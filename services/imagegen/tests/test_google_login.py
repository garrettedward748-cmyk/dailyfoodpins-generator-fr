"""Signing in from the platform: the page's steps drive what is typed."""
import asyncio

import pytest

from agent import accounts, chrome, google_login


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "STATE_FILE", tmp_path / "accounts.json")
    monkeypatch.setattr(accounts, "ACTIVE_POINTER", tmp_path / "active-profile-dir")
    monkeypatch.setattr(accounts, "EXTRA_PROFILES", tmp_path / "chrome-profiles")
    monkeypatch.setattr(accounts, "FIRST_PROFILE", tmp_path / "chrome-profile")
    monkeypatch.setattr(google_login.shutil, "which", lambda _: "/usr/bin/xdotool")
    monkeypatch.setattr(google_login.asyncio, "sleep", _no_sleep)

    async def nothing(*_a, **_k):
        return True
    monkeypatch.setattr(chrome, "switch_account_if_pending", nothing)
    monkeypatch.setattr(chrome, "ensure_running", nothing)
    monkeypatch.setattr(chrome, "hold_manually", lambda *_: None)
    google_login._status.clear()
    yield


_real_sleep = asyncio.sleep


async def _no_sleep(_s):
    await _real_sleep(0)


class FakeClient:
    connected = True

    async def create_flow_project(self):
        return {"ok": True, "projectId": "new-proj"}

    def __init__(self, pages):
        self.pages = list(pages)
        self.focused = []

    async def google_login(self, action, selector="", email=""):
        if action == "open":
            return {"ok": True}
        if action == "focus":
            self.focused.append(selector)
            return {"ok": True}
        if action == "choose":
            return {"ok": True}
        return self.pages.pop(0) if len(self.pages) > 1 else self.pages[0]


def run_with(monkeypatch, pages):
    client = FakeClient(pages)
    typed = []

    async def xdo(*args):
        if args[0] == "type":
            typed.append(args[-1])
    monkeypatch.setattr(google_login, "get_flow_client", lambda: client)
    monkeypatch.setattr(google_login, "_xdo", xdo)
    new = accounts.add("")
    asyncio.run(google_login._run(new["id"], "me@gmail.com", "s3cret!"))
    return new["id"], typed


def test_types_the_address_then_the_password_and_waits_for_the_phone(monkeypatch):
    acc, typed = run_with(monkeypatch, [
        {"step": "email"}, {"step": "password"}, {"step": "phone"}, {"step": "done"},
    ])
    assert typed == ["me@gmail.com", "s3cret!"]
    assert google_login.status(acc)["state"] == "done"
    assert "new-proj" in google_login.status(acc)["message"]
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[acc]["status"] == "ok" and listed[acc]["project_id"] == "new-proj"


def test_a_code_given_on_the_platform_is_typed(monkeypatch):
    google_login._codes.clear()

    class CodeClient(FakeClient):
        async def google_login(self, action, selector="", email=""):
            if action == "state" and self.pages[0]["step"] == "code" and not google_login._codes and not self.focused[2:]:
                google_login.give_code(2, "123 456")
            return await super().google_login(action, selector, email)

    client = CodeClient([{"step": "email"}, {"step": "password"}, {"step": "code"}, {"step": "done"}])
    typed = []

    async def xdo(*args):
        if args[0] == "type":
            typed.append(args[-1])
    monkeypatch.setattr(google_login, "get_flow_client", lambda: client)
    monkeypatch.setattr(google_login, "_xdo", xdo)
    accounts.add("")
    asyncio.run(google_login._run(2, "me@gmail.com", "pw"))
    assert typed == ["me@gmail.com", "pw", "123456"]


def test_google_refusing_the_browser_ends_with_a_clear_message(monkeypatch):
    acc, _ = run_with(monkeypatch, [{"step": "email"}, {"step": "blocked"}])
    st = google_login.status(acc)
    assert st["state"] == "failed" and "Browser page" in st["message"]


def test_the_extension_answer_is_unwrapped():
    from agent.services.flow_client import FlowClient

    class C(FlowClient):
        def __init__(self):
            pass

        async def _send(self, method, params, timeout=300):
            return {"id": "x", "result": {"ok": True, "tabId": 3}}
    assert asyncio.run(C().google_login("open")) == {"ok": True, "tabId": 3}
