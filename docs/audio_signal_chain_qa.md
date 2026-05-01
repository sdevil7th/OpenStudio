# Audio Signal Chain QA

Pitch, render, and playback artifact work must start with the signal chain before any DSP tuning.

## Chain References

- Live playback: clip route resolution -> `PlaybackEngine` read/mix -> `TrackProcessor` -> sends/sidechain -> master/monitoring FX -> gain/pan/mono -> meters/spectrum -> audio device.
- Offline render/export: `renderProject` -> render `PlaybackEngine` snapshot -> `TrackProcessor` -> master FX/gain -> writer.

If a click/noise is present in an exported render, debug the shared render/playback path first. Do not attribute it to WebView IPC, audio-device underruns, or live-only preview routing until the render chain is clean.

## Render Chain Debug Packet

Set `OPENSTUDIO_AUDIO_CHAIN_DEBUG=1` before rendering to emit a debug packet next to the rendered file, or set `OPENSTUDIO_AUDIO_CHAIN_DEBUG_DIR` to choose a folder. The packet includes:

- `render_chain_report.json`
- `playback_output.wav`
- `track_post_processing.wav`
- `master_pre_fx.wav`
- `master_post_fx.wav`
- `writer_input.wav`

The report records per-block route/source details and peak/RMS/high-derivative/non-finite stats. Use `OPENSTUDIO_AUDIO_CHAIN_DEBUG_MAX_SEC` to cap the captured duration; the default is `12` seconds.

## First Dirty Stage Rule

- Dirty at playback: inspect source routing, stale pitch-preview state, reader/sample-rate conversion, chunking, and hot-path allocation counters.
- Dirty after track/master processing: inspect no-FX bypass, processor reset/state, default EQ/gain, and denormal handling.
- Dirty only at writer output: inspect write alignment, format conversion, dither, and block/tail handling.
- Dirty only in live playback after clean render: inspect callback duration/deadline counters, spectrum lock misses, callback resizes, IPC/timer pressure, and transport preview cleanup.

Do not call a render-noise fix done until the first dirty stage is identified and the fixed output passes spectrogram/high-derivative checks plus user audition.
