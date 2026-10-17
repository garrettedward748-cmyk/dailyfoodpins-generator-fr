import { html, raw, type Html } from './layout.js';
import type { PinDesign } from '../../core/pin-designs.js';

/**
 * Setup -> Pin designs: the Pinterest graphic's designs, each on its own,
 * apart from the other prompts so editing one cannot break anything else.
 */
export function pinDesignsPage(designs: PinDesign[], uses: Record<number, number>, problems: Record<number, string[]>): Html {
  const on = designs.filter((d) => d.enabled).length;
  return html`
    <h1>Pin designs</h1>
    <p class="subtitle">
      The look of the Pinterest graphic. Every new pin takes the next design that is on: never one of the site's last three,
      the least used first, and each site starts from a different one — so the pins do not all look the same.
    </p>
    <div class="card">
      <strong>Three fields go into every design, and each must stay in it:</strong>
      <ul class="small" style="margin:8px 0 0">
        <li><code>{{imagePrompts.pin}}</code> — the photo, written for each dish by the AI</li>
        <li><code>{{pinTitle}}</code> — the title written on the pin</li>
        <li><code>{{site.domain}}</code> — the site's address on the pin</li>
      </ul>
      <p class="help">A design may also write the recipe on the pin, cut short so it reads on a phone:
        <code>{{recipe.ingredients}}</code> (up to eight, one per line), <code>{{recipe.step1}}</code>,
        <code>{{recipe.step2}}</code>, <code>{{recipe.step3}}</code> (the first, a middle and the last step) and
        <code>{{recipe.badge}}</code> ("Prêt en …"). Such a design sits out a run that has no recipe.</p>
      <p class="help" style="margin-bottom:0">${on} of ${designs.length} design(s) on. A design missing one of the three is skipped until it is fixed.</p>
    </div>

    <form method="post" action="/settings/pin-designs/save">
      ${designs.map(
        (d, i) => html`
          <div class="card">
            <div class="spread">
              <strong>${i + 1}.</strong>
              <span class="muted small">${uses[d.id] ?? 0} pin(s) made with it</span>
            </div>
            <input type="hidden" name="id" value="${d.id}" />
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label>Name</label><input name="name" value="${d.name}" required maxlength="80" /></div>
              <div class="field field-action">
                <label class="inline-check"><input type="checkbox" name="enabled" value="${d.id}" ${d.enabled ? raw('checked') : raw('')} /> On</label>
              </div>
            </div>
            <div class="field">
              <label>Design</label>
              <textarea name="body" rows="7" spellcheck="false">${d.body}</textarea>
              ${(problems[d.id] ?? []).length
                ? html`<div class="flash warn" style="margin-top:6px">Missing ${(problems[d.id] ?? []).join(', ')} — this design is skipped until it is added back.</div>`
                : raw('')}
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/pin-designs/${d.id}/delete"
                      formnovalidate onclick="return confirm('Delete this design? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all designs</button>
        <span class="muted small">Every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/pin-designs/add" class="card">
      <h2 style="margin-top:0">Add a design</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Dark wood, title on the right" /></div>
      <div class="field">
        <label>Design</label>
        <textarea name="body" rows="6" spellcheck="false" required>{{imagePrompts.pin}}

Describe the layout here: where "{{pinTitle}}" goes, its font and colour, and "{{site.domain}}" smaller beneath it. Spell the words exactly as written, once each, with no other text, no logo and no border.</textarea>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
