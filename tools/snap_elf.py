"""Build-time classic-Snap ELF fixups and validation; never run by the DAW.

Snapcraft's fixups can leave PT_NOTE pointing at moved data (patchelf#217).
Repair those references without moving executable code or appended archives.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile


def _notes(data, origin=0):
    result, cursor = [], 0
    while cursor < len(data):
        if not any(data[cursor:]):
            break
        if cursor + 12 > len(data):
            raise ValueError('Truncated ELF note header')
        names, descs, kind = struct.unpack_from('<III', data, cursor)
        name_start = cursor + 12
        desc_start = name_start + ((names + 3) & ~3)
        end = desc_start + descs
        if end > len(data):
            raise ValueError('ELF note exceeds its declared range')
        result.append((origin + cursor, data[name_start:name_start + names], kind, data[desc_start:end]))
        cursor = desc_start + ((descs + 3) & ~3)
    return result


def audit_notes(path):
    from elftools.elf.elffile import ELFFile

    with Path(path).open('rb') as stream:
        elf = ELFFile(stream)
        if elf.elfclass != 64 or not elf.little_endian or elf['e_machine'] != 'EM_X86_64':
            raise ValueError(f'Unsupported runtime ELF architecture: {path}')
        sections = [s for s in elf.iter_sections()
                    if s['sh_type'] == 'SHT_NOTE' and s['sh_flags'] & 2 and s['sh_size']]
        segments = [s for s in elf.iter_segments()
                    if s['p_type'] in ('PT_NOTE', 'PT_GNU_PROPERTY', 0x6474e553) and s['p_filesz']]
        loads = [s for s in elf.iter_segments() if s['p_type'] == 'PT_LOAD']
        section_notes, program_notes = [], []
        for item in [*sections, *segments]:
            size = item['sh_size'] if 'sh_size' in item.header else item['p_filesz']
            if size > 1024 * 1024:
                raise ValueError(f'ELF note exceeds inspection limit: {path}')
        for section in sections:
            section_notes.extend(_notes(section.data(), section['sh_offset']))
            if not any(segment['p_offset'] <= section['sh_offset']
                       and section['sh_offset'] + section['sh_size'] <= segment['p_offset'] + segment['p_filesz']
                       and segment['p_vaddr'] + section['sh_offset'] - segment['p_offset'] == section['sh_addr']
                       for segment in loads):
                raise ValueError(f'ELF runtime note is outside mapped load segments: {path}')
            if not any(segment['p_offset'] <= section['sh_offset']
                       and section['sh_offset'] + section['sh_size'] <= segment['p_offset'] + segment['p_filesz']
                       and segment['p_vaddr'] + section['sh_offset'] - segment['p_offset'] == section['sh_addr']
                       for segment in segments):
                raise ValueError(f'ELF note section has no matching runtime segment: {path}')
        for segment in segments:
            program_notes.extend(_notes(segment.data(), segment['p_offset']))
        # PT_GNU_PROPERTY may alias a PT_NOTE: count each physical note once.
        if set(section_notes) != set(program_notes):
            raise ValueError(f'ELF runtime notes differ from section notes: {path}')
        build_ids = [value for _, name, kind, value in section_notes if name == b'GNU\0' and kind == 3]
        if any(not 4 <= len(value) <= 64 for value in build_ids):
            raise ValueError(f'Invalid GNU build identity: {path}')
        return sorted(value.hex() for value in build_ids)


def repair_notes(path):
    """Change only existing program-header pointers, never file layout/data."""
    from elftools.elf.elffile import ELFFile

    path = Path(path)
    try:
        audit_notes(path)
        return False
    except ValueError:
        pass
    original = path.read_bytes()
    with path.open('rb') as stream:
        elf = ELFFile(stream)
        if elf.elfclass != 64 or not elf.little_endian or elf['e_machine'] != 'EM_X86_64':
            raise ValueError(f'Unsupported runtime ELF architecture: {path}')
        if elf['e_phentsize'] != 56:
            raise ValueError(f'Unexpected ELF program-header size: {path}')
        sections = sorted([s for s in elf.iter_sections()
                           if s['sh_type'] == 'SHT_NOTE' and s['sh_flags'] & 2 and s['sh_size']],
                          key=lambda s: s['sh_offset'])
        segments = list(elf.iter_segments())
        slots = [i for i, s in enumerate(segments) if s['p_type'] == 'PT_NOTE']
        properties = [i for i, s in enumerate(segments)
                      if s['p_type'] in ('PT_GNU_PROPERTY', 0x6474e553)]
        property_sections = [s for s in sections if s.name == '.note.gnu.property']
        if not sections and (slots or properties):
            raise ValueError(f'Cannot repair runtime notes without authoritative note sections: {path}')
        if properties and len(property_sections) != 1:
            raise ValueError(f'Unexpected GNU property layout: {path}')
        groups = []
        for section in sections:
            # GNU property has its own runtime segment; don't require a second,
            # redundant PT_NOTE slot for the same physical note.
            if properties and section in property_sections:
                continue
            offset, address, size = section['sh_offset'], section['sh_addr'], section['sh_size']
            align = max(4, section['sh_addralign'])
            if groups and groups[-1][0] + groups[-1][2] == offset and groups[-1][1] + groups[-1][2] == address:
                groups[-1][2] += size
                groups[-1][3] = max(groups[-1][3], align)
            else:
                groups.append([offset, address, size, align])
        if len(groups) > len(slots):
            raise ValueError(f'Insufficient existing ELF note slots; refusing to move file layout: {path}')
        data = bytearray(original)

        def replace(index, kind, values):
            offset, address, size, align = values
            struct.pack_into('<IIQQQQQQ', data, elf['e_phoff'] + index * 56,
                             kind, 4 if kind else 0, offset, address, address, size, size, align)

        for index, slot in enumerate(slots):
            if index < len(groups):
                replace(slot, 4, groups[index])
            else:
                replace(slot, 0, [0, 0, 0, 0])
        for slot in properties:
            section = property_sections[0]
            replace(slot, 0x6474e553, [section['sh_offset'], section['sh_addr'], section['sh_size'],
                                      max(8, section['sh_addralign'])])
    # Atomic replacement also breaks prime/stage hardlinks. Validate the private
    # copy before it replaces the primed file; unsupported layouts fail closed.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.os-note-', delete=False) as temp:
        temp_path = Path(temp.name)
        temp.write(data)
    try:
        shutil.copystat(path, temp_path)
        audit_notes(temp_path)
        if len(data) != len(original):
            raise ValueError('ELF note repair changed file size')
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    return True


def elf_files(root):
    for path in sorted(Path(root).rglob('*')):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open('rb') as stream:
            if stream.read(4) == b'\x7fELF':
                yield path


def audit_root(root):
    files = list(elf_files(root))
    if not files:
        raise ValueError('No runtime ELF files found')
    for path in files:
        audit_notes(path)
    return {'status': 'pass', 'runtimeElfFiles': len(files), 'runtimeNoteIntegrity': 'pass'}


def prime(root):
    system = platform.freedesktop_os_release()
    if system.get('ID') != 'ubuntu' or system.get('VERSION_ID') != '22.04':
        raise ValueError('Classic core22 ELF fixups require the managed Ubuntu 22.04 build environment')
    from craft_cli import emit, EmitterMode
    from snapcraft import utils
    from snapcraft.elf import Patcher, SonameCache, elf_utils
    from snapcraft.elf.errors import DynamicLinkerNotFound

    version = subprocess.run([utils.get_snap_tool('patchelf'), '--version'], capture_output=True, text=True,
                             check=True).stdout.strip()
    root = Path(root).resolve(strict=True)
    emit.init(EmitterMode.BRIEF, 'openstudio-snap-elf', 'Classic Snap ELF fixups',
              log_filepath=root.parent / 'snap-elf-patcher.log')
    try:
        linker = elf_utils.get_dynamic_linker(root_path=root, snap_path=Path('/snap/openstudio/current'))
    except DynamicLinkerNotFound:
        linker = elf_utils.get_dynamic_linker(root_path=Path('/'), snap_path=Path('/snap/core22/current'))
    patcher = Patcher(dynamic_linker=linker, root_path=root)
    cache = SonameCache()
    files = elf_utils.get_elf_files(root)
    repaired = 0
    for elf in files:
        print(f'Fix classic ELF: {elf.path.relative_to(root)}', flush=True)
        before = audit_notes(elf.path)
        elf.load_dependencies(root_path=root, base_path=Path('/snap/core22/current'),
                              content_dirs=[], arch_triplet=elf_utils.get_arch_triplet(), soname_cache=cache)
        patcher.patch(elf_file=elf, use_system_libs=False)
        repaired += repair_notes(elf.path)
        if audit_notes(elf.path) != before:
            raise ValueError(f'ELF patching changed GNU build identity: {elf.path}')
    return {**audit_root(root), 'patcher': version, 'noteHeaderFilesRepaired': repaired}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--verify-only', action='store_true')
    mode.add_argument('--repair-only', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.repair_only:
        repaired = sum(repair_notes(path) for path in elf_files(args.root))
        result = {**audit_root(args.root), 'noteHeaderFilesRepaired': repaired}
    else:
        result = audit_root(args.root) if args.verify_only else prime(args.root)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
