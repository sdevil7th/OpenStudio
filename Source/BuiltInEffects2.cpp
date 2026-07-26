#include "BuiltInEffects2.h"
#include "S13PluginEditors.h"

#include "NAM/container.h"
#include "NAM/convnet.h"
#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#include "NAM/lstm.h"
#include "NAM/model_config.h"
#include "NAM/wavenet/model.h"

#include <filesystem>
#include <mutex>

#if JUCE_WINDOWS
 #include <excpt.h>
#endif

juce::AudioProcessorEditor* S13Delay::createEditor() { return new S13DelayEditor(*this); }
juce::AudioProcessorEditor* S13Reverb::createEditor() { return new S13ReverbEditor(*this); }
juce::AudioProcessorEditor* S13Chorus::createEditor() { return new S13ChorusEditor(*this); }
juce::AudioProcessorEditor* S13Saturator::createEditor() { return new S13SaturatorEditor(*this); }

// ============================================================================
// Helper: save/load parameters via ValueTree
// ============================================================================
namespace
{
    constexpr size_t kRealtimeFilterLutSize = 513;
    constexpr size_t kDiodeCurveLutSize = 2049;
    constexpr size_t kModulationSineLutSize = 4097;

    struct ModulationSineLut
    {
        ModulationSineLut()
        {
            for (size_t index = 0;
                 index < kModulationSineLutSize;
                 ++index)
            {
                const float phase =
                    juce::MathConstants<float>::twoPi
                    * static_cast<float>(index)
                    / static_cast<float>(
                        kModulationSineLutSize - 1);
                values[index] = std::sin(phase);
            }
        }

        std::array<float, kModulationSineLutSize> values {};
    };

    const ModulationSineLut& getModulationSineLut()
    {
        static const ModulationSineLut lut;
        return lut;
    }

    float wrapModulationPhase(float phase) noexcept
    {
        constexpr float twoPi =
            juce::MathConstants<float>::twoPi;
        while (phase >= twoPi)
            phase -= twoPi;
        while (phase < 0.0f)
            phase += twoPi;
        return phase;
    }

    float lookupModulationSine(float phase) noexcept
    {
        phase = wrapModulationPhase(phase);
        const float position =
            phase
            * static_cast<float>(
                kModulationSineLutSize - 1)
            / juce::MathConstants<float>::twoPi;
        const auto lowerIndex = static_cast<size_t>(position);
        const auto upperIndex = juce::jmin(
            lowerIndex + 1,
            kModulationSineLutSize - 1);
        const float fraction =
            position - static_cast<float>(lowerIndex);
        const auto& lut = getModulationSineLut();
        return lut.values[lowerIndex]
            + (lut.values[upperIndex]
               - lut.values[lowerIndex])
                * fraction;
    }

    struct DiodeCurveLut
    {
        DiodeCurveLut()
        {
            for (size_t index = 0;
                 index < kDiodeCurveLutSize;
                 ++index)
            {
                const float exponent =
                    -5.0f
                    + 10.0f * static_cast<float>(index)
                        / static_cast<float>(
                            kDiodeCurveLutSize - 1);
                sinhValues[index] = std::sinh(exponent);
                coshValues[index] = std::cosh(exponent);
            }
        }

        std::array<float, kDiodeCurveLutSize> sinhValues {};
        std::array<float, kDiodeCurveLutSize> coshValues {};
    };

    const DiodeCurveLut& getDiodeCurveLut()
    {
        static const DiodeCurveLut lut;
        return lut;
    }

    float safeFilterMaximum(double sampleRate, float nominalMinimum, float nominalMaximum)
    {
        return juce::jmax(nominalMinimum,
                          juce::jmin(nominalMaximum,
                                     static_cast<float>(sampleRate * 0.475)));
    }

    void prepareRealtimeFilterLut(std::vector<S13IIRCoefficientSet>& lut,
                                  double sampleRate,
                                  float nominalMinimum,
                                  float nominalMaximum,
                                  bool highPass)
    {
        const float safeMinimum = juce::jmax(1.0f, nominalMinimum);
        const float safeMaximum = safeFilterMaximum(sampleRate, safeMinimum, nominalMaximum);
        const double logMinimum = std::log(static_cast<double>(safeMinimum));
        const double logRange = std::log(static_cast<double>(safeMaximum)) - logMinimum;
        lut.resize(kRealtimeFilterLutSize);

        for (size_t index = 0; index < lut.size(); ++index)
        {
            const double proportion = static_cast<double>(index)
                / static_cast<double>(lut.size() - 1);
            const float frequency = static_cast<float>(std::exp(logMinimum + proportion * logRange));
            const auto coefficients = highPass
                ? juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, frequency)
                : juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, frequency);
            const auto& source = coefficients->coefficients;
            jassert(source.size() == lut[index].size());
            for (size_t coefficient = 0; coefficient < lut[index].size(); ++coefficient)
                lut[index][coefficient] = source[static_cast<int>(coefficient)];
        }
    }

    const S13IIRCoefficientSet& lookupRealtimeFilterLut(
        const std::vector<S13IIRCoefficientSet>& lut,
        double sampleRate,
        float frequency,
        float nominalMinimum,
        float nominalMaximum) noexcept
    {
        jassert(! lut.empty());
        const float safeMinimum = juce::jmax(1.0f, nominalMinimum);
        const float safeMaximum = safeFilterMaximum(sampleRate, safeMinimum, nominalMaximum);
        const double logMinimum = std::log(static_cast<double>(safeMinimum));
        const double logRange = std::log(static_cast<double>(safeMaximum)) - logMinimum;
        const double position = logRange > 0.0
            ? (std::log(static_cast<double>(juce::jlimit(safeMinimum, safeMaximum, frequency))) - logMinimum)
                / logRange
            : 0.0;
        const auto index = static_cast<size_t>(juce::jlimit(
            0,
            static_cast<int>(lut.size() - 1),
            static_cast<int>(std::lround(position * static_cast<double>(lut.size() - 1)))));
        return lut[index];
    }

    void writeRealtimeFilterCoefficients(juce::dsp::IIR::Filter<float>& filter,
                                         const S13IIRCoefficientSet& coefficients) noexcept
    {
        jassert(filter.coefficients != nullptr);
        if (filter.coefficients == nullptr)
            return;

        auto& destination = filter.coefficients->coefficients;
        jassert(destination.size() == coefficients.size());
        if (destination.size() != coefficients.size())
            return;

        for (size_t coefficient = 0; coefficient < coefficients.size(); ++coefficient)
            destination.set(static_cast<int>(coefficient), coefficients[coefficient]);
    }

    void writeRealtimeFilterCoefficients(juce::dsp::IIR::Filter<float>& left,
                                         juce::dsp::IIR::Filter<float>& right,
                                         const S13IIRCoefficientSet& coefficients) noexcept
    {
        writeRealtimeFilterCoefficients(left, coefficients);
        if (right.coefficients != left.coefficients)
            writeRealtimeFilterCoefficients(right, coefficients);
    }

    constexpr int kNAMRackGraphicEqBandCount = 9;
    constexpr std::array<float, kNAMRackGraphicEqBandCount> kNAMRackGraphicEqFrequencies {
        65.0f, 125.0f, 250.0f, 500.0f, 1000.0f, 2000.0f, 4000.0f, 8000.0f, 16000.0f
    };

    class ScopedNAMModelReader final
    {
    public:
        explicit ScopedNAMModelReader(std::atomic<std::uint32_t>& readerCount) noexcept
            : readers(readerCount)
        {
            readers.fetch_add(1, std::memory_order_seq_cst);
        }

        ~ScopedNAMModelReader()
        {
            readers.fetch_sub(1, std::memory_order_seq_cst);
        }

    private:
        std::atomic<std::uint32_t>& readers;

        JUCE_DECLARE_NON_COPYABLE(ScopedNAMModelReader)
    };

    void ensureNAMCoreParsersRegistered()
    {
        static std::once_flag once;
        std::call_once(once, []
        {
            auto& registry = nam::ConfigParserRegistry::instance();

            if (! registry.has("Linear"))
                registry.registerParser("Linear", nam::linear::create_config);
            if (! registry.has("LSTM"))
                registry.registerParser("LSTM", nam::lstm::create_config);
            if (! registry.has("ConvNet"))
                registry.registerParser("ConvNet", nam::convnet::create_config);
            if (! registry.has("WaveNet"))
                registry.registerParser("WaveNet", nam::wavenet::create_config);
            if (! registry.has("SlimmableContainer"))
                registry.registerParser("SlimmableContainer", nam::container::create_config);
        });
    }

    float builtinNoise(int age, int note)
    {
        const float x = static_cast<float>(age * 1103515245u + note * 12345u);
        return std::sin(x * 0.0000137f) * std::sin(x * 0.000091f);
    }

    float drumBaseFrequency(int note)
    {
        switch (note)
        {
            case 35:
            case 36: return 52.0f;
            case 37:
            case 38:
            case 40: return 190.0f;
            case 41: return 82.0f;
            case 43: return 98.0f;
            case 45: return 123.0f;
            case 47: return 146.0f;
            case 48: return 164.0f;
            case 50: return 196.0f;
            default: return 440.0f;
        }
    }

    float drumDecaySeconds(int note, float pedalClosed)
    {
        switch (note)
        {
            case 35:
            case 36: return 0.42f;
            case 37:
            case 38:
            case 40: return 0.24f;
            case 42: return 0.045f + pedalClosed * 0.03f;
            case 44: return 0.08f;
            case 46: return 0.18f + (1.0f - pedalClosed) * 0.62f;
            case 49:
            case 52:
            case 55:
            case 57: return 1.55f;
            case 51:
            case 53:
            case 59: return 1.15f;
            default: return note >= 41 && note <= 50 ? 0.42f : 0.28f;
        }
    }

    float drumPanPosition(int note)
    {
        switch (note)
        {
            case 35:
            case 36: return 0.0f;
            case 37:
            case 38:
            case 40: return -0.08f;
            case 41: return 0.34f;
            case 43: return 0.22f;
            case 45: return 0.05f;
            case 47:
            case 48:
            case 50: return -0.22f;
            case 42:
            case 44:
            case 46: return 0.46f;
            case 49:
            case 55:
            case 57: return -0.58f;
            case 51:
            case 52:
            case 53:
            case 59: return 0.54f;
            default: return 0.0f;
        }
    }

    void sanitizeBuiltInBuffer(juce::AudioBuffer<float>& buffer, float limit)
    {
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            auto* samples = buffer.getWritePointer(ch);
            for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            {
                const float value = samples[sample];
                samples[sample] = std::isfinite(value) ? juce::jlimit(-limit, limit, value) : 0.0f;
            }
        }
    }

    void clearNonFiniteSamples(juce::AudioBuffer<float>& buffer) noexcept
    {
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            auto* samples = buffer.getWritePointer(ch);
            for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
                if (! std::isfinite(samples[sample]))
                    samples[sample] = 0.0f;
        }
    }

    struct BuiltInMidiVoiceRef
    {
        size_t channel = 0;
        size_t note = 0;
    };

    constexpr size_t kBuiltInMidiVoiceSlots = 16u * 128u;

    float softLimitInstrumentBus(float value)
    {
        value = juce::jlimit(-4.0f, 4.0f, value);
        return std::tanh(value * 1.05f) * 0.96f;
    }

    float nyquistFade(float frequency, float sampleRate)
    {
        const float fadeStart = sampleRate * 0.38f;
        const float fadeEnd = sampleRate * 0.48f;
        if (frequency <= fadeStart)
            return 1.0f;
        if (frequency >= fadeEnd)
            return 0.0f;

        const float normalized = (frequency - fadeStart) / juce::jmax(1.0f, fadeEnd - fadeStart);
        return 1.0f - normalized;
    }

    void saveParamsToMemory(juce::MemoryBlock& destData,
                           const juce::String& typeName,
                           const std::vector<std::pair<juce::String, float>>& params)
    {
        juce::ValueTree tree(typeName);
        for (const auto& p : params)
            tree.setProperty(p.first, static_cast<double>(p.second), nullptr);

        juce::MemoryOutputStream stream(destData, false);
        tree.writeToStream(stream);
    }

    juce::ValueTree loadParamsFromMemory(const void* data, int sizeInBytes,
                                         const juce::String& typeName)
    {
        juce::MemoryInputStream stream(data, static_cast<size_t>(sizeInBytes), false);
        auto tree = juce::ValueTree::readFromStream(stream);
        if (tree.isValid() && tree.getType() == juce::Identifier(typeName))
            return tree;
        return {};
    }

    void removeJSONPropertyRecursively(juce::var& value, const juce::Identifier& propertyToRemove)
    {
        if (auto* array = value.getArray())
        {
            for (auto& child : *array)
                removeJSONPropertyRecursively(child, propertyToRemove);
            return;
        }

        auto* object = value.getDynamicObject();
        if (object == nullptr)
            return;

        juce::Array<juce::Identifier> propertyNames;
        const auto& properties = object->getProperties();
        propertyNames.ensureStorageAllocated(properties.size());
        for (int index = 0; index < properties.size(); ++index)
            propertyNames.add(properties.getName(index));

        for (const auto& propertyName : propertyNames)
        {
            if (propertyName == propertyToRemove)
            {
                object->removeProperty(propertyName);
                continue;
            }

            auto child = object->getProperty(propertyName);
            removeJSONPropertyRecursively(child, propertyToRemove);
            object->setProperty(propertyName, child);
        }
    }
}

// ============================================================================
//  S13Delay
// ============================================================================

S13Delay::S13Delay(float maximumSupportedDelaySeconds)
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      maximumDelaySeconds(juce::jlimit(0.1f, 30.0f, maximumSupportedDelaySeconds))
{
}

void S13Delay::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    maxDelaySamples = juce::jmax(2, juce::roundToInt(
        maximumDelaySeconds * static_cast<float>(juce::jmax(1.0, sampleRate))) + 4);
    delayLineL.setMaximumDelayInSamples(maxDelaySamples);
    delayLineR.setMaximumDelayInSamples(maxDelaySamples);

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 1;

    delayLineL.prepare(spec);
    delayLineR.prepare(spec);
    delayLineL.reset();
    delayLineR.reset();
    smoothedMix.reset(sampleRate, 0.02);
    const float initialMix =
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed));
    smoothedMix.setCurrentAndTargetValue(initialMix);
    smoothedDryGain.reset(sampleRate, 0.02);
    smoothedDryGain.setCurrentAndTargetValue(1.0f - initialMix);

    // Prepare feedback filters
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackHPF_L.reset();
    feedbackHPF_R.reset();

    lastLPFFreq = juce::jlimit(200.0f, 20000.0f, lpfFreq.load());
    auto lpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastLPFFreq);
    feedbackLPF_L.coefficients = lpfCoeffs;
    feedbackLPF_R.coefficients = lpfCoeffs;
    prepareRealtimeFilterLut(feedbackLPFCoefficientLut, sampleRate, 200.0f, 20000.0f, false);
    writeRealtimeFilterCoefficients(
        feedbackLPF_L,
        feedbackLPF_R,
        lookupRealtimeFilterLut(feedbackLPFCoefficientLut,
                                sampleRate,
                                lastLPFFreq,
                                200.0f,
                                20000.0f));

    lastHPFFreq = juce::jlimit(20.0f, 2000.0f, hpfFreq.load());
    auto hpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastHPFFreq);
    feedbackHPF_L.coefficients = hpfCoeffs;
    feedbackHPF_R.coefficients = hpfCoeffs;
    prepareRealtimeFilterLut(feedbackHPFCoefficientLut, sampleRate, 20.0f, 2000.0f, true);
    writeRealtimeFilterCoefficients(
        feedbackHPF_L,
        feedbackHPF_R,
        lookupRealtimeFilterLut(feedbackHPFCoefficientLut,
                                sampleRate,
                                lastHPFFreq,
                                20.0f,
                                2000.0f));

    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
    smoothedDelaySamplesL = static_cast<float>(0.25 * cachedSampleRate);
    smoothedDelaySamplesR = static_cast<float>(0.25 * cachedSampleRate);
    duckEnvelope = 0.0f;
    modulationPhase = 0.0f;
    validHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    unityDry.store(0.0f, std::memory_order_relaxed);
}

float S13Delay::syncNoteToMs(float noteIndex, double bpm)
{
    bpm = juce::jlimit(10.0, 300.0, bpm > 0.0 ? bpm : 120.0);

    const float quarterMs = static_cast<float>(60000.0 / bpm);

    // Matches the React schema: 1/1, 1/2, 1/4, 1/8, 1/16, 1/4T, 1/8T, 1/4D, 1/8D
    const int idx = juce::jlimit(0, 8, static_cast<int>(noteIndex));

    static const float baseMultipliers[] = {
        4.0f,         // 1/1
        2.0f,         // 1/2
        1.0f,         // 1/4
        0.5f,         // 1/8
        0.25f,        // 1/16
        2.0f / 3.0f,  // 1/4 triplet
        1.0f / 3.0f,  // 1/8 triplet
        1.5f,         // 1/4 dotted
        0.75f         // 1/8 dotted
    };

    return quarterMs * baseMultipliers[idx];
}

void S13Delay::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    // Update LPF if frequency changed
    const float currentLPFFreq = juce::jlimit(200.0f, 20000.0f, lpfFreq.load());
    if (std::abs(currentLPFFreq - lastLPFFreq) > 1.0f)
    {
        lastLPFFreq = currentLPFFreq;
        if (! feedbackLPFCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                feedbackLPF_L,
                feedbackLPF_R,
                lookupRealtimeFilterLut(feedbackLPFCoefficientLut,
                                        cachedSampleRate,
                                        currentLPFFreq,
                                        200.0f,
                                        20000.0f));
    }

    // Update HPF if frequency changed
    const float currentHPFFreq = juce::jlimit(20.0f, 2000.0f, hpfFreq.load());
    if (std::abs(currentHPFFreq - lastHPFFreq) > 1.0f)
    {
        lastHPFFreq = currentHPFFreq;
        if (! feedbackHPFCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                feedbackHPF_L,
                feedbackHPF_R,
                lookupRealtimeFilterLut(feedbackHPFCoefficientLut,
                                        cachedSampleRate,
                                        currentHPFFreq,
                                        20.0f,
                                        2000.0f));
    }

    // Get BPM from playhead for tempo sync
    double bpm = 120.0;
    if (auto* ph = getPlayHead())
    {
        auto pos = ph->getPosition();
        if (pos.hasValue())
        {
            if (auto bpmVal = pos->getBpm())
                bpm = *bpmVal;
        }
    }

    // Compute delay times
    const bool isTempSync = tempoSync.load() >= 0.5f;
    float delayMsL, delayMsR;
    if (isTempSync)
    {
        delayMsL = syncNoteToMs(syncNoteL.load(), bpm);
        delayMsR = syncNoteToMs(syncNoteR.load(), bpm);
    }
    else
    {
        delayMsL = juce::jlimit(1.0f, 2000.0f, delayTimeL.load());
        delayMsR = juce::jlimit(1.0f, 2000.0f, delayTimeR.load());
    }

    const float delaySamplesL = static_cast<float>(delayMsL * 0.001 * cachedSampleRate);
    const float delaySamplesR = static_cast<float>(delayMsR * 0.001 * cachedSampleRate);
    const float fb = juce::jlimit(0.0f, 0.95f, feedback.load());
    const float xfeed = juce::jlimit(0.0f, 0.95f, crossFeed.load());
    const float requestedMix =
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed));
    smoothedMix.setTargetValue(requestedMix);
    const bool isPingPong = pingPong.load() >= 0.5f;
    const float satAmount = juce::jlimit(0.0f, 1.0f, fbSaturation.load());
    const float widthVal = juce::jlimit(0.0f, 2.0f, stereoWidth.load());
    const int modeVal = juce::jlimit(0, 2, static_cast<int>(delayMode.load()));
    const float duckAmount = juce::jlimit(0.0f, 1.0f, ducking.load());
    const float sendGain = juce::jlimit(
        0.0f, 1.0f, inputSend.load(std::memory_order_relaxed));
    const bool preserveUnityDry =
        unityDry.load(std::memory_order_relaxed) >= 0.5f;
    smoothedDryGain.setTargetValue(
        preserveUnityDry ? 1.0f : 1.0f - requestedMix);
    const float delaySmoothingCoeff = 1.0f - std::exp(-1.0f / (0.025f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float duckAttack = 1.0f - std::exp(-1.0f / (0.008f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float duckRelease = 1.0f - std::exp(-1.0f / (0.180f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const float modulationInc = 0.37f * juce::MathConstants<float>::twoPi / static_cast<float>(juce::jmax(1.0, cachedSampleRate));

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const float wet = smoothedMix.getNextValue();
        const float dryGain = smoothedDryGain.getNextValue();
        const float inL = dataL[i];
        const float inR = dataR ? dataR[i] : inL;
        const float sentInL = inL * sendGain;
        const float sentInR = inR * sendGain;
        const float inputLevel =
            juce::jmax(std::abs(sentInL), std::abs(sentInR));
        const float duckCoeff = inputLevel > duckEnvelope ? duckAttack : duckRelease;
        duckEnvelope += (inputLevel - duckEnvelope) * duckCoeff;
        const float duckGain = 1.0f - duckAmount * juce::jlimit(0.0f, 0.82f, duckEnvelope * 1.35f);

        smoothedDelaySamplesL += (delaySamplesL - smoothedDelaySamplesL) * delaySmoothingCoeff;
        smoothedDelaySamplesR += (delaySamplesR - smoothedDelaySamplesR) * delaySmoothingCoeff;
        float modulatedDelayL = smoothedDelaySamplesL;
        float modulatedDelayR = smoothedDelaySamplesR;
        if (modeVal == 1)
        {
            const float wowDepth = static_cast<float>(0.0018 * cachedSampleRate) * (0.25f + satAmount * 0.75f);
            modulatedDelayL += std::sin(modulationPhase) * wowDepth;
            modulatedDelayR += std::sin(modulationPhase + 1.73f) * wowDepth;
            modulationPhase += modulationInc;
            if (modulationPhase >= juce::MathConstants<float>::twoPi)
                modulationPhase -= juce::MathConstants<float>::twoPi;
        }

        // Read from delay lines
        delayLineL.setDelay(juce::jlimit(1.0f, static_cast<float>(maxDelaySamples - 1), modulatedDelayL));
        delayLineR.setDelay(juce::jlimit(1.0f, static_cast<float>(maxDelaySamples - 1), modulatedDelayR));

        const float rawDelayedL = delayLineL.popSample(0);
        const float rawDelayedR = delayLineR.popSample(0);
        const bool leftHistoryValid =
            static_cast<float>(validHistorySamples)
                >= std::ceil(modulatedDelayL) + 1.0f;
        const bool rightHistoryValid =
            static_cast<float>(validHistorySamples)
                >= std::ceil(modulatedDelayR) + 1.0f;
        const float delayedL = leftHistoryValid ? rawDelayedL : 0.0f;
        const float delayedR = rightHistoryValid ? rawDelayedR : 0.0f;

        // Process feedback through filters (LPF + HPF)
        float fbL = feedbackLPF_L.processSample(feedbackSampleL);
        fbL = feedbackHPF_L.processSample(fbL);
        float fbR = feedbackLPF_R.processSample(feedbackSampleR);
        fbR = feedbackHPF_R.processSample(fbR);

        // Apply feedback saturation
        if (satAmount > 0.001f)
        {
            // Blend between clean and saturated feedback
            float satL = std::tanh(fbL * (1.0f + satAmount * 3.0f));
            float satR = std::tanh(fbR * (1.0f + satAmount * 3.0f));
            fbL = fbL * (1.0f - satAmount) + satL * satAmount;
            fbR = fbR * (1.0f - satAmount) + satR * satAmount;
        }

        // Apply delay mode character
        // Mode 0: Digital (clean), Mode 1: Tape (slight wobble + saturation), Mode 2: Analog (warmth)
        if (modeVal == 1) // Tape
        {
            fbL = std::tanh(fbL * 1.1f) * 0.95f;
            fbR = std::tanh(fbR * 1.1f) * 0.95f;
        }
        else if (modeVal == 2) // Analog
        {
            fbL *= 0.97f;
            fbR *= 0.97f;
        }

        // Cross-feed: blend feedback between channels
        const float fbLMixed = fbL * (1.0f - xfeed) + fbR * xfeed;
        const float fbRMixed = fbR * (1.0f - xfeed) + fbL * xfeed;

        // Write to delay lines
        if (isPingPong)
        {
            delayLineL.pushSample(0, sentInL + fbRMixed * fb);
            delayLineR.pushSample(0, sentInR + fbLMixed * fb);
        }
        else
        {
            delayLineL.pushSample(0, sentInL + fbLMixed * fb);
            delayLineR.pushSample(0, sentInR + fbRMixed * fb);
        }
        validHistorySamples =
            juce::jmin(maxDelaySamples, validHistorySamples + 1);

        // Store feedback samples
        feedbackSampleL = delayedL;
        feedbackSampleR = delayedR;

        // Apply stereo width to wet signal
        float wetL = delayedL;
        float wetR = delayedR;
        if (dataR && std::abs(widthVal - 1.0f) > 0.01f)
        {
            const float mid = (wetL + wetR) * 0.5f;
            const float side = (wetL - wetR) * 0.5f;
            wetL = mid + side * widthVal;
            wetR = mid - side * widthVal;
        }

        // Mix dry + wet
        dataL[i] = inL * dryGain + wetL * wet * duckGain;
        if (dataR)
            dataR[i] = inR * dryGain + wetR * wet * duckGain;
    }
    // The feedback path is bounded independently by its <= 0.95 coefficient
    // and optional saturation. Do not hard-clip the mixed output here: at
    // zero wet level this processor must leave an above-unity dry signal
    // sample-transparent for the NAM rack.
    clearNonFiniteSamples(buffer);
}

void S13Delay::resetTailState() noexcept
{
    validHistorySamples = 0;
    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
    duckEnvelope = 0.0f;
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackHPF_L.reset();
    feedbackHPF_R.reset();
    smoothedMix.setCurrentAndTargetValue(0.0f);
    smoothedDryGain.setCurrentAndTargetValue(1.0f);
}

void S13Delay::releaseResources()
{
    delayLineL.reset();
    delayLineR.reset();
    feedbackLPF_L.reset();
    feedbackLPF_R.reset();
    feedbackHPF_L.reset();
    feedbackHPF_R.reset();
    feedbackSampleL = 0.0f;
    feedbackSampleR = 0.0f;
    smoothedDelaySamplesL = static_cast<float>(0.25 * cachedSampleRate);
    smoothedDelaySamplesR = static_cast<float>(0.25 * cachedSampleRate);
    duckEnvelope = 0.0f;
    modulationPhase = 0.0f;
    validHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    unityDry.store(0.0f, std::memory_order_relaxed);
    const float initialMix =
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed));
    smoothedMix.setCurrentAndTargetValue(initialMix);
    smoothedDryGain.setCurrentAndTargetValue(1.0f - initialMix);
}

double S13Delay::getTailLengthSeconds() const
{
    if (mix.load(std::memory_order_relaxed) <= 0.0001f)
        return 0.0;

    double bpm = 120.0;
    if (auto* currentPlayHead = getPlayHead())
    {
        const auto position = currentPlayHead->getPosition();
        if (position.hasValue())
            if (const auto positionBpm = position->getBpm())
                bpm = *positionBpm;
    }

    float maximumDelayMs = 0.0f;
    if (tempoSync.load(std::memory_order_relaxed) >= 0.5f)
    {
        maximumDelayMs = juce::jmax(syncNoteToMs(syncNoteL.load(std::memory_order_relaxed), bpm),
                                    syncNoteToMs(syncNoteR.load(std::memory_order_relaxed), bpm));
    }
    else
    {
        maximumDelayMs = juce::jmax(
            juce::jlimit(1.0f, 2000.0f, delayTimeL.load(std::memory_order_relaxed)),
            juce::jlimit(1.0f, 2000.0f, delayTimeR.load(std::memory_order_relaxed)));
    }

    if (juce::jlimit(0, 2, static_cast<int>(delayMode.load(std::memory_order_relaxed))) == 1)
    {
        const float saturation = juce::jlimit(0.0f, 1.0f, fbSaturation.load(std::memory_order_relaxed));
        maximumDelayMs += 1.8f * (0.25f + saturation * 0.75f);
    }
    maximumDelayMs = juce::jmin(maximumDelaySeconds * 1000.0f, maximumDelayMs);

    const double currentFeedback = juce::jlimit(
        0.0, 0.95, static_cast<double>(feedback.load(std::memory_order_relaxed)));
    const double repeatsToMinus60 = currentFeedback > 0.0001
        ? std::log(0.001) / std::log(currentFeedback)
        : 1.0;
    return static_cast<double>(maximumDelayMs) * 0.001
         * juce::jmax(1.0, repeatsToMinus60);
}

void S13Delay::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Delay", {
        { "delayTimeL",   delayTimeL.load() },
        { "delayTimeR",   delayTimeR.load() },
        { "feedback",     feedback.load() },
        { "crossFeed",    crossFeed.load() },
        { "mix",          mix.load() },
        { "pingPong",     pingPong.load() },
        { "tempoSync",    tempoSync.load() },
        { "syncNoteL",    syncNoteL.load() },
        { "syncNoteR",    syncNoteR.load() },
        { "lpfFreq",      lpfFreq.load() },
        { "hpfFreq",      hpfFreq.load() },
        { "fbSaturation", fbSaturation.load() },
        { "stereoWidth",  stereoWidth.load() },
        { "delayMode",    delayMode.load() },
        { "ducking",      ducking.load() }
    });
}

void S13Delay::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Delay");
    if (!tree.isValid())
        return;

    delayTimeL   = static_cast<float>((double)tree.getProperty("delayTimeL", 250.0));
    delayTimeR   = static_cast<float>((double)tree.getProperty("delayTimeR", 250.0));
    feedback     = static_cast<float>((double)tree.getProperty("feedback", 0.4));
    crossFeed    = static_cast<float>((double)tree.getProperty("crossFeed", 0.0));
    mix          = static_cast<float>((double)tree.getProperty("mix", 0.5));
    pingPong     = static_cast<float>((double)tree.getProperty("pingPong", 0.0));
    tempoSync    = static_cast<float>((double)tree.getProperty("tempoSync", 0.0));
    syncNoteL    = static_cast<float>((double)tree.getProperty("syncNoteL", 0.0));
    syncNoteR    = static_cast<float>((double)tree.getProperty("syncNoteR", 0.0));
    lpfFreq      = static_cast<float>((double)tree.getProperty("lpfFreq", 20000.0));
    hpfFreq      = static_cast<float>((double)tree.getProperty("hpfFreq", 20.0));
    fbSaturation = static_cast<float>((double)tree.getProperty("fbSaturation", 0.0));
    stereoWidth  = static_cast<float>((double)tree.getProperty("stereoWidth", 1.0));
    delayMode    = static_cast<float>((double)tree.getProperty("delayMode", 0.0));
    ducking      = static_cast<float>((double)tree.getProperty("ducking", 0.0));
}

bool S13Delay::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13OctaveShimmerShifter
// ============================================================================

void S13OctaveShimmerShifter::prepare(double sampleRate)
{
    const float safeSampleRate =
        static_cast<float>(juce::jmax(1.0, sampleRate));
    grainWindowSamples = juce::jmax(
        64,
        juce::roundToInt(safeSampleRate * 0.075f));
    minimumDelaySamples = juce::jmax(
        8.0f, safeSampleRate * 0.0015f);
    const int requiredBufferSamples =
        grainWindowSamples
        + static_cast<int>(
            std::ceil(minimumDelaySamples))
        + 8;
    delayBuffer.assign(
        static_cast<size_t>(requiredBufferSamples),
        0.0f);
    grainPhaseIncrement =
        1.0f / static_cast<float>(grainWindowSamples);
    highPassCoefficient =
        1.0f
        - std::exp(
            -juce::MathConstants<float>::twoPi
            * 180.0f / safeSampleRate);
    lowPassCoefficient =
        1.0f
        - std::exp(
            -juce::MathConstants<float>::twoPi
            * 8200.0f / safeSampleRate);
    juce::ignoreUnused(getModulationSineLut());
    reset();
}

void S13OctaveShimmerShifter::reset() noexcept
{
    writeIndex = 0;
    validHistorySamples = 0;
    grainPhase = 0.0f;
    highPassState = 0.0f;
    lowPassState = 0.0f;
}

float S13OctaveShimmerShifter::readFractionalDelay(
    float delaySamples) const noexcept
{
    const int ringSize =
        static_cast<int>(delayBuffer.size());
    if (ringSize <= 4
        || static_cast<float>(validHistorySamples)
            < std::ceil(delaySamples) + 2.0f)
        return 0.0f;

    float readPosition =
        static_cast<float>(writeIndex)
        - delaySamples;
    while (readPosition < 0.0f)
        readPosition += static_cast<float>(ringSize);
    while (readPosition
           >= static_cast<float>(ringSize))
        readPosition -= static_cast<float>(ringSize);

    const int index0 =
        static_cast<int>(readPosition);
    const float fraction =
        readPosition - static_cast<float>(index0);
    const int previousIndex =
        index0 > 0 ? index0 - 1 : ringSize - 1;
    const int nextIndex =
        index0 + 1 < ringSize ? index0 + 1 : 0;
    const int nextNextIndex =
        nextIndex + 1 < ringSize
            ? nextIndex + 1
            : 0;
    const float previous =
        delayBuffer[static_cast<size_t>(
            previousIndex)];
    const float current =
        delayBuffer[static_cast<size_t>(index0)];
    const float next =
        delayBuffer[static_cast<size_t>(nextIndex)];
    const float nextNext =
        delayBuffer[static_cast<size_t>(
            nextNextIndex)];

    const float coefficient0 =
        -0.5f * previous
        + 1.5f * current
        - 1.5f * next
        + 0.5f * nextNext;
    const float coefficient1 =
        previous
        - 2.5f * current
        + 2.0f * next
        - 0.5f * nextNext;
    const float coefficient2 =
        -0.5f * previous + 0.5f * next;
    return ((coefficient0 * fraction
             + coefficient1)
                * fraction
            + coefficient2)
                * fraction
        + current;
}

float S13OctaveShimmerShifter::processSample(
    float input) noexcept
{
    const int ringSize =
        static_cast<int>(delayBuffer.size());
    if (ringSize <= 4)
        return 0.0f;

    delayBuffer[static_cast<size_t>(writeIndex)] =
        std::isfinite(input) ? input : 0.0f;

    const float secondPhase =
        grainPhase < 0.5f
            ? grainPhase + 0.5f
            : grainPhase - 0.5f;
    const float firstDelay =
        minimumDelaySamples
        + (1.0f - grainPhase)
            * static_cast<float>(
                grainWindowSamples);
    const float secondDelay =
        minimumDelaySamples
        + (1.0f - secondPhase)
            * static_cast<float>(
                grainWindowSamples);
    const float firstWeight =
        0.5f
        - 0.5f * lookupModulationSine(
            grainPhase
                * juce::MathConstants<float>::twoPi
            + juce::MathConstants<float>::halfPi);
    const float shifted =
        readFractionalDelay(firstDelay)
            * firstWeight
        + readFractionalDelay(secondDelay)
            * (1.0f - firstWeight);

    highPassState +=
        (shifted - highPassState)
        * highPassCoefficient;
    const float highPassed =
        shifted - highPassState;
    lowPassState +=
        (highPassed - lowPassState)
        * lowPassCoefficient;

    ++writeIndex;
    if (writeIndex >= ringSize)
        writeIndex = 0;
    validHistorySamples = juce::jmin(
        ringSize, validHistorySamples + 1);
    grainPhase += grainPhaseIncrement;
    if (grainPhase >= 1.0f)
        grainPhase -= 1.0f;

    return std::isfinite(lowPassState)
        ? lowPassState
        : 0.0f;
}


// ============================================================================
//  S13Reverb
// ============================================================================

S13Reverb::S13Reverb()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13Reverb::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;

    reverb.prepare(spec);
    reverb.reset();
    smoothedWetLevel.reset(sampleRate, 0.02);
    smoothedDryLevel.reset(sampleRate, 0.02);
    smoothedEarlyLevel.reset(sampleRate, 0.02);
    smoothedShimmerAmount.reset(sampleRate, 0.04);
    smoothedWetLevel.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, wetLevel.load()));
    smoothedDryLevel.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, dryLevel.load()));
    smoothedEarlyLevel.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, earlyLevel.load()));
    smoothedShimmerAmount.setCurrentAndTargetValue(
        juce::jlimit(
            0.0f, 1.0f,
            shimmerAmount.load(
                std::memory_order_relaxed)));
    shimmerShifter.prepare(sampleRate);

    // Prepare pre-delay lines
    juce::dsp::ProcessSpec monoSpec;
    monoSpec.sampleRate = sampleRate;
    monoSpec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    monoSpec.numChannels = 1;

    const int maximumPreDelaySamples = juce::jmax(
        2, static_cast<int>(std::ceil(juce::jmax(1.0, sampleRate) * 0.5)) + 2);
    preDelayLineL.setMaximumDelayInSamples(maximumPreDelaySamples);
    preDelayLineR.setMaximumDelayInSamples(maximumPreDelaySamples);
    preDelayLineL.prepare(monoSpec);
    preDelayLineR.prepare(monoSpec);
    preDelayLineL.reset();
    preDelayLineR.reset();

    // Prepare wet tone filters
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();

    auto lcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, 20.0f);
    wetLowCutL.coefficients = lcCoeffs;
    wetLowCutR.coefficients = lcCoeffs;
    prepareRealtimeFilterLut(lowCutCoefficientLut, sampleRate, 20.0f, 500.0f, true);

    auto hcCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, 20000.0f);
    wetHighCutL.coefficients = hcCoeffs;
    wetHighCutR.coefficients = hcCoeffs;
    prepareRealtimeFilterLut(highCutCoefficientLut, sampleRate, 1000.0f, 20000.0f, false);
    lastLowCut = 20.0f;
    lastHighCut = 20000.0f;
    writeRealtimeFilterCoefficients(
        wetLowCutL,
        wetLowCutR,
        lookupRealtimeFilterLut(lowCutCoefficientLut, sampleRate, lastLowCut, 20.0f, 500.0f));
    writeRealtimeFilterCoefficients(
        wetHighCutL,
        wetHighCutR,
        lookupRealtimeFilterLut(highCutCoefficientLut, sampleRate, lastHighCut, 1000.0f, 20000.0f));

    const int scratchChannels = juce::jmax(2, getTotalNumOutputChannels());
    const int scratchSamples = juce::jmax(samplesPerBlock, 16384);
    dryBuffer.setSize(scratchChannels, scratchSamples, false, false, true);
    earlyOutputBuffer.setSize(scratchChannels, scratchSamples, false, false, true);
    earlyReflectionBuffer.setSize(2, juce::jmax(samplesPerBlock + 8, static_cast<int>(std::ceil(sampleRate * 0.12))), false, false, true);
    earlyReflectionBuffer.clear();
    earlyReflectionWriteIndex = 0;
    lateTankBuffer.setSize(lateLineCount, juce::jmax(samplesPerBlock + 8, static_cast<int>(std::ceil(sampleRate * 2.5))), false, false, true);
    lateTankBuffer.clear();
    lateTankWriteIndex = 0;
    lateDampingState.fill(0.0f);
    validEarlyHistorySamples = 0;
    validPreDelayHistorySamples = 0;
    validLateHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    for (size_t line = 0; line < lateModPhase.size(); ++line)
        lateModPhase[line] = static_cast<float>(line) * 0.77f;
}

void S13Reverb::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const float preDelayMs = juce::jlimit(0.0f, 500.0f, preDelay.load());
    const float preDelaySamples = static_cast<float>(preDelayMs * 0.001 * cachedSampleRate);
    const float lc = juce::jlimit(20.0f, 500.0f, lowCut.load());
    const float hc = juce::jlimit(1000.0f, 20000.0f, highCut.load());
    const float wetLvl = juce::jlimit(0.0f, 1.0f, wetLevel.load());
    const float dryLvl = juce::jlimit(0.0f, 1.0f, dryLevel.load());
    const float earlyLvl = juce::jlimit(0.0f, 1.0f, earlyLevel.load());
    const float shimmerTarget = juce::jlimit(
        0.0f,
        1.0f,
        shimmerAmount.load(std::memory_order_relaxed));
    const float sendGain = juce::jlimit(
        0.0f, 1.0f, inputSend.load(std::memory_order_relaxed));
    smoothedWetLevel.setTargetValue(wetLvl);
    smoothedDryLevel.setTargetValue(dryLvl);
    smoothedEarlyLevel.setTargetValue(earlyLvl);
    smoothedShimmerAmount.setTargetValue(shimmerTarget);
    const bool processShimmer =
        shimmerTarget > 0.0001f
        || smoothedShimmerAmount.getCurrentValue()
            > 0.0001f
        || smoothedShimmerAmount.isSmoothing();

    // Update tone filters only when needed.
    if (std::abs(lc - lastLowCut) > 1.0f)
    {
        lastLowCut = lc;
        if (! lowCutCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                wetLowCutL,
                wetLowCutR,
                lookupRealtimeFilterLut(lowCutCoefficientLut,
                                        cachedSampleRate,
                                        lc,
                                        20.0f,
                                        500.0f));
    }

    if (std::abs(hc - lastHighCut) > 8.0f)
    {
        lastHighCut = hc;
        if (! highCutCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                wetHighCutL,
                wetHighCutR,
                lookupRealtimeFilterLut(highCutCoefficientLut,
                                        cachedSampleRate,
                                        hc,
                                        1000.0f,
                                        20000.0f));
    }

    // Get algorithm index for parameter adjustments
    const int algo = juce::jlimit(0, 3, static_cast<int>(algorithm.load()));

    // Map algorithm to reverb parameter adjustments
    float roomSizeAdj = juce::jlimit(0.0f, 1.0f, roomSize.load());
    float dampingAdj = juce::jlimit(0.0f, 1.0f, damping.load());
    float widthAdj = juce::jlimit(0.0f, 1.0f, width.load());

    switch (static_cast<Algorithm>(algo))
    {
        case Algorithm::Room:
            // Tight room: reduce room size range, increase damping
            roomSizeAdj *= 0.6f;
            dampingAdj = juce::jlimit(0.0f, 1.0f, dampingAdj + 0.2f);
            break;
        case Algorithm::Hall:
            // Large hall: extend room size, reduce damping
            roomSizeAdj = juce::jlimit(0.0f, 1.0f, roomSizeAdj * 0.5f + 0.5f);
            dampingAdj *= 0.7f;
            break;
        case Algorithm::Plate:
            // Plate: dense, bright
            dampingAdj *= 0.5f;
            widthAdj = juce::jlimit(0.0f, 1.0f, widthAdj * 1.2f);
            break;
        case Algorithm::Chamber:
            // Chamber: balanced
            roomSizeAdj *= 0.8f;
            break;
    }

    // Store dry signal in buffers allocated during prepareToPlay; never resize in the audio callback.
    if (dryBuffer.getNumChannels() < numChannels
        || dryBuffer.getNumSamples() < numSamples
        || earlyOutputBuffer.getNumChannels() < numChannels
        || earlyOutputBuffer.getNumSamples() < numSamples)
    {
        buffer.clear();
        return;
    }
    for (int ch = 0; ch < numChannels; ++ch)
        dryBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    earlyOutputBuffer.clear(0, numSamples);

    if (earlyReflectionBuffer.getNumSamples() > 0)
    {
        const int ringSize = earlyReflectionBuffer.getNumSamples();
        const float diffusionValue = juce::jlimit(0.0f, 1.0f, diffusion.load());
        const float tapScale = 0.18f + diffusionValue * 0.22f;
        const std::array<float, 5> tapMs {
            algo == static_cast<int>(Algorithm::Room) ? 5.7f : 9.3f,
            algo == static_cast<int>(Algorithm::Plate) ? 12.1f : 17.9f,
            algo == static_cast<int>(Algorithm::Chamber) ? 23.7f : 29.1f,
            algo == static_cast<int>(Algorithm::Hall) ? 43.0f : 37.0f,
            53.0f
        };
        const std::array<float, 5> tapGain { 0.72f, -0.48f, 0.36f, -0.27f, 0.19f };
        std::array<int, 5> tapOffsetSamples {};
        std::array<float, 5> scaledTapGains {};
        for (size_t tap = 0;
             tap < tapMs.size();
             ++tap)
        {
            tapOffsetSamples[tap] = juce::jlimit(
                1,
                ringSize - 1,
                juce::roundToInt(
                    tapMs[tap] * 0.001f
                    * static_cast<float>(
                        cachedSampleRate)));
            scaledTapGains[tap] =
                tapGain[tap] * tapScale;
        }

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dryBuffer.getSample(0, i) * sendGain;
            const float inR = (numChannels >= 2
                ? dryBuffer.getSample(1, i)
                : dryBuffer.getSample(0, i)) * sendGain;
            earlyReflectionBuffer.setSample(0, earlyReflectionWriteIndex, inL);
            earlyReflectionBuffer.setSample(1, earlyReflectionWriteIndex, inR);

            float earlyL = 0.0f;
            float earlyR = 0.0f;
            for (size_t tap = 0; tap < tapMs.size(); ++tap)
            {
                const int offset =
                    tapOffsetSamples[tap];
                int readIndex = earlyReflectionWriteIndex - offset;
                if (readIndex < 0)
                    readIndex += ringSize;

                if (offset <= validEarlyHistorySamples)
                {
                    const float gain =
                        scaledTapGains[tap];
                    earlyL += earlyReflectionBuffer.getSample(0, readIndex) * gain;
                    earlyR += earlyReflectionBuffer.getSample(1, readIndex)
                        * gain * (tap % 2 == 0 ? -0.82f : 0.92f);
                }
            }

            earlyOutputBuffer.setSample(0, i, earlyL);
            if (numChannels >= 2)
                earlyOutputBuffer.setSample(1, i, earlyR);
            earlyReflectionWriteIndex = (earlyReflectionWriteIndex + 1) % ringSize;
            validEarlyHistorySamples =
                juce::jmin(ringSize, validEarlyHistorySamples + 1);
        }
    }

    // Always advance the pre-delay write heads. During rack bypass the send is
    // zero, so only already-recorded audio can emerge from this point onward.
    const float effectivePreDelaySamples = juce::jmax(1.0f, preDelaySamples);
    preDelayLineL.setDelay(effectivePreDelaySamples);
    preDelayLineR.setDelay(effectivePreDelaySamples);
    auto* pL = buffer.getWritePointer(0);
    auto* pR = numChannels >= 2 ? buffer.getWritePointer(1) : nullptr;
    for (int i = 0; i < numSamples; ++i)
    {
        const float sentL = dryBuffer.getSample(0, i) * sendGain;
        const float sentR = (pR != nullptr
            ? dryBuffer.getSample(1, i)
            : dryBuffer.getSample(0, i)) * sendGain;
        preDelayLineL.pushSample(0, sentL);
        preDelayLineR.pushSample(0, sentR);
        const float delayedL = preDelayLineL.popSample(0);
        const float delayedR = preDelayLineR.popSample(0);
        const bool historyValid =
            static_cast<float>(validPreDelayHistorySamples)
                >= std::ceil(effectivePreDelaySamples);

        pL[i] = preDelaySamples > 0.5f
            ? (historyValid ? delayedL : 0.0f)
            : sentL;
        if (pR != nullptr)
            pR[i] = preDelaySamples > 0.5f
                ? (historyValid ? delayedR : 0.0f)
                : sentR;
        validPreDelayHistorySamples =
            juce::jmin(
                juce::roundToInt(static_cast<float>(cachedSampleRate) * 0.5f) + 2,
                validPreDelayHistorySamples + 1);
    }

    // Native late tail: 8-line feedback delay network with algorithm-specific
    // delay spacing and a Householder feedback matrix for dense, stable tails.
    if (lateTankBuffer.getNumSamples() > 0)
    {
        const int ringSize = lateTankBuffer.getNumSamples();
        const bool freeze = freezeMode.load(std::memory_order_relaxed) >= 0.5f;
        const float diffusionValue = juce::jlimit(0.0f, 1.0f, diffusion.load(std::memory_order_relaxed));
        const float decaySeconds = juce::jlimit(0.1f, 20.0f, decayTime.load(std::memory_order_relaxed));
        const float roomScale = 0.72f + roomSizeAdj * 1.35f;
        const float dampCoeff = juce::jlimit(0.012f, 0.42f, 0.36f - dampingAdj * 0.30f);
        const float inputGain = juce::jlimit(0.06f, 0.42f, 0.16f + diffusionValue * 0.18f);
        const float modDepthSamples = (static_cast<Algorithm>(algo) == Algorithm::Plate ? 1.8f : 4.5f) * (0.2f + diffusionValue * 0.8f);
        const float modRate = (static_cast<Algorithm>(algo) == Algorithm::Plate ? 0.19f : 0.11f)
                            * juce::MathConstants<float>::twoPi / static_cast<float>(juce::jmax(1.0, cachedSampleRate));
        const std::array<float, lateLineCount> baseDelayMs {
            29.7f, 37.1f, 41.9f, 53.3f, 61.7f, 71.9f, 83.9f, 97.1f
        };
        const float algorithmScale = static_cast<Algorithm>(algo) == Algorithm::Room ? 0.58f
                                   : static_cast<Algorithm>(algo) == Algorithm::Hall ? 1.35f
                                   : static_cast<Algorithm>(algo) == Algorithm::Plate ? 0.82f
                                   : 0.74f;
        std::array<float, lateLineCount>
            lineDelaySamples {};
        std::array<float, lateLineCount>
            lineFeedback {};
        for (int line = 0;
             line < lateLineCount;
             ++line)
        {
            const float lineDelaySeconds =
                baseDelayMs[static_cast<size_t>(line)]
                * 0.001f * algorithmScale * roomScale;
            lineDelaySamples[
                static_cast<size_t>(line)] =
                lineDelaySeconds
                * static_cast<float>(cachedSampleRate);
            lineFeedback[static_cast<size_t>(line)] =
                freeze
                    ? 0.997f
                    : juce::jlimit(
                          0.001f,
                          0.995f,
                          std::exp(
                              std::log(0.001f)
                              * lineDelaySeconds
                              / decaySeconds));
        }

        auto readLateLine = [&] (int line, float delaySamplesToRead) -> float
        {
            delaySamplesToRead = juce::jlimit(1.0f, static_cast<float>(ringSize - 2), delaySamplesToRead);
            if (static_cast<float>(validLateHistorySamples)
                < std::ceil(delaySamplesToRead))
                return 0.0f;
            float readPosition = static_cast<float>(lateTankWriteIndex) - delaySamplesToRead;
            while (readPosition < 0.0f)
                readPosition += static_cast<float>(ringSize);
            const int indexA = static_cast<int>(readPosition) % ringSize;
            const int indexB = (indexA + 1) % ringSize;
            const float frac = readPosition - std::floor(readPosition);
            const float a = lateTankBuffer.getSample(line, indexA);
            const float b = lateTankBuffer.getSample(line, indexB);
            return a + (b - a) * frac;
        };

        auto* outL = buffer.getWritePointer(0);
        auto* outR = numChannels >= 2 ? buffer.getWritePointer(1) : nullptr;
        for (int sample = 0; sample < numSamples; ++sample)
        {
            std::array<float, lateLineCount> tankRead {};
            float readSum = 0.0f;
            for (int line = 0; line < lateLineCount; ++line)
            {
                const float modulatedSamples =
                    lookupModulationSine(
                        lateModPhase[
                            static_cast<size_t>(line)])
                    * modDepthSamples;
                const float delaySamplesToRead =
                    lineDelaySamples[
                        static_cast<size_t>(line)]
                    + modulatedSamples;
                float read = readLateLine(line, delaySamplesToRead);
                lateDampingState[static_cast<size_t>(line)] += (read - lateDampingState[static_cast<size_t>(line)]) * dampCoeff;
                read = lateDampingState[static_cast<size_t>(line)];
                tankRead[static_cast<size_t>(line)] = read;
                readSum += read;

                lateModPhase[static_cast<size_t>(line)] += modRate * (1.0f + static_cast<float>(line) * 0.07f);
                if (lateModPhase[static_cast<size_t>(line)] >= juce::MathConstants<float>::twoPi)
                    lateModPhase[static_cast<size_t>(line)] -= juce::MathConstants<float>::twoPi;
            }

            const float inL = buffer.getSample(0, sample);
            const float inR = numChannels >= 2 ? buffer.getSample(1, sample) : inL;
            const float inputMid =
                (inL + inR) * 0.5f;
            const float inputSide =
                (inL - inR) * 0.5f;

            const float rawLateL =
                tankRead[0] - tankRead[2] + tankRead[4] - tankRead[6]
                + (tankRead[1] - tankRead[5]) * 0.55f;
            const float rawLateR =
                tankRead[1] - tankRead[3] + tankRead[5] - tankRead[7]
                + (tankRead[0] - tankRead[4]) * 0.55f;
            float lateL = rawLateL * 0.22f;
            float lateR = rawLateR * 0.22f;

            const float currentShimmerAmount =
                processShimmer
                    ? smoothedShimmerAmount.getNextValue()
                    : 0.0f;
            // Classic shimmer topology: pitch-shift the reverberated field and
            // regenerate it inside the FDN. Use the unattenuated tank taps here;
            // the previous implementation shifted the -13 dB output return and
            // then applied another -12 dB, making the octave almost inaudible.
            const float shiftedShimmer =
                processShimmer
                    ? shimmerShifter.processSample(
                          (rawLateL + rawLateR)
                              * 0.125f)
                    : 0.0f;
            const float shimmerFeedback =
                shiftedShimmer
                * (0.08f
                   + 0.52f * currentShimmerAmount)
                * currentShimmerAmount;
            const float baseFeedbackScale =
                1.0f
                - 0.22f * currentShimmerAmount;
            constexpr std::array<float, lateLineCount>
                sideInjectionSigns {
                    1.0f, 1.0f, -1.0f, -1.0f,
                    -1.0f, -1.0f, 1.0f, 1.0f
                };
            constexpr std::array<float, lateLineCount>
                shimmerInjectionSigns {
                    1.0f, -1.0f, -1.0f, 1.0f,
                    -1.0f, 1.0f, 1.0f, -1.0f
                };

            for (int line = 0; line < lateLineCount; ++line)
            {
                const float householder = (readSum * (2.0f / static_cast<float>(lateLineCount))) - tankRead[static_cast<size_t>(line)];
                const float lineSign = (line & 1) == 0 ? 1.0f : -1.0f;
                const float stereoInjection =
                    inputMid * lineSign
                    + inputSide
                        * sideInjectionSigns[
                            static_cast<size_t>(line)];
                const float write =
                    stereoInjection * inputGain
                    + householder
                        * lineFeedback[
                            static_cast<size_t>(line)]
                        * baseFeedbackScale
                    + shimmerFeedback
                        * shimmerInjectionSigns[
                            static_cast<size_t>(line)];
                lateTankBuffer.setSample(line, lateTankWriteIndex, juce::jlimit(-1.8f, 1.8f, write));
            }

            const float shimmerReturn =
                shiftedShimmer
                * currentShimmerAmount
                * 0.68f;
            lateL += shimmerReturn;
            lateR -= shimmerReturn * 0.72f;
            const float mid = (lateL + lateR) * 0.5f;
            const float side = (lateL - lateR) * 0.5f * (0.35f + widthAdj * 1.35f);
            outL[sample] = mid + side;
            if (outR != nullptr)
                outR[sample] = mid - side;
            else
                outL[sample] = mid;

            lateTankWriteIndex = (lateTankWriteIndex + 1) % ringSize;
            validLateHistorySamples =
                juce::jmin(ringSize, validLateHistorySamples + 1);
        }
    }

    // Apply tone filters to wet signal
    {
        auto* wL = buffer.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            wL[i] = wetLowCutL.processSample(wL[i]);
            wL[i] = wetHighCutL.processSample(wL[i]);
        }
    }
    if (numChannels >= 2)
    {
        auto* wR = buffer.getWritePointer(1);
        for (int i = 0; i < numSamples; ++i)
        {
            wR[i] = wetLowCutR.processSample(wR[i]);
            wR[i] = wetHighCutR.processSample(wR[i]);
        }
    }

    const float lateLevelScale = 0.72f
        + juce::jlimit(0.0f, 1.0f, diffusion.load()) * 0.48f;
    const float wetStart = smoothedWetLevel.getCurrentValue();
    const float dryStart = smoothedDryLevel.getCurrentValue();
    const float earlyStart = smoothedEarlyLevel.getCurrentValue();
    const float wetEnd = smoothedWetLevel.skip(numSamples);
    const float dryEnd = smoothedDryLevel.skip(numSamples);
    const float earlyEnd = smoothedEarlyLevel.skip(numSamples);
    const float interpolationScale = 1.0f / static_cast<float>(juce::jmax(1, numSamples));

    // Mix: dry + late tail + independent early reflection taps.
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* out = buffer.getWritePointer(ch);
        const auto* dryData = dryBuffer.getReadPointer(ch);
        const auto* earlyData = earlyOutputBuffer.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            const float amount = static_cast<float>(i + 1) * interpolationScale;
            const float smoothedDry = dryStart + (dryEnd - dryStart) * amount;
            const float smoothedWet = wetStart + (wetEnd - wetStart) * amount;
            const float smoothedEarly = earlyStart + (earlyEnd - earlyStart) * amount;
            out[i] = dryData[i] * smoothedDry
                   + out[i] * smoothedWet * lateLevelScale
                   + earlyData[i] * smoothedEarly;
        }
    }
    if (! processShimmer)
        shimmerShifter.reset();
    // The FDN writes are bounded at the feedback-tank boundary above. Keep
    // non-finite protection at the processor output without limiting the dry
    // path when the rack advances a zero-wet tail for spillover.
    clearNonFiniteSamples(buffer);
}

void S13Reverb::resetTailState() noexcept
{
    validEarlyHistorySamples = 0;
    validPreDelayHistorySamples = 0;
    validLateHistorySamples = 0;
    lateDampingState.fill(0.0f);
    shimmerShifter.reset();
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    smoothedWetLevel.setCurrentAndTargetValue(0.0f);
    smoothedEarlyLevel.setCurrentAndTargetValue(0.0f);
    smoothedShimmerAmount.setCurrentAndTargetValue(0.0f);
    smoothedDryLevel.setCurrentAndTargetValue(
        juce::jlimit(0.0f, 1.0f, dryLevel.load(std::memory_order_relaxed)));
}

void S13Reverb::releaseResources()
{
    reverb.reset();
    preDelayLineL.reset();
    preDelayLineR.reset();
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    earlyReflectionBuffer.clear();
    earlyOutputBuffer.clear();
    earlyReflectionWriteIndex = 0;
    lateTankBuffer.clear();
    lateTankWriteIndex = 0;
    lateDampingState.fill(0.0f);
    shimmerShifter.reset();
    validEarlyHistorySamples = 0;
    validPreDelayHistorySamples = 0;
    validLateHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    smoothedShimmerAmount.setCurrentAndTargetValue(
        juce::jlimit(
            0.0f,
            1.0f,
            shimmerAmount.load(
                std::memory_order_relaxed)));
}

double S13Reverb::calculateTailLengthSeconds(int algorithmIndex,
                                             float roomSizeValue,
                                             float wetLevelValue,
                                             float earlyLevelValue,
                                             bool freezeEnabled,
                                             float preDelayMs,
                                             float decaySeconds,
                                             double sampleRate)
{
    const bool hasLateTail = wetLevelValue > 0.0001f;
    const bool hasEarlyTail = earlyLevelValue > 0.0001f;
    if (! hasLateTail && ! hasEarlyTail)
        return 0.0;

    const int algo = juce::jlimit(0, 3, algorithmIndex);
    const auto selectedAlgorithm = static_cast<Algorithm>(algo);
    float adjustedRoomSize = juce::jlimit(0.0f, 1.0f, roomSizeValue);
    switch (selectedAlgorithm)
    {
        case Algorithm::Room:
            adjustedRoomSize *= 0.6f;
            break;
        case Algorithm::Hall:
            adjustedRoomSize = juce::jlimit(0.0f, 1.0f, adjustedRoomSize * 0.5f + 0.5f);
            break;
        case Algorithm::Plate:
            break;
        case Algorithm::Chamber:
            adjustedRoomSize *= 0.8f;
            break;
    }

    // The longest early-reflection tap is 53 ms and is sourced before the
    // late-tail pre-delay.
    double tailSeconds = hasEarlyTail ? 0.053 : 0.0;
    if (! hasLateTail)
        return tailSeconds;

    const double roomScale = 0.72 + static_cast<double>(adjustedRoomSize) * 1.35;
    const double algorithmScale = selectedAlgorithm == Algorithm::Room ? 0.58
                                : selectedAlgorithm == Algorithm::Hall ? 1.35
                                : selectedAlgorithm == Algorithm::Plate ? 0.82
                                : 0.74;
    const double safeDecaySeconds = juce::jlimit(0.1, 20.0,
                                                  static_cast<double>(decaySeconds));
    constexpr double meanBaseDelaySeconds = 0.059575;
    const double meanLineDelaySeconds =
        meanBaseDelaySeconds * algorithmScale * roomScale;
    const double feedback = freezeEnabled
        ? 0.997
        : juce::jlimit(
              0.001,
              0.995,
              std::exp(
                  std::log(0.001) * meanLineDelaySeconds
                  / safeDecaySeconds));
    const double repeatsToMinus60 = feedback > 0.0001
        ? std::log(0.001) / std::log(feedback)
        : 1.0;
    const double safeSampleRate = juce::jmax(1.0, sampleRate);
    const double modulationSamples = selectedAlgorithm == Algorithm::Plate ? 1.8 : 4.5;
    const double longestLineSeconds = 0.0971 * algorithmScale * roomScale
                                    + modulationSamples / safeSampleRate;

    // The longest FDN line is conservative for the unitary feedback matrix.
    constexpr double couplingAllowance = 1.15;
    const double lateTailSeconds = juce::jlimit(0.0, 0.5,
                                                static_cast<double>(preDelayMs) * 0.001)
                                 + longestLineSeconds
                                     * juce::jmax(1.0, repeatsToMinus60)
                                     * couplingAllowance;
    return juce::jmax(tailSeconds, lateTailSeconds);
}

double S13Reverb::getTailLengthSeconds() const
{
    return calculateTailLengthSeconds(
        static_cast<int>(std::round(algorithm.load(std::memory_order_relaxed))),
        roomSize.load(std::memory_order_relaxed),
        wetLevel.load(std::memory_order_relaxed),
        earlyLevel.load(std::memory_order_relaxed),
        freezeMode.load(std::memory_order_relaxed) >= 0.5f,
        preDelay.load(std::memory_order_relaxed),
        decayTime.load(std::memory_order_relaxed),
        cachedSampleRate);
}

void S13Reverb::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Reverb", {
        { "algorithm",  algorithm.load() },
        { "roomSize",   roomSize.load() },
        { "damping",    damping.load() },
        { "wetLevel",   wetLevel.load() },
        { "dryLevel",   dryLevel.load() },
        { "width",      width.load() },
        { "freezeMode", freezeMode.load() },
        { "preDelay",   preDelay.load() },
        { "diffusion",  diffusion.load() },
        { "lowCut",     lowCut.load() },
        { "highCut",    highCut.load() },
        { "earlyLevel", earlyLevel.load() },
        { "decayTime",  decayTime.load() },
        { "shimmerAmount", shimmerAmount.load() }
    });
}

void S13Reverb::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Reverb");
    if (!tree.isValid())
        return;

    algorithm  = juce::jlimit(
        0.0f,
        3.0f,
        static_cast<float>((double)tree.getProperty("algorithm", 0.0)));
    roomSize   = static_cast<float>((double)tree.getProperty("roomSize", 0.5));
    damping    = static_cast<float>((double)tree.getProperty("damping", 0.5));
    wetLevel   = static_cast<float>((double)tree.getProperty("wetLevel", 0.33));
    dryLevel   = static_cast<float>((double)tree.getProperty("dryLevel", 0.7));
    width      = static_cast<float>((double)tree.getProperty("width", 1.0));
    freezeMode = static_cast<float>((double)tree.getProperty("freezeMode", 0.0));
    preDelay   = static_cast<float>((double)tree.getProperty("preDelay", 0.0));
    diffusion  = static_cast<float>((double)tree.getProperty("diffusion", 0.5));
    lowCut     = static_cast<float>((double)tree.getProperty("lowCut", 20.0));
    highCut    = static_cast<float>((double)tree.getProperty("highCut", 20000.0));
    earlyLevel = static_cast<float>((double)tree.getProperty("earlyLevel", 0.5));
    decayTime  = static_cast<float>((double)tree.getProperty("decayTime", 2.0));
    shimmerAmount = juce::jlimit(
        0.0f,
        1.0f,
        static_cast<float>(
            static_cast<double>(
                tree.getProperty("shimmerAmount", 0.0))));
}

bool S13Reverb::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13Chorus
// ============================================================================

S13Chorus::S13Chorus()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    for (int v = 0; v < maxVoices; ++v)
    {
        lfoPhase[v] = static_cast<float>(v) * juce::MathConstants<float>::twoPi / static_cast<float>(maxVoices);
        sampleHoldTarget[static_cast<size_t>(v)] = nextSampleAndHoldValue();
        sampleHoldValue[static_cast<size_t>(v)] =
            sampleHoldTarget[static_cast<size_t>(v)];
    }
}

void S13Chorus::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    juce::ignoreUnused(samplesPerBlock, getModulationSineLut());

    for (auto& delayBuffer : delayBuffers)
        delayBuffer.assign(
            static_cast<size_t>(chorusDelayBufferSize),
            0.0f);
    delayWritePosition = 0;

    // Prepare phaser all-pass filters
    for (int s = 0; s < maxPhaserStages; ++s)
    {
        allpassL[s].reset();
        allpassR[s].reset();
    }

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
    validDelayHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    smoothedMix.reset(sampleRate, 0.02);
    smoothedMix.setCurrentAndTargetValue(
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed)));

    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    lastLowCut = juce::jlimit(20.0f, 2000.0f, lowCut.load());
    lastHighCut = juce::jlimit(200.0f, 20000.0f, highCut.load());
    auto lowCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastLowCut);
    wetLowCutL.coefficients = lowCutCoeffs;
    wetLowCutR.coefficients = lowCutCoeffs;
    prepareRealtimeFilterLut(lowCutCoefficientLut, sampleRate, 20.0f, 2000.0f, true);
    auto highCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastHighCut);
    wetHighCutL.coefficients = highCutCoeffs;
    wetHighCutR.coefficients = highCutCoeffs;
    prepareRealtimeFilterLut(highCutCoefficientLut, sampleRate, 200.0f, 20000.0f, false);
    writeRealtimeFilterCoefficients(
        wetLowCutL,
        wetLowCutR,
        lookupRealtimeFilterLut(lowCutCoefficientLut, sampleRate, lastLowCut, 20.0f, 2000.0f));
    writeRealtimeFilterCoefficients(
        wetHighCutL,
        wetHighCutR,
        lookupRealtimeFilterLut(highCutCoefficientLut, sampleRate, lastHighCut, 200.0f, 20000.0f));
    sampleHoldRandomState = 0x8f6a2c1du;
    characterNoiseSample = 0;
    sampleHoldSlewCoefficient = 1.0f - std::exp(
        -1.0f / (0.012f * static_cast<float>(juce::jmax(1.0, sampleRate))));
    for (int voice = 0; voice < maxVoices; ++voice)
    {
        lfoPhase[voice] = static_cast<float>(voice)
            * juce::MathConstants<float>::twoPi
            / static_cast<float>(maxVoices);
        sampleHoldTarget[static_cast<size_t>(voice)] =
            nextSampleAndHoldValue();
        sampleHoldValue[static_cast<size_t>(voice)] =
            sampleHoldTarget[static_cast<size_t>(voice)];
    }
}

float S13Chorus::nextSampleAndHoldValue() noexcept
{
    auto state = sampleHoldRandomState;
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    sampleHoldRandomState = state != 0 ? state : 0x8f6a2c1du;
    return static_cast<float>(sampleHoldRandomState & 0x00ffffffu)
        / static_cast<float>(0x007fffffu) - 1.0f;
}

void S13Chorus::advanceLFO(int voice, float phaseIncrement) noexcept
{
    const int voiceIndex = juce::jlimit(0, maxVoices - 1, voice);
    auto& phase = lfoPhase[voiceIndex];
    phase += phaseIncrement;
    if (phase >= juce::MathConstants<float>::twoPi)
    {
        phase -= juce::MathConstants<float>::twoPi;
        sampleHoldTarget[static_cast<size_t>(voiceIndex)] =
            nextSampleAndHoldValue();
    }

    auto& value = sampleHoldValue[static_cast<size_t>(voiceIndex)];
    value += (sampleHoldTarget[static_cast<size_t>(voiceIndex)] - value)
        * sampleHoldSlewCoefficient;
}

float S13Chorus::getLFOValue(float phase, LFOShape shape, int voice) const
{
    phase = wrapModulationPhase(phase);

    switch (shape)
    {
        case LFOShape::Sine:
            return lookupModulationSine(phase);

        case LFOShape::Triangle:
        {
            // Normalize to 0-1 range
            float norm = phase / juce::MathConstants<float>::twoPi;
            return 2.0f * std::abs(2.0f * norm - 1.0f) - 1.0f;
        }

        case LFOShape::Square:
            return phase < juce::MathConstants<float>::pi ? 1.0f : -1.0f;

        case LFOShape::SampleAndHold:
            return sampleHoldValue[static_cast<size_t>(
                juce::jlimit(0, maxVoices - 1, voice))];
    }
    return lookupModulationSine(phase);
}

float S13Chorus::readDelayTap(
    int channel,
    float delaySamples) const noexcept
{
    const int channelIndex = juce::jlimit(0, 1, channel);
    const auto& delayBuffer =
        delayBuffers[static_cast<size_t>(channelIndex)];
    if (delayBuffer.size()
        != static_cast<size_t>(chorusDelayBufferSize))
        return 0.0f;

    const int integerDelay =
        static_cast<int>(delaySamples);
    const float fraction =
        delaySamples
        - static_cast<float>(integerDelay)
        + 1.0f;
    int index1 =
        delayWritePosition + integerDelay - 1;
    if (index1 >= chorusDelayBufferSize)
        index1 -= chorusDelayBufferSize;
    int index2 = index1 + 1;
    if (index2 >= chorusDelayBufferSize)
        index2 -= chorusDelayBufferSize;
    int index3 = index2 + 1;
    if (index3 >= chorusDelayBufferSize)
        index3 -= chorusDelayBufferSize;
    int index4 = index3 + 1;
    if (index4 >= chorusDelayBufferSize)
        index4 -= chorusDelayBufferSize;

    const float value1 =
        delayBuffer[static_cast<size_t>(index1)];
    const float value2 =
        delayBuffer[static_cast<size_t>(index2)];
    const float value3 =
        delayBuffer[static_cast<size_t>(index3)];
    const float value4 =
        delayBuffer[static_cast<size_t>(index4)];
    const float distance1 = fraction - 1.0f;
    const float distance2 = fraction - 2.0f;
    const float distance3 = fraction - 3.0f;
    const float coefficient1 =
        -distance1 * distance2 * distance3 / 6.0f;
    const float coefficient2 =
        distance2 * distance3 * 0.5f;
    const float coefficient3 =
        -distance1 * distance3 * 0.5f;
    const float coefficient4 =
        distance1 * distance2 / 6.0f;
    return value1 * coefficient1
        + fraction
            * (value2 * coefficient2
               + value3 * coefficient3
               + value4 * coefficient4);
}

void S13Chorus::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    const auto currentMode = static_cast<Mode>(juce::jlimit(0, 2, static_cast<int>(mode.load())));
    const auto currentLFOShape = static_cast<LFOShape>(juce::jlimit(0, 3, static_cast<int>(lfoShape.load())));
    const int characterIndex = juce::jlimit(0, 2, static_cast<int>(std::round(characterMode.load(std::memory_order_relaxed))));
    float lfoRate = juce::jlimit(0.01f, 20.0f, rate.load());
    if (tempoSync.load() >= 0.5f)
    {
        double bpm = 120.0;
        if (auto* ph = getPlayHead())
        {
            auto pos = ph->getPosition();
            if (pos.hasValue())
                if (auto bpmVal = pos->getBpm())
                    bpm = *bpmVal;
        }

        const int syncIndex = juce::jlimit(0, 5, static_cast<int>(std::round(rate.load())));
        const float barsPerCycle[] { 4.0f, 2.0f, 1.0f, 0.5f, 0.25f, 0.125f };
        lfoRate = static_cast<float>((bpm / 60.0) / (barsPerCycle[syncIndex] * 4.0));
    }
    const float lfoDepth = juce::jlimit(0.0f, 1.0f, depth.load());
    const float fb = juce::jlimit(-1.0f, 1.0f, fbAmount.load());
    smoothedMix.setTargetValue(
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed)));
    const float sendGain = juce::jlimit(
        0.0f, 1.0f, inputSend.load(std::memory_order_relaxed));
    const float randomness = juce::jlimit(
        0.0f, 1.0f, randomBlend.load(std::memory_order_relaxed));
    const bool useEqualPowerMix =
        mixLaw.load(std::memory_order_relaxed) >= 0.5f;
    const int baseVoices = juce::jlimit(1, maxVoices, static_cast<int>(voices.load()));
    const int numVoices = characterIndex == 1 && currentMode == Mode::Chorus ? juce::jmax(baseVoices, 4) : baseVoices;
    const float spreadVal = juce::jlimit(0.0f, 1.0f, spread.load());

    const float currentLowCut = juce::jlimit(20.0f, 2000.0f, lowCut.load());
    if (std::abs(currentLowCut - lastLowCut) > 1.0f)
    {
        lastLowCut = currentLowCut;
        if (! lowCutCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                wetLowCutL,
                wetLowCutR,
                lookupRealtimeFilterLut(lowCutCoefficientLut,
                                        cachedSampleRate,
                                        currentLowCut,
                                        20.0f,
                                        2000.0f));
    }

    const float requestedHighCut = juce::jlimit(200.0f, 20000.0f, highCut.load());
    const float currentHighCut = characterIndex == 2 ? juce::jmin(requestedHighCut, 7200.0f)
                               : (characterIndex == 1 ? juce::jmin(requestedHighCut, 12000.0f)
                                                       : requestedHighCut);
    if (std::abs(currentHighCut - lastHighCut) > 8.0f)
    {
        lastHighCut = currentHighCut;
        if (! highCutCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                wetHighCutL,
                wetHighCutR,
                lookupRealtimeFilterLut(highCutCoefficientLut,
                                        cachedSampleRate,
                                        currentHighCut,
                                        200.0f,
                                        20000.0f));
    }

    const float phaseInc = lfoRate * juce::MathConstants<float>::twoPi
                         / static_cast<float>(cachedSampleRate);

    const float voiceGain = 1.0f / static_cast<float>(numVoices);
    constexpr std::array<float, maxVoices>
        ensembleRateRatios {
            0.83f, 0.93f, 1.0f, 1.08f, 1.17f, 1.29f
        };

    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    auto applyCharacter = [&] (float value, int sampleIndex, int channelIndex)
    {
        if (characterIndex == 1)
            return std::tanh(value * 1.05f) * 0.98f;
        if (characterIndex == 2)
            return std::tanh(value * 1.18f) * 0.9f
                 + builtinNoise(
                       static_cast<int>(
                           (characterNoiseSample
                            + static_cast<std::uint64_t>(sampleIndex))
                           & 0x7fffffffu),
                       400 + channelIndex)
                       * 0.0014f;
        return value;
    };
    auto getModulationValue = [&] (float phase, int voice)
    {
        const float smoothValue =
            getLFOValue(phase, currentLFOShape, voice);
        const float randomValue =
            getLFOValue(phase, LFOShape::SampleAndHold, voice);
        return smoothValue + (randomValue - smoothValue) * randomness;
    };

    if (currentMode == Mode::Phaser)
    {
        // Phaser mode: modulated all-pass filters
        const int baseStages = juce::jlimit(2, maxPhaserStages, numVoices * 2);
        const int numStages = characterIndex == 1 ? juce::jmax(baseStages, 8)
                            : (characterIndex == 2 ? juce::jmin(baseStages, 6) : baseStages);
        const float minFreq = characterIndex == 2 ? 120.0f : 200.0f;
        const float maxFreq = characterIndex == 2 ? 2500.0f : 4000.0f;

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;
            const float sentL = inL * sendGain;
            const float sentR = inR * sendGain;

            // LFO modulates the all-pass center frequency.
            const float lfoVal =
                getModulationValue(lfoPhase[0], 0);
            const float modFreq = minFreq + (maxFreq - minFreq) * (lfoVal * lfoDepth * 0.5f + 0.5f);
            const float warped = std::tan(juce::MathConstants<float>::pi * modFreq / static_cast<float>(cachedSampleRate));
            const float allPassCoeff = (warped - 1.0f) / (warped + 1.0f);

            float procL = sentL + feedbackState[0] * fb;
            float procR = sentR + feedbackState[1] * fb;

            for (int s = 0; s < numStages; ++s)
            {
                const auto stateIndex = static_cast<size_t>(s);
                const float outL = -allPassCoeff * procL + phaserStateL[stateIndex];
                phaserStateL[stateIndex] = procL + allPassCoeff * outL;
                procL = outL;

                const float outR = -allPassCoeff * procR + phaserStateR[stateIndex];
                phaserStateR[stateIndex] = procR + allPassCoeff * outR;
                procR = outR;
            }

            feedbackState[0] = procL;
            feedbackState[1] = procR;
            procL = applyCharacter(procL, i, 0);
            procR = applyCharacter(procR, i, 1);
            procL = wetHighCutL.processSample(wetLowCutL.processSample(procL));
            procR = wetHighCutR.processSample(wetLowCutR.processSample(procR));

            const float wet = smoothedMix.getNextValue();
            const float dryGain = useEqualPowerMix
                ? lookupModulationSine(
                      (1.0f - wet)
                      * juce::MathConstants<float>::halfPi)
                : 1.0f - wet;
            const float wetGain = useEqualPowerMix
                ? lookupModulationSine(
                      wet
                      * juce::MathConstants<float>::halfPi)
                : wet;
            dataL[i] =
                inL * dryGain + procL * wetGain;
            if (dataR)
                dataR[i] =
                    inR * dryGain + procR * wetGain;

            // Advance LFO
            advanceLFO(0, phaseInc);
        }
    }
    else
    {
        // Chorus / Flanger mode
        float centerDelaySamples, depthSamples;
        if (currentMode == Mode::Flanger)
        {
            // Flanger: shorter delay range (0.5ms - 5ms)
            centerDelaySamples =
                static_cast<float>(0.00275 * cachedSampleRate);
            depthSamples =
                static_cast<float>(0.0022 * cachedSampleRate) * lfoDepth;
        }
        else
        {
            // Chorus: longer delay range (7ms - 20ms)
            centerDelaySamples = static_cast<float>(0.007 * cachedSampleRate);
            depthSamples = static_cast<float>(0.013 * cachedSampleRate) * lfoDepth;
        }
        if (characterIndex == 1 && currentMode == Mode::Chorus)
        {
            centerDelaySamples *= 1.22f;
            depthSamples *= 1.18f;
        }
        else if (characterIndex == 2)
        {
            centerDelaySamples *= 1.08f;
            depthSamples *= 0.82f;
        }

        for (int i = 0; i < numSamples; ++i)
        {
            const float inL = dataL[i];
            const float inR = dataR ? dataR[i] : inL;
            const float sentL = inL * sendGain;
            const float sentR = inR * sendGain;

            float wetL = 0.0f;
            float wetR = 0.0f;

            delayBuffers[0][
                static_cast<size_t>(delayWritePosition)] =
                sentL + feedbackState[0] * fb;
            if (numChannels >= 2)
                delayBuffers[1][
                    static_cast<size_t>(
                        delayWritePosition)] =
                    sentR + feedbackState[1] * fb;

            for (int v = 0; v < numVoices; ++v)
            {
                const float lfoVal =
                    getModulationValue(lfoPhase[v], v);
                const float ensembleOffset = characterIndex == 1
                    ? lookupModulationSine(
                          lfoPhase[v] * 0.37f
                          + static_cast<float>(v) * 1.61f)
                        * 0.18f
                    : 0.0f;
                const float delaySamples = juce::jlimit(1.0f, static_cast<float>(maxChorusDelaySamples - 4),
                                                        centerDelaySamples + depthSamples * (lfoVal + ensembleOffset));

                // Read with modulated delay
                const float delayedL =
                    readDelayTap(0, delaySamples);
                const float outL =
                    validDelayHistorySamples
                            >= static_cast<int>(std::ceil(delaySamples)) + 3
                        ? delayedL
                        : 0.0f;
                wetL += outL;

                if (numChannels >= 2)
                {
                    // Stereo spread: offset phase for right channel
                    const float phaseOffset = juce::MathConstants<float>::pi * spreadVal * static_cast<float>(v % 2);
                    const float lfoValR = getModulationValue(
                        lfoPhase[v] + phaseOffset, v);
                    const float decorrelatedEnsembleOffsetR =
                        characterIndex == 1
                            ? lookupModulationSine(
                                  lfoPhase[v] * 0.41f
                                  + static_cast<float>(v) * 1.37f
                                  + phaseOffset)
                                * 0.18f
                            : 0.0f;
                    const float ensembleOffsetR =
                        ensembleOffset
                        + (decorrelatedEnsembleOffsetR
                           - ensembleOffset)
                            * spreadVal;
                    const float delaySamplesR = juce::jlimit(1.0f, static_cast<float>(maxChorusDelaySamples - 4),
                                                             centerDelaySamples + depthSamples * (lfoValR + ensembleOffsetR));
                    const float delayedR =
                        readDelayTap(1, delaySamplesR);
                    const float outR =
                        validDelayHistorySamples
                                >= static_cast<int>(
                                       std::ceil(delaySamplesR))
                                    + 3
                            ? delayedR
                            : 0.0f;
                    wetR += outR;
                }

                // Advance LFO phase
                const float voiceRateRatio =
                    characterIndex == 1
                            && currentMode == Mode::Chorus
                        ? ensembleRateRatios[
                              static_cast<size_t>(v)]
                        : 1.0f;
                advanceLFO(v, phaseInc * voiceRateRatio);
            }
            --delayWritePosition;
            if (delayWritePosition < 0)
                delayWritePosition =
                    chorusDelayBufferSize - 1;
            validDelayHistorySamples = juce::jmin(
                maxChorusDelaySamples,
                validDelayHistorySamples + 1);

            wetL *= voiceGain;
            wetR *= voiceGain;
            wetL = applyCharacter(wetL, i, 0);
            wetR = applyCharacter(wetR, i, 1);
            wetL = wetHighCutL.processSample(wetLowCutL.processSample(wetL));
            wetR = wetHighCutR.processSample(wetLowCutR.processSample(wetR));

            feedbackState[0] = wetL;
            feedbackState[1] = wetR;

            const float wet = smoothedMix.getNextValue();
            const float dryGain = useEqualPowerMix
                ? lookupModulationSine(
                      (1.0f - wet)
                      * juce::MathConstants<float>::halfPi)
                : 1.0f - wet;
            const float wetGain = useEqualPowerMix
                ? lookupModulationSine(
                      wet
                      * juce::MathConstants<float>::halfPi)
                : wet;
            dataL[i] =
                inL * dryGain + wetL * wetGain;
            if (dataR)
                dataR[i] =
                    inR * dryGain + wetR * wetGain;
        }
    }
    // Feedback is constrained by fbAmount and the rack maps it below unity.
    // Only clear non-finite output samples here; clipping the mixed buffer
    // would also clip the fully dry path while the effect is bypassed.
    clearNonFiniteSamples(buffer);
    characterNoiseSample += static_cast<std::uint64_t>(numSamples);
}

void S13Chorus::resetTailState() noexcept
{
    validDelayHistorySamples = 0;
    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
    phaserStateL.fill(0.0f);
    phaserStateR.fill(0.0f);
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();
    smoothedMix.setCurrentAndTargetValue(0.0f);
}

void S13Chorus::releaseResources()
{
    for (auto& delayBuffer : delayBuffers)
        std::fill(
            delayBuffer.begin(),
            delayBuffer.end(),
            0.0f);
    delayWritePosition = 0;

    for (int s = 0; s < maxPhaserStages; ++s)
    {
        allpassL[s].reset();
        allpassR[s].reset();
    }
    phaserStateL.fill(0.0f);
    phaserStateR.fill(0.0f);
    phaserStateL.fill(0.0f);
    phaserStateR.fill(0.0f);
    wetLowCutL.reset();
    wetLowCutR.reset();
    wetHighCutL.reset();
    wetHighCutR.reset();

    feedbackState[0] = 0.0f;
    feedbackState[1] = 0.0f;
    validDelayHistorySamples = 0;
    inputSend.store(1.0f, std::memory_order_relaxed);
    smoothedMix.setCurrentAndTargetValue(
        juce::jlimit(0.0f, 1.0f, mix.load(std::memory_order_relaxed)));
    sampleHoldRandomState = 0x8f6a2c1du;
    characterNoiseSample = 0;
    for (int voice = 0; voice < maxVoices; ++voice)
    {
        lfoPhase[voice] = static_cast<float>(voice) * juce::MathConstants<float>::twoPi
            / static_cast<float>(maxVoices);
        sampleHoldTarget[static_cast<size_t>(voice)] =
            nextSampleAndHoldValue();
        sampleHoldValue[static_cast<size_t>(voice)] =
            sampleHoldTarget[static_cast<size_t>(voice)];
    }
}

double S13Chorus::getTailLengthSeconds() const
{
    if (mix.load(std::memory_order_relaxed) <= 0.0001f)
        return 0.0;

    const auto currentMode = static_cast<Mode>(juce::jlimit(
        0,
        2,
        static_cast<int>(
            std::round(mode.load(std::memory_order_relaxed)))));
    // Ensemble chorus reaches just under 24 ms of delayed history. Phaser has
    // no delay line, but its all-pass/feedback state benefits from a
    // conservative short render tail in standalone use.
    return currentMode == Mode::Phaser ? 0.25 : 0.03;
}

void S13Chorus::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Chorus", {
        { "mode",      mode.load() },
        { "rate",      rate.load() },
        { "depth",     depth.load() },
        { "feedback",  fbAmount.load() },
        { "mix",       mix.load() },
        { "voices",    voices.load() },
        { "lfoShape",  lfoShape.load() },
        { "spread",    spread.load() },
        { "highCut",   highCut.load() },
        { "lowCut",    lowCut.load() },
        { "tempoSync", tempoSync.load() },
        { "characterMode", characterMode.load() },
        { "randomBlend", randomBlend.load() },
        { "mixLaw", mixLaw.load() }
    });
}

void S13Chorus::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Chorus");
    if (!tree.isValid())
        return;

    mode      = static_cast<float>((double)tree.getProperty("mode", 0.0));
    rate      = static_cast<float>((double)tree.getProperty("rate", 1.0));
    depth     = static_cast<float>((double)tree.getProperty("depth", 0.5));
    fbAmount  = static_cast<float>((double)tree.getProperty("feedback", 0.0));
    mix       = static_cast<float>((double)tree.getProperty("mix", 0.5));
    voices    = static_cast<float>((double)tree.getProperty("voices", 2.0));
    lfoShape  = static_cast<float>((double)tree.getProperty("lfoShape", 0.0));
    spread    = static_cast<float>((double)tree.getProperty("spread", 0.5));
    highCut   = static_cast<float>((double)tree.getProperty("highCut", 20000.0));
    lowCut    = static_cast<float>((double)tree.getProperty("lowCut", 20.0));
    tempoSync = static_cast<float>((double)tree.getProperty("tempoSync", 0.0));
    characterMode = static_cast<float>((double)tree.getProperty("characterMode", 0.0));
    randomBlend = static_cast<float>((double)tree.getProperty("randomBlend", 0.0));
    mixLaw = static_cast<float>(
        static_cast<double>(
            tree.getProperty("mixLaw", 0.0)));
}

bool S13Chorus::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}


// ============================================================================
//  S13Saturator
// ============================================================================

S13Saturator::S13Saturator(bool shouldUseLowLatencyOversampling)
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      useLowLatencyOversampling(shouldUseLowLatencyOversampling)
{
}

void S13Saturator::setOversamplingEnabled(bool enabled)
{
    oversamplingEnabled.store(enabled, std::memory_order_relaxed);
    updateOversamplingConfiguration(true);
}

void S13Saturator::setOversamplingMode(float mode)
{
    oversampleMode.store(
        static_cast<float>(juce::jlimit(
            0, 2, static_cast<int>(std::round(mode)))),
        std::memory_order_relaxed);
    updateOversamplingConfiguration(true);
}

int S13Saturator::getRequestedOversamplingMode() const noexcept
{
    if (! oversamplingEnabled.load(std::memory_order_relaxed))
        return 0;

    return juce::jlimit(
        0,
        2,
        static_cast<int>(std::round(
            oversampleMode.load(std::memory_order_relaxed))));
}

void S13Saturator::updateOversamplingConfiguration(bool resetProcessingState)
{
    if (! oversamplingPrepared)
        return;

    const int requestedMode = getRequestedOversamplingMode();
    float wetLatency = 0.0f;
    if (requestedMode == 1 && oversampler2x != nullptr)
        wetLatency = oversampler2x->getLatencyInSamples();
    else if (requestedMode == 2 && oversampler4x != nullptr)
        wetLatency = oversampler4x->getLatencyInSamples();

    const int configuredLatencySamples = juce::jlimit(
        0,
        maximumOversamplingLatencySamples,
        static_cast<int>(std::round(wetLatency)));
    jassert(wetLatency <= static_cast<float>(maximumOversamplingLatencySamples));

    const int previousMode =
        activeOversamplingMode.load(std::memory_order_relaxed);
    const int previousLatency =
        activeOversamplingLatencySamples.load(
            std::memory_order_relaxed);
    const bool configurationChanged =
        requestedMode != previousMode
        || configuredLatencySamples != previousLatency;
    activeOversamplingMode.store(
        requestedMode, std::memory_order_relaxed);
    activeOversamplingLatencySamples.store(
        configuredLatencySamples, std::memory_order_relaxed);
    oversamplingDryDelay.setDelay(
        static_cast<float>(configuredLatencySamples));
    if (getLatencySamples() != configuredLatencySamples)
        setLatencySamples(configuredLatencySamples);

    if (resetProcessingState || configurationChanged)
    {
        if (oversampler2x != nullptr)
            oversampler2x->reset();
        if (oversampler4x != nullptr)
            oversampler4x->reset();
        oversamplingDryDelay.reset();
    }
}

void S13Saturator::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    cachedBlockSize = juce::jmax(1, samplesPerBlock);

    toneFilterL.reset();
    toneFilterR.reset();
    lowCutFilterL.reset();
    lowCutFilterR.reset();
    lastToneFreq = juce::jlimit(200.0f, 20000.0f, toneFreq.load());
    auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, lastToneFreq);
    toneFilterL.coefficients = coeffs;
    toneFilterR.coefficients = coeffs;
    prepareRealtimeFilterLut(toneCoefficientLut, sampleRate, 200.0f, 20000.0f, false);
    lastLowCutFreq = juce::jlimit(20.0f, 1000.0f, lowCutFreq.load());
    auto lowCutCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastLowCutFreq);
    lowCutFilterL.coefficients = lowCutCoeffs;
    lowCutFilterR.coefficients = lowCutCoeffs;
    prepareRealtimeFilterLut(lowCutCoefficientLut, sampleRate, 20.0f, 1000.0f, true);
    writeRealtimeFilterCoefficients(
        toneFilterL,
        toneFilterR,
        lookupRealtimeFilterLut(toneCoefficientLut, sampleRate, lastToneFreq, 200.0f, 20000.0f));
    writeRealtimeFilterCoefficients(
        lowCutFilterL,
        lowCutFilterR,
        lookupRealtimeFilterLut(lowCutCoefficientLut, sampleRate, lastLowCutFreq, 20.0f, 1000.0f));

    const auto oversamplingFilterType = useLowLatencyOversampling
        ? juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR
        : juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple;
    oversampler2x = std::make_unique<juce::dsp::Oversampling<float>>(
        2,
        1,
        oversamplingFilterType,
        false,
        true);
    oversampler4x = std::make_unique<juce::dsp::Oversampling<float>>(
        2,
        2,
        oversamplingFilterType,
        false,
        true);
    oversampler2x->initProcessing(static_cast<size_t>(cachedBlockSize));
    oversampler4x->initProcessing(static_cast<size_t>(cachedBlockSize));

    const int preparedChannels = juce::jmax(2, getTotalNumInputChannels());
    oversamplingDryBuffer.setSize(
        preparedChannels, cachedBlockSize, false, false, true);
    oversamplingDryBuffer.clear();
    juce::dsp::ProcessSpec dryDelaySpec;
    dryDelaySpec.sampleRate = sampleRate;
    dryDelaySpec.maximumBlockSize =
        static_cast<juce::uint32>(cachedBlockSize);
    dryDelaySpec.numChannels =
        static_cast<juce::uint32>(preparedChannels);
    oversamplingDryDelay.prepare(dryDelaySpec);
    oversamplingPrepared = true;
    updateOversamplingConfiguration(true);

    smoothedDriveGain.reset(sampleRate, 0.02);
    smoothedMix.reset(sampleRate, 0.02);
    smoothedOutputGain.reset(sampleRate, 0.02);
    for (auto& modeSmoother : smoothedDiodeMode)
    {
        modeSmoother.reset(sampleRate * 2.0, 0.02);
        modeSmoother.setCurrentAndTargetValue(
            static_cast<int>(std::round(satType.load()))
                    == static_cast<int>(SatType::DiodeClipper)
                ? 1.0f
                : 0.0f);
    }
    diodeCapacitorState.fill(0.0f);
    // Construct the immutable diode table on the prepare thread, never lazily
    // from the realtime callback.
    juce::ignoreUnused(getDiodeCurveLut());
    const float initialDriveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float initialAutoCompDB = -initialDriveDB * 0.42f;
    lastDriveDbTarget = initialDriveDB;
    lastMixTarget =
        juce::jlimit(0.0f, 1.0f, mix.load());
    lastOutputDbTarget =
        juce::jlimit(
            -12.0f,
            0.0f,
            outputGain.load())
        + initialAutoCompDB;
    smoothedDriveGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(initialDriveDB));
    smoothedMix.setCurrentAndTargetValue(
        lastMixTarget);
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            lastOutputDbTarget));
}

void S13Saturator::lookupDiodeCurve(
    float exponent,
    float& sinhValue,
    float& coshValue) const noexcept
{
    const float clampedExponent =
        juce::jlimit(-5.0f, 5.0f, exponent);
    const float position =
        (clampedExponent + 5.0f)
        * static_cast<float>(kDiodeCurveLutSize - 1)
        * 0.1f;
    const auto lowerIndex = static_cast<size_t>(position);
    const auto upperIndex =
        juce::jmin(lowerIndex + 1, kDiodeCurveLutSize - 1);
    const float fraction =
        position - static_cast<float>(lowerIndex);
    const auto& lut = getDiodeCurveLut();
    sinhValue =
        lut.sinhValues[lowerIndex]
        + (lut.sinhValues[upperIndex] - lut.sinhValues[lowerIndex])
            * fraction;
    coshValue =
        lut.coshValues[lowerIndex]
        + (lut.coshValues[upperIndex] - lut.coshValues[lowerIndex])
            * fraction;
}

float S13Saturator::processSample(
    float input,
    float driveLinear,
    SatType type,
    float asym,
    int channel)
{
    // Apply asymmetry shift
    float x = input * driveLinear + asym * 0.1f;

    switch (type)
    {
        case SatType::Tape:
        {
            // Tape saturation: soft, warm compression
            float y = std::tanh(x * 0.8f);
            // Add subtle even harmonics
            y += 0.05f * x * x * (x > 0.0f ? 1.0f : -1.0f);
            return y;
        }

        case SatType::Tube:
        {
            // Tube saturation: asymmetric, rich harmonics
            float y;
            if (x >= 0.0f)
                y = 1.0f - std::exp(-x);
            else
                y = -1.0f + std::exp(x * 0.5f); // Asymmetric negative side
            return y;
        }

        case SatType::Transistor:
        {
            // Transistor: hard clipping with smooth transition
            float y = x;
            if (y > 1.0f)
                y = 2.0f / 3.0f;
            else if (y > 0.0f)
                y = y - (y * y * y) / 3.0f;
            else if (y > -1.0f)
                y = y - (y * y * y) / 3.0f;
            else
                y = -2.0f / 3.0f;
            return y;
        }

        case SatType::Clip:
        {
            // Hard clip
            return juce::jlimit(-1.0f, 1.0f, x);
        }

        case SatType::Crush:
        {
            // Bit crush effect: quantize
            constexpr float levels = 256.0f;
            float y = std::round(x * levels) / levels;
            return juce::jlimit(-1.0f, 1.0f, y);
        }

        case SatType::Console:
        {
            // Console: subtle soft knee with restrained odd harmonics.
            const float knee = x / (1.0f + 0.28f * std::abs(x));
            return std::tanh(knee * 1.15f) * 0.92f;
        }

        case SatType::Transformer:
        {
            // Transformer: rounded low-mid weight with asymmetric magnetic push.
            const float biased = x + asym * 0.18f;
            const float magnetic = std::tanh(biased * 0.95f) + 0.08f * std::sin(biased * 2.0f);
            return magnetic * 0.9f;
        }

        case SatType::Foldback:
        {
            // Foldback: controlled creative distortion, level bounded for safety.
            float y = x;
            const float threshold = 0.78f;
            if (std::abs(y) > threshold)
            {
                const float period = threshold * 4.0f;
                const float phase = y - threshold;
                const float wrapped =
                    phase
                    - std::trunc(phase / period)
                        * period;
                y = std::abs(
                        wrapped
                        - threshold * 2.0f)
                    - threshold;
            }
            return juce::jlimit(-1.0f, 1.0f, y);
        }

        case SatType::DiodeClipper:
        {
            // Backward-Euler solution of a normalized resistor/capacitor stage
            // feeding an anti-parallel Shockley diode pair. The capacitor state
            // gives the clipper a small, sample-rate-stable amount of memory
            // instead of reducing the high-gain mode to a static waveshaper.
            const auto stateIndex = static_cast<size_t>(
                juce::jlimit(0, 1, channel));
            const float previous = diodeCapacitorState[stateIndex];
            constexpr float diodeScale = 3.25f;
            constexpr float diodeCurrent = 0.045f;
            float y = juce::jlimit(
                -1.75f,
                1.75f,
                previous
                    + (x - previous)
                        / (1.0f + diodeCapacitorConductance));

            for (int iteration = 0; iteration < 2; ++iteration)
            {
                const float exponent = juce::jlimit(
                    -5.0f, 5.0f, y * diodeScale);
                float sinhValue = 0.0f;
                float coshValue = 1.0f;
                lookupDiodeCurve(
                    exponent, sinhValue, coshValue);
                const float diode = diodeCurrent * sinhValue;
                const float residual =
                    y
                    + diode
                    + diodeCapacitorConductance * (y - previous)
                    - x;
                const float derivative =
                    1.0f
                    + diodeCurrent * diodeScale * coshValue
                    + diodeCapacitorConductance;
                y = juce::jlimit(
                    -1.75f,
                    1.75f,
                    y - residual / juce::jmax(0.001f, derivative));
            }

            diodeCapacitorState[stateIndex] =
                std::isfinite(y) ? y : 0.0f;
            return diodeCapacitorState[stateIndex] * 0.92f;
        }
    }

    return std::tanh(x); // fallback
}

void S13Saturator::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0)
        return;

    // Update tone filter if frequency changed
    const float currentToneFreq = juce::jlimit(200.0f, 20000.0f, toneFreq.load());
    if (std::abs(currentToneFreq - lastToneFreq) > 1.0f)
    {
        lastToneFreq = currentToneFreq;
        if (! toneCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                toneFilterL,
                toneFilterR,
                lookupRealtimeFilterLut(toneCoefficientLut,
                                        cachedSampleRate,
                                        currentToneFreq,
                                        200.0f,
                                        20000.0f));
    }
    const float currentLowCutFreq = juce::jlimit(20.0f, 1000.0f, lowCutFreq.load());
    if (std::abs(currentLowCutFreq - lastLowCutFreq) > 1.0f)
    {
        lastLowCutFreq = currentLowCutFreq;
        if (! lowCutCoefficientLut.empty())
            writeRealtimeFilterCoefficients(
                lowCutFilterL,
                lowCutFilterR,
                lookupRealtimeFilterLut(lowCutCoefficientLut,
                                        cachedSampleRate,
                                        currentLowCutFreq,
                                        20.0f,
                                        1000.0f));
    }

    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    const float outGainDB = juce::jlimit(-12.0f, 0.0f, outputGain.load());
    const float autoCompDB = -driveDB * 0.42f;
    const float currentMix =
        juce::jlimit(0.0f, 1.0f, mix.load());
    const float outputDbTarget =
        outGainDB + autoCompDB;
    if (driveDB != lastDriveDbTarget)
    {
        lastDriveDbTarget = driveDB;
        smoothedDriveGain.setTargetValue(
            juce::Decibels::decibelsToGain(
                driveDB));
    }
    if (currentMix != lastMixTarget)
    {
        lastMixTarget = currentMix;
        smoothedMix.setTargetValue(currentMix);
    }
    if (outputDbTarget != lastOutputDbTarget)
    {
        lastOutputDbTarget = outputDbTarget;
        smoothedOutputGain.setTargetValue(
            juce::Decibels::decibelsToGain(
                outputDbTarget));
    }
    const auto type = static_cast<SatType>(juce::jlimit(
        0,
        static_cast<int>(SatType::DiodeClipper),
        static_cast<int>(satType.load())));
    const float asym = juce::jlimit(-1.0f, 1.0f, asymmetry.load());
    const int osMode =
        activeOversamplingMode.load(std::memory_order_relaxed);
    const float nonlinearSampleRate =
        static_cast<float>(cachedSampleRate)
        * static_cast<float>(1 << juce::jlimit(0, 2, osMode));
    diodeCapacitorConductance =
        nonlinearSampleRate
        / (juce::MathConstants<float>::twoPi * 18000.0f);
    const float diodeModeTarget =
        type == SatType::DiodeClipper ? 1.0f : 0.0f;
    for (auto& modeSmoother : smoothedDiodeMode)
        modeSmoother.setTargetValue(diodeModeTarget);
    const bool hasPreparedDryPath =
        oversamplingPrepared
        && cachedBlockSize > 0
        && oversamplingDryBuffer.getNumChannels() >= numChannels
        && oversamplingDryBuffer.getNumSamples() >=
            juce::jmin(cachedBlockSize, numSamples);
    jassert(hasPreparedDryPath);
    if (! hasPreparedDryPath)
        return;

    auto applyNonlinearity = [this, type, asym] (auto& audioBlock)
    {
        const int samples = static_cast<int>(audioBlock.getNumSamples());
        const int channels = static_cast<int>(audioBlock.getNumChannels());
        for (int channel = 0; channel < channels; ++channel)
        {
            auto* data = audioBlock.getChannelPointer(
                static_cast<size_t>(channel));
            auto& modeSmoother = smoothedDiodeMode[
                static_cast<size_t>(juce::jlimit(0, 1, channel))];
            const bool processDiode =
                type == SatType::DiodeClipper
                || modeSmoother.isSmoothing();
            if (! processDiode)
                diodeCapacitorState[
                    static_cast<size_t>(juce::jlimit(0, 1, channel))] =
                        0.0f;
            for (int sample = 0; sample < samples; ++sample)
            {
                if (processDiode)
                {
                    const float precisionSample = processSample(
                        data[sample],
                        1.0f,
                        SatType::Transistor,
                        asym,
                        channel);
                    const float distortionSample = processSample(
                        data[sample],
                        1.0f,
                        SatType::DiodeClipper,
                        asym,
                        channel);
                    const float modeMix = modeSmoother.getNextValue();
                    data[sample] =
                        precisionSample
                        + (distortionSample - precisionSample) * modeMix;
                }
                else
                {
                    data[sample] = processSample(
                        data[sample], 1.0f, type, asym, channel);
                }
            }
        }
    };

    if (osMode == 0)
    {
        auto* wetLeft = buffer.getWritePointer(0);
        auto* wetRight =
            numChannels >= 2
                ? buffer.getWritePointer(1)
                : nullptr;
        auto& leftModeSmoother = smoothedDiodeMode[0];
        auto& rightModeSmoother = smoothedDiodeMode[1];
        const bool processLeftDiode =
            type == SatType::DiodeClipper
            || leftModeSmoother.isSmoothing();
        const bool processRightDiode =
            type == SatType::DiodeClipper
            || rightModeSmoother.isSmoothing();
        if (! processLeftDiode)
            diodeCapacitorState[0] = 0.0f;
        if (! processRightDiode)
            diodeCapacitorState[1] = 0.0f;

        auto shapeSample =
            [this, type, asym] (
                float driven,
                int channel,
                bool processDiode,
                juce::SmoothedValue<
                    float,
                    juce::ValueSmoothingTypes::Linear>&
                    modeSmoother)
        {
            if (! processDiode)
            {
                return processSample(
                    driven,
                    1.0f,
                    type,
                    asym,
                    channel);
            }

            const float precisionSample = processSample(
                driven,
                1.0f,
                SatType::Transistor,
                asym,
                channel);
            const float distortionSample = processSample(
                driven,
                1.0f,
                SatType::DiodeClipper,
                asym,
                channel);
            const float modeMix =
                modeSmoother.getNextValue();
            return precisionSample
                + (distortionSample - precisionSample)
                    * modeMix;
        };

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float driveLinear =
                smoothedDriveGain.getNextValue();
            const float wetMix =
                smoothedMix.getNextValue();
            const float dryMix = 1.0f - wetMix;
            const float outGainLinear =
                smoothedOutputGain.getNextValue();

            const float dryLeft = wetLeft[sample];
            float drivenLeft = dryLeft;
            if (lowCutBeforeSaturation)
                drivenLeft =
                    lowCutFilterL.processSample(
                        drivenLeft);
            drivenLeft *= driveLinear;
            float processedLeft = shapeSample(
                drivenLeft,
                0,
                processLeftDiode,
                leftModeSmoother);
            processedLeft =
                toneFilterL.processSample(
                    processedLeft);
            if (! lowCutBeforeSaturation)
            {
                processedLeft =
                    lowCutFilterL.processSample(
                        processedLeft);
            }
            processedLeft *= outGainLinear;
            processedLeft =
                std::isfinite(processedLeft)
                    ? juce::jlimit(
                          -2.5f,
                          2.5f,
                          processedLeft)
                    : 0.0f;
            const float mixedLeft =
                dryLeft * dryMix
                + processedLeft * wetMix;
            wetLeft[sample] =
                std::isfinite(mixedLeft)
                    ? mixedLeft
                    : 0.0f;

            if (wetRight != nullptr)
            {
                const float dryRight =
                    wetRight[sample];
                float drivenRight = dryRight;
                if (lowCutBeforeSaturation)
                {
                    drivenRight =
                        lowCutFilterR.processSample(
                            drivenRight);
                }
                drivenRight *= driveLinear;
                float processedRight = shapeSample(
                    drivenRight,
                    1,
                    processRightDiode,
                    rightModeSmoother);
                processedRight =
                    toneFilterR.processSample(
                        processedRight);
                if (! lowCutBeforeSaturation)
                {
                    processedRight =
                        lowCutFilterR.processSample(
                            processedRight);
                }
                processedRight *= outGainLinear;
                processedRight =
                    std::isfinite(processedRight)
                        ? juce::jlimit(
                              -2.5f,
                              2.5f,
                              processedRight)
                        : 0.0f;
                const float mixedRight =
                    dryRight * dryMix
                    + processedRight * wetMix;
                wetRight[sample] =
                    std::isfinite(mixedRight)
                        ? mixedRight
                        : 0.0f;
            }
        }

        return;
    }

    juce::dsp::AudioBlock<float> fullBlock(buffer);
    juce::dsp::AudioBlock<float> fullDryBlock(oversamplingDryBuffer);
    for (int blockOffset = 0; blockOffset < numSamples;)
    {
        const int samplesThisChunk =
            juce::jmin(cachedBlockSize, numSamples - blockOffset);
        auto block = fullBlock.getSubBlock(
            static_cast<size_t>(blockOffset),
            static_cast<size_t>(samplesThisChunk));
        auto dryBlock = fullDryBlock
            .getSubsetChannelBlock(0, static_cast<size_t>(numChannels))
            .getSubBlock(0, static_cast<size_t>(samplesThisChunk));

        for (int channel = 0; channel < numChannels; ++channel)
            oversamplingDryBuffer.copyFrom(
                channel,
                0,
                buffer,
                channel,
                blockOffset,
                samplesThisChunk);
        juce::dsp::ProcessContextReplacing<float> dryDelayContext(dryBlock);
        oversamplingDryDelay.process(dryDelayContext);

        if (lowCutBeforeSaturation)
        {
            auto* wetLeft = block.getChannelPointer(0);
            auto* wetRight = numChannels >= 2
                ? block.getChannelPointer(1)
                : nullptr;
            for (int sample = 0; sample < samplesThisChunk; ++sample)
            {
                wetLeft[sample] =
                    lowCutFilterL.processSample(wetLeft[sample]);
                if (wetRight != nullptr)
                    wetRight[sample] =
                        lowCutFilterR.processSample(wetRight[sample]);
            }
        }

        for (int sample = 0; sample < samplesThisChunk; ++sample)
        {
            const float driveLinear = smoothedDriveGain.getNextValue();
            for (int channel = 0; channel < numChannels; ++channel)
                block.getChannelPointer(static_cast<size_t>(channel))[sample]
                    *= driveLinear;
        }

        if (osMode == 1 && oversampler2x != nullptr)
        {
            auto oversampledBlock = oversampler2x->processSamplesUp(block);
            applyNonlinearity(oversampledBlock);
            oversampler2x->processSamplesDown(block);
        }
        else if (osMode == 2 && oversampler4x != nullptr)
        {
            auto oversampledBlock = oversampler4x->processSamplesUp(block);
            applyNonlinearity(oversampledBlock);
            oversampler4x->processSamplesDown(block);
        }
        else
        {
            applyNonlinearity(block);
        }

        auto* wetLeft = block.getChannelPointer(0);
        auto* wetRight = numChannels >= 2
            ? block.getChannelPointer(1)
            : nullptr;
        const auto* dryLeft = dryBlock.getChannelPointer(0);
        const auto* dryRight = numChannels >= 2
            ? dryBlock.getChannelPointer(1)
            : nullptr;
        for (int sample = 0; sample < samplesThisChunk; ++sample)
        {
            const float wetMix = smoothedMix.getNextValue();
            const float dryMix = 1.0f - wetMix;
            const float outGainLinear = smoothedOutputGain.getNextValue();
            float processedLeft = toneFilterL.processSample(wetLeft[sample]);
            if (! lowCutBeforeSaturation)
                processedLeft = lowCutFilterL.processSample(processedLeft);
            processedLeft *= outGainLinear;
            processedLeft = std::isfinite(processedLeft)
                ? juce::jlimit(-2.5f, 2.5f, processedLeft)
                : 0.0f;
            wetLeft[sample] =
                dryLeft[sample] * dryMix
                + processedLeft * wetMix;

            if (wetRight != nullptr && dryRight != nullptr)
            {
                float processedRight =
                    toneFilterR.processSample(wetRight[sample]);
                if (! lowCutBeforeSaturation)
                    processedRight =
                        lowCutFilterR.processSample(processedRight);
                processedRight *= outGainLinear;
                processedRight = std::isfinite(processedRight)
                    ? juce::jlimit(-2.5f, 2.5f, processedRight)
                    : 0.0f;
                wetRight[sample] =
                    dryRight[sample] * dryMix
                    + processedRight * wetMix;
            }
        }

        blockOffset += samplesThisChunk;
    }
    // Floating-point dry audio may legitimately exceed 0 dBFS. Safety limiting
    // is applied to the effect branch above; after the aligned mix only invalid
    // values are removed so Mix=0 remains sample-transparent.
    clearNonFiniteSamples(buffer);
}

void S13Saturator::releaseResources()
{
    toneFilterL.reset();
    toneFilterR.reset();
    lowCutFilterL.reset();
    lowCutFilterR.reset();
    if (oversampler2x)
        oversampler2x->reset();
    if (oversampler4x)
        oversampler4x->reset();
    oversamplingDryDelay.reset();
    oversamplingDryBuffer.clear();
    diodeCapacitorState.fill(0.0f);
    for (auto& modeSmoother : smoothedDiodeMode)
    {
        modeSmoother.setCurrentAndTargetValue(
            static_cast<int>(std::round(satType.load()))
                    == static_cast<int>(SatType::DiodeClipper)
                ? 1.0f
                : 0.0f);
    }
    smoothedDriveGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(0.0f, 30.0f, drive.load())));
    smoothedMix.setCurrentAndTargetValue(juce::jlimit(0.0f, 1.0f, mix.load()));
    const float driveDB = juce::jlimit(0.0f, 30.0f, drive.load());
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-12.0f, 0.0f, outputGain.load()) - driveDB * 0.42f));
}

void S13Saturator::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13Saturator", {
        { "satType",        satType.load() },
        { "drive",          drive.load() },
        { "mix",            mix.load() },
        { "toneFreq",       toneFreq.load() },
        { "lowCutFreq",     lowCutFreq.load() },
        { "outputGain",     outputGain.load() },
        { "asymmetry",      asymmetry.load() },
        { "oversampleMode", oversampleMode.load() },
        { "oversamplingEnabled",
          oversamplingEnabled.load(std::memory_order_relaxed) ? 1.0f : 0.0f }
    });
}

void S13Saturator::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13Saturator");
    if (!tree.isValid())
        return;

    satType        = static_cast<float>((double)tree.getProperty("satType", 0.0));
    drive          = static_cast<float>((double)tree.getProperty("drive", 6.0));
    mix            = static_cast<float>((double)tree.getProperty("mix", 1.0));
    toneFreq       = static_cast<float>((double)tree.getProperty("toneFreq", 20000.0));
    lowCutFreq     = static_cast<float>((double)tree.getProperty("lowCutFreq", 20.0));
    outputGain     = static_cast<float>((double)tree.getProperty("outputGain", 0.0));
    asymmetry      = static_cast<float>((double)tree.getProperty("asymmetry", 0.0));
    const float restoredOversamplingMode = static_cast<float>(
        (double)tree.getProperty("oversampleMode", 1.0));
    oversampleMode.store(
        static_cast<float>(juce::jlimit(
            0,
            2,
            static_cast<int>(std::round(restoredOversamplingMode)))),
        std::memory_order_relaxed);
    const bool restoredOversamplingEnabled =
        static_cast<double>(tree.getProperty(
            "oversamplingEnabled",
            restoredOversamplingMode >= 0.5f ? 1.0 : 0.0)) >= 0.5;
    setOversamplingEnabled(restoredOversamplingEnabled);
}

// ============================================================================
//  S13NAMRack
// ============================================================================

static float getBufferPeakDb(const juce::AudioBuffer<float>& buffer) noexcept
{
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        const auto* samples = buffer.getReadPointer(ch);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            peak = juce::jmax(peak, std::abs(samples[sample]));
    }

    return juce::jlimit(-90.0f, 6.0f, juce::Decibels::gainToDecibels(peak, -90.0f));
}

static float bufferPeakLinear(const juce::AudioBuffer<float>& buffer) noexcept
{
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        const auto* samples = buffer.getReadPointer(ch);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            peak = juce::jmax(peak, std::abs(samples[sample]));
    }
    return peak;
}

static void copyNAMMonoInput(juce::AudioBuffer<float>& dest,
                             int destChannel,
                             const juce::AudioBuffer<float>& source,
                             int numSamples) noexcept
{
    if (destChannel < 0 || destChannel >= dest.getNumChannels() || numSamples <= 0 || source.getNumChannels() <= 0)
        return;

    if (source.getNumChannels() == 1)
    {
        dest.copyFrom(destChannel, 0, source, 0, 0, numSamples);
        return;
    }

    const auto* const left = source.getReadPointer(0);
    const auto* const right = source.getReadPointer(1);
    float leftPeak = 0.0f;
    float rightPeak = 0.0f;
    for (int sample = 0; sample < numSamples; ++sample)
    {
        leftPeak = juce::jmax(leftPeak, std::abs(left[sample]));
        rightPeak = juce::jmax(rightPeak, std::abs(right[sample]));
    }

    constexpr float silentChannelThreshold = 1.0e-9f;
    if (rightPeak <= silentChannelThreshold)
    {
        // AudioEngine maps a single routed hardware input to rack channel 0 and
        // leaves channel 1 silent. Keep that mono route at unity instead of
        // attenuating it by 6.02 dB.
        dest.copyFrom(destChannel, 0, source, 0, 0, numSamples);
        return;
    }

    if (leftPeak <= silentChannelThreshold)
    {
        // A raw stereo route can also carry a valid signal on only its right
        // side. Catch that channel at unity rather than silently feeding NAM an
        // empty left input.
        dest.copyFrom(destChannel, 0, source, 1, 0, numSamples);
        return;
    }

    // NAM captures with one input are mono processors. Match the official NAM
    // plug-in's DAW convention for a genuinely stereo source by folding L/R
    // down at unity for correlated mono material. This retains both sides and
    // avoids the 6 dB boost of a straight sum.
    auto* const destination = dest.getWritePointer(destChannel);
    for (int sample = 0; sample < numSamples; ++sample)
        destination[sample] = 0.5f * (left[sample] + right[sample]);
}

static float softLimitCreativeEffect(float value) noexcept
{
    if (! std::isfinite(value))
        return 0.0f;

    value = juce::jlimit(-8.0f, 8.0f, value);
    return std::tanh(value * 1.1f) * 0.95f;
}

static float finiteNAMSample(float value) noexcept
{
    // Floating-point NAM gain staging may legitimately exceed 0 dBFS. Keep all
    // finite model output untouched; only contain invalid DSP values here.
    return std::isfinite(value) ? value : 0.0f;
}

static juce::String normaliseNAMCaptureTypeName(const juce::String& rawType)
{
    auto type = rawType.trim().toLowerCase()
        .replaceCharacter('-', '_')
        .replaceCharacter(' ', '_');
    while (type.contains("__"))
        type = type.replace("__", "_");

    if (type == "amp" || type == "pedal" || type == "pedal_amp"
        || type == "amp_cab" || type == "amp_pedal_cab"
        || type == "preamp" || type == "studio")
        return type;
    if (type == "full_rig" || type == "fullrig" || type == "rig")
        return "full_rig";
    return "unknown";
}

static juce::String normaliseNAMCaptureType(const juce::var& modelJson)
{
    const auto metadata = modelJson.getProperty("metadata", {});
    auto* metadataObject = metadata.getDynamicObject();
    if (metadataObject == nullptr)
        return "unknown";

    // gear_type describes the captured hardware topology and therefore wins.
    // Some older exporters only populated tone_type, so consult it strictly
    // as a secondary metadata source when gear_type is absent/unknown.
    const auto gearType = normaliseNAMCaptureTypeName(
        metadataObject->getProperty("gear_type").toString());
    if (gearType != "unknown")
        return gearType;

    return normaliseNAMCaptureTypeName(
        metadataObject->getProperty("tone_type").toString());
}

static bool NAMCaptureIncludesCab(const juce::String& captureType) noexcept
{
    return captureType == "amp_cab"
        || captureType == "amp_pedal_cab"
        || captureType == "full_rig";
}

static bool guardedNAMProcessBlock(nam::DSP* dsp, float** input, float** output, int numFrames) noexcept
{
    if (dsp == nullptr || input == nullptr || output == nullptr || numFrames <= 0)
        return false;

   #if JUCE_WINDOWS
    __try
    {
        dsp->process(input, output, numFrames);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
   #else
    try
    {
        dsp->process(input, output, numFrames);
        return true;
    }
    catch (...)
    {
        return false;
    }
   #endif
}

static constexpr int kNAMRackMinimumRealtimeCapacity = 8192;
static constexpr int kNAMRackResamplerGuardSamples = 8;
// This threshold classifies observed callback granularity for diagnostics only.
// NAM accepts every positive host block size exposed by the audio driver.
static constexpr int kNAMRackTightBlockTelemetryThreshold = 128;
static constexpr double kNAMRackMaximumResampleRatio = 4.0;
static constexpr double kNAMRackModelTransitionSeconds = 0.012;

static int getNAMRackModelResamplerLatency(double hostSampleRate, double modelSampleRate) noexcept
{
    const double safeHostRate = juce::jmax(1.0, hostSampleRate);
    const double safeModelRate = modelSampleRate > 1000.0 ? modelSampleRate : safeHostRate;
    if (std::abs(safeModelRate - safeHostRate) <= 1.0)
        return 0;

    constexpr int halfKernel = 48 / 2;
    return halfKernel
        + static_cast<int>(std::ceil(static_cast<double>(halfKernel) * safeHostRate / safeModelRate));
}

static int getNAMRackRealtimeCapacity(int requestedBlockSize) noexcept
{
    return juce::jmax(kNAMRackMinimumRealtimeCapacity,
                      requestedBlockSize > 0 ? requestedBlockSize : 512);
}

static int getNAMRackDspFrameCapacity(int hostCapacity, double hostSampleRate, double modelSampleRate) noexcept
{
    const double safeHostRate = juce::jmax(1.0, hostSampleRate);
    const double safeModelRate = modelSampleRate > 1000.0 ? modelSampleRate : safeHostRate;
    return juce::jmax(64, static_cast<int>(std::ceil(static_cast<double>(hostCapacity) * safeModelRate / safeHostRate)))
        + kNAMRackResamplerGuardSamples;
}

void S13NAMRack::NAMResamplerKernel::prepare(double newInputRate, double newOutputRate) noexcept
{
    inputRate = juce::jmax(1.0, newInputRate);
    outputRate = juce::jmax(1.0, newOutputRate);
    sourceStep = inputRate / outputRate;

    // A fixed, precomputed polyphase windowed-sinc table keeps every callback
    // allocation-free and avoids running trigonometric functions on the audio
    // thread. Narrowing the cutoff when downsampling provides the anti-alias
    // filtering that the previous block-local interpolator did not provide.
    const double cutoff = juce::jmin(0.98, 0.98 * outputRate / inputRate);
    constexpr int half = namResamplerKernelTaps / 2;
    for (int phase = 0; phase < namResamplerKernelPhases; ++phase)
    {
        const double fraction = static_cast<double>(phase) / static_cast<double>(namResamplerKernelPhases);
        double coefficientSum = 0.0;
        const auto phaseOffset = static_cast<size_t>(phase * namResamplerKernelTaps);

        for (int tap = 0; tap < namResamplerKernelTaps; ++tap)
        {
            const int sampleOffset = tap - (half - 1);
            const double distance = fraction - static_cast<double>(sampleOffset);
            const double absoluteDistance = std::abs(distance);
            double coefficient = 0.0;
            if (absoluteDistance < static_cast<double>(half))
            {
                const double sincArgument = juce::MathConstants<double>::pi * cutoff * distance;
                const double sinc = std::abs(sincArgument) < 1.0e-12
                    ? 1.0
                    : std::sin(sincArgument) / sincArgument;
                const double window = 0.5 * (1.0 + std::cos(
                    juce::MathConstants<double>::pi * distance / static_cast<double>(half)));
                coefficient = cutoff * sinc * window;
            }

            coefficients[phaseOffset + static_cast<size_t>(tap)] = static_cast<float>(coefficient);
            coefficientSum += coefficient;
        }

        if (std::abs(coefficientSum) > 1.0e-12)
        {
            const float normalisation = static_cast<float>(1.0 / coefficientSum);
            for (int tap = 0; tap < namResamplerKernelTaps; ++tap)
                coefficients[phaseOffset + static_cast<size_t>(tap)] *= normalisation;
        }
    }
}

void S13NAMRack::NAMResamplerState::reset() noexcept
{
    history.fill(0.0f);
    writeIndex = 0;
    totalInputSamples = 0;
    nextSourcePosition = 0.0;
}

float S13NAMRack::NAMResamplerState::sampleAt(std::int64_t absoluteIndex) const noexcept
{
    if (absoluteIndex < 0 || absoluteIndex >= totalInputSamples)
        return 0.0f;

    const auto age = totalInputSamples - 1 - absoluteIndex;
    if (age < 0 || age >= namResamplerHistorySize)
        return 0.0f;

    int index = writeIndex - 1 - static_cast<int>(age);
    while (index < 0)
        index += namResamplerHistorySize;
    return history[static_cast<size_t>(index)];
}

float S13NAMRack::NAMResamplerState::interpolate(double sourcePosition,
                                                  const NAMResamplerKernel& kernel) const noexcept
{
    constexpr int half = namResamplerKernelTaps / 2;
    const double delayedPosition = sourcePosition - static_cast<double>(half);
    const auto baseIndex = static_cast<std::int64_t>(std::floor(delayedPosition));
    const double fraction = delayedPosition - static_cast<double>(baseIndex);
    const int phase = juce::jlimit(0,
                                  namResamplerKernelPhases - 1,
                                  static_cast<int>(fraction * static_cast<double>(namResamplerKernelPhases)));
    const auto phaseOffset = static_cast<size_t>(phase * namResamplerKernelTaps);

    double result = 0.0;
    for (int tap = 0; tap < namResamplerKernelTaps; ++tap)
    {
        const int sampleOffset = tap - (half - 1);
        result += static_cast<double>(sampleAt(baseIndex + sampleOffset))
            * static_cast<double>(kernel.coefficients[phaseOffset + static_cast<size_t>(tap)]);
    }
    return static_cast<float>(result);
}

int S13NAMRack::NAMResamplerState::process(const float* input,
                                            int numInputSamples,
                                            float* output,
                                            int outputCapacity,
                                            const NAMResamplerKernel& kernel) noexcept
{
    if (input == nullptr || output == nullptr || numInputSamples < 0 || outputCapacity < 0)
        return -1;

    int outputSamples = 0;
    for (int inputSample = 0; inputSample < numInputSamples; ++inputSample)
    {
        history[static_cast<size_t>(writeIndex)] = finiteNAMSample(input[inputSample]);
        writeIndex = (writeIndex + 1) % namResamplerHistorySize;
        ++totalInputSamples;

        while (nextSourcePosition < static_cast<double>(totalInputSamples))
        {
            if (outputSamples >= outputCapacity)
                return -1;

            output[outputSamples++] = interpolate(nextSourcePosition, kernel);
            nextSourcePosition += kernel.sourceStep;
        }
    }

    return outputSamples;
}

static bool probeNAMModelInChildProcess(const juce::File& modelFile, juce::String& error)
{
    if (juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_DISABLE_NAM_MODEL_PROBE", "0") == "1")
        return true;

    const auto executable = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    if (! executable.existsAsFile())
    {
        error = "Could not locate OpenStudio executable for NAM safety probe.";
        return false;
    }

    auto probeDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("OpenStudio")
        .getChildFile("NAMModelProbes");
    if (! probeDir.createDirectory())
    {
        error = "Could not create temporary NAM safety probe directory.";
        return false;
    }

    const auto reportFile = probeDir.getChildFile("probe_" + juce::Uuid().toString() + ".json");
    const auto commandLine = executable.getFullPathName().quoted()
        + " --nam-model-probe-headless " + modelFile.getFullPathName().quoted()
        + " --report " + reportFile.getFullPathName().quoted();

    juce::ChildProcess child;
    if (! child.start(commandLine))
    {
        error = "Could not start NAM model safety probe.";
        return false;
    }

    constexpr int timeoutMs = 35000;
    if (! child.waitForProcessToFinish(timeoutMs))
    {
        child.kill();
        error = "NAM model safety probe timed out.";
        reportFile.deleteFile();
        return false;
    }

    const int exitCode = child.getExitCode();
    auto report = reportFile.existsAsFile()
        ? juce::JSON::parse(reportFile.loadFileAsString())
        : juce::var();

    bool success = exitCode == 0
        && report.isObject()
        && static_cast<bool>(report.getProperty("success", false))
        && report.getProperty("objectiveGateStatus", {}).toString() == "pass";

    if (! success)
    {
        auto reportError = report.getProperty("error", {}).toString();
        if (reportError.isEmpty())
            reportError = "NAM model safety probe failed with exit code " + juce::String(exitCode) + ".";
        error = reportError;
    }

    reportFile.deleteFile();
    return success;
}

static void updateNAMMeterLevel(std::atomic<float>& meterDb,
                                float targetDb,
                                int numSamples,
                                double sampleRate,
                                int& holdSamplesRemaining) noexcept
{
    constexpr double holdSeconds = 0.60;
    constexpr double releaseSeconds = 0.35;
    const double safeSampleRate = sampleRate > 1000.0 ? sampleRate : 44100.0;
    const int safeSamples = juce::jmax(1, numSamples);
    const float boundedTarget = juce::jlimit(-90.0f, 6.0f, targetDb);
    const float currentDb = meterDb.load(std::memory_order_relaxed);

    if (boundedTarget >= currentDb)
    {
        // A linked peak meter should make transients visible immediately and
        // hold them long enough for the 10 Hz WebView diagnostics feed.
        meterDb.store(boundedTarget, std::memory_order_relaxed);
        holdSamplesRemaining = juce::roundToInt(holdSeconds * safeSampleRate);
        return;
    }

    if (holdSamplesRemaining > 0)
    {
        holdSamplesRemaining = juce::jmax(0, holdSamplesRemaining - safeSamples);
        return;
    }

    const double elapsedSeconds = static_cast<double>(safeSamples) / safeSampleRate;
    const float releaseAmount = static_cast<float>(
        1.0 - std::exp(-elapsedSeconds / releaseSeconds));
    const float nextDb = currentDb + (boundedTarget - currentDb) * releaseAmount;
    meterDb.store(juce::jlimit(-90.0f, 6.0f, nextDb), std::memory_order_relaxed);
}

enum NAMRackPostCabModule
{
    namRackPostCabEQ = 0,
    namRackPostCabMod = 1,
    namRackPostCabDelay = 2,
    namRackPostCabReverb = 3,
    namRackPostCabModuleCount = 4
};

static int namRackPostCabModuleFromString(const juce::String& id) noexcept
{
    if (id == "eq") return namRackPostCabEQ;
    if (id == "mod") return namRackPostCabMod;
    if (id == "delay") return namRackPostCabDelay;
    if (id == "reverb") return namRackPostCabReverb;
    return -1;
}

static void appendUniqueNAMRackPostCabModule(juce::Array<int>& order, int moduleId)
{
    if (moduleId < 0 || moduleId >= namRackPostCabModuleCount || order.contains(moduleId))
        return;

    order.add(moduleId);
}

static juce::Array<int> normalizeNAMRackPostCabOrder(const juce::var& uiState)
{
    juce::Array<int> order;

    if (auto* root = uiState.getDynamicObject())
    {
        if (auto* slots = root->getProperty("namRackSlots").getDynamicObject())
        {
            if (auto* rawOrder = slots->getProperty("order").getArray())
            {
                for (const auto& item : *rawOrder)
                    appendUniqueNAMRackPostCabModule(order, namRackPostCabModuleFromString(item.toString()));
            }
        }
    }

    appendUniqueNAMRackPostCabModule(order, namRackPostCabEQ);
    appendUniqueNAMRackPostCabModule(order, namRackPostCabMod);
    appendUniqueNAMRackPostCabModule(order, namRackPostCabDelay);
    appendUniqueNAMRackPostCabModule(order, namRackPostCabReverb);
    return order;
}

static float getNAMPrecisionDriveOutputGainDb(
    bool distortionMode,
    float driveAmount,
    int dspVersion) noexcept
{
    const float drive =
        juce::jlimit(0.0f, 1.0f, driveAmount);
    if (dspVersion < 2)
    {
        return distortionMode
            ? -2.0f - drive * 2.0f
            : -1.5f - drive * 3.5f;
    }

    // V2 compensation is calibrated against the deterministic 220/997 Hz
    // two-tone reference used by the native level/spectral gate. It counters
    // the reusable kernel's drive-dependent auto compensation without turning
    // higher Drive settings into an automatic loudness boost.
    return distortionMode
        ? -2.7f - drive * 0.3f
        : -1.5f - drive * 0.2f;
}

S13NAMRack::S13NAMRack()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      rackTapeEcho(1.25f),
      rackDelay(6.1f)
{
    retiredCabIRs.reserve(8);
    // The Rack owns one fixed 2x island around both adjacent nonlinear stages.
    // The reusable Saturator wrappers therefore run as high-rate kernels only;
    // paying one shared up/down conversion keeps PDC constant and avoids two
    // redundant oversampling filter pairs.
    rackPrecisionDrive.setOversamplingMode(0.0f);
    rackChaos.setOversamplingMode(0.0f);
    rackPrecisionDrive.setOversamplingEnabled(false);
    rackChaos.setOversamplingEnabled(false);
    rackPrecisionDrive.setLowCutBeforeSaturation(true);
}

void S13NAMRack::setTransposeSemitones(float legacySemitones) noexcept
{
    // Compatibility shim for projects and presets saved before live transpose
    // was retired. Never reactivate the former latency/artifact-producing path.
    juce::ignoreUnused(legacySemitones);
    transposeSemitones.store(0.0f, std::memory_order_relaxed);
}

void S13NAMRack::updateReportedLatency()
{
    int requiredLatency =
        embeddedDriveOversamplingLatencySamples;

    const auto addModelResamplerLatency = [this, &requiredLatency] (const std::shared_ptr<LoadedNAMModel>& model)
    {
        if (model == nullptr)
            return;

        const double modelSampleRate = model->expectedSampleRate > 1000.0
            ? model->expectedSampleRate
            : cachedSampleRate;
        if (std::abs(modelSampleRate - cachedSampleRate) <= 1.0)
            return;

        requiredLatency += getNAMRackModelResamplerLatency(cachedSampleRate, modelSampleRate);
    };

    {
        const juce::ScopedLock lock(modelSwapLock);
        addModelResamplerLatency(ampModel);
    }

    if (getLatencySamples() != requiredLatency)
        setLatencySamples(requiredLatency);
}

double S13NAMRack::getTailLengthSeconds() const
{
    return getAutomatedTailLengthSeconds(tailAutomationNone);
}

double S13NAMRack::getAutomatedTailLengthSeconds(std::uint32_t moduleMask) const
{
    double tailSeconds = 0.0;

    const auto addFeedbackTail = [&tailSeconds] (bool enabled, float mix, float delayMs, float feedback)
    {
        if (! enabled || mix <= 0.0001f)
            return;

        const double delaySeconds = juce::jmax(0.001, static_cast<double>(delayMs) * 0.001);
        const double clampedFeedback = juce::jlimit(0.0, 0.999, static_cast<double>(feedback));
        const double repeatsToMinus60 = clampedFeedback > 0.0001
            ? std::log(0.001) / std::log(clampedFeedback)
            : 1.0;
        tailSeconds += delaySeconds * juce::jmax(1.0, repeatsToMinus60);
    };

    const bool automateTape = (moduleMask & tailAutomationTapeEcho) != 0;
    const float effectiveTapeTimeMs = [&]
    {
        const float timeMs = automateTape
            ? 1200.0f
            : juce::jlimit(20.0f, 1200.0f, tapeEchoTimeMs.load(std::memory_order_relaxed));
        const float modulation = automateTape
            ? 1.0f
            : juce::jlimit(0.0f, 1.0f, tapeEchoMod.load(std::memory_order_relaxed));
        const float rightTimeMs = juce::jlimit(20.0f, 1200.0f,
                                              timeMs * (1.01f + modulation * 0.035f));
        const float saturation = 0.16f + modulation * 0.46f;
        const float maximumWowMs = 1.8f * (0.25f + saturation * 0.75f);
        return juce::jmin(rackTapeEcho.getMaximumSupportedDelaySeconds() * 1000.0f,
                          juce::jmax(timeMs, rightTimeMs) + maximumWowMs);
    }();
    addFeedbackTail(automateTape || tapeEchoEnabled.load(std::memory_order_relaxed) >= 0.5f,
                    automateTape ? 1.0f : tapeEchoMix.load(std::memory_order_relaxed),
                    effectiveTapeTimeMs,
                    automateTape ? 0.85f
                                 : juce::jlimit(0.0f, 0.85f, tapeEchoFeedback.load(std::memory_order_relaxed)));
    const bool automateDelay = (moduleMask & tailAutomationDelay) != 0;
    const float effectiveDelayTimeMs = [&]
    {
        double bpm = 120.0;
        if (auto* currentPlayHead = getPlayHead())
        {
            const auto position = currentPlayHead->getPosition();
            if (position.hasValue())
                if (const auto positionBpm = position->getBpm())
                    bpm = *positionBpm;
        }
        bpm = juce::jlimit(10.0, 300.0, bpm);
        const auto syncNoteMs = [bpm] (int index)
        {
            static constexpr std::array<float, 9> multipliers {
                4.0f, 2.0f, 1.0f, 0.5f, 0.25f,
                2.0f / 3.0f, 1.0f / 3.0f, 1.5f, 0.75f
            };
            return static_cast<float>(60000.0 / bpm)
                * multipliers[static_cast<size_t>(juce::jlimit(0, 8, index))];
        };

        const float modulation = automateDelay
            ? 1.0f
            : juce::jlimit(0.0f, 1.0f, delayMod.load(std::memory_order_relaxed));
        const bool pingPong = automateDelay
            || delayPingPong.load(std::memory_order_relaxed) >= 0.5f;
        const bool tempoSync = automateDelay
            || delayTempoSync.load(std::memory_order_relaxed) >= 0.5f;
        float maximumTimeMs = 0.0f;
        if (tempoSync)
        {
            if (automateDelay)
            {
                // Rack sync routes span 1/4 through 1/4T. At the supported
                // 10-BPM floor, 1/4 is the longest reachable selection.
                maximumTimeMs = syncNoteMs(2);
            }
            else
            {
                const int leftIndex = static_cast<int>(juce::jlimit(0.0f, 8.0f,
                                                                   2.0f + modulation * 2.0f));
                const int rightIndex = static_cast<int>(juce::jlimit(0.0f, 8.0f,
                    pingPong ? 3.0f + modulation * 2.0f : 2.0f + modulation * 2.0f));
                maximumTimeMs = juce::jmax(syncNoteMs(leftIndex), syncNoteMs(rightIndex));
            }
        }

        const float manualTimeMs = automateDelay
            ? 2000.0f
            : juce::jlimit(1.0f, 2000.0f, delayTimeMs.load(std::memory_order_relaxed));
        const float rightManualTimeMs = juce::jlimit(
            1.0f, 2000.0f, manualTimeMs * (pingPong ? 1.18f : 1.0f));
        if (! tempoSync || automateDelay)
            maximumTimeMs = juce::jmax(maximumTimeMs,
                                       juce::jmax(manualTimeMs, rightManualTimeMs));

        const int mode = automateDelay
            ? 1
            : juce::jlimit(0, 2, static_cast<int>(std::round(
                delayMode.load(std::memory_order_relaxed))));
        if (mode == 1)
        {
            const float saturation = 0.08f + modulation * 0.55f;
            maximumTimeMs += 1.8f * (0.25f + saturation * 0.75f);
        }
        return juce::jmin(rackDelay.getMaximumSupportedDelaySeconds() * 1000.0f,
                          maximumTimeMs);
    }();
    addFeedbackTail(automateDelay || delayEnabled.load(std::memory_order_relaxed) >= 0.5f,
                    automateDelay ? 1.0f : delayMix.load(std::memory_order_relaxed),
                    effectiveDelayTimeMs,
                    automateDelay ? 0.85f
                                  : juce::jlimit(0.0f, 0.85f, delayFeedback.load(std::memory_order_relaxed)));

    const bool automateReverb = (moduleMask & tailAutomationReverb) != 0;
    if ((automateReverb || reverbEnabled.load(std::memory_order_relaxed) >= 0.5f)
        && (automateReverb || reverbMix.load(std::memory_order_relaxed) > 0.0001f))
    {
        const float decay = automateReverb
            ? 12.0f
            : juce::jlimit(0.2f, 12.0f, reverbDecaySec.load(std::memory_order_relaxed));
        const float preDelayMs = automateReverb
            ? 500.0f
            : juce::jlimit(0.0f, 500.0f, reverbPreDelayMs.load(std::memory_order_relaxed));
        const float mix = automateReverb
            ? 1.0f
            : juce::jlimit(0.0f, 1.0f, reverbMix.load(std::memory_order_relaxed));
        const float roomSize = juce::jlimit(0.18f, 0.92f, decay / 8.0f);
        tailSeconds += S13Reverb::calculateTailLengthSeconds(
            static_cast<int>(S13Reverb::Algorithm::Plate),
            roomSize,
            mix,
            mix * 0.28f,
            false,
            preDelayMs,
            decay,
            cachedSampleRate);
    }

    const bool automateModulator = (moduleMask & tailAutomationModulator) != 0;
    if ((automateModulator || modulatorEnabled.load(std::memory_order_relaxed) >= 0.5f)
        && (automateModulator || chorusMix.load(std::memory_order_relaxed) > 0.0001f))
    {
        const int mode = automateModulator
            ? 1
            : juce::jlimit(0, 1, static_cast<int>(std::round(
                modulatorMode.load(std::memory_order_relaxed))));
        const double feedback = automateModulator
            ? 1.0
            : juce::jlimit(0.0, 1.0,
                static_cast<double>(modulatorFeedback.load(std::memory_order_relaxed)));
        const double effectiveFeedback = mode == 1
            ? 0.08 + feedback * 0.72
            : feedback * 0.16;
        const double maximumDelaySeconds = mode == 1 ? 0.006 : 0.027;
        const double repeatsToMinus60 = effectiveFeedback > 0.0001
            ? std::log(0.001) / std::log(effectiveFeedback)
            : 1.0;
        tailSeconds += maximumDelaySeconds * juce::jmax(1.0, repeatsToMinus60);
    }

    if (((moduleMask & tailAutomationCab) != 0
         || cabEnabled.load(std::memory_order_relaxed) >= 0.5f)
        && cabIRLoaded.load(std::memory_order_acquire))
    {
        tailSeconds += cabIRDurationSeconds.load(std::memory_order_relaxed);
    }

    // These modules are serial, so their conservative decay windows add rather
    // than compete. Processing latency is deliberately separate from this tail.
    return juce::jlimit(0.0, 600.0, tailSeconds);
}

double S13NAMRack::getMaximumAutomatedTailLengthSeconds() const
{
    return getAutomatedTailLengthSeconds(
        tailAutomationTapeEcho | tailAutomationDelay | tailAutomationReverb
        | tailAutomationModulator | tailAutomationCab);
}

void S13NAMRack::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    const juce::ScopedLock processorConfigurationLock(getCallbackLock());
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    cachedBlockSize = juce::jmax(1, samplesPerBlock);
    const auto resetLiveSmoother = [this] (auto& smoother, float value)
    {
        smoother.reset(cachedSampleRate, 0.02);
        smoother.setCurrentAndTargetValue(value);
    };
    resetLiveSmoother(
        smoothedInputGain,
        juce::Decibels::decibelsToGain(
            juce::jlimit(-24.0f, 24.0f, inputTrimDb.load(std::memory_order_relaxed))));
    resetLiveSmoother(
        smoothedOutputGain,
        juce::Decibels::decibelsToGain(
            juce::jlimit(-24.0f, 24.0f, outputTrimDb.load(std::memory_order_relaxed))));
    resetLiveSmoother(
        smoothedPedalMix,
        juce::jlimit(
            0.0f, 1.0f, pedalMix.load(std::memory_order_relaxed)));
    resetLiveSmoother(
        smoothedAmpMix,
        juce::jlimit(0.0f, 1.0f, ampMix.load(std::memory_order_relaxed)));
    resetLiveSmoother(
        smoothedAmpPowerMix,
        ampEnabled.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f);
    smoothedAmpInputGain.reset(cachedSampleRate, 0.02);
    smoothedAmpInputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-24.0f, 24.0f, ampGainDb.load(std::memory_order_relaxed))
                                       + (ampBoost.load(std::memory_order_relaxed) >= 0.5f ? 6.0f : 0.0f)));
    smoothedAmpOutputGain.reset(cachedSampleRate, 0.02);
    smoothedAmpOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-24.0f, 12.0f, ampOutputDb.load(std::memory_order_relaxed))));
    smoothedCabMix.reset(cachedSampleRate, 0.02);
    smoothedCabMix.setCurrentAndTargetValue(
        cabIRLoaded.load(std::memory_order_acquire)
                && cabEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    resetLiveSmoother(
        smoothedCabLevelGain,
        juce::Decibels::decibelsToGain(
            juce::jlimit(-24.0f, 12.0f, cabLevelDb.load(std::memory_order_relaxed))));
    resetLiveSmoother(
        smoothedPrecisionDrivePower,
        precisionDriveEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    resetLiveSmoother(
        smoothedPrecisionDriveVolumeGain,
        juce::Decibels::decibelsToGain(juce::jlimit(
            -24.0f,
            12.0f,
            precisionDriveVolumeDb.load(std::memory_order_relaxed))));
    resetLiveSmoother(
        smoothedChaosPower,
        chaosEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    resetLiveSmoother(
        smoothedChaosLevelGain,
        juce::Decibels::decibelsToGain(
            juce::jlimit(-12.0f, 12.0f,
                         chaosLevelDb.load(std::memory_order_relaxed))));
    resetLiveSmoother(
        smoothedEmbeddedDriveIslandPower,
        precisionDriveEnabled.load(
            std::memory_order_relaxed) >= 0.5f
                || (chaosEnabled.load(
                        std::memory_order_relaxed) >= 0.5f
                    && chaosMix.load(
                        std::memory_order_relaxed) > 0.0001f)
            ? 1.0f
            : 0.0f);
    const bool octaverIsEnabled =
        octaverEnabled.load(std::memory_order_relaxed) >= 0.5f;
    resetLiveSmoother(
        smoothedOctaverDownMix,
        octaverIsEnabled
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  octaverDownMix.load(std::memory_order_relaxed))
            : 0.0f);
    resetLiveSmoother(
        smoothedOctaverUpMix,
        octaverIsEnabled
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  octaverUpMix.load(std::memory_order_relaxed))
            : 0.0f);
    resetLiveSmoother(
        smoothedOctaverDirectMix,
        octaverIsEnabled
            ? juce::jlimit(
                  0.0f,
                  1.25f,
                  octaverDirectMix.load(std::memory_order_relaxed))
            : 1.0f);
    resetLiveSmoother(
        smoothedLaserMix,
        laserEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  laserMix.load(std::memory_order_relaxed))
            : 0.0f);
    realtimeBufferCapacity = getNAMRackRealtimeCapacity(cachedBlockSize);
    const int resampledCapacity = getNAMRackDspFrameCapacity(realtimeBufferCapacity, cachedSampleRate, cachedSampleRate * 4.0);

    workBuffer.setSize(2, realtimeBufferCapacity, false, false, true);
    namInputBuffer.setSize(2, realtimeBufferCapacity + kNAMRackResamplerGuardSamples, false, false, true);
    namOutputBuffer.setSize(2, realtimeBufferCapacity + kNAMRackResamplerGuardSamples, false, false, true);
    namResampledInputBuffer.setSize(2, resampledCapacity, false, false, true);
    namResampledOutputBuffer.setSize(2, resampledCapacity + kNAMRackResamplerGuardSamples, false, false, true);
    namTransitionBuffer.setSize(2, realtimeBufferCapacity, false, false, true);
    ampBypassBuffer.setSize(2, realtimeBufferCapacity, false, false, true);
    liveTransitionBuffer.setSize(3, realtimeBufferCapacity, false, false, true);
    const int embeddedDriveHighRateCapacity =
        realtimeBufferCapacity * 2;
    embeddedDriveSharedDryBuffer.setSize(
        2, realtimeBufferCapacity, false, false, true);
    precisionDriveBypassBuffer.setSize(
        2,
        embeddedDriveHighRateCapacity,
        false,
        false,
        true);
    chaosBypassBuffer.setSize(
        2,
        embeddedDriveHighRateCapacity,
        false,
        false,
        true);
    embeddedDriveSharedDryBuffer.clear();
    precisionDriveBypassBuffer.clear();
    chaosBypassBuffer.clear();
    namInputPtrs.resize(2);
    namOutputPtrs.resize(2);

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = cachedSampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(cachedBlockSize);
    spec.numChannels = 1;
    lowShelfL.prepare(spec);
    lowShelfR.prepare(spec);
    midPeakL.prepare(spec);
    midPeakR.prepare(spec);
    highShelfL.prepare(spec);
    highShelfR.prepare(spec);
    presenceShelfL.prepare(spec);
    presenceShelfR.prepare(spec);
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        graphicEqL[static_cast<size_t>(band)].prepare(spec);
        graphicEqR[static_cast<size_t>(band)].prepare(spec);
    }
    cabHPFL.prepare(spec);
    cabHPFR.prepare(spec);
    cabLPFL.prepare(spec);
    cabLPFR.prepare(spec);
    lowShelfL.reset();
    lowShelfR.reset();
    midPeakL.reset();
    midPeakR.reset();
    highShelfL.reset();
    highShelfR.reset();
    presenceShelfL.reset();
    presenceShelfR.reset();
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        graphicEqL[static_cast<size_t>(band)].reset();
        graphicEqR[static_cast<size_t>(band)].reset();
    }
    cabHPFL.reset();
    cabHPFR.reset();
    cabLPFL.reset();
    cabLPFR.reset();
    resetCabMicState();

    juce::dsp::ProcessSpec convolutionSpec;
    convolutionSpec.sampleRate = cachedSampleRate;
    convolutionSpec.maximumBlockSize = static_cast<juce::uint32>(cachedBlockSize);
    convolutionSpec.numChannels = 2;
    {
        const juce::ScopedLock lock(cabIRLock);
        if (cabIR != nullptr)
        {
            // Device reconfiguration is already protected by the processor
            // callback lock. End any old-engine transition and synchronously
            // prepare the currently published IR for the new host format.
            cabIR->transitionFrom = nullptr;
            cabIR->transitionSamplesRemaining.store(0, std::memory_order_release);
            cabIR->convolution.prepare(convolutionSpec);
            cabIR->convolution.reset();
            cabIR->preparedHostSampleRate = cachedSampleRate;
            cabIR->preparedHostBlockSize = cachedBlockSize;
            cabIR->preparedIRSize = cabIR->convolution.getCurrentIRSize();
        }
    }
    syncEmbeddedProcessorParameters();
    rackCompressor.prepareToPlay(cachedSampleRate, cachedBlockSize);
    rackTapeEcho.prepareToPlay(cachedSampleRate, cachedBlockSize);
    const double embeddedDriveSampleRate =
        cachedSampleRate * 2.0;
    rackPrecisionDrive.prepareToPlay(
        embeddedDriveSampleRate,
        embeddedDriveHighRateCapacity);
    rackChaos.prepareToPlay(
        embeddedDriveSampleRate,
        embeddedDriveHighRateCapacity);
    rackPrecisionDrive.setOversamplingEnabled(false);
    rackChaos.setOversamplingEnabled(false);
    smoothedPrecisionDrivePower.reset(
        embeddedDriveSampleRate, 0.02);
    smoothedPrecisionDrivePower.setCurrentAndTargetValue(
        precisionDriveEnabled.load(
            std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    smoothedPrecisionDriveVolumeGain.reset(
        embeddedDriveSampleRate, 0.02);
    smoothedPrecisionDriveVolumeGain
        .setCurrentAndTargetValue(
            juce::Decibels::decibelsToGain(
                juce::jlimit(
                    -24.0f,
                    12.0f,
                    precisionDriveVolumeDb.load(
                        std::memory_order_relaxed))));
    smoothedChaosPower.reset(
        embeddedDriveSampleRate, 0.02);
    smoothedChaosPower.setCurrentAndTargetValue(
        chaosEnabled.load(
            std::memory_order_relaxed) >= 0.5f
                && chaosMix.load(
                    std::memory_order_relaxed) > 0.0001f
            ? 1.0f
            : 0.0f);
    smoothedChaosLevelGain.reset(
        embeddedDriveSampleRate, 0.02);
    smoothedChaosLevelGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(-12.0f, 12.0f,
                         chaosLevelDb.load(std::memory_order_relaxed))));

    embeddedDriveOversampler2x =
        std::make_unique<
            juce::dsp::Oversampling<float>>(
            2,
            1,
            juce::dsp::Oversampling<float>::
                filterHalfBandPolyphaseIIR,
            false,
            true);
    embeddedDriveOversampler2x->initProcessing(
        static_cast<size_t>(
            realtimeBufferCapacity));
    embeddedDriveOversamplingLatencySamples =
        juce::jlimit(
            0,
            maximumEmbeddedDriveLatencySamples,
            static_cast<int>(std::round(
                embeddedDriveOversampler2x
                    ->getLatencyInSamples())));

    juce::dsp::ProcessSpec embeddedDriveDelaySpec;
    embeddedDriveDelaySpec.sampleRate =
        embeddedDriveSampleRate;
    embeddedDriveDelaySpec.maximumBlockSize =
        static_cast<juce::uint32>(
            embeddedDriveHighRateCapacity);
    embeddedDriveDelaySpec.numChannels = 2;
    precisionDriveBypassDelay.prepare(embeddedDriveDelaySpec);
    chaosBypassDelay.prepare(embeddedDriveDelaySpec);
    precisionDriveBypassDelay.setDelay(0.0f);
    chaosBypassDelay.setDelay(0.0f);
    precisionDriveBypassDelay.reset();
    chaosBypassDelay.reset();

    for (auto& channel :
         embeddedDriveSharedDryRing)
        channel.fill(0.0f);
    embeddedDriveSharedDryWriteIndex = 0;
    compressorWasActive = false;
    tapeEchoWasActive = false;
    octaverWasActive = false;
    precisionDriveWasActive = false;
    chaosWasActive = false;
    laserWasActive = false;
    cabWasActive = false;
    modulationWasActive = false;
    modulationBypassDrainSamples = 0;
    delayWasActive = false;
    reverbWasActive = false;
    tapeEchoTailSamplesRemaining = 0;
    delayTailSamplesRemaining = 0;
    reverbTailSamplesRemaining = 0;
    tapeEchoTailMix = 0.0f;
    delayTailMix = 0.0f;
    reverbTailWet = 0.0f;
    reverbTailEarly = 0.0f;
    resetOctaverState();
    resetLaserState();
    precisionDriveGateEnvelope = 0.0f;
    precisionDriveGateGain = 1.0f;
    resetAmpFaceplateState();
    rackChorus.prepareToPlay(cachedSampleRate, cachedBlockSize);
    rackDelay.setPlayHead(getPlayHead());
    rackDelay.prepareToPlay(cachedSampleRate, cachedBlockSize);
    rackReverb.prepareToPlay(cachedSampleRate, cachedBlockSize);
    lastBassDb = lastMidDb = lastTrebleDb = lastPresenceDb = 999.0f;
    lastGraphicEqDb.fill(999.0f);
    lastCabHPFHz = -1.0f;
    lastCabLPFHz = -1.0f;
    rackFilterCoefficientsInitialised = false;
    graphicEqCoefficientsSmoothing = false;
    cabFilterCoefficientsSmoothing = false;
    gateEnvelope = 0.0f;
    gateGain = 1.0f;
    auditionSourceSample = 0;
    {
        const juce::ScopedLock lock(modelSwapLock);
        auto resetModelForHost = [this] (const std::shared_ptr<LoadedNAMModel>& model)
        {
            if (model == nullptr || model->dsp == nullptr)
                return;
            const double modelSampleRate = model->expectedSampleRate > 1000.0
                ? model->expectedSampleRate
                : cachedSampleRate;
            const double sampleRateRatio = modelSampleRate / juce::jmax(1.0, cachedSampleRate);
            if (sampleRateRatio < (1.0 / kNAMRackMaximumResampleRatio)
                || sampleRateRatio > kNAMRackMaximumResampleRatio)
            {
                model->processFaulted.store(true, std::memory_order_relaxed);
                return;
            }
            const int processBlockSize = getNAMRackDspFrameCapacity(realtimeBufferCapacity,
                                                                     cachedSampleRate,
                                                                     modelSampleRate);
            model->dsp->ResetAndPrewarm(modelSampleRate, processBlockSize);
            model->processFaulted.store(false, std::memory_order_relaxed);
            resetModelStreamingState(*model, cachedSampleRate, modelSampleRate, realtimeBufferCapacity);
            model->preparedHostSampleRate = cachedSampleRate;
            model->preparedHostBufferCapacity = realtimeBufferCapacity;
            model->transitionSamplesRemaining.store(0, std::memory_order_relaxed);
        };
        resetModelForHost(pedalModel);
        resetModelForHost(ampModel);
    }
    inputLevelDb.store(-90.0f, std::memory_order_relaxed);
    outputLevelDb.store(-90.0f, std::memory_order_relaxed);
    inputMeterHoldSamplesRemaining = 0;
    outputMeterHoldSamplesRemaining = 0;
    diagnosticPreparedBlockSize.store(cachedBlockSize, std::memory_order_relaxed);
    diagnosticBufferCapacity.store(realtimeBufferCapacity, std::memory_order_relaxed);
    diagnosticLastBlockSize.store(0, std::memory_order_relaxed);
    diagnosticMaxBlockSize.store(0, std::memory_order_relaxed);
    diagnosticProcessedBlockCount.store(0, std::memory_order_relaxed);
    diagnosticLastDspFrames.store(0, std::memory_order_relaxed);
    diagnosticMaxDspFrames.store(0, std::memory_order_relaxed);
    diagnosticPreparedSampleRate.store(static_cast<float>(cachedSampleRate), std::memory_order_relaxed);
    diagnosticLastModelSampleRate.store(0.0f, std::memory_order_relaxed);
    diagnosticLastInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastRawInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastOutputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastAuditionSourceActive.store(false, std::memory_order_relaxed);
    diagnosticLastAuditionSourceRendered.store(false, std::memory_order_relaxed);
    diagnosticLastResampled.store(false, std::memory_order_relaxed);
    diagnosticAudioThreadResizeAvoidedCount.store(0, std::memory_order_relaxed);
    diagnosticOversizeBypassCount.store(0, std::memory_order_relaxed);
    diagnosticModelProcessFailCount.store(0, std::memory_order_relaxed);
    diagnosticObservedTightBlockSize.store(0, std::memory_order_relaxed);
    diagnosticRealtimeSafetyBypassCount.store(0, std::memory_order_relaxed);
    diagnosticRealtimeDSPBlocked.store(false, std::memory_order_relaxed);
    prepareFilterTargetTables();
    updateToneFiltersIfNeeded();
    updateGraphicEQFiltersIfNeeded();
    updateCabFiltersIfNeeded();
    rackFilterCoefficientsInitialised = true;
    updateReportedLatency();

    // Coefficient updates above switch the filters from their default
    // first-order identity state to biquads. Reset once here so JUCE grows the
    // filter state on the message thread, never on the first audio callback.
    lowShelfL.reset();
    lowShelfR.reset();
    midPeakL.reset();
    midPeakR.reset();
    highShelfL.reset();
    highShelfR.reset();
    presenceShelfL.reset();
    presenceShelfR.reset();
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        graphicEqL[static_cast<size_t>(band)].reset();
        graphicEqR[static_cast<size_t>(band)].reset();
    }
    cabHPFL.reset();
    cabHPFR.reset();
    cabLPFL.reset();
    cabLPFR.reset();
}

void S13NAMRack::releaseResources()
{
    inputLevelDb.store(-90.0f, std::memory_order_relaxed);
    outputLevelDb.store(-90.0f, std::memory_order_relaxed);
    inputMeterHoldSamplesRemaining = 0;
    outputMeterHoldSamplesRemaining = 0;
    diagnosticLastInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastRawInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastOutputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastAuditionSourceActive.store(false, std::memory_order_relaxed);
    diagnosticLastAuditionSourceRendered.store(false, std::memory_order_relaxed);
    workBuffer.setSize(0, 0);
    namInputBuffer.setSize(0, 0);
    namOutputBuffer.setSize(0, 0);
    namResampledInputBuffer.setSize(0, 0);
    namResampledOutputBuffer.setSize(0, 0);
    namTransitionBuffer.setSize(0, 0);
    ampBypassBuffer.setSize(0, 0);
    liveTransitionBuffer.setSize(0, 0);
    embeddedDriveSharedDryBuffer.setSize(0, 0);
    precisionDriveBypassBuffer.setSize(0, 0);
    chaosBypassBuffer.setSize(0, 0);
    if (embeddedDriveOversampler2x != nullptr)
        embeddedDriveOversampler2x->reset();
    for (auto& channel :
         embeddedDriveSharedDryRing)
        channel.fill(0.0f);
    embeddedDriveSharedDryWriteIndex = 0;
    precisionDriveBypassDelay.reset();
    chaosBypassDelay.reset();
    resetLaserState();
    smoothedLaserMix.setCurrentAndTargetValue(0.0f);
    laserWasActive = false;
    resetAmpFaceplateState();
    lowShelfL.reset();
    lowShelfR.reset();
    midPeakL.reset();
    midPeakR.reset();
    highShelfL.reset();
    highShelfR.reset();
    presenceShelfL.reset();
    presenceShelfR.reset();
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        graphicEqL[static_cast<size_t>(band)].reset();
        graphicEqR[static_cast<size_t>(band)].reset();
    }
    cabHPFL.reset();
    cabHPFR.reset();
    cabLPFL.reset();
    cabLPFR.reset();
    resetCabMicState();
    {
        const juce::ScopedLock lock(cabIRLock);
        if (cabIR != nullptr)
        {
            cabIR->convolution.reset();
            cabIR->transitionFrom = nullptr;
            cabIR->transitionSamplesRemaining.store(0, std::memory_order_release);
        }
    }
    rackCompressor.releaseResources();
    rackTapeEcho.releaseResources();
    rackPrecisionDrive.releaseResources();
    rackChaos.releaseResources();
    compressorWasActive = false;
    tapeEchoWasActive = false;
    octaverWasActive = false;
    precisionDriveWasActive = false;
    chaosWasActive = false;
    cabWasActive = false;
    modulationWasActive = false;
    modulationBypassDrainSamples = 0;
    delayWasActive = false;
    reverbWasActive = false;
    tapeEchoTailSamplesRemaining = 0;
    delayTailSamplesRemaining = 0;
    reverbTailSamplesRemaining = 0;
    tapeEchoTailMix = 0.0f;
    delayTailMix = 0.0f;
    reverbTailWet = 0.0f;
    reverbTailEarly = 0.0f;
    smoothedOctaverDownMix.setCurrentAndTargetValue(0.0f);
    smoothedOctaverUpMix.setCurrentAndTargetValue(0.0f);
    smoothedOctaverDirectMix.setCurrentAndTargetValue(1.0f);
    resetOctaverState();
    precisionDriveGateEnvelope = 0.0f;
    precisionDriveGateGain = 1.0f;
    rackChorus.releaseResources();
    rackDelay.releaseResources();
    rackReverb.releaseResources();
}

void S13NAMRack::syncEmbeddedProcessorParameters() noexcept
{
    const float compressorAmount = juce::jlimit(0.0f, 1.0f,
        compressorComp.load(std::memory_order_relaxed));
    const float compressorDetailValue = juce::jlimit(0.0f, 1.0f,
        compressorDetail.load(std::memory_order_relaxed));
    const float compressorVolume = juce::jlimit(-12.0f, 12.0f,
        compressorVolumeDb.load(std::memory_order_relaxed));
    rackCompressor.threshold.store(-6.0f - compressorAmount * 38.0f, std::memory_order_relaxed);
    rackCompressor.ratio.store(1.2f + compressorAmount * 8.8f, std::memory_order_relaxed);
    rackCompressor.attack.store(2.0f + (1.0f - compressorDetailValue) * 28.0f, std::memory_order_relaxed);
    rackCompressor.release.store(70.0f + compressorDetailValue * 260.0f, std::memory_order_relaxed);
    rackCompressor.knee.store(5.0f + (1.0f - compressorAmount) * 10.0f, std::memory_order_relaxed);
    rackCompressor.makeupGain.store(juce::jmax(0.0f, compressorVolume), std::memory_order_relaxed);
    rackCompressor.mix.store(juce::jlimit(0.0f, 1.0f, compressorMix.load(std::memory_order_relaxed)),
                             std::memory_order_relaxed);
    rackCompressor.style.store(1.0f, std::memory_order_relaxed);
    rackCompressor.autoMakeup.store(0.0f, std::memory_order_relaxed);
    rackCompressor.autoRelease.store(0.0f, std::memory_order_relaxed);
    rackCompressor.sidechainHPF.store(90.0f, std::memory_order_relaxed);
    rackCompressor.lookaheadMs.store(0.0f, std::memory_order_relaxed);
    rackCompressor.detectorMode.store(2.0f, std::memory_order_relaxed);
    rackCompressor.stereoLink.store(1.0f, std::memory_order_relaxed);

    const float tapeTime = juce::jlimit(20.0f, 1200.0f,
        tapeEchoTimeMs.load(std::memory_order_relaxed));
    const float tapeMod = juce::jlimit(0.0f, 1.0f,
        tapeEchoMod.load(std::memory_order_relaxed));
    const float tapeTone = juce::jlimit(0.0f, 1.0f,
        tapeEchoTone.load(std::memory_order_relaxed));
    rackTapeEcho.delayTimeL.store(tapeTime, std::memory_order_relaxed);
    rackTapeEcho.delayTimeR.store(juce::jlimit(20.0f, 1200.0f, tapeTime * (1.01f + tapeMod * 0.035f)),
                                  std::memory_order_relaxed);
    rackTapeEcho.feedback.store(juce::jlimit(0.0f, 0.85f,
        tapeEchoFeedback.load(std::memory_order_relaxed)), std::memory_order_relaxed);
    rackTapeEcho.crossFeed.store(0.05f + tapeMod * 0.12f, std::memory_order_relaxed);
    const bool tapeEchoActive = tapeEchoEnabled.load(std::memory_order_relaxed) >= 0.5f;
    rackTapeEcho.mix.store(tapeEchoActive
        ? juce::jlimit(0.0f, 1.0f, tapeEchoMix.load(std::memory_order_relaxed))
        : 0.0f, std::memory_order_relaxed);
    rackTapeEcho.pingPong.store(0.0f, std::memory_order_relaxed);
    rackTapeEcho.tempoSync.store(0.0f, std::memory_order_relaxed);
    rackTapeEcho.lpfFreq.store(2600.0f + tapeTone * 11200.0f, std::memory_order_relaxed);
    rackTapeEcho.hpfFreq.store(45.0f + (1.0f - tapeTone) * 210.0f, std::memory_order_relaxed);
    rackTapeEcho.fbSaturation.store(0.16f + tapeMod * 0.46f, std::memory_order_relaxed);
    rackTapeEcho.stereoWidth.store(0.82f + tapeMod * 0.34f, std::memory_order_relaxed);
    rackTapeEcho.delayMode.store(1.0f, std::memory_order_relaxed);
    rackTapeEcho.ducking.store(0.0f, std::memory_order_relaxed);

    const float precisionDriveAmount = juce::jlimit(0.0f, 1.0f,
        precisionDriveDrive.load(std::memory_order_relaxed));
    const float precisionBright = juce::jlimit(0.0f, 1.0f,
        precisionDriveBright.load(std::memory_order_relaxed));
    const float precisionAttack = juce::jlimit(0.0f, 1.0f,
        precisionDriveAttack.load(std::memory_order_relaxed));
    rackPrecisionDrive.satType.store(
        static_cast<float>(S13Saturator::SatType::Transistor),
        std::memory_order_relaxed);
    rackPrecisionDrive.drive.store(
        6.0f + precisionDriveAmount * 21.0f,
        std::memory_order_relaxed);
    rackPrecisionDrive.mix.store(
        0.90f + precisionDriveAmount * 0.10f,
        std::memory_order_relaxed);
    rackPrecisionDrive.toneFreq.store(2600.0f + precisionBright * 12600.0f, std::memory_order_relaxed);
    rackPrecisionDrive.lowCutFreq.store(70.0f + precisionAttack * precisionAttack * 760.0f, std::memory_order_relaxed);
    rackPrecisionDrive.outputGain.store(
        getNAMPrecisionDriveOutputGainDb(
            false,
            precisionDriveAmount,
            namEffectsDspVersion.load(
                std::memory_order_relaxed)),
        std::memory_order_relaxed);
    rackPrecisionDrive.asymmetry.store(
        0.06f + precisionDriveAmount * 0.22f,
        std::memory_order_relaxed);
    rackPrecisionDrive.oversampleMode.store(0.0f, std::memory_order_relaxed);

    const float chaosDriveValue = juce::jlimit(
        0.0f, 1.0f, chaosDrive.load(std::memory_order_relaxed));
    const float chaosToneValue = juce::jlimit(
        0.0f, 1.0f, chaosTone.load(std::memory_order_relaxed));
    const float chaosWet = juce::jlimit(
        0.0f, 1.0f, chaosMix.load(std::memory_order_relaxed));
    rackChaos.satType.store(
        static_cast<float>(S13Saturator::SatType::DiodeClipper),
        std::memory_order_relaxed);
    rackChaos.drive.store(
        12.0f + chaosDriveValue * 18.0f,
        std::memory_order_relaxed);
    rackChaos.mix.store(chaosWet, std::memory_order_relaxed);
    rackChaos.toneFreq.store(
        2100.0f + chaosToneValue * 12900.0f,
        std::memory_order_relaxed);
    rackChaos.lowCutFreq.store(
        70.0f + (1.0f - chaosToneValue) * 180.0f,
        std::memory_order_relaxed);
    rackChaos.outputGain.store(
        -1.5f - chaosDriveValue * 1.5f,
        std::memory_order_relaxed);
    rackChaos.asymmetry.store(
        0.12f + chaosDriveValue * 0.24f,
        std::memory_order_relaxed);
    rackChaos.oversampleMode.store(0.0f, std::memory_order_relaxed);

    const int modulationModeValue = juce::jlimit(0, 1, static_cast<int>(std::round(
        modulatorMode.load(std::memory_order_relaxed))));
    const float modulationFeedbackValue = juce::jlimit(0.0f, 1.0f,
        modulatorFeedback.load(std::memory_order_relaxed));
    const float modulationRandom = juce::jlimit(0.0f, 1.0f,
        modulatorAutoRandom.load(std::memory_order_relaxed));
    const float modulationSpeed = juce::jlimit(0.0f, 1.0f,
        modulatorAutoSpeed.load(std::memory_order_relaxed));
    const bool modulationAuto = modulatorPedalMode.load(std::memory_order_relaxed) >= 0.5f;
    const float pedalPosition = juce::jlimit(0.0f, 1.0f,
        modulatorPedalPosition.load(std::memory_order_relaxed));
    const float sweep = modulationAuto ? modulationRandom : pedalPosition * 0.5f;
    const float rateScale = modulationAuto ? (0.72f + modulationSpeed * 1.55f)
                                           : (0.55f + pedalPosition * 1.65f);
    const float modulationDepthValue = juce::jlimit(0.0f, 1.0f,
        chorusDepth.load(std::memory_order_relaxed));
    const float effectiveDepth = modulationAuto
        ? juce::jlimit(0.0f, 1.0f, modulationDepthValue + modulationRandom * 0.12f)
        : juce::jlimit(0.0f, 1.0f, modulationDepthValue * (0.35f + pedalPosition * 0.9f));
    const float effectiveFeedback = modulationAuto
        ? modulationFeedbackValue
        : juce::jlimit(0.0f, 1.0f, modulationFeedbackValue * (0.45f + pedalPosition * 1.1f));
    rackChorus.mode.store(static_cast<float>(modulationModeValue), std::memory_order_relaxed);
    rackChorus.rate.store(juce::jlimit(0.05f, 8.0f,
        chorusRateHz.load(std::memory_order_relaxed) * rateScale), std::memory_order_relaxed);
    rackChorus.depth.store(effectiveDepth, std::memory_order_relaxed);
    rackChorus.mix.store(juce::jlimit(0.0f, 1.0f, chorusMix.load(std::memory_order_relaxed)),
                         std::memory_order_relaxed);
    rackChorus.inputSend.store(1.0f, std::memory_order_relaxed);
    rackChorus.fbAmount.store(modulationModeValue == 1
        ? (0.08f + effectiveFeedback * 0.72f)
        : (effectiveFeedback * 0.16f), std::memory_order_relaxed);
    rackChorus.voices.store(modulationModeValue == 1 ? 2.0f : 5.0f,
                            std::memory_order_relaxed);
    rackChorus.lfoShape.store(0.0f, std::memory_order_relaxed);
    rackChorus.randomBlend.store(
        modulationAuto ? modulationRandom : 0.0f,
        std::memory_order_relaxed);
    rackChorus.spread.store(modulationModeValue == 1 ? 0.58f : 0.72f + sweep * 0.18f,
                            std::memory_order_relaxed);
    rackChorus.highCut.store(modulationModeValue == 1 ? 9200.0f : 12000.0f,
                             std::memory_order_relaxed);
    rackChorus.lowCut.store(modulationModeValue == 1 ? 120.0f : 90.0f,
                            std::memory_order_relaxed);
    rackChorus.characterMode.store(
        static_cast<float>(juce::jlimit(
            0,
            2,
            static_cast<int>(std::round(
                chorusCharacter.load(
                    std::memory_order_relaxed))))),
        std::memory_order_relaxed);
    rackChorus.mixLaw.store(
        namEffectsDspVersion.load(
            std::memory_order_relaxed) >= 2
            ? 1.0f
            : 0.0f,
        std::memory_order_relaxed);

    const float postDelayTime = juce::jlimit(1.0f, 2000.0f,
        delayTimeMs.load(std::memory_order_relaxed));
    const float postDelayMod = juce::jlimit(0.0f, 1.0f,
        delayMod.load(std::memory_order_relaxed));
    const bool postDelayPingPong = delayPingPong.load(std::memory_order_relaxed) >= 0.5f;
    const int postDelayMode = juce::jlimit(0, 2, static_cast<int>(std::round(
        delayMode.load(std::memory_order_relaxed))));
    rackDelay.delayTimeL.store(postDelayTime, std::memory_order_relaxed);
    rackDelay.delayTimeR.store(juce::jlimit(1.0f, 2000.0f,
        postDelayTime * (postDelayPingPong ? 1.18f : 1.0f)), std::memory_order_relaxed);
    rackDelay.feedback.store(juce::jlimit(0.0f, 0.85f,
        delayFeedback.load(std::memory_order_relaxed)), std::memory_order_relaxed);
    rackDelay.crossFeed.store(postDelayPingPong ? 0.12f + postDelayMod * 0.16f : 0.02f,
                              std::memory_order_relaxed);
    rackDelay.mix.store(juce::jlimit(0.0f, 1.0f, delayMix.load(std::memory_order_relaxed)),
                        std::memory_order_relaxed);
    rackDelay.pingPong.store(postDelayPingPong ? 1.0f : 0.0f, std::memory_order_relaxed);
    rackDelay.tempoSync.store(delayTempoSync.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f,
                              std::memory_order_relaxed);
    rackDelay.syncNoteL.store(juce::jlimit(0.0f, 8.0f, 2.0f + postDelayMod * 2.0f),
                              std::memory_order_relaxed);
    rackDelay.syncNoteR.store(juce::jlimit(0.0f, 8.0f,
        postDelayPingPong ? 3.0f + postDelayMod * 2.0f : 2.0f + postDelayMod * 2.0f),
        std::memory_order_relaxed);
    rackDelay.lpfFreq.store(postDelayMode == 0 ? 12000.0f
        : (4300.0f + (1.0f - postDelayMod) * 4200.0f), std::memory_order_relaxed);
    rackDelay.hpfFreq.store(70.0f + postDelayMod * 110.0f, std::memory_order_relaxed);
    rackDelay.fbSaturation.store(0.08f + postDelayMod * 0.55f, std::memory_order_relaxed);
    rackDelay.stereoWidth.store(postDelayPingPong ? 1.15f + postDelayMod * 0.18f : 0.92f,
                                std::memory_order_relaxed);
    rackDelay.delayMode.store(static_cast<float>(postDelayMode), std::memory_order_relaxed);
    rackDelay.ducking.store(juce::jlimit(0.0f, 1.0f, delayDucker.load(std::memory_order_relaxed)),
                            std::memory_order_relaxed);

    const float reverbToneValue = juce::jlimit(0.0f, 1.0f,
        reverbTone.load(std::memory_order_relaxed));
    const float reverbDecay = juce::jlimit(0.2f, 12.0f,
        reverbDecaySec.load(std::memory_order_relaxed));
    rackReverb.algorithm.store(2.0f, std::memory_order_relaxed);
    rackReverb.roomSize.store(juce::jlimit(0.18f, 0.92f, reverbDecay / 8.0f),
                              std::memory_order_relaxed);
    rackReverb.damping.store(1.0f - reverbToneValue * 0.82f,
                             std::memory_order_relaxed);
    rackReverb.wetLevel.store(juce::jlimit(0.0f, 1.0f, reverbMix.load(std::memory_order_relaxed)),
                              std::memory_order_relaxed);
    rackReverb.dryLevel.store(1.0f, std::memory_order_relaxed);
    rackReverb.width.store(1.0f, std::memory_order_relaxed);
    rackReverb.freezeMode.store(0.0f, std::memory_order_relaxed);
    rackReverb.preDelay.store(juce::jlimit(0.0f, 500.0f,
        reverbPreDelayMs.load(std::memory_order_relaxed)), std::memory_order_relaxed);
    rackReverb.diffusion.store(0.72f, std::memory_order_relaxed);
    rackReverb.lowCut.store(
        juce::jlimit(
            20.0f,
            500.0f,
            reverbLowCutHz.load(
                std::memory_order_relaxed)),
        std::memory_order_relaxed);
    rackReverb.highCut.store(juce::jlimit(2800.0f, 18000.0f,
        3800.0f + reverbToneValue * 9200.0f),
        std::memory_order_relaxed);
    const float recalledReverbMix = juce::jlimit(
        0.0f, 1.0f, reverbMix.load(std::memory_order_relaxed));
    rackReverb.earlyLevel.store(recalledReverbMix * 0.28f,
                                std::memory_order_relaxed);
    rackReverb.decayTime.store(reverbDecay, std::memory_order_relaxed);
    rackReverb.shimmerAmount.store(
        juce::jlimit(
            0.0f,
            1.0f,
            reverbShimmer.load(
                std::memory_order_relaxed)),
        std::memory_order_relaxed);
}

void S13NAMRack::reset()
{
    inputLevelDb.store(-90.0f, std::memory_order_relaxed);
    outputLevelDb.store(-90.0f, std::memory_order_relaxed);
    inputMeterHoldSamplesRemaining = 0;
    outputMeterHoldSamplesRemaining = 0;
    diagnosticLastInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastRawInputPeakDb.store(-90.0f, std::memory_order_relaxed);
    diagnosticLastOutputPeakDb.store(-90.0f, std::memory_order_relaxed);

    smoothedInputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(
            -24.0f, 24.0f, inputTrimDb.load(std::memory_order_relaxed))));
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(
            -24.0f, 24.0f, outputTrimDb.load(std::memory_order_relaxed))));
    smoothedPedalMix.setCurrentAndTargetValue(
        juce::jlimit(
            0.0f, 1.0f, pedalMix.load(std::memory_order_relaxed)));
    smoothedAmpMix.setCurrentAndTargetValue(
        juce::jlimit(0.0f, 1.0f, ampMix.load(std::memory_order_relaxed)));
    smoothedAmpPowerMix.setCurrentAndTargetValue(
        ampEnabled.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f);
    smoothedAmpInputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-24.0f, 24.0f,
            ampGainDb.load(std::memory_order_relaxed))
            + (ampBoost.load(std::memory_order_relaxed) >= 0.5f ? 6.0f : 0.0f)));
    smoothedAmpOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(-24.0f, 12.0f,
            ampOutputDb.load(std::memory_order_relaxed))));
    smoothedCabMix.setCurrentAndTargetValue(
        cabIRLoaded.load(std::memory_order_acquire)
                && cabEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    smoothedCabLevelGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(
            -24.0f, 12.0f, cabLevelDb.load(std::memory_order_relaxed))));
    smoothedPrecisionDrivePower.setCurrentAndTargetValue(
        precisionDriveEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    smoothedPrecisionDriveVolumeGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(juce::jlimit(
            -24.0f,
            12.0f,
            precisionDriveVolumeDb.load(std::memory_order_relaxed))));
    smoothedChaosPower.setCurrentAndTargetValue(
        chaosEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);
    smoothedChaosLevelGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(-12.0f, 12.0f,
                         chaosLevelDb.load(std::memory_order_relaxed))));
    smoothedEmbeddedDriveIslandPower
        .setCurrentAndTargetValue(
            precisionDriveEnabled.load(
                std::memory_order_relaxed) >= 0.5f
                    || (chaosEnabled.load(
                            std::memory_order_relaxed) >= 0.5f
                        && chaosMix.load(
                            std::memory_order_relaxed) > 0.0001f)
                ? 1.0f
                : 0.0f);
    const bool resetOctaverEnabled =
        octaverEnabled.load(std::memory_order_relaxed) >= 0.5f;
    smoothedOctaverDownMix.setCurrentAndTargetValue(
        resetOctaverEnabled
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  octaverDownMix.load(std::memory_order_relaxed))
            : 0.0f);
    smoothedOctaverUpMix.setCurrentAndTargetValue(
        resetOctaverEnabled
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  octaverUpMix.load(std::memory_order_relaxed))
            : 0.0f);
    smoothedOctaverDirectMix.setCurrentAndTargetValue(
        resetOctaverEnabled
            ? juce::jlimit(
                  0.0f,
                  1.25f,
                  octaverDirectMix.load(std::memory_order_relaxed))
            : 1.0f);
    smoothedLaserMix.setCurrentAndTargetValue(
        laserEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  laserMix.load(std::memory_order_relaxed))
            : 0.0f);

    // Automation may have left coefficient targets at the end of pass 1.
    // Rebuild the starting targets from the restored scalar snapshot and install
    // them immediately; smoothing then begins identically in every pass.
    lastBassDb = lastMidDb = lastTrebleDb = lastPresenceDb = 999.0f;
    lastGraphicEqDb.fill(999.0f);
    lastCabHPFHz = -1.0f;
    lastCabLPFHz = -1.0f;
    rackFilterCoefficientsInitialised = false;
    graphicEqCoefficientsSmoothing = false;
    cabFilterCoefficientsSmoothing = false;
    updateToneFiltersIfNeeded();
    updateGraphicEQFiltersIfNeeded();
    updateCabFiltersIfNeeded();
    rackFilterCoefficientsInitialised = true;

    syncEmbeddedProcessorParameters();
    lowShelfL.reset();
    lowShelfR.reset();
    midPeakL.reset();
    midPeakR.reset();
    highShelfL.reset();
    highShelfR.reset();
    presenceShelfL.reset();
    presenceShelfR.reset();
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        graphicEqL[static_cast<size_t>(band)].reset();
        graphicEqR[static_cast<size_t>(band)].reset();
    }
    cabHPFL.reset();
    cabHPFR.reset();
    cabLPFL.reset();
    cabLPFR.reset();
    {
        const juce::ScopedLock lock(cabIRLock);
        if (cabIR != nullptr)
        {
            cabIR->convolution.reset();
            cabIR->transitionFrom = nullptr;
            cabIR->transitionSamplesRemaining.store(0, std::memory_order_release);
        }
    }

    rackCompressor.releaseResources();
    rackTapeEcho.releaseResources();
    rackPrecisionDrive.releaseResources();
    rackChaos.releaseResources();
    if (embeddedDriveOversampler2x != nullptr)
        embeddedDriveOversampler2x->reset();
    for (auto& channel :
         embeddedDriveSharedDryRing)
        channel.fill(0.0f);
    embeddedDriveSharedDryWriteIndex = 0;
    precisionDriveBypassDelay.reset();
    chaosBypassDelay.reset();
    embeddedDriveSharedDryBuffer.clear();
    precisionDriveBypassBuffer.clear();
    chaosBypassBuffer.clear();
    rackChorus.releaseResources();
    rackDelay.releaseResources();
    rackReverb.releaseResources();
    compressorWasActive = false;
    tapeEchoWasActive = false;
    octaverWasActive = false;
    precisionDriveWasActive = false;
    chaosWasActive = false;
    laserWasActive = false;
    cabWasActive = false;
    modulationWasActive = false;
    modulationBypassDrainSamples = 0;
    delayWasActive = false;
    reverbWasActive = false;

    tapeEchoTailSamplesRemaining = 0;
    delayTailSamplesRemaining = 0;
    reverbTailSamplesRemaining = 0;
    tapeEchoTailMix = 0.0f;
    delayTailMix = 0.0f;
    reverbTailWet = 0.0f;
    reverbTailEarly = 0.0f;
    gateEnvelope = 0.0f;
    gateGain = 1.0f;
    resetOctaverState();
    precisionDriveGateEnvelope = 0.0f;
    precisionDriveGateGain = 1.0f;
    resetLaserState();
    resetAmpFaceplateState();
    resetCabMicState();
    auditionSourceSample = 0;

    const juce::ScopedLock lock(modelSwapLock);
    const auto resetModel = [this] (const std::shared_ptr<LoadedNAMModel>& model)
    {
        if (model == nullptr || model->dsp == nullptr)
            return;

        try
        {
            const double modelSampleRate = model->expectedSampleRate > 1000.0
                ? model->expectedSampleRate
                : cachedSampleRate;
            const int processBlockSize = getNAMRackDspFrameCapacity(realtimeBufferCapacity,
                                                                     cachedSampleRate,
                                                                     modelSampleRate);
            model->dsp->ResetAndPrewarm(modelSampleRate, processBlockSize);
            model->processFaulted.store(false, std::memory_order_relaxed);
        }
        catch (...)
        {
            model->processFaulted.store(true, std::memory_order_relaxed);
        }

        for (auto& resampler : model->inputResamplers)
            resampler.reset();
        for (auto& resampler : model->outputResamplers)
            resampler.reset();
        for (auto& channel : model->resampledHostFifo)
            std::fill(channel.begin(), channel.end(), 0.0f);
        model->resampledHostFifoRead = 0;
        model->resampledHostFifoSize = 0;
        for (auto& channel : model->resampledDryDelay)
            channel.fill(0.0f);
        model->resampledDryDelayWrite = 0;
        for (auto& channel : model->ampBypassDryDelay)
            channel.fill(0.0f);
        model->ampBypassDryDelayWrite = 0;
        model->currentInputCalibrationGain = 1.0f;
        model->currentOutputCalibrationGain = 1.0f;
        model->transitionSamplesRemaining.store(0, std::memory_order_release);
    };
    resetModel(pedalModel);
    resetModel(ampModel);
}

void S13NAMRack::reclaimRetiredModelsFromEarlierPublication()
{
    std::vector<std::shared_ptr<LoadedNAMModel>> modelsToDestroy;
    {
        const juce::ScopedLock lock(modelSwapLock);
        if (modelReaders.load(std::memory_order_seq_cst) == 0)
        {
            const auto* const pedalTransitionSource = pedalModel != nullptr
                && pedalModel->transitionSamplesRemaining.load(std::memory_order_acquire) > 0
                ? pedalModel->transitionFrom
                : nullptr;
            const auto* const ampTransitionSource = ampModel != nullptr
                && ampModel->transitionSamplesRemaining.load(std::memory_order_acquire) > 0
                ? ampModel->transitionFrom
                : nullptr;

            std::vector<std::shared_ptr<LoadedNAMModel>> stillReferenced;
            stillReferenced.reserve(retiredModels.size());
            modelsToDestroy.reserve(retiredModels.size());
            for (auto& retired : retiredModels)
            {
                if (retired.get() == pedalTransitionSource || retired.get() == ampTransitionSource)
                    stillReferenced.push_back(std::move(retired));
                else
                    modelsToDestroy.push_back(std::move(retired));
            }
            retiredModels.swap(stillReferenced);
        }
    }
    // modelsToDestroy is intentionally released after modelSwapLock. This
    // helper is called before the writer's next publication, so an owner
    // retired by that publication is never reclaimed in the same operation.
}

void S13NAMRack::reclaimRetiredCabIRsFromEarlierPublication()
{
    std::vector<std::shared_ptr<LoadedCabIR>> irsToDestroy;
    {
        const juce::ScopedLock lock(cabIRLock);
        if (modelReaders.load(std::memory_order_seq_cst) == 0)
        {
            const auto* const transitionSource = cabIR != nullptr
                && cabIR->transitionSamplesRemaining.load(std::memory_order_acquire) > 0
                ? cabIR->transitionFrom
                : nullptr;

            std::vector<std::shared_ptr<LoadedCabIR>> stillReferenced;
            stillReferenced.reserve(retiredCabIRs.size());
            irsToDestroy.reserve(retiredCabIRs.size());
            for (auto& retired : retiredCabIRs)
            {
                if (retired.get() == transitionSource)
                    stillReferenced.push_back(std::move(retired));
                else
                    irsToDestroy.push_back(std::move(retired));
            }
            retiredCabIRs.swap(stillReferenced);
        }
    }
    // Convolution destruction and its background-queue teardown happen after
    // releasing both the realtime-reader grace period and cabIRLock.
}

void S13NAMRack::resetModelStreamingState(LoadedNAMModel& model,
                                           double hostSampleRate,
                                           double modelSampleRate,
                                           int hostBufferCapacity)
{
    const double safeHostRate = juce::jmax(1.0, hostSampleRate);
    const double safeModelRate = juce::jmax(1.0, modelSampleRate);
    model.inputResamplerKernel.prepare(safeHostRate, safeModelRate);
    model.outputResamplerKernel.prepare(safeModelRate, safeHostRate);
    for (auto& resampler : model.inputResamplers)
        resampler.reset();
    for (auto& resampler : model.outputResamplers)
        resampler.reset();

    model.resampledHostFifoCapacity = juce::jmax(64,
        hostBufferCapacity + 2 * kNAMRackResamplerGuardSamples + 64);
    for (auto& channel : model.resampledHostFifo)
        channel.assign(static_cast<size_t>(model.resampledHostFifoCapacity), 0.0f);
    model.resampledHostFifoRead = 0;
    model.resampledHostFifoSize = 0;
    model.resampledDryDelaySamples = getNAMRackModelResamplerLatency(safeHostRate, safeModelRate);
    jassert(model.resampledDryDelaySamples < namResamplerDryDelayCapacity);
    model.resampledDryDelaySamples = juce::jlimit(0,
                                                  namResamplerDryDelayCapacity - 1,
                                                  model.resampledDryDelaySamples);
    for (auto& channel : model.resampledDryDelay)
        channel.fill(0.0f);
    model.resampledDryDelayWrite = 0;
    for (auto& channel : model.ampBypassDryDelay)
        channel.fill(0.0f);
    model.ampBypassDryDelayWrite = 0;
    model.currentInputCalibrationGain = 1.0f;
    model.currentOutputCalibrationGain = 1.0f;
}

bool S13NAMRack::prepareModelForHostConfiguration(LoadedNAMModel& model,
                                                  double hostSampleRate,
                                                  int hostBufferCapacity,
                                                  juce::String& error)
{
    const double safeHostSampleRate = juce::jmax(1.0, hostSampleRate);
    const int safeHostBufferCapacity = juce::jmax(1, hostBufferCapacity);
    const double modelSampleRate = model.expectedSampleRate > 1000.0
        ? model.expectedSampleRate
        : safeHostSampleRate;
    const double ratio = modelSampleRate / safeHostSampleRate;
    if (ratio < (1.0 / kNAMRackMaximumResampleRatio)
        || ratio > kNAMRackMaximumResampleRatio)
    {
        error = "Unsupported NAM sample-rate ratio (host "
            + juce::String(safeHostSampleRate)
            + " Hz / model "
            + juce::String(modelSampleRate)
            + " Hz); maximum supported ratio is 4:1";
        return false;
    }

    try
    {
        const int processBlockSize = getNAMRackDspFrameCapacity(safeHostBufferCapacity,
                                                                 safeHostSampleRate,
                                                                 modelSampleRate);
        model.dsp->ResetAndPrewarm(modelSampleRate, processBlockSize);
        resetModelStreamingState(model,
                                 safeHostSampleRate,
                                 modelSampleRate,
                                 safeHostBufferCapacity);
        model.preparedHostSampleRate = safeHostSampleRate;
        model.preparedHostBufferCapacity = safeHostBufferCapacity;
        model.processFaulted.store(false, std::memory_order_relaxed);
        error.clear();
        return true;
    }
    catch (const std::exception& ex)
    {
        error = "Failed to prepare NAM model for host: " + juce::String(ex.what());
    }
    catch (...)
    {
        error = "Failed to prepare NAM model for host: unknown error";
    }

    model.processFaulted.store(true, std::memory_order_relaxed);
    return false;
}

void S13NAMRack::processModelDryDelay(juce::AudioBuffer<float>& buffer,
                                      LoadedNAMModel& model) noexcept
{
    const int delaySamples = model.resampledDryDelaySamples;
    if (delaySamples <= 0)
        return;

    const int channels = juce::jmin(2, buffer.getNumChannels());
    int writeIndex = model.resampledDryDelayWrite;
    for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            auto* const data = buffer.getWritePointer(ch);
            auto& delay = model.resampledDryDelay[static_cast<size_t>(ch)];
            const float input = data[sample];
            data[sample] = delay[static_cast<size_t>(writeIndex)];
            delay[static_cast<size_t>(writeIndex)] = input;
        }

        ++writeIndex;
        if (writeIndex >= delaySamples)
            writeIndex = 0;
    }
    model.resampledDryDelayWrite = writeIndex;
}

void S13NAMRack::processAmpBypassDryDelay(juce::AudioBuffer<float>& buffer,
                                          LoadedNAMModel& model) noexcept
{
    const int delaySamples = model.resampledDryDelaySamples;
    if (delaySamples <= 0)
        return;

    const int channels = juce::jmin(2, buffer.getNumChannels());
    int writeIndex = model.ampBypassDryDelayWrite;
    for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            auto* const data = buffer.getWritePointer(ch);
            auto& delay = model.ampBypassDryDelay[static_cast<size_t>(ch)];
            const float input = data[sample];
            data[sample] = delay[static_cast<size_t>(writeIndex)];
            delay[static_cast<size_t>(writeIndex)] = input;
        }

        ++writeIndex;
        if (writeIndex >= delaySamples)
            writeIndex = 0;
    }
    model.ampBypassDryDelayWrite = writeIndex;
}

std::shared_ptr<S13NAMRack::LoadedNAMModel> S13NAMRack::prepareModel(
    const juce::String& path,
    juce::String& error,
    const juce::String& declaredCaptureType)
{
    const juce::File modelFile(path);
    if (!modelFile.existsAsFile())
    {
        error = "NAM model not found: " + path;
        return {};
    }

    const auto modelJson = juce::JSON::parse(modelFile.loadFileAsString());
    const bool hasRequiredNAMShape = modelJson.isObject()
        && modelJson.hasProperty("version")
        && modelJson.hasProperty("architecture")
        && modelJson.hasProperty("config")
        && modelJson.getProperty("weights", {}).isArray();
    if (!hasRequiredNAMShape)
    {
        error = "Invalid NAM model file: missing required version, architecture, config, or weights fields";
        return {};
    }

    juce::String probeError;
    if (! probeNAMModelInChildProcess(modelFile, probeError))
    {
        error = "Failed NAM model safety probe: " + probeError;
        return {};
    }

    double preparedHostSampleRate = 44100.0;
    int preparedHostBufferCapacity = 512;
    {
        const juce::ScopedLock processorConfigurationLock(getCallbackLock());
        preparedHostSampleRate = cachedSampleRate;
        preparedHostBufferCapacity = realtimeBufferCapacity;
    }

    try
    {
        ensureNAMCoreParsersRegistered();

        auto loaded = std::make_shared<LoadedNAMModel>();
        loaded->path = modelFile.getFullPathName();
        loaded->preparedHostSampleRate = preparedHostSampleRate;
        loaded->preparedHostBufferCapacity = preparedHostBufferCapacity;
        loaded->captureType = normaliseNAMCaptureType(modelJson);
        loaded->declaredCaptureType = normaliseNAMCaptureTypeName(declaredCaptureType);
        loaded->includesCab = NAMCaptureIncludesCab(loaded->effectiveCaptureType());
        loaded->dsp = nam::get_dsp(std::filesystem::path(modelFile.getFullPathName().toStdString()));
        if (loaded->dsp == nullptr)
            throw std::runtime_error("NeuralAmpModelerCore returned no DSP instance");

        loaded->hasInputLevelDbu = loaded->dsp->HasInputLevel();
        loaded->hasOutputLevelDbu = loaded->dsp->HasOutputLevel();
        if (loaded->hasInputLevelDbu)
            loaded->inputLevelDbu = loaded->dsp->GetInputLevel();
        if (loaded->hasOutputLevelDbu)
            loaded->outputLevelDbu = loaded->dsp->GetOutputLevel();
        loaded->expectedSampleRate = loaded->dsp->GetExpectedSampleRate();
        loaded->inputChannels = loaded->dsp->NumInputChannels();
        loaded->outputChannels = loaded->dsp->NumOutputChannels();
        if (loaded->inputChannels < 1 || loaded->inputChannels > 2
            || loaded->outputChannels < 1 || loaded->outputChannels > 2)
        {
            throw std::runtime_error(
                "unsupported channel layout ("
                + std::to_string(loaded->inputChannels)
                + " in / "
                + std::to_string(loaded->outputChannels)
                + " out); OpenStudio NAM Rack supports mono or stereo models");
        }
        juce::String preparationError;
        if (! prepareModelForHostConfiguration(*loaded,
                                                preparedHostSampleRate,
                                                preparedHostBufferCapacity,
                                                preparationError))
        {
            error = preparationError;
            return {};
        }

        error.clear();
        return loaded;
    }
    catch (const std::exception& ex)
    {
        error = "Failed to load NAM model: " + juce::String(ex.what());
        return {};
    }
    catch (...)
    {
        error = "Failed to load NAM model: unknown error";
        return {};
    }

}

bool S13NAMRack::commitPreparedModel(std::shared_ptr<LoadedNAMModel> loaded,
                                     bool pedalSlot,
                                     bool applyDirectLoadPolicy,
                                     bool reclaimEarlierPublication,
                                     juce::String* error)
{
    // Reclaiming can run the destructor of a retired NAM graph. Keep that
    // potentially expensive work outside the processor callback lock; only
    // configuration revalidation and publication are serialized with audio.
    if (reclaimEarlierPublication)
        reclaimRetiredModelsFromEarlierPublication();

    // Reserve retirement storage before touching the callback lock. Publication
    // then consists only of pointer/scalar swaps and cannot allocate.
    {
        const juce::ScopedLock lock(modelSwapLock);
        const auto& owner = pedalSlot ? pedalModel : ampModel;
        if (owner != nullptr)
            retiredModels.reserve(retiredModels.size() + 1);
    }

    constexpr int maximumConfigurationRetries = 8;
    for (int attempt = 0; attempt < maximumConfigurationRetries; ++attempt)
    {
        double targetHostSampleRate = 44100.0;
        int targetHostBufferCapacity = 512;
        {
            const juce::ScopedLock configurationSnapshotLock(getCallbackLock());
            targetHostSampleRate = cachedSampleRate;
            targetHostBufferCapacity = realtimeBufferCapacity;
        }

        if (loaded != nullptr
            && (std::abs(loaded->preparedHostSampleRate - targetHostSampleRate) > 0.5
                || loaded->preparedHostBufferCapacity != targetHostBufferCapacity))
        {
            juce::String preparationError;
            if (! prepareModelForHostConfiguration(*loaded,
                                                    targetHostSampleRate,
                                                    targetHostBufferCapacity,
                                                    preparationError))
            {
                if (error != nullptr)
                    *error = preparationError;
                return false;
            }
        }

        // The expensive re-prewarm and buffer allocation above happened while
        // audio continued. Publish only if that configuration is still current;
        // otherwise release the lock and retry against the new host settings.
        const juce::ScopedLock processorConfigurationLock(getCallbackLock());
        if (std::abs(targetHostSampleRate - cachedSampleRate) > 0.5
            || targetHostBufferCapacity != realtimeBufferCapacity)
        {
            continue;
        }

        {
            const juce::ScopedLock lock(modelSwapLock);
            auto& owner = pedalSlot ? pedalModel : ampModel;

            // A direct slot change starts from the new capture's metadata instead of
            // silently carrying a previous model's manual calibration into it. State
            // and preset recalls pass false and publish their saved calibration values
            // as part of the same transaction.
            if (applyDirectLoadPolicy)
            {
                if (pedalSlot)
                {
                    pedalCalibrationMode.store(1.0f, std::memory_order_relaxed);
                    pedalOverrideInputLevelDbu.store(12.0f, std::memory_order_relaxed);
                    pedalOverrideOutputLevelDbu.store(12.0f, std::memory_order_relaxed);
                }
                else
                {
                    ampCalibrationMode.store(1.0f, std::memory_order_relaxed);
                    ampOverrideInputLevelDbu.store(12.0f, std::memory_order_relaxed);
                    ampOverrideOutputLevelDbu.store(12.0f, std::memory_order_relaxed);
                }
            }

            if (! pedalSlot)
            {
                const bool nextIncludesCab = loaded != nullptr && loaded->includesCab;
                // cabRequestedEnabled is the durable user preference. The DSP/UI
                // value remains an effective state, forced off while the capture
                // already contains a cabinet and restored for amp-only captures.
                const bool requested = cabRequestedEnabled.load(std::memory_order_relaxed);
                cabEnabled.store(requested && ! nextIncludesCab ? 1.0f : 0.0f,
                                 std::memory_order_relaxed);
            }

            const bool replacingLiveGraph = loaded != nullptr && owner != nullptr;
            if (replacingLiveGraph)
            {
                // Do not restrict this to matching paths. A tone preset, A/B compare,
                // or project recall may replace the graph with a genuinely different
                // capture, which needs the same click-safe hand-off as a direct load.
                loaded->transitionFrom = owner.get();
                loaded->transitionSamplesTotal = juce::jmax(1, juce::roundToInt(
                    kNAMRackModelTransitionSeconds * cachedSampleRate));
                loaded->transitionSamplesRemaining.store(loaded->transitionSamplesTotal,
                                                           std::memory_order_release);
            }
            else if (loaded != nullptr)
            {
                // A first load has no audible graph to crossfade from.
                loaded->transitionFrom = nullptr;
                loaded->transitionSamplesTotal = 0;
                loaded->transitionSamplesRemaining.store(0, std::memory_order_release);
            }

            auto previous = std::move(owner);
            owner = std::move(loaded);
            if (previous != nullptr)
                retiredModels.push_back(std::move(previous));

            auto* const published = owner.get();
            if (pedalSlot)
            {
                activePedalModel.store(published, std::memory_order_seq_cst);
                pedalModelPath = owner != nullptr ? owner->path : juce::String();
                pedalDeclaredCaptureType = owner != nullptr
                    ? owner->declaredCaptureType
                    : juce::String("unknown");
            }
            else
            {
                activeAmpModelIncludesCab.store(owner != nullptr && owner->includesCab,
                                                 std::memory_order_release);
                activeAmpModel.store(published, std::memory_order_seq_cst);
                ampModelPath = owner != nullptr ? owner->path : juce::String();
                ampDeclaredCaptureType = owner != nullptr
                    ? owner->declaredCaptureType
                    : juce::String("unknown");
            }
        }

        updateReportedLatency();
        if (error != nullptr)
            error->clear();
        return true;
    }

    if (error != nullptr)
        *error = "NAM host configuration changed repeatedly during model publication";
    return false;
}

bool S13NAMRack::loadModelIntoSlot(const juce::String& path, bool pedalSlot)
{
    if (path.trim().isEmpty())
    {
        juce::String commitError;
        if (! commitPreparedModel({}, pedalSlot, true, true, &commitError))
        {
            const juce::ScopedLock lock(modelSwapLock);
            lastLoadError = commitError;
            return false;
        }
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError.clear();
        return true;
    }

    juce::String error;
    auto loaded = prepareModel(path, error);
    if (loaded == nullptr)
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError = error;
        return false;
    }

    const auto loadedPath = loaded->path;
    const double preparedHostRate = loaded->preparedHostSampleRate;
    const int preparedHostCapacity = loaded->preparedHostBufferCapacity;
    const double modelSampleRate = loaded->expectedSampleRate > 1000.0
        ? loaded->expectedSampleRate
        : preparedHostRate;
    const int processBlockSize = getNAMRackDspFrameCapacity(juce::jmax(1, preparedHostCapacity),
                                                             preparedHostRate,
                                                             modelSampleRate);
    const int inputChannels = loaded->inputChannels;
    const int outputChannels = loaded->outputChannels;
    if (! commitPreparedModel(std::move(loaded), pedalSlot, true, true, &error))
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError = error;
        return false;
    }
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError.clear();
    }
    double publishedHostRate = preparedHostRate;
    int publishedHostBlockSize = 0;
    int publishedHostCapacity = preparedHostCapacity;
    {
        const juce::ScopedLock processorConfigurationLock(getCallbackLock());
        publishedHostRate = cachedSampleRate;
        publishedHostBlockSize = cachedBlockSize;
        publishedHostCapacity = realtimeBufferCapacity;
    }
    juce::Logger::writeToLog("S13NAMRack: loaded "
        + juce::String(pedalSlot ? "pedal" : "amp")
        + " model path=" + loadedPath
        + " hostSr=" + juce::String(publishedHostRate)
        + " modelSr=" + juce::String(modelSampleRate)
        + " hostBlock=" + juce::String(publishedHostBlockSize)
        + " capacity=" + juce::String(publishedHostCapacity)
        + " dspFrames=" + juce::String(processBlockSize)
        + " inCh=" + juce::String(inputChannels)
        + " outCh=" + juce::String(outputChannels));
    return true;
}

bool S13NAMRack::loadPedalModel(const juce::String& path)
{
    return loadModelIntoSlot(path, true);
}

bool S13NAMRack::loadAmpModel(const juce::String& path)
{
    return loadModelIntoSlot(path, false);
}

void S13NAMRack::clearPedalModel()
{
    juce::String error;
    const bool cleared = commitPreparedModel({}, true, true, true, &error);
    const juce::ScopedLock lock(modelSwapLock);
    if (cleared)
        lastLoadError.clear();
    else
        lastLoadError = error;
}

void S13NAMRack::clearAmpModel()
{
    juce::String error;
    const bool cleared = commitPreparedModel({}, false, true, true, &error);
    const juce::ScopedLock lock(modelSwapLock);
    if (cleared)
        lastLoadError.clear();
    else
        lastLoadError = error;
}

juce::String S13NAMRack::getPedalModelPath() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return pedalModel != nullptr ? pedalModel->path : pedalModelPath;
}

juce::String S13NAMRack::getAmpModelPath() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return ampModel != nullptr ? ampModel->path : ampModelPath;
}

juce::String S13NAMRack::getLastLoadError() const
{
    const juce::ScopedLock lock(modelSwapLock);
    if (lastLoadError.isEmpty())
    {
        if (pedalModel != nullptr && pedalModel->processFaulted.load(std::memory_order_relaxed))
            return "NAM pedal model failed while processing and was bypassed: " + pedalModel->path;

        if (ampModel != nullptr && ampModel->processFaulted.load(std::memory_order_relaxed))
            return "NAM amp model failed while processing and was bypassed: " + ampModel->path;
    }
    return lastLoadError;
}

bool S13NAMRack::hasPedalModel() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return pedalModel != nullptr;
}

bool S13NAMRack::hasAmpModel() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return ampModel != nullptr;
}

juce::String S13NAMRack::getPedalCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    if (pedalModel != nullptr)
        return pedalModel->effectiveCaptureType();
    return pedalDeclaredCaptureType;
}

juce::String S13NAMRack::getAmpCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    if (ampModel != nullptr)
        return ampModel->effectiveCaptureType();
    return ampDeclaredCaptureType;
}

juce::String S13NAMRack::getPedalMetadataCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return pedalModel != nullptr ? pedalModel->captureType : juce::String("unknown");
}

juce::String S13NAMRack::getAmpMetadataCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return ampModel != nullptr ? ampModel->captureType : juce::String("unknown");
}

juce::String S13NAMRack::getPedalDeclaredCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return pedalDeclaredCaptureType;
}

juce::String S13NAMRack::getAmpDeclaredCaptureType() const
{
    const juce::ScopedLock lock(modelSwapLock);
    return ampDeclaredCaptureType;
}

bool S13NAMRack::ampModelIncludesCab() const
{
    return activeAmpModelIncludesCab.load(std::memory_order_acquire);
}

void S13NAMRack::setCabRequestedEnabled(bool enabled) noexcept
{
    cabRequestedEnabled.store(enabled, std::memory_order_relaxed);
    cabEnabled.store(enabled && ! ampModelIncludesCab() ? 1.0f : 0.0f,
                     std::memory_order_relaxed);
}

bool S13NAMRack::isCabRequestedEnabled() const noexcept
{
    return cabRequestedEnabled.load(std::memory_order_relaxed);
}

juce::var S13NAMRack::getCalibrationState(bool pedalSlot) const
{
    const juce::ScopedLock lock(modelSwapLock);
    const auto model = pedalSlot ? pedalModel : ampModel;
    const int mode = juce::jlimit(0, 2, static_cast<int>(std::round(
        pedalSlot ? pedalCalibrationMode.load(std::memory_order_relaxed)
                  : ampCalibrationMode.load(std::memory_order_relaxed))));
    const double referenceDbu = static_cast<double>(calibrationReferenceDbu.load(std::memory_order_relaxed));
    const bool hasMetadataInput = model != nullptr && model->hasInputLevelDbu;
    const bool hasMetadataOutput = model != nullptr && model->hasOutputLevelDbu;
    const bool useOverride = mode == 2;
    const bool useMetadata = mode == 1;
    const bool hasEffectiveInput = useOverride || (useMetadata && hasMetadataInput);
    const bool hasEffectiveOutput = useOverride || (useMetadata && hasMetadataOutput);
    const double effectiveInputDbu = useOverride
        ? static_cast<double>(pedalSlot ? pedalOverrideInputLevelDbu.load(std::memory_order_relaxed)
                                       : ampOverrideInputLevelDbu.load(std::memory_order_relaxed))
        : (hasMetadataInput ? model->inputLevelDbu : 0.0);
    const double effectiveOutputDbu = useOverride
        ? static_cast<double>(pedalSlot ? pedalOverrideOutputLevelDbu.load(std::memory_order_relaxed)
                                       : ampOverrideOutputLevelDbu.load(std::memory_order_relaxed))
        : (hasMetadataOutput ? model->outputLevelDbu : 0.0);

    auto* state = new juce::DynamicObject();
    state->setProperty("mode", mode);
    state->setProperty("referenceDbu", referenceDbu);
    if (hasMetadataInput)
        state->setProperty("metadataInputLevelDbu", model->inputLevelDbu);
    if (hasMetadataOutput)
        state->setProperty("metadataOutputLevelDbu", model->outputLevelDbu);
    if (hasEffectiveInput)
        state->setProperty("effectiveInputLevelDbu", effectiveInputDbu);
    if (hasEffectiveOutput)
        state->setProperty("effectiveOutputLevelDbu", effectiveOutputDbu);
    state->setProperty("appliedInputGainDb", hasEffectiveInput ? referenceDbu - effectiveInputDbu : 0.0);
    state->setProperty("appliedOutputGainDb", hasEffectiveOutput ? effectiveOutputDbu - referenceDbu : 0.0);

    juce::String status = "off";
    if (mode == 2)
        status = "override";
    else if (mode == 1 && ! hasMetadataInput && ! hasMetadataOutput)
        status = "unavailable";
    else if (mode == 1 && hasMetadataInput && hasMetadataOutput)
        status = "complete";
    else if (mode == 1)
        status = "partial";
    state->setProperty("status", status);
    return juce::var(state);
}

juce::var S13NAMRack::getPedalCalibrationState() const
{
    return getCalibrationState(true);
}

juce::var S13NAMRack::getAmpCalibrationState() const
{
    return getCalibrationState(false);
}

uint64_t S13NAMRack::getModelSnapshotLockMissCount() const noexcept
{
    return modelSnapshotLockMissCount.load(std::memory_order_relaxed);
}

void S13NAMRack::resetModelSnapshotLockMissCount() noexcept
{
    modelSnapshotLockMissCount.store(0, std::memory_order_relaxed);
}

bool S13NAMRack::hasAuditionSourceActive() const noexcept
{
    return auditionSource.load(std::memory_order_relaxed) >= 0.5f;
}

juce::var S13NAMRack::getDiagnosticState() const
{
    const double preparedSampleRate =
        static_cast<double>(diagnosticPreparedSampleRate.load(std::memory_order_relaxed));
    double pedalModelSampleRate = 0.0;
    double ampModelSampleRate = 0.0;
    bool pedalModelLoaded = false;
    bool ampModelLoaded = false;
    {
        const juce::ScopedLock lock(modelSwapLock);
        if (pedalModel != nullptr)
        {
            pedalModelLoaded = true;
            pedalModelSampleRate = pedalModel->expectedSampleRate > 1000.0
                ? pedalModel->expectedSampleRate
                : preparedSampleRate;
        }
        if (ampModel != nullptr)
        {
            ampModelLoaded = true;
            ampModelSampleRate = ampModel->expectedSampleRate > 1000.0
                ? ampModel->expectedSampleRate
                : preparedSampleRate;
        }
    }

    auto* obj = new juce::DynamicObject();
    obj->setProperty("preparedSampleRate", diagnosticPreparedSampleRate.load(std::memory_order_relaxed));
    obj->setProperty("preparedBlockSize", diagnosticPreparedBlockSize.load(std::memory_order_relaxed));
    obj->setProperty("bufferCapacity", diagnosticBufferCapacity.load(std::memory_order_relaxed));
    obj->setProperty("lastBlockSize", diagnosticLastBlockSize.load(std::memory_order_relaxed));
    obj->setProperty("maxBlockSize", diagnosticMaxBlockSize.load(std::memory_order_relaxed));
    obj->setProperty(
        "processedBlockCount",
        static_cast<juce::int64>(diagnosticProcessedBlockCount.load(std::memory_order_relaxed)));
    obj->setProperty("lastDspFrames", diagnosticLastDspFrames.load(std::memory_order_relaxed));
    obj->setProperty("maxDspFrames", diagnosticMaxDspFrames.load(std::memory_order_relaxed));
    obj->setProperty("lastModelSampleRate", diagnosticLastModelSampleRate.load(std::memory_order_relaxed));
    obj->setProperty("pedalModelSampleRate", pedalModelSampleRate);
    obj->setProperty("ampModelSampleRate", ampModelSampleRate);
    obj->setProperty("dualNAMActive", pedalModelLoaded && ampModelLoaded);
    obj->setProperty("lastRawInputPeakDb", diagnosticLastRawInputPeakDb.load(std::memory_order_relaxed));
    obj->setProperty("lastInputPeakDb", diagnosticLastInputPeakDb.load(std::memory_order_relaxed));
    obj->setProperty("lastOutputPeakDb", diagnosticLastOutputPeakDb.load(std::memory_order_relaxed));
    // Live meters use these processor-smoothed linked peaks instead of the
    // one-time values returned with the initial schema.
    obj->setProperty("inputLevelDb", inputLevelDb.load(std::memory_order_relaxed));
    obj->setProperty("outputLevelDb", outputLevelDb.load(std::memory_order_relaxed));
    obj->setProperty("auditionSourceActive", diagnosticLastAuditionSourceActive.load(std::memory_order_relaxed));
    obj->setProperty("auditionSourceRendered", diagnosticLastAuditionSourceRendered.load(std::memory_order_relaxed));
    obj->setProperty("lastResampled", diagnosticLastResampled.load(std::memory_order_relaxed));
    obj->setProperty("resamplerMode", "streaming-windowed-sinc-48");
    obj->setProperty("reportedLatencySamples", getLatencySamples());
    obj->setProperty("audioThreadResizeAvoidedCount", diagnosticAudioThreadResizeAvoidedCount.load(std::memory_order_relaxed));
    obj->setProperty("oversizeBypassCount", diagnosticOversizeBypassCount.load(std::memory_order_relaxed));
    obj->setProperty("modelProcessFailCount", diagnosticModelProcessFailCount.load(std::memory_order_relaxed));
    obj->setProperty(
        "observedTightBlockSize",
        diagnosticObservedTightBlockSize.load(std::memory_order_relaxed));
    obj->setProperty("realtimeSafetyBypassCount", diagnosticRealtimeSafetyBypassCount.load(std::memory_order_relaxed));
    obj->setProperty("realtimeDSPBlocked", diagnosticRealtimeDSPBlocked.load(std::memory_order_relaxed));
    obj->setProperty(
        "precisionDriveOversamplingEnabled",
        rackPrecisionDrive.isOversamplingEnabled());
    obj->setProperty(
        "precisionDriveOversampleMode",
        rackPrecisionDrive.oversampleMode.load(std::memory_order_relaxed));
    obj->setProperty(
        "precisionDriveActiveOversampleMode",
        rackPrecisionDrive.getActiveOversamplingMode());
    obj->setProperty(
        "precisionDriveOversamplingLatencySamples",
        rackPrecisionDrive.getOversamplingLatencySamples());
    obj->setProperty(
        "chaosOversamplingEnabled",
        rackChaos.isOversamplingEnabled());
    obj->setProperty(
        "chaosOversampleMode",
        rackChaos.oversampleMode.load(std::memory_order_relaxed));
    obj->setProperty(
        "chaosActiveOversampleMode",
        rackChaos.getActiveOversamplingMode());
    obj->setProperty(
        "chaosOversamplingLatencySamples",
        rackChaos.getOversamplingLatencySamples());
    obj->setProperty(
        "embeddedDriveSharedOversamplingEnabled",
        embeddedDriveOversampler2x != nullptr);
    obj->setProperty(
        "embeddedDriveSharedOversampleMode", 1);
    obj->setProperty(
        "embeddedDriveSharedOversamplingLatencySamples",
        embeddedDriveOversamplingLatencySamples);
    obj->setProperty("modelSnapshotLockMissCount", static_cast<double>(modelSnapshotLockMissCount.load(std::memory_order_relaxed)));
    return juce::var(obj);
}

static bool inspectCabImpulseResponseFile(const juce::File& irFile,
                                          double& durationSeconds,
                                          juce::String& error)
{
    if (! irFile.existsAsFile())
    {
        error = "Cab IR not found: " + irFile.getFullPathName();
        return false;
    }

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    auto reader = std::unique_ptr<juce::AudioFormatReader>(formatManager.createReaderFor(irFile));
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0
        || reader->numChannels == 0)
    {
        error = "Invalid or unsupported cab IR: " + irFile.getFullPathName();
        return false;
    }

    durationSeconds = juce::jlimit(0.0, 60.0,
        static_cast<double>(reader->lengthInSamples) / reader->sampleRate);
    error.clear();
    return true;
}

bool S13NAMRack::loadCabIR(const juce::String& path)
{
    if (path.trim().isEmpty())
    {
        clearCabIR();
        return true;
    }

    const juce::File irFile(path);
    double irDurationSeconds = 0.0;
    juce::String validationError;
    if (! inspectCabImpulseResponseFile(irFile, irDurationSeconds, validationError))
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError = validationError;
        return false;
    }

    reclaimRetiredCabIRsFromEarlierPublication();

    // A Convolution load submitted to an already-running instance is
    // asynchronous and has no public completion callback. Build a fresh
    // instance instead: prepare() synchronously drains its most-recent IR load,
    // so a successful publication always names the engine that will be audible
    // on its first process() call.
    constexpr int maximumConfigurationRetries = 8;
    for (int attempt = 0; attempt < maximumConfigurationRetries; ++attempt)
    {
        double targetHostSampleRate = 44100.0;
        int targetHostBlockSize = 512;
        {
            const juce::ScopedLock configurationSnapshotLock(getCallbackLock());
            targetHostSampleRate = cachedSampleRate;
            targetHostBlockSize = cachedBlockSize;
        }

        juce::String preparationError;
        auto prepared = prepareCabIR(irFile,
                                     irDurationSeconds,
                                     targetHostSampleRate,
                                     targetHostBlockSize,
                                     preparationError);
        if (prepared == nullptr)
        {
            const juce::ScopedLock lock(modelSwapLock);
            lastLoadError = preparationError;
            return false;
        }

        const juce::ScopedLock processorCallbackGuard(getCallbackLock());
        if (std::abs(targetHostSampleRate - cachedSampleRate) > 0.5
            || targetHostBlockSize != cachedBlockSize)
        {
            continue;
        }

        return publishPreparedCabIR(std::move(prepared));
    }

    const juce::ScopedLock lock(modelSwapLock);
    lastLoadError = "NAM host configuration changed repeatedly while loading cab IR";
    return false;
}

std::shared_ptr<S13NAMRack::LoadedCabIR> S13NAMRack::prepareCabIR(
    const juce::File& irFile,
    double durationSeconds,
    double hostSampleRate,
    int hostBlockSize,
    juce::String& error)
{
    try
    {
        auto prepared = std::make_shared<LoadedCabIR>();
        prepared->path = irFile.getFullPathName();
        prepared->durationSeconds = durationSeconds;
        prepared->preparedHostSampleRate = juce::jmax(1.0, hostSampleRate);
        prepared->preparedHostBlockSize = juce::jmax(1, hostBlockSize);
        prepared->convolution.loadImpulseResponse(irFile,
                                                  juce::dsp::Convolution::Stereo::yes,
                                                  juce::dsp::Convolution::Trim::yes,
                                                  0,
                                                  juce::dsp::Convolution::Normalise::yes);

        juce::dsp::ProcessSpec convolutionSpec;
        convolutionSpec.sampleRate = prepared->preparedHostSampleRate;
        convolutionSpec.maximumBlockSize = static_cast<juce::uint32>(prepared->preparedHostBlockSize);
        convolutionSpec.numChannels = 2;
        prepared->convolution.prepare(convolutionSpec);
        prepared->convolution.reset();
        prepared->preparedIRSize = prepared->convolution.getCurrentIRSize();
        if (prepared->preparedIRSize <= 0)
        {
            error = "Failed to initialise cab IR: " + irFile.getFullPathName();
            return {};
        }

        error.clear();
        return prepared;
    }
    catch (const std::exception& ex)
    {
        error = "Failed to load cab IR: " + juce::String(ex.what());
    }
    catch (...)
    {
        error = "Failed to load cab IR: unknown error";
    }

    return {};
}

bool S13NAMRack::publishPreparedCabIR(std::shared_ptr<LoadedCabIR> prepared)
{
    if (prepared == nullptr)
        return false;

    const bool ampIncludesCab = ampModelIncludesCab();
    {
        const juce::ScopedLock lock(cabIRLock);
        auto old = std::move(cabIR);
        if (old != nullptr)
        {
            prepared->transitionFrom = old.get();
            prepared->transitionSamplesTotal = juce::jmax(1, juce::roundToInt(
                kNAMRackModelTransitionSeconds * prepared->preparedHostSampleRate));
            prepared->transitionSamplesRemaining.store(prepared->transitionSamplesTotal,
                                                        std::memory_order_release);
            retiredCabIRs.push_back(std::move(old));
        }

        cabIR = std::move(prepared);
        cabIRPath = cabIR->path;
        cabIRDurationSeconds.store(cabIR->durationSeconds, std::memory_order_relaxed);
        cabIRLoaded.store(true, std::memory_order_release);
        activeCabIR.store(cabIR.get(), std::memory_order_seq_cst);
    }

    cabRequestedEnabled.store(true, std::memory_order_relaxed);
    cabEnabled.store(ampIncludesCab ? 0.0f : 1.0f, std::memory_order_relaxed);
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError.clear();
    }
    return true;
}

void S13NAMRack::clearCabIR()
{
    const juce::ScopedLock processorCallbackGuard(getCallbackLock());
    {
        const juce::ScopedLock lock(cabIRLock);
        cabIRLoaded.store(false, std::memory_order_release);
        cabIRDurationSeconds.store(0.0, std::memory_order_relaxed);
        cabIRPath.clear();
    }
    cabRequestedEnabled.store(false, std::memory_order_relaxed);
    cabEnabled.store(0.0f, std::memory_order_relaxed);
    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError.clear();
    }
}

juce::String S13NAMRack::getCabIRPath() const
{
    const juce::ScopedLock lock(cabIRLock);
    return cabIRPath;
}

bool S13NAMRack::hasCabIR() const
{
    const juce::ScopedLock lock(cabIRLock);
    return cabIRLoaded.load(std::memory_order_acquire)
        && cabIR != nullptr
        && activeCabIR.load(std::memory_order_seq_cst) == cabIR.get()
        && cabIR->preparedIRSize > 0;
}

bool S13NAMRack::restoreModelResourceState(bool pedalPathSpecified,
                                           const juce::String& pedalPath,
                                           bool ampPathSpecified,
                                           const juce::String& ampPath,
                                           bool cabPathSpecified,
                                           const juce::String& cabPath,
                                           bool applySessionCabAutoBypass,
                                           bool allowMissingResources,
                                           bool pedalDeclaredCaptureTypeSpecified,
                                           const juce::String& requestedPedalDeclaredCaptureType,
                                           bool ampDeclaredCaptureTypeSpecified,
                                           const juce::String& requestedAmpDeclaredCaptureType,
                                           const std::function<void()>& publishAdditionalState,
                                           const std::function<std::shared_ptr<void>()>& publicationLeaseFactory,
                                           std::shared_ptr<void>* retainedPublicationLease)
{
    if (retainedPublicationLease != nullptr)
        retainedPublicationLease->reset();

    std::shared_ptr<LoadedNAMModel> preparedPedal;
    std::shared_ptr<LoadedNAMModel> preparedAmp;
    std::shared_ptr<LoadedCabIR> preparedCab;
    bool pedalAvailable = true;
    bool ampAvailable = true;
    bool cabAvailable = true;
    double cabDurationSeconds = 0.0;
    const bool pedalDeclarationNeedsPublication =
        pedalDeclaredCaptureTypeSpecified || pedalPathSpecified;
    const bool ampDeclarationNeedsPublication =
        ampDeclaredCaptureTypeSpecified || ampPathSpecified;
    const auto nextPedalDeclaredCaptureType =
        pedalPathSpecified && pedalPath.trim().isEmpty()
        ? juce::String("unknown")
        : pedalDeclaredCaptureTypeSpecified
        ? normaliseNAMCaptureTypeName(requestedPedalDeclaredCaptureType)
        : juce::String("unknown");
    const auto nextAmpDeclaredCaptureType =
        ampPathSpecified && ampPath.trim().isEmpty()
        ? juce::String("unknown")
        : ampDeclaredCaptureTypeSpecified
        ? normaliseNAMCaptureTypeName(requestedAmpDeclaredCaptureType)
        : juce::String("unknown");
    juce::StringArray errors;
    const auto rememberError = [&errors] (const juce::String& error)
    {
        if (error.isNotEmpty())
            errors.addIfNotAlreadyThere(error);
    };
    const auto publishRestoreErrorIfCurrent = [this, &publicationLeaseFactory]
        (const juce::String& error)
    {
        std::shared_ptr<void> publicationLease;
        if (publicationLeaseFactory)
        {
            publicationLease = publicationLeaseFactory();
            if (! publicationLease)
                return;
        }
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError = error;
    };
    const auto pathsMatch = [] (const juce::String& first, const juce::String& second)
    {
        if (first.trim().isEmpty() || second.trim().isEmpty())
            return first.trim().isEmpty() && second.trim().isEmpty();
        return juce::File(first).getFullPathName().equalsIgnoreCase(
            juce::File(second).getFullPathName());
    };

    // Preset A/B commonly points at the models already active in the rack. Do
    // not rebuild and probe those same heavy resources; only the scalar/UI
    // state needs publishing. A faulted model is deliberately not reused.
    bool pedalResourceNeedsChange = pedalPathSpecified;
    bool ampResourceNeedsChange = ampPathSpecified;
    {
        const juce::ScopedLock lock(modelSwapLock);
        if (pedalPathSpecified)
        {
            pedalResourceNeedsChange = pedalPath.trim().isEmpty()
                ? pedalModel != nullptr || pedalModelPath.isNotEmpty()
                : pedalModel == nullptr
                    || pedalModel->processFaulted.load(std::memory_order_relaxed)
                    || ! pathsMatch(pedalPath, pedalModelPath);
        }
        if (ampPathSpecified)
        {
            ampResourceNeedsChange = ampPath.trim().isEmpty()
                ? ampModel != nullptr || ampModelPath.isNotEmpty()
                : ampModel == nullptr
                    || ampModel->processFaulted.load(std::memory_order_relaxed)
                    || ! pathsMatch(ampPath, ampModelPath);
        }
    }
    bool cabResourceNeedsChange = cabPathSpecified;
    {
        const juce::ScopedLock lock(cabIRLock);
        if (cabPathSpecified)
        {
            cabResourceNeedsChange = cabPath.trim().isEmpty()
                ? cabIRLoaded.load(std::memory_order_acquire) || cabIRPath.isNotEmpty()
                : ! cabIRLoaded.load(std::memory_order_acquire)
                    || ! pathsMatch(cabPath, cabIRPath);
        }
    }

    // Prepare every NAM graph before publishing any of them. Strict tone recalls
    // can therefore fail without changing the audible rack. Project recovery may
    // instead publish an unloaded slot carrying the missing path for relinking.
    if (pedalResourceNeedsChange && pedalPath.trim().isNotEmpty())
    {
        juce::String error;
        preparedPedal = prepareModel(
            pedalPath,
            error,
            pedalDeclarationNeedsPublication
                ? nextPedalDeclaredCaptureType
                : getPedalDeclaredCaptureType());
        if (preparedPedal == nullptr)
        {
            pedalAvailable = false;
            rememberError(error);
        }
    }

    if (ampResourceNeedsChange && ampPath.trim().isNotEmpty())
    {
        juce::String error;
        preparedAmp = prepareModel(
            ampPath,
            error,
            ampDeclarationNeedsPublication
                ? nextAmpDeclaredCaptureType
                : getAmpDeclaredCaptureType());
        if (preparedAmp == nullptr)
        {
            ampAvailable = false;
            rememberError(error);
        }
    }

    if (cabResourceNeedsChange && cabPath.trim().isNotEmpty())
    {
        juce::String error;
        if (! inspectCabImpulseResponseFile(juce::File(cabPath), cabDurationSeconds, error))
        {
            cabAvailable = false;
            rememberError(error);
        }
    }

    const auto allResourcesAvailable = [&]
    {
        return pedalAvailable && ampAvailable && cabAvailable;
    };

    if (! allResourcesAvailable() && ! allowMissingResources)
    {
        publishRestoreErrorIfCurrent(errors.joinIntoString("; "));
        return false;
    }

    // Reclaiming old graphs can run destructors, so attempt that before the
    // callback lock too. The newly retired owners remain available for a later
    // off-lock reclamation pass.
    reclaimRetiredModelsFromEarlierPublication();
    reclaimRetiredCabIRsFromEarlierPublication();
    {
        const juce::ScopedLock lock(modelSwapLock);
        const size_t possibleRetirements = static_cast<size_t>(pedalResourceNeedsChange)
            + static_cast<size_t>(ampResourceNeedsChange);
        retiredModels.reserve(retiredModels.size() + possibleRetirements);
    }

    // The host can change while files are probed. Re-prewarm both graphs for a
    // single configuration off-lock, then verify and publish the entire model /
    // IR / scalar transaction under one short callback lock.
    constexpr int maximumConfigurationRetries = 8;
    for (int attempt = 0; attempt < maximumConfigurationRetries; ++attempt)
    {
        double targetHostSampleRate = 44100.0;
        int targetHostBufferCapacity = 512;
        int targetHostBlockSize = 512;
        {
            const juce::ScopedLock configurationSnapshotLock(getCallbackLock());
            targetHostSampleRate = cachedSampleRate;
            targetHostBufferCapacity = realtimeBufferCapacity;
            targetHostBlockSize = cachedBlockSize;
        }

        const auto reprepareForCurrentHost = [&] (std::shared_ptr<LoadedNAMModel>& model,
                                                   bool& available)
        {
            if (! available || model == nullptr)
                return true;
            if (std::abs(model->preparedHostSampleRate - targetHostSampleRate) <= 0.5
                && model->preparedHostBufferCapacity == targetHostBufferCapacity)
            {
                return true;
            }

            juce::String error;
            if (prepareModelForHostConfiguration(*model,
                                                 targetHostSampleRate,
                                                 targetHostBufferCapacity,
                                                 error))
            {
                return true;
            }

            available = false;
            model.reset();
            rememberError(error);
            return allowMissingResources;
        };

        if (! reprepareForCurrentHost(preparedPedal, pedalAvailable)
            || ! reprepareForCurrentHost(preparedAmp, ampAvailable))
        {
            publishRestoreErrorIfCurrent(errors.joinIntoString("; "));
            return false;
        }

        if (cabResourceNeedsChange && cabAvailable && cabPath.trim().isNotEmpty()
            && (preparedCab == nullptr
                || std::abs(preparedCab->preparedHostSampleRate - targetHostSampleRate) > 0.5
                || preparedCab->preparedHostBlockSize != targetHostBlockSize))
        {
            juce::String error;
            preparedCab = prepareCabIR(juce::File(cabPath),
                                       cabDurationSeconds,
                                       targetHostSampleRate,
                                       targetHostBlockSize,
                                       error);
            if (preparedCab == nullptr)
            {
                cabAvailable = false;
                rememberError(error);
                if (! allowMissingResources)
                {
                    publishRestoreErrorIfCurrent(errors.joinIntoString("; "));
                    return false;
                }
            }
        }

        std::shared_ptr<void> publicationLease;
        if (publicationLeaseFactory)
        {
            publicationLease = publicationLeaseFactory();
            if (! publicationLease)
                return false;
        }

        // Lock ordering is publication state/generation -> processor callback,
        // matching message-thread topology mutations. Model preparation above
        // remains entirely outside both locks.
        const juce::ScopedLock processorCallbackGuard(getCallbackLock());
        if (std::abs(targetHostSampleRate - cachedSampleRate) > 0.5
            || targetHostBufferCapacity != realtimeBufferCapacity
            || targetHostBlockSize != cachedBlockSize)
        {
            continue;
        }

    if (cabResourceNeedsChange)
    {
        if (cabPath.trim().isEmpty())
            clearCabIR();
        else if (cabAvailable && ! publishPreparedCabIR(std::move(preparedCab)))
        {
            cabAvailable = false;
            rememberError("Failed to publish prepared cab IR: " + cabPath);
            if (! allowMissingResources)
                return false;
        }

        if (! cabAvailable && allowMissingResources)
        {
            clearCabIR();
            const juce::ScopedLock lock(cabIRLock);
            cabIRPath = cabPath;
        }
    }

    if (pedalResourceNeedsChange)
    {
        juce::String commitError;
        if (! commitPreparedModel(pedalAvailable ? std::move(preparedPedal) : std::shared_ptr<LoadedNAMModel>(),
                                  true,
                                  applySessionCabAutoBypass,
                                  false,
                                  &commitError))
        {
            rememberError(commitError);
            const juce::ScopedLock lock(modelSwapLock);
            lastLoadError = errors.joinIntoString("; ");
            return false;
        }
        if (! pedalAvailable)
        {
            const juce::ScopedLock lock(modelSwapLock);
            pedalModelPath = pedalPath;
        }
    }
    if (ampResourceNeedsChange)
    {
        juce::String commitError;
        if (! commitPreparedModel(ampAvailable ? std::move(preparedAmp) : std::shared_ptr<LoadedNAMModel>(),
                                  false,
                                  applySessionCabAutoBypass,
                                  false,
                                  &commitError))
        {
            rememberError(commitError);
            const juce::ScopedLock lock(modelSwapLock);
            lastLoadError = errors.joinIntoString("; ");
            return false;
        }
        if (! ampAvailable)
        {
            const juce::ScopedLock lock(modelSwapLock);
            ampModelPath = ampPath;
        }
    }

    // A declaration belongs to the selected library record, not to an earlier
    // graph in the slot. Path publication without an accompanying declaration
    // therefore clears stale fallback state. For an already-loaded path, update
    // the fallback and effective Cab topology in the same callback-locked
    // publication before any scalar/UI state derives cabEnabled.
    if (pedalDeclarationNeedsPublication || ampDeclarationNeedsPublication)
    {
        const juce::ScopedLock lock(modelSwapLock);
        if (pedalDeclarationNeedsPublication)
        {
            pedalDeclaredCaptureType = nextPedalDeclaredCaptureType;
            if (pedalModel != nullptr)
            {
                pedalModel->declaredCaptureType = nextPedalDeclaredCaptureType;
                pedalModel->includesCab = NAMCaptureIncludesCab(
                    pedalModel->effectiveCaptureType());
            }
        }
        if (ampDeclarationNeedsPublication)
        {
            ampDeclaredCaptureType = nextAmpDeclaredCaptureType;
            if (ampModel != nullptr)
            {
                ampModel->declaredCaptureType = nextAmpDeclaredCaptureType;
                ampModel->includesCab = NAMCaptureIncludesCab(
                    ampModel->effectiveCaptureType());
            }

            const bool nextIncludesCab =
                ampModel != nullptr && ampModel->includesCab;
            activeAmpModelIncludesCab.store(
                nextIncludesCab, std::memory_order_release);
            const bool requested =
                cabRequestedEnabled.load(std::memory_order_relaxed);
            cabEnabled.store(
                requested && ! nextIncludesCab ? 1.0f : 0.0f,
                std::memory_order_relaxed);
        }
    }

    if (publishAdditionalState)
        publishAdditionalState();

    {
        const juce::ScopedLock lock(modelSwapLock);
        lastLoadError = allResourcesAvailable() ? juce::String() : errors.joinIntoString("; ");
    }
    // Only a lease from the host configuration that actually published may be
    // retained by the caller. A lease acquired for a stale configuration dies
    // at the end of that retry, before any expensive re-preparation begins.
    if (retainedPublicationLease != nullptr)
        *retainedPublicationLease = publicationLease;
    return allResourcesAvailable();
    }

    publishRestoreErrorIfCurrent(
        "NAM host configuration changed repeatedly during state restore");
    return false;
}

void S13NAMRack::setUiStateJSON(const juce::String& json)
{
    const auto trimmed = json.trim();
    if (trimmed.isEmpty())
    {
        resetPostCabOrder();
    }
    else
    {
        const auto parsed = juce::JSON::parse(trimmed);
        if (! parsed.isVoid())
            updatePostCabOrderFromUiState(parsed);
    }

    const juce::ScopedLock lock(uiStateLock);
    uiStateJSON = json;
}

juce::String S13NAMRack::getUiStateJSON() const
{
    const juce::ScopedLock lock(uiStateLock);
    return uiStateJSON;
}

static std::array<float, 5> normaliseNAMRackBiquad(const std::array<float, 6>& coefficients) noexcept
{
    const float inverseA0 = std::abs(coefficients[3]) > 1.0e-12f ? 1.0f / coefficients[3] : 0.0f;
    return { coefficients[0] * inverseA0,
             coefficients[1] * inverseA0,
             coefficients[2] * inverseA0,
             coefficients[4] * inverseA0,
             coefficients[5] * inverseA0 };
}

static void initialiseNAMRackBiquad(juce::dsp::IIR::Filter<float>& left,
                                     juce::dsp::IIR::Filter<float>& right,
                                     const std::array<float, 5>& target)
{
    const std::array<float, 6> withUnityA0 {
        target[0], target[1], target[2], 1.0f, target[3], target[4]
    };
    *left.coefficients = withUnityA0;
    *right.coefficients = withUnityA0;
}

static bool smoothNAMRackBiquad(juce::dsp::IIR::Filter<float>& left,
                                juce::dsp::IIR::Filter<float>& right,
                                const std::array<float, 5>& target,
                                float smoothingCoefficient) noexcept
{
    auto& leftCoefficients = left.coefficients->coefficients;
    auto& rightCoefficients = right.coefficients->coefficients;
    jassert(leftCoefficients.size() == 5 && rightCoefficients.size() == 5);
    if (leftCoefficients.size() != 5 || rightCoefficients.size() != 5)
        return false;

    auto* const leftRaw = leftCoefficients.getRawDataPointer();
    auto* const rightRaw = rightCoefficients.getRawDataPointer();
    bool smoothing = false;
    for (int index = 0; index < 5; ++index)
    {
        const auto coefficientIndex = static_cast<size_t>(index);
        const float difference = target[coefficientIndex] - leftRaw[index];
        const float next = std::abs(difference) <= 1.0e-7f
            ? target[coefficientIndex]
            : leftRaw[index] + difference * smoothingCoefficient;
        leftRaw[index] = next;
        rightRaw[index] = next;
        smoothing = smoothing || std::abs(target[coefficientIndex] - next) > 1.0e-6f;
    }
    return smoothing;
}

void S13NAMRack::prepareFilterTargetTables()
{
    filterTargetTablesPrepared = false;
    for (auto& table : toneFilterTables)
        table.resize(static_cast<size_t>(filterGainTableSize));
    for (auto& table : graphicEqFilterTables)
        table.resize(static_cast<size_t>(filterGainTableSize));
    cabHPFFilterTable.resize(static_cast<size_t>(cabHPFTableSize));
    cabLPFFilterTable.resize(static_cast<size_t>(cabLPFTableSize));

    for (int index = 0; index < filterGainTableSize; ++index)
    {
        const float gainDb = -12.0f + static_cast<float>(index) * 0.1f;
        const float gain = juce::Decibels::decibelsToGain(gainDb);
        toneFilterTables[0][static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makeLowShelf(cachedSampleRate, 115.0f, 0.707f, gain));
        toneFilterTables[1][static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makePeakFilter(cachedSampleRate, 780.0f, 0.85f, gain));
        toneFilterTables[2][static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makeHighShelf(cachedSampleRate, 2400.0f, 0.707f, gain));
        toneFilterTables[3][static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makeHighShelf(cachedSampleRate, 5200.0f, 0.8f, gain));
    }

    const float nyquistSafeMax = juce::jmax(1000.0f, static_cast<float>(cachedSampleRate) * 0.45f);
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        const float frequency = juce::jlimit(20.0f,
                                             nyquistSafeMax,
                                             kNAMRackGraphicEqFrequencies[static_cast<size_t>(band)]);
        const float q = band == 0 || band == kNAMRackGraphicEqBandCount - 1 ? 0.9f : 1.15f;
        for (int index = 0; index < filterGainTableSize; ++index)
        {
            const float gainDb = -12.0f + static_cast<float>(index) * 0.1f;
            graphicEqFilterTables[static_cast<size_t>(band)][static_cast<size_t>(index)] = normaliseNAMRackBiquad(
                juce::dsp::IIR::ArrayCoefficients<float>::makePeakFilter(
                    cachedSampleRate, frequency, q, juce::Decibels::decibelsToGain(gainDb)));
        }
    }

    for (int index = 0; index < cabHPFTableSize; ++index)
    {
        const float frequency = 20.0f + static_cast<float>(index);
        cabHPFFilterTable[static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makeHighPass(cachedSampleRate, frequency));
    }
    for (int index = 0; index < cabLPFTableSize; ++index)
    {
        const float frequency = juce::jmin(1000.0f + static_cast<float>(index) * 10.0f,
                                           juce::jmax(1000.0f, static_cast<float>(cachedSampleRate) * 0.45f));
        cabLPFFilterTable[static_cast<size_t>(index)] = normaliseNAMRackBiquad(
            juce::dsp::IIR::ArrayCoefficients<float>::makeLowPass(cachedSampleRate, frequency));
    }

    filterTargetTablesPrepared = true;
}

void S13NAMRack::updateToneFiltersIfNeeded()
{
    const float bass = juce::jlimit(-12.0f, 12.0f, bassDb.load(std::memory_order_relaxed));
    const float mid = juce::jlimit(-12.0f, 12.0f, midDb.load(std::memory_order_relaxed));
    const float treble = juce::jlimit(-12.0f, 12.0f, trebleDb.load(std::memory_order_relaxed));
    const float presence = juce::jlimit(-12.0f, 12.0f, presenceDb.load(std::memory_order_relaxed));
    if (bass == lastBassDb && mid == lastMidDb && treble == lastTrebleDb && presence == lastPresenceDb)
        return;

    lastBassDb = bass;
    lastMidDb = mid;
    lastTrebleDb = treble;
    lastPresenceDb = presence;

    if (! filterTargetTablesPrepared)
        return;

    const auto gainIndex = [] (float gainDb)
    {
        return juce::jlimit(0, filterGainTableSize - 1,
                            juce::roundToInt((gainDb + 12.0f) * 10.0f));
    };
    lowShelfTarget = toneFilterTables[0][static_cast<size_t>(gainIndex(bass))];
    midPeakTarget = toneFilterTables[1][static_cast<size_t>(gainIndex(mid))];
    highShelfTarget = toneFilterTables[2][static_cast<size_t>(gainIndex(treble))];
    presenceShelfTarget = toneFilterTables[3][static_cast<size_t>(gainIndex(presence))];

    if (! rackFilterCoefficientsInitialised)
    {
        initialiseNAMRackBiquad(lowShelfL, lowShelfR, lowShelfTarget);
        initialiseNAMRackBiquad(midPeakL, midPeakR, midPeakTarget);
        initialiseNAMRackBiquad(highShelfL, highShelfR, highShelfTarget);
        initialiseNAMRackBiquad(presenceShelfL, presenceShelfR, presenceShelfTarget);
    }
}

void S13NAMRack::updateGraphicEQFiltersIfNeeded()
{
    const std::array<float, kNAMRackGraphicEqBandCount> gains {
        juce::jlimit(-12.0f, 12.0f, eq65Db.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq125Db.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq250Db.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq500Db.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq1kDb.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq2kDb.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq4kDb.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq8kDb.load(std::memory_order_relaxed)),
        juce::jlimit(-12.0f, 12.0f, eq16kDb.load(std::memory_order_relaxed))
    };

    bool changed = false;
    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        if (std::abs(gains[static_cast<size_t>(band)] - lastGraphicEqDb[static_cast<size_t>(band)]) > 0.001f)
        {
            changed = true;
            break;
        }
    }
    if (! changed)
        return;

    if (! filterTargetTablesPrepared)
        return;

    for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
    {
        const auto index = static_cast<size_t>(band);
        lastGraphicEqDb[index] = gains[index];
        const int gainTableIndex = juce::jlimit(0, filterGainTableSize - 1,
            juce::roundToInt((gains[index] + 12.0f) * 10.0f));
        graphicEqTargets[index] = graphicEqFilterTables[index][static_cast<size_t>(gainTableIndex)];
        if (! rackFilterCoefficientsInitialised)
            initialiseNAMRackBiquad(graphicEqL[index], graphicEqR[index], graphicEqTargets[index]);
    }
    graphicEqCoefficientsSmoothing = rackFilterCoefficientsInitialised;
}

void S13NAMRack::updateCabFiltersIfNeeded()
{
    const float hpf = juce::jlimit(20.0f, 500.0f, cabHPFHz.load(std::memory_order_relaxed));
    const float lpf = juce::jlimit(1000.0f, 20000.0f, cabLPFHz.load(std::memory_order_relaxed));
    if (std::abs(hpf - lastCabHPFHz) <= 1.0f && std::abs(lpf - lastCabLPFHz) <= 8.0f)
        return;

    lastCabHPFHz = hpf;
    lastCabLPFHz = lpf;

    if (! filterTargetTablesPrepared)
        return;

    const int hpfIndex = juce::jlimit(0, cabHPFTableSize - 1,
                                     juce::roundToInt(hpf - 20.0f));
    const int lpfIndex = juce::jlimit(0, cabLPFTableSize - 1,
                                     juce::roundToInt((lpf - 1000.0f) * 0.1f));
    cabHPFTarget = cabHPFFilterTable[static_cast<size_t>(hpfIndex)];
    cabLPFTarget = cabLPFFilterTable[static_cast<size_t>(lpfIndex)];
    if (! rackFilterCoefficientsInitialised)
    {
        initialiseNAMRackBiquad(cabHPFL, cabHPFR, cabHPFTarget);
        initialiseNAMRackBiquad(cabLPFL, cabLPFR, cabLPFTarget);
    }
    cabFilterCoefficientsSmoothing = rackFilterCoefficientsInitialised;
}

void S13NAMRack::resetCabMicState() noexcept
{
    cabMicLowState.fill(0.0f);
    cabRoomState.fill(0.0f);
}

void S13NAMRack::processCabStage(juce::AudioBuffer<float>& buffer, LoadedCabIR* cabForBlock)
{
    const bool irIsLoaded = cabIRLoaded.load(std::memory_order_acquire);
    const bool active = irIsLoaded
        && cabEnabled.load(std::memory_order_relaxed) >= 0.5f;
    smoothedCabMix.setTargetValue(active ? 1.0f : 0.0f);
    cabWasActive = active;
    if (! active && ! smoothedCabMix.isSmoothing())
        return;

    if (workBuffer.getNumChannels() < buffer.getNumChannels()
        || workBuffer.getNumSamples() < buffer.getNumSamples()
        || namTransitionBuffer.getNumChannels() < buffer.getNumChannels()
        || namTransitionBuffer.getNumSamples() < buffer.getNumSamples())
        return;
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        workBuffer.copyFrom(channel, 0, buffer, channel, 0, buffer.getNumSamples());
    auto& processed = buffer;

    updateCabFiltersIfNeeded();

    // Keep the previous IR running while a clear operation fades the cabinet
    // mix to dry. Once the 20 ms bypass ramp completes, an unloaded slot cannot
    // accidentally reveal that retained engine if its power control is toggled.
    const bool shouldProcessCab = cabForBlock != nullptr
        && (irIsLoaded || smoothedCabMix.isSmoothing());
    if (shouldProcessCab)
    {
        const int transitionRemaining = cabForBlock->transitionSamplesRemaining.load(
            std::memory_order_acquire);
        const bool transitionActive = transitionRemaining > 0
            && cabForBlock->transitionFrom != nullptr
            && cabForBlock->transitionSamplesTotal > 0;
        if (transitionActive)
        {
            for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
                namTransitionBuffer.copyFrom(channel, 0, workBuffer, channel, 0, buffer.getNumSamples());

            auto previousBlock = juce::dsp::AudioBlock<float>(namTransitionBuffer)
                .getSubsetChannelBlock(0, static_cast<size_t>(buffer.getNumChannels()))
                .getSubBlock(0, static_cast<size_t>(buffer.getNumSamples()));
            juce::dsp::ProcessContextReplacing<float> previousContext(previousBlock);
            cabForBlock->transitionFrom->convolution.process(previousContext);
        }

        juce::dsp::AudioBlock<float> block(processed);
        juce::dsp::ProcessContextReplacing<float> context(block);
        cabForBlock->convolution.process(context);

        if (transitionActive)
        {
            const int transitionTotal = cabForBlock->transitionSamplesTotal;
            const int transitionProgress = transitionTotal - transitionRemaining;
            for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            {
                const float newWeight = juce::jlimit(
                    0.0f,
                    1.0f,
                    static_cast<float>(transitionProgress + sample + 1)
                        / static_cast<float>(transitionTotal));
                for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
                {
                    const float previous = namTransitionBuffer.getSample(channel, sample);
                    const float next = processed.getSample(channel, sample);
                    processed.setSample(channel, sample, previous + (next - previous) * newWeight);
                }
            }
            cabForBlock->transitionSamplesRemaining.store(
                juce::jmax(0, transitionRemaining - buffer.getNumSamples()),
                std::memory_order_release);
        }
    }

    const int numSamples = processed.getNumSamples();
    const int numChannels = processed.getNumChannels();
    smoothedCabLevelGain.setTargetValue(juce::Decibels::decibelsToGain(
        juce::jlimit(-24.0f, 12.0f, cabLevelDb.load(std::memory_order_relaxed))));
    const bool phaseInverted = cabPhaseInvert.load(std::memory_order_relaxed) >= 0.5f;
    const float position = juce::jlimit(0.0f, 1.0f, cabMicPosition.load(std::memory_order_relaxed));
    const float distance = juce::jlimit(0.0f, 1.0f, cabMicDistance.load(std::memory_order_relaxed));
    const float blend = juce::jlimit(0.0f, 1.0f, cabMicBlend.load(std::memory_order_relaxed));
    const float roomSend = juce::jlimit(0.0f, 1.0f, cabRoomSend.load(std::memory_order_relaxed));
    const float pan = juce::jlimit(-1.0f, 1.0f, cabPan.load(std::memory_order_relaxed));
    const float positionOffset = position - 0.5f;
    const float lowCutoff = 420.0f + distance * 1100.0f;
    const float lowCoeff = std::exp(-2.0f * juce::MathConstants<float>::pi * lowCutoff / static_cast<float>(cachedSampleRate));
    const float roomCoeff = std::exp(-2.0f * juce::MathConstants<float>::pi * 38.0f / static_cast<float>(cachedSampleRate));
    const float distanceGain = juce::Decibels::decibelsToGain(-4.5f * distance);
    const float panLeft = pan > 0.0f ? 1.0f - pan * 0.55f : 1.0f;
    const float panRight = pan < 0.0f ? 1.0f + pan * 0.55f : 1.0f;
    const float coefficientSmoothing = 1.0f - std::exp(-1.0f
        / static_cast<float>(juce::jmax(1.0, cachedSampleRate * 0.025)));

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float level = smoothedCabLevelGain.getNextValue();
        const float polarity = phaseInverted ? -level : level;
        if (cabFilterCoefficientsSmoothing)
        {
            const bool highPassSmoothing = smoothNAMRackBiquad(
                cabHPFL, cabHPFR, cabHPFTarget, coefficientSmoothing);
            const bool lowPassSmoothing = smoothNAMRackBiquad(
                cabLPFL, cabLPFR, cabLPFTarget, coefficientSmoothing);
            cabFilterCoefficientsSmoothing = highPassSmoothing || lowPassSmoothing;
        }

        float left = cabLPFL.processSample(cabHPFL.processSample(processed.getSample(0, sample)));
        float leftLow = cabMicLowState[0] * lowCoeff + left * (1.0f - lowCoeff);
        cabMicLowState[0] = leftLow;
        const float leftHigh = left - leftLow;
        const float leftMicA = left + leftHigh * positionOffset * 0.42f - leftLow * distance * 0.10f;
        const float leftMicB = left - leftHigh * positionOffset * 0.28f - leftHigh * distance * 0.34f + leftLow * distance * 0.12f;
        float leftShaped = (leftMicA * (1.0f - blend) + leftMicB * blend) * distanceGain;
        cabRoomState[0] = cabRoomState[0] * roomCoeff + leftShaped * (1.0f - roomCoeff);
        leftShaped += cabRoomState[0] * roomSend * 0.45f;
        processed.setSample(0, sample, leftShaped * polarity * panLeft);

        if (numChannels > 1)
        {
            float right = cabLPFR.processSample(cabHPFR.processSample(processed.getSample(1, sample)));
            float rightLow = cabMicLowState[1] * lowCoeff + right * (1.0f - lowCoeff);
            cabMicLowState[1] = rightLow;
            const float rightHigh = right - rightLow;
            const float rightMicA = right + rightHigh * positionOffset * 0.42f - rightLow * distance * 0.10f;
            const float rightMicB = right - rightHigh * positionOffset * 0.28f - rightHigh * distance * 0.34f + rightLow * distance * 0.12f;
            float rightShaped = (rightMicA * (1.0f - blend) + rightMicB * blend) * distanceGain;
            cabRoomState[1] = cabRoomState[1] * roomCoeff + rightShaped * (1.0f - roomCoeff);
            rightShaped += cabRoomState[1] * roomSend * 0.45f;
            processed.setSample(1, sample, rightShaped * polarity * panRight);
            for (int ch = 2; ch < numChannels; ++ch)
                processed.setSample(ch, sample, (leftShaped * panLeft + rightShaped * panRight) * 0.5f * polarity);
        }
    }

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float wetAmount = smoothedCabMix.getNextValue();
        const float dryAmount = 1.0f - wetAmount;
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const float drySample = workBuffer.getSample(channel, sample);
            const float wetSample = buffer.getSample(channel, sample);
            buffer.setSample(channel, sample,
                             drySample * dryAmount + wetSample * wetAmount);
        }
    }
}

void S13NAMRack::resetPostCabOrder() noexcept
{
    postCabOrder0.store(namRackPostCabEQ, std::memory_order_relaxed);
    postCabOrder1.store(namRackPostCabMod, std::memory_order_relaxed);
    postCabOrder2.store(namRackPostCabDelay, std::memory_order_relaxed);
    postCabOrder3.store(namRackPostCabReverb, std::memory_order_relaxed);
}

void S13NAMRack::updatePostCabOrderFromUiState(const juce::var& uiState)
{
    const auto order = normalizeNAMRackPostCabOrder(uiState);
    jassert(order.size() >= namRackPostCabModuleCount);
    postCabOrder0.store(order[0], std::memory_order_relaxed);
    postCabOrder1.store(order[1], std::memory_order_relaxed);
    postCabOrder2.store(order[2], std::memory_order_relaxed);
    postCabOrder3.store(order[3], std::memory_order_relaxed);
}

void S13NAMRack::resetAmpFaceplateState() noexcept
{
    ampVoiceLowState.fill(0.0f);
}

void S13NAMRack::processAmpFaceplateInputStage(juce::AudioBuffer<float>& buffer)
{
    const float gainDb = juce::jlimit(-24.0f, 24.0f, ampGainDb.load(std::memory_order_relaxed));
    const bool boostActive = ampBoost.load(std::memory_order_relaxed) >= 0.5f;
    const bool voiceActive = ampVoice.load(std::memory_order_relaxed) >= 0.5f;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const float boostDb = boostActive ? 6.0f : 0.0f;
    smoothedAmpInputGain.setTargetValue(juce::Decibels::decibelsToGain(gainDb + boostDb));
    if (! boostActive && ! voiceActive
        && ! smoothedAmpInputGain.isSmoothing()
        && std::abs(smoothedAmpInputGain.getCurrentValue() - 1.0f) <= 0.000001f)
        return;

    const float cutoffHz = boostActive ? 185.0f : 120.0f;
    const float lowCoeff = std::exp(-2.0f * juce::MathConstants<float>::pi * cutoffHz / static_cast<float>(cachedSampleRate));
    const bool tightenActive = voiceActive || boostActive;
    const float lowMix = tightenActive ? (voiceActive ? 0.55f : 0.86f) : 1.0f;
    const float highMix = voiceActive ? 1.24f : 1.0f;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float gain = smoothedAmpInputGain.getNextValue();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const auto stateIndex = static_cast<size_t>(juce::jmin(ch, 1));
            const float input = buffer.getSample(ch, sample);
            float lowState = ampVoiceLowState[stateIndex];
            lowState = lowState * lowCoeff + input * (1.0f - lowCoeff);
            const float high = input - lowState;
            const float voiced = lowState * lowMix + high * highMix;
            const float output = voiced * gain;
            buffer.setSample(ch, sample, std::isfinite(output) ? output : 0.0f);
            ampVoiceLowState[stateIndex] = lowState;
        }
    }
}

void S13NAMRack::processAmpFaceplateOutputStage(juce::AudioBuffer<float>& buffer)
{
    const float outputDb = juce::jlimit(-24.0f, 12.0f, ampOutputDb.load(std::memory_order_relaxed));
    smoothedAmpOutputGain.setTargetValue(juce::Decibels::decibelsToGain(outputDb));
    if (! smoothedAmpOutputGain.isSmoothing()
        && std::abs(smoothedAmpOutputGain.getCurrentValue() - 1.0f) <= 0.000001f)
        return;

    for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
    {
        const float gain = smoothedAmpOutputGain.getNextValue();
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            const float output = buffer.getSample(ch, sample) * gain;
            buffer.setSample(ch, sample, std::isfinite(output) ? output : 0.0f);
        }
    }
}

void S13NAMRack::processAmpToneStack(juce::AudioBuffer<float>& buffer)
{
    updateToneFiltersIfNeeded();

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    const float coefficientSmoothing = 1.0f - std::exp(-1.0f
        / static_cast<float>(juce::jmax(1.0, cachedSampleRate * 0.025)));
    for (int sample = 0; sample < numSamples; ++sample)
    {
        smoothNAMRackBiquad(lowShelfL, lowShelfR, lowShelfTarget, coefficientSmoothing);
        smoothNAMRackBiquad(midPeakL, midPeakR, midPeakTarget, coefficientSmoothing);
        smoothNAMRackBiquad(highShelfL, highShelfR, highShelfTarget, coefficientSmoothing);
        smoothNAMRackBiquad(presenceShelfL, presenceShelfR, presenceShelfTarget, coefficientSmoothing);

        float left = buffer.getSample(0, sample);
        left = lowShelfL.processSample(left);
        left = midPeakL.processSample(left);
        left = highShelfL.processSample(left);
        left = presenceShelfL.processSample(left);
        buffer.setSample(0, sample, left);

        if (numChannels > 1)
        {
            float right = buffer.getSample(1, sample);
            right = lowShelfR.processSample(right);
            right = midPeakR.processSample(right);
            right = highShelfR.processSample(right);
            right = presenceShelfR.processSample(right);
            buffer.setSample(1, sample, right);
            for (int ch = 2; ch < numChannels; ++ch)
                buffer.setSample(ch, sample, (left + right) * 0.5f);
        }
    }
}

void S13NAMRack::processGraphicEQ(juce::AudioBuffer<float>& buffer)
{
    if (eqEnabled.load(std::memory_order_relaxed) < 0.5f)
        return;

    const std::array<float, kNAMRackGraphicEqBandCount> gains {
        eq65Db.load(std::memory_order_relaxed),
        eq125Db.load(std::memory_order_relaxed),
        eq250Db.load(std::memory_order_relaxed),
        eq500Db.load(std::memory_order_relaxed),
        eq1kDb.load(std::memory_order_relaxed),
        eq2kDb.load(std::memory_order_relaxed),
        eq4kDb.load(std::memory_order_relaxed),
        eq8kDb.load(std::memory_order_relaxed),
        eq16kDb.load(std::memory_order_relaxed)
    };

    bool active = false;
    for (float gain : gains)
    {
        if (std::abs(gain) > 0.001f)
        {
            active = true;
            break;
        }
    }
    updateGraphicEQFiltersIfNeeded();
    if (! active && ! graphicEqCoefficientsSmoothing)
        return;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    const float coefficientSmoothing = 1.0f - std::exp(-1.0f
        / static_cast<float>(juce::jmax(1.0, cachedSampleRate * 0.025)));
    for (int sample = 0; sample < numSamples; ++sample)
    {
        if (graphicEqCoefficientsSmoothing)
        {
            bool stillSmoothing = false;
            for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
            {
                const auto index = static_cast<size_t>(band);
                stillSmoothing = smoothNAMRackBiquad(graphicEqL[index],
                                                      graphicEqR[index],
                                                      graphicEqTargets[index],
                                                      coefficientSmoothing)
                    || stillSmoothing;
            }
            graphicEqCoefficientsSmoothing = stillSmoothing;
        }

        float left = buffer.getSample(0, sample);
        for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
            left = graphicEqL[static_cast<size_t>(band)].processSample(left);
        buffer.setSample(0, sample, left);

        if (numChannels > 1)
        {
            float right = buffer.getSample(1, sample);
            for (int band = 0; band < kNAMRackGraphicEqBandCount; ++band)
                right = graphicEqR[static_cast<size_t>(band)].processSample(right);
            buffer.setSample(1, sample, right);
            for (int ch = 2; ch < numChannels; ++ch)
                buffer.setSample(ch, sample, (left + right) * 0.5f);
        }
    }
}

void S13NAMRack::processCompressorStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const float mix = juce::jlimit(0.0f, 1.0f, compressorMix.load(std::memory_order_relaxed));
    const bool active = compressorEnabled.load(std::memory_order_relaxed) >= 0.5f && mix > 0.0001f;
    if (! active)
    {
        if (compressorWasActive)
        {
            rackCompressor.releaseResources();
            compressorWasActive = false;
        }
        return;
    }

    compressorWasActive = true;
    const float comp = juce::jlimit(0.0f, 1.0f, compressorComp.load(std::memory_order_relaxed));
    const float detail = juce::jlimit(0.0f, 1.0f, compressorDetail.load(std::memory_order_relaxed));
    const float volumeDb = juce::jlimit(-12.0f, 12.0f, compressorVolumeDb.load(std::memory_order_relaxed));

    rackCompressor.threshold.store(-6.0f - comp * 38.0f, std::memory_order_relaxed);
    rackCompressor.ratio.store(1.2f + comp * 8.8f, std::memory_order_relaxed);
    rackCompressor.attack.store(2.0f + (1.0f - detail) * 28.0f, std::memory_order_relaxed);
    rackCompressor.release.store(70.0f + detail * 260.0f, std::memory_order_relaxed);
    rackCompressor.knee.store(5.0f + (1.0f - comp) * 10.0f, std::memory_order_relaxed);
    rackCompressor.makeupGain.store(juce::jmax(0.0f, volumeDb), std::memory_order_relaxed);
    rackCompressor.mix.store(mix, std::memory_order_relaxed);
    rackCompressor.style.store(1.0f, std::memory_order_relaxed);
    rackCompressor.autoMakeup.store(0.0f, std::memory_order_relaxed);
    rackCompressor.autoRelease.store(0.0f, std::memory_order_relaxed);
    rackCompressor.sidechainHPF.store(90.0f, std::memory_order_relaxed);
    rackCompressor.lookaheadMs.store(0.0f, std::memory_order_relaxed);
    rackCompressor.detectorMode.store(2.0f, std::memory_order_relaxed);
    rackCompressor.stereoLink.store(1.0f, std::memory_order_relaxed);
    rackCompressor.processBlock(buffer, midi);

    if (volumeDb < 0.0f)
        buffer.applyGain(juce::Decibels::decibelsToGain(volumeDb));
}

static std::int64_t boundedNAMRackTailSamples(
    double tailSeconds,
    double sampleRate) noexcept
{
    // The rack's longest supported repeat is six seconds at the 10 BPM
    // tempo-sync floor. With the maximum 0.85 feedback, its calculated
    // -60 dB tail is about 255 seconds. Keep the lifecycle finite without
    // cutting that valid extreme case while it is still clearly audible.
    constexpr double maximumFiniteTailSeconds = 300.0;
    const double boundedSeconds = juce::jlimit(
        0.0, maximumFiniteTailSeconds, tailSeconds);
    return static_cast<std::int64_t>(std::llround(
        boundedSeconds * juce::jmax(1.0, sampleRate)));
}

void S13NAMRack::processTapeEchoStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const float mix = juce::jlimit(0.0f, 1.0f, tapeEchoMix.load(std::memory_order_relaxed));
    const bool enabled =
        tapeEchoEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const bool active = enabled && mix > 0.0001f;
    if (! active && tapeEchoTailSamplesRemaining <= 0)
    {
        tapeEchoWasActive = false;
        return;
    }
    const float timeMs = juce::jlimit(20.0f, 1200.0f, tapeEchoTimeMs.load(std::memory_order_relaxed));
    const float feedbackAmount = juce::jlimit(0.0f, 0.85f, tapeEchoFeedback.load(std::memory_order_relaxed));
    const float mod = juce::jlimit(0.0f, 1.0f, tapeEchoMod.load(std::memory_order_relaxed));
    const float tone = juce::jlimit(0.0f, 1.0f, tapeEchoTone.load(std::memory_order_relaxed));

    rackTapeEcho.delayTimeL.store(timeMs, std::memory_order_relaxed);
    rackTapeEcho.delayTimeR.store(juce::jlimit(20.0f, 1200.0f, timeMs * (1.01f + mod * 0.035f)), std::memory_order_relaxed);
    rackTapeEcho.feedback.store(feedbackAmount, std::memory_order_relaxed);
    rackTapeEcho.crossFeed.store(0.05f + mod * 0.12f, std::memory_order_relaxed);
    if (active)
        tapeEchoTailMix = mix;
    rackTapeEcho.mix.store(
        active ? mix : tapeEchoTailMix, std::memory_order_relaxed);
    rackTapeEcho.inputSend.store(
        active ? 1.0f : 0.0f, std::memory_order_relaxed);
    rackTapeEcho.unityDry.store(
        active ? 0.0f : 1.0f, std::memory_order_relaxed);
    rackTapeEcho.pingPong.store(0.0f, std::memory_order_relaxed);
    rackTapeEcho.tempoSync.store(0.0f, std::memory_order_relaxed);
    rackTapeEcho.lpfFreq.store(2600.0f + tone * 11200.0f, std::memory_order_relaxed);
    rackTapeEcho.hpfFreq.store(45.0f + (1.0f - tone) * 210.0f, std::memory_order_relaxed);
    rackTapeEcho.fbSaturation.store(0.16f + mod * 0.46f, std::memory_order_relaxed);
    rackTapeEcho.stereoWidth.store(0.82f + mod * 0.34f, std::memory_order_relaxed);
    rackTapeEcho.delayMode.store(1.0f, std::memory_order_relaxed);
    rackTapeEcho.ducking.store(0.0f, std::memory_order_relaxed);
    rackTapeEcho.processBlock(buffer, midi);

    if (active)
    {
        tapeEchoTailSamplesRemaining = boundedNAMRackTailSamples(
            rackTapeEcho.getTailLengthSeconds(), cachedSampleRate);
        tapeEchoWasActive = true;
    }
    else
    {
        tapeEchoTailSamplesRemaining = juce::jmax<std::int64_t>(
            0,
            tapeEchoTailSamplesRemaining
                - static_cast<std::int64_t>(buffer.getNumSamples()));
        if (tapeEchoTailSamplesRemaining == 0)
        {
            rackTapeEcho.resetTailState();
            tapeEchoTailMix = 0.0f;
            tapeEchoWasActive = false;
        }
    }
}

void S13NAMRack::resetOctaverState() noexcept
{
    octaverDetectorDcState = 0.0f;
    octaverDetectorLowpass1 = 0.0f;
    octaverDetectorLowpass2 = 0.0f;
    octaverDetectorEnvelope = 0.0f;
    octaverDetectorGateGain = 0.0f;
    octaverSharedSubPolarity = 1.0f;
    octaverDetectorChannel = 0;
    octaverDetectorArmed = false;
    octaverDetectorGateOpen = false;
    octaverSubSmooth.fill(0.0f);
    octaverUpHpState.fill(0.0f);
}

void S13NAMRack::processDualOctaverStage(juce::AudioBuffer<float>& buffer)
{
    const float requestedDownMix = juce::jlimit(
        0.0f, 1.0f, octaverDownMix.load(std::memory_order_relaxed));
    const float requestedUpMix = juce::jlimit(
        0.0f, 1.0f, octaverUpMix.load(std::memory_order_relaxed));
    const float requestedDirectMix = juce::jlimit(
        0.0f, 1.25f, octaverDirectMix.load(std::memory_order_relaxed));
    const bool enabled =
        octaverEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const bool active =
        enabled
        && (requestedDownMix > 0.0001f
            || requestedUpMix > 0.0001f
            || std::abs(requestedDirectMix - 1.0f) > 0.0001f);
    smoothedOctaverDownMix.setTargetValue(
        enabled ? requestedDownMix : 0.0f);
    smoothedOctaverUpMix.setTargetValue(
        enabled ? requestedUpMix : 0.0f);
    smoothedOctaverDirectMix.setTargetValue(
        enabled ? requestedDirectMix : 1.0f);
    const bool gainsAreSmoothing =
        smoothedOctaverDownMix.isSmoothing()
        || smoothedOctaverUpMix.isSmoothing()
        || smoothedOctaverDirectMix.isSmoothing();
    if (! active && ! gainsAreSmoothing && ! octaverWasActive)
    {
        return;
    }

    octaverWasActive = active || gainsAreSmoothing;
    const int numChannels = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (numChannels <= 0 || numSamples <= 0)
        return;

    const float sampleRate =
        juce::jmax(1.0f, static_cast<float>(cachedSampleRate));
    const auto onePoleCoefficient = [sampleRate] (float frequency) noexcept
    {
        return 1.0f - std::exp(
            -juce::MathConstants<float>::twoPi * frequency / sampleRate);
    };
    const float detectorDcCoeff = onePoleCoefficient(25.0f);
    const float detectorLowpassCoeff = onePoleCoefficient(420.0f);
    const float subSmoothingCoeff = onePoleCoefficient(1200.0f);
    const float octaveUpDcCoeff = onePoleCoefficient(25.0f);
    const float envelopeRelease =
        std::exp(-1.0f / (sampleRate * 0.060f));
    const float gateAttackCoeff =
        1.0f - std::exp(-1.0f / (sampleRate * 0.002f));
    const float gateReleaseCoeff =
        1.0f - std::exp(-1.0f / (sampleRate * 0.030f));

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float detectorInputs[] {
            buffer.getSample(0, sample),
            numChannels >= 2
                ? buffer.getSample(1, sample)
                : buffer.getSample(0, sample)
        };
        // A stereo average can erase the detector signal when a source is
        // anti-phase. Follow one signed channel and require a meaningful
        // magnitude advantage before switching, avoiding rapid polarity flips
        // when the two channels are nearly equal.
        if (numChannels >= 2)
        {
            const int otherChannel =
                octaverDetectorChannel == 0 ? 1 : 0;
            const float selectedMagnitude = std::abs(
                detectorInputs[octaverDetectorChannel]);
            const float otherMagnitude = std::abs(
                detectorInputs[otherChannel]);
            if (otherMagnitude
                > selectedMagnitude * 1.15f + 1.0e-6f)
            {
                octaverDetectorChannel = otherChannel;
            }
        }
        const float detectorInput =
            detectorInputs[octaverDetectorChannel];
        octaverDetectorDcState +=
            (detectorInput - octaverDetectorDcState) * detectorDcCoeff;
        const float dcFreeDetector =
            detectorInput - octaverDetectorDcState;
        octaverDetectorLowpass1 +=
            (dcFreeDetector - octaverDetectorLowpass1)
            * detectorLowpassCoeff;
        octaverDetectorLowpass2 +=
            (octaverDetectorLowpass1 - octaverDetectorLowpass2)
            * detectorLowpassCoeff;

        const float detectorMagnitude =
            std::abs(octaverDetectorLowpass2);
        octaverDetectorEnvelope = juce::jmax(
            detectorMagnitude,
            octaverDetectorEnvelope * envelopeRelease);
        if (octaverDetectorGateOpen)
        {
            if (octaverDetectorEnvelope < 0.0005f)
                octaverDetectorGateOpen = false;
        }
        else if (octaverDetectorEnvelope > 0.001f)
        {
            octaverDetectorGateOpen = true;
        }

        const float crossingThreshold = juce::jmax(
            1.0e-5f, octaverDetectorEnvelope * 0.08f);
        if (octaverDetectorGateOpen)
        {
            if (octaverDetectorLowpass2 < -crossingThreshold)
                octaverDetectorArmed = true;
            else if (octaverDetectorArmed
                     && octaverDetectorLowpass2 > crossingThreshold)
            {
                octaverSharedSubPolarity =
                    -octaverSharedSubPolarity;
                octaverDetectorArmed = false;
            }
        }
        else
        {
            octaverDetectorArmed = false;
        }

        const float targetGate =
            octaverDetectorGateOpen ? 1.0f : 0.0f;
        const float gateCoeff =
            targetGate > octaverDetectorGateGain
                ? gateAttackCoeff
                : gateReleaseCoeff;
        octaverDetectorGateGain +=
            (targetGate - octaverDetectorGateGain) * gateCoeff;

        const float downMix =
            smoothedOctaverDownMix.getNextValue();
        const float upMix =
            smoothedOctaverUpMix.getNextValue();
        const float directMix =
            smoothedOctaverDirectMix.getNextValue();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const size_t stateIndex =
                static_cast<size_t>(juce::jmin(ch, 1));
            auto* samples = buffer.getWritePointer(ch);
            const float dry = samples[sample];
            const float rectified = std::abs(dry);
            const float subTarget =
                rectified * octaverSharedSubPolarity;
            auto& subSmooth = octaverSubSmooth[stateIndex];
            subSmooth +=
                (subTarget - subSmooth) * subSmoothingCoeff;

            const float octaveUpRaw = rectified * 2.0f;
            auto& octaveUpDc = octaverUpHpState[stateIndex];
            octaveUpDc +=
                (octaveUpRaw - octaveUpDc) * octaveUpDcCoeff;
            const float octaveUp = octaveUpRaw - octaveUpDc;
            const float wet = softLimitCreativeEffect(
                subSmooth * downMix * 0.85f
                + octaveUp * upMix * 0.55f)
                * octaverDetectorGateGain;

            // Keep the direct branch outside the creative limiter. Direct=1
            // is therefore sample-linear even while octave voices are active.
            samples[sample] = dry * directMix + wet;
        }
    }

    if (! active
        && ! smoothedOctaverDownMix.isSmoothing()
        && ! smoothedOctaverUpMix.isSmoothing()
        && ! smoothedOctaverDirectMix.isSmoothing())
    {
        resetOctaverState();
        octaverWasActive = false;
    }
}

static bool captureEmbeddedStageDelayedDry(
    const juce::AudioBuffer<float>& input,
    juce::AudioBuffer<float>& delayedDry,
    juce::dsp::DelayLine<
        float,
        juce::dsp::DelayLineInterpolationTypes::None>& delayLine) noexcept
{
    const int numSamples = input.getNumSamples();
    const int numChannels = input.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return false;
    if (delayedDry.getNumSamples() < numSamples
        || delayedDry.getNumChannels() < numChannels)
        return false;

    for (int channel = 0; channel < numChannels; ++channel)
        delayedDry.copyFrom(
            channel, 0, input, channel, 0, numSamples);

    auto dryBlock = juce::dsp::AudioBlock<float>(delayedDry)
        .getSubsetChannelBlock(0, static_cast<size_t>(numChannels))
        .getSubBlock(0, static_cast<size_t>(numSamples));
    juce::dsp::ProcessContextReplacing<float> delayContext(dryBlock);
    delayLine.process(delayContext);
    return true;
}

static void crossfadeEmbeddedStagePower(
    juce::AudioBuffer<float>& processed,
    const juce::AudioBuffer<float>& delayedDry,
    juce::SmoothedValue<
        float,
        juce::ValueSmoothingTypes::Linear>& powerMix) noexcept
{
    const int numSamples = juce::jmin(
        processed.getNumSamples(), delayedDry.getNumSamples());
    const int numChannels = juce::jmin(
        processed.getNumChannels(), delayedDry.getNumChannels());
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float wet = powerMix.getNextValue();
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const float dry = delayedDry.getSample(channel, sample);
            const float effect = processed.getSample(channel, sample);
            processed.setSample(
                channel, sample, dry + (effect - dry) * wet);
        }
    }
}

void S13NAMRack::processEmbeddedDriveIsland(
    juce::AudioBuffer<float>& buffer,
    juce::MidiBuffer& midi)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const bool precisionActive =
        precisionDriveEnabled.load(
            std::memory_order_relaxed) >= 0.5f;
    const bool chaosActive =
        chaosEnabled.load(
            std::memory_order_relaxed) >= 0.5f
        && chaosMix.load(
            std::memory_order_relaxed) > 0.0001f;
    const bool islandActive =
        precisionActive || chaosActive;
    smoothedEmbeddedDriveIslandPower.setTargetValue(
        islandActive ? 1.0f : 0.0f);

    const bool islandPowerSmoothing =
        smoothedEmbeddedDriveIslandPower
            .isSmoothing();
    const bool writeDelayedDry =
        ! islandActive || islandPowerSmoothing;
    const bool hasDelayedDry =
        embeddedDriveSharedDryBuffer
                .getNumChannels() >= numChannels
        && embeddedDriveSharedDryBuffer
                .getNumSamples() >= numSamples;
    if (hasDelayedDry)
    {
        const int delaySamples = juce::jlimit(
            0,
            maximumEmbeddedDriveLatencySamples,
            embeddedDriveOversamplingLatencySamples);
        std::array<const float*, 2> inputChannels {
            buffer.getReadPointer(0),
            numChannels >= 2
                ? buffer.getReadPointer(1)
                : nullptr
        };
        std::array<float*, 2> dryChannels {
            writeDelayedDry
                ? embeddedDriveSharedDryBuffer
                      .getWritePointer(0)
                : nullptr,
            writeDelayedDry && numChannels >= 2
                ? embeddedDriveSharedDryBuffer
                      .getWritePointer(1)
                : nullptr
        };
        int writeIndex =
            embeddedDriveSharedDryWriteIndex;
        if (delaySamples <= 0)
        {
            for (int channel = 0;
                 channel < numChannels;
                 ++channel)
            {
                if (writeDelayedDry)
                {
                    embeddedDriveSharedDryBuffer
                        .copyFrom(
                            channel,
                            0,
                            buffer,
                            channel,
                            0,
                            numSamples);
                }
            }
        }
        else if (writeDelayedDry)
        {
            for (int sample = 0;
                 sample < numSamples;
                 ++sample)
            {
                for (int channel = 0;
                     channel < numChannels;
                     ++channel)
                {
                    auto& ring =
                        embeddedDriveSharedDryRing[
                            static_cast<size_t>(
                                channel)];
                    dryChannels[
                        static_cast<size_t>(
                            channel)][sample] =
                        ring[static_cast<size_t>(
                            writeIndex)];
                    ring[static_cast<size_t>(
                        writeIndex)] =
                        inputChannels[
                            static_cast<size_t>(
                                channel)][sample];
                }
                if (++writeIndex >= delaySamples)
                    writeIndex = 0;
            }
        }
        else
        {
            // While the island is steadily wet, only the final delay window
            // can be observed if power changes on the next callback.
            const int firstRetainedSample =
                juce::jmax(
                    0,
                    numSamples - delaySamples);
            writeIndex =
                (writeIndex
                 + firstRetainedSample)
                % delaySamples;
            for (int sample = firstRetainedSample;
                 sample < numSamples;
                 ++sample)
            {
                for (int channel = 0;
                     channel < numChannels;
                     ++channel)
                {
                    embeddedDriveSharedDryRing[
                        static_cast<size_t>(
                            channel)]
                        [static_cast<size_t>(
                            writeIndex)] =
                        inputChannels[
                            static_cast<size_t>(
                                channel)][sample];
                }
                if (++writeIndex >= delaySamples)
                    writeIndex = 0;
            }
        }
        embeddedDriveSharedDryWriteIndex =
            writeIndex;
    }
    const bool hasHighRateCapacity =
        embeddedDriveOversampler2x != nullptr
        && precisionDriveBypassBuffer
                .getNumChannels() >= numChannels
        && chaosBypassBuffer
                .getNumChannels() >= numChannels
        && precisionDriveBypassBuffer
                .getNumSamples() >= numSamples * 2
        && chaosBypassBuffer
                .getNumSamples() >= numSamples * 2;
    if (! hasDelayedDry || ! hasHighRateCapacity)
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(
            1, std::memory_order_relaxed);
        smoothedPrecisionDrivePower.skip(
            numSamples * 2);
        smoothedPrecisionDriveVolumeGain.skip(
            numSamples * 2);
        smoothedChaosPower.skip(numSamples * 2);
        smoothedEmbeddedDriveIslandPower.skip(
            numSamples);
        if (hasDelayedDry)
        {
            for (int channel = 0;
                 channel < numChannels;
                 ++channel)
            {
                buffer.copyFrom(
                    channel,
                    0,
                    embeddedDriveSharedDryBuffer,
                    channel,
                    0,
                    numSamples);
            }
        }
        return;
    }

    if (! islandActive
        && ! smoothedEmbeddedDriveIslandPower
                .isSmoothing())
    {
        for (int channel = 0;
             channel < numChannels;
             ++channel)
        {
            buffer.copyFrom(
                channel,
                0,
                embeddedDriveSharedDryBuffer,
                channel,
                0,
                numSamples);
        }
        precisionDriveGateEnvelope = 0.0f;
        precisionDriveGateGain = 1.0f;
        precisionDriveWasActive = false;
        chaosWasActive = false;
        return;
    }

    auto hostBlock =
        juce::dsp::AudioBlock<float>(buffer)
            .getSubsetChannelBlock(
                0,
                static_cast<size_t>(
                    numChannels));
    auto highRateBlock =
        embeddedDriveOversampler2x
            ->processSamplesUp(hostBlock);
    const int highRateSamples =
        static_cast<int>(
            highRateBlock.getNumSamples());
    std::array<float*, 2> highRateChannels {
        highRateBlock.getChannelPointer(0),
        numChannels >= 2
            ? highRateBlock.getChannelPointer(1)
            : nullptr
    };
    juce::AudioBuffer<float> highRateView(
        highRateChannels.data(),
        numChannels,
        highRateSamples);
    processPrecisionDriveStage(
        highRateView, midi);
    processChaosStage(highRateView, midi);
    embeddedDriveOversampler2x
        ->processSamplesDown(hostBlock);

    if (smoothedEmbeddedDriveIslandPower.isSmoothing())
    {
        crossfadeEmbeddedStagePower(
            buffer,
            embeddedDriveSharedDryBuffer,
            smoothedEmbeddedDriveIslandPower);
    }
}

void S13NAMRack::processPrecisionDriveStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const bool enabled = precisionDriveEnabled.load(std::memory_order_relaxed) >= 0.5f;
    smoothedPrecisionDrivePower.setTargetValue(enabled ? 1.0f : 0.0f);
    const bool powerSmoothing =
        smoothedPrecisionDrivePower.isSmoothing();
    if (! enabled && ! powerSmoothing)
    {
        precisionDriveGateEnvelope = 0.0f;
        precisionDriveGateGain = 1.0f;
        precisionDriveWasActive = false;
        return;
    }
    const bool canCrossfade =
        ! powerSmoothing
        || captureEmbeddedStageDelayedDry(
            buffer,
            precisionDriveBypassBuffer,
            precisionDriveBypassDelay);
    if (powerSmoothing && ! canCrossfade)
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(
            1, std::memory_order_relaxed);
        smoothedPrecisionDrivePower.skip(buffer.getNumSamples());
        if (! enabled)
        {
            precisionDriveGateEnvelope = 0.0f;
            precisionDriveGateGain = 1.0f;
            rackPrecisionDrive.mix.store(0.0f, std::memory_order_relaxed);
            rackPrecisionDrive.processBlock(buffer, midi);
            precisionDriveWasActive = false;
            return;
        }
    }

    precisionDriveWasActive = enabled;
    const float volumeDb = juce::jlimit(-12.0f, 12.0f, precisionDriveVolumeDb.load(std::memory_order_relaxed));
    const float bright = juce::jlimit(0.0f, 1.0f, precisionDriveBright.load(std::memory_order_relaxed));
    const float attack = juce::jlimit(0.0f, 1.0f, precisionDriveAttack.load(std::memory_order_relaxed));
    const float gate = juce::jlimit(0.0f, 1.0f, precisionDriveGate.load(std::memory_order_relaxed));
    const float drive = juce::jlimit(0.0f, 1.0f, precisionDriveDrive.load(std::memory_order_relaxed));
    if (gate > 0.0001f)
    {
        const int numSamples = buffer.getNumSamples();
        const int numChannels = buffer.getNumChannels();
        const float thresholdDb = -78.0f + gate * 44.0f;
        const float threshold = juce::Decibels::decibelsToGain(thresholdDb);
        const float releaseMs = 34.0f + gate * 140.0f;
        const float embeddedSampleRate =
            static_cast<float>(
                cachedSampleRate * 2.0);
        const float releaseCoeff = std::exp(
            -1.0f
            / (embeddedSampleRate
               * releaseMs * 0.001f));
        const float closedGain = juce::jlimit(0.04f, 1.0f, 1.0f - gate * 0.92f);
        auto* leftSamples =
            buffer.getWritePointer(0);
        auto* rightSamples =
            numChannels >= 2
                ? buffer.getWritePointer(1)
                : nullptr;

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float absPeak =
                rightSamples != nullptr
                ? juce::jmax(
                      std::abs(leftSamples[sample]),
                      std::abs(rightSamples[sample]))
                : std::abs(leftSamples[sample]);

            precisionDriveGateEnvelope = juce::jmax(absPeak, precisionDriveGateEnvelope * releaseCoeff);
            const float targetGain = precisionDriveGateEnvelope >= threshold ? 1.0f : closedGain;
            const float slew = targetGain > precisionDriveGateGain ? 0.30f : (1.0f - releaseCoeff);
            precisionDriveGateGain += (targetGain - precisionDriveGateGain) * slew;

            leftSamples[sample] *=
                precisionDriveGateGain;
            if (rightSamples != nullptr)
            {
                rightSamples[sample] *=
                    precisionDriveGateGain;
            }
        }
    }
    else
    {
        precisionDriveGateEnvelope = 0.0f;
        precisionDriveGateGain = 1.0f;
    }

    rackPrecisionDrive.satType.store(
        static_cast<float>(S13Saturator::SatType::Transistor),
        std::memory_order_relaxed);
    rackPrecisionDrive.drive.store(
        6.0f + drive * 21.0f,
        std::memory_order_relaxed);
    rackPrecisionDrive.mix.store(
        0.90f + drive * 0.10f,
        std::memory_order_relaxed);
    rackPrecisionDrive.toneFreq.store(2600.0f + bright * 12600.0f, std::memory_order_relaxed);
    rackPrecisionDrive.lowCutFreq.store(70.0f + attack * attack * 760.0f, std::memory_order_relaxed);
    rackPrecisionDrive.outputGain.store(
        getNAMPrecisionDriveOutputGainDb(
            false,
            drive,
            namEffectsDspVersion.load(
                std::memory_order_relaxed)),
        std::memory_order_relaxed);
    rackPrecisionDrive.asymmetry.store(
        0.06f + drive * 0.22f,
        std::memory_order_relaxed);
    rackPrecisionDrive.processBlock(buffer, midi);

    smoothedPrecisionDriveVolumeGain.setTargetValue(
        juce::Decibels::decibelsToGain(volumeDb));
    applySmoothedGain(buffer, smoothedPrecisionDriveVolumeGain);
    if (powerSmoothing && canCrossfade)
        crossfadeEmbeddedStagePower(
            buffer,
            precisionDriveBypassBuffer,
            smoothedPrecisionDrivePower);
}

void S13NAMRack::processChaosStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const float wet = juce::jlimit(0.0f, 1.0f, chaosMix.load(std::memory_order_relaxed));
    const float drive = juce::jlimit(0.0f, 1.0f, chaosDrive.load(std::memory_order_relaxed));
    const float tone = juce::jlimit(0.0f, 1.0f, chaosTone.load(std::memory_order_relaxed));
    const bool enabled =
        chaosEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const bool active = enabled && wet > 0.0001f;
    smoothedChaosPower.setTargetValue(active ? 1.0f : 0.0f);
    const bool powerSmoothing =
        smoothedChaosPower.isSmoothing();
    if (! active && ! powerSmoothing)
    {
        chaosWasActive = false;
        return;
    }
    const bool canCrossfade =
        ! powerSmoothing
        || captureEmbeddedStageDelayedDry(
            buffer, chaosBypassBuffer, chaosBypassDelay);
    if (powerSmoothing && ! canCrossfade)
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(
            1, std::memory_order_relaxed);
        smoothedChaosPower.skip(buffer.getNumSamples());
        if (! active)
        {
            rackChaos.mix.store(0.0f, std::memory_order_relaxed);
            rackChaos.processBlock(buffer, midi);
            chaosWasActive = false;
            return;
        }
    }

    chaosWasActive = active;
    rackChaos.satType.store(
        static_cast<float>(S13Saturator::SatType::DiodeClipper),
        std::memory_order_relaxed);
    rackChaos.drive.store(
        12.0f + drive * 18.0f,
        std::memory_order_relaxed);
    rackChaos.mix.store(wet, std::memory_order_relaxed);
    rackChaos.toneFreq.store(
        2100.0f + tone * 12900.0f,
        std::memory_order_relaxed);
    rackChaos.lowCutFreq.store(
        70.0f + (1.0f - tone) * 180.0f,
        std::memory_order_relaxed);
    rackChaos.outputGain.store(
        -1.5f - drive * 1.5f,
        std::memory_order_relaxed);
    rackChaos.asymmetry.store(
        0.12f + drive * 0.24f,
        std::memory_order_relaxed);
    rackChaos.processBlock(buffer, midi);
    smoothedChaosLevelGain.setTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(-12.0f, 12.0f,
                         chaosLevelDb.load(std::memory_order_relaxed))));
    applySmoothedGain(buffer, smoothedChaosLevelGain);
    if (powerSmoothing && canCrossfade)
        crossfadeEmbeddedStagePower(
            buffer, chaosBypassBuffer, smoothedChaosPower);
}

void S13NAMRack::resetLaserState() noexcept
{
    laserPhase = 0.0f;
    laserControlPhase = 0.0f;
    laserEnvelope = 0.0f;
    laserFilterState.fill(0.0f);
    laserRectifierDcState.fill(0.0f);
}

void S13NAMRack::processLaserStage(juce::AudioBuffer<float>& buffer)
{
    const float requestedMix = juce::jlimit(
        0.0f, 1.0f, laserMix.load(std::memory_order_relaxed));
    const bool active =
        laserEnabled.load(std::memory_order_relaxed) >= 0.5f
        && requestedMix > 0.0001f;
    smoothedLaserMix.setTargetValue(active ? requestedMix : 0.0f);
    if (! active
        && ! smoothedLaserMix.isSmoothing()
        && ! laserWasActive)
    {
        return;
    }

    laserWasActive = active || smoothedLaserMix.isSmoothing();
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const int mode = juce::jlimit(0, 5, static_cast<int>(std::round(laserMode.load(std::memory_order_relaxed))));
    const float speedHz = juce::jlimit(0.05f, 12.0f, laserSpeedHz.load(std::memory_order_relaxed));
    const float sensitivity = juce::jlimit(0.0f, 1.0f, laserSensitivity.load(std::memory_order_relaxed));
    const bool envelopeMode = laserEnvelopeMode.load(std::memory_order_relaxed) >= 0.5f;
    const bool triggerHeld = laserTrigger.load(std::memory_order_relaxed) >= 0.5f;
    const float sampleRate = juce::jmax(1.0f, static_cast<float>(cachedSampleRate));
    const float attackCoeff = 1.0f - std::exp(-1.0f / (sampleRate * 0.0045f));
    const float releaseCoeff = std::exp(-1.0f / (sampleRate * (0.055f + sensitivity * 0.24f)));
    const float lowpassCoeff = juce::jlimit(0.001f, 1.0f,
                                           1.0f - std::exp((-2.0f * juce::MathConstants<float>::pi * (220.0f + sensitivity * 2100.0f))
                                                          / sampleRate));
    const float rectifierDcCoeff = juce::jlimit(
        0.0001f,
        1.0f,
        1.0f
            - std::exp(
                (-2.0f * juce::MathConstants<float>::pi * 25.0f)
                / sampleRate));
    const float wetGain = 0.72f + sensitivity * 0.62f;

    auto modeCarrierHz = [mode, sensitivity] (float control) noexcept
    {
        switch (mode)
        {
            case 0: return 120.0f + control * (360.0f + sensitivity * 620.0f);
            case 1: return 42.0f + control * (140.0f + sensitivity * 280.0f);
            case 2: return 90.0f + control * (900.0f + sensitivity * 1900.0f);
            case 3: return 320.0f + control * (1600.0f + sensitivity * 2800.0f);
            case 4: return 740.0f + control * (3200.0f + sensitivity * 5200.0f);
            default: return 8.0f + control * 28.0f;
        }
    };

    for (int sample = 0; sample < numSamples; ++sample)
    {
        float absPeak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
            absPeak = juce::jmax(absPeak, std::abs(buffer.getSample(ch, sample)));

        if (absPeak > laserEnvelope)
            laserEnvelope += (absPeak - laserEnvelope) * attackCoeff;
        else
            laserEnvelope *= releaseCoeff;

        const float lfo = 0.5f
            + 0.5f
                * std::sin(
                    juce::MathConstants<float>::twoPi
                    * laserControlPhase);
        const float envelopeControl = juce::jlimit(0.0f, 1.0f, laserEnvelope * (3.8f + sensitivity * 9.5f));
        const float control = triggerHeld ? 1.0f : (envelopeMode ? envelopeControl : lfo);
        laserControlPhase += speedHz / sampleRate;
        laserControlPhase -= std::floor(laserControlPhase);
        const float carrierHz = modeCarrierHz(control);
        laserPhase += juce::jlimit(0.0f, 0.49f, carrierHz / sampleRate);
        laserPhase -= std::floor(laserPhase);
        const float carrier = std::sin(juce::MathConstants<float>::twoPi * laserPhase);
        const float stepped = mode == 4 ? (std::round(carrier * (6.0f + sensitivity * 18.0f)) / (6.0f + sensitivity * 18.0f)) : carrier;
        const float currentMix = smoothedLaserMix.getNextValue();

        for (int ch = 0; ch < numChannels; ++ch)
        {
            const size_t stateIndex = static_cast<size_t>(juce::jmin(ch, 1));
            auto* samples = buffer.getWritePointer(ch);
            const float dry = samples[sample];
            laserFilterState[stateIndex] += (dry - laserFilterState[stateIndex]) * lowpassCoeff;
            const float low = laserFilterState[stateIndex];
            const float ring = dry * (mode == 4 ? stepped : carrier);
            const float fullWave = std::abs(dry);
            laserRectifierDcState[stateIndex] +=
                (fullWave - laserRectifierDcState[stateIndex])
                * rectifierDcCoeff;
            const float rectified =
                fullWave - laserRectifierDcState[stateIndex];

            float wet = ring;
            switch (mode)
            {
                case 0:
                    wet = std::tanh(
                        rectified
                        * (1.5f + sensitivity * 3.2f)
                        * (0.72f + control * 0.55f));
                    break;
                case 1:
                    wet = low * (1.12f + sensitivity * 0.7f) - ring * (0.24f + control * 0.36f);
                    break;
                case 2:
                    wet = ring * (0.65f + control * 0.85f) + dry * (control - 0.42f);
                    break;
                case 3:
                    wet = std::tanh((ring + dry * 0.16f) * (1.5f + sensitivity * 4.6f));
                    break;
                case 4:
                    wet = std::tanh(dry * (0.9f + sensitivity * 2.2f) + ring * (1.8f + control * 3.4f));
                    break;
                default:
                    wet = dry * (0.62f + carrier * 0.26f) + ring * (0.22f + sensitivity * 0.24f);
                    break;
            }

            const float limitedWet =
                softLimitCreativeEffect(wet * wetGain);
            samples[sample] =
                dry * (1.0f - currentMix)
                + limitedWet * currentMix;
        }
    }

    if (! active && ! smoothedLaserMix.isSmoothing())
    {
        resetLaserState();
        laserWasActive = false;
    }
}

void S13NAMRack::processModulationStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const bool enabled = modulatorEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const float chMix = juce::jlimit(0.0f, 1.0f, chorusMix.load(std::memory_order_relaxed));
    const bool active = enabled && chMix > 0.0001f;
    if (active)
    {
        modulationBypassDrainSamples = juce::jmax(
            1, juce::roundToInt(static_cast<float>(cachedSampleRate) * 0.025f));
    }
    else if (modulationBypassDrainSamples <= 0)
    {
        if (modulationWasActive)
            rackChorus.resetTailState();
        modulationWasActive = false;
        return;
    }

    modulationWasActive = true;
    {
        const int mode = juce::jlimit(0, 1, static_cast<int>(std::round(modulatorMode.load(std::memory_order_relaxed))));
        const float feedback = juce::jlimit(0.0f, 1.0f, modulatorFeedback.load(std::memory_order_relaxed));
        const float autoRandom = juce::jlimit(0.0f, 1.0f, modulatorAutoRandom.load(std::memory_order_relaxed));
        const float autoSpeed = juce::jlimit(0.0f, 1.0f, modulatorAutoSpeed.load(std::memory_order_relaxed));
        const bool autoMode = modulatorPedalMode.load(std::memory_order_relaxed) >= 0.5f;
        const float pedalPosition = juce::jlimit(0.0f, 1.0f, modulatorPedalPosition.load(std::memory_order_relaxed));
        const float sweep = autoMode ? autoRandom : pedalPosition * 0.5f;
        const float rateScale = autoMode ? (0.72f + autoSpeed * 1.55f) : (0.55f + pedalPosition * 1.65f);
        const float depth = juce::jlimit(0.0f, 1.0f, chorusDepth.load(std::memory_order_relaxed));
        const float effectiveDepth = autoMode
            ? juce::jlimit(0.0f, 1.0f, depth + autoRandom * 0.12f)
            : juce::jlimit(0.0f, 1.0f, depth * (0.35f + pedalPosition * 0.9f));
        const float effectiveFeedback = autoMode
            ? feedback
            : juce::jlimit(0.0f, 1.0f, feedback * (0.45f + pedalPosition * 1.1f));
        rackChorus.mode.store(static_cast<float>(mode), std::memory_order_relaxed);
        rackChorus.rate.store(juce::jlimit(0.05f, 8.0f, chorusRateHz.load(std::memory_order_relaxed) * rateScale), std::memory_order_relaxed);
        rackChorus.depth.store(effectiveDepth, std::memory_order_relaxed);
        rackChorus.mix.store(active ? chMix : 0.0f, std::memory_order_relaxed);
        rackChorus.inputSend.store(active ? 1.0f : 0.0f, std::memory_order_relaxed);
        rackChorus.fbAmount.store(mode == 1 ? (0.08f + effectiveFeedback * 0.72f) : (effectiveFeedback * 0.16f), std::memory_order_relaxed);
        rackChorus.voices.store(mode == 1 ? 2.0f : 5.0f, std::memory_order_relaxed);
        rackChorus.lfoShape.store(0.0f, std::memory_order_relaxed);
        rackChorus.randomBlend.store(autoMode ? autoRandom : 0.0f, std::memory_order_relaxed);
        rackChorus.spread.store(mode == 1 ? 0.58f : 0.72f + sweep * 0.18f, std::memory_order_relaxed);
        rackChorus.highCut.store(mode == 1 ? 9200.0f : 12000.0f, std::memory_order_relaxed);
        rackChorus.lowCut.store(mode == 1 ? 120.0f : 90.0f, std::memory_order_relaxed);
        rackChorus.characterMode.store(
            static_cast<float>(juce::jlimit(
                0,
                2,
                static_cast<int>(std::round(
                    chorusCharacter.load(
                        std::memory_order_relaxed))))),
            std::memory_order_relaxed);
        rackChorus.mixLaw.store(
            namEffectsDspVersion.load(
                std::memory_order_relaxed) >= 2
                ? 1.0f
                : 0.0f,
            std::memory_order_relaxed);
        rackChorus.processBlock(buffer, midi);
    }

    if (! active)
    {
        modulationBypassDrainSamples = juce::jmax(
            0, modulationBypassDrainSamples - buffer.getNumSamples());
        if (modulationBypassDrainSamples == 0)
        {
            rackChorus.resetTailState();
            modulationWasActive = false;
        }
    }
}

void S13NAMRack::processDelayStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const bool enabled = delayEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const float dMix = juce::jlimit(0.0f, 1.0f, delayMix.load(std::memory_order_relaxed));
    const bool active = enabled && dMix > 0.0001f;
    if (! active && delayTailSamplesRemaining <= 0)
    {
        delayWasActive = false;
        return;
    }
    {
        const float timeMs = juce::jlimit(1.0f, 2000.0f, delayTimeMs.load(std::memory_order_relaxed));
        const float mod = juce::jlimit(0.0f, 1.0f, delayMod.load(std::memory_order_relaxed));
        const float ducker = juce::jlimit(0.0f, 1.0f, delayDucker.load(std::memory_order_relaxed));
        const int mode = juce::jlimit(0, 2, static_cast<int>(std::round(delayMode.load(std::memory_order_relaxed))));
        const bool pingPong = delayPingPong.load(std::memory_order_relaxed) >= 0.5f;
        const bool tempoSync = delayTempoSync.load(std::memory_order_relaxed) >= 0.5f;
        rackDelay.delayTimeL.store(timeMs, std::memory_order_relaxed);
        rackDelay.delayTimeR.store(juce::jlimit(1.0f, 2000.0f, timeMs * (pingPong ? 1.18f : 1.0f)), std::memory_order_relaxed);
        rackDelay.feedback.store(juce::jlimit(0.0f, 0.85f, delayFeedback.load(std::memory_order_relaxed)), std::memory_order_relaxed);
        rackDelay.crossFeed.store(pingPong ? 0.12f + mod * 0.16f : 0.02f, std::memory_order_relaxed);
        if (active)
            delayTailMix = dMix;
        rackDelay.mix.store(
            active ? dMix : delayTailMix, std::memory_order_relaxed);
        rackDelay.inputSend.store(
            active ? 1.0f : 0.0f, std::memory_order_relaxed);
        rackDelay.unityDry.store(
            active ? 0.0f : 1.0f, std::memory_order_relaxed);
        rackDelay.pingPong.store(pingPong ? 1.0f : 0.0f, std::memory_order_relaxed);
        rackDelay.tempoSync.store(tempoSync ? 1.0f : 0.0f, std::memory_order_relaxed);
        rackDelay.syncNoteL.store(juce::jlimit(0.0f, 8.0f, 2.0f + mod * 2.0f), std::memory_order_relaxed);
        rackDelay.syncNoteR.store(juce::jlimit(0.0f, 8.0f, pingPong ? 3.0f + mod * 2.0f : 2.0f + mod * 2.0f), std::memory_order_relaxed);
        rackDelay.lpfFreq.store(mode == 0 ? 12000.0f : (4300.0f + (1.0f - mod) * 4200.0f), std::memory_order_relaxed);
        rackDelay.hpfFreq.store(70.0f + mod * 110.0f, std::memory_order_relaxed);
        rackDelay.fbSaturation.store(0.08f + mod * 0.55f, std::memory_order_relaxed);
        rackDelay.stereoWidth.store(pingPong ? 1.15f + mod * 0.18f : 0.92f, std::memory_order_relaxed);
        rackDelay.delayMode.store(static_cast<float>(mode), std::memory_order_relaxed);
        rackDelay.ducking.store(
            active ? ducker : 0.0f, std::memory_order_relaxed);
        rackDelay.processBlock(buffer, midi);
    }

    if (active)
    {
        const auto dryCrossfadeSamples = static_cast<std::int64_t>(
            std::ceil(juce::jmax(1.0, cachedSampleRate) * 0.025));
        delayTailSamplesRemaining = juce::jmax(
            dryCrossfadeSamples,
            boundedNAMRackTailSamples(
                rackDelay.getTailLengthSeconds(), cachedSampleRate));
        delayWasActive = true;
    }
    else
    {
        delayTailSamplesRemaining = juce::jmax<std::int64_t>(
            0,
            delayTailSamplesRemaining
                - static_cast<std::int64_t>(buffer.getNumSamples()));
        if (delayTailSamplesRemaining == 0)
        {
            rackDelay.resetTailState();
            delayTailMix = 0.0f;
            delayWasActive = false;
        }
    }
}

void S13NAMRack::processReverbStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const bool enabled = reverbEnabled.load(std::memory_order_relaxed) >= 0.5f;
    const float rMix = juce::jlimit(0.0f, 1.0f, reverbMix.load(std::memory_order_relaxed));
    const bool active = enabled && rMix > 0.0001f;
    if (! active && reverbTailSamplesRemaining <= 0)
    {
        reverbWasActive = false;
        return;
    }
    {
        const float tone = juce::jlimit(0.0f, 1.0f, reverbTone.load(std::memory_order_relaxed));
        const float decaySec = juce::jlimit(0.2f, 12.0f, reverbDecaySec.load(std::memory_order_relaxed));
        const float preDelayMs = juce::jlimit(0.0f, 500.0f, reverbPreDelayMs.load(std::memory_order_relaxed));
        const float shimmer = juce::jlimit(
            0.0f, 1.0f,
            reverbShimmer.load(std::memory_order_relaxed));
        const float wetGain = std::sin(
            rMix * juce::MathConstants<float>::halfPi);
        const float dryGain = std::cos(
            rMix * juce::MathConstants<float>::halfPi);
        rackReverb.algorithm.store(2.0f, std::memory_order_relaxed);
        rackReverb.roomSize.store(juce::jlimit(0.18f, 0.92f, decaySec / 8.0f), std::memory_order_relaxed);
        rackReverb.damping.store(1.0f - tone * 0.82f, std::memory_order_relaxed);
        if (active)
        {
            reverbTailWet = wetGain;
            reverbTailEarly = wetGain * 0.36f;
        }
        rackReverb.wetLevel.store(
            active ? rMix : reverbTailWet, std::memory_order_relaxed);
        rackReverb.dryLevel.store(
            active ? dryGain : 1.0f,
            std::memory_order_relaxed);
        rackReverb.width.store(1.0f, std::memory_order_relaxed);
        rackReverb.freezeMode.store(0.0f, std::memory_order_relaxed);
        rackReverb.preDelay.store(preDelayMs, std::memory_order_relaxed);
        rackReverb.diffusion.store(
            0.78f + shimmer * 0.18f,
            std::memory_order_relaxed);
        rackReverb.lowCut.store(
            juce::jlimit(
                20.0f,
                500.0f,
                reverbLowCutHz.load(
                    std::memory_order_relaxed)),
            std::memory_order_relaxed);
        rackReverb.highCut.store(juce::jlimit(
            2800.0f, 18000.0f, 3800.0f + tone * 9200.0f),
            std::memory_order_relaxed);
        rackReverb.earlyLevel.store(
            active ? wetGain * 0.36f : reverbTailEarly,
                                    std::memory_order_relaxed);
        rackReverb.decayTime.store(decaySec, std::memory_order_relaxed);
        rackReverb.shimmerAmount.store(
            shimmer,
            std::memory_order_relaxed);
        rackReverb.inputSend.store(
            active ? 1.0f : 0.0f, std::memory_order_relaxed);
        rackReverb.processBlock(buffer, midi);
    }

    if (active)
    {
        reverbTailSamplesRemaining = boundedNAMRackTailSamples(
            rackReverb.getTailLengthSeconds(), cachedSampleRate);
        reverbWasActive = true;
    }
    else
    {
        reverbTailSamplesRemaining = juce::jmax<std::int64_t>(
            0,
            reverbTailSamplesRemaining
                - static_cast<std::int64_t>(buffer.getNumSamples()));
        if (reverbTailSamplesRemaining == 0)
        {
            rackReverb.resetTailState();
            reverbTailWet = 0.0f;
            reverbTailEarly = 0.0f;
            reverbWasActive = false;
        }
    }
}

void S13NAMRack::processPostFX(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    const int order[namRackPostCabModuleCount] = {
        postCabOrder0.load(std::memory_order_relaxed),
        postCabOrder1.load(std::memory_order_relaxed),
        postCabOrder2.load(std::memory_order_relaxed),
        postCabOrder3.load(std::memory_order_relaxed)
    };
    bool seen[namRackPostCabModuleCount] = {};

    auto processModule = [&] (int moduleId)
    {
        if (moduleId < 0 || moduleId >= namRackPostCabModuleCount || seen[moduleId])
            return;

        seen[moduleId] = true;
        switch (moduleId)
        {
            case namRackPostCabEQ:
                processGraphicEQ(buffer);
                break;
            case namRackPostCabMod:
                processModulationStage(buffer, midi);
                break;
            case namRackPostCabDelay:
                processDelayStage(buffer, midi);
                break;
            case namRackPostCabReverb:
                processReverbStage(buffer, midi);
                break;
            default:
                break;
        }
    };

    for (int moduleId : order)
        processModule(moduleId);

    processModule(namRackPostCabEQ);
    processModule(namRackPostCabMod);
    processModule(namRackPostCabDelay);
    processModule(namRackPostCabReverb);
}

bool S13NAMRack::renderAuditionSourceIfNeeded(juce::AudioBuffer<float>& buffer, float inputPeak)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return false;

    const bool sourceEnabled = auditionSource.load(std::memory_order_relaxed) >= 0.5f;
    if (! sourceEnabled)
    {
        auditionSourceSample += static_cast<uint64_t>(numSamples);
        return false;
    }

    constexpr float liveInputThreshold = 0.001f; // about -60 dBFS peak
    if (inputPeak > liveInputThreshold)
    {
        auditionSourceSample += static_cast<uint64_t>(numSamples);
        return false;
    }

    buffer.clear();

    constexpr std::array<int, 16> notes { 40, 45, 52, 57, 59, 57, 52, 45, 43, 47, 52, 55, 59, 55, 52, 47 };
    constexpr std::array<float, 16> velocities { 0.72f, 0.62f, 0.68f, 0.58f, 0.74f, 0.55f, 0.64f, 0.52f,
                                                 0.70f, 0.58f, 0.66f, 0.54f, 0.72f, 0.56f, 0.62f, 0.50f };
    const double sr = juce::jmax(1.0, cachedSampleRate);
    const double stepSec = 0.245;
    const double phraseSec = stepSec * static_cast<double>(notes.size());
    const float twoPi = juce::MathConstants<float>::twoPi;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const uint64_t absoluteSample = auditionSourceSample + static_cast<uint64_t>(sample);
        const double time = static_cast<double>(absoluteSample) / sr;
        const double phraseTime = std::fmod(time, phraseSec);
        const int step = juce::jlimit(0, static_cast<int>(notes.size()) - 1, static_cast<int>(phraseTime / stepSec));
        const double age = phraseTime - static_cast<double>(step) * stepSec;
        if (age > stepSec * 0.86)
            continue;

        const int note = notes[static_cast<size_t>(step)];
        const float freq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(note));
        const float phase = static_cast<float>(std::fmod(time * static_cast<double>(freq), 1.0));
        const float noteBright = juce::jlimit(0.65f, 1.3f, 0.82f + (static_cast<float>(note) - 48.0f) * 0.01f);
        const float attack = age < 0.006 ? static_cast<float>(age / 0.006) : 1.0f;
        const float decay = std::exp(static_cast<float>(-age / (0.34 + 0.04 * (step % 3))));
        const float release = age > stepSec * 0.68 ? juce::jlimit(0.0f, 1.0f, static_cast<float>((stepSec * 0.86 - age) / (stepSec * 0.18))) : 1.0f;
        const float envelope = attack * decay * release;
        const float fundamental = std::sin(twoPi * phase) * 0.68f;
        const float partial2 = std::sin(twoPi * (phase * 2.01f + 0.08f)) * 0.26f * nyquistFade(freq * 2.01f, static_cast<float>(sr));
        const float partial3 = std::sin(twoPi * (phase * 3.02f + 0.27f)) * 0.13f * nyquistFade(freq * 3.02f, static_cast<float>(sr));
        const float pick = builtinNoise(static_cast<int>(absoluteSample & 0x7fffffff), note + 19)
            * std::exp(static_cast<float>(-age / 0.014)) * 0.045f;
        const float voice = (fundamental + partial2 + partial3 + pick) * envelope * velocities[static_cast<size_t>(step)] * noteBright * 0.115f;
        const float pan = juce::jlimit(-0.42f, 0.42f, (static_cast<float>((step % 6)) - 2.5f) * 0.105f);
        const float leftGain = std::sqrt(0.5f * (1.0f - pan));
        const float rightGain = std::sqrt(0.5f * (1.0f + pan));

        if (numChannels == 1)
        {
            buffer.addSample(0, sample, voice * 0.707f);
        }
        else
        {
            buffer.addSample(0, sample, voice * leftGain);
            buffer.addSample(1, sample, voice * rightGain);
            for (int ch = 2; ch < numChannels; ++ch)
                buffer.addSample(ch, sample, voice * 0.5f);
        }
    }

    auditionSourceSample += static_cast<uint64_t>(numSamples);
    return true;
}

void S13NAMRack::processNAMModelCore(juce::AudioBuffer<float>& buffer,
                                     LoadedNAMModel* const model,
                                     const float* const mixEnvelope,
                                     bool pedalSlot)
{
    if (model == nullptr || model->dsp == nullptr)
        return;
    if (model->processFaulted.load(std::memory_order_relaxed))
    {
        processModelDryDelay(buffer, *model);
        return;
    }

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    const int inChannels = juce::jlimit(1, 2, model->inputChannels);
    const int outChannels = juce::jlimit(1, 2, model->outputChannels);
    if (numSamples <= 0 || numChannels <= 0)
        return;
    const double modelSampleRate = model->expectedSampleRate > 1000.0 ? model->expectedSampleRate : cachedSampleRate;
    const bool needsResampling = std::abs(modelSampleRate - cachedSampleRate) > 1.0;
    constexpr int resamplerGuardSamples = 8;
    const int maximumDspSamples = needsResampling
        ? juce::jmax(1, static_cast<int>(std::ceil(static_cast<double>(numSamples) * modelSampleRate / cachedSampleRate)) + 2)
        : numSamples;
    diagnosticLastModelSampleRate.store(static_cast<float>(modelSampleRate), std::memory_order_relaxed);
    diagnosticLastResampled.store(needsResampling, std::memory_order_relaxed);

    const bool buffersTooSmall =
        namInputBuffer.getNumSamples() < numSamples + resamplerGuardSamples
        || namInputBuffer.getNumChannels() < inChannels
        || namOutputBuffer.getNumSamples() < numSamples + resamplerGuardSamples
        || namOutputBuffer.getNumChannels() < outChannels
        || namResampledInputBuffer.getNumSamples() < maximumDspSamples
        || namResampledInputBuffer.getNumChannels() < inChannels
        || namResampledOutputBuffer.getNumSamples() < maximumDspSamples
        || namResampledOutputBuffer.getNumChannels() < outChannels
        || workBuffer.getNumSamples() < numSamples
        || workBuffer.getNumChannels() < numChannels
        || static_cast<int>(namInputPtrs.size()) < inChannels
        || static_cast<int>(namOutputPtrs.size()) < outChannels
        || (needsResampling
            && model->resampledHostFifoCapacity < numSamples + 2 * resamplerGuardSamples);

    if (buffersTooSmall)
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(1, std::memory_order_relaxed);
        diagnosticOversizeBypassCount.fetch_add(1, std::memory_order_relaxed);
        processModelDryDelay(buffer, *model);
        return;
    }

    const int calibrationMode = juce::jlimit(0, 2, static_cast<int>(std::round(
        pedalSlot ? pedalCalibrationMode.load(std::memory_order_relaxed)
                  : ampCalibrationMode.load(std::memory_order_relaxed))));
    const float referenceDbu = calibrationReferenceDbu.load(std::memory_order_relaxed);
    const bool overrideCalibration = calibrationMode == 2;
    const bool metadataCalibration = calibrationMode == 1;
    const bool applyInputCalibration = overrideCalibration || (metadataCalibration && model->hasInputLevelDbu);
    const bool applyOutputCalibration = overrideCalibration || (metadataCalibration && model->hasOutputLevelDbu);
    const float effectiveInputDbu = overrideCalibration
        ? (pedalSlot ? pedalOverrideInputLevelDbu.load(std::memory_order_relaxed)
                     : ampOverrideInputLevelDbu.load(std::memory_order_relaxed))
        : static_cast<float>(model->inputLevelDbu);
    const float effectiveOutputDbu = overrideCalibration
        ? (pedalSlot ? pedalOverrideOutputLevelDbu.load(std::memory_order_relaxed)
                     : ampOverrideOutputLevelDbu.load(std::memory_order_relaxed))
        : static_cast<float>(model->outputLevelDbu);
    const float targetInputGain = juce::Decibels::decibelsToGain(juce::jlimit(
        -36.0f, 36.0f, applyInputCalibration ? referenceDbu - effectiveInputDbu : 0.0f));
    const float targetOutputGain = juce::Decibels::decibelsToGain(juce::jlimit(
        -36.0f, 36.0f, applyOutputCalibration ? effectiveOutputDbu - referenceDbu : 0.0f));
    const float smoothingAmount = 1.0f - std::exp(-static_cast<float>(numSamples)
        / static_cast<float>(juce::jmax(1.0, cachedSampleRate * 0.02)));
    const float inputGainStart = model->currentInputCalibrationGain;
    const float inputGainEnd = inputGainStart + (targetInputGain - inputGainStart) * smoothingAmount;
    const float outputGainStart = model->currentOutputCalibrationGain;
    const float outputGainEnd = outputGainStart + (targetOutputGain - outputGainStart) * smoothingAmount;

    for (int ch = 0; ch < numChannels; ++ch)
        workBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    processModelDryDelay(workBuffer, *model);
    const auto restoreDelayedDry = [&] ()
    {
        for (int ch = 0; ch < numChannels; ++ch)
            buffer.copyFrom(ch, 0, workBuffer, ch, 0, numSamples);
    };
    int dspSamples = numSamples;
    if (needsResampling)
    {
        dspSamples = -1;
        for (int ch = 0; ch < inChannels; ++ch)
        {
            if (inChannels == 1)
                copyNAMMonoInput(namInputBuffer, ch, buffer, numSamples);
            else
                namInputBuffer.copyFrom(ch, 0, buffer, juce::jmin(ch, numChannels - 1), 0, numSamples);
            namInputBuffer.applyGainRamp(ch, 0, numSamples, inputGainStart, inputGainEnd);
            namResampledInputBuffer.clear(ch, 0, maximumDspSamples);
            const int produced = model->inputResamplers[static_cast<size_t>(ch)].process(
                namInputBuffer.getReadPointer(ch),
                numSamples,
                namResampledInputBuffer.getWritePointer(ch),
                maximumDspSamples,
                model->inputResamplerKernel);
            if (produced < 0 || (dspSamples >= 0 && produced != dspSamples))
            {
                model->processFaulted.store(true, std::memory_order_relaxed);
                diagnosticModelProcessFailCount.fetch_add(1, std::memory_order_relaxed);
                restoreDelayedDry();
                return;
            }
            dspSamples = produced;
            namInputPtrs[static_cast<size_t>(ch)] = namResampledInputBuffer.getWritePointer(ch);
        }

        for (int ch = 0; ch < outChannels; ++ch)
        {
            namResampledOutputBuffer.clear(ch, 0, dspSamples);
            namOutputPtrs[static_cast<size_t>(ch)] = namResampledOutputBuffer.getWritePointer(ch);
        }
    }
    else
    {
        for (int ch = 0; ch < inChannels; ++ch)
        {
            if (inChannels == 1)
                copyNAMMonoInput(namInputBuffer, ch, buffer, numSamples);
            else
                namInputBuffer.copyFrom(ch, 0, buffer, juce::jmin(ch, numChannels - 1), 0, numSamples);
            namInputBuffer.applyGainRamp(ch, 0, numSamples, inputGainStart, inputGainEnd);
            namInputPtrs[static_cast<size_t>(ch)] = namInputBuffer.getWritePointer(ch);
        }
        for (int ch = 0; ch < outChannels; ++ch)
        {
            namOutputBuffer.clear(ch, 0, numSamples);
            namOutputPtrs[static_cast<size_t>(ch)] = namOutputBuffer.getWritePointer(ch);
        }
    }
    model->currentInputCalibrationGain = inputGainEnd;

    diagnosticLastDspFrames.store(dspSamples, std::memory_order_relaxed);
    diagnosticMaxDspFrames.store(juce::jmax(diagnosticMaxDspFrames.load(std::memory_order_relaxed), dspSamples),
                                 std::memory_order_relaxed);

    bool processed = dspSamples == 0;
    if (dspSamples > 0)
    {
        try
        {
            processed = guardedNAMProcessBlock(model->dsp.get(), namInputPtrs.data(), namOutputPtrs.data(), dspSamples);
        }
        catch (...)
        {
            processed = false;
        }
    }

    if (! processed)
    {
        model->processFaulted.store(true, std::memory_order_relaxed);
        diagnosticModelProcessFailCount.fetch_add(1, std::memory_order_relaxed);
        restoreDelayedDry();
        return;
    }

    if (needsResampling)
    {
        int hostSamplesProduced = -1;
        for (int ch = 0; ch < outChannels; ++ch)
        {
            namOutputBuffer.clear(ch, 0, numSamples + resamplerGuardSamples);
            const int produced = model->outputResamplers[static_cast<size_t>(ch)].process(
                namResampledOutputBuffer.getReadPointer(ch),
                dspSamples,
                namOutputBuffer.getWritePointer(ch),
                numSamples + resamplerGuardSamples,
                model->outputResamplerKernel);
            if (produced < 0 || (hostSamplesProduced >= 0 && produced != hostSamplesProduced))
            {
                model->processFaulted.store(true, std::memory_order_relaxed);
                diagnosticModelProcessFailCount.fetch_add(1, std::memory_order_relaxed);
                restoreDelayedDry();
                return;
            }
            hostSamplesProduced = produced;
        }

        hostSamplesProduced = juce::jmax(0, hostSamplesProduced);
        const int fifoCapacity = model->resampledHostFifoCapacity;
        if (fifoCapacity <= 0
            || model->resampledHostFifoSize + hostSamplesProduced > fifoCapacity)
        {
            model->processFaulted.store(true, std::memory_order_relaxed);
            diagnosticModelProcessFailCount.fetch_add(1, std::memory_order_relaxed);
            restoreDelayedDry();
            return;
        }

        const int fifoWrite = (model->resampledHostFifoRead + model->resampledHostFifoSize)
            % fifoCapacity;
        for (int sample = 0; sample < hostSamplesProduced; ++sample)
        {
            const int fifoIndex = (fifoWrite + sample) % fifoCapacity;
            for (int ch = 0; ch < outChannels; ++ch)
            {
                model->resampledHostFifo[static_cast<size_t>(ch)][static_cast<size_t>(fifoIndex)] =
                    finiteNAMSample(namOutputBuffer.getSample(ch, sample));
            }
        }
        model->resampledHostFifoSize += hostSamplesProduced;

        // Cumulative input scheduling uses ceil(totalHostFrames * model/host),
        // so the round-trip converter can emit a small host-frame surplus. Keep
        // that surplus instead of discarding it at the callback boundary.
        if (model->resampledHostFifoSize < numSamples)
        {
            model->processFaulted.store(true, std::memory_order_relaxed);
            diagnosticModelProcessFailCount.fetch_add(1, std::memory_order_relaxed);
            restoreDelayedDry();
            return;
        }

        for (int ch = 0; ch < outChannels; ++ch)
        {
            auto* const destination = namOutputBuffer.getWritePointer(ch);
            for (int sample = 0; sample < numSamples; ++sample)
            {
                const int fifoIndex = (model->resampledHostFifoRead + sample)
                    % fifoCapacity;
                destination[sample] = model->resampledHostFifo[static_cast<size_t>(ch)][static_cast<size_t>(fifoIndex)];
            }
        }
        model->resampledHostFifoRead = (model->resampledHostFifoRead + numSamples)
            % fifoCapacity;
        model->resampledHostFifoSize -= numSamples;
    }

    for (int ch = 0; ch < outChannels; ++ch)
        namOutputBuffer.applyGainRamp(ch, 0, numSamples, outputGainStart, outputGainEnd);
    model->currentOutputCalibrationGain = outputGainEnd;

    mixNAMOutputForHostEnvelope(
        buffer, workBuffer, namOutputBuffer, outChannels, mixEnvelope);
}

void S13NAMRack::mixNAMOutputForHost(juce::AudioBuffer<float>& hostBuffer,
                                    const juce::AudioBuffer<float>& delayedDry,
                                    const juce::AudioBuffer<float>& modelOutput,
                                    int modelOutputChannels,
                                    float mixStart,
                                    float mixEnd) noexcept
{
    const int numSamples = juce::jmin(hostBuffer.getNumSamples(),
                                     juce::jmin(delayedDry.getNumSamples(),
                                                modelOutput.getNumSamples()));
    const int hostChannels = juce::jmin(hostBuffer.getNumChannels(),
                                       delayedDry.getNumChannels());
    if (numSamples <= 0 || hostChannels <= 0 || modelOutput.getNumChannels() <= 0)
        return;

    const int wetChannels = juce::jlimit(1,
                                        modelOutput.getNumChannels(),
                                        modelOutputChannels);

    const float wetMixStart = juce::jlimit(0.0f, 1.0f, mixStart);
    const float wetMixEnd = mixEnd < 0.0f
        ? wetMixStart
        : juce::jlimit(0.0f, 1.0f, mixEnd);
    // Match OpenStudio's existing stereo-to-mono render convention. Reading
    // only NAM output 0 would silently discard the model's right channel.
    const bool downmixStereoToMono = hostChannels == 1 && wetChannels >= 2;
    const auto* const wetLeft = modelOutput.getReadPointer(0);
    const auto* const wetRight = downmixStereoToMono
        ? modelOutput.getReadPointer(1)
        : nullptr;

    for (int ch = 0; ch < hostChannels; ++ch)
    {
        auto* const dest = hostBuffer.getWritePointer(ch);
        const auto* const dry = delayedDry.getReadPointer(ch);
        if (downmixStereoToMono)
        {
            for (int sample = 0; sample < numSamples; ++sample)
            {
                const float progress = static_cast<float>(sample + 1)
                    / static_cast<float>(numSamples);
                const float wetMix = wetMixStart
                    + (wetMixEnd - wetMixStart) * progress;
                const float wet = 0.5f * (finiteNAMSample(wetLeft[sample])
                                          + finiteNAMSample(wetRight[sample]));
                dest[sample] = dry[sample] * (1.0f - wetMix) + wet * wetMix;
            }
            continue;
        }

        const int wetChannel = juce::jmin(ch, wetChannels - 1);
        const auto* const wet = modelOutput.getReadPointer(wetChannel);
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float progress = static_cast<float>(sample + 1)
                / static_cast<float>(numSamples);
            const float wetMix = wetMixStart
                + (wetMixEnd - wetMixStart) * progress;
            dest[sample] = dry[sample] * (1.0f - wetMix)
                + finiteNAMSample(wet[sample]) * wetMix;
        }
    }
}

void S13NAMRack::crossfadeProcessedWithDry(
    juce::AudioBuffer<float>& processed,
    const juce::AudioBuffer<float>& dry,
    float mixStart,
    float mixEnd) noexcept
{
    const int numSamples = juce::jmin(
        processed.getNumSamples(), dry.getNumSamples());
    const int numChannels = juce::jmin(
        processed.getNumChannels(), dry.getNumChannels());
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const float start = juce::jlimit(0.0f, 1.0f, mixStart);
    const float end = juce::jlimit(0.0f, 1.0f, mixEnd);
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float progress = static_cast<float>(sample + 1)
            / static_cast<float>(numSamples);
        const float wet = start + (end - start) * progress;
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const float drySample = dry.getSample(channel, sample);
            const float processedSample = processed.getSample(channel, sample);
            processed.setSample(
                channel,
                sample,
                drySample + (processedSample - drySample) * wet);
        }
    }
}

void S13NAMRack::mixNAMOutputForHostEnvelope(
    juce::AudioBuffer<float>& hostBuffer,
    const juce::AudioBuffer<float>& delayedDry,
    const juce::AudioBuffer<float>& modelOutput,
    int modelOutputChannels,
    const float* const mixEnvelope) noexcept
{
    const int numSamples = juce::jmin(
        hostBuffer.getNumSamples(),
        juce::jmin(delayedDry.getNumSamples(), modelOutput.getNumSamples()));
    const int hostChannels = juce::jmin(
        hostBuffer.getNumChannels(), delayedDry.getNumChannels());
    if (numSamples <= 0 || hostChannels <= 0
        || modelOutput.getNumChannels() <= 0)
        return;

    const int wetChannels = juce::jlimit(
        1, modelOutput.getNumChannels(), modelOutputChannels);
    const bool downmixStereoToMono = hostChannels == 1 && wetChannels >= 2;
    const auto* const wetLeft = modelOutput.getReadPointer(0);
    const auto* const wetRight = downmixStereoToMono
        ? modelOutput.getReadPointer(1)
        : nullptr;

    for (int channel = 0; channel < hostChannels; ++channel)
    {
        auto* const destination = hostBuffer.getWritePointer(channel);
        const auto* const dry = delayedDry.getReadPointer(channel);
        const int wetChannel = juce::jmin(channel, wetChannels - 1);
        const auto* const wetForChannel =
            modelOutput.getReadPointer(wetChannel);

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float wetMix = mixEnvelope != nullptr
                ? juce::jlimit(0.0f, 1.0f, mixEnvelope[sample])
                : 0.0f;
            const float wet = downmixStereoToMono
                ? 0.5f * (finiteNAMSample(wetLeft[sample])
                          + finiteNAMSample(wetRight[sample]))
                : finiteNAMSample(wetForChannel[sample]);
            destination[sample] =
                dry[sample] * (1.0f - wetMix) + wet * wetMix;
        }
    }
}

void S13NAMRack::crossfadeProcessedWithDryEnvelope(
    juce::AudioBuffer<float>& processed,
    const juce::AudioBuffer<float>& dry,
    const float* const mixEnvelope) noexcept
{
    const int numSamples = juce::jmin(
        processed.getNumSamples(), dry.getNumSamples());
    const int numChannels = juce::jmin(
        processed.getNumChannels(), dry.getNumChannels());
    if (numSamples <= 0 || numChannels <= 0)
        return;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float wet = mixEnvelope != nullptr
            ? juce::jlimit(0.0f, 1.0f, mixEnvelope[sample])
            : 0.0f;
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const float drySample = dry.getSample(channel, sample);
            const float processedSample = processed.getSample(channel, sample);
            processed.setSample(
                channel,
                sample,
                drySample + (processedSample - drySample) * wet);
        }
    }
}

void S13NAMRack::applySmoothedGain(
    juce::AudioBuffer<float>& buffer,
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>& gain) noexcept
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (! gain.isSmoothing())
    {
        const float currentGain = gain.getCurrentValue();
        if (std::abs(currentGain - 1.0f) <= 1.0e-7f)
            return;
        buffer.applyGain(currentGain);
        return;
    }
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float currentGain = gain.getNextValue();
        for (int channel = 0; channel < numChannels; ++channel)
            buffer.setSample(
                channel, sample, buffer.getSample(channel, sample) * currentGain);
    }
}

void S13NAMRack::processNAMSlot(juce::AudioBuffer<float>& buffer,
                                LoadedNAMModel* const model,
                                const float* const mixEnvelope,
                                bool pedalSlot)
{
    if (model == nullptr)
        return;

    const int transitionRemaining = model->transitionSamplesRemaining.load(std::memory_order_acquire);
    const int numSamples = buffer.getNumSamples();
    if (transitionRemaining <= 0 || model->transitionSamplesTotal <= 0 || numSamples <= 0)
    {
        processNAMModelCore(buffer, model, mixEnvelope, pedalSlot);
        return;
    }

    if (namTransitionBuffer.getNumChannels() < buffer.getNumChannels()
        || namTransitionBuffer.getNumSamples() < numSamples)
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(1, std::memory_order_relaxed);
        model->transitionSamplesRemaining.store(0, std::memory_order_release);
        processNAMModelCore(buffer, model, mixEnvelope, pedalSlot);
        return;
    }

    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        namTransitionBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    if (model->transitionFrom != nullptr)
    {
        // AudioBuffer's external-data constructor uses its inline channel
        // pointer storage for this stereo view, so the callback performs no
        // allocation and the NAM core sees exactly the current host block.
        juce::AudioBuffer<float> transitionView(
            namTransitionBuffer.getArrayOfWritePointers(),
            buffer.getNumChannels(),
            numSamples);
        processNAMModelCore(
            transitionView, model->transitionFrom, mixEnvelope, pedalSlot);
    }
    processNAMModelCore(buffer, model, mixEnvelope, pedalSlot);

    const int alreadyProcessed = model->transitionSamplesTotal - transitionRemaining;
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float linearProgress = juce::jlimit(0.0f,
                                                  1.0f,
                                                  static_cast<float>(alreadyProcessed + sample + 1)
                                                      / static_cast<float>(model->transitionSamplesTotal));
        const float newWeight = linearProgress * linearProgress * (3.0f - 2.0f * linearProgress);
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            const float previous = namTransitionBuffer.getSample(ch, sample);
            const float next = buffer.getSample(ch, sample);
            buffer.setSample(ch, sample, previous + (next - previous) * newWeight);
        }
    }

    model->transitionSamplesRemaining.store(juce::jmax(0, transitionRemaining - numSamples),
                                             std::memory_order_release);
}

void S13NAMRack::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    ScopedNAMModelReader modelReadGuard(modelReaders);
    auto* const ampModelForBlock = activeAmpModel.load(std::memory_order_seq_cst);
    auto* const cabIRForBlock = activeCabIR.load(std::memory_order_seq_cst);
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;
    diagnosticProcessedBlockCount.fetch_add(1, std::memory_order_relaxed);
    diagnosticLastBlockSize.store(numSamples, std::memory_order_relaxed);
    diagnosticMaxBlockSize.store(juce::jmax(diagnosticMaxBlockSize.load(std::memory_order_relaxed), numSamples), std::memory_order_relaxed);
    const bool hasNAMModel = ampModelForBlock != nullptr;
    const bool tightNAMBlock =
        hasNAMModel && numSamples < kNAMRackTightBlockTelemetryThreshold;
    diagnosticObservedTightBlockSize.store(
        tightNAMBlock ? numSamples : 0,
        std::memory_order_relaxed);
    // A small callback is still processed normally. Deadline telemetry in the
    // host decides whether a particular machine/model combination is keeping
    // up; block size alone never changes the rack's signal path.
    diagnosticRealtimeDSPBlocked.store(false, std::memory_order_relaxed);

    const float rawInputPeak = bufferPeakLinear(buffer);
    const bool auditionSourceRendered = renderAuditionSourceIfNeeded(buffer, rawInputPeak);
    const float rawInputDb = juce::jlimit(
        -90.0f,
        6.0f,
        juce::Decibels::gainToDecibels(rawInputPeak, -90.0f));
    // Live input is unchanged when the internal audition source does not fire,
    // which is the normal guitar path. Reuse the already-computed peak instead
    // of scanning the full input buffer a second time on every callback.
    const float postSourceInputDb = auditionSourceRendered ? getBufferPeakDb(buffer) : rawInputDb;
    diagnosticLastRawInputPeakDb.store(rawInputDb, std::memory_order_relaxed);
    diagnosticLastAuditionSourceActive.store(auditionSource.load(std::memory_order_relaxed) >= 0.5f, std::memory_order_relaxed);
    diagnosticLastAuditionSourceRendered.store(auditionSourceRendered, std::memory_order_relaxed);
    diagnosticLastInputPeakDb.store(postSourceInputDb, std::memory_order_relaxed);
    updateNAMMeterLevel(inputLevelDb,
                        postSourceInputDb,
                        numSamples,
                        cachedSampleRate,
                        inputMeterHoldSamplesRemaining);
    smoothedInputGain.setTargetValue(juce::Decibels::decibelsToGain(
        juce::jlimit(
            -24.0f, 24.0f, inputTrimDb.load(std::memory_order_relaxed))));
    applySmoothedGain(buffer, smoothedInputGain);
    if (inputMode.load(std::memory_order_relaxed) >= 0.5f && numChannels >= 2)
    {
        // Mono mode means the rack's routed input (channel 0), not an L/R mix.
        // Single-channel hardware routes arrive as L + silent R, so averaging
        // here would attenuate the guitar by 6.02 dB before NAM calibration.
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float routedMono = buffer.getSample(0, sample);
            for (int ch = 1; ch < numChannels; ++ch)
                buffer.setSample(ch, sample, routedMono);
        }
    }
    const float thresholdDb = juce::jlimit(-100.0f, 0.0f, gateThresholdDb.load(std::memory_order_relaxed));
    if (thresholdDb > -99.0f)
    {
        const float threshold = juce::Decibels::decibelsToGain(thresholdDb);
        const float releaseCoeff = std::exp(-1.0f / (static_cast<float>(cachedSampleRate) * juce::jmax(5.0f, gateReleaseMs.load(std::memory_order_relaxed)) * 0.001f));
        for (int sample = 0; sample < numSamples; ++sample)
        {
            float absPeak = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                absPeak = juce::jmax(absPeak, std::abs(buffer.getSample(ch, sample)));
            gateEnvelope = juce::jmax(absPeak, gateEnvelope * releaseCoeff);
            const float targetGain = gateEnvelope >= threshold ? 1.0f : 0.0f;
            const float gateSlew = targetGain > gateGain ? 0.18f : (1.0f - releaseCoeff);
            gateGain += (targetGain - gateGain) * gateSlew;
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.setSample(ch, sample, buffer.getSample(ch, sample) * gateGain);
        }
    }

    processCompressorStage(buffer, midi);
    processTapeEchoStage(buffer, midi);
    processDualOctaverStage(buffer);
    processEmbeddedDriveIsland(buffer, midi);
    processLaserStage(buffer);
    smoothedAmpMix.setTargetValue(
        juce::jlimit(0.0f, 1.0f, ampMix.load(std::memory_order_relaxed)));
    smoothedAmpPowerMix.setTargetValue(
        ampModelForBlock != nullptr
                && ampEnabled.load(std::memory_order_relaxed) >= 0.5f
            ? 1.0f
            : 0.0f);

    const bool hasLiveTransitionCapacity =
        liveTransitionBuffer.getNumChannels() >= 3
        && liveTransitionBuffer.getNumSamples() >= numSamples;
    const float* ampMixEnvelope = nullptr;
    const float* ampPowerEnvelope = nullptr;
    if (hasLiveTransitionCapacity)
    {
        auto* const ampValues = liveTransitionBuffer.getWritePointer(1);
        auto* const ampPowerValues = liveTransitionBuffer.getWritePointer(2);
        for (int sample = 0; sample < numSamples; ++sample)
        {
            ampValues[sample] = smoothedAmpMix.getNextValue();
            ampPowerValues[sample] = smoothedAmpPowerMix.getNextValue();
        }
        ampMixEnvelope = ampValues;
        ampPowerEnvelope = ampPowerValues;
    }
    else
    {
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(
            1, std::memory_order_relaxed);
        smoothedAmpMix.skip(numSamples);
        smoothedAmpPowerMix.skip(numSamples);
    }

    const bool canCrossfadeAmp =
        ampModelForBlock != nullptr
        && hasLiveTransitionCapacity
        && ampBypassBuffer.getNumChannels() >= numChannels
        && ampBypassBuffer.getNumSamples() >= numSamples;
    if (canCrossfadeAmp)
    {
        for (int channel = 0; channel < numChannels; ++channel)
            ampBypassBuffer.copyFrom(
                channel, 0, buffer, channel, 0, numSamples);
        processAmpBypassDryDelay(ampBypassBuffer, *ampModelForBlock);

        processAmpFaceplateInputStage(buffer);
        processNAMSlot(buffer, ampModelForBlock, ampMixEnvelope, false);
        processAmpToneStack(buffer);
        processAmpFaceplateOutputStage(buffer);
        crossfadeProcessedWithDryEnvelope(
            buffer, ampBypassBuffer, ampPowerEnvelope);
    }
    else if (ampModelForBlock != nullptr)
    {
        // An unexpected oversize host block cannot use the preallocated amp
        // crossfade buffer. Preserve the model's fixed-latency dry path without
        // touching wrapper colour or allocating on the callback.
        diagnosticAudioThreadResizeAvoidedCount.fetch_add(
            1, std::memory_order_relaxed);
        processNAMSlot(buffer, ampModelForBlock, nullptr, false);
        resetAmpFaceplateState();
    }
    else
    {
        // Conservative empty-slot contract: Amp controls shape a loaded Amp
        // capture; they never colour dry input on their own.
        resetAmpFaceplateState();
    }
    processCabStage(buffer, cabIRForBlock);
    processPostFX(buffer, midi);
    smoothedOutputGain.setTargetValue(juce::Decibels::decibelsToGain(
        juce::jlimit(
            -24.0f, 24.0f, outputTrimDb.load(std::memory_order_relaxed))));
    applySmoothedGain(buffer, smoothedOutputGain);
    // Floating-point audio may legitimately exceed 0 dBFS between processors.
    // Only remove invalid DSP values here; clipping belongs at an explicitly
    // selected output stage, not on the always-on NAM rack bus.
    clearNonFiniteSamples(buffer);
    const float outputDb = getBufferPeakDb(buffer);
    diagnosticLastOutputPeakDb.store(outputDb, std::memory_order_relaxed);
    updateNAMMeterLevel(outputLevelDb,
                        outputDb,
                        numSamples,
                        cachedSampleRate,
                        outputMeterHoldSamplesRemaining);
}

void S13NAMRack::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree tree("S13NAMRack");
    tree.setProperty(
        "namEffectsDspVersion",
        namEffectsDspVersion.load(
            std::memory_order_relaxed),
        nullptr);
    tree.setProperty("inputTrimDb", static_cast<double>(inputTrimDb.load()), nullptr);
    tree.setProperty("inputMode", static_cast<double>(inputMode.load()), nullptr);
    tree.setProperty("calibrationStateVersion", 1, nullptr);
    tree.setProperty("calibrationReferenceDbu", static_cast<double>(calibrationReferenceDbu.load()), nullptr);
    tree.setProperty("pedalCalibrationMode", static_cast<double>(pedalCalibrationMode.load()), nullptr);
    tree.setProperty("pedalOverrideInputLevelDbu", static_cast<double>(pedalOverrideInputLevelDbu.load()), nullptr);
    tree.setProperty("pedalOverrideOutputLevelDbu", static_cast<double>(pedalOverrideOutputLevelDbu.load()), nullptr);
    tree.setProperty("ampCalibrationMode", static_cast<double>(ampCalibrationMode.load()), nullptr);
    tree.setProperty("ampOverrideInputLevelDbu", static_cast<double>(ampOverrideInputLevelDbu.load()), nullptr);
    tree.setProperty("ampOverrideOutputLevelDbu", static_cast<double>(ampOverrideOutputLevelDbu.load()), nullptr);
    tree.setProperty("gateThresholdDb", static_cast<double>(gateThresholdDb.load()), nullptr);
    tree.setProperty("gateReleaseMs", static_cast<double>(gateReleaseMs.load()), nullptr);
    tree.setProperty("compressorEnabled", static_cast<double>(compressorEnabled.load()), nullptr);
    tree.setProperty("compressorDetail", static_cast<double>(compressorDetail.load()), nullptr);
    tree.setProperty("compressorMix", static_cast<double>(compressorMix.load()), nullptr);
    tree.setProperty("compressorVolumeDb", static_cast<double>(compressorVolumeDb.load()), nullptr);
    tree.setProperty("compressorComp", static_cast<double>(compressorComp.load()), nullptr);
    tree.setProperty("tapeEchoEnabled", static_cast<double>(tapeEchoEnabled.load()), nullptr);
    tree.setProperty("tapeEchoMix", static_cast<double>(tapeEchoMix.load()), nullptr);
    tree.setProperty("tapeEchoTimeMs", static_cast<double>(tapeEchoTimeMs.load()), nullptr);
    tree.setProperty("tapeEchoFeedback", static_cast<double>(tapeEchoFeedback.load()), nullptr);
    tree.setProperty("tapeEchoMod", static_cast<double>(tapeEchoMod.load()), nullptr);
    tree.setProperty("tapeEchoTone", static_cast<double>(tapeEchoTone.load()), nullptr);
    tree.setProperty("octaverEnabled", static_cast<double>(octaverEnabled.load()), nullptr);
    tree.setProperty("octaverDownMix", static_cast<double>(octaverDownMix.load()), nullptr);
    tree.setProperty("octaverUpMix", static_cast<double>(octaverUpMix.load()), nullptr);
    tree.setProperty("octaverDirectMix", static_cast<double>(octaverDirectMix.load()), nullptr);
    tree.setProperty("precisionDriveEnabled", static_cast<double>(precisionDriveEnabled.load()), nullptr);
    tree.setProperty("precisionDriveVolumeDb", static_cast<double>(precisionDriveVolumeDb.load()), nullptr);
    tree.setProperty("precisionDriveBright", static_cast<double>(precisionDriveBright.load()), nullptr);
    tree.setProperty("precisionDriveAttack", static_cast<double>(precisionDriveAttack.load()), nullptr);
    tree.setProperty("precisionDriveGate", static_cast<double>(precisionDriveGate.load()), nullptr);
    tree.setProperty("precisionDriveDrive", static_cast<double>(precisionDriveDrive.load()), nullptr);
    tree.setProperty("precisionDriveMode", static_cast<double>(precisionDriveMode.load()), nullptr);
    tree.setProperty("chaosEnabled", static_cast<double>(chaosEnabled.load()), nullptr);
    // Preserve the legacy property at Distortion mode for old project readers.
    tree.setProperty("chaosMode", 0.0, nullptr);
    tree.setProperty("chaosDrive", static_cast<double>(chaosDrive.load()), nullptr);
    tree.setProperty("chaosTone", static_cast<double>(chaosTone.load()), nullptr);
    tree.setProperty("chaosMix", static_cast<double>(chaosMix.load()), nullptr);
    tree.setProperty("chaosLevelDb", static_cast<double>(chaosLevelDb.load()), nullptr);
    tree.setProperty("laserEnabled", static_cast<double>(laserEnabled.load()), nullptr);
    tree.setProperty("laserMode", static_cast<double>(laserMode.load()), nullptr);
    tree.setProperty("laserMix", static_cast<double>(laserMix.load()), nullptr);
    tree.setProperty("laserSpeedHz", static_cast<double>(laserSpeedHz.load()), nullptr);
    tree.setProperty("laserSensitivity", static_cast<double>(laserSensitivity.load()), nullptr);
    tree.setProperty("laserEnvelopeMode", static_cast<double>(laserEnvelopeMode.load()), nullptr);
    tree.setProperty("laserTrigger", static_cast<double>(laserTrigger.load()), nullptr);
    tree.setProperty("pedalMix", static_cast<double>(pedalMix.load()), nullptr);
    tree.setProperty("ampEnabled", static_cast<double>(ampEnabled.load()), nullptr);
    tree.setProperty("ampGainDb", static_cast<double>(ampGainDb.load()), nullptr);
    tree.setProperty("ampBoost", static_cast<double>(ampBoost.load()), nullptr);
    tree.setProperty("ampVoice", static_cast<double>(ampVoice.load()), nullptr);
    tree.setProperty("ampMix", static_cast<double>(ampMix.load()), nullptr);
    tree.setProperty("ampOutputDb", static_cast<double>(ampOutputDb.load()), nullptr);
    tree.setProperty("bassDb", static_cast<double>(bassDb.load()), nullptr);
    tree.setProperty("midDb", static_cast<double>(midDb.load()), nullptr);
    tree.setProperty("trebleDb", static_cast<double>(trebleDb.load()), nullptr);
    tree.setProperty("presenceDb", static_cast<double>(presenceDb.load()), nullptr);
    tree.setProperty("eq65Db", static_cast<double>(eq65Db.load()), nullptr);
    tree.setProperty("eq125Db", static_cast<double>(eq125Db.load()), nullptr);
    tree.setProperty("eq250Db", static_cast<double>(eq250Db.load()), nullptr);
    tree.setProperty("eq500Db", static_cast<double>(eq500Db.load()), nullptr);
    tree.setProperty("eq1kDb", static_cast<double>(eq1kDb.load()), nullptr);
    tree.setProperty("eq2kDb", static_cast<double>(eq2kDb.load()), nullptr);
    tree.setProperty("eq4kDb", static_cast<double>(eq4kDb.load()), nullptr);
    tree.setProperty("eq8kDb", static_cast<double>(eq8kDb.load()), nullptr);
    tree.setProperty("eq16kDb", static_cast<double>(eq16kDb.load()), nullptr);
    tree.setProperty("cabRequestedEnabled", isCabRequestedEnabled(), nullptr);
    tree.setProperty("cabEnabled", static_cast<double>(cabEnabled.load()), nullptr);
    tree.setProperty("cabLevelDb", static_cast<double>(cabLevelDb.load()), nullptr);
    tree.setProperty("cabHPFHz", static_cast<double>(cabHPFHz.load()), nullptr);
    tree.setProperty("cabLPFHz", static_cast<double>(cabLPFHz.load()), nullptr);
    tree.setProperty("cabPhaseInvert", static_cast<double>(cabPhaseInvert.load()), nullptr);
    tree.setProperty("cabMicPosition", static_cast<double>(cabMicPosition.load()), nullptr);
    tree.setProperty("cabMicDistance", static_cast<double>(cabMicDistance.load()), nullptr);
    tree.setProperty("cabMicBlend", static_cast<double>(cabMicBlend.load()), nullptr);
    tree.setProperty("cabRoomSend", static_cast<double>(cabRoomSend.load()), nullptr);
    tree.setProperty("cabPan", static_cast<double>(cabPan.load()), nullptr);
    tree.setProperty("eqEnabled", static_cast<double>(eqEnabled.load()), nullptr);
    tree.setProperty("chorusMix", static_cast<double>(chorusMix.load()), nullptr);
    tree.setProperty("chorusRateHz", static_cast<double>(chorusRateHz.load()), nullptr);
    tree.setProperty("chorusDepth", static_cast<double>(chorusDepth.load()), nullptr);
    tree.setProperty("chorusCharacter", static_cast<double>(chorusCharacter.load()), nullptr);
    tree.setProperty("modulatorMode", static_cast<double>(modulatorMode.load()), nullptr);
    tree.setProperty("modulatorFeedback", static_cast<double>(modulatorFeedback.load()), nullptr);
    tree.setProperty("modulatorAutoRandom", static_cast<double>(modulatorAutoRandom.load()), nullptr);
    tree.setProperty("modulatorAutoSpeed", static_cast<double>(modulatorAutoSpeed.load()), nullptr);
    tree.setProperty("modulatorEnabled", static_cast<double>(modulatorEnabled.load()), nullptr);
    tree.setProperty("modulatorPedalMode", static_cast<double>(modulatorPedalMode.load()), nullptr);
    tree.setProperty("modulatorPedalPosition", static_cast<double>(modulatorPedalPosition.load()), nullptr);
    tree.setProperty("delayMix", static_cast<double>(delayMix.load()), nullptr);
    tree.setProperty("delayTimeMs", static_cast<double>(delayTimeMs.load()), nullptr);
    tree.setProperty("delayFeedback", static_cast<double>(delayFeedback.load()), nullptr);
    tree.setProperty("delayMod", static_cast<double>(delayMod.load()), nullptr);
    tree.setProperty("delayDucker", static_cast<double>(delayDucker.load()), nullptr);
    tree.setProperty("delayMode", static_cast<double>(delayMode.load()), nullptr);
    tree.setProperty("delayPingPong", static_cast<double>(delayPingPong.load()), nullptr);
    tree.setProperty("delayTempoSync", static_cast<double>(delayTempoSync.load()), nullptr);
    tree.setProperty("delayEnabled", static_cast<double>(delayEnabled.load()), nullptr);
    tree.setProperty("reverbMix", static_cast<double>(reverbMix.load()), nullptr);
    tree.setProperty("reverbDecaySec", static_cast<double>(reverbDecaySec.load()), nullptr);
    tree.setProperty("reverbTone", static_cast<double>(reverbTone.load()), nullptr);
    tree.setProperty("reverbPreDelayMs", static_cast<double>(reverbPreDelayMs.load()), nullptr);
    tree.setProperty("reverbLowCutHz", static_cast<double>(reverbLowCutHz.load()), nullptr);
    tree.setProperty("reverbShimmer", static_cast<double>(reverbShimmer.load()), nullptr);
    tree.setProperty("reverbShimmerDspVersion", 1, nullptr);
    tree.setProperty("reverbEnabled", static_cast<double>(reverbEnabled.load()), nullptr);
    tree.setProperty("outputTrimDb", static_cast<double>(outputTrimDb.load()), nullptr);
    tree.setProperty("auditionSource", static_cast<double>(auditionSource.load()), nullptr);
    tree.setProperty("pedalModelPath", getPedalModelPath(), nullptr);
    tree.setProperty("ampModelPath", getAmpModelPath(), nullptr);
    tree.setProperty("pedalDeclaredCaptureType", getPedalDeclaredCaptureType(), nullptr);
    tree.setProperty("ampDeclaredCaptureType", getAmpDeclaredCaptureType(), nullptr);
    tree.setProperty("cabIRPath", getCabIRPath(), nullptr);
    tree.setProperty("uiStateJSON", getUiStateJSON(), nullptr);

    juce::MemoryOutputStream stream(destData, false);
    tree.writeToStream(stream);
}

void S13NAMRack::getTonePresetStateInformation(juce::MemoryBlock& destData)
{
    getStateInformation(destData);
    auto tree = loadParamsFromMemory(destData.getData(), static_cast<int>(destData.getSize()), "S13NAMRack");
    if (! tree.isValid())
        return;

    // The interface reference belongs to the user's hardware setup, not to a
    // portable tone. Remove nested A/B/UI snapshot copies too; per-model
    // metadata/override choices remain tone state.
    tree.removeProperty("calibrationReferenceDbu", nullptr);
    tree.removeProperty("auditionSource", nullptr);
    tree.removeProperty("laserTrigger", nullptr);
    const auto savedUiStateJSON = tree.getProperty("uiStateJSON", {}).toString();
    if (savedUiStateJSON.isNotEmpty())
    {
        auto uiState = juce::JSON::parse(savedUiStateJSON);
        if (! uiState.isVoid())
        {
            removeJSONPropertyRecursively(uiState, juce::Identifier("calibrationReferenceDbu"));
            removeJSONPropertyRecursively(uiState, juce::Identifier("auditionSource"));
            removeJSONPropertyRecursively(uiState, juce::Identifier("laserTrigger"));
            tree.setProperty("uiStateJSON", juce::JSON::toString(uiState, false), nullptr);
        }
    }
    tree.setProperty("tonePresetStateVersion", 1, nullptr);
    destData.setSize(0);
    juce::MemoryOutputStream stream(destData, false);
    tree.writeToStream(stream);
}

void S13NAMRack::setStateInformation(const void* data, int sizeInBytes)
{
    (void) restoreProjectStateInformation(data, sizeInBytes);
}

bool S13NAMRack::restoreTonePresetStateInformation(
    const void* data,
    int sizeInBytes,
    const std::function<std::shared_ptr<void>()>& publicationLeaseFactory)
{
    return restoreStateInformationInternal(
        data, sizeInBytes, false, false, true, publicationLeaseFactory);
}

bool S13NAMRack::restoreProjectStateInformation(
    const void* data,
    int sizeInBytes,
    const std::function<std::shared_ptr<void>()>& publicationLeaseFactory,
    std::shared_ptr<void>* retainedPublicationLease)
{
    return restoreStateInformationInternal(
        data, sizeInBytes, true, true, true,
        publicationLeaseFactory, retainedPublicationLease);
}

bool S13NAMRack::restoreRenderPassStateInformation(const void* data, int sizeInBytes)
{
    return restoreStateInformationInternal(data, sizeInBytes, true, false, false);
}

bool S13NAMRack::restoreStateInformationInternal(const void* data,
                                                 int sizeInBytes,
                                                 bool restoreHardwareCalibration,
                                                 bool allowMissingResources,
                                                 bool restoreResources,
                                                 const std::function<std::shared_ptr<void>()>& publicationLeaseFactory,
                                                 std::shared_ptr<void>* retainedPublicationLease)
{
    if (retainedPublicationLease != nullptr)
        retainedPublicationLease->reset();

    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13NAMRack");
    if (!tree.isValid())
        return false;

    const bool pedalPathSpecified = tree.hasProperty("pedalModelPath");
    const bool ampPathSpecified = tree.hasProperty("ampModelPath");
    const bool cabPathSpecified = tree.hasProperty("cabIRPath");
    const bool pedalDeclaredCaptureTypeSpecified =
        tree.hasProperty("pedalDeclaredCaptureType");
    const bool ampDeclaredCaptureTypeSpecified =
        tree.hasProperty("ampDeclaredCaptureType");
    const auto pedalPath = tree.getProperty("pedalModelPath", {}).toString();
    const auto ampPath = tree.getProperty("ampModelPath", {}).toString();
    const auto cabPath = tree.getProperty("cabIRPath", {}).toString();
    const auto restoredPedalDeclaredCaptureType =
        tree.getProperty("pedalDeclaredCaptureType", "unknown").toString();
    const auto restoredAmpDeclaredCaptureType =
        tree.getProperty("ampDeclaredCaptureType", "unknown").toString();
    const auto publishState = [&]
    {
    namEffectsDspVersion.store(
        juce::jlimit(
            1,
            2,
            static_cast<int>(
                tree.getProperty(
                    "namEffectsDspVersion", 1))),
        std::memory_order_relaxed);
    inputTrimDb = static_cast<float>((double)tree.getProperty("inputTrimDb", 0.0));
    inputMode = static_cast<float>((double)tree.getProperty("inputMode", 0.0));
    const bool hasCalibrationState = static_cast<int>(tree.getProperty("calibrationStateVersion", 0)) >= 1;
    if (restoreHardwareCalibration)
        calibrationReferenceDbu = juce::jlimit(-20.0f, 30.0f, static_cast<float>((double)tree.getProperty("calibrationReferenceDbu", 12.0)));
    pedalCalibrationMode = hasCalibrationState
        ? juce::jlimit(0.0f, 2.0f, static_cast<float>((double)tree.getProperty("pedalCalibrationMode", 1.0)))
        : 0.0f;
    pedalOverrideInputLevelDbu = juce::jlimit(-20.0f, 30.0f, static_cast<float>((double)tree.getProperty("pedalOverrideInputLevelDbu", 12.0)));
    pedalOverrideOutputLevelDbu = juce::jlimit(-20.0f, 30.0f, static_cast<float>((double)tree.getProperty("pedalOverrideOutputLevelDbu", 12.0)));
    ampCalibrationMode = hasCalibrationState
        ? juce::jlimit(0.0f, 2.0f, static_cast<float>((double)tree.getProperty("ampCalibrationMode", 1.0)))
        : 0.0f;
    ampOverrideInputLevelDbu = juce::jlimit(-20.0f, 30.0f, static_cast<float>((double)tree.getProperty("ampOverrideInputLevelDbu", 12.0)));
    ampOverrideOutputLevelDbu = juce::jlimit(-20.0f, 30.0f, static_cast<float>((double)tree.getProperty("ampOverrideOutputLevelDbu", 12.0)));
    gateThresholdDb = static_cast<float>((double)tree.getProperty("gateThresholdDb", -80.0));
    gateReleaseMs = static_cast<float>((double)tree.getProperty("gateReleaseMs", 80.0));
    compressorEnabled = static_cast<float>((double)tree.getProperty("compressorEnabled", 0.0));
    compressorDetail = static_cast<float>((double)tree.getProperty("compressorDetail", 0.55));
    compressorMix = static_cast<float>((double)tree.getProperty("compressorMix", 0.65));
    compressorVolumeDb = static_cast<float>((double)tree.getProperty("compressorVolumeDb", 0.0));
    compressorComp = static_cast<float>((double)tree.getProperty("compressorComp", 0.35));
    tapeEchoEnabled = static_cast<float>((double)tree.getProperty("tapeEchoEnabled", 0.0));
    tapeEchoMix = static_cast<float>((double)tree.getProperty("tapeEchoMix", 0.28));
    tapeEchoTimeMs = static_cast<float>((double)tree.getProperty("tapeEchoTimeMs", 360.0));
    tapeEchoFeedback = static_cast<float>((double)tree.getProperty("tapeEchoFeedback", 0.28));
    tapeEchoMod = static_cast<float>((double)tree.getProperty("tapeEchoMod", 0.18));
    tapeEchoTone = static_cast<float>((double)tree.getProperty("tapeEchoTone", 0.58));
    octaverEnabled = static_cast<float>((double)tree.getProperty("octaverEnabled", 0.0));
    octaverDownMix = static_cast<float>((double)tree.getProperty("octaverDownMix", 0.32));
    octaverUpMix = static_cast<float>((double)tree.getProperty("octaverUpMix", 0.18));
    octaverDirectMix = static_cast<float>((double)tree.getProperty("octaverDirectMix", 1.0));
    precisionDriveEnabled = static_cast<float>((double)tree.getProperty("precisionDriveEnabled", 0.0));
    precisionDriveVolumeDb = static_cast<float>((double)tree.getProperty("precisionDriveVolumeDb", 0.0));
    precisionDriveBright = static_cast<float>((double)tree.getProperty("precisionDriveBright", 0.55));
    precisionDriveAttack = static_cast<float>((double)tree.getProperty("precisionDriveAttack", 0.50));
    precisionDriveGate = static_cast<float>((double)tree.getProperty("precisionDriveGate", 0.0));
    precisionDriveDrive = static_cast<float>((double)tree.getProperty("precisionDriveDrive", 0.35));
    precisionDriveMode = juce::jlimit(
        0.0f,
        1.0f,
        static_cast<float>(
            (double)tree.getProperty("precisionDriveMode", 0.0)));
    const bool hasDedicatedDistortionState =
        tree.hasProperty("chaosMode")
        || tree.hasProperty("chaosDrive")
        || tree.hasProperty("chaosTone")
        || tree.hasProperty("chaosLevelDb");
    chaosEnabled = static_cast<float>((double)tree.getProperty("chaosEnabled", 0.0));
    // Chaos was retired; old snapshots migrate to the single diode Distortion
    // circuit regardless of their former mode selection.
    chaosMode = 0.0f;
    chaosDrive = juce::jlimit(
        0.0f, 1.0f,
        static_cast<float>((double)tree.getProperty(
            "chaosDrive",
            tree.getProperty("chaosMix", 0.62))));
    chaosTone = juce::jlimit(
        0.0f, 1.0f,
        static_cast<float>((double)tree.getProperty("chaosTone", 0.55)));
    chaosMix = juce::jlimit(
        0.0f, 1.0f,
        static_cast<float>((double)tree.getProperty(
            "chaosMix", hasDedicatedDistortionState ? 1.0 : 0.22)));
    chaosLevelDb = juce::jlimit(
        -12.0f, 12.0f,
        static_cast<float>((double)tree.getProperty("chaosLevelDb", 0.0)));
    // Migrate projects which used the old Precision Drive distortion toggle.
    // The old sound now lives in the dedicated Distortion pedal, while
    // Precision Drive remains an independent effect.
    if (! hasDedicatedDistortionState
        && precisionDriveMode.load(std::memory_order_relaxed) >= 0.5f)
    {
        chaosEnabled = precisionDriveEnabled.load(std::memory_order_relaxed);
        chaosMode = 0.0f;
        chaosDrive = precisionDriveDrive.load(std::memory_order_relaxed);
        chaosTone = precisionDriveBright.load(std::memory_order_relaxed);
        chaosMix = 1.0f;
        chaosLevelDb = precisionDriveVolumeDb.load(std::memory_order_relaxed);
        precisionDriveEnabled = 0.0f;
    }
    precisionDriveMode = 0.0f;
    laserEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("laserEnabled", 0.0)));
    laserMode = juce::jlimit(0.0f, 5.0f, static_cast<float>((double)tree.getProperty("laserMode", 0.0)));
    laserMix = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("laserMix", 0.35)));
    laserSpeedHz = juce::jlimit(0.05f, 12.0f, static_cast<float>((double)tree.getProperty("laserSpeedHz", 1.2)));
    laserSensitivity = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("laserSensitivity", 0.45)));
    laserEnvelopeMode = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("laserEnvelopeMode", 0.0)));
    laserTrigger = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("laserTrigger", 0.0)));
    pedalMix = static_cast<float>((double)tree.getProperty("pedalMix", 1.0));
    ampEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("ampEnabled", 1.0)));
    ampGainDb = juce::jlimit(-24.0f, 24.0f, static_cast<float>((double)tree.getProperty("ampGainDb", 0.0)));
    ampBoost = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("ampBoost", 0.0)));
    ampVoice = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("ampVoice", 0.0)));
    ampMix = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("ampMix", 1.0)));
    ampOutputDb = juce::jlimit(-24.0f, 12.0f, static_cast<float>((double)tree.getProperty("ampOutputDb", 0.0)));
    bassDb = static_cast<float>((double)tree.getProperty("bassDb", 0.0));
    midDb = static_cast<float>((double)tree.getProperty("midDb", 0.0));
    trebleDb = static_cast<float>((double)tree.getProperty("trebleDb", 0.0));
    presenceDb = static_cast<float>((double)tree.getProperty("presenceDb", 0.0));
    eq65Db = static_cast<float>((double)tree.getProperty("eq65Db", 0.0));
    eq125Db = static_cast<float>((double)tree.getProperty("eq125Db", 0.0));
    eq250Db = static_cast<float>((double)tree.getProperty("eq250Db", 0.0));
    eq500Db = static_cast<float>((double)tree.getProperty("eq500Db", 0.0));
    eq1kDb = static_cast<float>((double)tree.getProperty("eq1kDb", 0.0));
    eq2kDb = static_cast<float>((double)tree.getProperty("eq2kDb", 0.0));
    eq4kDb = static_cast<float>((double)tree.getProperty("eq4kDb", 0.0));
    eq8kDb = static_cast<float>((double)tree.getProperty("eq8kDb", 0.0));
    eq16kDb = static_cast<float>((double)tree.getProperty("eq16kDb", 0.0));
    const float recalledCabEnabled = juce::jlimit(0.0f, 1.0f,
        static_cast<float>((double)tree.getProperty("cabEnabled", 0.0)));
    const bool recalledCabRequested = tree.hasProperty("cabRequestedEnabled")
        ? static_cast<bool>(tree.getProperty("cabRequestedEnabled"))
        : recalledCabEnabled >= 0.5f;
    cabRequestedEnabled.store(recalledCabRequested, std::memory_order_relaxed);
    cabEnabled.store(recalledCabRequested && ! ampModelIncludesCab() ? 1.0f : 0.0f,
                     std::memory_order_relaxed);
    cabLevelDb = static_cast<float>((double)tree.getProperty("cabLevelDb", 0.0));
    cabHPFHz = static_cast<float>((double)tree.getProperty("cabHPFHz", 80.0));
    cabLPFHz = static_cast<float>((double)tree.getProperty("cabLPFHz", 8500.0));
    cabPhaseInvert = static_cast<float>((double)tree.getProperty("cabPhaseInvert", 0.0));
    cabMicPosition = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("cabMicPosition", 0.5)));
    cabMicDistance = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("cabMicDistance", 0.0)));
    cabMicBlend = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("cabMicBlend", 0.5)));
    cabRoomSend = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("cabRoomSend", 0.0)));
    cabPan = juce::jlimit(-1.0f, 1.0f, static_cast<float>((double)tree.getProperty("cabPan", 0.0)));
    eqEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("eqEnabled", 0.0)));
    chorusMix = static_cast<float>((double)tree.getProperty("chorusMix", 0.30));
    chorusRateHz = static_cast<float>((double)tree.getProperty("chorusRateHz", 0.75));
    chorusDepth = static_cast<float>((double)tree.getProperty("chorusDepth", 0.32));
    chorusCharacter = juce::jlimit(
        0.0f,
        2.0f,
        static_cast<float>(
            static_cast<double>(
                tree.getProperty(
                    "chorusCharacter",
                    1.0))));
    modulatorMode = static_cast<float>((double)tree.getProperty("modulatorMode", 0.0));
    modulatorFeedback = static_cast<float>((double)tree.getProperty("modulatorFeedback", 0.10));
    modulatorAutoRandom = static_cast<float>((double)tree.getProperty("modulatorAutoRandom", 0.0));
    modulatorAutoSpeed = static_cast<float>((double)tree.getProperty("modulatorAutoSpeed", 0.35));
    modulatorEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("modulatorEnabled", 0.0)));
    modulatorPedalMode = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("modulatorPedalMode", 1.0)));
    modulatorPedalPosition = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("modulatorPedalPosition", 0.5)));
    delayMix = static_cast<float>((double)tree.getProperty("delayMix", 0.22));
    delayTimeMs = static_cast<float>((double)tree.getProperty("delayTimeMs", 360.0));
    delayFeedback = static_cast<float>((double)tree.getProperty("delayFeedback", 0.22));
    delayMod = static_cast<float>((double)tree.getProperty("delayMod", 0.18));
    delayDucker = static_cast<float>((double)tree.getProperty("delayDucker", 0.12));
    delayMode = static_cast<float>((double)tree.getProperty("delayMode", 1.0));
    delayPingPong = static_cast<float>((double)tree.getProperty("delayPingPong", 1.0));
    delayTempoSync = static_cast<float>((double)tree.getProperty("delayTempoSync", 0.0));
    delayEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("delayEnabled", 0.0)));
    reverbMix = static_cast<float>((double)tree.getProperty("reverbMix", 0.28));
    reverbDecaySec = static_cast<float>((double)tree.getProperty("reverbDecaySec", 2.2));
    reverbTone = static_cast<float>((double)tree.getProperty("reverbTone", 0.62));
    reverbPreDelayMs = static_cast<float>((double)tree.getProperty("reverbPreDelayMs", 18.0));
    reverbLowCutHz = juce::jlimit(
        20.0f,
        500.0f,
        static_cast<float>(
            static_cast<double>(
                tree.getProperty(
                    "reverbLowCutHz", 120.0))));
    // Legacy snapshots may contain the former pseudo-shimmer toggle. Only
    // snapshots explicitly written after the native pitch-feedback DSP shipped
    // may restore that field as an audible amount.
    const int reverbShimmerDspVersion =
        static_cast<int>(
            tree.getProperty(
                "reverbShimmerDspVersion", 0));
    reverbShimmer =
        reverbShimmerDspVersion >= 1
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  static_cast<float>(
                      static_cast<double>(
                          tree.getProperty(
                              "reverbShimmer",
                              0.0))))
            : 0.0f;
    reverbEnabled = juce::jlimit(0.0f, 1.0f, static_cast<float>((double)tree.getProperty("reverbEnabled", 0.0)));
    outputTrimDb = static_cast<float>((double)tree.getProperty("outputTrimDb", 0.0));
    auditionSource = static_cast<float>((double)tree.getProperty("auditionSource", 0.0));

    setUiStateJSON(tree.getProperty("uiStateJSON", {}).toString());
    };

    if (! restoreResources)
    {
        publishState();
        return true;
    }

    const bool resourcesRestored = restoreModelResourceState(pedalPathSpecified,
                                                              pedalPath,
                                                              ampPathSpecified,
                                                              ampPath,
                                                              cabPathSpecified,
                                                              cabPath,
                                                              false,
                                                              allowMissingResources,
                                                              pedalDeclaredCaptureTypeSpecified,
                                                              restoredPedalDeclaredCaptureType,
                                                              ampDeclaredCaptureTypeSpecified,
                                                              restoredAmpDeclaredCaptureType,
                                                              publishState,
                                                              publicationLeaseFactory,
                                                              retainedPublicationLease);
    // Project recovery deliberately publishes all usable state and remembers
    // missing resource paths for relinking. That is a usable restore, not a
    // hard deserialisation failure; lastLoadError carries the degraded detail.
    return resourcesRestored || allowMissingResources;
}

bool S13NAMRack::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainIn = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const bool inputOk = mainIn == juce::AudioChannelSet::mono() || mainIn == juce::AudioChannelSet::stereo();
    const bool outputOk = mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
    return inputOk && outputOk && mainIn.size() == mainOut.size();
}

// ============================================================================
//  S13BasicSynthInstrument
// ============================================================================

static float synthPolyBlep(float phase, float phaseDelta)
{
    if (phaseDelta <= 0.0f)
        return 0.0f;

    if (phase < phaseDelta)
    {
        const float t = phase / phaseDelta;
        return t + t - t * t - 1.0f;
    }

    if (phase > 1.0f - phaseDelta)
    {
        const float t = (phase - 1.0f) / phaseDelta;
        return t * t + t + t + 1.0f;
    }

    return 0.0f;
}

static float synthSaw(float phase, float phaseDelta)
{
    return (2.0f * phase - 1.0f) - synthPolyBlep(phase, phaseDelta);
}

static float synthSquare(float phase, float phaseDelta)
{
    float value = phase < 0.5f ? 1.0f : -1.0f;
    value += synthPolyBlep(phase, phaseDelta);
    float fallingPhase = phase - 0.5f;
    if (fallingPhase < 0.0f)
        fallingPhase += 1.0f;
    value -= synthPolyBlep(fallingPhase, phaseDelta);
    return value;
}

S13BasicSynthInstrument::S13BasicSynthInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13BasicSynthInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13BasicSynthInstrument::releaseResources()
{
    clearVoices();
}

void S13BasicSynthInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : releasing) notes.fill(false);
    for (auto& notes : phaseA) notes.fill(0.0f);
    for (auto& notes : phaseB) notes.fill(0.0f);
    for (auto& notes : phaseSub) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : envelope) notes.fill(0.0f);
    for (auto& notes : filterState) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
    pitchBendSemitones.fill(0.0f);
    modWheel.fill(0.0f);
}

void S13BasicSynthInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isPitchWheel())
    {
        const float normalized = (static_cast<float>(message.getPitchWheelValue()) - 8192.0f) / 8192.0f;
        pitchBendSemitones[static_cast<size_t>(channel)] = juce::jlimit(-2.0f, 2.0f, normalized * 2.0f);
        return;
    }
    if (message.isController() && message.getControllerNumber() == 1)
    {
        modWheel[static_cast<size_t>(channel)] = static_cast<float>(message.getControllerValue()) / 127.0f;
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        phaseA[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        phaseB[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.25f;
        phaseSub[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = message.getFloatVelocity();
        envelope[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        filterState[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& notes : releasing[static_cast<size_t>(channel)])
            notes = true;
    }
}

void S13BasicSynthInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const float sr = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float attackStep = 1.0f / juce::jmax(1.0f, sr * attackMs.load(std::memory_order_relaxed) * 0.001f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, sr * releaseMs.load(std::memory_order_relaxed) * 0.001f);
    const float bright = juce::jlimit(0.0f, 1.0f, brightness.load(std::memory_order_relaxed));
    const float detune = std::pow(2.0f, juce::jlimit(0.0f, 35.0f, detuneCents.load(std::memory_order_relaxed)) / 1200.0f);
    const float sub = juce::jlimit(0.0f, 0.8f, subLevel.load(std::memory_order_relaxed));
    const float noise = juce::jlimit(0.0f, 0.25f, noiseLevel.load(std::memory_order_relaxed));
    const float outGain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed)));
    const float filterCoeff = juce::jlimit(0.015f, 0.55f, 0.04f + bright * bright * 0.46f);
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note] || envelope[channel][note] > 0.0f)
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixed = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;

                if (!active[channel][note] && envelope[channel][note] <= 0.0f)
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                if (active[channel][note] && !releasing[channel][note])
                    envelope[channel][note] = juce::jmin(1.0f, envelope[channel][note] + attackStep);
                else
                    envelope[channel][note] = juce::jmax(0.0f, envelope[channel][note] - releaseStep);

                if (envelope[channel][note] <= 0.0f)
                {
                    active[channel][note] = false;
                    releasing[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float freq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note)));
                const float bendFactor = std::pow(2.0f, pitchBendSemitones[channel] / 12.0f);
                const float mod = juce::jlimit(0.0f, 1.0f, modWheel[channel]);
                const float vibrato = std::sin(twoPi * (static_cast<float>(ageSamples[channel][note]) / sr) * 5.4f) * mod * 0.018f;
                const float modulatedFreq = freq * bendFactor * (1.0f + vibrato);
                const float deltaA = juce::jmin(0.45f, modulatedFreq / sr / detune);
                const float deltaB = juce::jmin(0.45f, modulatedFreq * detune / sr);
                const float deltaSub = juce::jmin(0.45f, modulatedFreq * 0.5f / sr);
                const float saw = synthSaw(phaseA[channel][note], deltaA);
                const float square = synthSquare(phaseB[channel][note], deltaB);
                const float subOsc = std::sin(twoPi * phaseSub[channel][note]);
                const float transient = builtinNoise(ageSamples[channel][note], static_cast<int>(note))
                    * noise * std::exp(-static_cast<float>(ageSamples[channel][note]) / (sr * 0.25f));
                float voice = saw * 0.58f + square * (0.22f + (bright + mod * 0.25f) * 0.18f) + subOsc * sub + transient;

                filterState[channel][note] += filterCoeff * (voice - filterState[channel][note]);
                voice = filterState[channel][note] * envelope[channel][note] * velocity[channel][note] * outGain;
                mixed += voice;

                phaseA[channel][note] += deltaA;
                phaseB[channel][note] += deltaB;
                phaseSub[channel][note] += deltaSub;
                if (phaseA[channel][note] >= 1.0f) phaseA[channel][note] -= std::floor(phaseA[channel][note]);
                if (phaseB[channel][note] >= 1.0f) phaseB[channel][note] -= std::floor(phaseB[channel][note]);
                if (phaseSub[channel][note] >= 1.0f) phaseSub[channel][note] -= std::floor(phaseSub[channel][note]);
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixed = softLimitInstrumentBus(mixed);
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.addSample(ch, sample, mixed);
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13BasicSynthInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13BasicSynthInstrument", {
        { "attackMs", attackMs.load() },
        { "releaseMs", releaseMs.load() },
        { "brightness", brightness.load() },
        { "detuneCents", detuneCents.load() },
        { "subLevel", subLevel.load() },
        { "noiseLevel", noiseLevel.load() },
        { "outputGain", outputGain.load() }
    });
}

void S13BasicSynthInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13BasicSynthInstrument");
    if (!tree.isValid())
        return;

    attackMs    = static_cast<float>((double)tree.getProperty("attackMs", 8.0));
    releaseMs   = static_cast<float>((double)tree.getProperty("releaseMs", 180.0));
    brightness  = static_cast<float>((double)tree.getProperty("brightness", 0.62));
    detuneCents = static_cast<float>((double)tree.getProperty("detuneCents", 7.0));
    subLevel    = static_cast<float>((double)tree.getProperty("subLevel", 0.18));
    noiseLevel  = static_cast<float>((double)tree.getProperty("noiseLevel", 0.015));
    outputGain  = static_cast<float>((double)tree.getProperty("outputGain", -15.0));
}

bool S13BasicSynthInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

// ============================================================================
//  S13PianoInstrument
// ============================================================================

S13PianoInstrument::S13PianoInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

void S13PianoInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13PianoInstrument::releaseResources()
{
    clearVoices();
}

void S13PianoInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : releasing) notes.fill(false);
    for (auto& notes : sustained) notes.fill(false);
    for (auto& notes : phase) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : envelope) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
    sustainPedal.fill(false);
}

void S13PianoInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isController() && message.getControllerNumber() == 64)
    {
        const bool pedalDown = message.getControllerValue() >= 64;
        sustainPedal[static_cast<size_t>(channel)] = pedalDown;
        if (!pedalDown)
        {
            for (int note = 0; note < 128; ++note)
            {
                if (sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)])
                {
                    sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
                    releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
                }
            }
        }
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        phase[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = message.getFloatVelocity();
        envelope[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        if (sustainPedal[static_cast<size_t>(channel)])
            sustained[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        else
            releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& notes : releasing[static_cast<size_t>(channel)])
            notes = true;
        for (auto& notes : sustained[static_cast<size_t>(channel)])
            notes = false;
    }
}

void S13PianoInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const float toneValue = juce::jlimit(0.0f, 1.0f, tone.load(std::memory_order_relaxed));
    const float bodyValue = juce::jlimit(0.0f, 1.0f, body.load(std::memory_order_relaxed));
    const float hammerValue = juce::jlimit(0.0f, 1.0f, hammer.load(std::memory_order_relaxed));
    const float resonanceValue = juce::jlimit(0.0f, 1.0f, resonance.load(std::memory_order_relaxed));
    const float widthValue = juce::jlimit(0.0f, 1.0f, stereoWidth.load(std::memory_order_relaxed));
    const int modelIndex = juce::jlimit(0, 2, static_cast<int>(std::round(model.load(std::memory_order_relaxed))));
    const float sr = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float attackStep = 1.0f / juce::jmax(1.0f, sr * 0.0038f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, sr * releaseMs.load(std::memory_order_relaxed) * 0.001f);
    const float outGain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed))) * 0.78f;
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note] || envelope[channel][note] > 0.0f)
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixedL = 0.0f;
            float mixedR = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;

                if (!active[channel][note] && envelope[channel][note] <= 0.0f)
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                if (active[channel][note] && !releasing[channel][note])
                    envelope[channel][note] = juce::jmin(1.0f, envelope[channel][note] + attackStep);
                else
                    envelope[channel][note] = juce::jmax(0.0f, envelope[channel][note] - releaseStep);

                if (envelope[channel][note] <= 0.0f)
                {
                    active[channel][note] = false;
                    releasing[channel][note] = false;
                    sustained[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float freq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note)));
                const float ageSec = static_cast<float>(ageSamples[channel][note]) / sr;
                const float noteBright = juce::jlimit(0.35f, 1.35f, 0.72f + (static_cast<float>(note) - 60.0f) * 0.008f);
                const float modelTone = modelIndex == 1 ? 1.22f : (modelIndex == 2 ? 0.72f : 1.0f);
                const float pedalLength = sustainPedal[channel] ? 1.0f + resonanceValue * 0.8f : 1.0f;
                const float decay = std::exp(-ageSec / ((0.85f + bodyValue * 2.6f + (1.0f - noteBright) * 0.4f) * pedalLength));
                const float p = phase[channel][note];
                const float strike = builtinNoise(ageSamples[channel][note], static_cast<int>(note))
                    * std::exp(-ageSec / 0.012f) * (0.012f + hammerValue * 0.045f) * modelTone;
                const float fundamental = std::sin(twoPi * p) * (0.82f + bodyValue * 0.28f);
                const float partial2 = std::sin(twoPi * p * 2.003f) * (0.24f + toneValue * 0.20f * modelTone)
                                     * std::exp(-ageSec / 1.1f) * nyquistFade(freq * 2.003f, sr);
                const float partial3 = std::sin(twoPi * p * 3.011f) * (0.13f + toneValue * 0.15f * modelTone)
                                     * std::exp(-ageSec / 0.74f) * nyquistFade(freq * 3.011f, sr);
                const float partial5 = std::sin(twoPi * p * 5.031f) * (0.04f + toneValue * 0.08f * modelTone)
                                     * std::exp(-ageSec / 0.42f) * nyquistFade(freq * 5.031f, sr);
                const float soundboard = std::sin(twoPi * p * 1.497f + 0.7f) * resonanceValue * 0.09f
                                       * std::exp(-ageSec / 3.8f) * nyquistFade(freq * 1.497f, sr);
                const float feltDamping = modelIndex == 2 ? 0.72f : 1.0f;
                const float voice = (fundamental + partial2 + partial3 + partial5 + soundboard + strike)
                                  * decay * envelope[channel][note] * velocity[channel][note] * outGain * feltDamping;
                const float pan = juce::jlimit(-0.82f, 0.82f, (static_cast<float>(note) - 60.0f) / 36.0f * widthValue);
                const float leftGain = std::sqrt(0.5f * (1.0f - pan));
                const float rightGain = std::sqrt(0.5f * (1.0f + pan));
                mixedL += voice * leftGain;
                mixedR += voice * rightGain;

                phase[channel][note] += freq / sr;
                if (phase[channel][note] >= 1.0f)
                    phase[channel][note] -= std::floor(phase[channel][note]);
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixedL = softLimitInstrumentBus(mixedL);
            mixedR = softLimitInstrumentBus(mixedR);
            if (numChannels == 1)
            {
                buffer.addSample(0, sample, (mixedL + mixedR) * 0.707f);
            }
            else
            {
                buffer.addSample(0, sample, mixedL);
                buffer.addSample(1, sample, mixedR);
                for (int ch = 2; ch < numChannels; ++ch)
                    buffer.addSample(ch, sample, (mixedL + mixedR) * 0.5f);
            }
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13PianoInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13PianoInstrument", {
        { "tone", tone.load() },
        { "body", body.load() },
        { "hammer", hammer.load() },
        { "releaseMs", releaseMs.load() },
        { "outputGain", outputGain.load() },
        { "resonance", resonance.load() },
        { "stereoWidth", stereoWidth.load() },
        { "model", model.load() }
    });
}

void S13PianoInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13PianoInstrument");
    if (!tree.isValid())
        return;

    tone       = static_cast<float>((double)tree.getProperty("tone", 0.58));
    body       = static_cast<float>((double)tree.getProperty("body", 0.72));
    hammer     = static_cast<float>((double)tree.getProperty("hammer", 0.42));
    releaseMs  = static_cast<float>((double)tree.getProperty("releaseMs", 950.0));
    outputGain = static_cast<float>((double)tree.getProperty("outputGain", -15.0));
    resonance  = static_cast<float>((double)tree.getProperty("resonance", 0.38));
    stereoWidth = static_cast<float>((double)tree.getProperty("stereoWidth", 0.62));
    model      = static_cast<float>((double)tree.getProperty("model", 0.0));
}

bool S13PianoInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

// ============================================================================
//  S13CleanGuitarInstrument
// ============================================================================

S13CleanGuitarInstrument::S13CleanGuitarInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    stringNote.fill(-1);
    stringChannel.fill(-1);
    for (auto& notes : voiceString)
        notes.fill(-1);
}

void S13CleanGuitarInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13CleanGuitarInstrument::releaseResources()
{
    clearVoices();
}

void S13CleanGuitarInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : releasing) notes.fill(false);
    for (auto& notes : phase) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : envelope) notes.fill(0.0f);
    for (auto& notes : pluckFilter) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
    for (auto& notes : voiceString) notes.fill(-1);
    pitchBendSemitones.fill(0.0f);
    modWheel.fill(0.0f);
    stringNote.fill(-1);
    stringChannel.fill(-1);
    chorusPhase = 0.0f;
}

int S13CleanGuitarInstrument::chooseStringForNote(int note, int midiChannel) const
{
    static constexpr std::array<int, 6> openStrings { 40, 45, 50, 55, 59, 64 };
    const auto noteFitsString = [note] (int string) -> bool
    {
        return string >= 0
            && string < static_cast<int>(openStrings.size())
            && note >= openStrings[static_cast<size_t>(string)];
    };

    const int mode = juce::jlimit(0, 2, static_cast<int>(std::round(stringMode.load(std::memory_order_relaxed))));
    if (mode == 1 && noteFitsString(midiChannel))
        return midiChannel;

    if (mode == 2 && noteFitsString(midiChannel - 1))
        return midiChannel - 1;

    for (int string = static_cast<int>(openStrings.size()) - 1; string >= 0; --string)
        if (noteFitsString(string) && stringNote[static_cast<size_t>(string)] < 0)
            return string;

    for (int string = static_cast<int>(openStrings.size()) - 1; string >= 0; --string)
        if (noteFitsString(string))
            return string;

    return 0;
}

void S13CleanGuitarInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isPitchWheel())
    {
        const float normalized = (static_cast<float>(message.getPitchWheelValue()) - 8192.0f) / 8192.0f;
        const float range = juce::jlimit(0.0f, 24.0f, bendRangeSemitones.load(std::memory_order_relaxed));
        pitchBendSemitones[static_cast<size_t>(channel)] = juce::jlimit(-range, range, normalized * range);
        return;
    }
    if (message.isController() && message.getControllerNumber() == 1)
    {
        modWheel[static_cast<size_t>(channel)] = static_cast<float>(message.getControllerValue()) / 127.0f;
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        const int string = chooseStringForNote(note, channel);
        const int previousNote = stringNote[static_cast<size_t>(string)];
        const int previousChannel = stringChannel[static_cast<size_t>(string)];
        if (previousNote >= 0 && previousChannel >= 0)
            releasing[static_cast<size_t>(previousChannel)][static_cast<size_t>(previousNote)] = true;

        stringNote[static_cast<size_t>(string)] = note;
        stringChannel[static_cast<size_t>(string)] = channel;
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = false;
        phase[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = message.getFloatVelocity();
        envelope[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        pluckFilter[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;
        voiceString[static_cast<size_t>(channel)][static_cast<size_t>(note)] = string;
    }
    else if (message.isNoteOff())
    {
        const int note = juce::jlimit(0, 127, message.getNoteNumber());
        releasing[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        for (int string = 0; string < 6; ++string)
        {
            if (stringNote[static_cast<size_t>(string)] == note && stringChannel[static_cast<size_t>(string)] == channel)
            {
                stringNote[static_cast<size_t>(string)] = -1;
                stringChannel[static_cast<size_t>(string)] = -1;
            }
        }
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& notes : releasing[static_cast<size_t>(channel)])
            notes = true;
        for (int string = 0; string < 6; ++string)
        {
            if (stringChannel[static_cast<size_t>(string)] == channel)
            {
                stringNote[static_cast<size_t>(string)] = -1;
                stringChannel[static_cast<size_t>(string)] = -1;
            }
        }
    }
}

void S13CleanGuitarInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const int modelIndex = juce::jlimit(0, 3, static_cast<int>(std::round(model.load(std::memory_order_relaxed))));
    const float toneValue = juce::jlimit(0.0f, 1.0f, tone.load(std::memory_order_relaxed));
    const float bodyValue = juce::jlimit(0.0f, 1.0f, body.load(std::memory_order_relaxed));
    const float pickValue = juce::jlimit(0.0f, 1.0f, pickNoise.load(std::memory_order_relaxed));
    const float chorusValue = juce::jlimit(0.0f, 1.0f, chorus.load(std::memory_order_relaxed));
    const float sr = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float attackStep = 1.0f / juce::jmax(1.0f, sr * 0.0028f);
    const float releaseStep = 1.0f / juce::jmax(1.0f, sr * releaseMs.load(std::memory_order_relaxed) * 0.001f);
    const float outGain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed)));
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note] || envelope[channel][note] > 0.0f)
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixedL = 0.0f;
            float mixedR = 0.0f;
            const float chorusLfo = std::sin(twoPi * chorusPhase);
            chorusPhase += (modelIndex == 3 ? 0.72f : 0.42f) / sr;
            if (chorusPhase >= 1.0f)
                chorusPhase -= std::floor(chorusPhase);

            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;
                if (!active[channel][note] && envelope[channel][note] <= 0.0f)
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                if (active[channel][note] && !releasing[channel][note])
                    envelope[channel][note] = juce::jmin(1.0f, envelope[channel][note] + attackStep);
                else
                    envelope[channel][note] = juce::jmax(0.0f, envelope[channel][note] - releaseStep);

                if (envelope[channel][note] <= 0.0f)
                {
                    active[channel][note] = false;
                    releasing[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceString[channel][note] = -1;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float baseFreq = static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(static_cast<int>(note)));
                const float bendFactor = std::pow(2.0f, pitchBendSemitones[channel] / 12.0f);
                const float ageSec = static_cast<float>(ageSamples[channel][note]) / sr;
                const float freq = baseFreq * bendFactor;
                const float p = phase[channel][note];
                const float noteBright = juce::jlimit(0.55f, 1.45f, 0.78f + (static_cast<float>(note) - 52.0f) * 0.009f);
                const float pickupBright = modelIndex == 0 ? 1.08f : (modelIndex == 1 ? 1.22f : (modelIndex == 3 ? 1.18f : 0.96f));
                const float bodyDecay = 0.75f + bodyValue * 1.2f + (1.0f - noteBright) * 0.22f;
                const float decay = std::exp(-ageSec / bodyDecay);
                const float pickupPhase = modelIndex == 1 ? 0.18f : 0.09f;
                const float fundamental = std::sin(twoPi * p) * 0.72f;
                const float partial2 = std::sin(twoPi * (p * 2.01f + pickupPhase)) * (0.28f + toneValue * 0.24f) * nyquistFade(freq * 2.01f, sr);
                const float partial3 = std::sin(twoPi * (p * 3.02f + 0.31f)) * (0.16f + toneValue * 0.14f) * nyquistFade(freq * 3.02f, sr);
                const float partial5 = std::sin(twoPi * (p * 5.07f + 0.11f)) * (0.045f + toneValue * 0.08f) * nyquistFade(freq * 5.07f, sr);
                const float pluck = builtinNoise(ageSamples[channel][note], static_cast<int>(note) + 37)
                    * std::exp(-ageSec / 0.018f) * (0.02f + pickValue * 0.075f) * pickupBright;
                float raw = (fundamental + partial2 + partial3 + partial5 + pluck) * decay * pickupBright;
                const float filterCoeff = juce::jlimit(0.04f, 0.72f, 0.12f + toneValue * 0.46f + noteBright * 0.08f);
                pluckFilter[channel][note] += filterCoeff * (raw - pluckFilter[channel][note]);
                raw = pluckFilter[channel][note];

                const float cleanAmp = modelIndex >= 2 ? std::tanh(raw * (1.08f + bodyValue * 0.24f)) : raw;
                const float voice = cleanAmp * envelope[channel][note] * velocity[channel][note] * outGain * 0.72f;
                const int assignedString = voiceString[channel][note];
                const int string = assignedString >= 0 ? assignedString : chooseStringForNote(static_cast<int>(note), static_cast<int>(channel));
                const float stringPan = juce::jlimit(-0.48f, 0.48f, (static_cast<float>(string) - 2.5f) * 0.15f);
                const float chorusOffset = (modelIndex == 3 ? 0.14f : 0.04f) * chorusValue * chorusLfo;
                const float pan = juce::jlimit(-0.65f, 0.65f, stringPan + chorusOffset);
                const float leftGain = std::sqrt(0.5f * (1.0f - pan));
                const float rightGain = std::sqrt(0.5f * (1.0f + pan));
                mixedL += voice * leftGain;
                mixedR += voice * rightGain;

                phase[channel][note] += juce::jmin(0.45f, freq / sr);
                if (phase[channel][note] >= 1.0f)
                    phase[channel][note] -= std::floor(phase[channel][note]);
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixedL = softLimitInstrumentBus(mixedL);
            mixedR = softLimitInstrumentBus(mixedR);
            if (numChannels == 1)
            {
                buffer.addSample(0, sample, (mixedL + mixedR) * 0.707f);
            }
            else
            {
                buffer.addSample(0, sample, mixedL);
                buffer.addSample(1, sample, mixedR);
                for (int ch = 2; ch < numChannels; ++ch)
                    buffer.addSample(ch, sample, (mixedL + mixedR) * 0.5f);
            }
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13CleanGuitarInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13CleanGuitarInstrument", {
        { "model", model.load() },
        { "tone", tone.load() },
        { "body", body.load() },
        { "pickNoise", pickNoise.load() },
        { "releaseMs", releaseMs.load() },
        { "chorus", chorus.load() },
        { "stringMode", stringMode.load() },
        { "bendRangeSemitones", bendRangeSemitones.load() },
        { "outputGain", outputGain.load() }
    });
}

void S13CleanGuitarInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13CleanGuitarInstrument");
    if (!tree.isValid())
        return;

    model = static_cast<float>((double)tree.getProperty("model", 0.0));
    tone = static_cast<float>((double)tree.getProperty("tone", 0.68));
    body = static_cast<float>((double)tree.getProperty("body", 0.46));
    pickNoise = static_cast<float>((double)tree.getProperty("pickNoise", 0.32));
    releaseMs = static_cast<float>((double)tree.getProperty("releaseMs", 210.0));
    chorus = static_cast<float>((double)tree.getProperty("chorus", 0.0));
    stringMode = static_cast<float>((double)tree.getProperty("stringMode", 1.0));
    bendRangeSemitones = static_cast<float>((double)tree.getProperty("bendRangeSemitones", 2.0));
    outputGain = static_cast<float>((double)tree.getProperty("outputGain", -14.0));
}

bool S13CleanGuitarInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

// ============================================================================
//  S13DrumInstrument
// ============================================================================

S13DrumInstrument::S13DrumInstrument()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    hihatPedal.fill(0.65f);
}

void S13DrumInstrument::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused(samplesPerBlock);
    cachedSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    clearVoices();
}

void S13DrumInstrument::releaseResources()
{
    clearVoices();
}

void S13DrumInstrument::clearVoices()
{
    for (auto& notes : active) notes.fill(false);
    for (auto& notes : phase) notes.fill(0.0f);
    for (auto& notes : velocity) notes.fill(0.0f);
    for (auto& notes : ageSamples) notes.fill(0);
}

int S13DrumInstrument::mapIncomingNote(int note) const
{
    const int preset = juce::jlimit(0, 1, static_cast<int>(std::round(mapPreset.load(std::memory_order_relaxed))));
    if (preset == 0)
        return note;

    switch (note)
    {
        case 22: return 42; // TD closed hi-hat edge
        case 26: return 46; // TD open hi-hat edge
        case 47: return 45; // mid tom rim -> mid tom
        case 50: return 48; // high tom rim -> high tom
        case 58: return 43; // low tom rim -> floor tom
        case 55: return 49; // crash edge -> crash
        case 52: return 57; // second crash/china edge -> crash 2
        case 59: return 51; // ride edge -> ride
        case 53: return 51; // ride bell -> ride family voice
        default: return note;
    }
}

void S13DrumInstrument::handleMidi(const juce::MidiMessage& message)
{
    const int channel = juce::jlimit(0, 15, message.getChannel() > 0 ? message.getChannel() - 1 : 0);
    if (message.isController() && message.getControllerNumber() == 4)
    {
        hihatPedal[static_cast<size_t>(channel)] = static_cast<float>(message.getControllerValue()) / 127.0f;
        return;
    }

    if (message.isNoteOn())
    {
        const int note = juce::jlimit(0, 127, mapIncomingNote(message.getNoteNumber()));
        const float curve = juce::jlimit(-1.0f, 1.0f, velocityCurve.load(std::memory_order_relaxed));
        const float exponent = juce::jmap(curve, -1.0f, 1.0f, 1.65f, 0.62f);
        const float curvedVelocity = std::pow(juce::jlimit(0.0f, 1.0f, message.getFloatVelocity()), exponent);
        active[static_cast<size_t>(channel)][static_cast<size_t>(note)] = true;
        phase[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0.0f;
        velocity[static_cast<size_t>(channel)][static_cast<size_t>(note)] = curvedVelocity;
        ageSamples[static_cast<size_t>(channel)][static_cast<size_t>(note)] = 0;

        if (note == 42 || note == 44)
            active[static_cast<size_t>(channel)][46] = false;
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        active[static_cast<size_t>(channel)].fill(false);
    }
}

void S13DrumInstrument::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    buffer.clear();
    const int kitIndex = juce::jlimit(0, 2, static_cast<int>(std::round(kit.load(std::memory_order_relaxed))));
    const float tune = std::pow(2.0f, juce::jlimit(-12.0f, 12.0f, tuning.load(std::memory_order_relaxed)) / 12.0f);
    const float room = juce::jlimit(0.0f, 1.0f, ambience.load(std::memory_order_relaxed));
    const float tightness = juce::jlimit(0.0f, 1.0f, hihatTightness.load(std::memory_order_relaxed));
    const float punchValue = juce::jlimit(0.0f, 1.0f, punch.load(std::memory_order_relaxed));
    const float widthValue = juce::jlimit(0.0f, 1.0f, stereoWidth.load(std::memory_order_relaxed));
    const float gain = juce::Decibels::decibelsToGain(juce::jlimit(-36.0f, 0.0f, outputGain.load(std::memory_order_relaxed)));
    const float twoPi = juce::MathConstants<float>::twoPi;
    std::array<BuiltInMidiVoiceRef, kBuiltInMidiVoiceSlots> voiceRefs {};

    auto render = [&] (int start, int end)
    {
        int voiceCount = 0;
        for (size_t channel = 0; channel < active.size(); ++channel)
        {
            for (size_t note = 0; note < active[channel].size(); ++note)
            {
                if (active[channel][note])
                    voiceRefs[static_cast<size_t>(voiceCount++)] = { channel, note };
            }
        }

        for (int sample = start; sample < end; ++sample)
        {
            float mixedL = 0.0f;
            float mixedR = 0.0f;
            for (int voiceIndex = 0; voiceIndex < voiceCount;)
            {
                const auto voiceRef = voiceRefs[static_cast<size_t>(voiceIndex)];
                const size_t channel = voiceRef.channel;
                const size_t note = voiceRef.note;
                const float pedalClosed = juce::jlimit(0.0f, 1.0f, hihatPedal[channel] * tightness);

                if (!active[channel][note])
                {
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const int midiNote = static_cast<int>(note);
                const float ageSec = static_cast<float>(ageSamples[channel][note]) / static_cast<float>(cachedSampleRate);
                const float velocityValue = velocity[channel][note];
                const float decay = drumDecaySeconds(midiNote, pedalClosed) * (0.82f + velocityValue * 0.42f);
                const float env = std::exp(-ageSec / decay);
                if (env < 0.0002f)
                {
                    active[channel][note] = false;
                    velocity[channel][note] = 0.0f;
                    voiceRefs[static_cast<size_t>(voiceIndex)] = voiceRefs[static_cast<size_t>(--voiceCount)];
                    continue;
                }

                const float noise = builtinNoise(ageSamples[channel][note], midiNote);
                const float sweep = (midiNote == 35 || midiNote == 36) ? std::exp(-ageSec / 0.035f) * 72.0f : 0.0f;
                const float freq = juce::jlimit(20.0f, 8000.0f, drumBaseFrequency(midiNote) * tune + sweep);
                phase[channel][note] += freq / static_cast<float>(cachedSampleRate);
                if (phase[channel][note] >= 1.0f)
                    phase[channel][note] -= std::floor(phase[channel][note]);

                float drum = 0.0f;
                if (midiNote == 35 || midiNote == 36)
                {
                    const float body = std::sin(twoPi * phase[channel][note]) * std::exp(-ageSec / (kitIndex == 1 ? 0.52f : 0.36f));
                    const float click = noise * std::exp(-ageSec / 0.012f) * (kitIndex == 2 ? 0.38f : 0.18f) * (0.7f + punchValue * 0.8f);
                    drum = body * 1.18f + click;
                }
                else if (midiNote == 37 || midiNote == 38 || midiNote == 40)
                {
                    const float snap = noise * std::exp(-ageSec / (kitIndex == 1 ? 0.22f : 0.16f));
                    const float body = std::sin(twoPi * phase[channel][note]) * std::exp(-ageSec / 0.12f);
                    drum = snap * (kitIndex == 2 ? 0.95f : 0.72f) * (0.75f + punchValue * 0.65f) + body * 0.34f;
                }
                else if (midiNote == 42 || midiNote == 44 || midiNote == 46 || midiNote == 22 || midiNote == 26)
                {
                    const float metal = std::sin(twoPi * phase[channel][note] * 7.1f) * 0.24f
                                      + std::sin(twoPi * phase[channel][note] * 11.7f) * 0.18f;
                    drum = (noise * 0.78f + metal) * env;
                }
                else if (midiNote == 49 || midiNote == 51 || midiNote == 52 || midiNote == 53
                         || midiNote == 55 || midiNote == 57 || midiNote == 59)
                {
                    const float shimmer = std::sin(twoPi * phase[channel][note] * 5.3f) * 0.15f
                                        + std::sin(twoPi * phase[channel][note] * 9.7f) * 0.12f;
                    drum = (noise * 0.64f + shimmer) * env;
                }
                else
                {
                    const float body = std::sin(twoPi * phase[channel][note]) * env;
                    drum = body * 0.9f + noise * 0.08f * std::exp(-ageSec / 0.04f);
                }

                const float roomTail = std::sin(twoPi * phase[channel][note] * 0.37f + static_cast<float>(midiNote))
                    * room * 0.08f * std::exp(-ageSec / 0.9f);
                const float voice = (drum + roomTail) * velocityValue * gain * 0.85f;
                const float pan = drumPanPosition(midiNote) * widthValue;
                const float leftGain = std::sqrt(0.5f * (1.0f - pan));
                const float rightGain = std::sqrt(0.5f * (1.0f + pan));
                mixedL += voice * leftGain;
                mixedR += voice * rightGain;
                ++ageSamples[channel][note];
                ++voiceIndex;
            }

            mixedL = softLimitInstrumentBus(mixedL);
            mixedR = softLimitInstrumentBus(mixedR);
            if (numChannels == 1)
            {
                buffer.addSample(0, sample, (mixedL + mixedR) * 0.707f);
            }
            else
            {
                buffer.addSample(0, sample, mixedL);
                buffer.addSample(1, sample, mixedR);
                for (int ch = 2; ch < numChannels; ++ch)
                    buffer.addSample(ch, sample, (mixedL + mixedR) * 0.5f);
            }
        }
    };

    int cursor = 0;
    for (const auto metadata : midi)
    {
        const int eventSample = juce::jlimit(0, numSamples, metadata.samplePosition);
        render(cursor, eventSample);
        handleMidi(metadata.getMessage());
        cursor = eventSample;
    }
    render(cursor, numSamples);
    sanitizeBuiltInBuffer(buffer, 2.5f);
}

void S13DrumInstrument::getStateInformation(juce::MemoryBlock& destData)
{
    saveParamsToMemory(destData, "S13DrumInstrument", {
        { "kit", kit.load() },
        { "tuning", tuning.load() },
        { "ambience", ambience.load() },
        { "outputGain", outputGain.load() },
        { "hihatTightness", hihatTightness.load() },
        { "mapPreset", mapPreset.load() },
        { "punch", punch.load() },
        { "stereoWidth", stereoWidth.load() },
        { "velocityCurve", velocityCurve.load() }
    });
}

void S13DrumInstrument::setStateInformation(const void* data, int sizeInBytes)
{
    auto tree = loadParamsFromMemory(data, sizeInBytes, "S13DrumInstrument");
    if (!tree.isValid())
        return;

    kit            = static_cast<float>((double)tree.getProperty("kit", 0.0));
    tuning         = static_cast<float>((double)tree.getProperty("tuning", 0.0));
    ambience       = static_cast<float>((double)tree.getProperty("ambience", 0.18));
    outputGain     = static_cast<float>((double)tree.getProperty("outputGain", -10.0));
    hihatTightness = static_cast<float>((double)tree.getProperty("hihatTightness", 0.65));
    mapPreset      = static_cast<float>((double)tree.getProperty("mapPreset", 0.0));
    punch          = static_cast<float>((double)tree.getProperty("punch", 0.55));
    stereoWidth    = static_cast<float>((double)tree.getProperty("stereoWidth", 0.7));
    velocityCurve  = static_cast<float>((double)tree.getProperty("velocityCurve", 0.0));
}

bool S13DrumInstrument::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    return mainOut == juce::AudioChannelSet::mono() || mainOut == juce::AudioChannelSet::stereo();
}

bool S13Saturator::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainOut = layouts.getMainOutputChannelSet();
    const auto& mainIn  = layouts.getMainInputChannelSet();
    if (mainOut != mainIn)
        return false;
    return mainOut == juce::AudioChannelSet::stereo()
        || mainOut == juce::AudioChannelSet::mono();
}
