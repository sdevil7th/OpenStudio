"""Explicit offline collection only; no DAW imports, plugin loading or discovery scans."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from .common import read_json, regular_file, sha256
from .identity import native_ids

PLUGIN_FILES = ('PluginList.xml', 'PluginSearchPaths.xml', 'PluginBlacklist.txt',
                'PluginScanDeadMansPedal.txt', 'PluginHosting.json', 'audio_device_settings.xml')


def plugin_snapshot(path, redactor):
    if regular_file(path).st_size > 2 * 1024 * 1024:
        raise ValueError('Plugin settings exceed the 2 MiB inspection limit')
    text = path.read_text(encoding='utf-8-sig')
    if path.suffix == '.xml':
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            raise ValueError('XML declarations/entities are not accepted')
        try:
            root = ET.fromstring(text)
        except ET.ParseError as exc:
            raise ValueError('Malformed plugin settings XML') from exc
        if path.name == 'audio_device_settings.xml':
            if root.tag != 'DEVICESETUP':
                raise ValueError('Unknown audio-device settings schema')
            allowed = {'deviceType', 'audioDeviceRate', 'audioDeviceBufferSize',
                       'audioDeviceInChans', 'audioDeviceOutChans'}
            items = [{key: redactor.text(value) for key, value in root.attrib.items() if key in allowed}]
        elif path.name == 'PluginList.xml':
            if root.tag != 'KNOWNPLUGINS':
                raise ValueError('Unknown plugin catalogue schema')
            allowed = {'name', 'descriptiveName', 'format', 'category', 'manufacturer', 'version',
                       'file', 'uniqueId', 'isInstrument', 'numInputs', 'numOutputs', 'isShell',
                       'hasARAExtension', 'uid', 'infoUpdateTime', 'fileTime'}
            items = [{key: redactor.text(value) for key, value in child.attrib.items() if key in allowed}
                     for child in root if child.tag == 'PLUGIN']
        else:
            if root.tag != 'PLUGIN_SEARCH_PATHS':
                raise ValueError('Unknown plugin search-path schema')
            items = [redactor.text(child.get('value', '')) for child in root if child.tag == 'PATH']
    elif path.suffix == '.json':
        value = json.loads(text)
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError('Unknown plugin hosting preferences schema')
        items = [redactor.text(item) for item in value]
    else:
        items = [redactor.text(line) for line in text.splitlines() if line.strip()]
    if len(items) > 10000:
        raise ValueError('Too many plugin settings entries')
    return {'kind': path.name, 'when': 'at_collection_time_only', 'entries': items}


def installed_app():
    if not getattr(sys, 'frozen', False):
        return None
    executable = Path(sys.executable)
    if sys.platform == 'darwin':
        for parent in executable.parents:
            if parent.name == 'OpenStudio.app':
                return parent / 'Contents/MacOS/OpenStudio'
    else:
        path = executable.with_name('OpenStudio.exe' if sys.platform == 'win32' else 'OpenStudio')
        if path.is_file():
            return path
    return None  # Separate AppImages cannot inspect each other's unmounted payload.


def installed_snapshot(path):
    if path.suffix == '.app':
        path = path / 'Contents/MacOS/OpenStudio'
    ids = native_ids(path)
    root = path.parent.parent / 'Resources' if path.parent.name == 'MacOS' else path.parent
    result = {'when': 'at_collection_time_only', 'module': path.name,
              'sha256': sha256(path), 'debugIds': ids, 'originalIncidentAssociation': 'not_asserted'}
    manifest = root / 'OpenStudio.build-identity.json'
    if manifest.is_file():
        value = read_json(manifest)
        if not isinstance(value, dict):
            raise ValueError('Invalid installed build manifest')
        modules = value.get('modules', [])
        if not isinstance(modules, list) or not all(isinstance(item, dict) for item in modules):
            raise ValueError('Invalid installed module inventory')
        matching = [item for item in modules if item.get('module') == path.name and item.get('debugIds') == ids and ids]
        if value.get('kind') != 'openstudio_build_identity' or not matching:
            raise ValueError('Installed build identity does not match its native executable')
        result['build'] = value
        result['preSigningBytesMatch'] = matching[0].get('sha256') == result['sha256']
    return result


def symbol_archive_ids(directory):
    manifest = read_json(directory / 'manifest.json')
    if not isinstance(manifest, dict) or manifest.get('kind') != 'openstudio_symbol_archive':
        raise ValueError('Not an OpenStudio symbol archive')
    entries = manifest.get('symbols', [])
    if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
        raise ValueError('Invalid symbol archive inventory')
    found = set()
    for item in entries:
        name = item['file']
        # Archive stores native debug files flat. No arbitrary manifest paths.
        if not isinstance(name, str) or '/' in name or '\\' in name or ':' in name or name in ('', '.', '..'):
            raise ValueError('Unsafe symbol archive path')
        path = directory / name
        if sha256(path) != item['sha256'] or native_ids(path) != item['debugIds']:
            raise ValueError('Symbol archive bytes or debug identity changed')
        found.update(item['debugIds'])
    return found
