# README animation

`openstudio-session.gif` is a screen recording of the **real Windows desktop
application**, captured on 5 October 2026. The native JUCE application loads
the project, plays its media and instruments, and supplies the live meters.
The recording captures its embedded WebView2 surface at `https://juce.backend`.
It shows arrangement playback followed by opening the docked piano roll.

Capture source: the existing local `build/OpenStudio_artefacts/Release/OpenStudio.exe`,
which reported app version **0.1.02**. This identifies the binary used; it is
not a claim that the local build matches a published release tag or every
change currently in the working tree. No app source changes were needed.

The GIF is silent. The first frame shows the actual arrangement and mixer.
Keep the GIF in the repository and reference it with a relative path.

## Demo project

Generate the original media and project from the repository root:

```sh
python tools/generate-readme-demo.py
```

The generator requires NumPy and writes to ignored `output/readme-demo/`:

- `Neon Morning.osproj`: six tracks, 24 clips, 120 BPM, 16 bars.
- Four 44.1 kHz mono WAV phrases: drums, percussion, bass and atmosphere.
- Two standard MIDI files: piano chords and an arpeggio.
- The project uses OpenStudio Piano and OpenStudio Basic Synth, with no
  downloaded samples, models or third-party plug-ins.

Open the generated project in the desktop app. Media paths point to the
generator's output directory; regenerate after moving the directory to a
different location or machine. Saving through the app preserves its media
and instrument assignments.

## Refreshing the capture

Capture the native app's main WebView while the project plays. For this
recording the maximized app content was 2560 × 1392, tracks were 120 px high,
and the mixer was open. Open the Piano / Chorus clip after about 16 seconds
and expand the docked piano roll enough to show the notes and velocity lane.
Retain raw recording and review evidence under ignored `output/playwright/`.

The export trims the initial setup, crops unused space at the right, resizes
the recording and quantizes it to a GIF palette. No UI or meters are fabricated.
Convert the recorded video with system FFmpeg, from the repository root:

```sh
ffmpeg -y -ss 2 -t 22 -i output/playwright/openstudio-real-app.webm -filter_complex "[0:v]fps=10,crop=1944:1392:0:0,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 assets/readme/openstudio-session.gif
```

The current export is 1000 × 716, 22 seconds, 220 frames, and about 5.3 MB.
Review the exported GIF in a browser and keep the first frame useful when
animation is disabled.

## Verification for this capture

- **pass**: generated project accepted by the frontend project validator,
  loaded in the native app and saved through the app with all 24 clips and
  both instrument assignments retained.
- **pass**: native diagnostics reported 16 audio clips and 8 scheduled MIDI
  clips (640 MIDI events); all six tracks returned nonzero meter values
  during playback.
- **pass**: WAV headers, duration and finite PCM peaks checked; GIF frames,
  duration, loop, main arrangement and visible piano-roll notes checked.
- **not_asserted**: subjective audio quality; no listening approval was obtained.
