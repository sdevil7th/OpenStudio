#pragma once
#include "BuiltInEffects.h"
#include "BuiltInPreampTone.h"
#include "BuiltInAverageMeter.h"
#include "BuiltInGraphicEQ.h"
#include "BuiltInSpectrumCapture.h"
#include "BuiltInPhaseAlignment.h"
#include "BuiltInAlignmentCapture.h"
#include "BuiltInLinearPhaseEQ.h"
#include "BuiltInOriginalColour.h"
#include <cmath>

// These are separate processors/FX-chain entries. The shared implementation
// supplies parameter/state plumbing only; it does not form a channel strip.
class OpenStudioUtilityEffect final : public OpenStudioBuiltInEffect
{
public:
    enum class Kind { Preamp, GraphicEQ, GainPhase };
    struct Control { const char* id; const char* label; float min, max, initial; const char* unit; bool toggle = false; };
    explicit OpenStudioUtilityEffect(Kind selected) : kind(selected)
    {
        if (kind == Kind::Preamp)
            controls = { { "drive", "Input drive", 0, 36, 0, "dB" }, { "outputGain", "Output trim", -36, 12, 0, "dB" }, { "colour", "Colour", 0, 1, 0.5f, "" } };
        else if (kind == Kind::GraphicEQ)
        {
            static constexpr const char* ids[] = { "geq0", "geq1", "geq2", "geq3", "geq4", "geq5", "geq6", "geq7", "geq8", "geq9" };
            static constexpr const char* labels[] = { "31 Hz", "63 Hz", "125 Hz", "250 Hz", "500 Hz", "1 kHz", "2 kHz", "4 kHz", "8 kHz", "16 kHz" };
            for (int i = 0; i < 10; ++i) controls.push_back({ ids[i], labels[i], -12, 12, 0, "dB" });
            controls.push_back({ "outputGain", "Output trim", -24, 12, 0, "dB" });
        }
        else
            controls = { { "gain", "Gain", -60, 24, 0, "dB" }, { "polarityL", "Invert L", 0, 1, 0, "", true },
                { "polarityR", "Invert R", 0, 1, 0, "", true }, { "delayL", "Delay L", 0, 2048, 0, "samples" },
                { "delayR", "Delay R", 0, 2048, 0, "samples" } };
        controls.push_back({ "bypass", "Bypass", 0, 1, 0, "", true });
        // Append after the existing bypass ID to preserve all host indices.
        if (kind == Kind::Preamp)
        {
            controls.push_back({ "toneEnabled", "Tone EQ", 0, 1, 0, "", true });
            controls.push_back({ "toneLowFrequency", "Low frequency", 0, 4, 3, "" });
            controls.push_back({ "toneLowGain", "Low gain", -16, 16, 0, "dB" });
            controls.push_back({ "toneMidFrequency", "Mid frequency", 0, 6, 3, "" });
            controls.push_back({ "toneMidGain", "Mid gain", -18, 18, 0, "dB" });
            controls.push_back({ "toneHighGain", "12 kHz high gain", -16, 16, 0, "dB" });
            controls.push_back({ "toneHighPass", "High pass", 0, 4, 0, "" });
            controls.push_back({ "saturationReference", "Saturation reference", -24, 0, 0, "dBFS" });
            controls.push_back({ "audioCharacter", "Audio character", 0, 1, 0, "" });
            controls.push_back({ "outputDrive", "Output drive", 0, 24, 0, "dB" });
            controls.push_back({ "headroom", "Headroom offset", -12, 12, 0, "dB" });
        }
        if (kind == Kind::GraphicEQ)
        {
            controls.push_back({ "graphicMode", "Bands", 0, 1, 0, "" });
            controls.push_back({ "graphicTarget", "Target", 0, 4, 0, "" });
            controls.push_back({ "graphicHPEnabled", "Low cut", 0, 1, 0, "", true });
            controls.push_back({ "graphicHP", "Low cut frequency", 20, 2000, 50, "Hz" });
            controls.push_back({ "graphicLPEnabled", "High cut", 0, 1, 0, "", true });
            controls.push_back({ "graphicLP", "High cut frequency", 1000, 20000, 20000, "Hz" });
            static constexpr const char* ids[] { "third0", "third1", "third2", "third3", "third4", "third5", "third6", "third7", "third8", "third9", "third10", "third11", "third12", "third13", "third14", "third15", "third16", "third17", "third18", "third19", "third20", "third21", "third22", "third23", "third24", "third25", "third26", "third27", "third28", "third29", "third30" };
            static constexpr const char* labels[] { "20 Hz", "25 Hz", "31.5 Hz", "40 Hz", "50 Hz", "63 Hz", "80 Hz", "100 Hz", "125 Hz", "160 Hz", "200 Hz", "250 Hz", "315 Hz", "400 Hz", "500 Hz", "630 Hz", "800 Hz", "1000 Hz", "1250 Hz", "1600 Hz", "2000 Hz", "2500 Hz", "3150 Hz", "4000 Hz", "5000 Hz", "6300 Hz", "8000 Hz", "10000 Hz", "12500 Hz", "16000 Hz", "20000 Hz" };
            for (size_t i = 0; i < BuiltInGraphicEQ::bandCount; ++i) controls.push_back({ ids[i], labels[i], -12, 12, 0, "dB" });
            graphicCapture = std::make_unique<BuiltInSpectrumCapture>();
        }
        if (kind == Kind::GainPhase)
        {
            alignmentCapture = std::make_unique<BuiltInAlignmentCapture>();
            controls.push_back({ "fineL", "Fine L", 0, .999f, 0, "samples" });
            controls.push_back({ "fineR", "Fine R", 0, .999f, 0, "samples" });
            controls.push_back({ "phaseEnabledL", "Phase L", 0, 1, 0, "", true });
            controls.push_back({ "phaseEnabledR", "Phase R", 0, 1, 0, "", true });
            controls.push_back({ "phaseFrequencyL", "Corner L", 20, 20000, 1000, "Hz" });
            controls.push_back({ "phaseFrequencyR", "Corner R", 20, 20000, 1000, "Hz" });
            controls.push_back({ "phaseStagesL", "Stages L", 0, 3, 0, "" });
            controls.push_back({ "phaseStagesR", "Stages R", 0, 3, 0, "" });
            controls.push_back({ "spectralPhaseEnabled", "Spectral phase", 0, 1, 0, "", true });
            controls.push_back({ "spectralPhaseAmount", "Correction", 0, 1, 1, "" });
            for (size_t ch = 0; ch < 2; ++ch) for (size_t point = 0; point < BuiltInSpectralPhaseCurve::points; ++point)
            {
                auto& id = spectralIds[ch * BuiltInSpectralPhaseCurve::points + point];
                id = "spectralPhase" + juce::String(ch == 0 ? "L" : "R") + juce::String(static_cast<int>(point));
                controls.push_back({ id.toRawUTF8(), id.toRawUTF8(), -1440, 1440, 0, "degrees" });
            }
        }
        for (size_t i = 0; i < controls.size(); ++i) values[i].store(controls[i].initial);
    }
    const juce::String getName() const override
    {
        return kind == Kind::Preamp ? "OpenStudio Preamp" : kind == Kind::GraphicEQ ? "OpenStudio Graphic EQ" : "OpenStudio Gain Phase";
    }
    const Kind kind;
    double getTailLengthSeconds() const override { return kind == Kind::Preamp && values[12].load() >= .5f ? 1.0 : 0.0; }
    std::vector<Control> controls;
    std::array<std::atomic<float>, 128> values {};
    std::atomic<float> correlation { 0.0f };
    std::unique_ptr<BuiltInAlignmentCapture> alignmentCapture;
    bool setControl(const juce::String& id, float value, bool deferConfiguration = false)
    {
        if (!std::isfinite(value)) return false;
        for (size_t i = 0; i < controls.size(); ++i)
            if (id == controls[i].id)
            {
                if (id.startsWith("delay") || id.startsWith("phaseStages") || id == "toneLowFrequency" || id == "toneMidFrequency" || id == "toneHighPass" || id == "graphicMode" || id == "graphicTarget" || id == "audioCharacter") value = std::round(value);
                values[i].store(juce::jlimit(controls[i].min, controls[i].max, value));
                if (id == "spectralPhaseEnabled" && !deferConfiguration) refreshSpectralConfiguration();
                if (id == "audioCharacter" && !deferConfiguration) refreshCharacterConfiguration();
                return true;
            }
        return false;
    }
    BuiltInLinearPhaseEQ::Snapshot spectralSnapshot() const
    {
        BuiltInLinearPhaseEQ::Snapshot snapshot; snapshot.spectralPhase = true; snapshot.quality = 1;
        const float amount = values[15].load();
        for (size_t ch = 0; ch < 2; ++ch) for (size_t point = 0; point < BuiltInSpectralPhaseCurve::points; ++point)
            snapshot.phaseCurves[ch][point] = values[16 + ch * BuiltInSpectralPhaseCurve::points + point].load() * amount;
        return snapshot;
    }
    // Control thread under the host's processor/publication lock. Curve-only
    // changes use the prepared kernel mailbox in processBlock instead.
    void refreshSpectralConfiguration(bool force = false)
    {
        if (kind != Kind::GainPhase || !prepared) return;
        const bool enabled = values[14].load() >= .5f;
        if (!force && enabled == (spectral != nullptr)) return;
        if (enabled)
        {
            if (!spectral) spectral = std::make_unique<BuiltInLinearPhaseEQ>();
            spectral->prepare(rate, spectralSnapshot(), isNonRealtime());
        }
        else spectral.reset();
        setLatencySamples(enabled ? BuiltInLinearPhaseEQ::latency(1) : 0);
    }
    // Nonautomatable control-thread configuration under the host publication /
    // callback lock. Full-state restoration follows the same latency contract.
    void refreshCharacterConfiguration()
    {
        if (kind != Kind::Preamp || !prepared || (values[12].load() >= .5f) == originalCharacterPrepared) return;
        prepareToPlay(rate, preparedMaximumBlock);
    }
    void prepareToPlay(double sampleRate, int maximumBlock) override
    {
        if(alignmentCapture)alignmentCapture->prepare(sampleRate);
        rate = sampleRate; visualRate.store(sampleRate); prepared = true; preparedMaximumBlock = maximumBlock;
        refreshSpectralConfiguration(true);
        if (kind == Kind::GraphicEQ) { graphic.prepare(sampleRate); graphicCapture->prepare(sampleRate); }
        if (kind == Kind::GainPhase) phase.prepare(sampleRate);
        scratch.setSize(2, maximumBlock);
        delays.setSize(2, 4096);
        if (kind == Kind::Preamp)
        {
            originalCharacterPrepared = values[12].load() >= .5f;
            preampOversamplingFactor = originalCharacterPrepared ? BuiltInOversampledColour::oversamplingFactor : 4;
            if (originalCharacterPrepared)
            {
                oversampler = std::make_unique<juce::dsp::Oversampling<float>>(2);
                BuiltInOversampledColour::addOversamplingStages(*oversampler);
                oversampler->setUsingIntegerLatency(true);
            }
            else oversampler = std::make_unique<juce::dsp::Oversampling<float>>(2, 2, juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true, true);
            oversampler->initProcessing(static_cast<size_t>(maximumBlock));
            setLatencySamples(static_cast<int>(oversampler->getLatencyInSamples()));
            tone.prepare(sampleRate * preampOversamplingFactor);
            for (auto& stage : originalPreamp) stage.prepare(sampleRate * preampOversamplingFactor, BuiltInOriginalColour::Preamp);
            averageMeter.prepare(sampleRate);
        }
        for (size_t i = 0; i < smoothedControlCount(); ++i)
        {
            smooth[i].reset(sampleRate * (kind == Kind::Preamp ? preampOversamplingFactor : 1.0), 0.010);
            smooth[i].setCurrentAndTargetValue(values[i].load());
        }
        reset();
    }
    void releaseResources() override { reset(); if (spectral) spectral->release(); prepared = false; }
    void reset() override
    {
        if(alignmentCapture)alignmentCapture->abort();
        delays.clear(); scratch.clear(); position = 0; updateCounter = 0;
        filterState = {}; dcInput = {}; dcOutput = {}; powers = {};
        for (size_t ch = 0; ch < 2; ++ch)
        {
            activeDelay[ch].set(kind == Kind::GainPhase ? std::round(values[3 + ch].load()) + static_cast<double>(values[6 + ch].load()) : 0);
            targetDelay[ch] = activeDelay[ch];
            delayFade[ch] = 1.0f;
        }
        correlation.store(0); inputDb.store(-100); outputDb.store(-100); drivenReferenceDb.store(-100); averageMeter.reset();
        tone.reset(); phase.reset(); if (spectral) spectral->reset();
        for (auto& stage : originalPreamp) stage.reset();
        if (kind == Kind::GraphicEQ) { graphic.reset(); graphicCapture->reset(); }
        if (oversampler) oversampler->reset();
    }
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
    {
        juce::ignoreUnused(midi);
        juce::ScopedNoDenormals noDenormals;
        const int channels = juce::jmin(2, buffer.getNumChannels());
        const int samples = buffer.getNumSamples();
        if (channels == 0 || samples == 0) return;
        if(alignmentCapture&&alignmentCapture->state.load(std::memory_order_relaxed)==1)
        {
            const auto playbackPosition=getPlayHead()?getPlayHead()->getPosition():juce::Optional<juce::AudioPlayHead::PositionInfo>();
            if(playbackPosition&&playbackPosition->getTimeInSamples())alignmentCapture->process(buffer,*playbackPosition->getTimeInSamples(),playbackPosition->getIsPlaying());
            else alignmentCapture->abort();
        }

        for (size_t i = 0; i < smoothedControlCount(); ++i) smooth[i].setTargetValue(values[i].load());
        if (spectral) spectral->request(spectralSnapshot());
        if (kind == Kind::Preamp)
        {
            averageMeter.measure(buffer,false);
            float inputPeak=0,drivenPeak=0;
            for(int ch=0;ch<channels;++ch)for(int i=0;i<samples;++i){const float sample=buffer.getSample(ch,i);if(std::isfinite(sample))inputPeak=juce::jmax(inputPeak,std::abs(sample));}
            tone.configure({ values[4].load(), values[5].load(), values[6].load(), values[7].load(), values[8].load(), values[9].load(), values[10].load() });
            for (int ch = 0; ch < 2; ++ch) scratch.copyFrom(ch, 0, buffer, juce::jmin(ch, channels - 1), 0, samples);
            juce::dsp::AudioBlock<float> block(scratch);
            auto working = block.getSubBlock(0, static_cast<size_t>(samples));
            auto up = oversampler->processSamplesUp(working);
            const float dcCoefficient = static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi * 5.0 / (rate * preampOversamplingFactor)));
            for (size_t i = 0; i < up.getNumSamples(); ++i)
            {
                const float drive = juce::Decibels::decibelsToGain(smooth[0].getNextValue());
                const float trim = juce::Decibels::decibelsToGain(smooth[1].getNextValue());
                const float colour = smooth[2].getNextValue();
                const float bypass = smooth[3].getNextValue();
                const float referenceGain=juce::Decibels::decibelsToGain(smooth[11].getNextValue());
                const float character = smooth[12].getNextValue();
                const float outputDrive = juce::Decibels::decibelsToGain(smooth[13].getNextValue());
                const float headroomGain = juce::Decibels::decibelsToGain(-smooth[14].getNextValue());
                std::array<float, 2> dry {}, colouredSignal {};
                for (size_t ch = 0; ch < 2; ++ch)
                {
                    const float rawInput = up.getSample(static_cast<int>(ch), static_cast<int>(i));
                    const float input = std::isfinite(rawInput) ? rawInput : 0.0f;
                    const float biased = input * drive;
                    // Smooth asymmetric transfer with DC rejection; an original
                    // transformer-inspired colour, not a circuit emulation.
                    const float bias = 0.12f * colour;
                    const float normalized=biased/referenceGain;
                    drivenPeak=juce::jmax(drivenPeak,std::abs(normalized));
                    const float shaped = ((std::tanh(normalized + bias) - std::tanh(bias)) / (1.0f - std::tanh(bias) * std::tanh(bias))) * referenceGain;
                    float coloured = biased + (shaped - biased) * colour;
                    if (character > 0)
                    {
                        const float staged = static_cast<float>(originalPreamp[ch].input(normalized * headroomGain, colour)) * referenceGain / headroomGain;
                        coloured += character * (staged - coloured);
                    }
                    const float highPassed = coloured - dcInput[ch] + dcCoefficient * dcOutput[ch];
                    dcInput[ch] = coloured; dcOutput[ch] = highPassed;
                    dry[ch] = input; colouredSignal[ch] = highPassed;
                }
                const auto equalized = tone.process(colouredSignal[0], colouredSignal[1]);
                for (size_t ch = 0; ch < 2; ++ch)
                {
                    float staged = equalized[ch];
                    if (character > 0)
                    {
                        const float amplified = static_cast<float>(originalPreamp[ch].output(equalized[ch] * outputDrive * headroomGain / referenceGain, colour)) * referenceGain / headroomGain;
                        staged += character * (amplified - staged);
                    }
                    const float output = dry[ch] * bypass + staged * trim * (1.0f - bypass);
                    up.setSample(static_cast<int>(ch), static_cast<int>(i), std::isfinite(output) ? output : 0.0f);
                }
            }
            oversampler->processSamplesDown(working);
            for (int ch = 0; ch < channels; ++ch) buffer.copyFrom(ch, 0, scratch, ch, 0, samples);
            inputDb.store(juce::Decibels::gainToDecibels(inputPeak,-100.0f));
            outputDb.store(juce::Decibels::gainToDecibels(buffer.getMagnitude(0,samples),-100.0f));
            drivenReferenceDb.store(juce::Decibels::gainToDecibels(drivenPeak,-100.0f));
            averageMeter.measure(buffer,true);
            return;
        }
        if (kind == Kind::GraphicEQ) { graphic.configure(graphicSettings()); graphicCapture->beginBlock(samples); }
        std::array<double,2> desiredDelay {};
        if (kind == Kind::GainPhase)
        {
            std::array<BuiltInPhaseAlignment::Channel,2> settings;
            for(size_t ch=0;ch<2;++ch)
            {
                desiredDelay[ch]=std::round(values[3+ch].load())+static_cast<double>(values[6+ch].load());
                settings[ch]={values[8+ch].load(),values[10+ch].load(),values[12+ch].load()};
            }
            phase.configure(settings);
        }
        float inputPeak = 0, outputPeak = 0;
        const float correlationDecay = static_cast<float>(std::exp(-1.0 / (rate * 0.15)));
        for (int i = 0; i < samples; ++i)
        {
            std::array<float, 64> control {};
            for (size_t k = 0; k < smoothedControlCount(); ++k) control[k] = smooth[k].getNextValue();
            if (kind == Kind::GraphicEQ && updateCounter++ % 16 == 0)
                for (int band = 0; band < 10; ++band) updateFilter(band, control[static_cast<size_t>(band)]);
            std::array<float, 2> outputs {};
            const float rawLeft = buffer.getSample(0, i), rawRight = channels == 2 ? buffer.getSample(1, i) : rawLeft;
            const float inputLeft = std::isfinite(rawLeft) ? rawLeft : 0, inputRight = std::isfinite(rawRight) ? rawRight : 0;
            inputPeak = juce::jmax(inputPeak, std::abs(inputLeft), std::abs(inputRight));
            const auto corrected = spectral ? spectral->process(inputLeft, inputRight) : std::array<float,4>{inputLeft,inputRight,inputLeft,inputRight};
            for (int ch = 0; ch < channels; ++ch)
            {
                const float input = corrected[static_cast<size_t>(ch)];
                float output = input;
                if (kind == Kind::GraphicEQ)
                {
                    for (int band = 0; band < 10; ++band)
                    {
                        const auto& c = coefficients[static_cast<size_t>(band)];
                        auto& z = filterState[static_cast<size_t>(ch)][static_cast<size_t>(band)];
                        const double filtered = c[0] * output + z[0];
                        z[0] = c[1] * output - c[3] * filtered + z[1]; z[1] = c[2] * output - c[4] * filtered;
                        output = static_cast<float>(filtered);
                    }

                }
                else
                {
                    delays.setSample(ch, position, input);
                    const double delay = desiredDelay[static_cast<size_t>(ch)];
                    const auto channel = static_cast<size_t>(ch);
                    if (delayFade[channel] >= 1.0f && delay != activeDelay[channel].delay)
                    {
                        targetDelay[channel].set(delay);
                        delayFade[channel] = 0.0f;
                    }
                    const float oldTap = activeDelay[channel].read(delays,ch,position);
                    const float newTap = targetDelay[channel].read(delays,ch,position);
                    output = oldTap + (newTap - oldTap) * delayFade[channel];
                    delayFade[channel] = juce::jmin(1.0f, delayFade[channel] + 1.0f / 128.0f);
                    if (delayFade[channel] >= 1.0f) activeDelay[channel] = targetDelay[channel];
                    output = phase.process(channel,output);
                    output *= (1.0f - 2.0f * control[static_cast<size_t>(1 + ch)]) * juce::Decibels::decibelsToGain(control[0]);
                }
                const float bypass = kind == Kind::GraphicEQ ? 0 : control[5];
                output = corrected[static_cast<size_t>(ch + 2)] * bypass + output * (1.0f - bypass);
                outputs[static_cast<size_t>(ch)] = std::isfinite(output) ? output : 0.0f;
                buffer.setSample(ch, i, outputs[static_cast<size_t>(ch)]);
            }
            if (kind == Kind::GraphicEQ)
            {
                outputs = graphic.process(inputLeft, inputRight, outputs[0], channels == 2 ? outputs[1] : outputs[0]);
                const float trim = juce::Decibels::decibelsToGain(control[10]), bypass = control[11];
                for (int ch = 0; ch < channels; ++ch)
                {
                    const float input = ch == 0 ? inputLeft : inputRight;
                    const float processed = outputs[static_cast<size_t>(ch)] * trim;
                    const float output = input * bypass + processed * (1-bypass);
                    outputs[static_cast<size_t>(ch)] = std::isfinite(output) ? output : 0;
                    buffer.setSample(ch, i, outputs[static_cast<size_t>(ch)]);
                }
                graphicCapture->push(inputLeft, inputRight, outputs[0], channels == 2 ? outputs[1] : outputs[0]);
            }
            outputPeak = juce::jmax(outputPeak, std::abs(outputs[0]), std::abs(outputs[1]));
            position = (position + 1) % 4096;
            const float left = outputs[0], right = channels == 1 ? left : outputs[1];
            powers[0] = correlationDecay * powers[0] + (1.0f - correlationDecay) * left * left;
            powers[1] = correlationDecay * powers[1] + (1.0f - correlationDecay) * right * right;
            powers[2] = correlationDecay * powers[2] + (1.0f - correlationDecay) * left * right;
        }
        inputDb.store(juce::Decibels::gainToDecibels(inputPeak, -100.0f)); outputDb.store(juce::Decibels::gainToDecibels(outputPeak, -100.0f));
        correlation.store(juce::jlimit(-1.0f, 1.0f, powers[2] / std::sqrt(juce::jmax(1.0e-20f, powers[0] * powers[1]))));
    }
    void getStateInformation(juce::MemoryBlock& data) override
    {
        juce::ValueTree state(getName().removeCharacters(" "));
        for (size_t i = 0; i < controls.size(); ++i)
            if (!(kind == Kind::Preamp && i >= 12 && values[i].load() == 0))
                state.setProperty(controls[i].id, values[i].load(), nullptr);
        juce::MemoryOutputStream stream(data, false); state.writeToStream(stream);
    }
    void setStateInformation(const void* data, int size) override
    {
        const auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(size));
        if (!state.isValid() || state.getType().toString() != getName().removeCharacters(" ")) return;
        for (const auto& control : controls) setControl(control.id, static_cast<float>(state.getProperty(control.id, control.initial)), true);
        refreshSpectralConfiguration(true);
        refreshCharacterConfiguration();
    }
    BuiltInGraphicEQ::Settings graphicSettings() const
    {
        BuiltInGraphicEQ::Settings settings;
        settings.mode = values[12].load(); settings.target = values[13].load();
        settings.highPassEnabled = values[14].load(); settings.highPass = values[15].load();
        settings.lowPassEnabled = values[16].load(); settings.lowPass = values[17].load();
        for (size_t i = 0; i < BuiltInGraphicEQ::bandCount; ++i) settings.gains[i] = values[18+i].load();
        return settings;
    }
    juce::var levelVisualization() const
    {
        auto* viz=new juce::DynamicObject();viz->setProperty("correlation",correlation.load());
        viz->setProperty("latencySamples",getLatencySamples());
        viz->setProperty("inputLevelDb",inputDb.load());viz->setProperty("outputLevelDb",outputDb.load());
        if(kind==Kind::Preamp)
        {
            viz->setProperty("drivenReferenceDb",drivenReferenceDb.load());
            juce::Array<juce::var> input,output;for(int ch=0;ch<2;++ch){input.add(averageMeter.db(false,ch));output.add(averageMeter.db(true,ch));}
            viz->setProperty("inputAverageDb",input);viz->setProperty("outputAverageDb",output);
        }
        return juce::var(viz);
    }
    juce::var graphicVisualization()
    {
        auto* viz = new juce::DynamicObject();
        if (kind != Kind::GraphicEQ) return juce::var(viz);
        const double fs = visualRate.load(); const auto settings = graphicSettings();
        const auto spectrum = graphicCapture->read();
        juce::Array<juce::var> frequencies, response, pre, post;
        std::array<BuiltInGraphicEQ::Coefficients, 33> filters {};
        const size_t count = settings.mode >= .5f ? 31 : 10;
        for (size_t i = 0; i < count; ++i)
            filters[i] = BuiltInGraphicEQ::peak(fs, count == 31 ? BuiltInGraphicEQ::frequencies[i] : 31.25*std::pow(2.0, static_cast<double>(i)),
                count == 31 ? settings.gains[i] : values[i].load(), count == 31 ? BuiltInGraphicEQ::q() : std::sqrt(2.0));
        filters[count] = BuiltInGraphicEQ::cut(fs, settings.highPass, true, settings.highPassEnabled >= .5f);
        filters[count+1] = BuiltInGraphicEQ::cut(fs, settings.lowPass, false, settings.lowPassEnabled >= .5f);
        for (int i = 0; i < 128; ++i)
        {
            const double hz = 20 * std::pow(juce::jmin(20000.0, fs*.45)/20, i/127.0);
            double gain = juce::Decibels::decibelsToGain(static_cast<double>(values[10].load()));
            for (size_t filter = 0; filter < count+2; ++filter) gain *= BuiltInGraphicEQ::magnitude(filters[filter], fs, hz);
            if (values[11].load() >= .5f) gain = 1;
            frequencies.add(hz); response.add(juce::Decibels::gainToDecibels(gain, -120.0));
            const size_t bin = static_cast<size_t>(juce::jlimit(0, BuiltInSpectrumCapture::bins-1, juce::roundToInt(hz/fs*BuiltInSpectrumCapture::size)));
            pre.add(spectrum.pre[bin]); post.add(spectrum.post[bin]);
        }
        viz->setProperty("frequencies", frequencies); viz->setProperty("responseDb", response);
        viz->setProperty("spectrumPreDb", pre); viz->setProperty("spectrumPostDb", post); viz->setProperty("spectrumReady", spectrum.ready);
        viz->setProperty("sampleRate", fs); viz->setProperty("inputLevelDb", inputDb.load()); viz->setProperty("outputLevelDb", outputDb.load());
        return juce::var(viz);
    }
private:
    size_t smoothedControlCount() const noexcept { return kind == Kind::GainPhase ? 14 : controls.size(); }
    std::array<juce::String, BuiltInSpectralPhaseCurve::points * 2> spectralIds;
    std::unique_ptr<BuiltInLinearPhaseEQ> spectral;
    bool prepared = false;
    bool originalCharacterPrepared = false;
    int preparedMaximumBlock = 512, preampOversamplingFactor = 4;
    BuiltInPhaseAlignment phase;
    BuiltInGraphicEQ graphic;
    std::unique_ptr<BuiltInSpectrumCapture> graphicCapture;
    std::atomic<double> visualRate { 44100 };
    std::atomic<float> inputDb { -100 }, outputDb { -100 };
    BuiltInPreampTone tone;
    BuiltInAverageMeter averageMeter;
    std::atomic<float> drivenReferenceDb{-100};
    double rate = 44100.0;
    juce::AudioBuffer<float> scratch, delays;
    std::array<juce::SmoothedValue<float>, 64> smooth;
    std::array<BuiltInOriginalColour, 2> originalPreamp;
    int position = 0;
    unsigned int updateCounter = 0;
    std::array<std::array<double, 5>, 10> coefficients {};
    std::array<std::array<std::array<double, 2>, 10>, 2> filterState {};
    std::array<float, 2> dcInput {}, dcOutput {};
    std::array<float, 3> powers {};
    std::array<BuiltInPhaseAlignment::Tap, 2> activeDelay {}, targetDelay {};
    std::array<float, 2> delayFade { 1.0f, 1.0f };
    void updateFilter(int band, float gainDb)
    {
        static constexpr double frequencies[] = { 31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
        const double omega = juce::MathConstants<double>::twoPi * juce::jmin(frequencies[band], rate * 0.45) / rate;
        const double a = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
        const double alpha = std::sin(omega) / (2.0 * 1.41421356237);
        const double a0 = 1.0 + alpha / a;
        coefficients[static_cast<size_t>(band)] = { (1.0 + alpha * a) / a0, -2.0 * std::cos(omega) / a0,
            (1.0 - alpha * a) / a0, -2.0 * std::cos(omega) / a0, (1.0 - alpha / a) / a0 };
    }
};
