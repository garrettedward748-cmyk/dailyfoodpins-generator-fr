import { html, raw, type Html } from './layout.js';
import type { PhotoStyle } from '../../core/photo-styles.js';

/**
 * Setup -> Photo styles: the shoot each recipe's photographs are taken on,
 * beside Pin designs and run by the same rotation.
 */
export function photoStylesPage(styles: PhotoStyle[], uses: Record<number, number>): Html {
  const on = styles.filter((s) => s.enabled).length;
  return html`
    <h1>Photo styles</h1>
    <p class="subtitle">
      The shoot the article's photographs are taken on — the surface, the light, the props and where the camera stands.
      Every new recipe takes the next style that is on: never one of the site's last three, the least used first, and each
      site starts from a different one, so the archive does not look photographed in a single afternoon.
    </p>

    <div class="card">
      <p style="margin:0">A style is a <strong>brief, not a prompt</strong>. It describes the kitchen; the AI still writes
        the five picture prompts from the dish itself, and is told to take its accent colours from the food while keeping
        your surface, light and camera.</p>
      <p class="help" style="margin-bottom:0">${on} of ${styles.length} style(s) on.
        ${on === 0 ? 'With none on, the AI chooses a look per recipe by itself — which is what it did before this page existed.' : ''}</p>
    </div>

    <form method="post" action="/settings/photo-styles/save">
      ${styles.map(
        (s, i) => html`
          <div class="card">
            <div class="spread">
              <strong>${i + 1}.</strong>
              <span class="muted small">${uses[s.id] ?? 0} recipe(s) shot on it</span>
            </div>
            <input type="hidden" name="id" value="${s.id}" />
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label>Name</label><input name="name" value="${s.name}" required maxlength="80" /></div>
              <div class="field field-action">
                <label class="inline-check"><input type="checkbox" name="enabled" value="${s.id}" ${s.enabled ? raw('checked') : raw('')} /> On</label>
              </div>
            </div>
            <div class="field">
              <label>The shoot</label>
              <textarea name="body" rows="6" spellcheck="false">${s.body}</textarea>
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/photo-styles/${s.id}/delete"
                      formnovalidate onclick="return confirm('Delete this style? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all styles</button>
        <span class="muted small">Every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/photo-styles/add" class="card">
      <h2 style="margin-top:0">Add a style</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Blue tiles, hard midday light" /></div>
      <div class="field">
        <label>The shoot</label>
        <textarea name="body" rows="5" spellcheck="false" required placeholder="The surface and what sits on it. The props, two at most. The light: where it comes from, how hard, what colour. The palette. Where the camera stands and how close."></textarea>
        <div class="help">Make it differ in what a reader notices first — how bright it is, what the food sits on, where the
          camera is. Six variations on “natural light, nice plate” read as one shoot with six names.</div>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
