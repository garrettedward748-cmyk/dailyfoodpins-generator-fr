"""Reading the submit response Google actually sends now.

The reference-to-video submit used to answer with `operations[]`, and the whole
video path was built on polling one of those. It does not any more: a submit
comes back as a workflow plus the media record it will fill, and the operation
poller has nothing to hold. The job failed with the credits already spent.

The bodies below are captured from a real failure, trimmed only of fields that
play no part. Written as a test because the shape is the thing that broke, and
the next time it changes this should say so before an operator does.
"""
from agent.worker._parsing import (
    extract_media_handle,
    extract_media_url,
    extract_operation,
)

# What a submit answered with, verbatim from the failing job.
WORKFLOW_SUBMIT = {
    "id": "ff4fb188-b54f-4d37-9618-1f629481208f",
    "status": 200,
    "data": {
        "remainingCredits": 30,
        "workflows": [
            {
                "name": "2800295f-cea6-4f1b-9aac-1269ef4d29f5",
                "metadata": {
                    "displayName": "Crockpot buffalo chicken dip recipe",
                    "createTime": "2026-09-06T18:08:42.035114Z",
                    "primaryMediaId": "da134cbd-dcf1-4745-859b-fada786b042d",
                    "batchId": "285ae4cf-f4a0-4cfb-91e6-7629f159c655",
                    "updateTime": "2026-09-06T18:08:44.259674Z",
                },
                "projectId": "05680afb-489c-48b5-a966-d6f2a08546f7",
            }
        ],
        "media": [
            {
                "name": "da134cbd-dcf1-4745-859b-fada786b042d",
                "projectId": "05680afb-489c-48b5-a966-d6f2a08546f7",
                "workflowId": "2800295f-cea6-4f1b-9aac-1269ef4d29f5",
                "workflowStepId": "CAE",
                "mediaMetadata": {"createTime": "2026-09-06T18:08:42.035114Z"},
            }
        ],
    },
}

# The older shape, which must keep working: an account or a model that still
# answers with operations should not be broken by teaching this the new one.
OPERATION_SUBMIT = {
    "status": 200,
    "data": {"operations": [{"operation": {"name": "operations/abc123"}, "status": "PENDING"}]},
}


class TestReadingTheSubmit:
    def test_finds_the_media_to_poll_for(self):
        handle = extract_media_handle(WORKFLOW_SUBMIT)
        assert handle is not None
        assert handle["mediaId"] == "da134cbd-dcf1-4745-859b-fada786b042d"
        assert handle["workflowId"] == "2800295f-cea6-4f1b-9aac-1269ef4d29f5"
        assert handle["projectId"] == "05680afb-489c-48b5-a966-d6f2a08546f7"

    def test_falls_back_to_the_media_list_when_the_workflow_names_no_primary(self):
        # Same generation, one field absent. The media record carries the id
        # under its own name, so there is no reason to fail here.
        body = {
            "data": {
                "workflows": [{"name": "wf-1", "metadata": {}, "projectId": "p-1"}],
                "media": [{"name": "media-1", "workflowId": "wf-1"}],
            }
        }
        assert extract_media_handle(body)["mediaId"] == "media-1"

    def test_says_nothing_about_the_operation_shape(self):
        # The two readers must not both claim a response: the caller picks a
        # poller by which one answers.
        assert extract_media_handle(OPERATION_SUBMIT) is None
        assert extract_operation(WORKFLOW_SUBMIT) is None

    def test_the_operation_shape_still_reads(self):
        assert extract_operation(OPERATION_SUBMIT) is not None

    def test_an_unreadable_body_is_not_mistaken_for_either(self):
        assert extract_media_handle({"data": {"remainingCredits": 30}}) is None
        assert extract_media_handle({"data": "a string"}) is None


class TestReadingTheMedia:
    def test_takes_the_url_once_it_is_there(self):
        assert extract_media_url({"data": {"fifeUrl": "https://x/video.mp4"}}) == (
            "https://x/video.mp4"
        )

    def test_accepts_the_other_name_for_it(self):
        # get_media documents servingUri; the video path reads fifeUrl. Which
        # arrives has varied, and accepting both costs a line.
        assert extract_media_url({"data": {"servingUri": "https://x/v.mp4"}}) == "https://x/v.mp4"

    def test_reads_it_through_a_nested_media_object(self):
        assert extract_media_url({"data": {"media": {"fifeUrl": "https://x/n.mp4"}}}) == (
            "https://x/n.mp4"
        )

    def test_not_ready_is_empty_rather_than_an_error(self):
        # The normal state for most of the wait.
        assert extract_media_url({"data": {"name": "media-1"}}) == ""
        assert extract_media_url({"data": {}}) == ""
