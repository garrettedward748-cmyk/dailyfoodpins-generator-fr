"""Serves the extension CRX and its update manifest to the local Chrome.

Chrome force-installs the extension via enterprise policy (see
docker/pack-extension.sh), and a force-install entry needs an update URL
serving a gupdate manifest. Rather than depend on an external host, the agent
serves both itself over loopback.

Deliberately unauthenticated: the only client is the Chrome running beside it
in this container, and Chrome cannot present an API key when fetching an
update manifest. Nothing here is sensitive — the CRX is the same extension
code that ships in the image — and the routes are only reachable from inside
the container unless someone publishes the port without a proxy.
"""
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from agent.config import FLOW_PROJECT_ID
from agent.db.jobs import next_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ext", tags=["ext"])

# Where pack-extension.sh writes the CRX at build time. Overridable so the
# routes can be exercised outside a container.
DIST = Path(os.environ.get("EXT_DIST_DIR", "/app/ext-dist"))


@router.get("/update.xml")
async def update_manifest():
    """The gupdate manifest Chrome polls to discover the extension."""
    manifest = DIST / "update.xml"
    if not manifest.is_file():
        raise HTTPException(503, "Extension was not packed at build time")
    return PlainTextResponse(
        manifest.read_text(encoding="utf-8"), media_type="text/xml",
    )


@router.get("/flowkit.crx")
async def crx():
    """The packed extension itself."""
    package = DIST / "flowkit.crx"
    if not package.is_file():
        raise HTTPException(503, "Extension was not packed at build time")
    logger.info("Serving CRX to Chrome")
    return FileResponse(
        package,
        media_type="application/x-chrome-extension",
        filename="flowkit.crx",
    )


FLOW_HOME = "https://flow.google.com/"


@router.get("/landing")
async def landing() -> dict:
    """Where a freshly started Chrome should open.

    Chrome is started because a job is queued, and the extension asks this on
    startup. Answering with that job's project page means the first page
    Google sees is the one the work needs -- one load, no visit to the home
    page and no navigation from it. With nothing queued (someone opened the
    Browser page to sign in) it is the home page, as it always was.

    Unauthenticated for the same reason as the CRX route: the caller is the
    Chrome beside us, which cannot carry the key.
    """
    from agent import accounts
    project = accounts.active_project() or await next_project_id() or FLOW_PROJECT_ID
    return {"url": f"{FLOW_HOME}project/{project}" if project else FLOW_HOME}
