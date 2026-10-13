import { LlmJsonError, parseJson, tryParseJson } from './json.js';
import { createLogger } from '../lib/logger.js';
import type { PipelineContext } from './context.js';

const log = createLogger('json-repair');

/**
 * Parse a model's JSON, and if it cannot be repaired mechanically, ask the
 * model to rewrite it.
 *
 * Losing a whole generation to a trailing comma is the wrong trade. The
 * generation already cost 10-60 seconds and a slice of the rate limit; a
 * repair costs one short call against text that is already almost correct.
 *
 * The order matters. Local repair runs first because it is free, instant, and
 * deterministic — sending every stray quote to a model would be slower and
 * would sometimes come back subtly different. The model is the fallback for
 * damage no rule can describe: a truncated document, a missing brace in the
 * middle, two objects concatenated.
 *
 * The repaired document is checked for the fields the caller needs, so a model
 * that "fixes" the JSON by returning `{}` fails here rather than three steps
 * later with something emptier and harder to trace.
 */
export async function parseJsonOrRepair<T extends Record<string, unknown>>(
  ctx: PipelineContext,
  raw: string,
  what: string,
  options: { requiredFields?: string[] } = {},
): Promise<T> {
  const local = tryParseJson<T>(raw);

  if (local) {
    if (local.repairedBy !== 'as written') {
      // Worth a line: a model that has started emitting broken JSON every time
      // is a prompt or model problem, and this is the only place it shows.
      log.info(`${what} needed repair (${local.repairedBy})`);
    }
    if (hasFields(local.value, options.requiredFields)) return local.value;
    log.warn(`${what} parsed but is missing ${missing(local.value, options.requiredFields)}`);
  }

  log.warn(`${what} could not be repaired locally; asking the model to rewrite it`);

  const complaint = local
    ? `The JSON parsed but was missing required fields: ${missing(local.value, options.requiredFields)}.`
    : describeFailure(raw);

  try {
    const response = await ctx.prompt('repair-json', {
      postError: complaint,
      articleJson: raw.slice(0, 20_000),
    });

    const repaired = parseJson<T>(response.content, `${what} (model-repaired)`);

    if (!hasFields(repaired, options.requiredFields)) {
      throw new LlmJsonError(
        `${what} was rewritten but is still missing ${missing(repaired, options.requiredFields)}`,
        response.content.slice(0, 2000),
      );
    }

    log.info(`${what} rewritten by the model successfully`);
    return repaired;
  } catch (err) {
    // Fall through to the original error. The rewrite failing is not the
    // interesting fact — what the model produced in the first place is.
    log.warn(`model rewrite of ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return parseJson<T>(raw, what);
  }
}

function hasFields(value: Record<string, unknown>, fields?: string[]): boolean {
  if (!fields?.length) return true;
  return fields.every((f) => {
    const v = value[f];
    return v !== undefined && v !== null && v !== '';
  });
}

function missing(value: Record<string, unknown>, fields?: string[]): string {
  if (!fields?.length) return 'nothing';
  return (
    fields
      .filter((f) => {
        const v = value[f];
        return v === undefined || v === null || v === '';
      })
      .join(', ') || 'nothing'
  );
}

/** The parser's own complaint, which is the most useful thing to hand back. */
function describeFailure(raw: string): string {
  try {
    JSON.parse(raw);
    return 'The document could not be parsed.';
  } catch (err) {
    return `The document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
}
