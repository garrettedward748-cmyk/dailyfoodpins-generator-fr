import { mkdirSync, writeFileSync } from 'node:fs';
import { vi } from 'vitest';

/**
 * A fake world for pipeline tests: Ollama, the image service, the site API,
 * Buffer. Every prompt is identified by a MARKER in its text, so a test can
 * say what the model answers to which question.
 */

/* -------------------------------------------------------------------------
 * A fake world: Ollama, the image service, the site API, and Buffer.
 * ---------------------------------------------------------------------- */

/**
 * The recipe the fake model writes. A real one, in US units, with times that add
 * up: the article rules check the recipe before three prompts copy it, so a
 * stub with no times in it is correctly refused.
 */
export const RECIPE = {
  title: 'Test Chicken',
  servings: 4,
  prep_time: '10 minutes',
  cook_time: '12 minutes',
  total_time: '27 minutes',
  ingredients: ['2 lb bone-in chicken thighs', '1 tbsp olive oil', '1 tsp kosher salt'],
  step_1: 'Heat the oven to 400°F (200°C) and pat the chicken dry.',
  step_2: 'Sear the chicken skin side down for 5 minutes until deeply golden.',
  step_3: 'Flip the chicken and roast it for 12 minutes until the juices run clear.',
  step_4: 'Rest the chicken for 5 minutes before serving.',
};

/** The title the fake model gives the article: a dish name, a colon, a description. */
export const ARTICLE_TITLE = 'Test Chicken: Simple Chicken';

const PART_1 = {
  title: ARTICLE_TITLE,
  slug: 'test-chicken-simple-chicken',
  headline: 'Seared hard so the skin stays crisp under the pan sauce',
  title_tag: 'Test Chicken: Simple Chicken in 27 Minutes',
  meta_desc:
    'Sear chicken thighs until the skin crisps, then finish them in a hot oven. A simple weeknight dinner that serves four people with very little work.',
  focus_keyword: 'test chicken',
  intro_html:
    '<p>Chicken thighs keep their moisture because the bone and skin protect the meat while the pan builds a crust. Sear them skin side down and leave them alone.</p>'
    + '<p>The oven finishes the job gently, so the center stays juicy while the skin stays crisp. Rest the chicken before you slice it.</p>',
};

const PART_2 = {
  servings: 4,
  servings_unit: 'servings',
  yield_text: '',
  prep_minutes: 10,
  cook_minutes: 12,
  rest_minutes: 5,
  difficulty: 'easy',
  ingredients: [
    { amount: '2', unit: 'lb', item: 'bone-in chicken thighs', note: '' },
    { amount: '1', unit: 'tbsp', item: 'olive oil', note: '' },
    { amount: '1', unit: 'tsp', item: 'kosher salt', note: '' },
    { amount: '1/2', unit: 'tsp', item: 'black pepper', note: '' },
    { amount: '3', unit: '', item: 'garlic cloves', note: 'smashed' },
    { amount: '2', unit: 'tbsp', item: 'unsalted butter', note: '' },
    { amount: '1/2', unit: 'cup', item: 'chicken broth', note: 'low sodium' },
    { amount: '1', unit: 'tbsp', item: 'lemon juice', note: '' },
  ],
  steps: [
    { heading: 'Heat the oven', body: 'Heat the oven to 400°F (200°C). A hot oven crisps the skin while the meat stays moist.', timer_seconds: null },
    { heading: 'Dry the chicken', body: 'Pat the thighs dry and season both sides. Dry skin browns instead of steaming in the pan.', timer_seconds: null },
    { heading: 'Sear the skin', body: 'Sear the chicken skin side down for 5 minutes until deeply golden. Leave it alone so the crust can form.', timer_seconds: 300 },
    { heading: 'Roast it', body: 'Flip the chicken and roast it for 12 minutes until the juices run clear. The thickest part should feel firm.', timer_seconds: 720 },
    { heading: 'Rest the meat', body: 'Rest the chicken for 5 minutes before serving. The juices settle back into the meat instead of running out.', timer_seconds: 300 },
    { heading: 'Make the sauce', body: 'Stir the broth and lemon juice into the pan and scrape up the browned bits. Reduce until glossy.', timer_seconds: null },
  ],
  tips_html: '<p>Do not move the chicken while it sears. If the skin sticks to the pan, it is not ready to turn yet, so give it another minute and try again.</p>',
};

const PART_3 = {
  notes_html:
    '<h2>Avec quoi servir ce plat</h2><p>Serve the chicken with roasted potatoes or a crisp green salad. The pan sauce is rich, so something sharp on the side keeps each bite balanced and light.</p>'
    + '<h2>À préparer à l\'avance</h2><p>Season the chicken a day ahead and keep it uncovered in the refrigerator. The skin dries out overnight, which helps it crisp faster when it meets the hot pan.</p>',
  faqs: [
    { question: 'Can I use boneless thighs?', answer_html: '<p>Yes, but shorten the roasting time because they cook faster. Check the center with a thermometer rather than trusting the clock.</p>' },
    { question: 'How do I keep the skin crisp?', answer_html: '<p>Dry it well and keep the pan hot. Moisture is what turns skin soft, so remove it before the chicken goes in.</p>' },
    { question: 'Can I freeze it?', answer_html: '<p>Yes, for up to two months. Thaw it in the refrigerator overnight, then reheat it in a hot oven so the skin crisps again.</p>' },
  ],
  nutrition: { calories: 480, protein_g: 38, carbs_g: 2, fat_g: 34, fiber_g: 0, sugar_g: 0, sodium_mg: 620 },
  tags: ['chicken', 'weeknight', 'one pan', 'gluten free', 'oven roasted'],
};

export const LLM_REPLIES: Record<string, string> = {
  'spy-validation': JSON.stringify({
    keyword: 'chicken breast',
    title: 'Test Chicken',
    description: 'A test recipe',
    category: 'Quick & Easy Everyday Recipes',
  }),
  'recipe-generator': JSON.stringify(RECIPE),
  'image-prompts': JSON.stringify({
    hero: 'hero prompt',
    step_a: 'first method prompt',
    step_a_number: 1,
    step_b: 'second method prompt',
    step_b_number: 2,
    step_c: 'third method prompt',
    step_c_number: 3,
    pin_title: 'Layer By Layer',
    pin: 'vertical pin prompt',
  }),
  'part-1': JSON.stringify(PART_1),
  'part-2': JSON.stringify(PART_2),
  'part-3': JSON.stringify(PART_3),
  'pin-description': 'A delicious test pin description',
  'pick-board': JSON.stringify({ id: 'board-1', name: 'Chicken Recipes' }),
  'reel-caption': ['Hook line!', '', 'A cosy stew. https://never.example'].join(String.fromCharCode(10)),
};

export interface WorldOptions {
  failImageJobs?: boolean;
  /** Let this many generations succeed, then fail every one after. */
  failImageAfter?: number;
  imagePendingPolls?: number;
  failPostOnce?: boolean;
  /** Reject this many article posts with the site's real validation body, then accept. */
  rejectPayloadTimes?: number;
  /** Answer every article post with this status and a plain body (a 401, say). */
  postStatus?: number;
  /** Refuse the video job submit with a 503, as a sleeping image service does. */
  failVideoSubmit?: boolean;
  failEndpoint?: string;
  /** Replace one prompt's reply, to stand in for a model behaving badly. */
  llmOverrides?: Record<string, string>;
  /** Answer Buffer with no channels, as an account nobody has set up does. */
  bufferUnconfigured?: boolean;
}

export function buildWorld(options: WorldOptions = {}) {
  const calls: string[] = [];
  const generateBodies: Record<string, unknown>[] = [];
  const videoBodies: Record<string, unknown>[] = [];
  let pollCount = 0;
  let postAttempts = 0;
  const promptCalls: Record<string, number> = {};

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);

    // -- Ollama ------------------------------------------------------------
    if (url.includes('/api/chat')) {
      const host = new URL(url).hostname;
      if (options.failEndpoint && host === options.failEndpoint) {
        return new Response('endpoint down', { status: 500 });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: { content: string }[];
      };
      const text = body.messages.map((m) => m.content).join(' ');

      // Identify which prompt this is by a distinctive marker in its text.
      const which =
        text.includes('MARKER-spy-validation') ? 'spy-validation'
        : text.includes('MARKER-recipe-generator') ? 'recipe-generator'
        : text.includes('MARKER-image-prompts') ? 'image-prompts'
        : text.includes('MARKER-part-1') ? 'part-1'
        : text.includes('MARKER-part-2') ? 'part-2'
        : text.includes('MARKER-part-3') ? 'part-3'
        : text.includes('MARKER-pin-description') ? 'pin-description'
        : text.includes('MARKER-pick-board') ? 'pick-board'
        : text.includes('MARKER-repair-json') ? 'repair-json'
        : text.includes('MARKER-reel-caption') ? 'reel-caption'
        : 'unknown';
      promptCalls[which] = (promptCalls[which] ?? 0) + 1;

      const reply = options.llmOverrides?.[which] ?? LLM_REPLIES[which] ?? '{}';
      return json({ message: { content: reply } });
    }

    // -- Image service -----------------------------------------------------
    if (url.includes('/v1/generate-video')) {
      videoBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (options.failVideoSubmit) return new Response('imagegen down', { status: 503 });
      return json({ job_id: 'video-1' });
    }

    if (url.includes('/v1/generate')) {
      generateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ job_id: 'job-123' });
    }

    if (url.includes('/v1/jobs/')) {
      const failing =
        options.failImageJobs ||
        (options.failImageAfter !== undefined && generateBodies.length > options.failImageAfter);
      if (failing) {
        return json({ job_id: 'job-123', status: 'FAILED', error: 'GPU unavailable' });
      }
      pollCount++;
      if (options.imagePendingPolls && pollCount <= options.imagePendingPolls) {
        return json({ job_id: 'job-123', status: 'PENDING', image_url: null, error: null });
      }
      return json({
        job_id: 'job-123',
        status: 'COMPLETED',
        image_url: 'https://images.test/out.webp',
        error: null,
      });
    }

    if (url.startsWith('https://images.test/')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }

    // A published image on one of the sites. This is what a second site
    // downloads when it reuses a keyword's images instead of generating them.
    if (url.includes('/uploads/')) {
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }

    // -- Site API ----------------------------------------------------------
    if (url.includes('/api/categories')) {
      return json([
        { id: 'cat-1', slug: 'quick', title: 'Quick & Easy Everyday Recipes', href: '/c/quick' },
      ]);
    }

    if (url.includes('/api/cuisines')) {
      return json([{ id: 'cui-1', slug: 'north-african', title: 'North African', href: '/cuisine/north-african' }]);
    }

    if (url.includes('/api/upload')) {
      return json({ success: true, url: '/uploads/recipes/x.webp', thumbnailUrl: '', filename: 'x.webp' });
    }

    if (url.includes('/api/recipe')) {
      if (init?.method === 'POST') {
        postAttempts++;
        if (options.failPostOnce && postAttempts === 1) {
          return new Response('Invalid JSON: unexpected token', { status: 400 });
        }
        if (options.postStatus) {
          return new Response('Unauthorized', { status: options.postStatus });
        }
        if (options.rejectPayloadTimes && postAttempts <= options.rejectPayloadTimes) {
          // The real thing, as longlivo.com sent it.
          return json(
            {
              error: 'Recipe payload validation failed',
              count: 1,
              errors: [{
                field: 'recipeInfo.servings',
                message: '"recipeInfo.servings" does not look like a yield/serving value.',
                received: 'string("4 medium pizzas")',
                expected: 'e.g. "24 clusters", "Serves 4", "8 slices"',
                hint: 'Use a short yield phrase, not a long sentence.',
              }],
              hint: 'Fix the listed field issues and retry the request.',
            },
            400,
          );
        }

        return json({ id: 'recipe-1', title: 'Test Chicken', href: '/r/test-chicken' });
      }
      return json({ id: 'recipe-1', title: 'Test Chicken', href: '/r/test-chicken' });
    }

    // -- Buffer ------------------------------------------------------------
    if (url.includes('api.buffer.com')) {
      const body = String(init?.body ?? '');
      if (options.bufferUnconfigured) {
        return json({ data: { account: { organizations: [] }, channels: [] } });
      }
      if (body.includes('GetOrganizations')) {
        return json({ data: { account: { organizations: [{ id: 'org-1', name: 'Org' }] } } });
      }
      if (body.includes('GetChannelsWithBoards')) {
        return json({
          data: {
            channels: [
              {
                id: 'chan-1',
                name: 'testsite',
                metadata: { boards: [{ serviceId: 'board-1', name: 'Chicken Recipes' }] },
              },
            ],
          },
        });
      }
      return json({ data: { createPost: { post: { id: 'buffer-post-1' } } } });
    }

    return new Response('not found', { status: 404 });
  });

  return { fetchStub, calls, generateBodies, videoBodies, postAttempts: () => postAttempts, promptCalls };
}

/** Write prompt files whose text identifies which prompt was invoked. */
export function writeFakePrompts(dir: string): void {
  mkdirSync(dir, { recursive: true });

  const names = [
    'spy-validation', 'recipe-generator', 'image-prompts',
    'part-1', 'part-2', 'part-3',
    'part-1.fallback', 'part-2.fallback', 'part-3.fallback',
    'pin-description', 'pick-board', 'repair-json', 'reel-caption',
  ];

  for (const name of names) {
    const base = name.replace('.fallback', '');
    writeFileSync(`${dir}/${name}.user.txt`, `MARKER-${base} {{seo.title}}`);
    writeFileSync(`${dir}/${name}.system.txt`, `system for ${base}`);
  }
  writeFileSync(`${dir}/pin-graphic.template.txt`, 'pin graphic for {{seo.title}} {{cta}}');
  writeFileSync(`${dir}/reel-video.template.txt`, 'reel video for {{seo.title}}\n{{reelShape}}');
}

