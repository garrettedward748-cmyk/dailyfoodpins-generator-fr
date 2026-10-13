import { html, raw, type Html } from './layout.js';
import type { BlogStructure } from '../../core/blog-structures.js';

/**
 * Setup -> Blog structures: the shape of a blog article, beside Article
 * structures and run by the same rotation.
 */
export function blogStructuresPage(structures: BlogStructure[], uses: Record<number, number>): Html {
  const on = structures.filter((s) => s.enabled).length;
  return html`
    <h1>Blog structures</h1>
    <p class="subtitle">
      The shape of a blog article: how long it runs, how many headings it carries, and how it ends. Every new article
      takes the next structure that is on — never one of the site's last three, the least used first, each site starting
      from a different one.
    </p>

    <div class="card">
      <p style="margin:0">Four things never vary, whatever a structure says, because each one earns its place:</p>
      <ul class="small" style="margin:8px 0 0">
        <li>the <strong>direct answer</strong> in the first paragraph — that is the featured-snippet play</li>
        <li>the <strong>internal links</strong>, once each — the reason the blog exists</li>
        <li>the <strong>printable recipe card</strong> line, which sends a blog reader to the recipe</li>
        <li>the allowed tags and the house voice</li>
      </ul>
      <p class="help" style="margin:8px 0 0">An article under 600 words is refused by the platform, so no structure
        should aim below about 700.</p>
      <p class="help" style="margin-bottom:0">${on} of ${structures.length} structure(s) on.
        ${on === 0 ? 'With none on, every article takes the first shape below, which is what the blog wrote before this page existed.' : ''}</p>
    </div>

    <form method="post" action="/settings/blog-structures/save">
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
              <label>Length, headings and ending</label>
              <textarea name="body" rows="6" spellcheck="false">${s.body}</textarea>
            </div>
            <div class="row wrap">
              <button type="submit" class="small danger" formaction="/settings/blog-structures/${s.id}/delete"
                      formnovalidate onclick="return confirm('Delete this structure? Anything you changed above and have not saved is lost.')">Delete</button>
            </div>
          </div>`,
      )}

      <div class="save-bar">
        <button type="submit" class="primary">Save all structures</button>
        <span class="muted small">Every card above, in one go.</span>
      </div>
    </form>

    <form method="post" action="/settings/blog-structures/add" class="card">
      <h2 style="margin-top:0">Add a structure</h2>
      <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Answer then checklist" /></div>
      <div class="field">
        <label>Length, headings and ending</label>
        <textarea name="body" rows="5" spellcheck="false" required placeholder="- 1,000-1,400 words in total, under 4-6 <h2> headings.&#10;- …&#10;- Finish with <h2>…</h2>: …"></textarea>
        <div class="help">Make a structure differ in <strong>what the article has to do</strong> — compare, walk
          through, correct a belief, troubleshoot — not in how the instruction is worded.</div>
      </div>
      <button type="submit" class="primary">Add</button>
    </form>
  `;
}
