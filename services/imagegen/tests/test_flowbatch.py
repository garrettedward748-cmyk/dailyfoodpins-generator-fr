"""Flow Batch: the second way of making an image, chosen on the Google accounts page.

Pinned here: the method is stored and read back in order (with a fallback
second), the queue hands a prompt to the extension and returns its answer, a
missing extension fails fast instead of waiting out the timeout, and the image
the job gets is the new one Flow Batch saw on its tile -- in the shape the
worker already reads.
"""
import asyncio
import time

import pytest

from agent import accounts, flowbatch, gemini
from agent.services.flow_batch import GeneratedImage
from agent.services.flow_client import FlowClient

_REAL_SLEEP = asyncio.sleep


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "STATE_FILE", tmp_path / "accounts.json")
    monkeypatch.setattr(accounts, "ACTIVE_POINTER", tmp_path / "active-profile-dir")
    monkeypatch.setattr(accounts, "EXTRA_PROFILES", tmp_path / "chrome-profiles")
    monkeypatch.setattr(accounts, "FIRST_PROFILE", tmp_path / "chrome-profile")
    yield tmp_path


# ─── the setting ────────────────────────────────────────────────

def test_flow_kit_is_the_default_so_nothing_changes_until_someone_picks():
    assert accounts.image_method() == "flowkit"
    assert accounts.image_methods_in_order() == ["flowkit"]
    assert accounts.list_accounts()["image_method"] == "flowkit"


def test_a_fallback_choice_is_two_methods_in_order():
    accounts.set_image_method("flowbatch_then_flowkit")
    assert accounts.image_methods_in_order() == ["flowbatch", "flowkit"]
    accounts.set_image_method("flowkit_then_flowbatch")
    assert accounts.image_methods_in_order() == ["flowkit", "flowbatch"]


def test_an_unknown_method_is_refused():
    with pytest.raises(ValueError):
        accounts.set_image_method("both")
    assert accounts.image_method() == "flowkit"


# ─── the queue ──────────────────────────────────────────────────

def test_a_prompt_goes_to_the_extension_and_its_answer_comes_back(monkeypatch):
    monkeypatch.setattr(gemini.chrome, "hold", lambda: None)
    monkeypatch.setattr(gemini.chrome, "release", lambda: None)
    q = flowbatch.FlowBatchQueue()

    async def scenario():
        async def extension():
            job = await q.next_job(5)
            assert job.payload["prompt"] == "olives"
            q.finish(job.id, True, {"sources": ["https://x/abc"]})

        q.last_poll = time.monotonic()  # the extension is polling
        task = asyncio.create_task(extension())
        answer = await q.run({"prompt": "olives"}, 30)
        await task
        return answer

    answer = asyncio.run(scenario())
    assert answer == {"ok": True, "result": {"sources": ["https://x/abc"]}}


def test_no_extension_fails_fast_with_a_reason(monkeypatch):
    monkeypatch.setattr(flowbatch, "CONNECT_WAIT_S", 0)
    q = flowbatch.FlowBatchQueue()
    answer = asyncio.run(q.run({"prompt": "olives"}, 30))
    assert answer["error"].startswith("NO_EXTENSION")
    assert not q.jobs  # nothing was queued for an extension that is not there


# ─── reading the result off the project ─────────────────────────

def image(n: str) -> GeneratedImage:
    return GeneratedImage(media_id=n, url=f"https://flow-content.google/image/{n}?sig=x")


class Fake(FlowClient):
    def __init__(self, listings, answer):
        self._listings = list(listings)
        self._answer = answer
        self.sent: list[dict] = []

    async def project_images(self, project_id: str):
        return self._listings.pop(0) if len(self._listings) > 1 else self._listings[0]

    async def flowbatch_run(self, payload: dict, timeout_s: float) -> dict:
        self.sent.append(payload)
        return self._answer


def run(client, **kw):
    return asyncio.run(client.generate_images_flowbatch("a bowl of olives", "PROJ-1", **kw))


def test_the_image_flow_batch_saw_on_its_tile_is_the_one_the_job_gets(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake(
        [[image("old")], [image("other"), image("ours"), image("old")]],
        {"ok": True, "result": {"sources": ["https://flow-content.google/image/ours?w=512"]}},
    )

    out = run(client, aspect_ratio="16:9", model="Nano Banana Pro")

    assert client.sent[0]["projectId"] == "PROJ-1"
    assert client.sent[0]["aspectRatio"] == "16:9"
    assert client.sent[0]["model"] == "Nano Banana Pro"
    media = out["data"]["media"][0]
    assert media["name"] == "ours"
    assert media["image"]["generatedImage"]["fifeUrl"].endswith("ours?sig=x")


def test_with_no_tile_address_the_first_new_image_is_taken(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")], [image("new"), image("old")]], {"ok": True, "result": {}})
    assert run(client)["data"]["media"][0]["name"] == "new"


def test_an_extension_error_is_the_jobs_error(monkeypatch):
    client = Fake([[image("old")]], {"error": "Generate stayed disabled"})
    out = run(client)
    assert out["error"] == "Flow Batch: Generate stayed disabled"


def test_finished_but_nothing_new_in_the_project_is_an_error(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]], {"ok": True, "result": {}})
    out = run(client, poll_seconds=0)
    assert "no new image" in out["error"]
