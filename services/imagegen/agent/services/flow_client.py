"""
Flow Client — communicates with Google Flow API via Chrome extension WebSocket bridge.

Agent runs a WS server. Extension connects as client. Agent sends API requests,
extension executes them in browser context (residential IP, cookies, reCAPTCHA).
"""
import asyncio
import json
import logging
import random
import time
import uuid
from typing import Optional

from agent.config import (
    GOOGLE_FLOW_API, GOOGLE_API_KEY, ENDPOINTS,
    IMAGE_MODELS, VIDEO_MODELS, VIDEO_MODEL_KEY, VIDEO_PAYGATE_TIER,
    I2V_MODEL_KEY,
)
from agent.services import flow_batch as fb
from agent.services.headers import random_headers

logger = logging.getLogger(__name__)


class FlowClient:
    """Sends commands to Chrome extension via WebSocket."""

    def __init__(self):
        self._extension_ws = None  # Set by WS server when extension connects
        self._pending: dict[str, asyncio.Future] = {}
        self._flow_key: Optional[str] = None
        # Account rotation state
        self.accounts: list[str] = []
        self.current_auth_user: int = 0
        self._rotation_enabled: bool = True
        self._accounts_loaded: bool = False
        # WS stats
        self._ws_connect_count = 0
        self._ws_disconnect_count = 0
        self._ws_connected_at: Optional[float] = None
        self._ws_last_disconnect_at: Optional[float] = None

    def set_extension(self, ws):
        """Called when extension connects via WS."""
        self._extension_ws = ws
        self._ws_connect_count += 1
        self._ws_connected_at = time.time()
        logger.info("Extension connected #%d (waiting for extension_ready/token_captured to sync)", self._ws_connect_count)

    def clear_extension(self):
        """Called when extension disconnects."""
        self._extension_ws = None
        self._ws_disconnect_count += 1
        self._ws_last_disconnect_at = time.time()
        # Cancel all pending futures (copy to avoid RuntimeError on concurrent modification)
        pending_copy = list(self._pending.items())
        count = len(pending_copy)
        for req_id, future in pending_copy:
            if not future.done():
                future.set_exception(ConnectionError("Extension disconnected"))
        self._pending.clear()
        logger.warning("Extension disconnected, cleared %d pending requests", count)

    def set_flow_key(self, key: str):
        self._flow_key = key

    @property
    def connected(self) -> bool:
        return self._extension_ws is not None

    @property
    def ws_stats(self) -> dict:
        uptime = None
        if self._ws_connected_at and self.connected:
            uptime = int(time.time() - self._ws_connected_at)
        return {
            "connected": self.connected,
            "connects": self._ws_connect_count,
            "disconnects": self._ws_disconnect_count,
            "uptime_s": uptime,
        }

    # ─── Account Rotation ─────────────────────────────────────

    def load_accounts(self):
        """Load account config from accounts.json."""
        if self._accounts_loaded:
            return
        accounts_path = __import__("os").path.join(
            __import__("pathlib").Path(__file__).parent.parent, "accounts.json"
        )
        try:
            if __import__("os").path.isfile(accounts_path):
                with open(accounts_path) as f:
                    cfg = json.load(f)
                self.accounts = cfg.get("accounts", [])
                self.current_auth_user = cfg.get("current_auth_user", 0)
                self._rotation_enabled = cfg.get("auto_rotate", True)
                logger.info("Accounts loaded: %d accounts, authuser=%d, rotation=%s",
                            len(self.accounts), self.current_auth_user, self._rotation_enabled)
            self._accounts_loaded = True
        except Exception as e:
            logger.warning("Failed to load accounts: %s", e)
            self._accounts_loaded = True

    def save_accounts(self):
        """Save current account config to accounts.json."""
        accounts_path = __import__("os").path.join(
            __import__("pathlib").Path(__file__).parent.parent, "accounts.json"
        )
        try:
            with open(accounts_path, "w") as f:
                json.dump({
                    "accounts": self.accounts,
                    "auto_rotate": self._rotation_enabled,
                    "current_auth_user": self.current_auth_user,
                }, f, indent=2)
            logger.info("Accounts saved: %d accounts", len(self.accounts))
        except Exception as e:
            logger.warning("Failed to save accounts: %s", e)

    async def sync_accounts_to_extension(self):
        """Send current accounts config to the extension."""
        if not self._extension_ws:
            logger.warning("Cannot sync accounts: extension not connected")
            return False
        try:
            await self._extension_ws.send(json.dumps({
                "method": "set_accounts",
                "params": {
                    "accounts": self.accounts,
                    "autoRotate": self._rotation_enabled,
                    "currentAuthUser": self.current_auth_user,
                },
            }))
            logger.info("Accounts synced to extension")
            return True
        except Exception as e:
            logger.warning("Failed to sync accounts: %s", e)
            return False

    # Rotation is triggered per rate-limited response. With
    # MAX_CONCURRENT_REQUESTS in flight, one quota wall produces a burst of
    # identical triggers — each of which makes the extension navigate the Flow
    # tab through accounts.google.com, the window in which a healthy tab stops
    # matching the Flow URL patterns and callers start opening replacements.
    # One rotation per cooldown is enough; the rest are redundant by definition.
    _ROTATE_COOLDOWN_S = 60
    _rotate_lock: asyncio.Lock | None = None
    _last_rotate_at: float = 0.0

    async def _rotate_account_auto(self):
        """Called when a rate-limit is detected. Rotates to the next account."""
        if self._rotate_lock is None:
            self._rotate_lock = asyncio.Lock()
        if self._rotate_lock.locked():
            logger.debug("Account rotation already in progress, skipping duplicate trigger")
            return {"ok": False, "reason": "rotation in progress"}
        async with self._rotate_lock:
            since = time.time() - self._last_rotate_at
            if since < self._ROTATE_COOLDOWN_S:
                logger.info("Account rotation suppressed (%.0fs since last, cooldown %ds)",
                            since, self._ROTATE_COOLDOWN_S)
                return {"ok": False, "reason": "rotation cooldown"}
            self._last_rotate_at = time.time()
            return await self._rotate_account_auto_locked()

    async def _rotate_account_auto_locked(self):
        self.load_accounts()

        if not self.accounts or len(self.accounts) < 2:
            logger.info("Account rotation: need at least 2 accounts, have %d", len(self.accounts))
            return {"ok": False, "reason": "need 2+ accounts"}

        if not self._rotation_enabled:
            logger.info("Account rotation disabled")
            return {"ok": False, "reason": "rotation disabled"}

        next_user = (self.current_auth_user + 1) % len(self.accounts)
        logger.info("Rotating account: authuser %d -> %d (%s)",
                    self.current_auth_user, next_user, self.accounts[next_user])

        if not self._extension_ws:
            return {"ok": False, "reason": "extension not connected"}

        try:
            # Send switch_account command to extension
            await self._extension_ws.send(json.dumps({
                "method": "switch_account",
                "params": {"authUser": next_user, "auto": True},
            }))
            logger.info("Account rotation command sent to extension")
            return {"ok": True, "from": self.current_auth_user, "to": next_user}
        except Exception as e:
            logger.warning("Account rotation failed: %s", e)
            return {"ok": False, "error": str(e)}

    async def handle_message(self, data: dict):
        """Handle incoming message from extension."""
        if data.get("type") == "token_captured":
            self._flow_key = data.get("flowKey")
            logger.info("Flow key captured from extension")
            return

        if data.get("type") == "extension_ready":
            logger.info("Extension ready, flowKey=%s", "yes" if data.get("flowKeyPresent") else "no")
            self.load_accounts()
            asyncio.create_task(self.sync_accounts_to_extension())
            return

        if data.get("type") == "media_urls_refresh":
            # The extension still announces these; they only ever updated scene
            # and character rows, which no longer exist.
            return

        if data.get("type") == "pong":
            return

        if data.get("type") == "ping":
            # Respond to keepalive
            if self._extension_ws:
                await self._extension_ws.send(json.dumps({"type": "pong"}))
            return

        # Response to a pending request
        req_id = data.get("id")
        if req_id and req_id in self._pending:
            if not self._pending[req_id].done():
                self._pending[req_id].set_result(data)
            return

    _UUID_RE = __import__("re").compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    _SAFE_URL_RE = __import__("re").compile(r'^https://(storage\.googleapis\.com|lh3\.googleusercontent\.com)/')

    async def ensure_fresh_token(self, max_age_s: float) -> dict:
        """Reload the Flow tab so the batch starts on a token that will outlive it.

        The bearer lasts about an hour and nothing renews it on its own: capture
        is passive, driven by the Authorization header on requests the Flow page
        makes, so an idle tab keeps serving the same expiring token until someone
        reloads it by hand. That is the manual refresh operators kept having to
        do, and this is it done on schedule instead.

        A reload, not a re-auth: cookies and the signed-in Google account are
        untouched, so nobody has to sign in again.

        `max_age_s` of 0 — the default the worker passes — always reloads.
        Anything else is a hint the extension checks against its own capture
        timestamp, for a deployment that would rather skip a recent one.
        """
        if not self._extension_ws:
            return {"ok": False, "error": "Extension not connected"}

        return await self._send(
            "refresh_token",
            {"maxAgeMs": int(max_age_s * 1000)},
            # Bounded well under the worker's poll: the reload polls for a new
            # token for up to 20s, and a batch delayed is better than a batch
            # sent on a token that is about to expire.
            timeout=45,
        )

    async def get_diagnostics(self) -> dict:
        """Everything the extension knows about its own state.

        Short timeout on purpose: this is asked when something is already
        wrong, and a diagnostic that hangs for five minutes is no use to the
        person asking.
        """
        return await self._send("get_diagnostics", {}, timeout=15)

    async def refresh_project_urls(self, project_id: str) -> dict:
        """Refresh media URLs for a project.

        Note: Google Flow's get_media API returns encoded content (base64),
        not fresh signed URLs. URL refresh requires TRPC intercept from
        the extension when the user opens the project in Chrome.
        The video reviewer falls back to get_media content directly.
        """
        logger.info("URL refresh requested for project %s — TRPC endpoint no longer available, "
                     "use extension passive intercept (open project in Chrome)", project_id[:12])
        return {"refreshed": 0, "found": 0, "note": "TRPC endpoint unavailable. "
                "Video reviewer uses get_media fallback automatically. "
                "For URL refresh, open the project in Google Flow in Chrome."}

    async def _send(self, method: str, params: dict, timeout: float = 300) -> dict:
        """Send request to extension and wait for response.

        Always returns a dict. On error, returns {"error": "<reason>"} — callers
        must check result.get("error") or use _is_ws_error() before reading data.
        Never raises; exceptions are caught and returned as error dicts.

        If the response indicates rate limiting, triggers automatic account rotation.
        """
        if not self._extension_ws:
            return {"error": "Extension not connected"}

        req_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future

        try:
            await self._extension_ws.send(json.dumps({
                "id": req_id,
                "method": method,
                "params": params,
            }))
            result = await asyncio.wait_for(future, timeout=timeout)

            # Check for rate-limit responses and trigger auto-rotation
            if self._is_rate_limited(result) and self._rotation_enabled:
                logger.warning("Rate limit detected (status=%s), triggering account rotation",
                               result.get("status"))
                # Fire-and-forget rotation — don't block the caller
                asyncio.create_task(self._rotate_account_auto())

            return result
        except asyncio.TimeoutError:
            return {"error": f"Timeout ({timeout}s) waiting for {method}"}
        except Exception as e:
            return {"error": str(e)}
        finally:
            self._pending.pop(req_id, None)

    @staticmethod
    def _is_rate_limited(result: dict) -> bool:
        """Check if an API response indicates rate limiting / quota exceeded."""
        if result.get("status") == 429:
            return True
        data = result.get("data", {})
        if isinstance(data, dict):
            err = data.get("error", "")
            if isinstance(err, str) and any(k in err.lower() for k in
                ("quota", "rate_limit", "exhausted", "resource_exhausted", "too many")):
                return True
            if isinstance(err, dict):
                msg = err.get("message", "")
                if any(k in msg.lower() for k in ("quota", "rate_limit", "exhausted", "resource_exhausted")):
                    return True
        error_msg = result.get("error", "")
        if isinstance(error_msg, str) and any(k in error_msg.lower() for k in
            ("quota", "rate_limit", "exhausted", "resource_exhausted", "429")):
            return True
        return False

    def _build_url(self, endpoint_key: str, **kwargs) -> str:
        """Build full API URL."""
        path = ENDPOINTS[endpoint_key].format(**kwargs)
        sep = "&" if "?" in path else "?"
        return f"{GOOGLE_FLOW_API}{path}{sep}key={GOOGLE_API_KEY}"

    def _client_context(self, project_id: str, user_paygate_tier: str = "PAYGATE_TIER_TWO") -> dict:
        """Build clientContext with recaptcha placeholder."""
        return {
            "projectId": str(project_id),
            "recaptchaContext": {
                "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                "token": "",  # Extension injects real token
            },
            "sessionId": f";{int(time.time() * 1000)}",
            "tool": "PINHOLE",
            "userPaygateTier": user_paygate_tier,
        }

    def _image_client_context(self, project_id: str) -> dict:
        """Build the clientContext used by batchGenerateImages.

        Matches the shape Google Flow's own UI sends: no userPaygateTier.
        The extension fills in the recaptcha token (see background.js — it
        walks clientContext.recaptchaContext and every requests[].clientContext).
        """
        return {
            "recaptchaContext": {
                "token": "",  # Extension injects real token
                "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            },
            "projectId": str(project_id),
            "tool": "PINHOLE",
            "sessionId": f";{int(time.time() * 1000)}",
        }

    @staticmethod
    def _resolve_image_model(image_model_name: str | None) -> str:
        """Resolve an image model name to the value the API expects.

        Accepts a friendly alias from models.json (NANO_BANANA_2) or a raw
        API name (BELUGA). Defaults to BELUGA — what the UI currently sends.
        """
        if not image_model_name:
            return "BELUGA"
        return IMAGE_MODELS.get(image_model_name, image_model_name)

    # ─── High-level API Methods ──────────────────────────────

    async def create_project(self, project_title: str, tool_name: str = "PINHOLE") -> dict:
        """Create a project on Google Flow via tRPC endpoint.

        Returns the full response including projectId.
        """
        url = "https://labs.google/fx/api/trpc/project.createProject"
        body = {"json": {"projectTitle": project_title, "toolName": tool_name}}

        return await self._send("trpc_request", {
            "url": url,
            "method": "POST",
            "headers": {
                "content-type": "application/json",
                "accept": "*/*",
            },
            "body": body,
        }, timeout=30)

    async def generate_images(self, prompt: str, project_id: str,
                               aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT",
                               user_paygate_tier: str = "PAYGATE_TIER_TWO",
                               character_media_ids: list[str] = None,
                               image_model_name: str | None = None) -> dict:
        """Generate image(s) via flowMedia:batchGenerateImages.

        Payload matches a captured request from Google Flow's own UI: a batch
        wrapper (clientContext + requests[]) with the clientContext repeated
        inside each request item, which is where the extension injects the
        recaptcha token.

        Response structure:
            data.media[].name = mediaId (used for video gen)
        """
        client_context = self._image_client_context(project_id)

        image_inputs = []
        if character_media_ids:
            image_inputs = [
                {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                for mid in character_media_ids
            ]

        request = {
            "clientContext": client_context,
            "imageModelName": self._resolve_image_model(image_model_name),
            "imageAspectRatio": aspect_ratio,
            "structuredPrompt": {"parts": [{"text": prompt}]},
            "seed": random.randint(1, 999999),
            "imageInputs": image_inputs,
        }

        body = {
            "clientContext": client_context,
            "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
            "useNewMedia": True,
            "requests": [request],
        }

        url = self._build_url("generate_images", project_id=project_id)
        return await self._send("api_request", {
            "url": url,
            "method": "POST",
            "headers": random_headers(),
            "body": body,
            "captchaAction": "IMAGE_GENERATION",
        })

    async def generate_video_from_references(
        self,
        reference_media_ids: list[str],
        prompt: str,
        project_id: str,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        model_key: str = "",
    ) -> dict:
        """Generate a video composed from reference images (r2v).

        The request body is part of the frozen surface: it is what the Flow UI
        sends, recovered from a working capture. Reshaping any of it -- the
        nesting of textInput, the imageUsageType, the empty metadata -- produces
        requests Google rejects with no useful detail.

        reference_media_ids come from upload_image, not from anything we stored
        earlier: uploading at generation time means an article from any date can
        be turned into a video, and no media id has to outlive its job.
        """
        key = (
            model_key
            or VIDEO_MODEL_KEY
            or VIDEO_MODELS.get(VIDEO_PAYGATE_TIER, {})
            .get("reference_frame_2_video", {})
            .get(aspect_ratio, "")
        )

        if not key:
            return {"error": (
                f"No video model for tier={VIDEO_PAYGATE_TIER} "
                f"ratio={aspect_ratio}. Set VIDEO_MODEL_KEY."
            )}

        if not reference_media_ids:
            return {"error": "No reference images to generate a video from"}

        request = {
            "aspectRatio": aspect_ratio,
            "seed": int(time.time()) % 10000,
            "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
            "videoModelKey": key,
            "referenceImages": [
                {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
                for mid in reference_media_ids
            ],
            "metadata": {},
        }

        body = {
            "mediaGenerationContext": {"batchId": f"{uuid.uuid4()}"},
            "clientContext": self._client_context(project_id, VIDEO_PAYGATE_TIER),
            "requests": [request],
            "useV2ModelConfig": True,
        }

        url = self._build_url("generate_video_references")
        return await self._send("api_request", {
            "url": url,
            "method": "POST",
            "headers": random_headers(),
            "body": body,
            "captchaAction": "VIDEO_GENERATION",
        }, timeout=60)  # Submit only -- polling is separate.

    async def generate_video_from_image(
        self,
        start_image_media_id: str,
        prompt: str,
        project_id: str,
        scene_id: str,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        model_key: str = "",
    ) -> dict:
        """Generate a video from one image (i2v).

        The fallback for when reference-to-video is refused. Same frozen-surface
        rule as the r2v call above, and this body is Flow Kit's own captured i2v
        payload: `startImage` in place of `referenceImages`, a different endpoint,
        and `metadata` carrying a scene id rather than being empty. The r2v
        capture has an empty metadata object and this one does not -- that
        difference is in the captures, so it is kept.

        Why this exists at all: r2v is on its way out. Flow Kit's own model list
        for the endpoint Google is migrating to accepts three video models and
        every one of them is i2v, and its r2v method refuses outright with "its
        payload was never captured off the new UI". i2v is the path that will
        still be there.

        `scene_id` has no scenes behind it here -- the job id is passed, because
        the captured payload carries a unique id in that slot and inventing an
        empty one is a change to a shape that is rejected without explanation.
        """
        key = (
            model_key
            or I2V_MODEL_KEY
            or VIDEO_MODELS.get(VIDEO_PAYGATE_TIER, {})
            .get("frame_2_video", {})
            .get(aspect_ratio, "")
        )

        if not key:
            return {"error": (
                f"No i2v model for tier={VIDEO_PAYGATE_TIER} "
                f"ratio={aspect_ratio}. Set VIDEO_I2V_MODEL_KEY."
            )}

        if not start_image_media_id:
            return {"error": "No start image to generate a video from"}

        request = {
            "aspectRatio": aspect_ratio,
            "seed": int(time.time()) % 10000,
            "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
            "videoModelKey": key,
            "startImage": {"mediaId": start_image_media_id},
            "metadata": {"sceneId": scene_id},
        }

        body = {
            "mediaGenerationContext": {"batchId": f"{uuid.uuid4()}"},
            "clientContext": self._client_context(project_id, VIDEO_PAYGATE_TIER),
            "requests": [request],
            "useV2ModelConfig": True,
        }

        url = self._build_url("generate_video")
        return await self._send("api_request", {
            "url": url,
            "method": "POST",
            "headers": random_headers(),
            "body": body,
            "captchaAction": "VIDEO_GENERATION",
        }, timeout=60)  # Submit only -- polling is separate.

    async def check_video_status(self, operations: list[dict]) -> dict:
        """Poll asynchronous video operations. Consumes no captcha."""
        url = self._build_url("check_video_status")
        return await self._send("api_request", {
            "url": url,
            "method": "POST",
            "headers": random_headers(),
            "body": {"operations": operations},
        }, timeout=30)

    # ─── batchexecute, the transport Flow moved to ──────────
    #
    # A second way of reaching Flow, beside the REST calls above rather than in
    # place of them. Images still go the old way and still work. Video does not:
    # it began answering INVALID_ARGUMENT, and Flow Kit's own client shows why --
    # it no longer sends video over REST at all. Flow moved to a batchexecute
    # endpoint on flow.google.com in September 2026, and those calls can only be
    # signed by a page that is already signed in.
    #
    # So nothing here touches the network. Each method builds a request envelope
    # and hands it to the extension, which runs it inside the Flow tab; the
    # envelope format and the readers are agent/services/flow_batch.py, vendored
    # from Flow Kit unchanged.

    async def batch_rpc(self, rpcid: str, freq: str, captcha_action: str = None,
                        match: str = None, timeout: float = 180,
                        project_id: str = "") -> dict:
        """Run one batchexecute RPC in the Flow tab and return the raw text.

        `project_id` is where the tab should be while it runs. The captcha is
        minted on a project page, and naming the project lets the extension
        open the tab there directly instead of on the home page and then
        hunting for a link to any project.
        """
        return await self._send("batch_rpc", {
            "rpcid": rpcid,
            "freq": freq,
            "captchaAction": captcha_action,
            "match": match,
            "projectId": project_id or None,
        }, timeout=timeout)

    async def _batch_payload(self, rpcid: str, freq: str, captcha_action: str = None,
                             timeout: float = 180, project_id: str = ""):
        """The decoded payload of one RPC, or an {"error": ...} dict."""
        result = await self.batch_rpc(rpcid, freq, captcha_action, timeout=timeout,
                                      project_id=project_id)
        if result.get("error"):
            return {"error": result["error"]}

        status = result.get("status")
        if isinstance(status, int) and status >= 400:
            return {"error": f"batchexecute answered HTTP {status}"}

        try:
            return {"payload": fb.first_payload(result.get("data") or "", rpcid)}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}

    async def upload_image_batch(self, image_base64: str, project_id: str,
                                 mime_type: str = "image/jpeg",
                                 file_name: str = "reference.jpg") -> dict:
        """Put an image into the project on the batch path.

        The media ids the two transports hand out are not interchangeable, so a
        video generated this way has to reference an image uploaded this way.
        """
        freq = fb.upload_request(image_base64, project_id, mime_type, file_name)
        out = await self._batch_payload(fb.RPC_UPLOAD_IMAGE, freq, timeout=180)
        if "error" in out:
            return out
        try:
            return {"media_id": fb.read_uploaded_media_id(out["payload"])}
        except Exception as e:
            return {"error": f"upload gave no media id: {type(e).__name__}: {e}"}

    async def ui_generate_image(self, prompt: str, project_id: str) -> dict:
        """Type the prompt into Flow's composer and press Generate.

        Says only that the submit went in; what it made is read from the
        project listing afterwards. Generous timeout: this drives a real page
        and waits for the composer to clear.
        """
        return await self._send(
            "ui_generate_image", {"projectId": project_id, "prompt": prompt}, timeout=180,
        )

    async def google_login(self, action: str, selector: str = "", email: str = "") -> dict:
        """One step of signing in to Google in the browser (see agent/google_login.py)."""
        answer = await self._send("google_login", {"action": action, "selector": selector, "email": email}, timeout=30)
        # The extension answers {id, result: {...}}; an error from _send is flat.
        return answer.get("result") if isinstance(answer.get("result"), dict) else answer

    async def create_flow_project(self) -> dict:
        """Press Flow's "New project" and return {ok, projectId} or {error}."""
        answer = await self._send("create_flow_project", {}, timeout=120)
        return answer.get("result") if isinstance(answer.get("result"), dict) else answer

    async def scan_flow_ui(self, project_id: str | None = None) -> dict:
        """What Flow's generate controls look like on the live page.

        The batch path builds Flow's requests for it, and a request that is
        not quite Flow's own is what UNUSUAL_ACTIVITY is a verdict on. Driving
        the page's controls instead needs to know what they are, and Flow's
        markup is minified and unannounced, so it is read rather than assumed.
        Read-only, and short: nothing generates while it runs.
        """
        return await self._send("scan_flow_ui", {"projectId": project_id}, timeout=60)

    async def discover_image_models(self, known: list[str]) -> dict:
        """The model names the Flow page's own source carries.

        Answers {"near": {known_name: [names found close to it, ...]}} or
        {"error": ...}. The extension does the reading, inside the tab; this is
        only the question. Short timeout: it is asked once and nothing waits on
        it that could not proceed without it.
        """
        return await self._send("discover_image_models", {"known": known}, timeout=45)

    async def project_images(self, project_id: str) -> list:
        """Every image in the project, newest first, as GeneratedImage.

        Carries no captcha, so it is the half of the image path that Google's
        2026-09-22 change left working.
        """
        out = await self._batch_payload(
            fb.RPC_PROJECT_MEDIA, fb.project_media_request(project_id),
            timeout=120, project_id=project_id,
        )
        if "error" in out:
            return out
        try:
            return fb.read_images(out["payload"])
        except Exception as e:
            return {"error": f"project listing unreadable: {type(e).__name__}: {e}"}

    async def generate_images_ui(self, prompt: str, project_id: str,
                                 poll_seconds: float = 180) -> dict:
        """Generate by driving Flow's composer, and read the result back.

        The captcha-gated call cannot be sent from here any more -- see
        uiGenerateImage in the extension for the measurements -- so the app
        sends it and this watches the project for what appeared.

        Which image is ours is decided by what the project did not have before
        the click. That is why the listing is read first and diffed after,
        rather than trusting the newest entry: another job on the same project,
        or a person in the Flow tab, can land an image in between, and taking
        the newest would hand this job somebody else's picture.

        Answers in the REST shape generate_images_batch answers in, so nothing
        downstream knows which path ran.
        """
        before = await self.project_images(project_id)
        if isinstance(before, dict):
            return before
        known = {image.media_id for image in before}

        submitted = await self.ui_generate_image(prompt, project_id)
        if submitted.get("error"):
            return {"error": f"the composer would not take it: {submitted['error']}"}

        # Flow's own UI decides how many variants a submit makes, so a submit
        # can bring back more than one. The first new one is this job's; the
        # rest stay in the project and cost nothing to leave there.
        deadline = time.monotonic() + poll_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            now = await self.project_images(project_id)
            if isinstance(now, dict):
                continue  # a listing that failed once is not the generation failing
            fresh = [image for image in now if image.media_id not in known]
            if fresh:
                first = fresh[0]
                return {
                    "status": 200,
                    "data": {
                        "media": [{
                            "name": first.media_id,
                            "image": {"generatedImage": {
                                "mediaId": first.media_id,
                                "fifeUrl": first.url,
                            }},
                        }],
                    },
                }

        return {"error": f"the composer took the prompt but no image appeared in {poll_seconds:.0f}s"}

    async def generate_images_batch(self, prompt: str, project_id: str,
                                    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT",
                                    image_model_name: str | None = None,
                                    ref_media_ids: list[str] | None = None) -> dict:
        """Generate one image on the batch path.

        Answers in the REST shape on purpose. The worker reads
        data.media[0].image.generatedImage.fifeUrl and media[0].name, and
        _parsing.py has tests pinning exactly that, so the batch answer is folded
        into the shape the worker already knows rather than teaching it a second
        one. Images come back inline on this call -- no operation to poll, unlike
        video -- which is what makes the two shapes line up at all.

        The media id is read off the CDN url and may not be a UUID; the worker's
        extractor UUID-checks it and will store null if not. The url is the thing
        the platform actually consumes, and that survives regardless.
        """
        # The name goes through as given. resolve_image_model() coerces anything
        # it does not recognise to the default, which would turn a fallback the
        # worker chose on purpose back into Pro without saying so. The worker
        # owns the list and the order; this sends what it is handed.
        freq = fb.image_request(
            prompt, project_id, count=1,
            aspect=aspect_ratio,
            model=fb.IMAGE_MODEL_BY_NICKNAME.get(image_model_name or "", image_model_name)
            or fb.IMAGE_MODEL,
            ref_media_ids=ref_media_ids or None,
        )
        out = await self._batch_payload(
            fb.RPC_GEN_IMAGE, freq, fb.CAPTCHA_IMAGE, timeout=180, project_id=project_id)
        if "error" in out:
            return out
        try:
            images = fb.read_images(out["payload"])
        except Exception as e:
            return {"error": f"image response unreadable: {type(e).__name__}: {e}"}
        if not images:
            return {"error": f"No image url in batch response: {repr(out['payload'])[:300]}"}

        first = images[0]
        return {
            "status": 200,
            "data": {
                "media": [{
                    "name": first.media_id,
                    "image": {"generatedImage": {
                        "mediaId": first.media_id,
                        "fifeUrl": first.url,
                    }},
                }],
            },
        }

    async def generate_reel_batch(self, prompt: str, project_id: str,
                                  image_media_ids: list[str],
                                  character_media_id: str | None = None,
                                  voice_media_id: str | None = None,
                                  aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT") -> dict:
        """Submit one clip from ingredients. Returns {"operation_id": ...}.

        The one way a reel clip is made. The images are uploaded media ids
        from this project; the character and voice are the presenter's, read
        from the project's assets. See flow_batch.reel_request for the shape.
        """
        freq = fb.reel_request(prompt, project_id, image_media_ids,
                               character_media_id, voice_media_id, aspect=aspect_ratio)
        out = await self._batch_payload(
            fb.RPC_GEN_REEL, freq, fb.CAPTCHA_VIDEO, timeout=180, project_id=project_id)
        if "error" in out:
            return out
        try:
            operation = fb.read_operation(out["payload"])
        except Exception as e:
            return {"error": f"submit gave no operation: {type(e).__name__}: {e}"}
        return {
            "operation_id": operation.operation_id,
            "project_id": operation.project_id or project_id,
        }

    async def check_operation_batch(self, operation_id: str) -> dict:
        """Poll one operation. {"done": bool, "error": str|None}."""
        out = await self._batch_payload(
            fb.RPC_OPERATION, fb.operation_request(operation_id), timeout=60)
        if "error" in out:
            return out
        try:
            operation = fb.read_operation(out["payload"])
        except Exception as e:
            return {"error": f"poll unreadable: {type(e).__name__}: {e}"}
        # `complained` is deliberately not treated as failure: Flow Kit measured
        # an operation reporting "Media not found." and still delivering a clip.
        state = {
            "done": operation.done,
            "status": operation.status,
            "complaint": operation.error,
        }
        if not operation.status:
            # No status in the slot we read. Keep the record so the log shows
            # what Google actually sent instead of fifteen minutes of nothing.
            state["raw"] = repr(out["payload"])[:600]
        return state

    async def find_operation_media_batch(self, operation_id: str, project_id: str) -> dict:
        """The media id an operation produced, read out of the project listing.

        `match` keeps the listing inside the tab: it is tens of megabytes and
        grows with every generation, and only the one entry is ever wanted.
        """
        result = await self.batch_rpc(
            fb.RPC_PROJECT_MEDIA, fb.project_media_request(project_id),
            match=operation_id, timeout=120,
        )
        if result.get("error"):
            return {"error": result["error"]}

        text = result.get("data") or ""
        media_id = fb.find_media_id_in_text(text, operation_id)
        return {"media_id": media_id} if media_id else {"media_id": None}

    async def get_media_urls_batch(self, media_id: str) -> dict:
        """The signed URLs for a finished media id."""
        out = await self._batch_payload(
            fb.RPC_MEDIA, fb.media_request(media_id), timeout=60)
        if "error" in out:
            return out
        urls = fb.read_media_urls(out["payload"], media_id)
        return {"video_url": urls.video, "image_url": urls.image}

    async def get_credits(self) -> dict:
        """Get user credits and tier."""
        url = self._build_url("get_credits")
        return await self._send("api_request", {
            "url": url,
            "method": "GET",
            "headers": random_headers(),
        }, timeout=15)

    async def validate_media_id(self, media_id: str) -> bool:
        """Check if a mediaId is still valid.

        Production calls: GET /v1/media/{mediaId}?key=...&clientContext.tool=PINHOLE
        Returns True on 200, False otherwise.
        """
        result = await self.get_media(media_id)
        status = result.get("status", 500)
        return isinstance(status, int) and status == 200

    async def get_media(self, media_id: str) -> dict:
        """Fetch media metadata from Google Flow.

        Returns the raw API response which contains a fresh signed URL
        in data.fifeUrl or data.servingUri.
        """
        url = f"{GOOGLE_FLOW_API}/v1/media/{media_id}?key={GOOGLE_API_KEY}&clientContext.tool=PINHOLE"
        return await self._send("api_request", {
            "url": url,
            "method": "GET",
            "headers": random_headers(),
        }, timeout=15)

    async def upload_image(self, image_base64: str, mime_type: str = "image/jpeg",
                            project_id: str = "", file_name: str = "image.jpg") -> dict:
        """Upload an image for use as start/end frame.

        Uses /v1/flow/uploadImage endpoint.
        Response: {media: {name: "uuid", ...}, workflow: {...}}
        We store media.name as the mediaId for video generation.
        """
        body = {
            "clientContext": {
                "projectId": project_id,
                "tool": "PINHOLE",
            },
            "fileName": file_name,
            "imageBytes": image_base64,
            "isHidden": False,
            "isUserUploaded": True,
            "mimeType": mime_type,
        }

        url = self._build_url("upload_image")
        result = await self._send("api_request", {
            "url": url,
            "method": "POST",
            "headers": random_headers(),
            "body": body,
        }, timeout=60)

        # Extract media.name for convenience (used as mediaId in video gen)
        if not _is_ws_error(result):
            data = result.get("data", {})
            if isinstance(data, dict):
                media = data.get("media", {})
                if isinstance(media, dict) and media.get("name"):
                    result["_mediaId"] = media["name"]

        return result


def _is_ws_error(result: dict) -> bool:
    return bool(result.get("error")) or (isinstance(result.get("status"), int) and result["status"] >= 400)


# Singleton
_client: Optional[FlowClient] = None


def get_flow_client() -> FlowClient:
    global _client
    if _client is None:
        _client = FlowClient()
    return _client
