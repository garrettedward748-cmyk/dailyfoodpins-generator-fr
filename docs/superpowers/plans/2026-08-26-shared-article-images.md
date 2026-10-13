# Shared Article Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When one keyword publishes to several sites, generate its four article images once and copy them to the other sites, instead of paying for four Google generations per site.

**Architecture:** `uploadImage()` returns a permanent path on the receiving site, and `SiteApiClient` already knows its domain, so `https://<domain><path>` is a stable public URL. The first site to run a keyword records those four URLs in a `keyword_images` row; later sites download from them and upload their own copy. A per-`(keyword, site)` flag on the existing `keyword_sites` table controls participation. The Pinterest graphic is excluded and always generates fresh.

**Tech Stack:** TypeScript, Node 24 (`node:sqlite`), Fastify 5, Vitest 4. No new dependencies.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-08-26-imagegen-integration-design.md`, section "Sharing article images across sites".
- Branch: `imagegen-integration`.
- `share_images` defaults to **1** (on), including a backfill for existing rows.
- `generatePinImage` must remain untouched — it always generates.
- A failed download from a cached URL must fall back to generating, never fail the run.
- Sharing off for a link means *neither* read nor write: that site does not seed the cache for others.
- No new npm dependencies.
- Run `npm run typecheck && npx vitest run` before every commit; both must be clean.

---

### Task 1: Schema, migration, and repository functions

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.ts` (add `migrate()`, call it from `openDatabase`)
- Modify: `src/db/repos.ts`
- Test: `test/shared-images.test.ts` (create)

**Interfaces:**
- Consumes: `all`, `get`, `run` from `src/db/index.js`; `SharedImageUrls` is structurally identical to `ArticleImages` in `src/pipeline/steps/images.ts`.
- Produces:
  - `interface SharedImageUrls { feature: string; topShot: string; textureMacro: string; beforeAfter: string }`
  - `getSharedImages(keywordId: number): SharedImageUrls | undefined`
  - `saveSharedImages(keywordId: number, sourceSiteId: number, urls: SharedImageUrls): void`
  - `clearSharedImages(keywordId: number): void`
  - `setLinkShareImages(keywordId: number, siteId: number, share: boolean): void`
  - `setKeywordShareImages(keywordId: number, share: boolean): void`
  - `getLinkShare(keywordId: number, siteId: number): boolean`
  - `loadLinkGrid(): { keywordId: number; siteId: number; status: 'go' | 'done' | 'no'; shareImages: boolean }[]`

- [ ] **Step 1: Write the failing test**

Create `test/shared-images.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  clearSharedImages,
  getLinkShare,
  getSharedImages,
  insertKeyword,
  loadLinkGrid,
  saveSharedImages,
  setKeywordShareImages,
  setLink,
  setLinkShareImages,
  upsertSite,
} from '../src/db/repos.js';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32);

const seedSite = (domain: string): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );

const URLS = {
  feature: 'https://bitespoon.com/uploads/recipes/a.webp',
  topShot: 'https://bitespoon.com/uploads/recipes/b.webp',
  textureMacro: 'https://bitespoon.com/uploads/recipes/c.webp',
  beforeAfter: 'https://bitespoon.com/uploads/recipes/d.webp',
};

describe('shared article images', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('returns nothing before any images are recorded', () => {
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('round-trips the four urls', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    expect(getSharedImages(keywordId)).toEqual(URLS);
  });

  it('overwrites rather than duplicating on a second save', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    saveSharedImages(keywordId, siteId, { ...URLS, feature: 'https://x.com/new.webp' });

    expect(getSharedImages(keywordId)?.feature).toBe('https://x.com/new.webp');
  });

  it('clears a stale row', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    clearSharedImages(keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('drops the row when the keyword is deleted', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    saveSharedImages(keywordId, siteId, URLS);

    openDatabase; // keep import used
    const { run } = await import('../src/db/index.js');
    run('DELETE FROM keywords WHERE id = ?', keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('defaults a new link to sharing on', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    setLink(keywordId, siteId, 'go');
    expect(getLinkShare(keywordId, siteId)).toBe(true);
  });

  it('turns sharing off for one link without touching its status', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');

    setLinkShareImages(keywordId, siteId, false);

    const row = loadLinkGrid().find((l) => l.siteId === siteId)!;
    expect(row.shareImages).toBe(false);
    expect(row.status).toBe('go');
  });

  it('does not reset sharing when the status is changed', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');
    setLinkShareImages(keywordId, siteId, false);

    setLink(keywordId, siteId, 'done');

    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });

  it('sets sharing across every site for one keyword', () => {
    const a = seedSite('a.com');
    const b = seedSite('b.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, a, 'go');
    setLink(keywordId, b, 'go');

    setKeywordShareImages(keywordId, false);
    expect(loadLinkGrid().every((l) => l.shareImages === false)).toBe(true);

    setKeywordShareImages(keywordId, true);
    expect(loadLinkGrid().every((l) => l.shareImages === true)).toBe(true);
  });
});
```

Note: the fifth test uses a dynamic import inside a non-async `it`. Fix it while writing by declaring `it('drops the row when the keyword is deleted', async () => {` and removing the stray `openDatabase;` line — import `run` at the top of the file instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/shared-images.test.ts`
Expected: FAIL — `getSharedImages is not exported by '../src/db/repos.js'`.

- [ ] **Step 3: Add the schema**

In `src/db/schema.sql`, add `share_images` to the `keyword_sites` definition (currently at line 73):

```sql
CREATE TABLE IF NOT EXISTS keyword_sites (
  keyword_id   INTEGER NOT NULL REFERENCES keywords (id) ON DELETE CASCADE,
  site_id      INTEGER NOT NULL REFERENCES sites (id)    ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'no'
                       CHECK (status IN ('go', 'done', 'no')),
  -- On by default: reusing one image set across a keyword's sites is the
  -- behaviour that should need no thought. Generating fresh is the exception.
  share_images INTEGER NOT NULL DEFAULT 1 CHECK (share_images IN (0, 1)),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (keyword_id, site_id)
);
```

Then append the new table after it:

```sql
-- ---------------------------------------------------------------------------
-- Article images shared between the sites that publish one keyword.
--
-- The site API returns a permanent path, so `https://<domain><path>` is a
-- stable public URL. Storing the URL means there is no image cache to manage,
-- expire, or back up: the first site to publish becomes the source, and the
-- others download and upload their own copy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_images (
  keyword_id        INTEGER PRIMARY KEY REFERENCES keywords (id) ON DELETE CASCADE,
  feature_url       TEXT    NOT NULL,
  top_shot_url      TEXT    NOT NULL,
  texture_macro_url TEXT    NOT NULL,
  before_after_url  TEXT    NOT NULL,
  source_site_id    INTEGER REFERENCES sites (id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Add the migration**

`schema.sql` uses `IF NOT EXISTS`, so it cannot add a column to a table that
already exists. Add this to `src/db/index.ts`, above `openDatabase`:

```ts
/**
 * Column additions for databases created before the column existed.
 *
 * schema.sql only ever runs CREATE TABLE IF NOT EXISTS, which is a no-op on an
 * existing table — so a new column has to be added explicitly. Guarded by
 * PRAGMA table_info rather than catching an error, because "duplicate column"
 * and "table is locked" both arrive as the same exception type.
 */
function migrate(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(keyword_sites)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'share_images')) {
    db.exec(
      'ALTER TABLE keyword_sites ADD COLUMN share_images INTEGER NOT NULL DEFAULT 1 CHECK (share_images IN (0, 1))',
    );
    log.info('Added keyword_sites.share_images (defaulting existing rows to on)');
  }
}
```

`ALTER TABLE ... DEFAULT 1` fills existing rows with 1, so the backfill is
implicit. Call it from `openDatabase`, immediately after the `schema.sql` exec:

```ts
  db.exec(readFileSync(schemaPath(), 'utf8'));
  migrate(db);
```

- [ ] **Step 5: Add the repository functions**

In `src/db/repos.ts`, replace `loadLinkViews` / `setLink` / `getLinksForKeyword`
(lines 240-267) with that block plus the following additions. Leave
`loadLinkViews` exactly as it is — it feeds `selectTask`, whose input type stays
minimal on purpose.

```ts
/** The grid the keywords page renders: status and sharing for every pair. */
export const loadLinkGrid = (): {
  keywordId: number;
  siteId: number;
  status: 'go' | 'done' | 'no';
  shareImages: boolean;
}[] =>
  all<{ keyword_id: number; site_id: number; status: 'go' | 'done' | 'no'; share_images: number }>(
    'SELECT keyword_id, site_id, status, share_images FROM keyword_sites',
  ).map((r) => ({
    keywordId: r.keyword_id,
    siteId: r.site_id,
    status: r.status,
    shareImages: r.share_images === 1,
  }));

export const getLinkShare = (keywordId: number, siteId: number): boolean =>
  get<{ share_images: number }>(
    'SELECT share_images FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
    keywordId,
    siteId,
  )?.share_images === 1;

export const setLinkShareImages = (
  keywordId: number,
  siteId: number,
  share: boolean,
): void => {
  run(
    `INSERT INTO keyword_sites (keyword_id, site_id, status, share_images)
     VALUES (?, ?, 'no', ?)
     ON CONFLICT (keyword_id, site_id)
       DO UPDATE SET share_images = excluded.share_images, updated_at = datetime('now')`,
    keywordId,
    siteId,
    share ? 1 : 0,
  );
};

/** The "share on all" control: one keyword, every site it is linked to. */
export const setKeywordShareImages = (keywordId: number, share: boolean): void => {
  run(
    `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
      WHERE keyword_id = ?`,
    share ? 1 : 0,
    keywordId,
  );
};

/* =========================================================================
 * Shared article images
 * ====================================================================== */

export interface SharedImageUrls {
  feature: string;
  topShot: string;
  textureMacro: string;
  beforeAfter: string;
}

export const getSharedImages = (keywordId: number): SharedImageUrls | undefined => {
  const row = get<{
    feature_url: string;
    top_shot_url: string;
    texture_macro_url: string;
    before_after_url: string;
  }>(
    `SELECT feature_url, top_shot_url, texture_macro_url, before_after_url
       FROM keyword_images WHERE keyword_id = ?`,
    keywordId,
  );

  return row
    ? {
        feature: row.feature_url,
        topShot: row.top_shot_url,
        textureMacro: row.texture_macro_url,
        beforeAfter: row.before_after_url,
      }
    : undefined;
};

export const saveSharedImages = (
  keywordId: number,
  sourceSiteId: number,
  urls: SharedImageUrls,
): void => {
  run(
    `INSERT INTO keyword_images
       (keyword_id, feature_url, top_shot_url, texture_macro_url, before_after_url, source_site_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (keyword_id) DO UPDATE SET
       feature_url       = excluded.feature_url,
       top_shot_url      = excluded.top_shot_url,
       texture_macro_url = excluded.texture_macro_url,
       before_after_url  = excluded.before_after_url,
       source_site_id    = excluded.source_site_id,
       created_at        = datetime('now')`,
    keywordId,
    urls.feature,
    urls.topShot,
    urls.textureMacro,
    urls.beforeAfter,
    sourceSiteId,
  );
};

export const clearSharedImages = (keywordId: number): void => {
  run('DELETE FROM keyword_images WHERE keyword_id = ?', keywordId);
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/shared-images.test.ts`
Expected: PASS, 9 tests.

Then the full suite, to confirm the schema change broke nothing:

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; 129 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/index.ts src/db/repos.ts test/shared-images.test.ts
git commit -m "Record article image urls per keyword, and a per-link share flag"
```

---

### Task 2: Expose the absolute upload URL on SiteApiClient

**Files:**
- Modify: `src/integrations/site-api.ts`
- Test: `test/site-api.test.ts` (create)

**Interfaces:**
- Consumes: the existing private `url(path)` helper at `src/integrations/site-api.ts:74`.
- Produces: `SiteApiClient.absoluteUrl(path: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/site-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SiteApiClient } from '../src/integrations/site-api.js';

describe('SiteApiClient.absoluteUrl', () => {
  it('joins a bare domain to an upload path', () => {
    const client = new SiteApiClient('bitespoon.com', 'token');
    expect(client.absoluteUrl('/uploads/recipes/504341a6.webp')).toBe(
      'https://bitespoon.com/uploads/recipes/504341a6.webp',
    );
  });

  it('tolerates a domain that already carries a scheme', () => {
    const client = new SiteApiClient('https://bitespoon.com', 'token');
    expect(client.absoluteUrl('/uploads/a.webp')).toBe('https://bitespoon.com/uploads/a.webp');
  });

  it('tolerates a trailing slash on the domain', () => {
    const client = new SiteApiClient('bitespoon.com/', 'token');
    expect(client.absoluteUrl('/uploads/a.webp')).toBe('https://bitespoon.com/uploads/a.webp');
  });

  it('returns an already-absolute url unchanged', () => {
    const client = new SiteApiClient('bitespoon.com', 'token');
    const absolute = 'https://longlivo.com/uploads/recipes/b.webp';
    expect(client.absoluteUrl(absolute)).toBe(absolute);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/site-api.test.ts`
Expected: FAIL — `client.absoluteUrl is not a function`.

- [ ] **Step 3: Add the method**

In `src/integrations/site-api.ts`, directly after the private `url` method:

```ts
  /**
   * The public URL of something this site is serving.
   *
   * `uploadImage` returns a site-relative path; prefixed with the domain it
   * becomes a permanent link that any other site can download from. Passing an
   * already-absolute URL through unchanged keeps callers from having to know
   * which kind they are holding.
   */
  absoluteUrl(path: string): string {
    return /^https?:\/\//.test(path) ? path : this.url(path);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/site-api.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/site-api.ts test/site-api.test.ts
git commit -m "Expose the public url of an uploaded site asset"
```

---

### Task 3: Give the pipeline context the sharing flag and store

**Files:**
- Modify: `src/pipeline/context.ts`
- Modify: `src/pipeline/runner.ts` (wherever `new PipelineContext({...})` is constructed — locate with `grep -n "new PipelineContext" src/`)
- Test: `test/pipeline.test.ts` (extend)

**Interfaces:**
- Consumes: `SharedImageUrls`, `getSharedImages`, `saveSharedImages`, `clearSharedImages`, `getLinkShare` from Task 1.
- Produces:
  - `interface SharedImageStore { get(keywordId: number): SharedImageUrls | undefined; save(keywordId: number, sourceSiteId: number, urls: SharedImageUrls): void; clear(keywordId: number): void }`
  - `PipelineContext.shareImages: boolean`
  - `PipelineContext.sharedImages: SharedImageStore`

- [ ] **Step 1: Write the failing test**

Append to `test/pipeline.test.ts`:

```ts
describe('PipelineContext sharing wiring', () => {
  it('defaults sharing to off when no flag is supplied', () => {
    const ctx = makeContext(); // the existing helper in this file
    expect(ctx.shareImages).toBe(false);
  });

  it('carries an injected store and flag', () => {
    const store = {
      get: () => undefined,
      save: () => {},
      clear: () => {},
    };
    const ctx = makeContext({ shareImages: true, sharedImages: store });
    expect(ctx.shareImages).toBe(true);
    expect(ctx.sharedImages).toBe(store);
  });
});
```

If `test/pipeline.test.ts` has no `makeContext` helper, write one at the top of
the new describe block that builds a `PipelineContext` with the same fake site,
keyword and settings the file's existing tests use, and accepts an overrides
object spread over the constructor argument.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — `Property 'shareImages' does not exist on type 'PipelineContext'`.

- [ ] **Step 3: Add the field and the default store**

In `src/pipeline/context.ts`, add to the imports:

```ts
import {
  clearSharedImages,
  getSharedImages,
  saveSharedImages,
  siteSecrets,
  type SharedImageUrls,
  type SiteRow,
  type KeywordRow,
} from '../db/repos.js';
```

Above the class:

```ts
/**
 * Where a keyword's already-generated article images are recorded.
 *
 * Behind an interface so a step can be tested without a database — the same
 * reason the API clients live on the context rather than being imported.
 */
export interface SharedImageStore {
  get(keywordId: number): SharedImageUrls | undefined;
  save(keywordId: number, sourceSiteId: number, urls: SharedImageUrls): void;
  clear(keywordId: number): void;
}

const databaseImageStore: SharedImageStore = {
  get: getSharedImages,
  save: saveSharedImages,
  clear: clearSharedImages,
};
```

Add the two readonly fields alongside `allowResume`:

```ts
  readonly shareImages: boolean;
  readonly sharedImages: SharedImageStore;
```

Extend the constructor's `init` type with:

```ts
    shareImages?: boolean;
    sharedImages?: SharedImageStore;
```

And assign, next to the `allowResume` line:

```ts
    this.shareImages = init.shareImages ?? false;
    this.sharedImages = init.sharedImages ?? databaseImageStore;
```

- [ ] **Step 4: Pass the real flag at the call site**

Find the construction site:

```bash
grep -rn "new PipelineContext" src/
```

Add `getLinkShare` to that file's imports from `../db/repos.js`, and add one
property to the object literal:

```ts
      shareImages: getLinkShare(keyword.id, site.id),
```

Use whatever the surrounding code already calls the keyword and site variables.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/context.ts src/pipeline/runner.ts test/pipeline.test.ts
git commit -m "Thread the per-link image sharing flag into the pipeline context"
```

---

### Task 4: Reuse cached images in the generate-images step

**Files:**
- Modify: `src/pipeline/steps/images.ts:26-64`
- Test: `test/shared-images.test.ts` (extend)

**Interfaces:**
- Consumes: `PipelineContext.shareImages`, `PipelineContext.sharedImages`, `SiteApiClient.absoluteUrl`, the existing `ImageClient.download(url)`.
- Produces: no new exports. `generateArticleImages` keeps returning `ArticleImages` of site-relative paths.

- [ ] **Step 1: Write the failing test**

Append to `test/shared-images.test.ts`. Build a minimal fake context rather than
a real one — the step only touches four properties:

```ts
describe('generateArticleImages sharing behaviour', () => {
  const PROMPTS = {
    feature: 'p1',
    topShot: 'p2',
    textureMacro: 'p3',
    beforeAfter: 'p4',
  };

  function fakeContext(over: Record<string, unknown> = {}) {
    const generated: string[] = [];
    const downloaded: string[] = [];
    const uploaded: number[] = [];
    let counter = 0;

    const ctx = {
      keyword: { id: 1 },
      site: { id: 7, domain: 'bitespoon.com' },
      shareImages: false,
      sharedImages: { get: () => undefined, save: () => {}, clear: () => {} },
      images: {
        generate: async (prompt: string) => {
          generated.push(prompt);
          return { data: Buffer.from('x'), contentType: 'image/webp', jobId: 'j' };
        },
        download: async (url: string) => {
          downloaded.push(url);
          return { data: Buffer.from('x'), contentType: 'image/webp' };
        },
      },
      siteApi: {
        uploadImage: async () => {
          uploaded.push(++counter);
          return { url: `/uploads/recipes/${counter}.webp` };
        },
        absoluteUrl: (p: string) => `https://bitespoon.com${p}`,
      },
      ...over,
    };

    return { ctx, generated, downloaded, uploaded };
  }

  it('generates all four when sharing is off', async () => {
    const { ctx, generated, downloaded } = fakeContext();
    await generateArticleImages.run(ctx as never, PROMPTS);
    expect(generated).toHaveLength(4);
    expect(downloaded).toHaveLength(0);
  });

  it('does not record anything when sharing is off', async () => {
    const saved: unknown[] = [];
    const { ctx } = fakeContext({
      shareImages: false,
      sharedImages: { get: () => undefined, save: (...a: unknown[]) => saved.push(a), clear: () => {} },
    });
    await generateArticleImages.run(ctx as never, PROMPTS);
    expect(saved).toHaveLength(0);
  });

  it('records the four absolute urls when sharing is on and the cache is empty', async () => {
    let saved: { keywordId: number; siteId: number; urls: Record<string, string> } | null = null;
    const { ctx, generated } = fakeContext({
      shareImages: true,
      sharedImages: {
        get: () => undefined,
        save: (keywordId: number, siteId: number, urls: Record<string, string>) => {
          saved = { keywordId, siteId, urls };
        },
        clear: () => {},
      },
    });

    await generateArticleImages.run(ctx as never, PROMPTS);

    expect(generated).toHaveLength(4);
    expect(saved!.keywordId).toBe(1);
    expect(saved!.siteId).toBe(7);
    expect(saved!.urls.feature).toBe('https://bitespoon.com/uploads/recipes/1.webp');
  });

  it('downloads instead of generating when the cache is warm', async () => {
    const cached = {
      feature: 'https://a.com/1.webp',
      topShot: 'https://a.com/2.webp',
      textureMacro: 'https://a.com/3.webp',
      beforeAfter: 'https://a.com/4.webp',
    };
    const { ctx, generated, downloaded } = fakeContext({
      shareImages: true,
      sharedImages: { get: () => cached, save: () => {}, clear: () => {} },
    });

    const result = await generateArticleImages.run(ctx as never, PROMPTS);

    expect(generated).toHaveLength(0);
    expect(downloaded).toEqual(Object.values(cached));
    expect(result.feature).toBe('/uploads/recipes/1.webp');
  });

  it('falls back to generating when a cached url cannot be downloaded', async () => {
    let cleared = 0;
    const { ctx, generated } = fakeContext({
      shareImages: true,
      sharedImages: {
        get: () => ({ feature: 'https://dead.com/1.webp', topShot: 'x', textureMacro: 'y', beforeAfter: 'z' }),
        save: () => {},
        clear: () => { cleared++; },
      },
      images: {
        generate: async () => ({ data: Buffer.from('x'), contentType: 'image/webp', jobId: 'j' }),
        download: async () => { throw new Error('HTTP 404'); },
      },
    });

    const result = await generateArticleImages.run(ctx as never, PROMPTS);

    expect(cleared).toBe(1);
    expect(result.feature).toBeTruthy();
  });
});
```

Add `import { generateArticleImages } from '../src/pipeline/steps/images.js';` at
the top of the file.

The last test's fake replaces `images` wholesale, so it loses the `generated`
array; assert on `cleared` and on the returned value instead, as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/shared-images.test.ts`
Expected: FAIL — the sharing tests fail because the step always generates.

- [ ] **Step 3: Rewrite the step**

Replace lines 26-64 of `src/pipeline/steps/images.ts` with:

```ts
/** One uploaded image: the path the article uses, and the link other sites use. */
interface Uploaded {
  path: string;
  absolute: string;
}

async function upload(
  ctx: import('../context.js').PipelineContext,
  data: Buffer,
  contentType: string,
): Promise<Uploaded> {
  const extension = contentType.includes('png')
    ? 'png'
    : contentType.includes('jpeg')
      ? 'jpg'
      : 'webp';

  const result = await ctx.siteApi.uploadImage(
    data,
    `${randomUUID()}.${extension}`,
    contentType,
    'recipes',
  );

  return { path: result.url, absolute: ctx.siteApi.absoluteUrl(result.url) };
}

/** Generate one image and upload it to the site. */
async function generateAndUpload(
  ctx: import('../context.js').PipelineContext,
  prompt: string,
  label: string,
): Promise<Uploaded> {
  log.debug(`generating "${label}"`);
  const { data, contentType, jobId } = await ctx.images.generate(prompt, 'VERTICAL');
  const uploaded = await upload(ctx, data, contentType);
  log.debug(`"${label}" uploaded to ${uploaded.path} (job ${jobId})`);
  return uploaded;
}

/** Copy an image another site already published into this site's library. */
async function copyFromUrl(
  ctx: import('../context.js').PipelineContext,
  sourceUrl: string,
  label: string,
): Promise<Uploaded> {
  log.debug(`copying "${label}" from ${sourceUrl}`);
  const { data, contentType } = await ctx.images.download(sourceUrl);
  return upload(ctx, data, contentType);
}

/**
 * The four article images.
 *
 * Generated sequentially rather than in parallel: the image service is shared
 * across all sites and a burst of four is the kind of load that produces the
 * rate-limit failures this system exists to avoid.
 *
 * When this keyword's link to this site has sharing on, the first site to run
 * records the four public URLs and every later site copies them instead of
 * generating again — four Google calls per keyword rather than four per site.
 * A cached URL that will not download is treated as no cache at all: the row
 * is dropped and the images are generated, because a stale link must never
 * fail a run.
 */
export const generateArticleImages: Step<ImagePromptSet, ArticleImages> = {
  name: 'generate-images',
  title: 'Generate and upload article images',
  async run(ctx, prompts) {
    const cached = ctx.shareImages ? ctx.sharedImages.get(ctx.keyword.id) : undefined;

    if (cached) {
      try {
        const feature = await copyFromUrl(ctx, cached.feature, 'feature');
        const topShot = await copyFromUrl(ctx, cached.topShot, 'top shot');
        const textureMacro = await copyFromUrl(ctx, cached.textureMacro, 'texture macro');
        const beforeAfter = await copyFromUrl(ctx, cached.beforeAfter, 'before/after');

        return {
          feature: feature.path,
          topShot: topShot.path,
          textureMacro: textureMacro.path,
          beforeAfter: beforeAfter.path,
        };
      } catch (err) {
        log.warn(
          `Shared images for keyword ${ctx.keyword.id} could not be copied ` +
            `(${err instanceof Error ? err.message : String(err)}); generating fresh ones`,
        );
        ctx.sharedImages.clear(ctx.keyword.id);
      }
    }

    const feature = await generateAndUpload(ctx, prompts.feature, 'feature');
    const topShot = await generateAndUpload(ctx, prompts.topShot, 'top shot');
    const textureMacro = await generateAndUpload(ctx, prompts.textureMacro, 'texture macro');
    const beforeAfter = await generateAndUpload(ctx, prompts.beforeAfter, 'before/after');

    if (ctx.shareImages) {
      ctx.sharedImages.save(ctx.keyword.id, ctx.site.id, {
        feature: feature.absolute,
        topShot: topShot.absolute,
        textureMacro: textureMacro.absolute,
        beforeAfter: beforeAfter.absolute,
      });
    }

    return {
      feature: feature.path,
      topShot: topShot.path,
      textureMacro: textureMacro.path,
      beforeAfter: beforeAfter.path,
    };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests passing, including the five new sharing tests.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/steps/images.ts test/shared-images.test.ts
git commit -m "Copy an article's images between sites instead of regenerating them"
```

---

### Task 5: The sharing toggle in the keywords grid

**Files:**
- Modify: `src/web/views/pages.ts:427-433` (signature) and `:489-506` (the cell)
- Modify: `src/web/server.ts:321-340` (the route) and `:381-390` (the link handler)
- Test: `test/shared-images.test.ts` (extend)

**Interfaces:**
- Consumes: `loadLinkGrid`, `setLinkShareImages`, `setKeywordShareImages` from Task 1.
- Produces: `POST /keywords/:id/share` accepting `share=1|0`; `POST /keywords/:id/link` additionally accepting `share_images=1` (absent means off).

- [ ] **Step 1: Change the page signature and cell**

In `src/web/views/pages.ts`, change the `links` parameter type:

```ts
export function keywordsPage(
  keywords: KeywordRow[],
  sites: SiteRow[],
  links: Map<string, { status: string; shareImages: boolean }>,
  page: number,
  total: number,
): Html {
```

Replace the per-site cell block (the `${sites.map((s) => { ... })}` inside
`<tbody>`) with:

```ts
                  ${sites.map((s) => {
                    const cell = links.get(`${k.id}:${s.id}`);
                    const current = cell?.status ?? 'no';
                    const shared = cell?.shareImages ?? true;
                    return html`<td>
                      <form method="post" action="/keywords/${k.id}/link">
                        <input type="hidden" name="site_id" value="${s.id}" />
                        <select name="status" onchange="this.form.submit()">
                          ${(['go', 'done', 'no'] as const).map(
                            (v) =>
                              html`<option value="${v}" ${current === v ? raw('selected') : raw('')}>${v}</option>`,
                          )}
                        </select>
                        <label class="muted small" title="Reuse this keyword's article images here instead of generating new ones">
                          <input type="checkbox" name="share_images" value="1"
                                 ${shared ? raw('checked') : raw('')}
                                 onchange="this.form.submit()" />
                          share
                        </label>
                      </form>
                    </td>`;
                  })}
```

Add a "share all" control in the keyword's status cell, directly after the
existing status form:

```ts
                    <form method="post" action="/keywords/${k.id}/share" class="row">
                      <button class="small" type="submit" name="share" value="1"
                              title="Reuse one image set on every site for this keyword">share all</button>
                      <button class="small" type="submit" name="share" value="0"
                              title="Generate fresh images on every site for this keyword">none</button>
                    </form>
```

- [ ] **Step 2: Update the route**

In `src/web/server.ts`, swap `loadLinkViews` for `loadLinkGrid` in the import
list, then replace the map construction at line 324:

```ts
    const links = new Map(
      loadLinkGrid().map(
        (l) => [`${l.keywordId}:${l.siteId}`, { status: l.status, shareImages: l.shareImages }] as const,
      ),
    );
```

Leave the `loadLinkViews` import in place if the scheduler in this file also
uses it — check with `grep -n "loadLinkViews" src/web/server.ts` before removing.

- [ ] **Step 3: Update the link handler and add the share handler**

Replace the `/keywords/:id/link` handler body so it writes both fields, and add
the new route after it:

```ts
  app.post('\keywords:id/link', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = request.body as Record<string, unknown>;
    const siteId = asNumber(body.site_id, 0);
    const status = asString(body.status, 'no');
    if (siteId && (status === 'go' || status === 'done' || status === 'no')) {
      setLink(id, siteId, status);
      // An unchecked checkbox submits nothing, so absence means off.
      setLinkShareImages(id, siteId, body.share_images === '1');
    }
    return redirect(reply, '/keywords');
  });

  app.post('\keywords:id/share', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const share = asString((request.body as Record<string, unknown>).share, '1') === '1';
    setKeywordShareImages(id, share);
    return redirect(reply, '/keywords');
  });
```

Add `setLinkShareImages` and `setKeywordShareImages` to the `../db/repos.js`
import list at the top of the file.

Note: the existing route strings in this file use a literal backslash before
`keywords` (`'\keywords:id/link'`). Copy the surrounding file's exact style
rather than "fixing" it — changing it would change the registered path.

- [ ] **Step 4: Update the import help text**

In `src/web/views/pages.ts`, the CSV help paragraph, append one sentence:

```
Image sharing is on by default for every link; turn it off per site with the
<span class="mono">share</span> checkbox in the grid.
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests passing.

- [ ] **Step 6: Verify by eye**

```bash
npm run dev
```

Open `/keywords`. Expected: every cell shows the status dropdown plus a checked
`share` checkbox; unchecking one reloads the page with it still unchecked;
"none" on a keyword row clears every checkbox in that row; "share all" restores
them.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/pages.ts src/web/server.ts
git commit -m "Toggle image sharing per keyword and site from the grid"
```

---

## Self-Review

**Spec coverage.** Every requirement in the spec's "Sharing article images
across sites" section maps to a task: the `keyword_images` table and the
`share_images` column to Task 1; the permanent-URL construction to Task 2; the
flag reaching the pipeline to Task 3; the three-branch behaviour, the
regenerate-on-failure fallback, and `generatePinImage` staying untouched to
Task 4; the per-cell toggle and "share on all" to Task 5. Default-on is Task 1
Steps 3 and 4.

**Placeholders.** None. Task 3 Step 4 asks the implementer to run one `grep`
because the construction site is not pinned in the spec; the change to make
there is given in full.

**Type consistency.** `SharedImageUrls` is declared once in Task 1 and used by
Tasks 3 and 4 under that name. `Uploaded` is local to Task 4. `loadLinkGrid`
returns `shareImages`, matching the `Map<string, { status: string; shareImages:
boolean }>` in Task 5. `absoluteUrl` is spelled the same in Tasks 2, 4 and the
Task 4 fake.

## Next plan

The FlowKit → imagegen work in the same spec is an independent subsystem —
Python, Docker, and a WebSocket proxy — and gets its own plan once this one
lands.
