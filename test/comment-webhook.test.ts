import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel, createRun, insertFbToken, insertKeyword, markRunPublished, recordFbFeedPostResolved,
  setFbPageOptions, updateReel, upsertFbPage, upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The comment-keyword webhook: each post asks for its own word, and only that
 * word (or the global one, for a post that predates per-post words) sends the
 * link to the commenter.
 */
const sent = vi.hoisted(() => [] as { pageId: string; commentId: string; message: string; card?: { title: string; url: string } }[]);
const rejectCards = vi.hoisted(() => ({ on: false }));
const publicReplies = vi.hoisted(() => [] as { commentId: string; message: string }[]);
const failPublic = vi.hoisted(() => ({ on: false }));
const failPrivate = vi.hoisted(() => ({ on: false }));
vi.mock('../src/integrations/facebook.js', () => ({
  FacebookClient: vi.fn().mockImplementation(function FacebookClient() {
    return {
      privateReply: vi.fn(async (input: { pageId: string; commentId: string; message: string; card?: { title: string; url: string } }) => {
        if (input.card && rejectCards.on) throw new Error('templates not allowed');
        if (failPrivate.on) throw new Error('no DM');
        sent.push(input);
        return { messageId: 'M1' };
      }),
      replyToComment: vi.fn(async (input: { commentId: string; message: string }) => {
        if (failPublic.on) throw new Error('no public');
        publicReplies.push(input);
        return { commentId: 'R1' };
      }),
      videoIdOfPost: vi.fn(async () => 'VID9'),
    };
  }),
  FacebookError: class FacebookError extends Error {},
}));

const KEY = randomBytes(32);
const SECRET = 'webhook-secret';
let app: FastifyInstance;
let pageRow = 0;
let runId = 0;

beforeEach(async () => {
  setLogLevel('error');
  process.env.FB_WEBHOOK_VERIFY_TOKEN = SECRET;
  sent.length = 0;
  publicReplies.length = 0;
  failPublic.on = false;
  failPrivate.on = false;
  rejectCards.on = false;
  openDatabase(':memory:');
  const siteId = upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  const keywordId = insertKeyword({ seed_keyword: 'pizza', spy_title: 'Pizza' });
  runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://a.com/pizza', 'Pizza');
  const tokenId = insertFbToken('A', 'tok', KEY);
  pageRow = upsertFbPage({ pageId: '555', name: 'Page', tokenId });
  setFbPageOptions(pageRow, { siteId, autoPublish: false, enabled: true });
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
});
afterEach(async () => {
  delete process.env.FB_WEBHOOK_VERIFY_TOKEN;
  await app.close();
  closeDatabase();
});

const comment = (message: string, ids: { post_id?: string; video_id?: string }, fromId = '777') =>
  app.inject({
    method: 'POST',
    url: `/webhooks/facebook?key=${SECRET}`,
    payload: {
      object: 'page',
      entry: [{ id: '555', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message, from: { id: fromId }, ...ids } }] }],
    },
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a keyword comment', () => {
  it("answers the word this post asked for, and not the global one", async () => {
    recordFbFeedPostResolved({ runId, fbPageId: pageRow, purpose: 'facebook', fbPostId: '555_1', triggerKeyword: 'pizza' });

    await comment('banana', { post_id: '555_1' });
    await settle();
    expect(sent).toHaveLength(0);

    await comment('PIZZA please', { post_id: '555_1' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pageId: '555', commentId: 'C1' });
    expect(sent[0]!.message).toContain('https://a.com/pizza');
  });

  it('keeps answering the global word on a post that has no word of its own', async () => {
    recordFbFeedPostResolved({ runId, fbPageId: pageRow, purpose: 'facebook', fbPostId: '555_2' });
    await comment('banana', { post_id: '555_2' });
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("finds a reel through the video behind the commented post, by the reel's own word", async () => {
    const reelId = createReel({ runId, siteId: null, keywordId: null, fbPageId: pageRow, prompt: 'p', caption: 'Pizza', references: [] });
    updateReel(reelId, { fbVideoId: 'VID9', triggerKeyword: 'pizza' });

    await comment('pizza', { post_id: '555_999' }); // the post id of the reel, not its video id
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("never answers the Page's own comments", async () => {
    recordFbFeedPostResolved({ runId, fbPageId: pageRow, purpose: 'facebook', fbPostId: '555_3', triggerKeyword: 'pizza' });
    await comment('pizza', { post_id: '555_3' }, '555');
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe('the public reply', () => {
  beforeEach(() => {
    recordFbFeedPostResolved({ runId, fbPageId: pageRow, purpose: 'facebook', fbPostId: '555_5', triggerKeyword: 'pizza' });
  });

  it('answers under the comment after the private reply', async () => {
    await comment('pizza', { post_id: '555_5' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(publicReplies).toHaveLength(1);
    expect(publicReplies[0]!.commentId).toBe('C1');
    expect(publicReplies[0]!.message.length).toBeGreaterThan(5);
  });

  it('stays silent when the private reply failed', async () => {
    failPrivate.on = true;
    await comment('pizza', { post_id: '555_5' });
    await settle();
    expect(publicReplies).toHaveLength(0);
  });

  it('does not undo the private reply when the public one fails', async () => {
    failPublic.on = true;
    const res = await comment('pizza', { post_id: '555_5' });
    await settle();
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('can be turned off in settings', async () => {
    new Settings(KEY).set('fb_public_reply', 'false');
    await comment('pizza', { post_id: '555_5' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(publicReplies).toHaveLength(0);
  });
});

describe('the link card', () => {
  beforeEach(() => {
    recordFbFeedPostResolved({ runId, fbPageId: pageRow, purpose: 'facebook', fbPostId: '555_6', triggerKeyword: 'pizza' });
  });

  it('is sent with the title and a button to the article', async () => {
    await comment('pizza', { post_id: '555_6' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.card).toMatchObject({ title: 'Pizza', url: 'https://a.com/pizza' });
  });

  it('falls back to the plain link when Facebook refuses the card', async () => {
    rejectCards.on = true;
    await comment('pizza', { post_id: '555_6' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.card).toBeUndefined();
    expect(sent[0]!.message).toContain('https://a.com/pizza');
  });
});
