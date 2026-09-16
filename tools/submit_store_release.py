"""Validate an OpenStudio MSIX and optionally submit it to Microsoft Store.

Default: offline validation only. --preflight permits authenticated reads;
--submit permits mutations. Initial drafts require an explicit reviewed config.
Secrets come from the environment. Reports never contain bearer tokens or SAS URLs.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

APP_ID = "9N3MQ442VXGW"
IDENTITY = "SouravDas.OpenStudio"
PUBLISHER = "CN=40F9D2C5-1757-4552-B213-B0651C58A9F5"
API = "https://manage.devcenter.microsoft.com/v1.0/my"
ROOT = Path(__file__).resolve().parents[1]
FAILED = {"CommitFailed", "PreProcessingFailed", "CertificationFailed", "PublishFailed", "Canceled"}
ACCEPTED = {"PreProcessing", "Certification", "PendingPublication", "Publishing", "Published", "Release"}
MARKER_PREFIX = "OpenStudio release automation: "
INITIAL_MARKER_PREFIX = "OpenStudio initial draft: "


class StoreError(RuntimeError):
    pass


def package_version(value: str) -> str:
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:\.0)?", value):
        raise StoreError("Store releases require a stable three-part version (or four parts with zero revision).")
    parts = [int(part) for part in value.removeprefix("v").split(".")]
    if len(parts) == 3:
        parts.append(0)
    if any(part > 65535 for part in parts):
        raise StoreError("Store version components must not exceed 65535.")
    return ".".join(map(str, parts))


def version_tuple(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", value):
        raise StoreError("Store returned an invalid package version; refusing to guess ordering.")
    return tuple(map(int, value.split(".")))


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def validated_notes(version: str, path: Path) -> str:
    spec = importlib.util.spec_from_file_location("release_notes_validator", ROOT / "tools/validate-release-notes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate(version, path)


def store_notes(notes: str, tag: str) -> str:
    # The complete reviewed notes remain at the immutable release URL. Keep the
    # Store field within 1500 characters without cutting a sentence mid-word.
    link = f"Full release notes: https://github.com/sdevil7th/OpenStudio/releases/tag/{tag}"
    lines = [re.sub(r"^#{1,6}\s+", "", line) for line in notes.strip().splitlines()]
    text = "\n".join(lines)
    if len(text) + len(link) + 2 <= 1500:
        return text + "\n\n" + link
    kept = []
    for line in lines:
        if len("\n".join(kept + [line])) + len(link) + 2 > 1500:
            break
        kept.append(line)
    return "\n".join(kept).rstrip() + "\n\n" + link


def validate_package(directory: Path, version: str) -> tuple[Path, str]:
    report = json.loads((directory / "package-report.json").read_text(encoding="utf-8-sig"))
    packages = list(directory.glob("*.msix"))
    if len(packages) != 1 or report.get("version") != version:
        raise StoreError("Expected one MSIX and a matching packaging report.")
    package = packages[0]
    sha256 = digest(package)
    if (report.get("sha256", "").lower() != sha256 or report.get("packageValidation") != "pass"
            or report.get("payloadRoundTrip") != "pass"):
        raise StoreError("MSIX hash or packaging validation mismatch.")
    with zipfile.ZipFile(package) as archive:
        entry = archive.getinfo("AppxManifest.xml")
        if entry.file_size > 1024 * 1024:
            raise StoreError("Unexpectedly large manifest.")
        root = ET.fromstring(archive.read(entry))
        ns = {"m": "http://schemas.microsoft.com/appx/manifest/foundation/windows10"}
        identity = root.find("m:Identity", ns)
        if identity is None or any(identity.get(key) != expected for key, expected in {
            "Name": IDENTITY, "Publisher": PUBLISHER, "Version": version, "ProcessorArchitecture": "x64",
        }.items()):
            raise StoreError("MSIX identity, publisher, architecture or version mismatch.")
        families = root.findall("m:Dependencies/m:TargetDeviceFamily", ns)
        if len(families) != 1 or families[0].get("Name") != "Windows.Desktop":
            raise StoreError("Expected the qualified Windows.Desktop package.")
    return package, sha256


def marker(version: str, sha256: str, notes: str) -> str:
    return f"{MARKER_PREFIX}{version}; sha256={sha256}; notes={hashlib.sha256(notes.encode()).hexdigest()}"


def owns(submission: dict, expected: str) -> bool:
    return expected in submission.get("notesForCertification", "").splitlines()


def load_initial_config(path: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    if (not isinstance(config, dict) or set(config) != {
            "appId", "submissionId", "releaseTag", "previousPackageVersion"}
            or not all(isinstance(value, str) for value in config.values())
            or config["appId"] != APP_ID or not re.fullmatch(r"\d+", config["submissionId"])
            or not config["releaseTag"].startswith("v")):
        raise StoreError("Invalid initial-submission configuration.")
    package_version(config["releaseTag"])
    version_tuple(config["previousPackageVersion"])
    return config


def json_digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def initial_settings_digest(submission: dict) -> str:
    # Bind the saved listing/artwork/audience/ratings and other settings to retries.
    # Only the package, English release notes, markers and server status may change.
    settings = copy.deepcopy(submission)
    for key in ("id", "status", "statusDetails", "fileUploadUrl", "applicationPackages"):
        settings.pop(key, None)
    settings["notesForCertification"] = "\n".join(
        line for line in settings.get("notesForCertification", "").splitlines()
        if not line.startswith((MARKER_PREFIX, INITIAL_MARKER_PREFIX))).strip()
    for language, listing in settings.get("listings", {}).items():
        if language.lower() == "en-us":
            listing.get("baseListing", {}).pop("releaseNotes", None)
    return json_digest(settings)


def require_uploaded_assets(value):
    if isinstance(value, dict):
        if "fileStatus" in value and value["fileStatus"] != "Uploaded":
            raise StoreError("Initial draft contains unfinished or deleted assets; finish reviewing it in Partner Center.")
        for child in value.values():
            require_uploaded_assets(child)
    elif isinstance(value, list):
        for child in value:
            require_uploaded_assets(child)


def initial_marker(config: dict, submission: dict) -> str:
    return f"{INITIAL_MARKER_PREFIX}{json_digest(config)}; settings={initial_settings_digest(submission)}"


def validate_initial_resume(pending: dict, config: dict, package: Path, notes: str, expected: str):
    release_markers = [line for line in pending.get("notesForCertification", "").splitlines()
                       if line.startswith(MARKER_PREFIX)]
    if (pending.get("id") != config["submissionId"] or pending.get("targetPublishMode") != "Manual"
            or release_markers != [expected]):
        raise StoreError("Initial submission identity, release marker or manual publishing hold changed.")
    markers = [line for line in pending.get("notesForCertification", "").splitlines()
               if line.startswith(INITIAL_MARKER_PREFIX)]
    if markers != [initial_marker(config, pending)]:
        raise StoreError("Initial submission settings/artwork or configuration changed; refusing to resume.")
    if pending.get("status") == "PendingCommit":
        packages = pending.get("applicationPackages", [])
        old = [item for item in packages if item.get("fileStatus") == "PendingDelete"]
        new = [item for item in packages if item.get("fileStatus") == "PendingUpload"]
        if (len(packages) != 2 or len(old) != 1 or len(new) != 1
                or old[0].get("version") != config["previousPackageVersion"]
                or new[0].get("fileName") != package.name):
            raise StoreError("Initial submission package replacement changed; refusing to upload or commit.")
        english = [value for language, value in pending.get("listings", {}).items() if language.lower() == "en-us"]
        if len(english) != 1 or english[0].get("baseListing", {}).get("releaseNotes") != notes:
            raise StoreError("Initial submission release notes changed; refusing to commit.")


def prepare_initial_submission(pending: dict, config: dict, package: Path, version: str,
                               notes: str, expected: str) -> dict:
    if pending.get("id") != config["submissionId"] or pending.get("targetPublishMode") != "Manual":
        raise StoreError("Initial draft identity or manual publishing hold does not match.")
    if pending.get("status") != "PendingCommit":
        raise StoreError("The initial draft is not editable; automation will not cancel certification.")
    if any(line.startswith((MARKER_PREFIX, INITIAL_MARKER_PREFIX))
           for line in pending.get("notesForCertification", "").splitlines()):
        raise StoreError("Initial draft belongs to another artifact or release; refusing to overwrite it.")
    packages = pending.get("applicationPackages", [])
    if (len(packages) != 1 or packages[0].get("version") != config["previousPackageVersion"]
            or version_tuple(version) <= version_tuple(config["previousPackageVersion"])):
        raise StoreError("Initial draft package version/coverage differs from the reviewed configuration.")
    require_uploaded_assets(pending)
    english = [value for language, value in pending.get("listings", {}).items() if language.lower() == "en-us"]
    if len(english) != 1 or not english[0].get("baseListing", {}).get("images"):
        raise StoreError("Initial draft must contain the saved English listing artwork.")
    updated = copy.deepcopy(pending)
    updated["notesForCertification"] = (updated.get("notesForCertification", "").rstrip()
                                         + "\n" + initial_marker(config, pending)).strip()
    return prepare_submission(updated, package, notes, expected)


def prepare_submission(submission: dict, package: Path, notes: str, expected: str) -> dict:
    updated = copy.deepcopy(submission)
    packages = updated.get("applicationPackages", [])
    replaced = 0
    retained = []
    for item in packages:
        if item.get("fileStatus") == "PendingDelete":
            continue
        families = item.get("targetDeviceFamilies", [])
        if item.get("architecture", "").lower() == "x64" and families and all(
                family.startswith("Windows.Desktop ") for family in families):
            item["fileStatus"] = "PendingDelete"
            replaced += 1
        retained.append(item)
    if replaced != 1:
        raise StoreError("Expected exactly one existing x64 desktop package; review Store package coverage manually.")
    retained.append({"fileName": package.name, "fileStatus": "PendingUpload",
                     "minimumDirectXVersion": "None", "minimumSystemRam": "None"})
    updated["applicationPackages"] = retained
    listings = updated.get("listings", {})
    english = [value for language, value in listings.items() if language.lower() == "en-us"]
    if len(english) != 1 or "baseListing" not in english[0]:
        raise StoreError("The existing en-us Store listing is required.")
    english[0]["baseListing"]["releaseNotes"] = notes
    explanation = [line for line in updated.get("notesForCertification", "").splitlines()
                   if not line.startswith(MARKER_PREFIX)]
    updated["notesForCertification"] = "\n".join(explanation + [expected]).strip()
    if len(updated["notesForCertification"]) > 2000:
        raise StoreError("Certification notes plus automation marker exceed 2000 characters; shorten the notes first.")
    return updated


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class StoreApi:
    def __init__(self):
        self.credentials = [os.environ.get(name, "") for name in
                            ("MS_STORE_TENANT_ID", "MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET")]
        if not all(self.credentials):
            raise StoreError("Configure MS_STORE_TENANT_ID, MS_STORE_CLIENT_ID and MS_STORE_CLIENT_SECRET in GitHub.")
        if not all(re.fullmatch(r"[0-9a-fA-F-]{36}", value) for value in self.credentials[:2]):
            raise StoreError("Tenant ID and client ID must be GUIDs.")
        self.opener = urllib.request.build_opener(NoRedirect())
        self.token = ""
        self.token_until = 0.0

    def _open(self, request, *, json_response=True):
        try:
            with self.opener.open(request, timeout=180) as response:
                return json.loads(response.read()) if json_response else None
        except urllib.error.HTTPError as error:
            # Server error bodies and URLs can include tokens/SAS signatures.
            raise StoreError(f"Microsoft request failed with HTTP {error.code}. Inspect Partner Center; no submission was deleted.") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise StoreError("Microsoft request failed or timed out. Its result may be ambiguous; rerun to inspect/resume, not create blindly.") from None

    def request(self, method: str, path: str, body=None):
        if time.monotonic() >= self.token_until:
            tenant, client, secret = self.credentials
            form = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client,
                                           "client_secret": secret, "resource": "https://manage.devcenter.microsoft.com"}).encode()
            result = self._open(urllib.request.Request(f"https://login.microsoftonline.com/{tenant}/oauth2/token",
                data=form, headers={"Content-Type": "application/x-www-form-urlencoded"}))
            self.token = result["access_token"]
            self.token_until = time.monotonic() + min(3000, int(result.get("expires_in", 3600)) - 60)
        data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
        return self._open(urllib.request.Request(API + path, method=method, data=data,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}))

    def upload(self, url: str, archive: Path):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or not (parsed.hostname or "").endswith(".blob.core.windows.net")
                or parsed.username or parsed.password or parsed.port not in (None, 443) or not parsed.query):
            raise StoreError("Store returned an unexpected upload destination.")
        # Streaming upload: never load a several-hundred-MB MSIX into memory.
        with archive.open("rb") as stream:
            self._open(urllib.request.Request(url, method="PUT", data=stream, headers={
                "Content-Length": str(archive.stat().st_size), "Content-Type": "application/zip",
                "x-ms-blob-type": "BlockBlob", "x-ms-version": "2021-12-02",
            }), json_response=False)


def submission_path(submission_id: str) -> str:
    if not re.fullmatch(r"\d+", submission_id):
        raise StoreError("Invalid submission ID returned by Microsoft.")
    return f"/applications/{APP_ID}/submissions/{submission_id}"


def submit(api, package: Path, version: str, sha256: str, notes: str, record,
           *, initial_config=None, release_tag=None, preflight_only=False, max_polls=40, sleep=time.sleep):
    base = f"/applications/{APP_ID}"
    expected = marker(version, sha256, notes)
    if digest(package) != sha256:
        raise StoreError("Package changed after validation; refusing to contact the Store.")
    app = api.request("GET", base)
    if app.get("id") != APP_ID or app.get("packageIdentityName") != IDENTITY or app.get("publisherName") != PUBLISHER:
        raise StoreError("Partner Center app identity does not match OpenStudio.")
    published_id = (app.get("lastPublishedApplicationSubmission") or {}).get("id")
    pending_id = (app.get("pendingApplicationSubmission") or {}).get("id")
    initial = not published_id
    if not published_id:
        if (not initial_config or pending_id != initial_config["submissionId"]
                or release_tag != initial_config["releaseTag"]
                or version != package_version(initial_config["releaseTag"])):
            raise StoreError("No published baseline: an exact initial draft and release tag must be explicitly configured.")
        pending = api.request("GET", submission_path(pending_id))
        if owns(pending, expected):
            validate_initial_resume(pending, initial_config, package, notes, expected)
        else:
            prepared = prepare_initial_submission(pending, initial_config, package, version, notes, expected)
            if preflight_only:
                record(submissionId=pending_id, status="PreflightPassed", initialSubmission=True)
                return
            # Detect edits made since the initial read before adopting the draft.
            current = api.request("GET", submission_path(pending_id))
            if (current.get("status") != "PendingCommit" or current.get("id") != pending_id
                    or initial_settings_digest(current) != initial_settings_digest(pending)
                    or current.get("applicationPackages") != pending.get("applicationPackages")
                    or current.get("notesForCertification") != pending.get("notesForCertification")):
                raise StoreError("Initial draft changed during preflight; no changes were made.")
            api.request("PUT", submission_path(pending_id), prepared)
            # Read back the server's state and current upload URL; never assume PUT succeeded.
            pending = api.request("GET", submission_path(pending_id))
            validate_initial_resume(pending, initial_config, package, notes, expected)
    else:
        published = api.request("GET", submission_path(published_id))
        if owns(published, expected):
            record(submissionId=published_id, status="Published", alreadySubmitted=True)
            return
        for item in published.get("applicationPackages", []):
            if item.get("fileStatus") != "PendingDelete" and version_tuple(item.get("version", "")) >= version_tuple(version):
                raise StoreError("The Store already has this version or a newer version. Publish a higher version.")
        if pending_id:
            pending = api.request("GET", submission_path(pending_id))
            if not owns(pending, expected):
                raise StoreError("An unrelated or unmarked submission is pending. Resolve it manually; automation will not overwrite or delete it.")
        else:
            # Validate preservation/coverage/notes before making the first mutation.
            prepare_submission(published, package, notes, expected)
            if preflight_only:
                record(status="PreflightPassed", initialSubmission=False)
                return
            pending = api.request("POST", base + "/submissions")
            pending_id = pending["id"]
            record(submissionId=pending_id, status="Created")
            pending = prepare_submission(pending, package, notes, expected)
            api.request("PUT", submission_path(pending_id), pending)
    path = submission_path(pending_id)
    status = pending.get("status")
    if status in FAILED:
        raise StoreError(f"Existing submission is {status}; inspect certification details before retrying.")
    if status not in ACCEPTED | {"PendingCommit", "CommitStarted"}:
        raise StoreError("Unexpected submission state; inspect Partner Center before continuing.")
    record(submissionId=pending_id, status="PreflightPassed" if preflight_only else status, initialSubmission=initial)
    if preflight_only:
        return
    if status == "PendingCommit":
        # Safe to re-upload the same hash-bound ZIP after an interrupted upload.
        with tempfile.TemporaryDirectory(prefix="openstudio-store-") as temp:
            archive = Path(temp) / "submission.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
                bundle.write(package, package.name)
            api.upload(pending["fileUploadUrl"], archive)
        api.request("POST", path + "/commit")
        record(status="CommitStarted")
    elif status not in ACCEPTED | {"CommitStarted"}:
        raise StoreError("Unexpected submission state; inspect Partner Center before continuing.")
    for attempt in range(max_polls):
        result = api.request("GET", path + "/status")
        status = result.get("status", "Unknown")
        details = result.get("statusDetails", {})
        # Keep codes, not arbitrary server text or credential-bearing report URLs.
        record(status=status, errorCodes=[item.get("code") for item in details.get("errors", [])],
               warningCodes=[item.get("code") for item in details.get("warnings", [])])
        if status in FAILED:
            raise StoreError(f"Microsoft submission reached {status}. Inspect Partner Center for details.")
        if status in ACCEPTED:
            return
        if status != "CommitStarted":
            raise StoreError("Unexpected status while waiting for ingestion; inspect Partner Center.")
        if attempt + 1 < max_polls:
            sleep(15)
    raise StoreError("Submission is still processing. It has not been resubmitted; rerun the failed job to check its status.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--package-dir", type=Path)
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--report", type=Path, default=Path("output/store-submission.json"))
    parser.add_argument("--print-package-version", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--submit", action="store_true")
    mode.add_argument("--preflight", action="store_true", help="Authenticate and inspect readiness without modifying the Store.")
    parser.add_argument("--initial-submission-config", type=Path)
    args = parser.parse_args()
    report = {"appId": APP_ID, "liveSubmission": args.submit, "livePreflight": args.preflight}

    def record(**values):
        report.update(values)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    try:
        version = package_version(args.version)
        if args.print_package_version:
            print(version)
            return 0
        if not args.package_dir or not args.notes_file:
            raise StoreError("--package-dir and --notes-file are required.")
        package, sha256 = validate_package(args.package_dir, version)
        notes = validated_notes(args.version, args.notes_file)
        tag = "v" + args.version.removeprefix("v")
        notes = store_notes(notes, tag)
        record(version=version, sha256=sha256, releaseTag=tag, status="Validated", releaseNotes=notes)
        config = load_initial_config(args.initial_submission_config) if args.initial_submission_config else None
        if args.submit or args.preflight:
            submit(StoreApi(), package, version, sha256, notes, record, initial_config=config,
                   release_tag=tag, preflight_only=args.preflight)
        print(f"Store release: {report['status']}; report: {args.report}")
        return 0
    except (StoreError, OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        # Only StoreError is authored/sanitized; parser/file/API internals may
        # contain untrusted content or secrets. Do not print their raw values.
        message = str(error) if isinstance(error, StoreError) else "Input or API response validation failed. Check package/report/notes and Partner Center."
        record(error=message)
        print(message, file=sys.stderr)
        return 1
    finally:
        if os.environ.get("GITHUB_STEP_SUMMARY") and not args.print_package_version:
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
                summary.write(f"### Microsoft Store\n\nStatus: {report.get('status', 'Validation failed')}\n\n"
                              f"Submission ID: {report.get('submissionId', 'Not created')}\n\n"
                              "This is submission status, not proof of certification or a Store-delivered upgrade.\n")


if __name__ == "__main__":
    sys.exit(main())
