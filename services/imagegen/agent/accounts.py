"""Google accounts for Flow, used one at a time, rotated when one runs dry.

Why one at a time: Chrome is this container's whole CPU bill (see chrome.py --
the GPU process alone is ~170% while it exists). Running a browser per account
would multiply that by the number of accounts. Instead every account is just a
Chrome profile directory on the /data volume -- a few hundred MB of disk, no
CPU, no RAM -- and the one browser that runs is started on whichever profile is
active. Switching costs one Chrome restart (10-20 s), and happens only when the
active account stops working:

  - out of credits / quota exhausted  -> that account rests for COOLDOWN_H hours
  - signed out of Google              -> it waits until someone signs it in again
  - stuck (a run of failures)         -> it rests for STUCK_COOLDOWN_M minutes

The switch itself is never done under a job: rotate() only marks it pending,
and chrome.reconcile() carries it out once no job holds the browser.

Account 1 is the profile the service always had (CHROME_PROFILE_DIR), so an
existing sign-in carries over untouched.

Each account has its own Flow project: a project id belongs to the Google
account that made it, and another account sending it is refused. So the
project is chosen by the account in use, not by the site. An account with no
project yet is left out of rotation (account 1 alone may fall back to the
project the caller sent, which is how it always worked).
"""
from __future__ import annotations

import calendar
import json
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional

from agent.config import BASE_DIR, FLOW_PROJECT_ID

logger = logging.getLogger(__name__)

STATE_FILE = BASE_DIR / "accounts.json"
# Read by docker/chrome-launch.sh: the profile the next Chrome start uses.
ACTIVE_POINTER = BASE_DIR / "active-profile-dir"
EXTRA_PROFILES = BASE_DIR / "chrome-profiles"
FIRST_PROFILE = Path(os.environ.get("CHROME_PROFILE_DIR", str(BASE_DIR / "chrome-profile")))

COOLDOWN_H = float(os.environ.get("ACCOUNT_COOLDOWN_HOURS", "6"))
STUCK_COOLDOWN_M = float(os.environ.get("ACCOUNT_STUCK_COOLDOWN_MINUTES", "30"))
MAX_ACCOUNTS = int(os.environ.get("MAX_FLOW_ACCOUNTS", "20"))

# Error text that means "this account, not this request": worth moving on for.
CREDIT_MARKERS = ("no video credits", "credits left", "out of credits", "insufficient credit",
                  "quota", "resource_exhausted", "exhausted")
SIGNED_OUT_MARKERS = ("session_expired", "signed out", "sign in again")
# A Google account that is signed in but has never got through Flow: Labs'
# terms and welcome screens are still waiting, so the page has no sign-in
# token. Read as "signed out" before, which sent people to sign in again --
# the one thing that does not help.
FLOW_SETUP_MARKER = "flow not set up"
FLOW_SETUP_REASON = ("Signed in, but Flow is not set up on it yet — open Browser, go to "
                     "labs.google/flow once, accept the terms, then press Reset")
# Google's reCAPTCHA verdict on this account in this browser. Retrying on the
# same account does not clear it, so a run of them moves the work on.
UNUSUAL_MARKER = "unusual_activity"
UNUSUAL_STREAK = int(os.environ.get("ACCOUNT_UNUSUAL_STREAK", "2"))
UNUSUAL_COOLDOWN_M = float(os.environ.get("ACCOUNT_UNUSUAL_COOLDOWN_MINUTES", "120"))
LIMIT_MARKER = "credit limit reached"

# What one video clip costs in Flow credits, until someone sets it on the page.
# 0 means clips are not counted at all: no credit limit ever stops an account,
# and work goes on until Google itself says the credits are gone.
DEFAULT_CLIP_COST = 0


def _now() -> float:
    return time.time()


def _profile_dir(account_id: int) -> Path:
    return FIRST_PROFILE if account_id == 1 else EXTRA_PROFILES / str(account_id)


def _default_state() -> dict:
    return {
        "active": 1,
        "pending": None,
        "last_switch": 0.0,
        "accounts": [{"id": 1, "label": "Account 1", "status": "ok", "until": None, "reason": None,
                      "project_id": FLOW_PROJECT_ID}],
    }


LIMIT_REST_PREFIX = "Reached the credit limit"


def _end_stale_limit_rests(data: dict) -> dict:
    """A rest for a credit limit ends as soon as the account can afford a clip again.

    The rest used to wait out its clock even after the limit was raised or the
    count was reset, which showed "resting, reached the limit" beside a count
    under it. The limit is the truth, not the clock.
    """
    cost = _clip_cost(data)
    for account in data.get("accounts", []):
        if account.get("status") == "cooldown" and str(account.get("reason") or "").startswith(LIMIT_REST_PREFIX) \
                and _affords(account, cost):
            account.update(status="ok", until=None, reason=None)
    return data


def _load() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text())
        if isinstance(data, dict) and data.get("accounts"):
            return _end_stale_limit_rests(data)
    except (OSError, ValueError):
        pass
    return _default_state()


def _save(data: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(STATE_FILE.parent), prefix=".accounts-")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, STATE_FILE)


def _write_pointer(account_id: int) -> None:
    path = _profile_dir(account_id)
    path.mkdir(parents=True, exist_ok=True)
    ACTIVE_POINTER.write_text(str(path))


def _refresh(account: dict) -> dict:
    """A rest that has run out is over: the account is usable again."""
    if account["status"] == "cooldown" and account.get("until") and account["until"] <= _now():
        account.update(status="ok", until=None, reason=None)
    return account


def _has_project(account: dict) -> bool:
    return bool((account.get("project_id") or "").strip()) or account["id"] == 1


def _usable(account: dict) -> bool:
    return _refresh(account)["status"] == "ok" and _has_project(account)


# ─── What each account is allowed to make ────────────────────
# Two switches per account: images and video. An account rotates in only for
# the kinds it is ticked for -- so a fresh, not-yet-trusted account can be kept
# on images (cheap, lightly watched) while video (Google's most heavily
# guarded resource) is reserved for the warmed-up accounts. A missing flag
# means allowed, so every account made before this keeps doing both.

def _can(account: dict, kind: str) -> bool:
    """Whether this account is ticked for this kind of job ('image' or 'video')."""
    key = "video" if kind == "video" else "images"
    return account.get(key, True) is not False


def set_capabilities(account_id: int, images: bool, video: bool) -> None:
    data = _load()
    target = next((a for a in data["accounts"] if a["id"] == account_id), None)
    if target is None:
        raise ValueError("No such account.")
    target["images"] = bool(images)
    target["video"] = bool(video)
    _save(data)
    logger.info("accounts: #%d can make%s%s", account_id,
                " images" if images else "", " video" if video else "")


def active_kinds() -> set:
    """The job kinds the account in use is allowed to make (ignoring rest)."""
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    if current is None:
        return {"image", "video"}
    return {k for k in ("image", "video") if _can(current, k)}


def ensure_active_can(kind: str) -> str:
    """Make sure the account in use is allowed to make `kind`, switching if not.

    Returns:
      "ok"           the active account is usable and ticked for this kind.
      "switching"    a switch to a capable account was queued (or one is already
                     pending) -- the caller waits for it to land.
      "all_busy"     accounts ticked for this kind exist, but all are resting
                     right now -- the caller waits, nothing is wrong.
      "none_capable" no account is ticked for this kind at all -- a setup gap
                     the caller should surface rather than wait on forever.
    """
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    if current is not None and _usable(current) and _can(current, kind):
        return "ok"
    if data.get("pending"):
        return "switching"

    capable = [a for a in data["accounts"] if _can(a, kind)]
    if not capable:
        return "none_capable"

    ids = [a["id"] for a in data["accounts"]]
    start = ids.index(current["id"]) if current else 0
    for step in range(1, len(ids) + 1):
        candidate = data["accounts"][(start + step) % len(ids)]
        if current and candidate["id"] == current["id"]:
            continue
        if _usable(candidate) and _can(candidate, kind):
            data["pending"] = candidate["id"]
            _save(data)
            logger.info("accounts: #%s is not set for %s — switching to #%d",
                        current["id"] if current else "?", kind, candidate["id"])
            return "switching"
    return "all_busy"


# ─── Reading ─────────────────────────────────────────────────

def list_accounts() -> dict:
    data = _load()
    for a in data["accounts"]:
        _refresh(a)
    return {
        "active": data["active"],
        "pending": data.get("pending"),
        "clip_cost": _clip_cost(data),
        "accounts": [
            {**{k: v for k, v in a.items() if k != "spend"},
             "used_today": _used(a, _today_from(a)), "used_month": _used(a, _month_start()),
             "daily_limit": a.get("daily_limit"), "monthly_limit": a.get("monthly_limit"),
             "project_id": a.get("project_id") or "",
             "images": _can(a, "image"), "video": _can(a, "video"),
             "active": a["id"] == data["active"], "profile": str(_profile_dir(a["id"]))}
            for a in data["accounts"]
        ],
    }


def count() -> int:
    return len(_load()["accounts"])


def active_id() -> int:
    return int(_load()["active"])


def active_project() -> str:
    """The Flow project of the account in use, or '' when it has none set."""
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    return ((current or {}).get("project_id") or "").strip()


def switch_pending() -> Optional[int]:
    return _load().get("pending")


def seconds_since_switch() -> float:
    return _now() - float(_load().get("last_switch") or 0.0)


# ─── Managing ────────────────────────────────────────────────

def add(label: str = "") -> dict:
    data = _load()
    if len(data["accounts"]) >= MAX_ACCOUNTS:
        raise ValueError(f"At most {MAX_ACCOUNTS} accounts.")
    new_id = max(a["id"] for a in data["accounts"]) + 1
    account = {"id": new_id, "label": label.strip() or f"Account {new_id}",
               "status": "signed_out", "until": None,
               "reason": "New — sign in to Google on this account", "project_id": ""}
    data["accounts"].append(account)
    _profile_dir(new_id).mkdir(parents=True, exist_ok=True)
    _save(data)
    logger.info("accounts: added #%d", new_id)
    return account


def remove(account_id: int) -> None:
    data = _load()
    if len(data["accounts"]) <= 1:
        raise ValueError("Keep at least one account.")
    if not any(a["id"] == account_id for a in data["accounts"]):
        raise ValueError("No such account.")
    if account_id == data["active"] or account_id == data.get("pending"):
        raise ValueError("Switch to another account before removing this one.")
    data["accounts"] = [a for a in data["accounts"] if a["id"] != account_id]
    _save(data)
    shutil.rmtree(_profile_dir(account_id), ignore_errors=True)
    logger.info("accounts: removed #%d", account_id)


def use(account_id: int, reason: str = "chosen by hand") -> None:
    """Make this account the active one (for signing in, or by choice). Clears its rest."""
    data = _load()
    target = next((a for a in data["accounts"] if a["id"] == account_id), None)
    if target is None:
        raise ValueError("No such account.")
    target.update(status="ok", until=None, reason=None)
    if account_id != data["active"]:
        data["pending"] = account_id
        logger.info("accounts: switch to #%d requested (%s)", account_id, reason)
    _save(data)


def set_project(account_id: int, project_id: str) -> None:
    """Save the account's Flow project. Accepts the id or the whole project URL."""
    value = (project_id or "").strip()
    if "/project/" in value:
        value = value.split("/project/", 1)[1]
    value = value.split("?", 1)[0].split("/", 1)[0].strip()
    data = _load()
    target = next((a for a in data["accounts"] if a["id"] == account_id), None)
    if target is None:
        raise ValueError("No such account.")
    target["project_id"] = value
    _save(data)
    logger.info("accounts: #%d project %s", account_id, value or "(none)")


def mark_ok(account_id: int) -> None:
    data = _load()
    for a in data["accounts"]:
        if a["id"] == account_id:
            a.update(status="ok", until=None, reason=None)
    _save(data)


def rotate(problem: str) -> Optional[int]:
    """The active account has a problem: rest it and queue a switch to the next usable one.

    Returns the account switched to, or None when there is nowhere to go (a
    single account, or every other one resting) -- the caller then carries on
    as it always did.
    """
    data = _load()
    if data.get("pending"):
        return data["pending"]  # a switch is already on its way

    lower = problem.lower()
    current = next(a for a in data["accounts"] if a["id"] == data["active"])
    current["unusual"] = 0
    if FLOW_SETUP_MARKER in lower:
        current.update(status="signed_out", until=None, reason=FLOW_SETUP_REASON)
    elif any(m in lower for m in SIGNED_OUT_MARKERS):
        current.update(status="signed_out", until=None, reason="Signed out of Google — sign in again")
    elif LIMIT_MARKER in lower:
        current.update(status="cooldown", until=_next_reset(current),
                       reason="Reached the credit limit set for it")
    elif UNUSUAL_MARKER in lower:
        current.update(status="cooldown", until=_now() + _unusual_rest_m(data) * 60,
                       reason="Google flagged unusual activity")
    elif any(m in lower for m in CREDIT_MARKERS):
        current.update(status="cooldown", until=_now() + COOLDOWN_H * 3600,
                       reason="Out of credits or quota")
    else:
        current.update(status="cooldown", until=_now() + STUCK_COOLDOWN_M * 60,
                       reason="Kept failing: " + problem[:120])

    ids = [a["id"] for a in data["accounts"]]
    start = ids.index(current["id"])
    for step in range(1, len(ids)):
        candidate = data["accounts"][(start + step) % len(ids)]
        needs_credits = LIMIT_MARKER in lower or any(m in lower for m in CREDIT_MARKERS)
        if _usable(candidate) and (not needs_credits or _affords(candidate, _clip_cost(data))):
            data["pending"] = candidate["id"]
            _save(data)
            logger.warning("accounts: #%d %s — switching to #%d", current["id"],
                           current["reason"], candidate["id"])
            return candidate["id"]

    _save(data)
    logger.warning("accounts: #%d %s — no other account is usable", current["id"], current["reason"])
    return None


def apply_pending_switch() -> Optional[int]:
    """Point the next Chrome start at the pending account. Call only with Chrome stopped."""
    data = _load()
    target = data.get("pending")
    if not target:
        return None
    data["active"] = target
    data["pending"] = None
    data["last_switch"] = _now()
    _save(data)
    _write_pointer(target)
    logger.info("accounts: now using #%d", target)
    # Models the old account was refused are not refused for this one.
    from agent import image_models
    image_models.forget_refusals()
    return target


# ─── Credit limits ───────────────────────────────────────────
# Optional per account: a daily and a monthly number of Flow credits. Each
# video clip submitted is counted against the account in use, and when the
# next clip would not fit, the work moves on before Google has to refuse it.
# An account with neither limit set is never counted against.

def _day_start(t: Optional[float] = None) -> float:
    d = time.gmtime(t if t is not None else _now())
    return calendar.timegm((d.tm_year, d.tm_mon, d.tm_mday, 0, 0, 0))


def _month_start(t: Optional[float] = None) -> float:
    d = time.gmtime(t if t is not None else _now())
    return calendar.timegm((d.tm_year, d.tm_mon, 1, 0, 0, 0))


def _next_reset(account: dict) -> float:
    """When the limit that was hit frees up again: tomorrow, or next month."""
    now = _now()
    tomorrow = _day_start() + 86400
    d = time.gmtime(now)
    year, month = (d.tm_year + 1, 1) if d.tm_mon == 12 else (d.tm_year, d.tm_mon + 1)
    next_month = calendar.timegm((year, month, 1, 0, 0, 0))
    monthly = account.get("monthly_limit")
    if monthly is not None and _used(account, _month_start()) >= monthly:
        return next_month
    return tomorrow


def _used(account: dict, since: float) -> int:
    return sum(int(c) for t, c in account.get("spend", []) if t >= since)


def _today_from(account: dict) -> float:
    """Start of today's count: midnight, or a later reset by hand."""
    return max(_day_start(), float(account.get("reset_at") or 0))


def reset(account_id: int) -> None:
    """Start the account over by hand: no rest, no unusual-activity streak,
    and today's credit count from zero (the month's count is kept). A
    signed-out account stays signed out: only signing in fixes that."""
    data = _load()
    target = next((a for a in data["accounts"] if a["id"] == account_id), None)
    if target is None:
        raise ValueError("No such account.")
    if target.get("status") != "signed_out":
        target.update(status="ok", until=None, reason=None)
    target["unusual"] = 0
    target["reset_at"] = _now()
    _save(data)
    logger.info("accounts: #%d reset by hand", account_id)


def _unusual_rest_m(data: dict) -> float:
    """Minutes an account rests after UNUSUAL_ACTIVITY: set on the platform, else the environment."""
    value = data.get("unusual_rest_m")
    return float(value) if value is not None else UNUSUAL_COOLDOWN_M


def set_unusual_rest(minutes: float) -> None:
    data = _load()
    data["unusual_rest_m"] = max(0.0, float(minutes))
    _save(data)


def _clip_cost(data: dict) -> int:
    value = data.get("clip_cost")
    return max(0, int(value)) if value is not None else DEFAULT_CLIP_COST


def _affords(account: dict, cost: int) -> bool:
    if cost <= 0:
        return True  # clips are not counted: no limit can stop the account
    daily, monthly = account.get("daily_limit"), account.get("monthly_limit")
    if daily is not None and _used(account, _today_from(account)) + cost > daily:
        return False
    if monthly is not None and _used(account, _month_start()) + cost > monthly:
        return False
    return True


def active_affords_clip() -> bool:
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    return current is None or _affords(current, _clip_cost(data))


def record_clip() -> None:
    """A clip was submitted on the account in use: count its credits."""
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    if current is None:
        return
    cost = _clip_cost(data)
    if cost > 0:
        cutoff = _now() - 32 * 86400
        spend = [s for s in current.get("spend", []) if s[0] >= cutoff]
        spend.append([_now(), cost])
        current["spend"] = spend
    current["unusual"] = 0
    _save(data)


def set_limits(account_id: int, daily: Optional[int], monthly: Optional[int]) -> None:
    """Blank (None) means no limit."""
    data = _load()
    target = next((a for a in data["accounts"] if a["id"] == account_id), None)
    if target is None:
        raise ValueError("No such account.")
    target["daily_limit"] = daily if daily and daily > 0 else None
    target["monthly_limit"] = monthly if monthly and monthly > 0 else None
    # A rest for a limit that no longer applies ends now.
    if target["status"] == "cooldown" and (target.get("reason") or "").startswith("Reached the credit limit") \
            and _affords(target, _clip_cost(data)):
        target.update(status="ok", until=None, reason=None)
    _save(data)


def set_clip_cost(cost: int) -> None:
    data = _load()
    data["clip_cost"] = max(0, int(cost))
    _save(data)


def note_unusual_activity() -> bool:
    """Count a run of UNUSUAL_ACTIVITY on the account in use. True when it is time to move on."""
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    if current is None:
        return False
    current["unusual"] = int(current.get("unusual") or 0) + 1
    _save(data)
    return current["unusual"] >= UNUSUAL_STREAK


def note_success() -> None:
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    if current is not None and (current.get("unusual") or not current.get("worked")):
        current["unusual"] = 0
        current["worked"] = True
        _save(data)


def active_has_worked() -> bool:
    """Has the account in use ever got something out of Flow?

    Accounts from before this was recorded count as having worked when they
    have spent credits, so a real sign-out on them still reads as one.
    """
    data = _load()
    current = next((a for a in data["accounts"] if a["id"] == data["active"]), None)
    return bool(current and (current.get("worked") or current.get("spend")))


def other_account() -> Optional[int]:
    """Any account other than the active one, preferring a usable one."""
    data = _load()
    others = [a for a in data["accounts"] if a["id"] != data["active"]]
    usable = [a for a in others if _usable(a)]
    pick = (usable or others or [None])[0]
    return pick["id"] if pick else None


def ensure_pointer() -> None:
    """At start-up: make sure the pointer names the active profile."""
    try:
        _write_pointer(active_id())
    except OSError as e:
        logger.warning("accounts: could not write the profile pointer: %s", e)
