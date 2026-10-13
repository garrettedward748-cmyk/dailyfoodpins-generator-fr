import type { Settings } from '../settings.js';

/**
 * Where an Instagram post's recipe link goes, as set on Channels -> Instagram.
 *
 * 'bio' (Buffer's free plan, which has no first comment): the caption says
 * the link is in the bio. 'comment' (a paid plan): the caption points down
 * and the link is the first comment. Both lines are the person's own words.
 */
export function instagramLink(settings: Pick<Settings, 'get'>, postUrl: string): { line: string; firstComment?: string } {
  // No link to point at (a social-only account): no line about one either.
  if (!postUrl.trim()) return { line: '' };
  const mode = settings.get('ig_link_mode') === 'comment' ? 'comment' : 'bio';
  if (mode === 'bio') {
    return { line: settings.get('ig_bio_line').trim() || 'La recette complète : lien en bio' };
  }
  const text = (settings.get('ig_comment_text').trim() || 'La recette complète : {url}');
  return {
    line: settings.get('ig_comment_line').trim() || 'La recette complète dans le premier commentaire',
    firstComment: text.includes('{url}') ? text.split('{url}').join(postUrl) : `${text} ${postUrl}`,
  };
}
