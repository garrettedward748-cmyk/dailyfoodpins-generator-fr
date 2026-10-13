"""Sign a Google account in from the platform, instead of through the Browser page.

The person gives the Gmail address and password on the platform; this opens
Google's sign-in page in the account's browser and types them in. The typing is
real keystrokes on the virtual display (xdotool), not a script filling fields:
Google's sign-in page tells the two apart and refuses the second.

Google may ask for more after the password -- a tap on the phone, or a code --
and this waits for it: the phone prompt is answered on the phone, a code is
typed on the platform. Anything it cannot get past (Google saying the browser
is not secure, a captcha) ends with a message to use the Browser page once.

Nothing here is stored: the password lives only for the length of the attempt.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from typing import Optional

from agent import accounts, chrome
from agent.services.flow_client import get_flow_client

logger = logging.getLogger(__name__)

DISPLAY = os.environ.get("DISPLAY_FOR_INPUT", ":99")
TOTAL_TIMEOUT_S = 300          # the whole sign-in, phone prompt included
STUCK_TIMEOUT_S = 60           # one unrecognised page this long is a dead end

# account id -> {"state", "message", "at"}; also where a code arrives.
_status: dict[int, dict] = {}
_codes: dict[int, str] = {}
_tasks: dict[int, asyncio.Task] = {}

MESSAGES = {
    "starting": "Opening Google's sign-in page…",
    "email": "Typing the Gmail address…",
    "password": "Typing the password…",
    "phone": "Google sent a prompt to your phone: open it and tap Yes.",
    "need_code": "Google asks for a verification code. Type it below.",
    "done": "Signed in.",
    "project": "Creating a Flow project for this account…",
}


def status(account_id: int) -> dict:
    return _status.get(account_id, {"state": "idle", "message": ""})


def _set(account_id: int, state: str, message: str = "") -> None:
    _status[account_id] = {"state": state, "message": message or MESSAGES.get(state, ""), "at": time.time()}


def give_code(account_id: int, code: str) -> None:
    _codes[account_id] = code.strip().replace(" ", "")


def running(account_id: int) -> bool:
    task = _tasks.get(account_id)
    return task is not None and not task.done()


def start(account_id: int, email: str, password: str) -> None:
    if running(account_id):
        return
    _codes.pop(account_id, None)
    _set(account_id, "starting")
    _tasks[account_id] = asyncio.create_task(_run(account_id, email.strip(), password))


async def _xdo(*args: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "xdotool", *args, env={**os.environ, "DISPLAY": DISPLAY},
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"xdotool {args[0]} failed: {err.decode(errors='replace').strip()[:200]}")


async def _type_into(selector: str, text: str) -> None:
    client = get_flow_client()
    focused = await client.google_login("focus", selector)
    if not focused.get("ok"):
        raise RuntimeError("Could not find the field on Google's page.")
    # Keyboard focus to the Chrome window, then keystrokes at a human pace.
    try:
        await _xdo("search", "--onlyvisible", "--class", "chrome", "windowfocus", "--sync")
    except RuntimeError:
        pass  # a single window already has focus
    await asyncio.sleep(0.4)
    await _xdo("key", "--clearmodifiers", "ctrl+a")
    await _xdo("type", "--delay", "85", "--", text)
    await asyncio.sleep(0.5)
    await _xdo("key", "Return")


def _has_project(account_id: int) -> bool:
    return any(a["id"] == account_id and a.get("project_id")
               for a in accounts.list_accounts()["accounts"])


async def _ensure_project(account_id: int, after_login: bool = False) -> None:
    """Give the account a Flow project if it has none. Reports; never raises."""
    signed = "Signed in. " if after_login else ""
    if _has_project(account_id):
        _set(account_id, "done", f"{signed}The account already has a Flow project.".strip())
        return
    _set(account_id, "project")
    made = await get_flow_client().create_flow_project()
    if made.get("ok") and made.get("projectId"):
        accounts.set_project(account_id, made["projectId"])
        _set(account_id, "done", f"{signed}Flow project created: {made['projectId']}")
        logger.info("google login: account #%d project %s", account_id, made["projectId"])
    else:
        _set(account_id, "failed" if not after_login else "done",
             f"{signed}Could not create a Flow project automatically ({made.get('error', 'no answer')}). "
             "Create one on the Browser page and paste its ID.")


def start_project(account_id: int) -> None:
    """Create a Flow project for an account that is already signed in."""
    if running(account_id):
        return
    _set(account_id, "project")
    _tasks[account_id] = asyncio.create_task(_project_task(account_id))


async def _project_task(account_id: int) -> None:
    try:
        accounts.use(account_id, "creating its Flow project")
        await chrome.switch_account_if_pending()
        chrome.hold_manually(300)
        await chrome.ensure_running("creating a Flow project")
        client = get_flow_client()
        for _ in range(60):
            if client.connected:
                break
            await asyncio.sleep(1)
        else:
            raise RuntimeError("The browser did not start. Try again in a minute.")
        await _ensure_project(account_id)
    except Exception as e:  # noqa: BLE001
        _set(account_id, "failed", str(e))


async def _run(account_id: int, email: str, password: str) -> None:
    try:
        if shutil.which("xdotool") is None:
            raise RuntimeError("xdotool is not installed in the image service; redeploy it.")

        # The account's own browser, held open for as long as this takes.
        accounts.use(account_id, "signing in from the platform")
        await chrome.switch_account_if_pending()
        chrome.hold_manually(TOTAL_TIMEOUT_S + 120)
        await chrome.ensure_running("signing in to Google")

        client = get_flow_client()
        for _ in range(60):
            if client.connected:
                break
            await asyncio.sleep(1)
        else:
            raise RuntimeError("The browser did not start. Try again in a minute.")

        opened = await client.google_login("open")
        if opened.get("error") or not opened.get("ok"):
            raise RuntimeError("Could not open Google's sign-in page: "
                               f"{opened.get('error') or 'the browser extension did not answer; redeploy the image service'}")
        await asyncio.sleep(4)

        deadline = time.time() + TOTAL_TIMEOUT_S
        typed: dict[str, float] = {}

        def fresh(field: str) -> bool:
            """Typed moments ago: the page is still moving on, do not type again."""
            return time.time() - typed.get(field, 0) < 20
        last_step, last_change = "", time.time()

        while time.time() < deadline:
            page = await client.google_login("state", email=email)
            step = page.get("step", "unknown")
            if step != last_step:
                last_step, last_change = step, time.time()

            if step == "done":
                accounts.mark_ok(account_id)
                logger.info("google login: account #%d signed in", account_id)
                await asyncio.sleep(5)  # let Flow finish loading on the new session
                await _ensure_project(account_id, after_login=True)
                return

            if step == "email":
                if "email" in typed and page.get("error"):
                    raise RuntimeError(f"Google did not accept the address: {page['error']}")
                if not fresh("email"):
                    _set(account_id, "email")
                    await _type_into('input[type="email"], #identifierId, input[name="identifier"]', email)
                    typed["email"] = time.time()
            elif step == "password":
                if "password" in typed and page.get("error"):
                    raise RuntimeError(f"Google did not accept the password: {page['error']}")
                if not fresh("password"):
                    _set(account_id, "password")
                    await _type_into('input[type="password"]:not([name="hiddenPassword"]), input[name="Passwd"]', password)
                    typed["password"] = time.time()
            elif step == "chooser":
                await client.google_login("choose", email=email)
            elif step == "phone":
                _set(account_id, "phone")
            elif step == "code":
                code = _codes.pop(account_id, None)
                if code:
                    await _type_into('input[name="totpPin"], #totpPin, input[name="idvPin"], #idvPin, '
                                     'input[name="Pin"], input[type="tel"]', code)
                else:
                    _set(account_id, "need_code")
            elif step in ("blocked", "captcha"):
                raise RuntimeError(
                    "Google will not let an automatic sign-in through for this account right now"
                    f" ({'it says the browser is not secure' if step == 'blocked' else 'it shows a captcha'})."
                    " Sign in once on the Browser page instead.")
            elif step == "verify":
                _set(account_id, "phone", "Google wants to check it is you. Follow the prompt on your phone,"
                                          " or finish on the Browser page.")
            if step in ("unknown", "no_tab", "verify") and time.time() - last_change > STUCK_TIMEOUT_S:
                raise RuntimeError("Google showed a page this cannot handle"
                                   f"{': ' + page.get('text', '')[:120] if page.get('text') else ''}."
                                   " Finish on the Browser page.")
            await asyncio.sleep(3)

        raise RuntimeError("Timed out waiting for Google. Finish on the Browser page.")
    except Exception as e:  # noqa: BLE001 -- every failure is reported, none is fatal
        logger.warning("google login: account #%d: %s", account_id, e)
        _set(account_id, "failed", str(e))
    finally:
        _codes.pop(account_id, None)
