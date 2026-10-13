export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;
let sink: ((level: LogLevel, source: string, message: string, detail?: unknown) => void) | null =
  null;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

/** Persist log records to the events table once the database is available. */
export function setLogSink(fn: typeof sink): void {
  sink = fn;
}

function emit(level: LogLevel, source: string, message: string, detail?: unknown): void {
  if (RANK[level] < threshold) return;

  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (detail !== undefined) {
    console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  }

  // Never let logging break the caller.
  try {
    sink?.(level, source, message, detail);
  } catch {
    /* ignore */
  }
}

export function createLogger(source: string) {
  return {
    debug: (m: string, d?: unknown) => emit('debug', source, m, d),
    info: (m: string, d?: unknown) => emit('info', source, m, d),
    warn: (m: string, d?: unknown) => emit('warn', source, m, d),
    error: (m: string, d?: unknown) => emit('error', source, m, d),
  };
}

/** Turn anything thrown into a readable single-line message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
