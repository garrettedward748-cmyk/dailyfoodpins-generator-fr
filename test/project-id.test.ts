import { describe, expect, it } from 'vitest';
import {
  describeProjectId,
  placeholderProjectId,
  resolveProjectId,
} from '../src/core/project-id.js';

/**
 * The value that reaches Google as clientContext.projectId.
 *
 * It was previously an environment variable on the image service — one value
 * for every site, fixed at container start, and completely deaf to the field in
 * Settings. Sites each have their own Flow project, so that could only ever be
 * right for one of them.
 */

describe('which project a site generates into', () => {
  it("prefers the site's own project", () => {
    const resolved = resolveProjectId('site-project', 'shared-project', 'bitespoon.com');

    expect(resolved).toEqual({ projectId: 'site-project', source: 'site' });
  });

  it('falls back to the shared one from Settings', () => {
    const resolved = resolveProjectId('', 'shared-project', 'bitespoon.com');

    expect(resolved).toEqual({ projectId: 'shared-project', source: 'settings' });
  });

  it('treats whitespace as unset on both tiers', () => {
    expect(resolveProjectId('   ', 'shared', 'a.com').source).toBe('settings');
    expect(resolveProjectId('   ', '  ', 'a.com').source).toBe('placeholder');
  });

  it('treats null and undefined as unset', () => {
    expect(resolveProjectId(null, undefined, 'a.com').source).toBe('placeholder');
    expect(resolveProjectId(undefined, 'shared', 'a.com').source).toBe('settings');
  });

  it('falls back to a placeholder rather than refusing to generate', () => {
    const resolved = resolveProjectId('', '', 'bitespoon.com');

    expect(resolved.source).toBe('placeholder');
    expect(resolved.projectId).not.toBe('');
  });
});

describe('the placeholder', () => {
  it('is the same every time for one domain', () => {
    // A projectId that changed per request would be a stronger signal to
    // Google than one that is merely unfamiliar.
    expect(placeholderProjectId('bitespoon.com')).toBe(placeholderProjectId('bitespoon.com'));
  });

  it('differs between sites', () => {
    expect(placeholderProjectId('bitespoon.com')).not.toBe(placeholderProjectId('longlivo.com'));
  });

  it('ignores how the domain was capitalised', () => {
    expect(placeholderProjectId('BiteSpoon.com')).toBe(placeholderProjectId('bitespoon.com'));
  });

  it('is shaped like a real Flow project id', () => {
    // Flow's own are UUIDs; something obviously not one is a clearer tell.
    expect(placeholderProjectId('bitespoon.com')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is stable across every site tested', () => {
    for (const domain of ['a.com', 'b.org', 'chocofeverdream.com', 'zucchinibreadrecipes.org']) {
      expect(placeholderProjectId(domain)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe('saying which project was used', () => {
  it('names the site when the site has its own', () => {
    const message = describeProjectId(
      resolveProjectId('proj-1', 'shared', 'bitespoon.com'),
      'bitespoon.com',
    );
    expect(message).toContain('bitespoon.com');
    expect(message).toContain('proj-1');
  });

  it('says the shared one was used and why', () => {
    const message = describeProjectId(resolveProjectId('', 'shared', 'a.com'), 'a.com');
    expect(message).toContain('shared');
    expect(message).toContain('none of its own');
  });

  it('says plainly that a placeholder is not a real project', () => {
    const message = describeProjectId(resolveProjectId('', '', 'a.com'), 'a.com');

    expect(message).toContain('placeholder');
    expect(message).toContain('Set a real one');
  });
});
