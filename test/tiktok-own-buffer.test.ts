import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { firstProfile, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A reel from a Facebook page, with TikTok connected in a second Buffer of its
 * own. The page's Buffer has no TikTok, and that was the only one ever tried.
 */
const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => { closeDatabase(); vi.restoreAllMocks(); });

describe('a TikTok connected in a second Buffer', () => {
  it('is where the reel goes, not the page\'s Buffer that has no TikTok', async () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    run('UPDATE sites SET tt_reels = 1 WHERE id = ?', siteId);
    const page = firstProfile(siteId, 'facebook').id;
    const tiktok = firstProfile(siteId, 'tiktok').id;
    upsertBufferAccount({ siteId, label: 'first', token: 'tok-fb', enabled: true, profileId: page }, KEY);
    upsertBufferAccount({ siteId, label: 'second', token: 'tok-tt', enabled: true, profileId: tiktok }, KEY);

    vi.spyOn(BufferClient.prototype, 'getOrganizationId').mockResolvedValue('org');
    vi.spyOn(BufferClient.prototype, 'getChannels').mockImplementation(async function (this: BufferClient) {
      const token = (this as unknown as { token: string }).token;
      return (token === 'tok-tt'
        ? [{ id: 'tt1', name: 'Recipes', service: 'tiktok', boards: [] }]
        : [{ id: 'fb1', name: 'Page', service: 'facebook', boards: [] }]) as never;
    });
    const post = vi.spyOn(BufferClient.prototype, 'createTikTokPost').mockResolvedValue('TT-POST' as never);

    const { defaultDeps } = await import('../src/reels/engine.js');
    const deps = defaultDeps(new Settings(KEY), KEY);
    const id = await deps.tiktokReel!({
      siteId, runId: null, title: 'Stew', caption: 'Hook.', postUrl: 'https://s.com/stew',
      videoUrl: 'https://s.com/v.mp4', linkUrl: 'https://s.com/stew', pageProfileId: page,
    } as never);
    expect(id).toBe('TT-POST');
    expect(post.mock.calls[0]![0]).toMatchObject({ channelId: 'tt1' });
  });
});
