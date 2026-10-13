# Reel Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published article becomes a 15–60 s multi-scene reel — storyboard written per recipe, clips filmed by Flow with the page's presenter composed in, assembled with ffmpeg, published to the page — with the presenter created once per installation.

**Architecture:** The existing reel engine (`src/reels/engine.ts`, one stage per minute-tick) grows from "generate → publish" into `planning → imaging → filming → assembling → ready → publishing`, with a `reel_scenes` table holding one row per scene so each stage does only what is not done and a failed scene is retried alone. The image service gains the captured *ingredients-to-video* request (`MZZa6b` / `abra_r2v_10s`) that carries images, a voice and a character in three separate reference slots; the platform gains presenters (a Flow character + a Flow voice + a voice description), formats, a plan prompt with a validator, and ffmpeg assembly.

**Tech Stack:** TypeScript / Fastify / `node:sqlite` / vitest (platform); Python / FastAPI / pytest (image service); ffmpeg (assembly); Google Flow via the Chrome extension.

## Global Constraints

- Branch `ui`. Spec: `docs/superpowers/specs/2026-09-16-reel-studio-design.md`.
- Migrations never drop tables. `reels.status` keeps its CHECK set (`draft, generating, ready, publishing, published, failed`); the new in-flight stages live in a new `stage` column, and `status = 'generating'` means "a stage is in progress".
- Clip length is 10 s (`abra_r2v_10s`). Default reel length 30 s = 3 scenes. 2–6 scenes.
- Nothing is provisional: no fallback modes, no "until captured" branches. One request shape for clips.
- Every user-facing text says what it does and when to change it, never how it works inside.
- Commit messages: one plain sentence, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests: platform `npx vitest run <file>`, typecheck `npx tsc --noEmit`; image service `cd services/imagegen && PYTHONPATH=. .venv/Scripts/python -m pytest -q` (Windows) / `.venv/bin/python` (Linux).
- Everything reaches a page only behind the existing `fb_enabled` switch.

## No open input

Every request the studio sends was captured on 2026-09-16. A presenter's
character and voice ids are read by the operator off Flow's address bar
(`/project/<project>/character/<id>` and the voice's own page), which is what
Task 8 asks for -- two pasted ids, each with a sentence saying where to find it.

---

## File structure

**Image service (`services/imagegen/`)**
- `agent/services/flow_batch.py` — add `RPC_GEN_REEL`, `REEL_MODEL`, `reel_request()`.
- `agent/services/flow_client.py` — add `generate_reel_batch()`; `generate_video_batch()` and its i2v model walk are removed.
- `agent/db/jobs.py`, `agent/db/schema.py` — `job.character_media_id`.
- `agent/api/v1.py` — `GenerateVideoRequest.character_media_id`, `reference_urls` max 3.
- `agent/worker/processor.py` — `_run_video_batch` uploads every reference and sends the reel request.
- `tests/test_reel_request_shape.py` (new), `tests/test_video_batch.py`, `tests/test_worker.py`.

**Platform (`src/`)**
- `db/migrations.ts` — migration `011-reel-studio`.
- `db/repos.ts` — presenters, reel scenes, reel stage helpers.
- `reels/formats.ts` (new) — the thirteen formats and the rotation.
- `reels/plan.ts` (new) — plan type, validator, `planReel()`.
- `reels/film.ts` (new) — the filming stage: one clip per scene.
- `reels/assemble.ts` (new) — ffmpeg normalise + concat + CTA.
- `reels/engine.ts` — stages wired into `advance()`.
- `reels/compose.ts` — `sourceUrls()` replaces `referenceUrls()`; `clipPrompt()`.
- `pipeline/steps/reel.ts` — creates a reel in `planning`.
- `integrations/images.ts` — `submitVideo` takes `characterMediaId`.
- `web/views/reel-detail.ts` — the storyboard.
- `web/views/pages.ts`, `web/server.ts`, `web/views/layout.ts` — Setup → Presenters, Setup → Reels, page presenter select, Home notice.
- `settings.ts` — `reel_length_seconds`, `reel_formats`, `reel_fresh_images`, `reel_cta_text`.
- `prompts/reel-plan.system.txt`, `prompts/reel-plan.user.txt`, `prompts/index.json`, `pipeline/prompt-contexts.ts`.
- `Dockerfile` — `ffmpeg`.

---

### Task 1: The reel request on the image service

**Files:**
- Modify: `services/imagegen/agent/services/flow_batch.py`
- Modify: `services/imagegen/agent/services/flow_client.py`
- Create: `services/imagegen/tests/test_reel_request_shape.py`

**Interfaces:**
- Produces: `flow_batch.reel_request(prompt: str, project_id: str, image_media_ids: list[str], character_media_id: str | None, aspect) -> str` (an `f.req` string); `FlowClient.generate_reel_batch(prompt, project_id, image_media_ids, character_media_id=None, aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT") -> dict` answering `{"operation_id", "project_id"}` or `{"error"}`.

- [ ] **Step 1: Write the failing test that pins the captured shape**

```python
"""The ingredients-to-video request, pinned to the captures of 2026-09-16.

Flow's UI sent this when a character, a voice and a dish image were handed
over as ingredients with a spoken line in the prompt:

  rpcid MZZa6b, model abra_r2v_10s, aspect 1 (portrait),
  slot 1  [[null, <image media id>, null, null, null, <full-frame crop>]]  the images
  slot 7  [[<voice media id>]]                                             the voice
  slot 9  [[<character media id>]]                                         the character

Three separate slots. Everything here is what makes a clip carry the
presenter and their voice. Drift is not a failure Google reports; it is a
clip with nobody in it.
"""
import json

import pytest

from agent.services import flow_batch as fb

PROMPT = 'She lifts the spoon and says: "Full recipe in the comments."'
PROJECT = "559dd649-1000-4947-aaa5-e08ae6515705"
CHARACTER = "f346cb5a-ec29-4143-a87d-b13d70729bf5"
VOICE = "509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"
IMAGE = "1e9401b2-f0f5-40a2-a7db-a559744bdfe7"


def inner_of(freq: str):
    outer = json.loads(freq)
    assert outer[0][0][0] == fb.RPC_GEN_REEL
    return json.loads(outer[0][0][1])


def test_the_reel_rpc_is_the_one_the_ui_sends():
    assert fb.RPC_GEN_REEL == "MZZa6b"
    assert fb.REEL_MODEL == "abra_r2v_10s"


def test_the_request_matches_the_capture_slot_for_slot():
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE], CHARACTER, VOICE,
                                     aspect="VIDEO_ASPECT_RATIO_PORTRAIT"))
    item = inner[0][0]
    assert item[0] == [None, None, [[[PROMPT]]]]
    assert item[1] == [[None, IMAGE, None, None, None, fb.REEL_IMAGE_CROP]]
    assert item[2] == "abra_r2v_10s"
    assert item[3] == fb.VIDEO_ASPECT_PORTRAIT == 1
    assert item[4] is None
    assert item[5][:4] == [None, None, None, None]
    assert all(len(u) == 36 and u == u.upper() for u in item[5][4:6])
    assert item[6] is None
    assert item[7] == [[VOICE]]
    assert item[8] is None
    assert item[9] == [[CHARACTER]]
    assert inner[1][5] == PROJECT
    assert inner[1][10] == [fb.CAPTCHA_SLOT, 1]
    assert inner[2][1] == 2


def test_the_crop_is_the_full_frame_the_ui_sends():
    assert fb.REEL_IMAGE_CROP == [0.003875968992248069, None, 0.9961240310077519, 1]


def test_several_images_each_take_their_own_entry():
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE, "b" * 36], CHARACTER, VOICE))
    assert [e[1] for e in inner[0][0][1]] == [IMAGE, "b" * 36]


def test_no_presenter_leaves_both_slots_null_not_missing():
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE], None, None))
    item = inner[0][0]
    assert item[7] is None and item[9] is None
    assert len(item) == 10


def test_a_request_needs_at_least_one_image():
    with pytest.raises(ValueError):
        fb.reel_request(PROMPT, PROJECT, [], CHARACTER, VOICE)
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd services/imagegen && PYTHONPATH=. .venv/Scripts/python -m pytest tests/test_reel_request_shape.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'RPC_GEN_REEL'`.

- [ ] **Step 3: Add the builder to `flow_batch.py`**

After `RPC_GEN_VIDEO = "eb1hJf"` add:

```python
#: Ingredients to video: the scene's images, the presenter's voice, and the
#: presenter, each in its own reference slot, and the model that composes
#: them. Captured 2026-09-16 from the Flow UI; see
#: tests/test_reel_request_shape.py.
RPC_GEN_REEL = "MZZa6b"
REEL_MODEL = "abra_r2v_10s"

#: The crop box the UI puts on every ingredient image when nothing was
#: reframed by hand. Not the same arrangement as FULL_FRAME_CROP, which is
#: what image-to-video sends; the ingredient slot has its own.
REEL_IMAGE_CROP = [0.003875968992248069, None, 0.9961240310077519, 1]
```

After `video_request()` add:

```python
def reel_request(prompt: str, project_id: str, image_media_ids: list[str],
                 character_media_id: Optional[str] = None,
                 voice_media_id: Optional[str] = None,
                 aspect: Any = VIDEO_ASPECT_PORTRAIT) -> str:
    """One clip from ingredients: the scene's images and, when there is one,
    the presenter and their voice.

    Slot for slot what the UI sends. Images sit in slot 1, each with the
    full-frame crop; the voice in slot 7; the character in slot 9. A clip
    with no presenter sends None in 7 and 9 rather than leaving them out,
    because the slot count is part of the shape.
    """
    if not image_media_ids:
        raise ValueError("a reel clip needs at least one image")
    item = [
        [None, None, [[[prompt]]]],
        [[None, mid, None, None, None, REEL_IMAGE_CROP] for mid in image_media_ids],
        REEL_MODEL,
        resolve_video_aspect(aspect),
        None,
        [None, None, None, None, _client_uuid(), _client_uuid()],
        None,
        [[voice_media_id]] if voice_media_id else None,
        None,
        [[character_media_id]] if character_media_id else None,
    ]
    inner = [[item], _context(project_id), [_client_uuid(), 2]]
    return build_envelope(RPC_GEN_REEL, inner)
```

- [ ] **Step 4: Add the client call to `flow_client.py`**

Replace `generate_video_batch` (the whole method) with:

```python
    async def generate_reel_batch(self, prompt: str, project_id: str,
                                  image_media_ids: list[str],
                                  character_media_id: str | None = None,
                                  voice_media_id: str | None = None,
                                  aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT") -> dict:
        """Submit one clip from ingredients. Returns {"operation_id": ...}.

        The one way a reel clip is made. The images are uploaded media ids
        from this project; the character and voice are the presenter's, read
        from the project's assets. See flow_batch.reel_request for the shape.
        """
        freq = fb.reel_request(prompt, project_id, image_media_ids,
                               character_media_id, voice_media_id, aspect=aspect_ratio)
        out = await self._batch_payload(
            fb.RPC_GEN_REEL, freq, fb.CAPTCHA_VIDEO, timeout=180, project_id=project_id)
        if "error" in out:
            return out
        try:
            operation = fb.read_operation(out["payload"])
        except Exception as e:
            return {"error": f"submit gave no operation: {type(e).__name__}: {e}"}
        return {
            "operation_id": operation.operation_id,
            "project_id": operation.project_id or project_id,
        }
```

- [ ] **Step 5: Run the new test and the batch tests**

Run: `PYTHONPATH=. .venv/Scripts/python -m pytest tests/test_reel_request_shape.py tests/test_video_batch.py -q`
Expected: the new file PASSES; `test_video_batch.py` FAILS where it calls `generate_video_batch` — fixed in Task 2.

- [ ] **Step 6: Commit**

```bash
git add services/imagegen/agent/services/flow_batch.py services/imagegen/agent/services/flow_client.py services/imagegen/tests/test_reel_request_shape.py
git commit -m "Send a reel clip the way Flow takes ingredients, with the presenter in its own slot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The worker films from ingredients

**Files:**
- Modify: `services/imagegen/agent/db/schema.py` (the `ADDED_COLUMNS` list), `services/imagegen/agent/db/jobs.py`
- Modify: `services/imagegen/agent/api/v1.py`
- Modify: `services/imagegen/agent/worker/processor.py` (`_run_video_batch`)
- Modify: `services/imagegen/tests/test_video_batch.py`, `services/imagegen/tests/test_worker.py`, `services/imagegen/tests/test_jobs.py`

**Interfaces:**
- Consumes: `FlowClient.generate_reel_batch(...)` from Task 1.
- Produces: `POST /v1/generate-video` body `{prompt, reference_urls (1–3), character_media_id?, voice_media_id?, orientation?, project_id?}`; `jobs.create_video(prompt, reference_urls, project_id, orientation, character_media_id, voice_media_id)`; the job row carries both ids.

- [ ] **Step 1: Failing tests**

In `tests/test_jobs.py` add:

```python
def test_a_video_job_keeps_the_presenter_it_was_asked_for(fresh_db):
    job = asyncio.run(jobs.create_video("soup", ["https://a/1.jpg"], "P", "VERTICAL",
                                        character_media_id="f346cb5a-ec29-4143-a87d-b13d70729bf5",
                                        voice_media_id="509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"))
    assert job["character_media_id"] == "f346cb5a-ec29-4143-a87d-b13d70729bf5"
    assert job["voice_media_id"] == "509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"
    plain = asyncio.run(jobs.create_video("soup", ["https://a/1.jpg"], "P", "VERTICAL"))
    assert plain["character_media_id"] is None and plain["voice_media_id"] is None
```

In `tests/test_video_batch.py` replace every use of `generate_video_batch` with `generate_reel_batch` and add:

```python
def test_a_clip_goes_out_as_the_reel_rpc_with_its_ingredients():
    client, sent = client_with({"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, ["operations/op-1"]])})

    asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["img-1", "img-2"], "char-1", "voice-1"))

    assert sent["ws_method"] == "batch_rpc"
    assert sent["rpcid"] == fb.RPC_GEN_REEL
    assert sent["captchaAction"] == fb.CAPTCHA_VIDEO
    inner = json.loads(json.loads(sent["freq"])[0][0][1])
    assert [e[1] for e in inner[0][0][1]] == ["img-1", "img-2"]
    assert inner[0][0][7] == [["voice-1"]]
    assert inner[0][0][9] == [["char-1"]]
```

In `tests/test_worker.py`, in the video section, add a test that drives `_run_video_batch` with a fake client and asserts every reference is uploaded and the reel request gets all the ids plus the character (model the fake on the existing video worker test in that file — it stubs `get_flow_client`, `_fetch_reference`, and `_await_video_batch`):

```python
@pytest.mark.asyncio
async def test_every_reference_is_uploaded_and_sent_with_the_presenter(monkeypatch):
    calls = {"uploaded": [], "reel": None}

    class Fake:
        connected = True
        async def upload_image_batch(self, image_base64, project_id, mime_type, file_name):
            calls["uploaded"].append(file_name)
            return {"media_id": f"m-{len(calls['uploaded'])}"}
        async def generate_reel_batch(self, prompt, project_id, image_media_ids,
                                      character_media_id=None, voice_media_id=None, aspect_ratio=""):
            calls["reel"] = dict(prompt=prompt, ids=image_media_ids, char=character_media_id, voice=voice_media_id)
            return {"operation_id": "op-1", "project_id": project_id}

    monkeypatch.setattr(processor, "get_flow_client", lambda: Fake())
    controller = processor.WorkerController()

    async def fetched(url):
        return {"bytes": b"jpg", "mime": "image/jpeg"}
    monkeypatch.setattr(controller, "_fetch_reference", fetched)
    waited = {}
    async def await_batch(job, operation_id, project):
        waited["op"] = operation_id
    monkeypatch.setattr(controller, "_await_video_batch", await_batch)

    job = await jobs.create_video("pour the sauce", ["https://a/1.jpg", "https://a/2.jpg"],
                                  "P", "VERTICAL", character_media_id="char-1", voice_media_id="voice-1")
    settled = await controller._run_video_batch(job, json.loads(job["reference_urls"]), "P")

    assert settled is True
    assert calls["uploaded"] == ["1.jpg", "2.jpg"]
    assert calls["reel"] == {"prompt": "pour the sauce", "ids": ["m-1", "m-2"], "char": "char-1", "voice": "voice-1"}
    assert waited["op"] == "op-1"
```

- [ ] **Step 2: Run them to see them fail**

Run: `PYTHONPATH=. .venv/Scripts/python -m pytest tests/test_jobs.py tests/test_video_batch.py tests/test_worker.py -q`
Expected: FAIL — `create_video() got an unexpected keyword argument 'character_media_id'`, and the worker test on `generate_reel_batch`.

- [ ] **Step 3: Schema and jobs**

`schema.py`, in the list that already holds `("job", "kind", ...)`, add:

```python
    # The presenter a clip is composed with: a character and a voice, both
    # assets in the Flow project. NULL for a clip with nobody in it, and for
    # every image job.
    ("job", "character_media_id", "TEXT"),
    ("job", "voice_media_id", "TEXT"),
```

`jobs.py`:

```python
async def create_video(
    prompt: str,
    reference_urls: list[str],
    project_id: str = "",
    orientation: str = "VERTICAL",
    character_media_id: str | None = None,
    voice_media_id: str | None = None,
) -> dict:
    """Queue one clip from reference images and, optionally, a presenter and voice."""
    job_id = str(uuid.uuid4())
    db = await get_db()
    await db.execute(
        """INSERT INTO job (id, prompt, orientation, project_id, kind, reference_urls,
                            character_media_id, voice_media_id)
                VALUES (?, ?, ?, ?, 'video', ?, ?, ?)""",
        (job_id, prompt, orientation, project_id, json.dumps(reference_urls),
         character_media_id or None, voice_media_id or None),
    )
    await db.commit()
    return await get(job_id)
```

- [ ] **Step 4: The API**

`v1.py`, `GenerateVideoRequest`:

```python
class GenerateVideoRequest(BaseModel):
    """One clip composed from images the platform already published and,
    when the page has one, its presenter.

    reference_urls are public image URLs: the service uploads each at
    generation time, so an article of any age can become a clip and no media
    id has to outlive the job. Three is what Flow takes as ingredients.
    character_media_id and voice_media_id are the presenter's character and
    voice, two assets in the Flow project.
    """

    prompt: str = Field(..., min_length=1, max_length=5000)
    reference_urls: list[str] = Field(..., min_length=1, max_length=3)
    character_media_id: Optional[str] = Field(default=None, max_length=200)
    voice_media_id: Optional[str] = Field(default=None, max_length=200)
    orientation: Literal["VERTICAL", "HORIZONTAL"] = "VERTICAL"
    project_id: Optional[str] = Field(default=None, max_length=200)
```

and in `generate_video()`:

```python
    job = await jobs.create_video(
        body.prompt, body.reference_urls, project_id, body.orientation,
        character_media_id=body.character_media_id,
        voice_media_id=body.voice_media_id,
    )
```

- [ ] **Step 5: The worker**

In `processor.py`, replace the body of `_run_video_batch` from `fetched = await self._fetch_reference(reference_urls[0])` down to (and including) the block that ends `await self._handle_failure(job, f"Video submit failed: {detail}")\n            return True` with:

```python
        # Every reference goes up: they are the clip's ingredients, and Flow
        # composes from all of them.
        media_ids: list[str] = []
        for url in reference_urls[:3]:
            fetched = await self._fetch_reference(url)
            if "error" in fetched:
                await self._handle_failure(job, fetched["error"])
                return True
            uploaded = await client.upload_image_batch(
                image_base64=base64.b64encode(fetched["bytes"]).decode("ascii"),
                project_id=project_id,
                mime_type=fetched["mime"],
                file_name=url.rsplit("/", 1)[-1][:100] or "reference.jpg",
            )
            if uploaded.get("error"):
                await self._handle_failure(job, f"Uploading a reference failed: {uploaded['error']}")
                return True
            media_ids.append(uploaded["media_id"])

        submitted = await client.generate_reel_batch(
            prompt=job["prompt"],
            project_id=project_id,
            image_media_ids=media_ids,
            character_media_id=job.get("character_media_id") or None,
            voice_media_id=job.get("voice_media_id") or None,
            aspect_ratio=aspect,
        )

        if submitted.get("error"):
            detail = submitted["error"]
            if video_models.out_of_credits(detail):
                message = ("This Google account has no video credits left on Flow. "
                           "Nothing was generated. Wait for the credits to reset "
                           "or add more, then run the reel again.")
                logger.error("job %s FAILED: %s", job_id[:8], message)
                await jobs.fail(job_id, message)
                return True
            await self._handle_failure(job, f"Clip submit failed: {detail}")
            return True
```

Delete `video_models.batch_plan`, `remember_batch`, `forget_batch`, `BATCH_CANDIDATES` and their tests if nothing else uses them (grep first: `grep -rn "batch_plan\|BATCH_CANDIDATES" agent tests`).

- [ ] **Step 6: Run the whole image-service suite**

Run: `PYTHONPATH=. .venv/Scripts/python -m pytest -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add services/imagegen
git commit -m "Film a clip from every reference and the presenter, on the one path Flow uses

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Platform data — presenters, scenes, stages

**Files:**
- Modify: `src/db/migrations.ts` (append migration `011-reel-studio`), `src/db/schema.sql` (document the new tables beside `reels`)
- Modify: `src/db/repos.ts`
- Create: `test/reel-studio-data.test.ts`

**Interfaces (produces):**
```ts
export interface PresenterRow { id; name; flow_character_id: string; flow_voice_id: string; voice_description: string; portrait_url: string; created_at }
insertPresenter(input: { name; flowCharacterId; flowVoiceId; voiceDescription; portraitUrl }): number
updatePresenter(id, fields: Partial<{ name; voiceDescription; portraitUrl }>): void
deletePresenter(id): void
listPresenters(): PresenterRow[]
getPresenter(id): PresenterRow | undefined
setFbPagePresenter(pageRowId: number, presenterId: number | null): void   // FbPageRow gains presenter_id
presenterForPage(pageRowId: number): PresenterRow | undefined

export type ReelStage = 'planning' | 'imaging' | 'filming' | 'assembling' | 'done'
export interface ReelSceneRow { id; reel_id; position; seconds; presenter: 0|1; sources_json; image_prompt; motion_prompt; line;
                               image_job_id; image_url; clip_job_id; clip_path; status: 'pending'|'working'|'done'|'failed'; error }
replaceScenes(reelId, scenes: Array<{ seconds; presenter: boolean; sources: string[]; imagePrompt: string; motionPrompt: string; line: string }>): void
listScenes(reelId): ReelSceneRow[]
updateScene(id, fields: Partial<{ status; error; imageJobId; imageUrl; clipJobId; clipPath }>): void
setReelStage(reelId, stage: ReelStage, fields?: Partial<{ planJson: string; format: string; outputPath: string }>): void
recentFormatsForPage(pageRowId, limit = 4): string[]
// ReelView gains: stage, plan_json, format, output_path; createReel() gains optional { stage }
```

- [ ] **Step 1: Failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel, getReel, insertFbToken, insertKeyword, insertPresenter, listPresenters,
  listScenes, presenterForPage, recentFormatsForPage, replaceScenes, setFbPagePresenter,
  setReelStage, updateScene, upsertFbPage, upsertSite, deletePresenter, getFbPage,
} from '../src/db/repos.js';

const KEY = randomBytes(32);

describe('reel studio data', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  const seed = () => {
    const siteId = upsertSite({ name: 'a', domain: 'a.com', status: 'active', pin_username: '',
      project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const tokenId = insertFbToken('App', 'tok', KEY);
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId });
    return { siteId, keywordId, pageId };
  };

  it('a presenter is a character in the project plus how they sound', () => {
    const id = insertPresenter({ name: 'Rima', flowCharacterId: 'char-1', flowVoiceId: 'voice-1',
      voiceDescription: 'warm, unhurried', portraitUrl: 'https://x/p.jpg' });
    expect(listPresenters()[0]).toMatchObject({ id, name: 'Rima', flow_character_id: 'char-1', flow_voice_id: 'voice-1' });
  });

  it('a page picks one presenter, and losing the presenter leaves the page without one', () => {
    const { pageId } = seed();
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'c', flowVoiceId: 'v', voiceDescription: '', portraitUrl: '' });
    setFbPagePresenter(pageId, presenterId);
    expect(presenterForPage(pageId)?.name).toBe('Rima');
    deletePresenter(presenterId);
    expect(getFbPage(pageId)?.presenter_id).toBeNull();
    expect(presenterForPage(pageId)).toBeUndefined();
  });

  it('a reel starts in planning and moves stage by stage, keeping its plan', () => {
    const { siteId, keywordId, pageId } = seed();
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '', caption: 'c', references: [], stage: 'planning' });
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'planning' });
    setReelStage(reelId, 'filming', { planJson: '{"scenes":[]}', format: 'reveal' });
    expect(getReel(reelId)).toMatchObject({ stage: 'filming', format: 'reveal', plan_json: '{"scenes":[]}' });
  });

  it('scenes are rows, each with its own status, replaced as a set', () => {
    const { siteId, keywordId, pageId } = seed();
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '', caption: 'c', references: [], stage: 'planning' });
    replaceScenes(reelId, [
      { seconds: 10, presenter: true, sources: ['feature'], imagePrompt: '', motionPrompt: 'pour', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['topShot'], imagePrompt: '', motionPrompt: 'lift', line: '' },
    ]);
    const scenes = listScenes(reelId);
    expect(scenes.map((s) => s.position)).toEqual([1, 2]);
    expect(scenes[0]).toMatchObject({ presenter: 1, status: 'pending', sources_json: '["feature"]' });
    updateScene(scenes[1]!.id, { status: 'failed', error: 'no credits' });
    expect(listScenes(reelId)[1]).toMatchObject({ status: 'failed', error: 'no credits' });
    replaceScenes(reelId, [{ seconds: 10, presenter: false, sources: ['pin'], imagePrompt: '', motionPrompt: 'x', line: '' }]);
    expect(listScenes(reelId)).toHaveLength(1);
  });

  it('remembers the last formats a page used, newest first', () => {
    const { siteId, keywordId, pageId } = seed();
    for (const format of ['reveal', 'myth', 'pov']) {
      const id = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '', caption: '', references: [], stage: 'planning' });
      setReelStage(id, 'done', { format });
    }
    expect(recentFormatsForPage(pageId, 2)).toEqual(['pov', 'myth']);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/reel-studio-data.test.ts`
Expected: FAIL — `insertPresenter is not a function` / `no such table: presenters`.

- [ ] **Step 3: The migration**

Append to `MIGRATIONS` in `src/db/migrations.ts`:

```ts
  {
    id: '011-reel-studio',
    description: 'Presenters, reel scenes, and the stage a reel is at',
    up(db) {
      // A presenter is a character and a voice that live in the Flow project
      // as two assets -- that is where both are made and kept. What the
      // platform adds is the pairing, the name the operator knows them by,
      // and how the delivery should sound, in words the clip prompt repeats.
      db.exec(`
        CREATE TABLE IF NOT EXISTS presenters (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT    NOT NULL,
          flow_character_id TEXT    NOT NULL,
          flow_voice_id     TEXT    NOT NULL DEFAULT '',
          voice_description TEXT    NOT NULL DEFAULT '',
          portrait_url      TEXT    NOT NULL DEFAULT '',
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'fb_pages', 'presenter_id', 'INTEGER REFERENCES presenters (id) ON DELETE SET NULL');

      // The stage an in-flight reel is at. status stays as it was ('generating'
      // covers every stage) because its CHECK cannot be widened without
      // rebuilding the table; the stage says which of the five it is on.
      addColumn(db, 'reels', 'stage', "TEXT NOT NULL DEFAULT 'done'");
      addColumn(db, 'reels', 'plan_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'format', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'output_path', "TEXT NOT NULL DEFAULT ''");

      // One row per scene: what to film it from, what happens, what is said,
      // and how far it got. A scene that fails is retried alone.
      db.exec(`
        CREATE TABLE IF NOT EXISTS reel_scenes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          reel_id       INTEGER NOT NULL REFERENCES reels (id) ON DELETE CASCADE,
          position      INTEGER NOT NULL,
          seconds       INTEGER NOT NULL DEFAULT 10,
          presenter     INTEGER NOT NULL DEFAULT 0 CHECK (presenter IN (0, 1)),
          sources_json  TEXT    NOT NULL DEFAULT '[]',
          image_prompt  TEXT    NOT NULL DEFAULT '',
          motion_prompt TEXT    NOT NULL DEFAULT '',
          line          TEXT    NOT NULL DEFAULT '',
          image_job_id  TEXT,
          image_url     TEXT,
          clip_job_id   TEXT,
          clip_path     TEXT,
          status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'working', 'done', 'failed')),
          error         TEXT,
          UNIQUE (reel_id, position)
        );
      `);
    },
  },
```

Also add the two `CREATE TABLE IF NOT EXISTS` blocks (presenters, reel_scenes) to `src/db/schema.sql` next to the reels tables, with the same comments, so a fresh database and a migrated one agree. Do **not** add the `fb_pages.presenter_id` or `reels.*` columns to `schema.sql`'s CREATE TABLE statements — those come only from the migration, per the rule in `schema.sql`'s header.

- [ ] **Step 4: The repos**

In `src/db/repos.ts`, add `presenter_id: number | null;` to `FbPageRow`. Add `stage`, `plan_json`, `format`, `output_path` to `ReelRow`. Add to `createReel`'s input `stage?: ReelStage` and, in its INSERT, `stage` = `input.stage ?? 'done'` with `status` = `input.stage ? 'generating' : 'draft'`; `runId` becomes `number | null`. Then append:

```ts
/* -- Presenters ------------------------------------------------------------ */

export interface PresenterRow {
  id: number;
  name: string;
  flow_character_id: string;
  flow_voice_id: string;
  voice_description: string;
  portrait_url: string;
  created_at: string;
}

export const listPresenters = (): PresenterRow[] =>
  all<PresenterRow>('SELECT * FROM presenters ORDER BY name');

export const getPresenter = (id: number): PresenterRow | undefined =>
  get<PresenterRow>('SELECT * FROM presenters WHERE id = ?', id);

export function insertPresenter(input: {
  name: string;
  flowCharacterId: string;
  flowVoiceId: string;
  voiceDescription: string;
  portraitUrl: string;
}): number {
  const name = input.name.trim();
  if (!name) throw new Error('A presenter needs a name.');
  if (!input.flowCharacterId.trim()) throw new Error('A presenter needs a character.');
  return Number(
    run(
      `INSERT INTO presenters (name, flow_character_id, flow_voice_id, voice_description, portrait_url)
       VALUES (?, ?, ?, ?, ?)`,
      name,
      input.flowCharacterId.trim(),
      input.flowVoiceId.trim(),
      input.voiceDescription.trim(),
      input.portraitUrl.trim(),
    ).lastInsertRowid,
  );
}

export function updatePresenter(
  id: number,
  fields: Partial<{ name: string; voiceDescription: string; portraitUrl: string }>,
): void {
  if (fields.name !== undefined) run('UPDATE presenters SET name = ? WHERE id = ?', fields.name.trim(), id);
  if (fields.voiceDescription !== undefined)
    run('UPDATE presenters SET voice_description = ? WHERE id = ?', fields.voiceDescription.trim(), id);
  if (fields.portraitUrl !== undefined)
    run('UPDATE presenters SET portrait_url = ? WHERE id = ?', fields.portraitUrl.trim(), id);
}

/** ALTER-added foreign keys are not enforced by SQLite, so the pages are cleared here. */
export function deletePresenter(id: number): void {
  run('UPDATE fb_pages SET presenter_id = NULL WHERE presenter_id = ?', id);
  run('DELETE FROM presenters WHERE id = ?', id);
}

export const setFbPagePresenter = (pageRowId: number, presenterId: number | null): void => {
  run('UPDATE fb_pages SET presenter_id = ? WHERE id = ?', presenterId, pageRowId);
};

export const presenterForPage = (pageRowId: number): PresenterRow | undefined =>
  get<PresenterRow>(
    `SELECT p.* FROM presenters p JOIN fb_pages f ON f.presenter_id = p.id WHERE f.id = ?`,
    pageRowId,
  );

/* -- Reel stages and scenes ------------------------------------------------ */

export type ReelStage = 'planning' | 'imaging' | 'filming' | 'assembling' | 'done';

export function setReelStage(
  reelId: number,
  stage: ReelStage,
  fields: Partial<{ planJson: string; format: string; outputPath: string }> = {},
): void {
  run(
    `UPDATE reels SET stage = ?, updated_at = datetime('now'),
       plan_json   = COALESCE(?, plan_json),
       format      = COALESCE(?, format),
       output_path = COALESCE(?, output_path)
     WHERE id = ?`,
    stage,
    fields.planJson ?? null,
    fields.format ?? null,
    fields.outputPath ?? null,
    reelId,
  );
}

export interface ReelSceneRow {
  id: number;
  reel_id: number;
  position: number;
  seconds: number;
  presenter: 0 | 1;
  sources_json: string;
  image_prompt: string;
  motion_prompt: string;
  line: string;
  image_job_id: string | null;
  image_url: string | null;
  clip_job_id: string | null;
  clip_path: string | null;
  status: 'pending' | 'working' | 'done' | 'failed';
  error: string | null;
}

export const listScenes = (reelId: number): ReelSceneRow[] =>
  all<ReelSceneRow>('SELECT * FROM reel_scenes WHERE reel_id = ? ORDER BY position', reelId);

export function replaceScenes(
  reelId: number,
  scenes: Array<{
    seconds: number;
    presenter: boolean;
    sources: string[];
    imagePrompt: string;
    motionPrompt: string;
    line: string;
  }>,
): void {
  run('DELETE FROM reel_scenes WHERE reel_id = ?', reelId);
  scenes.forEach((scene, index) => {
    run(
      `INSERT INTO reel_scenes
         (reel_id, position, seconds, presenter, sources_json, image_prompt, motion_prompt, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      reelId,
      index + 1,
      scene.seconds,
      scene.presenter ? 1 : 0,
      JSON.stringify(scene.sources),
      scene.imagePrompt,
      scene.motionPrompt,
      scene.line,
    );
  });
}

export function updateScene(
  id: number,
  fields: Partial<{
    status: ReelSceneRow['status'];
    error: string | null;
    imageJobId: string | null;
    imageUrl: string | null;
    clipJobId: string | null;
    clipPath: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status', error: 'error', imageJobId: 'image_job_id', imageUrl: 'image_url',
    clipJobId: 'clip_job_id', clipPath: 'clip_path',
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) {
      sets.push(`${column} = ?`);
      values.push((fields as Record<string, unknown>)[key]);
    }
  }
  if (sets.length === 0) return;
  run(`UPDATE reel_scenes SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
}

/** The formats this page's last reels used, newest first, for the rotation. */
export const recentFormatsForPage = (pageRowId: number, limit = 4): string[] =>
  all<{ format: string }>(
    `SELECT format FROM reels WHERE fb_page_id = ? AND format != ''
      ORDER BY id DESC LIMIT ?`,
    pageRowId,
    limit,
  ).map((r) => r.format);
```

- [ ] **Step 5: Run the test, the migration tests, and typecheck**

Run: `npx tsc --noEmit && npx vitest run test/reel-studio-data.test.ts test/column-migration.test.ts test/reel-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db test/reel-studio-data.test.ts
git commit -m "Give reels a stage and scenes, and pages a presenter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Formats, the plan prompt, and the validator

**Files:**
- Create: `src/reels/formats.ts`, `src/reels/plan.ts`
- Create: `prompts/reel-plan.system.txt`, `prompts/reel-plan.user.txt`
- Modify: `prompts/index.json`, `src/pipeline/prompt-contexts.ts`, `src/pipeline/prompts.ts` (`PROMPT_MODELS`, if it lists models per prompt — check `grep -n "reel-caption" src/pipeline/prompts.ts`)
- Create: `test/reel-plan.test.ts`

**Interfaces (produces):**
```ts
// formats.ts
export interface ReelFormat { key: string; title: string; shape: string; presenter: 'optional' | 'never' | 'required'; speech: boolean }
export const FORMATS: ReelFormat[]           // thirteen, in the spec's order
export function pickFormat(allowed: string[], recent: string[], random?: () => number): ReelFormat
// plan.ts
export type SourceRole = 'feature' | 'topShot' | 'textureMacro' | 'beforeAfter' | 'pin'
export interface PlannedScene { seconds: 10; sources: SourceRole[]; presenter: boolean; image: string; motion: string; line: string }
export interface ReelPlan { format: string; hook: string; scenes: PlannedScene[]; cta: string }
export function validatePlan(raw: unknown, rules: { sources: SourceRole[]; hasPresenter: boolean; targetSeconds: number; format: ReelFormat }): ReelPlan  // throws Error with a plain reason
export function scenesFor(targetSeconds: number): number   // 15→2, 30→3, 45→4, 60→6 (clip is 10 s; 45 rounds up)
export async function planReel(input: { prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>; article: { title: string; recipe: string; imagePrompts: Record<string, string> }; sources: SourceRole[]; presenter: { name: string; voice: string } | null; targetSeconds: number; format: ReelFormat }): Promise<ReelPlan>
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { FORMATS, pickFormat } from '../src/reels/formats.js';
import { planReel, scenesFor, validatePlan } from '../src/reels/plan.js';
import { loadPrompt } from '../src/pipeline/prompts.js';

const reveal = FORMATS.find((f) => f.key === 'reveal')!;
const rules = { sources: ['feature', 'topShot', 'pin'] as const, hasPresenter: true, targetSeconds: 30, format: reveal };
const scene = (over: Partial<Record<string, unknown>> = {}) => ({
  seconds: 10, sources: ['feature'], presenter: false, image: '', motion: 'a slow pour', line: '', ...over,
});

describe('formats', () => {
  it('has the thirteen shapes, and pov never has the presenter', () => {
    expect(FORMATS).toHaveLength(13);
    expect(FORMATS.find((f) => f.key === 'pov')?.presenter).toBe('never');
    expect(FORMATS.find((f) => f.key === 'asmr')?.speech).toBe(false);
  });

  it('avoids what the page used last, and never repeats when it can help it', () => {
    const allowed = FORMATS.map((f) => f.key);
    const picked = pickFormat(allowed, ['reveal', 'myth', 'pov', 'story'], () => 0);
    expect(['reveal', 'myth', 'pov', 'story']).not.toContain(picked.key);
  });

  it('falls back to any allowed format when every one was used recently', () => {
    expect(pickFormat(['reveal'], ['reveal'], () => 0).key).toBe('reveal');
  });

  it('refuses an empty allow-list', () => {
    expect(() => pickFormat([], [], () => 0)).toThrow(/no format/i);
  });
});

describe('the plan validator', () => {
  it('accepts a plan that fits the rules', () => {
    const plan = validatePlan({ format: 'reveal', hook: 'Wait for it', cta: 'Full recipe in the comments',
      scenes: [scene({ presenter: true, line: 'Here we go' }), scene({ sources: ['topShot'] }), scene({ sources: ['pin'], line: 'Full recipe in the comments' })] }, { ...rules, sources: [...rules.sources] });
    expect(plan.scenes).toHaveLength(3);
  });

  it.each([
    ['too few scenes', { scenes: [scene()] }, /2 and 6/],
    ['a source that does not exist', { scenes: [scene({ sources: ['beforeAfter'] }), scene(), scene()] }, /beforeAfter/],
    ['a line too long to say in ten seconds', { scenes: [scene({ line: 'word '.repeat(30) }), scene(), scene()] }, /22 words/],
    ['no presenter anywhere although the page has one', { scenes: [scene(), scene(), scene()] }, /presenter/],
    ['the CTA missing from the last scene', { scenes: [scene({ presenter: true, line: 'hi' }), scene(), scene({ line: 'bye' })] }, /last scene/],
    ['the wrong number of scenes for the length', { scenes: [scene({ presenter: true }), scene(), scene(), scene(), scene({ line: 'Full recipe in the comments' })] }, /30 seconds/],
  ])('rejects %s', (_label, partial, reason) => {
    expect(() => validatePlan({ format: 'reveal', hook: 'h', cta: 'Full recipe in the comments', ...partial }, { ...rules, sources: [...rules.sources] })).toThrow(reason);
  });

  it('does not require the presenter when the page has none, and forbids one for pov', () => {
    const noOne = { ...rules, sources: [...rules.sources], hasPresenter: false };
    expect(() => validatePlan({ format: 'reveal', hook: 'h', cta: 'c', scenes: [scene(), scene(), scene({ line: 'c' })] }, noOne)).not.toThrow();
    const pov = { ...noOne, format: FORMATS.find((f) => f.key === 'pov')!, hasPresenter: true };
    expect(() => validatePlan({ format: 'pov', hook: 'h', cta: 'c', scenes: [scene({ presenter: true }), scene(), scene({ line: 'c' })] }, pov)).toThrow(/pov/);
  });

  it('maps a length to a scene count', () => {
    expect([15, 30, 45, 60].map(scenesFor)).toEqual([2, 3, 4, 6]);
  });
});

describe('planning with the model', () => {
  it('renders the prompt with every placeholder filled', () => {
    const { system, user } = loadPrompt('reel-plan', {
      article: { title: 'Soup', recipe: 'boil', imagePrompts: 'feature: a bowl' },
      sources: 'feature, topShot, pin',
      presenter: { name: 'Rima', voice: 'warm' },
      format: { title: 'Reveal', shape: 'close on ingredients' },
      scenes: 3, targetSeconds: 30, cta: 'Full recipe in the comments',
    });
    expect(system + user).not.toMatch(/\{\{/);
    expect(user).toContain('Rima');
  });

  it('asks the model once and returns the validated plan', async () => {
    const answer = { format: 'reveal', hook: 'h', cta: 'Full recipe in the comments',
      scenes: [scene({ presenter: true, line: 'hi' }), scene({ sources: ['topShot'] }), scene({ line: 'Full recipe in the comments' })] };
    const calls: string[] = [];
    const plan = await planReel({
      prompt: async (name) => { calls.push(name); return { content: JSON.stringify(answer) }; },
      article: { title: 'Soup', recipe: 'boil', imagePrompts: { feature: 'a bowl' } },
      sources: ['feature', 'topShot', 'pin'], presenter: { name: 'Rima', voice: 'warm' }, targetSeconds: 30, format: reveal,
    });
    expect(calls).toEqual(['reel-plan']);
    expect(plan.scenes[0]!.presenter).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/reel-plan.test.ts`
Expected: FAIL — cannot find module `../src/reels/formats.js`.

- [ ] **Step 3: `src/reels/formats.ts`**

```ts
/**
 * The shapes a reel can take.
 *
 * What keeps reels from all looking the same. Each format is a shape the plan
 * prompt is told to follow, and a page rotates through them: the last four it
 * used are avoided, so every shape comes round before any comes back.
 */
export interface ReelFormat {
  key: string;
  title: string;
  /** Handed to the plan prompt verbatim. */
  shape: string;
  presenter: 'optional' | 'never' | 'required';
  /** False for a format with no spoken line at all. */
  speech: boolean;
}

export const FORMATS: ReelFormat[] = [
  { key: 'reveal', title: 'Reveal', shape: 'close on the ingredients, one motion, then the finished dish', presenter: 'optional', speech: true },
  { key: 'taste-test', title: 'Taste test', shape: 'the presenter tastes, reacts, and shows the dish', presenter: 'required', speech: true },
  { key: 'three-things', title: 'Three things', shape: '"three things that make this work", one per scene', presenter: 'optional', speech: true },
  { key: 'mistake', title: 'The mistake', shape: 'the common mistake, then the fix, then the result', presenter: 'optional', speech: true },
  { key: 'pov', title: 'POV', shape: 'first-person hands only, the viewer is the cook', presenter: 'never', speech: true },
  { key: 'before-after', title: 'Before and after', shape: 'raw, then cooked, side by side', presenter: 'optional', speech: true },
  { key: 'secret', title: 'The secret', shape: '"the secret to this one is..." -- tease, the thing, the result', presenter: 'optional', speech: true },
  { key: 'countdown', title: 'Countdown', shape: '3-2-1 over steps or ingredients, one per scene', presenter: 'optional', speech: true },
  { key: 'myth', title: 'The myth', shape: '"people think... but actually..." -- a belief, then the truth', presenter: 'optional', speech: true },
  { key: 'asmr', title: 'ASMR', shape: 'no speech at all: cooking sound only, the call to action as text', presenter: 'never', speech: false },
  { key: 'time-trap', title: 'Time trap', shape: '"ready in 20 minutes" -- time as the subject, fast rhythm', presenter: 'optional', speech: true },
  { key: 'first-bite', title: 'First bite', shape: 'opens on the first bite, then back to how it was made', presenter: 'optional', speech: true },
  { key: 'story', title: 'Story', shape: 'the presenter says why this recipe is theirs, in the first person', presenter: 'required', speech: true },
];

export const formatByKey = (key: string): ReelFormat | undefined => FORMATS.find((f) => f.key === key);

/**
 * One format for the next reel on a page.
 *
 * Avoids the formats the page used most recently; when every allowed format
 * is recent (a short allow-list), any allowed one will do. `random` is
 * injectable so the choice is testable.
 */
export function pickFormat(
  allowed: string[],
  recent: string[],
  random: () => number = Math.random,
): ReelFormat {
  const pool = FORMATS.filter((f) => allowed.includes(f.key));
  if (pool.length === 0) throw new Error('No format is allowed. Turn at least one on under Setup → Reels.');
  const fresh = pool.filter((f) => !recent.includes(f.key));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(random() * from.length)]!;
}
```

- [ ] **Step 4: `src/reels/plan.ts`**

```ts
import { parseJsonLoose } from '../pipeline/json.js';
import type { ReelFormat } from './formats.js';

export type SourceRole = 'feature' | 'topShot' | 'textureMacro' | 'beforeAfter' | 'pin';
export const CLIP_SECONDS = 10;
const MAX_LINE_WORDS = 22;

export interface PlannedScene {
  seconds: typeof CLIP_SECONDS;
  sources: SourceRole[];
  presenter: boolean;
  image: string;
  motion: string;
  line: string;
}

export interface ReelPlan {
  format: string;
  hook: string;
  scenes: PlannedScene[];
  cta: string;
}

/** Clips are ten seconds; 45 rounds up rather than short. */
export const scenesFor = (targetSeconds: number): number =>
  Math.min(6, Math.max(2, Math.ceil(targetSeconds / CLIP_SECONDS)));

interface Rules {
  sources: SourceRole[];
  hasPresenter: boolean;
  targetSeconds: number;
  format: ReelFormat;
}

/**
 * Check a plan before anything is spent on it.
 *
 * Every rule here is one the model was told; this is what happens when it
 * did not listen. The error is a sentence, because it lands on the reel page.
 */
export function validatePlan(raw: unknown, rules: Rules): ReelPlan {
  const plan = raw as Partial<ReelPlan>;
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  const wanted = scenesFor(rules.targetSeconds);

  if (scenes.length < 2 || scenes.length > 6) {
    throw new Error(`The plan has ${scenes.length} scene(s); a reel has between 2 and 6.`);
  }
  if (Math.abs(scenes.length - wanted) > 1) {
    throw new Error(`The plan has ${scenes.length} scenes, but ${rules.targetSeconds} seconds is ${wanted}.`);
  }

  const cta = String(plan.cta ?? '').trim();
  const out: PlannedScene[] = scenes.map((s, i) => {
    const sources = (Array.isArray(s.sources) ? s.sources : []).map(String) as SourceRole[];
    if (sources.length === 0) throw new Error(`Scene ${i + 1} names no image to film from.`);
    for (const src of sources) {
      if (!rules.sources.includes(src)) throw new Error(`Scene ${i + 1} wants an image "${src}" the article does not have.`);
    }
    const line = String(s.line ?? '').trim();
    if (line.split(/\s+/).filter(Boolean).length > MAX_LINE_WORDS) {
      throw new Error(`Scene ${i + 1}'s line is longer than ${MAX_LINE_WORDS} words; it cannot be said in ten seconds.`);
    }
    if (!rules.format.speech && line) throw new Error(`The ${rules.format.title} format has no speech, but scene ${i + 1} has a line.`);
    const presenter = Boolean(s.presenter);
    if (presenter && (!rules.hasPresenter || rules.format.presenter === 'never')) {
      throw new Error(`Scene ${i + 1} puts the presenter in a ${rules.format.key} reel that has none.`);
    }
    return {
      seconds: CLIP_SECONDS,
      sources: sources.slice(0, 3),
      presenter,
      image: String(s.image ?? '').trim(),
      motion: String(s.motion ?? '').trim(),
      line,
    };
  });

  if (rules.hasPresenter && rules.format.presenter !== 'never' && !out.some((s) => s.presenter)) {
    throw new Error('The page has a presenter, but no scene puts them in the reel.');
  }
  if (out.some((s) => !s.motion)) throw new Error('Every scene needs to say what happens in it.');

  const last = out[out.length - 1]!;
  if (rules.format.speech && !last.line.toLowerCase().includes(cta.toLowerCase().slice(0, 12))) {
    throw new Error('The last scene has to carry the call to action.');
  }

  return { format: rules.format.key, hook: String(plan.hook ?? '').trim(), scenes: out, cta };
}

export async function planReel(input: {
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>;
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: SourceRole[];
  presenter: { name: string; voice: string } | null;
  targetSeconds: number;
  format: ReelFormat;
  cta?: string;
}): Promise<ReelPlan> {
  const cta = input.cta ?? 'Full recipe in the comments';
  const result = await input.prompt('reel-plan', {
    article: {
      title: input.article.title,
      recipe: input.article.recipe,
      imagePrompts: Object.entries(input.article.imagePrompts)
        .map(([role, text]) => `${role}: ${text}`)
        .join('\n'),
    },
    sources: input.sources.join(', '),
    presenter: input.presenter ?? { name: 'nobody', voice: 'no presenter in this reel' },
    format: { title: input.format.title, shape: input.format.shape },
    scenes: scenesFor(input.targetSeconds),
    targetSeconds: input.targetSeconds,
    cta,
  });
  return validatePlan(parseJsonLoose(result.content), {
    sources: input.sources,
    hasPresenter: input.presenter !== null,
    targetSeconds: input.targetSeconds,
    format: input.format,
  });
}
```

Check `src/pipeline/json.ts` for the loose parser's real name (`grep -n "^export function" src/pipeline/json.ts`) and use it.

- [ ] **Step 5: The prompt files**

`prompts/reel-plan.system.txt`:

```
You are the director of short vertical recipe videos for a food creator's Facebook page. You write storyboards that a real creator would shoot: specific, physical, surprising, never a list of adjectives about the dish. Each scene is one ten-second clip generated by a video model from one to three still photographs of the finished dish, so every scene must be filmable from those photographs plus at most one person. You answer with JSON only.
```

`prompts/reel-plan.user.txt`:

```
Recipe: {{article.title}}

How it is made:
{{article.recipe}}

The photographs available, by name, with what each shows:
{{article.imagePrompts}}
You may only film from these: {{sources}}

Presenter: {{presenter.name}} — voice: {{presenter.voice}}
Format for this reel: {{format.title}} — {{format.shape}}
Length: {{targetSeconds}} seconds = {{scenes}} scenes of 10 seconds each.
Call to action, which the last scene must carry: "{{cta}}"

Write the storyboard as JSON:
{
  "format": "<the format key>",
  "hook": "<the first spoken or shown line, under 8 words, that stops the scroll>",
  "scenes": [
    {
      "seconds": 10,
      "sources": ["<one to three photograph names this scene is filmed from>"],
      "presenter": <true if the presenter is on screen in this scene>,
      "image": "<fresh-image mode only: what the frame shows, one sentence>",
      "motion": "<what physically happens over ten seconds, one or two sentences, concrete>",
      "line": "<what the presenter says in this scene, under 22 words, or an empty string for cooking sound only>"
    }
  ],
  "cta": "{{cta}}"
}

Rules:
- Exactly {{scenes}} scenes. Follow the format's shape.
- Use the same photograph in more than one scene when a different motion earns it; vary rhythm: a close, then a pull-back, then a hand.
- The presenter appears in at least one scene if there is one, and not in every scene. A presenter named "nobody" never appears.
- Lines are spoken, not read: short, warm, first person, no hashtags, no links.
- The last scene's line ends with the call to action, word for word.
- Nothing in the storyboard may invent an ingredient or a step the recipe does not have.
```

`prompts/index.json`: add

```json
 "reel-plan": {
  "sourceNode": "Reels",
  "model": "gpt-oss:120b",
  "format": "json",
  "hasSystem": true
 }
```

`src/pipeline/prompt-contexts.ts`, in `STEP_CONTEXTS`:

```ts
  'reel-plan': {
    article: { title: 't', recipe: 'r', imagePrompts: 'feature: f' },
    sources: 'feature',
    presenter: { name: 'n', voice: 'v' },
    format: { title: 'f', shape: 's' },
    scenes: 3,
    targetSeconds: 30,
    cta: 'c',
  },
```

If `PROMPT_MODELS` in `src/pipeline/prompts.ts` is a hand-written map, add `'reel-plan': 'gpt-oss:120b'`; if it is read from `index.json`, nothing to do.

- [ ] **Step 6: Run the tests, the prompt tests, and typecheck**

Run: `npx tsc --noEmit && npx vitest run test/reel-plan.test.ts test/prompts.test.ts test/prompt-editing.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/reels/formats.ts src/reels/plan.ts prompts test/reel-plan.test.ts src/pipeline/prompt-contexts.ts src/pipeline/prompts.ts
git commit -m "Write a storyboard for every reel, in one of thirteen shapes, and check it before spending anything

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The plan stage and the filming stage in the engine

**Files:**
- Modify: `src/reels/compose.ts` (`sourceUrls`, `clipPrompt`), `src/reels/engine.ts`, `src/integrations/images.ts`
- Create: `src/reels/film.ts`
- Modify: `src/pipeline/steps/reel.ts`, `test/auto-reel.test.ts`, `test/reel-state.test.ts`
- Create: `test/reel-film.test.ts`

**Interfaces:**
- Consumes: Task 3 repos; Task 4 `planReel`, `pickFormat`; `ImageClient.submitVideo` gains `characterMediaId?: string` and `voiceMediaId?: string`.
- Produces:
```ts
// compose.ts
export function sourceUrls(host: string, images: ArticleImages, pin: string | null): Record<SourceRole, string>  // only roles that exist
export function clipPrompt(scene: { motion: string; line: string }, presenter: { name: string; voice: string } | null): string
// engine.ts — ReelDeps gains:
//   prompt(name, vars): Promise<{ content: string }>
//   clipsDir: string                      // where clips land: <dataDir>/reels
//   assemble(clipPaths: string[], out: string, cta: string): Promise<void>   // Task 6 supplies; stubbed in tests
// film.ts
export async function filmPending(reel: ReelView, deps: Pick<ReelDeps, 'images' | 'download' | 'clipsDir'>, settings: Settings): Promise<'working' | 'done'>
```

- [ ] **Step 1: Failing tests**

`test/reel-film.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createReel, getReel, insertFbToken, insertKeyword, insertPresenter, listScenes, replaceScenes, setFbPagePresenter, setReelStage, upsertFbPage, upsertSite } from '../src/db/repos.js';
import { filmPending } from '../src/reels/film.js';
import { clipPrompt, sourceUrls } from '../src/reels/compose.js';
import { Settings } from '../src/settings.js';

const KEY = randomBytes(32);

describe('the clip prompt', () => {
  it('puts the line in as dialogue and repeats the voice, word for word', () => {
    const text = clipPrompt({ motion: 'she lifts the spoon', line: 'Full recipe in the comments.' }, { name: 'Rima', voice: 'warm, unhurried' });
    expect(text).toContain('she lifts the spoon');
    expect(text).toContain('Rima says: "Full recipe in the comments."');
    expect(text).toContain('warm, unhurried');
  });
  it('is only the motion when there is nobody and nothing to say', () => {
    expect(clipPrompt({ motion: 'steam rises', line: '' }, null)).toBe('steam rises');
  });
});

describe('source urls', () => {
  it('names each article image by role, and the pin when there is one', () => {
    const urls = sourceUrls('a.com', { feature: '/f.webp', topShot: '/t.webp', textureMacro: '/m.webp', beforeAfter: '/b.webp' }, '/p.webp');
    expect(urls.feature).toBe('https://a.com/f.webp');
    expect(urls.pin).toBe('https://a.com/p.webp');
    expect(Object.keys(sourceUrls('a.com', { feature: '/f', topShot: '/t', textureMacro: '/m', beforeAfter: '/b' }, null))).not.toContain('pin');
  });
});

describe('filming', () => {
  let dir: string;
  let settings: Settings;
  beforeEach(() => { openDatabase(':memory:'); settings = new Settings(KEY); settings.set('flow_project_id', 'P'); dir = mkdtempSync(join(tmpdir(), 'reel-')); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  const seed = () => {
    const siteId = upsertSite({ name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId: insertFbToken('App', 'tok', KEY) });
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'char-1', flowVoiceId: 'voice-1', voiceDescription: 'warm', portraitUrl: '' });
    setFbPagePresenter(pageId, presenterId);
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '', caption: 'c', references: [], stage: 'filming' });
    setReelStage(reelId, 'filming', { planJson: JSON.stringify({ sources: { feature: 'https://a.com/f.webp', pin: 'https://a.com/p.webp' } }) });
    replaceScenes(reelId, [
      { seconds: 10, presenter: true, sources: ['feature'], imagePrompt: '', motionPrompt: 'she lifts the spoon', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['pin', 'feature'], imagePrompt: '', motionPrompt: 'steam', line: '' },
    ]);
    return reelId;
  };

  const fakeImages = (jobs: Record<string, string>) => ({
    submitVideo: vi.fn(async (input: { referenceUrls: string[]; characterMediaId?: string; prompt: string }) => {
      const id = `job-${Object.keys(jobs).length + 1}`; jobs[id] = 'PENDING'; return id;
    }),
    poll: vi.fn(async (id: string) => ({ job_id: id, status: jobs[id]!, image_url: jobs[id] === 'COMPLETED' ? `https://cdn/${id}.mp4` : null, image_expires_at: null, error: null })),
  });

  it('submits one clip per scene with its sources and the presenter, and only for scenes not yet done', async () => {
    const reelId = seed();
    const jobs: Record<string, string> = {};
    const images = fakeImages(jobs);
    const state = await filmPending(getReel(reelId)!, { images: images as never, download: async () => Buffer.from('mp4'), clipsDir: dir }, settings);
    expect(state).toBe('working');
    expect(images.submitVideo).toHaveBeenCalledTimes(2);
    expect(images.submitVideo.mock.calls[0]![0]).toMatchObject({ referenceUrls: ['https://a.com/f.webp'], characterMediaId: 'char-1', voiceMediaId: 'voice-1', projectId: 'P' });
    expect(images.submitVideo.mock.calls[1]![0]).toMatchObject({ referenceUrls: ['https://a.com/p.webp', 'https://a.com/f.webp'], characterMediaId: undefined, voiceMediaId: undefined });
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['working', 'working']);
  });

  it('downloads a finished clip next to the reel, and is done when every scene is', async () => {
    const reelId = seed();
    const jobs: Record<string, string> = {};
    const images = fakeImages(jobs);
    const deps = { images: images as never, download: async () => Buffer.from('mp4'), clipsDir: dir };
    await filmPending(getReel(reelId)!, deps, settings);
    jobs['job-1'] = 'COMPLETED';
    expect(await filmPending(getReel(reelId)!, deps, settings)).toBe('working');
    jobs['job-2'] = 'COMPLETED';
    expect(await filmPending(getReel(reelId)!, deps, settings)).toBe('done');
    const scenes = listScenes(reelId);
    expect(scenes.every((s) => s.status === 'done')).toBe(true);
    expect(existsSync(scenes[0]!.clip_path!)).toBe(true);
    expect(scenes[0]!.clip_path).toContain(join(dir, String(reelId)));
  });

  it('marks a scene failed with the reason, leaves the others, and stops there', async () => {
    const reelId = seed();
    const jobs: Record<string, string> = {};
    const images = fakeImages(jobs);
    const deps = { images: images as never, download: async () => Buffer.from('mp4'), clipsDir: dir };
    await filmPending(getReel(reelId)!, deps, settings);
    jobs['job-1'] = 'FAILED';
    await expect(filmPending(getReel(reelId)!, deps, settings)).rejects.toThrow(/scene 1/i);
    expect(listScenes(reelId)[0]).toMatchObject({ status: 'failed' });
    expect(listScenes(reelId)[1]!.status).toBe('working');
  });
});
```

Also, in `test/auto-reel.test.ts`, change what the step is expected to leave behind: a reel with `status: 'generating'`, `stage: 'planning'`, no `job_id`, and no `/v1/generate-video` call during the pipeline (the engine films later). Keep the "no page → skipped", "fb off → no reel", "resume → one reel" tests as they are; delete the "video submit fails" test (nothing is submitted in the step any more).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/reel-film.test.ts test/auto-reel.test.ts`
Expected: FAIL — missing modules / the step still submits a video.

- [ ] **Step 3: `compose.ts` and `images.ts`**

In `src/reels/compose.ts`, replace `referenceUrls` with:

```ts
import type { SourceRole } from './plan.js';

/** The article's images by role, as public urls; the pin only when there is one. */
export function sourceUrls(
  host: string,
  images: ArticleImages,
  pin: string | null,
): Partial<Record<SourceRole, string>> {
  const abs = (path: string) => `https://${host}${path}`;
  const out: Partial<Record<SourceRole, string>> = {
    feature: abs(images.feature),
    topShot: abs(images.topShot),
    textureMacro: abs(images.textureMacro),
    beforeAfter: abs(images.beforeAfter),
  };
  if (pin) out.pin = abs(pin);
  return out;
}

/**
 * The prompt one clip is filmed from.
 *
 * The motion, then the line as dialogue in the form the Flow UI uses, then
 * the voice in the same words every scene -- that repetition is what keeps
 * the voice the same clip to clip.
 */
export function clipPrompt(
  scene: { motion: string; line: string },
  presenter: { name: string; voice: string } | null,
): string {
  const parts = [scene.motion.trim()];
  if (presenter && scene.line.trim()) {
    parts.push(`${presenter.name} says: "${scene.line.trim()}"`);
    if (presenter.voice.trim()) parts.push(`Her voice: ${presenter.voice.trim()}.`);
  }
  return parts.join(' ');
}
```

(`buildReelPrompt` and the `reel-video.template.txt` are no longer used by the pipeline; delete `buildReelPrompt`, the template file, its `TEMPLATE_CONTEXTS` entry, and the composer's use of it — the composer page becomes "make a reel by hand" = create a reel in `planning` for that run.)

In `src/integrations/images.ts`, `submitVideo`:

```ts
  async submitVideo(input: {
    prompt: string;
    referenceUrls: string[];
    characterMediaId?: string;
    voiceMediaId?: string;
    projectId?: string;
    orientation?: string;
  }): Promise<string> {
    // ... body gains:
        ...(input.characterMediaId ? { character_media_id: input.characterMediaId } : {}),
        ...(input.voiceMediaId ? { voice_media_id: input.voiceMediaId } : {}),
```

- [ ] **Step 4: `src/reels/film.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageClient } from '../integrations/images.js';
import { getSite, listScenes, presenterForPage, updateScene, type ReelSceneRow, type ReelView } from '../db/repos.js';
import { resolveProjectId } from '../core/project-id.js';
import type { Settings } from '../settings.js';
import { clipPrompt } from './compose.js';
import type { SourceRole } from './plan.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('reel-film');

const TERMINAL_FAILURES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

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
  deps: { images: Pick<ImageClient, 'submitVideo' | 'poll'>; download(url: string): Promise<Buffer>; clipsDir: string },
  settings: Settings,
): Promise<'working' | 'done'> {
  const plan = JSON.parse(reel.plan_json || '{}') as { sources?: Partial<Record<SourceRole, string>> };
  const sources = plan.sources ?? {};
  const presenter = reel.fb_page_id ? presenterForPage(reel.fb_page_id) : undefined;
  const site = reel.site_id ? getSite(reel.site_id) : undefined;
  const project = resolveProjectId(site?.project_id ?? '', settings.get('flow_project_id'), site?.domain ?? '');

  for (const scene of listScenes(reel.id)) {
    if (scene.status === 'done') continue;
    if (scene.status === 'failed') throw new Error(`Scene ${scene.position} failed: ${scene.error ?? 'no detail'}`);

    if (scene.status === 'pending') {
      const urls = (JSON.parse(scene.sources_json) as SourceRole[]).map((r) => sources[r]).filter((u): u is string => Boolean(u));
      if (urls.length === 0) {
        fail(scene, 'none of the images this scene was planned from exist');
      }
      const jobId = await deps.images.submitVideo({
        prompt: clipPrompt({ motion: scene.motion_prompt, line: scene.line }, scene.presenter && presenter ? { name: presenter.name, voice: presenter.voice_description } : null),
        referenceUrls: urls,
        characterMediaId: scene.presenter && presenter ? presenter.flow_character_id : undefined,
        voiceMediaId: scene.presenter && presenter ? presenter.flow_voice_id || undefined : undefined,
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
      fail(scene, job.error ?? `the clip job ended ${status}`);
    }
  }

  return listScenes(reel.id).every((s) => s.status === 'done') ? 'done' : 'working';
}

function fail(scene: ReelSceneRow, why: string): never {
  updateScene(scene.id, { status: 'failed', error: why });
  throw new Error(`Scene ${scene.position} failed: ${why}`);
}
```

- [ ] **Step 5: The engine**

In `src/reels/engine.ts`:

- `ReelDeps` gains `prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>`, `clipsDir: string`, and `assemble(clipPaths: string[], out: string, cta: string): Promise<void>`.
- `defaultDeps(settings, key, dataDir)` fills `prompt` from a `PipelineContext`-free LLM call — use the same code path `PipelineContext.prompt` uses (extract it into `src/llm/ask.ts` as `askPrompt(settings, key, name, vars)` if it is not already standalone), `clipsDir: join(dataDir, 'reels')`, `assemble` from Task 6 (import `assembleReel`).
- `activeReels()` in repos: include `status = 'generating'` (already) — stages ride on it.
- `advance()`:

```ts
    case 'generating':
      switch (reel.stage) {
        case 'planning':   return planStage(reel, settings, deps);
        case 'imaging':    return imagingStage(reel, settings, deps);   // Task 9
        case 'filming':    return filmingStage(reel, settings, deps);
        case 'assembling': return assemblingStage(reel, settings, deps); // Task 6
        default:           return pollGeneration(reel, deps);           // the one-shot reels that still exist
      }
```

`planStage`:

```ts
async function planStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const page = reel.fb_page_id ? getFbPage(reel.fb_page_id) : undefined;
  const presenter = page ? presenterForPage(page.id) : undefined;
  const seed = JSON.parse(reel.plan_json || '{}') as { sources?: Record<string, string>; article?: { title: string; recipe: string; imagePrompts: Record<string, string> } };
  if (!seed.sources || !seed.article) throw new Error('This reel has no article to plan from.');

  const allowed = JSON.parse(settings.get('reel_formats') || '[]') as string[];
  const format = pickFormat(allowed, page ? recentFormatsForPage(page.id) : []);
  const plan = await planReel({
    prompt: deps.prompt,
    article: seed.article,
    sources: Object.keys(seed.sources) as SourceRole[],
    presenter: presenter && format.presenter !== 'never' ? { name: presenter.name, voice: presenter.voice_description } : null,
    targetSeconds: settings.getNumber('reel_length_seconds'),
    format,
    cta: settings.get('reel_cta_text'),
  });

  replaceScenes(reel.id, plan.scenes.map((s) => ({ seconds: s.seconds, presenter: s.presenter, sources: s.sources, imagePrompt: s.image, motionPrompt: s.motion, line: s.line })));
  const next = settings.getBool('reel_fresh_images') ? 'imaging' : 'filming';
  setReelStage(reel.id, next, { planJson: JSON.stringify({ ...seed, plan }), format: format.key });
  log.info(`reel ${reel.id}: planned as ${format.key}, ${plan.scenes.length} scenes`);
  return true;
}

async function filmingStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const state = await filmPending(reel, deps, settings);
  if (state === 'done') setReelStage(reel.id, 'assembling');
  return true;
}
```

`plan_json` therefore holds, from creation: `{ article, sources }`; after planning: `{ article, sources, plan }`.

- [ ] **Step 6: The pipeline step**

`src/pipeline/steps/reel.ts` no longer prompts for a caption itself nor starts a video. It creates the reel:

```ts
    const pinStep = getCompletedStep(ctx.runId, 'generate-pin-image');
    const pin = pinStep ? (JSON.parse(pinStep.output_json ?? '{}') as { url?: string }).url ?? null : null;
    const recipeStep = getCompletedStep(ctx.runId, 'generate-recipe');
    const promptsStep = getCompletedStep(ctx.runId, 'generate-image-prompts');

    const reelId = createReel({
      runId: ctx.runId,
      siteId: ctx.site.id,
      keywordId: ctx.keyword.id,
      fbPageId: page.id,
      prompt: '',
      caption,
      references: [],
      stage: 'planning',
    });
    setReelStage(reelId, 'planning', {
      planJson: JSON.stringify({
        article: {
          title,
          recipe: recipeStep?.output_json ?? '',
          imagePrompts: promptsStep ? JSON.parse(promptsStep.output_json ?? '{}') : {},
        },
        sources: sourceUrls(host, input.images, pin),
      }),
    });
    log.info(`run ${ctx.runId}: reel ${reelId} queued for planning on ${page.name || page.page_id}`);
    return { reelId };
```

(The caption code stays exactly as it is above it.)

- [ ] **Step 7: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (update `test/reel-state.test.ts` fakes to supply the three new deps as no-op stubs).

- [ ] **Step 8: Commit**

```bash
git add src test prompts
git commit -m "Plan every reel, then film it scene by scene with the presenter in the clip

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Assembly with ffmpeg, and publishing the result

**Files:**
- Create: `src/reels/assemble.ts`, `test/reel-assemble.test.ts`
- Modify: `src/reels/engine.ts` (`assemblingStage`, `publishReel`), `Dockerfile`, `src/web/server.ts` (a route that streams `output_path`), `src/web/views/reel-detail.ts`

**Interfaces:**
- Produces: `assembleReel(clipPaths: string[], outPath: string, options: { ctaText: string; ffmpeg?: string }): Promise<void>` — throws with ffmpeg's last stderr lines on failure. `GET /reels/:id/video` streams the assembled file (behind login).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleReel } from '../src/reels/assemble.js';

const ffmpegAvailable = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!ffmpegAvailable)('assembling a reel', () => {
  let dir: string;
  const clip = (name: string, seconds: number, size: string) => {
    const path = join(dir, name);
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-shortest', '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' });
    return path;
  };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'asm-')); });

  it('joins clips of different sizes into one portrait file with the CTA on the end', async () => {
    const a = clip('a.mp4', 1, '720x1280');
    const b = clip('b.mp4', 1, '640x640');
    const out = join(dir, 'out.mp4');
    await assembleReel([a, b], out, { ctaText: 'Full recipe in the comments' });
    expect(statSync(out).size).toBeGreaterThan(0);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0', out]).toString();
    expect(probe).toContain('1080,1920');
    expect(Number(probe.trim().split('\n').pop())).toBeGreaterThan(1.8);
  });

  it('says what ffmpeg said when a clip is unreadable', async () => {
    await expect(assembleReel([join(dir, 'missing.mp4')], join(dir, 'x.mp4'), { ctaText: '' })).rejects.toThrow(/missing\.mp4/);
  });
});

describe('assembling without ffmpeg', () => {
  it('fails with a sentence a person can act on', async () => {
    await expect(assembleReel(['a.mp4'], 'o.mp4', { ctaText: '', ffmpeg: 'no-such-ffmpeg-binary' })).rejects.toThrow(/ffmpeg/i);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/reel-assemble.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: `src/reels/assemble.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Join the scene clips into the reel.
 *
 * One ffmpeg run: every clip scaled and padded to 1080x1920 at 30 fps with
 * its own sound kept, concatenated in order, and the call to action drawn on
 * the last two seconds. ffmpeg is a command, not a service -- it runs for the
 * seconds this takes and exits.
 */
export async function assembleReel(
  clipPaths: string[],
  outPath: string,
  options: { ctaText: string; ffmpeg?: string },
): Promise<void> {
  if (clipPaths.length === 0) throw new Error('There are no clips to assemble.');
  mkdirSync(dirname(outPath), { recursive: true });

  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const norm = clipPaths
    .map((_, i) => `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`)
    .join(';');
  const concat = clipPaths.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clipPaths.length}:v=1:a=1[vc][ac]`;
  const cta = options.ctaText.trim();
  const text = cta
    ? `;[vc]drawtext=text='${cta.replace(/'/g, "\\\\'").replace(/:/g, '\\:')}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.5:boxborderw=24:x=(w-text_w)/2:y=h-260:enable='gte(t,${Math.max(0, clipPaths.length * 10 - 2)})'[vout]`
    : ';[vc]copy[vout]';
  const filter = `${norm};${concat}${text}`;

  const args = ['-y', ...inputs, '-filter_complex', filter, '-map', '[vout]', '-map', '[ac]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath];

  await run(options.ffmpeg ?? 'ffmpeg', args);
}

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on('error', (err) => reject(new Error(`ffmpeg could not be started (${err.message}). It ships in the platform image; if this is a local checkout, install ffmpeg.`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(`ffmpeg failed (exit ${code}):\n${tail}`));
    });
  });
}
```

- [ ] **Step 4: Engine stage and publishing**

In `engine.ts`:

```ts
async function assemblingStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const scenes = listScenes(reel.id);
  const clips = scenes.map((s) => s.clip_path).filter((p): p is string => Boolean(p));
  if (clips.length !== scenes.length) throw new Error('Not every scene has a clip to assemble.');
  const out = join(deps.clipsDir, `${reel.id}.mp4`);
  await deps.assemble(clips, out, settings.get('reel_cta_text'));
  setReelStage(reel.id, 'done', { outputPath: out });
  updateReel(reel.id, { status: 'ready', videoUrl: null, error: null });
  log.info(`reel ${reel.id}: assembled ${clips.length} clip(s)`);
  return true;
}
```

`publishReel`: replace `if (!reel.video_url) throw ...` and `const video = await deps.download(reel.video_url)` with:

```ts
  const video = reel.output_path
    ? await readFile(reel.output_path)
    : reel.video_url
      ? await deps.download(reel.video_url)
      : (() => { throw new Error('This reel has no video to publish.'); })();
```

`Dockerfile`, runtime stage: `RUN apk add --no-cache tini wget ffmpeg && ...`.

`server.ts`: `app.get('/reels/:id/video', ...)` — 404 unless `reel.output_path` exists; `reply.type('video/mp4').send(createReadStream(reel.output_path))`. `reel-detail.ts`: when `output_path` is set, render `<video controls src="/reels/${id}/video" style="max-height:60vh">`.

- [ ] **Step 5: Run**

Run: `npx tsc --noEmit && npx vitest run test/reel-assemble.test.ts test/reel-state.test.ts`
Expected: PASS (the ffmpeg-backed tests run where ffmpeg is installed; install it locally with `winget install Gyan.FFmpeg` on this machine so they do).

- [ ] **Step 6: Commit**

```bash
git add src Dockerfile test/reel-assemble.test.ts
git commit -m "Join the scene clips into one reel with ffmpeg, and publish that file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Settings, the reel page as a storyboard, retry per scene, Home

**Files:**
- Modify: `src/settings.ts`, `src/web/views/layout.ts` (Setup tab `Reels` → `/settings/reels`), `src/web/views/pages.ts` (`reelsSettingsPage`), `src/web/server.ts`, `src/web/views/reel-detail.ts`
- Modify: `test/fb-settings.test.ts` or create `test/reel-settings.test.ts`

**Interfaces:**
- Settings: `reel_length_seconds` (number, default `30`, group `reels`, help: "How long a reel is. 30 seconds is three scenes; 60 is six. Longer costs more video credits per article."), `reel_formats` (hidden, default JSON of all thirteen keys), `reel_fresh_images` (bool, default `false`, help: "Off: scenes are filmed from the article's own images, which costs nothing extra. On: a new image is made for every scene first."), `reel_cta_text` (default `Full recipe in the comments`).
- Routes: `GET /settings/reels` (length select, formats checkboxes, fresh switch, CTA text; posts to `POST /settings/reels`); `POST /reels/:id/scenes/:sceneId/retry` (sets the scene `pending`, error null, reel `status='generating'`); `GET /reels/:id` renders the storyboard.

- [ ] **Step 1: Failing test**

```ts
// test/reel-settings.test.ts — same login scaffolding as test/home.test.ts
it('shows the reel style page under Setup, with every format on by default', async () => {
  const body = (await get('/settings/reels')).body;
  expect(body).toContain('name="reel_length_seconds"');
  expect((body.match(/name="reel_formats" value="[a-z-]+" checked/g) ?? []).length).toBe(13);
});
it('saves the formats that are ticked, and refuses none', async () => {
  await post('/settings/reels', { reel_length_seconds: '45', reel_formats: ['reveal', 'myth'], reel_cta_text: 'Recipe below' });
  expect(JSON.parse(settings.get('reel_formats'))).toEqual(['reveal', 'myth']);
  const refused = await post('/settings/reels', { reel_length_seconds: '45', reel_cta_text: 'x' });
  expect(refused.headers.location).toMatch(/error=/);
});
it('retries one scene without touching the others', async () => {
  // seed a reel in filming with scene 1 failed and scene 2 done (use repos), then:
  await post(`/reels/${reelId}/scenes/${failedSceneId}/retry`, {});
  expect(listScenes(reelId).map((s) => s.status)).toEqual(['pending', 'done']);
  expect(getReel(reelId)?.status).toBe('generating');
});
it('renders the storyboard: one row per scene with its state', async () => {
  const body = (await get(`/reels/${reelId}`)).body;
  expect(body).toContain('Scene 1');
  expect(body).toContain('Scene 2');
  expect(body).toContain('Retry');
});
```

- [ ] **Step 2: Run to see it fail**, then implement:

- `settings.ts`: the four specs, group `'reels'` (add `'reels'` to the `group` union).
- `layout.ts`: Setup pages gain `{ href: '/settings/reels', label: 'Reels' }` after Prompts.
- `pages.ts` `reelsSettingsPage(values, formats: ReelFormat[])`: `<h1>Reels</h1>`, subtitle "How every reel is shaped. Nothing here is needed to start; change it when you want reels longer, shorter, or in fewer shapes."; a select for length (15/30/45/60 with "= N scenes"); a checkbox per format with its title and shape; the fresh-images checkbox with its help; the CTA input; Save.
- `server.ts`: the two routes; `POST /settings/reels` reads `reel_formats` as array (`formBody` gives `string | string[]`), refuses an empty selection with the flash "Keep at least one format on."; the retry route; the storyboard route passes `listScenes(reel.id)` and `presenterForPage` to `reelDetailPage(reel, scenes, presenter)`.
- `reel-detail.ts`: a card per scene: "Scene N · 10 s", the source roles as chips, "with {presenter}" when set, the motion, the line in quotes, the status badge, the error if any, a Retry form when failed, a `<video>` when `clip_path` is set (served by `GET /reels/:id/scenes/:sceneId/clip` — add it beside the video route). The finished reel's `<video>` at the top when `output_path` is set. The stage as a subtitle ("Planning the storyboard" / "Filming scene 2 of 3" / "Assembling" / "Ready to publish").
- Home: in `attentionFor()`, after the FB page niche loop: for each enabled page with a niche and `presenter_id === null`, push `{ kind: 'info', text: 'Page "X" has no presenter, so its reels show the dish only', href: '/settings/facebook', action: 'Pick one' }`.

- [ ] **Step 3: Run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src test
git commit -m "Let the operator shape reels, read a storyboard, and retry one scene

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Presenters — the page under Setup, and the page picker

**Files:**
- Modify: `src/web/server.ts`, `src/web/views/pages.ts` (`presentersPage`), `src/web/views/layout.ts` (Setup tab `Presenters` → `/settings/presenters`), the Facebook settings page (a presenter `<select>` per page row → `setFbPagePresenter`)
- Create: `test/presenters.test.ts`

**Interfaces:**
- `GET /settings/presenters`: the list (name, character id, voice id, voice description, which pages use them, Remove) and the add form: **Name**; **Character id** with the help "In Flow, open the character: the address bar ends in /character/<id>. Paste that id."; **Voice id** with the help "In Flow, open the voice you made for them and paste the id from the address bar the same way. Leave empty for a presenter who does not speak."; **How they sound** with the help "A few words. The same words go into every scene so the delivery stays the same. Example: warm, unhurried, mid-thirties." A pasted value that is a whole URL is accepted: the id is the last path segment.
- `POST /settings/presenters` → `insertPresenter`; `POST /settings/presenters/:id` (name, voice description) → `updatePresenter`; `POST /settings/presenters/:id/delete` → `deletePresenter`.
- Facebook page row gains a `presenter_id` select ("no presenter — dish only" + each presenter); `POST /settings/facebook/pages/:id` saves it with the niche.
- `src/reels/ids.ts`: `idFromFlowUrl(value: string): string` — a bare id passes through; a URL yields its last non-empty path segment; anything that is not 36 chars of hex and dashes throws "That does not look like a Flow id. Copy it from the address bar: it is the long code after /character/."

- [ ] **Step 1: Failing tests**

```ts
// test/presenters.test.ts — login scaffolding as in test/home.test.ts
import { idFromFlowUrl } from '../src/reels/ids.js';

describe('a Flow id pasted by hand', () => {
  it('takes a bare id, or the id off the end of the character page url', () => {
    expect(idFromFlowUrl('f346cb5a-ec29-4143-a87d-b13d70729bf5')).toBe('f346cb5a-ec29-4143-a87d-b13d70729bf5');
    expect(idFromFlowUrl('https://flow.google.com/u/4/project/559dd649-1000-4947-aaa5-e08ae6515705/character/f346cb5a-ec29-4143-a87d-b13d70729bf5'))
      .toBe('f346cb5a-ec29-4143-a87d-b13d70729bf5');
    expect(idFromFlowUrl('  F346CB5A-EC29-4143-A87D-B13D70729BF5/ ')).toBe('f346cb5a-ec29-4143-a87d-b13d70729bf5');
  });
  it('refuses anything that is not an id', () => {
    expect(() => idFromFlowUrl('Rima')).toThrow(/address bar/);
  });
});

describe('presenters', () => {
  it('adds one from pasted ids and lists it', async () => {
    await post('/settings/presenters', { name: 'Rima', character: 'https://flow.google.com/u/4/project/p/character/f346cb5a-ec29-4143-a87d-b13d70729bf5', voice: '509a1ad4-e08a-4a9d-87ba-afc4af20a0c1', voice_description: 'warm' });
    expect(listPresenters()[0]).toMatchObject({ name: 'Rima', flow_character_id: 'f346cb5a-ec29-4143-a87d-b13d70729bf5', flow_voice_id: '509a1ad4-e08a-4a9d-87ba-afc4af20a0c1' });
    expect((await get('/settings/presenters')).body).toContain('Rima');
  });
  it('refuses a character that is not an id, and says where to find one', async () => {
    const r = await post('/settings/presenters', { name: 'Rima', character: 'rima', voice: '', voice_description: '' });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/address bar/);
  });
  it('lets a Facebook page pick a presenter, and forget it when the presenter goes', async () => {
    const tokenId = insertFbToken('App', 'tok', KEY);
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId });
    insertKeyword({ seed_keyword: 'soup' });
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'f346cb5a-ec29-4143-a87d-b13d70729bf5', flowVoiceId: '', voiceDescription: '', portraitUrl: '' });
    await post(`/settings/facebook/pages/${pageId}`, { niche: 'soup', enabled: 'on', autoPublish: 'on', presenter_id: String(presenterId) });
    expect(presenterForPage(pageId)?.name).toBe('Rima');
    await post(`/settings/presenters/${presenterId}/delete`, {});
    expect(presenterForPage(pageId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**, then implement `src/reels/ids.ts`:

```ts
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A Flow id as a person pastes it: on its own, or as the whole address of
 * the character's page. Either way the id is the last thing in it.
 */
export function idFromFlowUrl(value: string): string {
  const last = value.trim().split('/').filter(Boolean).pop() ?? '';
  const id = last.split('?')[0]!.toLowerCase();
  if (!ID.test(id)) {
    throw new Error(
      'That does not look like a Flow id. Copy it from the address bar: it is the long code after /character/.',
    );
  }
  return id;
}
```

then the page, the routes, the layout tab, and the presenter select on the Facebook page; `POST /settings/facebook/pages/:id` reads `presenter_id` ('' → null) and calls `setFbPagePresenter` after `setFbPageOptions`.

- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run`, then commit:

```bash
git commit -m "Presenters: a character and a voice from Flow, named here, chosen per page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Fresh-image mode (the imaging stage)

_Done: `imagingStage` in `src/reels/engine.ts`; `/v1/generate` takes `reference_urls`; tests in `test/reel-state.test.ts`, `test/image-client.test.ts`, `services/imagegen/tests/test_worker.py`._

**Files:**
- Modify: `src/reels/engine.ts` (`imagingStage`), `src/reels/film.ts` (a scene with `image_url` films from `[image_url]` instead of its sources), `test/reel-film.test.ts`

**Interfaces:**
- Consumes: `ImageClient.generate(prompt, orientation)` (exists), `updateScene({ imageJobId, imageUrl })`.

- [ ] **Step 1: Failing tests** — in `test/reel-film.test.ts`: a scene whose `image_url` is set submits `referenceUrls: [image_url]`; in a new engine test: a reel in `imaging` with two scenes calls `images.generate` once per scene with `image_prompt` and the article's feature url as reference (extend `ImageClient.generate` with an optional `{ references?: string[] }` — the image service's `/v1/generate` already accepts `reference_urls`? check `GenerateRequest`; if not, add `reference_urls: list[str] = []` there and pass them as ingredients to `image_request(ref_media_ids=...)` after uploading, mirroring Task 2), moves to `filming` when all have urls.
- [ ] **Step 2:** implement `imagingStage`: for each scene without `image_url`, generate (sequentially, with the `image_gap_seconds` pause), upload nothing (the url is the site's copy — use `ctx`-free upload: the reel has a site, so `SiteApiClient` from `siteSecrets` uploads the bytes and the absolute url is stored); on completion set `stage = 'filming'`.
- [ ] **Step 3:** run, commit:

```bash
git commit -m "Film from fresh images when the operator asks for them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** presenters (T3, T8), Setup → Reels (T7), storyboard + retry (T7), plan + formats + rotation + prompt (T4, T5), scene clips with the captured request (T1, T2, T5), fresh images (T9), assemble (T6), publish (T6), Home notice (T7), settings (T7), `fb_enabled` gate (unchanged, `tickReels` checks it). Voice: in the clip prompt (T5). Nothing provisional: the one-shot path's `pollGeneration` remains only for reels created before the deploy.
- **Placeholders:** none. Task 9's reference-image support on `/v1/generate` is conditional on a check the implementer makes (`grep -n reference_urls services/imagegen/agent/api/v1.py`).
- **Type consistency:** `ReelStage`, `ReelSceneRow`, `setReelStage`, `replaceScenes`, `listScenes`, `updateScene`, `presenterForPage`, `recentFormatsForPage` (T3) are the names used in T5–T8; `SourceRole`, `validatePlan`, `planReel`, `scenesFor` (T4) in T5; `filmPending` (T5) in the engine; `assembleReel` (T6) as `deps.assemble`; `submitVideo({ characterMediaId, voiceMediaId })` (T5) matches `character_media_id` / `voice_media_id` (T2).
