#include "PitchRenderBackend.h"

#include <algorithm>
#include <cmath>
#include <map>

#ifndef S13_HAS_RUBBERBAND_LIBRARY
#define S13_HAS_RUBBERBAND_LIBRARY 0
#endif

#if S13_HAS_RUBBERBAND_LIBRARY
#include <rubberband/RubberBandStretcher.h>
#endif

namespace PitchRendering
{
namespace
{

constexpr const char* kRubberBandHqBackendId = "rubberband_hq";
constexpr const char* kNativeHqV4BackendId = "native_hq_v4";

juce::String getPathSeparator()
{
#if JUCE_WINDOWS
    return ";";
#else
    return ":";
#endif
}

juce::File getApplicationRuntimeDirectory()
{
    return juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
}

bool hasRubberBandLibrary()
{
#if S13_HAS_RUBBERBAND_LIBRARY
    return true;
#else
    return false;
#endif
}

juce::String normaliseBackendId (juce::String backendId)
{
    backendId = backendId.trim().toLowerCase();

    if (backendId.isEmpty() || backendId == "auto" || backendId == "rubberband" || backendId == "external_rubberband_phrase_hq")
        return kRubberBandHqBackendId;

    if (backendId == "native" || backendId == "engine_v4")
        return kNativeHqV4BackendId;

    return backendId;
}

juce::Array<juce::var> buildCapabilityList (const PitchRenderBackend::Capabilities& capabilities)
{
    juce::Array<juce::var> values;

    if (capabilities.preview) values.add ("preview");
    if (capabilities.offlineHq) values.add ("offline_hq");
    if (capabilities.araPlugin) values.add ("ara_plugin");
    if (capabilities.phraseOrClipContext) values.add ("phrase_or_clip_context");
    if (capabilities.variablePitchMap) values.add ("variable_pitch_map");
    if (capabilities.formantPreservation) values.add ("formant_preservation");
    if (capabilities.explicitFormantControl) values.add ("explicit_formant_control");
    if (capabilities.requiresExternalExecutable) values.add ("requires_external_executable");
    if (capabilities.nativeInProcess) values.add ("native_in_process");
    if (capabilities.benchmarkCandidate) values.add ("benchmark_candidate");
    if (capabilities.promotionGatePassed) values.add ("promotion_gate_passed");
    if (capabilities.fallbackBaseline) values.add ("fallback_baseline");

    return values;
}

juce::File findExecutableOnPath (const juce::StringArray& names)
{
    juce::StringArray pathEntries;
    pathEntries.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}),
                           getPathSeparator(), {});

    for (const auto& entry : pathEntries)
    {
        const juce::File dir (entry.unquoted().trim());
        if (! dir.isDirectory())
            continue;

        for (const auto& name : names)
        {
            auto candidate = dir.getChildFile (name);
            if (candidate.existsAsFile())
                return candidate;
        }
    }

    return {};
}

juce::File findRubberBandExecutable()
{
    const auto explicitPath = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_RUBBERBAND_EXE", {}).trim();
    if (explicitPath.isNotEmpty())
    {
        juce::File explicitFile (explicitPath.unquoted());
        if (explicitFile.existsAsFile())
            return explicitFile;
    }

    juce::StringArray executableNames;
#if JUCE_WINDOWS
    executableNames.add ("rubberband.exe");
    executableNames.add ("rubberband-r3.exe");
#else
    executableNames.add ("rubberband");
    executableNames.add ("rubberband-r3");
#endif

    const auto runtimeDir = getApplicationRuntimeDirectory();
    const juce::File candidateDirs[] = {
        runtimeDir,
        runtimeDir.getChildFile ("rubberband"),
        runtimeDir.getChildFile ("tools"),
        runtimeDir.getChildFile ("tools").getChildFile ("rubberband"),
        runtimeDir.getParentDirectory().getChildFile ("tools"),
        runtimeDir.getParentDirectory().getChildFile ("tools").getChildFile ("rubberband"),
        runtimeDir.getParentDirectory().getParentDirectory().getChildFile ("tools"),
        runtimeDir.getParentDirectory().getParentDirectory().getChildFile ("tools").getChildFile ("rubberband"),
        juce::File::getCurrentWorkingDirectory().getChildFile ("tools"),
        juce::File::getCurrentWorkingDirectory().getChildFile ("tools").getChildFile ("rubberband")
    };

    for (const auto& dir : candidateDirs)
    {
        for (const auto& name : executableNames)
        {
            auto candidate = dir.getChildFile (name);
            if (candidate.existsAsFile())
                return candidate;
        }
    }

    return findExecutableOnPath (executableNames);
}

bool writeBufferToWavFile (const juce::AudioBuffer<float>& buffer,
                           int numSamples,
                           double sampleRate,
                           const juce::File& outputFile)
{
    outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> stream (outputFile.createOutputStream());
    if (! stream)
        return false;

    std::unique_ptr<juce::AudioFormatWriter> writer (
        wavFormat.createWriterFor (stream.get(), sampleRate,
                                   static_cast<unsigned int> (buffer.getNumChannels()),
                                   32, {}, 0));
    if (! writer)
        return false;

    stream.release();
    const bool ok = writer->writeFromAudioSampleBuffer (buffer, 0, numSamples);
    writer.reset();
    return ok && outputFile.existsAsFile();
}

bool readWavFileToExactBuffer (const juce::File& inputFile,
                               juce::AudioBuffer<float>& destination,
                               int targetSamples)
{
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (inputFile));
    if (! reader)
        return false;

    destination.clear();
    const int samplesToRead = std::min (targetSamples, static_cast<int> (reader->lengthInSamples));
    if (samplesToRead <= 0)
        return false;

    reader->read (&destination, 0, samplesToRead, 0, true, true);
    return true;
}

void addRubberBandPitchMapPoint (std::vector<std::pair<int, double>>& points,
                                 int sample,
                                 double semitones,
                                 int totalSamples)
{
    points.emplace_back (juce::jlimit (0, totalSamples, sample), semitones);
}

double getCommitDurationSec (const std::vector<PitchRenderBackend::RenderRequest::CommitRange>& ranges)
{
    double duration = 0.0;
    for (const auto& range : ranges)
        duration += std::max (0.0, range.endSec - range.startSec);
    return duration;
}

int getCommitDurationSamples (const std::vector<PitchRenderBackend::RenderRequest::CommitRange>& ranges,
                              double sampleRate,
                              int totalSamples)
{
    int samples = 0;
    for (const auto& range : ranges)
    {
        const int start = juce::jlimit (0, totalSamples, static_cast<int> (std::floor (range.startSec * sampleRate)));
        const int end = juce::jlimit (start, totalSamples, static_cast<int> (std::ceil (range.endSec * sampleRate)));
        samples += end - start;
    }
    return samples;
}

bool isWindowsMissingRuntimeDllExit (int exitCode)
{
#if JUCE_WINDOWS
    return exitCode == static_cast<int> (0xC0000135u);
#else
    juce::ignoreUnused (exitCode);
    return false;
#endif
}

juce::String getRubberBandProbeFailureMessage (const PitchRenderBackend::Status& status)
{
    if (isWindowsMissingRuntimeDllExit (status.versionProbeExitCode))
        return "rubberband executable could not start because a dependent runtime DLL is missing (Windows status 0xC0000135). Add the Rubber Band runtime DLLs beside rubberband.exe in tools/rubberband, or set OPENSTUDIO_RUBBERBAND_EXE to a complete installation.";

    return status.versionProbeOutput.isNotEmpty()
        ? status.versionProbeOutput
        : "rubberband version probe failed with exit code " + juce::String (status.versionProbeExitCode);
}

void populateRenderDiagnostics (PitchRenderBackend::RenderResult& result,
                                const PitchRenderBackend::RenderRequest& request,
                                bool backendProbeCached)
{
    result.commitPolicy = "dry_protect_commit_ranges";
    result.contextDurationSec = request.sampleRate > 0.0
        ? static_cast<double> (request.numSamples) / request.sampleRate
        : 0.0;
    result.commitDurationSec = getCommitDurationSec (request.commitRanges);
    result.dryProtectedSamples = std::max (0, request.numSamples - getCommitDurationSamples (
        request.commitRanges, request.sampleRate, request.numSamples));
    result.backendProbeCached = backendProbeCached;
    result.jobStartDelayMs = request.jobStartDelayMs;
}

bool getBoolProperty (const juce::var& value, const juce::Identifier& name, bool fallback = false)
{
    if (auto* object = value.getDynamicObject())
    {
        const auto property = object->getProperty (name);
        return property.isVoid() ? fallback : static_cast<bool> (property);
    }
    return fallback;
}

juce::String buildRubberBandPitchMapText (const std::vector<PitchAnalyzer::PitchNote>& notes,
                                          int totalSamples,
                                          double sampleRate)
{
    std::vector<std::pair<int, double>> points;
    points.reserve (notes.size() * 4 + 2);
    addRubberBandPitchMapPoint (points, 0, 0.0, totalSamples);

    constexpr double editThresholdSemitones = 0.01;
    for (const auto& note : notes)
    {
        const double semitones = static_cast<double> (note.correctedPitch - note.detectedPitch);
        if (std::abs (semitones) <= editThresholdSemitones)
            continue;

        const double bodyStart = std::max (0.0, static_cast<double> (note.startTime));
        const double bodyEnd = std::max (bodyStart, static_cast<double> (note.endTime));
        const double effectiveStart = std::min (bodyStart, std::max (0.0, static_cast<double> (note.effectiveStartTime)));
        const double effectiveEnd = std::max (bodyEnd, static_cast<double> (note.effectiveEndTime));
        const double noteDuration = std::max (0.0, bodyEnd - bodyStart);
        const double minRampSec = std::min (0.010, noteDuration * 0.25);
        const double rampInEnd = std::max (effectiveStart + minRampSec, bodyStart);
        const double rampOutStart = std::min (effectiveEnd - minRampSec, bodyEnd);

        addRubberBandPitchMapPoint (points, static_cast<int> (effectiveStart * sampleRate), 0.0, totalSamples);
        addRubberBandPitchMapPoint (points, static_cast<int> (rampInEnd * sampleRate), semitones, totalSamples);
        addRubberBandPitchMapPoint (points, static_cast<int> (rampOutStart * sampleRate), semitones, totalSamples);
        addRubberBandPitchMapPoint (points, static_cast<int> (effectiveEnd * sampleRate), 0.0, totalSamples);
    }

    addRubberBandPitchMapPoint (points, totalSamples, 0.0, totalSamples);
    std::stable_sort (points.begin(), points.end(),
        [] (const auto& a, const auto& b) { return a.first < b.first; });

    juce::String text;
    int previousSample = -1;
    for (const auto& point : points)
    {
        if (point.first == previousSample && text.isNotEmpty())
        {
            const int lastLineBreak = text.dropLastCharacters (1).lastIndexOfChar ('\n');
            text = lastLineBreak >= 0 ? text.substring (0, lastLineBreak + 1) : juce::String();
        }

        text << point.first << " " << juce::String (point.second, 6) << "\n";
        previousSample = point.first;
    }

    return text;
}

bool requestCanUseFixedPitchLibrary (const std::vector<PitchAnalyzer::PitchNote>& notes,
                                     int totalSamples,
                                     double sampleRate,
                                     double& semitonesOut)
{
    semitonesOut = 0.0;
    if (totalSamples <= 0 || sampleRate <= 0.0)
        return false;

    constexpr double editThresholdSemitones = 0.01;
    std::vector<std::pair<int, int>> editedRanges;
    bool foundEditedNote = false;

    for (const auto& note : notes)
    {
        const double semitones = static_cast<double> (note.correctedPitch - note.detectedPitch);
        if (std::abs (semitones) <= editThresholdSemitones)
            continue;

        if (! foundEditedNote)
        {
            semitonesOut = semitones;
            foundEditedNote = true;
        }
        else if (std::abs (semitones - semitonesOut) > 0.01)
        {
            return false;
        }

        const int start = juce::jlimit (0, totalSamples, static_cast<int> (std::floor (note.startTime * sampleRate)));
        const int end = juce::jlimit (start, totalSamples, static_cast<int> (std::ceil (note.endTime * sampleRate)));
        if (end > start)
            editedRanges.emplace_back (start, end);
    }

    if (! foundEditedNote)
        return true;
    if (editedRanges.empty())
        return false;

    std::sort (editedRanges.begin(), editedRanges.end());
    int covered = 0;
    int mergedStart = editedRanges.front().first;
    int mergedEnd = editedRanges.front().second;

    for (size_t i = 1; i < editedRanges.size(); ++i)
    {
        if (editedRanges[i].first <= mergedEnd)
        {
            mergedEnd = std::max (mergedEnd, editedRanges[i].second);
            continue;
        }

        covered += mergedEnd - mergedStart;
        mergedStart = editedRanges[i].first;
        mergedEnd = editedRanges[i].second;
    }

    covered += mergedEnd - mergedStart;
    const double coverage = static_cast<double> (covered) / static_cast<double> (totalSamples);
    const int edgeTolerance = std::max (1, static_cast<int> (0.02 * sampleRate));

    return coverage >= 0.97
        && editedRanges.front().first <= edgeTolerance
        && editedRanges.back().second >= totalSamples - edgeTolerance;
}

class RubberBandHqPitchRenderBackend final : public PitchRenderBackend
{
public:
    juce::String backendId() const override { return kRubberBandHqBackendId; }
    ProductPath productPath() const override { return ProductPath::OfflineHq; }

    Capabilities capabilities() const override
    {
        Capabilities caps;
        caps.offlineHq = true;
        caps.phraseOrClipContext = true;
        caps.variablePitchMap = true;
        caps.formantPreservation = true;
        caps.requiresExternalExecutable = true;
        caps.nativeInProcess = hasRubberBandLibrary();
        caps.benchmarkCandidate = true;
        return caps;
    }

    Status probe() const override
    {
        const auto overridePath = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_RUBBERBAND_EXE", {}).trim();
        const auto nowMs = juce::Time::currentTimeMillis();

        {
            const juce::ScopedLock sl (getProbeCacheLock());
            const bool cacheFreshEnough = cachedProbeStatus().available || (nowMs - cachedProbeAtMs()) < 10000;
            if (cachedProbeValid() && cachedProbeOverridePath() == overridePath && cacheFreshEnough)
            {
                auto status = cachedProbeStatus();
                status.diagnostics = buildDiagnostics (status, true);
                return status;
            }
        }

        auto status = buildProbeUncached();
        status.diagnostics = buildDiagnostics (status, false);

        {
            const juce::ScopedLock sl (getProbeCacheLock());
            cachedProbeStatus() = status;
            cachedProbeOverridePath() = status.overridePath;
            cachedProbeAtMs() = juce::Time::currentTimeMillis();
            cachedProbeValid() = true;
        }

        return status;
    }

    RenderResult render (const RenderRequest& request) const override
    {
        auto status = probe();
        const bool backendProbeCached = getBoolProperty (status.diagnostics, "backendProbeCached");

        if (! status.available)
        {
            RenderResult result;
            result.status = status;
            result.failureCode = status.failureCode;
            result.failureMessage = status.failureMessage;
            populateRenderDiagnostics (result, request, backendProbeCached);
            return result;
        }

        if (request.input == nullptr || request.numSamples <= 0 || request.sampleRate <= 0.0)
        {
            auto result = failWithStatus (status, "offline_hq.invalid_request", "invalid audio render request");
            populateRenderDiagnostics (result, request, backendProbeCached);
            return result;
        }

        double fixedPitchSemitones = 0.0;
        if (hasRubberBandLibrary()
            && requestCanUseFixedPitchLibrary (request.notes, request.numSamples, request.sampleRate, fixedPitchSemitones))
        {
            auto libraryResult = renderWithLibraryFixedPitch (request, status, fixedPitchSemitones);
            if (libraryResult.success || status.executablePath.isEmpty())
                return libraryResult;
        }

        return renderWithCommandLinePitchMap (request, status);
    }

private:
    static RenderResult failWithStatus (const Status& status,
                                        const juce::String& code,
                                        const juce::String& message)
    {
        RenderResult result;
        result.status = status;
        result.failureCode = code;
        result.failureMessage = message;
        return result;
    }

    static bool& cachedProbeValid()
    {
        static bool value = false;
        return value;
    }

    static juce::int64& cachedProbeAtMs()
    {
        static juce::int64 value = 0;
        return value;
    }

    static juce::String& cachedProbeOverridePath()
    {
        static juce::String value;
        return value;
    }

    static Status& cachedProbeStatus()
    {
        static Status value;
        return value;
    }

    static juce::CriticalSection& getProbeCacheLock()
    {
        static juce::CriticalSection lock;
        return lock;
    }

    Status buildProbeUncached() const
    {
        Status status;
        status.backendId = backendId();
        status.displayName = "Rubber Band HQ";
        status.productPath = productPath();
        status.capabilities = capabilities();
        status.integrationKind = hasRubberBandLibrary() ? "library_or_cli" : "cli";
        status.promotionStatus = "benchmark_candidate";
        status.selectedReason = "best available open-source offline HQ candidate";
        status.overridePath = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_RUBBERBAND_EXE", {}).trim();
        status.overridePathExists = status.overridePath.isNotEmpty()
            && juce::File (status.overridePath.unquoted()).existsAsFile();

        const auto executable = findRubberBandExecutable();
        const bool executableFound = executable.existsAsFile();
        if (executableFound)
        {
            status.executablePath = executable.getFullPathName();

            juce::StringArray args;
            args.add (status.executablePath);
            args.add ("--version");

            juce::ChildProcess process;
            if (process.start (args, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
            {
                if (process.waitForProcessToFinish (3000))
                {
                    status.versionProbeExitCode = process.getExitCode();
                    status.versionProbeOutput = process.readAllProcessOutput().trim();
                    status.versionProbeSucceeded = status.versionProbeExitCode == 0;
                    status.version = status.versionProbeOutput;
                }
                else
                {
                    process.kill();
                    status.versionProbeOutput = "version probe timed out";
                }
            }
            else
            {
                status.versionProbeOutput = "version probe failed to start";
            }
        }

        if (hasRubberBandLibrary())
        {
            status.available = true;
            if (status.version.isEmpty())
                status.version = "librubberband";
        }
        else
        {
            status.available = status.versionProbeSucceeded;
        }

        if (! status.available)
        {
            if (executableFound)
            {
                status.failureCode = isWindowsMissingRuntimeDllExit (status.versionProbeExitCode)
                    ? "offline_hq.rubberband_missing_runtime_dll"
                    : "offline_hq.probe_failed";
                status.failureMessage = getRubberBandProbeFailureMessage (status);
            }
            else
            {
                status.failureCode = "offline_hq.unavailable";
                status.failureMessage = "rubberband executable not found";
            }
        }

        return status;
    }

    static juce::var buildDiagnostics (const Status& status, bool backendProbeCached)
    {
        auto* diagnostics = new juce::DynamicObject();
        diagnostics->setProperty ("backendId", status.backendId);
        diagnostics->setProperty ("integrationKind", status.integrationKind);
        diagnostics->setProperty ("promotionStatus", status.promotionStatus);
        diagnostics->setProperty ("backendProbeCached", backendProbeCached);
        diagnostics->setProperty ("libraryAvailable", hasRubberBandLibrary());
        diagnostics->setProperty ("libraryUsedForFixedFullCoveragePitchOnly", hasRubberBandLibrary());
        diagnostics->setProperty ("cliAvailable", status.executablePath.isNotEmpty() && status.versionProbeSucceeded);
        diagnostics->setProperty ("variablePitchMapUsesCli", true);
        diagnostics->setProperty ("versionProbeSucceeded", status.versionProbeSucceeded);
        diagnostics->setProperty ("versionProbeExitCode", status.versionProbeExitCode);
        diagnostics->setProperty ("missingRuntimeDll", isWindowsMissingRuntimeDllExit (status.versionProbeExitCode));
        diagnostics->setProperty ("versionProbeOutput", status.versionProbeOutput);
        diagnostics->setProperty ("overridePath", status.overridePath);
        diagnostics->setProperty ("overridePathExists", status.overridePathExists);
        diagnostics->setProperty ("executablePath", status.executablePath);
        diagnostics->setProperty ("failureCode", status.failureCode);
        diagnostics->setProperty ("failureMessage", status.failureMessage);
        return juce::var (diagnostics);
    }

    RenderResult renderWithCommandLinePitchMap (const RenderRequest& request, const Status& status) const
    {
        const bool backendProbeCached = getBoolProperty (status.diagnostics, "backendProbeCached");
        if (status.executablePath.isEmpty())
        {
            auto result = failWithStatus (status, "offline_hq.rubberband_cli_unavailable",
                                          "rubberband CLI is required for phrase pitch maps");
            populateRenderDiagnostics (result, request, backendProbeCached);
            return result;
        }

        RenderResult result;
        result.status = status;
        populateRenderDiagnostics (result, request, backendProbeCached);

        const auto tempInput = juce::File::createTempFile (".wav");
        const auto tempOutput = juce::File::createTempFile (".wav");
        const auto pitchMap = juce::File::createTempFile (".txt");

        auto cleanup = [&]()
        {
            tempInput.deleteFile();
            tempOutput.deleteFile();
            pitchMap.deleteFile();
        };

        auto fail = [&] (const juce::String& code, const juce::String& message)
        {
            cleanup();
            result.failureCode = code;
            result.failureMessage = message;
            return result;
        };

        if (! writeBufferToWavFile (*request.input, request.numSamples, request.sampleRate, tempInput))
            return fail ("offline_hq.input_write_failed", "failed to write rubberband input wav");

        const auto pitchMapText = buildRubberBandPitchMapText (request.notes, request.numSamples, request.sampleRate);
        pitchMap.deleteFile();
        if (! pitchMap.replaceWithText (pitchMapText))
            return fail ("offline_hq.pitchmap_write_failed", "failed to write rubberband pitch map");

        tempOutput.deleteFile();
        juce::StringArray args;
        args.add (status.executablePath);
        args.add ("-q");
        args.add ("-3");
        args.add ("-F");
        args.add ("--pitch-hq");
        args.add ("-p");
        args.add ("0");
        args.add ("--pitchmap");
        args.add (pitchMap.getFullPathName());
        args.add (tempInput.getFullPathName());
        args.add (tempOutput.getFullPathName());

        juce::ChildProcess process;
        if (! process.start (args, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
            return fail ("offline_hq.process_start_failed", "failed to start rubberband");

        if (! process.waitForProcessToFinish (600000))
        {
            process.kill();
            return fail ("offline_hq.timed_out", "rubberband timed out");
        }

        const int exitCode = process.getExitCode();
        if (exitCode != 0)
        {
            const auto processOutput = process.readAllProcessOutput().trim();
            return fail ("offline_hq.process_failed",
                         "rubberband exit code " + juce::String (exitCode) + ": " + processOutput);
        }

        if (! tempOutput.existsAsFile())
            return fail ("offline_hq.output_missing", "rubberband output wav missing");

        result.output.setSize (request.input->getNumChannels(), request.numSamples, false, false, true);
        if (! readWavFileToExactBuffer (tempOutput, result.output, request.numSamples))
            return fail ("offline_hq.output_read_failed", "failed to read rubberband output wav");

        cleanup();
        result.status.integrationKind = "cli";
        result.success = true;
        return result;
    }

    RenderResult renderWithLibraryFixedPitch (const RenderRequest& request,
                                              const Status& status,
                                              double semitones) const
    {
#if S13_HAS_RUBBERBAND_LIBRARY
        RenderResult result;
        result.status = status;
        const bool backendProbeCached = getBoolProperty (status.diagnostics, "backendProbeCached");
        populateRenderDiagnostics (result, request, backendProbeCached);

        const int numChannels = request.input->getNumChannels();
        const int numSamples = request.numSamples;
        const int blockSize = 8192;
        const double pitchScale = std::pow (2.0, semitones / 12.0);

        using RubberBand::RubberBandStretcher;
        RubberBandStretcher::Options options =
            RubberBandStretcher::OptionProcessOffline
            | RubberBandStretcher::OptionEngineFiner
            | RubberBandStretcher::OptionChannelsTogether
            | RubberBandStretcher::OptionPitchHighQuality
            | RubberBandStretcher::OptionFormantPreserved;

        RubberBandStretcher stretcher (static_cast<size_t> (std::round (request.sampleRate)),
                                       static_cast<size_t> (numChannels),
                                       options,
                                       1.0,
                                       pitchScale);
        stretcher.setMaxProcessSize (static_cast<size_t> (blockSize));

        std::vector<const float*> inputPtrs (static_cast<size_t> (numChannels), nullptr);
        for (int pos = 0; pos < numSamples; pos += blockSize)
        {
            const int frames = std::min (blockSize, numSamples - pos);
            for (int ch = 0; ch < numChannels; ++ch)
                inputPtrs[static_cast<size_t> (ch)] = request.input->getReadPointer (ch) + pos;
            stretcher.study (inputPtrs.data(), static_cast<size_t> (frames), pos + frames >= numSamples);
        }

        std::vector<std::vector<float>> collected (static_cast<size_t> (numChannels));
        auto retrieveAvailable = [&]()
        {
            for (;;)
            {
                const auto available = stretcher.available();
                if (available <= 0)
                    break;

                const int frames = static_cast<int> (available);
                std::vector<std::vector<float>> block (static_cast<size_t> (numChannels),
                                                       std::vector<float> (static_cast<size_t> (frames), 0.0f));
                std::vector<float*> outputPtrs (static_cast<size_t> (numChannels), nullptr);
                for (int ch = 0; ch < numChannels; ++ch)
                    outputPtrs[static_cast<size_t> (ch)] = block[static_cast<size_t> (ch)].data();

                const int retrieved = static_cast<int> (stretcher.retrieve (outputPtrs.data(), static_cast<size_t> (frames)));
                if (retrieved <= 0)
                    break;

                for (int ch = 0; ch < numChannels; ++ch)
                {
                    auto& dst = collected[static_cast<size_t> (ch)];
                    const auto& src = block[static_cast<size_t> (ch)];
                    dst.insert (dst.end(), src.begin(), src.begin() + retrieved);
                }
            }
        };

        for (int pos = 0; pos < numSamples; pos += blockSize)
        {
            const int frames = std::min (blockSize, numSamples - pos);
            for (int ch = 0; ch < numChannels; ++ch)
                inputPtrs[static_cast<size_t> (ch)] = request.input->getReadPointer (ch) + pos;
            stretcher.process (inputPtrs.data(), static_cast<size_t> (frames), pos + frames >= numSamples);
            retrieveAvailable();
        }

        retrieveAvailable();

        if (collected.empty() || collected[0].empty())
        {
            auto failure = failWithStatus (status, "offline_hq.library_output_empty", "librubberband produced empty output");
            populateRenderDiagnostics (failure, request, backendProbeCached);
            return failure;
        }

        result.output.setSize (numChannels, numSamples, false, false, true);
        result.output.clear();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const auto& src = collected[static_cast<size_t> (ch)];
            result.output.copyFrom (ch, 0, src.data(), std::min (numSamples, static_cast<int> (src.size())));
        }

        result.status.integrationKind = "library";
        result.success = true;
        return result;
#else
        juce::ignoreUnused (semitones);
        auto failure = failWithStatus (status, "offline_hq.library_unavailable", "librubberband not linked");
        populateRenderDiagnostics (failure, request, getBoolProperty (status.diagnostics, "backendProbeCached"));
        return failure;
#endif
    }
};

class NativeHqV4PitchRenderBackend final : public PitchRenderBackend
{
public:
    juce::String backendId() const override { return kNativeHqV4BackendId; }
    ProductPath productPath() const override { return ProductPath::OfflineHq; }

    Capabilities capabilities() const override
    {
        Capabilities caps;
        caps.offlineHq = true;
        caps.phraseOrClipContext = true;
        caps.variablePitchMap = true;
        caps.nativeInProcess = true;
        caps.benchmarkCandidate = true;
        caps.promotionGatePassed = false;
        return caps;
    }

    Status probe() const override
    {
        Status status;
        status.backendId = backendId();
        status.displayName = "Native HQ v4";
        status.productPath = productPath();
        status.capabilities = capabilities();
        status.integrationKind = "native";
        status.promotionStatus = "reserved_not_implemented";
        status.selectedReason = "reserved fallback lane if rubberband_hq fails quality gates";
        status.available = false;
        status.version = "0";
        status.failureCode = "offline_hq.native_hq_v4_not_ready";
        status.failureMessage = "native_hq_v4 is reserved but not implemented";

        auto* diagnostics = new juce::DynamicObject();
        diagnostics->setProperty ("backendId", status.backendId);
        diagnostics->setProperty ("promotionStatus", status.promotionStatus);
        diagnostics->setProperty ("nextAction", "build only after rubberband_hq fails benchmark gates");
        status.diagnostics = juce::var (diagnostics);
        return status;
    }

    RenderResult render (const RenderRequest& request) const override
    {
        RenderResult result;
        result.status = probe();
        result.failureCode = result.status.failureCode;
        result.failureMessage = result.status.failureMessage;
        populateRenderDiagnostics (result, request, false);
        return result;
    }
};

} // namespace

juce::String PitchRenderBackend::productPathName (ProductPath path)
{
    switch (path)
    {
        case ProductPath::Preview: return "preview";
        case ProductPath::OfflineHq: return "offline_hq";
        case ProductPath::AraPlugin: return "ara_plugin";
    }

    return "unknown";
}

juce::var PitchRenderBackend::Capabilities::toVar() const
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("preview", preview);
    object->setProperty ("offlineHq", offlineHq);
    object->setProperty ("araPlugin", araPlugin);
    object->setProperty ("phraseOrClipContext", phraseOrClipContext);
    object->setProperty ("variablePitchMap", variablePitchMap);
    object->setProperty ("formantPreservation", formantPreservation);
    object->setProperty ("explicitFormantControl", explicitFormantControl);
    object->setProperty ("requiresExternalExecutable", requiresExternalExecutable);
    object->setProperty ("nativeInProcess", nativeInProcess);
    object->setProperty ("benchmarkCandidate", benchmarkCandidate);
    object->setProperty ("promotionGatePassed", promotionGatePassed);
    object->setProperty ("fallbackBaseline", fallbackBaseline);
    object->setProperty ("list", juce::var (buildCapabilityList (*this)));
    return juce::var (object);
}

juce::var PitchRenderBackend::Status::toVar() const
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("backendId", backendId);
    object->setProperty ("displayName", displayName);
    object->setProperty ("pitchRenderProductPath", productPathName (productPath));
    object->setProperty ("productPath", productPathName (productPath));
    object->setProperty ("capabilities", capabilities.toVar());
    object->setProperty ("available", available);
    object->setProperty ("executablePath", executablePath);
    object->setProperty ("version", version);
    object->setProperty ("integrationKind", integrationKind);
    object->setProperty ("promotionStatus", promotionStatus);
    object->setProperty ("selectedReason", selectedReason);
    object->setProperty ("failureCode", failureCode);
    object->setProperty ("failureMessage", failureMessage);
    object->setProperty ("overridePath", overridePath);
    object->setProperty ("overridePathExists", overridePathExists);
    object->setProperty ("versionProbeSucceeded", versionProbeSucceeded);
    object->setProperty ("versionProbeExitCode", versionProbeExitCode);
    object->setProperty ("versionProbeOutput", versionProbeOutput);
    object->setProperty ("diagnostics", diagnostics);

    // Backward-compatible bridge fields used by the existing frontend and harnesses.
    object->setProperty ("selectedRenderer", available ? backendId : "unavailable");
    object->setProperty ("pitchRenderStrategy", "offline_hq_bakeoff");
    object->setProperty ("externalPitchRendererAvailable", available);
    object->setProperty ("externalPitchRendererPath", executablePath);

    return juce::var (object);
}

juce::String getDefaultOfflineHqBackendId()
{
    return normaliseBackendId (juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_HQ_BACKEND",
                                                                          kRubberBandHqBackendId));
}

std::unique_ptr<PitchRenderBackend> createPitchRenderBackend (const juce::String& backendId)
{
    const auto normalised = normaliseBackendId (backendId);

    if (normalised == kRubberBandHqBackendId)
        return std::make_unique<RubberBandHqPitchRenderBackend>();

    if (normalised == kNativeHqV4BackendId)
        return std::make_unique<NativeHqV4PitchRenderBackend>();

    return nullptr;
}

std::unique_ptr<PitchRenderBackend> createPitchRenderBackend (PitchRenderBackend::ProductPath path)
{
    switch (path)
    {
        case PitchRenderBackend::ProductPath::OfflineHq:
            return createPitchRenderBackend (getDefaultOfflineHqBackendId());

        case PitchRenderBackend::ProductPath::Preview:
        case PitchRenderBackend::ProductPath::AraPlugin:
            return nullptr;
    }

    return nullptr;
}

juce::Array<juce::var> probeOfflineHqPitchRenderBackends()
{
    juce::Array<juce::var> statuses;

    if (auto rubberBand = createPitchRenderBackend (kRubberBandHqBackendId))
        statuses.add (rubberBand->probe().toVar());

    if (auto nativeV4 = createPitchRenderBackend (kNativeHqV4BackendId))
        statuses.add (nativeV4->probe().toVar());

    return statuses;
}

} // namespace PitchRendering
