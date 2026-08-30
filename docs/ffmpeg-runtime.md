# Windows FFmpeg Runtime

OpenStudio invokes FFmpeg as a separate process on Windows. It does not link
FFmpeg libraries into the application. The distributed runtime is owned and
built by OpenStudio so its binaries, enabled components, notices, and complete
corresponding source can be traced as one unit.

## Distribution contract

- `thirdparty/ffmpeg/source-lock.json` pins every upstream source archive, the
  cross-toolchain, build tools, licenses, and SHA-256 digests.
- `tools/build-windows-ffmpeg-runtime.sh` builds a Windows x86-64 UCRT shared
  runtime with dependency autodetection, GPL, non-free, version-3-only, and
  networking disabled.
- The only explicitly enabled external libraries are LAME, libogg, and
  libvorbis. Their exact sources and licenses are part of the source lock and
  companion source archive.
- `runtime-manifest.json` records every shipped executable, DLL, and license
  file with its size and SHA-256 digest.
- `thirdparty/ffmpeg/runtime-lock.json` pins an immutable GitHub runtime release,
  both asset digests, and the expected runtime/source manifests.
- `tools/setup-ffmpeg.ps1`, CMake, and release bundle validation independently
  reject missing, substituted, or stale runtime files.

The runtime's complete corresponding-source ZIP contains the original source
archives, the LAME Windows-export patch, the exact build/test scripts, source
lock, generated FFmpeg configuration, build information, and license material.
The source ZIP is published beside the runtime ZIP and is copied beside every
Windows OpenStudio installer that distributes that runtime.

## Capability gate

`.github/workflows/ffmpeg-runtime.yml` builds on a pinned Linux image and tests
the result on a real Windows runner. The test gate covers:

- required codec/filter discovery;
- MP3 and OGG encode/decode;
- WAV, AIFF, and FLAC conversion;
- sample-rate conversion;
- tempo and pitch-filter execution;
- video audio and frame extraction;
- Unicode and space-containing paths;
- expected failures for corrupt input and video without audio.

These are deterministic functional checks. They do not assert subjective audio
quality; release listening tests remain required where a change can affect
perceived output.

## Updating the runtime

1. Create a new runtime version. Never move or replace an existing
   `ffmpeg-runtime-v*` tag.
2. Update source/toolchain pins and any reviewed patches.
3. Run the dedicated workflow and require its Windows capability job to pass.
4. Tag the tested commit. The workflow publishes the runtime, complete source,
   and checksum list as an immutable GitHub release.
5. Update `runtime-lock.json` with the published asset and manifest digests.
6. Run `tools/setup-ffmpeg.ps1`, the Windows application build, runtime bundle
   validation, and the release smoke checklist.

macOS and Linux releases do not redistribute this Windows runtime. They use an
optional system FFmpeg and must fail only the requested FFmpeg-backed operation
when it is unavailable.
