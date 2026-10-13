"""The request Google sees must keep looking like the one its own UI sends.

This is the test that matters most in this service. Everything else here can be
rewritten; this shape cannot. If it drifts, generation does not fail loudly —
the account quietly slides onto the limited path and nobody finds out until the
quota does not go as far as it used to.

The expected values below were captured from Flow Kit before the video half was
removed, and verified byte-for-byte against it afterwards.
"""
import asyncio
import re

import pytest

from agent.services.flow_client import FlowClient
from agent.services.headers import random_headers


def capture(**kwargs) -> dict:
    """Run generate_images with the transport stubbed, return what it built."""
    client = FlowClient()
    captured: dict = {}

    async def fake_send(method, params, timeout=300):
        captured.update(params)
        return {}

    client._send = fake_send
    asyncio.run(
        client.generate_images(prompt="a bowl of soup", project_id="PROJ-1", **kwargs)
    )
    return captured


def test_url_is_the_batch_generate_images_endpoint():
    assert capture()["url"] == (
        "https://aisandbox-pa.googleapis.com"
        "/v1/projects/PROJ-1/flowMedia:batchGenerateImages"
        "?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
    )


def test_captcha_action_is_requested():
    # Without this the extension never solves a captcha and Google answers 403.
    assert capture()["captchaAction"] == "IMAGE_GENERATION"


def test_body_is_the_batch_wrapper():
    body = capture()["body"]
    assert list(body.keys()) == [
        "clientContext",
        "mediaGenerationContext",
        "useNewMedia",
        "requests",
    ]
    assert body["useNewMedia"] is True
    assert len(body["requests"]) == 1


def test_client_context_matches_the_ui_shape():
    body = capture()["body"]

    # Key order is part of the shape, not an accident of construction.
    assert list(body["clientContext"].keys()) == [
        "recaptchaContext",
        "projectId",
        "tool",
        "sessionId",
    ]
    assert body["clientContext"]["tool"] == "PINHOLE"
    assert body["clientContext"]["projectId"] == "PROJ-1"

    # The UI omits userPaygateTier on this call. Sending it is a tell.
    assert "userPaygateTier" not in body["clientContext"]

    # ";<epoch millis>" — the leading semicolon is real.
    assert re.fullmatch(r";\d{13}", body["clientContext"]["sessionId"])


def test_recaptcha_token_is_left_empty_for_the_extension_to_fill():
    context = capture()["body"]["clientContext"]["recaptchaContext"]
    assert context == {"token": "", "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"}


def test_context_is_repeated_inside_each_request_item():
    # background.js walks both the outer context and every requests[] item when
    # it injects the solved token. A request item without one never gets a
    # token and is rejected.
    body = capture()["body"]
    assert body["requests"][0]["clientContext"]["projectId"] == "PROJ-1"


def test_request_item_fields_and_order():
    assert list(capture()["body"]["requests"][0].keys()) == [
        "clientContext",
        "imageModelName",
        "imageAspectRatio",
        "structuredPrompt",
        "seed",
        "imageInputs",
    ]


def test_model_defaults_to_what_the_ui_sends():
    assert capture()["body"]["requests"][0]["imageModelName"] == "BELUGA"


def test_prompt_is_wrapped_as_a_structured_prompt():
    assert capture()["body"]["requests"][0]["structuredPrompt"] == {
        "parts": [{"text": "a bowl of soup"}]
    }


def test_seed_is_randomised_within_the_observed_range():
    seed = capture()["body"]["requests"][0]["seed"]
    assert isinstance(seed, int)
    assert 1 <= seed <= 999999


@pytest.mark.parametrize(
    "aspect", ["IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_LANDSCAPE"]
)
def test_aspect_ratio_passes_through(aspect):
    assert capture(aspect_ratio=aspect)["body"]["requests"][0]["imageAspectRatio"] == aspect


def test_batch_id_is_a_fresh_uuid_each_call():
    first = capture()["body"]["mediaGenerationContext"]["batchId"]
    second = capture()["body"]["mediaGenerationContext"]["batchId"]
    assert first != second
    assert re.fullmatch(r"[0-9a-f-]{36}", first)


def test_headers_carry_the_full_browser_set():
    # Any one of these missing is a signal that the caller is not a browser.
    assert set(capture()["headers"]) == {
        "accept",
        "accept-language",
        "content-type",
        "origin",
        "priority",
        "referer",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "user-agent",
        "x-browser-channel",
        "x-browser-copyright",
        "x-browser-validation",
        "x-browser-year",
        "x-client-data",
    }


def test_origin_and_referer_claim_labs_google():
    headers = capture()["headers"]
    assert headers["origin"] == "https://labs.google"
    assert headers["referer"] == "https://labs.google/"
    assert headers["content-type"] == "text/plain;charset=UTF-8"


def test_platform_hint_agrees_with_the_user_agent():
    # A Windows user-agent paired with sec-ch-ua-platform "macOS" is an
    # immediate contradiction to anyone checking.
    for _ in range(30):
        headers = random_headers()
        agent, platform = headers["user-agent"], headers["sec-ch-ua-platform"]
        if "Windows" in agent:
            assert platform == '"Windows"'
        elif "Macintosh" in agent:
            assert platform == '"macOS"'
        else:
            assert platform == '"Linux"'
        assert headers["sec-ch-ua-mobile"] == "?0"
