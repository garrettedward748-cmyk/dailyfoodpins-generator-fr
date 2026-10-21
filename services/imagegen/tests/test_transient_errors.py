"""Busy Google servers and an unready Flow page are waited out, not failed."""
import asyncio

import pytest

from agent.worker import processor as proc


@pytest.fixture
def calls(monkeypatch):
    seen = []

    async def requeue(job_id, error):
        seen.append(("requeue", error))

    async def fail(job_id, error):
        seen.append(("fail", error))

    async def no_sleep(_s):
        seen.append(("sleep", _s))

    monkeypatch.setattr(proc.jobs, "requeue", requeue)
    monkeypatch.setattr(proc.jobs, "fail", fail)
    monkeypatch.setattr(proc.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(proc.accounts, "count", lambda: 1)
    return seen


def handle(error, attempts=1):
    worker = proc.WorkerController.__new__(proc.WorkerController)
    return asyncio.run(worker._handle_failure({"id": "abcdef123", "attempts": attempts}, error))


def test_high_traffic_waits_then_goes_back_in_line(calls):
    handle("RpcError: ogiZ0b failed: [8, None, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_HIGH_TRAFFIC']]]]")
    assert calls[0] == ("sleep", proc.HIGH_TRAFFIC_WAIT_S)
    assert calls[1][0] == "requeue"


def test_an_unready_page_is_retried(calls):
    handle("Image job failed with status FAILED: NO_AT_TOKEN")
    assert calls == [("requeue", "Image job failed with status FAILED: NO_AT_TOKEN")]


def test_after_the_last_attempt_it_fails(calls):
    handle("NO_AT_TOKEN", attempts=proc.MAX_RETRIES)
    assert calls[-1][0] == "fail"


def test_a_page_that_never_gets_its_token_moves_to_the_next_account(calls, monkeypatch):
    problems = []
    monkeypatch.setattr(proc.accounts, "rotate", lambda p: problems.append(p) or 3)
    handle("NO_AT_TOKEN", attempts=proc.MAX_RETRIES)
    assert calls[-1][0] == "requeue"
    assert "signed out" in problems[0].lower()


def test_with_nowhere_to_go_the_failure_says_to_sign_in(calls, monkeypatch):
    monkeypatch.setattr(proc.accounts, "rotate", lambda p: None)
    handle("NO_AT_TOKEN", attempts=proc.MAX_RETRIES)
    assert calls[-1][0] == "fail"
    assert "sign in" in calls[-1][1]


def test_a_flow_tab_that_reloaded_mid_upload_is_retried(calls):
    """Chrome's error when the tab navigates under an injected script."""
    error = "Uploading a reference failed: Frame with ID 0 was removed."
    handle(error)
    assert calls == [("requeue", error)]
