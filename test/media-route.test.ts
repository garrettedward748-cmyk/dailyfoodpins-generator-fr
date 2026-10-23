import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';
import { configureMediaStore } from '../src/integrations/media-store.js';

/** /media serves a social-only account's files the way Facebook and Buffer fetch them. */

const KEY = randomBytes(32);
let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'media-route-'));
  configureMediaStore({ dir, publicUrl: () => 'https://platform.test' });
  writeFileSync(join(dir, 'reel-abc.mp4'), Buffer.from('0123456789'));
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

it('sends the length and takes ranges, without a session', async () => {
  const whole = await app.inject({ method: 'GET', url: '/media/reel-abc.mp4' });
  expect(whole.statusCode).toBe(200);
  expect(whole.headers['content-length']).toBe('10');
  expect(whole.headers['accept-ranges']).toBe('bytes');
  expect(whole.headers['content-type']).toBe('video/mp4');

  const part = await app.inject({ method: 'GET', url: '/media/reel-abc.mp4', headers: { range: 'bytes=2-5' } });
  expect(part.statusCode).toBe(206);
  expect(part.headers['content-range']).toBe('bytes 2-5/10');
  expect(part.body).toBe('2345');

  const tail = await app.inject({ method: 'GET', url: '/media/reel-abc.mp4', headers: { range: 'bytes=-3' } });
  expect(tail.body).toBe('789');

  const past = await app.inject({ method: 'GET', url: '/media/reel-abc.mp4', headers: { range: 'bytes=20-' } });
  expect(past.statusCode).toBe(416);
});

it('records a network fetching a file as its post going out, and nothing else', async () => {
  await app.inject({ method: 'GET', url: '/media/reel-abc.mp4', headers: { 'user-agent': 'Mozilla/5.0 Safari' } });
  expect(existsSync(join(dir, 'delivered.json'))).toBe(false);

  await app.inject({ method: 'GET', url: '/media/reel-abc.mp4', headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  const delivered = JSON.parse(readFileSync(join(dir, 'delivered.json'), 'utf8')) as Record<string, number>;
  expect(Object.keys(delivered)).toEqual(['reel-abc.mp4']);
});
