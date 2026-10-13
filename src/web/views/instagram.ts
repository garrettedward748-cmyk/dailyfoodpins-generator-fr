import { html, raw, type Html } from './layout.js';
import { bufferAccountsCard } from './pages.js';
import type { BufferAccount } from '../../db/repos.js';

export interface InstagramSiteView {
  id: number;
  domain: string;
  posts: boolean;
  reels: boolean;
  /** Buffer accounts this site can post to Instagram with (its own and its Facebook ones). */
  accounts: number;
  allAccounts: BufferAccount[];
}

/** Channels -> Instagram: per site, an Instagram post for every article and/or the reel. */
export interface InstagramLinkView {
  mode: 'bio' | 'comment';
  bioLine: string;
  commentLine: string;
  commentText: string;
}

export function instagramPage(sites: InstagramSiteView[], reelsThroughBuffer: boolean, link: InstagramLinkView): Html {
  return html`
    <h1>Instagram</h1>
    <p class="subtitle">
      Each site can post on Instagram through its Buffer account: the article's photo (the same one the Facebook post uses)
      and/or its reel.
    </p>
    <div class="card">
      <strong>Before you switch it on</strong>
      <ol class="small" style="margin:8px 0 0">
        <li>Make the Instagram account a <strong>Business</strong> or <strong>Creator</strong> account (Instagram → Settings → Account type).</li>
        <li>Connect it in Buffer — either in a Buffer account of its own (add that account's token under the site below), or in the one the site uses for Facebook.</li>
        <li>Put your site's address in the Instagram bio — that is the "link in bio".</li>
      </ol>
      ${reelsThroughBuffer
        ? raw('')
        : html`<div class="flash warn" style="margin-top:10px">Reels go to Instagram only when reels are published through Buffer
            (<a href="/settings/reels">Setup → Reels → Publish reels through: Buffer</a>).</div>`}
    </div>
    ${igLinkCard(link, '/instagram')}
    ${sites.map(
      (s) => html`<div class="card">
        <h2 style="margin-top:0">${s.domain}</h2>
        <form method="post" action="/instagram/${s.id}" class="row wrap" style="gap:18px">
          <input type="hidden" name="sent" value="1" />
          <label class="row" style="gap:6px;margin:0;cursor:pointer">
            <input type="checkbox" name="ig_posts" value="1" ${s.posts ? raw('checked') : raw('')} onchange="this.form.submit()" />
            <span><strong>Posts</strong> <span class="muted small">— the photo of every new article</span></span>
          </label>
          <label class="row" style="gap:6px;margin:0;cursor:pointer">
            <input type="checkbox" name="ig_reels" value="1" ${s.reels ? raw('checked') : raw('')} onchange="this.form.submit()" />
            <span><strong>Reels</strong> <span class="muted small">— every reel the site makes</span></span>
          </label>
        </form>
        <div style="margin-top:14px">${bufferAccountsCard({ id: s.id, domain: s.domain }, s.allAccounts, 'instagram', '/instagram')}</div>
        <p class="help">Instagram uses the accounts above first. With none here, it uses the site's Facebook Buffer accounts
          (<a href="/accounts#facebook-pages">Channels → Facebook</a>), as long as Instagram is connected in one of them.</p>
      </div>`,
    )}
  `;
}

/** Where the recipe link goes on Instagram (caption or first comment); shared by Instagram and Accounts. */
export function igLinkCard(link: InstagramLinkView, backTo: string, inline = false): Html {
  return html`
    <form method="post" action="/instagram/link" class="${inline ? '' : 'card'}" id="ig-link"
          style="${inline ? 'border-top:1px solid var(--edge, rgba(127,127,127,.25));padding-top:14px;margin-top:16px' : ''}">
      <input type="hidden" name="back" value="${backTo}" />
      <h3 style="margin-top:0">The recipe link <span class="muted small">— the same for every site</span></h3>
      <p class="help">Instagram does not make links in captions clickable. Pick where the link goes; the lines are yours to change.</p>
      <div class="row wrap" style="gap:18px;margin:8px 0 12px">
        <label class="inline-check"><input type="radio" style="width:auto;flex:none" name="mode" value="bio" ${link.mode === 'bio' ? raw('checked') : raw('')} />
          <span><strong>Link in bio</strong> <span class="muted small">— Buffer free plan</span></span></label>
        <label class="inline-check"><input type="radio" style="width:auto;flex:none" name="mode" value="comment" ${link.mode === 'comment' ? raw('checked') : raw('')} />
          <span><strong>Link in the first comment</strong> <span class="muted small">— Buffer paid plan</span></span></label>
      </div>
      <div data-ig="bio" ${link.mode === 'bio' ? raw('') : raw('hidden')}>
        <div class="field"><label>Last line of the caption</label><input name="bio_line" value="${link.bioLine}" maxlength="150" /></div>
      </div>
      <div data-ig="comment" ${link.mode === 'comment' ? raw('') : raw('hidden')}>
        <div class="field"><label>Last line of the caption</label><input name="comment_line" value="${link.commentLine}" maxlength="150" /></div>
        <div class="field">
          <label>First comment</label>
          <input name="comment_text" value="${link.commentText}" maxlength="300" />
          <div class="help"><code>{url}</code> is replaced by the recipe's link. If Buffer refuses the comment (free plan), the post still goes out without it.</div>
        </div>
        <div class="flash warn" style="margin-top:6px">
          Note: Instagram never makes a link in a comment clickable — it shows as plain text, whatever tool posts it
          (Buffer's paid plan included). People have to copy it. The link in your bio is the only one they can tap,
          so <strong>Link in bio</strong> is usually the better choice.
        </div>
      </div>
      <button type="submit" class="primary small">Save</button>
    </form>
    <script>
      (function () {
        var f = document.getElementById('ig-link');
        function show() {
          var m = f.querySelector('input[name=mode]:checked').value;
          f.querySelectorAll('[data-ig]').forEach(function (d) { d.hidden = d.dataset.ig !== m; });
        }
        f.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', show); });
      })();
    </script>

  `;
}
