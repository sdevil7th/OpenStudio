# NAM Rack

The NAM Rack is OpenStudio's free, open-source guitar workspace. It hosts Neural
Amp Modeler A1 and A2 amp or full-rig captures inside the DAW, surrounds them
with native pedals and studio effects, loads cabinet impulse responses, saves
complete tones, and optionally connects to TONE3000.

OpenStudio does not charge to unlock the rack or its built-in effects. NAM and
OpenStudio are open source. Third-party captures and impulse responses still
retain their creators' licenses.

## Musician workflow

1. Add the NAM Rack to a track and choose the live guitar input.
2. Set the device buffer and input trim, then tune.
3. Load a local A1/A2 capture or connect TONE3000 and choose an allowed capture.
4. If the capture is amp-only, load a cabinet IR. A full-rig capture that
   already contains a cabinet bypasses the separate cabinet stage.
5. Shape the front end with the native pedalboard and finish the sound with EQ,
   modulation, delay, and reverb.
6. Save the complete rack as a tone or project state.

The current audible route is:

```text
Input trim
  -> Gate
  -> Compressor
  -> Tape Echo
  -> Stereo Poly Octaver
  -> Precision Drive
  -> Distortion
  -> optional A1/A2 Pedal NAM capture
  -> A1/A2 Amp or Full-Rig NAM capture
  -> Cabinet IR and cabinet shaping
  -> Cabinet Space (early Room / optional Doubler)
  -> reorderable EQ / modulation / delay / reverb
  -> Output trim and meters
```

The tuner observes the input without becoming part of the audible chain.
Pedal NAM is an optional serial pre-amp slot. When loaded, its calibrated wet
path and the native pedalboard feed the Amp/Full-Rig NAM slot; a partial Pedal
mix preserves the single-input dry/wet balance before a following mono Amp NAM.
The current auto-fold still infers a one-live-side route
from each audio block. That preserves established sessions but is not explicit
host-route metadata: a callback that straddles the first stereo Tape repeat is
a documented compatibility limitation until route provenance is carried into
the rack.
The former global live Transpose, Chaos mode, Glitch, and Laser product
controls are retired. The new Cabinet Space Doubler is a separate post-cab
presentation effect, not a revival of the retired global control. Legacy Laser
fields are ignored and pruned when old projects are restored; they are not
exposed or processed by the active rack.

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
- Precision Drive and Distortion share one fixed 2x nonlinear rate island.
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

The complete Release rack diagnostic at 48 kHz / 8 samples included Compressor,
Tape Echo, Stereo Poly Octaver, both native drives, A1 Pedal NAM, A2 Amp NAM,
Cab IR, Room/Doubler, EQ, modulation, Delay, and Reverb. Three current-source
runs on the test machine measured Single-NAM average/p99/p99.9 of
`56.51/75.5/91.3 us`, `59.69/98.3/340.2 us`, and `58.50/92.4/353.0 us`, with
`0/29/18` of 4096 userspace calls over the `166.67 us` deadline. Dual NAM
measured `100.12/120.2/142.5 us`, `104.24/300.9/404.3 us`, and
`103.79/160.0/436.9 us`, with `0/62/37` misses. The averages remain below the
callback budget, but the scheduler-sensitive tail does not demonstrate reliable
8-sample operation. These are machine/build-specific `diagnostic_only` results,
not proof of ASIO stability. Driver safety and subjective stereo presentation
still require testing on the target system.

### Cabinet Space presentation contract

Cabinet Space is a fixed post-cab presentation stage, before the reorderable EQ,
modulation, Delay, and Reverb. It also runs for captures with an embedded cab;
placing it inside the external IR function would incorrectly skip those rigs.
Room Amount/Width feed a deterministic asymmetric 2x2 early-reflection field.
Doubler Mix/Spread add two independently drifting short-delay voices. The close
cab signal remains an unattenuated centre anchor and the generated side is
mixed as `+S/-S`, so summing the output to mono cancels the added side rather
than comb-filtering the direct tone.

The design follows the practical contracts exposed by current guitar products:
mono can become stereo at a component boundary, while true stereo input remains
stereo; a doubler uses millisecond-scale spread; and cabinet presentation is
separate from the late Delay/Reverb. It also follows the DAFx open-source
widener findings that low frequencies should remain more centred and that a
decorrelated path needs transient handling. Accordingly, two cascaded side
high-passes keep bass anchored, and a shared onset envelope ducks only the wet
Room/Doubler fields (up to about 3/6 dB respectively) while leaving the direct
pick attack untouched.

The processor has no feedback network, runtime allocation, locks, logging, or
I/O. Its deterministic gates cover exact bypass, reset/partition equivalence,
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
receives `R - 12 dB` before fixed 2x processing and applies the exact reciprocal
gain afterward. This keeps the represented analog pedal level stable when the
interface reference changes and avoids applying the conversion twice when both
pedals are stacked.

Precision Drive is a full-wet overdrive circuit, not an EQ-only boost. Attack
sets a frequency-selective feedback split: low frequencies retain the unity path
while upper lows and mids receive Drive-dependent gain into an asymmetric
nonlinear cell. Bright shapes the post-cell bandwidth, a DC blocker removes the
intentional asymmetry's offset, and Volume is an exact post-circuit gain. The
current default Volume is `+9 dB`, giving the pedal enough output to push a clean
Amp NAM; a saved explicit nonzero Volume remains the user's value.

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
while preventing the circuit's roughly 75 dB near-zero gain from turning
pickup/interface noise into broadband fizz. The current `0.22` default uses
6 dB hysteresis, a 35 ms hold, a fast reopen, and a smooth close; `0` is the
exact-unity bypass. The nonlinear state remains warm during closure, and the
linked envelope applies the same gain to both channels without mixing audio
between them.
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
restore. Persistent user `.ospreset` files are rewritten atomically after a
successful migration; runtime factory originals are left untouched and receive
a migrated AppData shadow. Corrupt presets are not rewritten. For pre-current
presets only, the former default Precision Volume of `0 dB` maps to the current
`+9 dB` default; explicit nonzero controls and model/IR resources are preserved.
No old pedal DSP remains selectable or runnable after restore.

### Other pre-NAM pedal contracts

The current Compressor exposes `Comp`, explicit `Attack` (0.1-50 ms), explicit
`Release` (50-1000 ms), a neutral-at-centre 500 Hz `Tone` tilt, true parallel
`Mix`, signed `Level` (-18 to +18 dB), and detector HPF choices Off/120/240 Hz.
`Comp` spans a 2:1 to 20:1 ratio with a progressively lower threshold and
firmer knee. Its calibrated gain-reduction meter is shown on the pedal. The
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
with +/-12 dB per band. The upper 16 kHz control is a high shelf rather than a
near-Nyquist bell, and the complete EQ has a separate smoothed +/-12 dB Level
control for gain matching and headroom. Flat/unity and bypass are transparent;
the minimum-phase path adds no latency or modelled hiss. State migration fills
the new Level at 0 dB and preserves the established band IDs.

Tape Echo uses an additive send law:

```text
output = dry + EchoLevel * echo
```

The direct guitar therefore stays at unity while Echo Level raises the repeats.
Bypass stops recording new input but lets the already-recorded stereo repeats
spill over the unity direct path. The runtime dry/send smoothers are initialized
to this law both at prepare time and after rack reset. The stable state ID remains
`tapeEchoMix`; the schema calls it `Echo Level`.

Moving Tape Mod publishes the raw control target to the child delay and uses a
40 ms sample-domain morph for its Mod-derived width,
feedback colour/cross-feed, and right-head time. This passed fixed-versus-uneven
callback rendering with a maximum error of `3.7439e-7`; the control also differed
materially from static Mod, so the invariant cannot pass by ignoring automation.
The shared right-head morph means Tape Time/Mod-derived head movement uses that
same 40 ms response. Standalone Delay and the post-NAM rack Delay retain their
existing timings.

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

The active rack pedal is one true-stereo guitar reverb, using an eight-line
feedback delay network with fixed input diffusion and decorrelated stereo
output decoding.
The current reverb starts with a hall-sized primary tank and follows a
zero-slope curve from 0.2 to 6 seconds of Decay. Its feedback coefficients are
recalculated from the per-line times, preserving the requested RT60. A gently tapered
square-root late-output compensation counters the lower impulse density of
longer lines without making the longest setting louder.

It adds a stereo architectural early-reflection pattern, spreads that pattern
into the tank, decodes a second set of fixed tank taps, and applies two short
output-only allpasses per channel. These layers create a later, more distributed
spatial field rather than relying on a louder wet signal. The recursive reads
remain fixed: moving
fractional feedback taps can inject a small positive loop-energy error that
compounds during a long armed session. The eight incommensurate tank lengths,
secondary taps, and output diffusers provide decorrelation without moving the
recursive poles.

Changing Decay crossfades the old and requested tank read heads over 80 ms and
queues the newest request when a morph is already active. The second read exists
only during that transition; steady state uses one read per tank line. The
design adds no dry latency, runtime allocation, second tank, lock, or
convolution. It uses a perceptual wet-gain curve while leaving the dry path
at unity, so a half-position Mix produces a clearly established space without
wrapping or attenuating the direct guitar tone.

Finite reverb samples have no separate tank or wet-output safety knee.
The rack's final stereo-linked guard remains the only normal finite-value
shaper. A separate integrity fallback clears only the reverb history and mutes
the current wet block if recursive state is non-finite or exceeds catastrophic
internal headroom; normal wet audio and the sample-exact dry branch are not
shaped by that fallback.

Its six sound controls are Pre-delay, Decay, Mix, Low cut, Tone, and Shimmer;
Engage is the only switch. Pre-delay applies before every wet path, and Shimmer
adds a filtered, decorrelated octave-up signal primarily inside the feedback
loop. With Shimmer at zero, the pitch shifters leave the audio callback.

Room/Plate/Hall selection, Freeze, ducking, and the former advanced reverb
controls are not part of the active rack UI or parameter schema. Recognized
pre-release reverb markers are migration input only and normalize to the one
current rack reverb during restore.

### State and recovery contract

- A rack preset represents the complete creative tone.
- Device calibration is playback-environment state and does not silently travel
  as creative preset state.
- Project state stores stable model/IR identity and the current rack parameters.
- Preview is transactional: Cancel restores the prior audible state; Use
  publishes the chosen asset; failed or superseded requests cannot overwrite a
  newer choice.
- Missing assets expose Locate, Replace, Bypass, and supported Re-download
  actions without disabling the rest of the rack.
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
5. Stores tokens in a private local session file; Windows uses DPAPI.
6. Restores a returning session and refreshes it before an authenticated action
   when required.

A first-time user can sign up in the same browser flow. The application should
never ask the user to copy an access token into a normal product screen.

Downloads accept only HTTPS URLs on an official `tone3000.com` host, apply a
redirect limit, avoid forwarding bearer credentials to another host, validate
the response, install to a durable local path, and preserve source attribution.
OpenStudio does not bulk-download, proxy, or re-host the TONE3000 catalog.

## Private TONE3000 review before public release

Public source or a public download is not required for partner review. Send the
TONE3000 team a private release candidate containing:

- a Windows installer or portable release archive and SHA-256 checksum;
- the exact version/commit and supported OS;
- a one-page integration note with OAuth redirect URI, endpoints used,
  attribution, storage, download validation, and deletion behavior;
- a two-minute screen recording of first-time sign-up/sign-in, A1/A2 search,
  install, Use, restart/session restore, and re-download;
- a short test script and a contact for a live walkthrough;
- optional read-only access to a private repository or a source archive if they
  request code inspection.

They can test the binary with their own account and registered test client. A
private GitHub pre-release, expiring cloud link, or invited private-repository
reviewer is sufficient. Ask them to confirm in writing that the implemented
search/detail/download scope, OAuth flow, attribution, and release wording are
approved for OpenStudio.

If the main repository is public, remember that pushing an ordinary branch
publishes that branch immediately. For a review before public disclosure, use
a private fork or private repository and invite the TONE3000 reviewer. Pin the
review to one commit so their feedback maps to an exact build.

Suggested email:

> **Subject:** OpenStudio NAM Rack — private TONE3000 integration review
>
> Hi TONE3000 team,
>
> I am preparing the NAM Rack for OpenStudio, a free and open-source DAW with
> no paid NAM Rack tier or related upsell. It gives musicians a built-in Neural
> Amp Modeler A1/A2 guitar rig with native pedals, cabinet IRs, studio effects,
> presets, project recall, and optional TONE3000 discovery and delivery.
>
> I would appreciate a private review before we announce or release the
> integration. The review branch is:
>
> **Branch:** `[PRIVATE_BRANCH_URL]`  
> **Commit:** `[COMMIT_SHA]`  
> **Windows build:** `[PRIVATE_BUILD_URL]`  
> **SHA-256:** `[BUILD_SHA256]`
>
> The current integration uses OAuth Authorization Code with PKCE and the
> loopback redirect `http://127.0.0.1:18762/tone3000/callback`. Access tokens
> are stored locally; on Windows the token file is protected with DPAPI. The
> client requests `/api/v1/tones/search`, `/api/v1/tones/{id}`, and
> `/api/v1/models`, then downloads only the model or IR explicitly selected by
> the authenticated user. OpenStudio validates official HTTPS download hosts,
> preserves creator/license/source metadata, and does not bulk-download,
> mirror, proxy, or re-host the catalog.
>
> I understand that the current free API tier documents OAuth prompt flows and
> bounded list endpoints, while OpenStudio's proposed experience includes
> richer search and detail browsing. Could you please confirm whether this
> endpoint scope can be approved for OpenStudio, or tell me which flow you
> would prefer us to ship?
>
> I have included screenshots of the rack, A1/A2 amp slot, pre- and post-FX,
> cabinet/IR workflow, calibration, presets, TONE3000 browser, audition, and
> install path. The catalog examples in the screenshots are deterministic mock
> review records, not production TONE3000 content. The supplied build and
> branch contain the real integration for your live-account testing. I can also
> provide a short first-time-account recording or join a live walkthrough
> using a test account you supply.
>
> Please also let me know whether the displayed “TONE3000” naming,
> attribution, creator metadata, and release wording meet your design and
> branding requirements.
>
> Thanks for building such an important home for the NAM community. I would be
> grateful for any product, API, security, or UX feedback.
>
> Best,  
> `[NAME]`  
> OpenStudio  
> `[CONTACT]`

## Release status

Objective DSP/state/download guards are automated. The remaining release
acceptance is intentionally external or human:

- authenticated TONE3000 review and a fresh-account end-to-end run;
- a real A1/A2 capture and cabinet-IR download, restart, recovery, and
  re-download;
- user audition of the exact build for tone, transition quality, low-buffer
  crackle, pedal feel, modulation, delay, reverb, and shimmer;
- a real screen-reader pass over bitmap-backed controls;
- license approval for any starter captures or IRs bundled with a release.

See [NAM and audio QA](testing.md) for the executable checklist.
