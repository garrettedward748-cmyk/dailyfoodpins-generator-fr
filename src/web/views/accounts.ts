import { emptyState, html, raw, timeAgo, type Html } from './layout.js';
import type { BufferAccount, ChannelProfile, FbPageRow, ProfilePlatform } from '../../db/repos.js';

/**
 * Channels -> Accounts: one card per site, and under it every network with
 * its accounts -- Pinterest 1, Pinterest 2, Facebook 1... -- each with its own
 * channel, boards and Buffer tokens. A site's articles go to its accounts of a
 * network in turn: the first article to Pinterest 1, the next to Pinterest 2.
 */

export interface AccountsSiteView {
  id: number;
  domain: string;
  pinPosts: boolean;
  pinReels: boolean;
  igPosts: boolean;
  igReels: boolean;
  ytReels: boolean;
  ttReels: boolean;
  profiles: ChannelProfile[];
  tokens: BufferAccount[];
  /** The page each Facebook account posts as, by the account's id. A Pinterest/Instagram/YouTube account has none here. */
  fbPages: Map<number, FbPageRow>;
  /** Networks where each post goes to every account instead of one in turn. */
  postToAll: ProfilePlatform[];
  /**
   * What really goes out on each network, with every setting that gates it
   * taken into account (Setup switches, Facebook pages, the reel route), and
   * why a ticked switch does nothing when that is the case.
   */
  effective: Record<ProfilePlatform, { on: string[]; notes: string[] }>;
  /** Names last suggested for a new Pinterest account (empty: none shown). */
  nameSuggestions?: { display: string; username: string; tagline: string; bio: string }[];
}

const NETWORK: Record<ProfilePlatform, string> = { pinterest: 'Pinterest', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' };

const CHANNEL_LABEL: Record<ProfilePlatform, { label: string; placeholder: string; help: string }> = {
  pinterest: {
    label: 'Pinterest username',
    placeholder: 'e.g. recipesbuzz',
    help: 'The Pinterest profile as Buffer shows it. Blank: the first Pinterest profile of the Buffer account.',
  },
  facebook: {
    label: 'Facebook Page name',
    placeholder: 'e.g. Sandra Recipes',
    help: 'The Page as Buffer shows it, and the Page this account posts as. Blank: the first Facebook Page of the Buffer account.',
  },
  instagram: {
    label: 'Instagram account',
    placeholder: 'e.g. sandrarecipes',
    help: 'The Instagram account as Buffer shows it. Blank: the first Instagram account of the Buffer account.',
  },
  youtube: {
    label: 'YouTube channel',
    placeholder: 'e.g. Sandra Recipes',
    help: 'The channel as Buffer shows it. Blank: the first YouTube channel of the Buffer account.',
  },
  tiktok: {
    label: 'TikTok account',
    placeholder: 'e.g. sandrarecipes',
    help: 'The account as Buffer shows it. Blank: the first TikTok account of the Buffer account.',
  },
};

const backTo = (siteId: number) => html`<input type="hidden" name="back" value="/accounts/${siteId}" />`;

/** The Buffer tokens of one account, used in order when a queue is full. */
function tokens(site: AccountsSiteView, profile: ChannelProfile): Html {
  const list = site.tokens.filter((t) => t.profileId === profile.id);
  const row = (t: BufferAccount): Html => {
    const full = t.fullUntil !== null && t.fullUntil > new Date();
    return html`<li class="account">
      <span class="account-index">${t.position}</span>
      <label class="account-field"><span>Label</span>
        <input type="text" form="buffer-${t.id}" name="label" value="${t.label}" /></label>
      <label class="account-field"><span>API token</span>
        <input type="password" form="buffer-${t.id}" name="token" autocomplete="new-password" placeholder="leave blank to keep the saved one" /></label>
      <label class="inline-check account-rotation">
        <input type="checkbox" form="buffer-${t.id}" name="enabled" value="1" ${t.enabled ? raw('checked') : raw('')} /> in use</label>
      <div class="account-state">
        ${full
          ? html`<span class="badge warn" title="${t.lastError ?? ''}">queue full</span>`
          : t.enabled ? html`<span class="badge ok">ready</span>` : html`<span class="badge muted">out</span>`}
        <span class="muted small">${t.lastUsedAt ? html`used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
      </div>
      <div class="account-actions">
        <form method="post" action="/sites/${site.id}/buffer/${t.id}" id="buffer-${t.id}">${backTo(site.id)}</form>
        <button class="small" type="submit" form="buffer-${t.id}">Save</button>
        <form method="post" action="/sites/${site.id}/buffer/${t.id}/delete" onsubmit="return confirm('Remove this Buffer token?')">
          ${backTo(site.id)}<button class="danger small" type="submit">Remove</button></form>
      </div>
    </li>`;
  };
  return html`
    <div class="spread" style="margin-top:12px"><strong class="small">Buffer</strong>
      <span class="muted small">When a token's queue is full (10 posts on the free plan), the next one takes over.</span></div>
    ${list.length ? html`<ul class="accounts">${list.map(row)}</ul>` : html`<p class="small muted">No Buffer token yet: this account is skipped until one is added.</p>`}
    <details ${list.length ? raw('') : raw('open')} style="margin-top:8px">
      <summary class="button small" style="display:inline-block">+ Buffer token</summary>
      <form method="post" action="/sites/${site.id}/buffer" class="account-add" style="margin-top:8px">
        ${backTo(site.id)}
        <input type="hidden" name="profile_id" value="${profile.id}" />
        <input type="hidden" name="enabled" value="1" />
        <label class="account-field"><span>Label</span><input type="text" name="label" placeholder="e.g. ${profile.label} Buffer" /></label>
        <label class="account-field"><span>API token</span><input type="password" name="token" required autocomplete="new-password" placeholder="from the Buffer account" /></label>
        <button class="primary small" type="submit">Add</button>
      </form>
    </details>`;
}

/** The names last suggested for a new Pinterest account, with Copy buttons. */
function nameSuggestions(site: AccountsSiteView): Html {
  const names = site.nameSuggestions ?? [];
  if (!names.length) return raw('');
  const copy = (text: string) =>
    html`<button type="button" class="small" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.t);this.textContent='Copied'" data-t="${text}">Copy</button>`;
  return html`<div class="card" style="margin:10px 0">
    <div class="spread"><strong>Names for a new Pinterest account</strong>
      <form method="post" action="/accounts/${site.id}/pinterest/names/clear"><button type="submit" class="small">Hide</button></form></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Bio</th></tr></thead>
      <tbody>${names.map((n) => {
        // Suggestions saved before the separator was trimmed carried their own "|".
        const tagline = n.tagline.replace(/^[\s|]+|[\s|]+$/g, '');
        const full = tagline ? `${n.display.replace(/[\s|]+$/, '')} | ${tagline}` : n.display;
        return html`<tr>
          <td>${full} ${copy(full)}</td>
          <td class="nowrap">${n.username} ${copy(n.username)}</td>
          <td class="small">${n.bio} ${n.bio ? copy(n.bio) : raw('')}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </div>`;
}

/** The last Suggest boards answer for a Pinterest account. */
function suggestions(profile: ChannelProfile): Html {
  type Row = { group: string; name: string; description: string; exists?: boolean };
  let plan: { boards: Row[]; general: Omit<Row, 'group'> | null } | null = null;
  let hidden = false;
  try {
    plan = profile.board_suggestions ? JSON.parse(profile.board_suggestions) : null;
    hidden = Boolean((plan as { hidden?: boolean } | null)?.hidden);
  } catch { plan = null; }
  // Hidden, not lost: the table comes back with Show suggestions (next to Suggest boards).
  if (!plan || hidden) return raw('');
  const rows: Row[] = [...plan.boards, ...(plan.general ? [{ group: '(general)', ...plan.general }] : [])];
  const copy = (text: string) =>
    html`<button type="button" class="small" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.t);this.textContent='Copied'" data-t="${text}">Copy</button>`;
  const toCreate = new Set(rows.filter((r) => !r.exists).map((r) => r.name)).size;
  return html`<div class="card" style="margin:10px 0">
    <div class="spread"><strong>${toCreate ? `Create the ${toCreate} new board(s) on Pinterest` : 'All groups use boards you already have'}</strong>
      <form method="post" action="/accounts/profile/${profile.id}/boards/suggest/clear"><button type="submit" class="small">Hide</button></form></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Group</th><th>Board</th><th>Status</th><th>Description</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        // A new board shared by several groups is created once: later rows point back to it.
        const again = !r.exists && rows.slice(0, i).some((x) => !x.exists && x.name.toLowerCase() === r.name.toLowerCase());
        return html`<tr>
        <td class="muted small">${r.group}</td>
        <td class="nowrap">${r.name} ${r.exists || again ? raw('') : copy(r.name)}</td>
        <td class="nowrap small">${r.exists ? html`<span class="muted">✅ Exists</span>` : again ? html`<span class="muted">↑ Same board as above</span>` : html`<strong>➕ Create</strong>`}</td>
        <td class="small">${r.exists || again ? raw('') : html`${r.description} ${r.description ? copy(r.description) : raw('')}`}</td>
      </tr>`;
      })}</tbody>
    </table></div>
  </div>`;
}

function profileCard(site: AccountsSiteView, profile: ChannelProfile, only: boolean, groups: string[]): Html {
  const ch = CHANNEL_LABEL[profile.platform];
  const page = profile.platform === 'facebook' ? site.fbPages.get(profile.id) : undefined;
  const formId = `profile-form-${profile.id}`;
  return html`
    <div class="card" id="profile-${profile.id}" style="margin:10px 0">
      <div class="spread">
        <strong>${profile.label}</strong>
        <div class="row" style="gap:12px;align-items:center">
          <label class="enable-switch" title="${profile.enabled ? 'On — takes part in this network\'s rotation' : 'Off — this account is skipped entirely'}">
            <input type="checkbox" form="${formId}" name="enabled" value="1" ${profile.enabled ? raw('checked') : raw('')}
                   onchange="this.form.requestSubmit()" />
            <span class="track"><span class="knob"></span><span class="label on">on</span><span class="label off">off</span></span>
          </label>
          ${only
            ? raw('')
            : html`<form method="post" action="/accounts/profile/${profile.id}/delete" style="margin:0"
                     onsubmit="return confirm('Remove ${profile.label} and its Buffer tokens?')">
                <button class="danger small" type="submit">Remove</button></form>`}
        </div>
      </div>
      <form method="post" action="/accounts/profile/${profile.id}" id="${formId}" class="row wrap" style="gap:10px;align-items:flex-end;margin-top:8px">
        <div class="field" style="margin:0;min-width:240px">
          <label>${ch.label}</label>
          <input type="text" name="channel_name" value="${profile.channel_name}" placeholder="${ch.placeholder}" />
        </div>
        <div class="field" style="margin:0;min-width:240px">
          <label>Name on Buffer</label>
          <input type="text" name="buffer_channel" id="bc-${profile.id}" value="${profile.buffer_channel}" placeholder="as Buffer shows it" />
        </div>
        <div class="field" style="margin:0">
          <label>&nbsp;</label>
          <select id="bs-${profile.id}" style="display:none" aria-label="Pick from Buffer"
                  onchange="if(this.value){document.getElementById('bc-${profile.id}').value=this.value;this.form.requestSubmit();}"></select>
          <button type="button" class="small" id="bb-${profile.id}"
                  onclick="pickBufferChannel(${profile.id})">Pick from Buffer</button>
        </div>
        ${profile.platform === 'facebook'
          ? html`
            <label class="inline-check" style="margin-bottom:8px">
              <input type="checkbox" name="posts" value="1" ${page?.posts ? raw('checked') : raw('')} />
              <span><strong>Posts</strong> <span class="muted small">— the recipe's picture for every article</span></span></label>
            <label class="inline-check" style="margin-bottom:8px">
              <input type="checkbox" name="reels" value="1" ${page?.reels ? raw('checked') : raw('')} />
              <span><strong>Reels</strong> <span class="muted small">— every reel the site makes</span></span></label>
            <label class="inline-check" style="margin-bottom:8px">
              <input type="checkbox" name="collage" value="1" ${page?.collage ? raw('checked') : raw('')} />
              <span><strong>Collage</strong> <span class="muted small">— the step-by-step photo grid, when Setup &rarr; Collage is on</span></span></label>`
          : raw('')}
        <button type="submit" class="small" style="margin-bottom:4px">Save</button>
      </form>
      <div class="help">${ch.help} <strong>Name on Buffer</strong>: fill it only when Buffer shows this account under a different name than the one above; the one above then stays yours, for remembering the account.</div>

      ${profile.platform === 'pinterest'
        ? html`<form method="post" action="/accounts/profile/${profile.id}/boards" style="margin-top:12px">
            <strong class="small">Boards</strong>
            <div class="row wrap" style="gap:12px;align-items:flex-start;margin-top:6px">
              <div class="field" style="margin:0;min-width:220px">
                <label>General board</label>
                <input name="default_board" value="${profile.default_board}" placeholder="e.g. Easy Recipes" />
              </div>
              <div class="field" style="margin:0;flex:1;min-width:260px">
                <label>Topic group = Board <span class="muted small">(one per line, optional)</span></label>
                <textarea name="board_map" rows="4" placeholder="dessert = Desserts&#10;chicken = Chicken Dinners">${profile.board_map}</textarea>
                ${groups.length ? html`<div class="small muted">Your topic groups: ${groups.slice(0, 30).join(', ')}</div>` : raw('')}
              </div>
            </div>
            <div class="row" style="gap:8px;margin-top:8px">
              <button type="submit" class="small">Save boards</button>
              <button type="submit" class="small primary" formaction="/accounts/profile/${profile.id}/boards/suggest"
                      title="AI suggests a board for each topic group, and fills the links">Suggest boards</button>
              ${/"hidden":true/.test(profile.board_suggestions ?? '')
                ? html`<button type="submit" class="small" formaction="/accounts/profile/${profile.id}/boards/suggest/show"
                          title="Show the last suggested boards again">Show suggestions</button>`
                : raw('')}
            </div>
          </form>
          ${suggestions(profile)}`
        : raw('')}

      ${tokens(site, profile)}
    </div>`;
}

function switches(site: AccountsSiteView, platform: ProfilePlatform): Html {
  // Facebook has no site-level switch: Posts and Reels are set per account,
  // on its own card below, because each account is its own Page.
  if (platform === 'facebook') {
    return html`<p class="small muted" style="margin:0">Posts and Reels are set on each account below.</p>`;
  }
  // YouTube has one switch, not two: a Short is a video, so there is no
  // article or pin for it to carry.
  if (platform === 'youtube') {
    return html`<form method="post" action="/youtube/${site.id}" class="row wrap" style="gap:18px;margin:0">
      ${backTo(site.id)}<input type="hidden" name="sent" value="1" />
      <label class="inline-check" style="margin:0;cursor:pointer">
        <input type="checkbox" name="yt_reels" value="1" ${site.ytReels ? raw('checked') : raw('')} onchange="this.form.submit()" />
        <span><strong>Shorts</strong> <span class="muted small">— every reel the site makes, as a YouTube Short</span></span></label>
    </form>`;
  }
  // TikTok, like YouTube, only ever takes the reel's video.
  if (platform === 'tiktok') {
    return html`<form method="post" action="/tiktok/${site.id}" class="row wrap" style="gap:18px;margin:0">
      ${backTo(site.id)}<input type="hidden" name="sent" value="1" />
      <label class="inline-check" style="margin:0;cursor:pointer">
        <input type="checkbox" name="tt_reels" value="1" ${site.ttReels ? raw('checked') : raw('')} onchange="this.form.submit()" />
        <span><strong>Videos</strong> <span class="muted small">— every reel the site makes, posted to TikTok</span></span></label>
    </form>`;
  }
  const [action, a, b, onA, onB, textA, textB] =
    platform === 'pinterest'
      ? [`/pinterest/${site.id}/publish`, 'pin_posts', 'pin_reels', site.pinPosts, site.pinReels, 'an image pin for every article', 'a video pin for every reel']
      : [`/instagram/${site.id}`, 'ig_posts', 'ig_reels', site.igPosts, site.igReels, 'the photo of every new article', 'every reel the site makes'];
  return html`<form method="post" action="${action}" class="row wrap" style="gap:18px;margin:0">
    ${backTo(site.id)}<input type="hidden" name="sent" value="1" />
    <label class="inline-check" style="margin:0;cursor:pointer">
      <input type="checkbox" name="${a}" value="1" ${onA ? raw('checked') : raw('')} onchange="this.form.submit()" />
      <span><strong>Posts</strong> <span class="muted small">— ${textA}</span></span></label>
    <label class="inline-check" style="margin:0;cursor:pointer">
      <input type="checkbox" name="${b}" value="1" ${onB ? raw('checked') : raw('')} onchange="this.form.submit()" />
      <span><strong>Reels</strong> <span class="muted small">— ${textB}</span></span></label>
  </form>`;
}

/**
 * Rotate or post to all, for one network of one site.
 *
 * Rotation is the default and what every site had: each article and its reel
 * go to one account, the next account taking the next article. Posting to all
 * sends the same post to every account that is switched on and has a Buffer
 * token. The two networks whose own rules name exactly that say so here.
 */
function modeSwitch(site: AccountsSiteView, platform: ProfilePlatform, accounts: number): Html {
  const all = site.postToAll.includes(platform);
  const risk: Partial<Record<ProfilePlatform, string>> = {
    youtube: 'YouTube\'s spam policy names "coordinated networks of channels" and mass-producing similar content; the same Short on several channels can cost monetization or a channel.',
    pinterest: 'Pinterest\'s guidelines forbid operating multiple accounts to manipulate the platform; the same pin on several accounts can be read that way.',
  };
  return html`<form method="post" action="/accounts/${site.id}/${platform}/mode" class="mode-switch" style="margin:12px 0 0">
    ${backTo(site.id)}
    <div class="row wrap" style="gap:18px">
      <label class="inline-check" style="margin:0;cursor:pointer">
        <input type="radio" name="mode" value="rotate" ${all ? raw('') : raw('checked')} onchange="this.form.submit()" />
        <span><strong>Rotate</strong> <span class="muted small">— one account per post, the next one for the next post</span></span></label>
      <label class="inline-check" style="margin:0;cursor:pointer">
        <input type="radio" name="mode" value="all" ${all ? raw('checked') : raw('')} onchange="this.form.submit()" />
        <span><strong>Post to all</strong> <span class="muted small">— the same post on every account</span></span></label>
    </div>
    ${accounts < 2 ? html`<p class="help" style="margin:4px 0 0">Makes a difference once this network has a second account.</p>` : raw('')}
    ${all && risk[platform] ? html`<p class="help" style="margin:4px 0 0;color:var(--warn, #b45309)">${risk[platform]}</p>` : raw('')}
  </form>`;
}

const ICONS: Record<ProfilePlatform, string> = {
  pinterest: '📌',
  facebook: '📘',
  instagram: '📸',
  youtube: '▶️',
  tiktok: '🎵',
};

/** The one-line state of a network on its card's header, so a closed card still says what is wrong. */
function status(site: AccountsSiteView, platform: ProfilePlatform): Html {
  const list = site.profiles.filter((p) => p.platform === platform);
  const ready = list.filter((p) => p.enabled && site.tokens.some((t) => t.profileId === p.id && t.enabled && t.token));
  const missing = list.filter((p) => p.enabled && !ready.includes(p)).length;
  const { on, notes } = site.effective[platform];
  const what = on.join(' + ');
  return html`<span class="row wrap" style="gap:6px;align-items:center">
    <span class="badge ${ready.length ? 'ok' : 'muted'}">${ready.length}/${list.length} ready</span>
    <span class="badge ${what ? 'brand' : 'muted'}" title="What this site publishes here now">${what || 'nothing'}</span>
    ${notes.map((n) => html`<span class="badge warn" title="${n}">${n.length > 34 ? `${n.slice(0, 32)}…` : n}</span>`)}
    ${missing ? html`<span class="badge warn">${missing} without a Buffer token</span>` : raw('')}
    ${list.length > 1
      ? site.postToAll.includes(platform)
        ? html`<span class="badge warn" title="Every post goes to every account">posted to all</span>`
        : html`<span class="muted small">used in turn</span>`
      : raw('')}
  </span>`;
}

export interface AccountsPageData {
  sites: AccountsSiteView[];
  site: AccountsSiteView | null;
  groups: string[];
  /** Instagram's link setting, shared by every site: shown inside the Instagram card. */
  igLink: Html;
  /** Facebook's pages (this site's, and any nobody has given a site yet): shown inside the Facebook card. */
  facebookPages: Html;
}

export function accountsPage(data: AccountsPageData): Html {
  const { site } = data;
  const tab = (s: AccountsSiteView) =>
    html`<a class="button ${site?.id === s.id ? 'primary' : ''}" href="/accounts/${s.id}">${s.domain}</a>`;
  return html`
    <h1>Accounts</h1>
    <p class="subtitle">
      Pick a site, then open a network. <strong>+</strong> adds a second or third account: the site's articles go to
      them in turn (Pinterest 1, then 2, …), never to another site's — or, with <strong>Post to all</strong>, to every one of
      them at once. A new Pinterest account starts with the first
      one's boards — fill in its username and Buffer token.
    </p>
    ${!site
      ? html`<div class="card">${emptyState('Add a site under Channels → Sites first.')}</div>
          <div class="card"><strong>${ICONS.facebook} Facebook</strong>${data.facebookPages}</div>`
      : html`
        <div class="row wrap" style="gap:8px;margin-bottom:14px">${data.sites.map(tab)}</div>
        ${(['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as ProfilePlatform[]).map((platform) => {
          const list = site.profiles.filter((p) => p.platform === platform);
          return html`
            <details class="card platform-card" data-remember="acc-${platform}" id="net-${platform}">
              <summary class="spread" style="cursor:pointer;list-style:none">
                <span style="font-size:1.1rem;font-weight:700">${ICONS[platform]} ${NETWORK[platform]}</span>
                ${status(site, platform)}
              </summary>
              <div style="margin-top:14px">
                <div class="spread" style="gap:10px">
                  ${switches(site, platform)}
                  <div class="row" style="gap:8px">
                    ${platform === 'pinterest'
                      ? html`<form method="post" action="/accounts/${site.id}/pinterest/names" style="margin:0">
                          <button type="submit" class="small" title="AI suggests names for a new Pinterest account, from this site's boards and keywords">Suggest account names</button>
                        </form>`
                      : raw('')}
                    <form method="post" action="/accounts/${site.id}/${platform}/add" style="margin:0">
                      <button type="submit" class="small primary">+ ${NETWORK[platform]}</button>
                    </form>
                  </div>
                </div>
                ${platform === 'pinterest' ? nameSuggestions(site) : raw('')}
                ${modeSwitch(site, platform, list.length)}
                ${list.map((p) => profileCard(site, p, list.length <= 1, data.groups))}
                ${platform === 'instagram' ? data.igLink : raw('')}
                ${platform === 'facebook' ? data.facebookPages : raw('')}
              </div>
            </details>`;
        })}
        <script>
          // Each network's card stays as it was left, and a link into a card opens it.
          (function () {
            document.querySelectorAll('details[data-remember]').forEach(function (d) {
              try { if (localStorage.getItem(d.dataset.remember) === 'open') d.open = true; } catch (e) {}
              d.addEventListener('toggle', function () {
                try { localStorage.setItem(d.dataset.remember, d.open ? 'open' : 'closed'); } catch (e) {}
              });
            });
            var target = location.hash && document.querySelector(location.hash);
            if (target) {
              var d = target.closest('details');
              while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
              target.scrollIntoView();
            }
          })();
          // "Pick from Buffer": the pages on this account's Buffer, as a list to choose from.
          function pickBufferChannel(id) {
            var button = document.getElementById('bb-' + id);
            var select = document.getElementById('bs-' + id);
            var input = document.getElementById('bc-' + id);
            button.disabled = true;
            button.textContent = 'Loading…';
            fetch('/accounts/profile/' + id + '/buffer-channels', { credentials: 'same-origin' })
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
              .then(function (res) {
                if (!res.ok) throw new Error(res.body.error || 'Could not read Buffer');
                select.innerHTML = '';
                var first = document.createElement('option');
                first.value = ''; first.textContent = res.body.names.length ? 'Choose a page…' : '(no pages on this Buffer account)';
                select.appendChild(first);
                res.body.names.forEach(function (n) {
                  var o = document.createElement('option');
                  o.value = n; o.textContent = n; if (n === input.value) o.selected = true;
                  select.appendChild(o);
                });
                select.style.display = '';
                button.style.display = 'none';
              })
              .catch(function (e) {
                button.disabled = false;
                button.textContent = 'Pick from Buffer';
                alert(e.message);
              });
          }
        </script>`}
  `;
}
