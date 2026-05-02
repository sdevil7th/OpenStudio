# macOS Audio Fixes — Root Cause Analysis & Implementation Notes

**Date:** 2026-04-13  
**Affects:** macOS arm64 (Apple Silicon), all macOS releases  
**Files changed:**
- `Source/StemSeparator.cpp`
- `CMakeLists.txt`

---

## Background

Two separate bugs were found during macOS testing with an Audient ID14 USB audio interface. Both trace back to the same root condition: **the app was distributed without notarization**, triggering macOS Gatekeeper quarantine on first launch. The quarantine created a cascade of failures in two independent subsystems.

The user had to run `xattr -dr com.apple.quarantine /Applications/OpenStudio.app` manually before the app would open. This is the key diagnostic signal that connected both bugs.

---

## Bug 1 — AI Tools Installation Fails on macOS arm64

### Symptom

Install log shows the download, verification, and extraction all succeeding, then:

```json
{
  "phase": "probe",
  "event": "runtime_probe_finished",
  "baseRuntimeReady": false,
  "runtimeReady": false,
  "selectedBackend": "cpu",
  "supportedBackends": ""
}
```

`supportedBackends: ""` (empty string, not even `"cpu"`) is the diagnostic fingerprint — it means `probeRuntimeCapabilities()` returned a **default-initialized struct**, i.e., it exited before parsing any JSON from the probe process.

### Root Cause Trace

#### Step 1 — Why `supportedBackends` is empty

`StemSeparator::probeRuntimeCapabilities()` has several early-return paths that return a default `RuntimeCapabilities{}` struct before reaching the JSON parse loop. The log call at the end (`capabilities.supportedBackends.joinIntoString(",")`) then produces an empty string because the array was never populated. The "add cpu if empty" safety net only runs after a successful parse — not on early returns.

#### Step 2 — Which early-return fired

The Python binary path check passes (the extracted Python file exists on disk — confirmed by the `findPythonInRuntimeRoot` check at line 1674 succeeding). The failure is at the subprocess launch:

```cpp
if (! probe.start(command) || ! probe.waitForProcessToFinish(30000))
    return capabilities;
```

`juce::ChildProcess::start()` uses `posix_spawn()` internally on macOS. `posix_spawn()` returns `EACCES` and the call returns `false` when the target binary is not executable.

#### Step 3 — Why the binary is not executable

`juce::ZipFile::uncompressTo()` does not restore Unix file permission bits from the zip's external file attributes. The Python binary inside the AI runtime archive has execute permission in the zip metadata, but after extraction the file mode is set without the `x` bit — typically `-rw-r--r--` instead of `-rwxr-xr-x`.

This is a known limitation of JUCE's zip extraction: it writes file content correctly but ignores the Unix permission field stored in the zip's local file headers.

#### Step 4 — The quarantine layer on top

Even if the execute bit were somehow present, macOS applies the `com.apple.quarantine` extended attribute to all files extracted from a downloaded zip archive (because the zip itself was downloaded from the internet and carries the quarantine attribute). Gatekeeper blocks execution of quarantined binaries launched by a child process.

The user's `xattr -dr` on the app bundle only cleared the `.app` itself. Files extracted later to `~/Library/Application Support/OpenStudio/stem-runtime/` were quarantined separately and untouched by that command.

Both problems apply simultaneously on a fresh install:
- No execute bit → `posix_spawn()` fails with `EACCES`
- Quarantine attribute → Gatekeeper blocks even if execute bit is present

### Fix

**File:** `Source/StemSeparator.cpp` — `extractRuntimeArchive()`

After the successful `copyDirectoryTo(destinationRoot)` call and before cleanup, a `#if JUCE_MAC` block is inserted that performs two post-extraction steps:

**Step A — Restore execute bits using POSIX `chmod()`**

A lambda (`restoreExecuteBit`) iterates every regular file under `bin/` and `lib/` using `juce::RangedDirectoryIterator`, reads current permissions with `::stat()`, and ORs in `S_IXUSR | S_IXGRP | S_IXOTH` via `::chmod()`. A separate block does the same for the Python binary itself (which may live outside `bin/` depending on the archive layout).

`chmod()` is used directly instead of spawning a subprocess because:
- It avoids the overhead of a child process
- It avoids the circular problem of needing a working Python to fix Python's own permissions
- `<sys/stat.h>` is always available on macOS/Linux

**Step B — Strip the quarantine attribute using `xattr -rd`**

`xattr` is a macOS system tool that always exists at a known path. It is invoked via `juce::ChildProcess` with `xattr -rd com.apple.quarantine <destinationRoot>`. The `-r` flag makes it recursive across the entire runtime directory. Failure is treated as non-fatal — the chmod step (Step A) is the primary fix; the quarantine strip is defense-in-depth.

There is no single POSIX API equivalent to a recursive `removexattr` over a directory tree, so the subprocess approach is necessary for this step.

**Additional changes in `probeRuntimeCapabilities()`:**

- All early-return paths now emit a structured JSON log line via `appendAiToolsLogLine()` explaining which check failed (python not found, script not found, process start failure, timeout, bad exit code). Previously these returned silently, making the failure impossible to diagnose from the log alone.
- Probe subprocess timeout increased from 15 000 ms to 30 000 ms. Even after quarantine is stripped, macOS Gatekeeper performs a one-time scan of newly executable binaries. On slow or heavily loaded systems this scan can exceed 15 seconds.

### Platform Impact

The chmod/xattr block is wrapped in `#if JUCE_MAC` and does not compile on Windows or Linux. The `#include <sys/stat.h>` is wrapped in `#if JUCE_MAC || JUCE_LINUX` — it is a standard POSIX header on Linux and a harmless addition there. The timeout and logging changes are cross-platform but additive only (longer timeout, extra log lines on failure).

---

## Bug 2 — Input Monitoring Produces No Audio (No Meter Movement)

### Symptom

- Audient ID14 connected via USB, inputs visible in the device selector inside the app
- Track added, armed for recording, FX loaded
- No audio heard through monitoring
- No movement in the channel strip peak meters at all

### Why This Is Not a Driver Issue

The Audient ID14 is a class-compliant USB audio device. macOS has native Core Audio support for it with no third-party driver required. Other DAWs working with the same device confirms the hardware and driver layer are fine.

### Root Cause Trace

#### Step 1 — Enumeration vs. capture

The app can list the interface's inputs (channel count, names) because device enumeration uses `AudioObjectGetPropertyData` with `kAudioDevicePropertyStreamConfiguration`, which does **not** require microphone permission.

Actual audio capture — reading samples from `inputChannelData` in the audio callback — goes through a different code path that macOS gates behind the privacy permission system.

#### Step 2 — macOS treats all audio input as "microphone"

On macOS, **the "Microphone" privacy permission covers every audio input source** — built-in microphone, USB audio interfaces, Thunderbolt interfaces, HDMI audio return, everything. It is not specific to the physical built-in microphone. The OS does not distinguish between a laptop mic and a professional audio interface at the privacy layer.

When microphone permission is denied or not yet requested:
- `numInputChannels` in the audio callback may still be > 0 (the device is open)
- But all values in `inputChannelData` are zero — silence
- The monitoring path in `AudioEngine::audioDeviceIOCallbackWithContext()` faithfully copies those zeros into the track buffer
- The track FX chain processes zeros, the meter computes 0.0 RMS, the channel strip shows nothing

#### Step 3 — The permission was never requested

The `NSMicrophoneUsageDescription` key was missing from the app's `Info.plist`. This key is required for macOS to allow the app to use audio input at all. When the key is absent:

- macOS never shows a permission dialog
- The app's permission state stays at "not determined" (or is silently treated as denied)
- Core Audio provides zero input data on every callback

This key must be set in the generated `Info.plist` at build time. In a JUCE CMake project, it is controlled through the `juce_add_gui_app()` call.

**The existing `juce_add_gui_app()` call in `CMakeLists.txt`:**

```cmake
juce_add_gui_app(OpenStudio
    PRODUCT_NAME "OpenStudio"
    VERSION ${PROJECT_VERSION}
    ICON_BIG  "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-256x256.png"
    ICON_SMALL "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-16x16.png"
    # MICROPHONE_PERMISSION_ENABLED and MICROPHONE_PERMISSION_TEXT were absent
)
```

#### Step 4 — The quarantine connection

The app being quarantined on first launch is related but not the direct cause. The direct cause is the missing plist key. The quarantine connection is:

- A quarantined app on its first launch may have its entitlement and permission requests suppressed or fail silently by Gatekeeper
- If the key had been present but the first launch was quarantined, macOS might have failed to record the "not determined" state correctly
- After the user ran `xattr -dr` on the app, subsequent launches no longer trigger Gatekeeper — but the permission was already never requested, so audio input still returns zeros

### Fix

**File:** `CMakeLists.txt` — `juce_add_gui_app()` call

Two properties added:

```cmake
MICROPHONE_PERMISSION_ENABLED TRUE
MICROPHONE_PERMISSION_TEXT "OpenStudio needs access to your audio input to record from microphones and audio interfaces."
```

`MICROPHONE_PERMISSION_ENABLED TRUE` tells JUCE's CMake module to emit `NSMicrophoneUsageDescription` into the generated `Info.plist`. `MICROPHONE_PERMISSION_TEXT` is the string value for that key — it is shown to the user in the macOS permission dialog and in System Settings → Privacy → Microphone.

On the first launch of the rebuilt app, macOS will display a one-time permission dialog. After the user grants access, Core Audio provides real input data and monitoring works.

### Platform Impact

`MICROPHONE_PERMISSION_ENABLED` and `MICROPHONE_PERMISSION_TEXT` are Apple-platform-only properties in JUCE's CMake module. The module does not act on them for Windows or Linux builds — they are silently ignored. This change has zero effect on Windows and Linux builds.

### User-Facing Behavior Change

**New installs:** The permission dialog appears on first launch. Expected and correct.

**Existing installs (users who had the old build):** Their stored permission state is "not determined" (the key was never in the plist, so macOS never asked). On first launch of the updated build, macOS will show the dialog. They grant access, and monitoring works from that point forward.

**If a user previously explicitly denied access** (unlikely given the permission dialog was never shown, but possible through System Settings): They need to enable it manually at System Settings → Privacy & Security → Microphone.

To reset a specific installation's stored permission state from the terminal:

```bash
tccutil reset Microphone <bundle-identifier>
# e.g.: tccutil reset Microphone in.openstudio.app
```

---

## Summary of All Changes

| File | Change | Reason |
|---|---|---|
| `Source/StemSeparator.cpp` | `#include <sys/stat.h>` under `#if JUCE_MAC \|\| JUCE_LINUX` | Required for POSIX `stat()` and `chmod()` |
| `Source/StemSeparator.cpp` | Post-extraction `chmod +x` block in `extractRuntimeArchive()` | `juce::ZipFile::uncompressTo()` does not restore Unix execute bits; Python binary extracted without `+x` causes `posix_spawn()` to return `EACCES` |
| `Source/StemSeparator.cpp` | Post-extraction `xattr -rd com.apple.quarantine` in `extractRuntimeArchive()` | macOS applies quarantine to all files extracted from a downloaded zip; Gatekeeper blocks execution of quarantined binaries |
| `Source/StemSeparator.cpp` | Diagnostic log lines on all early returns in `probeRuntimeCapabilities()` | All early returns were previously silent; log now records which specific check failed |
| `Source/StemSeparator.cpp` | Probe timeout 15 000 ms → 30 000 ms | First-time Gatekeeper scan of a newly executable binary can exceed 15 s on loaded systems |
| `CMakeLists.txt` | `MICROPHONE_PERMISSION_ENABLED TRUE` + `MICROPHONE_PERMISSION_TEXT` in `juce_add_gui_app()` | Without `NSMicrophoneUsageDescription` in `Info.plist`, macOS never prompts for audio input permission and Core Audio silently returns zeros for all input |
