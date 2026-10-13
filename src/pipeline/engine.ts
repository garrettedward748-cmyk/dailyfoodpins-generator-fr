import { beginStep, finishStep, getCompletedStep, touchSchedulerLock } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { PipelineContext } from './context.js';

const log = createLogger('pipeline');

/**
 * A checkpointed step runner.
 *
 * Every step's output is persisted. On resume, a step that already succeeded
 * is skipped and its stored output reused. That is what makes a failure at
 * "publish-to-buffer" cost one retry rather than thirteen LLM calls and five
 * image generations.
 */

export interface StepResult<T = unknown> {
  value: T;
  /** Recorded against the step so the UI can show which endpoint served it. */
  endpoint?: string;
  model?: string;
}

export interface Step<TIn = unknown, TOut = unknown> {
  name: string;
  /** Human-readable label for the run detail page. */
  title: string;
  run(context: PipelineContext, input: TIn): Promise<StepResult<TOut> | TOut>;
}

export class StepFailedError extends Error {
  constructor(
    readonly step: string,
    override readonly cause: unknown,
  ) {
    super(`Step "${step}" failed: ${errorMessage(cause)}`);
    this.name = 'StepFailedError';
  }
}

function isStepResult<T>(value: unknown): value is StepResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in (value as Record<string, unknown>)
  );
}

/**
 * Execute one step, honouring any existing checkpoint.
 * Throws StepFailedError so the caller always knows which step ended a run.
 */
/**
 * A step that stops responding must fail, not sit there.
 *
 * Every network call in this codebase has its own timeout, and a run still
 * managed to hang with the lock held and nothing to look at — an await that
 * never settles is invisible from the outside, and the only cure was waiting
 * ninety minutes for the lock to go stale.
 *
 * The losing promise is not cancelled: there is nothing to cancel it with, and
 * whatever it was doing will end on its own timeout or be collected with the
 * process. What matters is that the run stops waiting and reports why.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Step "${name}" timed out after ${Math.round(ms / 60_000)} minute(s) with ` +
                  `no response. ` +
                  `Raise the step timeout in Settings if this step legitimately takes longer.`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runStep<TIn, TOut>(
  context: PipelineContext,
  step: Step<TIn, TOut>,
  input: TIn,
): Promise<TOut> {
  const existing = getCompletedStep(context.runId, step.name);

  if (existing && context.allowResume) {
    log.info(`run ${context.runId}: skipping "${step.name}" (already completed)`);
    try {
      return JSON.parse(existing.output_json ?? 'null') as TOut;
    } catch {
      log.warn(`run ${context.runId}: checkpoint for "${step.name}" unreadable, re-running`);
    }
  }

  beginStep(context.runId, step.name);
  // Progress, for the watchdog that reaps a run whose process died mid-step.
  touchSchedulerLock();
  const started = Date.now();
  // Whatever the previous step left behind is not this step's cost.
  context.resetUsage();
  log.info(`run ${context.runId}: → ${step.name}`);

  try {
    const raw = await withTimeout(
      step.run(context, input),
      Math.max(1, context.settings.getNumber('run_step_timeout_minutes')) * 60_000,
      step.name,
    );
    const result = isStepResult<TOut>(raw) ? raw : { value: raw as TOut };
    const usage = context.takeUsage();

    finishStep(context.runId, step.name, {
      status: 'ok',
      output: result.value,
      durationMs: Date.now() - started,
      endpoint: result.endpoint,
      model: result.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      images: usage.images,
    });

    log.info(`run ${context.runId}: ✓ ${step.name} (${Date.now() - started}ms)`);
    return result.value;
  } catch (err) {
    // A failed step still spent what it spent, and a step that burns tokens
    // and then fails is exactly the one worth seeing in the usage table.
    const usage = context.takeUsage();

    finishStep(context.runId, step.name, {
      status: 'failed',
      error: errorMessage(err),
      durationMs: Date.now() - started,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      images: usage.images,
    });

    log.error(`run ${context.runId}: ✗ ${step.name}`, errorMessage(err));
    throw new StepFailedError(step.name, err);
  }
}

/**
 * Retry a transient operation with exponential backoff and jitter.
 * Preserves the backoff behaviour of the original Code in JavaScript5 node,
 * with the retry ceiling and the branch condition finally agreeing (the old
 * implementation set maxRetries = 5 but branched at retryCount > 3, so two
 * attempts were unreachable).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;

      const delay = Math.pow(2, attempt) * base + Math.floor(Math.random() * 1000);
      log.warn(
        `${options.label ?? 'operation'} failed (attempt ${attempt}/${attempts}), ` +
          `retrying in ${delay}ms: ${errorMessage(err)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
