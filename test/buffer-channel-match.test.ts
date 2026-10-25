import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { bufferChannelName, firstProfile, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { BufferPool, isBufferExhausted } from '../src/integrations/buffer-pool.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * An account that names its Facebook page means that page.
 *
 * With Post to all, seven accounts on one Buffer account each named their own
 * page, but the names were not spelled as Buffer shows them. "Else the first
 * channel" then sent every one of them to the same page: the same reel, seven
 * times, in one queue.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => { closeDatabase(); vi.restoreAllMocks(); });

const PAGES = [
  { id: 'c-recipe', name: 'The Recipe Corner', service: 'facebook', boards: [] },
  { id: 'c-yummy', name: 'The Yummy Spoon', service: 'facebook', boards: [] },
  { id: 'c-kitchen', name: 'Kitchen Stories', service: 'facebook', boards: [] },
];

function poolNamed(name: string, channels = PAGES, withProfile = true) {
  const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
  const profileId = firstProfile(siteId, 'facebook').id;
  upsertBufferAccount({ siteId, label: 'buf', token: 'tok', enabled: true, profileId }, KEY);
  vi.spyOn(BufferClient.prototype, 'getOrganizationId').mockResolvedValue('org');
  vi.spyOn(BufferClient.prototype, 'getChannels').mockResolvedValue(channels as never);
  const createReel = vi.spyOn(BufferClient.prototype, 'createReel').mockResolvedValue('POST-1' as never);
  const pool = new BufferPool(
    { id: siteId, domain: 's.com', pinUsername: name, platform: 'facebook', ...(withProfile ? { profileId } : {}) },
    KEY,
  );
  return { pool, createReel };
}

const reel = { text: 'Truffles', videoUrl: 'https://s.com/v.mp4' };

describe('the Facebook page an account posts to', () => {
  it('posts to the page it names, whatever its place in the list', async () => {
    const { pool, createReel } = poolNamed('kitchen stories'); // case does not matter
    const out = await pool.createReel(reel);
    expect(out.channelId).toBe('c-kitchen');
    expect(createReel.mock.calls[0]![0]).toMatchObject({ channelId: 'c-kitchen' });
  });

  it('a name matching none of Buffer\'s pages is an error naming the real ones, not a post on the first', async () => {
    const { pool, createReel } = poolNamed('KitchenStories12');
    // One call: the pool moves on to its next account after a refusal, so a
    // second call on the same pool would not look at this one again.
    const error = await pool.createReel(reel).then(() => '', (e: Error) => e.message);
    expect(error).toMatch(/No Facebook page named "KitchenStories12" on Buffer account "buf"/);
    expect(error).toContain('"The Recipe Corner", "The Yummy Spoon", "Kitchen Stories"');
    expect(createReel).not.toHaveBeenCalled();
  });

  it('a wrong page name is never reported as a full queue, so nothing holds the site or retries it for hours', async () => {
    const { pool } = poolNamed('KitchenStories12');
    const error = await pool.createReel(reel).then(() => '', (e: Error) => e.message);
    // "All Buffer accounts are full" is what the scheduler waits out, and what
    // a failed reel is retried on by itself; neither can fix a name.
    expect(error).not.toMatch(/are full/);
    expect(isBufferExhausted(new Error(error))).toBe(false);
  });

  it('a queue Buffer really refuses is still reported as full', async () => {
    const { pool } = poolNamed('Kitchen Stories');
    vi.spyOn(BufferClient.prototype, 'createReel').mockRejectedValue(new Error('Scheduled posts limit reached'));
    const error = await pool.createReel(reel).then(() => '', (e: Error) => e.message);
    expect(isBufferExhausted(new Error(error))).toBe(true);
  });

  it('the same goes for the article post', async () => {
    const { pool } = poolNamed('Nope');
    vi.spyOn(BufferClient.prototype, 'createFacebookImagePost').mockResolvedValue('X' as never);
    await expect(pool.createFacebookPost({ text: 't', imageUrl: 'https://s.com/i.jpg' })).rejects.toThrow(/No Facebook page named "Nope"/);
  });

  it('a blank name still takes the first page, as the card says', async () => {
    const { pool } = poolNamed('');
    expect((await pool.createReel(reel)).channelId).toBe('c-recipe');
  });

  it('a Buffer account with a single page that is not the one named is refused, not posted to', async () => {
    // A reel shown as "ArbmomRecipes" went to that account's only page, some
    // other page, and nothing said so.
    const { pool, createReel } = poolNamed('ArbmomRecipes', [PAGES[0]!]);
    const error = await pool.createReel(reel).then(() => '', (e: Error) => e.message);
    expect(error).toMatch(/No Facebook page named "ArbmomRecipes" on Buffer account "buf"/);
    expect(error).toContain('"The Recipe Corner"');
    expect(createReel).not.toHaveBeenCalled();
  });

  it('says which page it really posted to', async () => {
    const { pool } = poolNamed('the yummy spoon');
    expect((await pool.createReel(reel)).page).toBe('The Yummy Spoon');
  });

  it('a site not yet on accounts never named a Facebook page, so it keeps taking the first', async () => {
    // Its pin_username is a Pinterest name: it will never match a Facebook page.
    const { pool } = poolNamed('somepinterestname', PAGES, false);
    expect((await pool.createReel(reel)).channelId).toBe('c-recipe');
  });
});

describe('a reel\'s copy through its page\'s Buffer account', () => {
  function igPool(channels: { id: string; name: string; service: string; boards: never[] }[]) {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const profileId = firstProfile(siteId, 'facebook').id;
    upsertBufferAccount({ siteId, label: 'buf', token: 'tok', enabled: true, profileId }, KEY);
    vi.spyOn(BufferClient.prototype, 'getOrganizationId').mockResolvedValue('org');
    vi.spyOn(BufferClient.prototype, 'getChannels').mockResolvedValue(channels as never);
    vi.spyOn(BufferClient.prototype, 'createInstagramPost').mockResolvedValue('IG-1' as never);
    return new BufferPool(
      { id: siteId, domain: 's.com', pinUsername: 'ArbmomRecipes', platform: 'instagram', profileId, otherNetworkName: true },
      KEY,
    );
  }
  const post = { text: 't', type: 'reel' as const, videoUrl: 'https://s.com/v.mp4' };

  it('takes the account\'s only Instagram, whatever its name: the name is the Facebook page\'s', async () => {
    const pool = igPool([...PAGES, { id: 'ig-1', name: 'amanda.recipes', service: 'instagram', boards: [] }]);
    expect(await pool.createInstagramPost(post)).toMatchObject({ postId: 'IG-1', page: 'amanda.recipes' });
  });

  it('with several Instagrams and none named like the page, refuses rather than guess', async () => {
    const pool = igPool([
      { id: 'ig-1', name: 'amanda.recipes', service: 'instagram', boards: [] },
      { id: 'ig-2', name: 'bitecraft', service: 'instagram', boards: [] },
    ]);
    await expect(pool.createInstagramPost(post)).rejects.toThrow(/2 Instagram channels/);
  });
});

describe('the Buffer name of an account', () => {
  it('is its own field when filled, so the account name stays free to remember it by', () => {
    expect(bufferChannelName({ channel_name: 'ArbmomRecipes', buffer_channel: 'Kitchen Stories' })).toBe('Kitchen Stories');
    expect(bufferChannelName({ channel_name: 'ArbmomRecipes', buffer_channel: '  ' })).toBe('ArbmomRecipes');
  });
});

describe('an account with no channel for the network', () => {
  it('is reported as missing the channel, not as a full queue', async () => {
    const { pool } = poolNamed('', PAGES); // Facebook pages only, no TikTok
    const error = await pool.createTikTokVideo({ text: 'Truffles', videoUrl: 'https://s.com/v.mp4' } as never)
      .then(() => null, (e: Error) => e);
    expect(error!.message).toMatch(/has no TikTok channel/);
    expect(isBufferExhausted(error)).toBe(false);
  });
});

