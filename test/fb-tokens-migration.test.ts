import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/migrations.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A deployed database has one system token in settings and a routing table
 * saying which niche on which site goes to which page. After 010 the token is
 * a row in fb_tokens, every page hangs off it, and a page that a route named
 * without ambiguity carries that route's niche. Anything ambiguous is left for
 * a person: guessing here posts recipes to the wrong audience.
 */

const migration010 = () => MIGRATIONS.find((m) => m.id === '010-fb-tokens')!;

function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT
    );
    CREATE TABLE sites (id INTEGER PRIMARY KEY, domain TEXT);
    CREATE TABLE keywords (id INTEGER PRIMARY KEY, seed_keyword TEXT);
    CREATE TABLE keyword_sites (id INTEGER PRIMARY KEY, keyword_id INTEGER, site_id INTEGER);
    CREATE TABLE runs (id INTEGER PRIMARY KEY);
    CREATE TABLE run_steps (id INTEGER PRIMARY KEY);
  `);
  db.prepare("INSERT INTO sites (id, domain) VALUES (1, 'one.com')").run();
  MIGRATIONS.find((m) => m.id === '009-facebook-reels')!.up(db);
  return db;
}

describe('migration 010-fb-tokens', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    setLogLevel('error');
    db = legacyDb();
  });
  afterEach(() => db.close());

  it('moves the stored system token into fb_tokens, encrypted blob untouched', () => {
    db.prepare(
      "INSERT INTO settings (key, value, is_secret) VALUES ('fb_system_token', 'enc:abc', 1)",
    ).run();
    db.prepare("INSERT INTO fb_pages (page_id, name) VALUES ('1', 'One')").run();

    migration010().up(db);

    const token = db.prepare('SELECT * FROM fb_tokens').get() as {
      name: string;
      token_encrypted: string;
    };
    expect(token.name).toBe('Imported');
    expect(token.token_encrypted).toBe('enc:abc');
    const page = db.prepare('SELECT token_id FROM fb_pages').get() as { token_id: number };
    expect(page.token_id).toBe(1);
  });

  it('makes no token when none was stored', () => {
    migration010().up(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fb_tokens').get()).toEqual({ n: 0 });
  });

  it('turns an unambiguous route into the page niche and leaves an ambiguous one blank', () => {
    db.prepare(
      "INSERT INTO fb_pages (id, page_id, name) VALUES (1, 'p1', 'One'), (2, 'p2', 'Two'), (3, 'p3', 'Three')",
    ).run();
    db.prepare(
      "INSERT INTO fb_page_routes (site_id, seed_keyword, fb_page_id) VALUES (NULL, 'Soup', 1)",
    ).run();
    // Two pages claim 'cake': neither gets it.
    db.prepare(
      "INSERT INTO fb_page_routes (site_id, seed_keyword, fb_page_id) VALUES (NULL, 'cake', 2), (1, 'cake', 3)",
    ).run();
    // The every-niche route says nothing about a niche.
    db.prepare(
      "INSERT INTO fb_page_routes (site_id, seed_keyword, fb_page_id) VALUES (1, '', 1)",
    ).run();

    migration010().up(db);

    const niches = db.prepare('SELECT id, niche FROM fb_pages ORDER BY id').all();
    expect(niches).toEqual([
      { id: 1, niche: 'Soup' },
      { id: 2, niche: null },
      { id: 3, niche: null },
    ]);
  });

  it('leaves a page blank that was routed two niches', () => {
    db.prepare("INSERT INTO fb_pages (id, page_id, name) VALUES (1, 'p1', 'One')").run();
    db.prepare(
      "INSERT INTO fb_page_routes (site_id, seed_keyword, fb_page_id) VALUES (NULL, 'soup', 1), (NULL, 'cake', 1)",
    ).run();

    migration010().up(db);

    expect(db.prepare('SELECT niche FROM fb_pages').get()).toEqual({ niche: null });
  });

  it('is idempotent', () => {
    migration010().up(db);
    expect(() => migration010().up(db)).not.toThrow();
  });
});

describe('migration 012-fb-pages-auto-publish', () => {
  it('switches every page that was holding for review to publishing on its own', () => {
    setLogLevel('error');
    const db = legacyDb();
    db.prepare(
      "INSERT INTO fb_pages (id, page_id, name, auto_publish) VALUES (1, 'p1', 'Held', 0), (2, 'p2', 'Auto', 1)",
    ).run();

    MIGRATIONS.find((m) => m.id === '012-fb-pages-auto-publish')!.up(db);

    expect(db.prepare('SELECT id, auto_publish FROM fb_pages ORDER BY id').all()).toEqual([
      { id: 1, auto_publish: 1 },
      { id: 2, auto_publish: 1 },
    ]);
  });
});
