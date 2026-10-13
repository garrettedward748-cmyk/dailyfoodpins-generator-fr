import { errorMessage } from '../lib/logger.js';

/**
 * Client for the APIs each publishing site exposes:
 *   GET  /api/categories
 *   POST /api/upload    (multipart)
 *   POST /api/recipe
 *   GET  /api/recipe?id=
 *
 * Contracts were recovered from a captured successful n8n execution.
 */

export interface Category {
  id: string;
  slug: string;
  title: string;
  href: string;
  alt: string;
  description: string;
  image?: string;
  recipeCount?: number;
}

export interface UploadResult {
  success: boolean;
  url: string;
  thumbnailUrl: string;
  filename: string;
  originalName: string;
  width: number;
  height: number;
  size: number;
  category: string;
}

export interface PostedRecipe {
  id: string;
  title: string;
  href: string;
  categoryId: string;
  heroImage?: string;
  featuredText?: string;
  [key: string]: unknown;
}

/** One published recipe or post, as /api/content lists it. */
export interface SiteContentItem {
  type: 'recipe' | 'post';
  slug: string;
  title: string;
  summary: string;
  keyword?: string;
  category?: string;
  url: string;
}

export type TaxonomyTable = 'categories' | 'cuisines' | 'tags';

export interface TaxonomyItem {
  table: TaxonomyTable;
  id: number;
  name: string;
  slug: string;
  published: boolean;
  recipes: number;
  /** Text fields with nothing in them: title_tag, meta_desc, intro_html, body_html (tags: intro_html only). */
  empty: string[];
  image: string | null;
  url: string;
}

export interface TaxonomyUpdate {
  table: TaxonomyTable;
  id: number;
  title_tag?: string;
  meta_desc?: string;
  intro_html?: string;
  body_html?: string;
  image?: string;
  name?: string;
  published?: boolean;
}

export class SiteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'SiteApiError';
  }
}

/** Turn a status code into the thing an operator actually needs to check. */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return ' (check the site API token in Settings → Sites)';
  }
  if (status === 404) return ' (endpoint not found — is this site running the expected API?)';
  if (status === 413) return ' (payload too large)';
  if (status >= 500) return ' (the site itself returned an error)';
  return '';
}

export class SiteApiClient {
  constructor(
    private readonly domain: string,
    private readonly apiToken: string,
  ) {}

  private url(path: string): string {
    const host = this.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${host}${path}`;
  }

  /**
   * The public URL of something this site is serving.
   *
   * `uploadImage` returns a site-relative path; prefixed with the domain it
   * becomes a permanent link any other site can download from — which is what
   * lets one keyword's images be shared across sites without an image cache.
   * An already-absolute URL passes through unchanged, so callers do not have
   * to know which kind they are holding.
   */
  absoluteUrl(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.url(path);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  async getCategories(): Promise<Category[]> {
    const response = await fetch(this.url('/api/categories'), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `GET /api/categories failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }

    const json: unknown = await response.json();
    if (Array.isArray(json)) return json as Category[];

    // Tolerate a wrapped payload without assuming one.
    const wrapped = json as { categories?: Category[]; data?: Category[] };
    return wrapped.categories ?? wrapped.data ?? [];
  }

  /**
   * The cuisines the site will accept.
   *
   * /api/recipe refuses a cuisine it does not know rather than filing the
   * recipe under none, so the list has to be read rather than inferred from
   * the dish — "Algerian" is the obvious answer for a tajine and the wrong
   * one on a site whose cuisine is called "North African".
   */
  async getCuisines(): Promise<Category[]> {
    const response = await fetch(this.url('/api/cuisines'), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    // A site that does not serve this endpoint is a site that files nothing
    // by cuisine. That is a shape of site, not a failure, and refusing to
    // write the article over it would be wrong.
    if (response.status === 404) return [];

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `GET /api/cuisines failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }

    const json: unknown = await response.json();
    if (Array.isArray(json)) return json as Category[];

    const wrapped = json as { cuisines?: Category[]; data?: Category[] };
    return wrapped.cuisines ?? wrapped.data ?? [];
  }

  async uploadImage(
    data: Buffer,
    filename: string,
    contentType = 'image/webp',
    category = 'recipes',
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append('category', category);
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename);

    const response = await fetch(this.url('/api/upload'), {
      method: 'POST',
      headers: this.authHeaders(), // fetch sets the multipart boundary itself
      body: form,
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `POST /api/upload failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }

    const result = (await response.json()) as UploadResult;
    if (!result.url) throw new SiteApiError('Upload returned no url', 200, JSON.stringify(result));
    return result;
  }

  /**
   * Put a finished reel on the site and give back its public url.
   *
   * Buffer will not take a file: media is attached by url and Buffer's
   * servers fetch the bytes themselves. So a reel assembled here has to be
   * somewhere public before it can be scheduled, and the site it belongs to
   * is that somewhere.
   */
  async uploadVideo(
    data: Buffer,
    filename: string,
    contentType = 'video/mp4',
  ): Promise<{ url: string; size: number }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename);

    const response = await fetch(this.url('/api/upload-video'), {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
      signal: AbortSignal.timeout(600_000),
    });

    const body = await response.text();

    if (!response.ok) {
      throw new SiteApiError(
        `POST /api/upload-video failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 300)}` : ''}`,
        response.status,
        body,
      );
    }

    const result = JSON.parse(body) as { url?: string; size?: number };

    if (!result.url) {
      throw new SiteApiError('Video upload returned no url', response.status, body);
    }

    // Absolute already, because this url leaves the building: Buffer resolves
    // nothing and a site-relative path would simply fail to download.
    return { url: this.absoluteUrl(result.url), size: result.size ?? data.length };
  }

  /**
   * Publish the assembled recipe.
   *
   * The body is the recipe object exactly as the article prompts produce it,
   * matching the previous implementation's `JSON.stringify($json)`.
   */
  /** What the site has published, for choosing internal links. Empty on a site without the endpoint. */
  async getContent(type?: 'recipe' | 'post'): Promise<SiteContentItem[]> {
    const query = type ? `?type=${type}&limit=500` : '?limit=500';
    const response = await fetch(this.url(`/api/content${query}`), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `GET /api/content failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }
    const json = (await response.json()) as { items?: SiteContentItem[] };
    return Array.isArray(json.items) ? json.items : [];
  }

  /** Publish a blog article. Returns its id, slug and public url. */
  async publishPost(post: {
    title: string;
    slug?: string;
    title_tag?: string;
    meta_desc?: string;
    excerpt?: string;
    body_html: string;
    cover?: string;
    cover_alt?: string;
    recipe_card?: string;
    status?: 'published' | 'draft';
  }, idempotencyKey?: string): Promise<{ id: number; slug: string; url: string }> {
    const response = await fetch(this.url('/api/publish'), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
        // One key per question: a retried post returns the post already made.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ type: 'post', status: 'published', ...post }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new SiteApiError(
        `POST /api/publish (post) rejected by ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)} — ${text.slice(0, 400)}`,
        response.status,
        text,
      );
    }
    const json = JSON.parse(text) as { id: number; slug: string };
    return { id: json.id, slug: json.slug, url: this.url(`/blog/${json.slug}`) };
  }

  /**
   * `idempotencyKey` is the same for every attempt of one run: a site that
   * already saved the recipe on an attempt whose answer was lost returns that
   * recipe instead of making a second one.
   */
  async postRecipe(recipe: Record<string, unknown>, idempotencyKey?: string): Promise<PostedRecipe> {
    const response = await fetch(this.url('/api/recipe'), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(recipe),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new SiteApiError(
        `POST /api/recipe rejected by ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)} — ${text.slice(0, 400)}`,
        response.status,
        text,
      );
    }

    try {
      return JSON.parse(text) as PostedRecipe;
    } catch {
      throw new SiteApiError(
        `POST /api/recipe returned unparseable JSON from ${this.domain}`,
        response.status,
        text,
      );
    }
  }

  async getRecipe(id: string): Promise<PostedRecipe> {
    const response = await fetch(this.url(`/api/recipe?id=${encodeURIComponent(id)}`), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new SiteApiError(
        `GET /api/recipe?id=${id} failed on ${this.domain}: HTTP ${response.status}` +
          describeStatus(response.status),
        response.status,
        await response.text().catch(() => ''),
      );
    }
    return (await response.json()) as PostedRecipe;
  }

  /** Show a video uploaded with uploadVideo on a recipe's page (and in its schema). */
  /** The "Tools I used" list of a recipe (the site shows it with Amazon links). */
  /** Every category, cuisine and tag, with its empty fields and recipe count (see the site's /api/taxonomy). */
  async getTaxonomy(): Promise<TaxonomyItem[]> {
    const json = await this.getJson('/api/taxonomy');
    return ((json as { items?: TaxonomyItem[] }).items ?? []);
  }

  /** Up to 12 published recipes in one term, newest first. */
  async getTaxonomyRecipes(table: string, id: number): Promise<{ title: string; url: string }[]> {
    const json = await this.getJson(`/api/taxonomy/recipes?table=${encodeURIComponent(table)}&id=${id}`);
    return ((json as { recipes?: { title: string; url: string }[] }).recipes ?? []);
  }

  /** Fill a term's empty fields (the site never overwrites what is there), its image, name spelling, published. */
  async updateTaxonomy(update: TaxonomyUpdate): Promise<string[]> {
    const response = await fetch(this.url('/api/taxonomy/update'), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new SiteApiError(
        `POST /api/taxonomy/update failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 300)}` : ''}`,
        response.status,
        body,
      );
    }
    try {
      return (JSON.parse(body) as { updated?: string[] }).updated ?? [];
    } catch {
      return [];
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(this.url(path), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `GET ${path.replace(/\?.*$/, '')} failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${response.status === 404 ? ' (update the site: it has no taxonomy API yet)' : ''}` +
          `${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }
    return response.json();
  }

  async setRecipeTools(id: string, tools: { name: string; search: string }[]): Promise<void> {
    const response = await fetch(this.url('/api/recipe/tools'), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(id), tools }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `POST /api/recipe/tools failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 300)}` : ''}`,
        response.status,
        body,
      );
    }
  }

  async attachRecipeVideo(id: string, video: string): Promise<void> {
    const response = await fetch(this.url('/api/recipe/video'), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(id), video }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `POST /api/recipe/video failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 300)}` : ''}`,
        response.status,
        body,
      );
    }
  }

  /**
   * Save the text of a static page (about, contact, privacy, terms, disclaimer).
   * The site checks it again and refuses one that lacks a required point, with
   * a 422 naming what is missing.
   */
  async savePage(slug: string, htmlText: string): Promise<{ words: number }> {
    const response = await fetch(this.url('/api/page'), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, html: htmlText }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 404
        ? ' (this site has not been updated with the /api/page endpoint yet — redeploy the site first)'
        : describeStatus(response.status);
      throw new SiteApiError(
        `POST /api/page (${slug}) rejected by ${this.domain}: HTTP ${response.status}${hint} — ${text.slice(0, 300)}`,
        response.status,
        text,
      );
    }
    const json = JSON.parse(text) as { words?: number };
    return { words: Number(json.words) || 0 };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getCategories();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
