"""The Flow Batch extension's side of its queue (see agent/flowbatch.py).

Loopback only, like the Gemini Chat routes it mirrors: the caller is the Chrome
in this container, which cannot carry the API key.
"""
from fastapi import APIRouter, Depends, Response

from agent.api.gemini import Beat, Result, loopback_only
from agent.flowbatch import get_queue
from agent.gemini import POLL_WAIT_S

extension = APIRouter(prefix="/ext/flowbatch", tags=["flowbatch"], dependencies=[Depends(loopback_only)])


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
