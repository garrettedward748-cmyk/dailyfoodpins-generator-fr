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

describe('saying what happened', () => {
  it('names why every proposed tip was dropped', async () => {
    const { describeRun, emptyReport, pickSuggestions } = await import('../src/cook/suggest.js');
    const report = emptyReport();
    pickSuggestions({ suggestions: [{ tip: 'Drain frozen strawberries before mixing them in.', sources: ['S1'] }] }, 3, '', report);
    const pages = [1, 2, 3].map((i) => ({ title: 't', url: `https://a${i}.com`, experiences: ['x', 'y'] }));
    expect(describeRun(pages, report, 0)).toBe('Read 6 reader comment(s) on 3 page(s). The model proposed 1; kept 0, dropped 1 reported by only one page.');
  });
});

describe('reading comments from page text', () => {
  it('takes only what follows the comments heading', async () => {
    const { experiencesFromText } = await import('../src/cook/suggest.js');
    const text = [
      '# Strawberry Upside Down Cake',
      'This is the author telling a long story about strawberries in June.',
      '## 24 Comments',
      'Sarah says: I used frozen berries and drained them first, it set perfectly.',
      'Reply',
      'Leave a Reply',
      'Your email address will not be published.',
    ].join('\n');
    expect(experiencesFromText(text)).toEqual(['Sarah says: I used frozen berries and drained them first, it set perfectly.']);
  });

  it('gives nothing when the page has no comments heading', async () => {
    const { experiencesFromText } = await import('../src/cook/suggest.js');
    expect(experiencesFromText('Just the author writing about the cake for a long while.')).toEqual([]);
  });
});
