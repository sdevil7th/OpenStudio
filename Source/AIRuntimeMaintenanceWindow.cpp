#include "AIRuntimeMaintenanceWindow.h"
#include "AIManagedRuntime.h"
#include "StemSeparator.h"
#include "UpdateManifest.h"

namespace AIRuntimeMaintenance
{
namespace
{
class RepairTask final : public juce::ThreadWithProgressWindow
{
public:
    RepairTask(SessionLease&& lease, bool compilerRepair, bool rebuild)
        : ThreadWithProgressWindow("AI Runtime Maintenance", true, true, -1),
          separator(std::move(lease), rebuild), compiler(compilerRepair) {}

    void run() override
    {
        if (compiler)
        {
            (void) separator.getAiToolsStatus();
            auto options = std::make_unique<juce::DynamicObject>();
            options->setProperty("userConfirmedDownload", true);
            options->setProperty("repairRuntime", true);
            options->setProperty("prepareOptimization", "compile");
            options->setProperty("modelId", "stable-audio-3-medium");
            options->setProperty("modelVariant", "original");
            options->setProperty("requestedFeature", "audioGeneration");
            options->setProperty("selectedFeatures", juce::Array<juce::var> { "audioGeneration" });
            const auto launch = separator.installAiTools(juce::JSON::toString(juce::var(options.release())));
            if (!static_cast<bool>(launch.getProperty("started", false)))
            {
                outcome = launch.getProperty("error", "Compiler setup could not start.").toString();
                return;
            }
        }
        while (!threadShouldExit())
        {
            const auto status = compiler ? separator.getAiToolsStatus() : separator.pollRuntimeMaintenance();
            const auto maintenance = status.getProperty("runtimeMaintenance", {});
            const auto state = maintenance.getProperty("state", "").toString();
            const bool installing = static_cast<bool>(status.getProperty("installInProgress", false));
            const auto statusText = status.getProperty("message", "").toString();
            setStatusMessage(installing ? statusText : "Checking the installed AI runtime…");
            setProgress(installing ? static_cast<double>(status.getProperty("progress", 0.0)) : -1.0);
            if (!installing && (compiler || (state.isNotEmpty() && state != "needed" && state != "recheck" && state != "attempting")))
            {
                outcome = compiler ? status.getProperty("error", "").toString() : maintenance.getProperty("message", "").toString();
                if (outcome.isEmpty()) outcome = statusText;
                return;
            }
            wait(200);
        }
        separator.cancelRuntimeMaintenance();
    }

    juce::String outcome;
private:
    StemSeparator separator;
    bool compiler;
};
}

bool claimUpdateOffer(const juce::File& root, const juce::String& version)
{
    if (!UpdateManifest::numericVersion(version)) return false;
    const auto stamp = root.getChildFile("ai-maintenance-offer-version.txt");
    const auto newer = [&]
    {
        if (stamp.isSymbolicLink() || stamp.getSize() > 128) return false;
        const auto seen = stamp.loadFileAsString().trim();
        return !UpdateManifest::numericVersion(seen) || UpdateManifest::compareVersions(version, seen) > 0;
    };
    if (!newer()) return false;
    const auto path = stamp.getFullPathName();
    juce::InterProcessLock gate("OpenStudio-AI-offer-" + juce::SHA256(path.toRawUTF8(), path.getNumBytesAsUTF8()).toHexString());
    if (!gate.enter(0)) return false;
    struct Release { juce::InterProcessLock& lock; ~Release() { lock.exit(); } } release { gate };
    if (!newer() || root.createDirectory().failed()) return false;
    juce::TemporaryFile temporary(stamp);
    if (!temporary.getFile().replaceWithText(version) || !temporary.overwriteTargetFileWithTemporary()) return false;
    return AIManagedRuntime::getActiveStemRuntimeRoot(root).isDirectory()
        && StemSeparator::hasRequiredModel(root.getChildFile("models"));
}

void runStartupMaintenance(const juce::File& root, const juce::String& version)
{
    const auto request = requestFile(root);
    const bool requested = request.existsAsFile();
    if (!requested)
    {
       #if JUCE_WINDOWS || JUCE_LINUX
        if (!claimUpdateOffer(root, version)) return;
        juce::AlertWindow offer("AI Runtime Maintenance",
            "OpenStudio " + version + " can check your installed stem tools and repair them if needed. "
            "You can also open the DAW now and request repair later in AI Tools Setup.",
            juce::MessageBoxIconType::QuestionIcon);
        offer.addButton("Open DAW", 0, juce::KeyPress(juce::KeyPress::returnKey), juce::KeyPress(juce::KeyPress::escapeKey));
        offer.addButton("Check and repair", 1);
        if (offer.runModalLoop() != 1) return;
       #else
        return; // No reviewed stem repair plan is shipped for this platform.
       #endif
    }
    // A passive offer holds no runtime lease. Take exclusive access only after
    // consent (or for maintenance explicitly requested from AI Tools Setup).
    SessionLease guard;
    const auto admission = guard.acquire(root, SessionLease::Mode::maintenance);
    if (admission.failed())
    {
        const auto saved = requested ? juce::Result::ok() : requestOnNextLaunch(root, false);
        if (requested && !request.existsAsFile()) return;
        juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::InfoIcon, "AI Runtime Maintenance",
            admission.getErrorMessage() + (saved.wasOk() ? " The request is saved for a later launch." : " " + saved.getErrorMessage()));
        return;
    }
    bool compiler = false;
    int choice = 1;
    if (requested)
    {
        if (!request.existsAsFile()) return;
        const auto kind = request.loadFileAsString().trim();
        if (!request.deleteFile())
        {
            juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::WarningIcon, "AI Runtime Maintenance",
                                             "Could not consume the saved repair request.");
            return;
        }
        if (kind != "stems" && kind != "compiler") return;
        compiler = kind == "compiler";
        if (!compiler) (void) claimUpdateOffer(root, version);
        choice = compiler
            ? (juce::AlertWindow::showOkCancelBox(juce::MessageBoxIconType::QuestionIcon, "AI Runtime Maintenance",
                "Rebuild and validate the optional compiler runtime before opening the DAW?", "Rebuild", "Open DAW") ? 1 : 0)
            : juce::AlertWindow::showYesNoCancelBox(juce::MessageBoxIconType::QuestionIcon, "AI Runtime Maintenance",
                "Check and repair incompatible stem tools, or rebuild them even if a previous check passed or failed. "
                "Your downloaded models are kept. The DAW will open after maintenance finishes.",
                "Check and repair", "Rebuild", "Open DAW");
        if (choice == 0) return;
    }
    RepairTask task(std::move(guard), compiler, choice == 2);
    const bool completed = task.runThread();
    juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::InfoIcon, "AI Runtime Maintenance",
        completed ? task.outcome : "Maintenance cancelled. OpenStudio will open after the worker exits.");
}
}
