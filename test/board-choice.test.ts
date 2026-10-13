import { describe, expect, it, vi } from 'vitest';
import { resolveBufferTarget } from '../src/pipeline/steps/publish.js';
import { parseBoardMap } from '../src/db/repos.js';

/** Which board a pin goes on: the topic's board, the model's pick, or the general board. */
const boards = [
  { serviceId: 'b1', name: 'Desserts' },
  { serviceId: 'b2', name: 'Chicken Dinners' },
  { serviceId: 'b3', name: 'Easy Recipes' },
];

function ctx(site: Record<string, string>, answer: string, seed = 'dessert') {
  const prompt = vi.fn(async () => ({ content: answer, endpoint: 'k', model: 'm' }));
  return {
    prompt,
    value: {
      site: { domain: 'd.com', pin_username: '', ...site },
      keyword: { seed_keyword: seed },
      buffer: {
        getOrganizationId: async () => 'o',
        getChannels: async () => [{ id: 'ch', name: 'arbmom', service: 'pinterest', boards }],
      },
      prompt,
    } as never,
  };
}
const seo = { title: 'Lemon Bars' } as never;
const board = (out: unknown) => ((out as { value?: { boardName: string } }).value ?? (out as { boardName: string })).boardName;

describe('choosing the board', () => {
  it('uses the topic group’s board without asking the model', async () => {
    const c = ctx({ pin_board_map: 'dessert = Desserts\nchicken = Chicken Dinners' }, '');
    expect(board(await resolveBufferTarget.run(c.value, seo))).toBe('Desserts');
    expect(c.prompt).not.toHaveBeenCalled();
  });

  it('takes the model’s pick when the topic has no board', async () => {
    const c = ctx({}, '{"name":"Chicken Dinners","id":"b2"}', 'chicken');
    expect(board(await resolveBufferTarget.run(c.value, seo))).toBe('Chicken Dinners');
  });

  it('sends a recipe nothing fits to the general board', async () => {
    const c = ctx({ pin_default_board: 'Easy Recipes' }, '{"name":"none","id":"none"}', 'soup');
    expect(board(await resolveBufferTarget.run(c.value, seo))).toBe('Easy Recipes');
  });

  it('reads "group = Board" lines', () => {
    expect([...parseBoardMap('Dessert = Desserts\n\nbad line\nchicken → Chicken Dinners')]).toEqual([
      ['dessert', 'Desserts'], ['chicken', 'Chicken Dinners'],
    ]);
  });
});
