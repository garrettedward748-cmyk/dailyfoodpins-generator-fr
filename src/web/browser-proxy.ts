import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasValidSession } from './auth.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('browser-proxy');

/**
 * The live Chrome session, served inside the platform.
 *
 * imagegen runs a real Chrome under Xvfb with x11vnc in front of it. That used
 * to be published on its own domain behind an eight-character VNC password —
 * a second address to remember, a second secret to manage, and a signed-in
 * Google session guarded by the weakest credential in the system.
 *
 * Now nothing outside can reach it at all: imagegen publishes no ports and has
 * no domain, so this proxy is the only route in. Everything here goes through
 * the same session cookie as the rest of the UI, so there is one login.
 *
 * Why proxy VNC rather than drive Chrome over its DevTools protocol:
 * `Page.startScreencast` streams page content only — no tab strip, no address
 * bar, no extension toolbar, and chrome:// pages do not screencast reliably.
 * That is enough to sign in and nothing else. VNC captures the whole X
 * display, so reinstalling the extension, checking chrome://extensions or
 * switching Google accounts all work exactly as they would on a desktop.
 */

export interface BrowserProxyOptions {
  /** Base URL of imagegen's noVNC server, e.g. http://imagegen:6080 */
  targetUrl: string;
  /** HMAC secret for session cookies. */
  secret: Buffer;
  /**
   * Called when someone opens the viewer page, and again while they watch.
   *
   * There is a browser to look at only while something wants one, so opening
   * this page has to be one of the things that asks. Awaited so the display is
   * already coming up as the page loads, and never allowed to fail the request.
   *
   * Called repeatedly rather than once because the thing it asks for expires:
   * a hold long enough to cover an unattended viewer is also long enough to
   * leave the browser running for a quarter of an hour after the tab is closed,
   * which is exactly what it did.
   */
  onOpen?: () => Promise<void>;
  /**
   * Called once the last viewer socket has been gone for a moment.
   *
   * The page load is a poor signal for "someone is looking at this" and the
   * socket is a good one: it exists for exactly as long as the viewer is open.
   * Debounced because a refresh drops the socket and opens a new one, and a
   * browser stopped and restarted across a refresh is worse than one left up.
   */
  onViewerGone?: () => Promise<void>;
}

/** Host and port of the proxy target, parsed once at registration. */
function parseTarget(targetUrl: string): { host: string; port: number } {
  const url = new URL(targetUrl);
  return { host: url.hostname, port: Number(url.port || 80) };
}

export function registerBrowserProxy(app: FastifyInstance, options: BrowserProxyOptions): void {
  const target = parseTarget(options.targetUrl);

  /**
   * Every socket pair this proxy is currently relaying.
   *
   * An upgraded socket is detached from the HTTP server, so Node stops
   * counting it — `closeAllConnections()` does not reclaim it and `close()`
   * waits on it forever. A browser panel left open in a tab would therefore
   * hang shutdown indefinitely. Tracking them here is what makes the process
   * exit when asked.
   */
  const live = new Set<Duplex>();

  /* -- Who wants the browser up -------------------------------------------
   *
   * Chrome is not running just because the container is: its GPU process costs
   * 170% of a 185% container with nothing loaded, so it runs while something
   * needs it. A viewer is one of those things, and the live socket below is the
   * exact signal — it exists for precisely as long as someone has the page open.
   *
   * The page load alone is not: holding on a page load means picking a duration,
   * and any duration long enough to cover watching is long enough to burn cores
   * for a quarter of an hour after the tab is closed.
   */
  const VIEWER_KEEPALIVE_MS = 60_000;
  const VIEWER_GONE_GRACE_MS = 10_000;
  let keepAlive: NodeJS.Timeout | null = null;
  let goneTimer: NodeJS.Timeout | null = null;

  const viewerArrived = (): void => {
    if (goneTimer) {
      clearTimeout(goneTimer);
      goneTimer = null;
    }
    if (keepAlive || !options.onOpen) return;
    keepAlive = setInterval(() => void options.onOpen?.().catch(() => {}), VIEWER_KEEPALIVE_MS);
    keepAlive.unref?.();
  };

  const viewerLeft = (): void => {
    if (live.size > 0 || goneTimer) return;
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    if (!options.onViewerGone) return;
    // The grace is what makes a refresh survive: the old socket closes and the
    // new one opens inside it, and viewerArrived cancels this.
    goneTimer = setTimeout(() => {
      goneTimer = null;
      void options.onViewerGone?.().catch(() => {});
    }, VIEWER_GONE_GRACE_MS);
    goneTimer.unref?.();
  };

  // preClose, not onClose: onClose runs *after* Fastify has closed the server,
  // which is the very thing these sockets prevent from finishing.
  app.addHook('preClose', async () => {
    if (keepAlive) clearInterval(keepAlive);
    if (goneTimer) clearTimeout(goneTimer);
    keepAlive = null;
    goneTimer = null;
    for (const socket of live) socket.destroy();
    live.clear();
  });

  /* -- Static assets ------------------------------------------------------
   *
   * noVNC is a page plus its own scripts. Fastify's preHandler hook already
   * covers these, so they inherit the session check for free.
   */
  const forward = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const suffix = (request.url.split('?')[0] ?? '').replace(/^\/browser\/?/, '');
    const path = suffix === '' ? 'vnc.html' : suffix;

    // The page itself, not its scripts and images — one call per open rather
    // than one per asset.
    if (path === 'vnc.html' && options.onOpen) {
      await options.onOpen().catch(() => {});
    }

    try {
      const upstream = await fetch(`${options.targetUrl}/${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
      });

      const body = Buffer.from(await upstream.arrayBuffer());
      return reply
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/octet-stream')
        .send(body);
    } catch (err) {
      log.error(`could not reach the browser service: ${errorMessage(err)}`);
      return reply.status(502).type('text/html').send(unreachablePage(errorMessage(err)));
    }
  };

  /**
   * The trailing slash is load-bearing.
   *
   * vnc.html asks for its own assets with relative URLs — `app/styles/base.css`,
   * `core/rfb.js`, and the `websockify` socket. Served at `/browser`, a browser
   * resolves those against `/`, so every one of them lands on the platform's
   * own routes and 404s: the page arrives unstyled, with broken images, and the
   * socket never opens. Served at `/browser/` they resolve under this proxy,
   * which is where they actually live.
   *
   * The query string is noVNC's own, read client-side from window.location:
   * `autoconnect` connects on load instead of showing a connect button, and
   * `resize=scale` fits the remote screen to the tab rather than showing it at
   * 1:1 inside a black frame.
   */
  app.get('/browser', async (_request, reply) =>
    reply.redirect('/browser/?autoconnect=true&resize=scale', 302),
  );
  app.get('/browser/*', forward);

  /* -- The WebSocket itself -----------------------------------------------
   *
   * An upgrade request never reaches Fastify's routing or its preHandler
   * hook, so the session has to be checked here by hand — otherwise this
   * would be the one route on the server with no authentication.
   *
   * The relay is byte-level on purpose. Rewriting frames would mean pulling in
   * a WebSocket library and understanding noVNC's binary subprotocol; piping
   * the raw sockets is transparent to whatever the two ends agree on, and
   * needs no dependency at all.
   */
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0] ?? '';

    if (!path.startsWith('/browser')) {
      // Node destroys an upgrade only when nothing is listening for one. This
      // handler counts as listening, so a path it does not own would leave a
      // socket attached to no reader and closed by nobody — a slow leak, and
      // one that also hangs shutdown. Refuse it explicitly.
      //
      // Revisit if a second upgrade route is ever added here.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!hasValidSession(request.headers.cookie, options.secret)) {
      log.warn('rejected an unauthenticated browser upgrade');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstreamPath = path.replace(/^\/browser\/?/, '/') || '/';
    const upstream = connect(target.port, target.host, () => {
      live.add(socket);
      live.add(upstream);
      viewerArrived();

      // Replay the client's upgrade against the target, rewritten to its path.
      const headers = { ...request.headers, host: `${target.host}:${target.port}` };
      const lines = Object.entries(headers)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);

      upstream.write(`GET ${upstreamPath} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);

      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const drop = (what: string) => (err?: Error) => {
      if (err) log.debug(`browser session ${what}: ${err.message}`);
      live.delete(socket);
      live.delete(upstream);
      upstream.destroy();
      socket.destroy();
      viewerLeft();
    };

    upstream.on('error', drop('upstream error'));
    socket.on('error', drop('client error'));
    upstream.on('close', drop('upstream closed'));
    socket.on('close', drop('client closed'));
  });
}

function unreachablePage(detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Browser unavailable</title><link rel="stylesheet" href="/static/style.css"></head>
<body><main style="max-width:640px;margin:12vh auto">
  <h1>Browser unavailable</h1>
  <p class="subtitle">The image service is not answering.</p>
  <div class="card">
    <p>The <span class="mono">imagegen</span> container runs Chrome and the Google
       Flow extension. If it is restarting, this page works again once it is up —
       Chrome takes about a minute.</p>
    <p class="muted small mono">${detail.replace(/[<>&]/g, '')}</p>
  </div>
</main></body></html>`;
}
