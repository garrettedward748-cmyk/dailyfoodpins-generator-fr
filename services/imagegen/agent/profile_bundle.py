"""Move the Google sign-ins from one image service to another.

Each Google account is a Chrome profile directory on this container's disk, so
a platform backup (which only holds the platform's database) never carried the
sign-ins. This packs them, with the account list, into one .tar.gz that can be
downloaded and uploaded to a new service, where the accounts come up as they
were. Browser caches are left out: they are most of a profile's size and are
rebuilt on their own, which keeps the file in the tens of megabytes.

Google ties a session to the browser that made it and sometimes asks for a
check again on a new server or address. That is Google's decision, not
something this can prevent: an account that is asked simply signs in again.
"""
from __future__ import annotations

import json
import logging
import shutil
import tarfile
import tempfile
from pathlib import Path

from agent import accounts

logger = logging.getLogger(__name__)

# Rebuilt by Chrome by itself; the bulk of a profile's weight.
_SKIP_NAMES = {
    "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache",
    "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "CacheStorage", "component_crx_cache",
    "BrowserMetrics", "Safe Browsing", "optimization_guide_model_store", "extensions_crx_cache",
}
# Lock files of a running Chrome: carrying them would make the new one think
# another Chrome still owns the profile.
_SKIP_PREFIXES = ("Singleton", "lockfile", ".org.chromium")


def _skip(path: Path) -> bool:
    return path.name in _SKIP_NAMES or path.name.startswith(_SKIP_PREFIXES)


def _add_profile(tar: tarfile.TarFile, source: Path, arcname: str) -> None:
    if not source.is_dir():
        return
    tar.add(str(source), arcname=arcname, recursive=False)
    for child in sorted(source.iterdir()):
        if _skip(child) or child.is_symlink():
            continue
        if child.is_dir():
            _add_profile(tar, child, f"{arcname}/{child.name}")
        elif child.is_file():
            try:
                tar.add(str(child), arcname=f"{arcname}/{child.name}", recursive=False)
            except OSError as e:
                logger.warning("profile bundle: skipped %s (%s)", child, e)


def export_bundle(dest: Path) -> int:
    """Write the bundle to `dest`; returns how many accounts it holds."""
    state = accounts._load()
    with tarfile.open(dest, "w:gz") as tar:
        payload = json.dumps(state).encode()
        info = tarfile.TarInfo("accounts.json")
        info.size = len(payload)
        import io
        tar.addfile(info, io.BytesIO(payload))
        for account in state["accounts"]:
            _add_profile(tar, accounts._profile_dir(account["id"]), f"profiles/{account['id']}")
    return len(state["accounts"])


def _safe_members(tar: tarfile.TarFile, root: Path) -> list[tarfile.TarInfo]:
    out = []
    for member in tar.getmembers():
        target = (root / member.name).resolve()
        if root.resolve() not in target.parents and target != root.resolve():
            raise ValueError(f"Unsafe path in the file: {member.name}")
        if member.issym() or member.islnk() or member.isdev():
            continue
        out.append(member)
    return out


def import_bundle(src: Path) -> int:
    """Replace the accounts and their sign-ins with what the bundle holds.

    The caller has stopped Chrome. Returns how many accounts came in.
    """
    work = Path(tempfile.mkdtemp(prefix=".profile-import-", dir=str(accounts.STATE_FILE.parent)))
    try:
        try:
            with tarfile.open(src, "r:gz") as tar:
                tar.extractall(work, members=_safe_members(tar, work))
        except (tarfile.TarError, OSError, EOFError) as e:
            raise ValueError(f"Not a readable sign-ins file: {e}")

        try:
            state = json.loads((work / "accounts.json").read_text())
        except (OSError, ValueError):
            raise ValueError("This file is not a sign-ins file (no accounts.json inside).")
        if not isinstance(state, dict) or not state.get("accounts"):
            raise ValueError("The file holds no accounts.")

        ids = [a["id"] for a in state["accounts"]]
        for account_id in ids:
            target = accounts._profile_dir(account_id)
            shutil.rmtree(target, ignore_errors=True)
            source = work / "profiles" / str(account_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.move(str(source), str(target))
            else:
                target.mkdir(parents=True, exist_ok=True)

        # The first account is the one Chrome opens on; nothing is mid-switch.
        state["active"] = ids[0] if state.get("active") not in ids else state["active"]
        state["pending"] = None
        accounts._save(state)
        accounts.ensure_pointer()
        logger.info("profile bundle: %d account(s) imported", len(ids))
        return len(ids)
    finally:
        shutil.rmtree(work, ignore_errors=True)
