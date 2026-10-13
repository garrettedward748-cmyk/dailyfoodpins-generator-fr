# Flow Kit — single image: Xvfb + Chrome + extension + agent + noVNC
#
# Four processes under supervisord. Not systemd: systemd does not run inside a
# container, and Dokploy deploys containers.
#
# Chrome runs with a real (virtual) display rather than --headless. That is not
# an oversight — headless Chrome is trivially fingerprinted, and this whole
# service depends on reCAPTCHA scoring the session as a genuine browser.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99

# ─── System dependencies ─────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget gnupg ca-certificates openssl \
        xvfb x11vnc xdotool \
        novnc websockify \
        supervisor \
        dbus \
        procps \
    && rm -rf /var/lib/apt/lists/*

# ─── Google Chrome ───────────────────────────────────────────
# Same key/repo commands verified working during the VPS viability test.
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ─── Python dependencies ─────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ─── Application ─────────────────────────────────────────────
# The extension ships in this repo, so it arrives with the build context.
# Cloning it from GitHub at build time would add a network failure mode and a
# credential to manage, for no gain.
COPY agent/ /app/agent/
COPY extension/ /app/extension/
COPY tests/ /app/tests/
COPY pytest.ini /app/
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/pack-extension.sh /usr/local/bin/pack-extension.sh
COPY docker/dbus.conf /etc/dbus-1/imagegen.conf
COPY docker/chrome-launch.sh /usr/local/bin/chrome-launch.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/pack-extension.sh /usr/local/bin/chrome-launch.sh

# ─── Pack the extension and install the Chrome policy ────────
# Chrome 151 ignores --load-extension entirely, so the extension is packed
# into a signed CRX here and force-installed through enterprise policy at
# runtime. Failing the build is intentional: an image whose extension never
# loads is useless, and finding that out at deploy time costs far more than
# finding it out here.
RUN /usr/local/bin/pack-extension.sh

# ─── Verify the outgoing request shape ───────────────────────
# The request this service sends to Google has to keep looking like the one
# Flow's own UI sends. Same reasoning as the extension pack above, but worse:
# an image whose payload has drifted does not fail loudly at all — it quietly
# degrades the account's reCAPTCHA score, and nobody finds out until the quota
# stops going as far as it used to.
#
# pytest is uninstalled afterwards so it is not part of the shipped image.
RUN pip install --no-cache-dir pytest pytest-asyncio \
    && FLOW_AGENT_DIR=/tmp PYTHONPATH=/app python -m pytest -q /app/tests \
    && pip uninstall -y -q pytest pytest-asyncio

# ─── Non-root user ───────────────────────────────────────────
# Chrome refuses to run as root without --no-sandbox, and dropping the sandbox
# to work around that would be the wrong trade on a box holding a live Google
# session.
RUN useradd --create-home --shell /bin/bash flowkit \
    && mkdir -p /data/chrome-profile /var/log/supervisor /run/shared /run/dbus \
    && chown -R flowkit:flowkit /app /data /var/log/supervisor /run/shared /run/dbus \
    && chmod -R a+rX /etc/opt/chrome/policies

USER flowkit

ENV FLOW_AGENT_DIR=/data \
    API_HOST=0.0.0.0 \
    API_PORT=8100 \
    WS_HOST=127.0.0.1 \
    WS_PORT=9222 \
    CHROME_PROFILE_DIR=/data/chrome-profile

EXPOSE 8100 6080

# 8100 is the API; 6080 is noVNC. Neither is published to the host or given a
# domain: both are reachable only from the platform container across an
# internal Docker network. Raw VNC (5900) and the extension WebSocket (9222)
# stay bound to loopback and are not reachable even from there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8100/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
