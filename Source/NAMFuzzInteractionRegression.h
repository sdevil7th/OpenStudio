#pragma once

#include "NAMFuzz.h"
#include "NAMPolyOctaver.h"
#include "BuiltInEffects2.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <memory>
#include <vector>

// Opt-in, local QA only. Never read by the production renderer. No sound-quality
// pass is inferred from the measurements or the existence of audition files.
class NAMFuzzInteractionRegression final
{
public:
    static juce::Array<juce::var> run()
    {
        juce::Array<juce::var> checks;
        const auto requested = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_AUDIT_DIR", {});
        if (requested.isEmpty())
        {
            add(checks, "nam_fuzz_interaction_audit", "not_asserted", "Opt-in sweep/listening pack not requested; set OPENSTUDIO_NAM_FUZZ_AUDIT_DIR to an isolated QA output root.");
            return checks;
        }
        const auto started = juce::Time::getMillisecondCounterHiRes();
        const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile(requested)
            .getChildFile("fuzz-" + juce::Uuid().toString().substring(0, 8));
        if (!directory.createDirectory().wasOk())
        {
            add(checks, "nam_fuzz_interaction_audit", "fail", "Could not create the requested isolated output directory.");
            return checks;
        }
        bool structuralPassed = true, writesPassed = true;
        auto* report = new juce::DynamicObject();
        const juce::var reportValue(report);
        report->setProperty("schemaVersion", 1);
        report->setProperty("sampleRate", rate);
        report->setProperty("directory", directory.getFullPathName());
        report->setProperty("route", "The sweep and listening arrays cover the exact NAMPolyOctaver production voices/mixer followed by NAMFuzz, without amp/cab. Optional fullChainListening rows separately use the production NAM Rack and explicit amp/IR resources; their route and diagnostics describe that coverage.");
        report->setProperty("outputProcessing", "Native levels retained in IEEE float32 WAVs, including samples above unity; no export gain matching, added limiter, normalization or clipping. Full-chain exports retain production rack safety processing, recorded separately in each row. Listening-player/device clipping remains possible.");
        report->setProperty("soundQuality", "not_asserted");
        report->setProperty("aliasingIntermodulationLoudnessCancellationAndGating", "diagnostic_only");
        report->setProperty("coverage", "144 short cases: Guitar/Bass profiles x mono/chord x -48/-18/-1 dBFS input peaks x three fuzz voices x four route/control corners. This is a bounded boundary sample, not every combination or a universal no-clash guarantee.");
        report->setProperty("sourceScope", "Recorded guitar notes/arrangements where present. A Bass profile does not make a guitar recording a bass DI. Unavailable bass DI is explicitly synthetic.");
        report->setProperty("sweep", sweep(structuralPassed));
        report->setProperty("lowBassDownOctave", lowBass());
        report->setProperty("cleanBlendFrequencyDiagnostics", cleanFrequency(structuralPassed));
        report->setProperty("voiceRmsBalance", voiceBalance(structuralPassed));
        report->setProperty("gatedQuietTail", gatedTail(structuralPassed));
        report->setProperty("listening", listening(directory, writesPassed));
        report->setProperty("fullChainListening", fullChainListening(directory, structuralPassed, writesPassed, checks));
        report->setProperty("structuralPassed", structuralPassed);
        report->setProperty("filesWritten", writesPassed);
        report->setProperty("elapsedMilliseconds", juce::Time::getMillisecondCounterHiRes() - started);
        const auto manifest = directory.getChildFile("manifest.json");
        writesPassed = manifest.replaceWithText(juce::JSON::toString(reportValue, true)) && writesPassed;
        add(checks, "nam_fuzz_interaction_structural", structuralPassed && writesPassed ? "pass" : "fail",
            "Opt-in composition checks finite samples, silent-right isolation, fixed-control production-mix parity and callback partition invariance, and verifies audition file writes. Sound quality is not asserted.", reportValue);
        add(checks, "nam_fuzz_interaction_sound_measurements", "diagnostic_only",
            "Peaks above unity, coherent blend interference, low-sub attenuation, gated tail windows, spectra and voice loudness are diagnostic observations requiring exact-artifact audition. See the manifest and unnormalized float WAVs.", manifest.getFullPathName());
        return checks;
    }

private:
    inline static constexpr double rate = 48000.0;
    struct Voices { juce::AudioBuffer<float> down, up; };
    struct Material { juce::String name; juce::AudioBuffer<float> audio; juce::var provenance; bool bass = false; };
    static void add(juce::Array<juce::var>& checks, const juce::String& id, const juce::String& status,
                    const juce::String& detail, const juce::var& value = {})
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("id", id); result->setProperty("status", status); result->setProperty("detail", detail);
        if (!value.isVoid()) result->setProperty("value", value);
        checks.add(juce::var(result));
    }
    static juce::AudioBuffer<float> synthetic(bool bass, bool chord, int count, float peak)
    {
        juce::AudioBuffer<float> audio(2, count); audio.clear();
        const double fundamental = bass ? 30.8677063 : 82.4068892;
        double maximum = 0.0;
        for (int sample = 0; sample < count; ++sample)
        {
            const double time = static_cast<double>(sample) / rate;
            const double envelope = (1.0 - std::exp(-time / 0.002)) * std::exp(-time / 0.25);
            double value = 0.0;
            for (int note = 0; note < (chord ? 3 : 1); ++note)
                for (int harmonic = 1; harmonic <= 5; ++harmonic)
                    value += envelope * std::sin(juce::MathConstants<double>::twoPi * fundamental
                        * std::pow(2.0, (note == 1 ? 4.0 : note == 2 ? 7.0 : 0.0) / 12.0) * harmonic * time) / (harmonic * 2.0);
            audio.setSample(0, sample, static_cast<float>(value)); maximum = juce::jmax(maximum, std::abs(value));
        }
        audio.applyGain(static_cast<float>(peak / juce::jmax(1.0e-9, maximum)));
        return audio; // Right stays exactly silent for coupling tests.
    }
    static Voices octaves(const juce::AudioBuffer<float>& source, bool bass)
    {
        Voices result { juce::AudioBuffer<float>(2, source.getNumSamples()), juce::AudioBuffer<float>(2, source.getNumSamples()) };
        const auto octave = std::make_unique<NAMPolyOctaver>();
        octave->setInstrumentProfile(bass ? 1 : 0); octave->prepare(rate, 512);
        const std::array<const float*, 2> input { source.getReadPointer(0), source.getReadPointer(1) };
        std::array<float*, 2> down { result.down.getWritePointer(0), result.down.getWritePointer(1) };
        std::array<float*, 2> up { result.up.getWritePointer(0), result.up.getWritePointer(1) };
        octave->processVoicesForTesting(input.data(), down.data(), up.data(), 2, source.getNumSamples());
        return result;
    }
    static juce::AudioBuffer<float> mix(const juce::AudioBuffer<float>& source, const Voices& voices, float direct, float down, float up)
    {
        juce::AudioBuffer<float> audio(2,source.getNumSamples());
        // Same multiply/add order as NAMPolyOctaver::processBlock at fixed
        // prepared levels, avoiding a vectorized mixer changing roundoff.
        for (int channel = 0; channel < 2; ++channel) for(int sample=0;sample<source.getNumSamples();++sample)
            audio.setSample(channel,sample,source.getSample(channel,sample)*direct+voices.down.getSample(channel,sample)*down+voices.up.getSample(channel,sample)*up);
        return audio;
    }
    static float excitationForLevels(float direct,float down,float up)
    {const float reference=juce::jmax(1.0f,direct);return reference/juce::jmax(reference,direct+down+up);}
    static juce::AudioBuffer<float> fuzz(const juce::AudioBuffer<float>& source, NAMFuzz::Parameters controls,float excitationGain=1.0f)
    {
        juce::AudioBuffer<float> audio; audio.makeCopyOf(source); NAMFuzz processor; processor.prepare(rate, controls);
        const std::vector<float> excitation(static_cast<size_t>(audio.getNumSamples()),excitationGain);
        processor.processBlock(audio,excitation.data()); return audio;
    }
    static juce::var parameters(const NAMFuzz::Parameters& control)
    {
        auto* object = new juce::DynamicObject(); object->setProperty("enabled", control.enabled);
        object->setProperty("voice", control.voice); object->setProperty("drive", control.drive);
        object->setProperty("tone", control.tone); object->setProperty("levelDb", control.levelDb);
        object->setProperty("cleanMix", control.cleanMix); object->setProperty("bass", control.bass); return juce::var(object);
    }
    static double power(const juce::AudioBuffer<float>& audio, int start = 0, int end = -1)
    {
        if (end < 0)
            end = audio.getNumSamples();
        double sum = 0.0;
        for (int sample = start; sample < end; ++sample) { const double value = audio.getSample(0, sample); sum += value * value; }
        return sum / static_cast<double>(juce::jmax(1, end - start));
    }
    static double db(double value) { return 20.0 * std::log10(juce::jmax(1.0e-12, value)); }
    static double difference(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        double maximum = 0.0;
        for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < a.getNumSamples(); ++sample)
        { const double delta = std::abs(static_cast<double>(a.getSample(channel, sample)) - b.getSample(channel, sample)); if (!std::isfinite(delta)) return 1.0e30; maximum = juce::jmax(maximum, delta); }
        return maximum;
    }
    static juce::var measure(const juce::AudioBuffer<float>& audio, const juce::AudioBuffer<float>& input, bool& structurallyFinite)
    {
        double peak = 0.0, sum = 0.0, right = 0.0; int overUnity = 0, gatedWindows = 0, activeWindows = 0;
        for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < audio.getNumSamples(); ++sample)
        {
            const double value = audio.getSample(channel, sample);
            structurallyFinite = structurallyFinite && std::isfinite(value);
            if (!std::isfinite(value)) continue;
            peak = juce::jmax(peak, std::abs(value)); if (std::abs(value) > 1.0) ++overUnity;
            if (channel == 0) sum += value; else right = juce::jmax(right, std::abs(value));
        }
        for (int start = 0; start + 960 <= audio.getNumSamples(); start += 960)
            if (power(input, start, start + 960) > 1.0e-9)
            { ++activeWindows; if (power(audio, start, start + 960) < 1.0e-12) ++gatedWindows; }
        auto* result = new juce::DynamicObject(); result->setProperty("samplePeak", peak); result->setProperty("samplePeakDbFS", db(peak));
        result->setProperty("samplesAboveUnity", overUnity); result->setProperty("rmsDbFS", db(std::sqrt(power(audio))));
        result->setProperty("meanLeft", sum / audio.getNumSamples()); result->setProperty("rightPeak", right);
        result->setProperty("activeInput20msWindows", activeWindows); result->setProperty("outputBelowMinus120DbWindows", gatedWindows);
        result->setProperty("windowGatingInterpretation", "diagnostic_only: quiet-window counts do not prove an audible defect or approved gating behavior.");
        return juce::var(result);
    }
    static juce::var blendDiagnostic(const juce::AudioBuffer<float>& wet, const juce::AudioBuffer<float>& incoming)
    {
        double dot = 0.0; for (int sample = 0; sample < wet.getNumSamples(); ++sample) dot += static_cast<double>(wet.getSample(0, sample)) * incoming.getSample(0, sample);
        dot /= wet.getNumSamples(); const double wetPower = power(wet), cleanPower = power(incoming);
        const double incoherent = 0.25 * (wetPower + cleanPower), coherent = juce::jmax(0.0, incoherent + 0.5 * dot);
        auto* result = new juce::DynamicObject(); result->setProperty("wetIncomingCorrelation", dot / std::sqrt(juce::jmax(1.0e-30, wetPower * cleanPower)));
        result->setProperty("halfBlendCoherentVsIncoherentDb", db(std::sqrt(coherent / juce::jmax(1.0e-30, incoherent))));
        result->setProperty("halfBlendPredictedRmsDbFS", db(std::sqrt(coherent)));
        result->setProperty("cleanSource", "Pre-fuzz Direct+Down+Up sum, not the original DI. These are endpoint-coherence predictions under the original linear blend law, not actual measurements of a changed partial-blend implementation. See cleanBlendFrequencyDiagnostics for actual renders."); return juce::var(result);
    }
    static juce::var sweep(bool& passed)
    {
        juce::Array<juce::var> rows;
        constexpr std::array<std::array<float, 3>, 4> routes {{{0.0f,1.0f,0.0f},{0.0f,0.0f,1.0f},{1.25f,0.0f,0.0f},{1.25f,1.0f,1.0f}}};
        for (const bool bass : {false, true}) for (const bool chord : {false, true}) for (const float level : {-48.0f,-18.0f,-1.0f})
        {
            const auto source = synthetic(bass, chord, 19200, juce::Decibels::decibelsToGain(level)); const auto voices = octaves(source, bass);
            for (int voice = 0; voice < 3; ++voice) for (int route = 0; route < 4; ++route)
            {
                const auto gains = routes[static_cast<size_t>(route)]; const auto incoming = mix(source, voices, gains[0], gains[1], gains[2]);
                const float excitationGain=excitationForLevels(gains[0],gains[1],gains[2]);
                NAMFuzz::Parameters controls; controls.enabled = true; controls.bass = bass; controls.voice = voice;
                controls.drive = route >= 2 ? 1.0f : 0.0f; controls.tone = route % 2 ? 1.0f : 0.0f;
                controls.levelDb = route % 2 ? 12.0f : -18.0f; controls.cleanMix = route == 1 ? 0.25f : route == 2 ? 0.5f : 0.0f;
                const auto output = fuzz(incoming, controls,excitationGain); auto* row = new juce::DynamicObject();
                row->setProperty("bass", bass); row->setProperty("chord", chord); row->setProperty("inputPeakDbFS", level);
                row->setProperty("direct", gains[0]); row->setProperty("down", gains[1]); row->setProperty("up", gains[2]);
                row->setProperty("excitationMetadataGain",excitationGain);
                row->setProperty("fuzz", parameters(controls)); const auto metrics = measure(output, incoming, passed); row->setProperty("metrics", metrics);
                passed = passed && static_cast<double>(metrics.getProperty("rightPeak", 1.0)) == 0.0;
                // Actual all-wet output at unity Level isolates branch coherence
                // from ordinary crossfade/gain changes in the boundary matrix.
                controls.levelDb = 0.0f; controls.cleanMix = 0.0f;
                row->setProperty("blendAtUnityLevel", blendDiagnostic(fuzz(incoming, controls,excitationGain), incoming)); rows.add(juce::var(row));
            }
            // Verify the cached raw-voice mix against the real production mixer
            // and the combined stage under two callback partitions.
            if (level == -18.0f && !chord)
            {
                auto production = [bass, &source] (int blockSize)
                {
                    juce::AudioBuffer<float> output; output.makeCopyOf(source); const auto octave = std::make_unique<NAMPolyOctaver>();
                    octave->setInstrumentProfile(bass ? 1 : 0); octave->setLevels(1.25f,1.0f,1.0f); octave->prepare(rate,512);
                    NAMFuzz::Parameters control; control.enabled = true; control.bass = bass; NAMFuzz processor; processor.prepare(rate,control);
                    std::array<float,512> excitation{};
                    for (int start=0; start<output.getNumSamples(); start+=blockSize)
                    { std::array<float*,2> p {output.getWritePointer(0,start),output.getWritePointer(1,start)}; juce::AudioBuffer<float> block(p.data(),2,juce::jmin(blockSize,output.getNumSamples()-start)); octave->processBlock(block,excitation.data()); processor.processBlock(block,excitation.data()); }
                    return output;
                };
                NAMFuzz::Parameters control; control.enabled=true; control.bass=bass;
                const auto reference=fuzz(mix(source,voices,1.25f,1.0f,1.0f),control,excitationForLevels(1.25f,1.0f,1.0f)), regular=production(512), irregular=production(7);
                passed = passed && difference(reference,regular)<=1.0e-6 && difference(regular,irregular)==0.0;
            }
        }
        return juce::var(rows);
    }
    static std::array<double,2> phasor(const juce::AudioBuffer<float>& audio, double frequency)
    {
        // Fit sin,cos,DC jointly rather than assuming an integer FFT bin. This
        // avoids a window-projection bias at31/41Hz and15.43Hz octave down.
        std::array<std::array<double,4>,3> equations{};
        for(int sample=audio.getNumSamples()/2;sample<audio.getNumSamples();++sample)
        {
            const double phase=juce::MathConstants<double>::twoPi*frequency*sample/rate;
            const std::array<double,3> basis{std::sin(phase),std::cos(phase),1.0};
            for(size_t row=0;row<3;++row){for(size_t column=0;column<3;++column)equations[row][column]+=basis[row]*basis[column];equations[row][3]+=basis[row]*audio.getSample(0,sample);}
        }
        for(size_t pivot=0;pivot<3;++pivot)
        {
            size_t best=pivot;for(size_t row=pivot+1;row<3;++row)if(std::abs(equations[row][pivot])>std::abs(equations[best][pivot]))best=row;
            if(std::abs(equations[best][pivot])<1.0e-12)return {};
            if(best!=pivot)std::swap(equations[best],equations[pivot]);
            const double divisor=equations[pivot][pivot];for(size_t column=pivot;column<4;++column)equations[pivot][column]/=divisor;
            for(size_t row=0;row<3;++row)if(row!=pivot){const double scale=equations[row][pivot];for(size_t column=pivot;column<4;++column)equations[row][column]-=scale*equations[pivot][column];}
        }
        return {equations[0][3],equations[1][3]};
    }
    static double amplitude(const juce::AudioBuffer<float>& audio,double frequency)
    {const auto value=phasor(audio,frequency);return std::hypot(value[0],value[1]);}
    static juce::var lowBass()
    {
        auto input=synthetic(true,false,96000,0.1f); const auto voices=octaves(input,true); juce::Array<juce::var> rows;
        for(int voice=0;voice<3;++voice)
        {
            NAMFuzz::Parameters control;control.enabled=true;control.bass=true;control.voice=voice;const auto output=fuzz(voices.down,control);
            bool finiteSamples=true;auto* row=new juce::DynamicObject();row->setProperty("voice",voice);row->setProperty("metrics",measure(output,voices.down,finiteSamples));
            row->setProperty("octaveOnly15_43HzAmplitude",amplitude(voices.down,15.43385315));row->setProperty("combined15_43HzAmplitude",amplitude(output,15.43385315));
            row->setProperty("interpretation","diagnostic_only: Bass B0 downshift is below the existing18Hz octave HP and sees fuzz12Hz input HP plus12Hz DC blocker. Synthetic decaying note; harmonic redistribution, gate closure and sub attenuation require audition.");rows.add(juce::var(row));
        }
        return juce::var(rows);
    }
    static juce::var cleanFrequency(bool& passed)
    {
        juce::Array<juce::var> rows;
        for(const bool bass:{false,true}) for(const double frequency:{31.0,41.0,82.0,220.0,1000.0,6000.0,10000.0}) for(int voice=0;voice<3;++voice)
        {
            juce::AudioBuffer<float> input(2,24000);input.clear();for(int sample=0;sample<input.getNumSamples();++sample)input.setSample(0,sample,static_cast<float>(0.01*std::sin(juce::MathConstants<double>::twoPi*frequency*sample/rate)));
            NAMFuzz::Parameters control;control.enabled=true;control.bass=bass;control.voice=voice;control.tone=1.0f;
            const auto wet=fuzz(input,control);control.cleanMix=1.0f;const auto clean=fuzz(input,control);
            const int start=input.getNumSamples()/2;
            auto* row=new juce::DynamicObject();row->setProperty("frequencyHz",frequency);row->setProperty("bass",bass);row->setProperty("voice",voice);row->setProperty("tone",1.0);
            row->setProperty("drive",control.drive);row->setProperty("levelDb",0.0);row->setProperty("inputPeak",0.01);
            row->setProperty("endpointCoherence",blendDiagnostic(wet,clean));
            const auto wetPhasor=phasor(wet,frequency),cleanPhasor=phasor(clean,frequency);
            const double wetAmplitude=std::hypot(wetPhasor[0],wetPhasor[1]),cleanAmplitude=std::hypot(cleanPhasor[0],cleanPhasor[1]);
            const double phaseCosine=(wetPhasor[0]*cleanPhasor[0]+wetPhasor[1]*cleanPhasor[1])/juce::jmax(1.0e-30,wetAmplitude*cleanAmplitude);
            const float balancedBlend=static_cast<float>(wetAmplitude/juce::jmax(1.0e-30,wetAmplitude+cleanAmplitude));
            control.cleanMix=balancedBlend;const auto balancedOutput=fuzz(input,control);
            const double balancedIncoherent=(1.0-balancedBlend)*(1.0-balancedBlend)*wetAmplitude*wetAmplitude+balancedBlend*balancedBlend*cleanAmplitude*cleanAmplitude;
            row->setProperty("steadyEndpointPhaseDifferenceDegrees",std::acos(juce::jlimit(-1.0,1.0,phaseCosine))*180.0/juce::MathConstants<double>::pi);
            row->setProperty("amplitudeBalancedCleanMix",balancedBlend);
            row->setProperty("actualBalancedFundamentalVsIncoherentDb",db(amplitude(balancedOutput,frequency)/std::sqrt(juce::jmax(1.0e-30,balancedIncoherent))));
            row->setProperty("spectralEstimator","Least-squares sin/cos/DC fit over the second half of the rendered waveform; diagnostic only, not an alias or tone-quality proof.");
            juce::Array<juce::var> blends;
            for(const float blend:{0.0f,0.25f,0.5f,0.75f,1.0f})
            {
                control.cleanMix=blend;const auto output=fuzz(input,control);const auto metrics=measure(output,input,passed);
                passed=passed&&static_cast<double>(metrics.getProperty("rightPeak",1.0))==0.0;
                if(blend==1.0f)passed=passed&&difference(output,input)<=3.0e-8;
                double referenceDifference=0.0;
                for(int sample=start;sample<output.getNumSamples();++sample)
                    referenceDifference=juce::jmax(referenceDifference,std::abs(static_cast<double>(output.getSample(0,sample))-((1.0-blend)*wet.getSample(0,sample)+blend*clean.getSample(0,sample))));
                const double incoherent=(1.0-blend)*(1.0-blend)*power(wet,start)+blend*blend*power(clean,start);
                auto* actual=new juce::DynamicObject();actual->setProperty("cleanMix",blend);actual->setProperty("metrics",metrics);
                actual->setProperty("lateRmsDbFS",db(std::sqrt(power(output,start))));
                actual->setProperty("actualVsIncoherentEndpointPowerDb",db(std::sqrt(power(output,start)/juce::jmax(1.0e-30,incoherent))));
                actual->setProperty("maximumDifferenceFromLinearEndpointSum",referenceDifference);
                passed=passed&&referenceDifference<=1.0e-6;
                actual->setProperty("fundamentalAmplitude",amplitude(output,frequency));blends.add(juce::var(actual));
            }
            row->setProperty("actualRenderedBlends",juce::var(blends));
            row->setProperty("interpretation","diagnostic_only: actual partial-blend spectral/power output, without loudness matching. The retained linear parallel blend law, Clean100% unity-Level parity, finiteness and silent-right isolation are structural assertions; cancellation depth is not a sound-quality pass.");rows.add(juce::var(row));
        }
        return juce::var(rows);
    }

    static juce::var voiceBalance(bool& passed)
    {
        juce::Array<juce::var> rows;
        for(int material=0;material<3;++material)
        {
            const bool bass=material==2;const auto input=synthetic(bass,material==1,24000,0.126f);
            for(const float drive:{0.0f,0.5f,1.0f})for(const float tone:{0.0f,0.5f,1.0f})
            {
                juce::Array<juce::var> voices;double minimum=1.0e30,maximum=-1.0e30;
                for(int voice=0;voice<3;++voice)
                {
                    NAMFuzz::Parameters control;control.enabled=true;control.bass=bass;control.voice=voice;control.drive=drive;control.tone=tone;
                    const auto output=fuzz(input,control);const auto metrics=measure(output,input,passed);
                    passed=passed&&static_cast<double>(metrics.getProperty("rightPeak",1.0))==0.0;
                    const double rms=db(std::sqrt(power(output)));minimum=juce::jmin(minimum,rms);maximum=juce::jmax(maximum,rms);
                    auto* voiceRow=new juce::DynamicObject();voiceRow->setProperty("voice",voice);voiceRow->setProperty("metrics",metrics);voices.add(juce::var(voiceRow));
                }
                auto* row=new juce::DynamicObject();row->setProperty("material",material==0?"synthetic-guitar-mono":material==1?"synthetic-guitar-chord":"synthetic-bass-B0");
                row->setProperty("inputPeak",0.126);row->setProperty("drive",drive);row->setProperty("tone",tone);row->setProperty("levelDb",0.0);row->setProperty("cleanMix",0.0);
                row->setProperty("voices",juce::var(voices));row->setProperty("voiceRmsSpreadDb",maximum-minimum);
                row->setProperty("interpretation","diagnostic_only: voice RMS differences across material/drive/tone are measured at identical native Level. No material was normalized after rendering; intentional tonal differences remain possible.");rows.add(juce::var(row));
            }
        }
        return juce::var(rows);
    }

    static juce::var gatedTail(bool& passed)
    {
        juce::Array<juce::var> rows;
        // Known input segments, rather than a short peak-normalized decay,
        // expose late quiet-note retention, silence retirement and re-entry.
        constexpr std::array<float,8> peaks {0.03f,0.006f,0.003f,0.0015f,0.0007f,0.0f,0.0015f,0.03f};
        constexpr int segmentSamples=12000;
        for(const bool bass:{false,true})for(const float drive:{0.0f,0.5f,1.0f})
        {
            juce::AudioBuffer<float> input(2,segmentSamples*static_cast<int>(peaks.size()));input.clear();
            for(int sample=0;sample<input.getNumSamples();++sample)
            {const int segment=sample/segmentSamples;const double time=sample/rate;const double frequency=bass?30.8677063:82.4068892;
                input.setSample(0,sample,peaks[static_cast<size_t>(segment)]*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*frequency*time)));}
            input.copyFrom(1,0,input,0,0,input.getNumSamples());
            NAMFuzz::Parameters control;control.enabled=true;control.voice=2;control.bass=bass;control.drive=drive;
            const auto regular=fuzz(input,control);
            juce::AudioBuffer<float> irregular;irregular.makeCopyOf(input);NAMFuzz processor;processor.prepare(rate,control);
            for(int start=0;start<irregular.getNumSamples();start+=31)
            {std::array<float*,2> pointers{irregular.getWritePointer(0,start),irregular.getWritePointer(1,start)};juce::AudioBuffer<float> block(pointers.data(),2,juce::jmin(31,irregular.getNumSamples()-start));processor.processBlock(block);}
            const double partitionDifference=difference(regular,irregular);passed=passed&&partitionDifference==0.0;
            bool stereoParity=true;for(int sample=0;sample<regular.getNumSamples();++sample)stereoParity=stereoParity&&regular.getSample(0,sample)==regular.getSample(1,sample);
            const auto metrics=measure(regular,input,passed);passed=passed&&stereoParity;
            juce::Array<juce::var> segments;
            for(size_t segment=0;segment<peaks.size();++segment)
            {
                const int begin=static_cast<int>(segment)*segmentSamples;auto* measured=new juce::DynamicObject();
                measured->setProperty("inputPeak",peaks[segment]);measured->setProperty("startSeconds",begin/rate);
                measured->setProperty("inputLateRmsDbFS",db(std::sqrt(power(input,begin+segmentSamples/2,begin+segmentSamples))));
                measured->setProperty("outputLateRmsDbFS",db(std::sqrt(power(regular,begin+segmentSamples/2,begin+segmentSamples))));
                measured->setProperty("kind",segment==5?"silence":segment==6?"quiet-reentry":segment==7?"loud-reentry":"descending-tail");segments.add(juce::var(measured));
            }
            auto* row=new juce::DynamicObject();row->setProperty("bass",bass);row->setProperty("drive",drive);row->setProperty("segments",juce::var(segments));row->setProperty("metrics",metrics);
            row->setProperty("maximumPartitionDifference",partitionDifference);row->setProperty("identicalStereoParity",stereoParity);
            row->setProperty("interpretation","Late envelope and re-entry values are diagnostic_only. Exact callback partition and identical-stereo parity are asserted. These output measurements alone do not prove hysteresis without gate-state evidence.");rows.add(juce::var(row));
        }
        return juce::var(rows);
    }
    static bool load(const juce::File& file, juce::AudioBuffer<float>& audio, juce::var& provenance)
    {
        juce::AudioFormatManager formats;formats.registerBasicFormats();std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
        if(!reader||reader->sampleRate<8000.0||reader->sampleRate>384000.0)return false;
        const int inputCount=static_cast<int>(std::min<juce::int64>(reader->lengthInSamples,static_cast<juce::int64>(reader->sampleRate*6.0)));
        if (inputCount < 2)
            return false;
        juce::AudioBuffer<float> decoded(2, inputCount);
        decoded.clear();
        if (!reader->read(&decoded, 0, inputCount, 0, true, true))
            return false;
        const int count=static_cast<int>(inputCount*rate/reader->sampleRate);audio.setSize(2,count);
        for(int sample=0;sample<count;++sample){const double position=sample*reader->sampleRate/rate;const int index=juce::jmin(inputCount-1,static_cast<int>(position));const float fraction=static_cast<float>(position-index);
            for(int channel=0;channel<2;++channel){const int sourceChannel=reader->numChannels==1?0:channel;audio.setSample(channel,sample,decoded.getSample(sourceChannel,index)*(1.0f-fraction)+decoded.getSample(sourceChannel,juce::jmin(index+1,inputCount-1))*fraction);}}
        auto* source=new juce::DynamicObject();source->setProperty("path",file.getFullPathName());source->setProperty("sha256",juce::SHA256(file).toHexString());
        source->setProperty("sourceSampleRate",reader->sampleRate);source->setProperty("sourceChannels",static_cast<int>(reader->numChannels));
        source->setProperty("preprocessing","First at most6seconds; nativeJUCE decoding, linear resampling to48k only if needed, mono duplicated to stereo; no gain normalization or fades.");provenance=juce::var(source);return true;
    }
    static bool write(const juce::File& path,const juce::AudioBuffer<float>& audio)
    {
        std::unique_ptr<juce::OutputStream> stream=path.createOutputStream();if(!stream)return false;juce::WavAudioFormat format;
        auto writer=format.createWriterFor(stream,juce::AudioFormatWriterOptions().withSampleRate(rate).withNumChannels(2).withBitsPerSample(32).withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
        return writer&&writer->writeFromAudioSampleBuffer(audio,0,audio.getNumSamples());
    }
    static std::vector<Material> materials(bool& writesPassed)
    {
        std::vector<Material> materials;const auto root=juce::File::getCurrentWorkingDirectory();
        const auto overrideInput=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_AUDIT_INPUT",{});
        for(const char* name:{"recorded-guitar-low-notes","recorded-guitar-layered-chord"})
        {
            Material material;material.name=overrideInput.isNotEmpty()?"recorded-guitar-override":name;
            const auto file=root.getChildFile(overrideInput.isNotEmpty()?overrideInput:"output/reverb-recorded/sources/"+juce::String(name)+".wav");
            if(load(file,material.audio,material.provenance)){material.provenance.getDynamicObject()->setProperty("qualification",overrideInput.isNotEmpty()?"User-selected existing audio; recording-chain/DI provenance not independently verified.":"Existing arranged CC0FreePats raw electric-guitar notes. See output/reverb-recorded/sources/manifest.json for original note hashes, explicit source gains and fades. Not a continuous live performance.");materials.push_back(std::move(material));}
            else if(overrideInput.isNotEmpty())writesPassed=false;
            if(overrideInput.isNotEmpty())break;
        }
        if(materials.empty())
        {
            Material material;material.name="recorded-guitar-E2";
            if(load(root.getChildFile("resources/test_fixtures/guitar_di/EGuitarFSBS-direct SFZ+FLAC-20220911/samples/bridge/E2_s1_01.flac"),material.audio,material.provenance))
            {material.provenance.getDynamicObject()->setProperty("qualification","Existing CC0FreePats raw direct Fender guitar E2note; bank README/LICENSE provide provenance. One plucked note, not a riff.");materials.push_back(std::move(material));}
        }
        const auto bassInput=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_AUDIT_BASS_INPUT",{});
        Material bass;bass.bass=true;bass.name=bassInput.isEmpty()?"synthetic-bass-B0-decay":"bass-audio-override";
        if(bassInput.isNotEmpty())
        {if(!load(root.getChildFile(bassInput),bass.audio,bass.provenance))writesPassed=false;}
        else
        {bass.audio=synthetic(true,false,192000,0.18f);bass.audio.copyFrom(1,0,bass.audio,0,0,bass.audio.getNumSamples());auto* origin=new juce::DynamicObject();origin->setProperty("qualification","Explicitly synthetic five-harmonic B0decay, peak0.18, attack2ms/decay250ms; no verified real bass DI found. Not a recorded bass.");bass.provenance=juce::var(origin);}
        if(bass.audio.getNumSamples()>0)materials.push_back(std::move(bass));
        if(materials.size()==1&&materials.front().bass)writesPassed=false;
        for (auto& material : materials)
        {
            juce::MemoryBlock samples;
            for (int channel = 0; channel < material.audio.getNumChannels(); ++channel)
                samples.append(material.audio.getReadPointer(channel),
                    static_cast<size_t>(material.audio.getNumSamples()) * sizeof(float));
            material.provenance.getDynamicObject()->setProperty("renderedInputSha256", juce::SHA256(samples).toHexString());
        }
        return materials;
    }
    static juce::var listening(const juce::File& directory,bool& writesPassed)
    {
        const auto sources = materials(writesPassed);
        juce::Array<juce::var> entries;
        for(const auto& material:sources)
        {
            const auto voices=octaves(material.audio,material.bass);
            const auto combined=mix(material.audio,voices,1.0f,0.32f,0.18f);
            for(int variant=0;variant<11;++variant)
            {
                NAMFuzz::Parameters control;control.enabled=variant>=2;control.bass=material.bass;control.voice=variant>=8?variant-8:variant>=5?variant-5:juce::jmax(0,variant-2);
                control.cleanMix=variant>=8?0.5f:0.0f;
                control.levelDb=control.enabled?-6.0f:0.0f;
                const bool octave=variant==1||variant>=5;const auto& incoming=octave?combined:material.audio;
                const float excitationGain=octave?excitationForLevels(1.0f,0.32f,0.18f):1.0f;const auto output=fuzz(incoming,control,excitationGain);
                const juce::String voiceName=control.voice==0?"vintage":control.voice==1?"sustain":"gated";
                const auto label=variant==0?juce::String("dry"):variant==1?juce::String("octave-only"):juce::String(variant>=8?"combined-clean50-":variant>=5?"combined-":"fuzz-only-")+voiceName;
                const auto file=directory.getChildFile(material.name+"-"+label+".wav");writesPassed=write(file,output)&&writesPassed;
                auto* row=new juce::DynamicObject();row->setProperty("material",material.name);row->setProperty("file",file.getFileName());row->setProperty("source",material.provenance);
                row->setProperty("seconds",output.getNumSamples()/rate);row->setProperty("bassProfile",material.bass);row->setProperty("direct",1.0);row->setProperty("down",octave?0.32:0.0);row->setProperty("up",octave?0.18:0.0);
                row->setProperty("excitationMetadataGain",excitationGain);
                row->setProperty("fuzz",parameters(control));bool finiteSamples=true;row->setProperty("metrics",measure(output,incoming,finiteSamples));writesPassed=writesPassed&&finiteSamples;entries.add(juce::var(row));
            }
        }
        return juce::var(entries);
    }

    static juce::var fullChainListening(const juce::File& directory, bool& structuralPassed,
                                       bool& writesPassed, juce::Array<juce::var>& checks)
    {
        juce::Array<juce::var> entries;
        const bool extended = juce::SystemStats::getEnvironmentVariable(
            "OPENSTUDIO_NAM_FUZZ_EXTENDED", {}) == "1";
        const auto ampPath = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_AUDIT_AMP", {});
        const auto cabPath = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_NAM_FUZZ_AUDIT_CAB", {});
        if (ampPath.isEmpty() && cabPath.isEmpty())
        {
            add(checks, "nam_fuzz_full_chain_resources", extended ? "fail" : "not_asserted",
                "Full-chain listening was not requested. Supply both OPENSTUDIO_NAM_FUZZ_AUDIT_AMP and OPENSTUDIO_NAM_FUZZ_AUDIT_CAB for an explicit local NAM amp and cabinet IR; no substitute rig is invented.");
            structuralPassed = structuralPassed && !extended;
            return juce::var(entries);
        }
        const auto root = juce::File::getCurrentWorkingDirectory();
        const auto amp = root.getChildFile(ampPath), cab = root.getChildFile(cabPath);
        const auto rack = std::make_unique<OpenStudioNAMRack>();
        const bool ampLoaded = ampPath.isNotEmpty() && amp.existsAsFile()
            && rack->loadAmpModel(amp.getFullPathName()) && rack->hasAmpModel();
        const bool cabLoaded = cabPath.isNotEmpty() && cab.existsAsFile()
            && rack->loadCabIR(cab.getFullPathName()) && rack->hasCabIR();
        const bool resourcesPassed = ampLoaded && cabLoaded && !rack->ampModelIncludesCab();
        auto* resources = new juce::DynamicObject();
        resources->setProperty("ampPath", amp.getFullPathName());
        resources->setProperty("cabPath", cab.getFullPathName());
        resources->setProperty("ampLoaded", ampLoaded);
        resources->setProperty("cabLoaded", cabLoaded);
        resources->setProperty("ampIncludesCab", rack->ampModelIncludesCab());
        resources->setProperty("ampCaptureType", rack->getAmpCaptureType());
        resources->setProperty("ampMetadataCaptureType", rack->getAmpMetadataCaptureType());
        resources->setProperty("ampMetadataName", rack->getAmpMetadataName());
        resources->setProperty("ampMetadataGearMake", rack->getAmpMetadataGearMake());
        resources->setProperty("ampMetadataGearModel", rack->getAmpMetadataGearModel());
        resources->setProperty("fixtureQualification", "Explicit existing local files, successful native loads and hashes; capture/IR authoring provenance is not independently certified by this test.");
        if (amp.existsAsFile()) resources->setProperty("ampSha256", juce::SHA256(amp).toHexString());
        if (cab.existsAsFile()) resources->setProperty("cabSha256", juce::SHA256(cab).toHexString());
        add(checks, "nam_fuzz_full_chain_resources", resourcesPassed ? "pass" : "fail",
            "Requested full-chain coverage requires a loaded real NAM amp and cabinet IR. Amp+cab captures are rejected to avoid silently doubling cabinet filtering.", juce::var(resources));
        structuralPassed = structuralPassed && resourcesPassed;
        if (!resourcesPassed) return juce::var(entries);

        const auto sources = materials(writesPassed);
        bool fullChainPassed = true;
        juce::int64 ordinaryOutputGuardHits = 0;
        const std::array<const char*, 8> stageNames {{ "rig-only", "fuzz", "drive", "fuzz-drive",
            "distortion", "fuzz-distortion", "drive-distortion", "fuzz-drive-distortion" }};
        struct ChainCase
        {
            int mask = 7, voice = 0, distortionMode = 0;
            bool octave = true;
            float cleanMix = 0.0f, referenceDbu = 12.0f;
            int gateMask = 0, octavePresence = -1;
            juce::String suffix, category = "topology";
        };
        const auto makeCases = [extended] (bool stress)
        {
            std::vector<ChainCase> cases;
            // Default iteration, settings and filenames remain the archived
            // 16 cases per control set. Extended coverage adds the independent
            // Octave power state and all three active Distortion modes.
            for (int octave = 0; octave < (extended ? 2 : 1); ++octave)
            for (int mask = 0; mask < 8; ++mask)
            for (int voice = 0; voice < ((mask & 1) != 0 ? 3 : 1); ++voice)
            for (int mode = 0; mode < (extended && (mask & 4) != 0 ? 3 : 1); ++mode)
            {
                ChainCase item;
                item.mask = mask;
                item.voice = voice;
                item.octave = !extended || octave != 0;
                item.distortionMode = extended ? mode : (stress ? 1 : 0);
                if (extended)
                    item.suffix = "-extended-octave-" + juce::String(item.octave ? "on" : "off")
                        + "-dist-" + juce::String((mask & 4) != 0 ? mode : -1);
                cases.push_back(std::move(item));
            }
            if (!extended || stress) return cases;
            const auto context = [] (const juce::String& name, int voice)
            {
                ChainCase item;
                item.voice = voice;
                item.distortionMode = voice;
                item.category = name;
                item.suffix = "-extended-" + name;
                return item;
            };
            for (int voice = 0; voice < 3; ++voice)
            {
                for (float cleanMix : { 0.25f, 0.5f, 0.75f, 1.0f })
                {
                    auto item = context("clean", voice);
                    item.cleanMix = cleanMix;
                    item.suffix += "-" + juce::String(juce::roundToInt(cleanMix * 100.0f));
                    cases.push_back(std::move(item));
                }
                for (float referenceDbu : { 6.0f, 18.0f, 24.0f })
                {
                    auto item = context("calibration", voice);
                    item.referenceDbu = referenceDbu;
                    item.suffix += "-" + juce::String(juce::roundToInt(referenceDbu));
                    cases.push_back(std::move(item));
                }
                for (int presence = 1; presence < 8; ++presence)
                {
                    auto item = context("octave-presence", voice);
                    item.octavePresence = presence;
                    item.suffix += "-" + juce::String(presence);
                    cases.push_back(std::move(item));
                }
            }
            for (int mask = 1; mask < 8; ++mask)
            {
                auto item = context("gates", 2);
                item.gateMask = mask; // Global, Drive, Distortion; Fuzz is Gated.
                item.suffix += "-" + juce::String(mask);
                cases.push_back(std::move(item));
            }
            return cases;
        };
        juce::StringArray writtenNames;
        for (const auto& material : sources)
        {
            for (const bool stress : { false, true })
            {
                for (const auto& testCase : makeCases(stress))
                {
                    const int mask = testCase.mask, voice = testCase.voice;
                    const bool fuzzEnabled = (mask & 1) != 0;
                    // Every value is installed before prepare/reset. Resource loading and
                    // all buffers are allocated off the simulated audio callback.
                    rack->setRoutedInputChannelCount(2);
                    rack->instrumentProfile.store(material.bass ? 1.0f : 0.0f);
                    rack->inputTrimDb.store(0.0f); rack->outputTrimDb.store(0.0f);
                    rack->calibrationReferenceDbu.store(testCase.referenceDbu);
                    rack->gateThresholdDb.store((testCase.gateMask & 1) != 0 ? -45.0f : -100.0f);
                    rack->compressorEnabled.store(0.0f);
                    rack->octaverEnabled.store(testCase.octave ? 1.0f : 0.0f);
                    rack->octaverDirectMix.store(testCase.octavePresence < 0
                        ? (stress ? 1.25f : 1.0f) : ((testCase.octavePresence & 1) != 0 ? 1.0f : 0.0f));
                    rack->octaverDownMix.store(testCase.octavePresence < 0
                        ? (stress ? 1.0f : 0.32f) : ((testCase.octavePresence & 2) != 0 ? 0.5f : 0.0f));
                    rack->octaverUpMix.store(testCase.octavePresence < 0
                        ? (stress ? 1.0f : 0.18f) : ((testCase.octavePresence & 4) != 0 ? 0.5f : 0.0f));
                    rack->fuzzEnabled.store(fuzzEnabled ? 1.0f : 0.0f);
                    rack->fuzzVoice.store(static_cast<float>(voice));
                    rack->fuzzDrive.store(stress ? 1.0f : 0.45f);
                    rack->fuzzTone.store(stress ? 0.75f : 0.5f);
                    rack->fuzzLevelDb.store(stress ? 6.0f : -6.0f); rack->fuzzCleanMix.store(testCase.cleanMix);
                    rack->preEqEnabled.store(0.0f);
                    rack->precisionDriveEnabled.store((mask & 2) != 0 ? 1.0f : 0.0f);
                    rack->precisionDriveVoice.store(0.0f);
                    rack->precisionDriveDrive.store(stress ? 1.0f : 0.15f);
                    rack->precisionDriveVolumeDb.store(stress ? 12.0f : 3.0f);
                    rack->precisionDriveBright.store(0.5f); rack->precisionDriveAttack.store(0.5f);
                    rack->precisionDriveGate.store((testCase.gateMask & 2) != 0 ? 0.35f : 0.0f);
                    rack->chaosEnabled.store((mask & 4) != 0 ? 1.0f : 0.0f);
                    rack->chaosMode.store(static_cast<float>(testCase.distortionMode));
                    rack->chaosDrive.store(stress ? 1.0f : 0.35f);
                    rack->chaosTone.store(stress ? 0.75f : 0.5f);
                    rack->chaosWeight.store(0.5f); rack->chaosMix.store(1.0f);
                    rack->chaosLevelDb.store(stress ? 6.0f : -6.0f);
                    rack->chaosGate.store((testCase.gateMask & 4) != 0 ? 0.35f : 0.0f);
                    rack->pedalMix.store(0.0f); rack->ampEnabled.store(1.0f); rack->ampMix.store(1.0f);
                    rack->ampGainDb.store(0.0f); rack->ampBoost.store(0.0f); rack->ampVoice.store(0.0f);
                    rack->ampOutputDb.store(0.0f); rack->eqEnabled.store(0.0f);
                    rack->setCabRequestedEnabled(true);
                    rack->cabRoomEnabled.store(0.0f); rack->cabDoublerEnabled.store(0.0f);
                    rack->chorusMix.store(0.0f); rack->modulatorEnabled.store(0.0f);
                    rack->delayEnabled.store(0.0f); rack->reverbEnabled.store(0.0f);
                    rack->auditionSource.store(0.0f);
                    rack->prepareToPlay(rate, 512); rack->reset();
                    rack->resetModelSnapshotLockMissCount();

                    // Calibration probes retain equivalent represented physical
                    // input. This source transform is recorded separately from
                    // output gain matching, which is never applied here.
                    const float inputScale = juce::Decibels::decibelsToGain(12.0f - testCase.referenceDbu);
                    juce::AudioBuffer<float> input; input.makeCopyOf(material.audio);
                    if (inputScale != 1.0f) input.applyGain(inputScale);
                    juce::AudioBuffer<float> output; output.makeCopyOf(input);
                    juce::MidiBuffer midi;
                    juce::int64 firstAmpDspFrames = 0;
                    for (int start = 0; start < output.getNumSamples(); start += 512)
                    {
                        const int count = juce::jmin(512, output.getNumSamples() - start);
                        std::array<float*, 2> pointers {{ output.getWritePointer(0, start), output.getWritePointer(1, start) }};
                        juce::AudioBuffer<float> block(pointers.data(), 2, count);
                        rack->processBlock(block, midi);
                        if (start == 0)
                            firstAmpDspFrames = static_cast<juce::int64>(rack->getDiagnosticState().getProperty(
                                "lastAmpDspFrames", static_cast<juce::int64>(-1)));
                    }
                    const juce::String voiceName = voice == 0 ? "vintage" : voice == 1 ? "sustain" : "gated";
                    const auto file = directory.getChildFile(material.name + "-full-chain-"
                        + (stress ? "stress-" : "conservative-") + stageNames[static_cast<size_t>(mask)]
                        + (fuzzEnabled ? "-" + voiceName : juce::String()) + testCase.suffix + ".wav");
                    if (writtenNames.contains(file.getFileName())) fullChainPassed = false;
                    writtenNames.addIfNotAlreadyThere(file.getFileName());
                    writesPassed = write(file, output) && writesPassed;
                    auto* row = new juce::DynamicObject();
                    row->setProperty("file", file.getFileName()); row->setProperty("material", material.name);
                    row->setProperty("source", material.provenance); row->setProperty("resources", juce::var(resources));
                    row->setProperty("seconds", output.getNumSamples() / rate); row->setProperty("bassProfile", material.bass);
                    row->setProperty("stageMask", mask); row->setProperty("stages", stageNames[static_cast<size_t>(mask)]);
                    row->setProperty("fuzzVoice", voice);
                    row->setProperty("setting", stress ? "stress" : "conservative");
                    row->setProperty("category", testCase.category);
                    row->setProperty("extendedMatrix", extended);
                    row->setProperty("octaveEnabled", testCase.octave);
                    row->setProperty("distortionMode", testCase.distortionMode);
                    row->setProperty("cleanMix", testCase.cleanMix);
                    row->setProperty("gateMask", testCase.gateMask);
                    row->setProperty("octavePresenceMask", testCase.octavePresence);
                    row->setProperty("calibrationReferenceDbu", testCase.referenceDbu);
                    row->setProperty("inputScaleForEquivalentPhysicalLevel", inputScale);
                    if (inputScale != 1.0f)
                    {
                        juce::MemoryBlock inputBytes;
                        for (int channel = 0; channel < input.getNumChannels(); ++channel)
                            inputBytes.append(input.getReadPointer(channel),
                                static_cast<size_t>(input.getNumSamples()) * sizeof(float));
                        row->setProperty("scaledInputSha256", juce::SHA256(inputBytes).toHexString());
                    }
                    row->setProperty("direct", static_cast<double>(rack->octaverDirectMix.load()));
                    row->setProperty("down", static_cast<double>(rack->octaverDownMix.load()));
                    row->setProperty("up", static_cast<double>(rack->octaverUpMix.load()));
                    // The native state is the complete reproducible control/resource
                    // contract, rather than a hand-maintained subset of rack knobs.
                    juce::MemoryBlock state; rack->getStateInformation(state);
                    const auto stateTree = juce::ValueTree::readFromData(state.getData(), state.getSize());
                    row->setProperty("rackState", stateTree.createXml()->toString());
                    row->setProperty("route", "Production Octave -> Fuzz -> PRE EQ bypass -> Drive -> Distortion -> NAM amp -> cabinet IR; stage power/modes and optional Global/Drive/Distortion gates are recorded in each row. Compressor, captured pedal, post EQ, room/doubler and time effects bypassed.");
                    row->setProperty("outputProcessing", "Exact native IEEE float32; no export normalization, gain matching or added limiter. Production rack safety processing remains active.");
                    bool finiteSamples = true;
                    const auto metrics = measure(output, input, finiteSamples);
                    row->setProperty("metrics", metrics);
                    const auto diagnostics = rack->getDiagnosticState();
                    const auto diagnosticCount = [&diagnostics] (const char* id)
                    {
                        return static_cast<juce::int64>(diagnostics.getProperty(
                            juce::Identifier(id), static_cast<juce::int64>(-1)));
                    };
                    auto* integrity = new juce::DynamicObject();
                    const bool resourcesReadback = rack->hasAmpModel() && rack->hasCabIR()
                        && juce::File(rack->getAmpModelPath()) == amp
                        && juce::File(rack->getCabIRPath()) == cab
                        && !rack->ampModelIncludesCab() && rack->isCabRequestedEnabled()
                        && rack->cabEnabled.load() >= 0.5f;
                    const int expectedBlocks = (output.getNumSamples() + 511) / 512;
                    const auto finalAmpDspFrames = diagnosticCount("lastAmpDspFrames");
                    // A valid tiny final callback can produce no model-rate
                    // frames. The first prepared callback is a second activity
                    // witness; final cumulative fault counters still own safety.
                    const bool ampExecuted = firstAmpDspFrames > 0 || finalAmpDspFrames > 0;
                    // Published by the live Rack only when Cab was active with
                    // an IR snapshot. Together with the prepared capacity and
                    // exact resource readback, this excludes a loaded-but-bypassed
                    // cabinet from establishing full-chain coverage.
                    const bool cabActive = static_cast<bool>(diagnostics.getProperty("cabRoomInputSourceAvailable", false));
                    const bool processedExpectedBlocks = diagnosticCount("processedBlockCount") == expectedBlocks
                        && diagnosticCount("bufferCapacity") >= juce::jmin(512, output.getNumSamples());
                    const bool nonzeroOutput = static_cast<double>(metrics.getProperty("samplePeak", 0.0)) > 0.0;
                    const bool requiresNonzeroOutput = testCase.gateMask == 0;
                    bool noFallback = !static_cast<bool>(diagnostics.getProperty("realtimeDSPBlocked", true))
                        && !static_cast<bool>(diagnostics.getProperty("ampModelFaulted", true))
                        && !static_cast<bool>(diagnostics.getProperty("rackOutputEmergencyMuteActive", true));
                    for (const char* id : { "modelProcessFailCount", "audioThreadResizeAvoidedCount",
                         "oversizeBypassCount", "realtimeSafetyBypassCount", "modelSnapshotLockMissCount",
                         "rackOutputEmergencyMuteTripCount", "inputNonFiniteSampleCount", "ampToneFilterRecoveryCount" })
                    {
                        const auto count = diagnosticCount(id);
                        integrity->setProperty(id, count);
                        noFallback = noFallback && count == 0;
                    }
                    const auto guardHits = diagnosticCount("rackOutputSafetyGuardHitCount");
                    if (guardHits >= 0) ordinaryOutputGuardHits += guardHits;
                    integrity->setProperty("rackOutputSafetyGuardHitCount", guardHits);
                    integrity->setProperty("ordinaryGuardInterpretation", "diagnostic_only: production output-guard activity is retained, not normalized away and not an audible clipping/tone gate.");
                    integrity->setProperty("resourcesReadbackPassed", resourcesReadback);
                    integrity->setProperty("ampExecuted", ampExecuted);
                    integrity->setProperty("externalCabActive", cabActive);
                    integrity->setProperty("firstAmpDspFrames", firstAmpDspFrames);
                    integrity->setProperty("finalAmpDspFrames", finalAmpDspFrames);
                    integrity->setProperty("processedBlockCount", diagnosticCount("processedBlockCount"));
                    integrity->setProperty("expectedBlockCount", expectedBlocks);
                    integrity->setProperty("bufferCapacity", diagnosticCount("bufferCapacity"));
                    integrity->setProperty("activeInputRoutingMode", diagnosticCount("activeInputRoutingMode"));
                    integrity->setProperty("finiteOutput", finiteSamples);
                    integrity->setProperty("nonzeroOutput", nonzeroOutput);
                    integrity->setProperty("requiresNonzeroOutput", requiresNonzeroOutput);
                    if (!requiresNonzeroOutput)
                        integrity->setProperty("zeroOutputInterpretation", "Explicit gate contexts may legitimately close on a quiet supplied DI. Signal activity is diagnostic; loaded-resource execution, complete block processing, finite output and no fallback remain required.");
                    integrity->setProperty("processedExpectedBlocks", processedExpectedBlocks);
                    for (const char* id : { "realtimeDSPBlocked", "ampModelFaulted", "rackOutputEmergencyMuteActive" })
                        integrity->setProperty(id, static_cast<bool>(diagnostics.getProperty(juce::Identifier(id), true)));
                    integrity->setProperty("noSafetyFallback", noFallback);
                    const bool casePassed = finiteSamples && (!requiresNonzeroOutput || nonzeroOutput) && resourcesReadback
                        && ampExecuted && cabActive && processedExpectedBlocks && noFallback && guardHits >= 0;
                    integrity->setProperty("passed", casePassed);
                    row->setProperty("integrity", juce::var(integrity));
                    fullChainPassed = fullChainPassed && casePassed;
                    structuralPassed = structuralPassed && casePassed;
                    row->setProperty("audioQuality", "not_asserted"); entries.add(juce::var(row));
                    rack->releaseResources();
                }
            }
        }
        const int expectedCount = static_cast<int>(sources.size()) * (extended ? 177 : 32);
        fullChainPassed = fullChainPassed && entries.size() == expectedCount
            && writtenNames.size() == expectedCount;
        structuralPassed = structuralPassed && fullChainPassed;
        add(checks, "nam_fuzz_full_chain_matrix", fullChainPassed && writesPassed ? "pass" : "fail",
            extended
                ? "Extended: 64 discrete Octave/Fuzz voice/Drive/Distortion mode topologies at two control sets, plus 49 conservative Clean/gate/calibration/octave-presence probes per material. Exact resource readback, NAM execution, active Cab, complete block count, finite output, unique file writes and no fallback are asserted. Nonzero output is required except in explicit gate contexts, which may legitimately close. Supplemental controls are bounded interaction coverage, not every continuous combination. Ordinary guard hits are diagnostic; tone and hardware realtime performance remain not_asserted."
                : "Eight production Fuzz/Drive/Distortion combinations cover conservative/stress controls and every active Fuzz voice through the explicit NAM amp/cab. Exact resource readback, real NAM frames, active external cabinet, complete block processing, finite nonzero output, file writes and no model/oversize/snapshot/emergency-mute fallback are asserted. Ordinary guard hits are diagnostic; tone and physical-device realtime performance remain not_asserted.", entries.size());
        add(checks, "nam_fuzz_full_chain_output_guard", "diagnostic_only",
            "Cumulative ordinary production output-guard hits across the full-chain cases; raw native levels are retained. This count is not a clipping-audibility or tone-quality gate.", ordinaryOutputGuardHits);
        return juce::var(entries);
    }
};
