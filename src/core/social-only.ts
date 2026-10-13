import { normaliseDomain } from '../lib/domain.js';

/**
 * Social-only accounts: a "site" with no website behind it.
 *
 * Added on the Sites page with the Domain left blank. The run still picks a
 * keyword, researches it and writes the recipe, and every network it is set up
 * for still gets its posts -- but no article is published anywhere and no post
 * carries a link. The images the posts need a public address for are kept on
 * the platform itself (see media-store.ts) and removed again once the networks
 * have had time to copy them.
 *
 * Such an account is stored under a handle made from its name, with no dot in
 * it. That is the whole marker: a real domain always has a dot, a handle never
 * does, so writing a real domain over the handle later turns the account into
 * an ordinary site with every keyword, account and run it already had.
 */

/** True for an account that has no website: its "domain" is a handle with no dot. */
export function isSocialOnly(site: { domain: string }): boolean {
  const domain = normaliseDomain(site.domain);
  return domain !== '' && !domain.includes('.');
}

/** The handle a social-only account is stored under, made from its name. */
export function socialHandle(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * What the site form's Domain field means: the domain written, or -- left
 * blank -- the account's handle. Throws when there is neither, because a blank
 * name gives no handle to store the account under.
 */
export function siteKey(name: string, domain: string): string {
  const written = normaliseDomain(domain);
  if (written) return written;
  const handle = socialHandle(name);
  if (!handle) {
    throw new Error('Give the account a name (letters or numbers) when the domain is left blank.');
  }
  return handle;
}

/** The host part of a site's domain, without scheme or trailing slash. */
function hostOf(site: { domain: string }): string {
  return site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * The public link of something a run published, or '' for a social-only
 * account, which published nothing a link could point to. Every caption
 * builder already drops its link line when the url is empty.
 */
export function sitePostUrl(site: { domain: string }, href: string | null | undefined): string {
  if (isSocialOnly(site)) return '';
  return `https://${hostOf(site)}${String(href ?? '')}`;
}

/**
 * A stored image or video as a full url. Social-only accounts store full urls
 * already (on the platform), sites store paths on the site; a full url passes
 * through unchanged either way.
 */
export function siteAssetUrl(site: { domain: string }, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `https://${hostOf(site)}${path}`;
}

/**
 * What a picture or caption calls the account: its domain, or for a
 * social-only account its name -- a handle like "arbmom-social" is not
 * something to print on a pin.
 */
export function brandName(site: { domain: string; name?: string }): string {
  if (!isSocialOnly(site)) return hostOf(site);
  return (site.name ?? '').trim() || site.domain;
}
