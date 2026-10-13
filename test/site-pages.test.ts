import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { configurePrompts, loadPrompt } from '../src/pipeline/prompts.js';
import { SITE_PAGE_PLACEHOLDERS } from '../src/pipeline/prompt-contexts.js';
import { cleanPageHtml, countWords, missingFromPage, PAGE_SPECS } from '../src/pages/specs.js';

/**
 * The static pages: what a draft must contain before it is shown or sent, how the
 * model is asked, and the draft-then-publish flow with the model and site standing in.
 */

/** A privacy policy long and complete enough to pass. */
function goodPrivacy(): string {
  const filler = Array.from({ length: 900 }, () => 'word').join(' ');
  return (
    '<p><em>Last updated: {{updated}}</em></p><h2>Cookies and advertising</h2>' +
    '<p>We use cookies. Google AdSense and its partners serve ads. Opt out at ' +
    '<a href="https://www.google.com/settings/ads">Google Ads Settings</a> or ' +
    '<a href="https://www.aboutads.info/choices/">aboutads.info</a>.</p>' +
    `<h2>Contact</h2><p>${filler} <a href="mailto:{{email}}">{{email}}</a></p>`
  );
}

/** A page long enough for about, terms and disclaimer: the email token and a word on nutrition. */
function goodAbout(): string {
  const filler = Array.from({ length: 900 }, () => 'word').join(' ');
  return `<h2>Hello</h2><p>${filler} nutrition <a href="mailto:{{email}}">{{email}}</a></p>`;
}

const calls: { name: string; notes: string }[] = [];
let answers: string[] = [];
const sent: { slug: string; html: string }[] = [];
let siteRefuses = false;

vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async (_s: unknown, _k: unknown, name: string, vars: { notes: string }) => {
    calls.push({ name, notes: vars.notes });
    return { content: answers.shift() ?? '{}' };
  }),
}));

vi.mock('../src/integrations/site-api.js', () => ({
  SiteApiClient: class {
    async getContent() {
      return [
        { type: 'recipe', slug: 'lemon-bars', title: 'Lemon Bars', summary: '', category: 'Dessert', url: 'https://x.com/recipe/lemon-bars' },
        { type: 'post', slug: 'freezing', title: 'Freezing Desserts', summary: '', url: 'https://x.com/blog/freezing' },
      ];
    }
    async savePage(slug: string, html: string) {
      if (siteRefuses) throw new Error('POST /api/page (privacy) rejected by x.com: HTTP 422 — {"error":"page_incomplete"}');
      sent.push({ slug, html });
      return { words: countWords(html) };
    }
  },
}));

const { aboutCheckDue, describeContent, describeFacts, draftSiteFacts, publishSitePage, refreshAboutIfDue, siteChanged, siteSignature, writeAndPublishAll, writeSitePage } = await import('../src/pages/engine.js');
const { canWrite, getAboutAuto, getPageFacts, getSitePage, listSitePages, markWorking, savePageFacts, setAboutAuto } = await import('../src/pages/repo.js');
const { run } = await import('../src/db/index.js');

const KEY = randomBytes(32);
const settings = { get: () => '' } as never;
let siteId = 0;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  calls.length = 0;
  answers = [];
  sent.length = 0;
  siteRefuses = false;
  siteId = upsertSite(
    { name: 'Flavorza', domain: 'x.com', status: 'active', daily_target: 1, interval_minutes: 60, apiToken: 'tok' },
    KEY,
  );
});
afterEach(() => closeDatabase());

describe('cleaning and checking a page', () => {
  it('keeps formatting, drops what could run, and drops a leading h1', () => {
    const out = cleanPageHtml(
      '```html\n<h1>About</h1><p onclick="x()">Hi <strong>there</strong></p><script>x()</script>' +
        '<table><tr><td>t</td></tr></table><a href="javascript:x()">bad</a><a href="https://a.com/p">ok</a>\n```',
    );
    expect(out).toBe('<p>Hi <strong>there</strong></p>t<a href="#">bad</a><a href="https://a.com/p">ok</a>');
  });

  it('passes a complete privacy policy', () => {
    expect(missingFromPage('privacy', cleanPageHtml(goodPrivacy()))).toEqual([]);
  });

  it('names what a privacy policy lacks', () => {
    const missing = missingFromPage('privacy', '<p>We keep your data safe. {{email}}</p>');
    expect(missing.join(' ')).toContain('AdSense');
    expect(missing.join(' ')).toContain('aboutads.info');
    expect(missing.join(' ')).toContain('enough text');
  });

  it('refuses a token the site cannot fill and a bracketed placeholder', () => {
    const body = goodPrivacy() + '<p>{{phone}} [Your Name]</p>';
    const missing = missingFromPage('privacy', body).join(' ');
    expect(missing).toContain('unknown placeholders');
    expect(missing).toContain('bracketed');
  });
});

describe('the prompt', () => {
  it('carries the site tokens through as themselves instead of rendering them empty', () => {
    configurePrompts('./prompts');
    const { system, user } = loadPrompt('site-page', {
      site: { name: 'Flavorza', domain: 'x.com' },
      page: { title: 'Contact', spec: PAGE_SPECS.contact },
      ph: SITE_PAGE_PLACEHOLDERS,
      facts: '- Run by: Katie',
      content: '12 recipes',
      notes: '',
      style: { spelling: 'US spelling.' },
    });
    expect(system).toContain('mailto:{{email}}');
    expect(system).toContain('{{site_name}}');
    expect(user).toContain('{{email}}');
    expect(user).toContain('- Run by: Katie');
  });
});

describe('what the model is told', () => {
  it('says plainly when the owner gave no facts', () => {
    expect(describeFacts({ author: '', why: '', testing: '', extra: '' })).toContain('gave no personal facts');
    expect(describeFacts({ author: 'Katie', why: 'x', testing: '', extra: '' })).toContain('Run by: Katie');
  });

  it('summarises the real content', () => {
    const text = describeContent([
      { type: 'recipe', slug: 'a', title: 'Lemon Bars', summary: '', category: 'Dessert', url: 'u' },
      { type: 'post', slug: 'b', title: 'Post', summary: '', url: 'u' },
    ]);
    expect(text).toContain('1 recipes and 1 blog articles');
    expect(text).toContain('Dessert (1)');
    expect(text).toContain('- Lemon Bars');
  });
});

describe('write, read, publish', () => {
  it('sends a short draft back with what was wrong, then keeps the good one', async () => {
    answers = [JSON.stringify({ html: '<p>Too short.</p>' }), JSON.stringify({ html: goodPrivacy() })];
    const { words } = await writeSitePage(siteId, 'privacy', settings, KEY);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.notes).not.toContain('REJECTED');
    expect(calls[1]!.notes).toContain('REJECTED');
    expect(calls[1]!.notes).toContain('AdSense');

    const page = getSitePage(siteId, 'privacy')!;
    expect(page.status).toBe('draft');
    expect(page.words).toBe(words);
    expect(page.draft_html).toContain('{{email}}');
    // Writing is not publishing: the site has been sent nothing.
    expect(sent).toEqual([]);
  });

  it('fails after the last attempt and says why, leaving no draft', async () => {
    answers = ['not json', JSON.stringify({ html: '<p>short</p>' }), JSON.stringify({ html: '<p>short</p>' })];
    await expect(writeSitePage(siteId, 'privacy', settings, KEY)).rejects.toThrow(/could not write a page that passes/);
    const page = getSitePage(siteId, 'privacy')!;
    expect(page.status).toBe('failed');
    expect(page.error).toContain('AdSense');
    expect(page.draft_html).toBe('');
  });

  it('publishes the draft to the site, once it exists', async () => {
    await expect(publishSitePage(siteId, 'privacy', KEY)).rejects.toThrow(/no draft/);

    answers = [JSON.stringify({ html: goodPrivacy() })];
    await writeSitePage(siteId, 'privacy', settings, KEY);
    await publishSitePage(siteId, 'privacy', KEY);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.slug).toBe('privacy');
    const page = getSitePage(siteId, 'privacy')!;
    expect(page.status).toBe('published');
    expect(page.published_at).not.toBeNull();
  });

  it('keeps the draft and shows the reason when the site refuses it', async () => {
    answers = [JSON.stringify({ html: goodPrivacy() })];
    await writeSitePage(siteId, 'privacy', settings, KEY);
    siteRefuses = true;
    await expect(publishSitePage(siteId, 'privacy', KEY)).rejects.toThrow(/422/);
    const page = getSitePage(siteId, 'privacy')!;
    expect(page.status).toBe('failed');
    expect(page.error).toContain('page_incomplete');
    expect(page.draft_html).not.toBe('');
  });
});

describe('write and publish all', () => {
  it('publishes every page, carries on past a failure, and skips one being written', async () => {
    // about: good; contact: never passes (3 bad answers); privacy: being written; terms, disclaimer: good.
    const good = JSON.stringify({ html: goodAbout() });
    const bad = JSON.stringify({ html: '<p>short</p>' });
    answers = [good, bad, bad, bad, good, good];
    markWorking(siteId, 'privacy');

    const result = await writeAndPublishAll(siteId, settings, KEY);

    expect(result.published).toEqual(['about', 'terms', 'disclaimer']);
    expect(result.failed).toEqual(['contact']);
    expect(result.skipped).toEqual(['privacy']);
    expect(sent.map((s) => s.slug)).toEqual(['about', 'terms', 'disclaimer']);
    expect(getSitePage(siteId, 'contact')!.status).toBe('failed');
    expect(getSitePage(siteId, 'about')!.draft_html).not.toBe('');
  });
});

describe('weekly About refresh', () => {
  const lock = { tryLock: () => true, unlock: () => undefined };
  const weekAgo = "datetime('now', '-8 days')";

  /** An About page sent eight days ago, with the refresh on and the given last-seen shape. */
  function aboutSentLongAgo(seen: string): void {
    markWorking(siteId, 'about');
    run(`UPDATE site_pages SET status = 'published', draft_html = '<p>old</p>', published_at = ${weekAgo} WHERE site_id = ? AND slug = 'about'`, siteId);
    setAboutAuto(siteId, true);
    run(`UPDATE site_page_facts SET about_seen = ?, about_checked_at = NULL WHERE site_id = ?`, seen, siteId);
  }

  it('reads the shape of a site and what counts as a change', () => {
    const items = [
      { type: 'recipe', slug: 'a', title: 'A', summary: '', category: 'Dessert', url: 'u' },
      { type: 'recipe', slug: 'b', title: 'B', summary: '', category: 'dessert ', url: 'u' },
      { type: 'recipe', slug: 'c', title: 'C', summary: '', category: 'Soup', url: 'u' },
      { type: 'post', slug: 'd', title: 'D', summary: '', url: 'u' },
    ] as never;
    expect(siteSignature(items)).toBe('3|1|2');

    expect(siteChanged('', '50|10|4')).toBe(false); // no baseline yet
    expect(siteChanged('50|10|4', '52|10|4')).toBe(false); // a couple of items
    expect(siteChanged('50|10|4', '58|10|4')).toBe(true); // a tenth of 60 is 6
    expect(siteChanged('50|10|4', '50|10|5')).toBe(true); // a new category
    expect(siteChanged('2|1|1', '6|1|1')).toBe(false); // under five items
    expect(siteChanged('2|1|1', '7|1|1')).toBe(true);
  });

  it('is due a week after the page was sent or last checked, and never before it was sent', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(aboutCheckDue(null, null, now)).toBe(false);
    expect(aboutCheckDue('2026-10-14 00:00:00', null, now)).toBe(false);
    expect(aboutCheckDue('2026-10-12 00:00:00', null, now)).toBe(true);
    expect(aboutCheckDue('2026-10-01 00:00:00', '2026-10-18 00:00:00', now)).toBe(false);
  });

  it('does nothing while switched off, or before the page was ever sent', async () => {
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('off');
    setAboutAuto(siteId, true);
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('not due');
    expect(calls).toHaveLength(0);
  });

  it('only records the site the first time, then leaves an unchanged site alone', async () => {
    aboutSentLongAgo('');
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('baseline');
    expect(getAboutAuto(siteId).seen).toBe('1|1|1');
    expect(calls).toHaveLength(0);

    aboutSentLongAgo('1|1|1');
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('unchanged');
    expect(calls).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('writes and sends the About page again when the site has grown, and only that page', async () => {
    aboutSentLongAgo('30|30|3');
    answers = [JSON.stringify({ html: goodAbout() })];
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('refreshed');

    expect(sent.map((s) => s.slug)).toEqual(['about']);
    expect(getAboutAuto(siteId).seen).toBe('1|1|1');
    expect(getSitePage(siteId, 'privacy')).toBeUndefined();
  });

  it('waits when a recipe run holds the lock, and keeps the old page when the rewrite fails', async () => {
    aboutSentLongAgo('30|30|3');
    expect(await refreshAboutIfDue(siteId, settings, KEY, { tryLock: () => false, unlock: () => undefined })).toBe('busy');
    expect(calls).toHaveLength(0);

    answers = ['not json', 'not json', 'not json'];
    expect(await refreshAboutIfDue(siteId, settings, KEY, lock)).toBe('failed');
    expect(sent).toEqual([]);
    expect(getAboutAuto(siteId).seen).toBe('30|30|3');
    expect(getAboutAuto(siteId).checked_at).not.toBeNull(); // next try in a week, not an hour
  });
});

describe('drafting the facts', () => {
  const draft = { why: 'The site was created to take the guesswork out of cooking.', testing: 'We test every recipe.', extra: "Who it's for: busy cooks.\n\nWhat we will not publish: untested trends." };

  it('fills only the blank fields and never touches what the owner typed', async () => {
    savePageFacts(siteId, { author: '', why: 'My own reason.', testing: '', extra: '' });
    answers = [JSON.stringify(draft)];
    const { filled } = await draftSiteFacts(siteId, settings, KEY);

    expect(filled).toEqual(['author', 'testing', 'extra']);
    const facts = getPageFacts(siteId);
    expect(facts.why).toBe('My own reason.');
    expect(facts.testing).toBe(draft.testing);
    expect(facts.author).toBe('The Flavorza Team');
  });

  it('does not call the model at all when every field already has text', async () => {
    savePageFacts(siteId, { author: 'A', why: 'w', testing: 't', extra: 'e' });
    const { filled } = await draftSiteFacts(siteId, settings, KEY);
    expect(filled).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('sends back a draft that carries the site address or a year, then keeps the clean one', async () => {
    answers = [
      JSON.stringify({ ...draft, why: 'Visit x.com since 2019.' }),
      JSON.stringify(draft),
    ];
    await draftSiteFacts(siteId, settings, KEY);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.notes).toContain('REJECTED');
    expect(getPageFacts(siteId).why).toBe(draft.why);
  });

  it('saves nothing when the model never gives a usable draft', async () => {
    answers = ['not json', JSON.stringify({ why: 'x' })];
    await expect(draftSiteFacts(siteId, settings, KEY)).rejects.toThrow(/usable draft/);
    expect(getPageFacts(siteId).why).toBe('');
  });
});

describe('the pages list', () => {
  it('always shows the five pages, blank ones included, and stores the facts', () => {
    expect(listSitePages(siteId).map((p) => p.slug)).toEqual(['about', 'contact', 'privacy', 'terms', 'disclaimer']);
    expect(listSitePages(siteId).every((p) => p.status === 'empty')).toBe(true);

    savePageFacts(siteId, { author: ' Katie ', why: 'to cook', testing: '', extra: '' });
    expect(getPageFacts(siteId).author).toBe('Katie');
  });

  it('lets a page whose writer was lost be written again, but not one being written now', () => {
    markWorking(siteId, 'about');
    expect(canWrite(getSitePage(siteId, 'about'))).toBe(false);
    expect(canWrite(undefined)).toBe(true);
    expect(canWrite({ ...getSitePage(siteId, 'about')!, written_at: '2020-01-01 00:00:00' })).toBe(true);
  });
});
