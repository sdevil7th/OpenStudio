"""Synthetic native identities and hostile evidence; no OS crash configuration."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import shutil
import subprocess
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from openstudio_support.identity import native_ids, dump_modules, match_ids, os_report_ids
from openstudio_support.collection import collect, bundle
from openstudio_support.common import Redactor, save_report
from openstudio_support.snapshots import plugin_snapshot, symbol_archive_ids

GUID = uuid.UUID('00112233-4455-6677-8899-aabbccddeeff')
ID = f'pdb:{str(GUID).upper()}:3'


def pe(guid=GUID):
    data = bytearray(1024)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<H', data, 134, 1)
    struct.pack_into('<H', data, 148, 240)
    struct.pack_into('<H', data, 152, 0x20b)
    struct.pack_into('<II', data, 152 + 112 + 48, 4096, 28)
    struct.pack_into('<IIII', data, 392 + 8, 512, 4096, 512, 512)
    struct.pack_into('<IIII', data, 512 + 12, 2, 24, 0, 600)
    data[600:624] = b'RSDS' + guid.bytes_le + struct.pack('<I', 3)
    return data


def pdb(guid=GUID):
    data = bytearray(4096)
    data[:32] = b'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'
    struct.pack_into('<6I', data, 32, 512, 1, 8, 16, 0, 2)
    struct.pack_into('<I', data, 1024, 3)
    struct.pack_into('<4I', data, 1536, 2, 0, 28, 4)
    struct.pack_into('<3I', data, 2048, 20000404, 0, 3)
    data[2060:2076] = guid.bytes_le
    return data


def dump():
    data = bytearray(1024)
    data[:4] = b'MDMP'
    struct.pack_into('<II', data, 8, 1, 32)
    struct.pack_into('<III', data, 32, 4, 112, 48)
    struct.pack_into('<I', data, 48, 1)
    struct.pack_into('<I', data, 52 + 20, 200)
    name = 'C:\\Users\\private\\OpenStudio.exe'.encode('utf-16-le')
    struct.pack_into('<I', data, 200, len(name))
    data[204:204 + len(name)] = name
    struct.pack_into('<II', data, 52 + 76, 24, 400)
    data[400:424] = b'RSDS' + GUID.bytes_le + struct.pack('<I', 3)
    return data


def macho(guid=GUID):
    return struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 24, 0, 0) + struct.pack('<II', 0x1b, 24) + guid.bytes


def elf():
    data = bytearray(256)
    data[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<Q', data, 40, 64)
    struct.pack_into('<HH', data, 58, 64, 1)
    struct.pack_into('<I', data, 68, 7)
    struct.pack_into('<QQ', data, 88, 128, 36)
    struct.pack_into('<III', data, 128, 4, 20, 3)
    data[140:144] = b'GNU\0'
    data[144:164] = bytes(range(20))
    return data


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_native_pairs_and_truncated_inputs(self):
        cases = [(pe(), ID), (pdb(), ID), (macho(), 'macho:' + str(GUID).upper()),
                 (elf(), 'elf:' + bytes(range(20)).hex())]
        for index, (data, expected) in enumerate(cases):
            path = self.write(str(index), data)
            self.assertEqual(native_ids(path), [expected])
            path.write_bytes(data[:45])
            with self.assertRaises(ValueError):
                native_ids(path)

    def test_universal_macho_uses_both_uuids(self):
        other = uuid.uuid4()
        data = struct.pack('>II', 0xcafebabe, 2)
        data += struct.pack('>5I', 0x100000c, 0, 48, 56, 0)
        data += struct.pack('>5I', 0x1000007, 0, 104, 56, 0)
        data += macho() + macho(other)
        self.assertEqual(len(native_ids(self.write('fat', data))), 2)
        data = bytearray(data); struct.pack_into('>I', data, 20, 0xffffffff)
        with self.assertRaises(ValueError):
            native_ids(self.write('bad-fat', data))

    def test_dump_metadata_without_sharing_memory_or_claiming_new_build(self):
        path = self.write('last_crash.dmp', dump())
        modules = dump_modules(path)
        self.assertEqual(modules, [{'module': 'OpenStudio.exe', 'debugIds': [ID]}])
        app = self.write('OpenStudio.exe', pe(uuid.uuid4()))
        result, files, redactor = collect([self.root], app=app)
        self.assertFalse(files)
        self.assertEqual(result['incidentModules'][0]['modules'], modules)
        self.assertNotEqual(result['installedBuild']['debugIds'], [ID])
        self.assertEqual(result['incidentModules'][0]['symbolMatches'][0]['status'], 'not_asserted')
        self.assertNotIn('private', json.dumps(result['incidentModules']))
        self.assertEqual(match_ids([ID], {ID})[0]['status'], 'pass')
        path.write_bytes(dump()[:70])
        with self.assertRaises(ValueError):
            dump_modules(path)

    def test_plugin_allowlist_redaction_and_reviewed_bundle(self):
        self.write('plugin_scan_debug.txt', b'Load failed C:\\Users\\private\\fx.vst3\npassword=hidden')
        self.write('PluginList.xml', b'<KNOWNPLUGINS><PLUGIN name="Synth" format="VST3" version="1.2" file="C:/private/x.vst3" pluginState="PRIVATE"/><SECRET password="secret"/></KNOWNPLUGINS>')
        self.write('PluginHosting.json', b'["C:/private/x.vst3"]')
        result, files, redactor = collect([self.root])
        self.assertEqual(len(files), 3)
        text = b''.join(files.values()).decode()
        self.assertIn('Synth', text)
        for secret in ('private', 'PRIVATE', 'hidden'):
            self.assertNotIn(secret, text)
        self.assertTrue(all('modifiedAtUtc' in item for item in result['artifacts']))
        review = self.root / 'review'
        save_report(review, result, files, redactor)
        bundle(review, self.root / 'review.zip', True)

    def test_plugin_xml_entities_and_malformed_data_rejected(self):
        for data in (b'<!DOCTYPE a [<!ENTITY e "secret">]><KNOWNPLUGINS/>', b'<broken'):
            path = self.write('PluginList.xml', data)
            with self.assertRaises(ValueError):
                plugin_snapshot(path, Redactor())
            result, files, _ = collect([self.root])
            self.assertFalse(files)
            self.assertEqual(result['checks'][0]['status'], 'not_asserted')

    def test_symbol_archive_rejects_changed_bytes_and_unsafe_paths(self):
        path = self.write('OpenStudio.pdb', pdb())
        manifest = {'kind': 'openstudio_symbol_archive', 'symbols': [
            {'file': path.name, 'debugIds': [ID], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}]}
        self.write('manifest.json', json.dumps(manifest).encode())
        self.assertEqual(symbol_archive_ids(self.root), {ID})
        path.write_bytes(pdb(uuid.uuid4()))
        with self.assertRaises(ValueError):
            symbol_archive_ids(self.root)
        manifest['symbols'][0]['file'] = '../OpenStudio.pdb'
        self.write('manifest.json', json.dumps(manifest).encode())
        with self.assertRaises(ValueError):
            symbol_archive_ids(self.root)

    def test_archive_fails_closed_for_wrong_pdb_and_wrong_frontend(self):
        spec = importlib.util.spec_from_file_location('build_symbols', Path(__file__).parents[1] / 'tools/build-symbols.py')
        tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)
        app = self.write('OpenStudio.exe', pe())
        self.write('OpenStudio.pdb', pdb(uuid.uuid4()))
        (self.root / 'webui').mkdir()
        (self.root / 'webui/app.js').write_text('app')
        tool.write_identity(app, '1.2.3', 'Release')
        frontend = self.root / 'frontend'; frontend.mkdir()
        (frontend / 'manifest.json').write_text(json.dumps({'kind': 'openstudio_frontend_symbols', 'chunks': []}))
        with self.assertRaisesRegex(ValueError, 'Mismatched symbols'):
            tool.archive(app, self.root, self.root / 'out', frontend)
        self.write('OpenStudio.pdb', pdb())
        with self.assertRaisesRegex(ValueError, 'Frontend symbols'):
            tool.archive(app, self.root, self.root / 'out', frontend)
        self.assertFalse(list((self.root / 'out').iterdir()))
        code, mapping = b'app', b'{"version":3,"mappings":"AAAA"}'
        (frontend / 'app.js').write_bytes(code)
        (frontend / 'app.js.map').write_bytes(mapping)
        (frontend / 'manifest.json').write_text(json.dumps({'kind': 'openstudio_frontend_symbols', 'chunks': [
            {'file': 'app.js', 'sha256': hashlib.sha256(code).hexdigest(),
             'map': 'app.js.map', 'mapSha256': hashlib.sha256(mapping).hexdigest()}]}))
        destination = tool.archive(app, self.root, self.root / 'out', frontend)
        self.assertEqual(symbol_archive_ids(destination), {ID})
        with self.assertRaisesRegex(ValueError, 'already exists'):
            tool.archive(app, self.root, self.root / 'out', frontend)
        (self.root / 'webui/app.js').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Packaged JavaScript changed'):
            tool.archive(app, self.root, self.root / 'another-out', frontend)

    def test_audio_settings_exclude_device_names_and_unrelated_data(self):
        path = self.write('audio_device_settings.xml', b'<DEVICESETUP deviceType="ASIO" audioDeviceRate="48000" audioDeviceBufferSize="8" audioOutputDeviceName="private" credential="hidden"/>')
        value = plugin_snapshot(path, Redactor())
        self.assertEqual(value['entries'], [{'deviceType': 'ASIO', 'audioDeviceRate': '48000', 'audioDeviceBufferSize': '8'}])

    def test_selected_os_reports_are_explicit_and_redacted(self):
        path = self.write('OpenStudio.ips', b'{"path":"/Users/private/app", "exception":"EXC_BAD_ACCESS"}')
        result, files, _ = collect([self.root])
        self.assertFalse(files)
        result, files, _ = collect([self.root], crash_reports=[path])
        self.assertNotIn(b'private', next(iter(files.values())))
        self.assertIn(b'EXC_BAD_ACCESS', next(iter(files.values())))
        with self.assertRaises(ValueError):
            collect([], crash_reports=[self.root / 'core'])

    def test_os_incident_ids_ignore_unrelated_uuid_and_version(self):
        report = self.write('test.ips', ('{"incident_id":"' + str(uuid.uuid4()) + '"}\n' +
            json.dumps({'usedImages': [{'uuid': str(GUID), 'name': 'OpenStudio'}]})).encode())
        self.assertEqual(os_report_ids(report), ['macho:' + str(GUID).upper()])
        linux = self.write('core.txt', b'OpenStudio version 0.1.09\nModule has build-id: 12345678abcdef00')
        self.assertEqual(os_report_ids(linux), ['elf:12345678abcdef00'])

    @unittest.skipUnless(sys.platform in ('linux', 'darwin') and shutil.which('cc'), 'Native Unix compiler required')
    def test_platform_generated_debug_companion_matches(self):
        source = self.root / 'test.c'
        source.write_text('int main(void) { return 0; }')
        app = self.root / 'native'
        subprocess.run(['cc', '-g', str(source), '-o', str(app),
                        *(['-Wl,--build-id=sha1'] if sys.platform == 'linux' else [])], check=True)
        if sys.platform == 'linux':
            debug = self.root / 'native.debug'
            subprocess.run(['objcopy', '--only-keep-debug', str(app), str(debug)], check=True)
            subprocess.run(['strip', '--strip-debug', str(app)], check=True)
        else:
            subprocess.run(['dsymutil', str(app)], check=True)
            debug = self.root / 'native.dSYM/Contents/Resources/DWARF/native'
        self.assertTrue(native_ids(app))
        self.assertEqual(native_ids(app), native_ids(debug))


if __name__ == '__main__':
    unittest.main()
