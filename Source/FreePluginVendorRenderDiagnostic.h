#pragma once

// Opt-in evidence only: compare a vendor's direct SDK processing in realtime
// and offline modes, without the application's track graph or export mixer.
inline juce::var checkVendorRenderDiagnostic()
{
    const auto fixturePath=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_VENDOR_RENDER_PROJECT",{});
    const auto pluginPath=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_FX_REGRESSION_PLUGIN",{});
    const auto outputPath=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_VENDOR_RENDER_OUTPUT",{});
    auto* result=new juce::DynamicObject();
    result->setProperty("name","Direct vendor cold/reset rendering");
    result->setProperty("audioQuality","not_asserted");
    result->setProperty("repeatParity","diagnostic_only");
    result->setProperty("pass",false);
    if(fixturePath.isEmpty() || pluginPath.isEmpty() || outputPath.isEmpty())return juce::var(result);
    const auto project=juce::JSON::parse(juce::File(fixturePath).loadFileAsString());
    const auto* tracks=project["tracks"].getArray();
    if(tracks == nullptr || tracks->isEmpty())return juce::var(result);
    const auto& track=tracks->getReference(0);
    const auto* clips=track["clips"].getArray();
    const auto* states=track["trackFXStates"].getArray();
    if(clips == nullptr || clips->isEmpty() || states == nullptr || states->isEmpty())return juce::var(result);
    const auto& clip=clips->getReference(0);
    juce::AudioFormatManager formats;formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(juce::File(clip["filePath"].toString())));
    juce::MemoryBlock state;
    if(!reader || !state.fromBase64Encoding(states->getReference(0).toString()))return juce::var(result);
    const double rate=reader->sampleRate;
    constexpr int blockSize=2048;
    const int samples=juce::roundToInt(8.0*rate);
    juce::AudioBuffer<float> source(2,samples);
    const auto fileStart=static_cast<juce::int64>(std::llround((5.0-static_cast<double>(clip["startTime"])+static_cast<double>(clip["offset"]))*rate));
    if(!reader->read(&source,0,samples,fileStart,true,true))return juce::var(result);
    if(reader->numChannels == 1)source.copyFrom(1,0,source,0,0,samples);
    struct Clock final : juce::AudioPlayHead {
        double rate=44100.0;juce::int64 sample=0;
        juce::Optional<PositionInfo> getPosition() const override {
            PositionInfo info;info.setTimeInSamples(sample);info.setTimeInSeconds(static_cast<double>(sample)/rate);
            info.setBpm(120);info.setPpqPosition(static_cast<double>(sample)/rate*2);info.setIsPlaying(true);return info;
        }
    };
    PluginManager manager;
    juce::Array<juce::var> runs;bool passed=true;
    for(const int style : {0,1,2})for(const bool offline : {true,false}) {
        const bool reapply=style>0;
        const bool componentOnly=style==2;
        const auto withoutOverlay=[](juce::MemoryBlock& blob) {
            if(auto xml=juce::AudioProcessor::getXmlFromBinary(blob.getData(),static_cast<int>(blob.getSize()))) {
                if(auto* overlay=xml->getChildByName("OpenStudioHostParameters"))xml->removeChildElement(overlay,true);
                juce::AudioProcessor::copyXmlToBinary(*xml,blob);
            }
        };
        auto plugin=manager.loadPluginFromFile(pluginPath,rate,blockSize);
        if(!plugin) {passed=false;continue;}
        juce::MemoryBlock initial(state);if(componentOnly)withoutOverlay(initial);
        plugin->setStateInformation(initial.getData(),static_cast<int>(initial.getSize()));
        juce::MemoryBlock original;plugin->getStateInformation(original);
        if(componentOnly)withoutOverlay(original);
        juce::AudioBuffer<float> first;
        for(int pass=0;pass<2;++pass) {
            plugin->setNonRealtime(offline);plugin->prepareToPlay(rate,blockSize);plugin->reset();
            if(pass || reapply)plugin->setStateInformation(original.getData(),static_cast<int>(original.getSize()));
            Clock clock;clock.rate=rate;clock.sample=static_cast<juce::int64>(std::llround(5.0*rate));plugin->setPlayHead(&clock);
            const int channels=juce::jmax(2,plugin->getTotalNumInputChannels(),plugin->getTotalNumOutputChannels());
            if(channels>32) {plugin->setPlayHead(nullptr);passed=false;break;}
            juce::AudioBuffer<float> output(2,samples),block(channels,blockSize);
            std::exception_ptr error;
            std::thread worker([&] {
                try {
                    juce::MidiBuffer midi;
                    for(int offset=0;offset<samples;offset+=blockSize) {
                        const int count=juce::jmin(blockSize,samples-offset);block.setSize(channels,count,false,false,true);block.clear();
                        for(int channel=0;channel<juce::jmin(channels,2);++channel)block.copyFrom(channel,0,source,channel,offset,count);
                        plugin->processBlock(block,midi);
                        for(int channel=0;channel<2;++channel)output.copyFrom(channel,offset,block,channel,0,count);
                        clock.sample+=count;midi.clear();
                    }
                }catch(...) {error=std::current_exception();}
            });worker.join();plugin->setPlayHead(nullptr);
            const auto name=juce::String(offline ? "offline" : "realtime")+(componentOnly ? "-component-state" : reapply ? "-restored" : "")+(pass ? "-repeat" : "-cold");
            const auto file=juce::File(outputPath).getChildFile(name+".wav");
            bool finite=!error;
            for(int channel=0;channel<2;++channel)for(int sample=0;sample<samples;++sample)finite=finite && std::isfinite(output.getSample(channel,sample));
            const bool written=finite && writeProbeWave(file,output,rate);passed=passed && written;
            auto* run=new juce::DynamicObject();run->setProperty("name",name);run->setProperty("file",file.getFullPathName());run->setProperty("pass",written);
            run->setProperty("sampleRate",rate);run->setProperty("sdkMode",juce::openStudioVST3PreparedProcessMode(*plugin));
            if(!pass)first.makeCopyOf(output);
            else {
                juce::Array<juce::var> windows;
                for(const auto& bounds : {std::pair<double,double>{.5,1.5},{3.,4.},{6.,7.5}}) {
                    double before=0,after=0,maxError=0;
                    for(int channel=0;channel<2;++channel)for(int sample=juce::roundToInt(bounds.first*rate);sample<juce::roundToInt(bounds.second*rate);++sample) {
                        const double a=first.getSample(channel,sample),b=output.getSample(channel,sample);before+=a*a;after+=b*b;maxError=juce::jmax(maxError,std::abs(a-b));
                    }
                    auto* window=new juce::DynamicObject();window->setProperty("start",5+bounds.first);window->setProperty("end",5+bounds.second);
                    window->setProperty("repeatMinusColdDB",10*std::log10(juce::jmax(1e-30,after)/juce::jmax(1e-30,before)));
                    window->setProperty("maxAbsoluteError",maxError);windows.add(juce::var(window));
                }
                run->setProperty("windows",windows);
            }
            runs.add(juce::var(run));
        }
        plugin->releaseResources();
    }
    result->setProperty("pass",passed && runs.size()==12);result->setProperty("runs",runs);return juce::var(result);
}
