# Word timings for reel captions: faster-whisper on the CPU.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 WHISPER_MODEL=base
# faster-whisper 1.1.1 imports requests, which huggingface_hub 1.x no longer pulls in.
RUN pip install --no-cache-dir faster-whisper==1.1.1 requests "huggingface_hub<1.0"
# Bake the model in, so the first reel does not wait on a download.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8', download_root='/models')"
COPY server.py ./
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/health', timeout=4)"
CMD ["python", "server.py"]
