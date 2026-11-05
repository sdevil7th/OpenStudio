"""Validate/preflight a qualified Snap, or explicitly upload it after release.

Default is offline validation. --preflight only authenticates and reads status.
--submit uploads/releases exactly once; ambiguous failures require inspection.
Credentials and raw authentication responses are never written to reports.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SNAP_ID = 'Qde7k3B7zO9NGOR8QIyMUWs8l6z6hkZ7'


def validate(directory, version):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected an exact stable application version')
    report = json.loads((directory / 'qualification.json').read_text())
    package = directory / 'openstudio.snap'
    if (report.get('status') != 'pass' or report.get('version') != version
            or report.get('diagnosticSourceRun')
            or report.get('snapName') != 'openstudio' or report.get('snapId') != SNAP_ID
            or report.get('publisher') != 'sdevil7th' or report.get('published') is not False
            or report.get('supportLaunch') != 'explicit_only'
            or report.get('installedDesktopAndExports') != 'pass' or report.get('storeUpdates') != 'pass'):
        raise ValueError('Missing or mismatched installed-Snap qualification')
    if hashlib.sha256(package.read_bytes()).hexdigest() != report.get('snapSha256'):
        raise ValueError('Snap changed after installation qualification')
    return package, report


def run(directory, version, tag, *, preflight=False, submit=False, approval_url='', command=subprocess.run):
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
    if not re.fullmatch(r'https://forum\.snapcraft\.io/t/[a-zA-Z0-9/_-]+', approval_url):
        raise ValueError('A reviewed Canonical classic-confinement approval URL is required')
    result['classicApprovalRecord'] = approval_url
    for arguments in (['snapcraft', 'whoami'], ['snapcraft', 'status', 'openstudio']):
        process = command(arguments, capture_output=True, text=True, timeout=90)
        if process.returncode:
            raise ValueError('Snap Store authentication/status check failed; inspect account access')
    result['status'] = 'preflight_passed'
    if submit:
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
    raise SystemExit(0 if result['status'] in ('validated', 'preflight_passed', 'upload_completed') else 1)
