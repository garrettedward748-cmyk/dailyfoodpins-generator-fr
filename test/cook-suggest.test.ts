import { describe, expect, it } from 'vitest';
import { experiencesFromHtml, pickSuggestions, readSuggestions } from '../src/cook/suggest.js';

describe('reading what readers wrote', () => {
  it('takes reviews from the Recipe structured data', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [{ '@type': 'Recipe', review: [{ reviewBody: 'Used frozen berries and drained them, the filling set perfectly.' }] }],
    })}</script>`;
    expect(experiencesFromHtml(html)).toEqual(['Used frozen berries and drained them, the filling set perfectly.']);
  });

  it('takes comment blocks and ignores the rest of the page', () => {
    const html = `<p>The author's long story about summer, which is not a reader.</p>
      <div class="comment-content"><p>Baked it 10 minutes longer and the bottom was not soggy anymore.</p></div>`;
    expect(experiencesFromHtml(html)).toEqual(['Baked it 10 minutes longer and the bottom was not soggy anymore.']);
  });

  it('drops one-word comments', () => {
    expect(experiencesFromHtml('<div class="comment-content">Yum</div>')).toEqual([]);
  });
});

describe('holding suggestions to the rules', () => {
  const answer = (suggestions: unknown[]) => ({ suggestions });

  it('drops a tip only one page reports', () => {
    expect(pickSuggestions(answer([{ tip: 'Drain frozen strawberries before mixing them in.', sources: ['S1'] }]), 5)).toEqual([]);
  });

  it('drops a source number that does not exist', () => {
    expect(pickSuggestions(answer([{ tip: 'Drain frozen strawberries before mixing them in.', sources: ['S1', 'S9'] }]), 5)).toEqual([]);
  });

  it('drops personal stories and first person', () => {
    const out = pickSuggestions(
      answer([
        { tip: 'My kids loved it with extra cream on top.', sources: ['S1', 'S2'] },
        { tip: 'I always chill the dough for an hour first.', sources: ['S1', 'S2'] },
      ]),
      5,
    );
    expect(out).toEqual([]);
  });

  it('keeps at most three, strongest first', () => {
    const out = pickSuggestions(
      answer([
        { tip: 'Drain frozen strawberries before mixing them in.', sources: ['S1', 'S2'] },
        { tip: 'Bake ten minutes longer if the bottom looks pale.', sources: ['S1', 'S2', 'S3', 'S4'] },
        { tip: 'Let the pie cool fully before slicing so it sets.', sources: ['S2', 'S3', 'S5'] },
        { tip: 'Cover the edges with foil halfway through baking.', sources: ['S1', 'S3'] },
      ]),
      5,
    );
    expect(out.map((s) => s.sources)).toEqual([4, 3, 2]);
  });

  it('skips a tip already in the notes', () => {
    const tip = 'Drain frozen strawberries before mixing them in.';
    expect(pickSuggestions(answer([{ tip, sources: ['S1', 'S2'] }]), 5, `Something else\n${tip}`)).toEqual([]);
  });

  it('reads stored suggestions safely', () => {
    expect(readSuggestions('')).toEqual([]);
    expect(readSuggestions('not json')).toEqual([]);
    expect(readSuggestions('[{"tip":"x","sources":2}]')).toEqual([{ tip: 'x', sources: 2 }]);
  });
});
