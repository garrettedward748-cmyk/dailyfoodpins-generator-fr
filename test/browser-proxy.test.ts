import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerBrowserProxy } from '../src/web/browser-proxy.js';

/**
 * The browser proxy is the one route whose authentication is hand-written: a
 * WebSocket upgrade never reaches Fastify's preHandler hook, so if this were
 * wrong the live Chrome session — signed into Google — would be served to
 * anyone who found the URL.
 */

const SECRET = randomBytes(32);

/** A session cookie the real verifier accepts. Mirrors auth.ts's format. */
function validCookie(offsetMs = 3_600_000): string {
  const payload = `${Date.now() + offsetMs}.${randomBytes(8).toString('base64url')}`;
  const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `ap_session=${payload}.${signature}`;
}

describe('browser proxy', () => {
  let upstream: Server;
  let app: FastifyInstance;
  let upstreamPort: number;
  let appPort: number;
  let upgradesSeen: string[];
  let clients: ReturnType<typeof connect>[];

  beforeEach(async () => {
    upgradesSeen = [];
    clients = [];

    // Stands in for imagegen's noVNC server.
    upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>noVNC</title>${request.url}`);
    });
    upstream.on('upgrade', (request, socket) => {
      upgradesSeen.push(request.url ?? '');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
      socket.write('HELLO-FROM-VNC');
    });
    upstream.listen(0);
    await once(upstream, 'listening');
    upstreamPort = (upstream.address() as AddressInfo).port;

    app = Fastify({ logger: false });
    registerBrowserProxy(app, {
      targetUrl: `http://127.0.0.1:${upstreamPort}`,
      secret: SECRET,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    appPort = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // An upgrade the proxy declined leaves a socket nothing owns: not tracked
    // by the proxy, and no longer counted by the server. Drop them here.
    for (const client of clients) client.destroy();
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await app.close();
    upstream.close();
  });

  /** Send a raw upgrade request and return the first chunk of the reply. */
  function rawUpgrade(path: string, cookie?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(appPort, '127.0.0.1', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${appPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            (cookie ? `Cookie: ${cookie}\r\n` : '') +
            '\r\n',
        );
      });

      clients.push(socket);

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (/HELLO-FROM-VNC|401|404/.test(buffer)) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on('close', () => resolve(buffer));
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error(`no reply for ${path}`));
      }, 4000);
    });
  }

  describe('websocket upgrades', () => {
    it('refuses an upgrade with no session cookie', async () => {
      const reply = await rawUpgrade('/browser/websockify');

      expect(reply).toContain('401');
      expect(upgradesSeen).toEqual([]);
    });

    it('refuses an upgrade whose cookie signature is forged', async () => {
      const forged = `ap_session=${Date.now() + 60_000}.nonce.not-a-real-signature`;

      const reply = await rawUpgrade('/browser/websockify', forged);

      expect(reply).toContain('401');
      expect(upgradesSeen).toEqual([]);
    });

    it('refuses an upgrade whose session has expired', async () => {
      const reply = await rawUpgrade('/browser/websockify', validCookie(-60_000));

      expect(reply).toContain('401');
      expect(upgradesSeen).toEqual([]);
    });

    it('relays an upgrade that carries a valid session', async () => {
      const reply = await rawUpgrade('/browser/websockify', validCookie());

      expect(reply).toContain('101');
      expect(reply).toContain('HELLO-FROM-VNC');
    });

    it('strips the /browser prefix before reaching the target', async () => {
      await rawUpgrade('/browser/websockify', validCookie());

      // noVNC serves its socket at /websockify, not /browser/websockify.
      expect(upgradesSeen).toEqual(['/websockify']);
    });

    it('refuses upgrades for paths it does not own', async () => {
      // Never relayed, and never left dangling either: an unclaimed upgrade
      // socket leaks and hangs shutdown, because Node only auto-destroys one
      // when no upgrade listener exists at all.
      const reply = await rawUpgrade('/something-else');

      expect(reply).toContain('404');
      expect(upgradesSeen).toEqual([]);
    });
  });

  describe('static assets', () => {
    it('redirects the bare path so relative assets resolve under the proxy', async () => {
      // vnc.html asks for `app/styles/base.css` and `core/rfb.js` relatively.
      // Without the trailing slash a browser resolves those against `/`, and
      // the page arrives unstyled with a socket that never opens.
      const response = await app.inject({ method: 'GET', url: '/browser' });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/browser/?autoconnect=true&resize=scale');
    });

    it('serves the noVNC page at the slashed path', async () => {
      const response = await app.inject({ method: 'GET', url: '/browser/' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('noVNC');
      expect(response.body).toContain('/vnc.html');
    });

    it('forwards a query string without treating it as a path', async () => {
      const response = await app.inject({ method: 'GET', url: '/browser/?autoconnect=1' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/vnc.html');
    });

    it('forwards a nested asset path unchanged', async () => {
      const response = await app.inject({ method: 'GET', url: '/browser/core/rfb.js' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/core/rfb.js');
    });

    it('explains itself when the image service is unreachable', async () => {
      const orphan = Fastify({ logger: false });
      registerBrowserProxy(orphan, {
        // Nothing is listening here.
        targetUrl: 'http://127.0.0.1:1',
        secret: SECRET,
      });

      const response = await orphan.inject({ method: 'GET', url: '/browser/' });

      // A 502 with an explanation beats a stack trace: the usual cause is
      // simply that Chrome has not finished starting.
      expect(response.statusCode).toBe(502);
      expect(response.body).toContain('Browser unavailable');
      await orphan.close();
    });
  });
});

describe('shutdown', () => {
  /**
   * An upgraded socket is detached from the HTTP server, so Node no longer
   * counts it and close() would wait on it forever. Before the proxy tracked
   * them, a browser panel left open in a tab hung the whole process on
   * shutdown.
   */
  it('closes even while a browser session is open', async () => {
    const upstream = createServer((_request, response) => response.end('x'));
    upstream.on('upgrade', (_request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\nHELLO-FROM-VNC');
    });
    upstream.listen(0);
    await once(upstream, 'listening');

    const app = Fastify({ logger: false });
    registerBrowserProxy(app, {
      targetUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      secret: SECRET,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = connect(port, '127.0.0.1', () => {
      client.write(
        'GET /browser/websockify HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Cookie: ${validCookie()}\r\n\r\n`,
      );
    });
    await once(client, 'data');

    // The socket is deliberately still open here.
    await expect(
      Promise.race([
        app.close().then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
      ]),
    ).resolves.toBe('closed');

    client.destroy();
    upstream.closeAllConnections();
    upstream.close();
  });
});
