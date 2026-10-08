"""Resume only the already-created draft for the immutable v0.1.05 release.

The default is authenticated preflight. --submit permits uploading the exact
qualified package and committing that existing draft, never creating or editing one.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

if __package__ in {None, ""}:
    import diagnose_store_submission as diagnosis
    import submit_store_release as store
else:
    from . import diagnose_store_submission as diagnosis
    from . import submit_store_release as store

PACKAGE_ARTIFACT = 11557232399
PACKAGE_ARTIFACT_SIZE = 431688606
PACKAGE_ARTIFACT_SHA = "4b8710d3839ac99c3681c3f445ba7a79d69bdb3420269f1389328eac3952f7a7"
PACKAGE_SHA = diagnosis.PACKAGE_SHA
GITHUB_PATHS = frozenset(diagnosis.GITHUB_PATHS | {f"/actions/artifacts/{PACKAGE_ARTIFACT}"})
APP_PATH = f"/applications/{store.APP_ID}"
BASELINE_PATH = store.submission_path(diagnosis.BASELINE)
DRAFT_PATH = store.submission_path(diagnosis.DRAFT)
STORE_GET_PATHS = frozenset({APP_PATH, BASELINE_PATH, DRAFT_PATH, DRAFT_PATH + "/status"})


class RecoveryError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise RecoveryError(message)


def verify_package_artifact(get):
    artifact = get(f"/actions/artifacts/{PACKAGE_ARTIFACT}")
    require(artifact.get("id") == PACKAGE_ARTIFACT and artifact.get("name") == "microsoft-store-package"
        and artifact.get("expired") is False and artifact.get("size_in_bytes") == PACKAGE_ARTIFACT_SIZE
        and artifact.get("digest") == "sha256:" + PACKAGE_ARTIFACT_SHA
        and artifact.get("workflow_run", {}).get("id") == diagnosis.RUN
        and artifact["workflow_run"].get("head_sha") == diagnosis.SOURCE
        and artifact["workflow_run"].get("head_branch") == diagnosis.TAG,
        "The immutable release's qualified Store package artifact changed.")


class ResumeOnlyApi:
    """Expose fixed reads and one existing-draft commit to the normal submitter."""

    def __init__(self, api, package: Path, sha256: str, *, allow_submit=False):
        self.api = api
        self.package = package
        self.sha256 = sha256
        self.allow_submit = allow_submit
        self.upload_url = None
        self.upload_completed = False

    def request(self, method, path, body=None):
        if method == "GET":
            require(path in STORE_GET_PATHS and body is None, "Only fixed recovery Store GET requests are allowed.")
        elif method == "POST":
            require(path == DRAFT_PATH + "/commit" and body is None and self.allow_submit and self.upload_completed,
                "Only the existing draft's commit after its validated upload is allowed.")
        else:
            raise RecoveryError("Recovery cannot create, edit or delete any Store submission.")
        result = self.api.request(method, path, body) if body is not None else self.api.request(method, path)
        require(isinstance(result, dict) and len(json.dumps(result).encode()) <= diagnosis.MAX_RESPONSE,
            "Store recovery response is invalid or exceeds the bounded limit.")
        if method == "GET" and path == APP_PATH:
            require(result.get("id") == store.APP_ID and result.get("packageIdentityName") == store.IDENTITY
                and result.get("publisherName") == store.PUBLISHER, "The fixed Store application identity changed.")
            published = (result.get("lastPublishedApplicationSubmission") or {}).get("id")
            pending = (result.get("pendingApplicationSubmission") or {}).get("id")
            require((published == diagnosis.BASELINE and pending == diagnosis.DRAFT)
                or (published == diagnosis.DRAFT and pending is None),
                "The fixed published baseline or recovery draft identity changed.")
        elif method == "GET" and path in {BASELINE_PATH, DRAFT_PATH}:
            require(result.get("id") == (diagnosis.BASELINE if path == BASELINE_PATH else diagnosis.DRAFT),
                "The fixed Store submission identity changed.")
            if path == DRAFT_PATH:
                self.upload_url = result.get("fileUploadUrl")
        return result

    def upload(self, url, archive: Path):
        require(self.allow_submit and isinstance(self.upload_url, str) and url == self.upload_url,
            "Recovery upload requires the existing draft's current upload destination.")
        require(store.digest(self.package) == self.sha256, "The qualified package changed before recovery upload.")
        with zipfile.ZipFile(archive) as bundle:
            require(bundle.namelist() == [diagnosis.PACKAGE], "Recovery ZIP must contain only the qualified MSIX.")
            entry = bundle.getinfo(diagnosis.PACKAGE)
            require(entry.file_size == self.package.stat().st_size and entry.compress_type == zipfile.ZIP_STORED,
                "Recovery ZIP metadata differs from the qualified package.")
            digest = hashlib.sha256()
            with bundle.open(entry) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            require(digest.hexdigest() == self.sha256, "Recovery ZIP does not contain the qualified package bytes.")
        self.api.upload(url, archive)
        self.upload_completed = True


def recover(github_get, store_factory, package_dir: Path, notes: str, publishing: dict, record,
            *, submit=False, stage=lambda _: None, **poll_options):
    diagnosis.verify_release(github_get, notes, stage)
    stage("QualifiedPackageArtifact")
    verify_package_artifact(github_get)
    stage("QualifiedPackage")
    package, sha256 = store.validate_package(package_dir, diagnosis.VERSION)
    require(package.name == diagnosis.PACKAGE and sha256 == PACKAGE_SHA,
        "Recovery requires the exact immutable release's qualified MSIX.")
    stage("PublishingPolicy")
    require(publishing == {"appId": store.APP_ID, "releaseTag": diagnosis.TAG, "targetPublishMode": "Immediate"},
        "Recovery requires the reviewed v0.1.05 Immediate publishing policy.")
    notes = store.store_notes(notes, diagnosis.TAG)
    expected = store.marker(diagnosis.VERSION, sha256, notes)
    record(appId=store.APP_ID, releaseTag=diagnosis.TAG, sourceCommit=diagnosis.SOURCE,
        releaseRunId=diagnosis.RUN, version=diagnosis.VERSION, sha256=sha256,
        packageArtifactId=PACKAGE_ARTIFACT, packageArtifactSha256=PACKAGE_ARTIFACT_SHA,
        originalPublishedSubmissionId=diagnosis.BASELINE, submissionId=diagnosis.DRAFT,
        liveSubmission=submit, livePreflight=not submit, status="Validated")
    stage("StoreAuthentication")
    api = ResumeOnlyApi(store_factory(), package, sha256, allow_submit=submit)
    stage("ExistingDraftValidation")
    api.request("GET", APP_PATH)
    published = api.request("GET", BASELINE_PATH)
    pending = api.request("GET", DRAFT_PATH)
    store.validate_update_resume(pending, published, diagnosis.DRAFT, package, notes, expected,
        target_publish_mode="Immediate")
    require(store.owns(pending, expected), "The existing recovery draft's exact release marker changed.")
    stage("ExistingDraftResume" if submit else "ExistingDraftPreflight")
    store.submit(api, package, diagnosis.VERSION, sha256, notes, record,
        publishing_config=publishing, release_tag=diagnosis.TAG, preflight_only=not submit, **poll_options)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, default=Path("output/store-recovery.json"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true", help="Read-only live validation (the default).")
    mode.add_argument("--submit", action="store_true", help="Upload and commit only the fixed existing release draft.")
    args = parser.parse_args(argv)
    report = {"appId": store.APP_ID, "releaseTag": diagnosis.TAG, "submissionId": diagnosis.DRAFT,
        "liveSubmission": args.submit, "livePreflight": not args.submit}
    current_stage = "ReviewedNotes"

    def stage(value):
        nonlocal current_stage
        current_stage = value

    def record(**values):
        report.update(values)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    try:
        notes = store.validated_notes(diagnosis.TAG, diagnosis.ROOT / diagnosis.NOTES_PATH)
        publishing = store.load_publishing_config(diagnosis.ROOT / "packaging/msix/release-publishing.json")
        stage("GitHubAuthentication")
        recover(diagnosis.GitHubReads(allowed_paths=GITHUB_PATHS).get, store.StoreApi,
            args.package_dir, notes, publishing, record, submit=args.submit, stage=stage)
        print(f"Store recovery: {report['status']}; report: {args.report}")
        return 0
    except (RecoveryError, diagnosis.DiagnosisError, store.StoreError, OSError, ValueError, KeyError,
            TypeError, RecursionError, zipfile.BadZipFile, ET.ParseError):
        record(status="Failed", recoveryStage=current_stage,
            error="Fixed-release Store recovery failed closed; inspect the preserved draft and sanitized evidence.")
        print(f"Store recovery failed at {current_stage}; report: {args.report}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
