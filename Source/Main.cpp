#include "RegressionMessagePump.h"
#include "AudioDeviceProbe.h"
#include "RuntimeLocation.h"
#include <JuceHeader.h>
#include "ApplicationLaunchState.h"
#include "AudioEngine.h"
#include "CrashDiagnostics.h"
#include "RuntimeSafetyRegression.h"
#include "RecordingRecoveryRegression.h"
#include "MetronomeRegression.h"
#include "FreePluginRegression.h"
#include "AppUpdater.h"
#include "UpdateInstaller.h"
#include "StoreUpdaterRegression.h"
#include "UpdaterRegression.h"
#include "WindowsPackage.h"
#include "CLAPPluginFormat.h"
#include "MainComponent.h"
#include "NativeWindowTheme.h"
#include "MixerWindowManager.h"
#include "ASIOCapabilities.h"
#include "NAMModelSafety.h"
#include "PluginManager.h"
#include "PluginQualification.h"
#include "IsolatedPlugin.h"

#include "NAM/container.h"
#include "NAM/convnet.h"
#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#include "NAM/lstm.h"
#include "NAM/model_config.h"
#include "NAM/wavenet/model.h"

#include <algorithm>
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
                               const juce::File& reportFile,
                               bool qualify = false, bool checkEditor = false)
{
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager(formats);
    formats.addFormat(std::make_unique<CLAPPluginFormat>());

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
            if (qualify)
                for (const auto* description : descriptions)
                    if (description != nullptr)
                    {
                        auto qualification = PluginQualification::run(formats, *description, checkEditor);
                        if (!qualification->getBoolAttribute("success"))
                            result->setAttribute("status", "qualification-failed");
                        result->addChildElement(qualification.release());
                    }
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

    const auto modelFileSize = modelFile.getSize();
    const bool boundedModelSize = modelFileSize > 0
        && modelFileSize
            <= OpenStudioNAMModelSafety::maximumFileBytes;
    addHarnessCheck(checks,
                    "model_file_size_bounded",
                    boundedModelSize ? "pass" : "fail",
                    "The isolated probe rejects empty or oversized NAM JSON before allocating it.",
                    juce::String(modelFileSize));
    if (! boundedModelSize)
        return finish(false, modelFileSize <= 0
            ? juce::String("NAM model file is empty.")
            : juce::String("NAM model file exceeds the ")
                + OpenStudioNAMModelSafety::maximumFileDescription
                + " safety limit.");

    juce::FileInputStream modelInput(modelFile);
    std::array<char, 4096> modelPrefix {};
    const auto prefixBytes = modelInput.openedOk()
        ? modelInput.read(modelPrefix.data(), static_cast<int>(modelPrefix.size()))
        : 0;
    int prefixOffset = 0;
    if (prefixBytes >= 3
        && static_cast<unsigned char>(modelPrefix[0]) == 0xef
        && static_cast<unsigned char>(modelPrefix[1]) == 0xbb
        && static_cast<unsigned char>(modelPrefix[2]) == 0xbf)
    {
        prefixOffset = 3;
    }
    while (prefixOffset < prefixBytes
           && juce::CharacterFunctions::isWhitespace(
               static_cast<juce::juce_wchar>(
                   static_cast<unsigned char>(modelPrefix[static_cast<size_t>(prefixOffset)]))))
    {
        ++prefixOffset;
    }
    const bool jsonObjectEnvelope = prefixOffset < prefixBytes
        && modelPrefix[static_cast<size_t>(prefixOffset)] == '{';
    addHarnessCheck(checks,
                    "model_json_object_envelope",
                    jsonObjectEnvelope ? "pass" : "fail",
                    "The isolated probe requires a JSON object envelope before full parsing.");
    if (! jsonObjectEnvelope)
        return finish(false, "Invalid NAM model file envelope.");

    juce::String modelText;
    try
    {
        juce::FileInputStream boundedInput(modelFile);
        const auto boundedLength = boundedInput.openedOk()
            ? boundedInput.getTotalLength()
            : 0;
        if (boundedLength <= 0
            || boundedLength
                > OpenStudioNAMModelSafety::maximumFileBytes)
        {
            return finish(false,
                "NAM model file changed before isolated parsing.");
        }

        juce::MemoryBlock modelBytes(
            static_cast<size_t>(boundedLength));
        juce::int64 totalRead = 0;
        while (totalRead < boundedLength)
        {
            const int requested = static_cast<int>(
                std::min<juce::int64>(
                    boundedLength - totalRead,
                    1024 * 1024));
            const int count = boundedInput.read(
                static_cast<char*>(modelBytes.getData())
                    + static_cast<size_t>(totalRead),
                requested);
            if (count <= 0)
                break;
            totalRead += count;
        }
        char unexpectedByte = 0;
        if (totalRead != boundedLength
            || boundedInput.read(&unexpectedByte, 1) > 0)
        {
            return finish(false,
                "NAM model file changed during isolated parsing.");
        }
        modelText = juce::String::fromUTF8(
            static_cast<const char*>(modelBytes.getData()),
            static_cast<int>(modelBytes.getSize()));
    }
    catch (const std::exception& ex)
    {
        return finish(false,
            "Could not allocate bounded NAM model input: "
                + juce::String(ex.what()));
    }
    catch (...)
    {
        return finish(false,
            "Could not allocate bounded NAM model input.");
    }

    const auto parsed = juce::JSON::parse(modelText);
    modelText.clear();
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
    const auto catalogRegression =
        MainComponent::runNAMCatalogNativeRegression();
    const bool catalogPass = catalogRegression.isObject()
        && catalogRegression.getProperty(
               "objectiveGateStatus", {}).toString() == "pass";
    if (auto* resultObject = result.getDynamicObject())
    {
        auto suitesValue = resultObject->getProperty("suites");
        if (auto* suites = suitesValue.getArray())
        {
            juce::DynamicObject::Ptr suite = new juce::DynamicObject();
            suite->setProperty("id", "nam_catalog_native_fixture");
            suite->setProperty("pass", catalogPass);
            suite->setProperty(
                "detail",
                catalogPass
                    ? juce::String(
                        "Native catalog model-cache, duplicate-row, Retry-After, and credential-generation checks passed.")
                    : juce::String(
                        "One or more native NAM catalog or credential-generation checks failed."));
            suite->setProperty("diagnostics", catalogRegression);
            suites->add(juce::var(suite.get()));
            resultObject->setProperty("suites", suitesValue);
        }
        const bool enginePass = static_cast<bool>(
            resultObject->getProperty("overallPass"));
        resultObject->setProperty(
            "overallPass", enginePass && catalogPass);
        resultObject->setProperty(
            "namCatalogNativeRegression", catalogRegression);
    }
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool overallPass = result.isObject()
        && static_cast<bool>(result.getProperty("overallPass", false));

    juce::Logger::writeToLog("[automatedRegression.headless] report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " overallPass=" + juce::String(overallPass ? "true" : "false"));

    return wroteReport && overallPass ? 0 : 2;
}

int runHeadlessRenderExportRegression(AudioEngine& audioEngine,
                                      const juce::File& outputDirectory,
                                      const juce::File& reportFile)
{
    auto result = audioEngine.runRenderExportRegression(outputDirectory);
    const bool wroteReport = writeHeadlessResult(reportFile, result);
    const bool pass = result.isObject()
        && result.getProperty("objectiveGateStatus", {}).toString() == "pass";
    juce::Logger::writeToLog(
        "[renderExportRegression.headless] outputDir="
        + outputDirectory.getFullPathName()
        + " report=" + reportFile.getFullPathName()
        + " wroteReport=" + juce::String(wroteReport ? "true" : "false")
        + " objectiveGateStatus="
        + result.getProperty("objectiveGateStatus", {}).toString());
    return wroteReport && pass ? 0 : 2;
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
    const auto catalogRegression =
        MainComponent::runNAMCatalogNativeRegression();
    const bool catalogPass = catalogRegression.isObject()
        && catalogRegression.getProperty(
               "objectiveGateStatus", {}).toString() == "pass";
    if (auto* resultObject = result.getDynamicObject())
    {
        auto checksValue = resultObject->getProperty("checks");
        if (auto* checks = checksValue.getArray())
        {
            juce::DynamicObject::Ptr check = new juce::DynamicObject();
            check->setProperty(
                "id", "nam_catalog_native_fixture");
            check->setProperty(
                "status", catalogPass ? "pass" : "fail");
            check->setProperty(
                "detail",
                "The native packaged catalog must preserve multi-capture model hydration, honor Retry-After, and reject stale credential publication/cleanup decisions.");
            check->setProperty("value", catalogRegression);
            checks->add(juce::var(check.get()));
            resultObject->setProperty("checks", checksValue);
        }
        const bool rackPass =
            resultObject->getProperty(
                "objectiveGateStatus").toString() == "pass";
        const bool combinedPass = rackPass && catalogPass;
        resultObject->setProperty(
            "objectiveGateStatus", combinedPass ? "pass" : "fail");
        resultObject->setProperty("success", combinedPass);
        resultObject->setProperty("done", combinedPass);
        resultObject->setProperty(
            "namCatalogNativeRegression", catalogRegression);
    }
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
        if (!UpdateInstaller::registerRunningApplication(getCommandLineOptionValue(commandLine, "--openstudio-update-receipt")))
        {
            juce::Logger::writeToLog("OpenStudio could not acquire its installation lock. Another update may be replacing this application.");
            setApplicationReturnValue(2);
            quit(); return;
        }
        WindowsPackage::configureWebView();
        const auto updaterFeedTestPath = getCommandLineOptionValue(commandLine, "--updater-feed-self-test");
        if (updaterFeedTestPath.isNotEmpty())
        {
            const auto directory = juce::File(updaterFeedTestPath);
            const auto result = UpdaterRegression::checkPublishedFeed(directory);
            const auto status = result["status"].toString();
            const bool written = directory.createDirectory() && directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(result, true));
            setApplicationReturnValue(written && (status == "update-available" || status == "up-to-date") ? 0 : 2);
            quit(); return;
        }
        const auto updaterTestPath = getCommandLineOptionValue(commandLine, "--updater-self-test");
        if (updaterTestPath.isNotEmpty())
        {
            const auto directory = juce::File(updaterTestPath);
            const auto result = UpdaterRegression::run(directory);
            const bool written = directory.createDirectory() && directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(result, true));
            setApplicationReturnValue(written && static_cast<bool>(result["pass"]) ? 0 : 2);
            quit(); return;
        }
        const auto updateTestPath = getCommandLineOptionValue(commandLine, "--store-update-self-test");
        if (updateTestPath.isNotEmpty())
        {
            const auto result = runStoreUpdaterRegression();
            const auto file = juce::File(updateTestPath);
            const bool written = file.getParentDirectory().createDirectory()
                && file.replaceWithText(juce::JSON::toString(result, true));
            setApplicationReturnValue(written && static_cast<bool>(result["pass"]) ? 0 : 2);
            quit(); return;
        }
        const auto storeQueryPath = getCommandLineOptionValue(commandLine, "--store-update-query-self-test");
        if (storeQueryPath.isNotEmpty())
        {
            // Read-only integration probe: Store dialogs require a real HWND.
            // Never download or install from a test command-line argument.
            storeQueryWindow = std::make_unique<juce::DocumentWindow>("OpenStudio Store update check",
                juce::Colours::darkgrey, 0);
            storeQueryWindow->setUsingNativeTitleBar(true);
            storeQueryWindow->centreWithSize(420, 120);
            storeQueryWindow->setVisible(true);
            applyNativeWindowTheme(*storeQueryWindow);
            appUpdater.checkForUpdates(true, [this, storeQueryPath](const juce::var& status) {
                auto* report = new juce::DynamicObject();
                const auto resultStatus = status["status"].toString();
                const bool pass = WindowsPackage::isStoreManaged()
                    && status["updateSource"].toString() == "microsoft-store"
                    && (resultStatus == "up-to-date" || resultStatus == "update-available");
                report->setProperty("pass", pass);
                report->setProperty("status", status);
                report->setProperty("storeDeliveredUpgrade", "not_asserted");
                const auto file = juce::File(storeQueryPath);
                const bool written = file.getParentDirectory().createDirectory()
                    && file.replaceWithText(juce::JSON::toString(juce::var(report), true));
                setApplicationReturnValue(pass && written ? 0 : 2);
                quit();
            });
            return;
        }
        const auto storeTestPath = getCommandLineOptionValue(commandLine, "--store-package-self-test");
        if (storeTestPath.isNotEmpty())
        {
            juce::DynamicObject::Ptr report = new juce::DynamicObject();
            const bool packaged = WindowsPackage::isStoreManaged();
            report->setProperty("storeManaged", packaged);
            int replies = 0;
            AppUpdater updater;
            if (packaged)
            {
                const auto reply = [&](const juce::var& result) {
                    if (result["status"].toString() == "error" && result["updateSource"].toString() == "microsoft-store") ++replies;
                };
                updater.downloadUpdate(reply);
                updater.installDownloadedUpdate(reply);
            }
            report->setProperty("rejectedUnpreparedStoreOperations", replies);
            const auto updateRegression = runStoreUpdaterRegression();
            report->setProperty("updateRegression", updateRegression);
            report->setProperty("updateStatus", updater.getLastStatus());
            report->setProperty("fixedWebView", WindowsPackage::fixedWebViewDirectory().getFullPathName());
            const auto runtimePresent = WindowsPackage::fixedWebViewDirectory().getChildFile("msedgewebview2.exe").existsAsFile();
            report->setProperty("runtimePresent", runtimePresent);
            const auto reportFile = juce::File(storeTestPath);
            const bool passed = packaged && replies == 2 && runtimePresent && static_cast<bool>(updateRegression["pass"]);
            report->setProperty("pass", passed);
            const bool written = reportFile.getParentDirectory().createDirectory()
                && reportFile.replaceWithText(juce::JSON::toString(juce::var(report.get()), true));
            setApplicationReturnValue(passed && written ? 0 : 2);
            quit(); return;
        }
        const auto isolatedWorker = getCommandLineOptionValue(commandLine, "--isolated-plugin-worker");
        if (isolatedWorker.isNotEmpty())
        {
            setApplicationReturnValue(runIsolatedPluginWorker(isolatedWorker));
            quit(); return;
        }
        const auto isolationFixture = getCommandLineOptionValue(commandLine, "--isolated-plugin-self-test");
        if (isolationFixture.isNotEmpty())
        {
            setApplicationReturnValue(runIsolatedPluginRegression(juce::File(isolationFixture),
                commandLineHasFlag(commandLine, "--exercise-isolated-editors")));
            quit(); return;
        }
        const auto isolationCompatibility = getCommandLineOptionValue(commandLine, "--isolated-plugin-compatibility");
        if (isolationCompatibility.isNotEmpty())
        {
            setApplicationReturnValue(runIsolatedPluginCompatibility(
                juce::File(getCommandLineOptionValue(commandLine, "--plugin-catalog")),
                getCommandLineOptionValue(commandLine, "--plugin-name"), juce::File(isolationCompatibility)));
            quit(); return;
        }
        const auto recoveryFixture = getCommandLineOptionValue(commandLine, "--recovery-session-fixture");
        if (recoveryFixture.isNotEmpty())
        {
            ProjectFileStore::RecoverySession session { juce::File(recoveryFixture) };
            const auto saved = session.write(juce::Uuid().toString(), "", "{\"tracks\":[],\"projectName\":\"Interrupted untitled session\"}", 3);
            if (saved.wasOk() && commandLineHasFlag(commandLine, "--simulate-crash"))
                OpenStudioCrashDiagnostics::runSelfTest(juce::File(recoveryFixture).getChildFile("crash-evidence"), true);
            setApplicationReturnValue(saved.wasOk() && session.markClean().wasOk() ? 0 : 2);
            quit(); return;
        }
        const auto recoveryDiscovery = getCommandLineOptionValue(commandLine, "--recovery-discovery-fixture");
        if (recoveryDiscovery.isNotEmpty())
        {
            ProjectFileStore::RecoverySession observer { juce::File(recoveryDiscovery) };
            const juce::File report(getCommandLineOptionValue(commandLine, "--report"));
            setApplicationReturnValue(report.replaceWithText(juce::JSON::toString(observer.discover())) ? 0 : 2);
            quit(); return;
        }
        const auto recordingFixture = getCommandLineOptionValue(commandLine, "--recording-recovery-fixture");
        if (recordingFixture.isNotEmpty())
        {
            setApplicationReturnValue(runInterruptedRecordingFixture(juce::File(recordingFixture)));
            quit(); return;
        }
        const auto ownedWorkerFixture = getCommandLineOptionValue(commandLine, "--owned-worker-fixture");
        if (ownedWorkerFixture.isNotEmpty())
        {
            // Device-free process-tree fixture. Only this explicitly launched
            // test child waits; it never opens the user's project or audio device.
            const juce::File fixtureDirectory(ownedWorkerFixture);
            if (!fixtureDirectory.isDirectory()) { setApplicationReturnValue(2); quit(); return; }
            if (commandLineHasFlag(commandLine, "--owned-worker-environment"))
            {
                const auto value = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_PROCESS_ENV_TEST", "missing");
                fixtureDirectory.getChildFile("environment.txt").replaceWithText(value);
                quit(); return;
            }
            if (commandLineHasFlag(commandLine, "--owned-worker-leaf"))
            {
                juce::Thread::sleep(30000);
            }
            else
            {
                OwnedChildProcess descendant;
                const auto executable = OpenStudioRuntime::executableFile();
                if (!descendant.start({ executable.getFullPathName(), "--owned-worker-fixture", ownedWorkerFixture, "--owned-worker-leaf" }))
                { setApplicationReturnValue(3); quit(); return; }
                fixtureDirectory.getChildFile("descendant.pid").replaceWithText(juce::String(descendant.getProcessId()));
                juce::Thread::sleep(30000);
            }
            quit(); return;
        }
        const auto audioProbeName = getCommandLineOptionValue(commandLine, "--audio-device-probe");
        if (audioProbeName.isNotEmpty())
        {
            const auto output = getCommandLineOptionValue(commandLine, "--output-dir");
            const auto seconds = getCommandLineOptionValue(commandLine, "--audio-probe-seconds");
            const auto buffer = getCommandLineOptionValue(commandLine, "--audio-probe-buffer");
            setApplicationReturnValue(output.isNotEmpty()
                ? AudioDeviceProbe::run(audioProbeName, juce::File(output),
                    seconds.isEmpty() ? 10 : seconds.getIntValue(), buffer.isEmpty() ? 512 : buffer.getIntValue()) : 2);
            quit(); return;
        }
        const auto runtimeTestPath = getCommandLineOptionValue(commandLine, "--runtime-safety-self-test");
        if (runtimeTestPath.isNotEmpty())
        {
            const auto result = RuntimeSafetyRegression::run(juce::File(runtimeTestPath));
            setApplicationReturnValue(result);
            if (result == 0 && commandLineHasFlag(commandLine, "--simulate-recovery-crash"))
                OpenStudioCrashDiagnostics::runSelfTest(juce::File(runtimeTestPath).getChildFile("crash-evidence"), true);
            quit();
            return;
        }
        const auto diagnosticsTestPath = getCommandLineOptionValue(commandLine, "--crash-diagnostics-self-test");
        if (diagnosticsTestPath.isNotEmpty())
        {
            setApplicationReturnValue(OpenStudioCrashDiagnostics::runSelfTest(
                juce::File(diagnosticsTestPath), commandLineHasFlag(commandLine, "--simulate-crash"),
                commandLineHasFlag(commandLine, "--simulate-dump-write-failure"),
                commandLineHasFlag(commandLine, "--simulate-reporter-unavailable"),
                commandLineHasFlag(commandLine, "--simulate-hang"),
                commandLineHasFlag(commandLine, "--simulate-shutdown-hang")));
            quit();
            return;
        }
        if (commandLineHasFlag(
                commandLine,
                "--nam-library-manifest-writer-child"))
        {
           #if JUCE_WINDOWS
            ::SetPriorityClass(
                ::GetCurrentProcess(),
                BELOW_NORMAL_PRIORITY_CLASS);
           #endif
            const auto exitCode =
                MainComponent::runNAMLibraryManifestWriterRegressionChild(
                    juce::File(getCommandLineOptionValue(
                        commandLine, "--manifest")),
                    getCommandLineOptionValue(
                        commandLine, "--writer-id"),
                    juce::File(getCommandLineOptionValue(
                        commandLine, "--ready")),
                    juce::File(getCommandLineOptionValue(
                        commandLine, "--start")));
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        OpenStudioLaunchState::setPendingProjectPath(commandLine);
        if (commandLineHasFlag(commandLine, "--free-plugin-regression-headless"))
        {
            ScopedHeadlessRegressionMessages headlessMessages(true);
            const auto reportPath = getCommandLineOptionValue(commandLine, "--report");
            const auto fixturePath = getCommandLineOptionValue(commandLine, "--fixtures");
            const auto result = runFreePluginRegression(
                fixturePath.isEmpty() ? juce::File() : juce::File(fixturePath),
                commandLineHasFlag(commandLine, "--capture-fixtures"), getCommandLineOptionValue(commandLine, "--case"));
            const bool written = reportPath.isNotEmpty()
                && writeHeadlessResult(juce::File(reportPath), result);
            setApplicationReturnValue(written && static_cast<bool>(result["overallPass"]) ? 0 : 1);
            quit();
            return;
        }
        const auto startupSelfTestMode = commandLineHasFlag(commandLine, "--startup-self-test");
        const auto automatedRegressionHeadlessMode = commandLineHasFlag(commandLine, "--automated-regression-headless");
        const auto renderExportRegressionHeadlessMode = commandLineHasFlag(commandLine, "--render-export-regression-headless");
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
        ScopedHeadlessRegressionMessages headlessMessages(
            automatedRegressionHeadlessMode || renderExportRegressionHeadlessMode
            || pitchRegressionHeadlessJobPath.isNotEmpty()
            || cleanGuitarRegressionReportPath.isNotEmpty()
            || namRackRegressionReportPath.isNotEmpty()
            || namRackDIRegressionInputPath.isNotEmpty());
        startupMode = commandLineHasFlag(commandLine, "--ui-safe-mode")
            ? MainComponent::StartupMode::safe
            : MainComponent::StartupMode::normal;

        const auto reportFile = juce::File(startupSelfTestReportPath.trim().unquoted());
        auto logFile = startupSelfTestReportPath.isNotEmpty()
            ? reportFile.withFileExtension(pluginScanProbePath.isNotEmpty() ? "log" : "startup.log")
            : getWritableStartupLogFile();
        startupLogger = std::make_unique<juce::FileLogger>(logFile, "OpenStudio Startup Log");
        juce::Logger::setCurrentLogger(startupLogger.get());
        juce::Logger::writeToLog("Application Initialising...");
        juce::Logger::writeToLog("Startup log path: " + logFile.getFullPathName());
        juce::Logger::writeToLog("Startup mode: " + juce::String(startupMode == MainComponent::StartupMode::safe ? "safe" : "normal"));
        if (commandLineHasFlag(commandLine, "--asio-capability-probe"))
        {
            // Deliberately before AudioEngine construction: no streaming device,
            // user settings mutation, microphone recording, or application UI.
            auto* root = new juce::DynamicObject();
            auto* draft = new juce::DynamicObject();
            const auto driver = getCommandLineOptionValue(commandLine, "--driver");
            const bool reported = ASIOCapabilities::query(driver, *root, *draft);
            root->setProperty("driver", driver);
            root->setProperty("channels", juce::var(draft));
            root->setProperty("success", reported);
            root->setProperty("classification", "diagnostic_only: inactive ASIO capabilities, no recording or playback");
            const bool wrote = startupSelfTestReportPath.isNotEmpty()
                && writeHeadlessResult(juce::File(startupSelfTestReportPath), juce::var(root));
            setApplicationReturnValue(reported && wrote ? 0 : 2);
            quit();
            return;
        }
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
                reportFile,
                commandLineHasFlag(commandLine, "--plugin-qualify"),
                commandLineHasFlag(commandLine, "--plugin-editor-check"));
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
        if (automatedRegressionHeadlessMode
            && juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_METRONOME_FIXTURES_ONLY", {}).trim() == "1")
        {
            const auto result = runMetronomeRegression();
            const auto report = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath)
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_MetronomeRegression.json");
            const bool written = report.getParentDirectory().createDirectory()
                && report.replaceWithText(juce::JSON::toString(result, true));
            setApplicationReturnValue(written && static_cast<bool>(result["overallPass"]) ? 0 : 1);
            quit();
            return;
        }
        audioEngine = std::make_unique<AudioEngine>();
        audioEngine->onFXSlotsRemoved = [this](const juce::String& trackId,
                                              const juce::String& chain, int firstIndex)
        {
            closePluginEditorWindowsForRemovedSlots(trackId, chain, firstIndex);
        };

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

        if (renderExportRegressionHeadlessMode)
        {
            const auto outputDirectory = headlessOutputDirectoryPath.isNotEmpty()
                ? juce::File(headlessOutputDirectoryPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile(
                    "render_export_regression");
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : outputDirectory.getChildFile(
                    "render_export_regression_result.json");
            const auto exitCode = runHeadlessRenderExportRegression(
                *audioEngine,
                outputDirectory,
                reportFile);
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
            MainComponent::broadcastEventToRole(MainComponent::WindowRole::main,
                                                "nativeGlobalShortcut",
                                                payload);
        });

        juce::Logger::writeToLog("MainWindow Created.");

        if (windowLifecycleHarnessMode)
        {
            const auto reportFile = startupSelfTestReportPath.isNotEmpty()
                ? juce::File(startupSelfTestReportPath.trim().unquoted())
                : getWritableStartupLogFile().getSiblingFile("OpenStudio_WindowLifecycleHarness.json");

            const int editorReviewHoldMs = juce::jlimit(0, 60000,
                getCommandLineOptionValue(commandLine, "--plugin-editor-review-hold-ms").getIntValue());
            juce::Timer::callAfterDelay(1000, [this, reportFile, editorReviewHoldMs]()
            {
                runWindowLifecycleHarness(reportFile, editorReviewHoldMs);
            });
        }
    }

    void shutdown() override
    {
        if (audioEngine != nullptr)
            OpenStudioCrashDiagnostics::beginFinalShutdown();
        juce::Logger::writeToLog("Application Check-out.");
        appUpdater.shutdown();

        if (audioEngine != nullptr)
            audioEngine->onFXSlotsRemoved = {};
        pluginEditorWindowManagers.clear();
        pitchEditorWindowManager = nullptr;
        midiEditorWindowManagers.clear();
        mixerWindowManager = nullptr;
        mainWindow = nullptr;
        audioEngine.reset();

        juce::Logger::setCurrentLogger(nullptr);
        startupLogger.reset();
    }

    void systemRequestedQuit() override
    {
        if (pitchEditorWindowManager != nullptr) pitchEditorWindowManager->close();
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

    class MainWindow    : public juce::DocumentWindow
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
                              juce::DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
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

            applyNativeWindowTheme(*this);

        }

        void closeButtonPressed() override
        {
            if (auto* component = getMainComponent())
                component->requestFrontendAppClose();
            else
                juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

        void activeWindowStatusChanged() override
        {
            juce::DocumentWindow::activeWindowStatusChanged();

            if (isActiveWindow())
                if (auto* component = getMainComponent())
                    component->requestEmbeddedBrowserFocus();
        }

        MainComponent* getMainComponent() const
        {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

    private:
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
        callbacks.pitchEditorSession = [this](const juce::String& operation, const juce::var& payload,
                                              MainComponent::WindowRole sender, const juce::String& identity)
        { return handlePitchEditorSession(operation, payload, sender, identity); };
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
        callbacks.getPluginEditorWindowState = [this](const juce::String& sessionId)
        {
            auto* state = new juce::DynamicObject();
            const auto existing = pluginEditorWindowManagers.find(normalisePluginEditorSessionId(sessionId));
            const auto* manager = existing != pluginEditorWindowManagers.end() ? existing->second.get() : nullptr;
            state->setProperty("state", manager ? manager->getStateDescription() : juce::String("idle"));
            state->setProperty("frontendStartupState", manager ? manager->getFrontendStartupStateDescription() : juce::String("not-started"));
            return juce::var(state);
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
        obj->setProperty("frontendStartupState", mixerWindowManager != nullptr
                                                   ? mixerWindowManager->getFrontendStartupStateDescription()
                                                   : juce::String("not-created"));
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

    struct PluginEditorWindowGeometry
    {
        juce::Rectangle<int> preferred { 180, 90, 1320, 860 };
        int minimumWidth = 980;
        int minimumHeight = 620;
    };

    PluginEditorWindowGeometry getPluginEditorWindowGeometry(const juce::String& sessionId) const
    {
        const auto session = juce::JSON::parse(sessionId);
        auto pluginId = session.getProperty("pluginId", {}).toString().trim().toLowerCase();
        // New sessions carry the native ID. Exact known names keep old sessions
        // usable without classifying NAM or an unrelated custom title as compact.
        if (pluginId.isEmpty())
        {
            const auto fallbackName = session.getProperty("fallbackName", {}).toString().trim();
            const auto name = fallbackName.isNotEmpty() ? fallbackName : getPluginEditorTitleFromSession(sessionId);
            const std::pair<const char*, const char*> legacyNames[] {
                { "OpenStudio EQ", "eq" }, { "OpenStudio Graphic EQ", "geq" },
                { "OpenStudio Compressor", "compressor" }, { "OpenStudio Gate", "gate" },
                { "OpenStudio Limiter", "limiter" }, { "OpenStudio Preamp", "preamp" },
                { "OpenStudio Saturator", "saturator" }, { "OpenStudio Gain Phase", "utility" },
                { "OpenStudio Reverb", "reverb" }, { "OpenStudio Delay", "delay" },
                { "OpenStudio Chorus", "chorus" }, { "OpenStudio Basic Synth", "synth" },
                { "OpenStudio Piano", "piano" }, { "OpenStudio Clean Guitar", "guitar" },
                { "OpenStudio Drums", "drums" }
            };
            for (const auto& entry : legacyNames)
                if (name == entry.first) { pluginId = entry.second; break; }
        }
        const juce::StringArray compactIds { "eq", "geq", "compressor", "gate", "limiter", "preamp",
            "saturator", "utility", "reverb", "delay", "chorus", "synth", "piano", "guitar", "drums" };
        PluginEditorWindowGeometry result;
        if (compactIds.contains(pluginId))
        {
            result.minimumWidth = 640;
            result.minimumHeight = 480;
            result.preferred.setSize(pluginId == "chorus" ? 940 : 1040,
                                     pluginId == "chorus" ? 520 : pluginId == "delay" ? 620 : 680);
        }
        return result;
    }

    // All calls run on the message thread. Checkpoints outlive a retired WebView.
    juce::var handlePitchEditorSession(const juce::String& operation, const juce::var& payload,
                                      MainComponent::WindowRole sender, const juce::String& identity)
    {
        const bool fromMain = sender == MainComponent::WindowRole::main;
        const auto now = juce::Time::getMillisecondCounterHiRes();
        const auto recoveryFile = pitchRecoveryFileOverride.getFullPathName().isNotEmpty() ? pitchRecoveryFileOverride
            : getWritableStartupLogFile().getSiblingFile("OpenStudio_PitchRecovery.json");
        if (fromMain && operation == "ownerHeartbeat") {
            pitchOwnerHeartbeat = now;
            return true;
        }
        if (fromMain && operation == "tick") {
            if (pitchOwnerHeartbeat > 0 && now - pitchOwnerPing > 2000.0) {
                pitchOwnerPing = now;
                MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "pitchOwnerPing", {});
            }
            if (pitchOwnerHeartbeat > 0 && now - pitchOwnerHeartbeat > 15000.0) {
                pitchOwnerHeartbeat = 0;
                const auto clipId = pitchEditorCheckpoint.getProperty("pitch", {}).getProperty("clipId", {}).toString();
                if (clipId.isNotEmpty()) {
                    audioEngine->getPlaybackEngine().clearAllPitchPreviewRoutes(clipId);
                    audioEngine->stopPitchScrubPreview(clipId);
                    if (pitchEditorCheckpoint.getProperty("committedNotes", {}).isArray()) {
                        const auto checkpointText = juce::JSON::toString(pitchEditorCheckpoint);
                        pitchRecoveryCheckpoint = juce::JSON::parse(checkpointText);
                        recoveryFile.replaceWithText(checkpointText);
                    }
                }
                if (pitchEditorWindowManager) pitchEditorWindowManager->close();
                juce::Logger::writeToLog("Pitch session owner heartbeat expired; transient preview stopped, accepted checkpoint retained.");
            }
            return true;
        }
        if (fromMain && operation == "discardRecovery") {
            pitchRecoveryCheckpoint = juce::var(); recoveryFile.deleteFile(); return true;
        }
        const bool fromCurrentView = sender == MainComponent::WindowRole::pitchEditor
            && identity == pitchEditorViewId && identity.isNotEmpty();
        if (!fromMain && !fromCurrentView) return false;
        if (operation == "publish" && fromMain && payload.isObject())
        {
            const auto incomingSourceRevision = payload.getProperty("sourceRevision", {}).toString();
            const bool sourceChanged = incomingSourceRevision != pitchEditorCheckpoint.getProperty("sourceRevision", {}).toString();
            // Merge versioned field deltas so get always returns a full checkpoint.
            if (!pitchEditorCheckpoint.isObject()) pitchEditorCheckpoint = juce::var(new juce::DynamicObject());
            auto* checkpoint = pitchEditorCheckpoint.getDynamicObject();
            for (const auto& property : payload.getDynamicObject()->getProperties())
            {
                if (property.name == juce::Identifier("pitch") && property.value.isObject())
                {
                    if (!checkpoint->getProperty("pitch").isObject())
                        checkpoint->setProperty("pitch", juce::var(new juce::DynamicObject()));
                    auto* pitch = checkpoint->getProperty("pitch").getDynamicObject();
                    for (const auto& field : property.value.getDynamicObject()->getProperties())
                        pitch->setProperty(field.name, field.value);
                }
                else checkpoint->setProperty(property.name, property.value);
            }
            if (sourceChanged) {
                const auto source = checkpoint->getProperty("pitch").getProperty("originalClipFilePath", {}).toString();
                const juce::File sourceFile(source.isNotEmpty() ? source : juce::File::getSpecialLocation(juce::File::tempDirectory).getFullPathName());
                checkpoint->setProperty("sourceFingerprint", source.isNotEmpty() && sourceFile.existsAsFile()
                    ? juce::String(sourceFile.getSize()) + ":" + juce::String(sourceFile.getLastModificationTime().toMilliseconds()) : juce::String());
            }
            MainComponent::broadcastEventToRole(MainComponent::WindowRole::pitchEditor, "pitchEditorSnapshot", payload);
            return true;
        }
        if (operation == "get")
        {
            auto* reply = new juce::DynamicObject();
            if (fromMain && !pitchRecoveryCheckpoint.isObject() && recoveryFile.existsAsFile() && recoveryFile.getSize() < 33554432)
                pitchRecoveryCheckpoint = juce::JSON::parse(recoveryFile);
            bool recoverySourceMatches = false;
            const auto source = pitchRecoveryCheckpoint.getProperty("pitch", {}).getProperty("originalClipFilePath", {}).toString();
            if (source.isNotEmpty()) {
                const juce::File sourceFile(source);
                const auto fingerprint = juce::String(sourceFile.getSize()) + ":" + juce::String(sourceFile.getLastModificationTime().toMilliseconds());
                recoverySourceMatches = sourceFile.existsAsFile() && fingerprint == pitchRecoveryCheckpoint.getProperty("sourceFingerprint", {}).toString();
            }
            reply->setProperty("recovery", fromMain && recoverySourceMatches ? pitchRecoveryCheckpoint : juce::var());
            reply->setProperty("snapshot", pitchEditorCheckpoint);
            reply->setProperty("viewId", pitchEditorViewId);
            return juce::var(reply);
        }
        if (operation == "open" && fromMain)
        {
            pitchEditorCloseReason = "close";
            if (pitchEditorWindowManager == nullptr)
            {
                pitchEditorWindowManager = std::make_unique<MixerWindowManager>(
                    [this]() {
                        pitchEditorViewId = juce::Uuid().toString();
                        pitchEditorInteractive = false;
                        return std::make_unique<MainComponent>(*audioEngine, appUpdater, startupMode,
                            MainComponent::WindowRole::pitchEditor, createWindowCallbacks(), juce::String(), pitchEditorViewId);
                    },
                    [this](const juce::Rectangle<int>&) {
                        auto* closed = new juce::DynamicObject();
                        closed->setProperty("viewId", pitchEditorViewId);
                        closed->setProperty("reason", pitchEditorCloseReason);
                        pitchEditorViewId.clear();
                        pitchEditorInteractive = false;
                        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "pitchEditorClosed", juce::var(closed));
                    }, "Pitch Editor", juce::Rectangle<int>(160, 100, 1280, 800), 800, 480);
            }
            return pitchEditorWindowManager->open({});
        }
        if (operation == "close") {
            pitchEditorCloseReason = payload.isString() && payload.toString() == "dock" ? "dock" : "close";
            return pitchEditorWindowManager != nullptr && pitchEditorWindowManager->close();
        }
        if (operation == "status")
        {
            auto* state = new juce::DynamicObject();
            state->setProperty("interactive", pitchEditorInteractive);
            state->setProperty("viewId", pitchEditorViewId);
            state->setProperty("state", pitchEditorWindowManager ? pitchEditorWindowManager->getStateDescription() : juce::String("idle"));
            state->setProperty("frontendStartupState", pitchEditorWindowManager ? pitchEditorWindowManager->getFrontendStartupStateDescription() : juce::String("not-created"));
            return juce::var(state);
        }
        if ((operation == "command" || operation == "ready" || operation == "heartbeat") && fromCurrentView && payload.isObject())
        {
            if (juce::JSON::toString(payload, true).length() > 262144) return false;
            auto message = payload.getDynamicObject()->clone();
            message->setProperty("viewId", identity); // Never trust a JS-supplied identity.
            message->setProperty("operation", operation);
            MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "pitchEditorCommand", juce::var(message.release()));
            return true;
        }
        if (operation == "acceptReady" && fromMain)
        {
            pitchEditorInteractive = payload.toString() == pitchEditorViewId && pitchEditorViewId.isNotEmpty();
            return pitchEditorInteractive;
        }
        return false;
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
        obj->setProperty("frontendStartupState", existing != midiEditorWindowManagers.end() && existing->second != nullptr
                                                   ? existing->second->getFrontendStartupStateDescription()
                                                   : juce::String("not-created"));
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

        const auto editorTitle = getPluginEditorTitleFromSession(safeSessionId);
        const auto geometry = getPluginEditorWindowGeometry(safeSessionId);
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
            editorTitle,
            geometry.preferred,
            geometry.minimumWidth,
            geometry.minimumHeight);

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

    void closePluginEditorWindowsForRemovedSlots(const juce::String& trackId,
                                                const juce::String& chain, int firstIndex)
    {
        jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
        for (auto& entry : pluginEditorWindowManagers)
        {
            const auto session = juce::JSON::parse(entry.first);
            const auto address = session.getProperty("address", {});
            if (address.getProperty("chain", {}).toString() != chain)
                continue;
            if ((chain == "track" || chain == "input")
                && address.getProperty("trackId", {}).toString() != trackId)
                continue;
            const auto index = address.getProperty("fxIndex", -1);
            if (!index.isInt() || static_cast<int>(index) < firstIndex)
                continue;
            // Use the existing retired/delayed WebView teardown, including
            // cancellation of an editor queued behind another window's startup.
            if (entry.second != nullptr)
                entry.second->close();
        }
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

    void runWindowLifecycleHarness(const juce::File& reportFile, int editorReviewHoldMs = 0)
    {
        pitchRecoveryFileOverride = reportFile.getSiblingFile(reportFile.getFileNameWithoutExtension() + "-recovery.json");
        pitchRecoveryCheckpoint = juce::var();
        struct HarnessStep
        {
            juce::String id;
            int delayAfterMs = 400;
            std::function<bool()> action;
            int maxAttempts = 1;
            int retryDelayMs = 250;
        };

        const auto mixerBounds = juce::Rectangle<int>(120, 120, 1180, 520);
        const auto midiBounds = juce::Rectangle<int>(140, 100, 1180, 720);
        const auto pluginBounds = juce::Rectangle<int>(180, 90, 1040, 680);
        const juce::String midiSessionId = "window-lifecycle-midi";
        const juce::String pluginSessionId = R"({"title":"Window Lifecycle Harness","fallbackName":"OpenStudio EQ","pluginId":"eq","address":{"trackId":"window-lifecycle","chain":"track","fxIndex":0}})";
        constexpr int frontendReadyMaxAttempts = 120;
        constexpr int frontendReadyRetryDelayMs = 250;

        auto checks = std::make_shared<juce::Array<juce::var>>();
        auto inputEvidence = std::make_shared<juce::Array<juce::var>>();
        auto steps = std::make_shared<std::vector<HarnessStep>>();

        steps->push_back({ "main_frontend_ready", 0, [this]()
        {
            auto* component = mainWindow != nullptr ? mainWindow->getMainComponent() : nullptr;
            return component != nullptr && component->hasFrontendStartupSucceeded();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });

        const auto originalBounds = mainWindow->getBounds();
        const auto geometryBounds = originalBounds.withSizeKeepingCentre(1000, 700).translated(17, 13);
        steps->push_back({ "main_native_chrome", 0, [this]() {
            if (!mainWindow || !mainWindow->isUsingNativeTitleBar()) return false;
           #if JUCE_WINDOWS
            const auto hwnd = static_cast<HWND>(mainWindow->getPeer()->getNativeHandle());
            const auto style = ::GetWindowLongPtr(hwnd, GWL_STYLE);
            const auto required = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
            return (style & required) == required;
           #else
            return true;
           #endif
        }});
       #if JUCE_WINDOWS
        steps->push_back({ "main_dark_native_caption", 0, [this]() {
            BOOL dark = FALSE;
            return mainWindow && mainWindow->getPeer()
                && SUCCEEDED(::DwmGetWindowAttribute(static_cast<HWND>(mainWindow->getPeer()->getNativeHandle()), 20, &dark, sizeof(dark))) && dark;
        }});
       #endif
        steps->push_back({ "main_move_resize", 900, [this, geometryBounds]() {
            mainWindow->setBounds(geometryBounds);
            return mainWindow->getBounds() == geometryBounds;
        }});
        steps->push_back({ "main_bounds_stable", 0, [this, geometryBounds]() {
            return mainWindow->getBounds() == geometryBounds;
        }});
       #if JUCE_WINDOWS
        steps->push_back({ "main_os_maximize", 300, [this]() {
            auto hwnd = static_cast<HWND>(mainWindow->getPeer()->getNativeHandle());
            ::ShowWindow(hwnd, SW_MAXIMIZE);
            return ::IsZoomed(hwnd) != 0;
        }});
        steps->push_back({ "main_os_restore", 300, [this]() {
            auto hwnd = static_cast<HWND>(mainWindow->getPeer()->getNativeHandle());
            ::ShowWindow(hwnd, SW_RESTORE);
            return ::IsZoomed(hwnd) == 0 && ::IsIconic(hwnd) == 0;
        }});
        steps->push_back({ "main_os_minimize", 300, [this]() {
            auto hwnd = static_cast<HWND>(mainWindow->getPeer()->getNativeHandle());
            ::ShowWindow(hwnd, SW_MINIMIZE);
            return ::IsIconic(hwnd) != 0;
        }});
        steps->push_back({ "main_os_unminimize", 300, [this]() {
            auto hwnd = static_cast<HWND>(mainWindow->getPeer()->getNativeHandle());
            ::ShowWindow(hwnd, SW_RESTORE);
            return ::IsIconic(hwnd) == 0;
        }});
       #endif
        steps->push_back({ "main_restore_geometry", 300, [this, originalBounds]() {
            mainWindow->setBounds(originalBounds);
            return mainWindow->getBounds() == originalBounds;
        }});
        const auto probeDriver = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_AUDIO_PROBE_DRIVER", "");
        if (probeDriver.isNotEmpty())
            steps->push_back({ "audio_capability_query_preserves_active_setup", 0, [this, probeDriver, reportFile]() {
                const auto before = audioEngine->getAudioDeviceSetup();
                const auto stopsBefore = audioEngine->getAudioDebugSnapshot().getProperty("audioDeviceStopCount", {});
                auto* request = new juce::DynamicObject();
                request->setProperty("audioDeviceType", "ASIO");
                request->setProperty("inputDevice", probeDriver);
                request->setProperty("outputDevice", probeDriver);
                request->setProperty("sampleRate", 0);
                request->setProperty("bufferSize", 0);
                const auto capabilities = audioEngine->queryAudioDeviceSetup(juce::var(request));
                auto* evidence = new juce::DynamicObject();
                evidence->setProperty("before", before);
                evidence->setProperty("reported", capabilities);
                auto* wasapiRequest = new juce::DynamicObject();
                wasapiRequest->setProperty("audioDeviceType", "Windows Audio");
                evidence->setProperty("wasapiReported", audioEngine->queryAudioDeviceSetup(juce::var(wasapiRequest)));
                evidence->setProperty("after", audioEngine->getAudioDeviceSetup());
                evidence->setProperty("classification", "diagnostic_only: driver capability query, not a recording test");
                const bool wrote = writeHeadlessResult(reportFile.getSiblingFile(reportFile.getFileNameWithoutExtension() + "-audio.json"), juce::var(evidence));
                return wrote && juce::JSON::toString(before.getProperty("current", {}))
                    == juce::JSON::toString(audioEngine->getAudioDeviceSetup().getProperty("current", {}))
                    && stopsBefore == audioEngine->getAudioDebugSnapshot().getProperty("audioDeviceStopCount", {});
            }});
        steps->push_back({ "mixer_prewarm", 700, [this, mixerBounds]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->prewarm(mixerBounds);
        }});
        steps->push_back({ "mixer_open", 700, [this, mixerBounds]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->open(mixerBounds);
        }});
        steps->push_back({ "mixer_frontend_ready", 0, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
       #if JUCE_WINDOWS
        // Optional real desktop input: never infer this evidence from setBounds.
        const bool testDesktopInput = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_WINDOW_INPUT", "0") == "1";
        auto injectMouse = [](int x, int y, DWORD buttons) {
            INPUT input {};
            input.type = INPUT_MOUSE;
            const int left = ::GetSystemMetrics(SM_XVIRTUALSCREEN);
            const int top = ::GetSystemMetrics(SM_YVIRTUALSCREEN);
            input.mi.dx = static_cast<LONG>((static_cast<double>(x - left) * 65535.0) / juce::jmax(1, ::GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1));
            input.mi.dy = static_cast<LONG>((static_cast<double>(y - top) * 65535.0) / juce::jmax(1, ::GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1));
            input.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE | buttons;
            return ::SendInput(1, &input, sizeof(INPUT)) == 1;
        };
        auto addInputChecks = [steps, inputEvidence, testDesktopInput, injectMouse](const juce::String& role, std::function<juce::DocumentWindow*()> getWindow) {
            if (!testDesktopInput) return;
            struct InputGeometry { RECT before {}; POINT saved {}; int x = 0; int y = 0; HWND hwnd = nullptr; };
            auto inputState = std::make_shared<InputGeometry>();
            steps->push_back({ role + "_input_prepare", 400, [getWindow, inputState]() {
                auto* window = getWindow();
                if (!window || !window->getPeer()) return false;
                inputState->hwnd = static_cast<HWND>(window->getPeer()->getNativeHandle());
                ::GetCursorPos(&inputState->saved);
                ::ShowWindow(inputState->hwnd, SW_RESTORE);
                ::SetForegroundWindow(inputState->hwnd);
                return ::GetWindowRect(inputState->hwnd, &inputState->before) != 0;
            } });
            steps->push_back({ role + "_input_title_down", 200, [inputState, injectMouse]() {
                const auto& r = inputState->before;
                inputState->x = r.left + (r.right - r.left) / 3;
                inputState->y = r.top + ::GetSystemMetricsForDpi(SM_CYFRAME, ::GetDpiForWindow(inputState->hwnd))
                    + ::GetSystemMetricsForDpi(SM_CYCAPTION, ::GetDpiForWindow(inputState->hwnd)) / 2;
                const auto hit = ::SendMessage(inputState->hwnd, WM_NCHITTEST, 0, MAKELPARAM(inputState->x, inputState->y));
                return hit == HTCAPTION && injectMouse(inputState->x, inputState->y, MOUSEEVENTF_LEFTDOWN);
            } });
            steps->push_back({ role + "_input_title_threshold", 200, [inputState, injectMouse]() {
                return injectMouse(inputState->x + 6, inputState->y + 4, 0);
            } });
            steps->push_back({ role + "_input_title_move", 200, [inputState, injectMouse]() {
                return injectMouse(inputState->x + 60, inputState->y + 40, 0);
            } });
            steps->push_back({ role + "_input_title_up", 300, [inputState, injectMouse]() {
                return injectMouse(inputState->x + 60, inputState->y + 40, MOUSEEVENTF_LEFTUP);
            } });
            steps->push_back({ role + "_input_drag_verified", 0, [inputState, inputEvidence, role]() {
                RECT actual {}; ::GetWindowRect(inputState->hwnd, &actual);
                juce::Logger::writeToLog("[windowInput] drag delta=" + juce::String(actual.left - inputState->before.left)
                    + "," + juce::String(actual.top - inputState->before.top)
                    + " foreground=" + juce::String(::GetForegroundWindow() == inputState->hwnd ? "yes" : "no"));
                auto* evidence = new juce::DynamicObject();
                evidence->setProperty("role", role);
                evidence->setProperty("input", "SendInput");
                evidence->setProperty("dpi", static_cast<int>(::GetDpiForWindow(inputState->hwnd)));
                evidence->setProperty("fromX", static_cast<int>(inputState->before.left));
                evidence->setProperty("fromY", static_cast<int>(inputState->before.top));
                evidence->setProperty("toX", static_cast<int>(actual.left));
                evidence->setProperty("toY", static_cast<int>(actual.top));
                evidence->setProperty("expectedDeltaX", 54);
                evidence->setProperty("expectedDeltaY", 36);
                inputEvidence->add(juce::var(evidence));
                // DefWindowProc starts SC_MOVE after the initial 6x4 threshold
                // movement. Only the following 54x36 motion moves the window.
                return std::abs(actual.left - inputState->before.left - 54) <= 3
                    && std::abs(actual.top - inputState->before.top - 36) <= 3;
            } });
            steps->push_back({ role + "_input_resize_down", 200, [inputState, injectMouse]() {
                ::GetWindowRect(inputState->hwnd, &inputState->before);
                inputState->x = inputState->before.right - 2; inputState->y = inputState->before.bottom - 2;
                const auto hit = ::SendMessage(inputState->hwnd, WM_NCHITTEST, 0, MAKELPARAM(inputState->x, inputState->y));
                return hit == HTBOTTOMRIGHT && injectMouse(inputState->x, inputState->y, MOUSEEVENTF_LEFTDOWN);
            } });
            steps->push_back({ role + "_input_resize_move", 200, [inputState, injectMouse]() {
                return injectMouse(inputState->x + 40, inputState->y + 30, 0);
            } });
            steps->push_back({ role + "_input_resize_up", 300, [inputState, injectMouse]() {
                return injectMouse(inputState->x + 40, inputState->y + 30, MOUSEEVENTF_LEFTUP);
            } });
            steps->push_back({ role + "_input_resize_verified", 0, [inputState]() {
                RECT actual {}; ::GetWindowRect(inputState->hwnd, &actual);
                ::SetCursorPos(inputState->saved.x, inputState->saved.y);
                return std::abs((actual.right - actual.left) - (inputState->before.right - inputState->before.left) - 40) <= 3
                    && std::abs((actual.bottom - actual.top) - (inputState->before.bottom - inputState->before.top) - 30) <= 3;
            } });
        };
        addInputChecks("main", [this]() { return mainWindow.get(); });
       #endif
        auto addGeometryChecks = [steps](const juce::String& role, std::function<juce::DocumentWindow*()> getWindow)
        {
            auto expected = std::make_shared<juce::Rectangle<int>>();
            steps->push_back({ role + "_native_move_resize", 900, [getWindow, expected]() {
                auto* window = getWindow();
                if (!window || !window->isUsingNativeTitleBar()) return false;
                *expected = window->getBounds().translated(11, 9).withWidth(window->getWidth() + 20);
                window->setBounds(*expected);
                return window->getBounds() == *expected;
            }});
            steps->push_back({ role + "_bounds_stable", 0, [getWindow, expected]() {
                return getWindow() && getWindow()->getBounds() == *expected;
            }});
           #if JUCE_WINDOWS
            steps->push_back({ role + "_dark_native_caption", 0, [getWindow]() {
                auto* window = getWindow();
                BOOL dark = FALSE;
                return window && window->getPeer()
                    && SUCCEEDED(::DwmGetWindowAttribute(static_cast<HWND>(window->getPeer()->getNativeHandle()), 20, &dark, sizeof(dark))) && dark;
            }});
            steps->push_back({ role + "_os_maximize_restore", 300, [getWindow]() {
                auto* window = getWindow();
                if (!window || !window->getPeer()) return false;
                auto hwnd = static_cast<HWND>(window->getPeer()->getNativeHandle());
                ::ShowWindow(hwnd, SW_MAXIMIZE);
                const bool maximized = ::IsZoomed(hwnd) != 0;
                ::ShowWindow(hwnd, SW_RESTORE);
                return maximized && !::IsZoomed(hwnd) && !::IsIconic(hwnd);
            }});
           #endif
        };
        addGeometryChecks("mixer", [this]() { return mixerWindowManager->getNativeWindow(); });
       #if JUCE_WINDOWS
        addInputChecks("mixer", [this]() { return mixerWindowManager->getNativeWindow(); });
       #endif
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
        steps->push_back({ "mixer_reopened_frontend_ready", 0, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        steps->push_back({ "mixer_final_close", 2200, [this]()
        {
            return mixerWindowManager != nullptr && mixerWindowManager->close();
        }});

        if (startupMode == MainComponent::StartupMode::normal)
        {
            const auto pitchFixture = reportFile.getSiblingFile(reportFile.getFileNameWithoutExtension() + "-pitch.wav").getNonexistentSibling();
            steps->push_back({ "pitch_fixture_setup", 500, [this, pitchFixture]() {
                juce::AudioBuffer<float> samples(1, 144000);
                for (int sample = 0; sample < samples.getNumSamples(); ++sample)
                    samples.setSample(0, sample, 0.15f * std::sin(juce::MathConstants<float>::twoPi * 220.0f * static_cast<float>(sample) / 48000.0f));
                juce::WavAudioFormat wav;
                std::unique_ptr<juce::OutputStream> output = pitchFixture.createOutputStream();
                if (!output) return false;
                auto writer = wav.createWriterFor(output, juce::AudioFormatWriterOptions()
                    .withSampleRate(48000.0).withNumChannels(1).withBitsPerSample(16));
                if (!writer || !writer->writeFromAudioSampleBuffer(samples, 0, samples.getNumSamples())) return false;
                writer.reset();
                audioEngine->addTrack("window-lifecycle-pitch");
                audioEngine->addPlaybackClip("window-lifecycle-pitch", pitchFixture.getFullPathName(), 0, 3, 0, 0, 0, 0, "window-lifecycle-pitch-clip");
                auto* payload = new juce::DynamicObject();
                payload->setProperty("filePath", pitchFixture.getFullPathName());
                MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "pitchEditorHarness", juce::var(payload));
                return true;
            } });
            steps->push_back({ "pitch_analysis_hydrated", 0, [this]() {
                const auto pitch = pitchEditorCheckpoint.getProperty("pitch", {});
                return pitch.getProperty("clipId", {}).toString() == "window-lifecycle-pitch-clip"
                    && pitch.getProperty("contour", {}).isObject() && !static_cast<bool>(pitch.getProperty("isAnalyzing", true));
            }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
            const int pitchCycles = juce::jlimit(2, 50, juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_WINDOW_CYCLES", "2").getIntValue());
            for (int cycle = 0; cycle < pitchCycles; ++cycle)
            {
                const auto prefix = "pitch_cycle_" + juce::String(cycle + 1);
                steps->push_back({ prefix + "_open", 700, [this]() {
                    return static_cast<bool>(handlePitchEditorSession("open", {}, MainComponent::WindowRole::main, {}));
                } });
                steps->push_back({ prefix + "_interactive_ready", 0, [this]() {
                    return pitchEditorWindowManager && pitchEditorWindowManager->isFrontendReady() && pitchEditorInteractive;
                }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
                if (cycle == 0) {
                    steps->push_back({ "pitch_edit_with_main_minimized", 500, [this]() {
                        mainWindow->setMinimised(true);
                        MainComponent::broadcastEventToRole(MainComponent::WindowRole::pitchEditor, "pitchEditorHarnessEdit", "relative+4");
                        return true;
                    } });
                    steps->push_back({ "pitch_native_relative_shift_committed", 0, [this]() {
                        const auto notes = pitchEditorCheckpoint.getProperty("committedNotes", {});
                        if (!notes.isArray() || notes.size() == 0) return false;
                        for (const auto& note : *notes.getArray())
                            if (std::abs(static_cast<double>(note.getProperty("correctedPitch", 0))
                                - static_cast<double>(note.getProperty("detectedPitch", 0)) - 4.0) > 1.0e-6) return false;
                        return true;
                    }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
                    steps->push_back({ "pitch_native_correction_file_published", 0, [this, pitchFixture]() {
                        const auto tracks = pitchEditorCheckpoint.getProperty("daw", {}).getProperty("tracks", {});
                        if (!tracks.isArray() || tracks.size() == 0) return false;
                        const auto clips = tracks[0].getProperty("clips", {});
                        if (!clips.isArray() || clips.size() == 0) return false;
                        const auto path = clips[0].getProperty("filePath", {}).toString();
                        return path.isNotEmpty() && path != pitchFixture.getFullPathName() && juce::File(path).existsAsFile();
                    }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
                    steps->push_back({ "pitch_native_undo", 500, []() {
                        MainComponent::broadcastEventToRole(MainComponent::WindowRole::pitchEditor, "pitchEditorHarnessEdit", "undo");
                        return true;
                    } });
                    steps->push_back({ "pitch_native_undo_preserved", 0, [this]() {
                        const auto notes = pitchEditorCheckpoint.getProperty("committedNotes", {});
                        if (!notes.isArray() || notes.size() == 0) return false;
                        for (const auto& note : *notes.getArray())
                            if (std::abs(static_cast<double>(note.getProperty("correctedPitch", 0))
                                - static_cast<double>(note.getProperty("detectedPitch", 0))) > 1.0e-6) return false;
                        mainWindow->setMinimised(false);
                        return true;
                    }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
                    addGeometryChecks("pitch", [this]() { return pitchEditorWindowManager->getNativeWindow(); });
                   #if JUCE_WINDOWS
                    addInputChecks("pitch", [this]() { return pitchEditorWindowManager->getNativeWindow(); });
                   #endif
                }
                steps->push_back({ prefix + "_close", cycle == 0 ? 50 : 2200, [this]() {
                    return static_cast<bool>(handlePitchEditorSession("close", {}, MainComponent::WindowRole::main, {}));
                } });
            }
            steps->push_back({ "pitch_checkpoint_preserved", 0, [this]() {
                const auto pitch = pitchEditorCheckpoint.getProperty("pitch", {});
                return pitch.getProperty("clipId", {}).toString() == "window-lifecycle-pitch-clip"
                    && pitch.getProperty("contour", {}).isObject() && !pitchEditorInteractive;
            } });

            steps->push_back({ "pitch_owner_loss_retains_checkpoint", 0, [this]() {
                pitchOwnerHeartbeat = juce::Time::getMillisecondCounterHiRes() - 16000.0;
                handlePitchEditorSession("tick", {}, MainComponent::WindowRole::main, {});
                const bool retained = pitchRecoveryCheckpoint.getProperty("committedNotes", {}).isArray()
                    && pitchRecoveryFileOverride.existsAsFile();
                handlePitchEditorSession("discardRecovery", {}, MainComponent::WindowRole::main, {});
                return retained;
            } });

        }
        else
        {
            // Safe Mode mounts recovery UI in each browser role. It cannot
            // acknowledge normal pitch analysis/editing session messages.
            const int pitchCycles = juce::jlimit(2, 50, juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_WINDOW_CYCLES", "2").getIntValue());
            for (int cycle = 0; cycle < pitchCycles; ++cycle)
            {
                const auto prefix = "pitch_safe_cycle_" + juce::String(cycle + 1);
                steps->push_back({ prefix + "_open", 700, [this]() {
                    return static_cast<bool>(handlePitchEditorSession("open", {}, MainComponent::WindowRole::main, {}));
                } });
                steps->push_back({ prefix + "_frontend_ready", 0, [this]() {
                    return pitchEditorWindowManager && pitchEditorWindowManager->isFrontendReady();
                }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
                if (cycle == 0)
                    addGeometryChecks("pitch", [this]() { return pitchEditorWindowManager->getNativeWindow(); });
                steps->push_back({ prefix + "_close", cycle == 0 ? 50 : 2200, [this]() {
                    return static_cast<bool>(handlePitchEditorSession("close", {}, MainComponent::WindowRole::main, {}));
                } });
            }
        }

        steps->push_back({ "midi_prewarm", 700, [this, midiSessionId, midiBounds]()
        {
            return prewarmMidiEditorWindow(midiSessionId, rectangleToVar(midiBounds));
        }});
        steps->push_back({ "midi_focus", 300, [this, midiSessionId]()
        {
            return focusMidiEditorWindow(midiSessionId);
        }});
        steps->push_back({ "midi_frontend_ready", 0, [this, midiSessionId]()
        {
            const auto existing = midiEditorWindowManagers.find(midiSessionId);
            return existing != midiEditorWindowManagers.end()
                && existing->second != nullptr
                && existing->second->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        addGeometryChecks("midi", [this, midiSessionId]() { return midiEditorWindowManagers.at(midiSessionId)->getNativeWindow(); });
       #if JUCE_WINDOWS
        addInputChecks("midi", [this, midiSessionId]() { return midiEditorWindowManagers.at(midiSessionId)->getNativeWindow(); });
       #endif
        steps->push_back({ "midi_close", 50, [this, midiSessionId]()
        {
            return closeMidiEditorWindow(midiSessionId, "close");
        }});
        steps->push_back({ "midi_reopen_while_closing", 3000, [this, midiSessionId, midiBounds]()
        {
            return openMidiEditorWindow(midiSessionId, rectangleToVar(midiBounds));
        }});
        steps->push_back({ "midi_reopened_frontend_ready", 0, [this, midiSessionId]()
        {
            const auto existing = midiEditorWindowManagers.find(midiSessionId);
            return existing != midiEditorWindowManagers.end()
                && existing->second != nullptr
                && existing->second->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        steps->push_back({ "midi_final_close", 2200, [this, midiSessionId]()
        {
            return closeMidiEditorWindow(midiSessionId, "close");
        }});

        steps->push_back({ "plugin_editor_geometry_contract", 0, [this]()
        {
            for (const auto& id : juce::StringArray { "eq", "geq", "compressor", "gate", "limiter", "preamp",
                     "saturator", "utility", "reverb", "delay", "chorus", "synth", "piano", "guitar", "drums" })
            {
                auto* session = new juce::DynamicObject();
                session->setProperty("pluginId", id);
                session->setProperty("title", "Custom editor title");
                const auto geometry = getPluginEditorWindowGeometry(juce::JSON::toString(juce::var(session)));
                if (geometry.minimumWidth != 640 || geometry.minimumHeight != 480
                    || geometry.preferred.getWidth() != (id == "chorus" ? 940 : 1040)
                    || geometry.preferred.getHeight() != (id == "chorus" ? 520 : id == "delay" ? 620 : 680))
                    return false;
            }
            const auto legacy = getPluginEditorWindowGeometry(R"({"title":"OpenStudio Chorus"})");
            const auto nam = getPluginEditorWindowGeometry(R"({"pluginId":"nam","title":"OpenStudio NAM Rack"})");
            const auto external = getPluginEditorWindowGeometry(R"({"pluginId":"external","title":"OpenStudio EQ"})");
            return legacy.minimumWidth == 640 && legacy.preferred.getWidth() == 940
                && nam.minimumWidth == 980 && nam.minimumHeight == 620 && nam.preferred.getWidth() == 1320
                && external.minimumWidth == 980 && external.preferred.getHeight() == 860;
        }});
        steps->push_back({ "plugin_open", 700, [this, pluginSessionId, pluginBounds]()
        {
            audioEngine->addTrack("window-lifecycle");
            return audioEngine->addTrackBuiltInFX("window-lifecycle", "OpenStudio EQ")
                && openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds));
        }});
        steps->push_back({ "plugin_frontend_ready", 0, [this, pluginSessionId]()
        {
            const auto existing = pluginEditorWindowManagers.find(pluginSessionId);
            return existing != pluginEditorWindowManagers.end()
                && existing->second != nullptr
                && existing->second->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        steps->push_back({ "plugin_compact_native_resize", 900, [this, pluginSessionId, pluginBounds]()
        {
            auto* window = pluginEditorWindowManagers.at(pluginSessionId)->getNativeWindow();
            auto* constrainer = window != nullptr ? window->getConstrainer() : nullptr;
            if (constrainer == nullptr || constrainer->getMinimumWidth() != 640 || constrainer->getMinimumHeight() != 480)
                return false;
            constrainer->setBoundsForComponent(window, pluginBounds.withSize(640, 480), false, false, true, true);
            return window->getWidth() == 640 && window->getHeight() == 480;
        }});
        steps->push_back({ "plugin_compact_bounds_stable", 0, [this, pluginSessionId]()
        {
            auto* window = pluginEditorWindowManagers.at(pluginSessionId)->getNativeWindow();
            return window != nullptr && window->getWidth() == 640 && window->getHeight() == 480
                && pluginEditorWindowManagers.at(pluginSessionId)->isFrontendReady();
        }});
        steps->push_back({ "plugin_restore_preferred_geometry", 300, [this, pluginSessionId, pluginBounds]()
        {
            auto* window = pluginEditorWindowManagers.at(pluginSessionId)->getNativeWindow();
            if (window == nullptr) return false;
            window->setBounds(pluginBounds);
            return window->getBounds() == pluginBounds;
        }});
        if (editorReviewHoldMs > 0)
            steps->push_back({ "plugin_editor_review_hold", editorReviewHoldMs, []() { return true; } });
        addGeometryChecks("plugin", [this, pluginSessionId]() { return pluginEditorWindowManagers.at(pluginSessionId)->getNativeWindow(); });
       #if JUCE_WINDOWS
        addInputChecks("plugin", [this, pluginSessionId]() { return pluginEditorWindowManagers.at(pluginSessionId)->getNativeWindow(); });
       #endif
        steps->push_back({ "plugin_close", 50, [this, pluginSessionId]()
        {
            return closePluginEditorWindow(pluginSessionId, "close");
        }});
        steps->push_back({ "plugin_reopen_while_closing", 3000, [this, pluginSessionId, pluginBounds]()
        {
            return openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds));
        }});
        steps->push_back({ "plugin_reopened_frontend_ready", 0, [this, pluginSessionId]()
        {
            const auto existing = pluginEditorWindowManagers.find(pluginSessionId);
            return existing != pluginEditorWindowManagers.end()
                && existing->second != nullptr
                && existing->second->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        // Exercise the real engine removal paths while a different track's
        // editor stays open. Include an editor shifted by an earlier removal.
        for (const auto& chain : juce::StringArray { "track", "input", "master", "monitor" })
        {
            const juce::String testTrack("window-lifecycle-removal");
            const int editorIndex = chain == "track" ? 1 : 0;
            auto* address = new juce::DynamicObject();
            address->setProperty("trackId", testTrack);
            address->setProperty("chain", chain);
            address->setProperty("fxIndex", editorIndex);
            auto* session = new juce::DynamicObject();
            session->setProperty("address", juce::var(address));
            session->setProperty("title", "Removal " + chain);
            session->setProperty("fallbackName", chain == "monitor" ? "OpenStudio NAM Rack" : "OpenStudio EQ");
            const auto removalSession = juce::JSON::toString(juce::var(session), true);
            steps->push_back({ "plugin_" + chain + "_removal_open", 1600,
                [this, chain, testTrack, editorIndex, removalSession, pluginBounds]()
            {
                if (chain == "track") audioEngine->addTrack(testTrack);
                for (int index = 0; index <= editorIndex; ++index)
                {
                    const bool added = chain == "master"
                        ? audioEngine->addMasterBuiltInFX("OpenStudio EQ")
                        : chain == "monitor"
                            ? audioEngine->addMonitoringFX("OpenStudio NAM Rack")
                            : audioEngine->addTrackBuiltInFX(testTrack, "OpenStudio EQ", chain == "input");
                    if (!added) return false;
                }
                return openPluginEditorWindow(removalSession, rectangleToVar(pluginBounds));
            }});
            steps->push_back({ "plugin_" + chain + "_removal_ready", 0, [this, removalSession]()
            {
                const auto found = pluginEditorWindowManagers.find(removalSession);
                return found != pluginEditorWindowManagers.end() && found->second->isFrontendReady();
            }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
            steps->push_back({ "plugin_" + chain + "_failed_removal_keeps_editor", 0,
                [this, chain, testTrack, removalSession]()
            {
                bool removed = false;
                if (chain == "monitor") audioEngine->removeMonitoringFX(9999);
                else if (chain == "master") removed = audioEngine->removeMasterFX(9999);
                else removed = chain == "input" ? audioEngine->removeTrackInputFX(testTrack, 9999)
                                                 : audioEngine->removeTrackFX(testTrack, 9999);
                return !removed && pluginEditorWindowManagers.at(removalSession)->isOpen();
            }});
            steps->push_back({ "plugin_" + chain + "_removal_closes_editor", 2200,
                [this, chain, testTrack, removalSession, pluginSessionId]()
            {
                bool removed = true;
                if (chain == "monitor") audioEngine->removeMonitoringFX(0);
                else if (chain == "master") removed = audioEngine->removeMasterFX(0);
                else removed = chain == "input" ? audioEngine->removeTrackInputFX(testTrack, 0)
                                                 : audioEngine->removeTrackFX(testTrack, 0);
                return removed && !pluginEditorWindowManagers.at(removalSession)->isOpen()
                    && pluginEditorWindowManagers.at(pluginSessionId)->isOpen();
            }});
        }
        steps->push_back({ "plugin_final_close", 2200, [this, pluginSessionId]()
        {
            return audioEngine->removeTrackFX("window-lifecycle", 0)
                && !pluginEditorWindowManagers.at(pluginSessionId)->isOpen();
        }});
        steps->push_back({ "plugin_removal_reopen_setup", 1600, [this, pluginSessionId, pluginBounds]()
        {
            return audioEngine->addTrackBuiltInFX("window-lifecycle", "OpenStudio EQ")
                && openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds));
        }});
        steps->push_back({ "plugin_removal_reopen_ready", 0, [this, pluginSessionId]()
        {
            return pluginEditorWindowManagers.at(pluginSessionId)->isFrontendReady();
        }, frontendReadyMaxAttempts, frontendReadyRetryDelayMs });
        steps->push_back({ "plugin_track_delete_cancels_queued_reopen", 3000,
            [this, pluginSessionId, pluginBounds]()
        {
            return closePluginEditorWindow(pluginSessionId, "close")
                && openPluginEditorWindow(pluginSessionId, rectangleToVar(pluginBounds))
                && audioEngine->removeTrack("window-lifecycle")
                && !pluginEditorWindowManagers.at(pluginSessionId)->isOpen();
        }});
        steps->push_back({ "plugin_removed_editor_stays_closed", 0, [this, pluginSessionId]()
        {
            return pluginEditorWindowManagers.at(pluginSessionId)->getStateDescription() == "idle";
        }});

        steps->push_back({ "no_orphan_secondary_browser_components", 0, []() {
            const auto counts = MainComponent::getBrowserInstanceCounts();
            return static_cast<int>(counts.getProperty("main", 0)) == 1
                && static_cast<int>(counts.getProperty("secondary", -1)) == 0
                && static_cast<int>(counts.getProperty("retiring", -1)) == 0;
        }, 20, 250 });

        auto stepIndex = std::make_shared<size_t>(0);
        auto stepAttempt = std::make_shared<int>(0);
        auto runner = std::make_shared<std::function<void()>>();
        const std::weak_ptr<std::function<void()>> weakRunner = runner;
        *runner = [this, reportFile, checks, inputEvidence, steps, stepIndex, stepAttempt, weakRunner, midiSessionId]() mutable
        {
            // Timers own the next invocation. The function must not own itself,
            // otherwise all check results survive application shutdown.
            const auto runner = weakRunner.lock();
            if (runner == nullptr)
                return;
            if (*stepIndex >= steps->size())
            {
                const bool success = ! hasFailedHarnessCheck(*checks);
                auto* root = new juce::DynamicObject();
                root->setProperty("harnessMode", "window_lifecycle");
                root->setProperty("startupMode", startupMode == MainComponent::StartupMode::safe ? "safe" : "normal");
                root->setProperty("pitchEditing", startupMode == MainComponent::StartupMode::safe ? "not_asserted: recovery UI only" : "objective normal-mode editing checks");
                root->setProperty("success", success);
                root->setProperty("checks", juce::var(*checks));
                root->setProperty("nativeBrowserComponents", MainComponent::getBrowserInstanceCounts());
                root->setProperty("inputMeasurements", juce::var(*inputEvidence));
                root->setProperty("platform", juce::SystemStats::getOperatingSystemName());
                root->setProperty("multiMonitorDpi", "not_asserted");
                root->setProperty("pitchState", handlePitchEditorSession("status", {}, MainComponent::WindowRole::main, {}));
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
            ++(*stepAttempt);

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

            if (! ok && *stepAttempt < step.maxAttempts)
            {
                juce::Logger::writeToLog("[windowLifecycleHarness] " + step.id
                                         + " waiting attempt=" + juce::String(*stepAttempt)
                                         + "/" + juce::String(step.maxAttempts));
                juce::Timer::callAfterDelay(step.retryDelayMs, [runner]()
                {
                    if (runner != nullptr && *runner)
                        (*runner)();
                });
                return;
            }

            if (step.maxAttempts > 1)
                detail = ok ? "frontend ready" : "frontend did not reach ready state";

            addHarnessCheck(*checks, step.id, ok ? "pass" : "fail", detail);
            juce::Logger::writeToLog("[windowLifecycleHarness] " + step.id + " " + detail);
            *stepAttempt = 0;
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

    std::unique_ptr<juce::FileLogger> startupLogger;
    std::unique_ptr<AudioEngine> audioEngine;
    AppUpdater appUpdater;
    std::unique_ptr<juce::DocumentWindow> storeQueryWindow;
    MainComponent::StartupMode startupMode = MainComponent::StartupMode::normal;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MixerWindowManager> mixerWindowManager;
    std::unique_ptr<MixerWindowManager> pitchEditorWindowManager;
    juce::var pitchEditorCheckpoint;
    juce::var pitchRecoveryCheckpoint;
    juce::File pitchRecoveryFileOverride;
    double pitchOwnerHeartbeat = 0;
    double pitchOwnerPing = 0;
    juce::String pitchEditorViewId;
    juce::String pitchEditorCloseReason = "close";
    bool pitchEditorInteractive = false;
    std::map<juce::String, std::unique_ptr<MixerWindowManager>> midiEditorWindowManagers;
    std::map<juce::String, std::unique_ptr<MixerWindowManager>> pluginEditorWindowManagers;
    mutable juce::CriticalSection mixerSnapshotLock;
    juce::var latestMixerUISnapshot;
    mutable juce::CriticalSection midiEditorSnapshotLock;
    std::map<juce::String, juce::var> latestMidiEditorUISnapshots;
    std::map<juce::String, juce::String> midiEditorWindowCloseReasons;
};

START_JUCE_APPLICATION (OpenStudioApplication)
