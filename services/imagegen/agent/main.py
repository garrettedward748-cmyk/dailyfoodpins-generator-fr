"""imagegen — FastAPI + WebSocket entry point.

Two servers in one process:

  HTTP  (API_PORT)  the platform posts prompts and polls jobs here
  WS    (WS_PORT)   the Chrome extension connects here, loopback only

Plus a worker draining the job queue and a watchdog restarting Chrome when the
extension stops answering.

Derived from Flow Kit, with the video production half removed. What reaches
Google is unchanged — see agent/services/flow_client.py.
"""
import asyncio
import json
import logging
import signal
import sys
from contextlib import asynccontextmanager

import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect

from agent import watchdog
from agent.api.ext_host import router as ext_host_router
from agent.api.flow import router as flow_router
from agent.api.v1 import router as v1_router
from agent.auth import assert_secure_config
from agent.config import API_HOST, API_PORT, FLOW_PROJECT_ID, WS_HOST, WS_PORT
from agent.db.schema import close_db, init_db
from agent.services.flow_client import get_flow_client
from agent.worker.processor import get_worker_controller

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


# --- WebSocket server for the extension ----------------------------------

async def ws_handler(websocket) -> None:
    client = get_flow_client()
    client.set_extension(websocket)
    logger.info("extension connected from %s", websocket.remote_address)

    try:
        async for raw in websocket:
            try:
                await client.handle_message(json.loads(raw))
            except json.JSONDecodeError:
                logger.warning("invalid JSON from extension")
            except Exception:
                logger.exception("error handling extension message")
    except websockets.ConnectionClosed:
        pass
    finally:
        client.clear_extension()
        logger.info("extension disconnected")


async def run_ws_server() -> None:
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        logger.info("websocket server listening on ws://%s:%d", WS_HOST, WS_PORT)
        await asyncio.Future()


# --- Lifespan ------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Before anything else: refuse to boot as an open public endpoint.
    assert_secure_config()

    await init_db()

    # The next Chrome start uses the active Google account's profile.
    from agent import accounts
    accounts.ensure_pointer()

    if not FLOW_PROJECT_ID:
        # Not fatal — the container should come up so the browser page is
        # reachable and someone can finish configuring it. /v1/generate says
        # the same thing with a 503.
        logger.warning(
            "FLOW_PROJECT_ID is not set. Generation will be refused until it is: "
            "it travels to Google as clientContext.projectId and has to be a real "
            "project id from the Flow UI."
        )

    controller = get_worker_controller()

    # asyncio.add_signal_handler is Unix-only. On Windows fall back to the
    # default SIGINT handling so Ctrl+C still stops cleanly during local work.
    if sys.platform != "win32":
        asyncio.get_event_loop().add_signal_handler(
            signal.SIGTERM, controller.request_shutdown
        )
    else:
        signal.signal(signal.SIGINT, lambda *_: controller.request_shutdown())

    ws_task = asyncio.create_task(run_ws_server())
    worker_task = asyncio.create_task(controller.start())
    watchdog_task = asyncio.create_task(watchdog.run(controller))
    logger.info("imagegen ready on %s:%d", API_HOST, API_PORT)

    yield

    controller.request_shutdown()
    await controller.drain()
    for task in (ws_task, worker_task, watchdog_task):
        task.cancel()
    await close_db()
    logger.info("imagegen stopped")


app = FastAPI(title="imagegen", version="2.0.0", lifespan=lifespan)

# No CORS middleware. Nothing browser-side calls this service cross-origin: the
# platform reaches it server-to-server over the Docker network, and the
# extension talks over the WebSocket. An allow-list here would only be a list
# of origins that do not exist.

app.include_router(v1_router)        # public surface, API-key gated
app.include_router(flow_router)      # health, API-key gated
app.include_router(ext_host_router)  # loopback only: Chrome fetches its own CRX


@app.post("/api/ext/callback")
async def ext_callback(request: Request) -> dict:
    """How the extension delivers an API response.

    Not a duplicate of the WebSocket: background.js posts results here and only
    falls back to the socket if the POST fails, because a response delivered
    over HTTP survives a WebSocket that dropped between request and reply.
    Removing this does not break generation — it just makes every single
    response take a failed fetch first.

    Unauthenticated, like the extension's own CRX route, and for the same
    reason: Chrome is calling from inside this container and cannot carry the
    API key. What actually protects it is that a callback is only accepted for
    a request id currently in flight, and those are server-generated UUIDs.
    """
    data = await request.json()
    client = get_flow_client()
    request_id = data.get("id")

    if request_id and request_id in client._pending:
        future = client._pending[request_id]
        if not future.done():
            future.set_result(data)
        return {"ok": True}

    logger.warning("callback for unknown request id %s", str(request_id)[:8])
    return {"ok": False, "reason": "no matching pending request"}


@app.get("/health")
async def health() -> dict:
    """Unauthenticated on purpose — the container healthcheck has no key.

    Deliberately says nothing about the Google session; that is behind the API
    key at /flow/status. This answers only "is the process alive".
    """
    return {"ok": True, "watchdog": watchdog.state.as_dict()}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Kept so the extension can fall back to the HTTP port if it must.

    The dedicated WS_PORT server above is the normal path.
    """
    await websocket.accept()
    client = get_flow_client()
    client.set_extension(websocket)

    try:
        while True:
            await client.handle_message(json.loads(await websocket.receive_text()))
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        client.clear_extension()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=API_HOST, port=API_PORT, log_level="info")


if __name__ == "__main__":
    main()
