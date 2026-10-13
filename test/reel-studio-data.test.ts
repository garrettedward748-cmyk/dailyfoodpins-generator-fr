import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  deletePresenter,
  getFbPage,
  getReel,
  insertFbToken,
  insertKeyword,
  insertPresenter,
  listPresenters,
  listScenes,
  presenterForPage,
  recentFormatsForPage,
  replaceScenes,
  setFbPagePresenter,
  setReelStage,
  updateScene,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';

/**
 * What the reel studio keeps: a presenter (a character and a voice in the
 * Flow project, named here), the stage a reel is at, and one row per scene
 * so a scene can fail and be retried on its own.
 */

const KEY = randomBytes(32);

describe('reel studio data', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  const seed = () => {
    const siteId = upsertSite(
      { name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '',
        daily_target: 1, interval_minutes: 60 },
      KEY,
    );
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const tokenId = insertFbToken('App', 'tok', KEY);
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId });
    return { siteId, keywordId, pageId };
  };

  const reel = (ids: ReturnType<typeof seed>) =>
    createReel({ runId: null, siteId: ids.siteId, keywordId: ids.keywordId, fbPageId: ids.pageId,
      prompt: '', caption: 'c', references: [], stage: 'planning' });

  it('a presenter is a character and a voice in the project, plus how they sound', () => {
    const id = insertPresenter({ name: 'Rima', flowCharacterId: 'char-1', flowVoiceId: 'voice-1',
      voiceDescription: 'warm, unhurried', portraitUrl: 'https://x/p.jpg' });
    expect(listPresenters()[0]).toMatchObject({
      id, name: 'Rima', flow_character_id: 'char-1', flow_voice_id: 'voice-1',
    });
  });

  it('a page picks one presenter, and losing the presenter leaves the page without one', () => {
    const { pageId } = seed();
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'c', flowVoiceId: 'v',
      voiceDescription: '', portraitUrl: '' });
    setFbPagePresenter(pageId, presenterId);
    expect(presenterForPage(pageId)?.name).toBe('Rima');
    deletePresenter(presenterId);
    expect(getFbPage(pageId)?.presenter_id).toBeNull();
    expect(presenterForPage(pageId)).toBeUndefined();
  });

  it('a reel starts in planning and moves stage by stage, keeping its plan', () => {
    const ids = seed();
    const reelId = reel(ids);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'planning' });
    setReelStage(reelId, 'filming', { planJson: '{"scenes":[]}', format: 'reveal' });
    expect(getReel(reelId)).toMatchObject({
      stage: 'filming', format: 'reveal', plan_json: '{"scenes":[]}',
    });
  });

  it('a one-shot reel made the old way is not on any stage', () => {
    const ids = seed();
    const id = createReel({ runId: null, siteId: ids.siteId, keywordId: ids.keywordId,
      fbPageId: ids.pageId, prompt: 'p', caption: 'c', references: ['https://a/1.jpg'] });
    expect(getReel(id)).toMatchObject({ status: 'draft', stage: 'done' });
  });

  it('scenes are rows, each with its own status, replaced as a set', () => {
    const reelId = reel(seed());
    replaceScenes(reelId, [
      { seconds: 10, presenter: true, sources: ['hero'], imagePrompt: '', motionPrompt: 'pour', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['stepA'], imagePrompt: '', motionPrompt: 'lift', line: '' },
    ]);
    const scenes = listScenes(reelId);
    expect(scenes.map((s) => s.position)).toEqual([1, 2]);
    expect(scenes[0]).toMatchObject({ presenter: 1, status: 'pending', sources_json: '["hero"]' });

    updateScene(scenes[1]!.id, { status: 'failed', error: 'no credits' });
    expect(listScenes(reelId)[1]).toMatchObject({ status: 'failed', error: 'no credits' });

    replaceScenes(reelId, [
      { seconds: 10, presenter: false, sources: ['pin'], imagePrompt: '', motionPrompt: 'x', line: '' },
    ]);
    expect(listScenes(reelId)).toHaveLength(1);
  });

  it('remembers the last formats a page used, newest first', () => {
    const ids = seed();
    for (const format of ['reveal', 'myth', 'pov']) {
      setReelStage(reel(ids), 'done', { format });
    }
    expect(recentFormatsForPage(ids.pageId, 2)).toEqual(['pov', 'myth']);
  });
});
