import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { addManualFbPage, beginStep, createRun, finishStep, insertKeyword, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { facebookPostStep } from '../src/pipeline/steps/facebook-post.js';
import { instagramPostStep } from '../src/pipeline/steps/instagram-post.js';
import { publishToBuffer } from '../src/pipeline/steps/publish.js';
import { setLogLevel } from '../src/lib/logger.js';

/** The recipe in the photo posts: Facebook, Instagram and the Pinterest description. */

const RECIPE = {
  prep_time: '15 minutes',
  ingredients: ['2 lemons', '1 cup sugar'],
  step_1: 'Mix.',
  step_2: 'Bake.',
};

let SITE = 0;
let RUN = 0;
beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  SITE = upsertSite({ name: 'D', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, randomBytes(32));
  RUN = createRun(insertKeyword({ seed_keyword: 'lemon bars', spy_title: 'Lemon Bars' }), SITE);
  beginStep(RUN, 'generate-recipe');
  finishStep(RUN, 'generate-recipe', { status: 'ok', output: { raw: '', parsed: RECIPE } });
});
afterEach(() => closeDatabase());

function photo(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ppr-'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=768x1376', '-frames:v', '1', join(dir, 'p.png')]);
  return readFileSync(join(dir, 'p.png'));
}

const fakeCtx = (settings: Record<string, string>, extra: Record<string, unknown>, pool: string) => ({
  runId: RUN,
  keyword: { seed_keyword: 'lemon bars' },
  site: { id: SITE, domain: 'd.com', ig_posts: 1 },
  settings: { getBool: (k: string) => settings[k] === '1', get: (k: string) => settings[k] ?? '' },
  images: { download: vi.fn(async () => ({ data: photo(), contentType: 'image/png' })) },
  siteApi: { uploadImage: vi.fn(async () => ({ url: '/image/recipes/x.jpg' })), absoluteUrl: (p: string) => `https://d.com${p}` },
  async eachAccount(this: Record<string, unknown>, _p: string, send: (pool: unknown, profile: undefined, first: boolean) => Promise<string>) {
    return { postId: await send(this[pool], undefined, true), accounts: 1 };
  },
  ...extra,
}) as never;

describe('the Facebook photo post', () => {
  const sent: { text: string; firstComment?: string }[] = [];
  const ctx = (settings: Record<string, string>) => {
    sent.length = 0;
    return fakeCtx({ fb_enabled: '1', reel_publisher: 'buffer', ...settings }, {
      prompt: vi.fn(async () => ({ content: 'Tangy and bright.' })),
      facebookBuffer: { createFacebookPost: vi.fn(async (i: { text: string; firstComment?: string }) => { sent.push(i); return { postId: 'P', account: 'A' }; }) },
    }, 'facebookBuffer');
  };
  const input = { seo: { title: 'Lemon Bars' } as never, title: 'Lemon Bars', postUrl: 'https://d.com/r', pinImageUrl: '/p.webp' };
  beforeEach(() => { run('UPDATE fb_pages SET posts = 1 WHERE id = ?', addManualFbPage({ name: 'Page', siteId: SITE })); });

  it('leads with the link, then the text and the recipe, by default', async () => {
    await facebookPostStep.run(ctx({}), input);
    expect(sent[0]!.text).toMatch(/^La recette complète : https:\/\/d\.com\/r\n\nTangy and bright\.\n\nPréparation 15 minutes\n\nINGRÉDIENTS\n• 2 lemons/);
    expect(sent[0]!.text).toContain('PRÉPARATION\n1. Mix.\n2. Bake.');
    expect(sent[0]!.text.endsWith('2. Bake.')).toBe(true);
    expect(sent[0]!.firstComment).toBeUndefined();
  });

  it('puts the link in the first comment, or leaves it out', async () => {
    await facebookPostStep.run(ctx({ caption_fb_post_link: 'comment' }), input);
    expect(sent[0]!.text).not.toContain('https://');
    expect(sent[0]!.firstComment).toBe('La recette complète : https://d.com/r');
    await facebookPostStep.run(ctx({ caption_fb_post_link: 'none', caption_fb_post_recipe: 'ingredients' }), input);
    expect(sent[0]!.text).not.toContain('https://');
    expect(sent[0]!.text).not.toContain('PRÉPARATION');
    expect(sent[0]!.firstComment).toBeUndefined();
  });

  it('is the old post when the recipe is off', async () => {
    await facebookPostStep.run(ctx({ caption_fb_post_recipe: 'none' }), input);
    expect(sent[0]!.text).toBe('La recette complète : https://d.com/r\n\nTangy and bright.');
  });

  it('is the title and the link when Facebook is unticked under Caption structures, whatever the photo settings say', async () => {
    const c = ctx({ caption_networks: 'instagram,youtube,tiktok', caption_fb_post_link: 'keyword' });
    await facebookPostStep.run(c, input);
    expect(sent[0]!.text).toBe('La recette complète : https://d.com/r\n\nLemon Bars');
    expect(sent[0]!.firstComment).toBeUndefined();
    // Neither the text nor the comment keyword is written.
    expect((c as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt).not.toHaveBeenCalled();
    await facebookPostStep.run(ctx({ caption_networks: 'none' }), { ...input, text: 'Written for More posts.' });
    expect(sent[0]!.text).toBe('La recette complète : https://d.com/r\n\nLemon Bars');
  });

  it('keeps a More posts "No link" with Facebook unticked', async () => {
    await facebookPostStep.run(ctx({ caption_networks: 'none' }), { ...input, linkMode: 'none' });
    expect(sent[0]!.text).toBe('Lemon Bars');
  });
});

describe('the Instagram photo post', () => {
  const sent: { text: string; firstComment?: string }[] = [];
  const ctx = (settings: Record<string, string>, written: string) => {
    sent.length = 0;
    return fakeCtx({ ig_link_mode: 'bio', ...settings }, {
      prompt: vi.fn(async () => ({ content: written })),
      instagramBuffer: { createInstagramPost: vi.fn(async (i: { text: string; firstComment?: string }) => { sent.push(i); return { postId: 'IG', account: 'A' }; }) },
    }, 'instagramBuffer');
  };
  const input = { seo: { title: 'Lemon Bars' } as never, title: 'Lemon Bars', postUrl: 'https://d.com/r', heroImageUrl: 'https://d.com/h.jpg' };
  const written = 'Zesty and soft.\n\nLa recette complète : lien en bio\n\n#lemonbars #baking';

  it('puts the recipe under the caption, the link line after it, the hashtags last', async () => {
    await instagramPostStep.run(ctx({}, written), input);
    expect(sent[0]!.text).toBe(
      'Zesty and soft.\n\nPréparation 15 minutes\n\nINGRÉDIENTS\n• 2 lemons\n• 1 cup sugar\n\nPRÉPARATION\n1. Mix.\n2. Bake.\n\nLa recette complète : lien en bio\n\n#lemonbars #baking',
    );
  });

  it('keeps the caption exactly as written when the recipe is off', async () => {
    await instagramPostStep.run(ctx({ caption_ig_post_recipe: 'none' }, written), input);
    expect(sent[0]!.text).toBe(written);
  });

  it('gives way to the ingredients when the whole would pass 2200 characters', async () => {
    run(`UPDATE run_steps SET output_json = ? WHERE run_id = ? AND step = 'generate-recipe'`,
      JSON.stringify({ parsed: { ...RECIPE, step_1: 'Stir. '.repeat(400) } }), RUN);
    await instagramPostStep.run(ctx({}, written), input);
    expect(sent[0]!.text.length).toBeLessThanOrEqual(2200);
    expect(sent[0]!.text).toContain('INGRÉDIENTS');
    expect(sent[0]!.text).not.toContain('PRÉPARATION');
  });
});

describe('the Pinterest description', () => {
  const sent: { text: string }[] = [];
  const ctx = (settings: Record<string, string>) => {
    sent.length = 0;
    return fakeCtx({ buffer_enabled: '1', ...settings }, {
      pinterestBuffer: { createPost: vi.fn(async (i: { text: string }) => { sent.push(i); return { postId: 'PIN', destination: { boardName: 'B' }, account: 'A' }; }) },
    }, 'pinterestBuffer');
  };
  const input = (description: string) => ({
    pin: { seo: { title: 'Lemon Bars' }, posted: { href: '/r', title: 'Lemon Bars' }, pinImageUrl: '/p.webp', cta: '' },
    description,
    target: { channelId: 'c', boardServiceId: 'b', boardName: 'B' },
  }) as never;

  it('adds the ingredients when the whole recipe does not fit, and the whole when it does', async () => {
    await publishToBuffer.run(ctx({}), input('Short.'));
    expect(sent[0]!.text).toContain('PRÉPARATION');
    await publishToBuffer.run(ctx({}), input('x'.repeat(490)));
    expect(sent[0]!.text).toBe('x'.repeat(490)); // nothing fits in the 10 left: the description alone
  });

  it('leaves the description alone when the recipe is off', async () => {
    await publishToBuffer.run(ctx({ caption_pin_recipe: 'none' }), input('Short.'));
    expect(sent[0]!.text).toBe('Short.');
  });
});

describe('Buffer and the first comment on a Facebook photo post', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends it, and posts without it when the plan has none', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const query = JSON.parse(init.body).query as string;
      queries.push(query);
      return new Response(JSON.stringify({ data: { createPost: query.includes('firstComment') ? { message: 'First comment unavailable' } : { post: { id: 'F1' } } } }), { status: 200 });
    }));
    const id = await new BufferClient('t').createFacebookImagePost({ channelId: 'c', text: 'x', imageUrl: 'https://s/i.jpg', firstComment: 'La recette complète : https://s/r' });
    expect(id).toBe('F1');
    expect(queries[0]).toMatch(/type: post\s+firstComment: "La recette complète : https:\/\/s\/r"/);
    expect(queries[1]).not.toContain('firstComment');
  });
});

describe('Buffer and the name of a Facebook reel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the video, so Facebook does not list it as "Untitled Video"', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      queries.push(JSON.parse(init.body).query as string);
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'R1' } } } }), { status: 200 });
    }));
    await new BufferClient('t').createReel({ channelId: 'c', text: 'x', videoUrl: 'https://s/v.mp4', title: ' Slow  Cooker Stew ' });
    await new BufferClient('t').createReel({ channelId: 'c', text: 'x', videoUrl: 'https://s/v.mp4' });
    expect(queries[0]).toMatch(/url: "https:\/\/s\/v\.mp4"\s+metadata: \{ title: "Slow Cooker Stew" \}/);
    expect(queries[1]).not.toContain('title');
  });
});
