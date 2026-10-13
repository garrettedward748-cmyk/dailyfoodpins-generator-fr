"""The ingredients-to-video request, pinned to the captures of 2026-09-16.

Flow's UI sent this when a character, a voice and a dish image were handed
over as ingredients with a spoken line in the prompt:

  rpcid MZZa6b, model abra_r2v_10s, aspect 1 (portrait),
  slot 1  [[null, <image media id>, null, null, null, <full-frame crop>]]  the images
  slot 7  [[<voice media id>]]                                             the voice
  slot 9  [[<character media id>]]                                         the character

Three separate slots. Everything here is what makes a clip carry the
presenter and their voice. Drift is not a failure Google reports; it is a
clip with nobody in it.
"""
import json

import pytest

from agent.services import flow_batch as fb

PROMPT = 'She lifts the spoon and says: "Full recipe in the comments."'
PROJECT = "559dd649-1000-4947-aaa5-e08ae6515705"
CHARACTER = "f346cb5a-ec29-4143-a87d-b13d70729bf5"
VOICE = "509a1ad4-e08a-4a9d-87ba-afc4af20a0c1"
IMAGE = "1e9401b2-f0f5-40a2-a7db-a559744bdfe7"


def inner_of(freq: str):
    outer = json.loads(freq)
    assert outer[0][0][0] == fb.RPC_GEN_REEL
    return json.loads(outer[0][0][1])


def test_the_reel_rpc_is_the_one_the_ui_sends():
    assert fb.RPC_GEN_REEL == "MZZa6b"
    assert fb.REEL_MODEL == "abra_r2v_10s"


def test_the_request_matches_the_capture_slot_for_slot():
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE], CHARACTER, VOICE,
                                     aspect="VIDEO_ASPECT_RATIO_PORTRAIT"))
    item = inner[0][0]
    assert item[0] == [None, None, [[[PROMPT]]]]
    assert item[1] == [[None, IMAGE, None, None, None, fb.REEL_IMAGE_CROP]]
    assert item[2] == "abra_r2v_10s"
    assert item[3] == fb.VIDEO_ASPECT_PORTRAIT == 1
    assert item[4] is None
    assert item[5][:4] == [None, None, None, None]
    assert all(len(u) == 36 and u == u.upper() for u in item[5][4:6])
    assert item[6] is None
    assert item[7] == [[VOICE]]
    assert item[8] is None
    assert item[9] == [[CHARACTER]]
    assert inner[1][5] == PROJECT
    assert inner[1][10] == [fb.CAPTCHA_SLOT, 1]
    assert inner[2][1] == 2


def test_the_crop_is_the_full_frame_the_ui_sends():
    assert fb.REEL_IMAGE_CROP == [0.003875968992248069, None, 0.9961240310077519, 1]


def test_several_images_each_take_their_own_entry():
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE, "b" * 36], CHARACTER, VOICE))
    assert [e[1] for e in inner[0][0][1]] == [IMAGE, "b" * 36]


def test_no_presenter_sends_the_current_ui_shape():
    # Upstream's live capture of 2026-09-23: images as [null, id], no crop,
    # nothing after the client ids.
    inner = inner_of(fb.reel_request(PROMPT, PROJECT, [IMAGE, "b" * 36], None, None))
    item = inner[0][0]
    assert item[0] == [None, None, [[[PROMPT]]]]
    assert item[1] == [[None, IMAGE], [None, "b" * 36]]
    assert item[2] == "abra_r2v_10s"
    assert item[4] is None
    assert len(item) == 6
    assert inner[1][10] == [fb.CAPTCHA_SLOT, 1]
    assert inner[2][1] == 2


def test_a_request_needs_at_least_one_image():
    with pytest.raises(ValueError):
        fb.reel_request(PROMPT, PROJECT, [], CHARACTER, VOICE)
