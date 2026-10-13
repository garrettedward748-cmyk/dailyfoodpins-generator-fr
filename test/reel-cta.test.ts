import { describe, expect, it } from 'vitest';
import { reelCta } from '../src/reels/cta.js';
import { buildReelPrompt } from '../src/reels/compose.js';

/**
 * The address a reel ends on.
 *
 * One Call to action setting serves every site, so the address cannot be typed
 * into it — `arbmom.com` would follow that site's reels onto every other site's.
 * The operator writes {domain} and each reel stamps the site it belongs to.
 */

describe('reelCta', () => {
  it('stamps the site that reel belongs to', () => {
    expect(reelCta('Full recipe: {domain}', 'arbmom.com')).toBe('Full recipe: arbmom.com');
    expect(reelCta('Full recipe: {domain}', 'dailyfoodpins.com')).toBe('Full recipe: dailyfoodpins.com');
  });

  it('says the address the way a voiceover reads it', () => {
    // The line is spoken word for word, so a protocol, a www. or a trailing
    // slash would all be read out loud.
    expect(reelCta('Full recipe: {domain}', 'https://arbmom.com/')).toBe('Full recipe: arbmom.com');
    expect(reelCta('Full recipe: {domain}', 'www.Arbmom.com')).toBe('Full recipe: Arbmom.com');
    expect(reelCta('Visit { domain } today', 'arbmom.com')).toBe('Visit arbmom.com today');
  });

  it('leaves no trace of the placeholder when there is no site to name', () => {
    // "Full recipe:" with nothing after the colon is worse than no call to
    // action at all, and the voiceover would read the dangling colon.
    expect(reelCta('Full recipe: {domain}', '')).toBe('Full recipe');
    expect(reelCta('Full recipe — {domain}', '   ')).toBe('Full recipe');
  });

  it('leaves a line that names no domain exactly as written', () => {
    expect(reelCta('Full recipe in the comments', 'arbmom.com')).toBe('Full recipe in the comments');
    expect(reelCta('', 'arbmom.com')).toBe('');
  });
});

describe('the prompt the clip is filmed from', () => {
  it('carries the resolved address into the voiceover and the subtitle', () => {
    // One clip mode has no ffmpeg pass: the closing line is spoken and
    // subtitled by the video model, from this prompt. An unresolved {domain}
    // here would be read out as the word "domain".
    const prompt = buildReelPrompt({
      title: 'Apple Crumble Tart',
      presenter: null,
      cta: reelCta('Full recipe: {domain}', 'arbmom.com'),
    });

    expect(prompt).toContain('word for word: "Full recipe: arbmom.com"');
    expect(prompt).toContain('Subtitle: "Full recipe: arbmom.com"');
    expect(prompt).not.toContain('{domain}');
  });

  it('falls back to a line that is true on every network when the setting is blank', () => {
    // Not "in the comments": the link is in the post text on Facebook, the bio
    // or first comment on Instagram, and the description on YouTube.
    const prompt = buildReelPrompt({ title: 'Apple Crumble Tart', presenter: null, cta: '' });
    expect(prompt).toContain('Full recipe on our site');
    expect(prompt).not.toContain('in the comments');
  });
});
