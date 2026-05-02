# What It Took to Bring ACE-Step Music Generation Into OpenStudio

Adding ACE-Step music generation to OpenStudio looked, at first, like a straightforward integration task. We had a known-good workflow, we had the model files, and we had a clear product goal: let a user type a prompt and lyrics, press generate, and get a coherent song directly inside the app. No separate graph editor, no external desktop runtime, no manual model wiring.

The hard part was that the visible workflow was only the surface of the system.

ACE-Step is not just one model file and one inference call. It is a graph of model loading, text and lyric conditioning, latent creation, sampling, VAE audio decoding, runtime memory management, and file export. Two systems can appear to run the same graph and still produce very different audio if they differ in dtype selection, executor semantics, CUDA builds, decode strategy, cache lifecycle, or even the exact shape assumptions used while loading a checkpoint.

This document is a short write-up of the main challenges we hit, why they were deceptive, and what ultimately made the integration work.

## The First Trap: Same Settings Did Not Mean Same Sound

The first symptom was simple and frustrating: OpenStudio generated audio, but it did not sound like the reference render. It was audible, but it was not musically coherent in the same way. There were too many artifacts, too much random noise, and the result felt degraded even when prompt, lyrics, seed, model selection, sampler settings, and duration all appeared to match.

That is the kind of bug that tempts you to stare at UI parameters forever. Is the BPM being passed as a number or a string? Is `3/4` becoming `3`? Is the seed staying `-1` or being normalized to `0`? Is CFG being mapped to the right sampler field?

Those checks mattered, but they were not enough. We eventually confirmed the visible graph was broadly right:

- ACE 1.5 XL Turbo diffusion model
- Qwen 0.6B and 4B ACE text encoders
- ACE 1.5 VAE
- AuraFlow shift set to `3`
- `KSampler` using `euler`, `simple`, `steps=8`, `cfg=1`, `denoise=1`
- text conditioning through `TextEncodeAceStepAudio1.5`
- full `VAEDecodeAudio` path

The missing piece was that a graph is not only node names and widget values. A graph is also the executor, runtime context, memory policy, tensor dtype policy, cache behavior, and node implementation version.

## Checkpoint Shape Mismatches Were Real Bugs, But Not The Whole Bug

Early failures were more obvious. The runner crashed while loading ACE model weights with long lists of tensor shape mismatches. The model expected dimensions like `2048`, while the checkpoint contained decoder tensors shaped around `2560`.

That pointed to an ACE 1.5 split-shape issue. The encoder and decoder do not use the same hidden sizes in the XL checkpoint. A simpler config path treated them as if they shared dimensions, which made weight loading impossible or partially wrong.

The fix was to teach the packaged runtime to detect and preserve separate encoder and decoder dimensions:

- encoder hidden/intermediate sizes
- decoder hidden/intermediate sizes
- encoder and decoder attention head counts
- key/value head counts
- the 2048-to-2560 conditioning projection

That fixed the obvious state-dict loading failures. It did not, by itself, fix the sound quality. This was the first big lesson: a crash fix can get the model to run, while the model can still be running under subtly wrong runtime semantics.

## Decode Was A Quality Boundary, Not Just A Final Step

Another suspicious symptom showed up near the end of long renders. Generation would appear to make progress, then stall around audio decode, sometimes eventually failing with CUDA out-of-memory. Earlier experiments allowed fallback to tiled VAE decode. Tiling is a valid low-memory strategy in many image/audio pipelines, but it is also a quality-sensitive change.

For this specific goal, silently falling back was the wrong product behavior. If the reference path uses full VAE decode and OpenStudio silently returns tiled decode, then OpenStudio may "succeed" while producing a degraded song. That is worse than a clear failure, because it hides the real mismatch behind a bad output.

So we changed the default expectation:

- full decode is the quality path
- no silent tiled fallback in normal generation
- if full decode runs out of memory, fail clearly
- do not return a lower-quality result while pretending generation succeeded

That made failures more honest. It also helped narrow the problem: if full decode succeeds, the sound should be judged; if it cannot succeed, we need memory work rather than audio post-processing guesses.

## Direct Node Calls Were Not Equivalent To Real Graph Execution

The most important implementation change was moving away from manually calling individual nodes.

The direct runner originally assembled the right pieces, but it still called into nodes like an approximation:

1. load models
2. call text encode
3. call sampler
4. call VAE decode
5. save WAV

That sounds equivalent to graph execution, but it was not. The executor wraps node execution in a particular inference context, manages object and output caches, handles node output conventions, and applies memory lifecycle behavior. It also normalizes modern node APIs differently from older tuple-returning node APIs.

This difference produced several bugs:

- an in-place update error from tensors created under inference mode but later mutated outside the expected context
- invalid assumptions about node output shape
- missing executor cache arguments
- memory pressure that did not match the reference path

The final working direction was to make OpenStudio own a packaged ACE runtime and execute a generated prompt graph through the executor semantics, rather than approximating the graph with manual calls.

OpenStudio now builds the ACE prompt graph with fixed node IDs and known-good values, runs it through the packaged executor, extracts the decoded audio object from the executor output cache, and writes the requested WAV output without extra normalization, compression, or resampling.

## The Output Was Wrapped One More Time Than Expected

One of the final bugs was small but revealing. After switching to executor-based graph execution, the graph ran, but OpenStudio reported:

```text
OpenStudio ACE graph produced an invalid decoded audio object.
```

The decode node was not actually producing invalid audio. Our extraction code was wrong.

The direct-call path expected:

```python
audio = {"waveform": ..., "sample_rate": ...}
```

The executor cache stored the single-output node result one layer deeper:

```python
[{"waveform": ..., "sample_rate": ...}]
```

So OpenStudio was validating a list as if it were the audio dict. The fix was a small `unwrap_executor_output()` helper that unwraps single-item list/tuple layers before validation. That is a tiny code change, but it represents the broader theme: executor semantics are not optional details. They are part of the runtime contract.

## Runtime Version Differences Mattered

Another challenge was that the working reference environment was not identical to OpenStudio's initial runtime. Python version, PyTorch CUDA build, runtime package versions, and node implementation details all differed.

Some examples:

- different Python versions
- different CUDA wheel builds
- different packaged node code
- different latent dtype behavior
- different model-management behavior

One concrete mismatch was latent dtype creation. The ACE 1.5 latent node needs to use the runtime's intermediate dtype, not a hardcoded default that happens to work in one environment. If latents are created at a different dtype or device policy, sampling can still complete but produce different numerical behavior.

The eventual answer was not to require users to install the reference environment. That would be fragile and hostile to the product experience. Instead, OpenStudio vendors the required open-source runtime files under an OpenStudio-owned package boundary and runs its own packaged ACE graph.

That gives us a stable product story:

- users do not need a separate graph app installed
- OpenStudio controls the runtime files it ships
- the installer controls Python dependencies and models
- generation can work offline after setup

## Offline Behavior Needed To Be Explicit

A local AI feature should not unexpectedly reach the internet during generation after setup is complete. The first install or AI setup can download packages and model checkpoints, but a normal generation run should use local assets only.

To make that clear, the runner validates the required local assets first:

- diffusion model
- text encoders
- VAE

Only after validation does it enable offline environment guards:

```text
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
HF_DATASETS_OFFLINE=1
```

If a model file is missing, OpenStudio should tell the user to run AI setup while connected to the internet. It should not attempt a surprise download from the generation path.

This matters for trust. A musician should be able to install the AI tools once, go offline, and still generate music as long as the needed files are already present.

## Packaging Was Part Of The Feature

The integration was not done when the model produced sound on one development machine. It also had to be packaged correctly.

That meant:

- copying `openstudio_ace_runner.py` into the app artifacts
- copying `openstudio_ace_backend` into the app artifacts
- keeping third-party license files
- removing stale debug/parity scripts from reused build directories
- pruning unused API-node runtime files that were not part of ACE generation
- updating Linux and macOS dependency manifests
- making sure Windows, Linux, and macOS install paths all prepare enough Python dependencies

The vendored runtime is large, but most of it is source code, not model weights. The truly large files are the ACE checkpoints, which live in the user's model/cache area and are downloaded by setup. The runtime package exists so OpenStudio can execute the graph consistently without depending on another app being installed.

## What We Learned

The biggest lesson is that AI workflow integration is often not a "call the model" task. It is a runtime reproduction task.

For ACE-Step, correctness depended on several layers lining up at once:

- checkpoint shape detection
- text-conditioning semantics
- latent dtype/device policy
- sampler settings
- executor context
- cache and output conventions
- VAE decode strategy
- memory behavior
- packaging and install dependencies
- offline asset validation

When any one of those is wrong, the failure mode may not be a clean crash. It may be worse: a song that technically renders but sounds wrong.

That is why this took longer than simply copying visible workflow values. The visible graph told us what should happen. The runtime determined what actually happened.

## The Current Shape

OpenStudio now owns the ACE generation path:

- it builds a known ACE graph internally
- it executes through the packaged OpenStudio ACE runtime
- it uses full VAE decode as the quality path
- it writes WAV output directly
- it validates local model files before generation
- it can run offline after setup
- it does not require users to install a separate graph runtime

There is still future cleanup and hardening we can do. The vendored runtime can probably be reduced further with careful import and generation tests. Linux and macOS need real-machine validation, not just manifest and import checks from Windows. Long renders still depend on available VRAM, and full decode should fail clearly if the machine cannot handle the requested duration.

But the important architectural turn has happened: OpenStudio is no longer approximating ACE-Step from the outside. It owns a packaged graph execution path and treats the runtime semantics as part of the feature.

That is what finally made the generated song behave like a song.
