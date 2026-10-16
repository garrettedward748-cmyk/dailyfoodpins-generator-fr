import { randomUUID } from 'node:crypto';
import { isSocialOnly } from '../core/social-only.js';
import { saveMediaImage, saveMediaVideo } from './media-store.js';
import {
  SiteApiClient,
  SiteApiError,
  type Category,
  type PostedRecipe,
  type SiteContentItem,
  type TaxonomyItem,
  type UploadResult,
} from './site-api.js';

const SOCIAL_CATEGORIES = [
  'Breakfast', 'Lunch', 'Dinner', 'Main Dishes', 'Side Dishes', 'Appetizers', 'Soups', 'Salads',
  'Pasta', 'Chicken', 'Beef', 'Seafood', 'Vegetarian', 'Desserts', 'Baking', 'Snacks', 'Drinks',
];

/**
 * The stand-in for a website, for an account that has none.
 *
 * Every pipeline step talks to its site through one client, so this is the
 * one place a social-only account differs: pictures and videos go to the
 * platform's own media store and come back as full public urls, the site's
 * lists (categories, cuisines, published recipes) are empty, and anything
 * that would publish to a website refuses plainly instead of reaching for a
 * domain that does not exist. The pipeline never asks it to publish; the
 * refusals are there so a page or tool that forgot to check says why.
 */
export class SocialOnlySiteApi extends SiteApiClient {
  constructor(private readonly handle: string) {
    super(handle, '');
  }

  private refuse(what: string): never {
    throw new SiteApiError(`${this.handle} is a social-only account with no website, so it cannot ${what}.`, 0, '');
  }

  override absoluteUrl(path: string): string {
    return path;
  }

  /**
   * General recipe categories. The spy check files every dish under one of the
   * site's categories and refuses a site with none; an account with no website
   * has no list of its own, so it gets these. Nothing is filed anywhere: the
   * category only steers how the recipe is written.
   */
  override async getCategories(): Promise<Category[]> {
    return SOCIAL_CATEGORIES.map((title, i) => ({
      id: String(i + 1),
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      title,
      href: '',
      alt: title,
      description: '',
    }));
  }

  override async getCuisines(): Promise<Category[]> {
    return [];
  }

  override async getContent(): Promise<SiteContentItem[]> {
    return [];
  }

  override async uploadImage(data: Buffer, filename: string, contentType = 'image/webp', category = 'recipes'): Promise<UploadResult> {
    // A name made from the recipe ("cookies-aux-pepites-hero-a1b2c3.webp") keeps its words.
    const stem = filename.replace(/\.[a-z0-9]+$/i, '').replace(/-[0-9a-f]{6}$/, '');
    const prefix = filename.startsWith('reel-') ? 'reel' : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(filename) || !stem ? 'img' : stem;
    const saved = await saveMediaImage(data, contentType, prefix);
    return {
      success: true,
      url: saved.url,
      thumbnailUrl: saved.url,
      filename: saved.name,
      originalName: filename || `${randomUUID()}.jpg`,
      width: 0,
      height: 0,
      size: saved.size,
      category,
    };
  }

  override async uploadVideo(data: Buffer): Promise<{ url: string; size: number }> {
    const saved = saveMediaVideo(data, 'reel');
    return { url: saved.url, size: saved.size };
  }

  override async postRecipe(): Promise<PostedRecipe> {
    return this.refuse('publish an article');
  }

  override async getRecipe(): Promise<PostedRecipe> {
    return this.refuse('look up a published recipe');
  }

  override async publishPost(): Promise<never> {
    return this.refuse('publish a blog article');
  }

  override async getTaxonomy(): Promise<TaxonomyItem[]> {
    return [];
  }

  override async getTaxonomyRecipes(): Promise<{ title: string; url: string }[]> {
    return [];
  }

  override async updateTaxonomy(): Promise<string[]> {
    return this.refuse('update categories or cuisines');
  }

  override async setRecipeTools(): Promise<void> {
    // No recipe page to show a tools box on: nothing to do.
  }

  override async attachRecipeVideo(): Promise<void> {
    // No recipe page to attach a reel to: nothing to do.
  }

  override async savePage(): Promise<{ words: number }> {
    return this.refuse('publish a page');
  }

  override async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
}

/** The client for a site: its own website's API, or the stand-in when it has none. */
export function siteApiFor(site: { domain: string }, apiToken: string): SiteApiClient {
  return isSocialOnly(site) ? new SocialOnlySiteApi(site.domain) : new SiteApiClient(site.domain, apiToken);
}
