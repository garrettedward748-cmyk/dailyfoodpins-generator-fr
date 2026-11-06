"""The Gemini prompt queue and its two routers.

What has to hold, in the order it would hurt to lose it:

  * a prompt holds Chrome up from the moment it is queued until it is answered or given up on,
    and lets go exactly once -- otherwise the idle stop takes the browser away mid-answer, or
    Chrome never stops again;
  * a hand-off lost in transit is queued again within seconds, not after the whole timeout;
  * only the browser beside the agent can take prompts, and only the platform can send them;
  * Gemini failures stay out of the image job table (nothing here touches it).
"""
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent import chrome, gemini
from agent.api import gemini as gemini_api


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    """A new queue, a Chrome counter at zero, and no real supervisorctl."""
    monkeypatch.setattr(gemini, "_queue", None)
    monkeypatch.setattr(chrome, "_users", 0)
    monkeypatch.setattr(chrome, "_idle_since", None)
    started = []

    async def ensure_running(reason):
        started.append(reason)

    monkeypatch.setattr(chrome, "ensure_running", ensure_running)
    return started


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(gemini, "time", types.SimpleNamespace(monotonic=c))
    return c


def client(loopback=True, api_key=""):
    from agent import auth

    auth.API_KEY = api_key
    app = FastAPI()
    app.include_router(gemini_api.platform)
    app.include_router(gemini_api.extension)
    if loopback:
        app.dependency_overrides[gemini_api.loopback_only] = lambda: None
    return TestClient(app)


# --- the round trip ---------------------------------------------------------

def test_a_prompt_goes_to_the_extension_and_its_reply_comes_back(fresh):
    with client() as c:
        sent = c.post("/v1/gemini/jobs", json={"prompt": "Hello", "account": " me@example.com "})
        assert sent.status_code == 202
        job_id = sent.json()["id"]
        assert sent.json()["status"] == "queued"
        assert fresh == ["a Gemini prompt"]  # Chrome is started at once, not on the next pass

        taken = c.get("/ext/gemini/poll").json()["job"]
        assert taken["id"] == job_id
        assert taken["payload"]["prompt"] == "Hello"
        assert taken["payload"]["account"] == "me@example.com"
        assert taken["payload"]["temporary"] is True
        assert c.get(f"/v1/gemini/jobs/{job_id}").json()["status"] == "running"

        reply = {"text": "Hi!", "markdown": "Hi!", "code_blocks": [], "images": []}
        assert c.post("/ext/gemini/result", json={"id": job_id, "ok": True, "result": reply}).json() == {"ok": True}
        done = c.get(f"/v1/gemini/jobs/{job_id}").json()
        assert done == {"id": job_id, "status": "done", "result": reply, "error": None}
        assert c.get("/v1/gemini/status").json()["last_success_at"]


def test_a_failure_from_the_page_is_reported_with_its_reason():
    with client() as c:
        job_id = c.post("/v1/gemini/jobs", json={"prompt": "Hello"}).json()["id"]
        c.get("/ext/gemini/poll")
        c.post("/ext/gemini/result", json={"id": job_id, "ok": False, "error": "NOT_SIGNED_IN: sign in"})
        assert c.get(f"/v1/gemini/jobs/{job_id}").json()["error"] == "NOT_SIGNED_IN: sign in"
        assert c.get("/v1/gemini/status").json()["last_error"] == "NOT_SIGNED_IN: sign in"


def test_files_travel_with_the_prompt_and_an_empty_request_is_refused():
    with client() as c:
        assert c.post("/v1/gemini/jobs", json={"prompt": "  "}).status_code == 422
        sent = c.post("/v1/gemini/jobs", json={"files": [{"name": "a.png", "mime": "image/png", "base64": "iVBORw0KGgo="}]})
        assert sent.status_code == 202
        payload = c.get("/ext/gemini/poll").json()["job"]["payload"]
        assert payload["files"] == [{"name": "a.png", "mime": "image/png", "base64": "iVBORw0KGgo="}]


def test_a_reply_for_an_unknown_or_finished_prompt_changes_nothing():
    with client() as c:
        assert c.post("/ext/gemini/result", json={"id": "nope", "ok": True, "result": {}}).json() == {"ok": False}
        assert c.get("/v1/gemini/jobs/nope").status_code == 404


def test_the_extension_hears_nothing_when_nothing_is_queued(monkeypatch):
    monkeypatch.setattr(gemini_api, "POLL_WAIT_S", 0)
    with client() as c:
        assert c.get("/ext/gemini/poll").status_code == 204
        assert c.get("/v1/gemini/status").json()["extension_connected"] is True


# --- who may call what --------------------------------------------------------

def test_only_the_browser_beside_the_agent_takes_prompts():
    with client(loopback=False) as c:
        assert c.get("/ext/gemini/poll").status_code == 403
        assert c.post("/ext/gemini/result", json={"id": "x", "ok": True}).status_code == 403


def test_the_platform_side_needs_the_api_key():
    with client(api_key="secret") as c:
        assert c.post("/v1/gemini/jobs", json={"prompt": "Hello"}).status_code == 401
        ok = c.post("/v1/gemini/jobs", json={"prompt": "Hello"}, headers={"X-API-Key": "secret"})
        assert ok.status_code == 202
    from agent import auth
    auth.API_KEY = ""


# --- Chrome is held, and let go exactly once ----------------------------------

def test_chrome_is_held_while_a_prompt_waits_and_released_when_it_is_answered():
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=300)
    assert chrome._users == 1
    q.finish(job.id, True, {"text": "y"})
    assert chrome._users == 0
    q.finish(job.id, True, {"text": "again"})  # a second answer must not release twice
    assert chrome._users == 0


async def test_a_lost_hand_off_is_queued_again_within_the_lease(clock):
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=300)
    assert (await q.next_job(0)).id == job.id

    clock.now += gemini.LEASE_S - 1
    q.sweep()
    assert job.status == "running"  # still inside the lease

    clock.now += 2
    q.sweep()
    assert job.status == "queued"
    again = await q.next_job(0)
    assert again.id == job.id and again.deliveries == 2
    assert chrome._users == 1  # still held: the prompt is not finished


async def test_heartbeats_keep_a_long_answer_from_being_handed_out_twice(clock):
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=600)
    await q.next_job(0)
    for _ in range(10):
        clock.now += gemini.LEASE_S - 5
        assert q.beat(job.id)
        q.sweep()
    assert job.status == "running" and job.deliveries == 1


async def test_a_prompt_handed_out_too_often_is_failed(clock):
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=3600)
    for _ in range(gemini.MAX_DELIVERIES):
        await q.next_job(0)
        clock.now += gemini.LEASE_S + 1
        q.sweep()
    assert job.status == "failed"
    assert job.error.startswith("TIMEOUT")
    assert chrome._users == 0


def test_an_overdue_prompt_fails_and_lets_chrome_go(clock):
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=60)
    clock.now += 61
    q.sweep()
    assert job.status == "failed" and job.error.startswith("TIMEOUT")
    assert chrome._users == 0
    assert q.status()["last_error"].startswith("TIMEOUT")


def test_old_answers_are_forgotten(clock):
    q = gemini.get_queue()
    job = q.submit({"prompt": "x"}, timeout_s=60)
    q.finish(job.id, True, {})
    clock.now += gemini.KEEP_FINISHED_S + 1
    q.sweep()
    assert q.get(job.id) is None


def test_the_extension_counts_as_gone_when_it_stops_polling(clock):
    q = gemini.get_queue()
    assert q.status()["extension_connected"] is False
    q.beat("none")  # any contact counts
    assert q.status()["extension_connected"] is True
    clock.now += gemini.EXTENSION_ALIVE_S + 1
    assert q.status()["extension_connected"] is False
