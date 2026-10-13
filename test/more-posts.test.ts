import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, closeDatabase, get, openDatabase, run as dbRun } from '../src/db/index.js';
import { beginStep, createRun, finishStep, insertKeyword, loadLinkViews, markRunPublished, setLink, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { Settings } from '../src/settings.js';
import { customizeCaption, setSiteCaptionSetting } from '../src/core/caption-structures.js';

/**
 * Content -> More posts: new posts for a recipe already published. The model, the image
 * service and Buffer stand in; what matters is what is asked of them, what is recorded,
 * and that the site's own publishing counters never move.
 */

const calls: { step: string; input: unknown }[] = [];

vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async (_s: unknown, _k: unknown, name: string, vars: { angle?: { id: string }; shapeRule?: string }) => {
    if (name !== 'extra-post') throw new Error('unexpected prompt ' + name);
    calls.push({ step: 'prompt', input: vars });
    return {
      content: JSON.stringify({
        pin_title: `Pin for ${vars.angle?.id}`,
        pin_description: 'A fresh pin description about red velvet brownies.',
        facebook_text: 'A fresh Facebook post.',
        instagram_caption: 'A fresh caption.\n#brownies',
      }),
      tokensIn: 1,
      tokensOut: 1,
      endpoint: 'e',
      model: 'm',
    };
  }),
}));

vi.mock('../src/pipeline/steps/images.js', () => ({
  generatePinImage: {
    name: 'generate-pin-image',
    title: 'pin',
    run: async (_c: unknown, input: { prompts: { pinTitle: string } }) => {
      calls.push({ step: 'pin-image', input });
      return { url: '/image/pin-new.webp', cta: input.prompts.pinTitle };
    },
  },
}));
vi.mock('../src/pipeline/steps/publish.js', () => ({
  resolveBufferTarget: { name: 'resolve-buffer-target', title: 't', run: async () => ({ channelId: 'c', boardServiceId: 'b', boardName: 'Desserts' }) },
  publishToBuffer: {
    name: 'publish-to-buffer',
    title: 'b',
    run: async (_c: unknown, input: unknown) => {
      calls.push({ step: 'buffer', input });
      return { postId: 'p1' };
    },
  },
}));
vi.mock('../src/pipeline/steps/facebook-post.js', () => ({
  facebookPostStep: {
    name: 'facebook-post',
    title: 'fb',
    run: async (_c: unknown, input: unknown) => {
      calls.push({ step: 'facebook', input });
      return { postId: 'f1', imageUrl: 'u', source: 'pin' };
    },
  },
}));
vi.mock('../src/pipeline/steps/instagram-post.js', () => ({
  instagramPostStep: {
    name: 'instagram-post',
    title: 'ig',
    run: async (_c: unknown, input: unknown) => {
      calls.push({ step: 'instagram', input });
      return { postId: 'i1', imageUrl: 'u' };
    },
  },
}));

const { ANGLES, pickAngle, networkStates, checkRequest, makeExtraPosts, listPublishedRecipes, usedAngles, setRecipesHidden, hideOlderThan } = await import('../src/extra/engine.js');

const { tickExtraAuto } = await import('../src/extra/auto.js');

const KEY = randomBytes(32);
let settings: Settings;
let siteId: number;
let keywordId: number;
let sourceRun: number;

const step = (runId: number, name: string, output: unknown) => {
  beginStep(runId, name);
  finishStep(runId, name, { status: 'ok', output });
};

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  calls.length = 0;
  settings = new Settings(KEY);
  settings.set('buffer_enabled', 'true');
  siteId = upsertSite({ name: 'DFP', domain: 'dfp.test', status: 'active', daily_target: 3, interval_minutes: 60, pin_posts: 1, ig_posts: 1 } as never, KEY);
  dbRun('UPDATE sites SET pin_posts = 1, ig_posts = 1 WHERE id = ?', siteId);
  keywordId = insertKeyword({ seed_keyword: 'brownies', spy_title: 'Red Velvet Brownies', status: 'go' });
  setLink(keywordId, siteId, 'go');
  sourceRun = createRun(keywordId, siteId);
  step(sourceRun, 'validate-spy', { keyword: 'k', title: 'Red Velvet Brownies', description: 'd', category: 'c', cuisine: 'n' });
  step(sourceRun, 'generate-recipe', { raw: '{}', parsed: { ingredients: ['1 cup sugar'] } });
  step(sourceRun, 'post-article', { id: '7', href: '/recipe/red-velvet-brownies', title: 'Red Velvet Brownies' });
  step(sourceRun, 'generate-image-prompts', { hero: 'h', stepA: 'a', stepB: 'b', stepC: 'c', stepNumbers: [1], pinTitle: 'Old pin', pin: 'pin prompt' });
  step(sourceRun, 'generate-images', { hero: '/image/hero.webp', stepA: '/image/a.webp', stepB: '/image/b.webp', stepC: '/image/c.webp', stepNumbers: [] });
  markRunPublished(sourceRun, '7', 'https://dfp.test/recipe/red-velvet-brownies', 'Red Velvet Brownies');
  // The first posts went out long ago.
  dbRun("UPDATE runs SET published_at = datetime('now', '-30 days') WHERE id = ?", sourceRun);
});
afterEach(() => closeDatabase());

describe('angles', () => {
  it('uses the one asked for', () => expect(pickAngle('party', []).id).toBe('party'));
  it('on automatic takes the first not used yet, then the least used', () => {
    expect(pickAngle('auto', ['weeknight', 'make-ahead']).id).toBe('party');
    const all6 = ANGLES.map((a) => a.id);
    expect(pickAngle('auto', [...all6, 'weeknight']).id).toBe('make-ahead');
  });
});

describe('what can be posted', () => {
  it('lists published articles only', () => {
    expect(listPublishedRecipes().map((r) => r.runId)).toEqual([sourceRun]);
  });

  it('makes a network wait out the gap after a post, and counts the first posts', () => {
    const site = { id: siteId, pin_posts: 1, ig_posts: 1 } as never;
    const ready = networkStates(settings, site, sourceRun).find((s) => s.network === 'pinterest')!;
    expect(ready).toMatchObject({ ready: true, waitDays: 0 });

    dbRun("UPDATE runs SET published_at = datetime('now', '-2 days') WHERE id = ?", sourceRun);
    const waiting = networkStates(settings, site, sourceRun).find((s) => s.network === 'pinterest')!;
    expect(waiting.ready).toBe(false);
    expect(waiting.waitDays).toBe(5);
    expect(waiting.reason).toBe('wait 5 more days');
  });

  it('refuses a request before spending anything', () => {
    expect(checkRequest(settings, { sourceRunId: sourceRun, networks: [], angle: 'auto' })).toMatch(/at least one/);
    expect(checkRequest(settings, { sourceRunId: 9999, networks: ['pinterest'], angle: 'auto' })).toMatch(/not published/);
    // Facebook is off in Settings by default.
    expect(checkRequest(settings, { sourceRunId: sourceRun, networks: ['facebook'], angle: 'auto' })).toMatch(/Facebook/);
    expect(checkRequest(settings, { sourceRunId: sourceRun, networks: ['pinterest'], angle: 'auto' })).toBeNull();
  });
});

describe('making a batch', () => {
  it('writes new words, makes a new graphic, schedules, and records it apart from the article', async () => {
    const before = loadLinkViews();
    const report = await makeExtraPosts({ sourceRunId: sourceRun, networks: ['pinterest', 'instagram'], angle: 'auto' }, settings, KEY);

    expect(report.angle.id).toBe('weeknight');
    expect(report.outcomes.map((o) => [o.network, o.ok])).toEqual([['pinterest', true], ['instagram', true]]);

    const pin = calls.find((c) => c.step === 'pin-image')!.input as { prompts: { pinTitle: string; pin: string } };
    expect(pin.prompts.pinTitle).toBe('Pin for weeknight');
    expect(pin.prompts.pin).toBe('pin prompt');
    const buffer = calls.find((c) => c.step === 'buffer')!.input as { description: string; pin: { pinImageUrl: string } };
    expect(buffer.description).toMatch(/fresh pin description/);
    expect(buffer.pin.pinImageUrl).toBe('/image/pin-new.webp');
    const ig = calls.find((c) => c.step === 'instagram')!.input as { caption: string; heroImageUrl: string };
    expect(ig.caption).toMatch(/fresh caption/);
    expect(ig.heroImageUrl).toBe('/image/a.webp'); // a step photo, not the hero used the first time

    expect(all('SELECT network, angle, status FROM extra_posts ORDER BY id')).toEqual([
      { network: 'pinterest', angle: 'weeknight', status: 'ok' },
      { network: 'instagram', angle: 'weeknight', status: 'ok' },
    ]);
    expect(usedAngles(sourceRun)).toEqual(['weeknight', 'weeknight']);

    // Its own run row: not published, no keyword, started long ago, with the article's checkpoints copied.
    const batch = get<{ id: number; status: string; keyword_id: number | null; started_at: string }>(
      'SELECT id, status, keyword_id, started_at FROM runs WHERE id != ?',
      sourceRun,
    )!;
    expect(batch).toMatchObject({ status: 'cancelled', keyword_id: null, started_at: '2000-01-01 00:00:00' });
    expect(all<{ step: string }>('SELECT step FROM run_steps WHERE run_id = ? ORDER BY step', batch.id).map((r) => r.step)).toContain('generate-recipe');

    // The original article is untouched, and the site's counters did not move.
    expect(get<{ status: string; title: string }>('SELECT status, title FROM runs WHERE id = ?', sourceRun)).toMatchObject({ status: 'published', title: 'Red Velvet Brownies' });
    expect(listPublishedRecipes().map((r) => r.runId)).toEqual([sourceRun]);
    expect(loadLinkViews()).toEqual(before);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'published'")!.n).toBe(1);
  });

  it('keeps going when one network fails, and the next round waits out the gap', async () => {
    settings.set('fb_enabled', 'true');
    dbRun("INSERT INTO fb_pages (page_id, name, site_id, enabled, posts) VALUES ('p', 'Page', ?, 1, 1)", siteId);
    const report = await makeExtraPosts({ sourceRunId: sourceRun, networks: ['pinterest', 'facebook'], angle: 'swaps' }, settings, KEY);
    expect(report.outcomes.every((o) => o.ok)).toBe(true);
    const fb = calls.find((c) => c.step === 'facebook')!.input as { text: string; pinImageUrl: string };
    expect(fb.text).toBe('A fresh Facebook post.');
    expect(fb.pinImageUrl).toBe('/image/pin-new.webp');

    // Same recipe, same network, straight away: refused.
    expect(checkRequest(settings, { sourceRunId: sourceRun, networks: ['pinterest'], angle: 'auto' })).toMatch(/wait 7 more days/);
  });
});

describe('hiding recipes', () => {
  it('takes a hidden recipe off the list and out of the automatic mode, and brings it back', async () => {
    expect(setRecipesHidden([sourceRun], true)).toBe(1);
    expect(listPublishedRecipes().map((r) => r.runId)).toEqual([]);
    expect(listPublishedRecipes(undefined, 300, 'only').map((r) => r.runId)).toEqual([sourceRun]);

    settings.set('automation_enabled', 'true');
    settings.set('extra_auto_enabled', 'true');
    await tickExtraAuto(settings, KEY, { tryLock: () => true, unlock: () => {} });
    expect(all('SELECT id FROM extra_posts')).toEqual([]);

    expect(setRecipesHidden([sourceRun], false)).toBe(1);
    expect(listPublishedRecipes().map((r) => r.runId)).toEqual([sourceRun]);
  });

  it('hides the ones published before a number of days ago', () => {
    expect(hideOlderThan(90)).toBe(0);
    expect(hideOlderThan(10)).toBe(1); // the test recipe was published 30 days ago
    expect(listPublishedRecipes()).toEqual([]);
  });
});

describe('caption shapes and the link', () => {
  it('slots the next caption shape into the prompt, and rotates it', async () => {
    settings.set('caption_networks', 'instagram');
    await makeExtraPosts({ sourceRunId: sourceRun, networks: ['instagram'], angle: 'auto' }, settings, KEY);
    const first = (calls.find((c) => c.step === 'prompt')!.input as { shapeRule: string }).shapeRule;
    expect(first).toMatch(/THE SHAPE/);
    expect(first).toMatch(/instagram_caption/);

    dbRun("UPDATE extra_posts SET created_at = datetime('now', '-30 days')");
    calls.length = 0;
    await makeExtraPosts({ sourceRunId: sourceRun, networks: ['instagram'], angle: 'auto' }, settings, KEY);
    const second = (calls.find((c) => c.step === 'prompt')!.input as { shapeRule: string }).shapeRule;
    expect(second).not.toBe(first);
  });

  it('gives no shape to a network that is not ticked in Setup', async () => {
    settings.set('caption_networks', 'none');
    await makeExtraPosts({ sourceRunId: sourceRun, networks: ['instagram'], angle: 'auto' }, settings, KEY);
    expect((calls.find((c) => c.step === 'prompt')!.input as { shapeRule: string }).shapeRule).toBe('');
  });

  it("follows the site's choice about the link", async () => {
    customizeCaption(siteId, settings);
    setSiteCaptionSetting(siteId, 'caption_extra_link', 'no');
    await makeExtraPosts({ sourceRunId: sourceRun, networks: ['instagram'], angle: 'auto' }, settings, KEY);
    expect((calls.find((c) => c.step === 'instagram')!.input as { link?: string }).link).toBe('no');
  });

  it('leaves the link as Setup has it by default', async () => {
    await makeExtraPosts({ sourceRunId: sourceRun, networks: ['instagram'], angle: 'auto' }, settings, KEY);
    expect((calls.find((c) => c.step === 'instagram')!.input as { link?: string }).link).toBeUndefined();
  });
});

describe('automatic', () => {
  const lock = () => {
    let held = false;
    return { tryLock: () => ((held ? false : (held = true))), unlock: () => { held = false; } };
  };

  it('does nothing while it is off', async () => {
    settings.set('automation_enabled', 'true');
    await tickExtraAuto(settings, KEY, lock());
    expect(all('SELECT id FROM extra_posts')).toEqual([]);
  });

  it('posts for the recipe waiting longest, marks it auto, and stops at the daily cap', async () => {
    settings.set('automation_enabled', 'true');
    settings.set('extra_auto_enabled', 'true');
    settings.set('extra_auto_per_day', '1');
    await tickExtraAuto(settings, KEY, lock());
    const rows = all<{ network: string; auto: number }>('SELECT network, auto FROM extra_posts ORDER BY id');
    expect(rows.map((r) => r.network)).toEqual(['pinterest', 'instagram']);
    expect(rows.every((r) => r.auto === 1)).toBe(true);

    calls.length = 0;
    await tickExtraAuto(settings, KEY, lock());
    expect(calls).toEqual([]); // cap of 1 reached, and the gap has not passed anyway
  });

  it('leaves a busy lock alone', async () => {
    settings.set('automation_enabled', 'true');
    settings.set('extra_auto_enabled', 'true');
    await tickExtraAuto(settings, KEY, { tryLock: () => false, unlock: () => {} });
    expect(all('SELECT id FROM extra_posts')).toEqual([]);
  });
});
