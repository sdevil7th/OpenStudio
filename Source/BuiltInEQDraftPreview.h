#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <mutex>

// Control threads publish bounded POD plans. The callback copies one acquired
// slot and releases it; it never allocates, locks or destroys an owned object.
class BuiltInEQDraftPreview
{
public:
    using Coefficients=std::array<float,5>;
    struct Plan { std::array<Coefficients,64> coefficients{};int stages=0;uint64_t fingerprint=0,ticket=0,revision=0;double rate=0; };
    juce::var start(const juce::String& session,Plan plan,bool update=false)
    {
        const std::lock_guard<std::mutex> lock(control);
        if(session.isEmpty()||session.length()>128)return reply(false,"Invalid audition session");
        const auto current=wanted.load();
        if(update&&(current==0||session!=owner))return reply(false,"Audition session is no longer active");
        if(!update&&current!=0)return reply(false,"Another proposal is being auditioned");
        if(plan.stages<1||plan.stages>64)return reply(false,"Invalid audition filter count");
        if(update)discardPending();
        Slot* free=nullptr;
        for(auto& slot:mailbox){int expected=0;if(slot.state.compare_exchange_strong(expected,1)){free=&slot;break;}}
        if(!free)return reply(false,"Audition publication is busy; try again");
        plan.ticket=update?current:++serial;plan.revision=++revision;owner=session;remaining.store(static_cast<int>(plan.rate*6));reason.store(0);
        free->plan=plan;if(!update)wanted.store(plan.ticket,std::memory_order_release);free->state.store(2,std::memory_order_release);
        return reply(true,{});
    }
    juce::var command(const juce::String& session,bool stop,bool immediate=false)
    {
        const std::lock_guard<std::mutex> lock(control);
        if(session!=owner)return reply(false,"Audition session is no longer active");
        if(stop){if(immediate)hardStop.store(wanted.load());wanted.store(0);reason.store(1);discardPending();}
        else if(wanted.load()!=0)remaining.store(static_cast<int>(controlRate.load()*6));
        auto result=reply(true,{});result.getDynamicObject()->setProperty("active",wanted.load()!=0);
        result.getDynamicObject()->setProperty("reason",reason.load());return result;
    }
    void reset(double sampleRate) noexcept
    {
        wanted.store(0);actual.store(0);reason.store(1);discardPending();
        active={};previous={};history={};previousHistory={};mix.reset(sampleRate,.05);mix.setCurrentAndTargetValue(0);
        transition.reset(sampleRate,.02);transition.setCurrentAndTargetValue(1);controlRate.store(sampleRate);
    }
    bool requested() const noexcept { return wanted.load()!=0||actual.load()!=0; }
    // Invoked once even on bypass/linear early-return paths.
    void beginBlock(int samples,double rate,uint64_t fingerprint,bool eligible,bool offline) noexcept
    {
        if(offline){reset(rate);return;}
        if(const auto ticket=hardStop.exchange(0);ticket!=0&&ticket==active.ticket){active={};previous={};history={};previousHistory={};mix.setCurrentAndTargetValue(0);transition.setCurrentAndTargetValue(1);actual.store(0);}
        auto target=wanted.load(std::memory_order_acquire);
        if(target!=0&&remaining.fetch_sub(samples)<=samples){wanted.compare_exchange_strong(target,0);reason.store(3);target=wanted.load();}
        if(!eligible){reset(rate);reason.store(2);return;}
        if(active.ticket!=0&&(active.ticket!=target||active.fingerprint!=fingerprint||active.rate!=rate))
        {
            if(active.ticket==target){wanted.compare_exchange_strong(target,0);reason.store(2);}
            mix.setTargetValue(0);
        }
        if(active.ticket==0||(!mix.isSmoothing()&&mix.getCurrentValue()==0))
        {
            active={};previous={};history={};previousHistory={};actual.store(0);transition.setCurrentAndTargetValue(1);
        }
        if(!transition.isSmoothing()&&(active.ticket==0||active.ticket==wanted.load()))
        {
            for(auto& slot:mailbox)
            {
                int expected=2;if(!slot.state.compare_exchange_strong(expected,3,std::memory_order_acquire))continue;
                if(slot.plan.ticket==wanted.load()&&eligible&&slot.plan.fingerprint==fingerprint&&slot.plan.rate==rate)
                {
                    if(active.ticket==0)
                    {active=slot.plan;history={};mix.setCurrentAndTargetValue(0);mix.setTargetValue(1);actual.store(active.ticket);}
                    else if(active.ticket==slot.plan.ticket&&slot.plan.revision>active.revision)
                    {previous=active;previousHistory=history;active=slot.plan;history={};transition.setCurrentAndTargetValue(0);transition.setTargetValue(1);}
                }
                else if(slot.plan.ticket==wanted.load()){wanted.store(0);reason.store(2);}
                slot.state.store(0,std::memory_order_release);
                if(transition.isSmoothing())break;
            }
        }
    }
    void process(juce::AudioBuffer<float>& buffer) noexcept
    {
        if(active.ticket==0)return;
        for(int sample=0;sample<buffer.getNumSamples();++sample)
        {
            const float amount=mix.getNextValue(),crossfade=transition.getNextValue();
            for(int ch=0;ch<juce::jmin(2,buffer.getNumChannels());++ch)
            {
                const float dry=buffer.getSample(ch,sample);double value=filter(active,history[static_cast<size_t>(ch)],dry);
                if(crossfade<1&&previous.ticket!=0){const auto old=filter(previous,previousHistory[static_cast<size_t>(ch)],dry);value=old+crossfade*(value-old);}
                buffer.setSample(ch,sample,dry+amount*(static_cast<float>(value)-dry));
            }
        }
        if(!mix.isSmoothing()&&mix.getCurrentValue()==0){active={};previous={};actual.store(0);history={};previousHistory={};transition.setCurrentAndTargetValue(1);}
    }
    // Callback owner only. Prepared EQ incorporates the draft into its kernel
    // and owns the audible transition; advance the lease/mailer ramp bookkeeping
    // without processing the same correction again as an IIR post-stage.
    void advancePrepared(int samples) noexcept { mix.skip(samples); transition.skip(samples); }
    const Plan* preparedPlan() const noexcept
    { return active.ticket != 0 && active.ticket == wanted.load(std::memory_order_acquire) ? &active : nullptr; }
private:
    struct Slot { std::atomic<int> state{0};Plan plan; };
    std::array<Slot,3> mailbox;
    std::mutex control;juce::String owner;uint64_t serial=0,revision=0;
    std::atomic<uint64_t> wanted{0},actual{0},hardStop{0};std::atomic<int> remaining{0},reason{0};std::atomic<double> controlRate{48000};
    using ChannelHistory=std::array<std::array<double,2>,64>;
    Plan active,previous;std::array<ChannelHistory,2> history{},previousHistory{};
    juce::SmoothedValue<float> mix,transition;
    static double filter(const Plan& plan,ChannelHistory& state,double value) noexcept
    {for(int stage=0;stage<plan.stages;++stage){const auto& c=plan.coefficients[static_cast<size_t>(stage)];auto& h=state[static_cast<size_t>(stage)];const double output=c[0]*value+h[0];h[0]=c[1]*value-c[3]*output+h[1];h[1]=c[2]*value-c[4]*output;value=output;}return value;}
    void discardPending() noexcept { for(auto& slot:mailbox){int expected=2;slot.state.compare_exchange_strong(expected,0,std::memory_order_acq_rel);} }
    static juce::var reply(bool success,const juce::String& error){auto* r=new juce::DynamicObject();r->setProperty("success",success);if(error.isNotEmpty())r->setProperty("error",error);return r;}
};
