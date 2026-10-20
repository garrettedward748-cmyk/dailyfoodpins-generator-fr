import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  beginStep, createReel, createRun, finishStep, getPromptOverride, getReel, insertFbToken, insertKeyword,
  markRunPublished, setFbPageOptions, updateReel, upsertFbPage, upsertSite, type ReelView,
} from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { publishReel, youtubeDescription, type ReelDeps } from '../src/reels/engine.js';
import {
  composeWithRecipe, commentKeywordFor, facebookPost, formatRecipe, parseFacebookLinkMode, parseRecipeInPost, pickCommentKeyword, recipeCandidates, recipeOfRun,
  recipePostText, splitHashtags,
} from '../src/reels/recipe-text.js';
import { readShippedPrompt } from '../src/pipeline/prompts.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Facebook: the recipe in the post and where the link goes; YouTube: which
 * link lines the description carries; the whole caption prompt on the page.
 */

const KEY = randomBytes(32);

const RECIPE = {
  recipe_title: 'Slow Cooker Beef Stew',
  prep_time: '15 minutes',
  cook_time: '8 hours',
  servings: '6 bowls',
  ingredients: ['1 kg beef chuck, cubed', '3 carrots, sliced', '2 cups beef stock'],
  step_1: 'Step 1: Brown the beef in a hot pan.',
  step_2: '2. Add everything to the slow cooker.',
  step_3: 'Cook on low for eight hours.',
  step_4: '',
};

describe('the recipe as post text', () => {
  it('lists ingredients and numbers the steps itself', () => {
    const text = formatRecipe(RECIPE, 'full');
    expect(text).toBe([
      'Préparation 15 minutes · Cuisson 8 hours · Portions 6 bowls',
      'INGRÉDIENTS\n• 1 kg beef chuck, cubed\n• 3 carrots, sliced\n• 2 cups beef stock',
      'PRÉPARATION\n1. Brown the beef in a hot pan.\n2. Add everything to the slow cooker.\n3. Cook on low for eight hours.',
    ].join('\n\n'));
  });

  it('leaves the method out when only ingredients are asked for', () => {
    const text = formatRecipe(RECIPE, 'ingredients');
    expect(text).toContain('INGRÉDIENTS');
    expect(text).not.toContain('PRÉPARATION');
  });

  it('prints nothing rather than a heading over nothing', () => {
    expect(formatRecipe({ recipe_title: 'x', ingredients: [], step_1: '' }, 'full')).toBe('');
  });

  it('reads the choices back, with the defaults for anything unknown', () => {
    expect(parseRecipeInPost('ingredients')).toBe('ingredients');
    expect(parseRecipeInPost('nonsense')).toBe('full');
    expect(parseFacebookLinkMode('COMMENT')).toBe('comment');
    expect(parseFacebookLinkMode('')).toBe('text');
  });
});

describe('where the link goes', () => {
  const base = { body: 'Twelve minutes. One pan.', recipe: 'INGRÉDIENTS\n• 1 egg', postUrl: 'https://s.com/r' };

  it('in the text: first, before the caption, nothing in the comment', () => {
    expect(facebookPost({ ...base, link: 'text' })).toEqual({
      text: 'La recette complète : https://s.com/r\n\nTwelve minutes. One pan.\n\nINGRÉDIENTS\n• 1 egg',
    });
  });

  it('in the first comment: the post itself has no link', () => {
    const post = facebookPost({ ...base, link: 'comment' });
    expect(post.text).not.toContain('https://');
    expect(post.firstComment).toBe('La recette complète : https://s.com/r');
  });

  it('nowhere: neither the text nor a comment', () => {
    const post = facebookPost({ ...base, link: 'none' });
    expect(post.text).not.toContain('https://');
    expect(post.firstComment).toBeUndefined();
  });

  it('with no recipe, the link and the caption alone', () => {
    expect(facebookPost({ ...base, recipe: '', link: 'text' }).text).toBe('La recette complète : https://s.com/r\n\nTwelve minutes. One pan.');
  });
});

/* -- The engine ------------------------------------------------------------ */

function fakeDeps(overrides: Partial<ReelDeps> = {}): ReelDeps {
  return {
    facebookFor: vi.fn(() => ({})) as unknown as ReelDeps['facebookFor'],
    images: {} as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4 bytes')),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => 'https://bitespoon.com/fresh.webp'),
    uploadVideo: vi.fn(async () => 'https://bitespoon.com/video/reel-1.mp4'),
    scheduleReel: vi.fn(async () => 'BUF-1'),
    instagramReel: vi.fn(async () => 'IG-1'),
    youtubeShort: vi.fn(async () => 'YT-1'),
    reelPublisher: 'buffer',
    pause: vi.fn(async () => {}),
    ...overrides,
  };
}

function seed(withRecipe = true): { reelId: number; runId: number } {
  const siteId = upsertSite(
    { name: 'bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'slow cooker', spy_title: 'Slow Cooker Beef Stew' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/stew', 'Slow Cooker Beef Stew');
  if (withRecipe) {
    beginStep(runId, 'generate-recipe');
    finishStep(runId, 'generate-recipe', { status: 'ok', output: { raw: JSON.stringify(RECIPE), parsed: RECIPE } });
  }
  const tokenId = insertFbToken('A', 'tok', KEY);
  const pageId = upsertFbPage({ pageId: '999', name: 'Suppers', tokenId });
  setFbPageOptions(pageId, { siteId, autoPublish: true, enabled: true });
  const reelId = createReel({
    runId, siteId, keywordId, fbPageId: pageId, prompt: 'a stew', caption: 'Twelve minutes. One pan.', references: ['https://bitespoon.com/a.webp'],
  });
  updateReel(reelId, { status: 'ready', videoUrl: 'https://flow.example/clip.mp4' });
  return { reelId, runId };
}

const reelOf = (id: number): ReelView => getReel(id)!;
const scheduled = (deps: ReelDeps) =>
  ((deps.scheduleReel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as { text: string; firstComment?: string };

describe('a Facebook reel with the recipe in it', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('reads the recipe of the run the reel came from', () => {
    const { runId } = seed();
    expect(recipeOfRun(runId)).toMatchObject({ prep_time: '15 minutes' });
    expect(recipePostText(runId, 'full')).toContain('PRÉPARATION');
    expect(recipePostText(runId, 'none')).toBe('');
    expect(recipeOfRun(null)).toBeNull();
  });

  it('puts the link, then the caption, then the recipe, when the deps ask for it', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({ facebookRecipe: 'full', facebookLink: 'text' });
    await publishReel(reelOf(reelId), deps);

    const { text, firstComment } = scheduled(deps);
    expect(text.startsWith('La recette complète : https://bitespoon.com/stew\n\nTwelve minutes. One pan.\n\nPréparation 15 minutes')).toBe(true);
    expect(text).toContain('3. Cook on low for eight hours.');
    expect(text.endsWith('3. Cook on low for eight hours.')).toBe(true);
    expect(firstComment).toBeUndefined();
  });

  it('moves the link to the first comment', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({ facebookRecipe: 'full', facebookLink: 'comment' });
    await publishReel(reelOf(reelId), deps);

    const { text, firstComment } = scheduled(deps);
    expect(text).not.toContain('https://');
    expect(firstComment).toBe('La recette complète : https://bitespoon.com/stew');
  });

  it('sends no link at all when told none', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({ facebookRecipe: 'ingredients', facebookLink: 'none' });
    await publishReel(reelOf(reelId), deps);

    const { text, firstComment } = scheduled(deps);
    expect(text).toContain('INGRÉDIENTS');
    expect(text).not.toContain('PRÉPARATION');
    expect(text).not.toContain('https://');
    expect(firstComment).toBeUndefined();
  });

  it('posts exactly what it did before when the deps say nothing', async () => {
    const { reelId } = seed();
    const deps = fakeDeps();
    await publishReel(reelOf(reelId), deps);

    expect(scheduled(deps).text).toBe('La recette complète : https://bitespoon.com/stew\n\nTwelve minutes. One pan.');
  });

  it('still posts the caption and link when the run has no recipe to show', async () => {
    const { reelId } = seed(false);
    const deps = fakeDeps({ facebookRecipe: 'full', facebookLink: 'text' });
    await publishReel(reelOf(reelId), deps);

    expect(scheduled(deps).text).toBe('La recette complète : https://bitespoon.com/stew\n\nTwelve minutes. One pan.');
    expect(getReel(reelId)!.status).toBe('published');
  });
});

describe('Buffer and a plan with no first comment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the comment, and when Buffer refuses it posts the reel without', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const query = JSON.parse(init.body).query as string;
      queries.push(query);
      const refused = query.includes('firstComment');
      return new Response(
        JSON.stringify({ data: { createPost: refused ? { message: 'First comment is not available on your plan' } : { post: { id: 'FB1' } } } }),
        { status: 200 },
      );
    }));

    const id = await new BufferClient('t').createReel({ channelId: 'c1', text: 'x', videoUrl: 'https://s/v.mp4', firstComment: 'La recette complète : https://s/r' });

    expect(id).toBe('FB1');
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('firstComment: "La recette complète : https://s/r"');
    expect(queries[1]).not.toContain('firstComment');
  });

  it('does not hide a different refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { createPost: { message: 'Video too long' } } }), { status: 200 })));

    await expect(new BufferClient('t').createReel({ channelId: 'c1', text: 'x', videoUrl: 'https://s/v.mp4', firstComment: 'c' }))
      .rejects.toThrow(/Video too long/);
  });
});

describe('the YouTube description lines', () => {
  const caption = 'Twelve minutes.';
  it('has both by default, either can be left off, and both off leaves the caption alone', () => {
    const both = youtubeDescription('T', caption, 'https://s.com/r', 's.com');
    expect(both).toContain('La recette complète : https://s.com/r');
    expect(both).toContain('Plus de recettes : https://s.com');

    const noSite = youtubeDescription('T', caption, 'https://s.com/r', 's.com', { recipe: true, site: false });
    expect(noSite).toContain('La recette complète');
    expect(noSite).not.toContain('Plus de recettes');

    const noRecipe = youtubeDescription('T', caption, 'https://s.com/r', 's.com', { recipe: false, site: true });
    expect(noRecipe).not.toContain('La recette complète');
    expect(noRecipe).toContain('Plus de recettes');

    expect(youtubeDescription('T', caption, 'https://s.com/r', 's.com', { recipe: false, site: false })).toBe(caption);
  });
});

/* -- The page -------------------------------------------------------------- */

describe('the Caption structures page: the controls and the full prompt', () => {
  let app: FastifyInstance;
  let cookie: string;
  let settings: Settings;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = buildServer(settings, KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterEach(async () => { await app.close(); closeDatabase(); });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) for (const v of ([] as string[]).concat(value)) body.append(key, v);
    return app.inject({ method: 'POST', url, payload: body.toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  };

  /** The page's own rows, as its form would send them back. */
  const rows = async () => {
    const page = (await get('/settings/caption-structures')).body;
    const ids = [...page.matchAll(/name="id" value="(\d+)"/g)].map((m) => m[1]!);
    const names = [...page.matchAll(/name="name" value="([^"]*)"/g)].map((m) => m[1]!);
    const bodies = [...page.matchAll(/<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    return { ids, names, bodies, page };
  };
  const send = async (extra: Record<string, string | string[]>) => {
    const r = await rows();
    return post('/settings/caption-structures/save', { id: r.ids, name: r.names, body: r.bodies, enabled: r.ids, network: ['facebook', 'instagram', 'youtube'], ...extra });
  };

  it('starts as before: the recipe in the post, the link in the text, both YouTube lines', async () => {
    const { page } = await rows();
    expect(page).toContain('name="template"');
    expect(page).toMatch(/<option value="full" selected>/);
    expect(page).toMatch(/<option value="text" selected>/);
    expect(page).toMatch(/name="yt_link_recipe" value="1" checked/);
    expect(page).toMatch(/name="yt_link_site" value="1" checked/);
  });

  it('saves the Facebook choices and the YouTube lines with the one button', async () => {
    const res = await send({ fb_recipe: 'ingredients', fb_link: 'comment', yt_link_site: '1' });
    expect(res.statusCode).toBe(303);
    expect(settings.get('caption_fb_recipe')).toBe('ingredients');
    expect(settings.get('caption_fb_link')).toBe('comment');
    // An unticked box submits nothing: the recipe line is off, the site line stays on.
    expect(settings.getBool('caption_yt_link_recipe')).toBe(false);
    expect(settings.getBool('caption_yt_link_site')).toBe(true);
  });

  it('keeps "no link" instead of falling back to the default', async () => {
    await send({ fb_recipe: 'none', fb_link: 'none' });
    expect(settings.get('caption_fb_link')).toBe('none');
    expect(settings.get('caption_fb_recipe')).toBe('none');
  });

  it('saving the prompt unchanged does not freeze it as an edit', async () => {
    // A browser sends line breaks as CRLF; the page must still see no change.
    const shipped = readShippedPrompt('reel-caption.user.txt');
    await send({ template: shipped.replace(/\n/g, '\r\n') });
    expect(getPromptOverride('reel-caption.user.txt')).toBeUndefined();
  });

  it('saves an edited prompt as the same override Setup -> Prompts uses', async () => {
    const edited = `${readShippedPrompt('reel-caption.user.txt')}\n- Write in the second person.`;
    await send({ template: edited });
    expect(getPromptOverride('reel-caption.user.txt')).toBe(edited);
    expect((await get('/settings/caption-structures')).body).toContain('· edited');
  });

  it('refuses a prompt that has lost the place for the shape, and saves nothing', async () => {
    const res = await send({ template: 'Write a caption.', fb_link: 'none' });
    expect(decodeURIComponent(String(res.headers.location))).toContain('{{captionShape}}');
    expect(getPromptOverride('reel-caption.user.txt')).toBeUndefined();
    expect(settings.get('caption_fb_link')).toBe('text');
  });

  it('puts the shipped prompt back on request', async () => {
    await send({ template: `${readShippedPrompt('reel-caption.user.txt')}\n- Extra.` });
    expect(getPromptOverride('reel-caption.user.txt')).toBeDefined();

    await post('/settings/caption-structures/template/reset', {});
    expect(getPromptOverride('reel-caption.user.txt')).toBeUndefined();
  });
});

/* -- YouTube descriptions and Instagram reel captions ---------------------- */

const calledWith = (fn: unknown) =>
  ((fn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as { recipes?: string[]; caption: string };

describe('the recipe candidates a network is offered', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('offers the whole recipe then the ingredients, or only the ingredients, or nothing', async () => {
    const { runId } = seed();
    const full = recipeCandidates(runId, 'full');
    expect(full).toHaveLength(2);
    expect(full[0]).toContain('PRÉPARATION');
    expect(full[1]).not.toContain('PRÉPARATION');
    expect(recipeCandidates(runId, 'ingredients')).toEqual([full[1]]);
    expect(recipeCandidates(runId, 'none')).toEqual([]);
  });

  it('offers nothing for a run with no recipe', () => {
    const { runId } = seed(false);
    expect(recipeCandidates(runId, 'full')).toEqual([]);
    expect(recipeCandidates(null, 'full')).toEqual([]);
  });
});

describe('fitting a recipe under a caption inside a limit', () => {
  const recipes = ['R'.repeat(300), 'I'.repeat(100)];

  it('uses the whole recipe when it fits', () => {
    const text = composeWithRecipe({ body: 'Hi', recipes, tail: ['Link'], limit: 2200 });
    expect(text).toBe(`Hi\n\n${recipes[0]}\n\nLink`);
  });

  it('falls back to the ingredients, then to no recipe, and never cuts one', () => {
    const mid = composeWithRecipe({ body: 'Hi', recipes, tail: ['Link'], limit: 200 });
    expect(mid).toBe(`Hi\n\n${recipes[1]}\n\nLink`);
    const none = composeWithRecipe({ body: 'Hi', recipes, tail: ['Link'], limit: 50 });
    expect(none).toBe('Hi\n\nLink');
  });

  it('leaves a caption with no recipe exactly as it was, hashtags where they were', () => {
    expect(composeWithRecipe({ body: 'Hi\n#a #b', recipes: [], tail: ['Link'], limit: 2200 })).toBe('Hi\n#a #b\n\nLink');
  });

  it('puts the hashtags under the recipe when there is one', () => {
    expect(composeWithRecipe({ body: 'Hi\n#a #b', recipes: ['RECIPE'], tail: ['Link'], limit: 2200 })).toBe('Hi\n\nRECIPE\n\nLink\n\n#a #b');
    expect(splitHashtags('Only words')).toEqual({ body: 'Only words', tags: '' });
    expect(splitHashtags('#just #tags')).toEqual({ body: '#just #tags', tags: '' });
  });
});

describe('a reel that carries the recipe to YouTube and Instagram', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('hands each network its candidates, and nothing when the deps say nothing', async () => {
    const a = seed();
    const deps = fakeDeps({ youtubeRecipe: 'full', instagramRecipe: 'ingredients' });
    await publishReel(reelOf(a.reelId), deps);
    expect(calledWith(deps.youtubeShort).recipes).toHaveLength(2);
    expect(calledWith(deps.instagramReel).recipes).toHaveLength(1);
    expect(calledWith(deps.instagramReel).recipes![0]).not.toContain('PRÉPARATION');
  });

  it('keeps the caption empty for an unticked network, recipe or not', async () => {
    const a = seed();
    const deps = fakeDeps({ youtubeRecipe: 'full', captionOn: new Set(['facebook']) });
    await publishReel(reelOf(a.reelId), deps);
    expect(calledWith(deps.youtubeShort).caption).toBe('');
    expect(calledWith(deps.youtubeShort).recipes).toHaveLength(2);
  });

  it('sends no recipe by default', async () => {
    const a = seed();
    const deps = fakeDeps();
    await publishReel(reelOf(a.reelId), deps);
    expect(calledWith(deps.youtubeShort).recipes).toEqual([]);
    expect(calledWith(deps.instagramReel).recipes).toEqual([]);
  });
});

describe('the YouTube description with a recipe', () => {
  it('puts the recipe after the caption and before the link lines', () => {
    const text = youtubeDescription('T', 'Twelve minutes.', 'https://s.com/r', 's.com', { recipe: true, site: true }, ['RECIPE']);
    expect(text).toBe('Twelve minutes.\n\nRECIPE\n\nLa recette complète : https://s.com/r\nPlus de recettes : https://s.com');
  });

  it('is what it was without a recipe', () => {
    expect(youtubeDescription('T', 'Twelve minutes.', 'https://s.com/r', 's.com')).toBe(
      'Twelve minutes.\n\nLa recette complète : https://s.com/r\nPlus de recettes : https://s.com');
  });

  it('drops to the ingredients when the whole recipe would pass 5000 characters', () => {
    const text = youtubeDescription('T', 'Hi', 'https://s.com/r', 's.com', { recipe: true, site: true }, ['W'.repeat(5000), 'INGRÉDIENTS ONLY']);
    expect(text).toContain('INGRÉDIENTS ONLY');
    expect(text).not.toContain('WWW');
  });
});

describe('the Facebook post hashtags', () => {
  it('close the post under the recipe', () => {
    const { text } = facebookPost({ body: 'Words\n#a #b', recipe: 'RECIPE', postUrl: 'https://s/r', link: 'text' });
    expect(text).toBe('La recette complète : https://s/r\n\nWords\n\nRECIPE\n\n#a #b');
  });
});

describe('the Caption structures page: YouTube and Instagram recipe', () => {
  let app: FastifyInstance;
  let cookie: string;
  let settings: Settings;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = buildServer(settings, KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterEach(async () => { await app.close(); closeDatabase(); });

  const page = async () => (await app.inject({ method: 'GET', url: '/settings/caption-structures', headers: { cookie } })).body;
  const save = async (extra: Record<string, string>) => {
    const html = await page();
    const ids = [...html.matchAll(/name="id" value="(\d+)"/g)].map((m) => m[1]!);
    const names = [...html.matchAll(/name="name" value="([^"]*)"/g)].map((m) => m[1]!);
    const bodies = [...html.matchAll(/<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    const body = new URLSearchParams();
    for (const id of ids) { body.append('id', id); body.append('enabled', id); }
    names.forEach((n) => body.append('name', n));
    bodies.forEach((b) => body.append('body', b));
    for (const n of ['facebook', 'instagram', 'youtube']) body.append('network', n);
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    return app.inject({ method: 'POST', url: '/settings/caption-structures/save', payload: body.toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  };

  it('shows both selectors on "ingredients and steps" to begin with', async () => {
    const html = await page();
    expect(html).toMatch(/name="yt_recipe"[\s\S]*?<option value="full" selected>/);
    expect(html).toMatch(/name="ig_recipe"[\s\S]*?<option value="full" selected>/);
    for (const name of ['fbp_recipe', 'igp_recipe', 'pin_recipe']) {
      expect(html).toMatch(new RegExp(`name="${name}"[\\s\\S]*?<option value="full" selected>`));
    }
    expect(html).toMatch(/name="fbp_link"[\s\S]*?<option value="text" selected>/);
  });

  it('warns about the Buffer plan only when a first comment is chosen', async () => {
    expect(await page()).not.toContain('check your Buffer plan');
    await save({ fb_link: 'comment' });
    expect(await page()).toContain('check your Buffer plan');
    await save({ fbp_link: 'comment' });
    expect(await page()).toContain('check your Buffer plan');
    await save({});
    expect(await page()).not.toContain('check your Buffer plan');
  });

  it('saves the photo post choices as words with the same button', async () => {
    await save({ fbp_recipe: 'ingredients', fbp_link: 'comment', igp_recipe: 'none', pin_recipe: 'none' });
    expect(settings.get('caption_fb_post_recipe')).toBe('ingredients');
    expect(settings.get('caption_fb_post_link')).toBe('comment');
    expect(settings.get('caption_ig_post_recipe')).toBe('none');
    expect(settings.get('caption_pin_recipe')).toBe('none');
  });

  it('saves them as words with the one button, and shows them back', async () => {
    expect((await save({ yt_recipe: 'ingredients', ig_recipe: 'none' })).statusCode).toBe(303);
    expect(settings.get('caption_yt_recipe')).toBe('ingredients');
    expect(settings.get('caption_ig_recipe')).toBe('none');
    const html = await page();
    expect(html).toMatch(/name="yt_recipe"[\s\S]*?<option value="ingredients" selected>/);
    expect(html).toMatch(/name="ig_recipe"[\s\S]*?<option value="none" selected>/);
  });
});

describe('the comment-keyword link mode', () => {
  it('invites the keyword in the post and sends no link and no first comment', () => {
    const out = facebookPost({ body: 'Fudgy brownies', recipe: '', postUrl: 'https://d.com/r/x', link: 'keyword', keyword: 'banana' });
    expect(out.text).toContain('Commentez « BANANA »');
    expect(out.text).not.toContain('https://d.com/r/x');
    expect(out.firstComment).toBeUndefined();
  });

  it('adds nothing without a keyword, and is read back from storage', () => {
    const out = facebookPost({ body: 'Fudgy brownies', recipe: '', postUrl: 'https://d.com/r/x', link: 'keyword' });
    expect(out.text).toBe('Fudgy brownies');
    expect(parseFacebookLinkMode('keyword')).toBe('keyword');
  });
});

describe('the keyword taken from a dish', () => {
  it('takes the dish out of the title, not the filler around it', () => {
    expect(commentKeywordFor('Pizza')).toBe('pizza');
    expect(commentKeywordFor('Cheesecake Bars: American Cream Cheese Squares')).toBe('cheesecake');
    expect(commentKeywordFor('The Best Easy Homemade Lasagna Recipe')).toBe('lasagna');
    expect(commentKeywordFor('Crème Brûlée')).toBe('brulee');
  });

  it('falls back to the given word when a title offers nothing usable', () => {
    expect(commentKeywordFor('The Best Easy Recipe', 'Banana')).toBe('banana');
    expect(commentKeywordFor('', 'banana')).toBe('banana');
    expect(commentKeywordFor(null)).toBe('');
  });
});

describe('the keyword the model picks', () => {
  const ask = (answer: string | Error) => async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };

  it('takes a clean one-word answer', async () => {
    expect(await pickCommentKeyword('Crème Brûlée', ask('custard'))).toBe('custard');
    expect(await pickCommentKeyword('Lemon Bars', ask('  "Lemonbars".\n'))).toBe('lemonbars');
    expect(await pickCommentKeyword('Pizza', ask('#Pizza'))).toBe('pizza');
  });

  it('falls back to the title when the answer is not a plain word, or the model is down', async () => {
    expect(await pickCommentKeyword('Cheesecake Bars', ask('Comment cheesecake and I will send it'))).toBe('cheesecake');
    expect(await pickCommentKeyword('Cheesecake Bars', ask('bar'))).toBe('cheesecake'); // too short
    expect(await pickCommentKeyword('Cheesecake Bars', ask('recipe'))).toBe('cheesecake'); // filler
    expect(await pickCommentKeyword('Cheesecake Bars', ask(new Error('model down')))).toBe('cheesecake');
  });

  it('does not ask for a title that is empty', async () => {
    const spy = vi.fn(async () => 'pizza');
    expect(await pickCommentKeyword('', spy, 'banana')).toBe('banana');
    expect(spy).not.toHaveBeenCalled();
  });
});
