#!/usr/bin/env python3
"""Keep source coverage inventory complete; inventory membership is not a test pass."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'docs/ui-coverage-inventory.json'

def discover():
    entries = []
    for file in sorted((ROOT / 'frontend/src/components').rglob('*.tsx')):
        source = file.relative_to(ROOT).as_posix()
        entries.append({'id': source, 'kind': 'component', 'source': source})
    for file in sorted((ROOT / 'frontend/src').glob('*App.tsx')):
        source = file.relative_to(ROOT).as_posix()
        entries.append({'id': source, 'kind': 'window-shell', 'source': source})
    section = ''
    for line in (ROOT / 'docs/implemented_features.md').read_text().splitlines():
        if line.startswith('## '):
            section = line[3:]
        if not line.startswith('| ') or line.startswith('| Feature'):
            continue
        feature = line.split('|')[1].strip()
        key = hashlib.sha256((section + '/' + feature).encode()).hexdigest()[:16]
        entries.append({'id': 'feature:' + key, 'kind': 'feature', 'section': section,
                        'description': feature, 'source': 'docs/implemented_features.md'})
    return entries

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update', action='store_true', help='Reconcile membership; new items remain untested')
    args = parser.parse_args()
    found = discover()
    previous = json.loads(DEST.read_text()) if DEST.exists() else {'entries': []}
    old = {e['id']: e for e in previous['entries']}
    entries = [{**e, 'coverage': old.get(e['id'], {}).get('coverage', [])} for e in found]
    if args.update:
        DEST.write_text(json.dumps({
            'schemaVersion': 1,
            'meaning': 'Source inventory only. Empty coverage means untested. A component can have multiple surfaces; review tabs, states, context menus and native-only windows separately.',
            'coverageEntryFields': ['scenario', 'environment', 'status', 'evidence', 'sourceRevision'],
            'requiredDimensions': ['empty/populated/error/busy', 'pointer/keyboard/focus', 'layout/scaling', 'undo/save/reopen', 'native integration'],
            'entries': entries,
        }, indent=2) + '\n')
    else:
        expected = {e['id']: {k: v for k, v in e.items() if k != 'coverage'} for e in entries}
        actual = {e['id']: {k: v for k, v in e.items() if k != 'coverage'} for e in previous['entries']}
        if expected != actual or len(old) != len(previous['entries']):
            raise SystemExit('UI coverage inventory is stale; run with --update and review new/removed coverage entries.')
    print(f'Inventory: {sum(e["kind"] == "feature" for e in entries)} declared features, '
          f'{sum(e["kind"] != "feature" for e in entries)} component/window sources; membership is not a test pass.')

if __name__ == '__main__':
    main()
