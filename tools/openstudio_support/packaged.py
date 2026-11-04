"""Resources exist only inside the explicitly launched, standalone executable."""
from pathlib import Path
import hashlib
import json
import sys


def resource_root():
    return Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))


def prepare_project(path, clip_ids=(), resources=None):
    import quickjs
    from .common import JSON_LIMIT, regular_file, read_json
    if regular_file(path).st_size > JSON_LIMIT:
        raise ValueError('Project exceeds 32 MiB limit')
    data = path.read_bytes()
    root = resources or resource_root()
    # No filesystem/network callbacks are exposed to JS. Bound untrusted project work.
    context = quickjs.Context()
    context.set_memory_limit(256 * 1024 * 1024)
    context.set_time_limit(30)
    try:
        context.eval((root / 'support-midi.js').read_text(encoding='utf-8'))
        prepare = context.eval('SupportMIDI.prepare')
        encoded = prepare(data.decode('utf-8-sig'), json.dumps(list(clip_ids)))
        if len(encoded) > JSON_LIMIT:
            raise ValueError('Prepared MIDI exceeds 32 MiB limit')
        result = json.loads(encoded)
    except quickjs.JSException as exc:
        raise ValueError('Could not compare this saved project: ' + str(exc)) from exc
    result['sourceProjectSha256'] = hashlib.sha256(data).hexdigest()
    result['preparationSources'] = read_json(root / 'support-midi-sources.json')
    return result
