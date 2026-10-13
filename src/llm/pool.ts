import { all, get, run } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('llm-pool');

/**
 * A pool of Ollama endpoints with health tracking and automatic failover.
 *
 * This replaces nine Ollama credentials hand-pinned to individual nodes in
 * the previous system. That arrangement spread load but provided no
 * resilience: if the endpoint wired into "Part 1" went down, that stage
 * failed every time while the other eight sat idle.
 *
 * Here the caller asks for a model and the pool decides where to send it.
 * A rate-limited or unhealthy endpoint is skipped, and the same request is
 * retried elsewhere. The flow only fails when every endpoint serving that
 * model has been exhausted.
 */

export interface EndpointRow {
  id: number;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  models: string;
  enabled: number;
  healthy: number;
  consecutive_fails: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface Endpoint {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  healthy: boolean;
  consecutiveFails: number;
  cooldownUntil: Date | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

const FAILURES_BEFORE_UNHEALTHY = 3;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const UNHEALTHY_RETRY_AFTER_MS = 120_000;

function parseModels(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToEndpoint(row: EndpointRow, key: Buffer, fallbackBaseUrl = ''): Endpoint {
  let apiKey = '';
  try {
    apiKey = decrypt(row.api_key_encrypted, key);
  } catch (err) {
    log.warn(`Endpoint "${row.name}" has an unreadable API key`, errorMessage(err));
  }

  return {
    id: row.id,
    name: row.name,
    baseUrl: (row.base_url || fallbackBaseUrl).replace(/\/+$/, ''),
    apiKey,
    models: parseModels(row.models),
    enabled: row.enabled === 1,
    healthy: row.healthy === 1,
    consecutiveFails: row.consecutive_fails,
    cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until) : null,
    lastUsedAt: row.last_used_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

/* -- CRUD ---------------------------------------------------------------- */

export const listEndpointRows = (): EndpointRow[] =>
  all<EndpointRow>('SELECT * FROM llm_endpoints ORDER BY name');

export const listEndpoints = (key: Buffer, fallbackBaseUrl = ''): Endpoint[] =>
  listEndpointRows().map((r) => rowToEndpoint(r, key, fallbackBaseUrl));

export function upsertEndpoint(
  input: { name: string; baseUrl: string; apiKey: string; models: string[]; enabled: boolean },
  key: Buffer,
): void {
  const existing = get<EndpointRow>('SELECT * FROM llm_endpoints WHERE name = ?', input.name);
  const models = JSON.stringify(input.models);

  if (existing) {
    // An empty API key on update means "leave the stored one alone".
    const encrypted = input.apiKey ? encrypt(input.apiKey, key) : existing.api_key_encrypted;
    run(
      `UPDATE llm_endpoints SET base_url = ?, api_key_encrypted = ?, models = ?, enabled = ?
       WHERE id = ?`,
      input.baseUrl,
      encrypted,
      models,
      input.enabled ? 1 : 0,
      existing.id,
    );
    return;
  }

  run(
    `INSERT INTO llm_endpoints (name, base_url, api_key_encrypted, models, enabled)
     VALUES (?, ?, ?, ?, ?)`,
    input.name,
    input.baseUrl,
    encrypt(input.apiKey, key),
    models,
    input.enabled ? 1 : 0,
  );
}

export const deleteEndpoint = (id: number): void => {
  run('DELETE FROM llm_endpoints WHERE id = ?', id);
};

/* -- Health bookkeeping -------------------------------------------------- */

export function markSuccess(id: number): void {
  run(
    `UPDATE llm_endpoints SET healthy = 1, consecutive_fails = 0, cooldown_until = NULL,
       last_used_at = datetime('now'), last_success_at = datetime('now'), last_error = NULL
     WHERE id = ?`,
    id,
  );
}

export function markFailure(id: number, error: string, cooldownMs = 0): void {
  const row = get<EndpointRow>('SELECT * FROM llm_endpoints WHERE id = ?', id);
  if (!row) return;

  const fails = row.consecutive_fails + 1;
  const unhealthy = fails >= FAILURES_BEFORE_UNHEALTHY;
  const cooldown = cooldownMs > 0 ? cooldownMs : unhealthy ? UNHEALTHY_RETRY_AFTER_MS : 0;
  const until = cooldown > 0 ? new Date(Date.now() + cooldown).toISOString() : null;

  run(
    `UPDATE llm_endpoints SET consecutive_fails = ?, healthy = ?, cooldown_until = ?,
       last_used_at = datetime('now'), last_error = ?
     WHERE id = ?`,
    fails,
    unhealthy ? 0 : 1,
    until,
    error.slice(0, 500),
    id,
  );

  if (unhealthy) {
    log.warn(`Endpoint "${row.name}" marked unhealthy after ${fails} consecutive failures`);
  }
}

export function resetEndpointHealth(id: number): void {
  run(
    'UPDATE llm_endpoints SET healthy = 1, consecutive_fails = 0, cooldown_until = NULL, last_error = NULL WHERE id = ?',
    id,
  );
}

/* -- Selection ----------------------------------------------------------- */

/**
 * Endpoints able to serve `model` right now, least-recently-used first.
 * An endpoint with no declared models is treated as serving everything,
 * which keeps a single-endpoint setup working with no configuration.
 */
export function candidatesFor(
  model: string,
  key: Buffer,
  fallbackBaseUrl = '',
  now = new Date(),
): Endpoint[] {
  return listEndpoints(key, fallbackBaseUrl)
    .filter((e) => e.enabled)
    .filter((e) => e.models.length === 0 || e.models.includes(model))
    .filter((e) => !e.cooldownUntil || e.cooldownUntil <= now)
    .filter((e) => e.healthy)
    .sort((a, b) => {
      const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      if (ta !== tb) return ta - tb;
      return a.id - b.id;
    });
}

/** Everything configured for a model, ignoring health — used for diagnostics. */
export function allFor(model: string, key: Buffer, fallbackBaseUrl = ''): Endpoint[] {
  return listEndpoints(key, fallbackBaseUrl).filter(
    (e) => e.enabled && (e.models.length === 0 || e.models.includes(model)),
  );
}

export const COOLDOWNS = { RATE_LIMIT_COOLDOWN_MS, UNHEALTHY_RETRY_AFTER_MS };
