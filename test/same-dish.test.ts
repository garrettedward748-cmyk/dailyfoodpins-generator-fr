import { describe, expect, it } from 'vitest';
import { DishIndex, sameDish } from '../src/core/similar-title.js';

/** The pairs that were published twice on dailyfoodpins.com, and pairs that must stay apart. */
describe('same dish', () => {
  it.each([
    ['Biscoff Banana Pudding', 'Biscoff Banana Pudding: No-Bake Layered Dessert'],
    ['Mini Blueberry Cheesecakes: Individual Creamy Desserts', 'Mini Blueberry Cheesecakes: Individual Berry Desserts'],
    ['Chocolate Dipped Strawberries: Fresh Fruit with Swirly Patterns', 'Swirly Chocolate Dipped Strawberries'],
    ['Belgian Waffles: Strawberry Stack with Chocolate Drizzle', 'Belgian Waffle Stack with Strawberry and Chocolate'],
    ['Apple Crisp Cheesecake', 'apple crisp cheesecake'],
    ['Apple Crisp', 'Apple Crumble'],
    ['Apple Crisp Cheesecake', 'Apple Crumble Cheesecake'],
    ['Lemon Bars', 'Lemon Squares'],
    ['Lemon Bars', 'Lemon Bars: Easy Shortbread Crust'],
    ['Red Velvet Brownies', 'Red Velvet Brownies - Fudgy Cream Cheese Swirl'],
  ])('%s = %s', (a, b) => expect(sameDish(a, b)).toBe(true));

  it.each([
    ['Cheesecake Bars', 'Chocolate Chip Cookie Cheesecake Bars'],
    ['Chocolate Chip Cookies', 'Chocolate Chip Cookie Cheesecake Bars'],
    ['Apple Pie Cheesecake Tacos', 'Apple Crisp Cheesecake'],
    ['Strawberry Cheesecake', 'Creamy Cinnamon Roll Cheesecake'],
    ['Lemon Bars', 'Lemon Bar Cheesecake'],
    ['Apple Crisp', 'Apple Pie'],
  ])('%s ≠ %s', (a, b) => expect(sameDish(a, b)).toBe(false));

  it('finds the twin in a long list and can ignore an exact match', () => {
    const index = new DishIndex(['Lemon Bars', 'Biscoff Banana Pudding', 'Garlic Butter Shrimp']);
    expect(index.find('Biscoff Banana Pudding: No-Bake Layered Dessert')).toBe('Biscoff Banana Pudding');
    expect(index.find('Biscoff Banana Pudding', true)).toBeNull();
    expect(index.find('Honey Garlic Chicken')).toBeNull();
  });
});

describe('adding keywords', () => {
  it('leaves out a pasted or imported line that repeats an existing dish in other words', async () => {
    const { openDatabase, closeDatabase } = await import('../src/db/index.js');
    const { addPastedKeywords } = await import('../src/db/repos.js');
    const { importKeywordsCsv } = await import('../src/web/import.js');
    openDatabase(':memory:');
    try {
      const first = addPastedKeywords(['Mini Blueberry Cheesecakes', 'Biscoff Banana Pudding'], 'dessert', []);
      expect(first.added).toBe(2);
      const again = addPastedKeywords(['Mini Blueberry Cheesecake', 'Lemon Bars'], 'dessert', []);
      expect(again).toMatchObject({ added: 1, skipped: 1 });
      expect(again.similar[0]).toMatch(/Mini Blueberry Cheesecakes/);

      const csv = 'seed_keyword,spy_title\ndessert,Biscoff Banana Pudding: No-Bake Layered Dessert\ndessert,Garlic Butter Shrimp\n';
      const report = importKeywordsCsv(csv);
      expect(report.imported).toBe(1);
      expect(report.similar).toHaveLength(1);
    } finally {
      closeDatabase();
    }
  });
});
