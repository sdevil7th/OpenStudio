# Local Signalsmith Stretch adaptation

The bundled header identifies itself as Signalsmith Stretch 1.3.2. OpenStudio's
standalone Shimmer Spread adapter opts into an additional template argument:
`SignalsmithStretch<float, void, true>` enables the existing Linear STFT/FFT
incremental computation stages. The default third argument is `false`, retaining
the previous FFT configuration for callers that keep the default, including
Original Shimmer. No analysis window, hop, pitch map or latency is changed by
this template argument. The existing runtime split-computation option still
controls the one-hop output schedule.

Keep the argument and `DynamicSTFT` instantiation together when updating this
vendor header. `reverb-shimmer-performance` compares the optimized adapter with
the previous adapter at four sample rates and all four role offsets, and verifies
incremental reset parity. `reverb-shimmer-scheduling` covers automation, reset,
mono/stereo, callback heap activity and host block partition independence.
These checks do not qualify subjective audio quality or other platforms.

The October 12 standalone Pitch Correct signal-repair follow-up also opts into
fine FFT steps for **Corrected** Signal path. Legacy retains the default template.
Both keep `presetCheaper`'s window/hop and latency. The `signal-pitch-fft-parity`
regression compares their output and latency with static transpose/formant
settings; `signal-pitch-performance` measures the complete processors, including
the separately distributed, rate-normalized YIN detector. Its analysis decision
schedule adds up to one analysis hop; that detector schedule is not a vendor
FFT change. No other pitch consumer is migrated by this opt-in.

The Design03 Reverb follow-up adds an optional `beginReset` / `resetStep`
interface to Stretch, backed by bounded STFT clearing and input/output state
copy steps. `configure` prepares the cold window-normalization image off the
callback. The existing synchronous `reset` and transform processing remain
available and unchanged. A voice using incremental reset must remain inactive
until every step completes; all vectors are already sized by preparation.
Standalone Shimmer clears at most 32 elements per voice per sample before its
existing silent role priming and real-input warmup. Original steady processing
still uses its original adapter and FFT plan. Spread retains its 120 ms window,
30 ms hop and 64-sample adapter latency while servicing its processing in
eight-sample quanta. The focused performance regression checks the retained
adapter's signal parity, exact reset replay, step counts and callback heap;
scheduling tests cover cancellation, reversed changes and stale history.
The optional `beginProcessGroup` / `groupSilence` argument preserves the old
64-sample silence decision and transpose update when that group is serviced
in smaller pieces. The adapter double-buffers complete input groups and finishes
each output slice before its original playback deadline. Default callers still
classify their complete process call exactly as before. The regression includes
broadband wake-up after long silence and resets after populated spectral history;
accepting a larger error instead would hide a scheduling-induced signal change.
