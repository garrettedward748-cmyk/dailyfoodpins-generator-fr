import { describe, expect, it } from 'vitest';
import { filterWithModel, isQuestion, parseTopicIdeas, serperRotating, researchKeywords, titleCase, topicCandidates, verifyTopics } from '../src/research/keywords.js';

/** Google, as far as this tool can tell: Autocomplete by query, Serper by body. */
function fakeGoogle(suggest: Record<string, string[]>, serper?: { peopleAlsoAsk: { question: string }[]; relatedSearches: { query: string }[] }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://google.serper.dev')) {
      return new Response(JSON.stringify(serper ?? {}), { status: serper ? 200 : 403 });
    }
    const q = new URL(url).searchParams.get('q') ?? '';
    void init;
    return new Response(JSON.stringify([q, suggest[q] ?? []]));
  }) as typeof fetch;
}

describe('keyword research', () => {
  it('collects real searches, splits recipes from questions and drops shopping searches', async () => {
    const result = await researchKeywords('Banana Dessert', {
      fetchImpl: fakeGoogle({
        'banana dessert': ['banana dessert recipes', 'banana dessert near me', 'banana dessert'],
        'banana dessert b': ['banana dessert bars', 'banana dessert bread pudding'],
        'banana dessert c': ['banana dessert cups', 'banana dessert bars'],
        'comment faire banana dessert': ['comment faire banana dessert sans four'],
      }),
      serperKey: 'k',
      existingTitles: ['Banana Bread Pudding'],
    });
    const recipes = result.recipes.map((r) => r.text);
    expect(recipes).toContain('banana dessert bars');
    expect(recipes).toContain('banana dessert cups');
    expect(recipes).not.toContain('banana dessert near me');
    expect(recipes.filter((r) => r === 'banana dessert bars')).toHaveLength(1);
    expect(result.recipes.find((r) => r.text === 'banana dessert recipes')?.broad).toBe(true);
    expect(result.recipes.find((r) => r.text === 'banana dessert bread pudding')?.existing).toBe('Banana Bread Pudding');
    expect(result.questions.map((q) => q.text)).toEqual(['Comment faire banana dessert sans four?']);
    expect(result.notes.some((n) => n.startsWith('Serper'))).toBe(true); // the fake refused
  });

  it('adds People also ask and related searches when Serper answers', async () => {
    const result = await researchKeywords('banana pudding', {
      fetchImpl: fakeGoogle({}, {
        peopleAlsoAsk: [{ question: 'Can you freeze banana pudding?' }],
        relatedSearches: [{ query: 'banana pudding cheesecake' }],
      }),
      serperKey: 'k',
    });
    expect(result.questions[0]).toMatchObject({ text: 'Can you freeze banana pudding?', source: 'people-also-ask' });
    expect(result.recipes[0]).toMatchObject({ text: 'banana pudding cheesecake', source: 'related' });
  });

  it('helpers', () => {
    expect(isQuestion('can you freeze it')).toBe(true);
    expect(isQuestion('banana cake')).toBe(false);
    expect(titleCase('banana pudding with cookies')).toBe('Banana Pudding with Cookies');
  });
});

describe('AI clean-up', () => {
  const base = {
    seed: 'pasta',
    notes: [],
    recipes: [
      { text: 'pasta carbonara', source: 'autocomplete' as const, rank: 0, broad: false },
      { text: 'pasta garage', source: 'autocomplete' as const, rank: 1, broad: false },
    ],
    questions: [
      { text: 'Can you pasta a tooth?', source: 'autocomplete' as const, rank: 0, broad: false },
      { text: 'How long does pasta last in the fridge?', source: 'autocomplete' as const, rank: 1, broad: false },
    ],
  };

  it('keeps only dishes and cooking questions', async () => {
    const out = await filterWithModel(base, async () => '{"keep":[{"n":1,"type":"recipe"},{"n":4,"type":"question"}]}');
    expect(out.recipes.map((r) => r.text)).toEqual(['pasta carbonara']);
    expect(out.questions.map((q) => q.text)).toEqual(['How long does pasta last in the fridge?']);
    expect(out.notes.join(' ')).toContain('removed 2');
  });

  it('does not turn an idea search into a question', async () => {
    const out = await filterWithModel(base, async () => '{"keep":[{"n":1,"type":"question"},{"n":4,"type":"question"}]}');
    expect(out.questions.map((q) => q.text)).toEqual(['How long does pasta last in the fridge?']);
  });

  it('drops a "how to make X" question when X is one of the recipes', async () => {
    const withDup = {
      ...base,
      recipes: [...base.recipes, { text: 'pasta bake', source: 'autocomplete' as const, rank: 2, broad: false }],
      questions: [
        ...base.questions,
        { text: 'How to make pasta bake?', source: 'autocomplete' as const, rank: 2, broad: false },
        { text: 'How to make pasta bake without cheese?', source: 'autocomplete' as const, rank: 3, broad: false },
      ],
    };
    const out = await filterWithModel(withDup, async () =>
      '{"keep":[{"n":1,"type":"recipe"},{"n":3,"type":"recipe"},{"n":5,"type":"question"},{"n":6,"type":"question"},{"n":7,"type":"question"}]}');
    expect(out.questions.map((q) => q.text)).toEqual(['How long does pasta last in the fridge?', 'How to make pasta bake without cheese?']);
  });

  it('never empties the page when the model fails', async () => {
    expect((await filterWithModel(base, async () => 'nonsense')).recipes).toHaveLength(2);
    expect((await filterWithModel(base, async () => { throw new Error('down'); })).questions).toHaveLength(2);
  });
});

describe('topic ideas', () => {
  it('collects niche searches without shops and repeats', async () => {
    const { candidates } = await topicCandidates('Dessert', {
      fetchImpl: fakeGoogle({ dessert: ['dessert bars', 'dessert near me'], 'dessert b': ['dessert bars', 'dessert brownies'] }),
    });
    expect(candidates).toEqual(['dessert bars', 'dessert brownies']);
  });

  it('reads the model answer and survives a bad one', () => {
    const ok = parseTopicIdeas('Dessert', '{"topics":[{"topic":"Cheesecake","why":"many searches"}],"seasonal":[{"topic":"halloween treats","why":"soon"}]}', []);
    expect(ok.topics[0]).toEqual({ topic: 'cheesecake', why: 'many searches' });
    expect(ok.seasonal).toHaveLength(1);
    const bad = parseTopicIdeas('dessert', 'no json', []);
    expect(bad.topics).toEqual([]);
    expect(bad.notes.length).toBe(1);
  });
});

describe('checking topics on Google', () => {
  it('keeps topics Google suggests a lot, most first, and drops the rest', async () => {
    const out = await verifyTopics(
      { niche: 'dessert', notes: [], seasonal: [],
        topics: [{ topic: 'cobbler', why: '' }, { topic: 'cheesecake', why: '' }, { topic: 'dessert hummus', why: '' }] },
      fakeGoogle({
        cobbler: ['cobbler recipe', 'peach cobbler', 'cobbler easy'],
        cheesecake: ['cheesecake recipe', 'cheesecake factory', 'no bake cheesecake', 'cheesecake bars', 'cheesecake easy'],
        'dessert hummus': ['dessert hummus'],
      }),
    );
    expect(out.topics.map((t) => t.topic)).toEqual(['cheesecake', 'cobbler']);
    expect(out.topics[0]!.why).toContain('cheesecake recipe');
  });
});

describe('several Serper keys', () => {
  const serperBy = (spent: string[]): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['X-API-KEY']!;
      if (spent.includes(key)) return new Response('{"message":"Not enough credits"}', { status: 400 });
      return new Response(JSON.stringify({ relatedSearches: [{ query: `from ${key}` }] }));
    }) as typeof fetch;

  it('moves on from a spent key and remembers where it is', async () => {
    let index = 0;
    const state = { get: () => index, set: (i: number) => { index = i; } };
    const out = await serperRotating('q', { serperKey: 'k1, k2 k3', serperState: state }, serperBy(['k1']));
    expect(out.related).toEqual(['from k2']);
    expect(index).toBe(1);
    // Next search starts at k2: k1 is not tried first again.
    const calls: string[] = [];
    const spy = (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)['X-API-KEY']!);
      return serperBy(['k1'])(u, init);
    }) as typeof fetch;
    await serperRotating('q', { serperKey: 'k1, k2 k3', serperState: state }, spy);
    expect(calls).toEqual(['k2']);
  });

  it('says so when every key is spent', async () => {
    await expect(serperRotating('q', { serperKey: 'a b' }, serperBy(['a', 'b']))).rejects.toThrow(/all 2 Serper key/);
  });
});
