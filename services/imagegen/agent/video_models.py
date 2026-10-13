"""Which video model name Flow still accepts, worked out rather than configured.

Every reel was failing on

    {'code': 400, 'message': 'Request contains an invalid argument.',
     'status': 'INVALID_ARGUMENT'}

which is Flow refusing the request itself. The likeliest field is the model
name: `videoModelKey` is the one part of that body which is a bare string Google
retires on its own schedule, and Flow Kit's list for the endpoint Google is
migrating to accepts exactly three video models -- none of which is the one this
service had been sending.

The obvious response is to change the name in a setting. That only works if the
guess is right, and it has to be made again by hand every time Google moves. So
the names are a list here and the service walks it: on a refusal it tries the
next, and once one is accepted it remembers it and every later job starts there.

This also settles the question underneath. If some name works, generation comes
back with no intervention. If every name is refused, that is not another guess
to make -- it says the old endpoint is closed to this account for video, which
is worth knowing plainly rather than inferring from one failure at a time.

Ordering is by evidence, not preference:

  * r2v first for as long as it works at all, because a reel built from four
    photographs is the point of the feature.
  * within each kind, names Flow Kit says the current endpoint accepts come
    before the ones this service used to send.

Attempts are not free -- each one solves a captcha -- so the remembered name is
tried alone, the list is only walked when nothing is remembered yet, and it is
capped.
"""
import json
import logging
import os
from pathlib import Path
from typing import Optional

from agent.config import BASE_DIR, VIDEO_MODELS, VIDEO_PAYGATE_TIER

logger = logging.getLogger(__name__)

#: Where the accepted name is kept, so a redeploy does not re-derive it and pay
#: the captchas again. On the /data volume, beside the job database.
_STORE = Path(os.environ.get("VIDEO_MODEL_STORE", BASE_DIR / "video_models.json"))

#: Most attempts one job will make before giving up, across both kinds. Each is
#: a captcha, and a run of them on an account is exactly the pattern reCAPTCHA
#: scores badly.
MAX_ATTEMPTS = int(os.environ.get("VIDEO_MODEL_MAX_ATTEMPTS", "6"))

#: Names Flow Kit records as accepted by the endpoint Google is migrating to.
#: All three are i2v; its reference-to-video method refuses outright, saying the
#: payload was never captured off the new UI.
_KNOWN_GOOD_I2V = (
    "veo_3_1_i2v_lite_low_priority",
    "veo_3_1_i2v_lite",
    "veo_3_1_i2v_s_fast_ultra",
)


def _from_tables(gen_type: str, aspect_ratio: str) -> list[str]:
    """Every name models.json has for this kind, configured tier first."""
    tiers = [VIDEO_PAYGATE_TIER] + [
        t for t in VIDEO_MODELS if t != VIDEO_PAYGATE_TIER
    ]
    out = []
    for tier in tiers:
        key = VIDEO_MODELS.get(tier, {}).get(gen_type, {}).get(aspect_ratio)
        if key:
            out.append(key)
    return out


def _dedupe(names) -> list[str]:
    seen, out = set(), []
    for name in names:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def r2v_candidates(aspect_ratio: str) -> list[str]:
    return _dedupe(_from_tables("reference_frame_2_video", aspect_ratio))


def i2v_candidates(aspect_ratio: str) -> list[str]:
    # Known-good first: these are the ones an endpoint that has already moved
    # still answers to, and the tables are what this service was sending when it
    # started being refused.
    return _dedupe(list(_KNOWN_GOOD_I2V) + _from_tables("frame_2_video", aspect_ratio))


def plan(aspect_ratio: str) -> list[tuple[str, str]]:
    """(kind, model name) to try, in order, for one video.

    A remembered name is returned alone: it worked last time, and walking the
    list past it would spend captchas re-proving that.
    """
    remembered = recall(aspect_ratio)
    if remembered:
        return [remembered]

    attempts = [("r2v", name) for name in r2v_candidates(aspect_ratio)]
    attempts += [("i2v", name) for name in i2v_candidates(aspect_ratio)]
    return attempts[:MAX_ATTEMPTS]


# ─── What worked last time ──────────────────────────────────

def _load() -> dict:
    try:
        return json.loads(_STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def recall(aspect_ratio: str) -> Optional[tuple[str, str]]:
    entry = _load().get(aspect_ratio)
    if isinstance(entry, dict) and entry.get("kind") and entry.get("model"):
        return (entry["kind"], entry["model"])
    return None


def remember(aspect_ratio: str, kind: str, model: str) -> None:
    """Record the name Flow accepted. Best effort: losing it costs attempts, not correctness."""
    if recall(aspect_ratio) == (kind, model):
        return
    data = _load()
    data[aspect_ratio] = {"kind": kind, "model": model}
    try:
        _STORE.parent.mkdir(parents=True, exist_ok=True)
        _STORE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        logger.info("video model for %s: remembering %s (%s)", aspect_ratio, model, kind)
    except OSError as e:
        logger.warning("could not record the working video model: %s", e)


def forget(aspect_ratio: str) -> None:
    """Drop the remembered name, so the next job walks the list again.

    Called when the remembered name starts being refused -- Google retired it
    too, and the service should find the next one rather than keep asking.
    """
    data = _load()
    if data.pop(aspect_ratio, None) is None:
        return
    try:
        _STORE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        logger.warning("video model for %s was refused — forgetting it", aspect_ratio)
    except OSError:
        pass


def access_denied(error: str) -> bool:
    """Google's answer when the account may not use the model it named."""
    return "MODEL_ACCESS_DENIED" in str(error or "").upper()


def out_of_credits(error: str) -> bool:
    """Google's answer when the account has no video credits left.

    Seen on the deployed container as code 8 with
    PUBLIC_ERROR_USER_QUOTA_REACHED. Nothing was generated and nothing was
    charged; retrying only spends captchas until the credits reset.
    """
    return "USER_QUOTA_REACHED" in str(error or "").upper()
