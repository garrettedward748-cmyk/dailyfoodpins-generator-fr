#!/bin/bash
# Pre-flight checks, then hand off to supervisord.
#
# Everything here fails loudly with an explanation rather than letting the
# container die three layers deep in a Chrome stack trace.

set -euo pipefail

PROFILE_DIR="${CHROME_PROFILE_DIR:-/data/chrome-profile}"

fail() { echo "ERROR: $*" >&2; exit 1; }

# --- The shared API key -------------------------------------
# The platform and this service must agree on a secret. Asking someone to
# invent one and paste it into two places is a setup step that gets skipped or
# mistyped, so generate it here once and let the platform read it: SHARED_DIR
# is a volume both containers mount.
#
# This service is the only writer, which is what keeps two containers starting
# at the same time from racing to create different keys.
#
# Setting API_KEY explicitly still wins -- useful when the two halves are
# deployed separately and cannot share a volume.
SHARED_DIR="${SHARED_SECRET_DIR:-/run/shared}"
SHARED_KEY="$SHARED_DIR/image-api-key"

if [[ -z "${API_KEY:-}" ]]; then
    if [[ -d "$SHARED_DIR" ]] && [[ -w "$SHARED_DIR" ]]; then
        if [[ ! -s "$SHARED_KEY" ]]; then
            openssl rand -hex 32 > "$SHARED_KEY" ||
                fail "could not write the shared API key at $SHARED_KEY"
            # 0644, not 0600: the two containers run as different users, and
            # the file has to be readable from the platform's side. The volume
            # is mounted by nothing else, so the mode is not what protects it.
            chmod 644 "$SHARED_KEY"
            echo "imagegen: generated a shared API key at $SHARED_KEY"
        fi
        API_KEY="$(cat "$SHARED_KEY")"
        export API_KEY
    else
        fail "API_KEY is not set and $SHARED_DIR is not writable.

This service generates an image on request, which spends Google Flow credits.
Without a key, anything that reaches this port can spend them.

Either mount a shared volume at $SHARED_DIR (see docker-compose.yml), or set
API_KEY yourself. Generate one with:
    openssl rand -hex 32"
    fi
fi

# ─── Writable state ─────────────────────────────────────────
# Docker gives a fresh named volume the ownership of the image's directory, so
# this normally passes. It fails when a volume was created by an older image
# or pre-made as root — worth catching explicitly, because the symptom
# otherwise is Chrome exiting with no useful message.
mkdir -p "$PROFILE_DIR" 2>/dev/null || true
[[ -w "$PROFILE_DIR" ]] || fail "Chrome profile directory is not writable: $PROFILE_DIR
The mounted volume is owned by another user. Recreate it, or run:
    docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data"
[[ -w "${FLOW_AGENT_DIR:-/data}" ]] || fail "Data directory is not writable: ${FLOW_AGENT_DIR:-/data}"

# ─── Stale Chrome locks ─────────────────────────────────────
# A container stop kills Chrome without letting it clean up, leaving
# SingletonLock behind. On restart Chrome sees it, assumes another instance
# owns the profile, and exits immediately — supervisord then restarts it into
# the same wall until it gives up. Clearing these is what makes a persistent
# profile survive restarts.
rm -f "$PROFILE_DIR"/Singleton{Lock,Socket,Cookie} 2>/dev/null || true

# Chrome also refuses to start if it thinks it exited uncleanly, and shows a
# "restore pages?" bubble that can steal focus from the Flow tab.
PREFS="$PROFILE_DIR/Default/Preferences"
if [[ -f "$PREFS" ]]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' \
        "$PREFS" 2>/dev/null || true
fi

# --- The browser view ---------------------------------------
# No VNC password. x11vnc listens on loopback and websockify is reachable only
# from the platform container on an internal Docker network -- there is no
# public route to this port at all. The platform proxies it at /browser behind
# the session cookie it already checks, so the browser view is protected by the
# same login as everything else.
#
# Adding a second, 8-character password on top of that would be theatre: it was
# only ever there because this port used to have its own public domain.

# --- A bus for Chrome ---------------------------------------
# Without one, Chrome logs a dbus ERROR line for every service it cannot find
# -- power, screensaver, network monitor -- dozens per start and again on every
# restart. The noise is harmless in itself; what it costs is the ability to see
# a real failure in the log next to it.
if [[ -S /run/dbus/system_bus_socket ]]; then
    echo "imagegen: reusing the existing dbus socket"
elif command -v dbus-daemon >/dev/null 2>&1; then
    if dbus-daemon --config-file=/etc/dbus-1/imagegen.conf --fork; then
        echo "imagegen: dbus started"
    else
        echo "imagegen: dbus did not start; Chrome will log about it, which is harmless"
    fi
fi
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"

if [[ -d "$PROFILE_DIR/Default" ]]; then
    echo "imagegen: existing Chrome profile found - Google session should persist."
else
    echo "imagegen: no Chrome profile yet - sign in once through the platform's Browser page."
fi

exec "$@"
