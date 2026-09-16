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
                    "lastPublishedApplicationSubmission": {"id": "100"},
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


if __name__ == "__main__":
    unittest.main()
