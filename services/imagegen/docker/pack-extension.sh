#!/bin/bash
# Build-time: pack the extensions into signed CRXs and write the Chrome policy
# that force-installs them.
#
# Why not --load-extension: Chrome removed it. Verified on 151.0.7922.173 —
# the flag is accepted, the extension validates cleanly (chrome
# --pack-extension exits 0), and Chrome simply does not load it. No warning is
# printed. --disable-extensions-except and
# --disable-features=DisableLoadExtensionCommandLineSwitch both fail to bring
# it back, because the capability is gone rather than gated.
#
# Force-install through enterprise policy is the supported path for managed
# Chrome deployments. It needs a signed CRX and an update manifest, both of
# which this script produces and the agent serves over loopback.

set -euo pipefail

# Two extensions ship in this image and are packed the same way:
#   Flow Kit     (EXT_SRC)     makes the pictures in Google Flow
#   Gemini Chat  (GEMINI_SRC)  answers the platform's Gemini prompts in Gemini's own page
#   Flow Batch   (FLOWBATCH_SRC) makes images by driving Flow's page, when chosen
# Each path is overridable so the script can be checked outside a container.
EXT_SRC=${EXT_SRC:-/app/extension}
GEMINI_SRC=${GEMINI_SRC:-/app/gemini-extension}
FLOWBATCH_SRC=${FLOWBATCH_SRC:-/app/flowbatch-extension}
OUT=${OUT:-/app/ext-dist}
POLICY_DIR=${POLICY_DIR:-/etc/opt/chrome/policies/managed}
CHROME_BIN=${CHROME_BIN:-google-chrome}

mkdir -p "$OUT" "$POLICY_DIR"

# pack <source dir> <name>: writes $OUT/<name>.crx and .pem, prints "<id> <version>".
pack() {
    local src="$1" name="$2"
    echo "==> Packing $name from $src" >&2
    # Runs as root during the image build, so the sandbox has to come off for this
    # one invocation. It only reads local files — no web content is involved.
    "$CHROME_BIN" \
        --headless \
        --no-sandbox \
        --disable-gpu \
        --no-first-run \
        --user-data-dir=/tmp/pack-profile \
        --pack-extension="$src" \
        --no-message-box 2>&1 | grep -viE "dbus|gpu|xnnpack|gcm/engine" >&2 || true

    # --pack-extension writes <dir>.crx and <dir>.pem beside the source directory.
    [[ -f "$src.crx" ]] || { echo "ERROR: $src.crx was not produced" >&2; exit 1; }
    [[ -f "$src.pem" ]] || { echo "ERROR: $src.pem was not produced" >&2; exit 1; }
    mv "$src.crx" "$OUT/$name.crx"
    mv "$src.pem" "$OUT/$name.pem"

    # Chrome's extension ID is the first 16 bytes of SHA-256 over the DER public
    # key, with each hex digit remapped 0-f -> a-p.
    openssl rsa -in "$OUT/$name.pem" -pubout -outform DER -out /tmp/pub.der 2>/dev/null
    local id
    id=$(python3 -c "
import hashlib
digest = hashlib.sha256(open('/tmp/pub.der','rb').read()).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
")
    [[ ${#id} -eq 32 ]] || { echo "ERROR: bad extension id '$id' for $name" >&2; exit 1; }

    # The version in the update manifest must match the manifest's, or Chrome
    # treats the CRX as not-an-upgrade and skips it.
    local version
    version=$(python3 -c "
import json
print(json.load(open('$src/manifest.json'))['version'])
")
    echo "    $name id = $id, version = $version" >&2
    echo "$id $version"
}

read -r EXT_ID EXT_VERSION < <(pack "$EXT_SRC" flowkit)
read -r GEMINI_ID GEMINI_VERSION < <(pack "$GEMINI_SRC" gemini)
read -r FLOWBATCH_ID FLOWBATCH_VERSION < <(pack "$FLOWBATCH_SRC" flowbatch)
# A failure inside pack() only ends its own subshell, so check what came back.
[[ -n "${EXT_ID:-}" && -n "${GEMINI_ID:-}" && -n "${FLOWBATCH_ID:-}" ]] || { echo "ERROR: an extension did not pack"; exit 1; }
echo "$EXT_ID" > "$OUT/extension_id"
echo "$GEMINI_ID" > "$OUT/gemini_extension_id"
echo "$FLOWBATCH_ID" > "$OUT/flowbatch_extension_id"

echo "==> Writing update manifest"
# One manifest names both: Chrome looks up each extension by its appid.
cat > "$OUT/update.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${EXT_ID}'>
    <updatecheck codebase='http://127.0.0.1:8100/ext/flowkit.crx' version='${EXT_VERSION}' />
  </app>
  <app appid='${GEMINI_ID}'>
    <updatecheck codebase='http://127.0.0.1:8100/ext/gemini.crx' version='${GEMINI_VERSION}' />
  </app>
  <app appid='${FLOWBATCH_ID}'>
    <updatecheck codebase='http://127.0.0.1:8100/ext/flowbatch.crx' version='${FLOWBATCH_VERSION}' />
  </app>
</gupdate>
XML

echo "==> Writing Chrome policy"
# ExtensionInstallForcelist installs and pins them; the user cannot remove them.
# ExtensionInstallSources permits a CRX from a non-Web-Store origin.
# One file for both: list and dictionary policies set in two files are not merged.
cat > "$POLICY_DIR/flowkit.json" <<JSON
{
  "ExtensionInstallForcelist": [
    "${EXT_ID};http://127.0.0.1:8100/ext/update.xml",
    "${GEMINI_ID};http://127.0.0.1:8100/ext/update.xml",
    "${FLOWBATCH_ID};http://127.0.0.1:8100/ext/update.xml"
  ],
  "ExtensionInstallSources": [
    "http://127.0.0.1:8100/*"
  ],
  "ExtensionSettings": {
    "${EXT_ID}": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:8100/ext/update.xml"
    },
    "${GEMINI_ID}": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:8100/ext/update.xml"
    },
    "${FLOWBATCH_ID}": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:8100/ext/update.xml"
    }
  }
}
JSON

rm -rf /tmp/pack-profile /tmp/pub.der
echo "==> Done: Flow Kit $EXT_ID v$EXT_VERSION, Gemini Chat $GEMINI_ID v$GEMINI_VERSION, Flow Batch $FLOWBATCH_ID v$FLOWBATCH_VERSION"
