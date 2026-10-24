"""Finishing a video when the operation poll never says it is finished.

Recorded on the deployed container, every poll, for fifteen minutes:

    [None, 40, [['bafe318d-…', None, None, None, None,
                 [None, …, [4, [None, 'Media not found.'], ['Media not found.']]]]]]

No status in the slot, only a complaint -- while the finished clip was visible
in the Flow project the whole time. The worker waited on a signal that was
never going to come and the reel sat on "generating".

So the project listing is the done-signal when the poll has none.
"""
import asyncio

import pytest

from agent.db import jobs, schema
from agent.worker import processor
from agent.worker.processor import WorkerController

OP = "bafe318d-0162-4a4c-8a53-f44705180a2b"
PROJECT = "05680afb-489c-48b5-a966-d6f2a08546f7"

NO_STATUS = {"done": False, "status": None, "complaint": "Media not found.",
             "raw": "[None, 40, [['bafe318d-…', None, None, None, None, …]]]"}


class FakeClient:
    """The container's answers, scripted."""

    def __init__(self, listing_after: int, video_url="https://storage.googleapis.com/v/clip.mp4"):
        self.polls = 0
        self.listing_reads = 0
        self.listing_after = listing_after  # the listing shows the clip from this read on
        self.video_url = video_url

    async def check_operation_batch(self, operation_id):
        self.polls += 1
        return dict(NO_STATUS)

    async def find_operation_media_batch(self, operation_id, project_id):
        self.listing_reads += 1
        assert operation_id == OP and project_id == PROJECT
        if self.listing_reads >= self.listing_after:
            return {"media_id": "MEDIA-1"}
        return {"media_id": None}

    async def get_media_urls_batch(self, media_id):
        return {"video_url": self.video_url, "image_url": None}


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


@pytest.fixture
def no_waiting(monkeypatch):
    async def instant(_seconds):
        return None

    monkeypatch.setattr(processor.asyncio, "sleep", instant)


def run(monkeypatch, client):
    monkeypatch.setattr(processor, "get_flow_client", lambda: client)
    job = asyncio.run(jobs.create("a reel"))
    asyncio.run(jobs.claim_pending(1))
    asyncio.run(WorkerController()._await_video_batch(job, OP, PROJECT))
    return asyncio.run(jobs.get(job["id"]))


def test_a_video_the_poll_never_reports_is_taken_from_the_project(monkeypatch, no_waiting):
    client = FakeClient(listing_after=1)

    job = run(monkeypatch, client)

    assert job["status"] == "COMPLETED"
    assert job["media_id"] == "MEDIA-1"
    assert job["output_url"] == "https://storage.googleapis.com/v/clip.mp4"


def test_the_listing_is_read_once_a_minute_not_every_poll(monkeypatch, no_waiting):
    # The listing is the whole project; the poll is fifteen seconds.
    client = FakeClient(listing_after=3)

    run(monkeypatch, client)

    assert client.listing_reads == 3
    assert client.polls == 3 * processor.LISTING_EVERY_N_POLLS


def test_a_clip_still_rendering_is_waited_for(monkeypatch, no_waiting):
    """In the listing, but with no video url yet: not finished, not failed."""
    client = FakeClient(listing_after=1)
    answers = iter([None, None, "https://storage.googleapis.com/v/clip.mp4"])

    async def urls(media_id):
        return {"video_url": next(answers), "image_url": None}

    client.get_media_urls_batch = urls

    job = run(monkeypatch, client)

    assert job["status"] == "COMPLETED"


def test_a_video_that_never_appears_fails_after_the_full_wait(monkeypatch, no_waiting):
    monkeypatch.setattr(processor, "VIDEO_MAX_POLLS", 8)
    client = FakeClient(listing_after=10**6)

    job = run(monkeypatch, client)

    assert job["status"] in ("FAILED", "PENDING")  # handed to _handle_failure
    assert client.polls == 8


def test_a_video_never_in_the_project_gives_up_early_and_switches_account(monkeypatch, no_waiting):
    """One account took every request and made nothing; the others made a clip a minute."""
    client = FakeClient(listing_after=10**6)
    rotated = []
    monkeypatch.setattr(processor.accounts, "rotate", lambda problem, kind=None: rotated.append(problem) or 3)

    job = run(monkeypatch, client)

    assert rotated, "the account should be switched"
    assert job["status"] == "PENDING"  # back in line for the next account
    assert client.polls * processor.VIDEO_POLL_INTERVAL <= processor.VIDEO_LISTING_GIVEUP_S + 60


def test_with_no_other_account_it_fails_with_a_clear_message(monkeypatch, no_waiting):
    client = FakeClient(listing_after=10**6)
    monkeypatch.setattr(processor.accounts, "rotate", lambda problem, kind=None: None)

    job = run(monkeypatch, client)

    assert job["status"] == "FAILED"
    assert "nothing appeared in the project" in job["error_message"]
    assert client.polls < processor.VIDEO_MAX_POLLS


def test_a_video_flow_reports_on_is_not_cut_short(monkeypatch, no_waiting):
    """When Flow does say it is working, believe it for the whole budget."""
    monkeypatch.setattr(processor, "VIDEO_MAX_POLLS", 40)
    client = FakeClient(listing_after=10**6)

    async def pending(operation_id):
        client.polls += 1
        return {"done": False, "status": "MEDIA_GENERATION_STATUS_PENDING"}

    client.check_operation_batch = pending
    monkeypatch.setattr(processor.accounts, "rotate", lambda problem, kind=None: pytest.fail("must not rotate"))

    run(monkeypatch, client)

    assert client.polls == 40
