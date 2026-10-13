import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { Settings } from '../src/settings.js';
import {
  addCaptionStructure, customizeCaption, isCaptionCustom, listCaptionStructures, nextCaptionShape, resetCaption,
  saveCaptionStructure, setSiteCaptionSetting, siteCaptionSetting, withSiteOverrides,
} from '../src/core/caption-structures.js';

/** Setup -> Caption structures, per site: a site follows the default until it is customized. */

const KEY = randomBytes(32);
let settings: Settings;
let a: number;
let b: number;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  settings = new Settings(KEY);
  a = upsertSite({ name: 'A', domain: 'a.test', status: 'active', daily_target: 1, interval_minutes: 60 } as never, KEY);
  b = upsertSite({ name: 'B', domain: 'b.test', status: 'active', daily_target: 1, interval_minutes: 60 } as never, KEY);
});
afterEach(() => closeDatabase());

describe('a site that follows the default', () => {
  it('sees the default shapes and settings', () => {
    expect(isCaptionCustom(a)).toBe(false);
    expect(listCaptionStructures(a).map((s) => s.name)).toEqual(listCaptionStructures().map((s) => s.name));
    expect(withSiteOverrides(settings, a).get('caption_fb_post_link')).toBe('text');
  });

  it('ignores a stray override until the site is customized', () => {
    setSiteCaptionSetting(a, 'caption_fb_post_link', 'none');
    expect(siteCaptionSetting(a, 'caption_fb_post_link')).toBeUndefined();
    expect(withSiteOverrides(settings, a).get('caption_fb_post_link')).toBe('text');
  });
});

describe('customizing a site', () => {
  it('starts from a copy of the default, and changes only that site', () => {
    settings.set('caption_fb_post_link', 'comment');
    const before = listCaptionStructures().length;
    customizeCaption(a, settings);

    expect(isCaptionCustom(a)).toBe(true);
    expect(listCaptionStructures(a)).toHaveLength(before);
    expect(withSiteOverrides(settings, a).get('caption_fb_post_link')).toBe('comment');

    setSiteCaptionSetting(a, 'caption_fb_post_link', 'none');
    addCaptionStructure('Mine', '- only for A', a);
    const first = listCaptionStructures(a)[0]!;
    saveCaptionStructure(first.id, { name: 'Changed', body: first.body, enabled: false });

    expect(withSiteOverrides(settings, a).get('caption_fb_post_link')).toBe('none');
    expect(withSiteOverrides(settings, b).get('caption_fb_post_link')).toBe('comment');
    expect(settings.get('caption_fb_post_link')).toBe('comment');
    expect(listCaptionStructures(a).map((s) => s.name)).toContain('Mine');
    expect(listCaptionStructures(b).map((s) => s.name)).not.toContain('Mine');
    expect(listCaptionStructures().map((s) => s.name)).not.toContain('Changed');
    expect(listCaptionStructures().map((s) => s.name)).not.toContain('Mine');
  });

  it('is not repeated by a second customize', () => {
    customizeCaption(a, settings);
    const n = listCaptionStructures(a).length;
    customizeCaption(a, settings);
    expect(listCaptionStructures(a)).toHaveLength(n);
  });

  it('leaves non-caption settings alone', () => {
    customizeCaption(a, settings);
    expect(withSiteOverrides(settings, a).get('fb_enabled')).toBe(settings.get('fb_enabled'));
    setSiteCaptionSetting(a, 'llm_base_url', 'http://x');
    expect(withSiteOverrides(settings, a).get('llm_base_url')).toBe(settings.get('llm_base_url'));
  });

  it("takes the next shape from the site's own list", () => {
    customizeCaption(a, settings);
    for (const s of listCaptionStructures(a)) saveCaptionStructure(s.id, { name: s.name, body: s.body, enabled: false });
    const only = addCaptionStructure('Only one', '- the only shape on A', a);
    expect(nextCaptionShape(a)).toEqual({ shape: '- the only shape on A', id: only });
    expect(nextCaptionShape(b).shape).not.toBe('- the only shape on A');
  });

  it('goes back to the default and removes what was its own', () => {
    customizeCaption(a, settings);
    setSiteCaptionSetting(a, 'caption_fb_post_link', 'none');
    resetCaption(a);
    expect(isCaptionCustom(a)).toBe(false);
    expect(withSiteOverrides(settings, a).get('caption_fb_post_link')).toBe('text');
    expect(get('SELECT COUNT(*) AS n FROM caption_structures WHERE site_id = ?', a)).toEqual({ n: 0 });
  });
});
