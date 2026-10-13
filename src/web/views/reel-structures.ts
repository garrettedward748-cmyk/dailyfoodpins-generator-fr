import { html, raw, type Html } from './layout.js';
import type { ReelStructure } from '../../core/reel-structures.js';
import type { ReelMode } from '../../reels/compose.js';

/**
 * Setup -> Reel structures: the scenes of a one-clip reel, beside the article,
 * blog and caption shapes and run by the same rotation.
 */
export function reelStructuresPage(
  structures: ReelStructure[],
  uses: Record<number, number>,
  state: { mode: ReelMode; templateEdited: boolean },
): Html {
  const on = structures.filter((s) => s.enabled).length;
  const applies = state.mode === 'single' || state.mode === 'mixed';

  return html`
    <h1>Reel structures</h1>
    <p class="subtitle">
      What happens in the first eight seconds of a reel, scene by scene. Each new reel takes the next structure that is
      on — never one of the site's last three, the least used first, each site starting from a different one.
    </p>

    ${applies
      ? raw('')
      : html`<div class="flash warn">
          <p style="margin:0"><strong>Not in use right now.</strong> These shape the clip made from one prompt, which
            <em>One clip</em> and <em>Clip + steps</em> use. Setup &rarr; Reels is set to a type that plans its own
            scenes, so nothing here changes a reel until it is switched back.</p>
        </div>`}

    ${state.templateEdited
      ? html`<div class="flash error">
          <p style="margin:0"><strong>The video template was edited before it had a place for these.</strong> An edit
            under Setup &rarr; Prompts (reel-video.template) wins over the shipped file, and yours has no
            <code>{{reelShape}}</code> in it — so every reel is filmed the same way however many structures are on.
            Reset that template to the shipped one, or put <code>{{reelShape}}</code> where the scenes should go.</p>
        </div>`
      : raw('')}

    <form method="post" action="/settings/reel-structures/save">
      <div class="card">
        <p style="margin:0">YouTube's monetization rules name AI or template video <strong>with minimal variation</strong>
          between videos as content that cannot earn. The articles, the blog and the captions already rotate for the
          same reason; this is the same thing for the video itself.</p>
        <p class="help" style="margin:8px 0 0">What never varies, whatever a structure says, because it lives in the
          template: the food matches the reference photos, steam only on a hot dish, the last two seconds are the
          finished dish with the call to action and the site's address, every subtitle is a complete sentence, the
          voice, the look, and no faces.</p>
        <p class="help" style="margin-bottom:0">${on} of ${structures.length} structure(s) on.
          ${on === 0 ? 'With none on, every reel takes the first structure below, which is the scenes the template always had.' : ''}</p>
      </div>

      ${structures.map(
        (s, i) => html`
          <div class="card">
            <div class="spread">
              <strong>${i + 1}.</strong>
              <span class="muted small">${uses[s.id] ?? 0} reel(s) filmed with it</span>
            </div>
            <input type="hidden" name="id" value="${s.id}" />
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label>Name</label><input name="name" value="${s.name}" required maxlength="80" /></div>
              <div class="field field-action">
                <label class="inline-check"><input type="checkbox" name="enabled" value="${s.id}" ${s.enabled ? raw('checked') : raw('')} /> On</label>
              </div>
            </div>
            <div class="field">
              <label>The scenes</label>
              <textarea name="body" rows="10" spellcheck="false" class="mono">${s.body}</textarea>
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/reel-structures/${s.id}/delete"
                      formnovalidate onclick="return confirm('Delete this structure? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all structures</button>
        <span class="muted small">Every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/reel-structures/add" class="card">
      <h2 style="margin-top:0">Add a structure</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Before and after" /></div>
      <div class="field">
        <label>The scenes</label>
        <textarea name="body" rows="8" spellcheck="false" class="mono" required placeholder="SCENE 1 — 0–2 sec | …&#10;What the camera shows.&#10;Voiceover: the opening line — …&#10;Subtitle: that sentence in full.&#10;&#10;SCENE 2 — 2–8 sec | …"></textarea>
        <div class="help">Eight seconds at most: the last two belong to the closing shot and the call to action, which
          are added after. Say <em>the dish</em> rather than its name — placeholders are not filled in here. Make a
          structure differ in <strong>what the video does</strong> — where it opens, what it is about — not in how the
          instruction is worded.</div>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
