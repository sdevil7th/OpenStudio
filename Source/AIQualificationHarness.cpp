#include "AIQualificationHarness.h"
#include "StemSeparator.h"
#include "AIManagedRuntime.h"
#include "AITrackEngine.h"
#include "AIResourceCoordinator.h"
#include "AudioEngine.h"
#include <algorithm>
#include <cmath>

int AIQualificationHarness::run(const juce::File& configuration)
{
    const auto root = configuration.getParentDirectory();
    if (root.getChildFile(".openstudio-ai-qualification").loadFileAsString().trim()
            != "owned-test-data-v1") return 2;
    const auto caseName = configuration.getFileNameWithoutExtension();
    if (caseName.isEmpty() || caseName.retainCharacters("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != caseName)
        return 2;
    const auto reportFile = root.getChildFile(caseName == "configuration" ? "native-result.json" : "native-result-" + caseName + ".json");
    if (reportFile.exists()) return 2;
    const auto config = juce::JSON::parse(configuration);
    if (! config.isObject()) return 2;
    const auto input = juce::File(config.getProperty("input", "").toString());
    if (! input.existsAsFile()) return 2;
    const bool automaticMaintenance = static_cast<bool>(config.getProperty("automaticRuntimeMaintenance", false));
    StemSeparator separator;
    separator.qualificationDataRoot = root.getChildFile("user-data");
    separator.qualificationDataRoot.createDirectory();
    separator.qualificationManifestUrl = config.getProperty("manifestUrl", "").toString();
    if (separator.qualificationManifestUrl.isEmpty()) return 2;
    separator.qualificationGpuFraction = static_cast<double>(config.getProperty("qualificationGpuFraction", 0));
    if (! std::isfinite(separator.qualificationGpuFraction) || separator.qualificationGpuFraction < 0
        || separator.qualificationGpuFraction > 0.25) return 2;
    auto report = std::make_unique<juce::DynamicObject>();
    report->setProperty("status", "fail");
    report->setProperty("scope", static_cast<bool>(config.getProperty("install", true))
        ? "native installer selection/download/extraction/activation and owned worker transport"
        : "reuse of qualification-owned runtime and owned worker transport");
    report->setProperty("faultInjection", separator.qualificationGpuFraction > 0 ? "per-process GPU allocator limit" : "none");
    report->setProperty("subjectiveAudioQuality", "not_asserted");
    report->setProperty("userDataRoot", separator.qualificationDataRoot.getFullPathName());
    const auto started = juce::Time::getMillisecondCounterHiRes();
    auto save = [&] (int code, const juce::String& error)
    {
        const auto probes = separator.qualificationHardwareProbeCount.load();
        const bool excessiveProbes = code == 0 && automaticMaintenance && probes > 64;
        if (excessiveProbes) code = 1;
        report->setProperty("status", code == 0 ? "pass" : "fail");
        report->setProperty("error", excessiveProbes ? "Automatic setup repeated hardware probes during download." : error);
        report->setProperty("hardwareProbeCount", static_cast<int>(probes));
        report->setProperty("elapsedMs", juce::Time::getMillisecondCounterHiRes() - started);
        reportFile.replaceWithText(juce::JSON::toString(juce::var(report.release()), true));
        return code;
    };
    if (automaticMaintenance)
    {
        report->setProperty("scope", "automatic app-update runtime compatibility check, staged repair, backend validation and real stem separation");
        const auto before = AIManagedRuntime::getActiveStemRuntimeRoot(separator.qualificationDataRoot);
        const auto marker = separator.qualificationDataRoot.getChildFile("stem-runtime-active.txt");
        const auto markerBefore = marker.loadFileAsString();
        const auto oldPython = separator.findPythonInRuntimeRoot(before);
        if (! oldPython.existsAsFile() || ! separator.hasRequiredModel(separator.getUserModelsDir()))
            return save(1, "Automatic maintenance requires an installed owned runtime/model");
        const auto hash = [] (const juce::File& file) { juce::FileInputStream stream(file); return juce::SHA256(stream).toHexString(); };
        const auto pythonBefore = hash(oldPython);
        const auto modelBefore = hash(separator.getUserModelsDir().getChildFile("BS-Roformer-SW.ckpt"));
        if (static_cast<bool>(config.getProperty("testBusyDeferral", false)))
        {
            AIRuntimeMaintenance::SessionLease recordingSession;
            if (recordingSession.acquire(separator.qualificationDataRoot, AIRuntimeMaintenance::SessionLease::Mode::workstation).failed()
                || separator.beginRuntimeMaintenance().wasOk() || separator.automaticRuntimeCheckRequested
                || separator.qualificationHardwareProbeCount.load() != 0)
                return save(1, "Maintenance was admitted while a recording session held the runtime");
            AudioEngine workstation(AudioEngine::DeviceStartup::offline);
            workstation.stemSeparator.qualificationDataRoot = separator.qualificationDataRoot;
            (void) workstation.getAiToolsStatus();
            workstation.isRecordMode.store(true);
            const auto request = workstation.installAiTools(juce::String(R"({"repairRuntime":true,"userConfirmedDownload":true})"));
            (void) workstation.getAiToolsStatus();
            workstation.isRecordMode.store(false);
            if (request.getProperty("error", "").toString().isEmpty()
                || workstation.stemSeparator.automaticRuntimeCheckRequested
                || workstation.stemSeparator.automaticRuntimeRepairAttempts != 0)
                return save(1, "Recording status or a live repair request started maintenance");
            report->setProperty("busyDeferral", "pass");
        }
        const auto admitted = separator.beginRuntimeMaintenance();
        if (admitted.failed()) return save(1, admitted.getErrorMessage());
        AIRuntimeMaintenance::SessionLease competingWorkstation;
        if (competingWorkstation.acquire(separator.qualificationDataRoot, AIRuntimeMaintenance::SessionLease::Mode::workstation).wasOk())
            return save(1, "A recording session was admitted during maintenance");
        report->setProperty("recordingExcludedThroughoutRepair", true);
        const auto expected = config.getProperty("expectAutomaticState", "current").toString();
        const auto timeout = juce::jlimit(30.0, 10800.0, static_cast<double>(config.getProperty("timeoutSeconds", 1800))) * 1000;
        bool observedInstall = false, cancelled = false;
        juce::var status;
        while (juce::Time::getMillisecondCounterHiRes() - started < timeout)
        {
            status = separator.pollRuntimeMaintenance();
            const bool installing = static_cast<bool>(status.getProperty("installInProgress", false));
            observedInstall = observedInstall || installing || separator.automaticRuntimeRepairAttempts > 0;
            if (installing && ! cancelled && static_cast<bool>(config.getProperty("cancelAutomaticUpdate", false)))
            {
                separator.cancelAiToolsInstall(); cancelled = true;
            }
            const auto state = status.getProperty("runtimeMaintenance", {}).getProperty("state", "").toString();
            if (! installing && ! separator.installWorkerActive.load() && state == expected) break;
            if (! installing && ! separator.installWorkerActive.load()
                && (state == "failed" || state == "cancelled" || state == "interrupted" || state == "unavailable" || state == "cpu_only") && state != expected)
                return save(1, "Unexpected automatic update result: " + juce::JSON::toString(status));
            juce::Thread::sleep(100);
        }
        report->setProperty("automaticUpdate", status);
        report->setProperty("observedAutomaticInstall", observedInstall);
        if (status.getProperty("runtimeMaintenance", {}).getProperty("state", "").toString() != expected
            || observedInstall != static_cast<bool>(config.getProperty("expectAutomaticInstall", true)))
            return save(1, "Automatic update did not reach its expected result");
        const bool sourceRetained = oldPython.existsAsFile() && hash(oldPython) == pythonBefore
            && hash(separator.getUserModelsDir().getChildFile("BS-Roformer-SW.ckpt")) == modelBefore;
        report->setProperty("existingPythonAndModelUnchanged", sourceRetained);
        if (! sourceRetained) return save(1, "Automatic repair changed its source runtime/model");
        const auto after = AIManagedRuntime::getActiveStemRuntimeRoot(separator.qualificationDataRoot);
        const bool shouldChange = observedInstall && expected == "current";
        if (shouldChange ? before == after : (before != after || markerBefore != marker.loadFileAsString()))
            return save(1, "Automatic activation/rollback did not match the expected result");
        // Terminal failure/cancellation/healthy checks must not launch again.
        for (int poll = 0; poll < 5; ++poll)
            if (static_cast<bool>(separator.pollRuntimeMaintenance().getProperty("installInProgress", false)))
                return save(1, "Automatic repair repeated after its terminal result");
        report->setProperty("automaticRetryLoop", "absent");
        report->setProperty("activeRuntime", after.getFullPathName());
        if (static_cast<bool>(config.getProperty("skipSeparation", false))) return save(0, {});
    }
    if (!automaticMaintenance && (static_cast<bool>(config.getProperty("repairRuntime", false))
        || static_cast<bool>(config.getProperty("compilerSetup", false))))
    {
        const auto admitted = separator.beginRuntimeMaintenance();
        if (admitted.failed()) return save(1, admitted.getErrorMessage());
    }
    if (const auto* workloads = config.getProperty("generationMemorySequence", {}).getArray())
    {
        if (workloads->isEmpty() || workloads->size()>16) return save(1,"Invalid generation sequence");
        report->setProperty("scope","native Automatic generation, placement transitions, exclusive resource tokens and worker handoff; existing read-only models/runtimes");
        auto audio=std::make_unique<AudioEngine>(AudioEngine::DeviceStartup::offline);
        audio->qualificationGeneratedAudioRoot=root.getChildFile("generation-output-"+caseName);
        audio->stemSeparator.qualificationDataRoot=separator.qualificationDataRoot;
        audio->stemSeparator.lastAiToolsStatus=audio->stemSeparator.buildInitialAiToolsStatus();
        audio->stemSeparator.initialStatusPrepared=true;
        // Model/runtime files are independently validated by the workers. ACE's
        // setup status is a fixture because this harness reuses a read-only
        // snapshot rather than installing it into the user's home cache.
        audio->stemSeparator.lastAiToolsStatus.musicGenerationReady=true;
        audio->stemSeparator.lastAiToolsStatus.musicGenerationLayoutValid=true;
        audio->stemSeparator.lastAiToolsStatus.musicGenerationAvailableProfiles.add("ace-diffusers");
        auto& generation=audio->aiTrackEngine;
        generation.qualificationDataRoot=separator.qualificationDataRoot;
        auto& resources=audio->aiResources;
        juce::Array<juce::var> rows;
        juce::String previousModel;
        int previousPid=0;
        for (const auto& workload : *workloads)
        {
            const auto model=workload.getProperty("modelId","").toString();
            if (model!="stable-audio-3-medium" && model!="minimax-music-3" && model!="ace-step-v15-xl-turbo")
                return save(1,"Unknown qualification model");
            const auto modelRoot=juce::File(workload.getProperty("modelRoot","").toString());
            const auto python=juce::File(workload.getProperty("python","").toString());
            if (!modelRoot.isDirectory() || !python.existsAsFile()) return save(1,"Missing model/runtime");
            generation.qualificationModelRoots.set(juce::Identifier(model),modelRoot.getFullPathName());
            generation.qualificationPythonPaths.set(juce::Identifier(model),python.getFullPathName());
            const auto workflow=workload.getProperty("workflow","").toString();
            const auto params=workload.getProperty("params",{});
            if (params.getProperty("generationOptimization","standard").toString()!="standard"
                || params.getProperty("modelVariant","").toString()!="original") return save(1,"Sequence requires Original and Automatic");
            const auto timeoutMs=juce::jlimit(30.0,10800.0,static_cast<double>(workload.getProperty("timeoutSeconds",1800)))*1000;
            const auto requestStarted=juce::Time::getMillisecondCounterHiRes();
            juce::var row(new juce::DynamicObject());
            auto* object=row.getDynamicObject();
            object->setProperty("modelId",model);
            object->setProperty("params",params);
            const auto preflight=generation.getGenerationPreflight(model,workflow,juce::JSON::toString(params),[]{return false;});
            object->setProperty("preflight",preflight);
            // The public check is advisory: its separate process cannot count
            // an existing worker's reusable allocator pool. The owner makes
            // the final request admission decision before allocating.
            object->setProperty("preflightIncludesWarmWorker",generation.hasIdleWorker());
            if (preflight.getProperty("status","unavailable").toString()=="unavailable"
                || (preflight.getProperty("status","").toString()=="blocked" && !generation.hasIdleWorker()))
                return save(1,"Native Automatic preflight rejected the cold workload");
            const auto launch=audio->startAIGeneration("qualification",model,workflow,juce::JSON::toString(params));
            if (!static_cast<bool>(launch.getProperty("started",false))) return save(1,"Generation did not start: "+juce::JSON::toString(launch));
            const auto token=audio->generationResourceToken.load();
            if (!token || resources.begin(AIResourceCoordinator::Owner::separation)) return save(1,"Resource exclusivity failed");
            if (static_cast<bool>(audio->releaseIdleAIMemory().getProperty("success",true))) return save(1,"Active generation released its resource lease");
            AIGenerationProgress progress;
            while (juce::Time::getMillisecondCounterHiRes()-requestStarted<timeoutMs)
            {
                (void)audio->getAIGenerationProgress();
                progress=generation.pollProgress();
                if (progress.state=="done" || progress.state=="error" || progress.state=="cancelled") break;
                juce::Thread::sleep(50);
            }
            if (progress.state!="done") generation.cancel();
            generation.joinGenerationThread();
            object->setProperty("state",progress.state);
            object->setProperty("error",progress.error);
            object->setProperty("generationDetails",progress.generationDetails);
            object->setProperty("output",progress.outputFile);
            int pid=0;
            { const juce::ScopedLock lock(generation.lock_);pid=generation.workerPid_; }
            object->setProperty("workerPid",pid);
            object->setProperty("previousWorkerPid",previousPid);
            const bool changed=previousModel.isNotEmpty() && model!=previousModel;
            object->setProperty("modelChanged",changed);
            if (changed && previousPid==pid) return save(1,"Model switch reused the previous process");
            previousModel=model;previousPid=pid;
            const auto execution=progress.generationDetails.getProperty("execution",{});
            const auto expected=workload.getProperty("expectedPlacement","").toString();
            const auto placement=execution.getProperty("offload","").toString();
            if (expected.isNotEmpty() && placement!=expected) return save(1,"Unexpected Automatic placement: "+placement);
            juce::AudioFormatManager formats;formats.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(juce::File(progress.outputFile)));
            if (progress.state!="done" || !reader || reader->numChannels!=2 || reader->lengthInSamples<=0)
                return save(1,"Native generation failed: "+progress.error);
            juce::AudioBuffer<float> samples(2,8192);
            for (juce::int64 offset=0;offset<reader->lengthInSamples;offset+=samples.getNumSamples())
            {
                const auto count = static_cast<int>(std::min<juce::int64>(samples.getNumSamples(), reader->lengthInSamples - offset));
                if (!reader->read(&samples,0,count,offset,true,true)) return save(1,"Generated audio is unreadable");
                for (int channel=0;channel<2;++channel)
                    for (int index=0;index<count;++index)
                        if (!std::isfinite(samples.getSample(channel,index))) return save(1,"Generated audio is nonfinite");
            }
            object->setProperty("outputDurationSeconds",static_cast<double>(reader->lengthInSamples)/reader->sampleRate);
            object->setProperty("seconds",(juce::Time::getMillisecondCounterHiRes()-requestStarted)/1000);
            object->setProperty("status","pass");
            (void)audio->getAIGenerationProgress();
            const auto resourceState=resources.snapshot();
            if (resourceState.getProperty("owner","").toString()!="idle") return save(1,"Completed generation retained the active lease");
            object->setProperty("resources",resourceState);
            rows.add(row);
            root.getChildFile(caseName+"-row-"+juce::String(rows.size())+".json").replaceWithText(juce::JSON::toString(row,true));
        }
        const bool retired=static_cast<bool>(audio->releaseIdleAIMemory().getProperty("success",false))
            && !generation.hasUnretiredWorker();
        report->setProperty("runs",rows);
        report->setProperty("workerRetired",retired);
        report->setProperty("resources",resources.snapshot());
        return save(retired?0:1,retired?juce::String():"Final worker did not retire");
    }
    if (static_cast<bool>(config.getProperty("generationHandshake", false)))
    {
        const auto python = juce::File(config.getProperty("python", "").toString());
        const auto script = juce::File(config.getProperty("script", "").toString());
        const auto model = config.getProperty("modelId", "stable-audio-3-medium").toString();
        if (! python.existsAsFile() || ! script.existsAsFile()) return save(1, "Missing worker/runtime for handshake");
        AITrackEngine generation;
        const bool ready = generation.ensureWorkerAvailable(python, script, model,
            config.getProperty("optimization", "standard").toString());
        report->setProperty("scope", "native generation worker launch, dependency fingerprint, ready protocol and retirement; no inference");
        report->setProperty("workerReady", ready);
        juce::String error;
        {
            const juce::ScopedLock lock(generation.lock_);
            report->setProperty("workerVersion", generation.workerScriptVersion_);
            report->setProperty("expectedVersion", generation.expectedScriptVersion_);
            error = generation.currentProgress_.error;
        }
        generation.stopWorkerSession(false, false, false);
        const bool retired = ! generation.hasUnretiredWorker();
        report->setProperty("workerRetired", retired);
        const bool expectedRejection = static_cast<bool>(config.getProperty("expectHandshakeFailure", false));
        report->setProperty("expectedRejection", expectedRejection);
        const bool passed = retired && (expectedRejection ? ! ready : ready);
        return save(passed ? 0 : 1, passed ? juce::String() : error);
    }
    if (static_cast<bool>(config.getProperty("compilerSetup", false)))
    {
        const auto timeout = juce::jlimit(10.0, 3600.0, static_cast<double>(config.getProperty("timeoutSeconds", 1800))) * 1000;
        const auto requirements = separator.findInstallerScript().getSiblingFile("ai-compiler-runtime-requirements-windows.txt");
        const auto standard = separator.getStableAudioRuntimeRoot();
        const auto fingerprint = [&] ()
        {
            juce::StringArray entries;
            for (const auto& file : standard.findChildFiles(juce::File::findFiles, true))
                if (!file.hasFileExtension("pyc"))
                    entries.add(file.getRelativePathFrom(standard) + ":" + juce::String(file.getSize())
                        + ":" + juce::String(file.getLastModificationTime().toMilliseconds()));
            entries.sort(false);
            const auto text = entries.joinIntoString("\n");
            return juce::SHA256(text.toRawUTF8(), text.getNumBytesAsUTF8()).toHexString();
        };
        const auto before = fingerprint();
        const auto previous = AIManagedRuntime::getActiveCompilerRuntimeRoot(separator.qualificationDataRoot, requirements);
        report->setProperty("scope", "native optional compiler installation, atomic activation, runtime selection, compiled inference and retirement");
        report->setProperty("previousCompilerRuntime", previous.getFullPathName());
        separator.lastAiToolsStatus = separator.buildInitialAiToolsStatus();
        separator.initialStatusPrepared = true;
        auto* options = new juce::DynamicObject();
        options->setProperty("userConfirmedDownload", true);
        options->setProperty("prepareOptimization", "compile");
        options->setProperty("repairRuntime", true);
        options->setProperty("modelId", "stable-audio-3-medium");
        options->setProperty("modelVariant", "original");
        options->setProperty("selectedFeatures", juce::Array<juce::var> { "audioGeneration" });
        const auto launch = separator.installAiTools(juce::JSON::toString(juce::var(options)));
        if (!static_cast<bool>(launch.getProperty("started", false))) return save(1, juce::JSON::toString(launch));
        bool ready = false;
        while (juce::Time::getMillisecondCounterHiRes() - started < timeout)
        {
            const auto status = separator.getAiToolsStatus();
            if (!static_cast<bool>(status.getProperty("installInProgress", true)))
            {
                report->setProperty("installation", status);
                ready = status.getProperty("state", "").toString() == "ready";
                break;
            }
            juce::Thread::sleep(100);
        }
        if (!ready) return save(1, "Native compiler setup failed or timed out");
        const auto active = AIManagedRuntime::getActiveCompilerRuntimeRoot(separator.qualificationDataRoot, requirements);
        report->setProperty("compilerRuntime", active.getFullPathName());
        report->setProperty("standardRuntimeRetained", before == fingerprint());
        if (!active.isDirectory() || active == previous || before != fingerprint()
            || (previous != juce::File() && !previous.isDirectory())) return save(1, "Compiler activation changed or lost an existing runtime");
        AITrackEngine generation;
        generation.qualificationDataRoot = separator.qualificationDataRoot;
        const auto python = generation.findCompilerPython();
        if (!python.isAChildOf(active)) return save(1, "Native generation selected a different compiler runtime");
        const juce::String params("{\"prompt\":\"A mellow acoustic song with gentle guitar\",\"duration\":30,\"steps\":8,\"seed\":123,\"modelVariant\":\"original\",\"generationOptimization\":\"compile\"}");
        const auto preflight = generation.getGenerationPreflight("stable-audio-3-medium", "text-to-audio", params, [] { return false; });
        report->setProperty("preflight", preflight);
        if (preflight.getProperty("status", "unavailable").toString() == "unavailable") return save(1, "Compiler preflight did not use the prepared slot");
        if (!generation.startGeneration("stable-audio-3-medium", "text-to-audio", params, root.getChildFile("compiler-output-" + caseName)))
            return save(1, "Native compiled generation did not start");
        AIGenerationProgress progress;
        while (juce::Time::getMillisecondCounterHiRes() - started < timeout)
        {
            progress = generation.pollProgress();
            if (progress.state == "done" || progress.state == "error" || progress.state == "cancelled") break;
            juce::Thread::sleep(50);
        }
        if (progress.state != "done" && progress.state != "error" && progress.state != "cancelled") generation.cancel();
        generation.joinGenerationThread();
        const bool retired = generation.releaseIdleWorker() && !generation.hasUnretiredWorker();
        const auto proof = progress.generationDetails.getProperty("execution", {}).getProperty("compilation", {});
        report->setProperty("generationDetails", progress.generationDetails);
        report->setProperty("workerRetired", retired);
        report->setProperty("output", progress.outputFile);
        const bool passed = progress.state == "done" && retired && juce::File(progress.outputFile).existsAsFile()
            && proof.getProperty("state", "").toString() == "pass" && before == fingerprint();
        return save(passed ? 0 : 1, passed ? juce::String() : "Native compiled inference failed: " + progress.error);
    }
    const double timeoutMs = juce::jlimit(10.0, 3600.0, static_cast<double>(config.getProperty("timeoutSeconds", 1800))) * 1000;
    const auto activeBefore = AIManagedRuntime::getActiveStemRuntimeRoot(separator.qualificationDataRoot);
    const auto markerBefore = separator.qualificationDataRoot.getChildFile("stem-runtime-active.txt").loadFileAsString();
    const bool expectInstallFailure = static_cast<bool>(config.getProperty("expectInstallFailure", false));
    const auto previousPython = separator.findPython();
    const auto pythonHash = [&] () { juce::FileInputStream stream(previousPython); return juce::SHA256(stream).toHexString(); };
    const auto pythonHashBefore = previousPython.existsAsFile() ? pythonHash() : juce::String();
    if (expectInstallFailure && (pythonHashBefore.isEmpty() || ! previousPython.isAChildOf(activeBefore)))
        return save(1, "Failure test requires a previously installed owned runtime");
    if (static_cast<bool>(config.getProperty("repairRuntime", false)))
    {
        separator.lastAiToolsStatus = separator.buildInitialAiToolsStatus();
        separator.initialStatusPrepared = true;
        separator.refreshAiToolsStatus();
        while (juce::Time::getMillisecondCounterHiRes() - started < timeoutMs)
        {
            { const juce::ScopedLock guard(separator.aiToolsStatusLock);
              if (! separator.statusRefreshInFlight) break; }
            juce::Thread::sleep(100);
        }
        const auto previousStatus = separator.getAiToolsStatus();
        report->setProperty("previousRuntimeStatus", previousStatus);
        if (! static_cast<bool>(previousStatus.getProperty("available", false)))
            return save(1, "Repair test requires an actually ready runtime before repair");
    }
    if (! automaticMaintenance && static_cast<bool>(config.getProperty("install", true)))
    {
        auto options = std::make_unique<juce::DynamicObject>();
        options->setProperty("userConfirmedDownload", true);
        options->setProperty("selectedFeatures", juce::Array<juce::var> { "stemSeparation" });
        options->setProperty("accelerationMode", config.getProperty("accelerationMode", "auto"));
        options->setProperty("repairRuntime", config.getProperty("repairRuntime", false));
        const auto launch = separator.installAiTools(juce::JSON::toString(juce::var(options.release())));
        if (! static_cast<bool>(launch.getProperty("started", false)))
            return save(1, "Installer did not start: " + juce::JSON::toString(launch));
        while (juce::Time::getMillisecondCounterHiRes() - started < timeoutMs)
        {
            const auto status = separator.getAiToolsStatus();
            const auto state = status.getProperty("state", "").toString();
            if (! static_cast<bool>(status.getProperty("installInProgress", true)) && state == "ready")
            {
                if (expectInstallFailure) return save(1, "Installation unexpectedly succeeded");
                report->setProperty("installation", status); break;
            }
            if (state == "error" || state == "cancelled" || state == "pythonMissing")
            {
                if (expectInstallFailure)
                {
                    report->setProperty("installation", status);
                    const bool retained = activeBefore == AIManagedRuntime::getActiveStemRuntimeRoot(separator.qualificationDataRoot)
                        && markerBefore == separator.qualificationDataRoot.getChildFile("stem-runtime-active.txt").loadFileAsString()
                        && previousPython.existsAsFile() && pythonHashBefore == pythonHash();
                    report->setProperty("previousRuntimeRetained", retained);
                    return save(retained ? 0 : 1, retained ? juce::String() : "Failed setup changed the previous active runtime");
                }
                return save(1, "Native installation failed: " + juce::JSON::toString(status));
            }
            juce::Thread::sleep(100);
        }
        if (! report->hasProperty("installation")) return save(1, "Native installation timed out");
    }
    else
    {
        // Reuse qualification-owned runtime only, with an actual capability
        // refresh. Never manufacture a ready status for the worker launch.
        separator.lastAiToolsStatus = separator.buildInitialAiToolsStatus();
        separator.initialStatusPrepared = true;
        separator.refreshAiToolsStatus();
        while (juce::Time::getMillisecondCounterHiRes() - started < timeoutMs)
        {
            { const juce::ScopedLock lock(separator.aiToolsStatusLock);
              if (! separator.statusRefreshInFlight) break; }
            juce::Thread::sleep(100);
        }
    }
    report->setProperty("activeRuntime", AIManagedRuntime::getActiveStemRuntimeRoot(separator.qualificationDataRoot).getFullPathName());
    const auto output = root.getChildFile(caseName == "configuration" ? "stems" : "stems-" + caseName);
    if (! separator.startSeparation(input, output, StemSeparator::getAllStemNames(),
            config.getProperty("accelerationMode", "auto").toString(), "BS-Roformer-SW.ckpt",
            static_cast<int>(config.getProperty("chunkDuration", 0)), config.getProperty("memoryMode", "automatic").toString(),
            config.getProperty("performanceMode", "standard").toString()))
        return save(1, separator.pollProgress().error);
    StemSeparator::SeparationProgress progress;
    while (juce::Time::getMillisecondCounterHiRes() - started < timeoutMs)
    {
        progress = separator.pollProgress();
        const auto cancelPhase = config.getProperty("cancelAtPhase", "").toString();
        if (cancelPhase.isNotEmpty() && progress.state == "analyzing"
            && (cancelPhase == "separate" || progress.diagnostics.getProperty("phase", "").toString() == cancelPhase))
        {
            separator.cancel();
            const auto cancelled = separator.pollProgress();
            const bool clean = output.findChildFiles(juce::File::findDirectories, false, ".openstudio-stem-*").isEmpty()
                && output.findChildFiles(juce::File::findDirectories, false, "stems-*").isEmpty();
            const bool retired = ! separator.isRunning() && cancelled.state == "idle" && cancelled.stemFiles.size() == 0 && clean;
            report->setProperty("ownedWorkspaceCleanup", clean ? "pass" : "fail");
            report->setProperty("cancellation", retired ? "worker retired; no terminal output published" : "fail");
            return save(retired ? 0 : 1, retired ? juce::String() : "Worker did not acknowledge cancellation");
        }
        if (progress.state == "done" || progress.state == "error") break;
        juce::Thread::sleep(50);
    }
    report->setProperty("backend", progress.backend);
    report->setProperty("diagnostics", progress.diagnostics);
    if (progress.state != "done") return save(1, progress.error.isNotEmpty() ? progress.error : "Separation timed out");
    if (progress.backend != config.getProperty("expectedBackend", "cuda").toString())
        return save(1, "Unexpected model execution backend");
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> source(formats.createReaderFor(input));
    if (! source) return save(1, "Cannot inspect source duration");
    juce::Array<juce::var> files;
    for (const auto& name : StemSeparator::getAllStemNames())
    {
        const auto file = juce::File(progress.stemFiles[name]);
        if (! file.isAChildOf(output)) return save(1, "Missing or external stem output: " + name);
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
        if (! reader || reader->numChannels != 2 || reader->sampleRate != 44100
            || std::abs(static_cast<double>(reader->lengthInSamples) / reader->sampleRate
                     - static_cast<double>(source->lengthInSamples) / source->sampleRate) > 2.0 / 44100)
            return save(1, "Invalid stem dimensions/duration: " + name);
        juce::AudioBuffer<float> samples(2, 8192);
        for (juce::int64 offset = 0; offset < reader->lengthInSamples; offset += samples.getNumSamples())
        {
            const auto count = static_cast<int>(std::min<juce::int64>(samples.getNumSamples(), reader->lengthInSamples - offset));
            if (! reader->read(&samples, 0, count, offset, true, true)) return save(1, "Stem read failed");
            for (int channel = 0; channel < 2; ++channel)
                for (int i = 0; i < count; ++i)
                    if (! std::isfinite(samples.getSample(channel, i))) return save(1, "Nonfinite stem samples");
        }
        files.add(file.getFullPathName());
    }
    report->setProperty("files", files);
    return save(0, {});
}
