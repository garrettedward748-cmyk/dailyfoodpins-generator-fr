import { channelKeys, channelOf, readChannels, type ChannelKey } from '../../reels/engine.js';
import { html, raw, timeAgo, type Html } from './layout.js';
import { getProfile, type FbPageRow, type PresenterRow, type ReelSceneRow, type ReelView } from '../../db/repos.js';
import { publishControls } from './pages.js';
import { formatByKey } from '../../reels/formats.js';
import { reelStructureName } from '../../core/reel-structures.js';

/**
 * One reel, as a storyboard.
 *
 * The finished reel at the top when there is one; then every scene with what
 * it is filmed from, what happens, what is said, and how far it got -- with
 * a Retry on any scene that failed, so one bad clip costs one clip. Below
 * that, where it goes and what was published.
 */

const REEL_STATE: Record<string, string> = {
  draft: 'pending',
  generating: 'pending',
  ready: 'ok',
  publishing: 'pending',
  published: 'ok',
  failed: 'failed',
};

const SCENE_STATE: Record<ReelSceneRow['status'], string> = {
  pending: 'muted',
  working: 'busy',
  done: 'ok',
  failed: 'error',
};

const SOURCE_LABEL: Record<string, string> = {
  feature: 'feature',
  topShot: 'top shot',
  textureMacro: 'texture macro',
  beforeAfter: 'before / after',
  pin: 'Pinterest graphic',
};

/** What the reel is doing right now, in a sentence. */
export function stageSentence(reel: ReelView, scenes: ReelSceneRow[]): string {
  if (reel.status === 'failed') return 'Stopped. See what went wrong below.';
  if (reel.status === 'published') return 'Published.';
  if (reel.status === 'ready') return 'Ready to publish.';
  if (reel.status === 'publishing') return 'Publishing to Facebook.';
  if (reel.status === 'draft') return 'Waiting to start.';
  switch (reel.stage) {
    case 'planning':
      return 'Writing the storyboard.';
    case 'imaging':
      return 'Making a picture for each scene.';
    case 'filming': {
      const done = scenes.filter((s) => s.status === 'done').length;
      return `Filming scene ${Math.min(done + 1, scenes.length)} of ${scenes.length}.`;
    }
    case 'assembling':
      return 'Joining the scenes into one reel.';
    case 'mixing':
      return 'Adding the steps and the call to action after the clip.';
    default:
      return 'Generating the video.';
  }
}

function fact(label: string, value: Html | string | null): Html {
  if (value === null || value === '') return raw('');
  return html`
    <div class="field">
      <label>${label}</label>
      <div>${value}</div>
    </div>
  `;
}

function sources(scene: ReelSceneRow): string[] {
  try {
    const parsed = JSON.parse(scene.sources_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sceneCard(reel: ReelView, scene: ReelSceneRow, presenter: PresenterRow | undefined): Html {
  return html`
    <div class="card scene">
      <div class="spread">
        <div>
          <strong>Scene ${scene.position}</strong>
          <span class="muted small">· ${scene.seconds} s</span>
          ${sources(scene).map(
            (role) => html`<span class="badge muted">${SOURCE_LABEL[role] ?? role}</span>`,
          )}
          ${scene.presenter === 1
            ? html`<span class="badge brand">with ${presenter?.name ?? 'the presenter'}</span>`
            : raw('')}
        </div>
        <span class="badge ${SCENE_STATE[scene.status]}">${scene.status}</span>
      </div>
      <p>${scene.motion_prompt}</p>
      ${scene.line ? html`<p class="muted">“${scene.line}”</p>` : raw('')}
      ${scene.error ? html`<pre>${scene.error}</pre>` : raw('')}
      ${scene.image_url === 'none'
        ? html`<p class="small muted">Flow would not take the last frame; filmed from the article's photos.</p>`
        : scene.image_url
        ? html`<p class="small muted">Filmed from ${reel.format === 'process' ? 'the last frame of the shot before' : 'a fresh image'}:
            <a href="${scene.image_url}" target="_blank" rel="noopener">open</a></p>`
        : raw('')}
      ${scene.clip_path
        ? html`<video src="/reels/${reel.id}/scenes/${scene.id}/clip" controls playsinline
                     preload="none" style="max-width:100%;max-height:50vh"></video>`
        : raw('')}
      ${scene.status === 'failed'
        ? html`<form method="post" action="/reels/${reel.id}/scenes/${scene.id}/retry">
            <button type="submit">Retry this scene</button>
          </form>`
        : raw('')}
    </div>
  `;
}

export function reelDetailPage(
  reel: ReelView,
  scenes: ReelSceneRow[] = [],
  presenter: PresenterRow | undefined = undefined,
  fbPages: FbPageRow[] = [],
): Html {
  const format = formatByKey(reel.format);
  const channels = readChannels(reel);
  // One row per account a network went to: the run's own under the network's
  // name, each other one named after its account (Channels -> Accounts).
  const accountName = (key: string): string => {
    const id = Number(key.split(':')[1] ?? 0);
    const profile = id ? getProfile(id) : undefined;
    return id ? `${channelOf(key as ChannelKey)} · ${profile ? profile.channel_name || profile.label : `account ${id}`}` : key;
  };
  const channelRows = Object.fromEntries(
    channelKeys(channels).map((k) => [accountName(k), channels[k]!] as const),
  );
  const channelFailed = Object.values(channelRows).some((c) => c.status === 'failed');

  return html`
    <p class="small"><a href="/reels">&larr; All reels</a></p>

    <h1>${reel.run_title || 'Reel'}</h1>
    <p class="muted">
      <span class="badge ${REEL_STATE[reel.status] ?? 'pending'}">${reel.status}</span>
      &middot; ${stageSentence(reel, scenes)}
      ${format ? html`&middot; ${format.title}` : raw('')}
      &middot; ${reel.site_domain ?? 'no site'} &middot; ${reel.seed_keyword ?? 'no niche'}
      &middot; created ${timeAgo(reel.created_at)}
    </p>

    <div class="row wrap tile-actions">
      ${publishControls(reel, fbPages)}
      ${reel.status === 'failed' || channelFailed
        ? html`<form method="post" action="/reels/${reel.id}/retry">
            <button type="submit">${reel.status === 'failed' ? 'Retry' : 'Retry the channels that failed'}</button>
          </form>`
        : raw('')}
    </div>

    ${Object.keys(channelRows).length
      ? html`<div class="card">
          <h2>Channels</h2>
          <div class="table-wrap"><table>
            <tbody>${Object.entries(channelRows).map(
              ([name, c]) => html`<tr>
                <td><strong>${name}</strong></td>
                <td><span class="badge ${c.status === 'ok' ? 'ok' : c.status === 'failed' ? 'error' : 'muted'}">${c.status === 'ok' ? 'scheduled' : c.status === 'off' ? 'off for this site' : 'failed'}</span></td>
                <td>${c.status === 'ok' ? (c.page ? html`→ <strong>${c.page}</strong>` : html`<span class="muted small">page not recorded</span>`) : raw('')}</td>
                <td class="small muted">${c.status === 'ok' ? html`<code>${c.id ?? ''}</code>` : c.error ?? ''}</td>
              </tr>`,
            )}</tbody>
          </table></div>
        </div>`
      : raw('')}

    ${reel.error
      ? html`
          <div class="card">
            <h2>What went wrong</h2>
            <pre>${reel.error}</pre>
          </div>
        `
      : raw('')}

    ${reel.output_path
      ? html`
          <div class="card">
            <h2>The reel</h2>
            <video src="/reels/${reel.id}/video" controls playsinline
                   style="max-width:100%;max-height:70vh"></video>
          </div>
        `
      : reel.video_url
        ? html`
            <div class="card">
              <h2>The video</h2>
              <video src="${reel.video_url}" controls playsinline style="max-width:100%"></video>
              <p class="help">
                This is the clip as Flow made it.
                <a href="/reels/${reel.id}/preview?fresh=1" target="_blank" rel="noopener">Preview it as it will be posted</a>
                &mdash; re-encoded, with its title or its word-by-word captions. Nothing is sent anywhere.
              </p>
            </div>
          `
        : raw('')}

    ${scenes.length
      ? html`<h2>Storyboard</h2>
          ${scenes.map((scene) => sceneCard(reel, scene, presenter))}`
      : raw('')}

    <div class="card">
      <h2>Where it goes</h2>
      ${fact(
        'Page',
        reel.page_name || reel.page_external_id
          ? html`${reel.page_name || reel.page_external_id}`
          : html`<span class="muted">This site has no Facebook page — it will wait here.</span>`,
      )}
      ${fact('Presenter', presenter ? presenter.name : null)}
      ${fact('Scenes', reelStructureName((reel as { reel_structure_id?: number | null }).reel_structure_id))}
      ${fact('Caption', reel.caption ? html`<pre>${reel.caption}</pre>` : null)}
      ${fact(
        'Article',
        reel.post_url ? html`<a href="${reel.post_url}" rel="noreferrer">${reel.post_url}</a>` : null,
      )}
      ${fact('Published as', reel.fb_video_id ? html`<code>${reel.fb_video_id}</code>` : null)}
    </div>
  `;
}
