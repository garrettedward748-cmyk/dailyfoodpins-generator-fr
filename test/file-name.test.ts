import { describe, expect, it } from 'vitest';
import { fileSlug, recipeFileName } from '../src/lib/file-name.js';

describe('recipeFileName', () => {
  it('names the file after the recipe, without accents', () => {
    expect(fileSlug('Cookies aux pépites de chocolat')).toBe('cookies-aux-pepites-de-chocolat');
    expect(fileSlug("Cœur d'artichaut : l'été")).toBe('coeur-d-artichaut-l-ete');
  });
  it('adds the slot and ends in the extension', () => {
    expect(recipeFileName('Brownies au Nesquik', 'hero', 'webp')).toBe('brownies-au-nesquik-hero.webp');
  });
  it('still gives a name when there is nothing to name it after', () => {
    expect(recipeFileName('', '', 'jpg')).toBe('image.jpg');
  });
});
