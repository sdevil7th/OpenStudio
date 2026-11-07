#include "AIRuntimeMaintenanceWindow.h"
#include "StemSeparator.h"

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

void runRequestedMaintenance(const juce::File& root)
{
    const auto request = requestFile(root);
    if (!request.existsAsFile()) return;
    SessionLease guard;
    const auto admission = guard.acquire(root, SessionLease::Mode::maintenance);
    if (admission.failed())
    {
        if (!request.existsAsFile()) return;
        juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::InfoIcon, "AI Runtime Maintenance",
            admission.getErrorMessage() + " The request is saved for a later launch.");
        return;
    }
    if (!request.existsAsFile()) return;
    const auto kind = request.loadFileAsString().trim();
    if (!request.deleteFile())
    {
        juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::WarningIcon, "AI Runtime Maintenance",
                                         "Could not consume the saved repair request.");
        return;
    }
    if (kind != "stems" && kind != "compiler") return;
    const bool compiler = kind == "compiler";
    const int choice = compiler
        ? (juce::AlertWindow::showOkCancelBox(juce::MessageBoxIconType::QuestionIcon, "AI Runtime Maintenance",
            "Rebuild and validate the optional compiler runtime before opening the DAW?", "Rebuild", "Open DAW") ? 1 : 0)
        : juce::AlertWindow::showYesNoCancelBox(juce::MessageBoxIconType::QuestionIcon, "AI Runtime Maintenance",
            "Check and repair incompatible stem tools, or rebuild them even if a previous check passed or failed. "
            "Your downloaded models are kept. The DAW will open after maintenance finishes.",
            "Check and repair", "Rebuild", "Open DAW");
    if (choice == 0) return;
    RepairTask task(std::move(guard), compiler, choice == 2);
    const bool completed = task.runThread();
    juce::AlertWindow::showMessageBox(juce::MessageBoxIconType::InfoIcon, "AI Runtime Maintenance",
        completed ? task.outcome : "Maintenance cancelled. OpenStudio will open after the worker exits.");
}
}
