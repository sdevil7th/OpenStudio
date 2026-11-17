#!/usr/bin/env bash
# Invoked by the checksum-verifying Python owner; no global tool installation.
set -euo pipefail
root="$(cygpath -u "$OPENSTUDIO_FFMPEG_WORK_ROOT")"
repo="$(cygpath -u "$OPENSTUDIO_FFMPEG_REPO_ROOT")"
export PATH="$(cygpath -u "$OPENSTUDIO_FFMPEG_NATIVE_TOOLCHAIN")/bin:$root/tools/usr/bin:$root/tools/ucrt64/bin:$(cygpath -u "$OPENSTUDIO_FFMPEG_NATIVE_NASM"):$PATH"
target=x86_64-w64-mingw32
export CC=$target-clang CXX=$target-clang++ AR=$target-ar RANLIB=$target-ranlib STRIP=$target-strip WINDRES=$target-windres
prefix="$root/prefix"
mkdir -p "$prefix" "$root/build"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib"
patch_root="$repo/thirdparty/ffmpeg/patches"
if [[ ! -d "$patch_root" ]]; then patch_root="$repo/patches"; fi
if grep -q lame_init_old "$root/sources/lame/include/libmp3lame.sym"; then
    patch -d "$root/sources/lame" -p1 < "$patch_root/lame-3.100-windows-exports.patch"
fi
for name in libogg libvorbis lame; do
    mkdir -p "$root/build/$name"; cd "$root/build/$name"
    extra=(); if [[ "$name" == lame ]]; then extra+=(--disable-frontend); fi
    if [[ ! -f Makefile ]]; then
        "$root/sources/$name/configure" --host=$target --prefix="$prefix" --enable-shared --disable-static "${extra[@]}"
    fi
    make -j"${OPENSTUDIO_FFMPEG_BUILD_JOBS:-6}"
    make install
done
mkdir -p "$root/build/ffmpeg"; cd "$root/build/ffmpeg"
if [[ ! -f Makefile ]]; then
    "$root/sources/ffmpeg/configure" --prefix="$prefix" --target-os=mingw32 --arch=x86_64 --enable-cross-compile \
        --cross-prefix=$target- --cc=$CC --cxx=$CXX --host-cc=$CC --ar=$AR --ranlib=$RANLIB --strip=$STRIP --windres=$WINDRES \
        --pkg-config=pkgconf "--extra-cflags=-I$prefix/include" "--extra-ldflags=-L$prefix/lib" --enable-shared --disable-static \
        --disable-autodetect --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-debug --disable-network \
        --disable-programs --enable-ffmpeg --enable-ffprobe --enable-libmp3lame --enable-libvorbis --enable-mediafoundation --enable-d3d11va --enable-encoder=h264_mf
fi
make -j"${OPENSTUDIO_FFMPEG_BUILD_JOBS:-6}"
make install
