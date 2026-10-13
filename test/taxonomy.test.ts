import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSite, upsertSite } from '../src/db/repos.js';
import type { TaxonomyItem, TaxonomyUpdate } from '../src/integrations/site-api.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  displayName, fillTerm, listJobs, pickFields, planFor, readReport, retryFailed, runSite, shouldPublish, workOrder,
  type TaxonomyDeps,
} from '../src/taxonomy/engine.js';

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const item = (over: Partial<TaxonomyItem>): TaxonomyItem => ({
  table: 'categories', id: 1, name: 'Breakfast', slug: 'breakfast', published: true, recipes: 5,
  empty: ['title_tag', 'meta_desc', 'intro_html', 'body_html'], image: null, url: 'https://s.com/category/breakfast', ...over,
});

const ANSWER = JSON.stringify({
  title_tag: 'Easy Breakfast Recipes for Busy Mornings',
  meta_desc: 'Quick, cozy breakfast recipes for every morning. Find your next favorite.',
  intro_html: '<p>Mornings made easy.</p>',
  body_html: '<h1>Big</h1><p onclick="x">Start with <a href="/recipe/pancakes">Fluffy Pancakes</a> and <a href="/recipe/pancakes">again</a>.</p><script>bad()</script>',
});

function deps(over: Partial<TaxonomyDeps> = {}): TaxonomyDeps & { updates: TaxonomyUpdate[] } {
  const updates: TaxonomyUpdate[] = [];
  return {
    updates,
    api: {
      getTaxonomy: vi.fn(async () => []),
      getTaxonomyRecipes: vi.fn(async () => [{ title: 'Fluffy Pancakes', url: '/recipe/pancakes' }]),
      updateTaxonomy: vi.fn(async (u: TaxonomyUpdate) => { updates.push(u); return Object.keys(u).filter((k) => k !== 'table' && k !== 'id'); }),
      uploadImage: vi.fn(async () => ({ url: '/image/taxonomy/b.webp' })),
    } as never,
    ask: vi.fn(async () => ANSWER),
    image: vi.fn(async () => ({ data: Buffer.from('img'), contentType: 'image/webp' })),
    imagePrompt: 'A photo for {{name}} ({{kind}})',
    ...over,
  };
}

describe('taxonomy: what a term needs', () => {
  it('respells lower-case names only', () => {
    expect(displayName('peanut butter')).toBe('Peanut Butter');
    expect(displayName('no-bake filling')).toBe('No-Bake Filling');
    expect(displayName('BBQ sauce')).toBe('BBQ sauce');
  });

  it('writes a tag only from 3 recipes, but always fixes its spelling', () => {
    expect(planFor(item({ table: 'tags', name: 'apple', recipes: 2, empty: ['intro_html'] }))).toEqual({ text: [], image: false, rename: 'Apple' });
    expect(planFor(item({ table: 'tags', name: 'Apple', recipes: 3, empty: ['intro_html'] }))).toEqual({ text: ['intro_html'], image: false });
  });

  it('gives categories and cuisines their empty fields and a picture', () => {
    expect(planFor(item({ empty: ['body_html'], image: null }))).toEqual({ text: ['body_html'], image: true });
    expect(planFor(item({ empty: [], image: 'taxonomy/x.webp' }))).toEqual({ text: [], image: false });
  });

  it('orders categories, cuisines, then the biggest tags', () => {
    const order = workOrder([
      item({ table: 'tags', id: 9, recipes: 4 }), item({ table: 'cuisines', id: 2 }), item({ table: 'tags', id: 8, recipes: 9 }), item({ id: 3 }),
    ]).map((i) => `${i.table}:${i.id}`);
    expect(order).toEqual(['categories:3', 'cuisines:2', 'tags:8', 'tags:9']);
  });

  it('publishes a hidden cuisine only when complete and with 3 recipes', () => {
    const hidden = item({ table: 'cuisines', published: false, recipes: 3 });
    expect(shouldPublish(hidden, [], true)).toBe(true);
    expect(shouldPublish(hidden, ['body_html'], true)).toBe(false);
    expect(shouldPublish(hidden, [], false)).toBe(false);
    expect(shouldPublish({ ...hidden, recipes: 2 }, [], true)).toBe(false);
  });

  it('cleans the html and trims the meta fields', () => {
    const f = pickFields(JSON.parse(ANSWER), ['title_tag', 'body_html']);
    expect(f.title_tag).toBe('Easy Breakfast Recipes for Busy Mornings');
    expect(f.body_html).not.toMatch(/script|onclick|<h1/);
    expect((f.body_html!.match(/<a /g) ?? []).length).toBe(1);
    expect(pickFields({ meta_desc: 'x'.repeat(400) }, ['meta_desc']).meta_desc).toHaveLength(170);
  });
});

describe('taxonomy: filling one term', () => {
  it('sends text, a picture and publishes a complete hidden category', async () => {
    const d = deps();
    const out = await fillTerm({ name: 'S', domain: 's.com' }, item({ published: false }), d);
    expect(out.error).toBeUndefined();
    expect(d.updates[0]).toMatchObject({ table: 'categories', id: 1, image: '/image/taxonomy/b.webp', published: true, title_tag: expect.any(String) });
    expect(d.image).toHaveBeenCalledWith('A photo for Breakfast (category)');
    expect((d.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ kind: 'category', recipes: '- Fluffy Pancakes — /recipe/pancakes' });
  });

  it('keeps the text when the picture fails, and says so', async () => {
    const d = deps({ image: vi.fn(async () => { throw new Error('Flow busy'); }) });
    const out = await fillTerm({ name: 'S', domain: 's.com' }, item({ published: false }), d);
    expect(out.error).toContain('image: Flow busy');
    expect(d.updates[0]).toMatchObject({ title_tag: expect.any(String) });
    expect(d.updates[0]!.published).toBeUndefined();
  });

  it('asks only for the intro of a tag and never makes it a picture', async () => {
    const d = deps();
    await fillTerm({ name: 'S', domain: 's.com' }, item({ table: 'tags', name: 'Vegan', recipes: 4, empty: ['intro_html'] }), d);
    expect(d.image).not.toHaveBeenCalled();
    expect(Object.keys(d.updates[0]!).sort()).toEqual(['id', 'intro_html', 'table']);
  });
});

describe('taxonomy: a site run', () => {
  it('respells, writes one term per tick, records it and reports what is left', async () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const d = deps();
    (d.api.getTaxonomy as ReturnType<typeof vi.fn>).mockResolvedValue([
      item({ id: 1 }),
      item({ table: 'cuisines', id: 2, name: 'Mexican' }),
      item({ table: 'tags', id: 3, name: 'apple', recipes: 1, empty: ['intro_html'] }),
    ]);
    const r = await runSite(getSite(siteId)!, d, { max: 1, tryLock: () => true, unlock: () => {} });
    expect(r).toEqual({ written: 1, renamed: 1 });
    expect(d.updates.find((u) => u.table === 'tags')).toEqual({ table: 'tags', id: 3, name: 'Apple' });
    expect(listJobs(siteId)).toHaveLength(1);
    expect(readReport(getSite(siteId) as never)).toMatchObject({ total: 3, pending: 1, thinTags: 1 });
  });

  it('stops when a recipe run holds the lock, and gives up after 3 failures until retried', async () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const d = deps({ ask: vi.fn(async () => 'not json'), image: vi.fn(async () => { throw new Error('down'); }) });
    (d.api.getTaxonomy as ReturnType<typeof vi.fn>).mockResolvedValue([item({ id: 1 })]);
    expect((await runSite(getSite(siteId)!, d, { max: 5, tryLock: () => false, unlock: () => {} })).written).toBe(0);
    for (let i = 0; i < 3; i++) await runSite(getSite(siteId)!, d, { max: 5, tryLock: () => true, unlock: () => {} });
    expect(listJobs(siteId)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect((await runSite(getSite(siteId)!, d, { max: 5, tryLock: () => true, unlock: () => {} })).written).toBe(0);
    expect(retryFailed(siteId)).toBe(1);
    expect((await runSite(getSite(siteId)!, d, { max: 5, tryLock: () => true, unlock: () => {} })).written).toBe(1);
  });
});

describe('taxonomy: the page', () => {
  it('shows each site with its switch, and saves the switch and the picture prompt', async () => {
    const { buildServer } = await import('../src/web/server.js');
    const { Settings } = await import('../src/settings.js');
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const settings = new Settings(KEY);
    const app = buildServer(settings, KEY, { password: 'pw-123456', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=pw-123456', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = String([login.headers['set-cookie']].flat()[0]);
    const form = { cookie, 'content-type': 'application/x-www-form-urlencoded' };

    const page = await app.inject({ method: 'GET', url: '/taxonomy', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('s.com');
    expect(page.body).toContain('Turn on');
    if (process.env.TAXO_HTML) (await import('node:fs')).writeFileSync(process.env.TAXO_HTML, page.body);

    await app.inject({ method: 'POST', url: `/taxonomy/${siteId}/switch`, payload: 'on=1', headers: form });
    expect((getSite(siteId) as unknown as { taxo_on: number }).taxo_on).toBe(1);

    await app.inject({ method: 'POST', url: '/taxonomy/prompt', payload: 'prompt=Soft+photo+of+{{name}}', headers: form });
    expect(settings.get('taxo_image_prompt')).toBe('Soft photo of {{name}}');
    await app.close();
  });
});
