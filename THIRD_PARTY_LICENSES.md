# Third-Party Licenses

OpenStudio uses the following open-source libraries and dependencies.

---

## JUCE 8.0.0

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

YSFX bundles portions of WDL (Cockos) under the WTFPL license.

---

## WDL (Cockos)

- **Website:** https://www.cockos.com/wdl/
- **License:** WTFPL (Do What The F*** You Want To Public License)
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
- **License:** LGPLv2.1+ / GPLv2+
- **Copyright:** (c) The FFmpeg developers
- **Usage:** Audio format conversion (MP3, OGG, etc.) via external process

FFmpeg is distributed as a standalone executable and is not linked into
the OpenStudio binary. It is invoked as a child process for lossy format
encoding and sample rate conversion.

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

For a complete list of frontend dependencies and their licenses, see
`frontend/package.json` and run `npx license-checker` in the frontend directory.

---

## CLAP SDK 1.2.2

- **Website:** https://github.com/free-audio/clap
- **License:** MIT License
- **Copyright:** (c) free-audio contributors
- **Usage:** CLAP plugin format hosting headers

---

## Signalsmith Stretch

- **Website:** https://signalsmith-audio.co.uk/code/stretch/
- **License:** MIT License
- **Copyright:** (c) Signalsmith Audio Ltd
- **Usage:** Pitch shifting with formant preservation (header-only library)

Includes signalsmith-linear (FFT/STFT), also MIT licensed.

---

## ONNX Runtime (Optional)

- **Website:** https://onnxruntime.ai/
- **License:** MIT License
- **Copyright:** (c) Microsoft Corporation
- **Usage:** Neural network inference for polyphonic pitch detection (Basic-Pitch model)

Pre-built binary; not compiled from source. See `thirdparty/onnxruntime/ThirdPartyNotices.txt`
for full third-party notices.

---

## ARA SDK 2.2.0 (Optional)

- **Website:** https://www.celemony.com/ara
- **License:** Apache License 2.0
- **Copyright:** (c) Celemony Software GmbH
- **Usage:** ARA 2 plugin hosting (Melodyne, SpectraLayers integration)

Includes nested dependencies: cpp-base64 (zlib), pugixml (MIT).

---

## dr_libs

- **Website:** https://github.com/mackron/dr_libs
- **License:** Unlicense / MIT (dual choice)
- **Copyright:** (c) David Reid
- **Usage:** Audio format decoding (WAV, MP3, FLAC) — header-only

---

## stb

- **Website:** https://github.com/nothings/stb
- **License:** MIT License / Public Domain (dual choice)
- **Copyright:** (c) Sean Barrett
- **Usage:** Image I/O utilities — header-only
