"""Finding the video model name Flow still accepts, without being told it.

Every reel was failing on INVALID_ARGUMENT -- Flow refusing the request rather
than the images -- and `videoModelKey` is the one field in that body which is a
bare string Google retires on its own schedule. Naming the replacement in a
setting works only while the guess is right, and has to be made again by hand
every time Google moves, so the service walks a list instead.

What these pin down is the order and the remembering, because both are what
decide whether this is worth having:

  * reference video before image video, since reading all four photographs is
    the point of a reel;
  * names Flow Kit says the current endpoint accepts before the ones this
    service was sending when it started being refused;
  * one attempt once something works, because every attempt solves a captcha
    and a run of them is the pattern reCAPTCHA scores badly.
"""
import pytest

from agent import video_models

PORTRAIT = "VIDEO_ASPECT_RATIO_PORTRAIT"


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(video_models, "_STORE", tmp_path / "video_models.json")


def kinds(plan):
    return [kind for kind, _ in plan]


def models(plan):
    return [model for _, model in plan]


def test_reference_video_is_tried_before_image_video():
    # A reel built from one photograph is the fallback, not the intent.
    order = kinds(video_models.plan(PORTRAIT))

    assert order[0] == "r2v"
    assert "i2v" in order
    assert order.index("i2v") > 0


def test_the_names_the_current_endpoint_accepts_come_first():
    """Flow Kit's list for the endpoint Google is migrating to, ahead of ours.

    Ours is the one being refused, so trying it first would spend a captcha
    proving what the failure already said.
    """
    i2v = [m for k, m in video_models.plan(PORTRAIT) if k == "i2v"]

    assert i2v[0] == "veo_3_1_i2v_lite_low_priority"
    assert i2v.index("veo_3_1_i2v_lite_low_priority") < i2v.index("veo_3_1_i2v_s_fast_portrait")


def test_no_name_is_tried_twice():
    plan = models(video_models.plan(PORTRAIT))

    assert len(plan) == len(set(plan))


def test_the_walk_is_capped():
    # Each attempt is a captcha. An unbounded search on a closed endpoint would
    # spend the account's standing to learn something one failure already says.
    assert len(video_models.plan(PORTRAIT)) <= video_models.MAX_ATTEMPTS


def test_a_remembered_name_is_the_only_one_tried():
    video_models.remember(PORTRAIT, "i2v", "veo_3_1_i2v_lite_low_priority")

    assert video_models.plan(PORTRAIT) == [("i2v", "veo_3_1_i2v_lite_low_priority")]


def test_remembering_survives_a_restart():
    # The store is a file on the data volume precisely so a redeploy does not
    # pay the captchas again.
    video_models.remember(PORTRAIT, "r2v", "veo_3_1_r2v_fast_portrait")

    assert video_models.recall(PORTRAIT) == ("r2v", "veo_3_1_r2v_fast_portrait")


def test_a_refused_name_is_forgotten_and_the_walk_resumes():
    """Google retires the remembered one too, eventually."""
    video_models.remember(PORTRAIT, "i2v", "veo_3_1_i2v_lite_low_priority")
    assert len(video_models.plan(PORTRAIT)) == 1

    video_models.forget(PORTRAIT)

    assert len(video_models.plan(PORTRAIT)) > 1
    assert video_models.recall(PORTRAIT) is None


def test_forgetting_something_never_recorded_is_harmless():
    video_models.forget(PORTRAIT)

    assert video_models.recall(PORTRAIT) is None


def test_an_unreadable_store_does_not_break_generation():
    """A corrupt file costs attempts, not the feature."""
    video_models._STORE.write_text("{not json", encoding="utf-8")

    assert video_models.recall(PORTRAIT) is None
    assert len(video_models.plan(PORTRAIT)) > 1


def test_landscape_and_portrait_are_remembered_separately():
    video_models.remember(PORTRAIT, "i2v", "veo_3_1_i2v_lite")

    assert video_models.recall("VIDEO_ASPECT_RATIO_LANDSCAPE") is None


# ─── The batch path's three ─────────────────────────────────

def test_the_access_denial_is_recognised():
    # The exact answer the deployed container recorded.
    assert video_models.access_denied(
        "RpcError: eb1hJf failed: [7, None, [['type.googleapis.com/google.rpc.ErrorInfo', "
        "['PUBLIC_ERROR_MODEL_ACCESS_DENIED']]]]"
    ) is True


def test_other_errors_are_not_access_denials():
    # A captcha failure or a dropped browser is not a reason to try another
    # model, and each step of the walk is a captcha.
    assert video_models.access_denied("CAPTCHA_FAILED: no token") is False
    assert video_models.access_denied("Extension not connected") is False
    assert video_models.access_denied("") is False


def test_running_out_of_credits_is_recognised():
    # Recorded off the deployed container's Flow Kit panel: HTTP 200, and
    # inside it code 8 with this name. Nothing was generated.
    assert video_models.out_of_credits(
        "RpcError: eb1hJf failed: [8, None, [['type.googleapis.com/google.rpc.ErrorInfo', "
        "['PUBLIC_ERROR_USER_QUOTA_REACHED']]]]"
    ) is True


def test_a_model_denial_is_not_running_out_of_credits():
    # The two want opposite responses: a denial moves to the next model, an
    # empty balance stops the job.
    assert video_models.out_of_credits("PUBLIC_ERROR_MODEL_ACCESS_DENIED") is False
    assert video_models.out_of_credits("") is False
