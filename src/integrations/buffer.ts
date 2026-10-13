import { createLogger, errorMessage } from '../lib/logger.js';

/**
 * Buffer GraphQL client for Pinterest scheduling.
 * Queries are reproduced from the captured n8n execution.
 */

const ENDPOINT = 'https://api.buffer.com';

export interface BufferBoard {
  serviceId: string;
  name: string;
}

export interface BufferChannel {
  id: string;
  name: string;
  /** Which network this channel posts to: "pinterest", "facebook", … */
  service: string;
  boards: BufferBoard[];
}

export class BufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

const log = createLogger('buffer');

/**
 * A GraphQL "that field does not exist" error about one of a network's
 * metadata fields: the name it refused and, when GraphQL offers one, the name
 * it meant. `typeName` is the metadata input type's name as Buffer's schema
 * spells it ("Youtube" for `YoutubeMetadataInput`, say) -- GraphQL always
 * names the type in this error, which is what makes the match specific to
 * one network's fields rather than any field on any type.
 */
function unknownMetadataField(err: unknown, typeName: string): { field: string; suggestion?: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = new RegExp(`Field "(\\w+)" is not defined by type "${typeName}\\w*"\\.?(?:\\s*Did you mean "(\\w+)"\\?)?`, 'i').exec(message);
  if (!match) return null;
  return { field: match[1]!, suggestion: match[2] };
}

/** Whether a GraphQL error is about one field's value type rather than its name. */
function badMetadataValue(err: unknown, field: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return new RegExp(field, 'i').test(message)
    && /(cannot represent|expected type|invalid value|enum|of type "Int")/i.test(message);
}

export class BufferClient {
  constructor(private readonly token: string) {}

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BufferError(`Buffer HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new BufferError(`Buffer GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new BufferError('Buffer returned no data');

    return json.data;
  }

  async getOrganizationId(): Promise<string> {
    const data = await this.graphql<{
      account: { organizations: { id: string; name: string }[] };
    }>(`query GetOrganizations {
  account {
    organizations {
      id
      name
    }
  }
}`);

    const org = data.account?.organizations?.[0];
    if (!org) throw new BufferError('No Buffer organization found for this token');
    return org.id;
  }

  async getChannels(organizationId: string): Promise<BufferChannel[]> {
    const data = await this.graphql<{
      channels: {
        id: string;
        name: string;
        service?: string;
        metadata?: { boards?: BufferBoard[] };
      }[];
    }>(
      'query GetChannelsWithBoards($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name service metadata { ... on PinterestMetadata { boards {  serviceId name  } } } } }',
      { orgId: organizationId },
    );

    return (data.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      service: (c.service ?? '').toLowerCase(),
      boards: c.metadata?.boards ?? [],
    }));
  }

  /**
   * Schedule a Pinterest pin.
   *
   * Values are injected into the mutation as GraphQL string literals, matching
   * the original implementation, so they must be escaped rather than
   * concatenated raw.
   */
  async createPost(input: {
    text: string;
    channelId: string;
    imageUrl: string;
    altText: string;
    title: string;
    linkUrl: string;
    boardServiceId: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');

    const mutation = `mutation CreatePost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          image: {
            url: ${q(input.imageUrl)}
            metadata: {
              altText: ${q(input.altText)}
              animatedThumbnail: "string"
            }
          }
        }
      ]
      metadata: {
        pinterest: {
          title: ${q(input.title)}
          ${input.linkUrl ? `url: ${q(input.linkUrl)}` : ''}
          boardServiceId: ${q(input.boardServiceId)}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost: { post?: { id: string }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      throw new BufferError(`Buffer rejected the post: ${data.createPost.message}`);
    }

    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id');

    return id;
  }

  /**
   * Schedule a Facebook reel.
   *
   * The video is named by url and fetched by Buffer, which is the whole
   * reason the reel is uploaded to the site first. `type: reel` is what
   * separates this from an ordinary video post, and it is a required field
   * on Facebook's metadata rather than an option.
   *
   * The article link goes in `firstComment` and never in the text: a link in
   * the caption is what Facebook's ranking reads as an exit, and it is also
   * what makes a post look like an advert. That was true of the Graph route
   * and it is true here.
   */
  async createReel(input: {
    channelId: string;
    text: string;
    videoUrl: string;
    firstComment?: string;
    /** The reel's name. Without one Facebook lists it as "Untitled Video". */
    title?: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');
    const name = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const videoMeta = name ? `\n            metadata: { title: ${q(name)} }` : '';

    const firstComment =
      input.firstComment && input.firstComment.trim() !== ''
        ? `\n        firstComment: ${q(input.firstComment)}`
        : '';

    const mutation = `mutation CreateReel {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          video: {
            url: ${q(input.videoUrl)}${videoMeta}
          }
        }
      ]
      metadata: {
        facebook: {
          type: reel${firstComment}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost: { post?: { id: string }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      // A plan with no first comment: post without it rather than not at all.
      // The reel still goes out; only the link is missing, and the log says so.
      if (input.firstComment && /first comment/i.test(data.createPost.message)) {
        log.warn('Buffer refused the first comment on a Facebook reel; posting it without the link');
        return this.createReel({ ...input, firstComment: undefined });
      }
      throw new BufferError(`Buffer rejected the reel: ${data.createPost.message}`);
    }

    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id for the reel');

    return id;
  }

  /**
   * A Facebook Page post: one image and its text. The recipe link is in the
   * text, or in `firstComment` when the operator chose that (Setup -> Caption
   * structures); a plan with no first comment posts without it.
   */
  async createFacebookImagePost(input: { channelId: string; text: string; imageUrl: string; firstComment?: string }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');
    const firstComment = input.firstComment?.trim() ? `\n          firstComment: ${q(input.firstComment)}` : '';
    const mutation = `mutation CreateFacebookPost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          image: {
            url: ${q(input.imageUrl)}
          }
        }
      ]
      metadata: {
        facebook: {
          type: post${firstComment}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;
    const data = await this.graphql<{
      createPost?: { post?: { id?: string }; message?: string };
    }>(mutation);
    if (data.createPost?.message) {
      if (input.firstComment && /first comment/i.test(data.createPost.message)) {
        log.warn('Buffer refused the first comment on a Facebook post; posting it without the link');
        return this.createFacebookImagePost({ ...input, firstComment: undefined });
      }
      throw new BufferError(`Buffer rejected the Facebook post: ${data.createPost.message}`);
    }
    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id for the Facebook post');
    return id;
  }

  /**
   * An Instagram post or reel. Instagram has no clickable links in captions,
   * so the recipe link goes in `firstComment` and the caption says where it
   * is. `isAiGenerated` is set because the photos and videos are generated:
   * Instagram asks for that label, and an unlabelled one it detects itself
   * is shown to fewer people.
   */
  async createInstagramPost(input: {
    channelId: string;
    text: string;
    type: 'post' | 'reel';
    imageUrl?: string;
    videoUrl?: string;
    firstComment?: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');
    const asset = input.type === 'reel' ? `video: { url: ${q(input.videoUrl ?? '')} }` : `image: { url: ${q(input.imageUrl ?? '')} }`;
    const firstComment = input.firstComment?.trim() ? `\n          firstComment: ${q(input.firstComment)}` : '';
    const mutation = `mutation CreateInstagramPost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          ${asset}
        }
      ]
      metadata: {
        instagram: {
          type: ${input.type}
          shouldShareToFeed: true
          isAiGenerated: true${firstComment}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;
    const data = await this.graphql<{
      createPost?: { post?: { id?: string }; message?: string };
    }>(mutation);
    if (data.createPost?.message) {
      // Buffer's free plan has no first comment: post without it rather than
      // not at all. The caption already says "link in bio".
      if (input.firstComment && /first comment/i.test(data.createPost.message)) {
        return this.createInstagramPost({ ...input, firstComment: undefined });
      }
      throw new BufferError(`Buffer rejected the Instagram ${input.type}: ${data.createPost.message}`);
    }
    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError(`Buffer did not return a post id for the Instagram ${input.type}`);
    return id;
  }

  /**
   * A YouTube Short: the reel's video, with a title and a category.
   *
   * Buffer caps the title at 100 characters and the description at 5,000, and
   * YouTube refuses a post with no category.
   *
   * Buffer's GraphQL is not published in detail, so rather than cost a deploy
   * per guess this reads the shape it wants out of the refusals themselves:
   *   - "Did you mean X?" renames the field and sends again. GraphQL offers
   *     that whenever the name is close, and taking it is how "category"
   *     became "categoryId" without another round trip.
   *   - a field Buffer does not know and cannot suggest a name for is dropped,
   *     if it is one the post can do without. That is how "type" went.
   *   - a value refused on type is sent again unquoted, since whether an id
   *     wants a String or an Int is not knowable from here.
   * The title and the category are never dropped: YouTube requires both, so a
   * refusal naming one is a real failure rather than a field to shed.
   */
  async createYouTubePost(input: {
    channelId: string;
    title: string;
    text: string;
    videoUrl: string;
    /** A YouTube category id. 26 is Howto & Style, where cooking belongs. */
    category?: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');

    const title = input.title.trim().slice(0, 100);
    const category = (input.category ?? '26').trim();

    // Name -> value as GraphQL will read it. Quoted ids first: a String input
    // takes "26", and an Int or enum input refuses it by type, which is the
    // error the loop below reads.
    const fields = new Map<string, string>([
      ['title', q(title)],
      ['categoryId', q(category)],
      ['isAiGenerated', 'true'],
    ]);
    const droppable = new Set(['isAiGenerated']);
    let idQuoted = true;

    // Bounded before the loop: everything the loop learns changes the map it
    // would otherwise be counting, and a bound that moves is a retry that
    // never runs.
    const tries = fields.size + 3;

    for (let attempt = 0; attempt < tries; attempt++) {
      const body = [...fields].map(([name, value]) => `          ${name}: ${value}`).join('\n');
      const mutation = `mutation CreateYouTubePost {
  createPost(
    input: {
      text: ${q(input.text.slice(0, 5000))}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          video: { url: ${q(input.videoUrl)} }
        }
      ]
      metadata: {
        youtube: {
${body}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

      let data: { createPost?: { post?: { id?: string }; message?: string } };
      try {
        data = await this.graphql<{ createPost?: { post?: { id?: string }; message?: string } }>(mutation);
      } catch (err) {
        const bad = unknownMetadataField(err, 'Youtube');

        if (bad && fields.has(bad.field)) {
          if (bad.suggestion) {
            // Rebuilt rather than edited in place: a Map keeps insertion
            // order, and deleting then adding would move the field to the end.
            const renamed = new Map(
              [...fields].map(([name, value]) => [name === bad.field ? bad.suggestion! : name, value] as const),
            );
            fields.clear();
            for (const [name, value] of renamed) fields.set(name, value);
            if (droppable.delete(bad.field)) droppable.add(bad.suggestion);
            log.warn(`Buffer calls the YouTube field "${bad.field}" "${bad.suggestion}"; sending the Short again`);
            continue;
          }
          if (droppable.has(bad.field)) {
            fields.delete(bad.field);
            droppable.delete(bad.field);
            log.warn(`Buffer does not know the YouTube field "${bad.field}"; sending the Short without it`);
            continue;
          }
        }

        const idField = [...fields.keys()].find((name) => /category/i.test(name));
        if (idQuoted && idField && badMetadataValue(err, idField)) {
          fields.set(idField, category);
          idQuoted = false;
          log.warn(`Buffer refused the YouTube ${idField} as a string; sending it unquoted`);
          continue;
        }

        throw err;
      }

      if (data.createPost?.message) {
        throw new BufferError(`Buffer rejected the YouTube Short: ${data.createPost.message}`);
      }
      const id = data.createPost?.post?.id;
      if (!id) throw new BufferError('Buffer did not return a post id for the YouTube Short');
      return id;
    }

    throw new BufferError('Buffer refused every shape of the YouTube Short this client knows how to send.');
  }

  /**
   * A TikTok video: the reel's video, with its caption and a privacy level.
   *
   * Buffer's GraphQL schema for TikTok is not published, so this reads the
   * field names it wants the same way `createYouTubePost` does: a field GraphQL
   * suggests a different name for is renamed and sent again, and one it does
   * not recognise at all and that the post can do without is dropped.
   *
   * privacyLevel is sent first, because a Buffer that takes it needs it set;
   * but it is also droppable, because the live schema answered
   *   Field "privacyLevel" is not defined by type "TikTokPostMetadataInput"
   * -- Buffer's TikTok input simply has no such field, and sets the privacy
   * itself from the channel. Treating it as mandatory (its first form here)
   * failed every TikTok post outright. A Buffer that refuses the enum by value
   * instead still gets it quoted/unquoted and retried below; only "unknown
   * field" drops it.
   */
  async createTikTokPost(input: {
    channelId: string;
    text: string;
    videoUrl: string;
    /** TikTok's own enum: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, or SELF_ONLY. */
    privacyLevel?: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');

    const privacyLevel = (input.privacyLevel ?? 'PUBLIC_TO_EVERYONE').trim();
    // An ALL_CAPS value reads as TikTok's own enum constant (PUBLIC_TO_EVERYONE
    // and the like), so it is sent unquoted first, as a bare enum; a string
    // field refuses that by type, which the loop below reads and corrects.
    let privacyQuoted = privacyLevel.toUpperCase() !== privacyLevel;

    const fields = new Map<string, string>([
      ['privacyLevel', privacyQuoted ? q(privacyLevel) : privacyLevel],
      ['isAiGenerated', 'true'],
    ]);
    const droppable = new Set(['isAiGenerated', 'privacyLevel']);

    const tries = fields.size + 3;

    for (let attempt = 0; attempt < tries; attempt++) {
      const body = [...fields].map(([name, value]) => `          ${name}: ${value}`).join('\n');
      const mutation = `mutation CreateTikTokPost {
  createPost(
    input: {
      text: ${q(input.text.slice(0, 2200))}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          video: { url: ${q(input.videoUrl)} }
        }
      ]
      metadata: {
        tiktok: {
${body}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

      let data: { createPost?: { post?: { id?: string }; message?: string } };
      try {
        data = await this.graphql<{ createPost?: { post?: { id?: string }; message?: string } }>(mutation);
      } catch (err) {
        const bad = unknownMetadataField(err, 'Tiktok');

        if (bad && fields.has(bad.field)) {
          if (bad.suggestion) {
            const renamed = new Map(
              [...fields].map(([name, value]) => [name === bad.field ? bad.suggestion! : name, value] as const),
            );
            fields.clear();
            for (const [name, value] of renamed) fields.set(name, value);
            if (droppable.delete(bad.field)) droppable.add(bad.suggestion);
            log.warn(`Buffer calls the TikTok field "${bad.field}" "${bad.suggestion}"; sending the video again`);
            continue;
          }
          if (droppable.has(bad.field)) {
            fields.delete(bad.field);
            droppable.delete(bad.field);
            log.warn(`Buffer does not know the TikTok field "${bad.field}"; sending the video without it`);
            continue;
          }
        }

        if (fields.has('privacyLevel') && badMetadataValue(err, 'privacyLevel')) {
          // Sent as a bare enum and refused by type, or the reverse: flip it.
          privacyQuoted = !privacyQuoted;
          fields.set('privacyLevel', privacyQuoted ? q(privacyLevel) : privacyLevel);
          log.warn(`Buffer wants the TikTok privacyLevel ${privacyQuoted ? 'quoted' : 'unquoted'}; sending it that way`);
          continue;
        }

        throw err;
      }

      if (data.createPost?.message) {
        throw new BufferError(`Buffer rejected the TikTok video: ${data.createPost.message}`);
      }
      const id = data.createPost?.post?.id;
      if (!id) throw new BufferError('Buffer did not return a post id for the TikTok video');
      return id;
    }

    throw new BufferError('Buffer refused every shape of the TikTok video this client knows how to send.');
  }

  /** A video pin: the reel's video on a Pinterest board, linking to the recipe. */
  async createVideoPin(input: {
    channelId: string;
    text: string;
    title: string;
    linkUrl: string;
    videoUrl: string;
    boardServiceId: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');

    const mutation = `mutation CreateVideoPin {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          video: {
            url: ${q(input.videoUrl)}
          }
        }
      ]
      metadata: {
        pinterest: {
          title: ${q(input.title)}
          ${input.linkUrl ? `url: ${q(input.linkUrl)}` : ''}
          boardServiceId: ${q(input.boardServiceId)}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost?: { post?: { id?: string }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      throw new BufferError(`Buffer rejected the video pin: ${data.createPost.message}`);
    }
    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id for the video pin');
    return id;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getOrganizationId();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
