"""Flow Batch prompts: the queue the Flow Batch extension works through.

Flow Batch is the second way of making an image (Settings -> Google accounts ->
image method). Flow Kit builds Flow's request itself and sends it from inside
the tab; Flow Batch instead drives Flow's own page -- the settings chip, the
reference picker, the composer and the Generate button -- the way a person
does, and waits for the tile to finish.

The hand-off is the Gemini Chat one exactly (agent/gemini.py): the extension,
in this container's Chrome, long-polls /ext/flowbatch/poll over loopback, runs
the prompt and posts /ext/flowbatch/result. Only the names differ. The image
itself is not carried back: the extension says the prompt finished and where
the tile's picture is served from, and FlowClient.generate_images_flowbatch
reads the result off the project listing, as the composer path already does.
"""
import asyncio
import time
from typing import Optional

from agent.gemini import DONE, EXTENSION_ALIVE_S, FAILED, GeminiQueue

#: How long a prompt waits for the extension to show up at all -- Chrome may
#: just have been started for this job -- before failing as "not installed".
CONNECT_WAIT_S = 90


class FlowBatchQueue(GeminiQueue):
    tag = "flowbatch"
    page = "the Flow Batch extension"
    answerer = "Flow Batch"

    def connected(self) -> bool:
        return bool(self.last_poll) and time.monotonic() - self.last_poll < EXTENSION_ALIVE_S

    async def run(self, payload: dict, timeout_s: float) -> dict:
        """Hand one prompt to the extension and wait for its answer.

        {"ok": True, "result": {...}} or {"error": "..."}.
        """
        waited = 0.0
        while not self.connected():
            if waited >= CONNECT_WAIT_S:
                return {"error": "NO_EXTENSION: the Flow Batch extension is not running in the browser "
                                 "(rebuild the image service so it is installed, then try again)"}
            await asyncio.sleep(2)
            waited += 2

        job = self.submit(payload, timeout_s)
        while True:
            current = self.get(job.id)
            if current is None or current.status == FAILED:
                return {"error": (current.error if current else None) or "Flow Batch lost the prompt"}
            if current.status == DONE:
                return {"ok": True, "result": current.result or {}}
            await asyncio.sleep(1)


_queue: Optional[FlowBatchQueue] = None


def get_queue() -> FlowBatchQueue:
    global _queue
    if _queue is None:
        _queue = FlowBatchQueue()
    return _queue
