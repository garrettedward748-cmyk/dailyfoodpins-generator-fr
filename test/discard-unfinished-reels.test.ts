import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { discardUnfinishedReels, listReels } from '../src/db/repos.js';

/**
 * A runaway batch is stopped without throwing away what was already made:
 * only reels with no video yet go; a finished one, even one waiting on a
 * full Buffer queue, is kept to publish.
 */
describe('discard all still being made', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('removes reels with no video and keeps every reel whose video exists', () => {
    const add = (status: string, video: string | null, output = '') =>
      run('INSERT INTO reels (status, video_url, output_path, caption) VALUES (?, ?, ?, ?)', status, video, output, status + (video ?? '') + output);
    add('generating', null);
    add('draft', null);
    add('generating', null, '/data/clips/1/final.mp4');
    add('ready', 'https://site.test/v.mp4');
    add('failed', 'https://site.test/w.mp4');
    add('failed', null);
    add('published', 'https://site.test/x.mp4');

    expect(discardUnfinishedReels()).toBe(2);
    const left = listReels().map((r) => r.status).sort();
    expect(left).toEqual(['failed', 'failed', 'generating', 'published', 'ready']);
  });
});
