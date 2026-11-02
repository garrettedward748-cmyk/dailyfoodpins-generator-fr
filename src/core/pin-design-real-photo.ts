/**
 * The two "real home cooking" pin designs: a white title banner over a dish that
 * looks photographed by the person who cooked it, not styled for a shoot. Kept
 * in a file of its own, with no imports, so the migration that adds them to an
 * existing install can use them without pulling in the database layer.
 *
 * The look is written into the designs themselves as well as the image prompts,
 * so a site whose image prompts were edited in Setup -> Prompts still gets it.
 */
const REAL_LOOK = `Whatever the description above says about empty space, let the food fill most of the frame. This must look like a real photo that a home cook took of their own dinner with a phone just before eating, not a styled shoot and not a computer render. The food is well cooked and looks delicious, but it was served quickly and nobody arranged it: the pieces are uneven in size and shape and sit in no pattern, some are browner than others, a little sauce has smeared or dripped on the rim of the dish, and a few crumbs or stray bits of herb have landed where they fell. The garnish is scattered unevenly, not placed. The dish is an ordinary everyday one and sits slightly off-centre, the framing a little casual and not perfectly straight. Something was left there without thought, such as a crumpled used napkin half in the frame or a fork resting at an angle. Plain daylight from a kitchen window, soft uneven shadows, true unfiltered colours, a faint phone-camera grain, and only part of the food in sharp focus. No glossy or plastic-looking surfaces, no perfect symmetry, no spotless staging, no people and no hands.`;

const NO_EXTRA = 'The words are a flat, clean graphic on top of the photo and never cover the centre of the dish. Spell them exactly as written, once each, with no other text, no logo, no watermark, no badge and no border anywhere in the image.';

export const REAL_BANNER_NAME = 'Real home photo, wide title banner';

export const REAL_BANNER_BODY = `{{imagePrompts.pin}}

${REAL_LOOK}

Near the top of the frame, a wide solid white rectangular banner with equal margins on the left and right. Inside it, "{{pinTitle}}" in a very bold, condensed sans-serif, all capital letters that keep every French accent, left-aligned, in a deep burgundy, on two or three tightly stacked lines. Near the bottom, centred, a small white rectangular label, and on it "{{site.domain}}" in bold deep burgundy. ${NO_EXTRA}`;

export const REAL_CORNER_NAME = 'Real home photo, corner title and bottom strip';

export const REAL_CORNER_BODY = `{{imagePrompts.pin}}

${REAL_LOOK}

A solid white rectangular box flush against the top-left corner of the frame, about sixty percent of its width. Inside it, "{{pinTitle}}" in a very bold serif, all capital letters that keep every French accent, left-aligned, in a deep burgundy, on two or three tightly stacked lines. A full-width solid white strip runs along the very bottom of the frame, and on it, centred on one line in deep burgundy, "Une recette à essayer ! — {{site.domain}}". ${NO_EXTRA}`;
