#pragma once

// The map owns these complete processors. Control-side retirement retains them
// across callback readers; audio never allocates, releases owners or rebuilds a graph.
struct BuiltInEQPreparedPrograms
{
    struct Voice
    {
        std::unique_ptr<OpenStudioEQ> engine;
        juce::AudioBuffer<float> audio, alignment;
        int delay=0,position=0,valid=0;
        void reset() noexcept {engine->reset();position=valid=0;}
        void align(int count) noexcept
        {
            if(delay==0)return;
            for(int sample=0;sample<count;++sample)
            {
                for(int channel=0;channel<2;++channel)
                {
                    const float input=audio.getSample(channel,sample);
                    const float output=valid>=delay?alignment.getSample(channel,position):0;
                    alignment.setSample(channel,position,input);audio.setSample(channel,sample,output);
                }
                if(++position==delay)position=0;
                valid=juce::jmin(delay,valid+1);
            }
        }
    };
    std::vector<Voice> voices;
    int latency=0,block=0,active=0,pending=-1,queued=-1,warmRemaining=0,fadePosition=0,fadeLength=1;
    std::atomic<int> displayed{0},previewVoice{-1};
    double tailSeconds=0;
    void reset() noexcept
    {
        for(auto& voice:voices)voice.reset();
        active=displayed.load();
        pending=queued=-1;
        previewVoice.store(-1);
        warmRemaining=fadePosition=0;
    }
};
