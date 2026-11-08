"""Serving the extension to the Chrome running beside it.

Chrome cannot load an unpacked extension any more, so it force-installs a
signed CRX through enterprise policy. The policy names two URLs on this
service; if either is wrong the extension never installs, and the symptom is
not an error — it is generation failing later with NO_FLOW_KEY.

Verified against a real Chrome 151 pack: --pack-extension produced a Cr24
format-3 CRX, the id derivation matched, and these routes served it back
byte-identical.
"""
import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def build(dist_dir) -> TestClient:
    """A client over the ext routes, pointed at a given dist directory."""
    import importlib
    import os

    os.environ["EXT_DIST_DIR"] = str(dist_dir)
    from agent.api import ext_host

    importlib.reload(ext_host)

    app = FastAPI()
    app.include_router(ext_host.router)
    return TestClient(app)


@pytest.fixture
def packed(tmp_path):
    """A stand-in for what pack-extension.sh leaves in /app/ext-dist."""
    ext_id = "lahfflihjjglkfdlhofpjofnndojpecl"
    (tmp_path / "update.xml").write_text(
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid='{ext_id}'>\n"
        "    <updatecheck codebase='http://127.0.0.1:8100/ext/flowkit.crx' version='0.2.0' />\n"
        "  </app>\n"
        "</gupdate>\n",
        encoding="utf-8",
    )
    # Cr24, format 3 — the header Chrome checks before anything else.
    (tmp_path / "flowkit.crx").write_bytes(b"Cr24" + struct.pack("<I", 3) + b"\x00" * 64)
    return tmp_path


def test_the_update_manifest_is_served_as_xml(packed):
    response = build(packed).get("/ext/update.xml")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/xml")
    assert "gupdate" in response.text


def test_the_manifest_names_the_crx_route_this_service_serves(packed):
    # The codebase URL and the CRX route have to agree, or Chrome polls
    # successfully and then fails to fetch what the poll pointed it at.
    text = build(packed).get("/ext/update.xml").text

    assert "/ext/flowkit.crx" in text


def test_the_crx_is_served_with_chrome_content_type(packed):
    response = build(packed).get("/ext/flowkit.crx")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-chrome-extension"


def test_the_served_crx_carries_the_cr24_header(packed):
    body = build(packed).get("/ext/flowkit.crx").content

    assert body[:4] == b"Cr24"
    assert struct.unpack("<I", body[4:8])[0] == 3


def test_a_missing_pack_reports_503_rather_than_500(tmp_path):
    # An image whose build skipped the pack step should say so plainly; the
    # 503 is what distinguishes "not built" from "route is broken".
    client = build(tmp_path / "nothing-here")

    assert client.get("/ext/update.xml").status_code == 503
    assert client.get("/ext/flowkit.crx").status_code == 503


def test_the_routes_need_no_api_key(packed):
    # Chrome cannot present one when fetching an update manifest. What limits
    # the exposure is that the CRX is the same extension code already in the
    # image, and the port has no route in from outside the Docker network.
    assert build(packed).get("/ext/update.xml").status_code == 200


# --- Where Chrome lands when it starts ------------------------------------
# Chrome is started for a queued job. It used to open the Flow home page and
# the extension then went looking for a project link to move to -- two page
# loads and a navigation before any work. The extension now asks this route
# on startup and goes straight to the queued job's project.

def test_chrome_lands_on_the_queued_jobs_project(packed, monkeypatch):
    from agent.api import ext_host

    async def next_project():
        return "abc-123"

    # build() reloads the module, so the patch goes on afterwards.
    client = build(packed)
    monkeypatch.setattr(ext_host, "next_project_id", next_project)
    monkeypatch.setattr(ext_host, "FLOW_PROJECT_ID", "")
    body = client.get("/ext/landing").json()
    assert body == {"url": "https://flow.google.com/project/abc-123"}


def test_chrome_lands_on_home_when_nothing_is_queued(packed, monkeypatch):
    # Someone starting Chrome from the Browser page to sign in gets the page
    # they expect, exactly as before.
    from agent.api import ext_host

    async def next_project():
        return ""

    client = build(packed)
    monkeypatch.setattr(ext_host, "next_project_id", next_project)
    monkeypatch.setattr(ext_host, "FLOW_PROJECT_ID", "")
    body = client.get("/ext/landing").json()
    assert body == {"url": "https://flow.google.com/"}
