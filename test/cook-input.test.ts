import { describe, expect, it } from 'vitest';
import { proseProblems } from '../src/core/article-rules.js';
import { cookBlock } from '../src/pipeline/steps/article.js';

describe("the cook's notes", () => {
  const line = 'The first time I made this it came out dry, so I added an egg.';

  it('keeps the no-narrator rule when there are no notes', () => {
    expect(proseProblems(line, 'intro_html').some((p) => p.includes('first person'))).toBe(true);
  });

  it('allows the first person when the cook wrote notes', () => {
    expect(proseProblems(line, 'intro_html', false, 'us', true).some((p) => p.includes('first person'))).toBe(false);
  });

  it('still applies every other voice rule with notes', () => {
    expect(proseProblems('I think it is delicious!', 'intro_html', false, 'us', true).length).toBe(2);
  });

  it('adds nothing to the prompt when the notes are empty', () => {
    expect(cookBlock('')).toBe('');
  });

  it('hands the notes over verbatim and forbids invention', () => {
    const block = cookBlock('Added an egg.');
    expect(block).toContain('Added an egg.');
    expect(block).toContain('Never invent');
  });
});
