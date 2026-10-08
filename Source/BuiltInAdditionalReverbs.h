#pragma once
#include "BuiltInReverbPitchVoice.h"
#include "BuiltInNonlinearTail.h"
#include "BuiltInReverbSpillover.h"

// Standalone-only spaces. NAM Rack never prepares or runs these engines.
// The caller owns wet/dry routing; this class returns wet stereo samples.
class BuiltInAdditionalReverbs
{
public:
    struct Settings
    {
        float decay, size, damping, diffusion, preDelay, lowCut, highCut, shimmer, width;
        float pitchA = 12, pitchB = 7, voiceMix = 0, shape = 0, voiceEngine = 1;
        float shimmerRoute = 0; // Tank (legacy), Input, Both
        float nonlinearFeedback = 0, lateDecay = 2, lateLevel = 0, nonlinearDiffusion = 0;
        bool hold = false, infiniteInput = false;
        float nonlinearModulation = 0, nonlinearRate = .7f;
        bool nonlinearHold=false;
    };
    void prepare(double sampleRate, int selected)
    {
        rate = static_cast<float>(sampleRate);
        pre.assign(static_cast<size_t>(std::ceil(rate * 0.51f)) + 2, {});
        for(auto& history:kindPre)history.assign(pre.size(),{});
        for(auto& delay:kindPredelay)delay.reset(sampleRate,.05);
        retirement.prepare(sampleRate,selected>=4&&selected<=6?selected-4:-1);
        nonlinear.assign(static_cast<size_t>(std::ceil(rate * 2.1f)) + 2, {});
        constexpr std::array<float, 8> times { .0297f, .0371f, .0411f, .0437f, .0531f, .0617f, .0713f, .0797f };
        for (size_t i = 0; i < lines.size(); ++i) lines[i].assign(static_cast<size_t>(rate * times[i]) + 1, 0);
        spring[0].assign(static_cast<size_t>(rate * .037f) + 1, 0);
        spring[1].assign(static_cast<size_t>(rate * .043f) + 1, 0);
        shifter[0].prepare(sampleRate, .075f, 0.0f, 2.0f);
        shifter[1].prepare(sampleRate, .081f, .5f, 2.0f);
        for (auto& voice : spectralVoices) voice.prepare(sampleRate);
        for (auto& voice : inputSpectralVoices) voice.prepare(sampleRate);
        inputShifter[0].prepare(sampleRate, .075f, 0.0f, 2.0f);
        inputShifter[1].prepare(sampleRate, .081f, .5f, 2.0f);
        inputRoute.reset(sampleRate, .05); tankRoute.reset(sampleRate, .05);
        holdWeight.reset(sampleRate,.05); holdSend.reset(sampleRate,.05);
        for (auto& pitch : pitchRatio) pitch.reset(sampleRate, .05);
        voiceMix.reset(sampleRate, .05);
        shimmerBlend.reset(sampleRate, .05);
        spectralWeight.reset(sampleRate, .05);
        for (auto& gain : reflectionGain) gain.reset(sampleRate, .05);
        nonlinearReturn.reset(sampleRate, .05); nonlinearLateLevel.reset(sampleRate, .05); nonlinearSmear.reset(sampleRate, .05);
        nonlinearTail.prepare(sampleRate);
        nonlinearDepth.reset(sampleRate, .05); nonlinearRate.reset(sampleRate, .05);
        nonlinearHoldWeight.reset(sampleRate,.05);nonlinearHoldSend.reset(sampleRate,.05);
        for (size_t tap = 0; tap < reflectionPhase.size(); ++tap)
        {
            const float angle = juce::MathConstants<float>::twoPi * static_cast<float>((tap * 17) % 48) / 48.0f;
            reflectionPhase[tap] = { std::cos(angle), std::sin(angle) };
        }
        for (size_t i = 0; i < weights.size(); ++i)
        {
            weights[i].reset(sampleRate, .05);
            weights[i].setCurrentAndTargetValue(selected == static_cast<int>(i) + 4 ? 1.0f : 0.0f);
        }
        predelay.reset(sampleRate, .05);
        predelay.setCurrentAndTargetValue(0);
        reset();
    }
    void reset()
    {
        std::fill(pre.begin(), pre.end(), std::array<float, 2>{});
        for(auto& history:kindPre)std::fill(history.begin(),history.end(),std::array<float,2>{});
        hasKindSettings.fill(false);retirement.reset(weights);
        std::fill(nonlinear.begin(), nonlinear.end(), std::array<float, 2>{});
        for (auto& line : lines) std::fill(line.begin(), line.end(), 0.0f);
        for (auto& line : spring) std::fill(line.begin(), line.end(), 0.0f);
        for (auto& shift : shifter) shift.reset();
        for (auto& voice : spectralVoices) voice.reset();
        for (auto& voice : inputSpectralVoices) voice.reset();
        for (auto& voice : inputShifter) voice.reset();
        inputDrainRemaining = 0; nonlinearTail.reset(); nonlinearReturned.fill(0); lateWasActive = false;
        nonlinearPhase = 0;
        positions.fill(0); springPositions.fill(0); dampingState.fill(0);
        for (auto& state : dispersion) state.fill(0);
        for (auto& state : highState) state.fill(0);
        for (auto& state : lowState) state.fill(0);
        shifted.fill(0); prePosition = 0; nonlinearPosition = 0; settingsInitialized = false; spectralDrainRemaining = 0;
        drainRemaining.fill(0); processedFrames.fill(0); validLines.fill(0); validSpring.fill(0); validNonlinear=0; validPre=0;
    }
    void configure(int selected, const Settings& settings, bool spillover=false)
    {
        retainTails=spillover;
        values = settings;
        const auto finite = [](float value, float fallback) { return std::isfinite(value) ? value : fallback; };
        values.decay = finite(values.decay, 2);
        values.size = finite(values.size, .5f);
        values.damping = finite(values.damping, .5f);
        values.width = finite(values.width, 1);
        values.preDelay = finite(values.preDelay, 0);
        values.lowCut = finite(values.lowCut, 20);
        values.highCut = finite(values.highCut, 20000);
        values.shimmer = finite(values.shimmer, 0);
        values.pitchA = juce::jlimit(-24.0f, 24.0f, finite(values.pitchA, 12));
        values.pitchB = juce::jlimit(-24.0f, 24.0f, finite(values.pitchB, 7));
        values.voiceMix = juce::jlimit(0.0f, 1.0f, finite(values.voiceMix, 0));
        values.shape = juce::jlimit(0.0f, 7.0f, finite(values.shape, 0));
        values.nonlinearFeedback = juce::jlimit(0.0f, .95f, finite(values.nonlinearFeedback, 0));
        values.lateDecay = juce::jlimit(.1f, 20.0f, finite(values.lateDecay, 2));
        values.lateLevel = juce::jlimit(0.0f, 1.0f, finite(values.lateLevel, 0));
        values.nonlinearDiffusion = juce::jlimit(0.0f, 1.0f, finite(values.nonlinearDiffusion, 0));
        values.nonlinearModulation = juce::jlimit(0.0f, 1.0f, finite(values.nonlinearModulation, 0));
        values.nonlinearRate = juce::jlimit(.05f, 8.0f, finite(values.nonlinearRate, .7f));
        values.size = juce::jlimit(0.0f, 1.0f, values.size);
        values.damping = juce::jlimit(0.0f, 1.0f, values.damping);
        values.width = juce::jlimit(0.0f, 1.0f, values.width);
        if(selected==6&&values.nonlinearHold&&hasKindSettings[2]){values.decay=kindSettings[2].decay;values.shape=kindSettings[2].shape;}
        if(selected>=4&&selected<=6){kindSettings[static_cast<size_t>(selected-4)]=values;hasKindSettings[static_cast<size_t>(selected-4)]=true;}
        for(size_t kind=0;kind<3;++kind)
        {
            const auto& saved=hasKindSettings[kind]?kindSettings[kind]:values;
            const float target=juce::jlimit(0.0f,.5f*rate,saved.preDelay*.001f*rate);
            if(!settingsInitialized)kindPredelay[kind].setCurrentAndTargetValue(target);else kindPredelay[kind].setTargetValue(target);
            retirement.configure(kind,selected==static_cast<int>(kind)+4,retainTails,drainRemaining[kind]>0);
        }
        const auto& shimmerSettings=settingsFor(1);const auto& nonlinearSettings=settingsFor(2);
        for (size_t i = 0; i < weights.size(); ++i) weights[i].setTargetValue(selected == static_cast<int>(i) + 4 ? 1.0f : 0.0f);
        const float targetPreDelay = juce::jlimit(0.0f, .5f * rate, values.preDelay * .001f * rate);
        if (!settingsInitialized) predelay.setCurrentAndTargetValue(targetPreDelay);
        else predelay.setTargetValue(targetPreDelay);
        const auto setSmooth = [this](auto& smoother, float target)
        {
            if (!settingsInitialized) smoother.setCurrentAndTargetValue(target);
            else smoother.setTargetValue(target);
        };
        setSmooth(holdWeight, selected == 5 && shimmerSettings.hold ? 1.0f : 0.0f);
        setSmooth(holdSend, selected == 5 && shimmerSettings.hold && !shimmerSettings.infiniteInput ? 0.0f : 1.0f);
        setSmooth(pitchRatio[0], std::pow(2.0f, shimmerSettings.pitchA / 12.0f));
        setSmooth(pitchRatio[1], std::pow(2.0f, shimmerSettings.pitchB / 12.0f));
        setSmooth(voiceMix, shimmerSettings.voiceMix);
        setSmooth(shimmerBlend, juce::jlimit(0.0f, .45f, shimmerSettings.shimmer * .45f));
        setSmooth(spectralWeight, shimmerSettings.voiceEngine >= .5f ? 1.0f : 0.0f);
        const int route = juce::jlimit(0, 2, juce::roundToInt(finite(shimmerSettings.shimmerRoute, 0)));
        setSmooth(inputRoute, route > 0 ? 1.0f : 0.0f);
        setSmooth(tankRoute, route == 1 ? 0.0f : 1.0f);
        setSmooth(nonlinearReturn, nonlinearSettings.nonlinearFeedback);
        setSmooth(nonlinearLateLevel, nonlinearSettings.lateLevel);
        setSmooth(nonlinearSmear, nonlinearSettings.nonlinearDiffusion);
        const bool holdNonlinear=selected==6&&nonlinearSettings.nonlinearHold;
        setSmooth(nonlinearHoldWeight,holdNonlinear?1.0f:0.0f);
        setSmooth(nonlinearHoldSend,holdNonlinear&&!nonlinearSettings.infiniteInput?0.0f:1.0f);
        setSmooth(nonlinearDepth, holdNonlinear?0.0f:nonlinearSettings.nonlinearModulation * rate * .002f);
        setSmooth(nonlinearRate, nonlinearSettings.nonlinearRate);
        if (selected == 6 || drainRemaining[2] > 0) nonlinearTail.configure(nonlinearSettings.lateDecay, nonlinearSettings.damping,holdNonlinear);
        const int shape = juce::roundToInt(nonlinearSettings.shape);
        // Normalize every envelope to the same tap energy as the legacy Ramp.
        // This prevents a shape switch from being merely an output-gain change.
        if (!settingsInitialized || shape != previousShape)
        {
            std::array<float, 48> envelope {};
            float legacyEnergy = 0, newEnergy = 0;
            for (size_t tap = 0; tap < envelope.size(); ++tap)
            {
                const float position = (static_cast<float>(tap) + .5f) / 48.0f;
                const float ramp = .2f + .8f * position;
                float amplitude = ramp;
                switch (shape)
                {
                    case 1: amplitude = juce::jmin(1.0f, position * 16.0f); break; // gated plateau
                    case 2: amplitude = std::exp(5.0f * (position - 1.0f)); break; // exponential reverse
                    case 3: amplitude = std::pow(std::sin(position * juce::MathConstants<float>::halfPi), 2.0f); break;
                    case 4: amplitude = std::exp(-5.0f * position); break;
                    case 5: amplitude = std::exp(-18.0f * (position - .5f) * (position - .5f)); break;
                    case 6: amplitude = std::pow(std::sin(position * juce::MathConstants<float>::halfPi), 5.0f); break;
                    case 7: amplitude = 1 - std::exp(-18.0f * (position - .5f) * (position - .5f)); break;
                    default: break;
                }
                envelope[tap] = amplitude;
                legacyEnergy += ramp * ramp;
                newEnergy += amplitude * amplitude;
            }
            const float normalization = std::sqrt(legacyEnergy / juce::jmax(1e-8f, newEnergy));
            for (size_t tap = 0; tap < envelope.size(); ++tap)
                setSmooth(reflectionGain[tap], envelope[tap] * normalization * .035f * (tap % 3 == 0 ? -1.0f : 1.0f));
            // Every normalized shape has this same energy; Cauchy-Schwarz
            // bounds the FIR gain by sqrt(taps * energy), including morphs.
            reflectionGainBound = std::sqrt(48.0f * legacyEnergy) * .035f;
            previousShape = shape;
        }
        settingsInitialized = true;
        const float decay = juce::jlimit(.1f, 20.0f, values.decay);
        if(selected>=4&&selected<=6)
        {
            const auto kind=static_cast<size_t>(selected-4);
            const float seconds=kind==2 ? juce::jmax(2.7f, nonlinearTailSeconds(values.decay, values.nonlinearFeedback,
                values.lateDecay, values.lateLevel, values.nonlinearDiffusion) + values.preDelay * .001f + .6f) : 2.0f*decay+1.5f;
            drainRemaining[kind]=juce::jmax(drainRemaining[kind],static_cast<int>(std::ceil(rate*seconds)));
        }
        for (size_t i = 0; i < lines.size(); ++i)
            feedback[i] = std::pow(.001f, static_cast<float>(lines[i].size()) / (rate * juce::jlimit(.1f,20.0f,settingsFor(1).decay)));
        for (size_t i = 0; i < spring.size(); ++i)
            springFeedback[i] = std::pow(.001f, static_cast<float>(spring[i].size()) / (rate * juce::jlimit(.1f,20.0f,settingsFor(0).decay)));
        for(size_t kind=0;kind<3;++kind)
        {
            const auto& settingsForKind=settingsFor(kind);
            lowCoefficient[kind] = 1.0f - std::exp(-juce::MathConstants<float>::twoPi * juce::jlimit(1000.0f, rate * .45f, settingsForKind.highCut) / rate);
            highCoefficient[kind] = 1.0f - std::exp(-juce::MathConstants<float>::twoPi * juce::jlimit(20.0f, 500.0f, settingsForKind.lowCut) / rate);
            dampingCoefficient[kind] = juce::jlimit(.03f, .95f, .95f - settingsForKind.damping * .9f);
        }
    }
    std::array<float, 3> process(float left, float right)
    {
        if (pre.empty()) return {};
        if(isDormant()) return {};
        left = std::isfinite(left) ? juce::jlimit(-16.0f, 16.0f, left) : 0.0f;
        right = std::isfinite(right) ? juce::jlimit(-16.0f, 16.0f, right) : 0.0f;
        pre[prePosition] = { left, right };
        validPre=juce::jmin(pre.size(),validPre+1);
        const float delay = predelay.getNextValue();
        const size_t whole = static_cast<size_t>(delay);
        const float fraction = delay - static_cast<float>(whole);
        const size_t first = (prePosition + pre.size() - whole) % pre.size();
        const size_t second = (first + pre.size() - 1) % pre.size();
        std::array<float, 2> input {};
        for (size_t ch = 0; ch < 2; ++ch)
        {
            const float a=whole<validPre?pre[first][ch]:0, b=whole+1<validPre?pre[second][ch]:0;
            input[ch]=a+fraction*(b-a);
        }
        std::array<std::array<float,2>,3> kindInput {};
        for(size_t kind=0;kind<3;++kind)
        {
            kindPre[kind][prePosition]=weights[kind].getTargetValue()>0?std::array<float,2>{left,right}:std::array<float,2>{};
            const float ownDelay=kindPredelay[kind].getNextValue();const size_t ownWhole=static_cast<size_t>(ownDelay);const float ownFraction=ownDelay-static_cast<float>(ownWhole);
            const size_t a=(prePosition+pre.size()-ownWhole)%pre.size(),b=(a+pre.size()-1)%pre.size();
            for(size_t ch=0;ch<2;++ch){const float firstSample=ownWhole<validPre?kindPre[kind][a][ch]:0,secondSample=ownWhole+1<validPre?kindPre[kind][b][ch]:0;kindInput[kind][ch]=retainTails?firstSample+ownFraction*(secondSample-firstSample):input[ch]*weights[kind].getTargetValue();}
        }
        prePosition = (prePosition + 1) % pre.size();
        std::array<std::array<float, 2>, 3> wet {};
        // Dispersive allpass chains in two damped recirculating springs.
        if(drainRemaining[0]>0)
        {
        ++processedFrames[0];
        for (size_t ch = 0; ch < 2; ++ch)
        {
            float wave = validSpring[ch]>=spring[ch].size()?spring[ch][springPositions[ch]]:0.0f;
            for (size_t stage = 0; stage < dispersion[ch].size(); ++stage)
            {
                const float coefficient = .42f + .035f * static_cast<float>(stage) + settingsFor(0).size * .08f;
                const float next = dispersion[ch][stage] - coefficient * wave;
                dispersion[ch][stage] = wave + coefficient * next;
                wave = next;
            }
            dampingState[ch] += dampingCoefficient[0] * (wave - dampingState[ch]);
            spring[ch][springPositions[ch]] = kindInput[0][ch] * .3f + dampingState[ch] * springFeedback[ch];
            springPositions[ch] = (springPositions[ch] + 1) % spring[ch].size();
            validSpring[ch]=juce::jmin(spring[ch].size(),validSpring[ch]+1);
            wet[0][ch] = wave;
        }
        }
        // Orthogonal eight-line feedback network with octave-up reinjection.
        if(drainRemaining[1]>0)
        {
        ++processedFrames[1];
        std::array<float, 8> taps {};
        float sum = 0;
        for (size_t i = 0; i < lines.size(); ++i) { taps[i] = validLines[i]>=lines[i].size()?lines[i][positions[i]]:0.0f; sum += taps[i]; }
        const float amount = shimmerBlend.getNextValue();
        const float ratioA = pitchRatio[0].getNextValue(), ratioB = pitchRatio[1].getNextValue();
        const float blend = voiceMix.getNextValue();
        const float spectralMix = spectralWeight.getNextValue();
        const float inputMix = inputRoute.getNextValue() * (amount / .45f);
        const float held = holdWeight.getNextValue(), excitation = holdSend.getNextValue();
        const float tankAmount = tankRoute.getNextValue() * amount;
        const bool feedInput = inputRoute.getCurrentValue() > 0
            && (weights[1].getCurrentValue() > 0 || weights[1].getTargetValue() > 0 || (retainTails&&retirement.audibleRetiring(1)));
        if (feedInput) inputDrainRemaining = static_cast<int>(rate * .3f);
        std::array<float, 2> inputShift {};
        if (inputDrainRemaining > 0)
        {
            --inputDrainRemaining;
            const float leftInput = feedInput ? (retainTails?kindInput[1][0]:input[0]) : 0, rightInput = feedInput ? (retainTails?kindInput[1][1]:input[1]) : 0;
            const auto firstVoice = inputSpectralVoices[0].process(leftInput, rightInput, ratioA);
            const auto secondVoice = inputSpectralVoices[1].process(leftInput, rightInput, ratioB);
            for (size_t ch = 0; ch < 2; ++ch)
                inputShift[ch] = inputShifter[ch].processSample(ch == 0 ? leftInput : rightInput) * (1 - spectralMix)
                    + (firstVoice[ch] * (1 - blend) + secondVoice[ch] * blend) * spectralMix;
        }
        for (size_t i = 0; i < lines.size(); ++i)
        {
            const size_t ch = i % 2;
            const float reflected = taps[i] - .25f * sum;
            dampingState[i + 2] += dampingCoefficient[1] * (reflected - dampingState[i + 2]);
            // Normal processing retains its original convex pitch return. Hold
            // moves to the lossless unpitched tank and bounds added excitation.
            float reinjected = dampingState[i + 2] * (1.0f - tankAmount) + shifted[ch] * tankAmount * .5f;
            const float source=retainTails?kindInput[1][ch]:input[ch];
            const float routedInput = inputMix <= 0 ? source : source * (1 - inputMix) + inputShift[ch] * inputMix;
            if(held>0)reinjected+=held*(reflected-reinjected);
            const float sample=routedInput*(retainTails?1.0f:weights[1].getTargetValue())*.22f*excitation+reinjected*(feedback[i]+held*(1-feedback[i]));
            lines[i][positions[i]]=held>0?juce::jlimit(-8.0f,8.0f,sample):sample;
            positions[i] = (positions[i] + 1) % lines[i].size();
            validLines[i]=juce::jmin(lines[i].size(),validLines[i]+1);
            wet[1][ch] += taps[i] * (i < 4 ? .35f : -.35f);
        }
        std::array<float, 2> voiceA {}, voiceB {};
        // Drain the spectral history with silence before suspending inactive
        // voices, so returning to Shimmer cannot replay frozen old input.
        const bool feedSpectral = spectralMix > 0 && (weights[1].getCurrentValue() > 0 || weights[1].getTargetValue() > 0 || (retainTails&&retirement.audibleRetiring(1)));
        if (feedSpectral) spectralDrainRemaining = static_cast<int>(rate * .3f);
        if (spectralDrainRemaining > 0)
        {
            --spectralDrainRemaining;
            const float inputL = feedSpectral ? wet[1][0] : 0, inputR = feedSpectral ? wet[1][1] : 0;
            voiceA = spectralVoices[0].process(inputL, inputR, ratioA);
            voiceB = spectralVoices[1].process(inputL, inputR, ratioB);
        }
        for (size_t ch = 0; ch < 2; ++ch)
        {
            const float legacy = shifter[ch].processSample(wet[1][ch]);
            // Convex sum maintains the old feedback bound with either voice.
            shifted[ch] = legacy * (1.0f - spectralMix)
                + (voiceA[ch] * (1.0f - blend) + voiceB[ch] * blend) * spectralMix;
        }
        }
        // Reflection generator, bounded return around that generator, then independent late decay.
        if(drainRemaining[2]>0)
        {
        ++processedFrames[2];
        const float returnGain = nonlinearReturn.getNextValue() / juce::jmax(1.0f, reflectionGainBound);
        const float held=nonlinearHoldWeight.getNextValue(),send=nonlinearHoldSend.getNextValue();
        auto nonlinearInput = nonlinearTail.diffuse({
            kindInput[2][0]*send + nonlinearReturned[0] * returnGain*(1-held),
            kindInput[2][1]*send + nonlinearReturned[1] * returnGain*(1-held) }, nonlinearSmear.getNextValue());
        const float duration = juce::jlimit(.1f, 2.0f, settingsFor(2).decay) * rate;
        auto next=nonlinearInput;
        if(held>0)
        {
            const auto loopLength=static_cast<size_t>(juce::roundToInt(duration));
            const auto loop=validNonlinear>=loopLength?nonlinear[(nonlinearPosition+nonlinear.size()-loopLength)%nonlinear.size()]:std::array<float,2>{};
            for(size_t ch=0;ch<2;++ch){nonlinearInput[ch]*=send;next[ch]=juce::jlimit(-4.0f,4.0f,nonlinearInput[ch]+held*loop[ch]);}
        }
        nonlinear[nonlinearPosition] = next;
        validNonlinear=juce::jmin(nonlinear.size(),validNonlinear+1);
        const float depthSamples = nonlinearDepth.getNextValue();
        const float phaseSine = depthSamples > 0 ? static_cast<float>(std::sin(nonlinearPhase)) : 0;
        const float phaseCosine = depthSamples > 0 ? static_cast<float>(std::cos(nonlinearPhase)) : 1;
        nonlinearPhase += juce::MathConstants<double>::twoPi * nonlinearRate.getNextValue() / rate;
        if (nonlinearPhase >= juce::MathConstants<double>::twoPi) nonlinearPhase -= juce::MathConstants<double>::twoPi;
        for (int tap = 0; tap < 48; ++tap)
        {
            const float position = (static_cast<float>(tap) + .5f) / 48.0f;
            const size_t offset = static_cast<size_t>(duration * (.02f + .96f * position));
            auto reflection = offset<validNonlinear?nonlinear[(nonlinearPosition + nonlinear.size() - offset) % nonlinear.size()]:std::array<float,2>{};
            if (depthSamples > 0)
            {
                const auto& rotation = reflectionPhase[static_cast<size_t>(tap)];
                const float modulated = juce::jlimit(1.0f, static_cast<float>(nonlinear.size() - 2), static_cast<float>(offset) + depthSamples * (phaseSine * rotation[0] + phaseCosine * rotation[1]));
                const auto wholeDelay = static_cast<size_t>(modulated);
                const float interpolation = modulated - static_cast<float>(wholeDelay);
                const size_t index = (nonlinearPosition + nonlinear.size() - wholeDelay) % nonlinear.size();
                for (size_t ch = 0; ch < 2; ++ch)
                {
                    const float a = wholeDelay < validNonlinear ? nonlinear[index][ch] : 0;
                    const float b = wholeDelay + 1 < validNonlinear ? nonlinear[(index + nonlinear.size() - 1) % nonlinear.size()][ch] : 0;
                    reflection[ch] = a + interpolation * (b - a);
                }
            }
            const float gain = reflectionGain[static_cast<size_t>(tap)].getNextValue();
            wet[2][0] += reflection[static_cast<size_t>(tap % 2)] * gain;
            wet[2][1] += reflection[static_cast<size_t>((tap + 1) % 2)] * gain;
        }
        nonlinearPosition = (nonlinearPosition + 1) % nonlinear.size();
        for (size_t ch = 0; ch < 2; ++ch)
            nonlinearReturned[ch] += dampingCoefficient[2] * (wet[2][ch] - nonlinearReturned[ch]);
        const float lateGain = nonlinearLateLevel.getNextValue();
        if (lateGain > 0 || nonlinearLateLevel.getTargetValue() > 0)
        {
            auto excitation=wet[2];
            if(held>0)for(size_t ch=0;ch<2;++ch)excitation[ch]=held>=1?nonlinearInput[ch]:excitation[ch]+held*(nonlinearInput[ch]-excitation[ch]);
            const auto tail = nonlinearTail.process(excitation, depthSamples, phaseSine, phaseCosine);
            for (size_t ch = 0; ch < 2; ++ch) wet[2][ch] += tail[ch] * lateGain;
            lateWasActive = true;
        }
        else if (lateWasActive) { nonlinearTail.resetLate(); lateWasActive = false; }
        }
        std::array<float, 3> output {};
        for (size_t kind = 0; kind < wet.size(); ++kind)
        {
            const float weight = weights[kind].getNextValue();
            if(weights[kind].getTargetValue()==0&&drainRemaining[kind]<=static_cast<int>(rate*.05f))retirement.configure(kind,false,retainTails,false);
            const float wetWeight=retirement.next(kind);
            output[2] += weight;
            if(drainRemaining[kind]==0) continue;
            for (size_t ch = 0; ch < 2; ++ch)
            {
                highState[kind][ch] += highCoefficient[kind] * (wet[kind][ch] - highState[kind][ch]);
                lowState[kind][ch] += lowCoefficient[kind] * (wet[kind][ch] - highState[kind][ch] - lowState[kind][ch]);
                if(!retainTails)output[ch] += lowState[kind][ch] * weight;
            }
            if(retainTails)
            {
                const float mid=(lowState[kind][0]+lowState[kind][1])*.5f,side=(lowState[kind][0]-lowState[kind][1])*.5f*settingsFor(kind).width;
                output[0]+=(mid+side)*wetWeight;output[1]+=(mid-side)*wetWeight;
            }
            if(--drainRemaining[kind]==0)
            {
                highState[kind]={};lowState[kind]={};
                if(kind==0)
                {
                    validSpring.fill(0);springPositions.fill(0);
                    for(auto& state:dispersion)state.fill(0);
                    dampingState[0]=0;dampingState[1]=0;
                }
                else if(kind==1)
                {
                    validLines.fill(0);positions.fill(0);shifted.fill(0);
                    for(size_t i=2;i<dampingState.size();++i)dampingState[i]=0;
                }
                else {validNonlinear=0;nonlinearPosition=0;nonlinearReturned.fill(0);nonlinearTail.reset();lateWasActive=false;}
            }
        }
        if(isDormant()) { validPre=0;prePosition=0; }
        const float mid = (output[0] + output[1]) * .5f;
        const float side = (output[0] - output[1]) * .5f * (retainTails?1.0f:values.width);
        output[0] = mid + side; output[1] = mid - side;
        return output;
    }
    static float nonlinearTailSeconds(float time, float feedbackAmount, float lateDecay, float lateLevel, float diffusion) noexcept
    {
        const float duration = juce::jlimit(.1f, 2.0f, time);
        const float feedbackGain = juce::jlimit(0.0f, .95f, feedbackAmount);
        const float repeats = feedbackGain > 0 ? std::log(.001f) / std::log(feedbackGain) : 0;
        return juce::jmin(120.0f, duration * (1 + repeats) + .1f
            + (lateLevel > 0 ? 2 * juce::jlimit(.1f, 20.0f, lateDecay) + 1 : 0)
            + (diffusion > 0 ? .5f : 0));
    }
    double retiringTailSeconds()const noexcept
    {
        int remaining=0;for(size_t kind=0;kind<3;++kind)if(retirement.audibleRetiring(kind))remaining=juce::jmax(remaining,drainRemaining[kind]);
        return static_cast<double>(remaining)/rate;
    }
    // Audio-thread-owned diagnostics; inspect only while processing is stopped.
    bool isDormant() const noexcept { return drainRemaining[0]==0&&drainRemaining[1]==0&&drainRemaining[2]==0; }
    std::array<juce::uint64,3> processingFrames() const noexcept { return processedFrames; }
private:
    BuiltInNonlinearTail nonlinearTail;
    std::array<float, 2> nonlinearReturned {};
    float reflectionGainBound = 1;
    bool lateWasActive = false;
    juce::SmoothedValue<float> nonlinearReturn, nonlinearLateLevel, nonlinearSmear;
    juce::SmoothedValue<float> nonlinearDepth, nonlinearRate, nonlinearHoldWeight, nonlinearHoldSend;
    double nonlinearPhase = 0;
    std::array<std::array<float, 2>, 48> reflectionPhase {};
    float rate = 44100;
    std::array<float,3> lowCoefficient {1,1,1},highCoefficient {},dampingCoefficient {.5f,.5f,.5f};
    Settings values {};
    std::array<Settings,3> kindSettings {};
    std::array<bool,3> hasKindSettings {};
    bool retainTails=false;
    BuiltInReverbSpillover<3> retirement;
    std::array<std::vector<std::array<float,2>>,3> kindPre;
    std::array<juce::SmoothedValue<float>,3> kindPredelay;
    const Settings& settingsFor(size_t kind)const noexcept{return retainTails&&hasKindSettings[kind]?kindSettings[kind]:values;}
    bool settingsInitialized = false;
    int previousShape = -1;
    int spectralDrainRemaining = 0, inputDrainRemaining = 0;
    std::array<int,3> drainRemaining {};
    std::array<juce::uint64,3> processedFrames {};
    std::array<size_t,8> validLines {};
    std::array<size_t,2> validSpring {};
    size_t validNonlinear=0,validPre=0;
    std::vector<std::array<float, 2>> pre, nonlinear;
    std::array<std::vector<float>, 8> lines;
    std::array<std::vector<float>, 2> spring;
    std::array<size_t, 8> positions {};
    std::array<size_t, 2> springPositions {};
    size_t prePosition = 0, nonlinearPosition = 0;
    std::array<float, 8> feedback {};
    std::array<float, 2> springFeedback {}, shifted {};
    std::array<float, 10> dampingState {};
    std::array<std::array<float, 8>, 2> dispersion {};
    std::array<std::array<float, 2>, 3> highState {}, lowState {};
    std::array<OpenStudioOctaveShimmerShifter, 2> shifter, inputShifter;
    std::array<BuiltInReverbPitchVoice, 2> spectralVoices, inputSpectralVoices;
    std::array<juce::SmoothedValue<float>, 2> pitchRatio;
    juce::SmoothedValue<float> voiceMix, shimmerBlend, spectralWeight, inputRoute, tankRoute, holdWeight, holdSend;
    std::array<juce::SmoothedValue<float>, 48> reflectionGain;
    std::array<juce::SmoothedValue<float>, 3> weights;
    juce::SmoothedValue<float> predelay;
};
