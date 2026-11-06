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

from agent import chrome
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
            "temporary": body.temporary,
            "images": body.images,
            "timeoutMs": (body.timeout_s - START_ALLOWANCE_S) * 1000,
        },
        timeout_s=body.timeout_s,
    )
    # Started now rather than on the worker's next pass, which can be seconds away.
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
async def poll():
    job = await get_queue().next_job(POLL_WAIT_S)
    if not job:
        return Response(status_code=204)
    return {"job": {"id": job.id, "payload": job.payload}}


@extension.post("/beat")
async def beat(body: Beat) -> dict:
    return {"ok": get_queue().beat(body.id)}


@extension.post("/result")
async def result(body: Result) -> dict:
    return {"ok": get_queue().finish(body.id, body.ok, body.result, body.error)}
