#!/bin/bash
# Start Chrome on the active Google account's profile.
#
# agent/accounts.py writes the path of the active profile to
# $FLOW_AGENT_DIR/active-profile-dir; with no pointer (a fresh or older
# volume) it is the original profile, so nothing changes for one account.
# Only one Chrome ever runs: switching account means stop, re-point, start.
set -u

DATA_DIR="${FLOW_AGENT_DIR:-/data}"
PROFILE="$(cat "$DATA_DIR/active-profile-dir" 2>/dev/null || true)"
[[ -n "$PROFILE" ]] || PROFILE="${CHROME_PROFILE_DIR:-/data/chrome-profile}"
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

exec /usr/bin/google-chrome --user-data-dir="$PROFILE" "$@"
