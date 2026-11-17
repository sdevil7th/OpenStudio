# OpenStudio FFmpeg 8.0.1-openstudio.2

This is a Windows media-runtime release, not a new OpenStudio application release.
It contains source-built FFmpeg 8.0.1 executables/shared libraries and their
complete corresponding source. Application workflow changes in the local working
tree are not shipped or qualified by this runtime tag.

## Highlights

- Bundle FFprobe from the same pinned FFmpeg source as FFmpeg, so application
  video import and delivery inspection no longer need a separately installed probe.
- Enable Windows Media Foundation software H.264 encoding for edited MP4/AAC
  delivery. Existing MPEG-4 Part 2, FFV1, audio conversions and video decoding remain.
- Retain shared libraries with dependency autodetection, networking, GPL,
  non-free and version-3-only components disabled. No separate H.264 encoder DLL
  or AI model is added. Complete corresponding source is a separate release asset.

## Fixes

- Add explicit FFprobe and H.264 capability checks, including 1080p60 High-profile
  encode/decode with the numeric profile required by FFmpeg 8.0.1's MF adapter.
- Include the exact build recipes, generated configuration, patches and upstream
  archives in the companion source asset; CI rebuilds from that archive before
  Windows conversion checks. Add a version-matched release-note/tag gate.

## Known Issues

- H.264 requires Windows Media Foundation components; Windows editions or systems
  without those components are not qualified by this release. Software encoding
  is the reviewed path; GPU encoder performance and other platforms are unqualified.
- Functional conversion checks do not establish subjective audio/picture quality,
  physical lip sync, long-form capacity or low-latency deadlines. The application's
  96 kHz/16-sample deadline qualification remains deferred.
- This runtime does not itself add video controls to an older OpenStudio app.
  Installed application Release/Store acceptance is a separate gate.

## Upgrade Notes

- Application maintainers must pin the published runtime and corresponding-source
  hashes, install with `tools/setup-ffmpeg.ps1`, and validate the complete packaged
  manifest. Do not copy individual DLLs/probes from another installation.
- The previous immutable `.1` runtime is retained. New binaries and matching source
  are published under a new `.2` tag; existing assets/tags must not be replaced.
- Review the [runtime source comparison](https://github.com/sdevil7th/OpenStudio/compare/ffmpeg-runtime-v8.0.1-openstudio.1...codex/ffmpeg-runtime-8.0.1-openstudio.2).
