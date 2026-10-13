"""The extension delivers its answers over HTTP, not the WebSocket.

background.js posts every API response to /api/ext/callback and only falls back
to the socket if that POST fails, so a response survives a WebSocket that
dropped between request and reply.

Worth its own test because the failure mode is quiet: with the route missing,
generation still works — every response just takes a failed fetch and a
fallback first. Nothing errors, it only gets slower and noisier.
"""
import asyncio

from fastapi.testclient import TestClient

from agent import main
from agent.services.flow_client import get_flow_client


def client() -> TestClient:
    # The bare app, without the lifespan: no database, worker or watchdog is
    # needed to exercise one route.
    from fastapi import FastAPI

    app = FastAPI()
    app.add_api_route("/api/ext/callback", main.ext_callback, methods=["POST"])
    return TestClient(app)


def test_a_callback_resolves_the_waiting_request():
    flow = get_flow_client()
    loop = asyncio.new_event_loop()
    future = loop.create_future()
    flow._pending["req-1"] = future

    try:
        response = client().post(
            "/api/ext/callback", json={"id": "req-1", "status": 200, "data": {"media": []}}
        )

        assert response.json() == {"ok": True}
        assert future.done()
        assert future.result()["status"] == 200
    finally:
        flow._pending.pop("req-1", None)
        loop.close()


def test_a_callback_for_an_unknown_id_is_refused():
    # Request ids are server-generated UUIDs, and only one currently in flight
    # is accepted — that is what stands in for authentication on this route.
    response = client().post("/api/ext/callback", json={"id": "not-in-flight"})

    assert response.json()["ok"] is False


def test_a_second_callback_does_not_crash_on_an_already_resolved_request():
    # A retry, or the WebSocket fallback arriving after the POST succeeded.
    flow = get_flow_client()
    loop = asyncio.new_event_loop()
    future = loop.create_future()
    future.set_result({"first": True})
    flow._pending["req-2"] = future

    try:
        assert client().post("/api/ext/callback", json={"id": "req-2"}).json()["ok"] is True
        assert future.result() == {"first": True}
    finally:
        flow._pending.pop("req-2", None)
        loop.close()


def test_a_callback_without_an_id_is_refused():
    assert client().post("/api/ext/callback", json={"status": 200}).json()["ok"] is False
