#include <JuceHeader.h>
#include "ApplicationLaunchState.h"
#include "AudioEngine.h"
#include "AppUpdater.h"
#include "MainComponent.h"
#include "MixerWindowManager.h"

#include <cmath>
#include <cstdlib>

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
        // Raise process priority so the audio thread is less likely to be preempted
        // by competing background processes. ASIO drivers handle thread priority
        // themselves (via MMCSS), but HIGH_PRIORITY_CLASS reduces scheduler jitter
        // from other apps at 32-sample buffer sizes.
       #if JUCE_WINDOWS
        ::SetPriorityClass(::GetCurrentProcess(), HIGH_PRIORITY_CLASS);
       #endif

        OpenStudioLaunchState::setPendingProjectPath(commandLine);
        const auto startupSelfTestMode = commandLineHasFlag(commandLine, "--startup-self-test");
        const auto startupSelfTestReportPath = getCommandLineOptionValue(commandLine, "--report");
        const auto pitchRegressionHeadlessJobPath = getCommandLineOptionValue(commandLine, "--pitch-regression-headless");
        const auto pitchRegressionJobPath = getCommandLineOptionValue(commandLine, "--pitch-regression");
        startupMode = commandLineHasFlag(commandLine, "--ui-safe-mode")
            ? MainComponent::StartupMode::safe
            : MainComponent::StartupMode::normal;

        auto logFile = getWritableStartupLogFile();
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

        if (pitchRegressionHeadlessJobPath.isNotEmpty())
        {
            const auto exitCode = runHeadlessPitchRegressionJob(audioEngine, pitchRegressionHeadlessJobPath);
            setApplicationReturnValue(exitCode);
            quit();
            return;
        }

        mixerWindowManager = std::make_unique<MixerWindowManager>(
            [this]()
            {
                return std::make_unique<MainComponent>(audioEngine,
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
                                                  audioEngine,
                                                  appUpdater,
                                                  startupMode,
                                                  createWindowCallbacks(),
                                                  pitchRegressionJobPath);

        if (auto* component = mainWindow->getMainComponent())
            audioEngine.setPluginWindowOwnerComponent(component);

        audioEngine.onPeaksReady = [] (const juce::String& filePath)
        {
            auto* data = new juce::DynamicObject();
            data->setProperty("filePath", filePath);
            MainComponent::broadcastEventToAll("peaksReady", juce::var(data));
        };

        appUpdater.setStatusCallback([](const juce::var& status)
        {
            MainComponent::broadcastEventToAll("updateStatusChanged", status);
        });

        audioEngine.setPluginWindowShortcutForwardCallback([](const juce::var& payload)
        {
            MainComponent::broadcastEventToAll("nativeGlobalShortcut", payload);
        });

        juce::Logger::writeToLog("MainWindow Created.");
    }

    void shutdown() override
    {
        juce::Logger::writeToLog("Application Check-out.");

        mixerWindowManager = nullptr;
        mainWindow = nullptr;

        juce::Logger::setCurrentLogger(nullptr);
    }

    void systemRequestedQuit() override
    {
        if (mixerWindowManager != nullptr)
            mixerWindowManager->close();

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

    void handleMixerWindowClosed(const juce::Rectangle<int>& bounds)
    {
        if (auto* component = mainWindow != nullptr ? mainWindow->getMainComponent() : nullptr)
            audioEngine.setPluginWindowOwnerComponent(component);

        auto* payload = new juce::DynamicObject();
        payload->setProperty("bounds", rectangleToVar(bounds));
        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "mixerWindowClosed", juce::var(payload));
    }

    AudioEngine audioEngine;
    AppUpdater appUpdater;
    MainComponent::StartupMode startupMode = MainComponent::StartupMode::normal;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MixerWindowManager> mixerWindowManager;
    mutable juce::CriticalSection mixerSnapshotLock;
    juce::var latestMixerUISnapshot;
};

START_JUCE_APPLICATION (OpenStudioApplication)
