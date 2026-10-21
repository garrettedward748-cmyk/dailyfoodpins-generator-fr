/**
 * The "white title box" pin design: the dish on a plain warm surface, a white
 * box with a heavy burgundy slab-serif title near the top, and the domain on a
 * small white label at the bottom. Kept in a file of its own, with no imports,
 * so the migration that adds it to an existing install can use it without
 * pulling in the database layer.
 */
export const TITLE_BOX_NAME = 'White title box top, label bottom';

export const TITLE_BOX_BODY = `{{imagePrompts.pin}}

Shoot the dish in soft warm natural light on a plain cream or beige surface, the food set in the middle of the tall frame with calm empty space around it. In the upper part of the frame, a solid white rectangular box with a faint soft drop shadow, starting a little in from the left edge and stopping short of the right edge so it does not span the full width. Inside the box, "{{pinTitle}}" in a very bold, heavy slab serif, all capital letters, left-aligned, in a deep burgundy, tightly stacked on three or four lines. Near the bottom of the frame, centred, a small white rectangular label with the same faint shadow, and on it "{{site.domain}}" in a clean dark burgundy serif. Spell the words exactly as written, once each, with no other text, no logo, no watermark, no badge and no border anywhere in the image.`;
