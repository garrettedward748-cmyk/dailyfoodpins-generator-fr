import { emptyState, html, Html, raw, statusBadge, timeAgo } from './layout.js';
import type { AboutAuto, PageFacts, SitePageRow } from '../../pages/repo.js';
import { canWrite } from '../../pages/repo.js';
import { PAGE_TITLE } from '../../pages/specs.js';

export interface SitePagesSiteView {
  id: number;
  name: string;
  domain: string;
  facts: PageFacts;
  autoAbout: AboutAuto;
  pages: SitePageRow[];
}

const STATUS_LABEL: Record<SitePageRow['status'], string> = {
  empty: 'not written',
  working: 'writing…',
  draft: 'draft — read it, then publish',
  published: 'published',
  failed: 'failed',
};

function rowActions(siteId: number, page: SitePageRow): Html {
  const writing = page.status === 'working' && !canWrite(page);
  const hasDraft = page.draft_html.trim() !== '';
  return html`
    <form method="post" action="/site-pages/${siteId}/${page.slug}/write" style="display:inline">
      <button type="submit" class="small" ${writing ? raw('disabled') : raw('')}
              title="Ask the model to write this page from the facts above and the site's content">
        ${hasDraft ? 'Rewrite' : 'Write'}
      </button>
    </form>
    <form method="post" action="/site-pages/${siteId}/${page.slug}/publish" style="display:inline">
      <button type="submit" class="small primary" ${hasDraft && !writing ? raw('') : raw('disabled')}
              title="Send the draft below to the site">Publish</button>
    </form>`;
}

function siteCard(site: SitePagesSiteView): Html {
  const f = site.facts;
  return html`
    <h2>${site.domain}</h2>

    <div class="card">
      <h3 style="margin-top:0">Facts about the site</h3>
      <p class="small muted" style="margin:0 0 16px">
        What only you know. The pages are written from this and from the recipes and articles the site
        really has. Anything left blank is written around, never invented — a few true sentences here
        make the About page far more real.
      </p>
      <form method="post" action="/site-pages/${site.id}/facts">
        <label style="display:block">
          Who runs the site (the name shown as the author)
          <input type="text" name="author" value="${f.author}" maxlength="120" />
        </label>
        <label style="display:block;margin-top:10px">
          Why the site exists
          <textarea name="why" rows="3" maxlength="1500">${f.why}</textarea>
        </label>
        <label style="display:block;margin-top:10px">
          How the recipes are developed and tested (only what is true)
          <textarea name="testing" rows="3" maxlength="1500">${f.testing}</textarea>
        </label>
        <label style="display:block;margin-top:10px">
          Anything else worth saying (an angle, who it is for, what you will not publish)
          <textarea name="extra" rows="2" maxlength="1500">${f.extra}</textarea>
        </label>
        <div class="row wrap" style="gap:8px;align-items:center;margin-top:8px">
          <button type="submit" class="primary">Save facts</button>
          <button type="submit" formaction="/site-pages/${site.id}/facts/draft"
                  title="Writes a draft into the blank fields only, from the kinds of dishes this site publishes. What you typed is kept.">
            Fill blank fields with a draft
          </button>
          <span class="small muted">A draft to read and correct — keep only what is true. It takes up to a minute.</span>
        </div>
      </form>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Page</th><th>Status</th><th>Words</th><th>Written</th><th>Sent</th><th></th></tr></thead>
          <tbody>
            ${site.pages.map(
              (p) => html`<tr>
                <td>${PAGE_TITLE[p.slug]}</td>
                <td>
                  ${statusBadge(p.status)}
                  <div class="small muted">${STATUS_LABEL[p.status]}</div>
                  ${p.error ? html`<div class="small warn-text">${p.error}</div>` : raw('')}
                </td>
                <td>${p.words || '—'}</td>
                <td class="small muted">${p.written_at ? timeAgo(p.written_at) : '—'}</td>
                <td class="small muted">${p.published_at ? timeAgo(p.published_at) : '—'}</td>
                <td class="nowrap">${rowActions(site.id, p)}</td>
              </tr>
              ${p.draft_html.trim() !== ''
                ? html`<tr>
                    <td colspan="6">
                      <details ${p.status === 'draft' ? raw('open') : raw('')}>
                        <summary class="small">Preview of the ${PAGE_TITLE[p.slug]} draft</summary>
                        <div class="page-preview" style="max-width:760px;line-height:1.6;padding:8px 0">${raw(p.draft_html)}</div>
                      </details>
                    </td>
                  </tr>`
                : raw('')}`,
            )}
          </tbody>
        </table>
      </div>
      <form method="post" action="/site-pages/${site.id}/all" style="margin:12px 0 0">
        <button type="submit" class="primary"
                title="Writes each of the five pages and sends it to the site, one after another. A page that fails is marked and the rest go on.">
          Write &amp; publish all pages
        </button>
        <span class="small muted">Skips the read-first step: each page goes live as soon as it passes the checks. The text stays in the list below.</span>
      </form>
      <form method="post" action="/site-pages/${site.id}/auto-about" style="margin:12px 0 0">
        <input type="hidden" name="on" value="${site.autoAbout.on ? '0' : '1'}" />
        <button type="submit" ${site.autoAbout.on ? raw('class="primary"') : raw('')}
                title="Once a week, if the site has grown by about a tenth or gained or lost a category, the About page is written again and sent. The other pages are never touched.">
          Weekly About refresh: ${site.autoAbout.on ? 'on — switch off' : 'off — switch on'}
        </button>
        <span class="small muted">
          ${site.autoAbout.on
            ? html`Last checked ${site.autoAbout.checked_at ? timeAgo(site.autoAbout.checked_at) : 'never (the first check, a week after the About page was sent, only records the site)'}.`
            : 'Only the About page, only once it has been sent, and only when the site has changed.'}
        </span>
      </form>
      <p class="small muted" style="margin-bottom:0">
        Writing takes a minute or two: refresh this page to see the draft. {{email}}, {{author}} and the other
        tokens in a draft are filled in by the site from its own settings, so check that the site's email is set.
      </p>
    </div>`;
}

export function sitePagesPage(data: { sites: SitePagesSiteView[]; site?: number }): Html {
  const shown = data.site ? data.sites.filter((s) => s.id === data.site) : data.sites;

  return html`
    <div class="spread">
      <div>
        <h1>Site pages</h1>
        <p class="subtitle">
          About, Contact, Privacy Policy, Terms and Disclaimer — the pages Google AdSense looks for.
          Each is written from your facts and the site's real recipes and articles, shown to you as a
          draft, and sent to the site only when you press Publish.
        </p>
      </div>
    </div>
    ${shown.length === 0
      ? html`<div class="card">${emptyState('Add a site under Channels → Sites first.')}</div>`
      : html`${shown.map(siteCard)}`}`;
}
