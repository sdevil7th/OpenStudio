import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from tools import submit_store_release as store


def baseline():
    return {
        "id": "100", "status": "Published", "targetPublishMode": "Manual",
        "visibility": "Private", "pricing": {"priceId": "Free"},
        "allowMicrosoftDecideAppAvailabilityToFutureDeviceFamilies": False,
        "notesForCertification": "Native audio and plugin hosting require runFullTrust.",
        "listings": {"en-us": {"baseListing": {"description": "DAW", "releaseNotes": "Old",
            "images": [{"id": "image1", "fileStatus": "Uploaded"}]}}},
        "applicationPackages": [{"fileName": "old.msix", "version": "0.1.1.0", "fileStatus": "Uploaded",
            "architecture": "X64", "targetDeviceFamilies": ["Windows.Desktop min version 10.0.19041.0"]}],
    }


class FakeApi:
    def __init__(self, pending=None, statuses=None):
        self.published = baseline()
        self.pending = pending
        self.calls = []
        self.uploads = []
        self.statuses = list(statuses or ["PreProcessing"])

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path == f"/applications/{store.APP_ID}":
            return {"id": store.APP_ID, "packageIdentityName": store.IDENTITY, "publisherName": store.PUBLISHER,
                    "lastPublishedApplicationSubmission": {"id": "100"} if self.published else None,
                    "pendingApplicationSubmission": {"id": "200"} if self.pending else None}
        if path.endswith("/status"):
            return {"status": self.statuses.pop(0), "statusDetails": {"warnings": [{"code": "W1"}]}}
        if method == "POST" and path.endswith("/commit"):
            self.pending["status"] = "CommitStarted"
            return {"status": "CommitStarted"}
        if method == "POST":
            self.pending = copy.deepcopy(self.published)
            self.pending.update(id="200", status="PendingCommit", fileUploadUrl="https://test.blob.core.windows.net/upload?sig=SECRET")
            return copy.deepcopy(self.pending)
        if method == "PUT":
            self.pending = copy.deepcopy(body)
            return copy.deepcopy(body)
        return copy.deepcopy(self.published if path.endswith("/100") else self.pending)

    def upload(self, url, path):
        with zipfile.ZipFile(path) as bundle:
            self.uploads.append((url, bundle.namelist(), bundle.read(bundle.namelist()[0])))


class StoreSubmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.package = self.directory / "OpenStudio-0.1.2.0-x64.msix"
        self.package.write_bytes(b"tested package")
        self.sha = store.digest(self.package)
        self.notes = "Release notes for the exact version."
        self.expected = store.marker("0.1.2.0", self.sha, self.notes)
        self.report = {}

    def run_submit(self, api, **kwargs):
        store.submit(api, self.package, "0.1.2.0", self.sha, self.notes,
                     lambda **values: self.report.update(values), sleep=lambda _: None, **kwargs)

    def pending(self, status="PendingCommit"):
        value = baseline()
        value.update(id="200", status=status, notesForCertification=self.expected,
                     fileUploadUrl="https://test.blob.core.windows.net/upload?sig=SECRET")
        return value

    def test_stable_versions_normalize_and_reject_prereleases(self):
        self.assertEqual(store.package_version("v0.1.01"), "0.1.1.0")
        self.assertEqual(store.package_version("1.2.3.0"), "1.2.3.0")
        for value in ("1.2", "1.2.3-beta", "1.2.3.1", "65536.0.0", "1.2.3\n", "v1.2.3;echo x"):
            with self.subTest(value=value), self.assertRaises(store.StoreError):
                store.package_version(value)

    def test_preserves_listing_audience_schedule_and_other_architectures(self):
        original = baseline()
        original["applicationPackages"].append({"fileName": "arm.msix", "architecture": "ARM64", "fileStatus": "Uploaded"})
        prepared = store.prepare_submission(original, self.package, self.notes, self.expected)
        for key in ("targetPublishMode", "visibility", "pricing", "allowMicrosoftDecideAppAvailabilityToFutureDeviceFamilies"):
            self.assertEqual(prepared[key], original[key])
        self.assertEqual(prepared["listings"]["en-us"]["baseListing"]["description"], "DAW")
        self.assertEqual(prepared["applicationPackages"][0]["fileStatus"], "PendingDelete")
        self.assertEqual(prepared["applicationPackages"][1]["fileStatus"], "Uploaded")
        self.assertEqual(prepared["applicationPackages"][2]["fileStatus"], "PendingUpload")
        self.assertEqual(original["applicationPackages"][0]["fileStatus"], "Uploaded")
        self.assertIn("runFullTrust", prepared["notesForCertification"])

    def test_unknown_package_coverage_and_missing_listing_fail_before_mutation(self):
        for missing in ("applicationPackages", "listings"):
            api = FakeApi()
            api.published.pop(missing)
            with self.assertRaises(store.StoreError):
                self.run_submit(api)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_create_upload_commit_order_and_sanitized_report(self):
        api = FakeApi(statuses=["CommitStarted", "Certification"])
        self.run_submit(api)
        self.assertEqual([method for method, _, _ in api.calls], ["GET", "GET", "POST", "PUT", "POST", "GET", "GET"])
        self.assertEqual(api.uploads[0][1:], ([self.package.name], b"tested package"))
        self.assertEqual(self.report["status"], "Certification")
        self.assertNotIn("SECRET", json.dumps(self.report))
        self.assertEqual(self.report["warningCodes"], ["W1"])

    def test_unrelated_pending_submission_untouched(self):
        api = FakeApi(pending=baseline())
        with self.assertRaisesRegex(store.StoreError, "unrelated"):
            self.run_submit(api)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_same_tag_changed_package_or_notes_cannot_overwrite(self):
        for suffix in ("new file", "new notes"):
            pending = self.pending()
            pending["notesForCertification"] += suffix
            api = FakeApi(pending=pending)
            with self.assertRaises(store.StoreError):
                self.run_submit(api)
            self.assertFalse(api.uploads)

    def test_resume_upload_without_creating_new_submission(self):
        api = FakeApi(pending=self.pending())
        self.run_submit(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(sum(method == "POST" for method, _, _ in api.calls), 1)

    def test_resume_commit_checks_status_without_reupload_or_recommit(self):
        api = FakeApi(pending=self.pending("CommitStarted"))
        self.run_submit(api)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
        self.assertFalse(api.uploads)

    def test_already_published_same_artifact_is_idempotent(self):
        api = FakeApi()
        api.published["notesForCertification"] = self.expected
        self.run_submit(api)
        self.assertTrue(self.report["alreadySubmitted"])
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_equal_or_older_versions_rejected(self):
        for version in ("0.1.2.0", "1.0.0.0"):
            api = FakeApi()
            api.published["applicationPackages"][0]["version"] = version
            with self.assertRaisesRegex(store.StoreError, "higher version"):
                self.run_submit(api)
            self.assertEqual(len(api.calls), 2)

    def test_failed_certification_never_resubmitted(self):
        api = FakeApi(pending=self.pending("CertificationFailed"))
        with self.assertRaisesRegex(store.StoreError, "CertificationFailed"):
            self.run_submit(api)
        self.assertFalse(api.uploads)

    def test_polling_failure_and_timeout_record_submission(self):
        for statuses in (["PreProcessingFailed"], ["CommitStarted"]):
            api = FakeApi(statuses=statuses)
            with self.assertRaises(store.StoreError):
                self.run_submit(api, max_polls=1)
            self.assertEqual(self.report["submissionId"], "200")
            self.assertEqual(self.report["status"], statuses[0])

    def test_ambiguous_create_is_not_retried(self):
        api = FakeApi()
        original = api.request
        def request(method, path, body=None):
            result = original(method, path, body)
            if method == "POST":
                raise store.StoreError("Request timed out")
            return result
        api.request = request
        with self.assertRaises(store.StoreError):
            self.run_submit(api)
        self.assertEqual(sum(method == "POST" for method, _, _ in api.calls), 1)

    def test_release_notes_bounded_and_linked(self):
        notes = "# OpenStudio 0.1.2\n\n" + "- A complete description of a tested improvement.\n" * 100
        result = store.store_notes(notes, "v0.1.2")
        self.assertLessEqual(len(result), 1500)
        self.assertTrue(result.endswith("/releases/tag/v0.1.2"))
        self.assertIn("tested improvement.", result)

    def create_package(self, **identity):
        attrs = {"Name": store.IDENTITY, "Publisher": store.PUBLISHER, "Version": "0.1.2.0", "ProcessorArchitecture": "x64"} | identity
        xml = '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity '
        xml += " ".join(f'{key}="{value}"' for key, value in attrs.items())
        xml += '/><Dependencies><TargetDeviceFamily Name="Windows.Desktop" /></Dependencies></Package>'
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("AppxManifest.xml", xml)
        report = {"version": "0.1.2.0", "sha256": store.digest(self.package), "packageValidation": "pass", "payloadRoundTrip": "pass"}
        (self.directory / "package-report.json").write_text(json.dumps(report))

    def test_package_identity_and_hash(self):
        self.create_package()
        store.validate_package(self.directory, "0.1.2.0")
        self.package.write_bytes(b"modified")
        with self.assertRaisesRegex(store.StoreError, "hash"):
            store.validate_package(self.directory, "0.1.2.0")
        for attrs in ({"Publisher": "CN=Wrong"}, {"Version": "9.0.0.0"}, {"ProcessorArchitecture": "arm64"}):
            self.create_package(**attrs)
            with self.assertRaisesRegex(store.StoreError, "identity"):
                store.validate_package(self.directory, "0.1.2.0")

    def api_client(self):
        env = {"MS_STORE_TENANT_ID": "a" * 36, "MS_STORE_CLIENT_ID": "b" * 36, "MS_STORE_CLIENT_SECRET": "super-secret"}
        with patch.dict("os.environ", env):
            return store.StoreApi()

    def test_upload_rejects_non_azure_hosts_and_redirects(self):
        api = self.api_client()
        for url in ("http://x.blob.core.windows.net/f?sig=x", "https://evil.test/f?sig=x",
                    "https://x.blob.core.windows.net.evil.test/f?sig=x", "https://u@x.blob.core.windows.net/f?sig=x"):
            with self.assertRaises(store.StoreError):
                api.upload(url, self.package)
        self.assertIsNone(store.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_upload_stream_does_not_send_api_credentials(self):
        api = self.api_client()
        api.token = "bearer-secret"
        requests = []
        def capture(request, **kwargs):
            requests.append(request)
            self.assertTrue(hasattr(request.data, "read"))
            self.assertIsNone(request.get_header("Authorization"))
            self.assertEqual(request.data.read(), b"tested package")
        api._open = capture
        api.upload("https://x.blob.core.windows.net/f?sig=x", self.package)
        self.assertEqual(requests[0].get_header("Content-length"), str(self.package.stat().st_size))

    def test_http_error_does_not_expose_secrets(self):
        api = self.api_client()
        api.opener.open = lambda *args, **kwargs: (_ for _ in ()).throw(
            urllib.error.HTTPError("https://x?sig=super-secret", 401, "super-secret", {}, None))
        with self.assertRaises(store.StoreError) as failure:
            api._open(None)
        self.assertNotIn("super-secret", str(failure.exception))

    def test_offline_cli_validates_without_credentials_or_network(self):
        self.create_package()
        notes_path = self.directory / "0.1.2.md"
        notes_path.write_text("# OpenStudio 0.1.2\n\n" + "\n\n".join(
            f"## {title}\n- A concrete explanation of the release behavior and its testing."
            for title in ("Highlights", "Fixes", "Known Issues", "Upgrade Notes"))
            + "\n\nSource: https://github.com/sdevil7th/OpenStudio/pull/10\n", encoding="utf-8")
        report_path = self.directory / "result.json"
        with patch.object(store, "StoreApi", side_effect=AssertionError("Offline mode touched credentials/network")), \
             patch("sys.argv", ["submit_store_release.py", "--version", "v0.1.2", "--package-dir", str(self.directory),
                                "--notes-file", str(notes_path), "--report", str(report_path)]):
            self.assertEqual(store.main(), 0)
        report = json.loads(report_path.read_text())
        self.assertEqual(report["status"], "Validated")
        self.assertFalse(report["liveSubmission"])
        self.assertNotIn("submissionId", report)

    def test_missing_first_publication_and_wrong_app_block_mutations(self):
        for override in ({"lastPublishedApplicationSubmission": None}, {"packageIdentityName": "UnrelatedApp"}):
            api = FakeApi()
            original = api.request
            def request(method, path, body=None):
                result = original(method, path, body)
                return result | override if path == f"/applications/{store.APP_ID}" else result
            api.request = request
            with self.assertRaises(store.StoreError):
                self.run_submit(api)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def initial_api(self):
        pending = baseline()
        pending.update(id="200", status="PendingCommit",
                       fileUploadUrl="https://test.blob.core.windows.net/upload?sig=SECRET")
        pending["applicationPackages"][0]["version"] = "0.0.1.0"
        api = FakeApi(pending=pending)
        api.published = None
        return api

    def initial_config(self):
        return {"appId": store.APP_ID, "submissionId": "200", "releaseTag": "v0.1.02",
                "previousPackageVersion": "0.0.1.0"}

    def run_initial(self, api, **kwargs):
        self.run_submit(api, **({"initial_config": self.initial_config(), "release_tag": "v0.1.02"} | kwargs))

    def test_initial_adopts_only_existing_draft_and_preserves_all_settings(self):
        api = self.initial_api()
        before = copy.deepcopy(api.pending)
        self.run_initial(api)
        self.assertEqual([method for method, _, _ in api.calls], ["GET", "GET", "GET", "PUT", "GET", "POST", "GET"])
        self.assertTrue(all(not (method == "POST" and path.endswith("/submissions")) and method != "DELETE"
                            for method, path, _ in api.calls))
        self.assertEqual(store.initial_settings_digest(api.pending), store.initial_settings_digest(before))
        self.assertEqual(api.pending["listings"]["en-us"]["baseListing"]["images"],
                         before["listings"]["en-us"]["baseListing"]["images"])
        self.assertEqual(api.pending["targetPublishMode"], "Manual")
        self.assertEqual(api.uploads[0][1:], ([self.package.name], b"tested package"))
        self.assertEqual(self.report["submissionId"], "200")
        self.assertEqual(self.report["status"], "PreProcessing")
        self.assertTrue(self.report["initialSubmission"])
        self.assertNotIn("SECRET", json.dumps(self.report))

    def test_initial_preflight_authenticates_with_reads_only(self):
        api = self.initial_api()
        before = copy.deepcopy(api.pending)
        self.run_initial(api, preflight_only=True)
        self.assertEqual(api.pending, before)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
        self.assertFalse(api.uploads)
        self.assertEqual(self.report["status"], "PreflightPassed")

    def test_blocked_initial_preflight_reports_state_without_mutating(self):
        for status in ("Canceled", "Certification", "PendingPublication", "unexpected SECRET"):
            api = self.initial_api()
            api.pending["status"] = status
            before = copy.deepcopy(api.pending)
            with self.subTest(status=status), self.assertRaises(store.StoreError) as failure:
                self.run_initial(api, preflight_only=True)
            self.assertEqual(api.pending, before)
            self.assertFalse(api.uploads)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
            self.assertEqual(self.report["submissionId"], "200")
            self.assertEqual(self.report["observedStoreStatus"],
                             "Unknown" if status == "unexpected SECRET" else status)
            self.assertNotIn("SECRET", str(failure.exception) + json.dumps(self.report))

    def test_next_tag_reports_current_certification_without_adopting_it(self):
        api = self.initial_api()
        api.pending["status"] = "Certification"
        with self.assertRaisesRegex(store.StoreError, "No published baseline"):
            self.run_initial(api, release_tag="v0.1.03", preflight_only=True)
        self.assertEqual(self.report["observedStoreStatus"], "Certification")
        self.assertFalse(api.uploads)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_failed_live_cli_does_not_leave_a_validated_success_summary(self):
        self.create_package()
        api = self.initial_api()
        api.pending["status"] = "Canceled"
        config = self.directory / "initial.json"
        config.write_text(json.dumps(self.initial_config()))
        report_path = self.directory / "report.json"
        summary_path = self.directory / "summary.md"
        with patch.object(store, "StoreApi", return_value=api), \
                patch.dict(store.os.environ, {"GITHUB_STEP_SUMMARY": str(summary_path)}), \
                patch("sys.argv", ["submit_store_release.py", "--version", "v0.1.02",
                    "--package-dir", str(self.directory), "--notes-file",
                    str(store.ROOT / "docs/releases/0.1.02.md"), "--initial-submission-config",
                    str(config), "--report", str(report_path), "--preflight"]):
            self.assertEqual(store.main(), 1)
        report = json.loads(report_path.read_text())
        self.assertEqual(report["status"], "Failed")
        self.assertEqual(report["observedStoreStatus"], "Canceled")
        self.assertIn("Status: Failed", summary_path.read_text())
        self.assertIn("required: PendingCommit", summary_path.read_text())
        self.assertNotIn("SECRET", report_path.read_text() + summary_path.read_text())
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_published_preflight_never_creates_a_submission(self):
        api = FakeApi()
        self.run_submit(api, preflight_only=True)
        self.assertIsNone(api.pending)
        self.assertFalse(api.uploads)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
        self.assertEqual(self.report["status"], "PreflightPassed")

    def test_initial_requires_exact_draft_and_tag(self):
        for override in ({"initial_config": None}, {"release_tag": "v0.1.2"}, {"release_tag": "v0.1.03"},
                         {"initial_config": self.initial_config() | {"submissionId": "999"}},
                         {"initial_config": self.initial_config() | {"releaseTag": "v0.1.03"}}):
            api = self.initial_api()
            with self.subTest(override=override), self.assertRaises(store.StoreError):
                self.run_initial(api, **override)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
            self.assertFalse(api.uploads)

    def test_initial_missing_or_wrong_response_draft_is_not_adopted(self):
        for missing in (True, False):
            api = self.initial_api()
            if missing:
                api.pending = None
            else:
                api.pending["id"] = "999"
            with self.assertRaises(store.StoreError):
                self.run_initial(api)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_initial_rejects_ineligible_draft_without_mutations(self):
        def mutate(pending, case):
            if case == "hold":
                pending["targetPublishMode"] = "Immediate"
            elif case == "status":
                pending["status"] = "Certification"
            elif case == "version":
                pending["applicationPackages"][0]["version"] = "0.1.2.0"
            elif case == "architecture":
                pending["applicationPackages"][0]["architecture"] = "ARM64"
            elif case == "extra_package":
                pending["applicationPackages"].append(copy.deepcopy(pending["applicationPackages"][0]))
            elif case == "image_upload":
                pending["listings"]["en-us"]["baseListing"]["images"][0]["fileStatus"] = "PendingUpload"
            elif case == "image_delete":
                pending["listings"]["en-us"]["baseListing"]["images"][0]["fileStatus"] = "PendingDelete"
            elif case == "missing_images":
                pending["listings"]["en-us"]["baseListing"]["images"] = []
            elif case == "no_english":
                pending["listings"] = {}
            elif case == "foreign_marker":
                pending["notesForCertification"] += "\n" + store.MARKER_PREFIX + "other artifact"
            elif case == "long_notes":
                pending["notesForCertification"] = "x" * 1999
        for case in ("hold", "status", "version", "architecture", "extra_package", "image_upload", "image_delete",
                     "missing_images", "no_english", "foreign_marker", "long_notes"):
            api = self.initial_api()
            mutate(api.pending, case)
            with self.subTest(case=case), self.assertRaises(store.StoreError):
                self.run_initial(api)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
            self.assertFalse(api.uploads)

    def interrupted_initial_upload(self):
        api = self.initial_api()
        with patch.object(api, "upload", side_effect=store.StoreError("Upload interrupted")):
            with self.assertRaisesRegex(store.StoreError, "interrupted"):
                self.run_initial(api)
        self.assertTrue(store.owns(api.pending, self.expected))
        self.assertEqual(api.pending["status"], "PendingCommit")
        api.calls.clear()
        return api

    def test_initial_interrupted_upload_resumes_without_replacing_draft_again(self):
        api = self.interrupted_initial_upload()
        self.run_initial(api)
        self.assertEqual([method for method, _, _ in api.calls], ["GET", "GET", "POST", "GET"])
        self.assertEqual(len(api.uploads), 1)

    def test_initial_retry_preflight_is_read_only(self):
        api = self.interrupted_initial_upload()
        self.run_initial(api, preflight_only=True)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
        self.assertFalse(api.uploads)

    def test_initial_changed_hash_notes_and_configuration_fail_on_retry(self):
        for change in ("hash", "notes", "configuration"):
            api = self.interrupted_initial_upload()
            with self.subTest(change=change), self.assertRaises(store.StoreError):
                if change == "hash":
                    changed = self.directory / "changed" / self.package.name
                    changed.parent.mkdir(exist_ok=True)
                    changed.write_bytes(b"different release artifact")
                    store.submit(api, changed, "0.1.2.0", store.digest(changed), self.notes, lambda **_: None,
                                 initial_config=self.initial_config(), release_tag="v0.1.02")
                elif change == "notes":
                    store.submit(api, self.package, "0.1.2.0", self.sha, "changed", lambda **_: None,
                                 initial_config=self.initial_config(), release_tag="v0.1.02")
                else:
                    self.run_initial(api, initial_config=self.initial_config() | {"previousPackageVersion": "0.0.2.0"})
            self.assertFalse(api.uploads)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_initial_saved_artwork_hold_notes_or_packages_changed_on_retry(self):
        for change in ("artwork", "hold", "notes", "package"):
            api = self.interrupted_initial_upload()
            if change == "artwork":
                api.pending["listings"]["en-us"]["baseListing"]["images"][0]["id"] = "changed"
            elif change == "hold":
                api.pending["targetPublishMode"] = "Immediate"
            elif change == "notes":
                api.pending["listings"]["en-us"]["baseListing"]["releaseNotes"] = "changed"
            else:
                api.pending["applicationPackages"][-1]["fileName"] = "wrong.msix"
            with self.subTest(change=change), self.assertRaises(store.StoreError):
                self.run_initial(api)
            self.assertFalse(api.uploads)
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_initial_ambiguous_put_resumes_from_saved_marker(self):
        api = self.initial_api()
        request = api.request
        def ambiguous(method, path, body=None):
            result = request(method, path, body)
            if method == "PUT":
                raise store.StoreError("Timed out after PUT")
            return result
        with patch.object(api, "request", side_effect=ambiguous), self.assertRaises(store.StoreError):
            self.run_initial(api)
        self.assertFalse(api.uploads)
        api.calls.clear()
        self.run_initial(api)
        self.assertFalse(any(method == "PUT" for method, _, _ in api.calls))
        self.assertEqual(len(api.uploads), 1)

    def test_initial_ambiguous_commit_polls_without_recommitting(self):
        api = self.initial_api()
        request = api.request
        def ambiguous(method, path, body=None):
            result = request(method, path, body)
            if path.endswith("/commit"):
                raise store.StoreError("Timed out after commit")
            return result
        with patch.object(api, "request", side_effect=ambiguous), self.assertRaises(store.StoreError):
            self.run_initial(api)
        api.calls.clear()
        self.run_initial(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_initial_changed_during_preflight_or_after_put_stops_before_upload(self):
        for after_put in (False, True):
            api = self.initial_api()
            request = api.request
            draft_reads = 0
            def changing(method, path, body=None):
                nonlocal draft_reads
                if method == "GET" and path.endswith("/200"):
                    draft_reads += 1
                    if draft_reads == (3 if after_put else 2):
                        api.pending["visibility"] = "Public"
                return request(method, path, body)
            with patch.object(api, "request", side_effect=changing), self.assertRaises(store.StoreError):
                self.run_initial(api)
            self.assertFalse(api.uploads)
            self.assertFalse(any(method == "POST" for method, _, _ in api.calls))
            if not after_put:
                self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_initial_failed_certification_is_not_resubmitted(self):
        api = self.initial_api()
        self.run_initial(api)
        api.pending["status"] = "CertificationFailed"
        api.calls.clear()
        with self.assertRaisesRegex(store.StoreError, "CertificationFailed"):
            self.run_initial(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_published_release_uses_regular_path_even_with_initial_config(self):
        api = FakeApi()
        self.run_initial(api)
        self.assertFalse(self.report["initialSubmission"])
        self.assertTrue(any(method == "POST" and path.endswith("/submissions") for method, path, _ in api.calls))

    def test_initial_config_validation_and_repository_pin(self):
        actual = store.load_initial_config(store.ROOT / "packaging/msix/initial-submission.json")
        self.assertEqual(actual["submissionId"], "1152921505701841400")
        self.assertEqual(actual["releaseTag"], "v0.1.03")
        for change in ({"appId": "other"}, {"submissionId": "200/commit"}, {"submissionId": 200},
                       {"releaseTag": "v0.1.02-beta"}, {"previousPackageVersion": "bad"}, {"extra": "field"}):
            path = self.directory / "config.json"
            path.write_text(json.dumps(self.initial_config() | change))
            with self.subTest(change=change), self.assertRaises(store.StoreError):
                store.load_initial_config(path)

    def test_package_changed_after_validation_never_contacts_store(self):
        api = self.initial_api()
        self.package.write_bytes(b"replaced after validation")
        with self.assertRaisesRegex(store.StoreError, "changed after validation"):
            self.run_initial(api)
        self.assertFalse(api.calls)
        self.assertFalse(api.uploads)

    def test_initial_cli_preflight_and_submit_use_explicit_config(self):
        self.create_package()
        config_path = self.directory / "initial.json"
        config_path.write_text(json.dumps(self.initial_config()))
        for mode in ("--preflight", "--submit"):
            api = self.initial_api()
            report_path = self.directory / "cli-report.json"
            with patch.object(store, "StoreApi", return_value=api), patch("sys.argv", [
                    "submit_store_release.py", "--version", "v0.1.02", "--package-dir", str(self.directory),
                    "--notes-file", str(store.ROOT / "docs/releases/0.1.02.md"),
                    "--initial-submission-config", str(config_path), "--report", str(report_path), mode]):
                self.assertEqual(store.main(), 0)
            report = json.loads(report_path.read_text())
            self.assertNotIn("SECRET", json.dumps(report))
            self.assertEqual(report["livePreflight"], mode == "--preflight")
            self.assertEqual(report["liveSubmission"], mode == "--submit")
            if mode == "--preflight":
                self.assertEqual(report["status"], "PreflightPassed")
                self.assertTrue(all(method == "GET" for method, _, _ in api.calls))
                self.assertFalse(api.uploads)
            else:
                self.assertEqual(report["status"], "PreProcessing")
                self.assertEqual(len(api.uploads), 1)


if __name__ == "__main__":
    unittest.main()
