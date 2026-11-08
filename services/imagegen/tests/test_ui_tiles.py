"""Prompts read off their own tiles, so two can render at once.

Each submit through the composer marks the tiles it added with its job, and the
job reads its picture or clip off those tiles -- never off "whatever is new",
which with two prompts out is either one's. Pinned here: each job gets its own
result while the other renders, a submit whose tiles cannot be found falls back
to one at a time, a submit Flow drops without a word is retried on a reloaded
tab, Flow's words on a tile fail the job, and a clip is read off its tile by
its media id -- and never resubmitted when it cannot be followed.
"""
import asyncio

import pytest

_REAL_SLEEP = asyncio.sleep

from agent.services.flow_batch import GeneratedImage
from agent.services.flow_client import FlowClient

ID_A = "aaaaaaaa-0000-4000-8000-000000000001"
ID_B = "bbbbbbbb-0000-4000-8000-000000000002"
CLIP = "cccccccc-0000-4000-8000-000000000003"


def picture(media_id: str) -> str:
    return f"https://flow-content.google/image/{media_id}?sig=x"


def rendering(percent: int) -> dict:
    return {"percent": percent, "image": None, "video": None, "still": None, "ids": []}


def finished(media_id: str) -> dict:
    return {"percent": None, "image": picture(media_id), "video": None, "still": None,
            "ids": [media_id]}


BLANK = {"percent": None, "image": None, "video": None, "still": None, "ids": []}


class Tiles(FlowClient):
    """A browser that is a script: per job, the states its tiles go through."""

    def __init__(self, tiles_by_job, submit=None, listings=None, videos=None):
        self._ui_lock = None
        self._reload_next = False
        self._watching = 0
        self.tiles_unreliable = False
        self._tiles = {job: list(states) for job, states in tiles_by_job.items()}
        self._submit = submit or {"ok": True, "submitted": True, "tiles": 1, "submittedAt": 0}
        self._listings = list(listings or [[]])
        self._videos = dict(videos or {})
        self.submits: list[dict] = []
        self.events: list[str] = []

    async def ui_generate_image(self, prompt, project_id, model_label=None, aspect_label=None,
                                **options):
        self.submits.append({"prompt": prompt, "model": model_label, "aspect": aspect_label,
                             **options})
        self.events.append(f"submit {options.get('jobId')}")
        return dict(self._submit)

    async def ui_job_tiles(self, job_id):
        states = self._tiles.get(job_id) or [None]
        state = states.pop(0) if len(states) > 1 else states[0]
        self.events.append(f"look {job_id}")
        if state is None:
            return {"found": False, "tiles": [], "codes": []}
        return {"found": True, "tiles": state if isinstance(state, list) else [state],
                "codes": getattr(self, "codes", [])}

    async def project_images(self, project_id):
        return self._listings.pop(0) if len(self._listings) > 1 else self._listings[0]

    async def project_titles(self, project_id):
        titles = getattr(self, "titles", [{}])
        return {"titles": titles.pop(0) if len(titles) > 1 else titles[0]}

    async def get_media_urls_batch(self, media_id):
        return {"video_url": self._videos.get(media_id), "image_url": picture(media_id)}


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))


def fife(answer: dict) -> str:
    return answer["data"]["media"][0]["image"]["generatedImage"]["fifeUrl"]


def test_the_job_gets_the_picture_on_its_own_tile():
    client = Tiles({"job-a": [rendering(10), rendering(80), finished(ID_A)]})

    out = asyncio.run(client.generate_images_ui(
        "olives", "P1", "Nano Banana 2", "9:16", job_id="job-a",
        references=[{"name": "ref-job-a-1"}]))

    assert fife(out) == picture(ID_A)
    sent = client.submits[0]
    assert sent["jobId"] == "job-a" and sent["kind"] == "image"
    assert sent["references"] == [{"name": "ref-job-a-1"}]
    assert sent["reloadFirst"] is False


def test_two_prompts_render_side_by_side_and_each_gets_its_own():
    client = Tiles({
        "job-a": [rendering(10)] * 4 + [finished(ID_A)],
        "job-b": [rendering(10)] * 2 + [finished(ID_B)],
    })

    async def both():
        return await asyncio.gather(
            client.generate_images_ui("a", "P1", job_id="job-a"),
            client.generate_images_ui("b", "P1", job_id="job-b"),
        )

    a, b = asyncio.run(both())

    assert fife(a) == picture(ID_A)
    assert fife(b) == picture(ID_B)
    # The second prompt went in while the first was still rendering.
    assert client.events.index("submit job-b") < client.events.index("look job-a") + 6
    assert client.events.index("submit job-b") > client.events.index("submit job-a")


def test_another_projects_prompt_waits_until_the_first_has_rendered():
    client = Tiles({
        "job-a": [rendering(10)] * 4 + [finished(ID_A)],
        "job-b": [finished(ID_B)],
    })

    async def both():
        first = asyncio.create_task(client.generate_images_ui("a", "P1", job_id="job-a"))
        await _REAL_SLEEP(0)
        return await asyncio.gather(
            first, client.generate_images_ui("b", "P2", job_id="job-b"))

    a, b = asyncio.run(both())

    assert fife(a) == picture(ID_A) and fife(b) == picture(ID_B)
    # The tab stayed on P1 until its picture was there.
    assert client.events.index("submit job-b") > max(
        i for i, e in enumerate(client.events) if e == "look job-a")


def test_a_reference_uploaded_beside_the_page_reloads_it_first():
    client = Tiles({"job-a": [finished(ID_A)]})

    asyncio.run(client.generate_images_ui(
        "a", "P1", job_id="job-a", references=[{"name": "ref-1", "uploaded": True}]))

    assert client.submits[0]["reloadFirst"] is True


def test_tiles_not_found_falls_back_to_one_at_a_time():
    client = Tiles({}, submit={"ok": True, "submitted": True, "tiles": 0},
                   listings=[[], [GeneratedImage(media_id=ID_A, url=picture(ID_A))]])
    client.ui_page_state = lambda: _REAL_SLEEP(0, result={})
    client.ui_page_errors = lambda *a, **k: _REAL_SLEEP(0, result=[])

    out = asyncio.run(client.generate_images_ui("a", "P1", job_id="job-a"))

    assert fife(out) == picture(ID_A)
    assert client.tiles_unreliable is True


def test_a_submit_dropped_without_a_word_reloads_the_tab_before_the_next():
    client = Tiles({"job-a": [BLANK], "job-b": [finished(ID_B)]})

    first = asyncio.run(client.generate_images_ui("a", "P1", job_id="job-a"))
    second = asyncio.run(client.generate_images_ui("b", "P1", job_id="job-b"))

    assert first["error"].startswith("SILENT_FAILURE")
    assert client.submits[1]["reloadFirst"] is True
    assert fife(second) == picture(ID_B)
    assert client._reload_next is False


def test_a_tile_rendering_is_not_a_silent_failure():
    client = Tiles({"job-a": [rendering(5)] * 30 + [finished(ID_A)]})

    out = asyncio.run(client.generate_images_ui("a", "P1", job_id="job-a"))

    assert fife(out) == picture(ID_A)


def test_flow_words_on_the_tile_fail_the_job_with_its_code():
    failed = dict(BLANK, error="Generation failed: unusual activity, try again later")
    client = Tiles({"job-a": [rendering(30), failed]})

    out = asyncio.run(client.generate_images_ui("a", "P1", job_id="job-a"))

    assert out["error"].startswith("FLOW_UI_ERROR: PUBLIC_ERROR_UNUSUAL_ACTIVITY")


def test_tiles_that_left_the_page_are_followed_in_the_project():
    client = Tiles({"job-a": [rendering(40), None]},
                   listings=[[], [GeneratedImage(media_id=ID_A, url=picture(ID_A))]])

    out = asyncio.run(client.generate_images_ui("a", "P1", job_id="job-a"))

    assert fife(out) == picture(ID_A)


def test_a_clip_is_read_off_its_tile_by_media_id():
    done = {"percent": None, "image": None, "video": None,
            "still": f"https://flow-content.google/image/{CLIP}?thumb=1", "ids": [CLIP]}
    client = Tiles({"job-v": [rendering(20), rendering(70), done]},
                   videos={CLIP: "https://storage.example/clip.mp4"})

    out = asyncio.run(client.generate_ui(
        "a scene", "P1", job_id="job-v", kind="video", model_label="Veo 3.1 - Fast",
        aspect_label="9:16", video_mode="Frames", references=[{"name": "ref-job-v-1"}]))

    assert out == {"status": 200, "media_id": CLIP, "video_url": "https://storage.example/clip.mp4"}
    sent = client.submits[0]
    assert sent["kind"] == "video" and sent["videoMode"] == "Frames"


def test_a_clip_whose_tile_cannot_be_found_is_not_submitted_again():
    client = Tiles({}, submit={"ok": True, "submitted": True, "tiles": 0})

    out = asyncio.run(client.generate_ui("a scene", "P1", job_id="job-v", kind="video"))

    assert out["error"].startswith("VIDEO_NOT_TRACKED")
    assert len(client.submits) == 1


def test_errors_the_worker_retries_and_the_ones_it_does_not():
    from agent.worker.processor import RETRYABLE

    def retried(error):
        return any(marker in error.lower() for marker in RETRYABLE)

    assert retried("SILENT_FAILURE: this prompt's tiles went blank")
    assert retried("the composer would not take it: REFERENCES_NOT_ATTACHED: no picker")
    assert not retried("VIDEO_NOT_TRACKED: Flow took the clip")
    assert not retried("VIDEO_TIMED_OUT: the clip did not finish")


def test_a_clip_whose_tile_left_before_showing_an_id_is_found_in_the_project():
    client = Tiles({"job-v": [None]}, videos={CLIP: "https://v/clip.mp4"})
    client.titles = [{ID_A: "Puppy on rug"}, {ID_A: "Puppy on rug", CLIP: "Puppy brushed"}]

    out = asyncio.run(client.generate_ui("brush", "P1", job_id="job-v", kind="video",
                                         poll_seconds=600))

    assert out == {"status": 200, "media_id": CLIP, "video_url": "https://v/clip.mp4"}
    assert len(client.submits) == 1
