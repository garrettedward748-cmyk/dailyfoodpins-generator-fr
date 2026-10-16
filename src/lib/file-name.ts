import { randomBytes } from 'node:crypto';

/** Lower-case ASCII words joined by hyphens: "Cookies aux pépites" -> "cookies-aux-pepites". */
export function fileSlug(text: string, max = 60): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

/**
 * A picture's file name from the recipe's name: "cookies-aux-pepites-de-chocolat-hero-a1b2c3.webp".
 * The short random tail keeps two files of one recipe (or two sites) from colliding.
 * With nothing to name it after, the random tail alone is used.
 */
export function recipeFileName(recipe: string, hint: string, extension: string): string {
  const parts = [fileSlug(recipe), fileSlug(hint, 20)].filter(Boolean);
  parts.push(randomBytes(3).toString('hex'));
  return `${parts.join('-')}.${extension}`;
}
