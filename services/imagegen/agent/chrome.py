"""Chrome's lifecycle, which is this container's entire CPU cost.

Measured on the deployed container with no Flow tab open at all -- `about:blank`
and nothing else:

    total 185% CPU
       89   170.0  chrome --type=gpu-process ... --use-angle=swiftshader
      161     8.0  chrome --type=renderer --extension-process
       47     7.0  Xvfb :99 -screen 0 1366x768x24

and inside pid 89, the reason:

       89    43.0  chrome              <- GPU main thread
       94    22.0  Thread<01>  )
       95    21.0  Thread<02>  |
       93    20.0  Thread<00>  }- 118% across six workers
       98    20.0  Thread<05>  |
       96    19.0  Thread<03>  |
       97    16.0  Thread<04>  )
      116     5.0  VizCompositorTh     <- the actual compositor

Thread<NN> is marl, the scheduler SwiftShader runs on. Its workers spin-wait
rather than block, so they burn cores whether or not anything is drawn -- and
VizCompositorThread at 5% says nothing was being drawn. The cost is the GPU
process existing, not the page inside it.

That is why five fixes in a row missed. The autoplay policy, the framebuffer
halved to 1366x768, --num-raster-threads=1, loading Flow in a background tab and
closing the Flow tab between runs all reduce work on screen, and there was no
work on screen. Closing the tab by hand appeared to cure it only because it was
Chrome's last tab, so Chrome exited: the 43% that measurement recorded was the
container with no browser in it.

--disable-gpu and --disable-software-rasterizer would end it and are still not
available: they take WebGL with them, and reCAPTCHA reads WebGL.

So Chrome runs while there is work and not otherwise. A job needs four to six
minutes of it. The profile lives on the /data volume, so the Google session
survives a stop, and the extension is force-installed from policy again on the
next start -- the same path a cold container already takes.

Held with a counter rather than a flag, for the same reason the tab was: the
worker drives MAX_CONCURRENT_REQUESTS jobs in parallel, and the first to finish
must not stop a browser the second is still using.
"""
import asyncio
import logging
import os
import subprocess
import time
from typing import Optional

from agent import accounts

logger = logging.getLogger(__name__)

# How long Chrome stays up after the last job lets go. Long enough that the
# four images of one article do not each pay a cold start, short enough that an
# idle container is not paying 170% for a browser nobody is using.
IDLE_STOP_S = int(os.environ.get("CHROME_IDLE_STOP", "180"))

# Set CHROME_ALWAYS_ON=1 to pin Chrome up and restore the old behaviour. Here
# for the case where this turns out to break something under load and someone
# needs the previous shape back without a redeploy.
ALWAYS_ON = os.environ.get("CHROME_ALWAYS_ON", "") not in ("", "0", "false", "False")

_SUPERVISORCTL = ["supervisorctl", "-c", "/etc/supervisor/supervisord.conf"]

# What we have asked supervisord for, not what it did. The watchdog reads this
# to tell "Chrome is down because we stopped it" from "Chrome is wedged", which
# are the same observation -- the extension is not connected -- with opposite
# remedies.
_wanted_running = False
_users = 0
_idle_since: Optional[float] = None
_manual_until: float = 0.0
_lock = asyncio.Lock()

# A person signing in to Google is not a queued job, so nothing would hold
# Chrome up for them and the idle stop would close the browser under their
# hands three minutes in. A manual start pins it for this long instead.
#
# Two minutes, not fifteen. This is a lease the viewer renews while its socket
# is open, not a guess at how long someone might stay -- and as a guess it was
# badly wrong: at fifteen minutes, one visit to the Browser page cost eighteen
# minutes of a browser at 170%, so opening the page to see whether the CPU had
# come down was the thing keeping it up. Every high-CPU window in the log that
# proved it was self-inflicted that way.
MANUAL_HOLD_S = int(os.environ.get("CHROME_MANUAL_HOLD", "120"))

# The longest a queued account switch waits for the jobs holding the browser.
# A switch waits for them so it does not cut a request off -- but nothing new is
# claimed meanwhile, and a reel's video job polls for up to twenty minutes. An
# article's image that set off the switch sat behind it all that time. Past
# this, the switch goes ahead: a job cut off goes back in the queue (Chrome
# gone reads as "not connected", which is retried) and runs on the new account.
SWITCH_MAX_WAIT_S = int(os.environ.get("ACCOUNT_SWITCH_MAX_WAIT", "240"))
_pending_seen: tuple = (None, 0.0)  # (account id, when first seen pending)


def hold_manually(seconds: int = MANUAL_HOLD_S) -> None:
    """Keep Chrome up for someone using the Browser page by hand."""
    global _manual_until
    _manual_until = time.monotonic() + seconds


def release_manual_hold() -> None:
    """Drop the pin, so an explicit stop is not undone by the next pass."""
    global _manual_until
    _manual_until = 0.0


def wanted_running() -> bool:
    return _wanted_running


def state() -> dict:
    """For /flow/status and the watchdog's log line."""
    return {
        "wanted_running": _wanted_running,
        "users": _users,
        "idle_for_s": round(time.monotonic() - _idle_since) if _idle_since else None,
        "idle_stop_after_s": IDLE_STOP_S,
        "held_manually_for_s": max(0, round(_manual_until - time.monotonic())) or None,
        "always_on": ALWAYS_ON,
        "account": accounts.active_id(),
        "account_switch_pending": accounts.switch_pending(),
    }


async def _supervisor(action: str) -> bool:
    """Run one supervisorctl verb against the chrome program."""
    def run() -> subprocess.CompletedProcess:
        return subprocess.run(
            [*_SUPERVISORCTL, action, "chrome"],
            capture_output=True, text=True, timeout=90,
        )

    try:
        result = await asyncio.to_thread(run)
    except FileNotFoundError:
        logger.warning("supervisorctl not available — not running under supervisord")
        return False
    except (subprocess.SubprocessError, OSError) as e:
        logger.error("Chrome %s error: %s", action, e)
        return False

    if result.returncode == 0:
        return True

    # `start` on an already-running program and `stop` on an already-stopped one
    # both exit non-zero, and both mean the state we wanted. Not an error.
    combined = (result.stdout + result.stderr).lower()
    if "already started" in combined or "not running" in combined:
        return True

    logger.error("Chrome %s failed: %s", action, (result.stderr or result.stdout).strip()[:200])
    return False


async def ensure_running(reason: str) -> None:
    """Start Chrome if it is not meant to be up. Safe to call every loop."""
    global _wanted_running
    async with _lock:
        if _wanted_running:
            return
        logger.info("Chrome: starting (%s)", reason)
        if await _supervisor("start"):
            _wanted_running = True
        # On failure _wanted_running stays False, so the next pass retries and
        # the watchdog still sees a browser that is supposed to be down. Better
        # than claiming it is up and having the watchdog restart into it.


async def ensure_stopped(reason: str) -> None:
    global _wanted_running, _idle_since
    async with _lock:
        if not _wanted_running:
            return
        # A job outranks anyone asking for a stop. /flow/chrome/stop is reachable
        # while generation is in flight -- closing the Browser page calls it --
        # and taking the browser away mid-run kills the request the bearer token
        # is riding on, which surfaces as NO_FLOW_KEY and loses the job.
        if _users > 0:
            logger.info("Chrome: not stopping (%s) — %d job(s) still using it", reason, _users)
            return
        logger.info("Chrome: stopping (%s) — idle costs 170%% while it runs", reason)
        if await _supervisor("stop"):
            _wanted_running = False
            _idle_since = None


def hold() -> None:
    """Claim Chrome for a job. Call before the work, not inside a task."""
    global _users, _idle_since
    _users += 1
    _idle_since = None


def release() -> None:
    """Give it back. The stop happens on the worker's next pass, not here."""
    global _users, _idle_since
    _users = max(0, _users - 1)
    if _users == 0:
        _idle_since = time.monotonic()


async def switch_account_if_pending() -> bool:
    """Carry out a queued account switch, if nothing is using the browser.

    Stop Chrome (if up), point the next start at the new profile. The caller's
    usual ensure_running then starts it there. Never under a job: a switch
    mid-generation would kill the request the bearer token is riding on.
    """
    global _wanted_running, _idle_since, _pending_seen
    pending = accounts.switch_pending()
    if not pending:
        _pending_seen = (None, 0.0)
        return False
    if _pending_seen[0] != pending:
        _pending_seen = (pending, time.monotonic())
    waited = time.monotonic() - _pending_seen[1]
    overdue = waited >= SWITCH_MAX_WAIT_S
    if _users > 0 and not overdue:
        return False
    async with _lock:
        if _users > 0 and not overdue:
            return False
        if _users > 0:
            logger.warning("Chrome: account switch waited %ds for %d job(s) — switching anyway; "
                           "they go back in the queue", int(waited), _users)
        if _wanted_running:
            logger.info("Chrome: stopping to switch Google account")
            if not await _supervisor("stop"):
                return False
            _wanted_running = False
            _idle_since = None
        switched = accounts.apply_pending_switch()
        return switched is not None


async def reconcile(work_waiting: bool) -> None:
    """Bring Chrome in line with whether there is anything for it to do.

    Called once per worker pass. `work_waiting` covers jobs that are queued but
    not yet claimed -- without it a container whose Chrome is stopped would never
    start one, because the worker only claims jobs while the extension is
    connected and the extension cannot connect without a browser.
    """
    global _idle_since

    await switch_account_if_pending()

    if ALWAYS_ON:
        await ensure_running("CHROME_ALWAYS_ON is set")
        return

    held_manually = time.monotonic() < _manual_until
    if work_waiting or _users > 0 or held_manually:
        _idle_since = None
        await ensure_running("someone is using it" if held_manually else "work waiting")
        return

    if not _wanted_running:
        return

    if _idle_since is None:
        _idle_since = time.monotonic()
        return

    if time.monotonic() - _idle_since >= IDLE_STOP_S:
        await ensure_stopped(f"no work for {IDLE_STOP_S}s")
