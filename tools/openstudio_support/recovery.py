"""Read existing recording recovery metadata only while Support is explicitly run."""
from __future__ import annotations

import math
import os
from pathlib import Path
import re
import stat

from .common import check, read_json, regular_file

MAX_NODES = 4096
MAX_JOBS = 128
MAX_BYTES = 16 * 1024 * 1024
JOB_LIMIT = 2 * 1024 * 1024
ID = re.compile(r'[0-9a-f]{32}')
FAULTS = {1: 'write_failed', 2: 'flush_failed', 3: 'seek_failed'}
NUMBERS = ('sampleRate', 'channels', 'bitDepth', 'startTime', 'writtenSamples',
           'droppedSamples', 'createdAt', 'updatedAt')


class InspectionLimit(ValueError):
    pass


def _directory(path):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or path.is_symlink()
            or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)):
        raise ValueError('Recovery directories must not be symbolic links, junctions or special files')


def _children(path, budget):
    _directory(path)
    with os.scandir(path) as children:
        for child in children:
            if budget['nodes'] >= MAX_NODES:
                raise InspectionLimit('Recording recovery directory inspection limit reached')
            budget['nodes'] += 1
            if ID.fullmatch(child.name):
                yield Path(child.path)


def recording_recovery(directories, redactor, result):
    """Fixed WorkRecovery/<session>/<job>/job.json layout, never media traversal.

    The ordinary writer already persists these records, including late header
    failures. Reading them here adds no DAW timers, logging or callback work.
    """
    entries = []
    budget = {'nodes': 0, 'jobs': 0, 'bytes': 0}
    for root in dict.fromkeys(directory / 'WorkRecovery' for directory in directories):
        if not root.exists():
            continue
        try:
            for session in _children(root, budget):
                try:
                    for job in _children(session, budget):
                        path = job / 'job.json'
                        try:
                            _directory(job)
                            info = regular_file(path)
                            if info.st_size > JOB_LIMIT:
                                raise ValueError('Recording recovery record exceeds 2 MiB')
                            if budget['jobs'] >= MAX_JOBS or budget['bytes'] + info.st_size > MAX_BYTES:
                                raise InspectionLimit('Recording recovery record/byte inspection limit reached')
                            budget['jobs'] += 1
                            budget['bytes'] += info.st_size
                            value = read_json(path)
                            if not isinstance(value, dict):
                                raise ValueError('Invalid recovery record')
                            if value.get('kind') != 'recording':
                                continue  # Never copy AI prompts, project snapshots or worker state.
                            if value.get('version') != 1 or value.get('id') != f'{session.name}/{job.name}':
                                raise ValueError('Recording recovery identity/schema mismatch')
                            fault = value.get('writeFault', 0)
                            dropped = value.get('droppedSamples', 0)
                            if type(fault) is not int or fault not in (0, *FAULTS):
                                raise ValueError('Unknown recording write fault')
                            if type(dropped) is not int or dropped < 0:
                                raise ValueError('Invalid dropped-sample count')
                            if fault == 0 and dropped == 0:
                                continue  # Healthy/unfinished records are not proof of a failure.
                            snapshot = {'id': value['id'], 'writeFault': fault,
                                        'writeFailure': FAULTS.get(fault, 'none'),
                                        'droppedSamples': dropped,
                                        'classification': 'diagnostic_only',
                                        'journalModifiedAtUtcSeconds': info.st_mtime}
                            for key in NUMBERS:
                                number = value.get(key)
                                if type(number) in (int, float) and math.isfinite(number) and number >= 0:
                                    snapshot[key] = number
                            # Paths/track IDs are opaque references, not raw names or content.
                            for key in ('path', 'trackId'):
                                if isinstance(value.get(key), str) and len(value[key]) <= 4096:
                                    snapshot[key] = redactor.alias(value[key], 'path' if key == 'path' else 'track')
                            if value.get('status') in {'recording', 'finalized', 'imported', 'dismissed', 'cancelled'}:
                                snapshot['status'] = value['status']
                            entries.append(snapshot)
                        except InspectionLimit:
                            raise
                        except (OSError, ValueError, TypeError, OverflowError, RecursionError) as exc:
                            check(result, 'recording_recovery_unavailable', 'not_asserted', str(exc), source=str(path))
                except InspectionLimit:
                    raise
                except (OSError, ValueError) as exc:
                    check(result, 'recording_recovery_unavailable', 'not_asserted', str(exc), source=str(session))
        except InspectionLimit as exc:
            check(result, 'recording_recovery_limit', 'not_asserted', str(exc))
            break
        except (OSError, ValueError) as exc:
            check(result, 'recording_recovery_unavailable', 'not_asserted', str(exc), source=str(root))
    check(result, 'recording_recovery', 'diagnostic_only' if entries else 'not_asserted',
          f'{len(entries)} existing recording records contain write faults or dropped samples. '
          'Absence does not prove recording was fault-free; no audio or project files were read.')
    return {'kind': 'recording_recovery_snapshot', 'when': 'existing_records_read_at_collection_time',
            'limitations': ['These records identify writer failures, not their underlying disk/driver/resource cause.',
                            'Records can span sessions. Missing records and unsupported failures remain unavailable.'],
            'entries': entries}
