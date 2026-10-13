import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml, head } from './views/layout.js';
import { storedPasswordHash, verifyPassword } from './password.js';

/**
 * Password gate for the UI.
 *
 * The platform is deployed behind a Docker host's proxy, which means a public
 * URL. The UI holds every credential the system uses and can publish to live
 * sites, so it cannot be left open. This is deliberately the smallest thing
 * that is actually safe: one shared password, an HMAC-signed session cookie,
 * no user table, no dependencies.
 */

const COOKIE = 'ap_session';
const SESSION_DAYS = 30;

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still compare something so timing does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(secret: Buffer): string {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const nonce = randomBytes(8).toString('base64url');
  const payload = `${expires}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token: string, secret: Buffer): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expires, nonce, signature] = parts as [string, string, string];
  if (!safeEqual(signature, sign(`${expires}.${nonce}`, secret))) return false;

  const expiryMs = Number(expires);
  return Number.isFinite(expiryMs) && expiryMs > Date.now();
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function loginPage(error?: string, generated?: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
${head('Sign in')}
</head><body class="signin">
<main>
  <div class="docket">
    <div class="docket-head">
      <span>Article Platform</span>
      <span>Sign in</span>
    </div>
    <div class="docket-body">
      <h1>Sign in</h1>
      <p class="subtitle">One password covers every site, key and session behind this.</p>
      ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ''}
      ${
        generated
          ? `<div class="flash warn">A password was generated on first start. Look for
             <span class="mono">ADMIN PASSWORD</span> in the container logs, then set your own
             under Settings.</div>`
          : ''
      }
      <form method="post" action="/login">
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" autofocus required
                 autocomplete="current-password">
        </div>
        <button class="primary" type="submit" style="width:100%">Sign in</button>
      </form>
    </div>
  </div>
</main>
</body></html>`;
}

/**
 * Whether a raw request carries a valid session.
 *
 * The WebSocket proxy needs this: an upgrade never reaches Fastify's
 * preHandler hook, so the browser view would otherwise be the one route on the
 * server with no authentication at all.
 */
export function hasValidSession(
  cookieHeader: string | undefined,
  secret: Buffer,
): boolean {
  if (!cookieHeader) return false;

  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE) {
      return verifyToken(decodeURIComponent(rest.join('=')), secret);
    }
  }
  return false;
}

export interface AuthOptions {
  /** The fallback password: AUTH_PASSWORD, or one generated into the volume. */
  password: string;
  /** HMAC secret for session cookies; the encryption key is reused. */
  secret: Buffer;
  /** True when the fallback was auto-generated, so the hint can be shown. */
  generated: boolean;
  /** Needed to read the chosen password hash out of settings. */
  encryptionKey: Buffer;
}

/**
 * Check a submitted password against whichever one is in force.
 *
 * A password chosen in the UI wins outright. Until one is set, the generated
 * or environment-supplied fallback applies — which is what gets you in on a
 * fresh install.
 *
 * Once a password has been chosen the fallback stops working entirely. That
 * matters: the generated one is printed in the container logs, so leaving it
 * live alongside a chosen password would mean the weaker of the two decides
 * who gets in.
 */
export function passwordAccepted(submitted: string, options: AuthOptions): boolean {
  const chosen = storedPasswordHash(options.encryptionKey);
  if (chosen) return verifyPassword(submitted, chosen);
  return safeEqual(submitted, options.password);
}

/**
 * Paths reachable without a session.
 *
 * `/webhooks/facebook` is Meta calling in, not a person in a browser -- it
 * has no session cookie to send. It is protected a different way: the GET
 * handshake checks `hub.verify_token`, and the POST checks a secret carried
 * in the callback URL's own query string, which `registerAuth` never sees
 * (it is stripped before the lookup here).
 */
const PUBLIC_PATHS = new Set(['/login', '/healthz', '/webhooks/facebook']);

export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    // /media/ is what Buffer, Facebook and Flow download a social-only
    // account's pictures and reels from; they have no session to send. The
    // names are random and the route serves only files the store wrote.
    if (PUBLIC_PATHS.has(path) || path.startsWith('/static/') || path.startsWith('/media/')) return;

    const token = readCookie(request, COOKIE);
    if (token && verifyToken(token, options.secret)) return;

    if (request.method !== 'GET') {
      // Never silently redirect a mutation; the user would lose the submission.
      return reply.status(401).type('text/html').send(loginPage('Session expired. Sign in again.'));
    }

    return reply
      .status(401)
      .type('text/html')
      .send(loginPage(undefined, options.generated && !storedPasswordHash(options.encryptionKey)));
  });

  app.get('/login', async (_request, reply) =>
    // The generated-password hint is pointless once a password has been chosen.
    reply
      .type('text/html')
      .send(loginPage(undefined, options.generated && !storedPasswordHash(options.encryptionKey))),
  );

  app.post('/login', async (request, reply) => {
    const body = request.body as { password?: string } | undefined;
    const submitted = typeof body?.password === 'string' ? body.password : '';

    if (!passwordAccepted(submitted, options)) {
      // Slow down guessing without holding a worker for long.
      await new Promise((r) => setTimeout(r, 400));
      return reply.status(401).type('text/html').send(loginPage('Incorrect password.'));
    }

    const secure = (request.headers['x-forwarded-proto'] ?? request.protocol) === 'https';

    return reply
      .header(
        'set-cookie',
        `${COOKIE}=${issueToken(options.secret)}; Path=/; HttpOnly; SameSite=Lax; ` +
          `Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`,
      )
      .redirect('/', 303);
  });

  app.post('/logout', async (_request, reply) =>
    reply
      .header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
      .redirect('/login', 303),
  );
}
