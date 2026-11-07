"""Reject missing, mismatched or instrumented application release payloads."""
import argparse
import json
from pathlib import Path


def validate(bundle: Path, version: str) -> None:
    root = Path(bundle)
    if root.suffix == '.app':
        root = root / 'Contents/Resources'
    policy = json.loads((root / 'OpenStudio.build-policy.json').read_text(encoding='utf-8'))
    if policy.get('version') != version or any(policy.get(key) is not False for key in ('callbackDiagnostics', 'araDiagnostics', 'hangMonitoring')):
        raise ValueError('Release packaging requires matching application version and callback/ARA diagnostics and periodic hang monitoring compiled out')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    validate(args.bundle, args.version)
    print('Production callback instrumentation policy verified')
