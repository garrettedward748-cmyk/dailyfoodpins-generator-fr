/**
 * Server-rendered HTML with no build step and no client framework.
 *
 * The audience for this code is an AI assistant six months from now with no
 * memory of how it was written. Template literals returning strings are the
 * most legible thing available: there is no compilation, no hydration, and
 * no hidden state — what you read is what the browser receives.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marks a string as already-safe HTML so `html` will not escape it. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export const raw = (value: string): Html => new Html(value);

/** Tagged template that escapes interpolations unless they are Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    out +=
      value instanceof Html
        ? value.value
        : Array.isArray(value)
          ? value.map((v) => (v instanceof Html ? v.value : escapeHtml(v))).join('')
          : escapeHtml(value);
    out += strings[i + 1] ?? '';
  }

  return new Html(out);
}

export interface NavPage {
  href: string;
  label: string;
  /** Opens in its own tab (the live browser). */
  external?: boolean;
  /** Reachable by its URL but kept out of the tabs, unless it is the page open. */
  hidden?: boolean;
  /**
   * Pages sharing a group show as ONE tab, named after the group and leading to
   * its first page; on any of them, a second strip lists the group's pages.
   * `cluster` labels runs of them inside that strip.
   */
  group?: string;
  cluster?: string;
}

export interface NavSection {
  label: string;
  /** Where the rail link goes: the section's first page. */
  href: string;
  /** Inline stroke icon, sized and coloured by CSS via `currentColor`. */
  icon: string;
  /** Shown as tabs at the top of every page in the section. One page: no tabs. */
  pages: NavPage[];
}

/**
 * Nav icons.
 *
 * Drawn inline rather than pulled from an icon font: five glyphs is not worth a
 * network request, and `currentColor` means they inherit the link's colour in
 * both themes and in the active state without a second rule.
 */
const ICON = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/**
 * The rail: five sections, in the order a person asks the questions.
 *
 *   What is happening?        Home
 *   What do we publish?       Content   — articles, keywords, reels
 *   Where does it go?         Channels  — sites, Facebook pages
 *   Why did nothing happen?   Activity  — decisions, events
 *   Setup                     Setup     — settings, keys, prompts, browser, data
 *
 * It used to list pages by table -- Sites, Keywords, Runs, Events, Reels --
 * with Settings in the middle and Decisions hidden inside the dashboard, and
 * a new person did not know where to start or where to look when something
 * stopped. A page belongs to exactly one section, found from its URL by
 * sectionFor(), so no route has to say which.
 */
export const SECTIONS: NavSection[] = [
  {
    label: 'Home',
    href: '/',
    icon: ICON('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>'),
    pages: [{ href: '/', label: 'Home' }],
  },
  {
    label: 'Content',
    href: '/runs',
    icon: ICON('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>'),
    pages: [
      { href: '/runs', label: 'Articles' },
      { href: '/keywords', label: 'Keywords' },
      { href: '/research', label: 'Research' },
      { href: '/radar', label: 'Radar' },
      { href: '/pin-ideas', label: 'Pin ideas' },
      { href: '/blog', label: 'Blog' },
      { href: '/site-pages', label: 'Site pages' },
      { href: '/more-posts', label: 'More posts' },
      { href: '/reels', label: 'Reels' },
    ],
  },
  {
    label: 'Channels',
    href: '/sites',
    icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>'),
    pages: [
      { href: '/sites', label: 'Sites' },
      { href: '/accounts', label: 'Accounts' },
    ],
  },
  {
    label: 'Search Console',
    href: '/gsc',
    icon: ICON('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M8 13l2-3 2 2 2-4"/>'),
    pages: [
      { href: '/gsc', label: 'Opportunities' },
      { href: '/gsc/setup', label: 'Setup' },
    ],
  },
  {
    label: 'Taxonomy',
    href: '/taxonomy',
    icon: ICON('<path d="M3 7h7l2 2h9v10H3z"/><path d="M7 13h10M7 16h6"/>'),
    pages: [{ href: '/taxonomy', label: 'Taxonomy' }],
  },
  {
    label: 'Activity',
    href: '/events',
    icon: ICON('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
    pages: [
      { href: '/events', label: 'Events' },
      { href: '/decisions', label: 'Decisions', hidden: true },
    ],
  },
  {
    label: 'Setup',
    href: '/settings',
    icon: ICON('<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2' +
      'a2 2 0 1 1-4 0a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15' +
      'a2 2 0 1 1 0-4a1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6' +
      'a2 2 0 1 1 4 0a1.7 1.7 0 0 0 2.6 1.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11' +
      'a2 2 0 1 1 0 4a1.7 1.7 0 0 0-1.6 0z"/>'),
    pages: [
      { href: '/settings', label: 'General' },
      { href: '/settings/keys', label: 'LLM keys' },
      { href: '/settings/prompts', label: 'Prompts' },
      // Everything that rotates so no two posts read as made from one mould —
      // what an article is built of, then what goes out on the networks.
      { href: '/settings/article-structures', label: 'Article structures', group: 'Rotation', cluster: 'Article' },
      { href: '/settings/photo-styles', label: 'Photo styles', group: 'Rotation', cluster: 'Article' },
      { href: '/settings/blog-structures', label: 'Blog structures', group: 'Rotation', cluster: 'Article' },
      { href: '/settings/pin-designs', label: 'Pin designs', group: 'Rotation', cluster: 'Networks' },
      { href: '/settings/caption-structures', label: 'Caption structures', group: 'Rotation', cluster: 'Networks' },
      { href: '/settings/reel-structures', label: 'Reel structures', group: 'Rotation', cluster: 'Networks' },
      { href: '/settings/reels', label: 'Reels' },
      { href: '/settings/collage', label: 'Collage' },
      { href: '/settings/presenters', label: 'Presenters', hidden: true },
      { href: '/settings/google', label: 'Google accounts' },
      { href: '/settings/backups', label: 'Backups' },
      { href: '/browser', label: 'Browser', external: true },
      { href: '/settings/account', label: 'Password' },
    ],
  },
];

/** Whether `path` is `href` or a page under it. `/` matches only itself. */
const under = (path: string, href: string): boolean =>
  href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

/**
 * The section a URL belongs to, by the longest page prefix that matches --
 * longest, so /settings/facebook lands in Channels rather than in Setup
 * under /settings.
 */
export function sectionFor(path: string): NavSection | undefined {
  let best: { section: NavSection; length: number } | undefined;
  for (const section of SECTIONS) {
    for (const page of section.pages) {
      if (under(path, page.href) && (!best || page.href.length > best.length)) {
        best = { section, length: page.href.length };
      }
    }
  }
  return best?.section;
}

/** The page within a section that `path` is on, by the same longest-prefix rule. */
export function pageFor(section: NavSection, path: string): NavPage | undefined {
  return [...section.pages]
    .sort((a, b) => b.href.length - a.href.length)
    .find((page) => under(path, page.href));
}

/**
 * The theme, applied before the first paint.
 *
 * This runs in <head> rather than at the end of <body> deliberately: setting
 * the class after the page has painted means a light flash on every navigation
 * for anyone using dark mode. Light unless the switch was set to dark.
 */
const THEME_BOOT = `<script>
(function () {
  try {
    var stored = localStorage.theme;
    var dark = stored === 'dark';
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) { /* private mode: fall through to the light default */ }
})();
</script>`;

/** Flips the class on <html> and remembers the choice. */
const THEME_TOGGLE = `<script>
(function () {
  var button = document.getElementById('theme-toggle');
  // The boot script has already decided; the switch just catches up with it.
  button.setAttribute('aria-checked',
    String(document.documentElement.classList.contains('dark')));
})();
document.getElementById('theme-toggle').addEventListener('click', function () {
  var dark = document.documentElement.classList.toggle('dark');
  this.setAttribute('aria-checked', String(dark));
  try { localStorage.theme = dark ? 'dark' : 'light'; } catch (e) {}
});
</script>`;

/**
 * Speed and feel, with no library:
 *  - prefetch: a page starts loading when the pointer rests on its link (or
 *    the finger touches it), so it opens almost at once. Downloads and the
 *    live browser are left out.
 *  - a pressed submit button shows a spinner and cannot be pressed twice,
 *    so a slow save never turns into two.
 *  - on a phone, each table cell is labelled with its column name and the
 *    table shown as cards (CSS: table.stack).
 */
const SPEED = `<script type="speculationrules">
{"prefetch":[{"where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":["/browser*","/logout*","/*download*","/*export*","/static/*"]}}]},"eagerness":"moderate"}]}
</script>
<script>
(function () {
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (form.target === '_blank' || form.method === 'dialog') return;
    var button = e.submitter || form.querySelector('button[type=submit],button:not([type])');
    if (!button || button.classList.contains('is-loading')) return;
    button.classList.add('is-loading');
    // After the form has been read, so the button's own name and value still go.
    setTimeout(function () { button.disabled = true; }, 0);
    // A form that answers with a file leaves the page where it is: give the button back.
    setTimeout(function () { button.classList.remove('is-loading'); button.disabled = false; }, 15000);
  });
  // Back/forward restores the page as it was left: no stuck spinners.
  addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('.is-loading').forEach(function (b) { b.classList.remove('is-loading'); b.disabled = false; });
  });
  function stack() {
    document.querySelectorAll('table').forEach(function (table) {
      if (table.classList.contains('stack') || table.classList.contains('matrix') || !table.tHead) return;
      var heads = Array.prototype.map.call(table.tHead.rows[0] ? table.tHead.rows[0].cells : [], function (th) {
        return th.colSpan > 1 ? null : th.textContent.trim();
      });
      if (!heads.length || heads.indexOf(null) !== -1) return;
      var ok = true;
      Array.prototype.forEach.call(table.tBodies, function (body) {
        Array.prototype.forEach.call(body.rows, function (row) {
          if (row.cells.length !== heads.length) ok = false;
        });
      });
      if (!ok) return;
      Array.prototype.forEach.call(table.tBodies, function (body) {
        Array.prototype.forEach.call(body.rows, function (row) {
          Array.prototype.forEach.call(row.cells, function (cell, i) {
            if (heads[i]) cell.setAttribute('data-label', heads[i]);
          });
        });
      });
      table.classList.add('stack');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stack);
  else stack();
})();
</script>`;

/** Shared <head> contents, so the sign-in page cannot drift from the app. */
export function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Article Platform</title>
<meta name="theme-color" content="#f4f5fb">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%232563eb'/><rect x='9' y='9' width='14' height='2.5' rx='1.25' fill='white'/><rect x='9' y='15' width='14' height='2.5' rx='1.25' fill='white' opacity='.75'/><rect x='9' y='21' width='8' height='2.5' rx='1.25' fill='white' opacity='.5'/></svg>">
${THEME_BOOT}
${SPEED}`;
}

export interface LayoutOptions {
  title: string;
  /** The current URL path. Picks the rail section and the tab. */
  active: string;
  body: Html;
  flash?: { kind: 'ok' | 'error' | 'warn'; message: string } | null;
  automationOn?: boolean;
  /** The site tabs of the Content pages: one site at a time, or all of them. */
  siteBar?: { sites: { id: number; domain: string }[]; selected: number; allowAll: boolean; path: string } | null;
}

export function layout(options: LayoutOptions): string {
  const section = sectionFor(options.active);
  const current = section ? pageFor(section, options.active) : undefined;

  const nav = SECTIONS.map(
    (item) => html`
      <a href="${item.href}" class="${item === section ? 'active' : ''}"
        >${raw(item.icon)}<span>${item.label}</span></a
      >
    `,
  );

  // Tabs for the section's pages, when it has more than one. A group's pages
  // fold into one tab where the first of them stands.
  const visible = section ? section.pages.filter((p) => !p.hidden || p === current) : [];
  const folded: NavPage[] = [];
  for (const p of visible) {
    if (!p.group) folded.push(p);
    else if (!folded.some((f) => f.group === p.group)) folded.push({ href: p.href, label: p.group, group: p.group });
  }
  const isActive = (p: NavPage) => (p.group ? current?.group === p.group : p === current);
  const tabs =
    section && folded.length > 1
      ? html`<nav class="subnav" aria-label="${section.label}">
          ${folded.map(
            (p) => html`<a href="${p.href}" class="${isActive(p) ? 'active' : ''}"
              ${p.external ? raw('target="_blank" rel="noopener"') : raw('')}
              >${p.label}</a>`,
          )}
        </nav>`
      : raw('');

  // On a grouped page: its siblings, with a small label where each cluster starts.
  const siblings = current?.group && section ? section.pages.filter((p) => p.group === current.group) : [];
  const inner =
    siblings.length > 1
      ? html`<nav class="subnav subnav-inner" aria-label="${current!.group!}">
          ${siblings.map(
            (p, i) => html`${p.cluster && p.cluster !== siblings[i - 1]?.cluster
                ? html`<span class="subnav-label">${p.cluster}</span>`
                : raw('')}<a href="${p.href}" class="${p === current ? 'active' : ''}">${p.label}</a>`,
          )}
        </nav>`
      : raw('');

  // One row of sites under the section tabs: each site shows on its own, with
  // its keywords and everything else. A link, not a form, so the choice is in
  // the address and survives a refresh; the server also remembers it, so it
  // stays when moving from Keywords to Blog to Reels.
  const bar = options.siteBar && options.siteBar.sites.length > 0
    ? html`<nav class="row wrap site-tabs" style="gap:8px;margin:0 0 16px" aria-label="Sites">
        ${options.siteBar.allowAll && options.siteBar.sites.length > 1
          ? html`<a class="button ${options.siteBar.selected === 0 ? 'primary' : ''}" href="${options.siteBar.path}?site=all">All sites</a>`
          : raw('')}
        ${options.siteBar.sites.map(
          (s) => html`<a class="button ${options.siteBar!.selected === s.id ? 'primary' : ''}" href="${options.siteBar!.path}?site=${s.id}">${s.domain}</a>`,
        )}
      </nav>`
    : raw('');

  const flash = options.flash
    ? html`<div class="flash ${options.flash.kind}">${options.flash.message}</div>`
    : raw('');

  const status =
    options.automationOn === undefined
      ? raw('')
      : options.automationOn
        ? html`<span class="pill ok">Automation on</span>`
        : html`<span class="pill off">Automation off</span>`;

  return `<!doctype html>
<html lang="en">
<head>
${head(options.title)}
</head>
<body>
<header class="topbar">
  <div class="brand"><a href="/">Article&nbsp;Platform</a>${status.value}</div>
  <nav>${nav.map((n) => n.value).join('')}</nav>
  <div class="rail-utils">
    <button type="button" id="theme-toggle" class="theme-switch"
            role="switch" aria-checked="false" title="Switch between light and dark">
      <span>Dark mode</span><span class="track"></span>
    </button>
    <a class="button browser" href="/browser" target="_blank" rel="noopener"
       title="The live Chrome session used to generate images">Browser</a>
    <form method="post" action="/logout">
      <button type="submit">Sign out</button>
    </form>
  </div>
</header>
<main>
  <div class="page">
${tabs.value}
${inner.value}
${bar.value}
${flash.value}
${options.body.value}
  </div>
</main>
${THEME_TOGGLE}
</body>
</html>`;
}

/* -- Small shared components -------------------------------------------- */

export function statusBadge(status: string): Html {
  const kind =
    status === 'published' || status === 'ok' || status === 'active' || status === 'go'
      ? 'ok'
      : status === 'failed' || status === 'no'
        ? 'error'
        : status === 'running'
          ? 'busy'
          : 'muted';
  return html`<span class="badge ${kind}">${status}</span>`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';

  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then.getTime())) return String(iso);

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const emptyState = (message: string): Html =>
  html`<div class="empty">${message}</div>`;

/**
 * A small inline bar chart.
 *
 * Four counters answer "what happened today". They cannot answer "is this
 * actually running", which is a shape rather than a number — a week of threes
 * and a week of nothing look identical in a counter reading 3.
 *
 * Inline SVG, no library: the page has no build step and a chart is not worth
 * acquiring one for. Bars rather than a line because the series is a count per
 * day, and a line between two days implies values in between that do not exist.
 */
export function sparkline(
  series: { day: string; published: number; failed: number }[],
  options: { width?: number; height?: number } = {},
): Html {
  if (series.length === 0) return raw('');

  const width = options.width ?? 320;
  const height = options.height ?? 44;
  const gap = 2;
  const barWidth = Math.max(2, width / series.length - gap);
  const peak = Math.max(1, ...series.map((d) => d.published + d.failed));

  const bars = series.map((day, index) => {
    const x = index * (barWidth + gap);
    const total = day.published + day.failed;

    // A day with nothing gets a visible baseline tick rather than blank space:
    // "we published nothing" is the reading this chart exists to make obvious.
    if (total === 0) {
      return html`<rect x="${x.toFixed(1)}" y="${height - 1}" width="${barWidth.toFixed(1)}"
        height="1" fill="currentColor" opacity="0.18"></rect>`;
    }

    const publishedHeight = (day.published / peak) * (height - 2);
    const failedHeight = (day.failed / peak) * (height - 2);

    return html`<g>
      <title>${day.day}: ${day.published} published, ${day.failed} failed</title>
      <rect x="${x.toFixed(1)}" y="${(height - failedHeight).toFixed(1)}"
        width="${barWidth.toFixed(1)}" height="${failedHeight.toFixed(1)}"
        fill="#e63946" opacity="0.85"></rect>
      <rect x="${x.toFixed(1)}" y="${(height - failedHeight - publishedHeight).toFixed(1)}"
        width="${barWidth.toFixed(1)}" height="${publishedHeight.toFixed(1)}"
        fill="#10b981"></rect>
    </g>`;
  });

  // preserveAspectRatio="none" so the chart fills the card it is in. The
  // default keeps the viewBox's ratio, which drew a small chart floating in
  // the middle of a wide empty box — the bars are what carry the meaning and
  // stretching them horizontally costs nothing, since only their heights are
  // being compared.
  return html`<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    preserveAspectRatio="none"
    role="img" aria-label="Articles published per day">${bars}</svg>`;
}

/** Thousands separators, so 148213 reads as a number rather than a barcode. */
export const formatCount = (n: number): string => n.toLocaleString('en-US');

/** Token counts compressed to something scannable in a table. */
export function formatTokens(n: number): string {
  if (n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * How a run ended, in the language of the thing that happened.
 *
 * A held run is stored as `cancelled` — see markRunHeld — and rendering it
 * that way would tell you an article was thrown away when it is sitting there
 * finished, waiting for you.
 */
export function runBadge(run: { status: string; hold?: string; research?: string }): Html {
  const noResearch =
    run.research === 'none'
      ? html` <span class="badge warn" title="Written without Google research: every search failed for 6 hours">no research</span>`
      : raw('');
  if (run.hold === 'awaiting') return html`<span class="badge warn">awaiting approval</span>${noResearch}`;
  if (run.hold === 'dry') return html`<span class="badge brand">dry run</span>${noResearch}`;
  return html`${statusBadge(run.status)}${noResearch}`;
}

