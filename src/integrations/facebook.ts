import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('facebook');

/**
 * Facebook Graph API client, for publishing Reels to Pages.
 *
 * Authentication is a Business Manager **system user** token. Unlike a user
 * token it has no 60-day clock and survives a password change, because it
 * belongs to the business rather than to a person — which is what makes
 * unattended publishing possible without a refresh job nobody remembers to
 * check. One client per token; a page publishes with the token it was found
 * under, so pages from several apps sit side by side.
 *
 * Page tokens are minted per publish rather than stored. They are derivable
 * from the system token in one call, and deriving them means a page that gains
 * or loses permission takes effect immediately instead of at the next time
 * somebody re-pastes a credential.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export class FacebookError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'FacebookError';
  }
}

export interface FacebookPage {
  id: string;
  name: string;
}

export interface PublishedReel {
  videoId: string;
  permalink: string;
}

export interface FacebookClientOptions {
  systemUserToken: string;
  /**
   * How long to wait for Facebook to finish processing an uploaded video.
   *
   * Publishing is not the end of it: Facebook accepts the upload, returns a
   * video id, and only then transcodes — and a rejected video reports its
   * rejection here, minutes later. Treating the upload as success is how a
   * failure gets recorded as a publish.
   */
  pollIntervalMs?: number;
  maxAttempts?: number;
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_user_msg?: string };
}

export class FacebookClient {
  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(options: FacebookClientOptions) {
    this.token = options.systemUserToken.trim();
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 60;
  }

  get configured(): boolean {
    return this.token !== '';
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new FacebookError(
        'This page has no Facebook token. Add one under Settings → Facebook.',
      );
    }
  }

  /**
   * Read a Graph response, turning its error envelope into a thrown error.
   *
   * Graph answers 200 with an `error` object often enough that checking the
   * status alone lets failures through as success.
   */
  private async read<T>(response: Response, what: string): Promise<T> {
    const text = await response.text();

    let body: (T & GraphError) | undefined;
    try {
      body = text ? (JSON.parse(text) as T & GraphError) : undefined;
    } catch {
      throw new FacebookError(`${what} returned a non-JSON response`, text.slice(0, 300));
    }

    if (body?.error) {
      const message = body.error.error_user_msg ?? body.error.message ?? 'unknown error';
      throw new FacebookError(`${what} failed: ${message}`, JSON.stringify(body.error));
    }

    if (!response.ok) {
      throw new FacebookError(`${what} failed: HTTP ${response.status}`, text.slice(0, 300));
    }

    if (body === undefined) {
      throw new FacebookError(`${what} returned an empty response`);
    }

    return body;
  }

  /** Every Page the system user can see. Used to verify the token. */
  async listPages(): Promise<FacebookPage[]> {
    this.assertConfigured();

    const url = new URL(`${GRAPH}/me/accounts`);
    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('limit', '200');
    url.searchParams.set('access_token', this.token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{ data?: FacebookPage[] }>(response, 'Listing pages');
    return body.data ?? [];
  }

  /**
   * A Page's most recent videos (Reels included), newest first.
   *
   * Read-only -- `pages_read_engagement` covers it, nothing posting-related
   * needed. This is how a reel published through Buffer gets its real video
   * id filled in after the fact: Buffer cannot say what Facebook assigned a
   * queued post, but this can, once the post actually goes live.
   */
  async listRecentVideos(pageId: string, limit = 25): Promise<{ id: string; description: string; createdTime: string }[]> {
    const token = await this.pageToken(pageId);

    const url = new URL(`${GRAPH}/${pageId}/videos`);
    url.searchParams.set('fields', 'id,description,created_time');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('access_token', token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{
      data?: { id: string; description?: string; created_time?: string }[];
    }>(response, 'Listing recent videos');

    return (body.data ?? []).map((v) => ({
      id: v.id,
      description: v.description ?? '',
      createdTime: v.created_time ?? '',
    }));
  }

  /**
   * A Page's most recent feed posts (image posts, the photo collage), newest
   * first. The image-post counterpart to `listRecentVideos`, for the same
   * reason: Buffer cannot say what Facebook will assign a post it has only
   * queued, so this is how that id is found once the post actually goes live.
   */
  async listRecentPosts(pageId: string, limit = 25): Promise<{ id: string; message: string; createdTime: string }[]> {
    const token = await this.pageToken(pageId);

    const url = new URL(`${GRAPH}/${pageId}/feed`);
    url.searchParams.set('fields', 'id,message,created_time');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('access_token', token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{
      data?: { id: string; message?: string; created_time?: string }[];
    }>(response, 'Listing recent posts');

    return (body.data ?? []).map((v) => ({
      id: v.id,
      message: v.message ?? '',
      createdTime: v.created_time ?? '',
    }));
  }

  /**
   * A page access token, derived from the system user token.
   *
   * Not cached: the call is cheap next to uploading a video, and a stale page
   * token is an authorisation failure at the worst possible moment — after the
   * video has been generated and paid for.
   */
  async pageToken(pageId: string): Promise<string> {
    this.assertConfigured();

    const url = new URL(`${GRAPH}/${pageId}`);
    url.searchParams.set('fields', 'access_token');
    url.searchParams.set('access_token', this.token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{ access_token?: string }>(
      response,
      `Fetching a page token for ${pageId}`,
    );

    if (!body.access_token) {
      throw new FacebookError(
        `Page ${pageId} returned no access token. The system user probably has no ` +
          'role on that page, or is missing pages_manage_posts.',
      );
    }

    return body.access_token;
  }

  /**
   * Publish a Reel to a Page.
   *
   * Four steps, not three: start reserves a video id and an upload URL, the
   * bytes go to that URL, finish publishes it, and then Facebook is polled
   * until it says the video is actually ready. Skipping the fourth reports
   * rejected videos as published.
   */
  async publishReel(input: {
    pageId: string;
    video: Buffer;
    description: string;
    /** The reel's name. Without one Facebook lists it as "Untitled Video". */
    title?: string;
  }): Promise<PublishedReel> {
    const token = await this.pageToken(input.pageId);

    const { videoId, uploadUrl } = await this.startUpload(input.pageId, token);
    log.debug(`reel upload ${videoId} started for page ${input.pageId}`);

    await this.uploadBytes(uploadUrl, token, input.video);
    log.debug(`reel ${videoId}: ${input.video.length} bytes uploaded`);

    await this.finishUpload(input.pageId, token, videoId, input.description, input.title);
    log.info(`reel ${videoId} submitted, waiting for Facebook to finish processing`);

    await this.waitUntilReady(videoId, token);

    return {
      videoId,
      permalink: `https://www.facebook.com/reel/${videoId}`,
    };
  }

  /**
   * Publish an image post to a Page's feed, as the Page.
   *
   * One call, not the multi-step upload a Reel needs: Graph accepts a remote
   * image URL directly on `/photos` and hands back the real post id in the
   * same response -- there is no transcoding step to wait on, so unlike
   * `publishReel` there is nothing to poll. This is what lets the
   * comment-keyword webhook work on an image post the moment it goes out,
   * with no backfill in between.
   */
  async publishPhotoPost(input: {
    pageId: string;
    imageUrl: string;
    caption: string;
  }): Promise<{ postId: string; photoId: string }> {
    const token = await this.pageToken(input.pageId);

    const response = await fetch(`${GRAPH}/${input.pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.imageUrl, caption: input.caption, access_token: token }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await this.read<{ id?: string; post_id?: string }>(response, 'Publishing the Facebook photo post');
    if (!body.id) throw new FacebookError('Facebook did not return a photo id for the post');
    // `post_id` ("<page id>_<post id>") is the id the comment-keyword webhook
    // matches against (it is what Facebook sends back as `value.post_id` on
    // a feed comment). A Page publishing to its own timeline always gets one
    // back; the photo id is the fallback only so the post is still recorded
    // if it somehow does not.
    return { postId: body.post_id ?? body.id, photoId: body.id };
  }

  /**
   * The video behind a post, when it is one. A comment event on a reel names
   * the post ("<page>_<post>"), while the reel is recorded under its video id,
   * and the two differ; the post's attachment points at the video.
   */
  async videoIdOfPost(pageId: string, postId: string): Promise<string | undefined> {
    const token = await this.pageToken(pageId);

    const url = new URL(`${GRAPH}/${postId}`);
    url.searchParams.set('fields', 'attachments{target{id},type}');
    url.searchParams.set('access_token', token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{
      attachments?: { data?: { target?: { id?: string } }[] };
    }>(response, 'Looking up the video of a post');
    return body.attachments?.data?.find((a) => a.target?.id)?.target?.id;
  }

  /**
   * Leave a comment on a published reel, as the Page.
   *
   * This is where the article link goes. Not the caption: a link in the
   * description is the thing Facebook's ranking reads as an exit and shows
   * to fewer people, and it is also what makes a post look like an ad. The
   * first comment carries it fine and still gets tapped.
   *
   * Needs pages_manage_engagement on the token, which a token minted for
   * publishing alone may lack. That surfaces as a Graph error here rather
   * than a silent absence, so the caller can say so.
   */
  async commentOnReel(input: {
    pageId: string;
    videoId: string;
    message: string;
  }): Promise<{ commentId: string }> {
    const token = await this.pageToken(input.pageId);

    const response = await fetch(`${GRAPH}/${input.videoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input.message, access_token: token }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await this.read<{ id?: string }>(response, 'Commenting on the reel');
    if (!body.id) throw new FacebookError('Facebook did not return a comment id');

    return { commentId: body.id };
  }

  /**
   * Leave a comment on any published object -- a feed post or a photo, not
   * only a reel. Same endpoint and the same reasoning as `commentOnReel`
   * (the link goes in the first comment, not the caption); a second name
   * because `publishPhotoPost`'s caller is not publishing a reel.
   */
  commentOnPost(input: { pageId: string; postId: string; message: string }): Promise<{ commentId: string }> {
    return this.commentOnReel({ pageId: input.pageId, videoId: input.postId, message: input.message });
  }

  /**
   * Send a private reply to a comment, as the Page.
   *
   * This is the keyword-triggered DM: someone comments a trigger word under a
   * post or reel, and this puts the article link in their Messenger inbox
   * without them having to message the Page first. Needs `pages_messaging` on
   * the token -- a Graph error here most often means that scope is missing.
   */
  async privateReply(input: {
    pageId: string;
    commentId: string;
    message: string;
    /**
     * A link card (picture, title and a button) instead of bare text. A bare
     * link is dead in Messenger's "message requests" until the reader replies;
     * a button is not.
     */
    card?: { title: string; imageUrl?: string; url: string; buttonTitle?: string };
  }): Promise<{ messageId: string }> {
    const token = await this.pageToken(input.pageId);
    const card = input.card;
    const message = card
      ? {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: [
                {
                  title: card.title.slice(0, 80),
                  ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
                  default_action: { type: 'web_url', url: card.url },
                  buttons: [{ type: 'web_url', url: card.url, title: (card.buttonTitle ?? 'Tap for link!').slice(0, 20) }],
                },
              ],
            },
          },
        }
      : { text: input.message };

    // The Messenger Platform form: POST /{page-id}/messages addressed to a
    // comment. It reports clearer errors than /{comment-id}/private_replies,
    // which answers "does not exist" for every kind of refusal.
    const response = await fetch(`${GRAPH}/${input.pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { comment_id: input.commentId },
        message,
        access_token: token,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await this.read<{ message_id?: string; id?: string }>(response, 'Sending a private reply');
    const messageId = body.message_id ?? body.id;
    if (!messageId) throw new FacebookError('Facebook did not return a message id for the private reply');

    return { messageId };
  }

  /**
   * Reply publicly under a comment, as the Page. Used after the private
   * reply so the commenter (and onlookers) see that the recipe was sent.
   */
  async replyToComment(input: {
    pageId: string;
    commentId: string;
    message: string;
  }): Promise<{ commentId: string }> {
    const token = await this.pageToken(input.pageId);
    const response = await fetch(`${GRAPH}/${input.commentId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input.message, access_token: token }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await this.read<{ id?: string }>(response, 'Replying to a comment');
    if (!body.id) throw new FacebookError('Facebook did not return a comment id for the reply');
    return { commentId: body.id };
  }

  private async startUpload(
    pageId: string,
    pageToken: string,
  ): Promise<{ videoId: string; uploadUrl: string }> {
    const response = await fetch(`${GRAPH}/${pageId}/video_reels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_phase: 'start', access_token: pageToken }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await this.read<{ video_id?: string; upload_url?: string }>(
      response,
      'Starting the reel upload',
    );

    if (!body.video_id || !body.upload_url) {
      throw new FacebookError('Facebook did not return a video id and upload URL');
    }

    return { videoId: body.video_id, uploadUrl: body.upload_url };
  }

  /**
   * The bytes themselves.
   *
   * Note this does not go to the Graph host and does not take an access_token
   * parameter: the upload URL is its own endpoint and wants the page token in
   * an `Authorization: OAuth` header, which is the one place in this API where
   * that is true.
   */
  private async uploadBytes(uploadUrl: string, pageToken: string, video: Buffer): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageToken}`,
        offset: '0',
        file_size: String(video.length),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(video),
      signal: AbortSignal.timeout(600_000),
    });

    await this.read<{ success?: boolean }>(response, 'Uploading the reel');
  }

  private async finishUpload(
    pageId: string,
    pageToken: string,
    videoId: string,
    description: string,
    title?: string,
  ): Promise<void> {
    const url = new URL(`${GRAPH}/${pageId}/video_reels`);
    url.searchParams.set('upload_phase', 'finish');
    url.searchParams.set('video_id', videoId);
    url.searchParams.set('video_state', 'PUBLISHED');
    url.searchParams.set('description', description);
    const name = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (name) url.searchParams.set('title', name);
    url.searchParams.set('access_token', pageToken);

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });

    await this.read<{ success?: boolean }>(response, 'Publishing the reel');
  }

  /**
   * Wait for Facebook to finish processing, and fail if it refuses the video.
   *
   * `video_status` is the field that tells the truth. `ready` means published;
   * `error` means the upload succeeded and the video did not.
   */
  private async waitUntilReady(videoId: string, pageToken: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));

      const url = new URL(`${GRAPH}/${videoId}`);
      url.searchParams.set('fields', 'status');
      url.searchParams.set('access_token', pageToken);

      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const body = await this.read<{
        status?: { video_status?: string; processing_phase?: { status?: string } };
      }>(response, `Checking reel ${videoId}`);

      const state = (body.status?.video_status ?? '').toLowerCase();

      if (state === 'ready') {
        log.debug(`reel ${videoId} ready after ${attempt} poll(s)`);
        return;
      }

      if (state === 'error') {
        throw new FacebookError(
          `Facebook rejected reel ${videoId} during processing`,
          JSON.stringify(body.status),
        );
      }
    }

    const waited = Math.round((this.maxAttempts * this.pollIntervalMs) / 1000);
    throw new FacebookError(
      `Reel ${videoId} was still processing after ${waited}s. It may yet publish — ` +
        'check the page before uploading it again.',
    );
  }

  /** Prove the token works, without publishing anything. */
  async healthCheck(): Promise<{ ok: boolean; pages?: number; error?: string }> {
    try {
      const pages = await this.listPages();
      return { ok: true, pages: pages.length };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
