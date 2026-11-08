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

    def __init__(self, listings, submit=None, page_errors=None, page_images=None,
                 page_tiles=None, tile_pictures=None):
        self._ui_lock = None
        self._page_images = list(page_images or [])
        self._page_tiles = list(page_tiles or [])
        self._tile_pictures = dict(tile_pictures or {})
        self.media_lookups: list[str] = []
        self._listings = list(listings)
        self._submit = submit or {"ok": True, "submitted": True}
        self._page_errors = list(page_errors or [])
        self.submitted: list[tuple[str, str]] = []
        self.picks: list[tuple] = []
        self.ignored: list[list[str]] = []

    async def project_images(self, project_id: str):
        return self._listings.pop(0) if len(self._listings) > 1 else self._listings[0]

    async def ui_generate_image(self, prompt: str, project_id: str,
                                model_label=None, aspect_label=None) -> dict:
        self.submitted.append((prompt, project_id))
        self.picks.append((model_label, aspect_label))
        return self._submit

    async def ui_page_state(self):
        shown = self._page_images.pop(0) if self._page_images else []
        tiles = self._page_tiles.pop(0) if len(self._page_tiles) > 1 else (
            self._page_tiles[0] if self._page_tiles else [])
        return {"images": [i.url for i in shown], "tiles": tiles,
                "codes": list(getattr(self, "codes", []))}

    async def get_media_urls_batch(self, media_id: str):
        self.media_lookups.append(media_id)
        return {"image_url": f"https://flow-content.google/image/{media_id}?sig=y"}

    async def _send_ui(self, method, params, timeout=30):
        assert method == "ui_tile_image"
        return self._tile_pictures.get(params["src"], {"error": "gone"})

    async def ui_page_errors(self, project_id: str, ignore: list[str], before=None) -> list[str]:
        self.ignored.append(ignore)
        shown = self._page_errors.pop(0) if self._page_errors else []
        if isinstance(before, dict):
            # `shown` is then a list with one entry per tile showing it.
            return sorted({e for e in shown if shown.count(e) > before.get(e, 0)})
        return [e for e in shown if e not in ignore]


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


def test_the_model_and_shape_reach_the_composer(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[], [image("fresh")]])

    run(client, model_label="Nano Banana 2.1", aspect_label="3:4")

    assert client.picks == [("Nano Banana 2.1", "3:4")]


def test_an_error_flow_shows_fails_the_job_without_waiting_out_the_poll(monkeypatch):
    # A failed generation leaves nothing in the listing. Without reading the
    # page the job would sit for three minutes on a picture that never comes.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]], page_errors=[["We noticed some unusual activity."]])

    out = run(client)

    assert out["error"].startswith("FLOW_UI_ERROR")
    assert "unusual activity" in out["error"]


def test_a_message_already_on_the_page_is_not_this_jobs_error(monkeypatch):
    # An error banner from an earlier attempt can still be showing. It was
    # there before the click, so it is not about this one.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    old = "Something went wrong."
    client = Fake(
        [[image("old")], [image("old")], [image("old"), image("new")]],
        submit={"ok": True, "submitted": True, "pageErrors": [old]},
        page_errors=[[old]],
    )

    out = run(client)

    assert out["data"]["media"][0]["name"] == "new"
    assert client.ignored[0] == [old]



def test_a_picture_flow_shows_counts_when_the_listing_has_not_caught_up(monkeypatch):
    # The pictures were in Flow and the job still timed out: the listing never
    # showed them. The tile on the page is read as well.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake(
        [[image("old")]],
        submit={"ok": True, "submitted": True, "pageImages": ["shown-before"]},
        page_images=[[image("shown-before")], [image("shown-before"), image("tile")]],
    )

    out = run(client)

    assert out["data"]["media"][0]["name"] == "tile"


def test_two_jobs_take_turns_at_the_composer(monkeypatch):
    # Two prompts typed into the one box at once, each job watching for the
    # other's picture, is how a finished picture was never collected.
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    inside = []
    most = []

    class Slow(Fake):
        async def ui_generate_image(self, *a, **kw):
            inside.append(1)
            most.append(len(inside))
            await _REAL_SLEEP(0.01)
            inside.pop()
            return await super().ui_generate_image(*a, **kw)

    client = Slow([[], [image("a")], [image("a")], [image("a"), image("b")]])

    async def both():
        await asyncio.gather(
            client.generate_images_ui("one", "P"), client.generate_images_ui("two", "P"))

    asyncio.run(both())

    assert max(most) == 1


UUID = "0f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4"


def test_a_new_tile_with_an_id_gets_its_signed_link(monkeypatch):
    """Flow can show a picture under an address of its own -- a redirect that
    names the media id -- which neither the listing nor the page's signed links
    carry. The id is looked up for the link the platform can download."""
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    tile = f"https://flow.google.com/fx/api/trpc/media.getMediaUrlRedirect?name={UUID}"
    client = Fake([[image("old")]],
                  submit={"ok": True, "submitted": True, "pageTiles": ["https://x/old-tile"]},
                  page_tiles=[["https://x/old-tile", tile]])

    out = run(client, poll_seconds=30)

    generated = out["data"]["media"][0]["image"]["generatedImage"]
    assert generated["mediaId"] == UUID
    assert generated["fifeUrl"] == f"https://flow-content.google/image/{UUID}?sig=y"


def test_a_new_tile_without_an_address_is_fetched_by_the_page(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]],
                  page_tiles=[["blob:https://flow.google.com/abc"]],
                  tile_pictures={"blob:https://flow.google.com/abc": {"dataUrl": "data:image/png;base64,AAAA"}})

    out = run(client, poll_seconds=30)

    assert out["data"]["media"][0]["image"]["generatedImage"]["fifeUrl"] == "data:image/png;base64,AAAA"


def test_a_tile_that_is_only_a_preview_is_not_the_picture(monkeypatch):
    """After a reload Flow's tiles are previews (286x512); the listing has the picture."""
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    preview = "https://flow.google.com/asb/ANqvLOarsCz471"
    client = Fake([[image("old")], [image("old")], [image("old"), image("full")]],
                  page_tiles=[[preview]],
                  tile_pictures={preview: {"dataUrl": "data:image/jpeg;base64,AAAA",
                                           "width": 286, "height": 512}})

    out = run(client, poll_seconds=30)

    assert out["data"]["media"][0]["name"] == "full"


def test_a_tile_seen_only_once_is_not_taken(monkeypatch):
    """Flow's working spinner can be picture-sized; a tile must stay a poll."""
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]],
                  page_tiles=[["blob:spinner"], []],
                  tile_pictures={"blob:spinner": {"dataUrl": "data:image/png;base64,AAAA"}})

    out = run(client, poll_seconds=12)

    assert "error" in out


def test_composer_answers_are_read_one_level_down():
    """The extension answers these as {"id", "result": {...}}."""
    class Wire(FlowClient):
        def __init__(self):
            pass

        async def _send(self, method, params, timeout=300):
            return {"id": "x", "result": {"images": [image("a").url], "tiles": ["blob:t"]}}

    state = asyncio.run(Wire().ui_page_state())
    assert state["tiles"] == ["blob:t"]
    assert [i.media_id for i in asyncio.run(Wire().ui_page_images())] == ["a"]
