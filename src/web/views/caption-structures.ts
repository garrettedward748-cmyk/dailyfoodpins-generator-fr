import { html, raw, type Html } from './layout.js';
import {
  CAPTION_NETWORKS, CAPTION_NETWORK_LABELS, type CaptionNetwork, type CaptionStructure,
} from '../../core/caption-structures.js';
import type { FacebookLinkMode, RecipeInPost } from '../../reels/recipe-text.js';

/** What sits around the shapes on this page: the prompt they are slotted into, and where links and the recipe go. */
export interface CaptionExtras {
  /** The whole caption prompt, with {{captionShape}} marking where the chosen shape goes. */
  template: string;
  /** True when it differs from the one shipped with the platform. */
  templateEdited: boolean;
  facebookLink: FacebookLinkMode;
  facebookRecipe: RecipeInPost;
  youtubeRecipe: RecipeInPost;
  photoFacebookRecipe: RecipeInPost;
  photoFacebookLink: FacebookLinkMode;
  photoInstagramRecipe: RecipeInPost;
  photoPinterestRecipe: RecipeInPost;
  instagramRecipe: RecipeInPost;
  tiktokRecipe: RecipeInPost;
  youtubeRecipeLine: boolean;
  youtubeSiteLine: boolean;
  /** More posts: whether the recipe link goes in ('setup' follows the settings above). */
  extraLink: 'setup' | 'yes' | 'no';
  /** 0 is the default every site follows; otherwise the site this page is for. */
  site: number;
  sites: { id: number; domain: string; custom: boolean }[];
  /** The site has shapes and settings of its own. */
  custom: boolean;
}

/**
 * Setup -> Caption structures: the words under a reel, beside the article and
 * blog shapes and run by the same rotation.
 *
 * `networks` is which of them get those words. The rest get the recipe title
 * and the link, which is what all of them carried before this page existed, so
 * the choice is between a written caption and the old behaviour — not between a
 * caption and nothing.
 */
export function captionStructuresPage(
  structures: CaptionStructure[],
  uses: Record<number, number>,
  networks: Set<CaptionNetwork>,
  extras: CaptionExtras,
): Html {
  const on = structures.filter((s) => s.enabled).length;
  const off = CAPTION_NETWORKS.filter((n) => !networks.has(n));
  const named = (list: readonly CaptionNetwork[]) => list.map((n) => CAPTION_NETWORK_LABELS[n].name).join(', ');

  const scope = html`
    <div class="card">
      <label>Site</label>
      <div class="row wrap" style="gap:8px">
        <a class="button small ${extras.site === 0 ? 'primary' : ''}" href="/settings/caption-structures">All sites (default)</a>
        ${extras.sites.map(
          (s) => html`<a class="button small ${extras.site === s.id ? 'primary' : ''}" href="/settings/caption-structures?site=${s.id}">${s.domain}${s.custom ? html` <span class="muted small">· own</span>` : raw('')}</a>`,
        )}
      </div>
      ${extras.site === 0
        ? html`<p class="help" style="margin:10px 0 0"><strong>Default.</strong> Used by every site that has no settings of its own.</p>`
        : extras.custom
          ? html`<p class="help" style="margin:10px 0 0"><strong>Own settings.</strong> This site no longer follows the default.</p>
              <form method="post" action="/settings/caption-structures/default" style="margin-top:8px">
                <input type="hidden" name="site" value="${extras.site}" />
                <button type="submit" class="small" onclick="return confirm('Back to the default? This site's own shapes and settings are removed.')">Back to default</button>
              </form>`
          : html`<p class="help" style="margin:10px 0 0"><strong>Follows the default.</strong> Nothing of its own yet. Customize to start from a copy of the default.</p>
              <form method="post" action="/settings/caption-structures/customize" style="margin-top:8px">
                <input type="hidden" name="site" value="${extras.site}" />
                <button type="submit" class="small primary">Customize for this site</button>
              </form>`}
    </div>`;
  if (extras.site > 0 && !extras.custom) {
    return html`<h1>Caption structures</h1>${scope}`;
  }

  return html`
    <h1>Caption structures</h1>
    ${scope}
    <p class="subtitle">
      The words under a reel. Each new reel takes the next structure that is on — never one of the site's last three,
      the least used first, each site starting from a different one.
      ${networks.size > 0
        ? html`They go to <strong>${named([...networks])}</strong>.`
        : html`No network is set to use them, so every reel goes out with its title and link.`}
    </p>

    <form method="post" action="/settings/caption-structures/save">
      <input type="hidden" name="site" value="${extras.site}" />
      <div class="card">
        <p style="margin:0">A feed is where repetition shows fastest. An article is read on its own, but a page's posts
          are read one under another, and six captions that all open with a hook and close with the same question read as
          <strong>one post with six dishes in it</strong>.</p>
        <p class="help" style="margin:8px 0 0">Four things never vary between structures, because they live in the
          prompt below rather than in a shape: no links in the caption itself (the platform adds the link, where you
          choose further down), no filler or marketing words, at most two emoji, and hashtags specific to the dish.
          Edit the prompt and all six change together.</p>

        ${extras.site > 0
          ? html`<p class="help" style="margin:14px 0 0">The full prompt is shared by every site; what differs per site is the shapes below and the settings on this page.</p>`
          : html`<details style="margin-top:14px" ${extras.templateEdited ? raw('open') : raw('')}>
          <summary style="cursor:pointer"><strong>The full prompt</strong>
            <span class="muted small">— everything around the shape${extras.templateEdited ? ' · edited' : ''}</span></summary>
          <div class="field" style="margin-top:10px">
            <textarea name="template" rows="16" spellcheck="false">${extras.template}</textarea>
            <div class="help">The shape of the structure whose turn it is goes where <code>{{captionShape}}</code> stands,
              so keep that. <code>{{seo.title}}</code>, <code>{{spy.group}}</code>, <code>{{spy.description}}</code> and
              <code>{{spy.annotation}}</code> are the dish. This is the same prompt as Setup → Prompts →
              <code>reel-caption.user.txt</code>; a link the model writes anyway is removed before posting.</div>
            <button type="submit" class="small" formaction="/settings/caption-structures/template/reset" formnovalidate
                    onclick="return confirm('Put the shipped prompt back? Anything changed in the box above and not saved is lost.')">Reset to the shipped prompt</button>
          </div>
        </details>`}

        <div class="field" style="margin:14px 0 0">
          <label>Networks that get the written caption</label>
          <div class="row wrap" style="gap:18px">
            ${CAPTION_NETWORKS.map(
              (network) => html`
                <label class="inline-check">
                  <input type="checkbox" name="network" value="${network}" ${networks.has(network) ? raw('checked') : raw('')} />
                  ${CAPTION_NETWORK_LABELS[network].name}
                  <span class="muted small">— ${CAPTION_NETWORK_LABELS[network].where}</span>
                </label>`,
            )}
          </div>
          <div class="help">A network left unticked gets the recipe title and the link instead, exactly as it did before
            this page existed. Pinterest is not here: a video pin carries the article's own Pinterest description, which
            is written for Pinterest's search box rather than for a feed. Facebook unticked covers every Facebook post,
            not only the reels: the article's photo post, the collage and More posts carry the title and the link too
            (More posts set to "No link" below stays without one).
            ${off.length > 0
              ? html`Right now <strong>${named(off)}</strong> ${off.length === 1 ? raw('gets') : raw('get')} the title and the link.`
              : raw('')}</div>
          ${networks.has('youtube')
            ? raw('')
            : html`<div class="help"><strong>YouTube is unticked.</strong> Its description is the one of the three that
                Google indexes, so a Short left with only its title repeated above the link is the costliest place to
                save the words.</div>`}
        </div>

        <div class="field" style="margin:14px 0 0">
          <label>Facebook: the recipe in the post</label>
          <div class="row wrap" style="gap:12px;align-items:flex-start">
            <select name="fb_recipe">
              ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                ([value, label]) => html`<option value="${value}" ${extras.facebookRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
              )}
            </select>
            <select name="fb_link">
              ${([['text', 'Link in the post'], ['comment', 'Link in the first comment'], ['keyword', 'Comment keyword (link sent by private message)'], ['none', 'No link']] as const).map(
                ([value, label]) => html`<option value="${value}" ${extras.facebookLink === value ? raw('selected') : raw('')}>${label}</option>`,
              )}
            </select>
          </div>
          <div class="help">After the caption, the post carries the recipe as written for the article (ingredients, then
            numbered steps), so it can be read without leaving Facebook. The platform writes it from the recipe itself, not
            the model. If the link goes in the first comment, see the warning below. Applies when Facebook is ticked above and the reel is made from an article.
            ${extras.facebookRecipe !== 'none' && extras.facebookLink !== 'text'
              ? html`<strong>With the recipe in the post and no link in it, a reader has little reason to open the site.</strong>`
              : raw('')}</div>
        </div>

        ${extras.facebookLink === 'comment' || extras.photoFacebookLink === 'comment'
          ? html`<div class="flash warn" style="margin:14px 0 0"><strong>Link in the first comment: check your Buffer plan.</strong>
              Buffer only accepts a first comment on some plans. When it refuses, the post still goes out but <strong>with no
              link at all</strong> (the refusal is only written in the log). If your posts come out without the link, switch
              this to "Link in the post".</div>`
          : html`<div class="help" style="margin-top:14px">"Link in the first comment" needs a Buffer plan that allows a first
              comment; if Buffer refuses it, the post goes out with no link.</div>`}

        <div class="field" style="margin:14px 0 0">
          <label>YouTube, Instagram and TikTok reels: the recipe in the text</label>
          <div class="row wrap" style="gap:12px;align-items:flex-start">
            <label class="inline-check">YouTube description
              <select name="yt_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.youtubeRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
            <label class="inline-check">Instagram caption
              <select name="ig_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.instagramRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
            <label class="inline-check">TikTok caption
              <select name="tt_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.tiktokRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
          </div>
          <div class="help">Reels only; the Instagram photo post is unchanged. Written by the platform from the recipe itself.
            Instagram and TikTok allow about 2200 characters, so a recipe that does not fit gives way to the ingredients
            alone, then to the caption: it is never cut in the middle. YouTube's link lines below come after the recipe;
            Instagram's link stays as set in Channels -> Instagram. TikTok's caption has no clickable link at all.</div>
        </div>

        <div class="field" style="margin:14px 0 0">
          <label>Photo posts (the article's own posts): the recipe in the text</label>
          <div class="row wrap" style="gap:12px;align-items:flex-start">
            <label class="inline-check">Facebook
              <select name="fbp_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.photoFacebookRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
            <label class="inline-check">Facebook link
              <select name="fbp_link">
                ${([['text', 'Link in the post'], ['comment', 'Link in the first comment'], ['keyword', 'Comment keyword (link sent by private message)'], ['none', 'No link']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.photoFacebookLink === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
            <label class="inline-check">Instagram
              <select name="igp_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Caption only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.photoInstagramRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
            <label class="inline-check">Pinterest
              <select name="pin_recipe">
                ${([['full', 'Ingredients and steps'], ['ingredients', 'Ingredients only'], ['none', 'Description only']] as const).map(
                  ([value, label]) => html`<option value="${value}" ${extras.photoPinterestRecipe === value ? raw('selected') : raw('')}>${label}</option>`,
                )}
              </select></label>
          </div>
          <div class="help">The same rule as for reels, for the photo posts that go out with each article; with Facebook
            unticked above, the Facebook photo post and the collage are the title and the link only. Instagram's link
            stays as set in Channels -> Instagram; Pinterest's link is the pin's own destination, which this does not touch.
            <strong>Pinterest takes about 500 characters and its description already uses about 400</strong>, so a recipe
            seldom fits there: it gives way to the ingredients, then to the description alone, and never gets cut in the middle.
            Instagram's limit is 2200, handled the same way. The Facebook text still ends with an invitation to get the
            recipe; change that in Setup -> Prompts (<code>facebook-post</code>) if the recipe is now in the post.</div>
        </div>

        <div class="field" style="margin:14px 0 0">
          <label>More posts: the recipe link</label>
          <select name="extra_link">
            ${([['setup', 'As set above and in Channels -> Instagram'], ['yes', 'Always put the link in'], ['no', 'No link']] as const).map(
              ([value, label]) => html`<option value="${value}" ${extras.extraLink === value ? raw('selected') : raw('')}>${label}</option>`,
            )}
          </select>
          <div class="help">For the new posts made on Content -> More posts, on Facebook and Instagram. "Always" puts the link in
            even where the settings above leave it out (on Instagram, as the first comment); "No link" leaves it out. Pinterest always links its pin to the recipe.</div>
        </div>

        <div class="field" style="margin:14px 0 0">
          <label>YouTube: the lines under the description</label>
          <div class="row wrap" style="gap:18px">
            <label class="inline-check"><input type="checkbox" name="yt_link_recipe" value="1" ${extras.youtubeRecipeLine ? raw('checked') : raw('')} /> <code>Full recipe:</code> and the recipe's address</label>
            <label class="inline-check"><input type="checkbox" name="yt_link_site" value="1" ${extras.youtubeSiteLine ? raw('checked') : raw('')} /> <code>More recipes:</code> and the site's address</label>
          </div>
          <div class="help">Links in a Short's description cannot be tapped, but Google reads them.</div>
        </div>

        <p class="help" style="margin-bottom:0">${on} of ${structures.length} structure(s) on.
          ${on === 0 ? 'With none on, every reel takes the first shape below, which is what the platform wrote before this page existed.' : ''}</p>
      </div>

      ${structures.map(
        (s, i) => html`
          <div class="card">
            <div class="spread">
              <strong>${i + 1}.</strong>
              <span class="muted small">${uses[s.id] ?? 0} reel(s) captioned with it</span>
            </div>
            <input type="hidden" name="id" value="${s.id}" />
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label>Name</label><input name="name" value="${s.name}" required maxlength="80" /></div>
              <div class="field field-action">
                <label class="inline-check"><input type="checkbox" name="enabled" value="${s.id}" ${s.enabled ? raw('checked') : raw('')} /> On</label>
              </div>
            </div>
            <div class="field">
              <label>The shape</label>
              <textarea name="body" rows="6" spellcheck="false">${s.body}</textarea>
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/caption-structures/${s.id}/delete${extras.site ? `?site=${extras.site}` : ''}"
                      formnovalidate onclick="return confirm('Delete this structure? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all structures</button>
        <span class="muted small">The networks and every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/caption-structures/add" class="card">
      <input type="hidden" name="site" value="${extras.site}" />
      <h2 style="margin-top:0">Add a structure</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Ask before you tell" /></div>
      <div class="field">
        <label>The shape</label>
        <textarea name="body" rows="5" spellcheck="false" required placeholder="- Open with …&#10;- Then …&#10;- End on …&#10;- Then three to five hashtags on one line."></textarea>
        <div class="help">Make a structure differ in <strong>what the caption does</strong> — ask, promise, confess,
          count, name who it is for — not in how the instruction is worded.</div>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
