# Third-Party Licenses

OpenStudio uses the following open-source libraries and dependencies.

---

## JUCE 9.0.1

- **Website:** https://juce.com/
- **License:** AGPLv3 / Commercial
- **Copyright:** (c) Raw Material Software Limited
- **Usage:** Audio engine, GUI framework, plugin hosting, WebView2 integration

The JUCE framework is dual-licensed under the AGPLv3 and a commercial license.
OpenStudio is released under AGPLv3-compatible terms.

---

## YSFX

- **Website:** https://github.com/jpcima/ysfx
- **License:** Apache License 2.0
- **Copyright:** (c) Jean Pierre Cimalando and contributors
- **Usage:** JSFX/EEL2 scripting runtime for built-in S13FX audio effects

Licensed under the Apache License, Version 2.0. You may obtain a copy at:
http://www.apache.org/licenses/LICENSE-2.0

The exact upstream Apache-2.0 text is shipped in every application bundle as
`licenses/YSFX-LICENSE.txt`.

YSFX bundles portions of WDL (Cockos) under WDL's zlib-style license and uses
dr_libs and stb under their upstream dual-license terms. Their exact notices
are shipped as `licenses/WDL-LICENSE.txt`, `licenses/dr_libs-LICENSE.txt`, and
`licenses/stb-LICENSE.txt`.

---

## WDL (Cockos)

- **Website:** https://www.cockos.com/wdl/
- **License:** zlib-style WDL license
- **Copyright:** (c) Cockos Incorporated
- **Usage:** Bundled with YSFX for EEL2 compilation and DSP primitives

---

## Lua 5.4

- **Website:** https://www.lua.org/
- **License:** MIT License
- **Copyright:** (c) 1994-2024 Lua.org, PUC-Rio
- **Usage:** Embedded scripting engine for DAW automation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

---

## Microsoft WebView2

- **Website:** https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- **License:** Microsoft Software License Terms
- **Copyright:** (c) Microsoft Corporation
- **Usage:** Embedded Chromium-based browser for the React frontend on Windows

---

## FFmpeg

- **Website:** https://ffmpeg.org/
- **Bundled Windows runtime:** OpenStudio FFmpeg 8.0.1-openstudio.1
- **FFmpeg license for this build:** LGPL-2.1-or-later
- **Enabled external libraries:** LAME 3.100 (LGPL-2.0-or-later), libogg
  1.3.5 (BSD-3-Clause), and libvorbis 1.3.7 (BSD-3-Clause)
- **Copyright:** (c) The FFmpeg developers
- **Usage:** Audio format conversion (MP3, OGG, etc.) via external process

On Windows, FFmpeg is distributed as a standalone executable with its required
shared libraries and is not linked into the OpenStudio binary. It is invoked as
a child process for encoding, resampling, time/pitch processing, and media
extraction. The build disables GPL, non-free, version-3-only, networking, and
dependency autodetection; only the explicitly pinned libraries above are
enabled.

The exact runtime archive, complete corresponding-source archive, source
inputs, build toolchain, configuration, patches, binary files, and SHA-256
digests are recorded in the packaged `licenses/FFmpeg-PROVENANCE.json`,
`licenses/FFmpeg-SOURCE-LOCK.json`, and
`licenses/FFmpeg-RUNTIME-MANIFEST.json`. The applicable FFmpeg, LAME, libogg,
and libvorbis license texts are shipped beside those manifests. The matching
complete corresponding-source archive is published as an immutable companion
asset in the `ffmpeg-runtime-v8.0.1-openstudio.1` GitHub release and is also
attached to every OpenStudio Windows release that distributes this runtime.

OpenStudio does not redistribute an FFmpeg binary in its macOS or Linux
packages. Those builds use an optional system `ffmpeg` on `PATH` when present.

---

## ASIO SDK

- **Website:** https://www.steinberg.net/developers/
- **License:** Steinberg ASIO SDK License Agreement
- **Copyright:** (c) Steinberg Media Technologies GmbH
- **Usage:** Low-latency audio driver support on Windows

The ASIO SDK headers are used at compile time only. The SDK is not
redistributed with OpenStudio binaries.

---

## Frontend Dependencies (npm)

The React frontend uses packages installed via npm. Key dependencies include:

| Package | License | Usage |
|---------|---------|-------|
| React | MIT | UI framework |
| Zustand | MIT | State management |
| react-konva / Konva | MIT | Canvas-based timeline rendering |
| Tailwind CSS | MIT | Utility-first CSS framework |
| Vite | MIT | Build tool and dev server |
| Lucide React | ISC | Icon library |
| @dnd-kit | MIT | Drag-and-drop toolkit |

The complete deterministic production dependency inventory and exact installed
license/notice texts are generated from `frontend/package-lock.json` as
`frontend/THIRD_PARTY_NOTICES.txt`. Every application bundle ships that file as
`licenses/Frontend-THIRD_PARTY_NOTICES.txt`.

---

## CLAP SDK 1.2.2

- **Website:** https://github.com/free-audio/clap
- **License:** MIT License
- **Copyright:** (c) free-audio contributors
- **Usage:** CLAP plugin format hosting headers

The exact upstream MIT text is shipped in every application bundle as
`licenses/CLAP-LICENSE.txt`.

---

## NeuralAmpModelerCore

- **Website:** https://github.com/sdatkinson/NeuralAmpModelerCore
- **Version:** 0.5.4
- **License:** MIT License
- **Copyright:** NeuralAmpModelerCore contributors
- **Usage:** NAM/A1/A2 neural amp model loading and DSP processing

The complete upstream MIT text is shipped with each application bundle as
`licenses/NeuralAmpModelerCore-LICENSE.txt`.

OpenStudio preserves TONE3000 per-tone license metadata in saved NAM tones.
TONE3000 models and thumbnails are not redistributed by OpenStudio.

---

## Eigen

- **Website:** https://gitlab.com/libeigen/eigen
- **Version:** 5.0.1 (`bc3b39870ecb690a623a3f49149a358b95c5781d`)
- **License:** Mozilla Public License 2.0, with individual files under
  compatible BSD, Apache-2.0, and MINPACK notices
- **Usage:** Header-only matrix operations used by NeuralAmpModelerCore

Eigen is primarily licensed under the Mozilla Public License 2.0. The exact
source used by OpenStudio is available through NeuralAmpModelerCore's
`Dependencies/eigen` submodule at the commit above. The complete MPL-2.0,
BSD, Apache-2.0, MINPACK, and explanatory `COPYING.*` files are shipped in the
application bundle's `licenses/` directory.

---

## JSON for Modern C++ (nlohmann/json)

- **Website:** https://github.com/nlohmann/json
- **Version:** 3.12.0
- **License:** MIT License
- **Copyright:** Copyright (c) 2013-2025 Niels Lohmann
- **Usage:** Header-only NAM model JSON parsing through NeuralAmpModelerCore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Signalsmith Stretch

- **Website:** https://signalsmith-audio.co.uk/code/stretch/
- **License:** MIT License
- **Copyright:** (c) Signalsmith Audio Ltd
- **Usage:** Pitch shifting with formant preservation (header-only library)

Includes signalsmith-linear (FFT/STFT), also MIT licensed. The exact
Signalsmith Stretch and Signalsmith Linear MIT texts are shipped in every
application bundle as `licenses/Signalsmith-Stretch-LICENSE.txt` and
`licenses/Signalsmith-Linear-LICENSE.txt`.

---

## terrarium-poly-octave

- **Website:** https://github.com/schult/terrarium-poly-octave
- **License:** MIT License
- **Copyright:** (c) 2024 Steven Schulteis
- **Usage:** Reference implementation and equations adapted for the NAM Rack's
  stereo ERB phase-scaling octave generator

OpenStudio retains the complete upstream MIT notice in
`Source/NAMPolyOctaver.cpp`. Its desktop implementation is sample-rate aware,
uses independent left/right state, and does not include the upstream Daisy,
Q, or GCEM dependencies.

---

## Spotify Basic Pitch ICASSP 2022 model

- **Website:** https://github.com/spotify/basic-pitch
- **Upstream version:** v0.4.0, commit
  `9991303bba609a3b93089d13ec80d1d495083596`
- **Upstream file:** `basic_pitch/saved_models/icassp_2022/nmp.onnx`
- **SHA-256:**
  `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec`
- **License:** Apache License 2.0
- **Copyright:** Copyright 2022 Spotify AB
- **Usage:** Polyphonic pitch detection and audio-to-MIDI transcription

OpenStudio ships the unchanged official 230,444-byte ONNX model. Its pinned
provenance manifest is bundled beside the model, and the exact upstream
`LICENSE` and `NOTICE` files are shipped in the application's `licenses/`
directory.

---

## ONNX Runtime 1.24.4 (Optional)

- **Website:** https://onnxruntime.ai/
- **License:** MIT License
- **Copyright:** (c) Microsoft Corporation
- **Usage:** Neural network inference for polyphonic pitch detection (Basic-Pitch model)

Pre-built binary; not compiled from source. When ONNX Runtime is included, its
exact upstream `LICENSE` and `ThirdPartyNotices.txt` files are shipped in the
application bundle's `licenses/` directory.

---

## ARA SDK 2.2.0 (Optional)

- **Website:** https://www.celemony.com/ara
- **License:** Apache License 2.0
- **Copyright:** (c) Celemony Software GmbH
- **Usage:** ARA 2 plugin hosting (Melodyne, SpectraLayers integration)

The vendored SDK notice also identifies dependencies used by its examples,
including cpp-base64 (zlib) and pugixml (MIT). OpenStudio compiles the ARA API
and ARA Library host support, not the SDK example applications.

The exact vendored ARA notice plus the ARA API and ARA Library Apache-2.0
license texts are shipped as `licenses/ARA-NOTICE.txt`,
`licenses/ARA-API-LICENSE.txt`, and `licenses/ARA-Library-LICENSE.txt`.

---

## dr_libs

- **Website:** https://github.com/mackron/dr_libs
- **License:** Unlicense / MIT (dual choice)
- **Copyright:** (c) David Reid
- **Usage:** Audio format decoding (WAV, MP3, FLAC) — header-only

The exact upstream dual-license text used by the YSFX dependency is shipped as
`licenses/dr_libs-LICENSE.txt`.

---

## stb

- **Website:** https://github.com/nothings/stb
- **License:** MIT License / Public Domain (dual choice)
- **Copyright:** (c) Sean Barrett
- **Usage:** Image I/O utilities — header-only

The exact upstream dual-license text used by the YSFX dependency is shipped as
`licenses/stb-LICENSE.txt`.
