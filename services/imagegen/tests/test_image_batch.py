"""Images over the transport Flow actually uses.

Three days after REST video started answering INVALID_ARGUMENT, REST images
started answering

    {'code': 401, 'message': 'Request had invalid authentication credentials.
     Expected OAuth 2 access token, login cookie or other valid authentication
     credential.', 'status': 'UNAUTHENTICATED'}

That is the bearer token being refused rather than the request: the page no
longer talks to aisandbox-pa, so the token sniffed off it is no longer good
there. The batch path signs itself inside the Flow tab and needs no sniffed
token at all -- the same move video made, one endpoint later.

As with test_video_batch.py, the envelope builder and readers are Flow Kit's
code and not tested here. What these pin is the seam this service owns: that an
image goes out as a batch RPC asking for the image captcha, and -- the part
that matters most -- that the answer comes back in the REST shape the worker
already reads, so nothing downstream had to learn a second one.
"""
import asyncio

from agent.services import flow_batch as fb
from agent.services.flow_client import FlowClient
from agent.worker._parsing import extract_output_url, is_error

from tests.test_video_batch import client_with, envelope


IMAGE_URL = f"https://{fb.MEDIA_HOST}/image/abc123def?sig=xyz"


def image_reply():
    # Where the url sits inside the payload is Flow's business; read_images
    # walks every string, so any nesting that contains it is enough here.
    return {"status": 200, "data": envelope(
        fb.RPC_GEN_IMAGE, [None, [[None, None, [[IMAGE_URL]]]]]
    )}


def test_an_image_goes_out_as_a_batch_rpc_not_a_rest_call():
    client, sent = client_with(image_reply())

    asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert sent["method"] == "batch_rpc"
    assert sent["rpcid"] == fb.RPC_GEN_IMAGE
    # No URL at all: nothing here talks to aisandbox-pa any more, so there is
    # no bearer token to be refused.
    assert "url" not in sent


def test_the_image_submit_names_its_project_so_the_tab_can_land_on_it():
    # The extension opens the Flow tab on this project's page directly, rather
    # than on the home page and then hunting for a project link.
    client, sent = client_with(image_reply())

    asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert sent["projectId"] == "PROJ-1"


def test_the_image_submit_asks_for_the_image_captcha():
    client, sent = client_with(image_reply())

    asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert sent["captchaAction"] == fb.CAPTCHA_IMAGE


def test_the_answer_is_in_the_shape_the_worker_already_reads():
    """The whole point of folding the batch reply into the REST shape.

    _run_image calls extract_output_url() on whatever comes back and has done so
    since before the batch path existed. If this stops holding, images complete
    with no url and the platform gets nothing, and the failure looks like Flow
    returning empty rather than like this adapter drifting.
    """
    client, _ = client_with(image_reply())

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert not is_error(result)
    assert extract_output_url(result) == IMAGE_URL
    assert result["data"]["media"][0]["name"] == "abc123def"


def test_a_transport_error_is_passed_through_as_one():
    client, _ = client_with({"error": "Extension not connected"})

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert is_error(result)
    assert "not connected" in result["error"]


def test_an_answer_with_no_image_in_it_is_an_error_not_a_blank_success():
    client, _ = client_with({"status": 200, "data": envelope(fb.RPC_GEN_IMAGE, [None, []])})

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert is_error(result)
    assert "No image url" in result["error"]


def test_the_rest_path_is_still_there_behind_the_flag():
    """IMAGE_USE_BATCH=0 has to mean something on the day Google turns REST back on."""
    client, sent = client_with({"status": 200, "data": {"media": []}})

    asyncio.run(client.generate_images("soup", "PROJ-1"))

    assert sent["ws_method"] == "api_request"
    assert "aisandbox-pa.googleapis.com" in sent["url"]
