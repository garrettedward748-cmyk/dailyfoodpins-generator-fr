import { chat } from '../llm/client.js';
import { loadPrompt, modelFor } from '../pipeline/prompts.js';
import { withoutLinks } from './compose.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';

const log = createLogger('reel-caption');

/**
 * The words under a reel, written rather than assembled.
 *
 * The shape wanted is a hook that stops the scroll, a few lines about the
 * dish, a question worth answering and some hashtags — and no link anywhere in
 * it, because every network adds the link its own way afterwards.
 *
 * Lives here rather than in the web server because both callers need it: the
 * composer, which fetches one after the page has rendered, and the pipeline,
 * which makes a reel for every article without anyone present. The pipeline
 * used the title as the caption, so every automatic reel went out as its own
 * headline repeated — and the caption rules were being written for a path
 * almost nothing took.
 *
 * Never fatal. A model that is down costs the writing, not the reel: the title
 * stands in, which is exactly what the reel used to have.
 */
export async function writeReelCaption(
  about: { title: string; group: string; description: string; annotation: string },
  settings: Settings,
  encryptionKey: Buffer,
  shape = '',
): Promise<string> {
  const title = about.title.trim();

  try {
    const { system, user } = loadPrompt('reel-caption', {
      seo: { title },
      spy: { group: about.group, description: about.description, annotation: about.annotation },
      captionShape: shape,
    });

    const messages = system.trim()
      ? [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: user },
        ]
      : [{ role: 'user' as const, content: user }];

    const result = await chat(
      { model: modelFor('reel-caption'), messages, format: null },
      encryptionKey,
      settings.get('llm_base_url'),
    );

    // The prompt forbids links; this is the belt to that braces, because a
    // link that slips into an Instagram caption is not clickable and a link in
    // a Facebook post drags its reach down.
    return withoutLinks(result.content) || title;
  } catch (err) {
    log.warn(`caption for "${title}" not written: ${errorMessage(err)}`);
    return title;
  }
}
