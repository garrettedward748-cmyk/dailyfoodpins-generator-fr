"""Several Google accounts, one browser, rotated when the active one runs dry."""
import asyncio

import pytest

from agent import accounts, chrome


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "STATE_FILE", tmp_path / "accounts.json")
    monkeypatch.setattr(accounts, "ACTIVE_POINTER", tmp_path / "active-profile-dir")
    monkeypatch.setattr(accounts, "EXTRA_PROFILES", tmp_path / "chrome-profiles")
    monkeypatch.setattr(accounts, "FIRST_PROFILE", tmp_path / "chrome-profile")
    yield tmp_path


def signed_in(n: int) -> None:
    """n accounts, all ready to use, each with its Flow project."""
    for _ in range(n - 1):
        new = accounts.add("")
        accounts.mark_ok(new["id"])
        accounts.set_project(new["id"], f"project-{new['id']}")


def test_one_account_is_the_original_profile(isolated):
    data = accounts.list_accounts()
    assert data["active"] == 1
    assert data["accounts"][0]["profile"] == str(isolated / "chrome-profile")


def test_a_new_account_waits_for_a_sign_in(isolated):
    new = accounts.add("Second")
    assert new["status"] == "signed_out"
    assert (isolated / "chrome-profiles" / "2").is_dir()


def test_out_of_credits_rests_the_account_and_queues_the_next(isolated):
    signed_in(3)
    assert accounts.rotate("This Google account has no video credits left") == 2
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[1]["status"] == "cooldown"
    assert accounts.switch_pending() == 2
    # The switch takes effect only when applied, with Chrome down.
    assert accounts.active_id() == 1
    assert accounts.apply_pending_switch() == 2
    assert accounts.active_id() == 2
    assert (isolated / "active-profile-dir").read_text() == str(isolated / "chrome-profiles" / "2")


def test_rotation_skips_resting_and_signed_out_accounts(isolated):
    signed_in(3)
    accounts.rotate("quota exhausted")           # 1 rests, go to 2
    accounts.apply_pending_switch()
    accounts.rotate("SESSION_EXPIRED")           # 2 signed out, go to 3
    accounts.apply_pending_switch()
    assert accounts.active_id() == 3
    assert accounts.rotate("quota exhausted") is None  # 1 resting, 2 signed out
    listed = {a["id"]: a["status"] for a in accounts.list_accounts()["accounts"]}
    assert listed == {1: "cooldown", 2: "signed_out", 3: "cooldown"}


def test_a_rest_ends_on_its_own(isolated, monkeypatch):
    signed_in(2)
    accounts.rotate("quota")
    later = accounts._now() + accounts.COOLDOWN_H * 3600 + 1
    monkeypatch.setattr(accounts, "_now", lambda: later)
    assert {a["id"]: a["status"] for a in accounts.list_accounts()["accounts"]}[1] == "ok"


def test_with_one_account_nothing_changes(isolated):
    assert accounts.rotate("quota exhausted") is None
    assert accounts.switch_pending() is None
    assert accounts.active_id() == 1


def test_the_active_account_cannot_be_removed(isolated):
    signed_in(2)
    with pytest.raises(ValueError):
        accounts.remove(1)
    accounts.remove(2)
    assert accounts.count() == 1


def test_chrome_switches_only_when_no_job_holds_it(isolated, monkeypatch):
    signed_in(2)
    calls = []

    async def fake_supervisor(action):
        calls.append(action)
        return True

    monkeypatch.setattr(chrome, "_supervisor", fake_supervisor)
    monkeypatch.setattr(chrome, "_wanted_running", True)
    monkeypatch.setattr(chrome, "_users", 1)
    accounts.rotate("quota")

    assert asyncio.run(chrome.switch_account_if_pending()) is False  # a job is running
    assert accounts.active_id() == 1

    monkeypatch.setattr(chrome, "_users", 0)
    assert asyncio.run(chrome.switch_account_if_pending()) is True
    assert calls == ["stop"]
    assert accounts.active_id() == 2


def test_each_account_has_its_own_project(isolated):
    new = accounts.add("")
    accounts.mark_ok(new["id"])
    accounts.set_project(1, "p-one")
    accounts.set_project(2, "https://labs.google/fx/tools/flow/project/p-two?x=1")
    assert accounts.active_project() == "p-one"
    accounts.rotate("quota")
    accounts.apply_pending_switch()
    assert accounts.active_project() == "p-two"


def test_an_account_without_a_project_is_skipped(isolated):
    new = accounts.add("")
    accounts.mark_ok(new["id"])             # signed in, but no project yet
    assert accounts.rotate("quota") is None
    accounts.set_project(2, "p-two")
    accounts.mark_ok(1)
    assert accounts.rotate("quota") == 2


def test_a_credit_limit_moves_on_before_google_refuses(isolated):
    signed_in(2)
    accounts.set_clip_cost(20)
    accounts.set_limits(1, daily=None, monthly=50)
    assert accounts.active_affords_clip()
    accounts.record_clip()
    accounts.record_clip()                       # 40 of 50 used
    assert not accounts.active_affords_clip()    # a third clip would pass 50
    assert accounts.rotate(accounts.LIMIT_MARKER) == 2
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[1]["status"] == "cooldown" and listed[1]["used_month"] == 40
    assert listed[1]["until"] > accounts._now() + 86400 * 0  # rests until the month turns


def test_no_limit_means_never_counted_against(isolated):
    accounts.set_clip_cost(20)
    accounts.record_clip()
    accounts.record_clip()
    assert accounts.active_affords_clip()
    accounts.set_limits(1, daily=30, monthly=None)
    assert not accounts.active_affords_clip()    # 40 used today
    accounts.set_limits(1, daily=None, monthly=None)
    assert accounts.active_affords_clip()


def test_two_unusual_activity_answers_move_on(isolated):
    signed_in(2)
    assert accounts.note_unusual_activity() is False
    assert accounts.note_unusual_activity() is True
    assert accounts.rotate("PUBLIC_ERROR_UNUSUAL_ACTIVITY") == 2
    assert {a["id"]: a["status"] for a in accounts.list_accounts()["accounts"]}[1] == "cooldown"


def test_any_account_but_the_last_can_be_removed(isolated):
    signed_in(2)
    accounts.use(2)
    accounts.apply_pending_switch()
    accounts.remove(1)                            # the original one too
    with pytest.raises(ValueError):
        accounts.remove(2)                        # the last one stays


def test_reset_by_hand_ends_the_rest_and_restarts_today(isolated):
    signed_in(2)
    accounts.set_clip_cost(20)
    accounts.set_limits(1, daily=50, monthly=None)
    accounts.record_clip()
    accounts.record_clip()                       # 40 of 50 today
    accounts.rotate(accounts.LIMIT_MARKER)
    accounts.reset(1)
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[1]["status"] == "ok" and listed[1]["until"] is None
    assert listed[1]["used_today"] == 0 and listed[1]["used_month"] == 40


def test_reset_does_not_sign_an_account_in(isolated):
    new = accounts.add("x")
    accounts.reset(new["id"])
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[new["id"]]["status"] == "signed_out"


def test_the_rest_after_unusual_activity_is_set_from_the_platform(isolated):
    signed_in(2)
    accounts.set_unusual_rest(30)
    before = accounts._now()
    accounts.rotate("PUBLIC_ERROR_UNUSUAL_ACTIVITY")
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert before + 29 * 60 < listed[1]["until"] < before + 31 * 60


# ─── Images vs video, set per account ────────────────────────

def test_a_new_account_may_make_both_images_and_video_by_default(isolated):
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[1]["images"] is True
    assert listed[1]["video"] is True
    assert accounts.active_kinds() == {"image", "video"}


def test_setting_an_account_to_images_only_is_reflected_everywhere(isolated):
    accounts.set_capabilities(1, images=True, video=False)
    listed = {a["id"]: a for a in accounts.list_accounts()["accounts"]}
    assert listed[1]["images"] is True
    assert listed[1]["video"] is False
    assert accounts.active_kinds() == {"image"}


def test_ensure_active_can_is_ok_when_the_account_is_ticked_for_the_kind(isolated):
    assert accounts.ensure_active_can("video") == "ok"
    assert accounts.switch_pending() is None


def test_video_on_an_images_only_account_switches_to_a_video_account(isolated):
    signed_in(2)
    accounts.set_capabilities(1, images=True, video=False)   # active #1: images only
    accounts.set_capabilities(2, images=True, video=True)    # #2 can do video
    assert accounts.ensure_active_can("video") == "switching"
    assert accounts.switch_pending() == 2
    # images still run on the current account without a switch
    assert accounts.ensure_active_can("image") in ("ok", "switching")


def test_video_with_no_video_account_anywhere_is_none_capable(isolated):
    signed_in(2)
    accounts.set_capabilities(1, images=True, video=False)
    accounts.set_capabilities(2, images=True, video=False)
    assert accounts.ensure_active_can("video") == "none_capable"
    assert accounts.switch_pending() is None


def test_video_when_the_only_video_account_is_resting_waits_rather_than_failing(isolated):
    signed_in(2)
    accounts.use(2); accounts.apply_pending_switch()          # active = 2
    accounts.set_capabilities(2, images=True, video=True)
    accounts.rotate("out of credits")                         # rests #2, switch to #1
    accounts.apply_pending_switch()                           # active = 1
    accounts.set_capabilities(1, images=True, video=False)    # active #1: images only
    assert accounts.ensure_active_can("video") == "all_busy"
    assert accounts.switch_pending() is None


def test_a_limit_rest_ends_when_the_limit_is_raised_or_the_count_is_under_it(isolated):
    import time as _t
    new = accounts.add("")
    accounts.mark_ok(new["id"])
    accounts.set_project(new["id"], "p")
    accounts.set_clip_cost(20)
    accounts.set_limits(new["id"], 60, None)
    data = accounts._load()
    acct = next(a for a in data["accounts"] if a["id"] == new["id"])
    acct["spend"] = [[_t.time(), 60]]
    acct.update(status="cooldown", until=_t.time() + 4 * 3600, reason="Reached the credit limit set for it")
    accounts._save(data)
    # Still at the limit: the rest stands.
    assert next(a for a in accounts.list_accounts()["accounts"] if a["id"] == new["id"])["status"] == "cooldown"
    # Written behind the page's back (a raised limit in the file): it ends on the next read.
    data = accounts._load()
    next(a for a in data["accounts"] if a["id"] == new["id"])["daily_limit"] = 90
    accounts._save(data)
    assert next(a for a in accounts.list_accounts()["accounts"] if a["id"] == new["id"])["status"] == "ok"


def test_a_clip_cost_of_zero_counts_nothing_and_no_limit_stops_work(isolated):
    assert accounts.DEFAULT_CLIP_COST == 0
    accounts.set_limits(1, daily=50, monthly=50)
    accounts.record_clip()
    accounts.record_clip()
    accounts.record_clip()
    assert accounts.active_affords_clip()
    listed = next(a for a in accounts.list_accounts()["accounts"] if a["id"] == 1)
    assert listed["used_today"] == 0


def test_setting_the_cost_to_zero_ends_limit_rests(isolated):
    import time as _t
    new = accounts.add("")
    accounts.mark_ok(new["id"])
    accounts.set_project(new["id"], "p")
    accounts.set_clip_cost(10000)
    accounts.set_limits(new["id"], 105, None)
    data = accounts._load()
    acct = next(a for a in data["accounts"] if a["id"] == new["id"])
    acct.update(status="cooldown", until=_t.time() + 3 * 3600, reason="Reached the credit limit set for it")
    accounts._save(data)
    assert next(a for a in accounts.list_accounts()["accounts"] if a["id"] == new["id"])["status"] == "cooldown"
    accounts.set_clip_cost(0)
    assert next(a for a in accounts.list_accounts()["accounts"] if a["id"] == new["id"])["status"] == "ok"


def test_new_account_without_flow_reads_as_not_set_up(isolated):
    assert accounts.active_has_worked() is False
    accounts.rotate(f"{accounts.FLOW_SETUP_MARKER}: NO_AT_TOKEN")
    acc = next(a for a in accounts.list_accounts()["accounts"] if a["id"] == 1)
    assert acc["status"] == "signed_out"
    assert "Flow is not set up" in acc["reason"]


def test_an_account_that_worked_once_is_remembered(isolated):
    accounts.note_success()
    assert accounts.active_has_worked() is True
