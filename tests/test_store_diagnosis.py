import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

from tools import diagnose_store_submission as diagnosis
from tools import submit_store_release as store
from tests.test_store_submission import baseline


class StoreDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.notes = store.validated_notes(diagnosis.TAG, diagnosis.ROOT / diagnosis.NOTES_PATH)
        raw_notes = self.notes.encode()
        self.github = {
            f"/git/ref/tags/{diagnosis.TAG}": {"ref": "refs/tags/" + diagnosis.TAG,
                "object": {"type": "commit", "sha": diagnosis.SOURCE}},
            f"/releases/tags/{diagnosis.TAG}": {"id": diagnosis.RELEASE, "tag_name": diagnosis.TAG,
                "draft": False, "prerelease": False, "published_at": "2026-10-08T14:38:45Z", "body": self.notes},
            f"/actions/runs/{diagnosis.RUN}": {"id": diagnosis.RUN, "head_sha": diagnosis.SOURCE,
                "head_branch": diagnosis.TAG, "event": "push", "path": ".github/workflows/release.yml",
                "run_attempt": 1, "status": "completed", "conclusion": "failure"},
            f"/actions/runs/{diagnosis.RUN}/jobs?per_page=100&filter=latest": {
                "total_count": len(diagnosis.JOB_OUTCOMES), "jobs": [{"name": name,
                "id": job, "status": "completed", "conclusion": result}
                for name, (job, result) in diagnosis.JOB_OUTCOMES.items()]},
            f"/actions/artifacts/{diagnosis.READINESS_ARTIFACT}": {"id": diagnosis.READINESS_ARTIFACT,
                "name": "microsoft-store-readiness-1", "expired": False, "size_in_bytes": 1111,
                "digest": "sha256:" + diagnosis.READINESS_SHA,
                "workflow_run": {"id": diagnosis.RUN, "head_sha": diagnosis.SOURCE}},
            f"/contents/{diagnosis.NOTES_PATH}?ref={diagnosis.SOURCE}": {"type": "file",
                "path": diagnosis.NOTES_PATH, "encoding": "base64", "size": len(raw_notes),
                "content": base64.b64encode(raw_notes).decode()},
        }
        self.published = baseline()
        self.published["id"] = diagnosis.BASELINE
        self.published["opaqueExistingSettings"] = {"reviewed": "PRIVATE_SETTING_VALUE"}
        self.published["applicationPackages"].append({"fileName": "retained-arm.msix", "fileStatus": "Uploaded", "architecture": "ARM64"})
        notes = store.store_notes(self.notes, diagnosis.TAG)
        expected = store.marker(diagnosis.VERSION, diagnosis.PACKAGE_SHA, notes)
        self.pending = store.prepare_submission(self.published, Path(diagnosis.PACKAGE), notes, expected,
            target_publish_mode="Immediate")
        self.pending.update(id=diagnosis.DRAFT, status="PendingCommit", fileUploadUrl="https://private.example/upload?sig=SECRET_SAS")
        self.api = Mock()
        self.api.request.side_effect = self.store_request
        self.factory = Mock(return_value=self.api)
        self.github_calls = []

    def github_get(self, path):
        self.github_calls.append(path)
        return copy.deepcopy(self.github[path])

    def store_request(self, method, path):
        self.assertEqual(method, "GET")
        self.assertIn(path, diagnosis.STORE_PATHS)
        if path == f"/applications/{store.APP_ID}":
            return {"id": store.APP_ID, "packageIdentityName": store.IDENTITY, "publisherName": store.PUBLISHER,
                "lastPublishedApplicationSubmission": {"id": diagnosis.BASELINE},
                "pendingApplicationSubmission": {"id": diagnosis.DRAFT}}
        return copy.deepcopy(self.published if path == store.submission_path(diagnosis.BASELINE) else self.pending)

    def run_diagnosis(self):
        return diagnosis.diagnose(self.github_get, self.factory, self.notes)

    def test_matching_owned_draft_reads_only_fixed_resources_after_provenance(self):
        def create_store():
            self.assertEqual(set(self.github_calls), diagnosis.GITHUB_PATHS)
            return self.api
        self.factory.side_effect = create_store
        report = self.run_diagnosis()
        self.assertTrue(report["settingsDigestEqual"])
        self.assertTrue(report["releaseMarkerUnique"])
        self.assertEqual(report["settingsDifferences"], {"count": 0, "truncated": False, "paths": []})
        self.assertEqual(self.api.request.call_count, 3)
        self.api.upload.assert_not_called()
        self.assertEqual(report["uploadCompletion"], "not_asserted")
        self.assertEqual(report["commitCompletion"], "not_asserted")

    def test_provenance_changes_never_construct_store_client(self):
        cases = [
            (f"/git/ref/tags/{diagnosis.TAG}", ("object", "sha"), "0" * 40),
            (f"/git/ref/tags/{diagnosis.TAG}", ("object", "type"), "tag"),
            (f"/releases/tags/{diagnosis.TAG}", ("id",), 999),
            (f"/releases/tags/{diagnosis.TAG}", ("draft",), True),
            (f"/releases/tags/{diagnosis.TAG}", ("prerelease",), True),
            (f"/releases/tags/{diagnosis.TAG}", ("body",), "Unreviewed notes"),
            (f"/actions/runs/{diagnosis.RUN}", ("head_sha",), "0" * 40),
            (f"/actions/runs/{diagnosis.RUN}", ("event",), "workflow_dispatch"),
            (f"/actions/runs/{diagnosis.RUN}", ("status",), "in_progress"),
            (f"/actions/runs/{diagnosis.RUN}", ("run_attempt",), 2),
            (f"/actions/artifacts/{diagnosis.READINESS_ARTIFACT}", ("digest",), "sha256:" + "0" * 64),
            (f"/actions/artifacts/{diagnosis.READINESS_ARTIFACT}", ("workflow_run", "head_sha"), "0" * 40),
            (f"/contents/{diagnosis.NOTES_PATH}?ref={diagnosis.SOURCE}", ("content",), "Invalid%base64"),
        ]
        original = copy.deepcopy(self.github)
        for path, keys, value in cases:
            with self.subTest(path=path, keys=keys):
                self.github = copy.deepcopy(original)
                target = self.github[path]
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                with self.assertRaises(diagnosis.DiagnosisError):
                    self.run_diagnosis()
                self.factory.assert_not_called()
                self.api.request.assert_not_called()

    def test_job_failure_duplicate_or_unexpected_job_stops_before_store(self):
        path = f"/actions/runs/{diagnosis.RUN}/jobs?per_page=100&filter=latest"
        original = copy.deepcopy(self.github[path])
        for change in ("failedQualification", "duplicate", "unexpected", "missing"):
            with self.subTest(change=change):
                response = copy.deepcopy(original)
                if change == "failedQualification":
                    response["jobs"][1]["conclusion"] = "failure"
                elif change == "duplicate":
                    response["jobs"][-1] = response["jobs"][0]
                elif change == "unexpected":
                    response["jobs"][-1]["name"] = "Unreviewed job"
                else:
                    response["jobs"].pop()
                self.github[path] = response
                with self.assertRaises(diagnosis.DiagnosisError):
                    self.run_diagnosis()
                self.factory.assert_not_called()

    def test_changed_local_notes_stop_before_any_api(self):
        with self.assertRaises(diagnosis.DiagnosisError):
            diagnosis.diagnose(self.github_get, self.factory, self.notes + "changed")
        self.assertFalse(self.github_calls)
        self.factory.assert_not_called()

    def test_crlf_is_reported_without_asserting_actual_failure_cause(self):
        self.pending["notesForCertification"] = self.pending["notesForCertification"].replace("\n", "\r\n")
        self.pending["listings"]["en-us"]["baseListing"]["releaseNotes"] = store.store_notes(self.notes, diagnosis.TAG).replace("\n", "\r\n")
        report = self.run_diagnosis()
        self.assertFalse(report["certificationNotesEqual"])
        self.assertTrue(report["certificationNotesLineEndingEquivalent"])
        self.assertFalse(report["releaseNotesEqual"])
        self.assertTrue(report["releaseNotesLineEndingEquivalent"])
        self.assertTrue(report["settingsDigestEqual"])
        self.assertTrue(report["releaseMarkerUnique"])

    def test_meaningful_settings_notes_and_package_edits_are_visible_but_values_are_secret(self):
        self.pending["opaqueExistingSettings"]["reviewed"] = "NEW_PRIVATE_SETTING"
        self.pending["notesForCertification"] += "\nPRIVATE_CERTIFICATION_TEXT"
        self.pending["listings"]["en-us"]["baseListing"]["releaseNotes"] += "\nPRIVATE_RELEASE_TEXT"
        self.pending["applicationPackages"][-1]["fileName"] = "PRIVATE_PACKAGE_NAME"
        report = self.run_diagnosis()
        self.assertFalse(report["settingsDigestEqual"])
        self.assertFalse(report["certificationNotesLineEndingEquivalent"])
        self.assertFalse(report["releaseNotesLineEndingEquivalent"])
        self.assertIn("/opaqueExistingSettings/reviewed", [item["path"] for item in report["settingsDifferences"]["paths"]])
        self.assertGreater(report["packageDifferences"]["count"], 0)
        text = json.dumps(report)
        for secret in ("SECRET_SAS", "private.example", "PRIVATE_SETTING_VALUE", "NEW_PRIVATE_SETTING",
                "PRIVATE_CERTIFICATION_TEXT", "PRIVATE_RELEASE_TEXT", "PRIVATE_PACKAGE_NAME", "runFullTrust"):
            self.assertNotIn(secret, text)

    def test_identity_changes_stop_after_application_read(self):
        self.api.request.side_effect = lambda *_: {"id": "UNEXPECTED_APP"}
        with self.assertRaises(diagnosis.DiagnosisError):
            self.run_diagnosis()
        self.assertEqual(self.api.request.call_count, 1)

    def test_store_wrapper_refuses_unpinned_resources_without_calling_api(self):
        reads = diagnosis.StoreReads(self.api)
        for path in ("/applications/other", store.submission_path("999"), store.submission_path(diagnosis.DRAFT) + "/commit"):
            with self.subTest(path=path), self.assertRaises(diagnosis.DiagnosisError):
                reads.get(path)
        self.api.request.assert_not_called()

    def test_differences_distinguish_types_missing_and_strict_line_endings(self):
        changes = diagnosis.differences({"boolean": False, "integer": 1, "text": "a\nb", "missing": None},
            {"boolean": 0, "integer": True, "text": "a\r\nb", "extra": "secret"})
        rows = {row["path"]: row for row in changes["paths"]}
        self.assertEqual(changes["count"], 5)
        self.assertEqual(rows["/boolean"]["preparedType"], "bool")
        self.assertEqual(rows["/boolean"]["pendingType"], "int")
        self.assertEqual(rows["/missing"]["pendingType"], "missing")
        self.assertTrue(rows["/text"]["lineEndingEquivalent"])
        self.assertFalse(diagnosis.line_endings_equal("a \n", "a\n"))
        self.assertFalse(diagnosis.line_endings_equal("a\rb", "a\nb"))

    def test_report_is_bounded_and_unsafe_keys_are_hashed(self):
        result = diagnosis.differences({}, {"https://secret.example/?sig=SECRET": "SECRET_VALUE", **{f"field{x}": x for x in range(250)}})
        self.assertEqual(result["count"], 251)
        self.assertEqual(len(result["paths"]), diagnosis.MAX_DIFFERENCES)
        self.assertTrue(result["truncated"])
        self.assertNotIn("SECRET", json.dumps(result))
        nested = {}
        for _ in range(diagnosis.MAX_DEPTH + 2):
            nested = {"nested": nested}
        with self.assertRaises(diagnosis.DiagnosisError):
            diagnosis.differences(nested, copy.deepcopy(nested))

    def test_github_client_forbids_redirects_writes_and_external_paths(self):
        with patch.dict("os.environ", {"GITHUB_TOKEN": "SECRET_GH"}):
            client = diagnosis.GitHubReads()
        for path in ("https://evil.example/", "/git/refs", f"/releases/tags/{diagnosis.TAG}/assets"):
            with self.assertRaises(diagnosis.DiagnosisError):
                client.get(path)
        self.assertIsNone(store.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://evil.example"))
        response = Mock()
        response.read.return_value = b'{}'
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        client.opener = Mock()
        client.opener.open.return_value = context
        client.get(f"/git/ref/tags/{diagnosis.TAG}")
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "https://api.github.com/repos/" + diagnosis.REPOSITORY + f"/git/ref/tags/{diagnosis.TAG}")
        self.assertIsNone(request.data)
        self.assertEqual(response.read.call_args.args, (diagnosis.MAX_RESPONSE + 1,))

    def test_network_error_messages_never_echo_signed_urls(self):
        with patch.dict("os.environ", {"GITHUB_TOKEN": "SECRET_GH"}):
            client = diagnosis.GitHubReads()
        client.opener = Mock()
        for error in (urllib.error.HTTPError("https://private.example/?sig=SECRET", 403, "SECRET_BODY", {}, None),
                urllib.error.URLError("SECRET_NETWORK_TEXT")):
            client.opener.open.side_effect = error
            with self.assertRaises(diagnosis.DiagnosisError) as caught:
                client.get(f"/git/ref/tags/{diagnosis.TAG}")
            self.assertNotIn("SECRET", str(caught.exception))
            self.assertNotIn("private.example", str(caught.exception))

    def test_cli_failure_report_sanitizes_untrusted_exception(self):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            with patch.object(diagnosis, "GitHubReads", side_effect=ValueError("SECRET_GH_AND_URL")):
                self.assertEqual(diagnosis.main(["--report", str(report)]), 1)
            value = json.loads(report.read_text())
            self.assertTrue(value["readOnly"])
            self.assertEqual(value["status"], "Failed")
            self.assertEqual(value["diagnosticStage"], "GitHubAuthentication")
            self.assertNotIn("SECRET", report.read_text())

    def test_direct_cli_imports_without_pythonpath_from_unrelated_directory(self):
        environment = {key: value for key, value in os.environ.items()
            if key not in {"PYTHONPATH", "GITHUB_TOKEN", "MS_STORE_TENANT_ID", "MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET"}}
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run([sys.executable, str(diagnosis.ROOT / "tools/diagnose_store_submission.py"), "--help"],
                cwd=temp, env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--report", result.stdout)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
