/**
 * The "recipe card" pin design: the finished dish at the top under a big
 * burgundy title, then the ingredients and three steps in numbered panels.
 * Kept in a file of its own, with no imports, so the migration that adds it
 * to an existing install can use it without pulling in the database layer.
 */
export const RECIPE_CARD_NAME = 'Fiche recette en étapes';

export const RECIPE_CARD_BODY = `{{imagePrompts.pin}}

Turn that dish into a tall printed recipe card on warm cream paper with a faint texture, in a rustic French kitchen style: deep burgundy for every heading, dark brown for small text, small hand-drawn olive-leaf sprigs with red berries as the only ornaments.

Top of the card, centred: a tiny burgundy chef's hat, under it a short burgundy brush-stroke ribbon reading "{{recipe.badge}}" in a white italic serif, with a small olive sprig on each side. Under it the title "{{pinTitle}}" in a very large, heavy, deep-burgundy serif, centred, on one or two lines.

Upper half: the finished dish, large and golden, in a white oval ceramic dish on a red-striped linen cloth on a wooden table, with a few of its raw ingredients and fresh herbs around it, warm natural light.

Lower half: a grid of panels on the cream paper, separated by thin pale hairlines. Each numbered panel has a burgundy circle with a white number, beside it a burgundy brush-stroke label with white serif words, and a small photograph of that step in the same kitchen.
Panel 1, label "Les ingrédients": a photo of the raw ingredients, and beside it, one per line in a dark serif:
"{{recipe.ingredients}}"
Panel 2, label "La préparation": photo of this step, caption under it: "{{recipe.step1}}"
Panel 3, label "L'assemblage": photo of this step, caption under it: "{{recipe.step2}}"
Panel 4, label "La cuisson": photo of this step, caption under it: "{{recipe.step3}}"
Panel 5, bottom right, no number and no label: one plated serving with a fork, a small salad behind it.

Bottom: a thin burgundy rule, and "{{site.domain}}" in a small burgundy handwritten script in the bottom right corner.

Spell every word exactly as written, once each, in French with all its accents, with no other text, no logo and no watermark anywhere in the image.`;
