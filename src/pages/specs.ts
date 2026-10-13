/**
 * The static pages a recipe site needs, what each must say, and the checks a
 * written page passes before it is shown or sent.
 *
 * The same five pages and the same required points as the site's own Admin →
 * Pages writer (dailyfoodpins controllers/ai.php) and as POST /api/page, which
 * refuses a page that fails them. Checking here first means a bad draft is sent
 * back to the model instead of bouncing off the site.
 */

export const PAGE_SLUGS = ['about', 'contact', 'privacy', 'terms', 'disclaimer'] as const;
export type PageSlug = (typeof PAGE_SLUGS)[number];

export function isPageSlug(value: string): value is PageSlug {
  return (PAGE_SLUGS as readonly string[]).includes(value);
}

export const PAGE_TITLE: Record<PageSlug, string> = {
  about: 'About',
  contact: 'Contact',
  privacy: 'Privacy Policy',
  terms: 'Terms of Use',
  disclaimer: 'Disclaimer',
};

/** A page shorter than this many words is sent back to the model once more. */
export const MIN_WORDS: Record<PageSlug, number> = {
  about: 330,
  contact: 110,
  privacy: 850,
  terms: 550,
  disclaimer: 380,
};

/** What each page must contain. Placeholders in {{braces}} are filled in by the site. */
export const PAGE_SPECS: Record<PageSlug, string> = {
  about:
    'The About page. Who runs {{site_name}} and cooks the recipes ({{author}}), why the site exists, what kind of recipes it publishes and for whom, ' +
    'how recipes are developed and tested, and how to get in touch (link to /contact). Warm, honest, first person. ' +
    'Ground it in the site\'s real content listed below: name the kinds of dishes and categories it really has. ' +
    'Use only the facts given; where a fact is not given, write around it rather than inventing one (no invented years, awards, schools, hometowns or numbers). 400 to 600 words.',
  contact:
    'The text shown ABOVE the contact form on the Contact page. Say what people can write about (recipe questions, corrections, collaborations, privacy requests), ' +
    'the email address {{email}} as a mailto link, a realistic reply time without promising a fixed one, and that recipe questions are best asked in the recipe comments. ' +
    'Do not add a form. 130 to 230 words.',
  privacy:
    'The Privacy Policy. Start with <p><em>Last updated: {{updated}}</em></p>. It MUST cover, each under its own <h2>: information collected (given by visitors and collected automatically), ' +
    'how it is used, cookies, advertising and Google AdSense (Google and third-party vendors use cookies, including the DoubleClick cookie, to serve ads based on prior visits; ' +
    'opt-out links https://www.google.com/settings/ads and https://www.aboutads.info/choices/ and https://www.youronlinechoices.eu/; ' +
    'link https://policies.google.com/technologies/partner-sites), analytics (Google Analytics and its opt-out add-on), social sharing, how long data is kept, ' +
    'sharing of information (never sold), your rights (GDPR for EEA/UK visitors and CCPA/CPRA for California residents: access, correction, deletion, opt-out), ' +
    "children's privacy (COPPA, not directed at children under 13), security, changes to the policy, and contact ({{email}}). 1000 to 1500 words.",
  terms:
    'The Terms of Use. Start with <p><em>Last updated: {{updated}}</em></p>. Cover: acceptance of the terms, use of the site, intellectual property ' +
    '(recipes, text and photos belong to {{site_name}}; a single photo with a credit link may be shared, whole recipes may not be republished), ' +
    'user content (comments, ratings) and a licence to display it, prohibited conduct, third-party links and ads, disclaimer of warranties, limitation of liability, ' +
    'indemnification, changes to the terms, and contact ({{email}}). Do not name a country, state or court. 700 to 1100 words.',
  disclaimer:
    'The Disclaimer. Start with <p><em>Last updated: {{updated}}</em></p>. Cover: general information only; recipes and results vary (ovens, ingredients, altitude); ' +
    'nutrition information is an automatic estimate, not professional advice; food safety (safe internal temperatures, raw eggs, storage) with a link to https://www.foodsafety.gov/; ' +
    'allergies (always check labels); not medical or dietary advice; advertising and any affiliate links (we may earn from qualifying purchases at no cost to the reader); ' +
    'errors and omissions; external links; and contact ({{email}}). 450 to 750 words.',
};

/** Strings a page must still contain, case-insensitively. Mirrors ai_page_missing() on the site. */
const MUST_CONTAIN: Record<PageSlug, string[]> = {
  about: [],
  contact: ['{{email}}'],
  privacy: ['google.com/settings/ads', 'aboutads.info', 'cookie', 'AdSense', '{{email}}'],
  terms: ['{{email}}'],
  disclaimer: ['{{email}}', 'nutrition'],
};

const TAGS_ALLOWED = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'br', 'a']);

/**
 * Keep only simple formatting; drop anything that could run or restyle the page.
 * Mirrors ai_clean_html() on the site, and drops a leading <h1> (the page shows its own title).
 */
export function cleanPageHtml(input: string): string {
  let out = input
    .replace(/```(?:html)?/gi, '')
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');

  out = out.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (whole, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    if (!TAGS_ALLOWED.has(tag)) return '';
    if (whole.startsWith('</')) return `</${tag}>`;
    if (tag !== 'a') return `<${tag}>`;
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = (href?.[2] ?? href?.[3] ?? '').trim();
    if (!url || /^\s*(javascript|data|vbscript):/i.test(url)) return '<a href="#">';
    return `<a href="${url.replace(/"/g, '&quot;')}">`;
  });

  return out.trim();
}

export function countWords(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

/** What a page still lacks; empty means it can go. */
export function missingFromPage(slug: PageSlug, html: string): string[] {
  const lower = html.toLowerCase();
  const missing = MUST_CONTAIN[slug].filter((needle) => !lower.includes(needle.toLowerCase()));
  const words = countWords(html);
  if (words < MIN_WORDS[slug]) {
    missing.push(`enough text (${words} words, at least ${MIN_WORDS[slug]} needed)`);
  }
  // Written to the page or left as a template marker: any other {{...}} is a leak.
  const stray = [...html.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)]
    .map((m) => m[1]!.toLowerCase())
    .filter((n) => !['site_name', 'domain', 'site_url', 'email', 'author', 'updated'].includes(n));
  if (stray.length > 0) missing.push(`no unknown placeholders (found {{${stray[0]}}})`);
  if (/\[(your|insert|name|email|date)[^\]]*\]/i.test(html)) missing.push('no bracketed placeholders like [Your Name]');
  return missing;
}
