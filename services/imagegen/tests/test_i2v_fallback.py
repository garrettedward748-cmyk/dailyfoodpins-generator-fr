"""The video that gets made when reference-to-video is refused.

Reference video began answering

    {'code': 400, 'message': 'Request contains an invalid argument.',
     'status': 'INVALID_ARGUMENT'}

on a submit that had worked days earlier, and it is not coming back: the
endpoint Google is migrating to accepts three video models and every one of them
is i2v, and Flow Kit's own r2v method on that path refuses outright because its
payload was never captured off the new UI.

So a refusal falls through to a video built from the first image. Two things
have to hold for that to be worth having, and both are tested here: the i2v body
has to be the one Flow's UI sends -- the same frozen-surface rule as the r2v
body next door -- and the fallback has to fire on a refusal and not on a blip,
because falling back on a rate limit would quietly turn every reel into a
one-image video over something that would have worked on the retry.
"""
import asyncio

from agent.services.flow_client import FlowClient
from agent.worker._parsing import rejected_the_request


def capture(**kwargs) -> dict:
    """Run the start-image call with the transport stubbed."""
    client = FlowClient()
    captured: dict = {}

    async def fake_send(method, params, timeout=300):
        captured.update(params)
        return {}

    client._send = fake_send

    call = dict(
        start_image_media_id="11111111-1111-1111-1111-111111111111",
        prompt="a bowl of soup, slowly steaming",
        project_id="PROJ-1",
        scene_id="JOB-1",
    )
    call.update(kwargs)

    asyncio.run(client.generate_video_from_image(**call))
    return captured


# ─── The request Google sees ────────────────────────────────

def test_url_is_the_start_image_endpoint():
    assert capture()["url"] == (
        "https://aisandbox-pa.googleapis.com"
        "/v1/video:batchAsyncGenerateVideoStartImage"
        "?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
    )


def test_captcha_action_is_requested():
    # Video consumes a captcha whichever endpoint it goes to; without this the
    # extension never solves one and Google answers 403.
    assert capture()["captchaAction"] == "VIDEO_GENERATION"


def test_the_image_travels_as_a_start_image():
    request = capture()["body"]["requests"][0]

    assert request["startImage"] == {
        "mediaId": "11111111-1111-1111-1111-111111111111"
    }
    # The reference list belongs to the other endpoint. Sending both is a
    # different request than either capture, and this path has no way to learn
    # that except another unexplained 400.
    assert "referenceImages" not in request


def test_metadata_carries_the_scene_id():
    # Not decoration, and not empty either: the r2v capture has {} here and the
    # i2v capture has an id, so the difference is kept rather than tidied.
    assert capture()["body"]["requests"][0]["metadata"] == {"sceneId": "JOB-1"}


def test_body_is_the_v2_batch_wrapper():
    body = capture()["body"]

    assert list(body.keys()) == [
        "mediaGenerationContext",
        "clientContext",
        "requests",
        "useV2ModelConfig",
    ]
    assert body["useV2ModelConfig"] is True


def test_an_i2v_model_is_chosen_not_a_reference_one():
    # The two are different model families. An r2v key sent here is refused
    # exactly like the failure this fallback exists to get around, which would
    # be an unusually confusing way to fail.
    key = capture()["body"]["requests"][0]["videoModelKey"]

    assert "i2v" in key
    assert "r2v" not in key


def test_a_missing_start_image_is_refused_before_the_network():
    client = FlowClient()
    result = asyncio.run(client.generate_video_from_image(
        start_image_media_id="", prompt="soup", project_id="P", scene_id="J",
    ))

    assert "error" in result


# ─── When the fallback fires ────────────────────────────────

def test_the_invalid_argument_refusal_is_recognised():
    # The exact body the deployed container recorded.
    assert rejected_the_request({"data": {"error": {
        "code": 400,
        "message": "Request contains an invalid argument.",
        "status": "INVALID_ARGUMENT",
    }}}) is True


def test_a_bare_400_is_a_refusal():
    assert rejected_the_request({"status": 400}) is True


def test_a_rate_limit_is_not_a_refusal():
    # 429 is about when the request was sent, not what was in it. Falling back
    # here would spend a reel's quality on a wait that would have cleared.
    assert rejected_the_request({"status": 429}) is False


def test_a_server_error_is_not_a_refusal():
    assert rejected_the_request({"status": 503}) is False


def test_a_timeout_is_not_a_refusal():
    assert rejected_the_request({"error": "Timeout (300s) waiting for api_request"}) is False


def test_a_disconnected_browser_is_not_a_refusal():
    assert rejected_the_request({"error": "Extension not connected"}) is False
