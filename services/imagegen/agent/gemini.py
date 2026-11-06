"""Gemini prompts: a small queue the Gemini Chat extension works through.

The platform posts a prompt, the extension (in this container's Chrome, signed in to the same
Google account as Flow) long-polls for it, runs it in Gemini's own page and posts the reply back.

Kept apart from the image job table on purpose. The watchdog's failure breaker, the
unusual-activity hold and the worker's pause all read that table, and a Gemini session that needs
signing in again must not stop pictures being made -- nor a Flow hold stop Gemini answering.

In memory rather than in SQLite: a prompt is answered in seconds to minutes while the platform
waits for it, and one lost to a restart costs nothing -- the platform falls back to its usual model.

Chrome is claimed with the same counter image jobs use (agent/chrome.py), from the moment a prompt
is queued until it is answered or given up on, so the idle stop never takes the browser away from
a prompt and a prompt alone is enough to start one.
"""
import asyncio
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from agent import chrome

logger = logging.getLogger(__name__)

#: A prompt handed out with no heartbeat for this long goes back in the queue. The extension beats
#: every 5 s while it works, so this only fires when the hand-off itself was lost (the long-poll
#: answer never arrived) -- without it that prompt would wait out its whole timeout.
LEASE_S = 20

#: How many times one prompt may be handed out before it is failed instead of re-queued.
MAX_DELIVERIES = 3

#: The extension polls at least every POLL_WAIT_S; quieter than this, it is not there.
EXTENSION_ALIVE_S = 45

#: How long a long-poll waits for a prompt before answering "nothing".
POLL_WAIT_S = 25

#: Finished prompts are kept this long so a late poll from the platform still finds the answer.
KEEP_FINISHED_S = 3600

QUEUED, RUNNING, DONE, FAILED = "queued", "running", "done", "failed"


@dataclass
class GeminiJob:
    id: str
    payload: dict
    deadline: float
    status: str = QUEUED
    result: Optional[dict] = None
    error: Optional[str] = None
    last_beat: float = 0.0
    deliveries: int = 0
    finished_at: float = 0.0
    holds_chrome: bool = False

    def public(self) -> dict:
        return {"id": self.id, "status": self.status, "result": self.result, "error": self.error}


class GeminiQueue:
    def __init__(self) -> None:
        self.jobs: dict[str, GeminiJob] = {}
        self._order: deque[str] = deque()
        self._wakeup = asyncio.Event()
        self.last_poll = 0.0
        self.last_success_at: Optional[str] = None
        self.last_error: Optional[str] = None

    # -- the platform's side ------------------------------------------------

    def submit(self, payload: dict, timeout_s: float) -> GeminiJob:
        job = GeminiJob(id=str(uuid.uuid4()), payload=payload, deadline=time.monotonic() + timeout_s)
        # Claimed before anything can await, so the idle stop cannot land in between.
        chrome.hold()
        job.holds_chrome = True
        self.jobs[job.id] = job
        self._order.append(job.id)
        self._wakeup.set()
        logger.info("gemini: prompt %s queued (%d chars, %d file(s))", job.id[:8], len(payload.get("prompt", "")), len(payload.get("files", [])))
        return job

    def get(self, job_id: str) -> Optional[GeminiJob]:
        self.sweep()
        return self.jobs.get(job_id)

    def status(self) -> dict:
        self.sweep()
        live = [j for j in self.jobs.values() if j.status in (QUEUED, RUNNING)]
        return {
            "extension_connected": bool(self.last_poll) and time.monotonic() - self.last_poll < EXTENSION_ALIVE_S,
            "queued": sum(1 for j in live if j.status == QUEUED),
            "running": sum(1 for j in live if j.status == RUNNING),
            "last_success_at": self.last_success_at,
            "last_error": self.last_error,
            "chrome": chrome.state(),
        }

    # -- the extension's side -----------------------------------------------

    async def next_job(self, wait_s: float = POLL_WAIT_S) -> Optional[GeminiJob]:
        """The next prompt for the extension, waiting up to wait_s for one to arrive."""
        end = time.monotonic() + wait_s
        while True:
            self.last_poll = time.monotonic()
            self.sweep()
            while self._order:
                job = self.jobs.get(self._order.popleft())
                if job and job.status == QUEUED:
                    job.status = RUNNING
                    job.deliveries += 1
                    job.last_beat = time.monotonic()
                    return job
            remaining = end - time.monotonic()
            if remaining <= 0:
                return None
            self._wakeup.clear()
            try:
                await asyncio.wait_for(self._wakeup.wait(), timeout=min(remaining, 5))
            except asyncio.TimeoutError:
                pass

    def beat(self, job_id: str) -> bool:
        self.last_poll = time.monotonic()
        job = self.jobs.get(job_id)
        if not job or job.status != RUNNING:
            return False
        job.last_beat = time.monotonic()
        return True

    def finish(self, job_id: str, ok: bool, result: Optional[dict] = None, error: Optional[str] = None) -> bool:
        self.last_poll = time.monotonic()
        job = self.jobs.get(job_id)
        if not job or job.status in (DONE, FAILED):
            return False
        if ok:
            job.status, job.result = DONE, result or {}
            self.last_success_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self.last_error = None
            logger.info("gemini: prompt %s answered", job.id[:8])
        else:
            self._fail(job, error or "the Gemini page reported an error without saying why")
        self._close(job)
        return True

    # -- housekeeping -------------------------------------------------------

    def _fail(self, job: GeminiJob, error: str) -> None:
        job.status, job.error = FAILED, error[:500]
        self.last_error = job.error
        logger.warning("gemini: prompt %s failed: %s", job.id[:8], job.error)

    def _close(self, job: GeminiJob) -> None:
        job.finished_at = time.monotonic()
        if job.holds_chrome:
            job.holds_chrome = False
            chrome.release()

    def sweep(self) -> None:
        """Time out overdue prompts, re-queue lost hand-offs, forget old answers."""
        now = time.monotonic()
        for job in list(self.jobs.values()):
            if job.status in (QUEUED, RUNNING) and now > job.deadline:
                self._fail(job, "TIMEOUT: Gemini did not answer in time")
                self._close(job)
            elif job.status == RUNNING and now - job.last_beat > LEASE_S:
                if job.deliveries >= MAX_DELIVERIES:
                    self._fail(job, "TIMEOUT: the Gemini page never picked the prompt up")
                    self._close(job)
                else:
                    logger.info("gemini: prompt %s was handed out but never confirmed; queued again", job.id[:8])
                    job.status = QUEUED
                    self._order.appendleft(job.id)
                    self._wakeup.set()
            elif job.status in (DONE, FAILED) and now - job.finished_at > KEEP_FINISHED_S:
                del self.jobs[job.id]


_queue: Optional[GeminiQueue] = None


def get_queue() -> GeminiQueue:
    global _queue
    if _queue is None:
        _queue = GeminiQueue()
    return _queue


async def run_sweeper(every_s: float = 5) -> None:
    """Keeps deadlines honest while nobody is polling or asking."""
    while True:
        try:
            get_queue().sweep()
        except Exception:
            logger.exception("gemini sweep failed")
        await asyncio.sleep(every_s)
