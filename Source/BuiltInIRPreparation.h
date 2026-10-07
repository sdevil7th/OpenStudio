#pragma once
#include <JuceHeader.h>
#include <atomic>

// Worker/UI coordination only. Cancellation and publication contend on one CAS:
// a successful cancel can never publish an IR afterwards.
class BuiltInIRPreparation
{
public:
    enum State { running, publishing, complete, cancelled, failed };
    enum Stage { queued, reading, validating, shaping, analysing, preparing, finalising };
    bool claim() noexcept { bool expected=false;return claimed.compare_exchange_strong(expected,true); }
    bool advance(Stage next) noexcept
    {
        if(state.load()!=running)return false;
        stage.store(next);return state.load()==running;
    }
    bool cancel() noexcept { int expected=running;return state.compare_exchange_strong(expected,cancelled); }
    bool isCancelled() const noexcept {return state.load()==cancelled;}
    bool terminal() const noexcept {return finished.load();}
    bool publish() noexcept
    {
        int expected=running;if(!state.compare_exchange_strong(expected,publishing))return false;
        stage.store(finalising);return true;
    }
    void finish(bool success) noexcept
    {
        int expected=publishing;
        if(!state.compare_exchange_strong(expected,success?complete:failed))
        {expected=running;state.compare_exchange_strong(expected,success?complete:failed);}
        finished.store(true);
    }
    juce::var info() const
    {
        static const char* const names[]{"running","publishing","complete","cancelled","failed"};
        const int current=state.load();auto* result=new juce::DynamicObject();
        result->setProperty("state",names[current]);result->setProperty("stage",stage.load());result->setProperty("cancellable",current==running);return result;
    }
    struct FinishGuard
    {
        std::shared_ptr<BuiltInIRPreparation> job;
        ~FinishGuard(){if(job)job->finish(false);}
    };
private:
    std::atomic<int> state{running},stage{queued};
    std::atomic<bool> claimed{false},finished{false};
};
