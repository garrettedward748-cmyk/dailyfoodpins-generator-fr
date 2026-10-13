"""Video over the transport Flow actually uses.

REST video answers INVALID_ARGUMENT and is not coming back: Flow Kit's client
stopped sending video that way entirely when Flow moved to a batchexecute
endpoint on flow.google.com in September 2026. Those calls can only be signed by
a page that is already signed in, so the agent builds an envelope and the
extension runs it inside the Flow tab.

The envelope builder is agent/services/flow_batch.py, vendored from Flow Kit
unchanged and not tested here -- it is their code and their captures. What these
check is the seam this service owns: that the right RPC is asked for, that video
asks for a captcha and polling does not, and that a reply is read back into the
ids the worker needs.
"""
import asyncio

from agent.services import flow_batch as fb
from agent.services.flow_client import FlowClient


def client_with(reply):
    """A client whose transport returns `reply` and records what was sent."""
    client = FlowClient()
    sent: dict = {}

    async def fake_send(method, params, timeout=300):
        sent["method"] = method
        # Its own key as well: the REST params carry a "method": "POST" of
        # their own, which overwrites the transport method recorded above.
        sent["ws_method"] = method
        sent.update(params)
        return reply

    client._send = fake_send
    return client, sent


def envelope(rpcid: str, inner) -> str:
    """A reply shaped like batchexecute's, for the reader to unwrap."""
    import json
    payload = json.dumps(inner, separators=(",", ":"))
    return ")]}'\n\n" + json.dumps([["wrb.fr", rpcid, payload, None, None, None, "generic"]])


# ─── Submitting ─────────────────────────────────────────────

def test_video_goes_out_as_a_batch_rpc_not_a_rest_call():
    reply = {"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, sent = client_with(reply)

    asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert sent["method"] == "batch_rpc"
    assert sent["rpcid"] == fb.RPC_GEN_REEL
    # No URL at all: nothing here talks to aisandbox-pa any more.
    assert "url" not in sent


def test_the_video_submit_asks_for_a_captcha():
    reply = {"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, sent = client_with(reply)

    asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert sent["captchaAction"] == fb.CAPTCHA_VIDEO


def test_the_payload_leaves_a_slot_for_the_captcha():
    # The token is single-use and has to be minted in the page moments before
    # the request goes; the extension fills this in.
    reply = {"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, sent = client_with(reply)

    asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert fb.CAPTCHA_SLOT in sent["freq"]


def test_the_operation_id_comes_back():
    reply = {"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, _ = client_with(reply)

    out = asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert out["operation_id"] == "OP-1"
    assert out["project_id"] == "PROJ-1"


def test_a_transport_failure_is_reported_not_raised():
    client, _ = client_with({"error": "Extension not connected"})

    out = asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert "error" in out


def test_an_http_error_is_reported():
    client, _ = client_with({"status": 500, "data": ""})

    out = asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["MEDIA-1"], "CHAR-1", "VOICE-1"))

    assert "error" in out


def test_a_clip_goes_out_with_its_ingredients_in_their_slots():
    import json
    client, sent = client_with({"status": 200, "data": envelope(
        fb.RPC_GEN_REEL, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]])})

    asyncio.run(client.generate_reel_batch("soup", "PROJ-1", ["img-1", "img-2"], "char-1", "voice-1"))

    assert sent["ws_method"] == "batch_rpc"
    assert sent["captchaAction"] == fb.CAPTCHA_VIDEO
    inner = json.loads(json.loads(sent["freq"])[0][0][1])
    assert [e[1] for e in inner[0][0][1]] == ["img-1", "img-2"]
    assert inner[0][0][7] == [["voice-1"]]
    assert inner[0][0][9] == [["char-1"]]


# ─── Polling ────────────────────────────────────────────────

def test_polling_asks_for_the_operation_rpc_and_no_captcha():
    reply = {"status": 200, "data": envelope(
        fb.RPC_OPERATION, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, sent = client_with(reply)

    asyncio.run(client.check_operation_batch("OP-1"))

    assert sent["rpcid"] == fb.RPC_OPERATION
    # A poll that spent a captcha would burn one every fifteen seconds.
    assert sent["captchaAction"] is None


def test_a_finished_operation_reports_done():
    reply = {"status": 200, "data": envelope(
        fb.RPC_OPERATION, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", fb.STATUS_DONE]]]
    )}
    client, _ = client_with(reply)

    out = asyncio.run(client.check_operation_batch("OP-1"))

    assert out["done"] is True


def test_an_unfinished_operation_reports_not_done():
    reply = {"status": 200, "data": envelope(
        fb.RPC_OPERATION, [None, 50, [["OP-1", "PROJ-1", "SCENE-1", "PENDING"]]]
    )}
    client, _ = client_with(reply)

    assert asyncio.run(client.check_operation_batch("OP-1"))["done"] is False


# ─── Uploading ──────────────────────────────────────────────

def test_the_reference_upload_uses_the_batch_upload_rpc():
    # The two transports do not hand out interchangeable media ids, so a video
    # generated this way has to reference an image uploaded this way.
    reply = {"status": 200, "data": envelope(fb.RPC_UPLOAD_IMAGE, [None, None, "MEDIA-9"])}
    client, sent = client_with(reply)

    asyncio.run(client.upload_image_batch("Ym9keQ==", "PROJ-1"))

    assert sent["rpcid"] == fb.RPC_UPLOAD_IMAGE
