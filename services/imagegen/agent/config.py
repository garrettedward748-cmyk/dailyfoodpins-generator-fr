"""Configuration constants."""
import json
import os
from pathlib import Path

# ─── Paths ───────────────────────────────────────────────────
BASE_DIR = Path(os.environ.get("FLOW_AGENT_DIR", Path(__file__).parent.parent))
DB_PATH = BASE_DIR / "flow_agent.db"

# ─── API Server ──────────────────────────────────────────────
API_HOST = os.environ.get("API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("API_PORT", "8100"))

# Shared secret for the public /v1 surface (see agent/auth.py). Empty is only
# tolerated when API_HOST is loopback; binding publicly without it is refused.
API_KEY = os.environ.get("API_KEY", "").strip()

# ─── WebSocket Server (extension connects here) ─────────────
WS_HOST = os.environ.get("WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("WS_PORT", "9222"))

# ─── Google Flow API ────────────────────────────────────────
GOOGLE_FLOW_API = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY")
RECAPTCHA_SITE_KEY = os.environ.get("RECAPTCHA_SITE_KEY", "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV")

# The Flow project this service generates into. It travels to Google as
# clientContext.projectId, so it has to be a real project id from the Flow
# UI -- the previous code sent a local database row id, which matched no
# project on their side.
FLOW_PROJECT_ID = os.environ.get("FLOW_PROJECT_ID", "").strip()

# --- Worker -------------------------------------------------
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))
API_COOLDOWN = int(os.environ.get("API_COOLDOWN", "10"))
MAX_CONCURRENT_REQUESTS = int(os.environ.get("MAX_CONCURRENT_REQUESTS", "2"))
STALE_PROCESSING_TIMEOUT = int(os.environ.get("STALE_PROCESSING_TIMEOUT", "600"))

# How old a captured bearer may be before the Flow tab is reloaded for a
# fresh one. 0 means always reload when a reload is due.
#
# When one is due depends on the transport. The REST path carries that bearer
# and reloads before every batch. The batch path carries none -- the page
# signs its own requests -- so it reloads only before a retry, as the remedy
# for a session Google refused; a routine reload there made every image look
# like a fresh page, a captcha seconds later and a request, four times an
# article. See WorkerController.reload_before.
TOKEN_MAX_AGE_BEFORE_BATCH = int(os.environ.get("TOKEN_MAX_AGE_BEFORE_BATCH", "0"))

# Generate images by driving Flow's composer instead of sending the call.
#
# Off. It was the first answer to Google's 2026-09-22 build refusing our
# captcha-gated calls, and it misses things in practice; upstream also found it
# refused again after a cold Chrome restart (crisng95/flowkit#58). The widget
# mint in extension/injected.js is the fix. This stays for trying by hand.
IMAGE_USE_UI = os.environ.get("IMAGE_USE_UI", "0") not in ("", "0", "false", "False")

# Send images over Flow's batchexecute transport instead of the REST API.
#
# On by default because REST images started answering
#
#   {'code': 401, 'message': 'Request had invalid authentication credentials.
#    Expected OAuth 2 access token, login cookie or other valid authentication
#    credential.', 'status': 'UNAUTHENTICATED'}
#
# That is the bearer token itself being refused, not the request. The token is
# sniffed off the Flow page, and the page no longer talks to aisandbox-pa --
# Flow moved to a batchexecute endpoint on flow.google.com in September 2026 --
# so what it sends is no longer good there, and reloading the tab for a fresh
# one fetches a fresh one that is no better. The batch path signs itself inside
# the tab and needs no sniffed token at all.
#
# Set to 0 to fall back to REST, for the day Google turns it back on.
IMAGE_USE_BATCH = os.environ.get("IMAGE_USE_BATCH", "1") == "1"

# --- Models -------------------------------------------------
# Part of the frozen request surface: the alias table decides which model name
# reaches Google, and BELUGA (Nano Banana 2.1) is what the UI sends.
_MODELS_FILE = Path(__file__).parent / "models.json"
with open(_MODELS_FILE) as _f:
    _MODELS = json.load(_f)

IMAGE_MODELS = _MODELS["image_models"]
VIDEO_MODELS = _MODELS["video_models"]

# Which Veo model generates a video from reference images.
#
# The tier decides which table in models.json is consulted; the override skips
# the table entirely. Flow's UI has moved on to model names ("Omni") that are
# not in this file, and the only way to learn one is to read a real request in
# DevTools -- so the override exists to let that value be pasted in without a
# redeploy. Empty means "use the table", which is the shipped behaviour.
VIDEO_PAYGATE_TIER = os.environ.get("VIDEO_PAYGATE_TIER", "PAYGATE_TIER_ONE").strip()
VIDEO_MODEL_KEY = os.environ.get("VIDEO_MODEL_KEY", "").strip()

# The same override for the i2v fallback, deliberately separate: these are
# different model families, and one variable forcing both would send an r2v key
# to the start-image endpoint, rejected with the same unexplained
# INVALID_ARGUMENT the fallback exists to get around.
I2V_MODEL_KEY = os.environ.get("VIDEO_I2V_MODEL_KEY", "").strip()

# Skip reference-to-video entirely and generate from the first image.
#
# r2v is being retired. Flow Kit's model list for the endpoint Google is
# migrating to accepts three video models and every one is i2v, and its own r2v
# method refuses outright -- "its payload was never captured off the new UI".
# Once r2v stops working here for good this turns one wasted submit per reel
# into none, without a redeploy.
VIDEO_FORCE_I2V = os.environ.get("VIDEO_FORCE_I2V", "") not in ("", "0", "false", "False")

# Send video over Flow's batchexecute transport instead of the REST API.
#
# On by default because REST video answers INVALID_ARGUMENT and will not
# come back: Flow Kit stopped sending video that way entirely when Flow
# moved in September 2026. Set to 0 to fall back to the old path.
VIDEO_USE_BATCH = os.environ.get("VIDEO_USE_BATCH", "1") == "1"

# Same for images. When video moved, images were left on REST because REST
# images still worked. Three days later they stopped:
#
#   {'code': 401, 'message': 'Request had invalid authentication credentials.
#    Expected OAuth 2 access token, login cookie or other valid authentication
#    credential.', 'status': 'UNAUTHENTICATED'}
#
# That is the bearer token itself being refused, not the request -- the token
# sniffed off the page is no longer good for aisandbox-pa, because the page no
# longer talks to aisandbox-pa. Same retirement, one endpoint at a time. The
# batch path signs itself inside the tab and needs no sniffed token at all.
#
# Set to 0 to fall back to REST, for the day Google turns it back on.
IMAGE_USE_BATCH = os.environ.get("IMAGE_USE_BATCH", "1") == "1"

# Video generation is minutes, not the 30-90 seconds an image takes, so it gets
# its own budget rather than inheriting numbers chosen for images.
VIDEO_POLL_INTERVAL = int(os.environ.get("VIDEO_POLL_INTERVAL", "15"))
VIDEO_MAX_POLLS = int(os.environ.get("VIDEO_MAX_POLLS", "80"))
# A video with no status from Flow that has still not shown up in the project
# after this long is not coming: a healthy account delivers one in about a
# minute. Give up then and move to the next Google account instead of waiting
# out the whole VIDEO_MAX_POLLS budget.
VIDEO_LISTING_GIVEUP_S = int(os.environ.get("VIDEO_LISTING_GIVEUP_S", "300"))

# --- API Endpoints ------------------------------------------
# Frozen: these paths and their query shape are what the Flow UI calls.
ENDPOINTS = {
    "generate_images": "/v1/projects/{project_id}/flowMedia:batchGenerateImages",
    "generate_video": "/v1/video:batchAsyncGenerateVideoStartImage",
    "generate_video_references": "/v1/video:batchAsyncGenerateVideoReferenceImages",
    "check_video_status": "/v1/video:batchCheckAsyncVideoGenerationStatus",
    "upload_image": "/v1/flow/uploadImage",
    "get_credits": "/v1/credits",
    "get_media": "/v1/media/{media_id}",
}

# ─── Header Randomization Pools ─────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
]

CHROME_VERSIONS = [
    '"Google Chrome";v="109", "Chromium";v="109"',
    '"Google Chrome";v="110", "Chromium";v="110"',
    '"Google Chrome";v="111", "Chromium";v="111"',
    '"Google Chrome";v="113", "Not-A.Brand";v="24"',
    '"Google Chrome";v="120", "Not-A.Brand";v="24"',
    '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
]

BROWSER_VALIDATIONS = [
    "SgDQo8mvrGRdD61Pwo8wyWVgYgs=",
]

CLIENT_DATA = [
    "CKi1yQEIh7bJAQiktskBCKmdygEIvorLAQiUocsBCIagzQEYv6nKARjRp88BGKqwzwE=",
]
