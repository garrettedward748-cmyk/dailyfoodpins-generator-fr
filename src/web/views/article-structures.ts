import { html, raw, type Html } from './layout.js';
import type { ArticleStructure } from '../../core/article-structures.js';

/**
 * Setup -> Article structures: the shape of the article, beside Photo styles
 * and run by the same rotation.
 */
export function articleStructuresPage(structures: ArticleStructure[], uses: Record<number, number>): Html {
  const on = structures.filter((s) => s.enabled).length;
  return html`
    <h1>Article structures</h1>
    <p class="subtitle">
      The shape of the article: how the introduction opens, how many sections follow the recipe card, how many questions
      end it. Every new article takes the next structure that is on — never one of the site's last three, the least used
      first, each site starting from a different one.
    </p>

    <div class="card">
      <p style="margin:0">What makes a site read as machine-written is rarely the sentences. It is that every article
        opens the same way and carries the same sections in the same order. <strong>So the shape rotates and the voice
        does not</strong> — the house voice stays in Setup → Prompts, one voice per site.</p>
      <p class="help" style="margin:8px 0 0">The <strong>recipe card is never varied</strong>: it is structured data for
        Google, and changing its shape would cost rich results and buy nothing.</p>
      <p class="help" style="margin-bottom:0">${on} of ${structures.length} structure(s) on.
        ${on === 0 ? 'With none on, every article is written in the first shape below, which is what the site wrote before this page existed.' : ''}</p>
    </div>

    <form method="post" action="/settings/article-structures/save">
      ${structures.map(
        (s, i) => html`
          <div class="card">
            <div class="spread">
              <strong>${i + 1}.</strong>
              <span class="muted small">${uses[s.id] ?? 0} article(s) written in it</span>
            </div>
            <input type="hidden" name="id" value="${s.id}" />
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label>Name</label><input name="name" value="${s.name}" required maxlength="80" /></div>
              <div class="field field-action">
                <label class="inline-check"><input type="checkbox" name="enabled" value="${s.id}" ${s.enabled ? raw('checked') : raw('')} /> On</label>
              </div>
            </div>
            <div class="field">
              <label>The introduction <span class="muted small">(part 1)</span></label>
              <textarea name="intro" rows="7" spellcheck="false">${s.intro}</textarea>
            </div>
            <div class="field">
              <label>After the recipe card <span class="muted small">(part 3: the sections and the questions)</span></label>
              <textarea name="sections" rows="6" spellcheck="false">${s.sections}</textarea>
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/article-structures/${s.id}/delete"
                      formnovalidate onclick="return confirm('Delete this structure? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all structures</button>
        <span class="muted small">Every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/article-structures/add" class="card">
      <h2 style="margin-top:0">Add a structure</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Open with the season" /></div>
      <div class="field">
        <label>The introduction</label>
        <textarea name="intro" rows="5" spellcheck="false" required placeholder="- EXACTLY TWO <p> paragraphs. 120 to 180 words in total.&#10;- First paragraph: …&#10;- Second paragraph: …"></textarea>
      </div>
      <div class="field">
        <label>After the recipe card</label>
        <textarea name="sections" rows="4" spellcheck="false" required placeholder="- EXACTLY TWO sections in notes_html, chosen from: …&#10;- EXACTLY THREE questions in faqs."></textarea>
        <div class="help">Write them as instructions, in bullets, with exact counts. Make a structure differ in
          <strong>what it asks the article to contain</strong> — a mistake, a comparison, a substitution — not in how the
          instruction is worded: six rewordings of one brief produce six flavours of the same article.</div>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
