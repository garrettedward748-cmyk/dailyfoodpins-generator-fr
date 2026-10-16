"""The Google sign-ins, packed for another server and unpacked there."""
import tarfile

import pytest

from agent import accounts, profile_bundle


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "STATE_FILE", tmp_path / "accounts.json")
    monkeypatch.setattr(accounts, "ACTIVE_POINTER", tmp_path / "active-profile-dir")
    monkeypatch.setattr(accounts, "EXTRA_PROFILES", tmp_path / "chrome-profiles")
    monkeypatch.setattr(accounts, "FIRST_PROFILE", tmp_path / "chrome-profile")
    yield tmp_path


def test_round_trip_keeps_accounts_and_sign_ins_and_drops_caches(isolated, tmp_path):
    second = accounts.add("Second")
    accounts.set_project(second["id"], "proj-2")
    (isolated / "chrome-profile" / "Default").mkdir(parents=True)
    (isolated / "chrome-profile" / "Default" / "Cookies").write_text("c1")
    (isolated / "chrome-profile" / "Default" / "Cache").mkdir()
    (isolated / "chrome-profile" / "Default" / "Cache" / "big").write_text("x" * 100)
    (isolated / "chrome-profile" / "SingletonLock").write_text("lock")
    (isolated / "chrome-profiles" / "2" / "Cookies").write_text("c2")

    bundle = tmp_path / "b.tar.gz"
    assert profile_bundle.export_bundle(bundle) == 2
    names = tarfile.open(bundle).getnames()
    assert "profiles/1/Default/Cookies" in names
    assert not any("Cache" in n or "SingletonLock" in n for n in names)

    # a blank service
    import shutil
    shutil.rmtree(isolated / "chrome-profile")
    shutil.rmtree(isolated / "chrome-profiles")
    (isolated / "accounts.json").unlink()

    assert profile_bundle.import_bundle(bundle) == 2
    data = accounts.list_accounts()
    assert [a["label"] for a in data["accounts"]] == ["Account 1", "Second"]
    assert data["accounts"][1]["project_id"] == "proj-2"
    assert (isolated / "chrome-profile" / "Default" / "Cookies").read_text() == "c1"
    assert (isolated / "chrome-profiles" / "2" / "Cookies").read_text() == "c2"


def test_a_file_that_is_not_a_bundle_is_refused(isolated, tmp_path):
    bad = tmp_path / "bad.tar.gz"
    bad.write_bytes(b"not a tarball")
    with pytest.raises(ValueError):
        profile_bundle.import_bundle(bad)
    empty = tmp_path / "empty.tar.gz"
    with tarfile.open(empty, "w:gz"):
        pass
    with pytest.raises(ValueError):
        profile_bundle.import_bundle(empty)


def test_a_path_escaping_the_folder_is_refused(isolated, tmp_path):
    evil = tmp_path / "evil.tar.gz"
    payload = tmp_path / "x"
    payload.write_text("x")
    with tarfile.open(evil, "w:gz") as tar:
        tar.add(str(payload), arcname="../escaped")
    with pytest.raises(ValueError):
        profile_bundle.import_bundle(evil)
