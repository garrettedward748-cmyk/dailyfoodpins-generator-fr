"""Shared defaults for the worker tests.

Image jobs go through Flow's composer now, because Google's frontend build of
2026-09-22 refuses the captcha-gated call the extension used to send. The tests
that predate that change are about the captcha path -- the model walk, the
refusal handling, the name discovery -- so they run with it selected, the way a
deployment would with IMAGE_USE_UI=0. The composer path has its own tests in
test_ui_generate.py.
"""
import pytest

from agent.worker import processor


@pytest.fixture(autouse=True)
def captcha_image_path(monkeypatch):
    monkeypatch.setattr(processor, "IMAGE_USE_UI", False)


@pytest.fixture(autouse=True)
def flow_kit_image_method(request, monkeypatch):
    """The same for the image method: the deployment uses Flow's page only
    (agent/accounts.py image_methods_in_order), but these tests are about the
    Flow Kit path, which stays in the code. Tests of the choice itself
    (test_accounts.py) and of the page path set it themselves."""
    if request.module.__name__.endswith("test_accounts"):
        return
    from agent import accounts
    monkeypatch.setattr(accounts, "image_methods_in_order", lambda: ["flowkit"])


@pytest.fixture(autouse=True)
def captcha_video_path(request, monkeypatch):
    """Clips go through Flow's page in a deployment (VIDEO_USE_UI); the tests
    written before that are about the batch and REST paths, which stay in the
    code, so they run with those. test_video_ui.py tests the page path."""
    if request.module.__name__.endswith("test_video_ui"):
        return
    monkeypatch.setattr(processor, "VIDEO_USE_UI", False)


@pytest.fixture(autouse=True)
def no_gap_between_page_submits(monkeypatch):
    """The gap between prompts on Flow's page is minutes in a deployment and
    nothing in the tests, which send several in a row."""
    from agent.services import flow_client
    monkeypatch.setattr(flow_client, "UI_SUBMIT_GAP_MIN_S", 0.0)
    monkeypatch.setattr(flow_client, "UI_SUBMIT_GAP_MAX_S", 0.0)
