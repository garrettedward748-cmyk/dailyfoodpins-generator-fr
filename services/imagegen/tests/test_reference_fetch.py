"""An article's picture is fetched for a reel: retried, named, its type kept."""
import asyncio

import httpx

from agent.worker import processor


def serve(monkeypatch, answers):
    calls = []
    real = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        status, body = answers[min(len(calls), len(answers)) - 1]
        if status is None:
            raise httpx.ReadTimeout("")
        return httpx.Response(status, content=body, headers={"content-type": "image/webp"})

    monkeypatch.setattr(processor.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))

    async def no_wait(_):
        return None

    monkeypatch.setattr(processor.asyncio, "sleep", no_wait)
    return calls


def test_a_slow_site_is_asked_again_and_the_picture_keeps_its_type(monkeypatch):
    calls = serve(monkeypatch, [(None, b""), (200, b"x" * 2000)])
    got = asyncio.run(processor.WorkerController()._fetch_reference("https://site/a.webp"))
    assert len(calls) == 2
    assert calls[0].headers["user-agent"].startswith("Mozilla/")
    assert got == {"bytes": b"x" * 2000, "mime": "image/webp"}


def test_the_reason_is_named_when_it_cannot_be_had(monkeypatch):
    serve(monkeypatch, [(None, b"")])
    got = asyncio.run(processor.WorkerController()._fetch_reference("https://site/a.webp"))
    assert "ReadTimeout" in got["error"] and "3 tries" in got["error"]
