# NAM Rack

The NAM Rack is OpenStudio's free, open-source guitar and bass workspace. It hosts Neural
Amp Modeler A1 and A2 pedal, amp, or full-rig captures inside the DAW, surrounds them
with native pedals and studio effects, loads cabinet impulse responses, saves
complete tones, and optionally connects to TONE3000.

OpenStudio does not charge to unlock the rack or its built-in effects. NAM and
OpenStudio are open source. Third-party captures and impulse responses still
retain their creators' licenses.

## Musician workflow

1. Add the NAM Rack to a track, choose the live instrument input, and select the
   Guitar or Bass profile.
2. Set the device buffer and input trim, then tune.
3. Load a local A1/A2 capture or connect TONE3000. When a tone pack contains
   more than one capture, open its capture list and choose the exact child
   before auditioning or using it.
4. If the capture is amp-only, load a cabinet IR. A full-rig capture that
   already contains a cabinet bypasses the separate cabinet stage.
5. Shape the front end with the native pedalboard and finish the sound with EQ,
   modulation, delay, and reverb.
6. Save the complete rack as a tone or project state.

### Multi-capture packs and audition

TONE3000 results are presented as tone packs rather than duplicating one card
per child model. A pack reports its declared capture count; opening **View
Captures** hydrates the available children and shows each name, NAM
architecture, and topology such as **RAW / AMP ONLY**, **CAB EMBEDDED**,
**PEDAL**, **PREAMP**, or **STUDIO**.

For a pack with more than one capture, the pack row is not an implicit model
choice. The user must select a concrete child before **Audition** or **Use** is
enabled. A selection is identified by tone ID plus model ID; URL-only children
use a normalized URL identity so two captures without numeric IDs do not
collapse together. The `tone:0` pack sentinel is never treated as a real child
capture.

The lifecycle is deliberately explicit:

1. Selecting a child updates only the pending UI selection; it does not change
   the audible rack.
2. **Audition** prepares/downloads that child as needed and temporarily
   publishes it to the target slot. Auditioning another child supersedes the
   first preview.
3. **Stop** or Cancel restores the complete baseline that existed before the
   preview, including capture, cabinet state, and relevant mix/power values.
4. **Use** commits that exact child and its durable source metadata. It can then
   be recalled, pinned in filtered library views, and recovered after restart.
5. Opening the capture selector and using another child replaces the current
   capture. Amp power bypasses/re-enables an Amp capture without losing it, and
   Amp **Unload** clears that slot. Pedal NAM uses Pedal Mix for bypass; removing
   the broader Pedal module also clears its pre-Amp module settings.
6. A CAB EMBEDDED/full-rig child bypasses the external Cab stage without
   deleting the chosen IR. Returning to an amp-only child restores the external
   cabinet workflow.

Model preparation, stale-request rejection, and rollback are deterministic
test contracts. The user interface also exposes the child list and actions to
keyboard/assistive navigation. Absence of audible clicks, dropouts, or
real-interface crackle remains `not_asserted` until the exact release artifact
is auditioned at small and normal buffers.

The current audible route is:

```text
Input trim
  -> Gate
  -> Compressor
  -> Stereo Poly Octaver
  -> EQ Boost / pre-EQ
  -> Precision Drive
  -> Distortion
  -> optional A1/A2 Pedal NAM capture
  -> A1/A2 Amp or Full-Rig NAM capture
  -> Cabinet IR and cabinet shaping
  -> Cabinet Space (early Room / optional Doubler)
  -> reorderable EQ / modulation / delay / reverb
  -> Output trim
  -> final stereo-linked finite/level safety guard
  -> meters
```

The tuner observes the input without becoming part of the audible chain.
Pedal NAM is an optional serial pre-amp slot. When loaded, its calibrated wet
path and the native pedalboard feed the Amp/Full-Rig NAM slot; a partial Pedal
mix preserves the single-input dry/wet balance before a following mono Amp NAM.
A pedal-only capture is not a complete amp/cab tone by itself; it normally needs
a following Amp/Full-Rig and, for an amp-only capture, a cabinet IR.
The former global live Transpose, Chaos mode, Glitch, and Laser product
controls are retired. The new Cabinet Space Doubler is a separate post-cab
presentation effect, not a revival of the retired global control. Legacy Laser
fields are ignored and pruned when old projects are restored; they are not
exposed or processed by the active rack.

### Guitar/Bass instrument-profile contract

Instrument Profile is a non-destructive voicing selector. It changes only the
frequency-, tracking-, and low-end-sensitive behavior that should follow the
instrument. It never rewrites visible control values or silently replaces a
loaded NAM capture, cabinet IR, input/output trim, gate threshold, compressor
settings, time/mix controls, or explicit HPF/LPF choices.

The current profile-aware components are:

- EQ Boost keeps its eight stable preset/automation IDs, but Guitar presents
  `120/250/500/1k/2.5k/5k/8k/12k` and Bass presents
  `50/120/250/500/800/1.6k/4.5k/10k`.
- The stereo poly Octaver changes its analysis and pitch-tracking profile so
  B0/E1 bass fundamentals remain supported without weakening Guitar tracking.
- Precision Drive, Distortion, the Amp input wrapper, and the Amp tone stack
  move their hidden low-frequency split/weighting and tone centres downward
  for Bass. Their visible Drive, Attack, Bright, Voice, Bass, Mid, Treble, and
  Presence values stay untouched.
- The post-cab Graphic EQ retains its fixed nine labels; in Bass mode its 65 Hz
  band becomes a low shelf instead of a narrow peaking band.
- Bass modulation keeps a unity direct path while the existing wet-path high
  pass prevents the modulated branch from replacing the fundamental.
- Bass Delay keeps unity direct audio and applies a higher high-pass only to
  repeats/feedback. Time, feedback, mix, modulation, ducking, mode, ping-pong,
  and sync remain the user's values.
- Plate, Hall, and Room Reverb shorten only the low-band decay ratio in Bass
  mode. The visible decay and low-cut values remain exact. Studio retains its
  legacy mapping for old-preset compatibility.

Gate, Compressor, Cabinet/IR, Cabinet Space, calibration, trims, and tuner are
deliberately profile-invariant. Compressor detector HPF and cabinet/reverb
cutoffs are explicit creative controls, not hidden selector defaults. The tuner
already covers 27.5-1320 Hz, so it needs no mode-dependent range change.

Library filtering follows the profile only as a discovery aid. Untagged/shared
captures remain visible, an explicitly opposite-tagged active capture remains
loaded and is pinned in the list, and changing profile never downloads, swaps,
or unloads an asset. A factory-template label is cleared if that template no
longer matches the chosen profile; the resulting control state remains intact.

### Tuner behavior

Opening the tuner explicitly subscribes that NAM Rack to its dry hardware-input
route; record arm and input monitoring are not required. Multiple rack windows
use independent subscriber IDs, so closing one window cannot disable another.
The most recently opened tuner owns the analysis route until it closes, then
the prior subscriber resumes. A master-rack tuner explicitly observes global
hardware Input 1.

The audio callback only selects the strongest routed channel and copies it into
a preallocated lock-free FIFO. A low-priority worker applies anti-aliased
downsampling, full-range MPM/NSDF pitch detection, parabolic period refinement,
and a temporal tracker. This keeps analysis out of the audible path and adds no
audio latency.

The supported range is 27.5-1320 Hz, covering B0/E1 bass fundamentals through
upper guitar. Estimates are converted to absolute musical cents, median
filtered, and confidence-weighted before display. Three consistent frames
acquire a note, with the first pick-heavy window deliberately deweighted.
Large note or octave changes require repeated agreement, and note-name
hysteresis prevents boundary flicker. A missing estimate enters `Holding`: the
last average remains unchanged for about 450 ms, then fades and clears around
1.2 seconds after genuinely missing pitch. Closing the final subscribed tuner
disables the worker-side analysis. The worker discards stale queued audio
rather than letting CPU pressure turn into seconds of display lag.

## Why A2 matters

NAM A2 is the current Neural Amp Modeler architecture. TONE3000 and the NAM
project describe it as a more accurate and more efficient successor while
keeping the model format and inference ecosystem open. OpenStudio loads both A1
and A2 so existing libraries remain useful while new A2 captures can take
advantage of the newer architecture.

That gives OpenStudio a credible free alternative in the same creative category
as AmpliTube, Guitar Rig, and Neural DSP plug-ins: a playable amp-capture rig
with pedals, cabinets, effects, presets, and DAW recall. It is not an objective
claim that every capture beats every commercial product. Capture quality,
interface calibration, cabinet choice, and the player still determine the
result, and subjective comparison remains a musician's decision.

## Architecture

The main implementation lives in:

- `Source/BuiltInEffects2.h/.cpp` — rack DSP, A1/A2 model preparation and
  processing, cabinet convolution, effects, transitions, calibration, state,
  latency, and diagnostics.
- `Source/NAMCabPresentation.h/.cpp` — bounded post-cab early-room and
  doubler presentation, transient protection, mono compatibility, and spatial
  diagnostics.
- `Source/NAMPolyOctaver.h/.cpp` — independent-channel ERB phase-scaling
  octave voices used by the current stereo/polyphonic Octaver.
- `Source/TunerPitchTracker.h/.cpp` — real-time-safe input tap, background
  MPM/NSDF detector, sustained-note averaging, and hold/release state.
- `Source/MainComponent.cpp` — native bridge, TONE3000 OAuth/search/download,
  local library, and secure token persistence.
- `frontend/src/components/NAMRackPanel.tsx` — rack application state and user
  workflow.
- `frontend/src/components/NAMRackDesignPort.tsx` — hardware-style stage UI.
- `frontend/src/components/NAMExplorer.tsx` — local/TONE3000 browsing,
  preview, installation, and recovery.
- `frontend/src/services/NativeBridge.ts` — typed native API and deterministic
  development mocks.

### Real-time contract

- Model parsing, file I/O, allocation, and convolution preparation occur away
  from the audio callback.
- Prepared models and IRs are published atomically and retired after readers
  have left the previous graph.
- The callback uses preallocated buffers and bounded work.
- Sample-rate conversion is explicit around NAM models whose expected rate
  differs from the host.
- Fixed latency is reported to the host, with aligned dry paths during bypass
  and crossfade transitions.
- Precision Drive and Distortion share the selected 2x/4x/8x nonlinear rate
  island. It contributes one host-reported latency for every pedal power
  combination; neither stage performs nested resampling.
- No timing result from one machine is marketed as a universal CPU claim.

### Input routing and stereo NAM contract

The DAW track route is the sole input-topology authority. A one-channel route
uses the mono NAM path. A route with two or more channels uses the stereo path
automatically when every loaded NAM slot has either two prepared 1x1 lanes or
a native 2x2 graph; if a loaded slot cannot support stereo, the Rack safely
falls back to mono. Empty slots do not prevent the remaining stereo effects
from processing a stereo track.

The standard NAM capture used by the public ecosystem is normally a stateful
1-input/1-output processor. For stereo processing, its atomically published
owner contains two independently constructed and prepared `nam::DSP` graphs.
Left and right have separate model,
resampler, FIFO, dry-delay, calibration, fault, output-history, and NAM Slim
activation state. The callback evaluates the lanes sequentially with shared
preallocated scratch memory, but stages both results until the pair completes;
a runtime fault in either graph therefore publishes latency-matched dry for both
channels in that same callback, never one wet lane beside one dry lane. The Rack
never clocks one DSP object twice. A native 2x2 NAM model, if one is loaded, runs
once and does not receive a duplicate wrapper graph. Cabinet convolution
continues to process the resulting stereo lanes.

Changing among routing modes uses an 8 ms fade-out, a muted 24 ms plus reported
latency state-prime interval, and a 12 ms fade-in. The graph mode changes only at
zero gain, and the envelope is before post effects so existing delay/reverb
tails remain continuous. This avoids exposing a cold or stale inactive lane and
does not allocate, lock, reset a graph, or perform I/O on the audio callback.

Both 1x1 lanes are constructed off the callback. A failed replacement cannot
disturb an already active pair. On a first load, if only the optional right graph
cannot be constructed or prepared, the ready primary graph remains available
for mono routing. Parallel lanes add no second latency contribution, but stereo
processing is expected to approach twice the NAM inference cost. Mono routing
processes only the primary graph.

There is no Rack-level Mono/Stereo preference. The retired `inputMode` key is
absent from the public schema and is ignored and pruned from legacy project,
preset, A/B, baseline, portable-state, and direct-setter paths. Physical input
selection and track channel width remain DAW responsibilities. Diagnostics
publish the automatic and effective mode so the UI can explain transitions and
pause the mono-only Doubler without introducing another user setting. Loading a
compatible model or changing the DAW track width activates the corresponding
route through the same muted handoff described above.

### Meter topology contract

The input meter measures the routed signal before Input Trim. A configured mono
source renders one full-width lane; a configured stereo source renders genuine
L/R lanes. This presentation follows `routedInputChannelCount`, not the
effective NAM graph, so a stereo route remains visibly stereo if a mono-only
capture forces an internal fallback. Returning to mono clears the hidden right
peak and hold, and the numeric level and clip indication use only visible lanes.

The output meter always renders independent L/R peaks from the final Rack output
boundary. Linked input/output peak values remain compatibility fallbacks for an
older native build; the frontend never invents stereo values from a linked peak.

Low-buffer timing results are machine/build-specific `diagnostic_only`
evidence, not proof of ASIO stability. Driver safety and subjective stereo
presentation still require testing on the target system and exact release build.

### Cabinet Space presentation contract

Cabinet Space is a fixed post-cab presentation stage, before the reorderable EQ,
modulation, Delay, and Reverb. It also runs for captures with an embedded cab;
placing it inside the external IR function would incorrectly skip those rigs.
Room accepts new input only from an engaged external Cab/IR or an audible,
engaged Amp/Full-Rig capture with an embedded cabinet. With an amp-only capture
and the external Cab off, or with both Amp and Cab off, Room may remain armed
and its existing history may drain over unity dry, but raw DI cannot enter a new
tail; the UI reports **No cab source**.

Room Amount/Width feed a deterministic asymmetric 2x2 early-reflection field.
Doubler Mix/Spread and its 3-20 ms Delay (4.5 ms by default) add two independently
drifting short-delay voices around the selected time. Doubler generates stereo
only for a routed mono source; a true-stereo source pauses it with an explanation
without rewriting its saved enable, mix, delay, or spread. The close cab signal
remains an unattenuated centre anchor and the generated side is mixed as `+S/-S`,
so summing the output to mono cancels the added side rather than comb-filtering
the direct tone.

The design follows the practical contracts exposed by current guitar products:
mono can become stereo at a component boundary, while true stereo input remains
stereo; a doubler uses millisecond-scale spread; and cabinet presentation is
separate from the late Delay/Reverb. It also follows the DAFx open-source
widener findings that low frequencies should remain more centred and that a
decorrelated path needs transient handling. Accordingly, two cascaded side
high-passes keep bass anchored, and a shared onset envelope ducks only the wet
Room/Doubler fields (up to about 3/6 dB respectively) while leaving the direct
pick attack untouched.

The processor uses preallocated feed-forward early/Doubler paths plus a bounded,
damped four-line late-room network, with no runtime allocation, locks, logging,
or I/O. Its deterministic gates cover exact bypass, reset/partition equivalence,
mono-fold cancellation, mono-to-stereo generation, the 3.1 ms first reflection,
44.1/48/96 kHz operation, wet-only low-frequency side/mid balance, prefilled
automation, transient recovery, NaN/Inf recovery, bounded tail, and 8-sample
component timing. Wall-clock scheduler outliers remain diagnostic-only.
Perceived externalisation, naturalness, and similarity to a named product are
still `not_asserted` until a level-matched musician audition.

Cabinet Space is controlled independently from the external Cab/IR switch. In
the compact chain, its own power control restores the last Room Amount and
Doubler Mix (or starts at 22% Room / 12% Doubler); switching it off writes both
amounts to zero. In Cab > Device Controls, Room Amount and Doubler Mix are the
individual enables: either may be zero while the other remains audible, and
Width/Spread shape only their corresponding active field.

### Native pre-amp pedal level contract

Precision Drive and Distortion use one current pre-release implementation. They
share a `+12 dBu` native-pedal operating reference before the Amp NAM stage. If
the interface/rack calibration reference is `R dBu`, the shared nonlinear island
receives `R - 12 dB` before the selected shared 2x/4x/8x processing and applies
the exact reciprocal gain afterward. This keeps the represented analog pedal
level stable when the interface reference changes and avoids applying the
conversion twice when both pedals are stacked.

Precision Drive is a full-wet overdrive circuit, not an EQ-only boost. Attack
sets a frequency-selective feedback split: low frequencies retain the unity path
while upper lows and mids receive Drive-dependent gain into an asymmetric
nonlinear cell. Bright shapes the post-cell bandwidth, a DC blocker removes the
intentional asymmetry's offset, and Volume is an exact post-circuit gain. The
current default Volume is `+9 dB`, giving the pedal enough output to push a clean
Amp NAM; a saved explicit nonzero Volume remains the user's value.

Precision Gate is a local, input-keyed control whose Off position is exact
unity. Its stereo-linked detector reads the untouched calibrated island input,
while its gain is applied after the complete Precision circuit and Volume but
before Distortion. Threshold, hold, detector release, and smooth closing follow
the selected amount; reopening is fast. The nonlinear circuit remains warm
during closure, and linking the envelope never mixes audio between channels.

Distortion is a clean-room modern-heavy design informed by Empress's published
Heavy/Heavy Menace behavior, not a circuit clone. It distributes gain across
three zero-centred nonlinear cells with filtering between cells, then feeds a
stateful diode stage. `Weight` is a pre-distortion high-pass macro (`Tight` to
`Thick`), Tone controls interstage/presence voicing, and Heavy, Extreme, and
Crunch select distinct gain-density ranges. Mix crossfades the latency-aligned
clean stage input against the complete distorted branch. A fixed `-2.5 dB`
internal calibration keeps ordinary high-gain transients below the rack's
emergency knee; Level is applied exactly once after the complete topology.
`Dist Gate` is a dedicated stereo-linked idle-noise gate. Its detector reads
the untouched calibrated drive-island input before Precision Drive, while its
gain is applied after the complete Distortion circuit, Mix, and Level. This
input-keyed/post-distortion placement leaves the approved open tone unchanged
while suppressing small-signal noise buildup when the input drops below the
selected threshold. The current `0.22` default uses 6 dB hysteresis, a 35 ms
hold, a fast reopen, and a smooth close; `0` is the exact-unity bypass. The
nonlinear state remains warm during closure, and the linked envelope applies
the same gain to both channels without mixing audio between them.
The public design references are Empress's
[Heavy Menace overview](https://empresseffects.com/products/heavy-menace) and
[Heavy/Heavy Menace design history](https://empresseffects.com/blogs/empress-blog/the-heavy-menace-celebrating-10-years-of-heavy).

The shared island uses one latency-aligned power transition instead of
multiplying nested pedal fades. Mid-transition reversals remain continuous, and
reaching exact bypass performs bounded fixed-state cleanup. The shared IIR
oversampler is drained incrementally with zero input across ordinary bypass
callbacks rather than performing a capacity-sized reset in one low-buffer
callback. The path has independent left/right state and performs no runtime
allocation, lock, I/O, nested resampling, or lookahead.

The serialized `namEffectsDspVersion` field is an internal migration schema,
not a user preference or a supported legacy-engine selector. Because NAM Rack
has not shipped, every recognized old or missing marker is translated to the
one current implementation during binary, project, tone, and portable-state
restore. For pre-current presets only, the former default Precision Volume of
`0 dB` maps to the current `+9 dB` default; explicit nonzero controls and
model/IR resources are preserved. No old pedal DSP remains selectable or
runnable after restore.

### Other pre-NAM pedal contracts

The current Compressor exposes `Comp`, explicit `Attack` (0.1-50 ms), explicit
`Release` (50-1000 ms), a neutral-at-centre 500 Hz `Tone` tilt, an `Intensity`
switch, true parallel `Mix`, signed `Level` (-18 to +18 dB), and detector HPF
choices Off/80/240 Hz.
`Comp` moves the threshold from -6 to -44 dB and the knee from 12 to 2 dB;
`Intensity` selects an 8:1 or 16:1 ratio. Its calibrated gain-reduction meter is
shown on the pedal. The
range and interaction model deliberately cover the useful overlap documented
by Dyna Comp, Cali76, Empress Compressor MKII, and Keeley Compressor Plus,
without claiming to copy their proprietary OTA/FET circuits or synthesising
their noise.

The Compressor first builds its complete parallel signal and then applies the
signed Level control to that complete stage:

```text
stage = (1 - Mix) * dry + Mix * compressed
output = dBToGain(Output) * stage
```

The child compressor therefore has no hidden positive makeup contribution.
After Compressor bypass has drained its 25 ms transition, its detector,
RMS envelope, filters, and lookahead state are reset before the next engage.
The stable Level automation/state ID remains `compressorVolumeDb`. The retired
pre-release `Detail` macro is accepted only by migration: it is translated once
to its exact former effective attack/release times, removed, and never selects
another compressor implementation.

The Rack Graphic EQ is nine bands at 65/125/250/500 Hz and 1/2/4/8/16 kHz,
with +/-12 dB per band. Its HPF provides exact **Off** plus logarithmic
20-500 Hz travel; its LPF provides logarithmic 3-20 kHz travel plus clockwise
**Off**. Mirrored 6% endpoint detents, double-click-to-Off, value formatting,
automation, MIDI learn, and state all use the same mapping. Each filter retains
its last active cutoff while Off.

The processing order is HPF, nine bands, LPF, then the separate smoothed +/-12 dB
Level control. Both edge filters are stereo 12 dB/oct Butterworth responses with
smoothed coefficients and short Off/On transitions. The upper 16 kHz band is a
high shelf rather than a near-Nyquist bell. Flat/Off and whole-module bypass are
transparent, filter state remains warm while bypassed, and the minimum-phase
path adds no latency, saturation, hidden makeup, or modelled hiss. Migration
defaults the filters to Off and Level to 0 dB while preserving established band
IDs and private last-active cutoffs.

The former dedicated Tape Echo pedal is retired in NAM effects DSP version 17.
Its six `tapeEcho*` parameters are removed from processing, automation, schema,
and UI state. Legacy values are pruned without being mapped onto the post-FX
Delay, so recalling an older tone cannot overwrite that Delay's saved settings.
The existing post-FX Delay remains available and retains its Tape mode.

Gate topology is unchanged. The rack uses `Stereo Poly Octaver`: independent L/R
instances of the MIT Terrarium-derived ERB-PS2 topology, with fixed 6:1
multirate processing, 80 complex bands at `Fs/6`, fast phase scaling, and
polyphase reconstruction. Six-sample scheduling state is retained across host
callbacks, so arbitrary partitions are sample-exact. The production callback
performs no allocation, locking, I/O, coefficient design, or dynamic growth.

Deterministic fixtures cover exact silence/bypass, L-only isolation, identical
stereo parity, reset and fixed-versus-uneven callback partitions, NaN/Inf
recovery, 110/220/440/880 Hz target generation, at least 70 dB stop-band
rejection, and 44.1/48/96 kHz operation. All reset/partition/leak/parity errors
were exactly zero in the final Release run. The optimized isolated 48 kHz /
8-sample both-voice path measured p50 `2.9 us`, p99 `8.0 us`, and zero deadline
misses on the test machine. These are correctness and machine-specific timing
checks only: perceived chord tracking, pick transients, voicing, and
product-reference quality remain `not_asserted` until musician audition.

### Reverb

The active rack/instrument reverb is true stereo and offers four Voice choices:
`Studio`, `Plate`, `Hall`, and `Room`. The stable stored controls are Mix,
Pre-delay, Low cut, Decay, Tone, Shimmer, Pad, and Engage, but the hardware UI
relabels and remaps the tone/texture macros for each voice:

- Studio: **DECAY**, **TONE**, and **AIR**;
- Plate: **DECAY**, **DAMP**, and **SHIMMER**;
- Hall: **DECAY**, **DAMP**, and **MOTION** (pitch shimmer is disabled);
- Room: **SIZE**, **TONE**, and **EARLY** (pitch shimmer is disabled).

The stored Decay range is 0.2-12 seconds. Room treats that control as Size and
maps it to an effective room-decay range of roughly 0.45-3.2 seconds. Plate,
Hall, and Room shorten the low-band decay in Bass mode while leaving the user's
stored controls intact; Studio keeps its compatibility mapping.

Pad is a default-off additive texture over the unchanged selected Reverb, not a
replacement voice or an amount macro. It is sourced from an already diffused
reverb projection rather than dry guitar, and it never changes Mix, Pre-delay,
Low cut, Decay, Tone, Shimmer, or the Voice-specific texture mapping. Its
source-following body and separately bounded upper breath layer avoid feeding
the noise-like carrier through the long tank, limiting dense-note buildup while
retaining a sparse airy tail. Pad remains armed if Reverb is bypassed, crossfades
without resetting the base tail, and drains after Off.

The wet architecture has no dry latency, runtime allocation, lock, or
convolution. Non-finite/catastrophic recursive state clears only the reverb
history and mutes that wet block; the rack's final stereo-linked guard remains
the normal finite/level safety stage. Freeze, ducking, and former advanced
controls are not part of the active public schema. Recognized pre-release
markers are migration input only and normalize to the current reverb engine
during restore.

### State and recovery contract

- A rack preset represents the complete creative tone.
- Device calibration is playback-environment state and does not silently travel
  as creative preset state.
- Project state stores the exact child-capture/model identity, stable model/IR
  source identity, and the current rack parameters.
- Exported rack presets reference local NAM/IR files and do not embed the asset
  binaries. Recall on another machine may therefore require Locate, Search in
  Folder, or supported TONE3000 re-download.
- Factory effect templates contain no capture or IR and shape the currently
  loaded Amp/Full-Rig plus native stages.
- Fresh capture selections and direct Capture Library loads request **Full**
  model quality independently for the Pedal and Amp slots. Explicit saved
  **Economy** selections and the legacy global Slim value restore exactly; a
  snapshot with no quality field migrates to Full rather than inheriting the
  destination rack's current setting. Legacy global quality is expanded into
  per-slot values before preset import or Compare verification.
- Preview is transactional: Cancel restores the prior audible state; Use
  publishes the chosen asset; failed or superseded requests cannot overwrite a
  newer choice.
- Preset selection has one verified identity: none, factory ID, or user name.
  Loading drains pending parameter persistence, applies the complete snapshot,
  verifies native readback and model resources, then commits that identity.
  Failure keeps the prior identity and the manager open; serialized Previous and
  Next navigation always resolves from the last verified identity.
- Compare recall is transactional. It captures a complete authoritative rollback
  before mutation, verifies parameters, model resources, DSP version, stage
  order, and identity after recall, and verifies the rollback independently
  before claiming the prior rack was restored after any false return, exception,
  or readback mismatch.
- Current `.ospreset` storage is authoritative: a same-name legacy `.s13preset`
  must never overwrite it. Valid user migrations write the current form
  atomically, while corrupt legacy or user files remain untouched. Runtime
  factory originals are immutable and use migrated AppData shadows instead.
- The immediate in-rack recovery card detects missing Amp/Cab assets and exposes
  Locate, Replace, and Bypass. Project-open missing-media recovery additionally
  covers Pedal NAM paths and can offer Search in Folder, a library copy, Locate,
  and supported TONE3000 re-download when provider metadata exists.
- Full-rig captures bypass the external cabinet without discarding the user's
  previous cabinet selection.

## TONE3000 connection

Production builds receive the TONE3000 publishable `client_id` through
`TONE3000_PUBLISHABLE_KEY`. It is a public OAuth identifier, not a secret. Never
embed a server/client secret.

The native sign-in flow:

1. Creates a PKCE verifier, challenge, and state value.
2. Opens the normal TONE3000 authorize page in the default browser.
3. Listens on `http://127.0.0.1:18762/tone3000/callback`.
4. Verifies the returned state and exchanges the code with the verifier.
5. Stores tokens in the operating-system credential store: Windows DPAPI,
   macOS Keychain, or Linux Secret Service through `secret-tool`.
6. Restores a returning session and refreshes it before an authenticated action
   when required.

A first-time user can sign up in the same browser flow. The application should
never ask the user to copy an access token into a normal product screen.

### Search and transient-cache contract

Typed text is a draft until one remote request is committed after a 400 ms
debounce. Enter and the Search button flush that same request immediately without
leaving a second delayed request. Every request owns an immutable key containing
query, architecture, category/gear, source tab, sort, page size, and page; a
search-intent change invalidates the previous generation synchronously, so a
late success, error, or completion cannot alter the new rows or busy state.

In-flight requests and bounded LRU results are shared across Explorer remounts
for the current application session. A fresh cached result renders immediately;
stale rows may remain visible during background refresh. Filters, committed
query, appended pages, and scroll position survive remounts in that session.
Remote catalog results are not persisted without explicit TONE3000 approval;
installed/local assets and user presets remain durable local data.

Infinite browsing issues at most one request for each page/key, deduplicates by
stable ID, and provides an accessible Load More fallback. A failed append keeps
the accumulated rows and retries as an append; no speculative prefetch is used
under the service search-rate limit.

The initial model URL must use HTTPS on an official `tone3000.com` host.
Bounded HTTPS redirects to CDN hosts are allowed, while bearer credentials are
sent only to trusted TONE3000 hosts. OpenStudio validates the response, installs
to a durable local path, and preserves source attribution.
OpenStudio does not bulk-download, proxy, or re-host the TONE3000 catalog.

## TONE3000 partner approval gate

Before a public release enables the connected catalog, obtain written TONE3000
approval for the exact release candidate's endpoint scope, OAuth flow,
attribution, creator/license metadata, download behavior, and release wording.
The public build must remain usable with local NAM captures when the connected
service is unavailable or not configured.

## Release status

Objective DSP/state/download guards are automated. The remaining release
acceptance is intentionally external or human:

- authenticated TONE3000 review and a fresh-account end-to-end run;
- a real A1/A2 capture and cabinet-IR download, restart, recovery, and
  re-download;
- user audition of the exact build for tone, transition quality, low-buffer
  crackle, pedal feel, modulation, delay, reverb, and shimmer;
- a real screen-reader pass over bitmap-backed controls;
- confirmation that the release bundles no third-party captures or IRs by
  default; any future starter content requires separate license and
  redistribution approval.

See [NAM and audio QA](testing.md) for the executable checklist.
