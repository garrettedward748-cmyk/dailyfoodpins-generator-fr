"""API key authentication for the public /v1 surface.

The internal /api/* routes were written for a loopback-only agent and have no
auth. Once this runs on Dokploy the HTTP port is public, so /v1 — the only
surface n8n needs — is gated behind a shared key.

Deliberately not gated: /health (Docker healthchecks must work without a
secret) and /setup's static assets.
"""
import hmac
import logging

from fastapi import Header, HTTPException

from agent.config import API_HOST, API_KEY

logger = logging.getLogger(__name__)


class InsecureConfiguration(RuntimeError):
    """Raised when the service would bind publicly with no API key set."""


def assert_secure_config() -> None:
    """Refuse to start if we'd serve an unauthenticated public endpoint.

    Binding to loopback without a key is fine — that's local development, and
    it's how the agent has always run. Binding to anything else without a key
    means the generate endpoint is open to whoever finds the URL, spending the
    account's Flow credits. That combination is a hard stop, not a warning:
    a warning in a container log is a warning nobody reads.
    """
    if API_KEY:
        return
    if API_HOST in ("127.0.0.1", "localhost", "::1"):
        logger.warning(
            "No API_KEY set — /v1 is unauthenticated. Acceptable only because "
            "API_HOST=%s is loopback-only.", API_HOST,
        )
        return
    raise InsecureConfiguration(
        f"API_HOST={API_HOST} exposes this service beyond loopback, but no "
        f"API_KEY is set. Anyone who reaches this port could spend your Google "
        f"Flow credits.\n\n"
        f"Fix: set the API_KEY environment variable to a long random string.\n"
        f"  Generate one with:  openssl rand -hex 32"
    )


async def require_api_key(x_api_key: str = Header(None)) -> None:
    """FastAPI dependency enforcing the X-API-Key header on /v1 routes."""
    if not API_KEY:
        # assert_secure_config() has already established this is loopback-only.
        return
    if not x_api_key:
        raise HTTPException(401, "Missing X-API-Key header")
    # Constant-time compare so a wrong key can't be discovered by timing.
    if not hmac.compare_digest(x_api_key, API_KEY):
        raise HTTPException(401, "Invalid API key")
