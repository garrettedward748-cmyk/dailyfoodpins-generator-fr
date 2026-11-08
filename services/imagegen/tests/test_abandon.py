"""Queued jobs nobody waits for any more are not made.

The platform asks about a job while it waits for it. A job left in the queue
after its article gave up, or after automation was switched off, was still
made hours later -- credits and Flow's patience spent on a picture nobody
used. Such a job is failed instead; one someone is still asking about, and one
already in Flow, are left alone.
"""
import asyncio

import pytest

from agent.db import jobs, schema


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "abandon.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


async def age(job_id: str, minutes: int, polled_minutes_ago: int | None = None) -> None:
    db = await schema.get_db()
    await db.execute(
        "UPDATE job SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?",
        (f"-{minutes} minutes", job_id))
    if polled_minutes_ago is not None:
        await db.execute(
            "UPDATE job SET last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?",
            (f"-{polled_minutes_ago} minutes", job_id))
    await db.commit()


def test_an_old_job_nobody_asks_about_is_not_made():
    async def go():
        old = await jobs.create("forgotten soup")
        await age(old["id"], 45)
        fresh = await jobs.create("soup someone waits for")
        dropped = await jobs.abandon_unwatched(20)
        return dropped, await jobs.get(old["id"]), await jobs.get(fresh["id"])

    dropped, old, fresh = asyncio.run(go())
    assert dropped == [old["id"]]
    assert old["status"] == "FAILED" and old["error_message"].startswith("ABANDONED")
    assert fresh["status"] == "PENDING"


def test_a_job_asked_about_lately_stays_in_the_queue_however_old():
    async def go():
        job = await jobs.create("long queue")
        await age(job["id"], 90, polled_minutes_ago=2)
        dropped = await jobs.abandon_unwatched(20)
        return dropped, await jobs.get(job["id"])

    dropped, job = asyncio.run(go())
    assert dropped == []
    assert job["status"] == "PENDING"


def test_asking_about_a_job_marks_it_watched():
    async def go():
        job = await jobs.create("polled")
        await age(job["id"], 45)
        await jobs.mark_polled(job["id"])
        return await jobs.abandon_unwatched(20)

    assert asyncio.run(go()) == []


def test_a_job_already_in_flow_is_left_to_finish_and_zero_keeps_everything():
    async def go():
        running = await jobs.create("in flow")
        await jobs.claim_pending(1)
        await age(running["id"], 45)
        waiting = await jobs.create("kept")
        await age(waiting["id"], 45)
        return (await jobs.abandon_unwatched(20), await jobs.abandon_unwatched(0),
                await jobs.get(running["id"]))

    dropped, none, running = asyncio.run(go())
    assert running["status"] == "PROCESSING"
    assert len(dropped) == 1 and dropped[0] != running["id"]
    assert none == []
