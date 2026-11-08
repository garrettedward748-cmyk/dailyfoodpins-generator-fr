#!/bin/bash
# Build-time: pack the extension into a signed CRX and write the Chrome policy
# that force-installs it.
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

EXT_SRC=/app/extension
OUT=/app/ext-dist
POLICY_DIR=/etc/opt/chrome/policies/managed

mkdir -p "$OUT" "$POLICY_DIR"

echo "==> Packing extension"
# Runs as root during the image build, so the sandbox has to come off for this
# one invocation. It only reads local files — no web content is involved.
google-chrome \
    --headless \
    --no-sandbox \
    --disable-gpu \
    --no-first-run \
    --user-data-dir=/tmp/pack-profile \
    --pack-extension="$EXT_SRC" \
    --no-message-box 2>&1 | grep -viE "dbus|gpu|xnnpack|gcm/engine" || true

# --pack-extension writes <dir>.crx and <dir>.pem beside the source directory.
[[ -f /app/extension.crx ]] || { echo "ERROR: extension.crx was not produced"; exit 1; }
[[ -f /app/extension.pem ]] || { echo "ERROR: extension.pem was not produced"; exit 1; }

mv /app/extension.crx "$OUT/flowkit.crx"
mv /app/extension.pem "$OUT/flowkit.pem"

echo "==> Deriving extension ID"
openssl rsa -in "$OUT/flowkit.pem" -pubout -outform DER -out /tmp/pub.der 2>/dev/null

# Chrome's extension ID is the first 16 bytes of SHA-256 over the DER public
# key, with each hex digit remapped 0-f -> a-p.
EXT_ID=$(python3 -c "
import hashlib
digest = hashlib.sha256(open('/tmp/pub.der','rb').read()).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
")

[[ ${#EXT_ID} -eq 32 ]] || { echo "ERROR: bad extension id '$EXT_ID'"; exit 1; }
echo "$EXT_ID" > "$OUT/extension_id"
echo "    id = $EXT_ID"

# The version in the update manifest must match the manifest's, or Chrome
# treats the CRX as not-an-upgrade and skips it.
EXT_VERSION=$(python3 -c "
import json
print(json.load(open('$EXT_SRC/manifest.json'))['version'])
")
echo "    version = $EXT_VERSION"

echo "==> Writing update manifest"
cat > "$OUT/update.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${EXT_ID}'>
    <updatecheck codebase='http://127.0.0.1:8100/ext/flowkit.crx' version='${EXT_VERSION}' />
  </app>
</gupdate>
XML

echo "==> Writing Chrome policy"
# ExtensionInstallForcelist installs and pins it; the user cannot remove it.
# ExtensionInstallSources permits a CRX from a non-Web-Store origin.
cat > "$POLICY_DIR/flowkit.json" <<JSON
{
  "ExtensionInstallForcelist": [
    "${EXT_ID};http://127.0.0.1:8100/ext/update.xml"
  ],
  "ExtensionInstallSources": [
    "http://127.0.0.1:8100/*"
  ],
  "ExtensionSettings": {
    "${EXT_ID}": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:8100/ext/update.xml"
    }
  }
}
JSON

rm -rf /tmp/pack-profile /tmp/pub.der
echo "==> Done: $EXT_ID v$EXT_VERSION"
