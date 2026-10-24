#pragma once

#include "AudioEngine.h"
#include "BuiltInEffects2.h"
#include "NAMFuzz.h"
#include "NAMFuzzAliasRegression.h"
#include "NAMFuzzInteractionRegression.h"
#include "NAMFuzzSignalRegression.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <memory>
#include <numeric>
#include <vector>

// Deterministic contracts only. Voice measurements are diagnostics, not an
// assertion of pedal similarity, naturalness, or user-approved sound quality.
class NAMFuzzRegression final
{
public:
    static juce::Array<juce::var> run(AudioEngine& engine)
    {
        juce::Array<juce::var> checks;
        for (const double rate : { 44100.0, 48000.0, 96000.0 })
        {
            runCore(checks, rate);
            runCalibration(checks, rate);
            runOctaverLifecycle(checks, rate);
        }
        runReprepare(checks);
        runBassGateContract(checks);
        runRackRouting(checks);
        runState(checks);
        runBridge(checks, engine);
        checks.add(OpenStudioNAMRack::runDistortionADAARegression());
        checks.add(OpenStudioSaturator::runLowCutPrecisionRegression());
        checks.add(NAMFuzzSignalRegression::runPartitionSmoke());
        for (const auto& check : NAMFuzzSignalRegression::run()) checks.add(check);
        for (const auto& check : NAMFuzzInteractionRegression::run()) checks.add(check);
        for (const auto& check : NAMFuzzAliasRegression::run()) checks.add(check);
        add(checks, "nam_fuzz_subjective_audio_quality", "not_asserted",
            "Tone, octave-chord articulation, pedal similarity, alias audibility and guitar/bass preference require audition of the exact output. Deterministic checks do not approve sound quality.");
        return checks;
    }

private:
    static void runOctaverLifecycle(juce::Array<juce::var>& checks, double rate)
    {
        const auto result = NAMPolyOctaver::runLifecycleSelfTest(rate);
        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", rate);
        value->setProperty("retirementPartitionPassed", result.retirementPartitionPassed);
        value->setProperty("unaffectedVoicePassed", result.unaffectedVoicePassed);
        value->setProperty("retiredProfileRecallPassed", result.retiredProfileRecallPassed);
        value->setProperty("fuzzPairPartitionPassed", result.fuzzPairPartitionPassed);
        value->setProperty("retirementComparisons", result.retirementComparisons);
        value->setProperty("profileComparisons", result.profileComparisons);
        value->setProperty("fuzzPairComparisons", result.fuzzPairComparisons);
        value->setProperty("maximumRetirementDifference", result.maximumRetirementDifference);
        value->setProperty("maximumMetadataDifference", result.maximumMetadataDifference);
        value->setProperty("maximumUnaffectedVoiceDifference", result.maximumUnaffectedVoiceDifference);
        value->setProperty("maximumRetiredProfileDifference", result.maximumRetiredProfileDifference);
        value->setProperty("maximumFuzzPairDifference", result.maximumFuzzPairDifference);
        add(checks, "nam_octaver_retirement_" + juce::String(static_cast<int>(rate)),
            result.passed ? "pass" : "fail",
            "Exact full/individual octave retirement and re-entry across all six resampler phases, seven off-dwell lengths, mono/stereo and Guitar/Bass; continuing voices and excitation metadata remain exact. Off-edited profiles match fresh state, and all three Fuzz voices preserve pair partition parity. Sound quality is not asserted.",
            juce::var(value));
    }

    struct Event
    {
        int sample = 0;
        NAMFuzz::Parameters parameters;
    };

    struct Field
    {
        const char* id;
        float minimum, maximum, initial, saved;
    };

    inline static constexpr std::array<Field, 6> fields {{
        { "fuzzEnabled", 0.0f, 1.0f, 0.0f, 1.0f },
        { "fuzzDrive", 0.0f, 1.0f, 0.5f, 0.73f },
        { "fuzzTone", 0.0f, 1.0f, 0.5f, 0.31f },
        { "fuzzLevelDb", -18.0f, 12.0f, 0.0f, -4.25f },
        { "fuzzVoice", 0.0f, 2.0f, 0.0f, 2.0f },
        { "fuzzCleanMix", 0.0f, 1.0f, 0.0f, 0.27f },
    }};

    static void add(juce::Array<juce::var>& checks, const juce::String& id,
                    const juce::String& status, const juce::String& detail,
                    const juce::var& value = {})
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("id", id);
        result->setProperty("status", status);
        result->setProperty("detail", detail);
        if (!value.isVoid()) result->setProperty("value", value);
        checks.add(juce::var(result));
    }

    static juce::AudioBuffer<float> fixture(double rate, int channels = 2, int count = 12019)
    {
        juce::AudioBuffer<float> buffer(channels, count);
        for (int channel = 0; channel < channels; ++channel)
            for (int sample = 0; sample < count; ++sample)
            {
                const double time = static_cast<double>(sample) / rate;
                const double frequency = channel == 0 ? 220.0 : 329.6275569;
                const float value = static_cast<float>(0.2 * std::sin(juce::MathConstants<double>::twoPi * frequency * time)
                    + 0.075 * std::sin(juce::MathConstants<double>::twoPi * frequency * 0.375 * time));
                buffer.setSample(channel, sample, value + (sample == 7 ? 0.1f : 0.0f));
            }
        return buffer;
    }

    static juce::AudioBuffer<float> render(NAMFuzz& fuzz, const juce::AudioBuffer<float>& input,
                                         NAMFuzz::Parameters parameters,
                                         const std::vector<int>& partitions,
                                         const std::vector<Event>& events = {})
    {
        juce::AudioBuffer<float> output;
        output.makeCopyOf(input);
        size_t eventIndex = 0, partitionIndex = 0;
        int position = 0;
        while (position < output.getNumSamples())
        {
            while (eventIndex < events.size() && events[eventIndex].sample == position)
                parameters = events[eventIndex++].parameters;
            fuzz.setParameters(parameters); // Production publishes targets every callback.
            int count = juce::jmin(partitions[partitionIndex++ % partitions.size()], output.getNumSamples() - position);
            if (eventIndex < events.size()) count = juce::jmin(count, events[eventIndex].sample - position);
            std::array<float*, 2> pointers {
                output.getWritePointer(0, position),
                output.getNumChannels() > 1 ? output.getWritePointer(1, position) : nullptr,
            };
            juce::AudioBuffer<float> block(pointers.data(), output.getNumChannels(), count);
            fuzz.processBlock(block);
            position += count;
        }
        return output;
    }

    static double difference(const juce::AudioBuffer<float>& left, const juce::AudioBuffer<float>& right)
    {
        double maximum = 0.0;
        if (left.getNumChannels() != right.getNumChannels() || left.getNumSamples() != right.getNumSamples())
            return std::numeric_limits<double>::infinity();
        for (int channel = 0; channel < left.getNumChannels(); ++channel)
            for (int sample = 0; sample < left.getNumSamples(); ++sample)
            {
                const double delta = std::abs(static_cast<double>(left.getSample(channel, sample)) - right.getSample(channel, sample));
                if (!std::isfinite(delta)) return std::numeric_limits<double>::infinity();
                maximum = juce::jmax(maximum, delta);
            }
        return maximum;
    }

    static double energy(const juce::AudioBuffer<float>& buffer, int start = 0)
    {
        double sum = 0.0;
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
            for (int sample = start; sample < buffer.getNumSamples(); ++sample)
            {
                const double value = buffer.getSample(channel, sample);
                if (!std::isfinite(value)) return std::numeric_limits<double>::infinity();
                sum += value * value;
            }
        return sum / static_cast<double>(juce::jmax(1, buffer.getNumChannels() * (buffer.getNumSamples() - start)));
    }

    static bool finite(const juce::AudioBuffer<float>& buffer)
    {
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
            for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
                if (!std::isfinite(buffer.getSample(channel, sample))) return false;
        return true;
    }

    static void runCore(juce::Array<juce::var>& checks, double rate)
    {
        const auto source = fixture(rate);
        const std::vector<int> regular { 512 }, irregular { 1, 7, 31, 64, 193, 1024, 3, 257 };
        auto* result = new juce::DynamicObject();
        result->setProperty("sampleRate", rate);
        bool bypassPassed = true, silencePassed = true, stereoPassed = true, resetPassed = true;
        bool partitionPassed = true, finiteRecoveryPassed = true, cleanBlendPassed = true, cleanLinearBlendPassed = true;
        bool malformedControlParityPassed = true, monoAndEmptyPassed = true;
        double maximumPartitionDifference = 0.0;
        juce::Array<juce::var> voiceDiagnostics;
        std::array<juce::AudioBuffer<float>, 3> voiceOutputs;

        NAMFuzz::Parameters off;
        NAMFuzz bypass;
        bypass.prepare(rate, off);
        bypassPassed = difference(render(bypass, source, off, irregular), source) == 0.0;

        for (int voice = 0; voice < 3; ++voice)
        {
            NAMFuzz::Parameters parameters;
            parameters.enabled = true;
            parameters.drive = 0.72f;
            parameters.voice = voice;
            for (const bool bass : { false, true })
            {
                parameters.bass = bass;
                NAMFuzz regularFuzz, irregularFuzz;
                regularFuzz.prepare(rate, parameters);
                irregularFuzz.prepare(rate, parameters);
                const auto regularOutput = render(regularFuzz, source, parameters, regular);
                const auto irregularOutput = render(irregularFuzz, source, parameters, irregular);
                const double delta = difference(regularOutput, irregularOutput);
                maximumPartitionDifference = juce::jmax(maximumPartitionDifference, delta);
                partitionPassed = partitionPassed && delta == 0.0;
                if (!bass) voiceOutputs[static_cast<size_t>(voice)].makeCopyOf(regularOutput);

                regularFuzz.reset();
                resetPassed = resetPassed && difference(render(regularFuzz, source, parameters, irregular), regularOutput) == 0.0;

                juce::AudioBuffer<float> silence(2, 8192);
                silence.clear();
                regularFuzz.prepare(rate, parameters);
                const auto silenceOutput = render(regularFuzz, silence, parameters, irregular);
                silencePassed = silencePassed && finite(silenceOutput) && energy(silenceOutput) == 0.0;

                juce::AudioBuffer<float> leftOnly;
                leftOnly.makeCopyOf(source);
                leftOnly.clear(1, 0, leftOnly.getNumSamples());
                regularFuzz.prepare(rate, parameters);
                const auto isolated = render(regularFuzz, leftOnly, parameters, irregular);
                for (int sample = 0; sample < source.getNumSamples(); ++sample)
                    stereoPassed = stereoPassed && isolated.getSample(0, sample) == regularOutput.getSample(0, sample)
                        && isolated.getSample(1, sample) == 0.0f;

                juce::AudioBuffer<float> equalStereo;
                equalStereo.makeCopyOf(source);
                equalStereo.copyFrom(1, 0, source, 0, 0, source.getNumSamples());
                regularFuzz.prepare(rate, parameters);
                const auto equalOutput = render(regularFuzz, equalStereo, parameters, regular);
                for (int sample = 0; sample < source.getNumSamples(); ++sample)
                    stereoPassed = stereoPassed && equalOutput.getSample(0, sample) == equalOutput.getSample(1, sample);

                juce::AudioBuffer<float> mono(1, source.getNumSamples());
                mono.copyFrom(0, 0, source, 0, 0, source.getNumSamples());
                regularFuzz.prepare(rate, parameters);
                juce::AudioBuffer<float> noChannels(0, 128), noSamples(2, 0);
                regularFuzz.processBlock(noChannels);
                regularFuzz.processBlock(noSamples);
                const auto monoOutput = render(regularFuzz, mono, parameters, irregular);
                for (int sample = 0; sample < source.getNumSamples(); ++sample)
                    monoAndEmptyPassed = monoAndEmptyPassed && monoOutput.getSample(0, sample) == regularOutput.getSample(0, sample);

                parameters.cleanMix = 1.0f;
                regularFuzz.prepare(rate, parameters);
                cleanBlendPassed = cleanBlendPassed && difference(render(regularFuzz, source, parameters, irregular), source) <= 3.0e-8;
                parameters.cleanMix = 0.5f;
                regularFuzz.prepare(rate, parameters);
                const auto halfBlend = render(regularFuzz, source, parameters, irregular);
                juce::AudioBuffer<float> expectedHalf(2, source.getNumSamples());
                for (int channel = 0; channel < 2; ++channel)
                    for (int sample = 0; sample < source.getNumSamples(); ++sample)
                        expectedHalf.setSample(channel, sample, 0.5f * regularOutput.getSample(channel, sample) + 0.5f * source.getSample(channel, sample));
                cleanLinearBlendPassed = cleanLinearBlendPassed && difference(halfBlend, expectedHalf) <= 1.0e-6;
                parameters.cleanMix = 0.0f;

                auto malformed = parameters;
                malformed.drive = std::numeric_limits<float>::quiet_NaN();
                malformed.tone = std::numeric_limits<float>::infinity();
                malformed.levelDb = -std::numeric_limits<float>::infinity();
                malformed.cleanMix = std::numeric_limits<float>::quiet_NaN();
                malformed.voice = std::numeric_limits<int>::max();
                auto sanitized = parameters;
                sanitized.drive = 0.5f;
                sanitized.tone = 0.5f;
                sanitized.levelDb = 0.0f;
                sanitized.cleanMix = 0.0f;
                sanitized.voice = 2;
                regularFuzz.prepare(rate, malformed);
                irregularFuzz.prepare(rate, sanitized);
                malformedControlParityPassed = malformedControlParityPassed
                    && difference(render(regularFuzz, source, malformed, regular), render(irregularFuzz, source, sanitized, irregular)) == 0.0;

                auto extremeControls = parameters;
                extremeControls.drive = std::numeric_limits<float>::max();
                extremeControls.tone = -std::numeric_limits<float>::max();
                extremeControls.levelDb = std::numeric_limits<float>::max();
                extremeControls.cleanMix = -std::numeric_limits<float>::max();
                extremeControls.voice = std::numeric_limits<int>::min();
                sanitized.drive = 1.0f;
                sanitized.tone = 0.0f;
                sanitized.levelDb = 12.0f;
                sanitized.voice = 0;
                regularFuzz.prepare(rate, extremeControls);
                irregularFuzz.prepare(rate, sanitized);
                malformedControlParityPassed = malformedControlParityPassed
                    && difference(render(regularFuzz, source, extremeControls, regular), render(irregularFuzz, source, sanitized, irregular)) == 0.0;

                juce::AudioBuffer<float> poisoned(2, 1024);
                for (int sample = 0; sample < poisoned.getNumSamples(); ++sample)
                {
                    const float value = sample % 4 == 0 ? std::numeric_limits<float>::quiet_NaN()
                        : sample % 4 == 1 ? std::numeric_limits<float>::infinity()
                        : sample % 4 == 2 ? std::numeric_limits<float>::max() : -std::numeric_limits<float>::max();
                    poisoned.setSample(0, sample, value);
                    poisoned.setSample(1, sample, -value);
                }
                regularFuzz.prepare(rate, malformed);
                const auto poisonOutput = render(regularFuzz, poisoned, malformed, irregular);
                const auto recoveryInput = fixture(rate, 2, static_cast<int>(rate * 0.3));
                const auto recoveryOutput = render(regularFuzz, recoveryInput, parameters, irregular);
                finiteRecoveryPassed = finiteRecoveryPassed && finite(poisonOutput) && finite(recoveryOutput)
                    && energy(recoveryOutput, recoveryOutput.getNumSamples() / 2) > 1.0e-8;
            }
            auto* diagnostic = new juce::DynamicObject();
            diagnostic->setProperty("voice", voice);
            diagnostic->setProperty("rms", std::sqrt(energy(voiceOutputs[static_cast<size_t>(voice)])));
            diagnostic->setProperty("maximumDifferenceFromInput", difference(voiceOutputs[static_cast<size_t>(voice)], source));
            voiceDiagnostics.add(juce::var(diagnostic));
        }

        // Control changes have exact sample positions independent of callback
        // sizes, including a bypass interval followed by reactivation.
        NAMFuzz::Parameters initial;
        initial.enabled = true;
        auto changed = initial;
        changed.drive = 0.91f;
        changed.tone = 0.22f;
        changed.levelDb = -7.0f;
        changed.cleanMix = 0.2f;
        changed.voice = 2;
        changed.bass = true;
        auto disabled = changed;
        disabled.enabled = false;
        auto resumed = changed;
        resumed.voice = 1;
        const std::vector<Event> events { { 1037, changed }, { 3061, disabled }, { 7103, resumed } };
        NAMFuzz regularControls, irregularControls;
        regularControls.prepare(rate, initial);
        irregularControls.prepare(rate, initial);
        const auto regularChanged = render(regularControls, source, initial, regular, events);
        const auto irregularChanged = render(irregularControls, source, initial, irregular, events);
        const double controlDifference = difference(regularChanged, irregularChanged);
        const int bypassResumeSample = 1207 + static_cast<int>(rate * 0.025) + 19;
        auto brieflyDisabled = initial;
        brieflyDisabled.enabled = false;
        const std::vector<Event> bypassResumeEvents { { 1207, brieflyDisabled }, { bypassResumeSample, initial } };
        regularControls.prepare(rate, initial);
        irregularControls.prepare(rate, initial);
        const auto largeBlockResume = render(regularControls, source, initial, { 2048 }, bypassResumeEvents);
        const auto oneSampleResume = render(irregularControls, source, initial, { 1 }, bypassResumeEvents);
        const double bypassResumeDifference = difference(largeBlockResume, oneSampleResume);
        const bool controlPartitionPassed = controlDifference == 0.0 && bypassResumeDifference == 0.0;

        // Disabled controls must have settled to exact bypass before this tail.
        NAMFuzz disabledFuzz;
        disabledFuzz.prepare(rate, initial);
        (void) render(disabledFuzz, source, disabled, irregular);
        bypassPassed = bypassPassed && difference(render(disabledFuzz, source, disabled, regular), source) == 0.0;

        bool malformedRatePassed = true;
        for (const double malformedRate : { 0.0, -1.0, std::numeric_limits<double>::quiet_NaN(),
                                           std::numeric_limits<double>::infinity(), std::numeric_limits<double>::max() })
        {
            NAMFuzz fuzz;
            fuzz.prepare(malformedRate, initial);
            const auto output = render(fuzz, source, initial, irregular);
            malformedRatePassed = malformedRatePassed && finite(output) && energy(output) > 1.0e-8;
        }

        result->setProperty("exactBypassPassed", bypassPassed);
        result->setProperty("exactSilencePassed", silencePassed);
        result->setProperty("stereoIsolationAndParityPassed", stereoPassed);
        result->setProperty("resetDeterminismPassed", resetPassed);
        result->setProperty("partitionInvariantPassed", partitionPassed);
        result->setProperty("maximumPartitionDifference", maximumPartitionDifference);
        result->setProperty("liveControlsPartitionPassed", controlPartitionPassed);
        result->setProperty("maximumControlPartitionDifference", controlDifference);
        result->setProperty("maximumBypassReactivationPartitionDifference", bypassResumeDifference);
        result->setProperty("finiteInputAndControlRecoveryPassed", finiteRecoveryPassed);
        result->setProperty("malformedSampleRatePassed", malformedRatePassed);
        result->setProperty("fullCleanBlendParityPassed", cleanBlendPassed);
        result->setProperty("linearParallelCleanBlendPassed", cleanLinearBlendPassed);
        result->setProperty("sanitizedMalformedAndExtremeControlParityPassed", malformedControlParityPassed);
        result->setProperty("monoAndEmptyBufferPassed", monoAndEmptyPassed);
        const bool passed = bypassPassed && silencePassed && stereoPassed && resetPassed && partitionPassed
            && controlPartitionPassed && finiteRecoveryPassed && malformedRatePassed && cleanBlendPassed && cleanLinearBlendPassed
            && malformedControlParityPassed && monoAndEmptyPassed;
        add(checks, "nam_fuzz_multirate_contract_" + juce::String(static_cast<int>(rate)), passed ? "pass" : "fail",
            "Exact fresh/settled bypass and silence; independent stereo; deterministic reset; arbitrary callback partitions including live control/voice/profile/bypass changes; finite malformed/extreme input recovery and full-clean parity. No subjective tone claim.", juce::var(result));
        auto* diagnostic = new juce::DynamicObject();
        diagnostic->setProperty("sampleRate", rate);
        diagnostic->setProperty("voices", juce::var(voiceDiagnostics));
        diagnostic->setProperty("vintageSustainDifference", difference(voiceOutputs[0], voiceOutputs[1]));
        diagnostic->setProperty("vintageGatedDifference", difference(voiceOutputs[0], voiceOutputs[2]));
        diagnostic->setProperty("sustainGatedDifference", difference(voiceOutputs[1], voiceOutputs[2]));
        add(checks, "nam_fuzz_voice_measurements_" + juce::String(static_cast<int>(rate)), "diagnostic_only",
            "Synthetic-fixture RMS and voice differences describe distinct mathematical outputs; they do not establish a preferred fuzz tone, pedal match, alias audibility, or octave sound quality.", juce::var(diagnostic));
    }

    static void runBassGateContract(juce::Array<juce::var>& checks)
    {
        constexpr double sampleRate=48000.0;
        constexpr float threshold=0.003f; // Drive0.5:0.0015+0.003*(1-Drive).
        constexpr std::array<int,5> lengths{12000,24000,28800,19200,12000};
        constexpr std::array<float,5> peaks{2.0f*threshold,0.8f*threshold,0.0f,0.8f*threshold,2.0f*threshold};
        constexpr std::array<const char*,5> labels{"loud-open","between-threshold-retention","silence-close","quiet-stays-closed","loud-reopen"};
        const int count=std::accumulate(lengths.begin(),lengths.end(),0);
        juce::AudioBuffer<float> input(2,count);int position=0;
        for(size_t segment=0;segment<lengths.size();++segment)
            for(int index=0;index<lengths[segment];++index,++position)
            {
                const float value=peaks[segment]*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*30.8677063*position/sampleRate));
                input.setSample(0,position,value);input.setSample(1,position,value);
            }
        struct GateRun {juce::AudioBuffer<float> audio;std::array<NAMFuzz::GateDiagnostics,5> snapshots;};
        const auto process=[&input,&lengths,sampleRate] (int blockSize,float excitationGain)
        {
            GateRun run;run.audio.makeCopyOf(input);NAMFuzz processor;NAMFuzz::Parameters controls;
            controls.enabled=true;controls.bass=true;controls.voice=2;controls.drive=0.5f;processor.prepare(sampleRate,controls);
            std::array<float,512> excitation{};excitation.fill(excitationGain);int start=0;
            for(size_t segment=0;segment<lengths.size();++segment)
            {
                const int end=start+lengths[segment];
                while(start<end)
                {
                    const int blockCount=juce::jmin(blockSize,end-start);
                    std::array<float*,2> pointers{run.audio.getWritePointer(0,start),run.audio.getWritePointer(1,start)};
                    juce::AudioBuffer<float> block(pointers.data(),2,blockCount);processor.processBlock(block,excitation.data());start+=blockCount;
                }
                run.snapshots[segment]=processor.getGateDiagnostics();
            }
            return run;
        };
        const auto regular=process(512,1.0f),irregular=process(7,1.0f),padded=process(31,0.25f);
        bool passed=finite(regular.audio)&&finite(irregular.audio)&&finite(padded.audio)&&difference(regular.audio,irregular.audio)==0.0;
        juce::Array<juce::var> segments;
        for(size_t segment=0;segment<lengths.size();++segment)
        {
            const bool expectedOpen=segment==0||segment==1||segment==4;
            const std::uint64_t expectedOpens=segment==4?2:1,expectedCloses=segment>=2?1:0;
            const auto& state=regular.snapshots[segment];auto* row=new juce::DynamicObject();
            row->setProperty("segment",labels[segment]);row->setProperty("inputPeak",peaks[segment]);row->setProperty("open",state.open[0]);
            row->setProperty("opens",static_cast<juce::int64>(state.opens[0]));row->setProperty("closes",static_cast<juce::int64>(state.closes[0]));
            row->setProperty("detectorEnvelope",state.envelope[0]);row->setProperty("gateGain",state.gain[0]);
            for(size_t channel=0;channel<2;++channel)
            {
                const auto& other=irregular.snapshots[segment];const auto& compensated=padded.snapshots[segment];
                passed=passed&&state.open[channel]==expectedOpen&&state.opens[channel]==expectedOpens&&state.closes[channel]==expectedCloses
                    &&state.open[channel]==state.open[0]&&state.opens[channel]==state.opens[0]&&state.closes[channel]==state.closes[0]
                    &&state.envelope[channel]==state.envelope[0]&&state.gain[channel]==state.gain[0]
                    &&state.open[channel]==other.open[channel]&&state.opens[channel]==other.opens[channel]&&state.closes[channel]==other.closes[channel]
                    &&state.envelope[channel]==other.envelope[channel]&&state.gain[channel]==other.gain[channel]
                    &&state.open[channel]==compensated.open[channel]&&state.opens[channel]==compensated.opens[channel]&&state.closes[channel]==compensated.closes[channel]
                    &&state.envelope[channel]==compensated.envelope[channel]&&state.gain[channel]==compensated.gain[channel];
            }
            segments.add(juce::var(row));
        }
        add(checks,"nam_fuzz_bass_gate_hysteresis_contract",passed?"pass":"fail",
            "At Drive0.5 Bass B0 opens above T, retains between T/2 and T, closes during600ms silence, remains closed for sub-T reentry and reopens above T. Gate transition/envelope/gain state is partition invariant, stereo equal and independent of nonlinear excitation padding. This is a deterministic state contract, not a tone-quality approval.",juce::var(segments));
    }

    static void runReprepare(juce::Array<juce::var>& checks)
    {
        bool passed = true;
        double maximumDifference = 0.0;
        juce::Array<juce::var> cases;
        for (const bool bass : { false, true }) for (int voice = 0; voice < 3; ++voice)
        {
            NAMFuzz::Parameters parameters;
            parameters.enabled = true; parameters.bass = bass; parameters.voice = voice;
            parameters.drive = 0.72f; parameters.tone = 0.31f; parameters.cleanMix = 0.27f;
            parameters.calibrationReferenceDbu = 18.0f;
            NAMFuzz reused;
            reused.prepare(44100.0, parameters);
            (void) render(reused, fixture(44100.0), parameters, { 512 });
            for (const double targetRate : { 44100.0, 48000.0, 96000.0, 44100.0 })
            {
                // Deliberately unchanged parameters must not bypass coefficient
                // construction after prepare changes the sample rate or resets
                // ramps. The second 44.1 kHz visit also checks returning from96k.
                const auto source = fixture(targetRate);
                reused.prepare(targetRate, parameters);
                NAMFuzz fresh; fresh.prepare(targetRate, parameters);
                const auto reusedOutput = render(reused, source, parameters, { 512 });
                const auto freshOutput = render(fresh, source, parameters, { 7, 31, 1 });
                const double delta = difference(reusedOutput, freshOutput);
                maximumDifference = juce::jmax(maximumDifference, delta);
                passed = passed && finite(reusedOutput) && finite(freshOutput) && delta == 0.0;
                auto* row = new juce::DynamicObject();
                row->setProperty("bass", bass); row->setProperty("voice", voice);
                row->setProperty("targetSampleRate", targetRate); row->setProperty("maximumDifference", delta);
                cases.add(juce::var(row));
            }
        }
        auto* value = new juce::DynamicObject();
        value->setProperty("maximumDifference", maximumDifference);
        value->setProperty("calibrationReferenceDbu", 18.0f);
        value->setProperty("cases", juce::var(cases));
        add(checks, "nam_fuzz_same_controls_reprepare", passed ? "pass" : "fail",
            "A warmed44.1k processor re-prepared at44.1/48/96/44.1k with unchanged controls must exactly match a fresh processor at each target rate, across Guitar/Bass and all three voices. This verifies coefficient-cache invalidation, filter/reset state and callback partition semantics, not sound quality.", juce::var(value));
    }

    static void runCalibration(juce::Array<juce::var>& checks, double rate)
    {
        const auto physicalSource = fixture(rate);
        double maximumPhysicalDifference = 0.0, maximumPartitionDifference = 0.0;
        bool passed = true;
        for (const bool bass : { false, true }) for (int voice = 0; voice < 3; ++voice)
        {
            for (const float cleanMix : { 0.0f, 0.5f, 1.0f })
            {
                NAMFuzz::Parameters parameters;
                parameters.enabled = true; parameters.voice = voice;
                parameters.bass = bass; parameters.cleanMix = cleanMix;
                NAMFuzz referenceProcessor;
                referenceProcessor.prepare(rate, parameters);
                const auto reference = render(referenceProcessor, physicalSource, parameters, { 512 });
                for (const float referenceDbu : { 6.0f, 12.0f, 18.0f, 24.0f })
                {
                    const float operatingGain = juce::Decibels::decibelsToGain(referenceDbu - 12.0f);
                    juce::AudioBuffer<float> digitalSource; digitalSource.makeCopyOf(physicalSource);
                    digitalSource.applyGain(1.0f / operatingGain);
                    parameters.calibrationReferenceDbu = referenceDbu;
                    NAMFuzz regularProcessor, irregularProcessor;
                    regularProcessor.prepare(rate, parameters); irregularProcessor.prepare(rate, parameters);
                    auto regular = render(regularProcessor, digitalSource, parameters, { 512 });
                    const auto irregular = render(irregularProcessor, digitalSource, parameters, { 7, 31, 1 });
                    maximumPartitionDifference = juce::jmax(maximumPartitionDifference, difference(regular, irregular));
                    passed = passed && finite(regular) && finite(irregular);
                    if (cleanMix == 1.0f) passed = passed && difference(regular, digitalSource) == 0.0;
                    regular.applyGain(operatingGain);
                    maximumPhysicalDifference = juce::jmax(maximumPhysicalDifference, difference(reference, regular));
                }
            }
        }
        // A live reference change must keep exactly the same sample-time ramp
        // across host callback boundaries, including a malformed value fallback.
        NAMFuzz::Parameters initial; initial.enabled = true;
        auto changed = initial; changed.calibrationReferenceDbu = 24.0f;
        auto malformed = initial; malformed.calibrationReferenceDbu = std::numeric_limits<float>::quiet_NaN();
        const std::vector<Event> events {{ 79, changed }, { 6031, malformed }};
        NAMFuzz regularProcessor, irregularProcessor;
        regularProcessor.prepare(rate, initial); irregularProcessor.prepare(rate, initial);
        const auto regular = render(regularProcessor, physicalSource, initial, { 512 }, events);
        const auto irregular = render(irregularProcessor, physicalSource, initial, { 7, 31, 1 }, events);
        maximumPartitionDifference = juce::jmax(maximumPartitionDifference, difference(regular, irregular));
        passed = passed && finite(regular) && finite(irregular)
            && maximumPhysicalDifference <= 1.0e-5 && maximumPartitionDifference == 0.0;
        auto* value = new juce::DynamicObject();
        value->setProperty("sampleRate", rate);
        value->setProperty("maximumPhysicalOutputDifference", maximumPhysicalDifference);
        value->setProperty("physicalOutputTolerance", 1.0e-5);
        value->setProperty("maximumPartitionDifference", maximumPartitionDifference);
        value->setProperty("referencesDbu", "6,12,18,24");
        value->setProperty("coverage", "Guitar/Bass x three voices x Clean0/0.5/1; source scaled inversely with interface reference, output converted back to a common physical domain. Live reference changes and NaN fallback are finite and partition invariant; full-clean remains exact incoming digital audio.");
        add(checks, "nam_fuzz_calibration_" + juce::String(static_cast<int>(rate)), passed ? "pass" : "fail",
            "Equivalent physical input must retain equivalent physical fuzz output across interface references without modifying raw clean audio. This asserts calibration and ramp semantics, not audible preference.", juce::var(value));
    }

    static juce::MemoryBlock memory(const juce::ValueTree& tree)
    {
        juce::MemoryBlock block;
        juce::MemoryOutputStream stream(block, false);
        tree.writeToStream(stream);
        return block;
    }

    static juce::AudioBuffer<float> renderRackFixture(const juce::AudioBuffer<float>& source,
                                                    bool octaveEnabled, bool fuzzEnabled)
    {
        // Test setup allocations stay off the audio callback. No NAM capture,
        // cabinet IR, or external fixture is needed to exercise the live rack.
        const auto rack = std::make_unique<OpenStudioNAMRack>();
        rack->setRoutedInputChannelCount(2);
        rack->inputTrimDb.store(0.0f);
        rack->outputTrimDb.store(0.0f);
        rack->gateThresholdDb.store(-100.0f);
        rack->compressorEnabled.store(0.0f);
        rack->octaverEnabled.store(octaveEnabled ? 1.0f : 0.0f);
        rack->octaverDownMix.store(0.32f);
        rack->octaverUpMix.store(0.18f);
        rack->octaverDirectMix.store(1.0f);
        rack->fuzzEnabled.store(fuzzEnabled ? 1.0f : 0.0f);
        rack->fuzzDrive.store(0.73f);
        rack->fuzzTone.store(0.31f);
        rack->fuzzLevelDb.store(-4.25f);
        rack->fuzzVoice.store(0.0f);
        rack->fuzzCleanMix.store(0.27f);
        rack->precisionDriveEnabled.store(0.0f);
        rack->chaosEnabled.store(0.0f);
        rack->pedalMix.store(0.0f);
        rack->ampEnabled.store(0.0f);
        rack->ampMix.store(0.0f);
        rack->setCabRequestedEnabled(false);
        rack->preEqEnabled.store(0.0f);
        rack->eqEnabled.store(0.0f);
        rack->chorusMix.store(0.0f);
        rack->modulatorEnabled.store(0.0f);
        rack->delayEnabled.store(0.0f);
        rack->reverbEnabled.store(0.0f);
        rack->auditionSource.store(0.0f);
        rack->prepareToPlay(48000.0, 512);
        juce::AudioBuffer<float> output;
        output.makeCopyOf(source);
        juce::MidiBuffer midi;
        for (int position = 0; position < output.getNumSamples(); position += 512)
        {
            const int count = juce::jmin(512, output.getNumSamples() - position);
            std::array<float*, 2> pointers { output.getWritePointer(0, position), output.getWritePointer(1, position) };
            juce::AudioBuffer<float> block(pointers.data(), 2, count);
            rack->processBlock(block, midi);
        }
        rack->releaseResources();
        return output;
    }

    static void runRackRouting(juce::Array<juce::var>& checks)
    {
        const auto source = fixture(48000.0, 2, 16384);
        const auto bypass = renderRackFixture(source, false, false);
        const auto fuzzOnly = renderRackFixture(source, false, true);
        const auto octaveOnly = renderRackFixture(source, true, false);
        const auto combined = renderRackFixture(source, true, true);
        const auto repeatedCombined = renderRackFixture(source, true, true);
        const double fuzzOnlyDifference = difference(fuzzOnly, bypass);
        const double combinedDifference = difference(combined, octaveOnly);
        const double repeatedDifference = difference(combined, repeatedCombined);
        const bool passed = finite(bypass) && finite(fuzzOnly) && finite(octaveOnly) && finite(combined)
            && energy(fuzzOnly) > 1.0e-8 && energy(combined) > 1.0e-8
            && fuzzOnlyDifference > 1.0e-4 && combinedDifference > 1.0e-4 && repeatedDifference == 0.0;
        auto* result = new juce::DynamicObject();
        result->setProperty("sampleRate", 48000.0);
        result->setProperty("noExternalModelOrCabIR", true);
        result->setProperty("fuzzWorksWithOctaveDisabled", fuzzOnlyDifference > 1.0e-4);
        result->setProperty("fuzzWorksWithOctaveEnabled", combinedDifference > 1.0e-4);
        result->setProperty("fuzzOnlyDifferenceFromBypass", fuzzOnlyDifference);
        result->setProperty("combinedDifferenceFromOctaveOnly", combinedDifference);
        result->setProperty("repeatedCombinedMaximumDifference", repeatedDifference);
        add(checks, "nam_fuzz_integrated_rack_routes", passed ? "pass" : "fail",
            "The live stereo Rack must produce finite, deterministic Fuzz-only output with Octave off and Octave+Fuzz output with Octave on, with NAM/Amp/Cab and other effects bypassed. Output differences prove route execution, not tone quality.", juce::var(result));
    }

    static juce::ValueTree tree(const juce::MemoryBlock& block)
    {
        return juce::ValueTree::readFromData(block.getData(), block.getSize());
    }

    static juce::var values(bool saved)
    {
        auto* object = new juce::DynamicObject();
        for (const auto& field : fields) object->setProperty(field.id, static_cast<double>(saved ? field.saved : field.initial));
        return juce::var(object);
    }

    static bool matchValues(const juce::var& actual, bool saved)
    {
        auto* object = actual.getDynamicObject();
        if (object == nullptr) return false;
        for (const auto& field : fields)
            if (!object->hasProperty(field.id) || std::abs(static_cast<double>(object->getProperty(field.id)) - (saved ? field.saved : field.initial)) > 1.0e-6)
                return false;
        return true;
    }

    static bool matchTree(const juce::ValueTree& actual, bool saved)
    {
        for (const auto& field : fields)
            if (!actual.hasProperty(field.id) || std::abs(static_cast<double>(actual.getProperty(field.id)) - (saved ? field.saved : field.initial)) > 1.0e-6)
                return false;
        return actual.isValid();
    }

    static void runState(juce::Array<juce::var>& checks)
    {
        const auto source = std::make_unique<OpenStudioNAMRack>();
        juce::MemoryBlock original;
        source->getStateInformation(original);
        auto currentTree = tree(original);
        bool defaultsPassed = matchTree(currentTree, false);
        for (const auto& field : fields) currentTree.setProperty(field.id, static_cast<double>(field.saved), nullptr);
        const auto configured = memory(currentTree);
        const bool nativeAccepted = source->restoreProjectStateInformation(configured.getData(), static_cast<int>(configured.getSize()));
        juce::MemoryBlock roundtrip;
        source->getStateInformation(roundtrip);
        bool roundtripPassed = nativeAccepted && matchTree(tree(roundtrip), true);

        juce::MemoryBlock portable;
        source->getTonePresetStateInformation(portable);
        const auto restored = std::make_unique<OpenStudioNAMRack>();
        const bool portableAccepted = restored->restoreTonePresetStateInformation(portable.getData(), static_cast<int>(portable.getSize()));
        juce::MemoryBlock portableRoundtrip;
        restored->getStateInformation(portableRoundtrip);
        const bool portablePassed = portableAccepted && matchTree(tree(portable), true) && matchTree(tree(portableRoundtrip), true);

        // Restore an old project into an already-enabled instance: absent fuzz
        // must reset to safe defaults rather than inherit the previous tone.
        auto legacy = currentTree.createCopy();
        for (const auto& field : fields) legacy.removeProperty(field.id, nullptr);
        const auto legacyMemory = memory(legacy);
        const bool legacyAccepted = source->restoreProjectStateInformation(legacyMemory.getData(), static_cast<int>(legacyMemory.getSize()));
        source->getStateInformation(roundtrip);
        const bool legacyPassed = legacyAccepted && matchTree(tree(roundtrip), false);

        auto uiState = juce::JSON::parse(R"json({"namPresetBaseline":{"values":{}},"namRackCompare":{"snapshots":{"A":{"values":{}},"B":{"values":{}}}}})json");
        auto* uiObject = uiState.getDynamicObject();
        auto baseline = uiObject->getProperty("namPresetBaseline");
        baseline.getDynamicObject()->setProperty("values", values(true));
        const auto compare = uiObject->getProperty("namRackCompare");
        const auto snapshots = compare.getProperty("snapshots", {});
        const auto snapshotA = snapshots.getProperty("A", {});
        snapshotA.getDynamicObject()->setProperty("values", values(true));
        (void) OpenStudioNAMRack::migrateUiStateToCurrent(uiState, 20);
        const auto migratedSnapshots = uiState.getProperty("namRackCompare", {}).getProperty("snapshots", {});
        const bool comparePassed = matchValues(uiState.getProperty("namPresetBaseline", {}).getProperty("values", {}), true)
            && matchValues(migratedSnapshots.getProperty("A", {}).getProperty("values", {}), true)
            && matchValues(migratedSnapshots.getProperty("B", {}).getProperty("values", {}), false);
        source->setUiStateJSON(juce::JSON::toString(uiState, false));
        source->getTonePresetStateInformation(portable);
        const bool uiPortableAccepted = restored->restoreTonePresetStateInformation(portable.getData(), static_cast<int>(portable.getSize()));
        const auto restoredUI = juce::JSON::parse(restored->getUiStateJSON());
        const auto restoredSnapshots = restoredUI.getProperty("namRackCompare", {}).getProperty("snapshots", {});
        const bool compareRoundtripPassed = uiPortableAccepted
            && matchValues(restoredUI.getProperty("namPresetBaseline", {}).getProperty("values", {}), true)
            && matchValues(restoredSnapshots.getProperty("A", {}).getProperty("values", {}), true)
            && matchValues(restoredSnapshots.getProperty("B", {}).getProperty("values", {}), false);
        const bool versionsPassed = OpenStudioNAMRack::currentNAMEffectsDspVersion == 20
            && OpenStudioNAMRack::currentReverbEngineVersion == 5
            && static_cast<int>(tree(roundtrip).getProperty("namEffectsDspVersion")) == 20
            && static_cast<int>(tree(portable).getProperty("tonePresetStateVersion")) == 1;
        auto* result = new juce::DynamicObject();
        result->setProperty("defaultFuzzOffPassed", defaultsPassed);
        result->setProperty("nativeRoundtripPassed", roundtripPassed);
        result->setProperty("portablePresetRoundtripPassed", portablePassed);
        result->setProperty("legacyMissingFuzzResetsPassed", legacyPassed);
        result->setProperty("compareMigrationPassed", comparePassed);
        result->setProperty("comparePortableRoundtripPassed", compareRoundtripPassed);
        result->setProperty("existingVersionMarkersUnchanged", versionsPassed);
        const bool passed = defaultsPassed && roundtripPassed && portablePassed && legacyPassed && comparePassed && compareRoundtripPassed && versionsPassed;
        add(checks, "nam_fuzz_native_legacy_preset_compare_state", passed ? "pass" : "fail",
            "All six fuzz controls persist through native projects, portable tone presets, preset baselines and Compare A/B; legacy state resets fuzz off with factory defaults. Existing schema/DSP markers stay unchanged.", juce::var(result));
    }

    static double bridgeValue(const juce::var& schema, const char* id)
    {
        const auto parameters = schema.getProperty("values", {});
        if (const auto* object = parameters.getDynamicObject())
            if (object->hasProperty(id)) return static_cast<double>(object->getProperty(id));
        return std::numeric_limits<double>::quiet_NaN();
    }

    static bool valueMatches(double value, double expected)
    {
        return std::isfinite(value) && std::abs(value - expected) <= 1.0e-6;
    }

    static void runBridge(juce::Array<juce::var>& checks, AudioEngine& engine)
    {
        const juce::String trackId = "nam-fuzz-regression-" + juce::Uuid().toString();
        const bool trackAdded = engine.addTrack(trackId, "audio").isNotEmpty();
        const bool rackAdded = trackAdded && engine.addTrackBuiltInFX(trackId, "OpenStudio NAM Rack", false);
        bool defaultPassed = rackAdded, clampsPassed = rackAdded, roundtripPassed = rackAdded;
        if (rackAdded)
        {
            auto schema = engine.getBuiltInPluginState(trackId, "track", 0);
            defaultPassed = static_cast<int>(schema.getProperty("schemaVersion", 0)) == 1;
            for (const auto& field : fields)
            {
                defaultPassed = defaultPassed && valueMatches(bridgeValue(schema, field.id), field.initial);
                const bool lowAccepted = engine.setBuiltInPluginParam(trackId, "track", 0, field.id, field.minimum - 100.0f);
                const bool lowMatched = valueMatches(bridgeValue(engine.getBuiltInPluginState(trackId, "track", 0), field.id), field.minimum);
                const bool highAccepted = engine.setBuiltInPluginParam(trackId, "track", 0, field.id, field.maximum + 100.0f);
                const bool highMatched = valueMatches(bridgeValue(engine.getBuiltInPluginState(trackId, "track", 0), field.id), field.maximum);
                clampsPassed = clampsPassed && lowAccepted && highAccepted && lowMatched && highMatched;
                roundtripPassed = engine.setBuiltInPluginParam(trackId, "track", 0, field.id, field.saved) && roundtripPassed;
            }
            schema = engine.getBuiltInPluginState(trackId, "track", 0);
            auto* state = new juce::DynamicObject();
            state->setProperty("schemaVersion", 1);
            state->setProperty("values", values(true));
            roundtripPassed = engine.setBuiltInPluginState(trackId, "track", 0, juce::JSON::toString(juce::var(state), false)) && roundtripPassed;
            const auto restoredSchema = engine.getBuiltInPluginState(trackId, "track", 0);
            for (const auto& field : fields)
                roundtripPassed = roundtripPassed && valueMatches(bridgeValue(schema, field.id), field.saved) && valueMatches(bridgeValue(restoredSchema, field.id), field.saved);
            const bool fractionalAccepted = engine.setBuiltInPluginParam(trackId, "track", 0, "fuzzVoice", 1.75f);
            clampsPassed = clampsPassed && fractionalAccepted
                && valueMatches(bridgeValue(engine.getBuiltInPluginState(trackId, "track", 0), "fuzzVoice"), 2.0);
            const bool malformedRejected = !engine.setBuiltInPluginParam(trackId, "track", 0, "fuzzDrive", std::numeric_limits<float>::quiet_NaN());
            clampsPassed = clampsPassed && malformedRejected
                && valueMatches(bridgeValue(engine.getBuiltInPluginState(trackId, "track", 0), "fuzzDrive"), 0.73);
        }
        if (trackAdded) (void) engine.removeTrack(trackId);
        auto* result = new juce::DynamicObject();
        result->setProperty("rackAdded", rackAdded);
        result->setProperty("schemaAndDefaultsPassed", defaultPassed);
        result->setProperty("parameterClampsAndMalformedRejectionPassed", clampsPassed);
        result->setProperty("bridgeStateRoundtripPassed", roundtripPassed);
        add(checks, "nam_fuzz_parameter_bridge_contract", defaultPassed && clampsPassed && roundtripPassed ? "pass" : "fail",
            "Native Device Controls publish six fuzz parameters, clamp finite extremes, quantize the voice enum, reject malformed changes and preserve saved values through bridge state restoration; schema version remains 1.", juce::var(result));
    }
};
