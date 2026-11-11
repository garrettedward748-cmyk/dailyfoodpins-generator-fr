"""Gemini's own browser: a second Chrome beside Flow's, for the platform's writing.

Gemini used to run in Flow's browser, as whichever Google account Flow was on.
That browser restarts on every Flow account switch, cutting off the prompt in
hand, and an account's Gemini allowance went with whatever account Flow
needed. With this on (Setup -> Gemini on the platform), prompts go to a Chrome
of its own instead -- the `gemini-chrome` program in supervisord, on
/data/gemini-profile -- signed in to the Google accounts listed here and
nothing else. The Gemini Chat extension there moves to the next account when
one's limit is reached (?authuser=1, 2, ...).

The two browsers tell themselves apart by their language (--lang=en-GB here):
Flow Kit stays out of this one, and Gemini Chat takes prompts only here.

Signing an account in works as for Flow's accounts (agent/google_login.py):
Google's sign-in page in this browser, the address and password typed as real
keystrokes on the display, a phone prompt or a code waited for. The password is
never stored.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import shutil
import subprocess
import time
from collections import deque
from typing import Optional

from agent.config import BASE_DIR

logger = logging.getLogger(__name__)

PROGRAM = "gemini-chrome"
STATE_PATH = BASE_DIR / "gemini-browser.json"
PROFILE_DIR = BASE_DIR / "gemini-profile"
#: Stopped after this long with no prompt and no sign-in: an idle Chrome still costs CPU.
IDLE_STOP_S = int(os.environ.get("GEMINI_BROWSER_IDLE_STOP_S", "900"))
DISPLAY = os.environ.get("DISPLAY_FOR_INPUT", ":99")
_SUPERVISORCTL = ["supervisorctl", "-c", "/etc/supervisor/supervisord.conf"]

TOTAL_TIMEOUT_S = 300
STUCK_TIMEOUT_S = 60

_last_used = 0.0


# -- settings ---------------------------------------------------------------

def _load() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(STATE_PATH)


def enabled() -> bool:
    return bool(_load().get("enabled"))


def set_enabled(on: bool) -> None:
    data = _load()
    data["enabled"] = bool(on)
    _save(data)
    logger.info("gemini browser: %s", "on" if on else "off")


def accounts() -> list[dict]:
    return [a for a in _load().get("accounts", []) if isinstance(a, dict) and a.get("email")]


def _put_account(email: str, **fields) -> None:
    data = _load()
    rows = [a for a in data.get("accounts", []) if isinstance(a, dict)]
    for row in rows:
        if row.get("email", "").lower() == email.lower():
            row.update(fields)
            break
    else:
        rows.append({"email": email, "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields})
    data["accounts"] = rows
    _save(data)


def remove_account(email: str) -> None:
    """Forgotten here. The Google session stays in the browser until signed out there."""
    data = _load()
    data["accounts"] = [a for a in data.get("accounts", []) if a.get("email", "").lower() != email.lower()]
    _save(data)


def state() -> dict:
    return {
        "enabled": enabled(),
        "running": _running_cached,
        "accounts": accounts(),
        "login": dict(_login),
        "login_running": login_running(),
        "idle_stop_s": IDLE_STOP_S,
    }


# -- the browser ------------------------------------------------------------

_running_cached = False


def _ctl(verb: str) -> subprocess.CompletedProcess:
    return subprocess.run([*_SUPERVISORCTL, verb, PROGRAM], capture_output=True, text=True, timeout=90)


async def running() -> bool:
    global _running_cached
    try:
        out = await asyncio.to_thread(_ctl, "status")
    except (OSError, subprocess.SubprocessError):
        return False
    _running_cached = "RUNNING" in out.stdout
    return _running_cached


async def pid() -> int:
    try:
        out = await asyncio.to_thread(_ctl, "pid")
        return int(out.stdout.strip() or 0)
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0


def touch() -> None:
    global _last_used
    _last_used = time.monotonic()


async def ensure_running(reason: str) -> None:
    touch()
    if await running():
        return
    logger.info("gemini browser: starting (%s)", reason)
    try:
        out = await asyncio.to_thread(_ctl, "start")
    except (OSError, subprocess.SubprocessError) as e:
        logger.error("gemini browser: could not start: %s", e)
        return
    if out.returncode != 0 and "already started" not in (out.stdout + out.stderr).lower():
        logger.error("gemini browser: start failed: %s", (out.stderr or out.stdout).strip()[:200])
    await running()


async def stop(reason: str) -> None:
    if not await running():
        return
    logger.info("gemini browser: stopping (%s)", reason)
    await asyncio.to_thread(_ctl, "stop")
    await running()


async def run_idle_stop(busy) -> None:
    """Stop the browser after IDLE_STOP_S with nothing for it; `busy()` says whether prompts wait."""
    while True:
        await asyncio.sleep(60)
        try:
            if not await running():
                continue
            if not enabled():
                await stop("Gemini's own browser was switched off")
            elif busy() or login_running():
                touch()
            elif time.monotonic() - _last_used > IDLE_STOP_S:
                await stop(f"no prompt for {IDLE_STOP_S // 60} minutes")
        except Exception as e:  # noqa: BLE001 -- the loop must not die
            logger.warning("gemini browser: idle check failed: %s", e)


# -- commands to the extension ------------------------------------------------
# The Gemini Chat extension polls the agent (agent/api/gemini.py). A command
# rides the same poll: the sign-in's page steps, answered on /ext/gemini/command.

_ids = itertools.count(1)
_commands: deque[dict] = deque()
_waiting: dict[str, asyncio.Future] = {}
_wake: Optional[asyncio.Event] = None


def set_wakeup(event: asyncio.Event) -> None:
    global _wake
    _wake = event


def next_command() -> Optional[dict]:
    return _commands.popleft() if _commands else None


def command_result(command_id: str, result: dict) -> bool:
    future = _waiting.pop(command_id, None)
    if future and not future.done():
        future.set_result(result if isinstance(result, dict) else {})
        return True
    return False


async def command(action: str, timeout: float = 30, **params) -> dict:
    command_id = f"c{next(_ids)}"
    future = asyncio.get_running_loop().create_future()
    _waiting[command_id] = future
    _commands.append({"id": command_id, "action": action, **params})
    if _wake:
        _wake.set()
    try:
        return await asyncio.wait_for(future, timeout)
    except asyncio.TimeoutError:
        _waiting.pop(command_id, None)
        return {"error": "the Gemini browser did not answer"}


# -- signing an account in ----------------------------------------------------

MESSAGES = {
    "starting": "Opening Google's sign-in page in Gemini's browser…",
    "email": "Typing the Gmail address…",
    "password": "Typing the password…",
    "phone": "Google sent a prompt to your phone: open it and tap Yes.",
    "need_code": "Google asks for a verification code. Type it below.",
    "done": "Signed in. Gemini can write with this account now.",
}
_login: dict = {"state": "idle", "message": "", "email": ""}
_code: Optional[str] = None
_task: Optional[asyncio.Task] = None


def _set(state: str, message: str = "", email: str = "") -> None:
    _login.update(state=state, message=message or MESSAGES.get(state, ""), at=time.time())
    if email:
        _login["email"] = email


def login_running() -> bool:
    return _task is not None and not _task.done()


def give_code(code: str) -> None:
    global _code
    _code = code.strip().replace(" ", "")


def start_login(email: str, password: str) -> None:
    global _task, _code
    if login_running():
        return
    _code = None
    _set("starting", email=email.strip())
    _task = asyncio.create_task(_run_login(email.strip(), password))


async def _xdo(*args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "xdotool", *args, env={**os.environ, "DISPLAY": DISPLAY},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"xdotool {args[0]} failed: {err.decode(errors='replace').strip()[:200]}")
    return out.decode(errors="replace")


async def _focus_window() -> None:
    """Keyboard focus to Gemini's browser, not Flow's, which shares the display."""
    browser = await pid()
    if browser:
        try:
            found = (await _xdo("search", "--onlyvisible", "--pid", str(browser))).split()
        except RuntimeError:
            found = []
        if found:
            await _xdo("windowraise", found[-1])
            await _xdo("windowfocus", "--sync", found[-1])
            return
    raise RuntimeError("Could not find the window of Gemini's browser on the display.")


async def _type_into(selector: str, text: str) -> None:
    focused = await command("focus", selector=selector)
    if not focused.get("ok"):
        raise RuntimeError("Could not find the field on Google's page.")
    await _focus_window()
    await asyncio.sleep(0.4)
    await _xdo("key", "--clearmodifiers", "ctrl+a")
    await _xdo("type", "--delay", "85", "--", text)
    await asyncio.sleep(0.5)
    await _xdo("key", "Return")


async def _run_login(email: str, password: str) -> None:
    global _code
    try:
        if shutil.which("xdotool") is None:
            raise RuntimeError("xdotool is not installed in the image service; redeploy it.")
        if not enabled():
            raise RuntimeError("Switch Gemini's own browser on first.")
        await ensure_running("signing in to Google")
        opened = {}
        for _ in range(20):  # the extension comes up a few seconds after Chrome
            opened = await command("open", timeout=15)
            if opened.get("ok"):
                break
            await asyncio.sleep(3)
        if not opened.get("ok"):
            raise RuntimeError(f"Could not open Google's sign-in page: {opened.get('error') or 'no answer from the Gemini browser'}")
        await asyncio.sleep(4)

        deadline = time.time() + TOTAL_TIMEOUT_S
        typed: dict[str, float] = {}
        last_step, last_change = "", time.time()

        def fresh(field: str) -> bool:
            return time.time() - typed.get(field, 0) < 20

        while time.time() < deadline:
            touch()
            page = await command("state", email=email)
            step = page.get("step", "unknown")
            if step != last_step:
                last_step, last_change = step, time.time()

            if step == "done":
                _put_account(email, state="signed_in", signed_in_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                _set("done")
                logger.info("gemini browser: %s signed in", email)
                return
            if step == "email":
                if "email" in typed and page.get("error"):
                    raise RuntimeError(f"Google did not accept the address: {page['error']}")
                if not fresh("email"):
                    _set("email")
                    await _type_into('input[type="email"], #identifierId, input[name="identifier"]', email)
                    typed["email"] = time.time()
            elif step == "password":
                if "password" in typed and page.get("error"):
                    raise RuntimeError(f"Google did not accept the password: {page['error']}")
                if not fresh("password"):
                    _set("password")
                    await _type_into('input[type="password"]:not([name="hiddenPassword"]), input[name="Passwd"]', password)
                    typed["password"] = time.time()
            elif step == "chooser":
                await command("choose", email=email)
            elif step == "phone":
                _set("phone")
            elif step == "code":
                if _code:
                    code, _code = _code, None
                    await _type_into('input[name="totpPin"], #totpPin, input[name="idvPin"], #idvPin, '
                                     'input[name="Pin"], input[type="tel"]', code)
                else:
                    _set("need_code")
            elif step in ("blocked", "captcha"):
                raise RuntimeError(
                    "Google will not let an automatic sign-in through for this account right now"
                    f" ({'it says the browser is not secure' if step == 'blocked' else 'it shows a captcha'})."
                    " Sign in once on the Browser page, in the Gemini window.")
            elif step == "verify":
                _set("phone", "Google wants to check it is you. Follow the prompt on your phone,"
                              " or finish on the Browser page.")
            if step in ("unknown", "verify") and time.time() - last_change > STUCK_TIMEOUT_S:
                raise RuntimeError("Google showed a page this cannot handle"
                                   f"{': ' + page.get('text', '')[:120] if page.get('text') else ''}."
                                   " Finish on the Browser page, in the Gemini window.")
            await asyncio.sleep(3)
        raise RuntimeError("Timed out waiting for Google. Finish on the Browser page, in the Gemini window.")
    except Exception as e:  # noqa: BLE001 -- every failure is reported
        logger.warning("gemini browser: sign-in of %s failed: %s", email, e)
        _put_account(email, state="failed")
        _set("failed", str(e))
    finally:
        _code = None
