"""The video request Google sees must match the one its own UI sends.

The same argument as test_request_shape.py, for the other half of the surface:
this body was recovered from a working Flow Kit capture, and a request that
drifts from it is rejected with nothing useful to read. The nesting of
textInput, the imageUsageType on every reference, and the empty metadata object
are all load-bearing -- none of them are decoration that can be tidied away.
"""
import asyncio

from agent.config import VIDEO_MODELS, VIDEO_PAYGATE_TIER
from agent.services.flow_client import FlowClient


def capture(**kwargs) -> dict:
    """Run the reference-video call with the transport stubbed."""
    client = FlowClient()
    captured: dict = {}

    async def fake_send(method, params, timeout=300):
        captured.update(params)
        return {}

    client._send = fake_send

    call = dict(
        reference_media_ids=["11111111-1111-1111-1111-111111111111",
                             "22222222-2222-2222-2222-222222222222"],
        prompt="a bowl of soup, slowly steaming",
        project_id="PROJ-1",
    )
    call.update(kwargs)

    asyncio.run(client.generate_video_from_references(**call))
    return captured


def test_url_is_the_reference_images_endpoint():
    assert capture()["url"] == (
        "https://aisandbox-pa.googleapis.com"
        "/v1/video:batchAsyncGenerateVideoReferenceImages"
        "?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
    )


def test_captcha_action_is_requested():
    # Video consumes a captcha exactly as image generation does; without this
    # the extension never solves one and Google answers 403.
    assert capture()["captchaAction"] == "VIDEO_GENERATION"


def test_body_is_the_v2_batch_wrapper():
    body = capture()["body"]
    assert list(body.keys()) == [
        "mediaGenerationContext",
        "clientContext",
        "requests",
        "useV2ModelConfig",
    ]
    assert body["useV2ModelConfig"] is True
    assert len(body["requests"]) == 1


def test_request_carries_exactly_the_captured_fields():
    request = capture()["body"]["requests"][0]
    assert set(request.keys()) == {
        "aspectRatio",
        "seed",
        "textInput",
        "videoModelKey",
        "referenceImages",
        "metadata",
    }
    # Present and empty, not omitted: the captured request sends it.
    assert request["metadata"] == {}


def test_prompt_is_wrapped_in_a_structured_prompt():
    request = capture()["body"]["requests"][0]
    assert request["textInput"] == {
        "structuredPrompt": {"parts": [{"text": "a bowl of soup, slowly steaming"}]}
    }


def test_every_reference_is_tagged_as_an_asset():
    request = capture()["body"]["requests"][0]
    assert request["referenceImages"] == [
        {"mediaId": "11111111-1111-1111-1111-111111111111",
         "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"},
        {"mediaId": "22222222-2222-2222-2222-222222222222",
         "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"},
    ]


def test_model_comes_from_the_table_for_the_configured_tier():
    expected = VIDEO_MODELS[VIDEO_PAYGATE_TIER]["reference_frame_2_video"][
        "VIDEO_ASPECT_RATIO_PORTRAIT"
    ]
    assert capture()["body"]["requests"][0]["videoModelKey"] == expected


def test_an_explicit_model_key_overrides_the_table():
    # How the Omni key reaches Google once it has been captured from the UI:
    # pasted into settings, never by editing models.json.
    request = capture(model_key="omni_1_1_flash")["body"]["requests"][0]
    assert request["videoModelKey"] == "omni_1_1_flash"


def test_portrait_is_the_default_for_reels():
    assert capture()["body"]["requests"][0]["aspectRatio"] == "VIDEO_ASPECT_RATIO_PORTRAIT"


def test_no_references_is_refused_before_it_reaches_google():
    client = FlowClient()

    async def fail(*_args, **_kwargs):
        raise AssertionError("should not have been sent")

    client._send = fail
    result = asyncio.run(
        client.generate_video_from_references(
            reference_media_ids=[], prompt="x", project_id="PROJ-1"
        )
    )
    assert "error" in result
