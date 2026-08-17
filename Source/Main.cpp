#include <JuceHeader.h>
#include "ApplicationLaunchState.h"
#include "AudioEngine.h"
#include "AppUpdater.h"
#include "CLAPPluginFormat.h"
#include "MainComponent.h"
#include "MixerWindowManager.h"
#include "PluginManager.h"

#include "NAM/container.h"
#include "NAM/convnet.h"
#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#include "NAM/lstm.h"
#include "NAM/model_config.h"
#include "NAM/wavenet/model.h"

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

#if JUCE_WINDOWS
 #include <dwmapi.h>
#endif

namespace
{
bool commandLineHasFlag(const juce::String& commandLine, const juce::String& flag)
{
    juce::StringArray tokens;
    tokens.addTokens(commandLine, " ", "\"");
    for (const auto& token : tokens)
    {
        if (token.trim().unquoted() == flag)
            return true;
    }

    return false;
}

juce::String getCommandLineOptionValue(const juce::String& commandLine, const juce::String& option)
{
    juce::StringArray tokens;
    tokens.addTokens(commandLine, " ", "\"");
    tokens.trim();
    tokens.removeEmptyStrings();

    for (int i = 0; i < tokens.size(); ++i)
    {
        const auto token = tokens[i].trim().unquoted();
        if (token == option)
            return i + 1 < tokens.size() ? tokens[i + 1].trim().unquoted() : juce::String();

        const auto equalsPrefix = option + "=";
        if (token.startsWith(equalsPrefix))
            return token.fromFirstOccurrenceOf(equalsPrefix, false, false).trim().unquoted();
    }

    return {};
}

juce::File getWritableStartupLogFile()
{
    auto logDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                    .getChildFile("OpenStudio")
                    .getChildFile("logs");

    if (logDir.createDirectory())
        return logDir.getChildFile("OpenStudio_Startup.log");

    return juce::File::getSpecialLocation(juce::File::SpecialLocationType::currentApplicationFile)
        .getSiblingFile("OpenStudio_Debug.log");
}

juce::StringArray readPluginScanSearchPathsFile(const juce::File& pathsFile)
{
    const auto xml = juce::parseXML(pathsFile);
    if (xml == nullptr)
        return {};

    juce::StringArray paths;
    for (const auto* child : xml->getChildIterator())
        if (child != nullptr && child->hasTagName("PATH"))
            paths.add(child->getStringAttribute("value"));
    paths.trim();
    paths.removeEmptyStrings();
    return paths;
}

int runHeadlessPluginScanProbe(const juce::String& formatName,
                               const juce::String& pluginIdentifier,
                               const juce::StringArray& searchPaths,
                               const juce::File& reportFile)
{
    juce::AudioPluginFormatManager formats;
    formats.addDefaultFormats();
    formats.addFormat(new CLAPPluginFormat());

    auto result = std::make_unique<juce::XmlElement>("PLUGIN_SCAN_RESULT");
    result->setAttribute("format", formatName);
    result->setAttribute("file", pluginIdentifier);

    juce::AudioPluginFormat* selectedFormat = nullptr;
    for (int index = 0; index < formats.getNumFormats(); ++index)
    {
        auto* candidate = formats.getFormat(index);
        if (candidate != nullptr && candidate->getName().equalsIgnoreCase(formatName))
        {
            selectedFormat = candidate;
            break;
        }
    }

    if (selectedFormat == nullptr)
    {
        result->setAttribute("status", "unsupported-format");
        result->setAttribute("error", "The requested plug-in format is not enabled in this build.");
    }
    else
    {
        const bool requiresDiscoveryPriming =
            formatName.containsIgnoreCase("LV2")
            || !juce::File::isAbsolutePath(pluginIdentifier);
        if (requiresDiscoveryPriming && !searchPaths.isEmpty())
        {
            juce::FileSearchPath discoveryPaths;
            for (const auto& path : searchPaths)
                discoveryPaths.add(juce::File(path));

            // LV2 candidates are URIs backed by a bundle map populated during
            // directory enumeration. Rebuild that map in this isolated process
            // before asking the format to resolve the URI. Filesystem-backed
            // VST3 and CLAP candidates must skip this work: rescanning every
            // root once per candidate would turn discovery into O(N^2).
            selectedFormat->searchPathsForPlugins(discoveryPaths, true, false);
        }

        if (!selectedFormat->fileMightContainThisPluginType(pluginIdentifier))
        {
            result->setAttribute("status", "not-a-plugin");
            result->setAttribute("error", "The selected format rejected this candidate before loading it.");
        }
        else
        {
            juce::OwnedArray<juce::PluginDescription> descriptions;
            selectedFormat->findAllTypesForFile(descriptions, pluginIdentifier);
            for (const auto* description : descriptions)
                if (description != nullptr)
                    result->addChildElement(description->createXml().release());

            result->setAttribute("status", descriptions.isEmpty() ? "no-types" : "ok");
            result->setAttribute("pluginCount", descriptions.size());
            if (descriptions.isEmpty())
                result->setAttribute("error", "The module loaded no compatible plug-in types.");
        }
    }

    reportFile.getParentDirectory().createDirectory();
    const bool wroteReport = result->writeTo(reportFile);
    const bool succeeded = wroteReport && result->getStringAttribute("status") == "ok";
    juce::Logger::writeToLog("[pluginScan.probe] format=" + formatName
        + " file=" + pluginIdentifier
        + " status=" + result->getStringAttribute("status")
        + " report=" + reportFile.getFullPathName());
    return succeeded ? 0 : 2;
}

int runHeadlessPluginScanRegression(const juce::File& reportFile)
{
    PluginManager pluginManager;
    const auto result = pluginManager.scanForPlugins(true);
    reportFile.getParentDirectory().createDirectory();
    const bool wroteReport = reportFile.replaceWithText(juce::JSON::toString(result, true));
    const bool succeeded = result.isObject()
        && static_cast<bool>(result.getProperty("success", false))
        && static_cast<bool>(result.getProperty("forceRescan", false))
        && static_cast<int>(result.getProperty("failedCount", 0)) == 0;
    juce::Logger::writeToLog("[pluginScan.headless] report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " success=" + juce::String(succeeded ? "true" : "false"));
    return wroteReport && succeeded ? 0 : 2;
}

juce::Rectangle<int> rectangleFromVar(const juce::var& value)
{
    if (auto* obj = value.getDynamicObject())
    {
        return {
            static_cast<int>(obj->getProperty("x")),
            static_cast<int>(obj->getProperty("y")),
            static_cast<int>(obj->getProperty("width")),
            static_cast<int>(obj->getProperty("height"))
        };
    }

    return {};
}

juce::var rectangleToVar(const juce::Rectangle<int>& bounds)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("x", bounds.getX());
    obj->setProperty("y", bounds.getY());
    obj->setProperty("width", bounds.getWidth());
    obj->setProperty("height", bounds.getHeight());
    return juce::var(obj);
}

bool isFiniteNumericVar(const juce::var& value)
{
    if (! (value.isDouble() || value.isInt() || value.isInt64()))
        return false;

    return std::isfinite(static_cast<double>(value));
}

double getNumericProperty(const juce::var& object, const juce::Identifier& propertyName, double fallback)
{
    const auto value = object.getProperty(propertyName, juce::var());
    return isFiniteNumericVar(value) ? static_cast<double>(value) : fallback;
}

void addHarnessCheck(juce::Array<juce::var>& checks,
                     const juce::String& id,
                     const juce::String& status,
                     const juce::String& detail,
                     const juce::var& value = juce::var())
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", id);
    obj->setProperty("status", status);
    obj->setProperty("detail", detail);
    if (! value.isVoid())
        obj->setProperty("value", value);
    checks.add(juce::var(obj));
}

void setProcessEnvironmentVariable(const juce::String& name, const juce::String& value)
{
   #if JUCE_WINDOWS
    _putenv_s(name.toRawUTF8(), value.toRawUTF8());
   #else
    setenv(name.toRawUTF8(), value.toRawUTF8(), 1);
   #endif
}

bool hasFailedHarnessCheck(const juce::Array<juce::var>& checks)
{
    for (const auto& check : checks)
        if (check.getProperty("status", {}).toString() == "fail")
            return true;

    return false;
}

bool writeHeadlessResult(const juce::File& resultFile, const juce::var& result)
{
    if (resultFile == juce::File())
        return false;

    resultFile.getParentDirectory().createDirectory();
    return resultFile.replaceWithText(juce::JSON::toString(result, true));
}

void ensureNAMProbeParsersRegistered()
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

float namProbeInputSample(int absoluteSample, double sampleRate)
{
    const double t = static_cast<double>(absoluteSample) / juce::jmax(1.0, sampleRate);
    const double phrase = std::fmod(t, 0.78);
    const double envelope = phrase < 0.006 ? phrase / 0.006 : std::exp(-phrase / 0.21);
    const double f0 = phrase < 0.26 ? 110.0 : (phrase < 0.52 ? 146.832 : 195.998);
    const double harmonic = std::sin(juce::MathConstants<double>::twoPi * f0 * t)
        + 0.35 * std::sin(juce::MathConstants<double>::twoPi * f0 * 2.01 * t + 0.2)
        + 0.16 * std::sin(juce::MathConstants<double>::twoPi * f0 * 3.02 * t + 0.6);
    return static_cast<float>(harmonic * envelope * 0.075);
}

int runHeadlessNAMModelProbe(const juce::File& modelFile,
                             const juce::File& reportFile,
                             bool audioEngineConstructed)
{
    juce::Array<juce::var> checks;
    auto* root = new juce::DynamicObject();
    root->setProperty("harnessMode", "nam_model_probe");
    root->setProperty("claimLevel", "objective_only");
    root->setProperty("subjectiveQuality", "not_asserted");
    root->setProperty("modelPath", modelFile.getFullPathName());

    auto finish = [&] (bool pass, const juce::String& error = {})
    {
        root->setProperty("objectiveGateStatus", pass ? "pass" : "fail");
        root->setProperty("success", pass);
        if (error.isNotEmpty())
            root->setProperty("error", error);
        root->setProperty("checks", juce::var(checks));
        const bool wrote = writeHeadlessResult(reportFile, juce::var(root));
        juce::Logger::writeToLog("[namModelProbe.headless] report=" + reportFile.getFullPathName()
            + " wroteReport=" + juce::String(wrote ? "true" : "false")
            + " objectiveGateStatus=" + juce::String(pass ? "pass" : "fail")
            + (error.isNotEmpty() ? " error=" + error : juce::String()));
        return wrote && pass ? 0 : 2;
    };

    const bool audioEngineIsolated =
        ! audioEngineConstructed;
    addHarnessCheck(
        checks,
        "audio_engine_not_constructed",
        audioEngineIsolated ? "pass" : "fail",
        "The NAM safety-probe child must not construct an AudioEngine or open an audio device.",
        audioEngineConstructed);

    bool backgroundPriority = true;
   #if JUCE_WINDOWS
    const auto priorityClass =
        ::GetPriorityClass(::GetCurrentProcess());
    backgroundPriority =
        priorityClass != HIGH_PRIORITY_CLASS
        && priorityClass != REALTIME_PRIORITY_CLASS;
    root->setProperty(
        "windowsPriorityClass",
        static_cast<juce::int64>(
            priorityClass));
   #endif
    addHarnessCheck(
        checks,
        "background_process_priority",
        backgroundPriority ? "pass" : "fail",
        "The NAM safety-probe child must not compete with the live audio process at high or realtime priority.");

    if (! audioEngineIsolated
        || ! backgroundPriority)
    {
        return finish(
            false,
            "NAM model safety probe was not isolated from the live audio process.");
    }

    if (! modelFile.existsAsFile())
    {
        addHarnessCheck(checks, "model_file_exists", "fail", "NAM model file must exist before loading.", modelFile.getFullPathName());
        return finish(false, "NAM model file does not exist.");
    }
    addHarnessCheck(checks, "model_file_exists", "pass", "NAM model file exists.", modelFile.getFullPathName());

    const auto parsed = juce::JSON::parse(modelFile.loadFileAsString());
    if (! parsed.isObject()
        || ! parsed.hasProperty("version")
        || ! parsed.hasProperty("architecture")
        || ! parsed.hasProperty("config")
        || ! parsed.getProperty("weights", {}).isArray())
    {
        addHarnessCheck(checks, "nam_json_shape", "fail", "NAM file must contain version, architecture, config, and weights.", {});
        return finish(false, "Invalid NAM model file shape.");
    }

    const auto architecture = parsed.getProperty("architecture", {}).toString();
    root->setProperty("architecture", architecture);
    root->setProperty("version", parsed.getProperty("version", {}).toString());
    root->setProperty("sampleRate", parsed.getProperty("sample_rate", {}));
    addHarnessCheck(checks, "nam_json_shape", "pass", "NAM JSON shape looks loadable.", architecture);

    try
    {
        ensureNAMProbeParsersRegistered();
        auto dsp = nam::get_dsp(std::filesystem::path(modelFile.getFullPathName().toStdString()));
        if (dsp == nullptr)
        {
            addHarnessCheck(checks, "core_get_dsp", "fail", "NeuralAmpModelerCore returned no DSP instance.", {});
            return finish(false, "NeuralAmpModelerCore returned no DSP instance.");
        }

        const int inChannels = juce::jmax(1, dsp->NumInputChannels());
        const int outChannels = juce::jmax(1, dsp->NumOutputChannels());
        const double sampleRate = dsp->GetExpectedSampleRate() > 1000.0 ? dsp->GetExpectedSampleRate() : 48000.0;
        constexpr int blockSize = 512;
        constexpr int blockCount = 10;
        dsp->ResetAndPrewarm(sampleRate, blockSize);

        std::vector<std::vector<NAM_SAMPLE>> inputBuffers(static_cast<size_t>(inChannels));
        std::vector<std::vector<NAM_SAMPLE>> outputBuffers(static_cast<size_t>(outChannels));
        std::vector<NAM_SAMPLE*> inputPtrs(static_cast<size_t>(inChannels));
        std::vector<NAM_SAMPLE*> outputPtrs(static_cast<size_t>(outChannels));
        for (int ch = 0; ch < inChannels; ++ch)
        {
            inputBuffers[static_cast<size_t>(ch)].assign(blockSize, static_cast<NAM_SAMPLE>(0));
            inputPtrs[static_cast<size_t>(ch)] = inputBuffers[static_cast<size_t>(ch)].data();
        }
        for (int ch = 0; ch < outChannels; ++ch)
        {
            outputBuffers[static_cast<size_t>(ch)].assign(blockSize, static_cast<NAM_SAMPLE>(0));
            outputPtrs[static_cast<size_t>(ch)] = outputBuffers[static_cast<size_t>(ch)].data();
        }

        int nonFinite = 0;
        float peak = 0.0f;
        double rmsAccum = 0.0;
        int rmsCount = 0;
        for (int block = 0; block < blockCount; ++block)
        {
            for (int sample = 0; sample < blockSize; ++sample)
            {
                const auto value = namProbeInputSample(block * blockSize + sample, sampleRate);
                for (int ch = 0; ch < inChannels; ++ch)
                    inputBuffers[static_cast<size_t>(ch)][static_cast<size_t>(sample)] = static_cast<NAM_SAMPLE>(value);
            }

            dsp->process(inputPtrs.data(), outputPtrs.data(), blockSize);

            for (int ch = 0; ch < outChannels; ++ch)
            {
                const auto& output = outputBuffers[static_cast<size_t>(ch)];
                for (int sample = 0; sample < blockSize; ++sample)
                {
                    const float value = static_cast<float>(output[static_cast<size_t>(sample)]);
                    if (! std::isfinite(value))
                        ++nonFinite;
                    peak = juce::jmax(peak, std::abs(value));
                    rmsAccum += static_cast<double>(value) * static_cast<double>(value);
                    ++rmsCount;
                }
            }
        }

        const double rms = rmsCount > 0 ? std::sqrt(rmsAccum / static_cast<double>(rmsCount)) : 0.0;
        root->setProperty("expectedSampleRate", sampleRate);
        root->setProperty("inputChannels", inChannels);
        root->setProperty("outputChannels", outChannels);
        root->setProperty("peak", peak);
        root->setProperty("rms", rms);
        root->setProperty("nonFiniteCount", nonFinite);

        const bool pass = nonFinite == 0 && peak < 32.0f;
        addHarnessCheck(checks,
                        "core_load_and_process",
                        pass ? "pass" : "fail",
                        "NAM Core should load the model and process a short finite probe without exploding.",
                        "peak=" + juce::String(peak, 6) + " rms=" + juce::String(rms, 6));
        return finish(pass, pass ? juce::String() : juce::String("NAM model produced invalid probe output."));
    }
    catch (const std::exception& ex)
    {
        const auto error = juce::String("NAM Core rejected model: ") + ex.what();
        addHarnessCheck(checks, "core_load_and_process", "fail", "NAM Core threw while probing the model.", error);
        return finish(false, error);
    }
    catch (...)
    {
        const auto error = juce::String("NAM Core rejected model: unknown exception");
        addHarnessCheck(checks, "core_load_and_process", "fail", "NAM Core threw while probing the model.", error);
        return finish(false, error);
    }
}

int runHeadlessPitchRegressionJob(AudioEngine& audioEngine, const juce::String& jobPath)
{
    setProcessEnvironmentVariable("OPENSTUDIO_PITCH_HEADLESS", "1");
    setProcessEnvironmentVariable("OPENSTUDIO_PITCH_APP_FINAL_CAPTURE_DISABLE", "1");

    const juce::File jobFile(jobPath.trim().unquoted());
    juce::File resultFile;
    juce::Array<juce::var> checks;

    auto makeBaseResult = [&]() {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("harnessMode", "headless_lightweight");
        obj->setProperty("claimLevel", "objective_only");
        obj->setProperty("subjectiveQuality", "not_asserted");
        obj->setProperty("completionClaim", "objective gates may pass; subjective audio quality is not asserted; user audition required");
        obj->setProperty("jobPath", jobFile.getFullPathName());
        obj->setProperty("capturedAt", juce::Time::getCurrentTime().toISO8601(true));
        return juce::DynamicObject::Ptr(obj);
    };

    auto fail = [&](const juce::String& message) {
        addHarnessCheck(checks, "headless_job", "fail", message);
        auto resultObj = makeBaseResult();
        resultObj->setProperty("success", false);
        resultObj->setProperty("objectiveGateStatus", "fail");
        resultObj->setProperty("error", message);
        resultObj->setProperty("checks", juce::var(checks));
        if (resultFile != juce::File())
            writeHeadlessResult(resultFile, juce::var(resultObj.get()));
        juce::Logger::writeToLog("[pitchRegression.headless] " + message);
        return 2;
    };

    if (! jobFile.existsAsFile())
        return fail("Headless pitch regression job file not found: " + jobFile.getFullPathName());

    auto job = juce::JSON::parse(jobFile);
    if (! job.isObject())
        return fail("Headless pitch regression job JSON could not be parsed: " + jobFile.getFullPathName());

    const auto resultPath = job.getProperty("resultJsonPath", {}).toString().trim().unquoted();
    if (resultPath.isNotEmpty())
        resultFile = juce::File(resultPath);

    const auto jobType = job.getProperty("jobType", "render").toString();
    if (jobType != "render")
        return fail("Headless lightweight harness only supports jobType='render'; got '" + jobType + "'");

    const auto sourceAudioPath = job.getProperty("sourceAudioPath", {}).toString().trim().unquoted();
    const auto trackId = job.getProperty("trackId", "pitch-regression-track-1").toString();
    const auto clipId = job.getProperty("clipId", "pitch-regression-clip-1").toString();
    const auto renderMode = job.getProperty("renderMode", "note_hq").toString();
    if (sourceAudioPath.isEmpty())
        return fail("Headless job is missing sourceAudioPath");
    if (trackId.isEmpty() || clipId.isEmpty())
        return fail("Headless job is missing trackId or clipId");

    const juce::File sourceFile(sourceAudioPath);
    if (! sourceFile.existsAsFile())
        return fail("Source audio file not found: " + sourceFile.getFullPathName());

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> sourceReader(formatManager.createReaderFor(sourceFile));
    if (sourceReader == nullptr || sourceReader->sampleRate <= 0.0 || sourceReader->lengthInSamples <= 0)
        return fail("Could not read source audio metadata: " + sourceFile.getFullPathName());

    const double sourceDurationSec = static_cast<double>(sourceReader->lengthInSamples) / sourceReader->sampleRate;
    const int sourceChannels = static_cast<int>(sourceReader->numChannels);
    sourceReader.reset();

    auto notes = juce::JSON::parse(juce::JSON::toString(job.getProperty("notes", juce::var()), false));
    auto* noteArray = notes.getArray();
    if (noteArray == nullptr && notes.isObject())
    {
        juce::Array<juce::var> wrappedNotes;
        wrappedNotes.add(notes);
        notes = juce::var(wrappedNotes);
        noteArray = notes.getArray();
    }
    if (noteArray == nullptr || noteArray->isEmpty())
        return fail("Headless render job requires a non-empty notes array");

    const auto targetShiftVar = job.getProperty("targetShiftSemitones", juce::var());
    const bool hasTargetShift = isFiniteNumericVar(targetShiftVar);
    double actualRequestedShift = 0.0;
    double maxShiftErrorSemitones = 0.0;
    if (hasTargetShift)
    {
        const double targetShift = static_cast<double>(targetShiftVar);
        for (auto& note : *noteArray)
        {
            auto* noteObj = note.getDynamicObject();
            if (noteObj == nullptr)
                return fail("Each note must be a JSON object");

            const auto detectedPitchVar = note.getProperty("detectedPitch", juce::var());
            if (! isFiniteNumericVar(detectedPitchVar))
                return fail("Cannot apply targetShiftSemitones because a note is missing numeric detectedPitch");

            const double detectedPitch = static_cast<double>(detectedPitchVar);
            const double correctedPitch = detectedPitch + targetShift;
            noteObj->setProperty("detectedPitch", detectedPitch);
            noteObj->setProperty("correctedPitch", correctedPitch);
            actualRequestedShift += correctedPitch - detectedPitch;
            maxShiftErrorSemitones = juce::jmax(maxShiftErrorSemitones,
                                                std::abs((correctedPitch - detectedPitch) - targetShift));
        }

        actualRequestedShift /= static_cast<double>(noteArray->size());
        const double maxErrorCents = maxShiftErrorSemitones * 100.0;
        addHarnessCheck(checks,
                        "exact_relative_pitch_shift",
                        maxErrorCents <= 1.0 ? "pass" : "fail",
                        "Requested shift is computed as detectedPitch + targetShiftSemitones, without chromatic snapping.",
                        maxErrorCents);
    }
    else
    {
        addHarnessCheck(checks,
                        "exact_relative_pitch_shift",
                        "not_asserted",
                        "Job did not provide targetShiftSemitones; exact relative pitch shift cannot be asserted.");
    }

    audioEngine.addTrack(trackId);
    audioEngine.setMasterVolume(1.0f);
    audioEngine.setMasterPan(0.0f);
    audioEngine.setTrackVolume(trackId, 0.0f);
    audioEngine.setTrackPan(trackId, 0.0f);
    audioEngine.clearPlaybackClips();
    audioEngine.addPlaybackClip(trackId, sourceFile.getFullPathName(), 0.0, sourceDurationSec, 0.0, 0.0, 0.0, 0.0, clipId);

    std::optional<double> windowStartSec;
    std::optional<double> windowEndSec;
    const auto windowStartVar = job.getProperty("windowStartSec", juce::var());
    const auto windowEndVar = job.getProperty("windowEndSec", juce::var());
    if (isFiniteNumericVar(windowStartVar) && isFiniteNumericVar(windowEndVar))
    {
        windowStartSec = static_cast<double>(windowStartVar);
        windowEndSec = static_cast<double>(windowEndVar);
    }

    const auto frames = job.getProperty("frames", juce::var());
    const float globalFormantSemitones = static_cast<float>(
        getNumericProperty(job, "globalFormantSemitones", 0.0));

    juce::Logger::writeToLog("[pitchRegression.headless] Running render job clip=" + clipId
        + " renderMode=" + renderMode
        + " source=" + sourceFile.getFullPathName());

    auto nativeResult = audioEngine.applyPitchCorrection(trackId,
                                                         clipId,
                                                         notes,
                                                         frames,
                                                         globalFormantSemitones,
                                                         windowStartSec,
                                                         windowEndSec,
                                                         renderMode);

    const bool nativeSuccess = nativeResult.isObject()
        && static_cast<bool>(nativeResult.getProperty("success", false));
    if (! nativeSuccess)
        addHarnessCheck(checks, "native_render_success", "fail", "AudioEngine::applyPitchCorrection did not return success.");
    else
        addHarnessCheck(checks, "native_render_success", "pass", "AudioEngine::applyPitchCorrection returned success.");

    const auto outputPath = nativeResult.getProperty("outputFile", {}).toString();
    const juce::File outputFile(outputPath);
    const bool outputExists = outputPath.isNotEmpty() && outputFile.existsAsFile();
    addHarnessCheck(checks,
                    "output_file_exists",
                    outputExists ? "pass" : "fail",
                    outputExists ? "Corrected output file exists." : "Corrected output file is missing.",
                    outputPath);

    if (outputExists)
    {
        std::unique_ptr<juce::AudioFormatReader> outputReader(formatManager.createReaderFor(outputFile));
        if (outputReader != nullptr && outputReader->sampleRate > 0.0)
        {
            const double outputDurationSec = static_cast<double>(outputReader->lengthInSamples) / outputReader->sampleRate;
            const double durationDeltaMs = std::abs(outputDurationSec - sourceDurationSec) * 1000.0;
            addHarnessCheck(checks,
                            "output_duration_sane",
                            durationDeltaMs <= 5.0 ? "pass" : "fail",
                            "Corrected full-clip output duration should match source duration within 5 ms.",
                            durationDeltaMs);
            addHarnessCheck(checks,
                            "output_channels_sane",
                            static_cast<int>(outputReader->numChannels) == sourceChannels ? "pass" : "fail",
                            "Corrected output channel count should match source channel count.",
                            static_cast<int>(outputReader->numChannels));
        }
        else
        {
            addHarnessCheck(checks, "output_duration_sane", "fail", "Corrected output file could not be read.");
            addHarnessCheck(checks, "output_channels_sane", "fail", "Corrected output file could not be read.");
        }
    }

    const auto actualRendererBranch = nativeResult.getProperty("actualRendererBranch", {}).toString();
    addHarnessCheck(checks,
                    "renderer_branch_recorded",
                    actualRendererBranch.isNotEmpty() ? "pass" : "fail",
                    actualRendererBranch.isNotEmpty() ? "Renderer branch was reported." : "Renderer branch was not reported.",
                    actualRendererBranch);

    const auto formantCurveUsedVar = nativeResult.getProperty("formantCurveUsed", juce::var());
    const bool formantCurveRecorded = formantCurveUsedVar.isBool();
    const bool formantCurveUsed = formantCurveRecorded && static_cast<bool>(formantCurveUsedVar);
    addHarnessCheck(checks,
                    "pitch_only_formant_curve_disabled",
                    formantCurveRecorded && ! formantCurveUsed ? "pass" : "fail",
                    formantCurveRecorded
                        ? "Pitch-only render reported formantCurveUsed=false."
                        : "Pitch-only render did not report formantCurveUsed.",
                    formantCurveRecorded ? juce::var(formantCurveUsed) : juce::var());

    const auto routeStatus = nativeResult.getProperty("postApplyRouteStatus", juce::var());
    if (routeStatus.isObject())
    {
        const bool routeClean = routeStatus.getProperty("monitorMode", {}).toString() == "corrected_source"
            && ! static_cast<bool>(routeStatus.getProperty("renderedSegmentActive", false))
            && ! static_cast<bool>(routeStatus.getProperty("clipLivePreviewActive", false))
            && ! static_cast<bool>(routeStatus.getProperty("scrubPreviewActive", false));
        addHarnessCheck(checks,
                        "corrected_source_route_clean",
                        routeClean ? "pass" : "fail",
                        "After note-HQ render, corrected source should be active with preview/scrub/rendered-segment routes inactive.",
                        routeStatus);
    }
    else
    {
        addHarnessCheck(checks,
                        "corrected_source_route_clean",
                        "not_asserted",
                        "Native render did not report postApplyRouteStatus.");
    }

    addHarnessCheck(checks,
                    "subjective_audio_quality",
                    "not_asserted",
                    "Harness cannot assert naturalness, robotic tone, doubled voice, stutter feel, or target-sample closeness. User audition is required.");
    addHarnessCheck(checks,
                    "spectral_similarity",
                    "diagnostic_only",
                    "Mel/formant/spectrogram similarity is intentionally not a pass/fail gate in the lightweight harness.");

    const bool failed = hasFailedHarnessCheck(checks);
    auto resultObj = makeBaseResult();
    resultObj->setProperty("success", nativeSuccess && ! failed);
    resultObj->setProperty("objectiveGateStatus", failed ? "fail" : "pass");
    resultObj->setProperty("done", false);
    resultObj->setProperty("targetShiftSemitones", hasTargetShift ? targetShiftVar : juce::var());
    resultObj->setProperty("actualRequestedShiftSemitones", hasTargetShift ? juce::var(actualRequestedShift) : juce::var());
    resultObj->setProperty("requestedShiftErrorCents", hasTargetShift ? juce::var(maxShiftErrorSemitones * 100.0) : juce::var());
    resultObj->setProperty("chromaticSnapBypassed", hasTargetShift);
    resultObj->setProperty("outputFile", outputPath);
    resultObj->setProperty("actualRendererBranch", actualRendererBranch);
    resultObj->setProperty("formantCurveUsed", formantCurveRecorded ? juce::var(formantCurveUsed) : juce::var());
    const char* const vsfDiagnosticKeys[] = {
        "vocalSourceFilterResidualMix",
        "vocalSourceFilterResidualMixScale",
        "vocalSourceFilterEpochInterpolationUsed",
        "vocalSourceFilterEpochInterpolationStrength",
        "vocalSourceFilterGrainRadiusScale",
        "vocalSourceFilterUpPresenceTrimDb",
        "vocalSourceFilterUpPresenceHz",
        "vocalSourceFilterDownNasalTrimDb",
        "vocalSourceFilterDownNasalHz",
        "vocalSourceFilterDownBodyCompDb",
        "vocalSourceFilterDownBodyCompHz"
    };
    for (const auto* key : vsfDiagnosticKeys)
    {
        const auto value = nativeResult.getProperty(key, juce::var());
        if (! value.isVoid())
            resultObj->setProperty(key, value);
    }
    resultObj->setProperty("nativeResult", nativeResult);
    resultObj->setProperty("checks", juce::var(checks));

    if (resultFile != juce::File())
    {
        const auto routeReportFile = resultFile.getSiblingFile(
            resultFile.getFileNameWithoutExtension() + "_route.json");
        auto* routeObj = new juce::DynamicObject();
        routeObj->setProperty("purpose", "headless_pitch_route_report");
        routeObj->setProperty("harnessMode", "headless_lightweight");
        routeObj->setProperty("trackId", trackId);
        routeObj->setProperty("clipId", clipId);
        routeObj->setProperty("sourceAudioPath", sourceFile.getFullPathName());
        routeObj->setProperty("outputFile", outputPath);
        routeObj->setProperty("renderMode", renderMode);
        routeObj->setProperty("targetShiftSemitones", hasTargetShift ? targetShiftVar : juce::var());
        routeObj->setProperty("actualRequestedShiftSemitones", hasTargetShift ? juce::var(actualRequestedShift) : juce::var());
        routeObj->setProperty("requestedShiftErrorCents", hasTargetShift ? juce::var(maxShiftErrorSemitones * 100.0) : juce::var());
        routeObj->setProperty("chromaticSnapBypassed", hasTargetShift);
        routeObj->setProperty("actualRendererBranch", actualRendererBranch);
        routeObj->setProperty("formantCurveUsed", formantCurveRecorded ? juce::var(formantCurveUsed) : juce::var());
        for (const auto* key : vsfDiagnosticKeys)
        {
            const auto value = nativeResult.getProperty(key, juce::var());
            if (! value.isVoid())
                routeObj->setProperty(key, value);
        }
        routeObj->setProperty("postApplyRouteStatus", routeStatus);
        routeObj->setProperty("objectiveGateStatus", failed ? "fail" : "pass");
        routeObj->setProperty("subjectiveQuality", "not_asserted");
        routeObj->setProperty("checks", juce::var(checks));
        routeReportFile.replaceWithText(juce::JSON::toString(juce::var(routeObj), true));
        resultObj->setProperty("routeReportPath", routeReportFile.getFullPathName());
    }

    if (! writeHeadlessResult(resultFile, juce::var(resultObj.get())))
        return fail("Could not write headless result JSON: " + resultFile.getFullPathName());

    juce::Logger::writeToLog("[pitchRegression.headless] Wrote result to: " + resultFile.getFullPathName()
        + " objectiveGateStatus=" + juce::String(failed ? "fail" : "pass"));
    return failed ? 2 : 0;
}

int runHeadlessAutomatedRegressionSuite(AudioEngine& audioEngine, const juce::File& reportFile)
{
    auto result = audioEngine.runAutomatedRegressionSuite();
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool overallPass = result.isObject()
        && static_cast<bool>(result.getProperty("overallPass", false));

    juce::Logger::writeToLog("[automatedRegression.headless] report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " overallPass=" + juce::String(overallPass ? "true" : "false"));

    return wroteReport && overallPass ? 0 : 2;
}

int runHeadlessCleanGuitarRegression(AudioEngine& audioEngine, const juce::File& reportFile)
{
    auto result = audioEngine.runCleanGuitarPitchBendRegression();
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool pass = result.isObject()
        && result.getProperty("objectiveGateStatus", {}).toString() == "pass";

    juce::Logger::writeToLog("[cleanGuitarRegression.headless] report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " objectiveGateStatus=" + result.getProperty("objectiveGateStatus", {}).toString());

    return wroteReport && pass ? 0 : 2;
}

int runHeadlessNAMRackRegression(AudioEngine& audioEngine, const juce::File& reportFile)
{
    auto result = audioEngine.runNAMRackRegression();
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool pass = result.isObject()
        && result.getProperty("objectiveGateStatus", {}).toString() == "pass";

    juce::Logger::writeToLog("[namRackRegression.headless] report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " objectiveGateStatus=" + result.getProperty("objectiveGateStatus", {}).toString());

    return wroteReport && pass ? 0 : 2;
}

int runHeadlessNAMRackDIRegression(AudioEngine& audioEngine,
                                   const juce::File& inputFile,
                                   const juce::File& outputDirectory,
                                   const juce::File& reportFile,
                                   const juce::File& modelFile)
{
    auto result = audioEngine.runNAMRackDIRegression(inputFile, outputDirectory, modelFile);
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool pass = result.isObject()
        && result.getProperty("objectiveGateStatus", {}).toString() == "pass";

    juce::Logger::writeToLog("[namRackDIRegression.headless] input=" + inputFile.getFullPathName()
        + " outputDir=" + outputDirectory.getFullPathName()
        + " report=" + reportFile.getFullPathName()
        + " model=" + modelFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " objectiveGateStatus=" + result.getProperty("objectiveGateStatus", {}).toString());

    return wroteReport && pass ? 0 : 2;
}
}

//==============================================================================
class OpenStudioApplication  : public juce::JUCEApplication
{
public:
    OpenStudioApplication() = default;

    const juce::String getApplicationName() override       { return ProjectInfo::projectName; }
    const juce::String getApplicationVersion() override    { return ProjectInfo::versionString; }
    bool moreThanOneInstanceAllowed() override             { return true; }

    void initialise (const juce::String& commandLine) override
    {
        OpenStudioLaunchState::setPendingProjectPath(commandLine);
        const auto startupSelfTestMode = commandLineHasFlag(commandLine, "--startup-self-test");
        const auto automatedRegressionHeadlessMode = commandLineHasFlag(commandLine, "--automated-regression-headless");
        const auto startupSelfTestReportPath = getCommandLineOptionValue(commandLine, "--report");
        const auto pitchRegressionHeadlessJobPath = getCommandLineOptionValue(commandLine, "--pitch-regression-headless");
        const auto pitchRegressionJobPath = getCommandLineOptionValue(commandLine, "--pitch-regression");
        const auto cleanGuitarRegressionReportPath = getCommandLineOptionValue(commandLine, "--clean-guitar-regression-headless");
        const auto namRackRegressionReportPath = getCommandLineOptionValue(commandLine, "--nam-rack-regression-headless");
        const auto namRackDIRegressionInputPath = getCommandLineOptionValue(commandLine, "--nam-rack-di-regression-headless");
        const auto headlessOutputDirectoryPath = getCommandLineOptionValue(commandLine, "--output-dir");
        const auto namRackDIRegressionModelPath = getCommandLineOptionValue(commandLine, "--model-path");
        const auto namModelProbePath = getCommandLineOptionValue(commandLine, "--nam-model-probe-headless");
        const auto pluginScanProbePath = getCommandLineOptionValue(commandLine, "--plugin-scan-probe-headless");
        const auto pluginScanProbeFormat = getCommandLineOptionValue(commandLine, "--plugin-format");
        const auto pluginScanSearchPathsFile = getCommandLineOptionValue(commandLine, "--plugin-search-paths-file");
        const auto pluginScanRegressionHeadlessMode = commandLineHasFlag(commandLine, "--plugin-scan-regression-headless");
        const auto windowLifecycleHarnessMode = commandLineHasFlag(commandLine, "--window-lifecycle-harness");
        startupMode = commandLineHasFlag(commandLine, "--ui-safe-mode")
            ? MainComponent::StartupMode::safe
            : MainComponent::StartupMode::normal;

        auto logFile = pluginScanProbePath.isNotEmpty() && startupSelfTestReportPath.isNotEmpty()
            ? juce::File(startupSelfTestReportPath.trim().unquoted()).withFileExtension("log")
            : getWritableStartupLogFile();
        juce::Logger::setCurrentLogger(new juce::FileLogger(logFile, "OpenStudio Startup Log"));
        juce::Logger::writeToLog("Application Initialising...");
        juce::Logger::writeToLog("Startup log path: " + logFile.getFullPathName());
        juce::Logger::writeToLog("Startup mode: " + juce::String(startupMode == MainComponent::StartupMode::safe ? "safe" : "normal"));
        if (pitchRegressionJobPath.isNotEmpty())
        {
            juce::Logger::writeToLog("Pitch regression job path: " + pitchRegressionJobPath);
            juce::Logger::writeToLog("OPENSTUDIO_PITCH_DEBUG=" + juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_PITCH_DEBUG", "<unset>"));
        }
        if (pitchRegressionHeadlessJobPath.isNotEmpty())
        {
            juce::Logger::writeToLog("Pitch regression headless job path: " + pitchRegressionHeadlessJobPath);
            juce::Logger::writeToLog("OPENSTUDIO_PITCH_DEBUG=" + juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_PITCH_DEBUG", "<unset>"));
        }
        if (cleanGuitarRegressionReportPath.isNotEmpty())
        {
            juce::Logger::writeToLog("Clean guitar regression report path: " + cleanGuitarRegressionReportPath);
        }
        if (namRackRegressionReportPath.isNotEmpty())
        {
            juce::Logger::writeToLog("NAM rack regression report path: " + namRackRegressionReportPath);
        }
        if (namRackDIRegressionInputPath.isNotEmpty())
        {
            juce::Logger::writeToLog("NAM rack DI regression input path: " + namRackDIRegressionInputPath);
            if (headlessOutputDirectoryPath.isNotEmpty())
                juce::Logger::writeToLog("NAM rack DI regression output directory: " + headlessOutputDirectoryPath);
            if (startupSelfTestReportPath.isNotEmpty())
                juce::Logger::writeToLog("NAM rack DI regression report path: " + startupSelfTestReportPath);
            if (namRackDIRegressionModelPath.isNotEmpty())
                juce::Logger::writeToLog("NAM rack DI regression model path: " + namRackDIRegressionModelPath);
        }
        if (namModelProbePath.isNotEmpty())
        {
            juce::Logger::writeToLog("NAM model probe path: " + namModelProbePath);
            if (startupSelfTestReportPath.isNotEmpty())
                juce::Logger::writeToLog("NAM model probe report path: " + startupSelfTestReportPath);
        }
        if (pluginScanProbePath.isNotEmpty())
        {
            juce::Logger::writeToLog("Plugin scan probe path: " + pluginScanProbePath);
            juce::Logger::writeToLog("Plugin scan probe format: " + pluginScanProbeFormat);
        }
        if (pluginScanRegressionHeadlessMode)
            juce::Logger::writeToLog("Plugin scan headless regression enabled.");
        if (windowLifecycleHarnessMode)
        {
            const auto reportPath = startupSelfTestReportPath.isNotEmpty()
                ? startupSelfTestReportPath
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_WindowLifecycleHarness.json").getFullPathName();
            juce::Logger::writeToLog("Window lifecycle harness enabled. Report path: " + reportPath);
        }

        if (pluginScanRegressionHeadlessMode)
        {
           #if JUCE_WINDOWS
            ::SetPriorityClass(::GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
           #endif
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_PluginScanRegression.json");
            const auto exitCode = runHeadlessPluginScanRegression(reportFile);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        // Plug-in discovery runs in a disposable helper process. A malformed,
        // incompatible, or hanging third-party module must not take down the
        // live OpenStudio process.
        if (pluginScanProbePath.isNotEmpty())
        {
           #if JUCE_WINDOWS
            ::SetPriorityClass(::GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
           #endif
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_PluginScanProbe.xml");
            const auto exitCode = runHeadlessPluginScanProbe(
                pluginScanProbeFormat,
                pluginScanProbePath.trim().unquoted(),
                pluginScanSearchPathsFile.isNotEmpty()
                    ? readPluginScanSearchPathsFile(juce::File(pluginScanSearchPathsFile.trim().unquoted()))
                    : juce::StringArray(),
                reportFile);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        // The safety probe is spawned by a live, high-priority OpenStudio
        // process and therefore may inherit that priority class. Handle it
        // before constructing AudioEngine so it cannot open or contend for the
        // live ASIO device, and explicitly demote its model parse/prewarm work.
        if (namModelProbePath.isNotEmpty())
        {
           #if JUCE_WINDOWS
            ::SetPriorityClass(
                ::GetCurrentProcess(),
                BELOW_NORMAL_PRIORITY_CLASS);
           #endif
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_NAMModelProbe.json");
            const auto exitCode = runHeadlessNAMModelProbe(
                juce::File(namModelProbePath.trim().unquoted()),
                reportFile,
                audioEngine != nullptr);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        if (startupSelfTestMode)
        {
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath)
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_StartupSelfTest.txt");

            const auto success = MainComponent::writeStartupSelfTestReport(reportFile);
            juce::Logger::writeToLog("Startup self-test completed with result: " + juce::String(success ? "PASS" : "FAIL"));
            setApplicationReturnValue(success ? 0 : 1);
            quit();
            return;
        }

        // Keep ordinary UI, WebView, logging, and worker threads below the
        // callback's dedicated MMCSS "Pro Audio" priority. Raising the entire
        // process to HIGH also raises non-audio work and can starve interface
        // support/driver threads at very small buffers.
       #if JUCE_WINDOWS
        ::SetPriorityClass(
            ::GetCurrentProcess(),
            ABOVE_NORMAL_PRIORITY_CLASS);
       #endif
        audioEngine = std::make_unique<AudioEngine>();

        if (automatedRegressionHeadlessMode)
        {
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath)
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_AutomatedRegression.json");

            const auto exitCode = runHeadlessAutomatedRegressionSuite(*audioEngine, reportFile);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        if (pitchRegressionHeadlessJobPath.isNotEmpty())
        {
            const auto exitCode = runHeadlessPitchRegressionJob(*audioEngine, pitchRegressionHeadlessJobPath);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        if (cleanGuitarRegressionReportPath.isNotEmpty())
        {
            const auto exitCode = runHeadlessCleanGuitarRegression(*audioEngine, juce::File(cleanGuitarRegressionReportPath.trim().unquoted()));
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        if (namRackRegressionReportPath.isNotEmpty())
        {
            const auto exitCode = runHeadlessNAMRackRegression(*audioEngine, juce::File(namRackRegressionReportPath.trim().unquoted()));
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        if (namRackDIRegressionInputPath.isNotEmpty())
        {
            const auto outputDirectory = headlessOutputDirectoryPath.isNotEmpty()
                ? juce::File(headlessOutputDirectoryPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("nam_rack_di_regression");
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : outputDirectory.getChildFile("nam_rack_di_regression_result.json");
            const auto modelFile = namRackDIRegressionModelPath.isNotEmpty()
                ? juce::File(namRackDIRegressionModelPath.trim().unquoted())
                : juce::File();

            const auto exitCode = runHeadlessNAMRackDIRegression(*audioEngine,
                                                                 juce::File(namRackDIRegressionInputPath.trim().unquoted()),
                                                                 outputDirectory,
                                                                 reportFile,
                                                                 modelFile);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        mixerWindowManager = std::make_unique<MixerWindowManager>(
            [this]()
            {
                return std::make_unique<MainComponent>(*audioEngine,
                                                       appUpdater,
                                                       startupMode,
                                                       MainComponent::WindowRole::mixer,
                                                       createWindowCallbacks());
            },
            [this](const juce::Rectangle<int>& bounds)
            {
                handleMixerWindowClosed(bounds);
            });

        mainWindow = std::make_unique<MainWindow>(getApplicationName(),
                                                  *audioEngine,
                                                  appUpdater,
                                                  startupMode,
                                                  createWindowCallbacks(),
                                                  pitchRegressionJobPath);

        if (auto* component = mainWindow->getMainComponent())
            audioEngine->setPluginWindowOwnerComponent(component);

        audioEngine->onPeaksReady = [] (const juce::String& filePath)
        {
            auto* data = new juce::DynamicObject();
            data->setProperty("filePath", filePath);
            MainComponent::broadcastEventToAll("peaksReady", juce::var(data));
        };

        appUpdater.setStatusCallback([](const juce::var& status)
        {
            MainComponent::broadcastEventToAll("updateStatusChanged", status);
        });

        audioEngine->setPluginWindowShortcutForwardCallback([](const juce::var& payload)
        {
            MainComponent::broadcastEventToAll("nativeGlobalShortcut", payload);
        });

        juce::Logger::writeToLog("MainWindow Created.");

        if (windowLifecycleHarnessMode)
        {
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_WindowLifecycleHarness.json");

            juce::Timer::callAfterDelay(1000, [this, reportFile]()
            {
                runWindowLifecycleHarness(reportFile);
            });
        }
    }

    void shutdown() override
    {
        juce::Logger::writeToLog("Application Check-out.");

        pluginEditorWindowManagers.clear();
        midiEditorWindowManagers.clear();
        mixerWindowManager = nullptr;
        mainWindow = nullptr;
        audioEngine.reset();

        juce::Logger::setCurrentLogger(nullptr);
    }

    void systemRequestedQuit() override
    {
        if (mixerWindowManager != nullptr)
            mixerWindowManager->close();
        for (auto& entry : pluginEditorWindowManagers)
            if (entry.second != nullptr)
                entry.second->close();
        for (auto& entry : midiEditorWindowManagers)
            if (entry.second != nullptr)
            {
                midiEditorWindowCloseReasons[entry.first] = "appQuit";
                entry.second->close();
            }

        quit();
    }

    void anotherInstanceStarted (const juce::String& commandLine) override
    {
        OpenStudioLaunchState::setPendingProjectPath(commandLine);
    }

    class MainWindow    : public juce::DocumentWindow,
                          private juce::Timer
    {
    public:
        MainWindow (juce::String name,
                    AudioEngine& audioEngine,
                    AppUpdater& appUpdater,
                    MainComponent::StartupMode startupMode,
                    MainComponent::WindowCallbacks callbacks,
                    const juce::String& pitchRegressionJobPath = {})
            : DocumentWindow (name,
                              juce::Colours::black,
#if JUCE_MAC
                              juce::DocumentWindow::allButtons)
#else
                              0)
#endif
        {
#if JUCE_MAC
            setUsingNativeTitleBar (true);
#else
            setUsingNativeTitleBar (false);
            setTitleBarHeight (0);
#endif
            setContentOwned (new MainComponent(audioEngine,
                                               appUpdater,
                                               startupMode,
                                               MainComponent::WindowRole::main,
                                               std::move(callbacks),
                                               pitchRegressionJobPath),
                             true);

           #if JUCE_IOS || JUCE_ANDROID
            setFullScreen (true);
           #else
            setResizable (true, true);
            setResizeLimits (800, 600, 10000, 10000);
            centreWithSize (1280, 800);
           #endif

            setVisible (true);

           #if JUCE_WINDOWS
            if (auto* peer = getPeer())
            {
                auto hwnd = static_cast<HWND> (peer->getNativeHandle());

                auto style = ::GetWindowLongPtr (hwnd, GWL_STYLE);
                style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
                ::SetWindowLongPtr (hwnd, GWL_STYLE, style);
                ::SetWindowPos (hwnd, nullptr, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

                BOOL useDarkMode = TRUE;
                ::DwmSetWindowAttribute (hwnd, 20, &useDarkMode, sizeof (useDarkMode));
            }
           #endif

            startTimer (600);
        }

        void closeButtonPressed() override
        {
            if (auto* component = getMainComponent())
                component->requestFrontendAppClose();
            else
                juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

        MainComponent* getMainComponent() const
        {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

        juce::BorderSize<int> getBorderThickness() const override { return { 0, 0, 0, 0 }; }
        juce::BorderSize<int> getContentComponentBorder() const override { return { 0, 0, 0, 0 }; }

    private:
        void timerCallback() override
        {
            stopTimer();

            auto b = getBounds();
            setBounds (b.withWidth (b.getWidth() + 1));
            setBounds (b);
        }

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    MainComponent::WindowCallbacks createWindowCallbacks()
    {
        MainComponent::WindowCallbacks callbacks;
        callbacks.requestAppClose = [this]()
        {
            systemRequestedQuit();
        };
        callbacks.openMixerWindow = [this](const juce::var& bounds)
        {
            return openMixerWindow(bounds);
        };
        callbacks.closeMixerWindow = [this]()
        {
            return closeMixerWindow();
        };
        callbacks.getMixerWindowState = [this]()
        {
            return getMixerWindowState();
        };
        callbacks.publishMixerUISnapshot = [this](const juce::var& snapshot)
        {
            publishMixerUISnapshot(snapshot);
        };
        callbacks.getMixerUISnapshot = [this]()
        {
            return getMixerUISnapshot();
        };
        callbacks.openMidiEditorWindow = [this](const juce::String& sessionId, const juce::var& bounds)
        {
            return openMidiEditorWindow(sessionId, bounds);
        };
        callbacks.prewarmMidiEditorWindow = [this](const juce::String& sessionId, const juce::var& bounds)
        {
            return prewarmMidiEditorWindow(sessionId, bounds);
        };
        callbacks.focusMidiEditorWindow = [this](const juce::String& sessionId)
        {
            return focusMidiEditorWindow(sessionId);
        };
        callbacks.closeMidiEditorWindow = [this](const juce::String& sessionId, const juce::String& reason)
        {
            return closeMidiEditorWindow(sessionId, reason);
        };
        callbacks.getMidiEditorWindowState = [this](const juce::String& sessionId)
        {
            return getMidiEditorWindowState(sessionId);
        };
        callbacks.publishMidiEditorUISnapshot = [this](const juce::String& sessionId, const juce::var& snapshot)
        {
            publishMidiEditorUISnapshot(sessionId, snapshot);
        };
        callbacks.getMidiEditorUISnapshot = [this](const juce::String& sessionId)
        {
            return getMidiEditorUISnapshot(sessionId);
        };
        callbacks.openPluginEditorWindow = [this](const juce::String& sessionId, const juce::var& bounds)
        {
            return openPluginEditorWindow(sessionId, bounds);
        };
        callbacks.closePluginEditorWindow = [this](const juce::String& sessionId, const juce::String& reason)
        {
            return closePluginEditorWindow(sessionId, reason);
        };
        return callbacks;
    }

    bool openMixerWindow(const juce::var& boundsValue)
    {
        if (mixerWindowManager == nullptr)
            return false;

        return mixerWindowManager->open(rectangleFromVar(boundsValue));
    }

    bool closeMixerWindow()
    {
        if (mixerWindowManager == nullptr)
            return false;

        return mixerWindowManager->close();
    }

    juce::var getMixerWindowState() const
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("isOpen", mixerWindowManager != nullptr && mixerWindowManager->isOpen());
        obj->setProperty("state", mixerWindowManager != nullptr ? mixerWindowManager->getStateDescription() : juce::String("idle"));
        return juce::var(obj);
    }

    void publishMixerUISnapshot(const juce::var& snapshot)
    {
        {
            const juce::ScopedLock sl(mixerSnapshotLock);
            latestMixerUISnapshot = snapshot;
        }

        MainComponent::broadcastEventToAll("mixerUISync", snapshot);
    }

    juce::var getMixerUISnapshot() const
    {
        const juce::ScopedLock sl(mixerSnapshotLock);
        return latestMixerUISnapshot;
    }

    juce::String normaliseMidiEditorSessionId(const juce::String& sessionId) const
    {
        const auto trimmed = sessionId.trim();
        return trimmed.isNotEmpty() ? trimmed : juce::String("default-midi-editor");
    }

    juce::String normalisePluginEditorSessionId(const juce::String& sessionId) const
    {
        const auto trimmed = sessionId.trim();
        return trimmed.isNotEmpty() ? trimmed : juce::String("default-plugin-editor");
    }

    juce::String getPluginEditorTitleFromSession(const juce::String& sessionId) const
    {
        auto parsed = juce::JSON::parse(sessionId);
        if (auto* object = parsed.getDynamicObject())
        {
            const auto title = object->getProperty("title").toString().trim();
            if (title.isNotEmpty())
                return title;

            const auto fallbackName = object->getProperty("fallbackName").toString().trim();
            if (fallbackName.isNotEmpty())
                return fallbackName;
        }

        return "OpenStudio Plugin";
    }

    MixerWindowManager* getOrCreateMidiEditorWindowManager(const juce::String& sessionId)
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        auto existing = midiEditorWindowManagers.find(safeSessionId);
        if (existing != midiEditorWindowManagers.end())
            return existing->second.get();

        auto manager = std::make_unique<MixerWindowManager>(
            [this, safeSessionId]()
            {
                return std::make_unique<MainComponent>(*audioEngine,
                                                       appUpdater,
                                                       startupMode,
                                                       MainComponent::WindowRole::midiEditor,
                                                       createWindowCallbacks(),
                                                       juce::String(),
                                                       safeSessionId);
            },
            [this, safeSessionId](const juce::Rectangle<int>& bounds)
            {
                handleMidiEditorWindowClosed(safeSessionId, bounds);
            },
            "MIDI Editor",
            juce::Rectangle<int>(140, 100, 1400, 850),
            900,
            560);

        auto* result = manager.get();
        midiEditorWindowManagers[safeSessionId] = std::move(manager);
        return result;
    }

    bool openMidiEditorWindow(const juce::String& sessionId, const juce::var& boundsValue)
    {
        if (auto* manager = getOrCreateMidiEditorWindowManager(sessionId))
            return manager->open(rectangleFromVar(boundsValue));

        return false;
    }

    bool prewarmMidiEditorWindow(const juce::String& sessionId, const juce::var& boundsValue)
    {
        if (auto* manager = getOrCreateMidiEditorWindowManager(sessionId))
            return manager->prewarm(rectangleFromVar(boundsValue));

        return false;
    }

    bool focusMidiEditorWindow(const juce::String& sessionId)
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        auto existing = midiEditorWindowManagers.find(safeSessionId);
        if (existing == midiEditorWindowManagers.end() || existing->second == nullptr)
            return false;

        return existing->second->focus();
    }

    bool closeMidiEditorWindow(const juce::String& sessionId, const juce::String& reason)
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        auto existing = midiEditorWindowManagers.find(safeSessionId);
        if (existing == midiEditorWindowManagers.end() || existing->second == nullptr)
            return false;

        const auto closeReason = reason.trim().isNotEmpty() ? reason.trim() : juce::String("close");
        midiEditorWindowCloseReasons[safeSessionId] = closeReason;

        if (closeReason == "dock")
            return existing->second->hide();

        return existing->second->close();
    }

    juce::var getMidiEditorWindowState(const juce::String& sessionId) const
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        const auto existing = midiEditorWindowManagers.find(safeSessionId);
        auto* obj = new juce::DynamicObject();
        obj->setProperty("isOpen", existing != midiEditorWindowManagers.end()
                                   && existing->second != nullptr
                                   && existing->second->isOpen());
        obj->setProperty("state", existing != midiEditorWindowManagers.end() && existing->second != nullptr
                                    ? existing->second->getStateDescription()
                                    : juce::String("idle"));
        obj->setProperty("sessionId", safeSessionId);
        return juce::var(obj);
    }

    void publishMidiEditorUISnapshot(const juce::String& sessionId, const juce::var& snapshot)
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        {
            const juce::ScopedLock sl(midiEditorSnapshotLock);
            latestMidiEditorUISnapshots[safeSessionId] = snapshot;
        }

        MainComponent::broadcastEventToAll("midiEditorUISync", snapshot);
    }

    juce::var getMidiEditorUISnapshot(const juce::String& sessionId) const
    {
        const auto safeSessionId = normaliseMidiEditorSessionId(sessionId);
        const juce::ScopedLock sl(midiEditorSnapshotLock);
        const auto existing = latestMidiEditorUISnapshots.find(safeSessionId);
        return existing != latestMidiEditorUISnapshots.end() ? existing->second : juce::var();
    }

    MixerWindowManager* getOrCreatePluginEditorWindowManager(const juce::String& sessionId)
    {
        const auto safeSessionId = normalisePluginEditorSessionId(sessionId);
        auto existing = pluginEditorWindowManagers.find(safeSessionId);
        if (existing != pluginEditorWindowManagers.end())
            return existing->second.get();

        auto manager = std::make_unique<MixerWindowManager>(
            [this, safeSessionId]()
            {
                return std::make_unique<MainComponent>(*audioEngine,
                                                       appUpdater,
                                                       startupMode,
                                                       MainComponent::WindowRole::pluginEditor,
                                                       createWindowCallbacks(),
                                                       juce::String(),
                                                       safeSessionId);
            },
            [this, safeSessionId](const juce::Rectangle<int>& bounds)
            {
                handlePluginEditorWindowClosed(safeSessionId, bounds);
            },
            getPluginEditorTitleFromSession(safeSessionId),
            juce::Rectangle<int>(180, 90, 1320, 860),
            980,
            620);

        auto* result = manager.get();
        pluginEditorWindowManagers[safeSessionId] = std::move(manager);
        return result;
    }

    bool openPluginEditorWindow(const juce::String& sessionId, const juce::var& boundsValue)
    {
        if (auto* manager = getOrCreatePluginEditorWindowManager(sessionId))
            return manager->open(rectangleFromVar(boundsValue));

        return false;
    }

    bool closePluginEditorWindow(const juce::String& sessionId, const juce::String& reason)
    {
        juce::ignoreUnused(reason);
        const auto safeSessionId = normalisePluginEditorSessionId(sessionId);
        auto existing = pluginEditorWindowManagers.find(safeSessionId);
        if (existing == pluginEditorWindowManagers.end() || existing->second == nullptr)
            return false;

        return existing->second->close();
    }

    void handleMixerWindowClosed(const juce::Rectangle<int>& bounds)
    {
        if (auto* component = mainWindow != nullptr ? mainWindow->getMainComponent() : nullptr)
            audioEngine->setPluginWindowOwnerComponent(component);

        auto* payload = new juce::DynamicObject();
        payload->setProperty("bounds", rectangleToVar(bounds));
        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "mixerWindowClosed", juce::var(payload));
    }

    void handleMidiEditorWindowClosed(const juce::String& sessionId, const juce::Rectangle<int>& bounds)
    {
        const auto reasonIt = midiEditorWindowCloseReasons.find(sessionId);
        const auto reason = reasonIt != midiEditorWindowCloseReasons.end()
            ? reasonIt->second
            : juce::String("close");
        if (reasonIt != midiEditorWindowCloseReasons.end())
            midiEditorWindowCloseReasons.erase(reasonIt);

        auto* payload = new juce::DynamicObject();
        payload->setProperty("sessionId", sessionId);
        payload->setProperty("reason", reason);
        payload->setProperty("bounds", rectangleToVar(bounds));
        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "midiEditorWindowClosed", juce::var(payload));
    }

    void handlePluginEditorWindowClosed(const juce::String& sessionId, const juce::Rectangle<int>& bounds)
    {
        if (auto* component = mainWindow != nullptr ? mainWindow->getMainComponent() : nullptr)
            audioEngine->setPluginWindowOwnerComponent(component);

        auto* payload = new juce::DynamicObject();
        payload->setProperty("sessionId", sessionId);
        payload->setProperty("bounds", rectangleToVar(bounds));
        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "builtInPluginEditorWindowClosed", juce::var(payload));
    }

    void runWindowLifecycleHarness(const juce::File& reportFile)
    {
        struct HarnessStep
        {
            juce::String id;
            int delayAfterMs = 400;
            std::function<bool()> action;
        };

        const auto mixerBounds = juce::Rectangle<int>(120, 120, 1180, 520);
        const auto midiBounds = juce::Rectangle<int>(140, 100, 1180, 720);
        const auto pluginBounds = juce::Rectangle<int>(180, 90, 1040, 680);
        const juce::String midiSessionId = "window-lifecycle-midi";
        const juce::String pluginSessionId = R"({"title":"Window Lifecycle Harness","fallbackName":"OpenStudio Built-in","address":{"trackId":"window-lifecycle","chain":"track","fxIndex":0}})";

        auto checks = std::make_shared<juce::Array<juce::var>>();
        auto steps = std::make_shared<std::vector<HarnessStep>>();

        steps->push_back({ "mixer_prewarm", 700, [this, mixerBounds]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->prewarm(mixerBounds);
        }});
        steps->push_back({ "mixer_open", 700, [this, mixerBounds]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->open(mixerBounds);
        }});
        steps->push_back({ "mixer_focus", 300, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->focus();
        }});
        steps->push_back({ "mixer_close", 50, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->close();
        }});
        steps->push_back({ "mixer_reopen_while_closing", 3000, [this, mixerBounds]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->open(mixerBounds);
        }});
        steps->push_back({ "mixer_final_close", 2200, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->close();
        }});

        steps->push_back({ "midi_prewarm", 700, [this, midiSessionId, midiBounds]()
        {
            return prewarmMidiEditorWindow(midiSessionId, rectangleToVar(midiBounds));
        }});
        steps->push_back({ "midi_focus", 300, [this, midiSessionId]()
        {
            return focusMidiEditorWindow(midiSessionId);
        }});
        steps->push_back({ "midi_close", 50, [this, midiSessionId]()
        {
            return closeMidiEditorWindow(midiSessionId, "close");
        }});
        steps->push_back({ "midi_reopen_while_closing", 3000, [this, midiSessionId, midiBounds]()
        {
            return openMidiEditorWindow(midiSessionId, rectangleToVar(midiBounds));
        }});
        steps->push_back({ "midi_final_close", 2200, [this, midiSessionId]()
        {
            return closeMidiEditorWindow(midiSessionId, "close");
        }});

        steps->push_back({ "plugin_open", 700, [this, pluginSessionId, pluginBounds]()
        {
            return openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds));
        }});
        steps->push_back({ "plugin_close", 50, [this, pluginSessionId]()
        {
            return closePluginEditorWindow(pluginSessionId, "close");
        }});
        steps->push_back({ "plugin_reopen_while_closing", 3000, [this, pluginSessionId, pluginBounds]()
        {
            return openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds));
        }});
        steps->push_back({ "plugin_final_close", 2200, [this, pluginSessionId]()
        {
            return closePluginEditorWindow(pluginSessionId, "close");
        }});

        auto stepIndex = std::make_shared<size_t>(0);
        auto runner = std::make_shared<std::function<void()>>();
        *runner = [this, reportFile, checks, steps, stepIndex, runner, midiSessionId]() mutable
        {
            if (*stepIndex >= steps->size())
            {
                const bool success = ! hasFailedHarnessCheck(*checks);
                auto* root = new juce::DynamicObject();
                root->setProperty("harnessMode", "window_lifecycle");
                root->setProperty("success", success);
                root->setProperty("checks", juce::var(*checks));
                root->setProperty("mixerState", getMixerWindowState());
                root->setProperty("midiState", getMidiEditorWindowState(midiSessionId));
                root->setProperty("generatedAtMs", static_cast<double>(juce::Time::currentTimeMillis()));

                const bool wrote = writeHeadlessResult(reportFile, juce::var(root));
                juce::Logger::writeToLog("[windowLifecycleHarness] report=" + reportFile.getFullPathName()
                                         + " wroteReport=" + juce::String(wrote ? "true" : "false")
                                         + " success=" + juce::String(success ? "true" : "false"));

                setApplicationReturnValue(wrote && success ? 0 : 2);

                juce::Timer::callAfterDelay(200, []()
                {
                    if (auto* app = juce::JUCEApplication::getInstance())
                        app->systemRequestedQuit();
                });
                return;
            }

            const auto& step = (*steps)[*stepIndex];
            bool ok = false;
            juce::String detail;

            try
            {
                ok = step.action != nullptr && step.action();
                detail = ok ? "accepted" : "rejected";
            }
            catch (...)
            {
                ok = false;
                detail = "exception";
            }

            addHarnessCheck(*checks, step.id, ok ? "pass" : "fail", detail);
            juce::Logger::writeToLog("[windowLifecycleHarness] " + step.id + " " + detail);
            ++(*stepIndex);

            juce::Timer::callAfterDelay(step.delayAfterMs, [runner]()
            {
                if (runner != nullptr && *runner)
                    (*runner)();
            });
        };

        juce::Logger::writeToLog("[windowLifecycleHarness] starting");
        (*runner)();
    }

    std::unique_ptr<AudioEngine> audioEngine;
    AppUpdater appUpdater;
    MainComponent::StartupMode startupMode = MainComponent::StartupMode::normal;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MixerWindowManager> mixerWindowManager;
    std::map<juce::String, std::unique_ptr<MixerWindowManager>> midiEditorWindowManagers;
    std::map<juce::String, std::unique_ptr<MixerWindowManager>> pluginEditorWindowManagers;
    mutable juce::CriticalSection mixerSnapshotLock;
    juce::var latestMixerUISnapshot;
    mutable juce::CriticalSection midiEditorSnapshotLock;
    std::map<juce::String, juce::var> latestMidiEditorUISnapshots;
    std::map<juce::String, juce::String> midiEditorWindowCloseReasons;
};

START_JUCE_APPLICATION (OpenStudioApplication)
