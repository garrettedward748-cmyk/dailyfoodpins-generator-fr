import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { listPinDesigns } from '../src/core/pin-designs.js';
import { listPhotoStyles } from '../src/core/photo-styles.js';
import { listArticleStructures } from '../src/core/article-structures.js';
import { listBlogStructures } from '../src/core/blog-structures.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * One Save button per page instead of one per card.
 *
 * The thing worth testing is the alignment: a browser submits nothing at all
 * for an unticked checkbox, so a naive "enabled" column shifts up and the
 * wrong rows come back on. The checkboxes carry their row's id to make that
 * impossible, and these tests tick the middle one off to prove it.
 */

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    payload: 'password=correct-horse-battery-staple',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

const post = (url: string, payload: string) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });

const field = (name: string, value: string) => `${name}=${encodeURIComponent(value)}`;

describe('Pin designs: one save for the page', () => {
  it('saves every card at once and keeps each switch with its own row', async () => {
    const before = listPinDesigns();
    expect(before.length).toBeGreaterThan(2);

    // Rename all three, and switch the middle one off — the case that breaks
    // when "enabled" is read as a column.
    const rows = before.slice(0, 3);
    const payload = [
      ...rows.flatMap((d, i) => [field('id', String(d.id)), field('name', `Renamed ${i}`), field('body', d.body)]),
      field('enabled', String(rows[0]!.id)),
      field('enabled', String(rows[2]!.id)),
    ].join('&');

    const response = await post('/settings/pin-designs/save', payload);
    expect(response.statusCode).toBe(303);

    const after = listPinDesigns();
    expect(after.slice(0, 3).map((d) => d.name)).toEqual(['Renamed 0', 'Renamed 1', 'Renamed 2']);
    expect(after.find((d) => d.id === rows[0]!.id)!.enabled).toBe(1);
    expect(after.find((d) => d.id === rows[1]!.id)!.enabled).toBe(0);
    expect(after.find((d) => d.id === rows[2]!.id)!.enabled).toBe(1);
  });

  it('saves nothing at all when one card was left blank', async () => {
    const before = listPinDesigns();
    const payload = [
      field('id', String(before[0]!.id)), field('name', 'Fine'), field('body', before[0]!.body),
      field('id', String(before[1]!.id)), field('name', ''), field('body', before[1]!.body),
    ].join('&');

    await post('/settings/pin-designs/save', payload);

    // The good row is not saved either: a half-applied page is worse than a
    // refused one, because nothing on screen says which half took.
    expect(listPinDesigns()[0]!.name).toBe(before[0]!.name);
  });

  it('warns rather than refuses when a design loses one of its three fields', async () => {
    const before = listPinDesigns()[0]!;
    const response = await post(
      '/settings/pin-designs/save',
      [field('id', String(before.id)), field('name', before.name), field('body', 'no fields at all'), field('enabled', String(before.id))].join('&'),
    );
    expect(String(response.headers.location)).toContain('warn');
    expect(listPinDesigns()[0]!.body).toBe('no fields at all');
  });
});

describe('the other three pages save the same way', () => {
  it('Photo styles', async () => {
    const rows = listPhotoStyles().slice(0, 2);
    await post('/settings/photo-styles/save', [
      ...rows.flatMap((r) => [field('id', String(r.id)), field('name', `S ${r.id}`), field('body', r.body)]),
      field('enabled', String(rows[1]!.id)),
    ].join('&'));

    const after = listPhotoStyles();
    expect(after.find((r) => r.id === rows[0]!.id)!.enabled).toBe(0);
    expect(after.find((r) => r.id === rows[1]!.id)).toMatchObject({ name: `S ${rows[1]!.id}`, enabled: 1 });
  });

  it('Article structures, with their two text fields', async () => {
    const rows = listArticleStructures().slice(0, 2);
    await post('/settings/article-structures/save', [
      ...rows.flatMap((r) => [
        field('id', String(r.id)),
        field('name', `A ${r.id}`),
        field('intro', `intro ${r.id}`),
        field('sections', `sections ${r.id}`),
      ]),
      field('enabled', String(rows[0]!.id)),
    ].join('&'));

    const after = listArticleStructures();
    // Two text columns must not cross over into each other.
    expect(after.find((r) => r.id === rows[1]!.id)).toMatchObject({
      intro: `intro ${rows[1]!.id}`,
      sections: `sections ${rows[1]!.id}`,
      enabled: 0,
    });
    expect(after.find((r) => r.id === rows[0]!.id)!.enabled).toBe(1);
  });

  it('Blog structures', async () => {
    const rows = listBlogStructures().slice(0, 2);
    await post('/settings/blog-structures/save', [
      ...rows.flatMap((r) => [field('id', String(r.id)), field('name', `B ${r.id}`), field('body', r.body)]),
    ].join('&'));

    // No "enabled" at all: every card was unticked, and all of them go off.
    expect(listBlogStructures().slice(0, 2).every((r) => r.enabled === 0)).toBe(true);
  });
});

describe('the pages themselves', () => {
  it('render one form with a save bar rather than a button per card', async () => {
    for (const [url, action] of [
      ['/settings/pin-designs', '/settings/pin-designs/save'],
      ['/settings/photo-styles', '/settings/photo-styles/save'],
      ['/settings/article-structures', '/settings/article-structures/save'],
      ['/settings/blog-structures', '/settings/blog-structures/save'],
    ]) {
      const page = await app.inject({ method: 'GET', url: url!, headers: { cookie } });
      expect(page.body).toContain(`action="${action}"`);
      expect(page.body).toContain('save-bar');
      // The checkbox carries the row id, which is what keeps the switches
      // attached to their own rows.
      expect(page.body).toMatch(/name="enabled" value="\d+"/);
    }
  });
});

describe('what an article says it was written in', () => {
  it('names the structure, the shoot and the pin design on the article page', async () => {
    const { upsertSite, insertKeyword, createRun } = await import('../src/db/repos.js');
    const { listArticleStructures, markRunArticleStructure } = await import('../src/core/article-structures.js');
    const { listPhotoStyles, markRunPhotoStyle } = await import('../src/core/photo-styles.js');
    const { listPinDesigns, markRunPinDesign } = await import('../src/core/pin-designs.js');

    const site = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const runId = createRun(insertKeyword({ seed_keyword: 'x', spy_title: 'Banana Bread Pudding' }), site);

    const structure = listArticleStructures()[1]!;
    const style = listPhotoStyles()[2]!;
    const design = listPinDesigns()[0]!;
    markRunArticleStructure(runId, structure.id);
    markRunPhotoStyle(runId, style.id);
    markRunPinDesign(runId, design.id);

    const page = await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: { cookie } });
    expect(page.body).toContain(`Structure: ${structure.name}`);
    expect(page.body).toContain(`Photo style: ${style.name}`);
    expect(page.body).toContain(`Pin design: ${design.name}`);
  });

  it('says nothing at all for an article written before the rotations existed', async () => {
    const { upsertSite, insertKeyword, createRun } = await import('../src/db/repos.js');
    const site = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const runId = createRun(insertKeyword({ seed_keyword: 'x', spy_title: 'Older Article' }), site);

    const page = await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: { cookie } });
    expect(page.body).not.toContain('Structure:');
    expect(page.body).not.toContain('Photo style:');
  });
});

describe('Caption structures', () => {
  it('rotates, records what it drew, and saves the page in one go', async () => {
    const { listCaptionStructures, nextCaptionShape, DEFAULT_CAPTION_STRUCTURES } =
      await import('../src/core/caption-structures.js');

    const structures = listCaptionStructures();
    expect(structures).toHaveLength(6);
    // The first is the shape the platform wrote until now, word for word.
    expect(structures[0]!.body).toBe(DEFAULT_CAPTION_STRUCTURES[0]!.body);
    // They ask for different things, not six wordings of one.
    expect(DEFAULT_CAPTION_STRUCTURES.some((s) => /TWO short lines/.test(s.body))).toBe(true);
    expect(DEFAULT_CAPTION_STRUCTURES.some((s) => /No question at the end/.test(s.body))).toBe(true);

    const chosen = nextCaptionShape(1);
    expect(chosen.shape.length).toBeGreaterThan(0);
    expect(chosen.id).toBeTruthy();

    const rows = structures.slice(0, 2);
    const payload = [
      ...rows.flatMap((r) => [field('id', String(r.id)), field('name', `C ${r.id}`), field('body', r.body)]),
      field('enabled', String(rows[1]!.id)),
    ].join('&');
    await post('/settings/caption-structures/save', payload);

    const after = listCaptionStructures();
    expect(after.find((r) => r.id === rows[0]!.id)!.enabled).toBe(0);
    expect(after.find((r) => r.id === rows[1]!.id)).toMatchObject({ name: `C ${rows[1]!.id}`, enabled: 1 });
  });

  it('falls back to the shipped shape when every structure is off', async () => {
    const { listCaptionStructures, saveCaptionStructure, nextCaptionShape, DEFAULT_CAPTION_STRUCTURES } =
      await import('../src/core/caption-structures.js');

    for (const s of listCaptionStructures()) saveCaptionStructure(s.id, { name: s.name, body: s.body, enabled: false });

    const chosen = nextCaptionShape(1);
    expect(chosen.id).toBeNull();
    expect(chosen.shape).toBe(DEFAULT_CAPTION_STRUCTURES[0]!.body.trim());
  });
});
