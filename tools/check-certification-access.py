"""Read-only certification prerequisites. Never creates, commits or publishes a submission."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def apple_access():
    names = ('MACOS_CERTIFICATE_BASE64', 'MACOS_CERTIFICATE_PASSWORD',
             'MACOS_CODESIGN_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD')
    present = {}
    for name in names:
        value = os.environ.get(name, '')
        if not value and os.environ.get('DOPPLER_TOKEN'):
            result = subprocess.run(['doppler', 'secrets', 'get', name, '--plain'],
                                    capture_output=True, text=True, timeout=30)
            value = result.stdout.strip() if result.returncode == 0 else ''
        present[name] = bool(value)
    return {'status': 'configured' if all(present.values()) else 'blocked',
            'presenceOnly': present, 'credentialsValidated': False,
            'notarization': 'not_performed', 'published': False}


def store_access():
    from submit_store_release import StoreApi, StoreError, APP_ID, IDENTITY, PUBLISHER, submission_path
    class ReadOnlyApi(StoreApi):
        def request(self, method, path, body=None):
            if method != 'GET' or body is not None:
                raise StoreError('Certification access inspection only permits GET requests.')
            return super().request(method, path)
    api = ReadOnlyApi()
    app = api.request('GET', '/applications/' + APP_ID)
    if app.get('packageIdentityName') != IDENTITY or app.get('publisherName') != PUBLISHER:
        raise StoreError('Unexpected Store application identity.')
    result = {'status': 'accessible', 'applicationId': APP_ID, 'submissions': {},
              'candidateVersion': '0.1.9.0', 'certification': 'not_performed',
              'mutationsPerformed': False, 'published': False}
    for kind in ('lastPublishedApplicationSubmission', 'pendingApplicationSubmission'):
        submission_id = (app.get(kind) or {}).get('id')
        if submission_id:
            submission = api.request('GET', submission_path(submission_id))
            result['submissions'][kind] = {
                'id': submission_id, 'status': submission.get('status'),
                'targetPublishMode': submission.get('targetPublishMode'),
                'packages': [{key: item.get(key) for key in ('version', 'fileStatus', 'fileName')}
                             for item in submission.get('applicationPackages', [])]}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=('apple', 'store'))
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = apple_access() if args.platform == 'apple' else store_access()
    except Exception as error:
        # Do not serialize API bodies, URLs, credentials or subprocess output.
        result = {'status': 'blocked', 'errorType': type(error).__name__,
                  'mutationsPerformed': False, 'published': False}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
