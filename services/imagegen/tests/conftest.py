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
