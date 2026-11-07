"""Bounded, offline native debug identities. Never loads or executes inspected code.

PE/PDB use CodeView GUID + age; Mach-O uses LC_UUID; ELF uses GNU build-id.
These identify debug companions, not signatures, provenance, or crash causation.
"""
from __future__ import annotations

import mmap
import json
import re
from pathlib import Path
import struct
import uuid

from .common import regular_file


def _bytes(data, offset, size):
    if offset < 0 or size < 0 or offset + size > len(data):
        raise ValueError('Truncated native identity data')
    return data[offset:offset + size]


def _unpack(data, offset, fmt):
    return struct.unpack(fmt, _bytes(data, offset, struct.calcsize(fmt)))


def _codeview(data, offset, size):
    if size < 24 or _bytes(data, offset, 4) != b'RSDS':
        return []
    guid = str(uuid.UUID(bytes_le=_bytes(data, offset + 4, 16))).upper()
    age, = _unpack(data, offset + 20, '<I')
    return [f'pdb:{guid}:{age}']


def _pe(data):
    pe, = _unpack(data, 60, '<I')
    if _bytes(data, pe, 4) != b'PE\0\0':
        raise ValueError('Invalid PE header')
    count, = _unpack(data, pe + 6, '<H')
    optional_size, = _unpack(data, pe + 20, '<H')
    optional = pe + 24
    magic, = _unpack(data, optional, '<H')
    directory = {0x10b: 96, 0x20b: 112}.get(magic)
    if directory is None or count > 96 or optional_size < directory + 56:
        raise ValueError('Unsupported PE layout')
    rva, size = _unpack(data, optional + directory + 48, '<II')
    sections = optional + optional_size
    def file_offset(address, length):
        for index in range(count):
            _, virtual, raw_size, raw = _unpack(data, sections + index * 40 + 8, '<IIII')
            if virtual <= address and address - virtual + length <= raw_size:
                return raw + address - virtual
        raise ValueError('Debug directory outside PE sections')
    if not rva or not size:
        return []
    if size > 28 * 4096 or size % 28:
        raise ValueError('Invalid PE debug directory size')
    table = file_offset(rva, size)
    result = []
    for offset in range(table, table + size, 28):
        kind, length, _, raw = _unpack(data, offset + 12, '<IIII')
        if kind == 2:
            result += _codeview(data, raw, length)
    return sorted(set(result))


def _pdb(data):
    # LLVM MSF 7 superblock and stream directory; read only stream 1's header.
    block, _, blocks, directory_size, _, block_map = _unpack(data, 32, '<6I')
    if block not in (512, 1024, 2048, 4096, 8192, 16384, 32768) or blocks * block > len(data):
        raise ValueError('Invalid PDB block layout')
    if directory_size > 16 * 1024 * 1024:
        raise ValueError('PDB directory exceeds inspection limit')
    count = (directory_size + block - 1) // block
    if count * 4 > block:
        raise ValueError('Unsupported PDB directory map')
    ids = _unpack(data, block_map * block, f'<{count}I')
    directory = b''.join(_bytes(data, item * block, block) for item in ids)[:directory_size]
    streams, = _unpack(directory, 0, '<I')
    if not 2 <= streams <= 100000:
        raise ValueError('Invalid PDB stream count')
    sizes = _unpack(directory, 4, f'<{streams}I')
    first_blocks = 0 if sizes[0] == 0xffffffff else (sizes[0] + block - 1) // block
    if sizes[1] == 0xffffffff or sizes[1] < 28:
        raise ValueError('Missing PDB info stream')
    info_block, = _unpack(directory, 4 + streams * 4 + first_blocks * 4, '<I')
    age, = _unpack(data, info_block * block + 8, '<I')
    guid = str(uuid.UUID(bytes_le=_bytes(data, info_block * block + 12, 16))).upper()
    return [f'pdb:{guid}:{age}']


def _macho(data, start=0, length=None, depth=0):
    length = len(data) if length is None else length
    if depth > 1 or start + length > len(data):
        raise ValueError('Invalid Mach-O slice')
    magic = _bytes(data, start, 4)
    if magic in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
        count, = _unpack(data, start + 4, '>I')
        if depth or not 1 <= count <= 16:
            raise ValueError('Invalid universal Mach-O architecture count')
        wide = magic[-1] == 0xbf
        result = []
        for index in range(count):
            entry = start + 8 + index * (32 if wide else 20)
            offset, size = _unpack(data, entry + 8, '>QQ' if wide else '>II')
            result += _macho(data, offset, size, depth + 1)
        return sorted(set(result))
    formats = {b'\xcf\xfa\xed\xfe': ('<', 32), b'\xce\xfa\xed\xfe': ('<', 28),
               b'\xfe\xed\xfa\xcf': ('>', 32), b'\xfe\xed\xfa\xce': ('>', 28)}
    if magic not in formats:
        raise ValueError('Unsupported Mach-O header')
    endian, header = formats[magic]
    count, size = _unpack(data, start + 16, endian + 'II')
    if count > 65536 or header + size > length:
        raise ValueError('Invalid Mach-O commands')
    cursor = start + header
    end = cursor + size
    result = []
    for _ in range(count):
        command, size = _unpack(data, cursor, endian + 'II')
        if size < 8 or cursor + size > end:
            raise ValueError('Invalid Mach-O command size')
        if command == 0x1b:
            if size != 24:
                raise ValueError('Invalid Mach-O UUID command')
            result.append('macho:' + str(uuid.UUID(bytes=_bytes(data, cursor + 8, 16))).upper())
        cursor += size
    return sorted(set(result))


def _elf(data):
    width, encoding = _unpack(data, 4, 'BB')
    if width not in (1, 2) or encoding not in (1, 2):
        raise ValueError('Unsupported ELF header')
    endian = '<' if encoding == 1 else '>'
    wide = width == 2
    table, = _unpack(data, 40 if wide else 32, endian + ('Q' if wide else 'I'))
    stride, count = _unpack(data, 58 if wide else 46, endian + 'HH')
    if not table or not count:
        return []
    if stride < (64 if wide else 40):
        raise ValueError('Invalid ELF section size')
    result = []
    for index in range(count):
        section = table + index * stride
        kind, = _unpack(data, section + 4, endian + 'I')
        if kind != 7:  # SHT_NOTE; retained by objcopy --only-keep-debug.
            continue
        offset, size = _unpack(data, section + (24 if wide else 16), endian + ('QQ' if wide else 'II'))
        if size > 1024 * 1024:
            raise ValueError('ELF notes exceed inspection limit')
        notes = _bytes(data, offset, size)
        cursor = 0
        while cursor + 12 <= size:
            names, descs, kind = _unpack(notes, cursor, endian + 'III')
            cursor += 12
            name = _bytes(notes, cursor, names)
            cursor += (names + 3) & ~3
            value = _bytes(notes, cursor, descs)
            cursor += (descs + 3) & ~3
            if name == b'GNU\0' and kind == 3 and 4 <= descs <= 64:
                result.append('elf:' + value.hex())
    return sorted(set(result))


def native_ids(path: Path):
    if regular_file(path).st_size == 0:
        raise ValueError('Empty native file')
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        magic = data[:4]
        if magic[:2] == b'MZ':
            return _pe(data)
        if data[:32] == b'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0':
            return _pdb(data)
        if magic == b'\x7fELF':
            return _elf(data)
        return _macho(data)


def dump_modules(path: Path):
    """Extract IDs without copying memory; available even when dumps aren't shared."""
    size = regular_file(path).st_size
    if not 32 <= size <= 512 * 1024 * 1024:
        raise ValueError('Dump identity inspection requires 32 bytes–512 MiB')
    result = []
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        if data[:4] != b'MDMP':
            raise ValueError('Not a Windows minidump')
        streams, directory = _unpack(data, 8, '<II')
        if streams > 4096:
            raise ValueError('Too many minidump streams')
        for index in range(streams):
            kind, length, offset = _unpack(data, directory + index * 12, '<III')
            if kind != 4:
                continue
            count, = _unpack(data, offset, '<I')
            if count > 4096 or length < 4 + count * 108:
                raise ValueError('Invalid minidump module list')
            for module in range(count):
                cursor = offset + 4 + module * 108
                name_rva, = _unpack(data, cursor + 20, '<I')
                name_size, = _unpack(data, name_rva, '<I')
                if name_size > 32768:
                    raise ValueError('Minidump module name too long')
                name = _bytes(data, name_rva + 4, name_size).decode('utf-16-le', errors='replace')
                cv_size, cv_rva = _unpack(data, cursor + 76, '<II')
                ids = _codeview(data, cv_rva, cv_size) if cv_size else []
                # Basename only, never the dump's original user directory.
                result.append({'module': name.replace('\\', '/').rsplit('/', 1)[-1], 'debugIds': ids})
    return result


def match_ids(incident_ids, candidates):
    """Exact IDs only. A version string or filename can never establish a match."""
    return [{'debugId': identity, 'status': 'pass' if identity in candidates else 'not_asserted',
             'detail': 'Exact debug identity found.' if identity in candidates else 'Matching symbols unavailable.'}
            for identity in sorted(set(incident_ids))]


def os_report_ids(path: Path):
    """Recognized text metadata only. Never treats a process/version name as an ID."""
    if regular_file(path).st_size > 2 * 1024 * 1024:
        raise ValueError('OS report identity inspection exceeds 2 MiB')
    text = path.read_text(encoding='utf-8-sig', errors='replace')
    result = set()
    if path.suffix.lower() == '.ips':
        # Apple .ips may contain one metadata JSON line followed by the report JSON.
        decoder = json.JSONDecoder()
        remaining = text.lstrip()
        for _ in range(2):
            value, end = decoder.raw_decode(remaining)
            if isinstance(value, dict):
                for module in value.get('usedImages', []):
                    if isinstance(module, dict) and isinstance(module.get('uuid'), str):
                        result.add('macho:' + str(uuid.UUID(module['uuid'])).upper())
            remaining = remaining[end:].lstrip()
            if not remaining:
                break
    elif path.suffix.lower() == '.crash' and 'Binary Images:' in text:
        for value in re.findall(r'<([0-9a-fA-F-]{32,36})>', text.split('Binary Images:', 1)[1]):
            result.add('macho:' + str(uuid.UUID(value)).upper())
    else:
        for value in re.findall(r'(?i)\bbuild[- ]id[:=]\s*([0-9a-f]{8,128})\b', text):
            if len(value) % 2 == 0:
                result.add('elf:' + value.lower())
    return sorted(result)
