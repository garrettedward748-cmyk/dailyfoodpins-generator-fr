/**
 * A pin's title, read from Pinterest itself.
 *
 * The Analytics export lists the top pins by link only, so the words that say
 * what each pin is have to come from the pin. No account or token is needed:
 * Pinterest's oEmbed answer and the pin page's own meta tags are public. Both
 * are tried, then the words of the address the pin sends people to, which for
 * the site's own pins is the article's slug ("/lemon-pizza-bites/").
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** A title that says nothing about the dish. */
const generic = (t: string): boolean => !t || /^(pinterest|pin on .*|.*\bon pinterest|épingle sur .*|sur pinterest)$/i.test(t.trim());

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\\//g, '/');

/** Strip what Pinterest adds around a title. */
const clean = (t: string): string =>
  decode(t)
    .replace(/\s*[|\-–]\s*Pinterest\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

const meta = (html: string, name: string): string => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
  const m = re.exec(html);
  return clean(m?.[1] ?? m?.[2] ?? '');
};

/** The words of a destination address: "https://d.com/lemon-pizza-bites/" -> "lemon pizza bites". */
export function slugTitle(url: string): string {
  try {
    const u = new URL(url);
    if (/pinterest\./.test(u.hostname)) return '';
    const last = u.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return /^\d*$/.test(last) ? '' : decodeURIComponent(last).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** The best title readable from a pin page's HTML. Exported for the tests. */
export function titleFromPage(html: string): string {
  const og = meta(html, 'og:title');
  if (!generic(og)) return og;
  // The page's own data names the pin, then the address it sends people to.
  const json = /"(?:grid_title|title)"\s*:\s*"((?:[^"\\]|\\.){3,200})"/.exec(html)?.[1];
  if (json && !generic(clean(json))) return clean(json);
  const link = /"link"\s*:\s*"(https?:(?:[^"\\]|\\.)+)"/.exec(html)?.[1];
  const fromLink = link ? slugTitle(decode(link)) : '';
  if (fromLink) return fromLink;
  const description = meta(html, 'og:description') || meta(html, 'description');
  return generic(description) ? '' : description.slice(0, 120);
}

async function get(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8,fr;q=0.6' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
}

/** The title of one pin, or '' when Pinterest gives none. */
export async function pinTitle(url: string, timeoutMs = 8000): Promise<string> {
  const embed = await get(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`, timeoutMs);
  if (embed?.ok) {
    try {
      const body = (await embed.json()) as { title?: string };
      const t = clean(body.title ?? '');
      if (!generic(t)) return t;
    } catch {
      /* not JSON: the page is tried next */
    }
  }
  const page = await get(url, timeoutMs);
  if (!page?.ok) return '';
  return titleFromPage(await page.text());
}
