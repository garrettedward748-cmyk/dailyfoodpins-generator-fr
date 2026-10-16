import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageClient } from '../integrations/images.js';
import {
  getSite,
  listScenes,
  presenterForPage,
  setReelStage,
  updateScene,
  type ReelSceneRow,
  type ReelView,
} from '../db/repos.js';
import { resolveProjectId } from '../core/project-id.js';
import type { Settings } from '../settings.js';
import { clipPrompt, type ReelSeed } from './compose.js';
import { processClipPrompt, type ProcessPlan, type SourceRole } from './plan.js';
import { lastFrame as ffmpegLastFrame } from './assemble.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('reel-film');

/** A process shot whose frame Flow would not take: filmed from the photos. */
export const NO_FRAME = 'none';

const TERMINAL_FAILURES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export interface FilmDeps {
  images: Pick<ImageClient, 'submitVideo' | 'poll'>;
  download(url: string): Promise<Buffer>;
  /** Where clips land: one folder per reel under it. */
  clipsDir: string;
  /** Process reels: put a frame on the site so any Google account can fetch it. */
  uploadImage?(siteId: number, data: Buffer, contentType: string, name?: string): Promise<string>;
  /** Process reels: the last frame of a clip. ffmpeg, in production. */
  lastFrame?(clipPath: string): Promise<Buffer>;
}

/**
 * Film every scene that is not filmed yet, one clip each, and say whether
 * the reel is still working or done.
 *
 * Called once per tick. Scenes are submitted in order, then polled; a scene
 * that comes back finished is downloaded next to the reel. A scene that
 * fails is marked with why and the stage stops -- Retry on the reel page
 * clears it and the next tick picks it up again. Scenes already done are
 * never touched, which is what makes a retry cost one clip, not the reel.
 */
export async function filmPending(
  reel: ReelView,
  deps: FilmDeps,
  settings: Settings,
): Promise<'working' | 'done'> {
  const seed = JSON.parse(reel.plan_json || '{}') as Partial<ReelSeed>;
  const sources = seed.sources ?? {};
  const presenter = reel.fb_page_id ? presenterForPage(reel.fb_page_id) : undefined;
  const site = reel.site_id ? getSite(reel.site_id) : undefined;
  const project = resolveProjectId(
    site?.project_id ?? '',
    settings.get('flow_project_id'),
    site?.domain ?? '',
  );

  const seedPlan = seed as Partial<ReelSeed> & { processPlan?: ProcessPlan; frameRetries?: Record<number, number> };
  const processPlan = seedPlan.processPlan;
  const scenes = listScenes(reel.id);

  for (const scene of scenes) {
    if (scene.status === 'done') continue;

    // Process reels are filmed in a chain: from the third shot on, each clip
    // starts from the last frame of the one before, uploaded to the site.
    // Everything the next clip needs -- that frame, the article's photo, the
    // same set description -- is a public url or plain words, so when Flow
    // moves to another Google account the chain carries on unchanged.
    if (processPlan && scene.status === 'pending' && scene.position >= 3) {
      const before = scenes.find((s) => s.position === scene.position - 1);
      if (!before || before.status !== 'done' || !before.clip_path) break; // wait for it
      if (!scene.image_url && deps.uploadImage && reel.site_id) {
        try {
          const frame = await (deps.lastFrame ?? ffmpegLastFrame)(before.clip_path);
          const url = await deps.uploadImage(reel.site_id, frame, 'image/jpeg', reel.run_title || reel.seed_keyword || '');
          updateScene(scene.id, { imageUrl: url });
          scene.image_url = url;
        } catch (err) {
          log.warn(`reel ${reel.id}: no frame from shot ${before.position}, filming shot ${scene.position} from the photos — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (scene.status === 'failed') {
      throw new Error(`Scene ${scene.position} failed: ${scene.error ?? 'no detail'}`);
    }

    // NO_FRAME: Flow refused the frame once; this shot goes on from the photos.
    const frame = scene.image_url && scene.image_url !== NO_FRAME ? scene.image_url : null;

    if (scene.status === 'pending' && processPlan) {
      const photos = (JSON.parse(scene.sources_json) as SourceRole[])
        .map((role) => sources[role])
        .filter((u): u is string => Boolean(u));
      // A chained shot goes from the frame alone: with the article's photo
      // beside it Flow blends the two and the kitchen drifts.
      const urls = frame ? [frame] : photos.slice(0, 3);
      if (urls.length === 0) fail(scene, 'none of the images this shot was planned from exist');
      const jobId = await deps.images.submitVideo({
        prompt: processClipPrompt(processPlan, scene.position - 1, seed.article?.title ?? 'the dish', Boolean(frame)),
        referenceUrls: urls,
        projectId: project.projectId,
      });
      updateScene(scene.id, { status: 'working', clipJobId: jobId, error: null });
      log.info(`reel ${reel.id}: shot ${scene.position} queued as ${jobId}${frame ? ' (from the last frame)' : ''}`);
      continue;
    }

    if (scene.status === 'pending') {
      // A fresh image made for this scene outranks the article's; either
      // way the clip is filmed from what the scene names.
      const urls = scene.image_url
        ? [scene.image_url]
        : (JSON.parse(scene.sources_json) as SourceRole[])
            .map((role) => sources[role])
            .filter((u): u is string => Boolean(u));
      if (urls.length === 0) {
        fail(scene, 'none of the images this scene was planned from exist');
      }

      // The character is an ingredient only when the scene puts them on
      // screen. The voice rides along with every spoken line, on screen or
      // not: a line without the voice asset is read by whoever Flow picks,
      // and that is a different voice in every clip.
      const onScreen = scene.presenter === 1 && Boolean(presenter);
      const speaks = Boolean(presenter) && scene.line.trim() !== '';
      const jobId = await deps.images.submitVideo({
        prompt: clipPrompt(
          { motion: scene.motion_prompt, line: scene.line, onScreen },
          presenter && (onScreen || speaks)
            ? { name: presenter.name, voice: presenter.voice_description }
            : null,
          seed.article?.title ?? '',
        ),
        referenceUrls: urls,
        characterMediaId: onScreen ? presenter!.flow_character_id || undefined : undefined,
        voiceMediaId: speaks ? presenter!.flow_voice_id || undefined : undefined,
        projectId: project.projectId,
      });
      updateScene(scene.id, { status: 'working', clipJobId: jobId, error: null });
      log.info(`reel ${reel.id}: scene ${scene.position} queued as ${jobId}`);
      continue;
    }

    // working: see whether it finished.
    const job = await deps.images.poll(scene.clip_job_id!);
    const status = (job.status ?? '').toUpperCase();
    if (status === 'COMPLETED' && job.image_url) {
      const dir = join(deps.clipsDir, String(reel.id));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `scene-${scene.position}.mp4`);
      writeFileSync(path, await deps.download(job.image_url));
      updateScene(scene.id, { status: 'done', clipPath: path, error: null });
      log.info(`reel ${reel.id}: scene ${scene.position} filmed`);
    } else if (TERMINAL_FAILURES.has(status)) {
      const why = job.error ?? `the clip job ended ${status}`;
      // Flow sometimes refuses to take the frame as a reference. The shot is
      // not lost over it: it is filmed again from the article's photos, with
      // the same kitchen description, instead of failing the reel.
      // The first refusal is usually the account, not the frame (it comes right
      // after Flow moves to another Google account), so the frame gets one more try.
      if (processPlan && frame && /uploading a reference failed/i.test(why)) {
        const tries = { ...(seedPlan.frameRetries ?? {}) };
        const again = (tries[scene.position] ?? 0) < 1;
        tries[scene.position] = (tries[scene.position] ?? 0) + 1;
        seedPlan.frameRetries = tries;
        setReelStage(reel.id, 'filming', { planJson: JSON.stringify(seedPlan) });
        log.warn(
          `reel ${reel.id}: Flow refused the frame for shot ${scene.position}, ` +
            `${again ? 'trying the frame once more' : 'filming it from the photos'} — ${why}`,
        );
        updateScene(scene.id, { status: 'pending', clipJobId: null, imageUrl: again ? frame : NO_FRAME, error: null });
        continue;
      }
      fail(scene, why);
    }
  }

  return listScenes(reel.id).every((s) => s.status === 'done') ? 'done' : 'working';
}

function fail(scene: ReelSceneRow, why: string): never {
  updateScene(scene.id, { status: 'failed', error: why });
  throw new Error(`Scene ${scene.position} failed: ${why}`);
}
