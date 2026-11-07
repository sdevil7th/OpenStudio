"""Validate/preflight a qualified Snap, or explicitly upload it after release.

Default is offline validation. --preflight only authenticates and reads status.
--submit uploads/releases exactly once; ambiguous failures require inspection.
Credentials and raw authentication responses are never written to reports.
"""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess

SNAP_ID = 'Qde7k3B7zO9NGOR8QIyMUWs8l6z6hkZ7'
HOST = 'https://dashboard.snapcraft.io'
CHANNELS = '/api/v2/snaps/openstudio/channel-map'


def store_request():
    # Use the client shipped with the same Snapcraft installation as the upload.
    from craft_store import UbuntuOneStoreClient, endpoints
    if not os.environ.get("SNAPCRAFT_STORE_CREDENTIALS"):
        raise ValueError("Snap Store credentials are required.")
    client = UbuntuOneStoreClient(base_url=HOST, storage_base_url=HOST, auth_url="https://login.ubuntu.com",
        endpoints=endpoints.U1_SNAP_STORE, application_name="OpenStudio", user_agent="OpenStudio-store-listing/1",
        environment_auth="SNAPCRAFT_STORE_CREDENTIALS", ephemeral=True)

    def request(method, path, **kwargs):
        return client.request(method, HOST + path, timeout=60, **kwargs).json()
    return request


def stable_revision(channels):
    snap = channels["snap"]
    if snap["id"] != SNAP_ID or snap["name"] != "openstudio":
        raise ValueError("Unexpected Snap identity in channel map.")
    rows = [row for row in channels["channel-map"] if row["architecture"] == "amd64" and row["channel"] == "latest/stable"]
    if not rows or (len(rows) == 1 and rows[0]["revision"] is None):
        return None
    if len(rows) != 1:
        raise ValueError("Ambiguous stable channel.")
    matches = [row for row in channels["revisions"] if row["revision"] == rows[0]["revision"]]
    if len(matches) != 1:
        raise ValueError("Stable channel is missing an unambiguous revision record.")
    return matches[0]


def file_digest(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(directory, version):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected an exact stable application version')
    report = json.loads((directory / 'qualification.json').read_text())
    package = directory / 'openstudio.snap'
    metadata = report.get('elfMetadata')
    if (not isinstance(metadata, dict) or metadata.get('status') != 'pass'
            or metadata.get('runtimeNoteIntegrity') != 'pass'
            or type(metadata.get('runtimeElfFiles')) is not int or metadata['runtimeElfFiles'] <= 0):
        raise ValueError('Installed ELF metadata integrity was not qualified')
    if (report.get('status') != 'pass' or report.get('version') != version
            or report.get('diagnosticSourceRun')
            or report.get('snapName') != 'openstudio' or report.get('snapId') != SNAP_ID
            or report.get('publisher') != 'sdevil7th' or report.get('published') is not False
            or report.get('supportLaunch') != 'explicit_only'
            or report.get('installedDesktopAndExports') != 'pass' or report.get('storeUpdates') != 'pass'):
        raise ValueError('Missing or mismatched installed-Snap qualification')
    if file_digest(package, "sha256") != report.get('snapSha256'):
        raise ValueError('Snap changed after installation qualification')
    return package, report


def run(directory, version, tag, *, preflight=False, submit=False, approval_url='', command=subprocess.run, request=None):
    package, report = validate(directory, version)
    result = {'version': version, 'releaseTag': tag, 'snapName': 'openstudio',
              'snapId': SNAP_ID, 'snapSha256': report['snapSha256'],
              'status': 'validated', 'published': False, 'mutationsPerformed': False}
    if not (preflight or submit):
        return result
    if tag != 'v' + version:
        raise ValueError('Store operations require the exact release tag')
    if not os.environ.get('SNAPCRAFT_STORE_CREDENTIALS'):
        raise ValueError('SNAPCRAFT_STORE_CREDENTIALS is not configured')
    if not re.fullmatch(r'https://forum\.snapcraft\.io/t/(?:[A-Za-z0-9_-]+/)?[1-9]\d*/[1-9]\d*/?', approval_url):
        raise ValueError('Set the permalink to the reviewed Canonical decision post, including its post number.')
    result['classicApprovalRecord'] = approval_url
    for arguments in (['snapcraft', 'whoami'], ['snapcraft', 'status', 'openstudio']):
        process = command(arguments, capture_output=True, text=True, timeout=90)
        if process.returncode:
            raise ValueError('Snap Store authentication/status check failed; inspect account access')
    result['status'] = 'preflight_passed'
    if submit:
        request = request or store_request()
        stable = stable_revision(request("GET", CHANNELS))
        if stable:
            existing = stable["version"]
            if not re.fullmatch(r"\d+\.\d+\.\d+", existing):
                raise ValueError("Unexpected existing stable version. Review the Snap channel.")
            current = tuple(map(int, existing.split(".")))
            target = tuple(map(int, version.split(".")))
            if current > target:
                raise ValueError("The stable Snap is newer than this tag.")
            if current == target:
                sha3 = file_digest(package, "sha3_384")
                if existing != version or stable["sha3-384"] != sha3:
                    raise ValueError("Stable already has this version with different bytes or version spelling.")
                return dict(result, status="already_released", revision=stable["revision"], published=True)
        # An interrupted job may have uploaded a revision still in Store review.
        # Inspect history before another upload, including unreleased revisions.
        page = 1
        while True:
            history = request("GET", "/api/v2/snaps/openstudio/releases", params={"page": str(page)})
            if history["snap"]["id"] != SNAP_ID:
                raise ValueError("Unexpected Snap identity in revision history.")
            if any(row["version"] == version and "amd64" in row["architectures"] for row in history["revisions"]):
                raise ValueError("This version already has a Store revision. Inspect it before another upload.")
            if not history["_links"].get("next"):
                break
            page += 1
        # No automatic retry: a timeout/failed response can still have uploaded a
        # revision. Inspect the dashboard before deciding to retry this job.
        process = command(['snapcraft', 'upload', str(package), '--release=stable'],
                          capture_output=True, text=True, timeout=1200)
        result.update(mutationsPerformed=True, published='not_asserted',
                      status='upload_completed' if process.returncode == 0 else 'upload_failed_or_ambiguous')
        if process.returncode:
            raise RuntimeError('Snap upload failed or is ambiguous; inspect revisions before retrying')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--approval-url', default='')
    parser.add_argument('--report', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--submit', action='store_true')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    try:
        result = run(args.directory, args.version, args.tag, preflight=args.preflight,
                     submit=args.submit, approval_url=args.approval_url)
    except Exception as error:
        result = {'status': 'failed', 'errorType': type(error).__name__,
                  'message': str(error) if isinstance(error, ValueError) else 'Inspect the Snap dashboard before retrying',
                  'published': 'not_asserted' if args.submit else False,
                  'mutationsPerformed': 'not_asserted' if args.submit else False}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['status'] in ('validated', 'preflight_passed', 'upload_completed', 'already_released') else 1)
