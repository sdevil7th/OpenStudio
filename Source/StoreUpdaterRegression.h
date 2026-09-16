#pragma once
#include "StoreUpdater.h"

// Deterministic transport fixtures. No Store network calls or installation.
inline juce::var runStoreUpdaterRegression()
{
    struct FakeTransport final : StoreUpdateTransport
    {
        Done checked, transferred;
        Progress progress;
        int checks = 0, downloads = 0, installs = 0, cancels = 0;
        void check(Done done) override { ++checks; checked = std::move(done); }
        void transfer(bool install, Progress update, Done done) override
        {
            if (install) ++installs; else ++downloads;
            progress = std::move(update); transferred = std::move(done);
        }
        void cancel() override { ++cancels; }
    };
    using StoreResult = StoreUpdateTransport::Result;
    juce::Array<juce::var> checks;
    const auto expect = [&](const juce::String& name, bool pass) {
        auto* result = new juce::DynamicObject();
        result->setProperty("id", name); result->setProperty("pass", pass);
        checks.add(juce::var(result));
    };
    auto transport = std::make_unique<FakeTransport>();
    auto* fake = transport.get();
    juce::var status;
    int completions = 0, publications = 0;
    auto done = [&](const juce::var&) { ++completions; };
    StoreUpdater updater([&](const juce::var& value) { status = value; ++publications; }, std::move(transport));
    expect("store_channel_ready", status["updateSource"] == "microsoft-store" && status["status"] == "idle");
    updater.install(done);
    updater.download(done);
    expect("rejects_install_or_download_without_offer", fake->installs == 0 && fake->downloads == 0 && completions == 2);
    updater.check(true, done);
    updater.check(true, done);
    expect("deduplicates_checks", fake->checks == 1 && status["status"] == "checking");
    fake->checked({ StoreResult::available, {} });
    expect("offer_has_no_invented_version_or_installer", status["status"] == "update-available" && status["version"].isVoid() && status["downloadUrl"].isVoid());
    updater.check(false, done);
    expect("automatic_check_throttled", fake->checks == 1);
    updater.download(done);
    updater.download(done);
    expect("download_never_installs", fake->downloads == 1 && fake->installs == 0);
    fake->progress(0.4);
    expect("download_progress", static_cast<double>(status["progress"]) == 0.4);
    auto lateProgress = fake->progress;
    auto lateCompletion = fake->transferred;
    updater.cancel();
    const auto cancelledReplies = completions;
    lateProgress(0.9); lateCompletion({ StoreResult::downloaded, {} });
    expect("cancel_ignores_late_callbacks", status["status"] == "cancelled" && completions == cancelledReplies && fake->cancels == 1);
    updater.download(done);
    fake->transferred({ StoreResult::error, "Offline" });
    expect("download_error_visible", status["status"] == "error" && status["message"] == "Offline");
    updater.download(done);
    fake->transferred({ StoreResult::downloaded, {} });
    expect("retry_becomes_ready", status["status"] == "download-ready" && fake->installs == 0);
    lateProgress = fake->progress;
    lateProgress(0.2);
    updater.check(true, done);
    expect("ready_not_overwritten_by_progress_or_check", status["status"] == "download-ready" && fake->checks == 1);
    updater.install(done);
    updater.cancel();
    expect("install_explicit_and_not_cancelled_by_download_button", fake->installs == 1 && fake->cancels == 1 && status["status"] == "installing");
    fake->transferred({ StoreResult::cancelled, "Declined" });
    updater.install(done);
    expect("declined_install_requires_download_retry", fake->installs == 1);
    updater.download(done); fake->transferred({ StoreResult::downloaded, {} });
    updater.install(done); fake->transferred({ StoreResult::installed, {} });
    expect("store_install_result", status["status"] == "install-started" && fake->installs == 2);
    updater.check(true, done); fake->checked({ StoreResult::current, {} });
    expect("no_update_no_offer", status["status"] == "up-to-date");
    updater.check(true, done); fake->checked({ StoreResult::error, "Store unavailable" });
    expect("store_query_failure_not_up_to_date", status["status"] == "error");
    updater.check(true, done);
    auto afterShutdown = fake->checked;
    updater.shutdown();
    const auto previousPublications = publications;
    const auto previousCompletions = completions;
    afterShutdown({ StoreResult::available, {} });
    expect("shutdown_invalidates_callbacks", publications == previousPublications && completions == previousCompletions);
    bool pass = true;
    for (const auto& check : checks) pass = pass && static_cast<bool>(check["pass"]);
    auto* report = new juce::DynamicObject();
    report->setProperty("pass", pass); report->setProperty("checks", checks);
    report->setProperty("storeDeliveredUpgrade", "not_asserted");
    return juce::var(report);
}
