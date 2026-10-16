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
 * A file name from the recipe's name: "cookies-aux-pepites-de-chocolat-hero.webp".
 * No random tail here: whoever stores the file adds one (the site, or the
 * local media store), so two files of one recipe never collide.
 * With nothing to name it after, the name is just the hint.
 */
export function recipeFileName(recipe: string, hint: string, extension: string): string {
  const parts = [fileSlug(recipe), fileSlug(hint, 20)].filter(Boolean);
  return `${parts.length ? parts.join('-') : 'image'}.${extension}`;
}
