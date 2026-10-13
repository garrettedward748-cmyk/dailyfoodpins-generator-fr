import { describe, expect, it } from 'vitest';
import { findOnGoogle, findingsForPrompt, recipeFromHtml } from '../src/research/serp.js';

const recipePage = (ingredients: string[]) => `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
{"@type":["Recipe"],"recipeIngredient":${JSON.stringify(ingredients)},"prepTime":"PT15M","cookTime":"PT20M","recipeYield":"8",
"recipeInstructions":[{"@type":"HowToStep","text":"Mix the pudding."},{"@type":"HowToStep","text":"Layer with wafers."}]}]}</script>
</head><body>...</body></html>`;

describe('reading competitor pages', () => {
  it('finds the Recipe data inside @graph', () => {
    const r = recipeFromHtml(recipePage(['1 box vanilla wafers', '3 bananas']))!;
    expect(r.ingredients).toEqual(['1 box vanilla wafers', '3 bananas']);
    expect(r).toMatchObject({ prepTime: 'PT15M', cookTime: 'PT20M', yield: '8' });
    expect(r.steps).toBe('Mix the pudding. Layer with wafers.');
  });

  it('ignores pages without recipe data', () => {
    expect(recipeFromHtml('<script type="application/ld+json">{"@type":"Article"}</script>')).toBeUndefined();
  });
});

describe('finding the top results', () => {
  const web = (serperOk: boolean): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://google.serper.dev')) {
        if (!serperOk) return new Response('{"message":"Not enough credits"}', { status: 400 });
        return new Response(JSON.stringify({
          organic: [
            { title: 'Best Banana Pudding', link: 'https://a.com/bp' },
            { title: 'Video', link: 'https://www.youtube.com/watch?v=1' },
            { title: 'My own', link: 'https://mysite.com/bp' },
          ],
          peopleAlsoAsk: [{ question: 'Can you freeze banana pudding?' }],
        }));
      }
      if (url === 'https://a.com/bp') return new Response(recipePage(['wafers', 'bananas']));
      void init;
      return new Response('', { status: 404 });
    }) as typeof fetch;

  it('uses Serper, skips video and the site itself, and reads recipe data', async () => {
    const f = await findOnGoogle('banana pudding', { serperKey: 'k', ollamaKeys: [], skipDomain: 'mysite.com' }, web(true));
    expect(f).toMatchObject({ ok: true, provider: 'serper', questions: ['Can you freeze banana pudding?'] });
    expect(f.pages.map((p) => p.url)).toEqual(['https://a.com/bp']);
    expect(findingsForPrompt(f)).toContain('Ingredients: wafers; bananas');
  });

  it('says it found nothing when every source fails', async () => {
    const f = await findOnGoogle('banana pudding', { serperKey: 'k', ollamaKeys: [] }, web(false));
    expect(f.ok).toBe(false);
    expect(f.error).toContain('Serper');
  });
});
