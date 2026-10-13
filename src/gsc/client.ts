import { createSign } from 'node:crypto';

/**
 * Google Search Console, read-only, as a service account.
 *
 * A service account is a Google identity made for programs: a JSON key from
 * Google Cloud, added as a user on the Search Console property. The program
 * signs a short JWT with the key, trades it for an access token, and asks the
 * Search Analytics API what people searched. Nothing here can change the
 * property: the scope is webmasters.readonly.
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://www.googleapis.com/webmasters/v3';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GscRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GscError';
  }
}

/** The key file, checked enough to fail with a sentence rather than deep inside a signature. */
export function parseServiceAccount(json: string): ServiceAccount {
  let data: Partial<ServiceAccount> & { type?: string };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    throw new GscError('That is not the JSON key file: it could not be read as JSON.');
  }
  if (!data.client_email || !data.private_key?.includes('PRIVATE KEY')) {
    throw new GscError('That JSON has no client_email or private_key — download the key of a service account (Keys → Add key → JSON).');
  }
  return { client_email: data.client_email, private_key: data.private_key, token_uri: data.token_uri };
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

const tokens = new Map<string, { token: string; until: number }>();

export class GscClient {
  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    const cached = tokens.get(this.account.client_email);
    if (cached && cached.until > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const aud = this.account.token_uri || 'https://oauth2.googleapis.com/token';
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.account.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${claims}`);
    const jwt = `${head}.${claims}.${b64url(signer.sign(this.account.private_key))}`;

    const response = await this.fetchImpl(aud, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !data.access_token) {
      throw new GscError(`Google refused the key: ${data.error_description || data.error || `HTTP ${response.status}`}`);
    }
    tokens.set(this.account.client_email, { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!response.ok) {
      const why = data.error?.message ?? `HTTP ${response.status}`;
      throw new GscError(
        response.status === 403
          ? `No access: add ${this.account.client_email} as a user of this property in Search Console. (${why})`
          : `Search Console: ${why}`,
      );
    }
    return data;
  }

  /** The properties this service account was added to. */
  async listSites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    const data = await this.call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>('/sites');
    return (data.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  }

  /** Every search and page with impressions between two days (YYYY-MM-DD). */
  async searchAnalytics(property: string, startDate: string, endDate: string, rowLimit = 5000): Promise<GscRow[]> {
    const data = await this.call<{ rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(
      `/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      { startDate, endDate, dimensions: ['query', 'page'], rowLimit, type: 'web' },
    );
    return (data.rows ?? []).map((r) => ({
      query: r.keys[0] ?? '',
      page: r.keys[1] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
  }
}
