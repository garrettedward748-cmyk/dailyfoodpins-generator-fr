"""
Word timings for reel captions.

One endpoint: POST /words?lang=en with the audio (or the whole video) as the
body. Answers {"words": [{"w": "Did", "start": 0.12, "end": 0.31}, ...]}.

faster-whisper on the CPU, int8. The model is baked into the image at build
time, so the first reel does not wait on a download. Nothing is stored: the
upload is written to a temp file, transcribed, and deleted.
"""
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import av
import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
MAX_BYTES = 80 * 1024 * 1024

model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root="/models")
# One transcription at a time: two at once on a shared VPS only makes both slow.
lock = threading.Lock()


def audio_of(path: str) -> np.ndarray:
    """
    The sound as 16 kHz mono float32, decoded here rather than by faster-whisper:
    its own decoder passes an argument PyAV 15 and later no longer accept.
    """
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks: list[np.ndarray] = []
    with av.open(path, mode="r") as container:
        if not container.streams.audio:
            return np.zeros(0, dtype=np.float32)
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def words_for(path: str, lang: str | None) -> list[dict]:
    audio = audio_of(path)
    if audio.size == 0:
        return []
    with lock:
        segments, _ = model.transcribe(
            audio, language=lang or None, word_timestamps=True, vad_filter=True, beam_size=1
        )
        out = []
        for seg in segments:
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    out.append({"w": text, "start": round(w.start, 3), "end": round(w.end, 3)})
        return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_NAME})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/words":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._send(400, {"error": "send the audio as the request body (at most 80 MB)"})
        lang = (parse_qs(url.query).get("lang") or [""])[0][:5] or None
        fd, path = tempfile.mkstemp(suffix=".media")
        try:
            with os.fdopen(fd, "wb") as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            self._send(200, {"words": words_for(path, lang)})
        except Exception as err:  # the platform falls back to no captions
            self._send(500, {"error": str(err)})
        finally:
            os.unlink(path)

    def log_message(self, fmt: str, *args) -> None:
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8200"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
