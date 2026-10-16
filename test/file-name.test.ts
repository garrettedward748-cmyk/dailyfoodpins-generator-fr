import { describe, expect, it } from 'vitest';
import { fileSlug, recipeFileName } from '../src/lib/file-name.js';

describe('recipeFileName', () => {
  it('names the file after the recipe, without accents', () => {
    expect(fileSlug('Cookies aux pépites de chocolat')).toBe('cookies-aux-pepites-de-chocolat');
    expect(fileSlug("Cœur d'artichaut : l'été")).toBe('coeur-d-artichaut-l-ete');
  });
  it('adds the slot and a random tail, and always ends in the extension', () => {
    const a = recipeFileName('Brownies au Nesquik', 'hero', 'webp');
    const b = recipeFileName('Brownies au Nesquik', 'hero', 'webp');
    expect(a).toMatch(/^brownies-au-nesquik-hero-[0-9a-f]{6}\.webp$/);
    expect(a).not.toBe(b);
  });
  it('still gives a name when there is nothing to name it after', () => {
    expect(recipeFileName('', '', 'jpg')).toMatch(/^[0-9a-f]{6}\.jpg$/);
  });
});
