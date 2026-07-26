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
  -> Mono Octaver
  -> Precision Drive
  -> Distortion
  -> Laser
  -> A1/A2 Amp or Full-Rig NAM capture
  -> Cabinet IR and cabinet shaping
  -> reorderable EQ / modulation / delay / reverb
  -> Output trim and meters
```

The tuner observes the input without becoming part of the audible chain.
Historical Pedal NAM state is read only for project migration; the current
product uses the dedicated native pedalboard before one Amp/Full-Rig NAM slot.
The former live Transpose, Chaos mode, Glitch, and Doubler product controls are
retired. Legacy internal parameter names may remain where needed to restore old
projects.

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
