"""The UI scan: Flow's own generate controls, read off the signed-in tab.

The batch path reconstructs Flow's requests -- it mints the captcha, builds
f.req and sets the query string -- and a reconstruction that has drifted from
what the real client sends is what PUBLIC_ERROR_UNUSUAL_ACTIVITY is a verdict
on. Driving the page's controls instead removes the reconstruction, and needs
to know what the controls are. Flow's markup is minified and changes without
notice, so it is read from the live page rather than pinned here.

What is pinned here is the wiring: the endpoint asks the extension, it starts
Chrome the way signing in does, and an extension that is not there says so
instead of hanging.
"""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent import chrome
from agent.api import flow as flow_api


@pytest.fixture
def client(monkeypatch) -> TestClient:
    """The /flow router with the browser and supervisord both faked."""
    monkeypatch.setattr(flow_api, "require_api_key", lambda: None)

    app = FastAPI()
    app.include_router(flow_api.router, dependencies=[])
    return TestClient(app)


class FakeFlowClient:
    """Records what it was asked, answers what it was told to."""

    def __init__(self, answer: dict):
        self.answer = answer
        self.asked_with: list[str | None] = []

    async def scan_flow_ui(self, project_id: str | None = None) -> dict:
        self.asked_with.append(project_id)
        return self.answer


def wire(monkeypatch, answer: dict) -> tuple[FakeFlowClient, list[str]]:
    """Point the endpoint at a fake browser; collect the Chrome verbs it runs."""
    fake = FakeFlowClient(answer)
    started: list[str] = []

    async def ensure_running(reason: str) -> None:
        started.append(reason)

    monkeypatch.setattr(flow_api, "get_flow_client", lambda: fake)
    monkeypatch.setattr(chrome, "ensure_running", ensure_running)
    monkeypatch.setattr(chrome, "hold_manually", lambda *a, **k: started.append("held"))
    return fake, started


SCANNED = {
    "url": "https://flow.google.com/project/PROJ-1",
    "title": "Flow",
    "grecaptcha": True,
    "counts": {"inputs": 1, "buttons": 12},
    "inputs": [{"tag": "textarea", "attrs": {"placeholder": "Describe your idea"},
                "visible": True, "path": "form > textarea"}],
    "buttons": [{"tag": "button", "text": "Generate", "attrs": {"aria-label": "Generate"},
                 "visible": True, "path": "form > button:nth-of-type(2)"}],
    "formHtml": "<form>…</form>",
}


def test_the_scan_reports_the_controls_it_found(monkeypatch, client):
    wire(monkeypatch, SCANNED)

    body = client.get("/flow/ui-scan").json()

    assert body["grecaptcha"] is True
    assert body["inputs"][0]["path"] == "form > textarea"
    assert body["buttons"][0]["text"] == "Generate"


def test_chrome_is_started_and_pinned_for_it(monkeypatch, client):
    # A scan is not a queued job, so nothing else holds the browser up and the
    # idle stop would take it away mid-read -- the same reason signing in pins it.
    _, started = wire(monkeypatch, SCANNED)

    client.get("/flow/ui-scan")

    assert "held" in started
    assert any("scan" in reason for reason in started if reason != "held")


def test_the_project_asked_for_is_the_one_scanned(monkeypatch, client):
    # grecaptcha and the generate controls are on a project page and not on the
    # project list, so a scan of the wrong page reports an interface that is
    # not there.
    fake, _ = wire(monkeypatch, SCANNED)

    client.get("/flow/ui-scan", params={"project_id": "PROJ-9"})

    assert fake.asked_with == ["PROJ-9"]


def test_no_extension_is_an_answer_rather_than_a_hang(monkeypatch, client):
    wire(monkeypatch, {"error": "Extension not connected"})

    assert client.get("/flow/ui-scan").json() == {"error": "Extension not connected"}


def test_the_client_passes_the_project_through_to_the_extension(monkeypatch):
    """The wrapper names the method the extension dispatches on."""
    from agent.services.flow_client import FlowClient

    sent: dict = {}

    async def fake_send(method, params, timeout=300):
        sent.update(method=method, params=params, timeout=timeout)
        return {"url": "https://flow.google.com/project/PROJ-1"}

    client = FlowClient.__new__(FlowClient)
    client._send = fake_send  # type: ignore[method-assign]

    asyncio.run(client.scan_flow_ui("PROJ-1"))

    assert sent["method"] == "scan_flow_ui"
    assert sent["params"] == {"projectId": "PROJ-1"}
