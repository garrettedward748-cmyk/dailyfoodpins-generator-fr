import { describe, expect, it } from 'vitest';
import { findBoard, sameBoard } from '../src/core/board-match.js';

describe('sameBoard', () => {
  it('matches boards worded a little differently', () => {
    expect(sameBoard('Easy Dessert Recipes', 'Desserts')).toBe(true);
    expect(sameBoard('Chicken Dinner Recipes', 'Easy Chicken Dinners')).toBe(true);
    expect(sameBoard('Cookies & Bars', 'Cookie and Bar Recipes')).toBe(true);
    expect(sameBoard('Chicken Dinners', 'Chicken Dinner Casseroles')).toBe(true);
  });
  it('keeps different topics apart', () => {
    expect(sameBoard('Chicken Soup Recipes', 'Chicken Recipes')).toBe(false);
    expect(sameBoard('Dessert Recipes', 'Breakfast Recipes')).toBe(false);
    expect(sameBoard('Easy Recipes', 'Best Recipes')).toBe(true);
    expect(sameBoard('Easy Recipes', 'Soup Recipes')).toBe(false);
  });
  it('returns the existing name as written', () => {
    expect(findBoard('easy dessert recipes', ['Breakfast', 'Sweet Desserts ', 'Desserts'])).toBe('Desserts');
    expect(findBoard('Soup Recipes', ['Desserts'])).toBeUndefined();
  });
});
