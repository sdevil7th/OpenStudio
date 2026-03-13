# Full Reaper-style Track Routing Modal — Implementation Plan

## Context

Replace the inline sends section in ChannelStrip with a single "IO" button that opens a Reaper-style routing modal. Must include ALL features from the Reaper dialog — no skipping. Features missing in the C++ backend will be implemented.

## Files to Modify

**C++ Backend (requires rebuild):**

- `Source/TrackProcessor.h` — add phase invert, stereo width, output channel routing, master send enable, playback offset fields + methods
- `Source/TrackProcessor.cpp` — implement phase invert & stereo width in processBlock, output routing, playback offset
- `Source/AudioEngine.h` — add wrapper methods for new TrackProcessor features, modify audio callback for per-track output routing & send mixing
- `Source/AudioEngine.cpp` — implement send audio mixing in callback, per-track output routing, playback offset, new native function wrappers
- `Source/MainComponent.cpp` — expose new native functions to JavaScript

**Frontend:**

- `frontend/src/services/NativeBridge.ts` — add bridge methods for all new backend features
- `frontend/src/store/useDAWStore.ts` — add modal state + track properties (phaseInvert, width, masterSendEnabled, outputChannels, playbackOffset, midiOutputDevice)
- **NEW** `frontend/src/components/TrackRoutingModal.tsx` — the routing modal
- `frontend/src/components/ChannelStrip.tsx` — replace sends section with IO button
- `frontend/src/App.tsx` — lazy load + render modal

---

## Step 1: C++ — TrackProcessor additions

### 1a: Phase Invert (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h (private members, near line 270):

```cpp
std::atomic<bool> phaseInverted { false };
```

Add public methods:

```cpp
void setPhaseInvert(bool invert) { phaseInverted.store(invert); }
bool getPhaseInvert() const { return phaseInverted.load(); }
```

In `processBlock()` — insert AFTER DC offset removal (line 479), BEFORE automation gain (line 481):

```cpp
// ===== PHASE INVERT (polarity flip) =====
if (phaseInverted.load(std::memory_order_relaxed))
{
    for (int ch = 0; ch < bufferChannels; ++ch)
        juce::FloatVectorOperations::negate(
            buffer.getWritePointer(ch),
            buffer.getReadPointer(ch),
            buffer.getNumSamples());
}
```

### 1b: Stereo Width (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h (private members):

```cpp
std::atomic<float> stereoWidth { 100.0f };  // 0-200%, 100% = normal
```

Add public methods:

```cpp
void setStereoWidth(float widthPercent) { stereoWidth.store(juce::jlimit(0.0f, 200.0f, widthPercent)); }
float getStereoWidth() const { return stereoWidth.load(); }
```

In `processBlock()` — insert AFTER phase invert, BEFORE automation gain:

```cpp
// ===== STEREO WIDTH (M/S processing) =====
float width = stereoWidth.load(std::memory_order_relaxed);
if (bufferChannels >= 2 && std::abs(width - 100.0f) > 0.01f)
{
    float w = width / 100.0f;  // 0.0 = mono, 1.0 = normal, 2.0 = extra wide
    float* L = buffer.getWritePointer(0);
    float* R = buffer.getWritePointer(1);
    for (int i = 0; i < buffer.getNumSamples(); ++i)
    {
        float mid  = (L[i] + R[i]) * 0.5f;
        float side = (L[i] - R[i]) * 0.5f;
        L[i] = mid + side * w;
        R[i] = mid - side * w;
    }
}
```

### 1c: Master Send Enable (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h:

```cpp
std::atomic<bool> masterSendEnabled { true };
```

Add public methods:

```cpp
void setMasterSendEnabled(bool enabled) { masterSendEnabled.store(enabled); }
bool getMasterSendEnabled() const { return masterSendEnabled.load(); }
```

### 1d: Output Channel Routing (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h (private members, near input channel fields):

```cpp
int outputStartChannel { 0 };
int outputChannelCount { 2 };  // default stereo to channels 0-1
```

Add public methods:

```cpp
void setOutputChannels(int startChannel, int numChannels);
int getOutputStartChannel() const { return outputStartChannel; }
int getOutputChannelCount() const { return outputChannelCount; }
```

### 1e: Media Playback Offset (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h:

```cpp
std::atomic<double> playbackOffsetMs { 0.0 };  // milliseconds, positive = delay
```

Add public methods:

```cpp
void setPlaybackOffset(double offsetMs) { playbackOffsetMs.store(offsetMs); }
double getPlaybackOffset() const { return playbackOffsetMs.load(); }
```

### 1f: Per-send Phase Invert (`TrackProcessor.h/cpp`)

Extend `SendConfig` struct (line 214):

```cpp
struct SendConfig
{
    juce::String destTrackId;
    float level = 0.5f;
    float pan = 0.0f;
    bool enabled = true;
    bool preFader = false;
    bool phaseInvert = false;  // NEW
};
```

Add method:

```cpp
void setSendPhaseInvert(int sendIndex, bool invert);
bool getSendPhaseInvert(int sendIndex) const;
```

Update `fillSendBuffer()` (line 880) — apply phase invert when mixing:

```cpp
float phaseMultiplier = send.phaseInvert ? -1.0f : 1.0f;
float leftGain = std::cos(panAngle) * level * phaseMultiplier;
float rightGain = std::sin(panAngle) * level * phaseMultiplier;
```

### 1g: Track Channel Count (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h:

```cpp
int trackChannelCount { 2 };  // internal processing channel count
```

Add public methods:

```cpp
void setTrackChannelCount(int numChannels) { trackChannelCount = juce::jlimit(1, 8, numChannels); }
int getTrackChannelCount() const { return trackChannelCount; }
```

> Note: Actually making processBlock work with >2 channels is a deeper change. For now, store the value and expose it to UI. The audio path remains stereo. This matches Reaper where track channels is mainly informational for most users.

### 1h: Per-track MIDI Output (`TrackProcessor.h/cpp`)

Add to TrackProcessor.h:

```cpp
juce::String midiOutputDeviceName;
std::unique_ptr<juce::MidiOutput> midiOutputDevice;
```

Add public methods:

```cpp
void setMIDIOutputDevice(const juce::String& deviceName);
juce::String getMIDIOutputDeviceName() const { return midiOutputDeviceName; }
void sendMIDIToOutput(const juce::MidiBuffer& buffer);
```

Implementation opens/closes MIDI output device when name changes:

```cpp
void TrackProcessor::setMIDIOutputDevice(const juce::String& deviceName)
{
    if (deviceName == midiOutputDeviceName) return;
    midiOutputDeviceName = deviceName;
    midiOutputDevice.reset();
    if (deviceName.isNotEmpty())
    {
        for (const auto& d : juce::MidiOutput::getAvailableDevices())
        {
            if (d.name == deviceName)
            {
                midiOutputDevice = juce::MidiOutput::openDevice(d.identifier);
                break;
            }
        }
    }
}
```

---

## Step 2: C++ — AudioEngine callback changes

### 2a: Send Audio Mixing (AudioEngine.cpp, lines 504-534)

The current callback processes each track then mixes directly to master output (lines 525-534). `fillSendBuffer()` exists but is never called. Need to:

1. After `track->processBlock()` (line 506), capture pre-fader buffer (copy trackBuffer BEFORE gain is applied — BUT processBlock already applies gain). We need to restructure.

**Approach**: Add `getPreFaderBuffer()` / `getPostFaderBuffer()` concept:

- In TrackProcessor::processBlock, save a copy of the buffer at the pre-fader point (after FX, before gain)
- Add `juce::AudioBuffer<float> preFaderBuffer;` member (pre-allocated)
- Copy buffer to preFaderBuffer right before the gain section
- After processBlock, AudioEngine calls `fillSendBuffer()` for each send

Insert after line 506 (`track->processBlock(trackBuffer, midiMessages)`):

```cpp
// ========== SEND MIXING ==========
if (!track->sends.empty())
{
    for (int si = 0; si < (int)track->sends.size(); ++si)
    {
        const auto& send = track->sends[si];
        if (!send.enabled || send.level <= 0.0f) continue;

        auto destIt = trackMap.find(send.destTrackId);
        if (destIt == trackMap.end()) continue;

        // Send audio is mixed into the destination track's pre-allocated send accumulation buffer
        auto sendDestIt = sendAccumBuffers.find(send.destTrackId);
        if (sendDestIt != sendAccumBuffers.end())
        {
            track->fillSendBuffer(si, track->getPreFaderBuffer(), trackBuffer,
                                  sendDestIt->second, numSamples);
        }
    }
}
```

Add to AudioEngine.h:

```cpp
std::map<juce::String, juce::AudioBuffer<float>> sendAccumBuffers;  // pre-allocated per track
```

Initialize these in `audioDeviceAboutToStart()` alongside `sidechainOutputBuffers`.

At the START of each track's processing, mix in accumulated sends from other tracks:

```cpp
// Mix in sends destined for this track
auto accumIt = sendAccumBuffers.find(trackId);
if (accumIt != sendAccumBuffers.end() && accumIt->second.getNumSamples() > 0)
{
    for (int ch = 0; ch < juce::jmin(2, accumIt->second.getNumChannels()); ++ch)
        juce::FloatVectorOperations::add(
            trackBuffer.getWritePointer(ch),
            accumIt->second.getReadPointer(ch),
            numSamples);
    accumIt->second.clear();  // Clear for next callback
}
```

### 2b: Master Send Enable (AudioEngine.cpp, lines 525-534)

Wrap the master mix-in with a check:

```cpp
// Mix track output to device outputs (only if master send is enabled)
if (track->getMasterSendEnabled())
{
    int outStart = track->getOutputStartChannel();
    int outCount = track->getOutputChannelCount();
    for (int ch = 0; ch < std::min(trackBuffer.getNumChannels(), outCount); ++ch)
    {
        int destCh = outStart + ch;
        if (destCh < numOutputChannels)
        {
            juce::FloatVectorOperations::add(
                outputChannelData[destCh],
                trackBuffer.getReadPointer(ch),
                numSamples);
        }
    }
}
```

### 2c: Playback Offset (AudioEngine.cpp, line 394)

Apply per-track playback offset when calling fillTrackBuffer:

```cpp
double trackOffsetSec = track->getPlaybackOffset() / 1000.0;
double adjustedTime = (currentSamplePosition / currentSampleRate) - trackOffsetSec;
playbackEngine.fillTrackBuffer(trackId, trackBuffer, adjustedTime, numSamples, currentSampleRate);
```

---

## Step 3: C++ — AudioEngine wrapper methods & MainComponent native functions

### AudioEngine.h — Add new methods

```cpp
// Phase invert
void setTrackPhaseInvert(const juce::String& trackId, bool invert);
bool getTrackPhaseInvert(const juce::String& trackId) const;

// Stereo width
void setTrackStereoWidth(const juce::String& trackId, float widthPercent);
float getTrackStereoWidth(const juce::String& trackId) const;

// Master send enable
void setTrackMasterSendEnabled(const juce::String& trackId, bool enabled);
bool getTrackMasterSendEnabled(const juce::String& trackId) const;

// Output channel routing
void setTrackOutputChannels(const juce::String& trackId, int startChannel, int numChannels);

// Playback offset
void setTrackPlaybackOffset(const juce::String& trackId, double offsetMs);
double getTrackPlaybackOffset(const juce::String& trackId) const;

// Track channel count
void setTrackChannelCount(const juce::String& trackId, int numChannels);
int getTrackChannelCount(const juce::String& trackId) const;

// Per-send phase invert
void setTrackSendPhaseInvert(const juce::String& trackId, int sendIndex, bool invert);

// MIDI output
void setTrackMIDIOutput(const juce::String& trackId, const juce::String& deviceName);
juce::String getTrackMIDIOutput(const juce::String& trackId) const;
juce::StringArray getAvailableMIDIOutputDevices() const;

// Get full track routing info
juce::var getTrackRoutingInfo(const juce::String& trackId) const;
```

### MainComponent.cpp — Register native functions

Add `.withNativeFunction(...)` entries for each new method, following the existing pattern (e.g., lines 1326-1380 for sends). Each takes args from JavaScript, calls AudioEngine method, returns via completion callback.

---

## Step 4: Frontend — NativeBridge.ts

Add bridge methods:

```typescript
// Phase invert
async setTrackPhaseInvert(trackId: string, invert: boolean): Promise<boolean>
async getTrackPhaseInvert(trackId: string): Promise<boolean>

// Stereo width
async setTrackStereoWidth(trackId: string, widthPercent: number): Promise<boolean>
async getTrackStereoWidth(trackId: string): Promise<number>

// Master send enable/disable
async setTrackMasterSendEnabled(trackId: string, enabled: boolean): Promise<boolean>

// Output channel routing
async setTrackOutputChannels(trackId: string, startChannel: number, numChannels: number): Promise<boolean>

// Playback offset
async setTrackPlaybackOffset(trackId: string, offsetMs: number): Promise<boolean>

// Track channels
async setTrackChannelCount(trackId: string, numChannels: number): Promise<boolean>

// Per-send phase invert
async setTrackSendPhaseInvert(trackId: string, sendIndex: number, invert: boolean): Promise<boolean>

// MIDI output
async setTrackMIDIOutput(trackId: string, deviceName: string): Promise<boolean>
async getMIDIOutputDevices(): Promise<string[]>  // already partially exists

// Full routing info fetch
async getTrackRoutingInfo(trackId: string): Promise<TrackRoutingInfo>
```

---

## Step 5: Frontend — Store additions (`useDAWStore.ts`)

### Modal state (same pattern as showChannelStripEQ)

```typescript
showTrackRouting: boolean;          // false
trackRoutingTrackId: string | null; // null
openTrackRouting: (trackId: string) => void;
closeTrackRouting: () => void;
```

### Track interface additions

```typescript
// Add to Track interface:
phaseInverted: boolean;        // default false
stereoWidth: number;           // default 100 (percent)
masterSendEnabled: boolean;    // default true
outputStartChannel: number;    // default 0
outputChannelCount: number;    // default 2
playbackOffsetMs: number;      // default 0
trackChannelCount: number;     // default 2
midiOutputDevice: string;      // default ""
```

### New actions

```typescript
setTrackPhaseInvert: (trackId: string, invert: boolean) => void;
setTrackStereoWidth: (trackId: string, widthPercent: number) => void;
setTrackMasterSendEnabled: (trackId: string, enabled: boolean) => void;
setTrackOutputChannels: (trackId: string, startChannel: number, numChannels: number) => void;
setTrackPlaybackOffset: (trackId: string, offsetMs: number) => void;
setTrackChannelCount: (trackId: string, numChannels: number) => void;
setTrackSendPhaseInvert: (trackId: string, sendIndex: number, invert: boolean) => void;
setTrackMIDIOutput: (trackId: string, deviceName: string) => void;
```

Each calls the NativeBridge method then updates the tracks array in store.

---

## Step 6: Frontend — TrackRoutingModal.tsx (NEW)

**Props**: `isOpen: boolean`, `onClose: () => void`

**Layout** — faithful to Reaper's dialog:

```text
┌──────────────────────────────────────────────────────────┐
│ Routing — "Track 4"                                [X]   │
├──────────────────────────────────────────────────────────┤
│ [✓] Master send channels from/to  [All v] → [1-2 v]     │
│                                                          │
│ [-30.22] dB          Track channels: [2 v]               │
│                                                          │
│ Pan:  [═══════|═══════]  center                          │
│ Width:[═══════════════|]  100%                           │
│                                                          │
│ [  ] Media playback offset: [+0    ] ● ms ○ samples     │
│                                                          │
│ ── MIDI Hardware Output ──                               │
│ [<no output>                                         v]  │
│                                                          │
│ ── Sends ──                                              │
│ [Add new send...                                     v]  │
│                                                          │
│ ┌ Send to track 6 "Jazz Four"                 [Delete]─┐│
│ │ [+0.00] [center]  [M] [Ø] [Post-Fader (Post-Pan) v] ││
│ │ Vol: [═══════|══════════]   Pan: [═══════|═══════]   ││
│ │ Audio: [1/2 v] → [1/2 v]   MIDI: [All v] → [All v] ││
│ └──────────────────────────────────────────────────────┘│
│                                                          │
│ ── Receives ──                                           │
│ [Add new receive...                                  v]  │
│                                                          │
│ ┌ Receive from track 3 "90 BPM - ROCK"       [Delete]─┐│
│ │ [+0.00] [center]  [M] [Ø] [Post-Fader (Post-Pan) v] ││
│ │ Vol: [═══════|══════════]   Pan: [═══════|═══════]   ││
│ │ Audio: [1/2 v] → [1/2 v]   MIDI: [All v] → [All v] ││
│ └──────────────────────────────────────────────────────┘│
│                                                          │
│ ── Audio Hardware Outputs ──                             │
│ [Add new hardware output...                          v]  │
│                                                          │
│ ┌ Hardware: Analogue 1                        [Delete]─┐│
│ │ [+0.00] [center]  [M] [Ø] [Post-Fader (Post-Pan) v] ││
│ │ Vol: [═══════|══════════]   Pan: [═══════|═══════]   ││
│ │ [1/2 v] → Analogue 1                                ││
│ └──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

### Sections

**1. Master Send** — top section

- Checkbox to enable/disable master send → `setTrackMasterSendEnabled()`
- Channel mapping: source channels → master output channels (dropdowns)
- Volume display in dB (track.volume) — editable input field
- Track channels dropdown (1-8) → `setTrackChannelCount()`
- Pan slider (-100L to 100R) → `setTrackPan()`
- Width slider (0-200%) → `setTrackStereoWidth()`
- Media playback offset checkbox + input + ms/samples radio → `setTrackPlaybackOffset()`

**2. MIDI Hardware Output** — dropdown of available MIDI output devices → `setTrackMIDIOutput()`

**3. Sends** — list of current sends + "Add new send" dropdown

- Each send item shows:
  - Volume input (dB) + Pan display
  - M (mute/enable toggle) + Ø (phase invert) + Pre/Post fader dropdown
  - Volume slider + Pan slider
  - Audio channel mapping dropdowns (source → dest)
  - MIDI channel mapping dropdowns (source → dest)

**4. Receives** — derived from all tracks' sends where destTrackId === thisTrackId

- Same controls as sends, but actions target the SOURCE track's send

**5. Audio Hardware Outputs** — per-track output routing

- "Add new hardware output" → sets `outputStartChannel`/`outputChannelCount`
- Each output shows volume/pan/mute controls + channel mapping
- Hardware output names come from `getAudioDeviceSetup().outputChannelNames`

### Conversion helpers

```typescript
function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}
function dbToLinear(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}
function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return "center";
  return pan < 0 ? `${Math.round(Math.abs(pan * 100))}L` : `${Math.round(pan * 100)}R`;
}
```

---

## Step 7: ChannelStrip.tsx changes

- **Remove** entire sends section (lines 283-369)
- **Remove** from selector: `addTrackSend`, `removeTrackSend`, `setTrackSendLevel`, `setTrackSendEnabled`, `setTrackSendPreFader`
- **Add** to selector: `openTrackRouting`
- **Replace** with IO button:

```tsx
{!isMaster && (
  <div className="px-1 pt-0.5 pb-0.5 shrink-0">
    <button
      onClick={() => openTrackRouting(track.id)}
      title="Sends, receives & hardware output routing"
      className={classNames(
        "w-full h-4 rounded text-[7px] font-bold ...",
        track.sends?.length > 0 ? "border-cyan-600/60 text-cyan-400" : "..."
      )}
    >
      IO {track.sends?.length > 0 && `(${track.sends.length})`}
    </button>
  </div>
)}
```

---

## Step 8: App.tsx wiring

- Lazy import `TrackRoutingModal`
- Add `showTrackRouting`, `closeTrackRouting` to selector
- Render alongside other modals

---

## Step 9: Verify

```bash
# C++ build
cmake --build build --config Debug

# Frontend type check
cd frontend && npx tsc --noEmit
```

Manual testing:

1. Open mixer → click IO button → modal opens with track name
2. Test master send enable/disable, volume/pan
3. Add/remove sends, modify volume/pan/mute/phase/pre-post
4. Add/remove receives (verify they modify source track's sends)
5. Test stereo width slider (mono at 0%, normal at 100%, wide at 200%)
6. Test phase invert button (Ø)
7. Test playback offset (positive delay in ms)
8. Test hardware output routing (select different output channels)
9. Test MIDI output device selection

---

## Implementation Order

1. **C++ TrackProcessor** — all new fields/methods (Step 1)
2. **C++ AudioEngine** — send mixing + master send enable + output routing + playback offset (Step 2)
3. **C++ AudioEngine wrappers + MainComponent native functions** (Step 3)
4. **C++ Build & verify zero warnings**
5. **NativeBridge.ts** — all new bridge methods (Step 4)
6. **useDAWStore.ts** — modal state + track properties + actions (Step 5)
7. **TrackRoutingModal.tsx** — full UI component (Step 6)
8. **ChannelStrip.tsx** — replace sends with IO button (Step 7)
9. **App.tsx** — wire up modal (Step 8)
10. **TypeScript check + manual testing** (Step 9)
