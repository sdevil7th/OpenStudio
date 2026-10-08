import copy
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import re
import shlex
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import yaml

from tools import diagnose_store_submission as diagnosis
from tools import resume_store_release as recovery
from tools import submit_store_release as store
from tests import test_store_diagnosis as diagnosis_tests
from tests.test_store_release_workflow import evaluate_condition


class RecoveryApi:
    def __init__(self, published, pending):
        self.published = copy.deepcopy(published)
        self.pending = copy.deepcopy(pending)
        self.calls = []
        self.uploads = []
        self.statuses = ["PreProcessing"]
        self.already_published = False
        self.changed_app = False

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "POST" and path == recovery.DRAFT_PATH + "/commit":
            self.pending["status"] = "CommitStarted"
            return {"status": "CommitStarted"}
        if method != "GET":
            raise AssertionError("Recovery attempted to create/edit/delete a draft")
        if path == recovery.APP_PATH:
            return {"id": store.APP_ID, "packageIdentityName": store.IDENTITY, "publisherName": store.PUBLISHER,
                "lastPublishedApplicationSubmission": {"id": diagnosis.DRAFT if self.already_published else diagnosis.BASELINE},
                "pendingApplicationSubmission": None if self.already_published else {"id": "999" if self.changed_app else diagnosis.DRAFT}}
        if path == recovery.BASELINE_PATH:
            return copy.deepcopy(self.published)
        if path == recovery.DRAFT_PATH:
            return copy.deepcopy(self.pending)
        if path == recovery.DRAFT_PATH + "/status":
            return {"status": self.statuses.pop(0), "statusDetails": {"warnings": [{"code": "W1"}]}}
        raise AssertionError("Recovery accessed an unpinned Store resource")

    def upload(self, url, archive):
        with zipfile.ZipFile(archive) as bundle:
            self.uploads.append((bundle.namelist(), hashlib.sha256(bundle.read(bundle.namelist()[0])).hexdigest()))


class StoreRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.package = self.directory / diagnosis.PACKAGE
        self.write_package()
        self.sha = store.digest(self.package)
        self.write_report()
        sha_patch = patch.object(recovery, "PACKAGE_SHA", self.sha)
        sha_patch.start()
        self.addCleanup(sha_patch.stop)
        fixture = diagnosis_tests.StoreDiagnosisTests("test_matching_owned_draft_reads_only_fixed_resources_after_provenance")
        fixture.setUp()
        self.notes = fixture.notes
        self.github = copy.deepcopy(fixture.github)
        self.github[f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}"] = {
            "id": recovery.PACKAGE_ARTIFACT, "name": "microsoft-store-package", "expired": False,
            "size_in_bytes": recovery.PACKAGE_ARTIFACT_SIZE, "digest": "sha256:" + recovery.PACKAGE_ARTIFACT_SHA,
            "workflow_run": {"id": diagnosis.RUN, "head_sha": diagnosis.SOURCE, "head_branch": diagnosis.TAG},
        }
        self.published = copy.deepcopy(fixture.published)
        for item in self.published["applicationPackages"]:
            item["version"] = "0.1.3.0"
        self.published["pricing"]["isAdvancedPricingModel"] = True
        self.published["applicationPackages"][0]["targetPlatform"] = "Windows.Desktop"
        expected = store.marker(diagnosis.VERSION, self.sha, store.store_notes(self.notes, diagnosis.TAG))
        self.pending = store.prepare_submission(self.published, self.package, store.store_notes(self.notes, diagnosis.TAG),
            expected, target_publish_mode="Immediate")
        self.pending.update(id=diagnosis.DRAFT, status="PendingCommit",
            fileUploadUrl="https://test.blob.core.windows.net/upload?sig=SECRET_SAS")
        self.pending["pricing"]["isAdvancedPricingModel"] = False
        self.pending["applicationPackages"][0].pop("targetPlatform")
        self.pending["applicationPackages"][-1].update(capabilities=[], languages=[], targetDeviceFamilies=[])
        self.api = RecoveryApi(self.published, self.pending)
        self.factory = Mock(return_value=self.api)
        self.github_get = Mock(side_effect=lambda path: copy.deepcopy(self.github[path]))
        self.policy = {"appId": store.APP_ID, "releaseTag": diagnosis.TAG, "targetPublishMode": "Immediate"}
        self.report = {}

    def write_package(self, version=diagnosis.VERSION):
        manifest = (f'<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">'
            f'<Identity Name="{store.IDENTITY}" Publisher="{store.PUBLISHER}" Version="{version}" ProcessorArchitecture="x64"/>'
            '<Dependencies><TargetDeviceFamily Name="Windows.Desktop"/></Dependencies></Package>')
        with zipfile.ZipFile(self.package, "w") as bundle:
            bundle.writestr("AppxManifest.xml", manifest)

    def write_report(self):
        (self.directory / "package-report.json").write_text(json.dumps({"version": diagnosis.VERSION,
            "sha256": store.digest(self.package), "packageValidation": "pass", "payloadRoundTrip": "pass"}))

    def run_recovery(self, submit=False):
        recovery.recover(self.github_get, self.factory, self.directory, self.notes, self.policy,
            lambda **values: self.report.update(values), submit=submit, sleep=lambda _: None)

    def test_default_preflight_validates_owned_server_normalized_draft_without_mutation(self):
        self.run_recovery()
        self.assertEqual(self.report["status"], "PreflightPassed")
        self.assertTrue(self.report["livePreflight"])
        self.assertFalse(self.report["liveSubmission"])
        self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))
        self.assertFalse(self.api.uploads)
        self.assertEqual({call.args[0] for call in self.github_get.call_args_list}, recovery.GITHUB_PATHS)
        self.assertNotIn("SECRET", json.dumps(self.report))

    def test_upload_and_commit_existing_draft_only_after_validation(self):
        self.api.statuses = ["CommitStarted", "Certification"]
        self.run_recovery(submit=True)
        self.assertEqual(self.api.uploads, [([diagnosis.PACKAGE], self.sha)])
        posts = [(method, path, body) for method, path, body in self.api.calls if method != "GET"]
        self.assertEqual(posts, [("POST", recovery.DRAFT_PATH + "/commit", None)])
        self.assertEqual(self.report["status"], "Certification")
        self.assertEqual(self.report["submissionId"], diagnosis.DRAFT)
        self.assertEqual(self.report["targetPublishMode"], "Immediate")
        self.assertEqual(self.report["warningCodes"], ["W1"])

    def test_started_or_accepted_retry_reads_status_without_upload_or_recommit(self):
        for status in ("CommitStarted", "PreProcessing", "Certification", "PendingPublication", "Publishing", "Release"):
            with self.subTest(status=status):
                self.api = RecoveryApi(self.published, self.pending)
                self.factory.return_value = self.api
                self.api.pending["status"] = status
                self.api.statuses = ["Certification"]
                self.run_recovery(submit=True)
                self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))
                self.assertFalse(self.api.uploads)
                self.assertEqual(self.report["status"], "Certification")

    def test_already_published_exact_draft_reports_success_using_reads_only(self):
        self.api.already_published = True
        self.api.pending["status"] = "Published"
        self.run_recovery(submit=True)
        self.assertEqual(self.report["status"], "Published")
        self.assertTrue(self.report["alreadySubmitted"])
        self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))
        self.assertFalse(self.api.uploads)

    def test_changed_provenance_or_package_artifact_never_authenticates_store(self):
        cases = [
            (f"/git/ref/tags/{diagnosis.TAG}", ("object", "sha"), "0" * 40),
            (f"/releases/tags/{diagnosis.TAG}", ("draft",), True),
            (f"/actions/runs/{diagnosis.RUN}", ("run_attempt",), 2),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("digest",), "sha256:" + "0" * 64),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("expired",), True),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("size_in_bytes",), 123),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("workflow_run", "head_sha"), "0" * 40),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("workflow_run", "id"), 999),
            (f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}", ("workflow_run", "head_branch"), "develop"),
        ]
        original = copy.deepcopy(self.github)
        for path, keys, value in cases:
            with self.subTest(path=path, keys=keys):
                self.github = copy.deepcopy(original)
                target = self.github[path]
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                with self.assertRaises((recovery.RecoveryError, diagnosis.DiagnosisError)):
                    self.run_recovery(submit=True)
                self.factory.assert_not_called()
                self.assertFalse(self.api.calls)

    def test_changed_notes_or_policy_fail_before_store_authentication(self):
        self.notes += "Unreviewed change"
        with self.assertRaises(diagnosis.DiagnosisError):
            self.run_recovery(submit=True)
        self.github_get.assert_not_called()
        self.factory.assert_not_called()
        self.notes = store.validated_notes(diagnosis.TAG, diagnosis.ROOT / diagnosis.NOTES_PATH)
        for key, value in (("targetPublishMode", "Manual"), ("releaseTag", "v0.1.06"), ("appId", "OTHER")):
            with self.subTest(key=key):
                original = self.policy[key]
                self.policy[key] = value
                with self.assertRaises(recovery.RecoveryError):
                    self.run_recovery(submit=True)
                self.factory.assert_not_called()
                self.policy[key] = original

    def test_changed_package_bytes_manifest_or_filename_fail_before_store(self):
        self.package.write_bytes(self.package.read_bytes() + b"tampered")
        with self.assertRaises(store.StoreError):
            self.run_recovery(submit=True)
        self.write_report()
        with self.assertRaises(recovery.RecoveryError):
            self.run_recovery(submit=True)
        self.write_package(version="0.1.6.0")
        self.write_report()
        with self.assertRaises(store.StoreError):
            self.run_recovery(submit=True)
        self.write_package()
        self.write_report()
        self.package.rename(self.directory / "unqualified.msix")
        with self.assertRaises(recovery.RecoveryError):
            self.run_recovery(submit=True)
        self.factory.assert_not_called()
        self.assertFalse(self.api.calls)

    def test_changed_draft_marker_mode_unknown_settings_or_package_stop_before_upload_commit(self):
        for change in ("settings", "marker", "price", "mode", "releaseNotes", "retainedPackage"):
            with self.subTest(change=change):
                self.api = RecoveryApi(self.published, self.pending)
                self.factory.return_value = self.api
                if change == "settings":
                    self.api.pending["unknownSetting"] = "UNREVIEWED_SECRET"
                elif change == "marker":
                    self.api.pending["notesForCertification"] += "\nUnreviewed certification text"
                elif change == "price":
                    self.api.pending["pricing"]["priceId"] = "Tier1"
                elif change == "mode":
                    self.api.pending["targetPublishMode"] = "Manual"
                elif change == "releaseNotes":
                    self.api.pending["listings"]["en-us"]["baseListing"]["releaseNotes"] += "new text"
                else:
                    self.api.pending["applicationPackages"][1]["fileName"] = "changed-arm.msix"
                with self.assertRaises(store.StoreError):
                    self.run_recovery(submit=True)
                self.assertFalse(self.api.uploads)
                self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))

    def test_unrelated_draft_is_never_read_uploaded_or_committed(self):
        self.api.changed_app = True
        with self.assertRaises(recovery.RecoveryError):
            self.run_recovery(submit=True)
        self.assertEqual([(method, path) for method, path, _ in self.api.calls], [("GET", recovery.APP_PATH)])
        self.assertFalse(self.api.uploads)

    def test_route_allowlist_refuses_create_put_delete_foreign_read_and_early_commit(self):
        api = Mock()
        wrapper = recovery.ResumeOnlyApi(api, self.package, self.sha, allow_submit=True)
        for method, path, body in (
            ("POST", recovery.APP_PATH + "/submissions", None),
            ("PUT", recovery.DRAFT_PATH, {}), ("DELETE", recovery.DRAFT_PATH, None),
            ("GET", store.submission_path("999"), None),
            ("GET", recovery.DRAFT_PATH, {}), ("POST", recovery.DRAFT_PATH + "/commit", None),
        ):
            with self.subTest(method=method, path=path), self.assertRaises(recovery.RecoveryError):
                wrapper.request(method, path, body)
        api.request.assert_not_called()
        api.upload.assert_not_called()

    def test_archive_bytes_or_upload_destination_cannot_change(self):
        api = Mock()
        wrapper = recovery.ResumeOnlyApi(api, self.package, self.sha, allow_submit=True)
        wrapper.upload_url = "https://test.blob.core.windows.net/upload?sig=SECRET_SAS"
        archive = self.directory / "submission.zip"
        for changed in ("bytes", "entry", "additional", "compressed", "destination"):
            with self.subTest(changed=changed):
                with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED if changed == "compressed" else zipfile.ZIP_STORED) as bundle:
                    bundle.writestr("wrong.msix" if changed == "entry" else diagnosis.PACKAGE,
                        b"changed" if changed == "bytes" else self.package.read_bytes())
                    if changed == "additional":
                        bundle.writestr("extra.txt", "unreviewed")
                with self.assertRaises(recovery.RecoveryError):
                    wrapper.upload("https://other.blob.core.windows.net/?sig=OTHER" if changed == "destination" else wrapper.upload_url, archive)
                api.upload.assert_not_called()

    def test_github_recovery_extension_is_frozen_and_default_diagnosis_stays_fixed(self):
        paths = set(recovery.GITHUB_PATHS)
        with patch.dict(os.environ, {"GITHUB_TOKEN": "SECRET_GITHUB"}):
            reader = diagnosis.GitHubReads(allowed_paths=paths)
            default = diagnosis.GitHubReads()
        paths.add("/issues")
        self.assertEqual(reader.allowed_paths, recovery.GITHUB_PATHS)
        self.assertEqual(default.allowed_paths, frozenset(diagnosis.GITHUB_PATHS))
        for client, path in ((reader, "/issues"), (default, f"/actions/artifacts/{recovery.PACKAGE_ARTIFACT}")):
            with self.assertRaises(diagnosis.DiagnosisError):
                client.get(path)

    def test_cli_failure_report_never_exposes_credentials(self):
        output = self.directory / "recovery.json"
        with patch.object(diagnosis, "GitHubReads", side_effect=ValueError("SECRET_URL_AND_TOKEN")):
            self.assertEqual(recovery.main(["--package-dir", str(self.directory), "--report", str(output)]), 1)
        report = json.loads(output.read_text())
        self.assertEqual(report["status"], "Failed")
        self.assertTrue(report["livePreflight"])
        self.assertFalse(report["liveSubmission"])
        self.assertEqual(report["recoveryStage"], "GitHubAuthentication")
        self.assertNotIn("SECRET", output.read_text())

    def test_malformed_manifest_fails_with_sanitized_report_before_store_authentication(self):
        with zipfile.ZipFile(self.package, "w") as bundle:
            bundle.writestr("AppxManifest.xml", "<Package>SECRET_MALFORMED_XML")
        self.write_report()
        output = self.directory / "malformed.json"
        reader = Mock()
        reader.get.side_effect = lambda path: copy.deepcopy(self.github[path])
        with patch.object(diagnosis, "GitHubReads", return_value=reader), patch.object(store, "StoreApi") as factory:
            self.assertEqual(recovery.main(["--package-dir", str(self.directory), "--report", str(output)]), 1)
        factory.assert_not_called()
        report = json.loads(output.read_text())
        self.assertEqual(report["status"], "Failed")
        self.assertEqual(report["recoveryStage"], "QualifiedPackage")
        self.assertNotIn("SECRET", output.read_text())

    def test_direct_cli_help_does_not_require_pythonpath_credentials_or_project_cwd(self):
        environment = {key: value for key, value in os.environ.items()
            if key not in {"PYTHONPATH", "GITHUB_TOKEN", "MS_STORE_TENANT_ID", "MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET"}}
        result = subprocess.run([sys.executable, str(diagnosis.ROOT / "tools/resume_store_release.py"), "--help"],
            cwd=self.directory, env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--preflight", result.stdout)
        self.assertIn("--submit", result.stdout)


class StoreRecoveryWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load((diagnosis.ROOT / ".github/workflows/store-recovery.yml").read_text(encoding="utf-8"))
        cls.job = cls.workflow["jobs"]["resume"]
        cls.steps = cls.job["steps"]

    def test_actual_push_selector_and_first_guard_accept_only_valid_recovery_attempt_tags(self):
        triggers = self.workflow.get("on", self.workflow.get(True))
        patterns = triggers["push"]["tags"]
        guard_index, guard = next((index, step) for index, step in enumerate(self.steps)
            if "run" in step and "$GITHUB_REF" in step["run"])
        shell_pattern = re.search(r'\[\[ ! "\$GITHUB_REF" =~ (\S+) \]\]', guard["run"]).group(1)
        for tag, expected in (
            ("v-store-recovery-0.1.05-1", True), ("v-store-recovery-0.1.05-2", True),
            ("v-store-recovery-0.1.05-10", True), ("v0.1.05", False),
            ("v0.1.06", False), ("v-store-recovery-0.1.06-1", False),
            ("v-store-recovery-0.1.05-0", False), ("v-store-recovery-0.1.05-01", False),
            ("v-store-recovery-0.1.05-1-extra", False), ("v-store-recovery-0.1.05-", False),
            ("ai-runtime-v0.0.16", False), ("develop", False),
        ):
            with self.subTest(tag=tag):
                accepted = any(fnmatch.fnmatchcase(tag, pattern) for pattern in patterns)
                accepted = accepted and re.fullmatch(shell_pattern, "refs/tags/" + tag) is not None
                self.assertEqual(accepted, expected)
        download_index = next(index for index, step in enumerate(self.steps)
            if step.get("with", {}).get("name") == "microsoft-store-package")
        self.assertLess(guard_index, download_index)
        self.assertIn("exit 1", guard["run"])

    def test_store_enabled_gate_protected_environment_read_permissions_and_serialized_group(self):
        for enabled, expected in (("true", True), ("false", False), ("", False), ("TRUE", False)):
            with self.subTest(enabled=enabled):
                self.assertEqual(evaluate_condition(self.job["if"], {"vars.OPENSTUDIO_STORE_ENABLED": enabled}), expected)
        self.assertEqual(self.job["environment"], "microsoft-store")
        self.assertEqual(self.workflow["permissions"], {"contents": "read", "actions": "read"})
        self.assertNotIn("permissions", self.job)
        release = yaml.safe_load((diagnosis.ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
        self.assertEqual(self.job["concurrency"], release["jobs"]["submit-store"]["concurrency"])
        self.assertFalse(self.job["concurrency"]["cancel-in-progress"])
        self.assertLessEqual(self.job["timeout-minutes"], 25)
        self.assertFalse(self.steps[0]["with"]["persist-credentials"])

    def test_qualified_original_run_package_preflight_then_submit_without_build_or_publication(self):
        download = [(index, step) for index, step in enumerate(self.steps)
            if step.get("with", {}).get("name") == "microsoft-store-package"]
        self.assertEqual(len(download), 1)
        download_index, artifact = download[0]
        self.assertTrue(artifact["uses"].startswith("actions/download-artifact@"))
        self.assertEqual(artifact["with"]["run-id"], diagnosis.RUN)
        self.assertEqual(artifact["with"]["path"], "dist/store")
        self.assertEqual(artifact["with"]["github-token"], "${{ github.token }}")
        commands = [(index, step, shlex.split(step["run"])) for index, step in enumerate(self.steps)
            if "run" in step and "tools/resume_store_release.py" in step["run"]]
        self.assertEqual(len(commands), 2)
        preflight_index, preflight, preflight_args = commands[0]
        submit_index, submit, submit_args = commands[1]
        self.assertLess(download_index, preflight_index)
        self.assertLess(preflight_index, submit_index)
        self.assertEqual(preflight_args, ["python3", "tools/resume_store_release.py", "--package-dir", "dist/store",
            "--report", "output/store-recovery-preflight.json", "--preflight"])
        self.assertEqual(submit_args, ["python3", "tools/resume_store_release.py", "--package-dir", "dist/store",
            "--report", "output/store-recovery-submission.json", "--submit"])
        expected_environment = {"GITHUB_TOKEN": "${{ github.token }}",
            **{name: "${{ secrets." + name + " }}" for name in ("MS_STORE_TENANT_ID", "MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET")}}
        self.assertEqual(preflight["env"], expected_environment)
        self.assertEqual(submit["env"], expected_environment)
        self.assertNotIn("if", preflight)
        self.assertNotIn("if", submit)
        self.assertFalse(preflight.get("continue-on-error", False))
        self.assertFalse(submit.get("continue-on-error", False))
        self.assertEqual(len([step for step in self.steps if "run" in step]), 3)
        for step in self.steps:
            self.assertNotIn("actions/create-release", step.get("uses", ""))
            self.assertNotIn("softprops/action-gh-release", step.get("uses", ""))
            if "run" in step:
                self.assertFalse(re.search(r"\b(cmake|npm|gh\s+release|build\.py)\b", step["run"]))


if __name__ == "__main__":
    unittest.main()
