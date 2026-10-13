/**
 * The call to action a reel ends on, with the site's own address in it.
 *
 * The text the operator writes is one setting shared by every site, so an
 * address cannot simply be typed into it: `arbmom.com` would follow that site's
 * reels onto every other site's. They write `{domain}` instead and each reel
 * stamps the site it belongs to.
 *
 * Why an address at all, rather than a line saying where the link is: the same
 * video goes to Facebook, Instagram and YouTube, and the link sits somewhere
 * different on each — the post text, the bio or first comment, the description.
 * Any sentence naming one place is wrong on the other two. An address is true
 * everywhere, and on a YouTube Short it is the only route there is: links in a
 * Short's description have not been clickable since August 2023.
 */
export function reelCta(text: string, domain: string): string {
  const host = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');

  if (!/\{\s*domain\s*\}/i.test(text)) return text.trim();

  // A social-only account's handle has no dot: it is not an address anyone
  // could visit, so it is treated as no site at all.
  if (host && !host.includes('.')) return text.replace(/[\s:：\-–—]*\{\s*domain\s*\}/gi, '').trim();

  // With no site to name, the placeholder leaves no trace: "Full recipe:" with
  // nothing after the colon is worse than no call to action, and a reel is
  // filmed from this text — the voiceover reads it word for word.
  if (!host) return text.replace(/[\s:：\-–—]*\{\s*domain\s*\}/gi, '').trim();

  return text.replace(/\{\s*domain\s*\}/gi, host).trim();
}
