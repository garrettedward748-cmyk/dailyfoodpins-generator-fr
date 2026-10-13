import type { Step } from '../engine.js';
import { DishIndex } from '../../core/similar-title.js';
import { halalOnly, haramWord } from '../../core/halal.js';
import { publishedTitles } from '../../db/repos.js';
import { createLogger, errorMessage } from '../../lib/logger.js';

const log = createLogger('duplicate-step');

/** Halal only is on and the keyword names alcohol or pork: skipped before anything is spent. */
export class NotHalalError extends Error {
  constructor(readonly keywordTitle: string, readonly word: string) {
    super(`“${keywordTitle}” names ${word} — not written (Halal only)`);
    this.name = 'NotHalalError';
  }
}

/** The keyword names a dish this site already has: the run stops before spending anything. */
export class AlreadyOnSiteError extends Error {
  constructor(
    readonly keywordTitle: string,
    readonly existingTitle: string,
    readonly existingUrl: string | null,
  ) {
    super(`“${keywordTitle}” is already on the site as “${existingTitle}”`);
    this.name = 'AlreadyOnSiteError';
  }
}

/**
 * First step of every run: is this dish already on the site?
 *
 * Checked against the site's own published recipes and every article the
 * platform has published there, before the model, the images or the site are
 * touched. The check after writing only warned, so a keyword whose title
 * differed a little from one already used -- "Mini Blueberry Cheesecakes" and
 * "Mini Blueberry Cheesecakes – Individual Desserts" -- was written, paid for
 * and published a second time.
 *
 * A run that is resumed or approved has passed this already (the step is
 * checkpointed), so a person releasing a held article is never second-guessed.
 */
export const checkNotOnSite: Step<void, { checked: number }> = {
  name: 'check-duplicate',
  title: 'Check the dish is not already on the site',
  async run(ctx) {
    const keywordTitle = (ctx.keyword.spy_title || ctx.keyword.seed_keyword || '').trim();
    const haram = halalOnly() ? haramWord(`${keywordTitle} ${ctx.keyword.seed_keyword ?? ''}`) : null;
    if (haram) throw new NotHalalError(keywordTitle, haram);
    if (!keywordTitle) return { checked: 0 };

    const existing: { title: string; url: string | null }[] = [...publishedTitles(ctx.site.id)];
    try {
      for (const item of await ctx.siteApi.getContent('recipe')) existing.push({ title: item.title, url: item.url });
    } catch (err) {
      // The site's list is the better half of the check, not a reason to stop.
      log.warn(`could not read ${ctx.site.domain}'s recipes for the duplicate check: ${errorMessage(err)}`);
    }

    const index = new DishIndex(existing.map((e) => e.title));
    const twin = index.find(keywordTitle);
    if (twin) {
      const url = existing.find((e) => e.title === twin)?.url ?? null;
      throw new AlreadyOnSiteError(keywordTitle, twin, url);
    }
    return { checked: existing.length };
  },
};
