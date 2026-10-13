"""Unattended-operation guard.

Three failures matter for a service nobody is watching:

  1. Chrome wedges       — recoverable by restarting Chrome
  2. Google logs you out — NOT recoverable by anything automatic
  3. Everything fails    — recoverable, but grinding through it wastes credits

The distinction between (1) and (2) is the whole point. Restarting Chrome on a
sign-in wall just reopens the same wall, and the retry path drives tab creation
— which is exactly how the runaway-tab incident happened. So SESSION_EXPIRED
pauses and reports; it never restarts.

Retry and backoff for individual requests already live in worker/processor.py
and are covered by tests. This module deliberately does not duplicate them.
"""
import asyncio
import logging
import os
import subprocess
import time
from dataclasses import dataclass, field
from typing import Optional

from agent import accounts, chrome
from agent.db import jobs
from agent.services.flow_client import get_flow_client

logger = logging.getLogger(__name__)

# How long the extension may stay disconnected before we call Chrome wedged.
# The extension retries roughly every 5s (extension/background.js), so a gap
# this long is not a transient reconnect — it means Chrome itself is stuck.
DISCONNECT_GRACE_S = int(os.environ.get("WATCHDOG_DISCONNECT_GRACE", "120"))

# ...but only once the extension has connected at least once. Before that,
# Chrome is still installing it: a force-installed extension arrives through
# enterprise policy, and Chrome fetches the update manifest on its own delayed,
# backing-off schedule rather than at startup.
#
# Restarting during that window is actively harmful. It throws away the
# progress Chrome had made and starts the delay over, so a 120s grace on a
# fresh profile produces a container that restarts Chrome forever and never
# finishes installing the extension. That is a loop this watchdog caused.
FIRST_CONNECT_GRACE_S = int(os.environ.get("WATCHDOG_FIRST_CONNECT_GRACE", "600"))

# And once that longer grace expires, a restart is worth exactly one try. If
# the extension still has not appeared, it is not installed, and no number of
# restarts installs it.
MAX_RESTARTS_BEFORE_FIRST_CONNECT = 1

# Consecutive failures before the breaker trips. Low on purpose: an unattended
# service that fails 500 times overnight is worse than one that stops at 5 and
# says why.
FAILURE_THRESHOLD = int(os.environ.get("WATCHDOG_FAILURE_THRESHOLD", "5"))

# How far back the breaker looks. The job table outlives the container, so an
# unbounded look-back makes a run of failures permanent evidence: it would trip
# thirty seconds after every start, pause the worker, and -- because a paused
# worker reports no work waiting -- keep Chrome stopped and send nothing, for
# ever, long after the cause was fixed. That is exactly what happened.
CIRCUIT_WINDOW_S = int(os.environ.get("WATCHDOG_CIRCUIT_WINDOW", "1800"))

CHECK_INTERVAL_S = int(os.environ.get("WATCHDOG_INTERVAL", "30"))

# Print the Flow tab's state every Nth watchdog cycle. Two cycles is a minute,
# which is fine against a close that waits two.
TAB_LOG_EVERY = int(os.environ.get("WATCHDOG_TAB_LOG_EVERY", "2"))
_tab_log_tick = 0

# Backstop so a persistently broken Chrome doesn't get restarted forever.
MAX_RESTARTS_PER_HOUR = int(os.environ.get("WATCHDOG_MAX_RESTARTS", "4"))

# Only a genuine sign-in wall belongs here. NO_FLOW_KEY used to be in this
# list and should not have been: it means the extension had no bearer token in
# memory, which it now recovers on its own by reloading the Flow tab. Treating
# it as a session wall paused the worker and demanded a human for something
# that resolves itself in seconds.
_SESSION_MARKERS = ("SESSION_EXPIRED",)


@dataclass
class WatchdogState:
    """Snapshot for /health and /setup to render."""
    healthy: bool = True
    reason: Optional[str] = None
    needs_human: bool = False
    consecutive_failures: int = 0
    chrome_restarts: list[float] = field(default_factory=list)
    disconnected_since: Optional[float] = None
    ever_connected: bool = False
    paused_by: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "healthy": self.healthy,
            "reason": self.reason,
            "needs_human": self.needs_human,
            "consecutive_failures": self.consecutive_failures,
            "chrome_restarts_last_hour": len(self.chrome_restarts),
            "ever_connected": self.ever_connected,
        }


state = WatchdogState()


def restart_chrome() -> bool:
    """Ask supervisord to restart Chrome. False if we can't (e.g. not in Docker)."""
    try:
        result = subprocess.run(
            ["supervisorctl", "-c", "/etc/supervisor/supervisord.conf", "restart", "chrome"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            logger.warning("Watchdog restarted Chrome")
            return True
        logger.error("Chrome restart failed: %s", result.stderr.strip()[:200])
    except FileNotFoundError:
        logger.warning("supervisorctl not available — not running under supervisord")
    except (subprocess.SubprocessError, OSError) as e:
        logger.error("Chrome restart error: %s", e)
    return False


def _restarts_in_last_hour() -> int:
    cutoff = time.monotonic() - 3600
    state.chrome_restarts = [t for t in state.chrome_restarts if t > cutoff]
    return len(state.chrome_restarts)


async def _recent_failures(limit: int = 10, within_seconds: int = 0) -> list[dict]:
    """Most recent finished jobs, newest first."""
    return await jobs.recent_finished(limit, within_seconds)


async def _check_session_wall(controller) -> bool:
    """Pause and flag if the newest failure is a sign-in wall. True if walled."""
    recent = await _recent_failures(limit=3)
    for request in recent:
        if request.get("status") != "FAILED":
            break  # a success since then means the session is fine
        message = (request.get("error_message") or "").upper()
        if any(marker in message for marker in _SESSION_MARKERS):
            # Another Google account can carry on while this one waits for
            # someone to sign it back in.
            if accounts.rotate("SESSION_EXPIRED") is not None or accounts.switch_pending():
                state.reason = "A Google account was signed out; switched to the next one."
                return False
            state.healthy = False
            state.needs_human = True
            state.reason = (
                "Google signed this browser out. Open /setup and sign in again — "
                "restarting will not fix it."
            )
            controller.pause("session expired")
            return True
    return False


async def _check_circuit_breaker(controller) -> bool:
    """Pause if the last N finished requests all failed. True if tripped.

    Only failures inside CIRCUIT_WINDOW_S count, and the pause is lifted again
    once they age out. Without both halves this latches: it paused the worker,
    a paused worker reports nothing waiting so Chrome never starts, and nothing
    anywhere cleared needs_human -- so the service went quiet permanently and
    came back quiet after every restart, because the failures are on disk.
    """
    recent = await _recent_failures(limit=FAILURE_THRESHOLD, within_seconds=CIRCUIT_WINDOW_S)
    tripped = (
        len(recent) >= FAILURE_THRESHOLD
        and all(r.get("status") == "FAILED" for r in recent)
    )

    if not tripped:
        state.consecutive_failures = 0
        _release_circuit_breaker(controller)
        return False

    # With another Google account, try it before stopping everything -- but only
    # once per window: the failures that tripped this are still on record, and
    # without the guard every pass would rotate again.
    if accounts.count() > 1 and accounts.seconds_since_switch() > CIRCUIT_WINDOW_S:
        last = (recent[0].get("error_message") or "kept failing")[:160]
        if accounts.rotate(last) is not None:
            logger.warning("Watchdog: %d failures in a row — switching Google account", FAILURE_THRESHOLD)
            state.consecutive_failures = 0
            return False

    state.consecutive_failures = FAILURE_THRESHOLD
    state.healthy = False
    state.needs_human = True
    last_error = (recent[0].get("error_message") or "unknown error")[:120]
    state.reason = (
        f"Stopped after {FAILURE_THRESHOLD} failures in a row. "
        f"Most recent: {last_error}"
    )
    state.paused_by = "circuit breaker"
    controller.pause("circuit breaker")
    return True


def _release_circuit_breaker(controller) -> None:
    """Undo a pause this check made, once its failures have aged out."""
    if state.paused_by != "circuit breaker":
        return
    logger.info("Watchdog: the failures that tripped the breaker have aged out")
    state.paused_by = None
    state.needs_human = False
    state.healthy = True
    state.reason = None
    controller.resume()


async def _check_extension(controller) -> bool:
    """Restart Chrome if the extension has been gone too long. True if unhealthy."""
    # A browser we stopped on purpose presents exactly as a wedged one -- the
    # extension is not connected either way -- and the remedies are opposites.
    # Without this the watchdog restarts Chrome the moment the worker stops it,
    # every time, and the container never stops paying the 170% that stopping it
    # was for. The disconnect clock is reset rather than left running, so the
    # grace period starts from the next start rather than from the stop.
    if not chrome.wanted_running():
        state.disconnected_since = None
        return False

    if get_flow_client().connected:
        if state.disconnected_since is not None:
            logger.info("Extension connected")
        state.disconnected_since = None
        state.ever_connected = True
        return False

    now = time.monotonic()
    if state.disconnected_since is None:
        state.disconnected_since = now
        return False

    gap = now - state.disconnected_since

    # A fresh container is a different situation from a dropped connection.
    grace = DISCONNECT_GRACE_S if state.ever_connected else FIRST_CONNECT_GRACE_S
    if gap < grace:
        return False

    if not state.ever_connected and len(state.chrome_restarts) >= MAX_RESTARTS_BEFORE_FIRST_CONNECT:
        state.healthy = False
        state.needs_human = True
        state.reason = (
            f"The extension has never connected, {int(gap)}s after Chrome started. "
            "That means it is not installed, and restarting will not install it. "
            "Open the Browser page and check chrome://extensions."
        )
        controller.pause("extension not installed")
        return True

    if _restarts_in_last_hour() >= MAX_RESTARTS_PER_HOUR:
        state.healthy = False
        state.needs_human = True
        state.reason = (
            f"Chrome has been restarted {MAX_RESTARTS_PER_HOUR} times in an hour "
            f"and still isn't connecting. This needs a look — open /setup."
        )
        controller.pause("chrome unrecoverable")
        return True

    state.healthy = False
    state.reason = (
        f"Extension has not connected in {int(gap)}s — restarting Chrome (one attempt)."
        if not state.ever_connected
        else f"Browser disconnected for {int(gap)}s — restarting Chrome."
    )
    if restart_chrome():
        state.chrome_restarts.append(now)
    state.disconnected_since = now  # restart grace before trying again
    return True


async def _log_tab_state() -> None:
    """Print whether the Flow tab is open, and why, into the container log.

    The tab is the largest CPU cost in this service — the GPU process alone
    takes 283% with it open and 11% without — and the extension decides on its
    own when to close it, on two counters that live in a service worker.

    None of that reached anywhere a person can read. The worker's console is a
    devtools window nobody can open on a headless container, `docker logs`
    carries Chrome's stderr rather than the extension's, and the deployment is
    Dokploy, where there is no shell to curl /flow/diagnostics from. So a tab
    that should have closed and did not looks exactly like a tab in use, from
    the only surface anyone actually has.

    Best effort in every direction: a watchdog that fell over because a
    diagnostic timed out would cost far more than the line it prints.
    """
    global _tab_log_tick
    _tab_log_tick += 1
    if _tab_log_tick % TAB_LOG_EVERY:
        return

    # Say so rather than going quiet: a log that stops printing looks like a
    # log that broke, and "stopped" is the state this whole change exists to
    # reach. It is also the answer to "why is the container at 15%".
    if not chrome.wanted_running():
        logger.info("Chrome: stopped — no GPU process, nothing queued")
        return

    client = get_flow_client()
    if not client.connected:
        return

    payload = await client.get_diagnostics()
    diag = payload.get("result") or {}
    if not diag:
        return

    tabs = diag.get("flow_tabs")
    chrome_state = chrome.state()
    logger.info(
        "Chrome: running, jobs=%s idle=%ss/%ss | Flow tab: open=%s total=%s state=%s",
        chrome_state["users"],
        chrome_state["idle_for_s"],
        chrome_state["idle_stop_after_s"],
        len(tabs) if isinstance(tabs, list) else "?",
        diag.get("total_tabs"),
        diag.get("state"),
    )


async def run(controller, interval: int = CHECK_INTERVAL_S):
    """Watchdog loop. Started alongside the worker in main.lifespan."""
    logger.info(
        "Watchdog running (grace=%ds, failure threshold=%d)",
        DISCONNECT_GRACE_S, FAILURE_THRESHOLD,
    )
    while True:
        try:
            await asyncio.sleep(interval)

            # Before the checks below, not after: they each `continue` on a
            # fault, and a fault is exactly when knowing the tab state matters.
            try:
                await _log_tab_state()
            except Exception as e:  # noqa: BLE001 - diagnostics must never throw
                logger.debug("Flow tab state unavailable: %s", e)

            # Order matters: a sign-in wall is checked first because it also
            # presents as a run of failures, and its remedy is the opposite of
            # the extension check's. Diagnosing it as "Chrome wedged" would
            # restart into the same wall and spawn tabs doing it.
            if await _check_session_wall(controller):
                continue
            if await _check_circuit_breaker(controller):
                continue
            if await _check_extension(controller):
                continue

            if not state.healthy and not state.needs_human:
                logger.info("Watchdog: recovered")
                state.healthy = True
                state.reason = None
                controller.resume()

        except asyncio.CancelledError:
            logger.info("Watchdog stopped")
            raise
        except Exception:
            # A crashed watchdog is worse than a noisy one.
            logger.exception("Watchdog check failed; continuing")
