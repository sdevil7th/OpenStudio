"""Read the fixed failed v0.1.05 Store draft after verifying its release provenance.

This one-release diagnostic cannot upload, update, commit or delete a submission.
Reports contain field paths, types, hashes and comparisons, never field values.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

if __package__ in {None, ""}:
    import submit_store_release as store
else:
    from . import submit_store_release as store

REPOSITORY = "sdevil7th/OpenStudio"
TAG = "v0.1.05"
SOURCE = "649012c77f86eb9cbfee616bd16a588576c63112"
RUN = 37790026737
RELEASE = 406933927
BASELINE = "1152921505701841400"
DRAFT = "1152921505702075647"
VERSION = "0.1.5.0"
PACKAGE = "OpenStudio-0.1.5.0-x64.msix"
PACKAGE_SHA = "e816fb874fa50168042cfb064d1364570e0d07f3a3812cce8508f77efcc60eb1"
NOTES_SHA = "2eb9b4ded404d3a5558c3801363880d6c5db7f668b334f7768261097bc1a010e"
READINESS_ARTIFACT = 11557158416
READINESS_SHA = "5e8f135946a36e480b2dc7c7a975df73b7ee84a877209a93f0a3e358a3db1552"
NOTES_PATH = "docs/releases/0.1.05.md"
ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE = 4 * 1024 * 1024
MAX_DIFFERENCES = 200
MAX_NODES = 50000
MAX_DEPTH = 32
MISSING = object()
JOB_OUTCOMES = {
    "validate-release-notes": (113354644926, "success"),
    "build-windows": (113354711770, "success"),
    "build-macos": (113354712024, "success"),
    "build-linux": (113354712043, "success"),
    "Check Store readiness before publication": (113367695369, "success"),
    "publish": (113368272952, "success"),
    "Trigger website release publication": (113369135241, "success"),
    "Submit Microsoft Store release": (113369136574, "failure"),
}
GITHUB_PATHS = {
    f"/git/ref/tags/{TAG}", f"/releases/tags/{TAG}", f"/actions/runs/{RUN}",
    f"/actions/runs/{RUN}/jobs?per_page=100&filter=latest",
    f"/actions/artifacts/{READINESS_ARTIFACT}", f"/contents/{NOTES_PATH}?ref={SOURCE}",
}
STORE_PATHS = {f"/applications/{store.APP_ID}", store.submission_path(BASELINE), store.submission_path(DRAFT)}


class DiagnosisError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise DiagnosisError(message)


def value_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def line_endings_equal(left, right):
    return isinstance(left, str) and isinstance(right, str) and left.replace("\r\n", "\n") == right.replace("\r\n", "\n")


class GitHubReads:
    def __init__(self, *, allowed_paths=None):
        paths = frozenset(GITHUB_PATHS if allowed_paths is None else allowed_paths)
        require(bool(paths) and all(isinstance(path, str) and path.startswith("/")
            and not path.startswith("//") and ".." not in path
            and re.fullmatch(r"/[A-Za-z0-9_./?=&+-]+", path) for path in paths),
            "Release provenance paths must be fixed relative repository API routes.")
        self.allowed_paths = paths
        self.token = os.environ.get("GITHUB_TOKEN", "")
        require(bool(self.token), "GITHUB_TOKEN is required for release provenance reads.")
        self.opener = urllib.request.build_opener(store.NoRedirect())

    def get(self, path):
        require(path in self.allowed_paths, "Only fixed release provenance GET requests are allowed.")
        request = urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + path,
            method="GET", headers={"Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
            require(len(raw) <= MAX_RESPONSE, "Release provenance response exceeds the bounded read limit.")
            result = json.loads(raw)
            require(isinstance(result, dict), "Release provenance response must be an object.")
            return result
        except urllib.error.HTTPError as error:
            raise DiagnosisError(f"Release provenance GET failed with HTTP {error.code}.") from None
        except (urllib.error.URLError, OSError, TimeoutError, ValueError):
            raise DiagnosisError("Release provenance GET failed or returned invalid JSON.") from None


def verify_release(get, notes, stage=lambda _: None):
    stage("ReviewedNotes")
    require(hashlib.sha256(notes.encode()).hexdigest() == NOTES_SHA, "Reviewed v0.1.05 notes differ from the released source.")
    stage("ReleaseTag")
    tag = get(f"/git/ref/tags/{TAG}")
    require(tag.get("ref") == "refs/tags/" + TAG and isinstance(tag.get("object"), dict) and tag["object"].get("type") == "commit"
            and tag["object"].get("sha") == SOURCE, "The fixed release tag/source identity changed.")
    stage("PublishedRelease")
    release = get(f"/releases/tags/{TAG}")
    require(release.get("id") == RELEASE and release.get("tag_name") == TAG
            and release.get("draft") is False and release.get("prerelease") is False
            and isinstance(release.get("published_at"), str) and bool(release["published_at"])
            and line_endings_equal(release.get("body"), notes), "The fixed release is not published with its reviewed notes.")
    stage("ReleaseRun")
    run = get(f"/actions/runs/{RUN}")
    require(run.get("id") == RUN and run.get("head_sha") == SOURCE and run.get("head_branch") == TAG
            and run.get("event") == "push" and run.get("path") == ".github/workflows/release.yml"
            and run.get("run_attempt") == 1 and run.get("status") == "completed" and run.get("conclusion") == "failure",
            "The fixed failed release run/source identity changed.")
    stage("ReleaseJobs")
    jobs = get(f"/actions/runs/{RUN}/jobs?per_page=100&filter=latest")
    rows = jobs.get("jobs", [])
    require(jobs.get("total_count") == len(JOB_OUTCOMES) and len(rows) == len(JOB_OUTCOMES)
            and len({row.get("name") for row in rows}) == len(JOB_OUTCOMES)
            and all(isinstance(row, dict) and row.get("name") in JOB_OUTCOMES
                and (row.get("id"), row.get("conclusion")) == JOB_OUTCOMES[row["name"]]
                and row.get("status") == "completed" for row in rows),
            "The fixed release qualification/submission job outcomes changed.")
    stage("ReadinessArtifact")
    artifact = get(f"/actions/artifacts/{READINESS_ARTIFACT}")
    require(artifact.get("id") == READINESS_ARTIFACT and artifact.get("name") == "microsoft-store-readiness-1"
            and artifact.get("expired") is False and artifact.get("size_in_bytes") == 1111
            and artifact.get("digest") == "sha256:" + READINESS_SHA
            and artifact.get("workflow_run", {}).get("id") == RUN
            and artifact["workflow_run"].get("head_sha") == SOURCE,
            "The qualified Store readiness artifact provenance changed.")
    stage("CommittedNotes")
    source_notes = get(f"/contents/{NOTES_PATH}?ref={SOURCE}")
    require(source_notes.get("type") == "file" and source_notes.get("path") == NOTES_PATH
            and source_notes.get("encoding") == "base64" and isinstance(source_notes.get("content"), str)
            and isinstance(source_notes.get("size"), int) and 0 < source_notes["size"] <= 65536,
            "The committed release notes response is invalid.")
    try:
        raw = base64.b64decode(source_notes["content"].replace("\n", "").replace("\r", ""), validate=True)
        committed = raw.decode("utf-8-sig").replace("\r\n", "\n").strip() + "\n"
    except (ValueError, UnicodeError):
        raise DiagnosisError("The committed release notes encoding is invalid.") from None
    require(len(raw) == source_notes["size"] and committed == notes, "The local reviewed notes do not match the immutable release source.")


class StoreReads:
    def __init__(self, api):
        self.api = api

    def get(self, path):
        require(path in STORE_PATHS, "Only the fixed Store application, published baseline and draft GET requests are allowed.")
        result = self.api.request("GET", path)
        require(isinstance(result, dict), "Store diagnosis response must be an object.")
        require(len(json.dumps(result).encode()) <= MAX_RESPONSE, "Store diagnosis response exceeds the bounded limit.")
        return result


def settings(submission):
    result = copy.deepcopy(submission)
    for key in ("friendlyName", "id", "status", "statusDetails", "fileUploadUrl", "applicationPackages"):
        result.pop(key, None)
    result["notesForCertification"] = "\n".join(line for line in result.get("notesForCertification", "").splitlines()
        if not line.startswith((store.MARKER_PREFIX, store.INITIAL_MARKER_PREFIX))).strip()
    for language, listing in result.get("listings", {}).items():
        if language.lower() == "en-us":
            listing.get("baseListing", {}).pop("releaseNotes", None)
    return result


def differences(left, right):
    result = []
    visited = 0
    count = 0

    def visit(a, b, path, depth):
        nonlocal visited, count
        visited += 1
        require(visited <= MAX_NODES and depth <= MAX_DEPTH, "Store diagnosis structure exceeds the bounded traversal limit.")
        if isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(set(a) | set(b)):
                # JSON schema keys form paths; credential-bearing or malformed keys are hashed.
                safe = key if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,79}", str(key)) else "hashed-key-" + value_digest(key)[:16]
                visit(a.get(key, MISSING), b.get(key, MISSING), path + "/" + safe, depth + 1)
        elif isinstance(a, list) and isinstance(b, list):
            for index in range(max(len(a), len(b))):
                visit(a[index] if index < len(a) else MISSING, b[index] if index < len(b) else MISSING,
                      path + "/" + str(index), depth + 1)
        elif a is MISSING or b is MISSING or type(a) is not type(b) or a != b:
            count += 1
            if len(result) < MAX_DIFFERENCES:
                result.append({"path": path or "/", "preparedType": "missing" if a is MISSING else type(a).__name__,
                    "pendingType": "missing" if b is MISSING else type(b).__name__,
                    "preparedHash": None if a is MISSING else value_digest(a),
                    "pendingHash": None if b is MISSING else value_digest(b),
                    "lineEndingEquivalent": line_endings_equal(a, b)})

    visit(left, right, "", 0)
    return {"count": count, "truncated": count > len(result), "paths": result}


def diagnose(github_get, store_factory, notes, stage=lambda _: None):
    verify_release(github_get, notes, stage)
    stage("StoreAuthentication")
    reads = StoreReads(store_factory())
    stage("StoreApplication")
    app = reads.get(f"/applications/{store.APP_ID}")
    require(app.get("id") == store.APP_ID and app.get("packageIdentityName") == store.IDENTITY
            and app.get("publisherName") == store.PUBLISHER
            and (app.get("lastPublishedApplicationSubmission") or {}).get("id") == BASELINE
            and (app.get("pendingApplicationSubmission") or {}).get("id") == DRAFT,
            "The fixed Store application/baseline/draft identity changed; no mutations performed.")
    stage("PublishedSubmission")
    published = reads.get(store.submission_path(BASELINE))
    stage("PendingSubmission")
    pending = reads.get(store.submission_path(DRAFT))
    stage("StoreComparison")
    notes = store.store_notes(notes, TAG)
    expected = store.marker(VERSION, PACKAGE_SHA, notes)
    prepared = store.prepare_submission(published, Path(PACKAGE), notes, expected, target_publish_mode="Immediate")
    english = [value for language, value in pending.get("listings", {}).items() if language.lower() == "en-us"]
    pending_notes = english[0].get("baseListing", {}).get("releaseNotes") if len(english) == 1 else None
    marker_lines = [line for line in pending.get("notesForCertification", "").splitlines() if line.startswith(store.MARKER_PREFIX)]
    changed = differences(settings(prepared), settings(pending))
    packages = differences(prepared.get("applicationPackages"), pending.get("applicationPackages"))
    return {"appId": store.APP_ID, "releaseTag": TAG, "sourceCommit": SOURCE, "releaseRunId": RUN, "status": "Diagnosed",
        "version": VERSION, "sha256": PACKAGE_SHA, "publishedSubmissionId": BASELINE, "submissionId": DRAFT,
        "readOnly": True, "publishedStatus": store.safe_status(published), "pendingStatus": store.safe_status(pending),
        "publishedIdentityMatches": published.get("id") == BASELINE, "pendingIdentityMatches": pending.get("id") == DRAFT,
        "pendingTargetPublishMode": pending.get("targetPublishMode") if pending.get("targetPublishMode") in {"Immediate", "Manual", "SpecificDate"} else "Unknown",
        "releaseMarkerMatches": store.owns(pending, expected), "releaseMarkerUnique": marker_lines == [expected],
        "certificationNotesEqual": pending.get("notesForCertification") == prepared.get("notesForCertification"),
        "certificationNotesLineEndingEquivalent": line_endings_equal(pending.get("notesForCertification"), prepared.get("notesForCertification")),
        "releaseNotesEqual": pending_notes == notes, "releaseNotesLineEndingEquivalent": line_endings_equal(pending_notes, notes),
        "settingsDigestEqual": store.update_settings_digest(pending) == store.update_settings_digest(prepared),
        "preparedSettingsDigest": store.update_settings_digest(prepared), "pendingSettingsDigest": store.update_settings_digest(pending),
        "settingsDifferences": changed, "packageDifferences": packages,
        "uploadCompletion": "not_asserted", "commitCompletion": "not_asserted"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=Path("output/store-diagnosis.json"))
    args = parser.parse_args(argv)
    current_stage = "ReviewedNotes"

    def stage(value):
        nonlocal current_stage
        current_stage = value

    try:
        notes = store.validated_notes(TAG, ROOT / NOTES_PATH)
        stage("GitHubAuthentication")
        report = diagnose(GitHubReads().get, store.StoreApi, notes, stage)
        status = 0
    except (DiagnosisError, store.StoreError, OSError, ValueError, KeyError, TypeError, RecursionError):
        # API/file errors can carry secrets or untrusted values. Failures remain sanitized.
        report = {"appId": store.APP_ID, "releaseTag": TAG, "sourceCommit": SOURCE, "readOnly": True,
                  "status": "Failed", "diagnosticStage": current_stage,
                  "error": "Fixed-release read-only diagnosis failed; no Store mutation performed."}
        status = 1
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Store diagnosis report written; no Store mutation performed.")
    return status


if __name__ == "__main__":
    sys.exit(main())
