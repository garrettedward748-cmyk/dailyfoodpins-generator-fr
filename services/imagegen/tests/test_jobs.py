"""The job table and the /v1 surface the platform talks to."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from agent import chrome
from agent.db import jobs, schema


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    """A throwaway database per test, and a clean connection cache around it."""
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


def test_a_new_job_starts_pending():
    job = asyncio.run(jobs.create("a bowl of soup"))
    assert job["status"] == "PENDING"
    assert job["prompt"] == "a bowl of soup"
    assert job["orientation"] == "VERTICAL"
    assert job["attempts"] == 0
    assert job["output_url"] is None


def test_claiming_moves_a_job_to_processing_and_counts_the_attempt():
    asyncio.run(jobs.create("one"))

    claimed = asyncio.run(jobs.claim_pending(5))

    assert len(claimed) == 1
    assert claimed[0]["status"] == "PROCESSING"
    assert claimed[0]["attempts"] == 1


def test_a_claimed_job_is_not_handed_out_twice():
    # The whole point of claiming in a single statement: generating the same
    # image twice costs real Flow credits.
    asyncio.run(jobs.create("one"))

    first = asyncio.run(jobs.claim_pending(5))
    second = asyncio.run(jobs.claim_pending(5))

    assert len(first) == 1
    assert second == []


def test_claiming_respects_the_limit_and_takes_the_oldest_first():
    for prompt in ("first", "second", "third"):
        asyncio.run(jobs.create(prompt))

    claimed = asyncio.run(jobs.claim_pending(2))

    assert [j["prompt"] for j in claimed] == ["first", "second"]


def test_completing_records_the_url_and_clears_any_earlier_error():
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.requeue(job["id"], "a transient blip"))

    asyncio.run(jobs.complete(job["id"], "media-1", "https://cdn/img.webp"))

    stored = asyncio.run(jobs.get(job["id"]))
    assert stored["status"] == "COMPLETED"
    assert stored["output_url"] == "https://cdn/img.webp"
    assert stored["media_id"] == "media-1"
    assert stored["error_message"] is None


def test_failing_records_the_reason():
    job = asyncio.run(jobs.create("one"))

    asyncio.run(jobs.fail(job["id"], "HTTP 500 from Google"))

    stored = asyncio.run(jobs.get(job["id"]))
    assert stored["status"] == "FAILED"
    assert stored["error_message"] == "HTTP 500 from Google"


def test_requeueing_returns_a_job_to_the_queue():
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.claim_pending(1))

    asyncio.run(jobs.requeue(job["id"], "rate limited"))

    assert asyncio.run(jobs.get(job["id"]))["status"] == "PENDING"
    assert len(asyncio.run(jobs.claim_pending(1))) == 1


def test_a_requeued_job_keeps_counting_attempts():
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.claim_pending(1))
    asyncio.run(jobs.requeue(job["id"], "rate limited"))
    asyncio.run(jobs.claim_pending(1))

    assert asyncio.run(jobs.get(job["id"]))["attempts"] == 2


def backdate(job_id: str, seconds: int) -> None:
    """Age a row, so staleness can be tested without waiting for it."""

    async def go():
        db = await schema.get_db()
        await db.execute(
            "UPDATE job SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?",
            (f"-{seconds} seconds", job_id),
        )
        await db.commit()

    asyncio.run(go())


def test_stale_processing_jobs_are_requeued():
    # A job only reaches PROCESSING inside the worker, so one still sitting
    # there long afterwards means the process died holding it.
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.claim_pending(1))
    backdate(job["id"], 3600)

    assert asyncio.run(jobs.reset_stale(600)) == 1
    assert asyncio.run(jobs.get(job["id"]))["status"] == "PENDING"


def test_fresh_processing_jobs_are_left_alone():
    asyncio.run(jobs.create("one"))
    claimed = asyncio.run(jobs.claim_pending(1))

    assert asyncio.run(jobs.reset_stale(600)) == 0
    assert asyncio.run(jobs.get(claimed[0]["id"]))["status"] == "PROCESSING"


def test_a_job_that_is_still_being_polled_is_not_requeued():
    """A video is polled for up to twenty minutes; the stale cutoff is ten.

    Without a pulse, the job was handed back to the queue at ten minutes with
    its poll loop still running, claimed again, and submitted again -- a second
    video, paid for, exactly ten minutes after the first. Two submits ten
    minutes apart in the extension's log is this bug and nothing else.
    """
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.claim_pending(1))
    backdate(job["id"], 3600)  # looks abandoned...

    asyncio.run(jobs.touch(job["id"]))  # ...but the poll loop just checked in

    assert asyncio.run(jobs.reset_stale(600)) == 0
    assert asyncio.run(jobs.get(job["id"]))["status"] == "PROCESSING"


def test_touching_a_finished_job_changes_nothing():
    # Only a PROCESSING job has a pulse worth keeping. A completed one must not
    # be dragged back into looking live.
    job = asyncio.run(jobs.create("one"))
    asyncio.run(jobs.claim_pending(1))
    asyncio.run(jobs.complete(job["id"], "MEDIA", "https://example/v.mp4"))
    backdate(job["id"], 3600)
    before = asyncio.run(jobs.get(job["id"]))["updated_at"]

    asyncio.run(jobs.touch(job["id"]))

    assert asyncio.run(jobs.get(job["id"]))["updated_at"] == before


def test_unknown_job_id_returns_nothing():
    assert asyncio.run(jobs.get("no-such-id")) is None


def test_orientation_is_constrained_by_the_schema():
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        asyncio.run(jobs.create("one", "DIAGONAL"))


def test_recent_finished_is_newest_first_and_excludes_unfinished():
    done = asyncio.run(jobs.create("done"))
    asyncio.run(jobs.complete(done["id"], "m", "https://cdn/a.webp"))
    broken = asyncio.run(jobs.create("broken"))
    asyncio.run(jobs.fail(broken["id"], "boom"))
    asyncio.run(jobs.create("still waiting"))

    recent = asyncio.run(jobs.recent_finished(10))

    assert {j["prompt"] for j in recent} == {"done", "broken"}


def test_counts_group_by_status():
    asyncio.run(jobs.create("pending one"))
    second = asyncio.run(jobs.create("failed one"))
    asyncio.run(jobs.fail(second["id"], "boom"))

    assert asyncio.run(jobs.count_by_status()) == {"PENDING": 1, "FAILED": 1}


# --- The HTTP surface ----------------------------------------------------

def build_client(monkeypatch, *, connected=True, project_id="PROJ-1") -> TestClient:
    """A TestClient over just the /v1 router, with the browser side faked."""
    from fastapi import FastAPI

    from agent.api import v1
    from agent.services import flow_client as flow_client_module

    class FakeClient:
        connected = False

    fake = FakeClient()
    fake.connected = connected

    monkeypatch.setattr(v1, "FLOW_PROJECT_ID", project_id)
    monkeypatch.setattr(flow_client_module, "get_flow_client", lambda: fake)
    monkeypatch.setattr(v1, "get_flow_client", lambda: fake)

    app = FastAPI()
    app.include_router(v1.router)
    return TestClient(app)


def test_generate_returns_202_and_a_job_id(monkeypatch):
    response = build_client(monkeypatch).post("/v1/generate", json={"prompt": "soup"})

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "PENDING"
    assert body["job_id"]


def test_generate_is_refused_when_a_running_browser_has_no_extension(monkeypatch):
    monkeypatch.setattr(chrome, "_wanted_running", True)
    response = build_client(monkeypatch, connected=False).post(
        "/v1/generate", json={"prompt": "soup"}
    )

    # Chrome is up and the extension still is not there. Waiting does not fix
    # that, and queueing work that cannot move leaves the caller polling forever.
    assert response.status_code == 503
    assert "extension" in response.json()["detail"].lower()


def test_generate_is_queued_while_chrome_is_asleep(monkeypatch):
    """A stopped browser is the normal idle state, not a fault.

    Chrome runs only while there is work, so between jobs the extension is not
    connected -- and refusing on that is a deadlock: nothing can be queued
    without a browser, and no browser starts without something queued. Three
    generate calls were lost to it on the deployed container, and generation
    only recovered when someone opened the Browser page and started Chrome by
    hand.

    The job is queued instead. The worker reads the queue rather than what it
    has claimed, so a PENDING job is exactly what starts the browser.
    """
    monkeypatch.setattr(chrome, "_wanted_running", False)
    response = build_client(monkeypatch, connected=False).post(
        "/v1/generate", json={"prompt": "soup"}
    )

    assert response.status_code == 202
    assert response.json()["status"] == "PENDING"


def test_generate_is_refused_without_a_flow_project_id(monkeypatch):
    response = build_client(monkeypatch, project_id="").post(
        "/v1/generate", json={"prompt": "soup"}
    )

    assert response.status_code == 503
    assert "project id" in response.json()["detail"].lower()


def test_an_empty_prompt_is_rejected(monkeypatch):
    assert build_client(monkeypatch).post("/v1/generate", json={"prompt": ""}).status_code == 422


def test_polling_an_unknown_job_is_a_404(monkeypatch):
    assert build_client(monkeypatch).get("/v1/jobs/nope").status_code == 404


def test_polling_a_fresh_job_reports_pending_with_no_url(monkeypatch):
    client = build_client(monkeypatch)
    job_id = client.post("/v1/generate", json={"prompt": "soup"}).json()["job_id"]

    body = client.get(f"/v1/jobs/{job_id}").json()

    assert body["status"] == "PENDING"
    assert body["image_url"] is None
    assert body["prompt"] == "soup"


def test_a_completed_job_exposes_its_url_and_expiry(monkeypatch):
    client = build_client(monkeypatch)
    job_id = client.post("/v1/generate", json={"prompt": "soup"}).json()["job_id"]
    asyncio.run(
        jobs.complete(job_id, "media-1", "https://cdn/img.webp?Expires=1800000000&sig=x")
    )

    body = client.get(f"/v1/jobs/{job_id}").json()

    assert body["status"] == "COMPLETED"
    assert body["image_url"].startswith("https://cdn/img.webp")
    # Surfacing the deadline is how a caller learns to download now rather than
    # meeting a 403 tomorrow.
    assert body["image_expires_at"] == 1800000000


def test_a_url_without_an_expiry_reports_none(monkeypatch):
    client = build_client(monkeypatch)
    job_id = client.post("/v1/generate", json={"prompt": "soup"}).json()["job_id"]
    asyncio.run(jobs.complete(job_id, "media-1", "https://cdn/img.webp"))

    assert client.get(f"/v1/jobs/{job_id}").json()["image_expires_at"] is None


def test_a_failed_job_surfaces_its_error(monkeypatch):
    client = build_client(monkeypatch)
    job_id = client.post("/v1/generate", json={"prompt": "soup"}).json()["job_id"]
    asyncio.run(jobs.fail(job_id, "quota exhausted"))

    body = client.get(f"/v1/jobs/{job_id}").json()

    # The platform's ImageClient treats FAILED as terminal; the old n8n loop
    # took the false branch and polled a dead job forever.
    assert body["status"] == "FAILED"
    assert body["error"] == "quota exhausted"


def test_a_video_job_keeps_the_presenter_it_was_asked_for(fresh_db):
    job = asyncio.run(jobs.create_video("soup", ["https://a/1.jpg"], "P", "VERTICAL",
                                        character_media_id="f346cb5a-ec29-4143-a87d-b13d70729bf5",
                                        voice_media_id="509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"))
    assert job["character_media_id"] == "f346cb5a-ec29-4143-a87d-b13d70729bf5"
    assert job["voice_media_id"] == "509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"
    plain = asyncio.run(jobs.create_video("soup", ["https://a/1.jpg"], "P", "VERTICAL"))
    assert plain["character_media_id"] is None and plain["voice_media_id"] is None


# ─── Claiming only the kinds the active account is ticked for ──

def test_claim_can_be_limited_to_certain_kinds():
    asyncio.run(jobs.create("an image"))
    asyncio.run(jobs.create_video("a clip", []))

    only_images = asyncio.run(jobs.claim_pending(5, kinds=["image"]))

    assert len(only_images) == 1
    assert only_images[0]["kind"] == "image"
    # the video is left waiting for a video-capable account
    assert asyncio.run(jobs.oldest_pending_kind()) == "video"


def test_an_empty_kinds_list_claims_nothing():
    asyncio.run(jobs.create("an image"))
    assert asyncio.run(jobs.claim_pending(5, kinds=[])) == []


def test_no_kinds_filter_claims_any_kind():
    asyncio.run(jobs.create("an image"))
    asyncio.run(jobs.create_video("a clip", []))
    assert len(asyncio.run(jobs.claim_pending(5))) == 2


def test_oldest_pending_kind_is_none_when_nothing_waits():
    assert asyncio.run(jobs.oldest_pending_kind()) is None


def test_failing_the_pending_jobs_of_a_kind_leaves_the_others():
    asyncio.run(jobs.create("an image"))
    asyncio.run(jobs.create_video("clip one", []))
    asyncio.run(jobs.create_video("clip two", []))

    n = asyncio.run(jobs.fail_pending_of_kind("video", "no video account"))

    assert n == 2
    # the image is untouched and still claimable
    claimed = asyncio.run(jobs.claim_pending(5))
    assert [c["kind"] for c in claimed] == ["image"]
