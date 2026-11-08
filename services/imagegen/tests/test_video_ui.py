"""Reel clips made on Flow's own page (VIDEO_USE_UI).

What has to hold: the clip goes through the composer as a Video with the
scene's pictures attached, its tile's clip completes the job, the account's
clip count goes up once it is sent, and a clip that may already have been made
is never sent -- and paid for -- a second time.
"""
import asyncio
import json

import pytest

from agent.db import jobs, schema
from agent.worker import processor

CLIP = {"media_id": "clip-1", "video_url": "https://storage.googleapis.com/x/video/clip-1.mp4"}


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "video.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


class Page:
    """Flow's page as the worker sees it: references found, one clip made."""

    connected = True

    def __init__(self, answer=None, submits=True):
        self.answer = answer if answer is not None else dict(CLIP)
        self.submits = submits
        self.calls: list[dict] = []

    async def generate_ui(self, prompt, project_id, **kw):
        self.calls.append({"prompt": prompt, "project_id": project_id, **kw})
        if self.submits and kw.get("on_submitted"):
            await kw["on_submitted"](["old-1"])
        return self.answer


def run_clip(monkeypatch, page: Page, operation: dict | None = None) -> tuple[dict, list]:
    clips: list[int] = []
    monkeypatch.setattr(processor, "get_flow_client", lambda: page)
    monkeypatch.setattr(processor.accounts, "active_affords_clip", lambda: True)
    monkeypatch.setattr(processor.accounts, "active_project", lambda: "PROJ-1")
    monkeypatch.setattr(processor.accounts, "record_clip", lambda: clips.append(1))
    monkeypatch.setattr(processor.accounts, "note_success", lambda: None)

    async def refs(self, job, project_id, reuse=True, fail_job=True):
        return [{"name": "ref-abc", "uploaded": True}]

    monkeypatch.setattr(processor.WorkerController, "_ui_references", refs)

    async def go():
        job = await jobs.create_video("stir the batter", ["https://x/a.jpg"], "PROJ-1", "VERTICAL")
        if operation is not None:
            await jobs.set_operation(job["id"], operation)
        job = await jobs.get(job["id"])
        await processor.WorkerController()._run_video(job)
        return await jobs.get(job["id"])

    return asyncio.run(go()), clips


def test_a_clip_is_made_on_the_page_and_completes_the_job(monkeypatch):
    page = Page()
    stored, clips = run_clip(monkeypatch, page)
    assert stored["status"] == "COMPLETED"
    assert stored["output_url"] == CLIP["video_url"]
    call = page.calls[0]
    assert call["kind"] == "video"
    assert call["video_mode"] == "Ingredients"
    assert call["aspect_label"] == "9:16"
    assert call["model_label"] == processor.VIDEO_UI_MODEL
    assert call["references"] == [{"name": "ref-abc", "uploaded": True}]
    assert clips == [1]  # counted once it went in


def test_a_clip_already_sent_before_a_restart_is_not_sent_again(monkeypatch):
    page = Page()
    stored, clips = run_clip(monkeypatch, page, operation={"ui_submitted": 1.0, "known": []})
    assert page.calls == []
    assert stored["status"] == "FAILED"
    assert "VIDEO_NOT_TRACKED" in stored["error_message"]
    assert clips == []


def test_a_refusal_on_the_tile_clears_the_mark_so_it_can_be_tried_again(monkeypatch):
    page = Page(answer={"error": "FLOW_UI_ERROR: something went wrong"})
    stored, _ = run_clip(monkeypatch, page)
    assert json.loads(stored.get("operation_json") or "{}") == {}
    assert stored["status"] in ("PENDING", "FAILED")


def test_a_clip_that_timed_out_keeps_its_mark(monkeypatch):
    # It may still be rendering in Flow: trying again would pay for it twice.
    page = Page(answer={"error": "VIDEO_TIMED_OUT: no clip on the tile in 1200s"})
    stored, _ = run_clip(monkeypatch, page)
    assert json.loads(stored["operation_json"]).get("ui_submitted")


def test_a_finished_tile_hands_over_its_own_clip_address():
    # Read off the tile, the way a picture is: the media RPC no longer answers.
    from agent.services.flow_client import FlowClient

    class Client(FlowClient):
        def __init__(self):
            pass

        async def get_media_urls_batch(self, media_id):
            raise AssertionError("the tile's own address is used, not the RPC")

    url = "https://flow-content.google/video/ab12cd34-0000-4000-8000-000000000001?sig=x"
    answer = asyncio.run(Client()._tile_result("video", {"video": url}, set()))
    assert answer == {"status": 200, "media_id": "ab12cd34-0000-4000-8000-000000000001", "video_url": url}
