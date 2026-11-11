#!/bin/bash
# Start Chrome on the active Google account's profile.
#
# agent/accounts.py writes the path of the active profile to
# $FLOW_AGENT_DIR/active-profile-dir; with no pointer (a fresh or older
# volume) it is the original profile, so nothing changes for one account.
# Only one Chrome ever runs: switching account means stop, re-point, start.
set -u

DATA_DIR="${FLOW_AGENT_DIR:-/data}"
# --gemini: Gemini's own browser, beside Flow's. Its own profile, with only the
# Google accounts that write for the platform; Flow's account switches never
# touch it. See agent/gemini_browser.py.
GEMINI=0
if [[ "${1:-}" == "--gemini" ]]; then
    GEMINI=1
    shift
    PROFILE="$DATA_DIR/gemini-profile"
else
    PROFILE="$(cat "$DATA_DIR/active-profile-dir" 2>/dev/null || true)"
    [[ -n "$PROFILE" ]] || PROFILE="${CHROME_PROFILE_DIR:-/data/chrome-profile}"
fi
mkdir -p "$PROFILE"

# Same clean-up the entrypoint does for the first profile: a Chrome killed
# mid-run leaves a lock that makes the next start exit at once, and a
# "crashed" flag that raises a restore bubble over the Flow tab.
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie} 2>/dev/null || true
PREFS="$PROFILE/Default/Preferences"
if [[ -f "$PREFS" ]]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' \
        "$PREFS" 2>/dev/null || true
fi

# Browser caches: Chrome is not running at this point (only one ever runs and
# it is stopped between batches), so nothing is mid-generation. They only make
# pages load faster and grow without limit -- over 20 GB across the generators
# before this. Cleared when they pass 300 MB, every profile at once. Sign-ins
# (Cookies, Local Storage, IndexedDB) are never touched.
#
# "Service Worker/ScriptCache" must never be in this list. It is not a cache of
# web pages: it holds the code of the extensions' background service workers.
# Deleted, Chrome starts with Flow Kit and Gemini Chat registered but not
# running (checked 2026-11-08: 2 workers before, 0 after) -- Flow Kit never
# connects, every image waits out its step timeout, and the watchdog flags the
# browser as needing a human.
CACHE_LIMIT_MB="${CHROME_CACHE_LIMIT_MB:-300}"
CACHE_DIRS=()
# Each browser clears only its own profiles: the other one may be running.
if (( GEMINI )); then SCAN=("$PROFILE"); else SCAN=("$DATA_DIR"/chrome-profile "$DATA_DIR"/chrome-profiles/*); fi
for P in "${SCAN[@]}"; do
    [[ -d "$P" ]] || continue
    for C in Cache "Code Cache" GPUCache GrShaderCache ShaderCache GraphiteDawnCache component_crx_cache; do
        for D in "$P/$C" "$P"/*/"$C"; do [[ -d "$D" ]] && CACHE_DIRS+=("$D"); done
    done
    for D in "$P"/*/"Service Worker/CacheStorage"; do
        [[ -d "$D" ]] && CACHE_DIRS+=("$D")
    done
done
if (( ${#CACHE_DIRS[@]} > 0 )); then
    USED_MB=$(du -scm "${CACHE_DIRS[@]}" 2>/dev/null | tail -1 | cut -f1)
    if (( ${USED_MB:-0} > CACHE_LIMIT_MB )); then
        echo "chrome-launch: clearing ${USED_MB} MB of browser cache"
        rm -rf "${CACHE_DIRS[@]}" 2>/dev/null || true
    fi
fi

# --disk-cache-size caps the HTTP cache of this run at 100 MB.
exec /usr/bin/google-chrome --user-data-dir="$PROFILE" --disk-cache-size=104857600 "$@"
