import { describe, expect, it } from 'vitest';
import { SiteApiClient } from '../src/integrations/site-api.js';

/**
 * The upload endpoint answers with a site-relative path. Turning that into a
 * public link is what makes an image reusable by another site, so the join has
 * to survive every way a domain gets typed into the sites form.
 */
describe('SiteApiClient.absoluteUrl', () => {
  it('joins a bare domain to an upload path', () => {
    const client = new SiteApiClient('bitespoon.com', 'token');
    expect(client.absoluteUrl('/uploads/recipes/504341a6.webp')).toBe(
      'https://bitespoon.com/uploads/recipes/504341a6.webp',
    );
  });

  it('tolerates a domain that already carries a scheme', () => {
    const client = new SiteApiClient('https://bitespoon.com', 'token');
    expect(client.absoluteUrl('/uploads/a.webp')).toBe('https://bitespoon.com/uploads/a.webp');
  });

  it('tolerates a trailing slash on the domain', () => {
    const client = new SiteApiClient('bitespoon.com/', 'token');
    expect(client.absoluteUrl('/uploads/a.webp')).toBe('https://bitespoon.com/uploads/a.webp');
  });

  it('upgrades an http domain to https, matching every other call', () => {
    const client = new SiteApiClient('http://bitespoon.com', 'token');
    expect(client.absoluteUrl('/uploads/a.webp')).toBe('https://bitespoon.com/uploads/a.webp');
  });

  it('returns an already-absolute url unchanged', () => {
    const client = new SiteApiClient('bitespoon.com', 'token');
    const absolute = 'https://longlivo.com/uploads/recipes/b.webp';
    expect(client.absoluteUrl(absolute)).toBe(absolute);
  });
});
