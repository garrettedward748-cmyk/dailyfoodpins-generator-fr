"""Gemini's own browser: prompts go to it only while it is on, and sign-in
steps ride the extension's poll."""
import asyncio

import pytest

from agent import gemini_browser
from agent.api import gemini as api
from agent.gemini import GeminiQueue


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(gemini_browser, "STATE_PATH", tmp_path / "gemini-browser.json")
    monkeypatch.setattr(api, "POLL_WAIT_S", 0.2)
    queue = GeminiQueue()
    monkeypatch.setattr(api, "get_queue", lambda: queue)
    gemini_browser._commands.clear()
    yield queue


def test_off_by_default_and_remembered():
    assert gemini_browser.enabled() is False
    gemini_browser.set_enabled(True)
    assert gemini_browser.enabled() is True


def test_prompts_go_to_the_flow_browser_while_off_and_to_its_own_while_on(isolated):
    queue = isolated

    async def go():
        queue.submit({"prompt": "hi"}, timeout_s=60)
        mine = await api.poll(browser="gemini")      # off: Gemini's own browser waits
        flows = await api.poll(browser="flow")       # ...and Flow's takes it
        gemini_browser.set_enabled(True)
        queue.submit({"prompt": "again"}, timeout_s=60)
        flows_now = await api.poll(browser="flow")   # on: Flow's waits
        mine_now = await api.poll(browser="gemini")  # ...and Gemini's own takes it
        return mine, flows, flows_now, mine_now

    mine, flows, flows_now, mine_now = asyncio.run(go())
    assert getattr(mine, "status_code", None) == 204
    assert flows["job"]["payload"]["prompt"] == "hi"
    assert getattr(flows_now, "status_code", None) == 204
    assert mine_now["job"]["payload"]["prompt"] == "again"


def test_a_sign_in_step_rides_the_poll_and_its_answer_comes_back():
    gemini_browser.set_enabled(True)

    async def go():
        asking = asyncio.create_task(gemini_browser.command("state", email="a@b.c", timeout=5))
        await asyncio.sleep(0)
        handed = await api.poll(browser="gemini")
        step = handed["command"]
        assert step["action"] == "state" and step["email"] == "a@b.c"
        await api.command_done(api.CommandResult(id=step["id"], result={"step": "password"}))
        return await asking

    assert asyncio.run(go()) == {"step": "password"}


def test_accounts_are_listed_and_forgotten():
    gemini_browser._put_account("one@gmail.com", state="signed_in")
    gemini_browser._put_account("two@gmail.com", state="failed")
    gemini_browser._put_account("ONE@gmail.com", state="signed_in")
    assert [a["email"] for a in gemini_browser.accounts()] == ["one@gmail.com", "two@gmail.com"]
    gemini_browser.remove_account("two@gmail.com")
    assert [a["email"] for a in gemini_browser.accounts()] == ["one@gmail.com"]


def test_only_the_accounts_listed_in_setup_are_written_with(isolated):
    queue = isolated
    gemini_browser.set_enabled(True)
    gemini_browser._put_account("one@gmail.com", state="signed_in")
    gemini_browser._put_account("gone@gmail.com", state="failed")

    async def go():
        queue.submit({"prompt": "hi"}, timeout_s=60)
        return await api.poll(browser="gemini")

    assert asyncio.run(go())["job"]["payload"]["allowed"] == ["one@gmail.com"]
