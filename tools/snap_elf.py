"""Build-time classic-Snap ELF fixups and validation; never run by the DAW.

Snapcraft 8.14 bundles patchelf 0.9, which can leave PT_NOTE pointing at moved
data (NixOS/patchelf#217). Keep Canonical's dependency resolver and supply the
pinned, fixed upstream patcher through its preferred_patchelf argument.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import platform
import struct
import subprocess


PATCHER_VERSION = 'patchelf 0.18.0'


def _notes(data):
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
        result.append((data[name_start:name_start + names], kind, data[desc_start:end]))
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
        segments = [s for s in elf.iter_segments() if s['p_type'] == 'PT_NOTE' and s['p_filesz']]
        loads = [s for s in elf.iter_segments() if s['p_type'] == 'PT_LOAD']
        section_notes, program_notes = [], []
        for item in [*sections, *segments]:
            size = item['sh_size'] if 'sh_size' in item.header else item['p_filesz']
            if size > 1024 * 1024:
                raise ValueError(f'ELF note exceeds inspection limit: {path}')
        for section in sections:
            section_notes.extend(_notes(section.data()))
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
            program_notes.extend(_notes(segment.data()))
        if Counter(section_notes) != Counter(program_notes):
            raise ValueError(f'ELF runtime notes differ from section notes: {path}')
        build_ids = [value for name, kind, value in section_notes if name == b'GNU\0' and kind == 3]
        if any(not 4 <= len(value) <= 64 for value in build_ids):
            raise ValueError(f'Invalid GNU build identity: {path}')
        return sorted(value.hex() for value in build_ids)


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


def prime(root, patchelf):
    system = platform.freedesktop_os_release()
    if system.get('ID') != 'ubuntu' or system.get('VERSION_ID') != '22.04':
        raise ValueError('Classic core22 ELF fixups require the managed Ubuntu 22.04 build environment')
    from craft_cli import emit, EmitterMode
    from snapcraft.elf import Patcher, SonameCache, elf_utils
    from snapcraft.elf.errors import DynamicLinkerNotFound

    version = subprocess.run([str(patchelf), '--version'], capture_output=True, text=True,
                             check=True).stdout.strip()
    if version != PATCHER_VERSION:
        raise ValueError(f'Expected pinned {PATCHER_VERSION}, got {version}')
    root = Path(root).resolve(strict=True)
    emit.init(EmitterMode.BRIEF, 'openstudio-snap-elf', 'Classic Snap ELF fixups',
              log_filepath=root.parent / 'snap-elf-patcher.log')
    try:
        linker = elf_utils.get_dynamic_linker(root_path=root, snap_path=Path('/snap/openstudio/current'))
    except DynamicLinkerNotFound:
        linker = elf_utils.get_dynamic_linker(root_path=Path('/'), snap_path=Path('/snap/core22/current'))
    patcher = Patcher(dynamic_linker=linker, root_path=root, preferred_patchelf=str(patchelf))
    cache = SonameCache()
    files = elf_utils.get_elf_files(root)
    for elf in files:
        before = audit_notes(elf.path)
        elf.load_dependencies(root_path=root, base_path=Path('/snap/core22/current'),
                              content_dirs=[], arch_triplet=elf_utils.get_arch_triplet(), soname_cache=cache)
        patcher.patch(elf_file=elf, use_system_libs=False)
        if audit_notes(elf.path) != before:
            raise ValueError(f'ELF patching changed GNU build identity: {elf.path}')
    return {**audit_root(root), 'patcher': version}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--patchelf', type=Path)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.verify_only and not args.patchelf:
        parser.error('--patchelf is required unless --verify-only is used')
    result = audit_root(args.root) if args.verify_only else prime(args.root, args.patchelf.resolve(strict=True))
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
