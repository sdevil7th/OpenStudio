#include "StoreUpdater.h"
#include "WindowsPackage.h"

#if JUCE_WINDOWS
 #include <shobjidl.h>
 #include <winrt/Windows.ApplicationModel.h>
 #include <winrt/Windows.Foundation.Collections.h>
 #include <winrt/Windows.Services.Store.h>
#endif

namespace
{
using StoreResult = StoreUpdateTransport::Result;
juce::var statusFor(const juce::String& status, const juce::String& message)
{
    auto* value = new juce::DynamicObject();
    value->setProperty("status", status);
    value->setProperty("message", message);
    value->setProperty("currentVersion", ProjectInfo::versionString);
    value->setProperty("platform", "windows");
    value->setProperty("updateSource", "microsoft-store");
    return juce::var(value);
}

#if JUCE_WINDOWS
using winrt::Windows::Services::Store::StoreContext;
using winrt::Windows::Services::Store::StorePackageUpdate;
using winrt::Windows::Services::Store::StorePackageUpdateStatus;
using winrt::Windows::Services::Store::StorePackageUpdateState;
using winrt::Windows::Foundation::IAsyncInfo;
using winrt::Windows::Foundation::AsyncStatus;
namespace Collections = winrt::Windows::Foundation::Collections;

juce::String storeError(const winrt::hresult_error& error)
{
    return "Microsoft Store could not complete the update request (0x"
        + juce::String::toHexString(static_cast<unsigned int>(error.code().value))
        + "). Check your connection and Microsoft Store availability, then retry. "
          "A locally registered development package may not have a Store association.";
}

// No waits on the JUCE/UI thread. WinRT operations start on that thread, with
// HWND interop configured before invoking APIs which may display Store dialogs.
class WindowsStoreTransport final : public StoreUpdateTransport
{
    struct Session
    {
        StoreContext context { nullptr };
        Collections::IVectorView<StorePackageUpdate> updates { nullptr };
        IAsyncInfo operation { nullptr };
        uint64_t generation = 0;
        bool apartmentInitialised = false;
        ~Session()
        {
            operation = nullptr; updates = nullptr; context = nullptr;
            if (apartmentInitialised) winrt::uninit_apartment();
        }
    };
    std::shared_ptr<Session> session = std::make_shared<Session>();

    static void initialise(Session& data)
    {
        jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
        if (!WindowsPackage::isStoreManaged())
            throw winrt::hresult_error(E_ACCESSDENIED);
        if (!data.apartmentInitialised)
        {
            winrt::init_apartment(winrt::apartment_type::single_threaded);
            data.apartmentInitialised = true;
        }
        HWND owner = nullptr;
        auto& desktop = juce::Desktop::getInstance();
        for (int index = 0; index < desktop.getNumComponents(); ++index)
        {
            auto* component = desktop.getComponent(index);
            if (component->isVisible() && component->getPeer() != nullptr)
            {
                owner = static_cast<HWND>(component->getPeer()->getNativeHandle());
                break;
            }
        }
        if (owner == nullptr) throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE));
        if (!data.context) data.context = StoreContext::GetDefault();
        winrt::check_hresult(data.context.as<IInitializeWithWindow>()->Initialize(owner));
    }

    template <typename Work>
    static void post(std::weak_ptr<Session> weak, uint64_t generation, Work work)
    {
        juce::MessageManager::callAsync([weak, generation, work = std::move(work)]() mutable {
            if (auto data = weak.lock(); data && data->generation == generation) work(*data);
        });
    }

public:
    ~WindowsStoreTransport() override { cancel(); }
    void cancel() override
    {
        ++session->generation;
        auto operation = std::exchange(session->operation, nullptr);
        if (operation) { try { operation.Cancel(); } catch (const winrt::hresult_error&) {} }
    }

    void check(Done done) override
    {
        try
        {
            initialise(*session);
            session->updates = nullptr;
            const auto generation = ++session->generation;
            auto operation = session->context.GetAppAndOptionalStorePackageUpdatesAsync();
            session->operation = operation;
            operation.Completed([weak = std::weak_ptr<Session>(session), generation, done](auto op, AsyncStatus) {
                post(weak, generation, [op, done](Session& data) {
                    data.operation = nullptr;
                    try
                    {
                        data.updates = op.GetResults();
                        done({ data.updates.Size() == 0 ? StoreResult::current : StoreResult::available, {} });
                    }
                    catch (const winrt::hresult_error& error) { done({ StoreResult::error, storeError(error) }); }
                });
            });
        }
        catch (const winrt::hresult_error& error) { done({ StoreResult::error, storeError(error) }); }
    }

    void transfer(bool install, Progress progress, Done done) override
    {
        try
        {
            initialise(*session);
            if (!session->updates || session->updates.Size() == 0)
            {
                done({ StoreResult::error, "Check for updates again before downloading." });
                return;
            }
            const auto generation = ++session->generation;
            // Download-only never initiates installation. Install is called only
            // after the frontend's stopped-transport and successful-save checks.
            auto operation = install
                ? session->context.RequestDownloadAndInstallStorePackageUpdatesAsync(session->updates)
                : session->context.RequestDownloadStorePackageUpdatesAsync(session->updates);
            session->operation = operation;
            operation.Progress([weak = std::weak_ptr<Session>(session), generation, progress](auto, StorePackageUpdateStatus update) {
                post(weak, generation, [progress, value = update.TotalDownloadProgress](Session&) {
                    progress(juce::jlimit(0.0, 1.0, value));
                });
            });
            operation.Completed([weak = std::weak_ptr<Session>(session), generation, install, done](auto op, AsyncStatus) {
                post(weak, generation, [op, install, done](Session& data) {
                    data.operation = nullptr;
                    try
                    {
                        const auto result = op.GetResults();
                        switch (result.OverallState())
                        {
                            case StorePackageUpdateState::Completed:
                                done({ install ? StoreResult::installed : StoreResult::downloaded, {} }); break;
                            case StorePackageUpdateState::Canceled:
                                done({ StoreResult::cancelled, "Update postponed. You can retry when ready." }); break;
                            case StorePackageUpdateState::ErrorLowBattery:
                                done({ StoreResult::error, "Connect your computer to power, then retry the update." }); break;
                            case StorePackageUpdateState::ErrorWiFiRecommended:
                            case StorePackageUpdateState::ErrorWiFiRequired:
                                done({ StoreResult::error, "Microsoft Store needs an unrestricted network connection. Connect to Wi-Fi, then retry." }); break;
                            default:
                                done({ StoreResult::error, "Microsoft Store could not complete the update. Check your connection and available disk space, then retry." }); break;
                        }
                    }
                    catch (const winrt::hresult_canceled&) { done({ StoreResult::cancelled, "Update postponed. You can retry when ready." }); }
                    catch (const winrt::hresult_error& error) { done({ StoreResult::error, storeError(error) }); }
                });
            });
        }
        catch (const winrt::hresult_error& error) { done({ StoreResult::error, storeError(error) }); }
    }
};
#endif
}

struct StoreUpdater::State : juce::Timer, std::enable_shared_from_this<StoreUpdater::State>
{
    std::unique_ptr<StoreUpdateTransport> transport;
    Callback statusCallback, completion;
    juce::var status = statusFor("idle", "Check for OpenStudio updates from Microsoft Store.");
    bool active = true, busy = false, offered = false, ready = false, installing = false;
    uint64_t generation = 0;
    juce::int64 lastSuccessfulCheck = 0;

    void publish(juce::var next)
    {
        status = std::move(next);
        if (active && statusCallback) statusCallback(status);
    }
    void finish(juce::var next)
    {
        stopTimer();
        busy = false;
        installing = false;
        ++generation; // Ignore any progress queued behind completion.
        auto done = std::exchange(completion, {});
        publish(std::move(next));
        if (active && done) done(status);
    }
    void timerCallback() override
    {
        transport->cancel();
        finish(statusFor("error", "Microsoft Store did not respond. Check your connection and try again."));
    }
    bool begin(Callback done)
    {
        if (!active) return false;
        if (busy) { if (done) done(status); return false; }
        if (!transport)
        {
            auto error = statusFor("error", "Microsoft Store updates are only available on Windows.");
            publish(error); if (done) done(error); return false;
        }
        busy = true;
        completion = std::move(done);
        ++generation;
        return true;
    }
    void transfer(bool install, Callback done)
    {
        if (!begin(std::move(done))) return;
        if (!offered || (install && !ready))
        {
            finish(statusFor("error", install ? "Download the update before installing." : "Check for updates before downloading."));
            return;
        }
        installing = install;
        publish(statusFor(install ? "installing" : "downloading",
            install ? "Installing through Microsoft Store. OpenStudio may close to finish the update."
                    : "Downloading the OpenStudio update from Microsoft Store..."));
        const auto token = generation;
        transport->transfer(install, [weak = weak_from_this(), token](double progress) {
            if (auto self = weak.lock(); self && self->active && self->busy && self->generation == token)
            {
                auto update = self->status.clone();
                update.getDynamicObject()->setProperty("progress", progress);
                self->publish(update);
            }
        }, [weak = weak_from_this(), token, install](StoreResult result) {
            if (auto self = weak.lock(); self && self->active && self->generation == token)
            {
                if (result.kind == StoreResult::downloaded && !install)
                {
                    self->ready = true;
                    self->finish(statusFor("download-ready", "Update downloaded. Save your work before installing."));
                }
                else if (result.kind == StoreResult::installed && install)
                {
                    self->offered = self->ready = false;
                    self->finish(statusFor("install-started", "Microsoft Store completed the update. Reopen OpenStudio if it closes."));
                }
                else
                {
                    self->ready = false;
                    self->finish(statusFor(result.kind == StoreResult::cancelled ? "cancelled" : "error", result.message));
                }
            }
        });
    }
};

StoreUpdater::StoreUpdater(Callback callback, std::unique_ptr<StoreUpdateTransport> transport)
    : state(std::make_shared<State>())
{
   #if JUCE_WINDOWS
    if (!transport) transport = std::make_unique<WindowsStoreTransport>();
   #endif
    state->transport = std::move(transport);
    state->statusCallback = std::move(callback);
    state->publish(state->status);
}
StoreUpdater::~StoreUpdater() { shutdown(); }
void StoreUpdater::shutdown()
{
    state->active = false;
    state->stopTimer();
    ++state->generation;
    if (state->transport) state->transport->cancel();
    state->completion = {};
    state->statusCallback = {};
}
void StoreUpdater::check(bool manual, Callback done)
{
    if (state->ready) { if (done) done(state->status); return; }
    const auto now = juce::Time::currentTimeMillis();
    if (!manual && state->lastSuccessfulCheck != 0 && now - state->lastSuccessfulCheck < 24LL * 60 * 60 * 1000)
    {
        if (done) done(statusFor("skipped", "The next automatic update check is scheduled for later."));
        return;
    }
    if (!state->begin(std::move(done))) return;
    state->offered = false;
    state->publish(statusFor("checking", "Checking Microsoft Store for OpenStudio updates..."));
    state->startTimer(60000);
    state->transport->check([weak = std::weak_ptr<State>(state), token = state->generation](StoreResult result) {
        if (auto self = weak.lock(); self && self->active && self->generation == token)
        {
            self->offered = result.kind == StoreResult::available;
            if (result.kind == StoreResult::available || result.kind == StoreResult::current)
            {
                self->lastSuccessfulCheck = juce::Time::currentTimeMillis();
                self->finish(statusFor(self->offered ? "update-available" : "up-to-date",
                    self->offered ? "An OpenStudio update is available from Microsoft Store."
                                  : "Microsoft Store reports no updates for this installation."));
            }
            else self->finish(statusFor("error", result.message));
        }
    });
}
void StoreUpdater::download(Callback done) { state->transfer(false, std::move(done)); }
void StoreUpdater::install(Callback done) { state->transfer(true, std::move(done)); }
void StoreUpdater::cancel()
{
    if (!state->active || !state->busy || state->installing) return;
    state->transport->cancel();
    state->ready = false;
    state->finish(statusFor("cancelled", "Download cancelled. You can retry when ready."));
}
