import { describe, expect, it } from 'vitest';
import { SECTIONS, sectionFor } from '../src/web/views/layout.js';

/**
 * Five sections, in the order a person uses them: what is happening, what we
 * publish, where, why something did not happen, and setup. A page belongs to
 * exactly one section, found from its URL, so a route never has to say which.
 */
describe('navigation', () => {
  it('has the seven sections in order', () => {
    expect(SECTIONS.map((s) => s.label)).toEqual([
      'Home', 'Content', 'Channels', 'Search Console', 'Taxonomy', 'Activity', 'Setup',
    ]);
  });

  it.each([
    ['/', 'Home'],
    ['/runs', 'Content'],
    ['/runs/42', 'Content'],
    ['/keywords/7', 'Content'],
    ['/reels/new/3/caption', 'Content'],
    ['/sites', 'Channels'],
    ['/sites/2', 'Channels'],
    ['/accounts', 'Channels'],
    ['/events', 'Activity'],
    ['/decisions', 'Activity'],
    ['/settings', 'Setup'],
    ['/settings/prompts/part-1', 'Setup'],
    ['/browser', 'Setup'],
  ])('%s belongs to %s', (path, label) => {
    expect(sectionFor(path)?.label).toBe(label);
  });

  it('marks the page inside the section, not only the section', () => {
    const section = sectionFor('/settings/prompts/part-1')!;
    const page = section.pages.find((p) => p.href === '/settings/prompts');
    expect(page).toBeDefined();
  });
});

describe('the Rotation tab', () => {
  const ROTATION = [
    '/settings/article-structures', '/settings/photo-styles', '/settings/blog-structures',
    '/settings/pin-designs', '/settings/caption-structures', '/settings/reel-structures',
  ];

  it('stands for six pages as one tab in Setup', async () => {
    const { layout, html } = await import('../src/web/views/layout.js');
    const page = layout({ title: 't', active: '/settings', body: html`` });
    const outer = page.match(/<nav class="subnav" [^>]*>([\s\S]*?)<\/nav>/)![1]!;
    expect(outer).toContain('>Rotation</a>');
    for (const label of ['Pin designs', 'Photo styles', 'Article structures', 'Blog structures', 'Caption structures', 'Reel structures']) {
      expect(outer).not.toContain(`>${label}</a>`);
    }
    // No inner strip on a page outside the group.
    expect(page).not.toContain('subnav-inner');
  });

  it.each(ROTATION)('%s lights the Rotation tab and lists all six beneath it', async (path) => {
    const { layout, html } = await import('../src/web/views/layout.js');
    const page = layout({ title: 't', active: path, body: html`` });
    const outer = page.match(/<nav class="subnav" [^>]*>([\s\S]*?)<\/nav>/)![1]!;
    expect(outer).toMatch(/class="active"\s*>Rotation<\/a>/);
    const inner = page.match(/<nav class="subnav subnav-inner"[^>]*>([\s\S]*?)<\/nav>/)![1]!;
    for (const href of ROTATION) expect(inner).toContain(`href="${href}"`);
    expect(inner).toContain(`href="${path}" class="active"`);
    expect(inner).toContain('>Article</span>');
    expect(inner).toContain('>Networks</span>');
  });
});
