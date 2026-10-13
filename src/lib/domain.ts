/**
 * One way of writing a domain, so two spellings of the same site match.
 *
 * A site is stored as `bitespoon.com`, but the same site is written a dozen
 * ways by the time it reaches a spreadsheet column heading:
 * `https://bitespoon.com`, `www.bitespoon.com`, `BITESPOON.COM`,
 * `https://bitespoon.com/`. Comparing those as raw strings means a CSV import
 * silently matches nothing and every keyword arrives linked to no site —
 * which looks like a successful import and publishes nothing.
 */
export function normaliseDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .replace(/^www\./, '')
    .replace(/\/.*$/, '') // path, query, fragment
    .replace(/:\d+$/, '') // port
    .trim();
}

/** True when two ways of writing a domain mean the same site. */
export const sameDomain = (a: string, b: string): boolean =>
  normaliseDomain(a) === normaliseDomain(b) && normaliseDomain(a) !== '';
