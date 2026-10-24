#pragma once

#include <JuceHeader.h>
#include <array>
#include <cmath>
#include <cstdint>

/** Original, physically informed fuzz voices, not circuit-exact pedal replicas.
    Each voice has separate stereo state, coupling/tone filters and two nonlinear
    cells. First-order antiderivative antialiasing integrates each clipping cell
    over the interval between samples (Holters, DAFx 2019). The half-sample cell
    delay is part of its filtering; no additional integer-latency island or host
    PDC change is introduced. Bypass is exactly the incoming octave-stage output.
    All controls and voice crossfades ramp in sample time. No callback allocation,
    locks, disk access, or coefficient design inside the sample loop. */
class NAMFuzz final
{
public:
    struct Parameters
    {
        bool enabled = false;
        float drive = 0.5f;
        float tone = 0.5f;
        float levelDb = 0.0f;
        int voice = 0; // Vintage, Sustain, Gated
        float cleanMix = 0.0f;
        bool bass = false;
        float calibrationReferenceDbu = 12.0f;
    };

    // Calling-thread QA view only; the host never reads this concurrently with
    // processing and it is not persisted or published across the native bridge.
    struct GateDiagnostics
    {
        std::array<bool, 2> open {};
        std::array<std::uint64_t, 2> opens {}, closes {};
        std::array<float, 2> envelope {}, gain {};
    };

    [[nodiscard]] GateDiagnostics getGateDiagnostics() const noexcept
    {
        GateDiagnostics result;
        for (size_t channel = 0; channel < channels.size(); ++channel)
        {
            const auto& state = channels[channel];
            result.open[channel] = state.gateOpen;
            result.opens[channel] = state.gateOpens;
            result.closes[channel] = state.gateCloses;
            result.envelope[channel] = state.gateEnvelope;
            result.gain[channel] = state.gate;
        }
        return result;
    }

    void prepare(double rate, const Parameters& parameters) noexcept
    {
        sampleRate = std::isfinite(rate) && rate >= 8000.0 && rate <= 384000.0 ? rate : 44100.0;
        rampSamples = juce::jmax(1, static_cast<int>(sampleRate * 0.025));
        envelopeAttack = pole(0.001f);
        envelopeRelease = pole(0.080f);
        gateAttack = pole(0.003f);
        gateRelease = pole(0.012f);
        bassGateEnvelopeRelease = pole(0.120f);
        bassGateRelease = pole(0.030f);
        bassGateHoldSamples = juce::jmax(1, juce::roundToInt(sampleRate * 0.065));
        dcPole = lowPassPole(12.0f);
        parametersCached = false; // A new rate must redesign even unchanged controls.
        setParameters(parameters);
        for (auto* ramp : ramps()) ramp->finish();
        for (auto& ramp : voiceWeights) ramp.finish();
        reset();
    }

    void reset() noexcept
    {
        channels = {};
        wasProcessing = false;
    }

    void setParameters(const Parameters& raw) noexcept
    {
        if (parametersCached
            && raw.enabled == cachedParameters.enabled
            && raw.drive == cachedParameters.drive
            && raw.tone == cachedParameters.tone
            && raw.levelDb == cachedParameters.levelDb
            && raw.voice == cachedParameters.voice
            && raw.cleanMix == cachedParameters.cleanMix
            && raw.bass == cachedParameters.bass
            && raw.calibrationReferenceDbu == cachedParameters.calibrationReferenceDbu)
            return;
        cachedParameters = raw;
        parametersCached = true;
        const auto bounded = [] (float value, float low, float high, float fallback)
        {
            return std::isfinite(value) ? juce::jlimit(low, high, value) : fallback;
        };
        const float drive = bounded(raw.drive, 0.0f, 1.0f, 0.5f);
        const float tone = bounded(raw.tone, 0.0f, 1.0f, 0.5f);
        const float levelDb = bounded(raw.levelDb, -18.0f, 12.0f, 0.0f);
        bassMode = raw.bass;
        vintageCoupling.target(raw.bass ? 0.0f : 1.0f, rampSamples);
        power.target(raw.enabled ? 1.0f : 0.0f, rampSamples);
        amount.target(drive, rampSamples);
        toneBalance.target(tone, rampSamples);
        level.target(juce::Decibels::decibelsToGain(levelDb), rampSamples);
        clean.target(bounded(raw.cleanMix, 0.0f, 1.0f, 0.0f), rampSamples);
        // Match the rack's embedded pedals: convert the interface's 0 dBFS
        // reference into a fixed +12 dBu operating domain. Reciprocal recovery
        // below preserves the represented analog output and the raw clean path.
        const float referenceDbu = bounded(raw.calibrationReferenceDbu, -24.0f, 48.0f, 12.0f);
        operatingGain.target(juce::Decibels::decibelsToGain(
            juce::jlimit(-36.0f, 36.0f, referenceDbu - 12.0f)), rampSamples);
        // Fixed control-derived compensation for the center of the scooped
        // tone network. Do not chase bright-end RMS by amplifying its peaks.
        const float centerWeight = 1.0f - std::abs(2.0f * tone - 1.0f);
        const float makeupDb = centerWeight * (3.0f + 2.0f * juce::jmin(1.0f, 2.0f * drive));
        sustainMakeup.target(juce::Decibels::decibelsToGain(makeupDb), rampSamples);
        inputHighPass.target(lowPassPole(raw.bass ? 12.0f : 28.0f), rampSamples);
        inputLowPass.target(lowPassPole(raw.bass ? 6500.0f : 8500.0f), rampSamples);
        interstageLowPass.target(lowPassPole(raw.bass ? 3600.0f : 5100.0f), rampSamples);
        toneLowPass.target(lowPassPole((raw.bass ? 800.0f : 1000.0f)
            * std::pow(raw.bass ? 8.0f : 10.0f, tone)), rampSamples);
        sustainLowPass.target(lowPassPole(raw.bass ? 240.0f : 470.0f), rampSamples);
        sustainHighPass.target(lowPassPole(raw.bass ? 800.0f : 1400.0f), rampSamples);
        const int voice = juce::jlimit(0, 2, raw.voice);
        for (int index = 0; index < 3; ++index)
            voiceWeights[static_cast<size_t>(index)].target(index == voice ? 1.0f : 0.0f, rampSamples);
    }

    void processBlock(juce::AudioBuffer<float>& buffer, const float* excitationGains = nullptr) noexcept
    {
        const int count = juce::jmin(2, buffer.getNumChannels());
        if (count == 0 || buffer.getNumSamples() == 0) return;
        if (!wasProcessing && power.current == 0.0f && power.destination == 0.0f)
        {
            bool moving = false;
            for (const auto* ramp : ramps()) moving = moving || ramp->remaining > 0;
            for (const auto& ramp : voiceWeights) moving = moving || ramp.remaining > 0;
            if (!moving) return;
        }
        std::array<float*, 2> data { buffer.getWritePointer(0),
            count > 1 ? buffer.getWritePointer(1) : nullptr };
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            const float wetPower = power.next();
            const float drive = amount.next();
            const float tone = toneBalance.next();
            const float gain = level.next();
            const float cleanBlend = clean.next();
            const float calibratedGain = operatingGain.next();
            const float couplingBlend = vintageCoupling.next();
            const float sustainGain = sustainMakeup.next();
            const float hp = inputHighPass.next();
            const float lp = inputLowPass.next();
            const float inter = interstageLowPass.next();
            const float post = toneLowPass.next();
            const float low = sustainLowPass.next();
            const float high = sustainHighPass.next();
            const float excitation = excitationGains && std::isfinite(excitationGains[sample])
                ? juce::jlimit(0.0f, 1.0f, excitationGains[sample]) : 1.0f;
            std::array<float, 3> weights {};
            for (size_t voice = 0; voice < weights.size(); ++voice)
                weights[voice] = voiceWeights[voice].next();
            // Complete bypass at its exact sample boundary. Retiring histories
            // only on the next callback would make a quick reactivation depend
            // on block size. Every control ramp also advances during bypass,
            // including any zero-wet suffix of this callback.
            if (wetPower == 0.0f && power.destination == 0.0f)
            {
                if (wasProcessing) reset();
                continue; // Leave incoming samples exactly unchanged.
            }
            wasProcessing = true;
            for (int channel = 0; channel < count; ++channel)
            {
                auto& state = channels[static_cast<size_t>(channel)];
                const float dry = std::isfinite(data[static_cast<size_t>(channel)][sample])
                    ? data[static_cast<size_t>(channel)][sample] : 0.0f;
                const float boundedInput = juce::jlimit(-16.0f, 16.0f, dry);
                const float calibratedInput = boundedInput * calibratedGain;
                const float detectorInput = filter(calibratedInput - filter(calibratedInput, hp, state.inputCoupling), lp, state.inputBand);
                // Octave-mixer headroom affects the nonlinear cells and sag,
                // while the clean branch and gate retain their incoming level.
                const float input = detectorInput * excitation;
                const float absolute = std::abs(input);
                const float envPole = absolute > state.envelope ? envelopeAttack : envelopeRelease;
                state.envelope = envPole * state.envelope + (1.0f - envPole) * absolute;
                const float sag = juce::jlimit(0.0f, 1.0f, state.envelope * 3.0f);
                // Leave a usable low/mid Drive range before another gain pedal.
                // The former quadratic already supplied 22.5x at noon, so
                // quiet pickup noise could fully excite a downstream stack.
                // Preserve the 75x endpoint and continuous ungated sustain;
                // this changes excitation, not the final loudness control.
                const float driveSquared = drive * drive;
                const float driveGain = 1.5f + 73.5f * driveSquared * driveSquared;
                const float gatedDriveGain = 5.0f + 70.0f * drive * drive;

                // Vintage: unequal transistor knees, dynamic bias and coupling
                // between two gain stages. Sag changes the response continuously.
                auto& vintage = state.voices[0];
                float vintageOut = clip(input * driveGain / (1.0f + 0.65f * sag),
                    0.62f, 0.88f, 0.10f - 0.12f * sag, vintage.cells[0]);
                vintageOut = filter(vintageOut, inter, vintage.interstage);
                // AC coupling keeps the first asymmetric cell's signal-dependent
                // DC from becoming an unintended bias on the second cell. Keep
                // the history warm in Bass, whose existing sub-octave path is
                // retained without another high-pass stage.
                const float coupled = vintageOut - vintage.couplingInput + dcPole * vintage.couplingOutput;
                vintage.couplingInput = vintageOut;
                vintage.couplingOutput = std::abs(coupled) < 1.0e-20f ? 0.0f : coupled;
                if (couplingBlend == 1.0f)
                    vintageOut = vintage.couplingOutput;
                else if (couplingBlend > 0.0f)
                    vintageOut += couplingBlend * (vintage.couplingOutput - vintageOut);
                vintageOut = clip(vintageOut * (2.0f + 2.5f * drive),
                    0.55f, 0.78f, 0.07f + 0.10f * sag, vintage.cells[1]) * 1.45f;

                // Sustain: cascaded symmetric diode-like cells followed by
                // complementary low/high branches with a broad mid scoop.
                // Keep a 15% low-frequency floor in the bright branch: a pure
                // high-pass adds almost 90 degrees at low frequencies and can
                // oppose the immediate clean blend after coupling/DC filters.
                auto& sustain = state.voices[1];
                float sustainOut = clip(input * driveGain * 0.75f,
                    0.70f, 0.70f, 0.0f, sustain.cells[0]);
                sustainOut = filter(sustainOut, inter, sustain.interstage);
                sustainOut = clip(sustainOut * (2.8f + 2.2f * drive),
                    0.68f, 0.68f, 0.0f, sustain.cells[1]);
                const float lowBranch = filter(sustainOut, low, sustain.lowBand);
                const float highBranch = sustainOut - 0.85f * filter(sustainOut, high, sustain.highBand);
                sustainOut = 1.65f * sustainGain * ((1.0f - tone) * lowBranch + tone * highBranch);

                // Gated: deliberately starved asymmetric cells. Guitar retains
                // its soft gate; Bass gets a separate, longer detector plus
                // hysteresis/hold so low notes do not close on envelope troughs.
                auto& gated = state.voices[2];
                float gatedOut = clip(input * gatedDriveGain * 1.35f,
                    0.40f, 0.80f, 0.28f + 0.12f * sag, gated.cells[0]);
                gatedOut = filter(gatedOut, inter, gated.interstage);
                gatedOut = clip(gatedOut * 3.8f,
                    0.50f, 0.75f, 0.20f, gated.cells[1]);
                const float threshold = 0.0015f + 0.003f * (1.0f - drive);
                const float detectorAbsolute = std::abs(detectorInput);
                const float detectorRelease = bassMode ? bassGateEnvelopeRelease : envelopeRelease;
                const float detectorPole = detectorAbsolute > state.gateEnvelope ? envelopeAttack : detectorRelease;
                state.gateEnvelope = detectorPole * state.gateEnvelope + (1.0f - detectorPole) * detectorAbsolute;
                float gateTarget = 0.0f;
                const bool previouslyOpen = state.gateOpen;
                if (bassMode)
                {
                    if (state.gateEnvelope >= threshold)
                    {
                        state.gateOpen = true;
                        state.belowCloseSamples = 0;
                    }
                    else if (state.gateOpen && state.gateEnvelope < threshold * 0.5f)
                    {
                        if (++state.belowCloseSamples >= bassGateHoldSamples)
                        {
                            state.gateOpen = false;
                            state.belowCloseSamples = 0;
                        }
                    }
                    else
                    {
                        state.belowCloseSamples = 0;
                    }
                    gateTarget = state.gateOpen ? 1.0f : 0.0f;
                }
                else
                {
                    gateTarget = juce::jlimit(0.0f, 1.0f,
                        (state.gateEnvelope - threshold) / (threshold * 3.0f));
                    state.gateOpen = gateTarget > 0.0f;
                    state.belowCloseSamples = 0;
                }
                if (state.gateOpen && !previouslyOpen) ++state.gateOpens;
                if (!state.gateOpen && previouslyOpen) ++state.gateCloses;
                const float gatePole = gateTarget > state.gate ? gateAttack : (bassMode ? bassGateRelease : gateRelease);
                state.gate = gatePole * state.gate + (1.0f - gatePole) * gateTarget;
                gatedOut *= state.gate * 1.5f;

                float wet = weights[0] * filter(vintageOut, post, vintage.outputTone)
                    + weights[1] * filter(sustainOut, post, sustain.outputTone)
                    + weights[2] * filter(gatedOut, post, gated.outputTone);
                const float blocked = wet - state.dcInput + dcPole * state.dcOutput;
                state.dcInput = wet;
                state.dcOutput = std::abs(blocked) < 1.0e-20f ? 0.0f : blocked;
                // A fixed common wet trim leaves room for voice switching;
                // it never changes the true-clean endpoint or follows audio.
                wet = gain * ((1.0f - cleanBlend) * 0.86f * state.dcOutput / calibratedGain
                    + cleanBlend * boundedInput);
                const float output = dry + wetPower * (wet - dry);
                data[static_cast<size_t>(channel)][sample] = std::isfinite(output) ? output : 0.0f;
            }
        }
    }

private:
    struct Ramp
    {
        float current = 0.0f, destination = 0.0f, step = 0.0f;
        int remaining = 0;
        void target(float value, int samples) noexcept
        {
            if (destination == value) return;
            destination = value;
            remaining = samples;
            step = (destination - current) / static_cast<float>(samples);
        }
        float next() noexcept
        {
            if (remaining > 0)
            {
                current += step;
                if (--remaining == 0) current = destination;
            }
            return current;
        }
        void finish() noexcept { current = destination; remaining = 0; step = 0.0f; }
    };
    struct Cell { float previous = 0.0f; };
    struct Voice
    {
        std::array<Cell, 2> cells {};
        float interstage = 0.0f, outputTone = 0.0f, lowBand = 0.0f, highBand = 0.0f;
        float couplingInput = 0.0f, couplingOutput = 0.0f;
    };
    struct Channel
    {
        std::array<Voice, 3> voices {};
        float inputCoupling = 0.0f, inputBand = 0.0f, envelope = 0.0f, gate = 0.0f;
        float dcInput = 0.0f, dcOutput = 0.0f;
        float gateEnvelope = 0.0f;
        int belowCloseSamples = 0;
        bool gateOpen = false;
        std::uint64_t gateOpens = 0, gateCloses = 0;
    };
    std::array<Ramp*, 14> ramps() noexcept
    {
        return { &power, &amount, &toneBalance, &level, &clean, &operatingGain, &vintageCoupling, &sustainMakeup, &inputHighPass,
            &inputLowPass, &interstageLowPass, &toneLowPass, &sustainLowPass, &sustainHighPass };
    }
    float pole(float seconds) const noexcept
    { return static_cast<float>(std::exp(-1.0 / (sampleRate * seconds))); }
    float lowPassPole(float frequency) const noexcept
    {
        const double cutoff = juce::jmin(static_cast<double>(frequency), sampleRate * 0.40);
        return static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi * cutoff / sampleRate));
    }
    static float filter(float input, float coefficient, float& state) noexcept
    {
        state = coefficient * state + (1.0f - coefficient) * input;
        if (std::abs(state) < 1.0e-20f) state = 0.0f;
        return state;
    }
    static double curve(double input, double positive, double negative) noexcept
    {
        const double knee = input >= 0.0 ? positive : negative;
        const double unit = juce::jlimit(-1.0, 1.0, input / knee);
        return knee * (unit - unit * unit * unit / 3.0);
    }
    static double integral(double input, double positive, double negative) noexcept
    {
        const double knee = input >= 0.0 ? positive : negative;
        const double absolute = std::abs(input);
        if (absolute >= knee)
            return 5.0 * knee * knee / 12.0 + 2.0 * knee * (absolute - knee) / 3.0;
        const double squared = input * input;
        return squared * 0.5 - squared * squared / (12.0 * knee * knee);
    }
    static float clip(float input, float positive, float negative, float bias, Cell& state) noexcept
    {
        const double previous = state.previous;
        state.previous = input;
        const double delta = static_cast<double>(input) - previous;
        const double offset = curve(bias, positive, negative);
        const double output = std::abs(delta) < 1.0e-5
            ? curve((static_cast<double>(input) + previous) * 0.5 + bias, positive, negative) - offset
            : (integral(static_cast<double>(input) + bias, positive, negative)
                - integral(previous + bias, positive, negative)) / delta - offset;
        return static_cast<float>(output);
    }
    double sampleRate = 44100.0;
    int rampSamples = 1103;
    float envelopeAttack = 0.0f, envelopeRelease = 0.0f, gateAttack = 0.0f, gateRelease = 0.0f, dcPole = 0.0f;
    float bassGateEnvelopeRelease = 0.0f, bassGateRelease = 0.0f;
    int bassGateHoldSamples = 1;
    bool bassMode = false;
    Ramp power, amount, toneBalance, level, clean, operatingGain, vintageCoupling;
    Ramp sustainMakeup;
    Ramp inputHighPass, inputLowPass, interstageLowPass, toneLowPass, sustainLowPass, sustainHighPass;
    std::array<Ramp, 3> voiceWeights {};
    std::array<Channel, 2> channels {};
    Parameters cachedParameters;
    bool parametersCached = false;
    bool wasProcessing = false;
};
