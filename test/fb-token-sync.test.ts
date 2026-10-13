import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertFbToken, listFbPages, listFbTokens } from '../src/db/repos.js';
import { syncToken } from '../src/reels/tokens.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The token is the source of pages. Adding one asks Graph what it can
 * manage; a token Graph refuses is kept, with Graph's words beside it, so the
 * person sees what to fix rather than an empty table.
 */

const KEY = randomBytes(32);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});
afterEach(() => closeDatabase());

describe('syncToken', () => {
  it('asks Graph with the token itself and records the pages', async () => {
    const id = insertFbToken('A', 'tok-a', KEY);
    const seen: string[] = [];

    const result = await syncToken(id, KEY, (token) => ({
      async listPages() {
        seen.push(token);
        return [{ id: '1', name: 'One' }];
      },
    }));

    expect(seen).toEqual(['tok-a']);
    expect(result).toEqual({ ok: true, added: 1, renamed: 0, dropped: 0, total: 1 });
    expect(listFbPages()).toHaveLength(1);
    expect(listFbTokens()[0]!.last_error).toBeNull();
    expect(listFbTokens()[0]!.last_synced_at).not.toBeNull();
  });

  it('keeps the token and records what Graph said when it fails', async () => {
    const id = insertFbToken('A', 'tok-a', KEY);

    const result = await syncToken(id, KEY, () => ({
      async listPages() {
        throw new Error('Listing pages failed: Invalid OAuth access token');
      },
    }));

    expect(result).toEqual({
      ok: false,
      error: 'Listing pages failed: Invalid OAuth access token',
    });
    expect(listFbTokens()[0]!.last_error).toContain('Invalid OAuth');
  });

  it('a token encrypted under another key says so instead of calling Graph', async () => {
    const id = insertFbToken('A', 'tok-a', randomBytes(32));

    const result = await syncToken(id, KEY, () => {
      throw new Error('should not be asked');
    });

    expect(result.ok).toBe(false);
    expect(listFbTokens()[0]!.last_error).toMatch(/could not be read/);
  });
});
