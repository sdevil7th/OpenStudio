#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
default_lock_file="$repo_root/thirdparty/ffmpeg/source-lock.json"
if [[ ! -f "$default_lock_file" && -f "$repo_root/source-lock.json" ]]; then
  default_lock_file="$repo_root/source-lock.json"
fi
lock_file="${OPENSTUDIO_FFMPEG_SOURCE_LOCK:-$default_lock_file}"
default_patch_dir="$repo_root/thirdparty/ffmpeg/patches"
if [[ ! -d "$default_patch_dir" && -d "$repo_root/patches" ]]; then
  default_patch_dir="$repo_root/patches"
fi
patch_dir="${OPENSTUDIO_FFMPEG_PATCH_DIR:-$default_patch_dir}"
source_archive_dir="${OPENSTUDIO_FFMPEG_SOURCE_ARCHIVE_DIR:-$repo_root/sources}"
work_root="${OPENSTUDIO_FFMPEG_WORK_ROOT:-$repo_root/build-ffmpeg-runtime}"
output_root="${OPENSTUDIO_FFMPEG_OUTPUT_ROOT:-$repo_root/dist/ffmpeg-runtime}"

download_dir="$work_root/downloads"
source_dir="$work_root/sources"
build_dir="$work_root/build"
prefix_dir="$work_root/prefix"
host_tools_dir="$work_root/host-tools"
toolchain_dir="$work_root/toolchain"
runtime_dir="$work_root/runtime"
corresponding_dir="$work_root/corresponding-source"

runtime_archive="$output_root/OpenStudio-FFmpeg-8.0.1-windows-x64.zip"
source_archive="$output_root/OpenStudio-FFmpeg-8.0.1-complete-corresponding-source.zip"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required build command is missing: $1" >&2
    exit 1
  fi
}

for command_name in curl patch python3 sha256sum tar make pkg-config zip; do
  require_command "$command_name"
done

if [[ ! -f "$lock_file" ]]; then
  echo "FFmpeg source lock was not found: $lock_file" >&2
  exit 1
fi

assert_safe_build_path() {
  local candidate
  candidate="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1")"
  if [[ -z "$candidate" || "$candidate" == "/" || "$candidate" == "$repo_root" ]]; then
    echo "Refusing to clear unsafe build path: $candidate" >&2
    exit 1
  fi
}

assert_safe_build_path "$work_root"
assert_safe_build_path "$output_root"
rm -rf "$work_root" "$output_root"
mkdir -p "$download_dir" "$source_dir" "$build_dir" "$prefix_dir" \
  "$host_tools_dir" "$toolchain_dir" "$runtime_dir/licenses" "$corresponding_dir/sources" \
  "$corresponding_dir/build"

read_lock_value() {
  python3 - "$lock_file" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
print(value)
PY
}

download_verified() {
  local url="$1"
  local expected_sha256="$2"
  local destination="$3"
  local archive_name
  archive_name="$(basename "$destination")"
  if [[ -f "$source_archive_dir/$archive_name" ]]; then
    echo "Using packaged source archive $archive_name"
    cp "$source_archive_dir/$archive_name" "$destination"
  else
    echo "Downloading $archive_name"
    curl --fail --location --retry 3 --retry-delay 2 --output "$destination" "$url"
  fi
  local actual_sha256
  actual_sha256="$(sha256sum "$destination" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "Checksum mismatch for $destination" >&2
    echo "Expected: $expected_sha256" >&2
    echo "Actual:   $actual_sha256" >&2
    exit 1
  fi
}

toolchain_url="$(read_lock_value toolchain.url)"
toolchain_sha256="$(read_lock_value toolchain.sha256)"
toolchain_archive="$download_dir/$(basename "${toolchain_url%%\?*}")"
download_verified "$toolchain_url" "$toolchain_sha256" "$toolchain_archive"
tar -xf "$toolchain_archive" -C "$toolchain_dir" --strip-components=1

nasm_url="$(read_lock_value buildTools.0.url)"
nasm_sha256="$(read_lock_value buildTools.0.sha256)"
nasm_archive_name="$(read_lock_value buildTools.0.archive)"
nasm_archive="$download_dir/$nasm_archive_name"
download_verified "$nasm_url" "$nasm_sha256" "$nasm_archive"
cp "$nasm_archive" "$corresponding_dir/sources/$nasm_archive_name"
mkdir -p "$source_dir/nasm" "$build_dir/nasm"
tar -xf "$nasm_archive" -C "$source_dir/nasm" --strip-components=1
pushd "$build_dir/nasm" >/dev/null
"$source_dir/nasm/configure" "--prefix=$host_tools_dir"
make -j"$(getconf _NPROCESSORS_ONLN)"
make install
popd >/dev/null

source_count="$(python3 - "$lock_file" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    print(len(json.load(handle)["sources"]))
PY
)"

for ((index = 0; index < source_count; ++index)); do
  source_name="$(read_lock_value "sources.$index.name")"
  source_url="$(read_lock_value "sources.$index.url")"
  source_sha256="$(read_lock_value "sources.$index.sha256")"
  source_archive_name="$(read_lock_value "sources.$index.archive")"
  source_archive_path="$download_dir/$source_archive_name"
  download_verified "$source_url" "$source_sha256" "$source_archive_path"
  cp "$source_archive_path" "$corresponding_dir/sources/$source_archive_name"
  mkdir -p "$source_dir/$source_name"
  tar -xf "$source_archive_path" -C "$source_dir/$source_name" --strip-components=1
done

# LAME 3.100's Windows export list contains lame_init_old even when its
# configure result removes that deprecated implementation. Removing the stale
# export keeps the public, supported lame_init API and makes the DLL export
# table agree with the compiled source.
patch -d "$source_dir/lame" -p1 \
  < "$patch_dir/lame-3.100-windows-exports.patch"

target="x86_64-w64-mingw32"
export PATH="$host_tools_dir/bin:$toolchain_dir/bin:$PATH"
export CC="$target-clang"
export CXX="$target-clang++"
export AR="$target-ar"
export RANLIB="$target-ranlib"
export STRIP="$target-strip"
export WINDRES="$target-windres"
export PKG_CONFIG_LIBDIR="$prefix_dir/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export CPPFLAGS="-I$prefix_dir/include"
export LDFLAGS="-L$prefix_dir/lib"

jobs="${OPENSTUDIO_FFMPEG_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
common_configure=(
  "--host=$target"
  "--prefix=$prefix_dir"
  "--enable-shared"
  "--disable-static"
)

build_autotools_dependency() {
  local name="$1"
  shift
  local dependency_build_dir="$build_dir/$name"
  mkdir -p "$dependency_build_dir"
  pushd "$dependency_build_dir" >/dev/null
  "$source_dir/$name/configure" "${common_configure[@]}" "$@"
  make -j"$jobs"
  make install
  popd >/dev/null
}

build_autotools_dependency libogg
build_autotools_dependency libvorbis "--with-ogg=$prefix_dir"
build_autotools_dependency lame --disable-frontend

ffmpeg_configure=(
  "--prefix=$prefix_dir"
  "--target-os=mingw32"
  "--arch=x86_64"
  "--enable-cross-compile"
  "--cross-prefix=$target-"
  "--cc=$CC"
  "--cxx=$CXX"
  "--ar=$AR"
  "--ranlib=$RANLIB"
  "--strip=$STRIP"
  "--windres=$WINDRES"
  "--pkg-config=pkg-config"
  "--extra-cflags=-I$prefix_dir/include"
  "--extra-ldflags=-L$prefix_dir/lib"
  "--enable-shared"
  "--disable-static"
  "--disable-autodetect"
  "--disable-gpl"
  "--disable-nonfree"
  "--disable-version3"
  "--disable-doc"
  "--disable-debug"
  "--disable-network"
  "--disable-programs"
  "--enable-ffmpeg"
  "--enable-libmp3lame"
  "--enable-libvorbis"
)

mkdir -p "$build_dir/ffmpeg"
pushd "$build_dir/ffmpeg" >/dev/null
"$source_dir/ffmpeg/configure" "${ffmpeg_configure[@]}"
make -j"$jobs"
make install
cp ffbuild/config.mak "$corresponding_dir/build/ffmpeg-config.mak"
cp config.h "$corresponding_dir/build/ffmpeg-config.h"
popd >/dev/null

cp "$prefix_dir/bin/ffmpeg.exe" "$runtime_dir/"
find "$prefix_dir/bin" -maxdepth 1 -type f -iname '*.dll' -exec cp {} "$runtime_dir/" \;

cp "$source_dir/ffmpeg/COPYING.LGPLv2.1" "$runtime_dir/licenses/FFmpeg-COPYING.LGPLv2.1.txt"
cp "$source_dir/ffmpeg/COPYING.LGPLv3" "$runtime_dir/licenses/FFmpeg-COPYING.LGPLv3.txt"
cp "$source_dir/lame/COPYING" "$runtime_dir/licenses/LAME-COPYING.txt"
cp "$source_dir/libogg/COPYING" "$runtime_dir/licenses/libogg-COPYING.txt"
cp "$source_dir/libvorbis/COPYING" "$runtime_dir/licenses/libvorbis-COPYING.txt"

cp "$lock_file" "$corresponding_dir/source-lock.json"
cp -R "$patch_dir" "$corresponding_dir/patches"
cp "$script_dir/build-windows-ffmpeg-runtime.sh" "$corresponding_dir/build/"
cp "$script_dir/test-windows-ffmpeg-runtime.ps1" "$corresponding_dir/build/"

runtime_version="$(read_lock_value runtimeVersion)"
toolchain_version="$(read_lock_value toolchain.version)"
cat > "$corresponding_dir/README.md" <<EOF
# OpenStudio FFmpeg $runtime_version complete corresponding source

This archive accompanies the OpenStudio Windows FFmpeg runtime. It contains
the exact upstream source archives, checksums, build script, configuration and
license material used to create the distributed executable and DLLs.

OpenStudio invokes ffmpeg.exe as a separate child process; it does not link
FFmpeg libraries into OpenStudio. The runtime is a shared-library build with
GPL and non-free components disabled.

To rebuild on an x86_64 Linux host, install bash, curl, Python 3, make,
pkg-config, tar and zip, then run from the extracted archive root:

    bash ./build/build-windows-ffmpeg-runtime.sh

The build script downloads the checksum-pinned llvm-mingw $toolchain_version
toolchain recorded by source-lock.json and consumes the included upstream source
archives from sources/. No unlisted media library is detected or linked because
FFmpeg is configured with --disable-autodetect.
EOF

{
  echo "OpenStudio FFmpeg runtime: $runtime_version"
  echo "Target: x86_64 Windows UCRT"
  echo "Toolchain: llvm-mingw $toolchain_version"
  echo "Assembler: $(nasm -v)"
  echo "Compiler: $($CC --version | head -n 1)"
  echo ""
  printf 'FFmpeg configure:'
  printf ' %q' "${ffmpeg_configure[@]}"
  echo
} > "$corresponding_dir/build/BUILD-INFO.txt"

python3 - "$runtime_dir" "$lock_file" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

runtime_dir = Path(sys.argv[1])
with open(sys.argv[2], "r", encoding="utf-8") as handle:
    lock = json.load(handle)
files = []
for path in sorted(p for p in runtime_dir.rglob("*") if p.is_file()):
    files.append({
        "path": path.relative_to(runtime_dir).as_posix(),
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    })
manifest = {
    "schemaVersion": 1,
    "runtimeVersion": lock["runtimeVersion"],
    "target": lock["target"],
    "license": "LGPL-2.1-or-later",
    "gplComponentsEnabled": False,
    "nonFreeComponentsEnabled": False,
    "files": files,
}
(runtime_dir / "runtime-manifest.json").write_text(
    json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
)
PY

cp "$lock_file" "$runtime_dir/source-lock.json"

mkdir -p "$output_root"
(
  cd "$runtime_dir"
  zip -X -9 -r "$runtime_archive" .
)
(
  cd "$corresponding_dir"
  zip -X -9 -r "$source_archive" .
)

sha256sum "$runtime_archive" "$source_archive" | tee "$output_root/SHA256SUMS.txt"
echo "Built runtime: $runtime_archive"
echo "Built corresponding source: $source_archive"
