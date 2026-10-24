"""The worker: pending job -> Google Flow -> image or video URL.

One loop, two request kinds. What is preserved exactly is the call itself:
`generate_images()` and `generate_video_from_references()` build the payloads
Google's own UI sends, and nothing here reshapes them.

Images resolve in one call. Video does not: the submit returns an operation
handle, and the result arrives minutes later from a separate status endpoint.
That polling happens inside the job's own task rather than by returning it to
the queue, so a half-generated video is never re-submitted and paid for twice.
"""
import asyncio
import base64
import json
import os
import logging

import httpx

from agent import accounts

from agent.config import (
    API_COOLDOWN,
    FLOW_PROJECT_ID,
    IMAGE_USE_BATCH,
    IMAGE_USE_UI,
    MAX_CONCURRENT_REQUESTS,
    MAX_RETRIES,
    POLL_INTERVAL,
    STALE_PROCESSING_TIMEOUT,
    TOKEN_MAX_AGE_BEFORE_BATCH,
    VIDEO_MAX_POLLS,
    VIDEO_LISTING_GIVEUP_S,
    VIDEO_USE_BATCH,
    VIDEO_POLL_INTERVAL,
)
from agent import chrome, image_models, video_models
from agent.db import jobs
from agent.services.flow_client import get_flow_client
from agent.worker._parsing import (
    extract_media_handle,
    extract_media_url,
    error_text,
    extract_media_id,
    extract_operation,
    extract_output_url,
    extract_video_media_id,
    extract_video_url,
    is_error,
    rejected_the_request,
    video_failed,
)

logger = logging.getLogger(__name__)

ASPECT_RATIOS = {
    "VERTICAL": "IMAGE_ASPECT_RATIO_PORTRAIT",
    "HORIZONTAL": "IMAGE_ASPECT_RATIO_LANDSCAPE",
}

VIDEO_ASPECT_RATIOS = {
    "VERTICAL": "VIDEO_ASPECT_RATIO_PORTRAIT",
    "HORIZONTAL": "VIDEO_ASPECT_RATIO_LANDSCAPE",
}

# A reference image is fetched over the public internet from the site that
# published it, so it is bounded: a redirect loop or a wrong URL must fail the
# job rather than hold a worker slot open.
REFERENCE_DOWNLOAD_TIMEOUT = 60
MAX_REFERENCE_BYTES = 12 * 1024 * 1024

# Failures worth retrying: the browser is momentarily absent, or Google is
# rate-limiting. Anything else is a bad request that will fail identically on
# every attempt, and retrying it just burns the quota faster.
# "recaptcha" is here because a rejected score is a property of the browser
# session at that moment, not of the request. The extension already reloads the
# Flow tab and re-sends once with a fresh token; reaching us means that did not
# help yet, and the next attempt is spaced by API_COOLDOWN, which gives the new
# session time to settle. It used to be absent, so a 403 failed the job on
# attempt one of five while MAX_RETRIES sat there unused.
#
# Deliberately not "session_expired": that one needs a person to sign in, and
# retrying it just fails five times more slowly.
# 401 is here because an expired bearer is a property of the moment, not of
# the request: the extension reloads the Flow tab and re-sends once, and if
# that has not landed by the time we see it, the next attempt is spaced by
# API_COOLDOWN — by which point the reload has produced a token. Without it a
# whole queue died on attempt one of five every time the hour rolled over, and
# the only cure anyone had was refreshing the tab by hand.
#: How often the project listing is read while the operation poll says
#: nothing. The listing is the heavy call (it is the whole project), so not on
#: every 15-second poll -- once a minute is enough for a clip that takes two.
LISTING_EVERY_N_POLLS = 4

RETRYABLE = ("quota", "rate_limit", "exhausted", "resource_exhausted", "429",
             "no_flow_key", "not connected", "timeout", "503",
             "recaptcha", "captcha_timeout",
             "http 401", "api_401", "unauthenticated", "invalid authentication",
             # The request cut off inside the Flow tab before Google answered:
             # a page still coming back from a reload, or navigating under the
             # injected fetch. A timeout by another name.
             "no_injection_result", "injection_failed",
             # Chrome's own words for the same thing: the Flow tab reloaded or
             # navigated while a script was running in it ("Frame with ID 0
             # was removed"). The retry runs in the page that replaced it.
             "frame with id",
             # The Flow page was not ready to sign a request (its `at` token
             # unread) -- typically the first seconds after the browser came
             # up on another account. The retry reloads the tab first.
             "no_at_token",
             # Google's servers busy for the model: nothing wrong with the
             # request or the account. Retried after a pause (see below).
             "high_traffic")

# How long a job waits before going back in line after PUBLIC_ERROR_HIGH_TRAFFIC.
HIGH_TRAFFIC_WAIT_S = int(os.environ.get("HIGH_TRAFFIC_WAIT_SECONDS", "90"))


class WorkerController:
    """Owns the polling loop and its shutdown."""

    def __init__(self) -> None:
        self._shutdown = asyncio.Event()
        self._running: set[str] = set()
        self._paused_reason: str | None = None

    def request_shutdown(self) -> None:
        self._shutdown.set()

    # ─── Pausing, which the watchdog does ───────────────────
    #
    # These were called and never existed. The watchdog asks for a pause in four
    # places -- a Google sign-in wall, the circuit breaker, an extension that
    # never installed, a Chrome that will not come back -- and every one of them
    # raised AttributeError instead of pausing anything:
    #
    #   AttributeError: 'WorkerController' object has no attribute 'pause'
    #
    # The tests did not catch it because test_watchdog.py drives a FakeController
    # that has the method. So the fake defined the interface and nothing checked
    # the real class against it.
    #
    # What it cost: the breaker never stopped anything, so a run of failures kept
    # submitting -- each one spending a captcha and, for video, credits. Worse,
    # the raise happens inside _check_circuit_breaker, which runs before
    # _check_extension, so a tripped breaker also took Chrome-wedge detection
    # down with it. The watchdog was not degraded, it was off.

    @property
    def paused(self) -> bool:
        return self._paused_reason is not None

    def pause(self, reason: str) -> None:
        if self._paused_reason == reason:
            return  # Already paused for this; the watchdog re-asserts every cycle.
        self._paused_reason = reason
        logger.warning("worker paused: %s — no new jobs will be claimed", reason)

    def resume(self) -> None:
        if self._paused_reason is None:
            return
        logger.info("worker resumed (was paused: %s)", self._paused_reason)
        self._paused_reason = None

    async def drain(self) -> None:
        """Wait for in-flight jobs, so a redeploy does not abandon one mid-call."""
        while self._running:
            await asyncio.sleep(0.2)

    async def start(self) -> None:
        logger.info(
            "worker started (concurrency=%d, poll=%ds)", MAX_CONCURRENT_REQUESTS, POLL_INTERVAL
        )

        while not self._shutdown.is_set():
            try:
                await jobs.reset_stale(STALE_PROCESSING_TIMEOUT)

                # Chrome first, and from the queue rather than from what we
                # managed to claim. The claim below needs a connected extension,
                # the extension needs a browser, and the browser is only running
                # when something asked for it -- so a queue whose Chrome is
                # stopped would sit there forever if this read self._running.
                counts = await jobs.count_by_status()
                # A paused worker will not claim these, so they are not work
                # waiting -- and treating them as such would hold a browser up
                # at 170% for a queue nothing is allowed to touch, for as long
                # as whatever the watchdog paused for goes unattended.
                waiting = bool(counts.get("PENDING")) and not self.paused
                await chrome.reconcile(waiting)

                free = MAX_CONCURRENT_REQUESTS - len(self._running)
                # No new claims while a Google-account switch waits: the switch
                # needs the browser free, and a steady queue would never let it.
                if free > 0 and not self.paused and get_flow_client().connected and not accounts.switch_pending():
                    # Only claim work the account in use is ticked for (images
                    # vs video, set per account in Setup -> Google accounts).
                    allowed = accounts.active_kinds()
                    claimed = await jobs.claim_pending(free, kinds=list(allowed))
                    if not claimed:
                        await self._align_account_to_queue(allowed)
                    # Skipped while other jobs are still in flight, since
                    # reloading the tab takes their requests down with it.
                    if claimed and not self._running and self.reload_before(claimed):
                        await self._ensure_token(len(claimed))
                    for job in claimed:
                        self._running.add(job["id"])
                        # Claimed here, before the task exists, so the idle stop
                        # cannot land between creating it and it starting.
                        chrome.hold()
                        asyncio.create_task(self._run(job))
            except Exception:
                logger.exception("worker loop iteration failed")

            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass

        logger.info("worker stopping")

    @staticmethod
    def reload_before(claimed: list[dict]) -> bool:
        """Whether the Flow tab is reloaded before these jobs go out.

        The REST path needs it every time: the bearer it carries is sniffed
        off the page and only a reload renews it. The batch path carries no
        bearer -- the page signs each request itself -- so there the reload
        did nothing for the request and something to the account: every image
        arrived as a fresh page load, a captcha seconds later, and a request,
        four times an article. That is what a bot looks like to reCAPTCHA.

        So on the batch path a reload is a recovery, not a routine. A job on
        its second or later attempt is one Google refused as the session was,
        and a fresh session is the known remedy. claim_pending has already
        counted the attempt by the time this sees the row, so 1 is a first try.
        """
        if not IMAGE_USE_BATCH:
            return True
        return any(int(job.get("attempts") or 0) > 1 for job in claimed)

    async def _ensure_token(self, job_count: int) -> None:
        """Age out the bearer before a batch goes near it.

        Never fatal: a failed refresh is worth a log line and nothing more.
        The jobs still get their attempt, and if the token really is dead they
        come back through the retry path rather than being dropped here.
        """
        try:
            result = await get_flow_client().ensure_fresh_token(TOKEN_MAX_AGE_BEFORE_BATCH)
            if result.get("reloaded"):
                logger.info("reloaded the Flow tab before %d job(s): ok=%s",
                            job_count, result.get("ok"))
            elif result.get("error"):
                logger.warning("token refresh before batch failed: %s", result["error"])
        except Exception:
            logger.exception("token refresh before batch raised")

    async def _align_account_to_queue(self, allowed: set) -> None:
        """Nothing was claimable for the account in use -- see if work of another
        kind is waiting, and move the account pool toward it.

        Called only when claim_pending came back empty. If the oldest waiting job
        is a kind the active account is not ticked for, this queues a switch to an
        account that is (applied once the browser is free, like any switch). If no
        account is ticked for that kind at all, the waiting jobs of it are failed
        with a message naming what to tick -- better than a video queue that waits
        on an account that will never exist.
        """
        kind = await jobs.oldest_pending_kind()
        if kind is None or kind in allowed:
            return  # no work waiting, or the active account already covers it
        status = accounts.ensure_active_can(kind)
        if status == "none_capable":
            label = "videos" if kind == "video" else "images"
            tick = "Video" if kind == "video" else "Images"
            n = await jobs.fail_pending_of_kind(
                kind,
                f"No Google account is set to make {label}. "
                f"Tick {tick} on an account in Setup -> Google accounts.",
            )
            if n:
                logger.warning("worker: failed %d %s job(s) — no account is set for %s", n, kind, kind)

    async def _run(self, job: dict) -> None:
        job_id = job["id"]
        try:
            if job["kind"] == "video":
                await self._run_video(job)
            else:
                await self._run_image(job)

        except Exception as exc:
            logger.exception("job %s raised", job_id[:8])
            await self._handle_failure(job, str(exc))
        finally:
            self._running.discard(job_id)
            chrome.release()
            # Spacing between calls, not between loop iterations: bursts are
            # what earn a rate limit.
            await asyncio.sleep(API_COOLDOWN)

    async def _run_image(self, job: dict) -> None:
        job_id = job["id"]
        client = get_flow_client()
        # The batch path signs itself inside the Flow tab; REST carries a bearer
        # token sniffed off the page, which Google stopped honouring three days
        # after it stopped honouring the same thing for video. Both answer in the
        # same shape, so nothing below this line knows which one ran.
        request = dict(
            prompt=job["prompt"],
            # The job's own project. FLOW_PROJECT_ID is only the fallback for a
            # caller that sent none, applied when the job was queued.
            project_id=accounts.active_project() or job["project_id"] or FLOW_PROJECT_ID,
            aspect_ratio=ASPECT_RATIOS.get(job["orientation"], ASPECT_RATIOS["VERTICAL"]),
        )

        if not IMAGE_USE_BATCH:
            result = await client.generate_images(**request)
        else:
            # Pro, then 2, then Lite: walk the list and keep the first model
            # Google does not refuse by name. Anything that is not a refusal --
            # a captcha that did not solve, a transport that dropped -- is not
            # about the model, and moving down the list would spend another
            # captcha on the same problem, so it stops the walk.
            #
            # The third name is read off the Flow page the first time this runs.
            # A name read off a page and refused as INVALID_ARGUMENT was not a
            # model; it is dropped and never sent again. The two known names are
            # not dropped for that: INVALID_ARGUMENT on a name Google definitely
            # knows means something else is wrong.
            #
            # Every answer Google gives a model is recorded, and the Settings
            # page shows it. That is how a name read off a page gets verified:
            # in Automatic mode the walk never reaches it, because Nano Banana 2
            # is unlimited, so a person picks it there and runs one article.
            # References go up first, so the image can follow them. An image
            # job with none -- every article image -- skips this entirely.
            ref_media_ids = await self._upload_references_batch(job, request["project_id"])
            if ref_media_ids is None:
                return
            if ref_media_ids:
                request["ref_media_ids"] = ref_media_ids

            # Google's frontend build of 2026-09-22 refuses every captcha-gated
            # call we send -- PUBLIC_ERROR_UNUSUAL_ACTIVITY -- while the same
            # account generates fine when the button is clicked, so the app is
            # left to send it and the result is read from the project listing.
            # See uiGenerateImage in the extension for what was measured.
            #
            # The model walk does not apply on this path: the composer's model
            # is whatever is selected in the Flow UI, and nothing here can
            # refuse a model by name to move down a list.
            if IMAGE_USE_UI:
                result = await client.generate_images_ui(
                    request["prompt"], request["project_id"],
                )
            else:
                result = await self._generate_by_model(client, job, job_id, request)

        if is_error(result):
            await self._handle_failure(job, error_text(result))
            return

        url = extract_output_url(result)
        if not url:
            await self._handle_failure(job, f"No image url in response: {str(result)[:300]}")
            return

        await jobs.complete(job_id, extract_media_id(result), url)
        accounts.note_success()
        logger.info("job %s COMPLETED", job_id[:8])


    async def _generate_by_model(self, client, job: dict, job_id: str, request: dict) -> dict:
        """The captcha-gated path: walk the models and keep the first Google takes.

        Kept behind IMAGE_USE_UI for a Flow build that honours these calls
        again, and because video still goes this way.
        """
        await image_models.ensure_discovered(client)
        choice = job.get("image_model") or image_models.AUTO
        models = image_models.plan(choice)
        if not models:
            return {"error": image_models.why_empty(choice)}

        result = {"error": "no image model configured"}
        for model in models:
            result = await client.generate_images_batch(**request, image_model_name=model)
            err = None if not is_error(result) else error_text(result)
            image_models.record(model, err)
            if err is None:
                break
            if image_models.is_refusal(err):
                logger.warning("job %s: %s refused (%s) — trying the next model",
                               job_id[:8], model, err[:120])
                image_models.refused(model)
                continue
            if "HIGH_TRAFFIC" in err.upper():
                # This model is busy right now, not refused: the next one may
                # not be. Nothing is recorded against it.
                logger.warning("job %s: %s busy (high traffic) — trying the next model", job_id[:8], model)
                continue
            if not image_models.is_known(model) and image_models.is_bad_name(err):
                logger.warning("job %s: %s is not a model Flow knows (%s) — dropped",
                               job_id[:8], model, err[:120])
                continue
            break
        return result

    async def _upload_references_batch(self, job: dict, project_id: str) -> list[str] | None:
        """Every reference on the job, uploaded into the project; their media ids.

        None means the job was failed here and the caller should stop. The
        same upload the reel path does, kept apart so an image job with no
        references never touches it.
        """
        try:
            reference_urls = json.loads(job.get("reference_urls") or "[]")
        except (TypeError, ValueError):
            await self._handle_failure(job, "reference_urls is not valid JSON")
            return None
        if not reference_urls:
            return []

        client = get_flow_client()
        media_ids: list[str] = []
        for url in reference_urls[:3]:
            fetched = await self._fetch_reference(url)
            if "error" in fetched:
                await self._handle_failure(job, fetched["error"])
                return None
            uploaded = await client.upload_image_batch(
                image_base64=base64.b64encode(fetched["bytes"]).decode("ascii"),
                project_id=project_id,
                mime_type=fetched["mime"],
                file_name=url.rsplit("/", 1)[-1][:100] or "reference.jpg",
            )
            if uploaded.get("error"):
                await self._handle_failure(job, f"Uploading a reference failed: {uploaded['error']}")
                return None
            media_ids.append(uploaded["media_id"])
        return media_ids

    async def _run_video(self, job: dict) -> None:
        """Reference images -> Flow -> a finished video URL.

        Three stages in one task: upload each reference so Google has a media
        id for it, submit the generation, then poll the operation until it
        carries a URL. The polling stays here rather than going back through
        the queue, because a requeued video would be submitted again -- and a
        second submission is a second video paid for.
        """
        job_id = job["id"]
        client = get_flow_client()

        # The account's own credit limit, when one is set: move on before
        # Google has to refuse the clip.
        if not accounts.active_affords_clip():
            if accounts.rotate(accounts.LIMIT_MARKER) is not None:
                logger.warning("job %s: credit limit reached, switching Google account", job_id[:8])
                await jobs.requeue(job_id, "Credit limit reached on this account; moving to the next one")
                return
            await jobs.fail(job_id, "Every Google account has reached the credit limit set for it "
                                    "(Setup -> Google accounts). Raise a limit, add an account, or wait for the reset.")
            return

        project_id = accounts.active_project() or job["project_id"] or FLOW_PROJECT_ID

        try:
            reference_urls = json.loads(job["reference_urls"] or "[]")
        except json.JSONDecodeError:
            await jobs.fail(job_id, "reference_urls is not valid JSON")
            return

        if not reference_urls:
            await jobs.fail(job_id, "A video needs at least one reference image")
            return

        # The transport Flow actually uses for video now. The REST path below is
        # kept -- it is what images use and what video used until Google moved --
        # but video over REST answers INVALID_ARGUMENT, so this goes first.
        if VIDEO_USE_BATCH:
            if await self._run_video_batch(job, reference_urls, project_id):
                return
            logger.warning("job %s: batch path declined — trying REST", job_id[:8])

        # -- Stage 1: give Google the reference images. ----------------------
        media_ids: list[str] = []
        for url in reference_urls:
            uploaded = await self._upload_reference(client, url, project_id)
            if isinstance(uploaded, dict):
                await self._handle_failure(job, uploaded["error"])
                return
            media_ids.append(uploaded)

        logger.info("job %s uploaded %d reference image(s)", job_id[:8], len(media_ids))

        # -- Stage 2: submit. ------------------------------------------------
        aspect_ratio = VIDEO_ASPECT_RATIOS.get(
            job["orientation"], VIDEO_ASPECT_RATIOS["VERTICAL"]
        )
        submitted, refusals = await self._submit_video(
            client, job, media_ids, project_id, aspect_ratio
        )

        if is_error(submitted):
            await self._handle_failure(job, self._submit_error(submitted, refusals))
            return
        accounts.record_clip()

        operation = extract_operation(submitted)
        if operation:
            await jobs.set_operation(job_id, operation)
            logger.info("job %s submitted, polling the operation", job_id[:8])
            await self._await_video(job, operation)
            return

        # No operations[]: Google answers this submit with a workflow and the
        # media record it will fill. Nothing in that can be handed to
        # check_video_status, but the media id alone is enough -- get_media
        # returns the signed URL once the video exists.
        handle = extract_media_handle(submitted)
        if handle:
            await jobs.set_operation(job_id, handle)
            logger.info(
                "job %s submitted as workflow %s, polling media %s",
                job_id[:8], handle["workflowId"][:8], handle["mediaId"][:8],
            )
            await self._await_media(job, handle)
            return

        logger.error(
            "job %s: cannot read the video submit response. Full body: %s",
            job_id[:8],
            json.dumps(submitted, default=str),
        )
        data = submitted.get("data", submitted)
        shape = ",".join(sorted(data.keys())) if isinstance(data, dict) else type(data).__name__
        await self._handle_failure(
            job,
            f"Video submitted and accepted, but the reply was not in a shape this "
            f"service can read, so nothing polled for the result. The generation may "
            f"still have run and the credits are spent. Reply carried: {shape}.\n\n"
            f"{json.dumps(submitted, default=str)[:6000]}",
        )

    async def _fetch_reference(self, url: str):
        """The image bytes and their type. {"error": ...} if it cannot be had.

        The download half of _upload_reference, on its own, because the batch
        path uploads through a different call and the two transports do not hand
        out interchangeable media ids. _upload_reference is left untouched: it is
        what images still use, and images still work.
        """
        try:
            async with httpx.AsyncClient(
                timeout=REFERENCE_DOWNLOAD_TIMEOUT, follow_redirects=True
            ) as http:
                response = await http.get(url)
                response.raise_for_status()
                data = response.content
        except Exception as exc:
            return {"error": f"Could not fetch reference image {url}: {exc}"}

        if not data:
            return {"error": f"Reference image {url} was empty"}
        if len(data) > MAX_REFERENCE_BYTES:
            return {"error": f"Reference image {url} is {len(data)} bytes, over the limit"}

        mime = response.headers.get("content-type", "image/jpeg").split(";")[0]
        return {"bytes": data, "mime": mime}

    async def _run_video_batch(self, job, reference_urls, project_id) -> bool:
        """The whole video, over the transport Flow actually uses now.

        REST video answers INVALID_ARGUMENT and will not come back: Flow Kit's
        client stopped sending video that way entirely when Flow moved to
        batchexecute. Every step here runs inside the signed-in Flow tab.

        Every reference is an ingredient, and so are the presenter's character
        and voice when the job names them: one request, the shape Flow's own
        UI sends (flow_batch.reel_request).

        Returns True if the job was settled here, either finished or failed for
        a reason the old path cannot improve on.
        """
        job_id = job["id"]
        client = get_flow_client()
        aspect = VIDEO_ASPECT_RATIOS.get(job["orientation"], VIDEO_ASPECT_RATIOS["VERTICAL"])

        # Every reference goes up: they are the clip's ingredients, and Flow
        # composes from all of them.
        media_ids: list[str] = []
        for url in reference_urls[:3]:
            fetched = await self._fetch_reference(url)
            if "error" in fetched:
                await self._handle_failure(job, fetched["error"])
                return True
            uploaded = await client.upload_image_batch(
                image_base64=base64.b64encode(fetched["bytes"]).decode("ascii"),
                project_id=project_id,
                mime_type=fetched["mime"],
                file_name=url.rsplit("/", 1)[-1][:100] or "reference.jpg",
            )
            if uploaded.get("error"):
                await self._handle_failure(job, f"Uploading a reference failed: {uploaded['error']}")
                return True
            media_ids.append(uploaded["media_id"])

        submitted = await client.generate_reel_batch(
            prompt=job["prompt"],
            project_id=project_id,
            image_media_ids=media_ids,
            character_media_id=job.get("character_media_id") or None,
            voice_media_id=job.get("voice_media_id") or None,
            aspect_ratio=aspect,
        )

        if submitted.get("error"):
            detail = submitted["error"]
            if video_models.out_of_credits(detail):
                # Not a hiccup: the account's video credits are spent. With a
                # second Google account the job goes back in line for it;
                # with one, a retry is another upload and another captcha for
                # the same answer.
                if accounts.rotate("no video credits left") is not None:
                    logger.warning("job %s: out of video credits, switching Google account", job_id[:8])
                    await jobs.requeue(job_id, "Out of video credits on this account; moving to the next one")
                    return True
                message = ("This Google account has no video credits left on Flow. "
                           "Nothing was generated. Wait for the credits to reset "
                           "or add more, then run the reel again.")
                logger.error("job %s FAILED: %s", job_id[:8], message)
                await jobs.fail(job_id, message)
                return True
            await self._handle_failure(job, f"Clip submit failed: {detail}")
            return True

        operation_id = submitted["operation_id"]
        accounts.record_clip()
        listing_project = submitted.get("project_id") or project_id
        await jobs.set_operation(job_id, {"operationId": operation_id})
        logger.info("job %s submitted on the batch path, operation %s",
                    job_id[:8], operation_id[:8])

        await self._await_video_batch(job, operation_id, listing_project)
        return True

    async def _await_video_batch(self, job, operation_id: str, project_id: str) -> None:
        """Poll the operation, then read the finished video's URL.

        Measured on the deployed container: for this account the operation poll
        never carries a status at all -- every answer is

            [opId, None, None, None, None, [..., [4, "Media not found."]]]

        while the finished video is sitting in the project. So the poll cannot
        be the only done-signal. When it says nothing, the project listing is
        checked instead, once a minute, and the video is taken from there.
        """
        job_id = job["id"]
        client = get_flow_client()

        seen_status = object()  # so the very first poll is always logged
        watching_listing = False
        listing_misses = 0
        ever_had_status = False  # did Flow ever say anything about this operation?

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

            state = await client.check_operation_batch(operation_id)
            if state.get("error"):
                logger.warning("job %s poll %d: %s", job_id[:8], attempt, state["error"])
                continue

            # Once per change, not once per poll: eighty polls of "still
            # pending" is noise, and a video that never leaves its first status
            # is the thing worth seeing.
            if state.get("status") or state.get("done"):
                ever_had_status = True

            if state.get("status") != seen_status:
                seen_status = state.get("status")
                logger.info(
                    "job %s poll %d: operation is %s%s",
                    job_id[:8], attempt, seen_status or "?",
                    f" ({state['complaint']})" if state.get("complaint") else "",
                )
                if state.get("raw"):
                    logger.warning("job %s poll %d: no status in the answer: %s",
                                   job_id[:8], attempt, state["raw"])

            if state.get("done"):
                logger.info("job %s: operation finished — looking up the media",
                            job_id[:8])
            elif state.get("status"):
                continue  # Google says it is still working; believe it
            else:
                # No status at all. Nothing more will come from this poll, so
                # the listing is where a finished video shows up.
                if not watching_listing:
                    watching_listing = True
                    logger.info("job %s: the poll carries no status — watching the "
                                "project listing for the video instead", job_id[:8])
                if attempt % LISTING_EVERY_N_POLLS:
                    continue

            # The operation record does not carry the media id -- the third
            # uuid in it is the scene -- so it is read out of the project listing.
            found = await client.find_operation_media_batch(operation_id, project_id)
            if found.get("error") or not found.get("media_id"):
                listing_misses += 1
                if state.get("done") or listing_misses == 1:
                    logger.warning("job %s: no media for the operation in the project "
                                   "yet (%s)", job_id[:8], found.get("error") or "not in listing")
                # Flow never gave a status and the video is still not in the
                # project: this account accepted the request and made nothing
                # (seen for hours on one account while the others delivered in
                # a minute). Stop waiting and move the work on.
                if (not ever_had_status and not found.get("error")
                        and attempt * VIDEO_POLL_INTERVAL >= VIDEO_LISTING_GIVEUP_S):
                    await self._video_never_appeared(job, attempt * VIDEO_POLL_INTERVAL)
                    return
                continue

            urls = await client.get_media_urls_batch(found["media_id"])
            if urls.get("error"):
                logger.warning("job %s: %s", job_id[:8], urls["error"])
                continue
            if not urls.get("video_url"):
                continue  # in the project, still rendering

            await jobs.complete(job_id, found["media_id"], urls["video_url"])
            logger.info("job %s COMPLETED", job_id[:8])
            return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        await self._handle_failure(
            job,
            f"Video did not finish within {waited}s ({VIDEO_MAX_POLLS} polls). "
            "Raise VIDEO_MAX_POLLS if generation is legitimately slower.",
        )

    async def _video_never_appeared(self, job: dict, waited: int) -> None:
        """A video this account accepted but never produced: next account, or a clear failure."""
        job_id = job["id"]
        problem = (f"Flow accepted the video but nothing appeared in the project after {waited}s "
                   "on this Google account (no status, not in the listing)")
        if accounts.rotate(problem) is not None:
            logger.warning("job %s: %s — switching Google account", job_id[:8], problem)
            await jobs.requeue(job_id, problem + "; moving to the next account")
            return
        message = (problem + ". Nothing was generated. Check this account's video credits "
                   "and access on Flow, or add another account under Setup -> Google accounts.")
        logger.error("job %s FAILED: %s", job_id[:8], message)
        await jobs.fail(job_id, message)

    async def _submit_video(self, client, job, media_ids, project_id, aspect_ratio):
        """Submit the video, working out which model name Flow still accepts.

        `videoModelKey` is the one field in this body that is a bare string
        Google retires on its own schedule, and every reel here started failing
        with INVALID_ARGUMENT -- Flow refusing the request rather than the
        images. Naming the replacement in a setting only works while the guess
        is right and has to be made again by hand each time Google moves, so the
        names are a list and this walks it.

        Reference video is tried before image video, because reading all four
        photographs is the point of a reel. Its refusal is not fatal: a video
        built from the first image is worse than the one asked for and a great
        deal better than none, which is also what Flow Kit does here.

        Only a refusal advances the list. A rate limit, a dropped browser or a
        rejected captcha are about when the request was sent, and walking past
        them would spend a reel's quality -- and a captcha per step -- on
        something the ordinary retry clears.

        Returns the last response and every refusal along the way, so a reel
        that exhausts the list can say what it tried rather than repeating one
        opaque error.
        """
        job_id = job["id"]
        refusals: list[str] = []
        submitted: dict = {}

        for kind, model in video_models.plan(aspect_ratio):
            if kind == "r2v":
                submitted = await client.generate_video_from_references(
                    reference_media_ids=media_ids,
                    prompt=job["prompt"],
                    project_id=project_id,
                    aspect_ratio=aspect_ratio,
                    model_key=model,
                )
            else:
                submitted = await client.generate_video_from_image(
                    start_image_media_id=media_ids[0],
                    prompt=job["prompt"],
                    project_id=project_id,
                    # No scenes here. The captured payload carries a unique id
                    # in this slot, and the job id is already unique per video.
                    scene_id=job_id,
                    aspect_ratio=aspect_ratio,
                    model_key=model,
                )

            if not is_error(submitted):
                if kind == "i2v" and len(media_ids) > 1:
                    logger.warning(
                        "job %s: built from 1 of %d image(s) — reference video is "
                        "refused, so the other %d were not read",
                        job_id[:8], len(media_ids), len(media_ids) - 1,
                    )
                video_models.remember(aspect_ratio, kind, model)
                return submitted, refusals

            if not rejected_the_request(submitted):
                # Transient. Stop here and let the retry policy have it, rather
                # than burning the rest of the list on a bad minute.
                return submitted, refusals

            refusals.append(f"{kind}/{model}: {error_text(submitted)[:160]}")
            logger.warning(
                "job %s: Flow refused %s (%s) — trying the next model",
                job_id[:8], model, kind,
            )
            # A remembered name that starts being refused has been retired too.
            video_models.forget(aspect_ratio)

        return submitted, refusals

    @staticmethod
    def _submit_error(submitted: dict, refusals: list[str]) -> str:
        """One message naming everything that was refused.

        A reel that has exhausted the list is the answer to a bigger question
        than "this one failed": every model name this service knows was refused,
        which says the old endpoint is closed to this account for video rather
        than that one name went stale. That deserves to be legible in the
        failure rather than inferred from repeats.
        """
        if len(refusals) <= 1:
            return error_text(submitted)

        tried = "\n".join(f"  - {line}" for line in refusals)
        return (
            f"Flow refused every video model this service knows ({len(refusals)} "
            f"tried). That is not one stale name — it means this account can no "
            f"longer generate video through this endpoint at all.\n\n{tried}"
        )

    async def _upload_reference(self, client, url: str, project_id: str):
        """One reference image, fetched and handed to Flow.

        Returns the media id, or a {"error": ...} dict for the caller to route
        through the retry policy -- a transient fetch failure is worth the same
        treatment as a transient Flow failure, not a different one.
        """
        try:
            async with httpx.AsyncClient(
                timeout=REFERENCE_DOWNLOAD_TIMEOUT, follow_redirects=True
            ) as http:
                response = await http.get(url)
                response.raise_for_status()
                data = response.content
        except Exception as exc:
            return {"error": f"Could not fetch reference image {url}: {exc}"}

        if not data:
            return {"error": f"Reference image {url} was empty"}
        if len(data) > MAX_REFERENCE_BYTES:
            return {"error": f"Reference image {url} is {len(data)} bytes, over the limit"}

        result = await client.upload_image(
            image_base64=base64.b64encode(data).decode("ascii"),
            mime_type=response.headers.get("content-type", "image/jpeg").split(";")[0],
            project_id=project_id,
            file_name=url.rsplit("/", 1)[-1][:100] or "reference.jpg",
        )

        if is_error(result):
            return {"error": f"Uploading {url} to Flow failed: {error_text(result)}"}

        media_id = result.get("_mediaId")
        if not media_id:
            return {"error": f"Flow returned no mediaId for {url}"}

        return media_id

    async def _await_video(self, job: dict, operation: dict) -> None:
        """Poll one operation until it resolves, fails, or runs out of budget."""
        job_id = job["id"]
        client = get_flow_client()

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

            # A shutdown mid-generation leaves the job PROCESSING with its
            # operation stored, so reset_stale returns it to the queue and the
            # next attempt resumes rather than paying for a second video.
            if self._shutdown.is_set():
                logger.info("job %s: polling interrupted by shutdown", job_id[:8])
                return

            status = await client.check_video_status([operation])

            if is_error(status):
                await self._handle_failure(job, error_text(status))
                return

            failure = video_failed(status)
            if failure:
                await self._handle_failure(job, f"Video generation failed: {failure}")
                return

            url = extract_video_url(status)
            if url:
                await jobs.complete(job_id, extract_video_media_id(status), url)
                logger.info("job %s COMPLETED after %d poll(s)", job_id[:8], attempt)
                return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        await self._handle_failure(
            job,
            f"Video did not finish within {waited}s ({VIDEO_MAX_POLLS} polls). "
            "Raise VIDEO_MAX_POLLS if generation is legitimately slower.",
        )

    async def _await_media(self, job: dict, handle: dict) -> None:
        """Poll one media id until it carries a URL, or the budget runs out.

        The same budget as _await_video on purpose: this is the same wait for
        the same video, asked a different way, and giving it its own timeout
        would mean two numbers to keep in step.
        """
        job_id = job["id"]
        media_id = handle["mediaId"]
        client = get_flow_client()
        last = {}

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

            # As in _await_video: the handle is stored, so a shutdown here
            # resumes on the next attempt rather than paying for a second video.
            if self._shutdown.is_set():
                logger.info("job %s: polling interrupted by shutdown", job_id[:8])
                return

            status = await client.get_media(media_id)

            # A media id that is not ready can answer 404 for a while. That is
            # the wait, not a failure -- only a hard error ends it.
            if is_error(status) and status.get("status") not in (404, 429):
                await self._handle_failure(job, error_text(status))
                return

            last = status
            url = extract_media_url(status)
            if url:
                await jobs.complete(job_id, media_id, url)
                logger.info("job %s COMPLETED after %d media poll(s)", job_id[:8], attempt)
                return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        logger.error(
            "job %s: media %s never carried a URL. Last body: %s",
            job_id[:8], media_id[:8], json.dumps(last, default=str),
        )
        await self._handle_failure(
            job,
            f"The video was submitted and Google created media {media_id}, but it "
            f"carried no URL within {waited}s ({VIDEO_MAX_POLLS} polls). Raise "
            f"VIDEO_MAX_POLLS if generation is legitimately slower.\n\n"
            f"{json.dumps(last, default=str)[:6000]}",
        )

    async def _handle_failure(self, job: dict, error: str) -> None:
        job_id = job["id"]
        lower = error.lower()
        retryable = any(marker in lower for marker in RETRYABLE)

        # A problem with the account rather than the request -- spent credits,
        # an exhausted quota, a signed-out session -- moves the work to the next
        # Google account, when there is one. The job goes back in line for it;
        # once every account is resting, rotate() finds nowhere to go and the
        # ordinary retry policy below takes over, so this cannot loop.
        if any(m in lower for m in accounts.CREDIT_MARKERS + accounts.SIGNED_OUT_MARKERS):
            if accounts.rotate(error) is not None:
                logger.warning("job %s: account problem, switching Google account: %s", job_id[:8], error[:160])
                await jobs.requeue(job_id, error)
                return

        # Google flagging this account's activity: retrying on it does not
        # help, so a run of these moves the work to the next account. The
        # first one is retried when there is another account to fall back on.
        if accounts.UNUSUAL_MARKER in lower:
            if accounts.note_unusual_activity() and accounts.rotate(error) is not None:
                logger.warning("job %s: unusual activity again, switching Google account", job_id[:8])
                await jobs.requeue(job_id, error)
                return
            if accounts.count() > 1 and job["attempts"] < MAX_RETRIES:
                await jobs.requeue(job_id, error)
                return

        # The Flow page kept coming up without its sign-in token, even after the
        # reloads the retries do: this account's Google session is gone. Left
        # alone, every job fails the same way for hours (found that way one
        # night), so on the last try it is marked signed out -- the Google
        # accounts page then says to sign in again -- and the work moves on.
        #
        # An account that has never got anything out of Flow is not signed
        # out: it is a new one whose Labs terms and welcome screens are still
        # waiting. Said so, because signing in again does not help it.
        if "no_at_token" in lower and job["attempts"] >= MAX_RETRIES:
            never_worked = not accounts.active_has_worked()
            problem = (
                f"{accounts.FLOW_SETUP_MARKER}: the Flow page has no sign-in token (NO_AT_TOKEN) on an account that never worked"
                if never_worked
                else "Signed out of Google: the Flow page has no sign-in token (NO_AT_TOKEN)"
            )
            if accounts.rotate(problem) is not None:
                logger.warning("job %s: %s, switching Google account", job_id[:8],
                               "Flow not set up on this account" if never_worked else "Flow page signed out")
                await jobs.requeue(job_id, error)
                return
            error = (
                f"{error} — this Google account is signed in but Flow is not set up on it yet. "
                "Open Browser, go to labs.google/flow once, accept the terms, then press Reset on the account under Setup → Google accounts."
                if never_worked
                else f"{error} — the Google account in the platform's browser looks signed out of Flow. "
                "Open Browser, sign in to labs.google/flow, then retry (or press Reset on the account under Setup → Google accounts)."
            )

        if "high_traffic" in lower and job["attempts"] < MAX_RETRIES:
            # Busy servers clear on their own; asking again at once is what
            # keeps them busy. Wait, then go back in line.
            logger.warning("job %s: Google busy (high traffic), retrying in %ds", job_id[:8], HIGH_TRAFFIC_WAIT_S)
            await asyncio.sleep(HIGH_TRAFFIC_WAIT_S)
            await jobs.requeue(job_id, error)
            return

        if retryable and job["attempts"] < MAX_RETRIES:
            logger.warning(
                "job %s attempt %d/%d failed, requeueing: %s",
                job_id[:8], job["attempts"], MAX_RETRIES, error[:200],
            )
            await jobs.requeue(job_id, error)
            return

        # A run of jobs failing on this account, for any reason Google gave or
        # none at all, moves the work to the next account -- the way changing
        # it by hand fixed it. The job that tipped it goes back in line for
        # that account instead of failing its article.
        if accounts.count() > 1 and not _about_the_request(lower) and accounts.note_failure():
            problem = (f"{accounts.FAIL_STREAK} jobs in a row failed on this account, "
                       f"last: {error[:120]}")
            if accounts.rotate(problem) is not None:
                logger.warning("job %s: %s — switching Google account", job_id[:8], problem)
                await jobs.requeue(job_id, error + " — moving to the next Google account")
                return

        logger.error("job %s FAILED: %s", job_id[:8], error[:300])
        await jobs.fail(job_id, error)


# Failures that are about the job itself, not the Google account it ran on:
# another account would fail them the same way, so they do not count.
REQUEST_FAULTS = ("empty_prompt", "reference_urls is not valid", "could not fetch reference",
                  "reference image", "no google account is set")


def _about_the_request(lower: str) -> bool:
    return any(marker in lower for marker in REQUEST_FAULTS)


_controller: WorkerController | None = None


def get_worker_controller() -> WorkerController:
    global _controller
    if _controller is None:
        _controller = WorkerController()
    return _controller
