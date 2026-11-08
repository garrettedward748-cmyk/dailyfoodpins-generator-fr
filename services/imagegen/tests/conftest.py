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
