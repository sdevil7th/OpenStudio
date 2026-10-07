#pragma once

juce::var checkConvolutionOutputs()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Four-output convolution matrix paths");
    bool passed=true,portable=true,legacy=true;double maximumError=0;
    const auto directory=juce::File::getCurrentWorkingDirectory().getChildFile("output/free-suite-convolution-output-tests");directory.createDirectory();
    const auto settings=[](int layout,int order){auto* value=new juce::DynamicObject();value->setProperty("normalise",false);value->setProperty("outputLayout",layout);value->setProperty("channelOrder",order);return juce::var(value);};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int block:{1,127,512})for(int order:{0,1})
    {
        juce::AudioBuffer<float> ir(4,2048);ir.clear();
        ir.setSample(0,0,.5f);ir.setSample(1,73,.25f);ir.setSample(2,109,-.125f);ir.setSample(3,151,.4f);
        ir.setSample(0,512,.25f);ir.setSample(1,1023,.125f);ir.setSample(2,1537,-.25f);ir.setSample(3,2047,.125f);
        const auto file=directory.getChildFile("coded-paths.wav");passed=writeProbeWave(file,ir,rate)&&passed;
        BuiltInConvolution split,stereo;passed=split.loadFile(file)&&stereo.loadFile(file)&&split.edit(settings(1,order))&&stereo.edit(settings(0,order))&&passed;
        juce::ValueTree state("Convolution");split.save(state);BuiltInConvolution restored;portable=restored.restore(state)&&portable;
        split.prepare(rate,block);stereo.prepare(rate,block);restored.prepare(rate,block);
        juce::AudioBuffer<float> expected(4,2048);expected.clear();
        expected.setSample(0,0,.125f);expected.setSample(1,151,-.2f);
        expected.setSample(order==0?3:2,73,order==0?.0625f:-.125f);
        expected.setSample(order==0?2:3,109,order==0?.0625f:-.03125f);
        expected.setSample(0,512,.0625f);expected.setSample(1,2047,-.0625f);
        expected.setSample(order==0?3:2,1023,order==0?.03125f:-.0625f);
        expected.setSample(order==0?2:3,1537,order==0?.125f:-.0625f);
        for(int start=0;start<2048;start+=block)
        {
            const int count=juce::jmin(block,2048-start);
            juce::AudioBuffer<float> a(4,count),b(2,count),c(4,count);a.clear();b.clear();c.clear();
            if(start==0)for(auto* audio:{&a,&b,&c}){audio->setSample(0,0,.25f);audio->setSample(1,0,-.5f);}
            split.process(a,0,20,20000,1,true,false);stereo.process(b,0,20,20000,1,true,false);restored.process(c,0,20,20000,1,true,false);
            for(int channel=0;channel<4;++channel)for(int sample=0;sample<count;++sample)
            {
                maximumError=juce::jmax(maximumError,std::abs(static_cast<double>(a.getSample(channel,sample)-expected.getSample(channel,start+sample))));
                portable=portable&&std::abs(a.getSample(channel,sample)-c.getSample(channel,sample))<1e-7f;
            }
            for(int channel=0;channel<2;++channel)for(int sample=0;sample<count;++sample)
                legacy=legacy&&std::abs(a.getSample(channel,sample)+a.getSample(channel+2,sample)-b.getSample(channel,sample))<1e-7f;
        }
    }
    auto reverb=std::make_unique<OpenStudioReverb>(true);
    auto invalidLayout=reverb->getBusesLayout();invalidLayout.outputBuses.set(1,juce::AudioChannelSet::mono());
    passed=passed&&!reverb->isBusesLayoutSupported(invalidLayout);
    const auto file=directory.getChildFile("coded-paths.wav");
    bool host=reverb->convolutionSpace.loadFile(file)&&reverb->convolutionSpace.edit(settings(1,0));
    reverb->algorithm.store(7);reverb->wetLevel.store(1);reverb->dryLevel.store(0);
    juce::MemoryBlock saved;reverb->getStateInformation(saved);
    auto restored=std::make_unique<OpenStudioReverb>(true);restored->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));
    host=host&&restored->getTotalNumOutputChannels()==4&&static_cast<int>(restored->convolutionSpace.info()["shape"]["outputLayout"])==1;
    restored->prepareToPlay(48000,256);juce::AudioBuffer<float> audio(4,256);audio.clear();audio.setSample(0,0,.25f);audio.setSample(1,0,-.5f);juce::MidiBuffer midi;
    restored->processBlock(audio,midi);host=host&&audio.getMagnitude(2,0,256)>1e-5f&&audio.getMagnitude(3,0,256)>1e-5f;
    result->setProperty("pass",passed&&portable&&legacy&&host&&maximumError<2e-6);
    result->setProperty("maximumPathError",maximumError);result->setProperty("portableState",portable);
    result->setProperty("stereoSumParity",legacy);result->setProperty("hostOutputsAndState",host);
    result->setProperty("audioQuality","not_asserted");return result;
}
