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
    expect(reelCta('La recette complète : {domain}', 'arbmom.com')).toBe('La recette complète : arbmom.com');
    expect(reelCta('La recette complète : {domain}', 'dailyfoodpins.com')).toBe('La recette complète : dailyfoodpins.com');
  });

  it('says the address the way a voiceover reads it', () => {
    // The line is spoken word for word, so a protocol, a www. or a trailing
    // slash would all be read out loud.
    expect(reelCta('La recette complète : {domain}', 'https://arbmom.com/')).toBe('La recette complète : arbmom.com');
    expect(reelCta('La recette complète : {domain}', 'www.Arbmom.com')).toBe('La recette complète : Arbmom.com');
    expect(reelCta('Visit { domain } today', 'arbmom.com')).toBe('Visit arbmom.com today');
  });

  it('leaves no trace of the placeholder when there is no site to name', () => {
    // "La recette complète :" with nothing after the colon is worse than no call to
    // action at all, and the voiceover would read the dangling colon.
    expect(reelCta('La recette complète : {domain}', '')).toBe('La recette complète');
    expect(reelCta('La recette complète — {domain}', '   ')).toBe('La recette complète');
  });

  it('leaves a line that names no domain exactly as written', () => {
    expect(reelCta('La recette complète in the comments', 'arbmom.com')).toBe('La recette complète in the comments');
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
      cta: reelCta('La recette complète : {domain}', 'arbmom.com'),
    });

    expect(prompt).toContain('word for word: "La recette complète : arbmom.com"');
    expect(prompt).toContain('Subtitle: "La recette complète : arbmom.com"');
    expect(prompt).not.toContain('{domain}');
  });

  it('falls back to a line that is true on every network when the setting is blank', () => {
    // Not "in the comments": the link is in the post text on Facebook, the bio
    // or first comment on Instagram, and the description on YouTube.
    const prompt = buildReelPrompt({ title: 'Apple Crumble Tart', presenter: null, cta: '' });
    expect(prompt).toContain('La recette complète sur notre site');
    expect(prompt).not.toContain('in the comments');
  });
});
