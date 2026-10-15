import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const asked = vi.hoisted(() => ({ vars: null as Record<string, unknown> | null }));
vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async (_s: unknown, _k: unknown, _name: string, vars: Record<string, unknown>) => {
    asked.vars = vars;
    return {
      content: JSON.stringify({
        names: [
          { display: 'Cheesecake & Caramel Kitchen', username: 'Cheesecake_Caramel', tagline: 'Easy Dessert Recipes', bio: 'Creamy cheesecakes and caramel desserts.' },
          { display: 'Taken One', username: 'arbmomrecipes', tagline: '', bio: '' },
          { display: '', username: 'nameless', tagline: '', bio: '' },
        ],
      }),
    };
  }),
}));

const { closeDatabase, openDatabase } = await import('../src/db/index.js');
const { firstProfile, getAccountNameSuggestions, updateProfile, upsertSite } = await import('../src/db/repos.js');
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

describe('Suggest account names', () => {
  it('builds names from the boards, skips taken and broken ones, and shows them to copy', async () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const p = firstProfile(site, 'pinterest');
    updateProfile(p.id, { channel_name: 'ArbmomRecipes', default_board: 'Everyday Home Cooking', board_map: 'oreo cheesecake = Oreo Cheesecake Recipes' });

    const r = await app.inject({ method: 'POST', url: `/accounts/${site}/pinterest/names`, headers: { cookie } });
    expect(r.statusCode).toBe(303);
    expect(String(asked.vars?.boards)).toContain('Oreo Cheesecake Recipes');
    expect(String(asked.vars?.taken)).toContain('ArbmomRecipes');

    const names = getAccountNameSuggestions(site);
    expect(names.map((n) => n.username)).toEqual(['cheesecakecaramel']);

    const page = await app.inject({ method: 'GET', url: `/accounts/${site}`, headers: { cookie } });
    expect(page.body).toContain('Names for a new Pinterest account');
    expect(page.body).toContain('Cheesecake &amp; Caramel Kitchen | Easy Dessert Recipes');

    await app.inject({ method: 'POST', url: `/accounts/${site}/pinterest/names/clear`, headers: { cookie } });
    expect(getAccountNameSuggestions(site)).toEqual([]);
  });
});
