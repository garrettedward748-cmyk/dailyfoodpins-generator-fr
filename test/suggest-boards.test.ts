import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async () => ({
    content: JSON.stringify({
      boards: [
        { group: 'dessert', name: 'Easy Dessert Recipes', description: 'Simple desserts for every day.' },
        { group: 'chicken', name: 'Chicken Dinner Recipes', description: 'Quick chicken dinners.' },
        { group: 'nope', name: 'Ignored', description: '' },
      ],
      general: { name: 'Easy Recipes', description: 'Everyday recipes.' },
    }),
  })),
}));

const boards = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('../src/integrations/buffer.js', async (orig) => ({
  ...(await orig<typeof import('../src/integrations/buffer.js')>()),
  BufferClient: class {
    async getOrganizationId() { return 'org'; }
    async getChannels() { return [{ id: 'c', name: 'arbmom', service: 'pinterest', boards: boards.names.map((name, i) => ({ serviceId: String(i), name })) }]; }
  },
}));

const { closeDatabase, openDatabase } = await import('../src/db/index.js');
const { firstProfile, getProfile, insertKeyword, setLink, updateProfile, upsertBufferAccount, upsertSite } = await import('../src/db/repos.js');
const { Settings } = await import('../src/settings.js');
const { buildServer } = await import('../src/web/server.js');
const { setLogLevel } = await import('../src/lib/logger.js');

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

describe('Suggest boards', () => {
  it('suggests a board per topic group, fills the links and shows names to copy', async () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    setLink(insertKeyword({ seed_keyword: 'chicken', spy_title: 'Honey Garlic Chicken' }), site, 'go');

    const profile = firstProfile(site, 'pinterest');
    const r = await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    expect(r.statusCode).toBe(303);
    const row = getProfile(profile.id)!;
    expect(row.default_board).toBe('Easy Recipes');
    expect(row.board_map).toContain('dessert = Easy Dessert Recipes');
    expect(row.board_map).toContain('chicken = Chicken Dinner Recipes');
    expect(row.board_map).not.toContain('Ignored');

    const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('Create the 3 new board(s) on Pinterest');
    expect(page.body).toContain('Chicken Dinner Recipes');
  });

  it('links groups to boards the account already has and proposes only the missing ones', async () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    upsertBufferAccount({ siteId: site, label: 'b', token: 't', enabled: true, platform: 'pinterest' }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    setLink(insertKeyword({ seed_keyword: 'chicken', spy_title: 'Honey Garlic Chicken' }), site, 'go');
    boards.names = ['Desserts', 'Everyday Recipes'];
    const profile = firstProfile(site, 'pinterest');
    // Copied from the first account: none of these is on this account.
    updateProfile(profile.id, { default_board: 'My Other Recipes', board_map: 'apple crumble = Apple Crumble Recipes\ncake = Easy Desserts' });

    const r = await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    expect(r.statusCode).toBe(303);
    const row = getProfile(profile.id)!;
    expect(row.board_map).toContain('dessert = Desserts'); // "Easy Dessert Recipes" is the board already there
    expect(row.board_map).toContain('chicken = Chicken Dinner Recipes');
    expect(row.default_board).toBe('Everyday Recipes'); // "My Other Recipes" is not on this account
    expect(row.board_map).not.toContain('Apple Crumble Recipes'); // a board it does not have: dropped
    expect(row.board_map).toContain('cake = Desserts'); // near match: set to the real board

    const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('Create the 1 new board(s) on Pinterest');
    expect(page.body).toContain('Exists');
  });

  it('keeps a chosen general board that the account has', async () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    upsertBufferAccount({ siteId: site, label: 'b', token: 't', enabled: true, platform: 'pinterest' }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    boards.names = ['Desserts', 'Everyday Home Cooking'];
    const profile = firstProfile(site, 'pinterest');
    updateProfile(profile.id, { default_board: 'Everyday Home Cooking' });

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    expect(getProfile(profile.id)!.default_board).toBe('Everyday Home Cooking');
  });

  it('puts a group named like a board on that board', async () => {
    const { askPrompt } = await import('../src/llm/ask.js');
    vi.mocked(askPrompt).mockResolvedValueOnce({ content: JSON.stringify({
      boards: [
        { group: 'honey recipes', name: 'Honey Recipes', description: 'Honey dishes.' },
        { group: 'honey', name: 'Chicken Recipes', description: '' },
      ],
      general: null,
    }) } as never);
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    upsertBufferAccount({ siteId: site, label: 'b', token: 't', enabled: true, platform: 'pinterest' }, KEY);
    setLink(insertKeyword({ seed_keyword: 'honey recipes', spy_title: 'Honey Rolls' }), site, 'go');
    setLink(insertKeyword({ seed_keyword: 'honey', spy_title: 'Honey Quail' }), site, 'go');
    boards.names = ['Chicken Recipes', 'Everyday Recipes'];
    const profile = firstProfile(site, 'pinterest');
    updateProfile(profile.id, { default_board: 'Everyday Recipes' });

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    const map = getProfile(profile.id)!.board_map;
    expect(map).toContain('honey = Honey Recipes');
    expect(map).not.toContain('Chicken Recipes');
  });

  it('pressing again keeps what was decided, even when the model answers differently', async () => {
    const { askPrompt } = await import('../src/llm/ask.js');
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    upsertBufferAccount({ siteId: site, label: 'b', token: 't', enabled: true, platform: 'pinterest' }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    setLink(insertKeyword({ seed_keyword: 'milkshake', spy_title: 'Oreo Shake' }), site, 'go');
    boards.names = ['Desserts'];
    const profile = firstProfile(site, 'pinterest');
    updateProfile(profile.id, { default_board: '', board_map: '' });

    vi.mocked(askPrompt).mockResolvedValueOnce({ content: JSON.stringify({
      boards: [{ group: 'dessert', name: 'Desserts', description: '' }, { group: 'milkshake', name: 'Milkshake Recipes', description: 'Shakes.' }],
      general: { name: 'Recipe Inspiration', description: 'All sorts.' },
    }) } as never);
    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    const first = getProfile(profile.id)!;

    vi.mocked(askPrompt).mockClear(); // a second answer would differ, but none should be asked for
    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    const second = getProfile(profile.id)!;
    expect(askPrompt).not.toHaveBeenCalled(); // nothing left to decide
    expect(second.board_map).toBe(first.board_map);
    expect(second.board_map).toContain('milkshake = Milkshake Recipes');
    expect(second.default_board).toBe('Recipe Inspiration');
    expect(second.board_suggestions).toContain('Shakes.');
  });

  it('a new account with boards copied from the first gets descriptions to copy, names kept', async () => {
    const { askPrompt } = await import('../src/llm/ask.js');
    vi.mocked(askPrompt).mockResolvedValueOnce({ content: JSON.stringify({
      boards: [{ group: 'dessert', name: 'Some Other Name', description: 'Sweet things to bake.' }],
      general: { name: 'Another General', description: 'Every recipe.' },
    }) } as never);
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    upsertBufferAccount({ siteId: site, label: 'b', token: 't', enabled: true, platform: 'pinterest' }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    boards.names = []; // a fresh account: no boards yet
    const profile = firstProfile(site, 'pinterest');
    updateProfile(profile.id, { default_board: 'Everyday Home Cooking', board_map: 'dessert = Desserts', board_suggestions: '' });

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });
    const row = getProfile(profile.id)!;
    expect(row.board_map).toContain('dessert = Desserts');
    expect(row.default_board).toBe('Everyday Home Cooking');
    const plan = JSON.parse(row.board_suggestions);
    expect(plan.boards[0]).toMatchObject({ name: 'Desserts', description: 'Sweet things to bake.', exists: false });
    expect(plan.general).toMatchObject({ name: 'Everyday Home Cooking', description: 'Every recipe.' });
  });

  it('Hide keeps the suggestions, and Show suggestions brings them back', async () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    setLink(insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' }), site, 'go');
    const profile = firstProfile(site, 'pinterest');
    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest`, headers: { cookie } });

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest/clear`, headers: { cookie } });
    let page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).not.toContain('new board(s) on Pinterest');
    expect(page.body).toContain('Show suggestions');
    expect(getProfile(profile.id)!.board_suggestions).toContain('Easy Dessert Recipes');

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/boards/suggest/show`, headers: { cookie } });
    page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('new board(s) on Pinterest');
    expect(page.body).not.toContain('Show suggestions');
  });
});
