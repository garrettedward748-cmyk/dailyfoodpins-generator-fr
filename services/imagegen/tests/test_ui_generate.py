"""Generating through Flow's composer, and reading the result off the project.

Google's frontend build of 2026-09-22 refuses every captcha-gated RPC the
extension sends -- PUBLIC_ERROR_UNUSUAL_ACTIVITY -- while the same account
generates normally when the button is clicked. So the app is left to send the
call and the picture is found by diffing the project listing, which carries no
captcha and never broke.

What matters and is pinned here: the job gets the image the click made and not
one that was already there, a composer that refuses the prompt fails the job
instead of waiting out the poll, and the answer keeps the shape the worker
already reads so nothing downstream knows which path ran.
"""
import asyncio

import pytest

_REAL_SLEEP = asyncio.sleep

from agent.services.flow_batch import GeneratedImage
from agent.services.flow_client import FlowClient


def image(n: str) -> GeneratedImage:
    return GeneratedImage(media_id=n, url=f"https://flow-content.google/image/{n}?sig=x")


class Fake(FlowClient):
    """A client whose browser is a script: listings in order, submit canned."""

    def __init__(self, listings, submit=None):
        self._listings = list(listings)
        self._submit = submit or {"ok": True, "submitted": True}
        self.submitted: list[tuple[str, str]] = []

    async def project_images(self, project_id: str):
        return self._listings.pop(0) if len(self._listings) > 1 else self._listings[0]

    async def ui_generate_image(self, prompt: str, project_id: str) -> dict:
        self.submitted.append((prompt, project_id))
        return self._submit


def run(client, **kw):
    return asyncio.run(client.generate_images_ui("a bowl of olives", "PROJ-1", **kw))


def test_the_new_image_is_the_one_the_job_gets(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")], [image("old"), image("new")]])

    out = run(client)

    assert client.submitted == [("a bowl of olives", "PROJ-1")]
    media = out["data"]["media"][0]
    assert media["name"] == "new"
    assert media["image"]["generatedImage"]["fifeUrl"].endswith("new?sig=x")
    assert out["status"] == 200


def test_an_image_that_was_already_there_is_not_mistaken_for_ours(monkeypatch):
    # Another job on the same project, or a person in the Flow tab, can land an
    # image between the click and the poll. Taking the newest entry would hand
    # this job someone else's picture, so what is new is what was not there.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("theirs")], [image("theirs")]])

    out = run(client, poll_seconds=0.01)

    assert "error" in out
    assert "no image appeared" in out["error"]


def test_a_composer_that_refuses_the_prompt_fails_at_once(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]], submit={"error": "GENERATE_DISABLED: the composer did not accept the prompt"})

    out = run(client)

    assert "GENERATE_DISABLED" in out["error"]
    # Nothing was generated, so nothing should have been waited for.
    assert "no image appeared" not in out["error"]


def test_a_listing_that_cannot_be_read_is_not_a_generation_failure(monkeypatch):
    # The listing is tens of megabytes and read repeatedly; one bad read while
    # the picture is still rendering must not fail a job that is working.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([
        [image("old")],
        {"error": "batchexecute answered HTTP 500"},
        [image("old"), image("new")],
    ])

    out = run(client)

    assert out["data"]["media"][0]["name"] == "new"


def test_a_listing_that_fails_before_the_click_stops_there(monkeypatch):
    # Without a "before", nothing can be called new, and clicking anyway would
    # generate a picture no one could identify.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([{"error": "Extension not connected"}])

    out = run(client)

    assert out == {"error": "Extension not connected"}
    assert client.submitted == []


def test_the_answer_matches_the_shape_the_old_path_returned(monkeypatch):
    # The worker reads data.media[0].image.generatedImage.fifeUrl and
    # media[0].name. Both paths answer in that shape on purpose.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    out = run(Fake([[], [image("fresh")]]))

    assert set(out) == {"status", "data"}
    assert list(out["data"]["media"][0]["image"]["generatedImage"]) == ["mediaId", "fifeUrl"]


def test_the_composer_path_is_off_by_default():
    """The widget mint is the fix; the composer path is kept for trying by hand."""
    import agent.config as config

    assert config.IMAGE_USE_UI is False
