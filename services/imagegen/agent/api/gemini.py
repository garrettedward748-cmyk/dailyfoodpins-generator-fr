"""Gemini prompts, over HTTP.

Two routers, for two callers:

  /v1/gemini   the platform: post a prompt, poll for the reply, ask how Gemini is doing.
               API-key gated like the rest of /v1. Asynchronous for the same reason image
               generation is: an answer takes seconds to minutes, past where a single request
               should be held open.

  /ext/gemini  the Gemini Chat extension in this container's Chrome: take the next prompt,
               report it is still being worked on, hand the reply back. Chrome cannot carry the
               API key, so instead of a key these answer loopback callers only -- port 8100
               listens on every interface for the platform's sake, and nothing but the browser
               beside us has any business taking prompts from this queue.
"""
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from agent import chrome, gemini_browser
from agent.auth import require_api_key
from agent.gemini import POLL_WAIT_S, get_queue

logger = logging.getLogger(__name__)

#: Files travel as base64 inside the JSON body; this caps the whole set.
MAX_FILES_BASE64 = 40 * 1024 * 1024

#: Of a prompt's whole budget, what is left for Chrome to start and the page to load before
#: Gemini's own answering time begins.
START_ALLOWANCE_S = 60


class GeminiFile(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    mime: str = Field(..., min_length=1, max_length=120)
    base64: str


class AskRequest(BaseModel):
    prompt: str = Field(default="", max_length=200_000)
    files: list[GeminiFile] = Field(default_factory=list, max_length=10)
    # The Google account to ask as, by email. Empty means the browser's default account.
    account: str = Field(default="", max_length=320)
    # A temporary chat keeps automated prompts out of the account's chat history.
    temporary: bool = True
    # Gemini's id for an existing chat to ask in (the part after /app/ in its address), so the
    # answer keeps that chat's earlier messages in mind. Empty starts a new chat.
    conversation_id: str = Field(default="", max_length=100, pattern=r"^[A-Za-z0-9_-]*$")
    # Whether pictures in the reply come back as data, not only as addresses.
    images: bool = True
    # The whole budget: Chrome starting, the page loading and Gemini answering.
    timeout_s: int = Field(default=300, ge=60, le=1800)


platform = APIRouter(prefix="/v1/gemini", tags=["gemini"], dependencies=[Depends(require_api_key)])


@platform.post("/jobs", status_code=202)
async def ask(body: AskRequest) -> dict:
    if not body.prompt.strip() and not body.files:
        raise HTTPException(422, "Send a prompt, a file, or both.")
    if sum(len(f.base64) for f in body.files) > MAX_FILES_BASE64:
        raise HTTPException(413, "The attached files are too large together (about 30 MB at most).")

    job = get_queue().submit(
        {
            "prompt": body.prompt,
            "files": [f.model_dump() for f in body.files],
            "account": body.account.strip(),
            # A chat that is carried on is an ordinary one: a temporary chat has no address to return to.
            "temporary": body.temporary and not body.conversation_id,
            "conversationId": body.conversation_id,
            "images": body.images,
            "timeoutMs": (body.timeout_s - START_ALLOWANCE_S) * 1000,
        },
        timeout_s=body.timeout_s,
    )
    # Started now rather than on the worker's next pass, which can be seconds away.
    if gemini_browser.enabled():
        asyncio.create_task(gemini_browser.ensure_running("a Gemini prompt"))
    else:
        asyncio.create_task(chrome.ensure_running("a Gemini prompt"))
    return job.public()


@platform.get("/jobs/{job_id}")
async def job(job_id: str) -> dict:
    found = get_queue().get(job_id)
    if not found:
        raise HTTPException(404, "No such Gemini prompt. The image service may have restarted since it was sent.")
    return found.public()


@platform.get("/status")
async def status() -> dict:
    return get_queue().status()


def loopback_only(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Only the browser in this container takes Gemini prompts.")


extension = APIRouter(prefix="/ext/gemini", tags=["gemini"], dependencies=[Depends(loopback_only)])


class Beat(BaseModel):
    id: str = Field(..., max_length=64)


class Result(BaseModel):
    id: str = Field(..., max_length=64)
    ok: bool
    result: Optional[dict] = None
    error: Optional[str] = Field(default=None, max_length=2000)


@extension.get("/poll")
async def poll(browser: str = "flow"):
    """The next prompt, or a sign-in step, for the Gemini Chat extension in `browser`.

    Two Chromes carry the extension: Flow's ("flow") and Gemini's own ("gemini",
    see agent/gemini_browser.py). Prompts go to Gemini's own while it is
    switched on and to Flow's otherwise; the other is kept waiting so its loop
    does not spin.
    """
    own = gemini_browser.enabled()
    if (browser == "gemini") != own:
        await asyncio.sleep(POLL_WAIT_S)
        return Response(status_code=204)
    queue = get_queue()
    gemini_browser.set_wakeup(queue._wakeup)
    end = asyncio.get_running_loop().time() + POLL_WAIT_S
    while True:
        if own:
            step = gemini_browser.next_command()
            if step:
                return {"command": step}
        left = end - asyncio.get_running_loop().time()
        job = await queue.next_job(min(3.0, max(0.0, left)) if own else max(0.0, left))
        if job:
            payload = job.payload
            if own:
                gemini_browser.touch()
                # Only the accounts listed in Setup -> Gemini write; one removed
                # there stays signed in to the browser but is passed over.
                listed = [a["email"] for a in gemini_browser.accounts() if a.get("state") == "signed_in"]
                if listed:
                    payload = {**payload, "allowed": listed}
            return {"job": {"id": job.id, "payload": payload}}
        if asyncio.get_running_loop().time() >= end:
            return Response(status_code=204)


class CommandResult(BaseModel):
    id: str = Field(..., max_length=64)
    result: dict = Field(default_factory=dict)


@extension.post("/command")
async def command_done(body: CommandResult) -> dict:
    return {"ok": gemini_browser.command_result(body.id, body.result)}


# -- Gemini's own browser, from the platform (Setup -> Gemini) ----------------

class BrowserSwitch(BaseModel):
    enabled: bool


class GeminiLogin(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    password: str = Field(..., min_length=1, max_length=500)


class GeminiCode(BaseModel):
    code: str = Field(..., min_length=1, max_length=20)


class GeminiAccount(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


@platform.get("/browser")
async def browser_state() -> dict:
    await gemini_browser.running()
    return gemini_browser.state()


@platform.post("/browser/open")
async def browser_open() -> dict:
    """Someone opened its window on the platform: start it if it sleeps, and keep it up."""
    if gemini_browser.enabled():
        await gemini_browser.ensure_running("its window was opened")
    return gemini_browser.state()


@platform.post("/browser")
async def browser_switch(body: BrowserSwitch) -> dict:
    gemini_browser.set_enabled(body.enabled)
    if not body.enabled:
        await gemini_browser.stop("switched off")
    return gemini_browser.state()


@platform.post("/accounts/login")
async def accounts_login(body: GeminiLogin) -> dict:
    if not gemini_browser.enabled():
        raise HTTPException(409, "Switch Gemini's own browser on first.")
    gemini_browser.start_login(body.email, body.password)
    return gemini_browser.state()


@platform.post("/accounts/login/code")
async def accounts_code(body: GeminiCode) -> dict:
    gemini_browser.give_code(body.code)
    return gemini_browser.state()


@platform.post("/accounts/remove")
async def accounts_remove(body: GeminiAccount) -> dict:
    gemini_browser.remove_account(body.email)
    return gemini_browser.state()


@extension.post("/beat")
async def beat(body: Beat) -> dict:
    return {"ok": get_queue().beat(body.id)}


@extension.post("/result")
async def result(body: Result) -> dict:
    return {"ok": get_queue().finish(body.id, body.ok, body.result, body.error)}
