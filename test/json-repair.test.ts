import { describe, expect, it } from 'vitest';
import {
  extractBalanced,
  LlmJsonError,
  parseJson,
  tryParseJson,
} from '../src/pipeline/json.js';

/**
 * Every case here is something a language model actually does. A run that dies
 * on one of them has already paid for the generation — 10 to 60 seconds and a
 * slice of the rate limit — and then thrown it away over a comma.
 */

const parse = <T = Record<string, unknown>>(raw: string): T => parseJson<T>(raw, 'test');

describe('output that is already valid', () => {
  it('is returned untouched, and says so', () => {
    const attempt = tryParseJson('{"title":"Roast chicken","servings":4}');
    expect(attempt?.value).toEqual({ title: 'Roast chicken', servings: 4 });
    expect(attempt?.repairedBy).toBe('as written');
  });

  it('does not mangle braces that live inside strings', () => {
    const raw = '{"note":"pipe into a { shaped mould, then } close it","ok":true}';
    expect(parse(raw)).toEqual({
      note: 'pipe into a { shaped mould, then } close it',
      ok: true,
    });
  });

  it('leaves a URL alone rather than reading // as a comment', () => {
    expect(parse('{"url":"https://bitespoon.com/recipes"}')).toEqual({
      url: 'https://bitespoon.com/recipes',
    });
  });

  it('keeps an apostrophe in prose', () => {
    expect(parse(`{"tip":"it's the chef's favourite"}`)).toEqual({
      tip: "it's the chef's favourite",
    });
  });
});

describe('the defects a model actually produces', () => {
  it('trailing comma before a closing brace', () => {
    expect(parse('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('trailing comma before a closing bracket', () => {
    expect(parse('{"steps":["mix","bake",]}')).toEqual({ steps: ['mix', 'bake'] });
  });

  it('markdown fences around the document', () => {
    expect(parse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('a sentence before the fenced document', () => {
    expect(parse('Sure! Here is the recipe:\n```json\n{"a":1}\n```\nLet me know!')).toEqual({ a: 1 });
  });

  it('commentary around bare JSON', () => {
    expect(parse('Here you go: {"a":1} — hope that helps')).toEqual({ a: 1 });
  });

  it('curly quotes from prose training data', () => {
    expect(parse('{\u201Ctitle\u201D:\u201CRoast chicken\u201D}')).toEqual({ title: 'Roast chicken' });
  });

  it('single-quoted keys and values', () => {
    expect(parse("{'title':'Roast chicken'}")).toEqual({ title: 'Roast chicken' });
  });

  it('bare object keys', () => {
    expect(parse('{title:"Roast chicken",servings:4}')).toEqual({
      title: 'Roast chicken',
      servings: 4,
    });
  });

  it('Python literals', () => {
    expect(parse('{"vegan":False,"gluten_free":True,"notes":None}')).toEqual({
      vegan: false,
      gluten_free: true,
      notes: null,
    });
  });

  it('NaN where a number belongs', () => {
    expect(parse('{"calories":NaN}')).toEqual({ calories: null });
  });

  it('a // comment on its own line', () => {
    expect(parse('{\n  // the title\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it('a block comment', () => {
    expect(parse('{/* notes */"a":1}')).toEqual({ a: 1 });
  });

  it('a literal newline inside a string', () => {
    // A model writing a multi-line instruction presses enter inside the quotes.
    const parsed = parse<{ step: string }>('{"step":"Heat the pan.\nAdd the oil."}');
    expect(parsed.step).toContain('Heat the pan.');
    expect(parsed.step).toContain('Add the oil.');
  });

  it('a second document appended after the first', () => {
    expect(parse('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });

  it('several defects at once', () => {
    const raw = `Here is your recipe:
\`\`\`json
{
  // generated
  title: 'Roast chicken',
  'vegan': False,
  "steps": ["season", "roast",],
}
\`\`\``;
    expect(parse(raw)).toEqual({
      title: 'Roast chicken',
      vegan: false,
      steps: ['season', 'roast'],
    });
  });
});

describe('finding the end of the document', () => {
  it('stops at the balanced close, not the last brace in the file', () => {
    expect(extractBalanced('{"a":{"b":1}} trailing {"c":2}')).toBe('{"a":{"b":1}}');
  });

  it('ignores braces inside strings', () => {
    expect(extractBalanced('{"a":"} not the end"}')).toBe('{"a":"} not the end"}');
  });

  it('handles an array at the top level', () => {
    expect(extractBalanced('[1,2,3] and more')).toBe('[1,2,3]');
  });

  it('returns nothing when there is no JSON at all', () => {
    expect(extractBalanced('I cannot help with that.')).toBeNull();
  });
});

describe('what is genuinely unrecoverable', () => {
  it('empty output', () => {
    expect(() => parse('')).toThrow(LlmJsonError);
  });

  it('a refusal with no JSON in it', () => {
    expect(() => parse('I am unable to generate that recipe.')).toThrow(LlmJsonError);
  });

  it('a document truncated mid-string', () => {
    expect(() => parse('{"title":"Roast chi')).toThrow(LlmJsonError);
  });

  it('reports what the parser objected to, not just that it failed', () => {
    try {
      parse('{"title":"Roast chi');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmJsonError);
      // "position 392" alone sent someone to the raw output to count characters.
      expect((err as LlmJsonError).message).toContain('could not be repaired');
      expect((err as LlmJsonError).raw).toContain('Roast chi');
    }
  });

  it('reports null from tryParseJson rather than throwing', () => {
    expect(tryParseJson('not json at all')).toBeNull();
  });
});

describe('a realistic recipe document', () => {
  it('survives the combination that broke run #1', () => {
    // Bare keys and a trailing comma inside nested arrays: the shape that
    // produced "Expected double-quoted property name in JSON at position 392".
    const raw = `{
  "title": "Crispy Baked Chicken Thighs",
  "prepTime": "15 minutes",
  ingredients: [
    {"item": "chicken thighs", "amount": "6"},
    {"item": "olive oil", "amount": "2 tbsp"},
  ],
  "instructions": [
    "Pat the thighs dry.",
    "Season generously.",
  ],
  "notes": "Rest for 5 minutes — it's worth it.",
}`;
    const parsed = parse<{ ingredients: unknown[]; instructions: string[]; notes: string }>(raw);

    expect(parsed.ingredients).toHaveLength(2);
    expect(parsed.instructions).toEqual(['Pat the thighs dry.', 'Season generously.']);
    expect(parsed.notes).toContain("it's worth it");
  });
});
