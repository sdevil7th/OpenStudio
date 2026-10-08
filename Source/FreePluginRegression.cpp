#include "OfflineMutationRegression.h"
namespace juce { class AudioProcessor; bool openStudioVST3AutomationQueueSelfTest();
    int openStudioVST3PreparedProcessMode(AudioProcessor&);
    int openStudioVST3PreparedSampleSize(AudioProcessor&); }
#include "BuiltInAllPassFit.h"
#include "FreePluginRegression.h"
#include "MIDIParameterChase.h"
#include "BuiltInEffects.h"
#include "BuiltInEQMatch.h"
#include "BuiltInEffects2.h"
#include "BuiltInUtilityEffects.h"
#include "OpenStudioPitchCorrector.h"
#include "BuiltInInstrumentPreview.h"
#include "BuiltInIRPreview.h"
#include "BuiltInInstrumentPreviewBindings.h"
#include "TrackProcessor.h"
#include "JSFXProcessor.h"
#include "CLAPPluginFormat.h"
#include "PluginManager.h"
#include "AudioEngine.h"
#include "MIDIClip.h"
#include <cmath>
#include <functional>
#include <thread>
#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

namespace
{
bool writeProbeWave(const juce::File& file, const juce::AudioBuffer<float>& audio, double rate)
{
    file.getParentDirectory().createDirectory();
    std::unique_ptr<juce::OutputStream> stream = file.createOutputStream();
    if (!stream) return false;
    stream->setPosition(0);
    juce::WavAudioFormat format;
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions().withSampleRate(rate)
        .withNumChannels(audio.getNumChannels()).withBitsPerSample(32).withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
    return writer && writer->writeFromAudioSampleBuffer(audio, 0, audio.getNumSamples());
}

#include "FreePluginTenHourListening.h"
#include "FreePluginMultiOutputRegression.h"
#include "FreePluginInstrumentTailRegression.h"
#include "FreePluginInstrumentPerformanceRegression.h"
#include "FreePluginDelayTelemetryRegression.h"
#include "FreePluginOriginalColourRegression.h"
#include "FreePluginOriginalColourSpectralRegression.h"
#include "FreePluginGuitarPerformanceRegression.h"
#include "FreePluginGateOnsetRegression.h"
#include "FreePluginHumanizeRegression.h"
#include "FreePluginPerformanceRegression.h"
#include "FreePluginAutomationRegistryRegression.h"
#include "FreePluginVendorRenderDiagnostic.h"
#include "FreePluginStressPerformance.h"
#include "FreePluginConvolutionOutputsRegression.h"
#include "FreePluginDelayDiffusionRegression.h"
#include "FreePluginMPERegression.h"
#include "FreePluginEQPhaseRegression.h"
#include "FreePluginEQDetectorRegression.h"
#include "FreePluginEQCutRegression.h"
#include "FreePluginMinimumEQRegression.h"
#include "FreePluginAnalogEQRegression.h"
#include "FreePluginEQDraftModesRegression.h"
#include "FreePluginEQAdaptiveRegression.h"
#include "FreePluginSpectralEQRegression.h"
#include "FreePluginLinearDynamicsRegression.h"
#include "FreePluginReverbHoldRegression.h"
#include "FreePluginReverbSpilloverRegression.h"
#include "FreePluginAutomationRangeRegression.h"
#include "FreePluginConvolutionMotionRegression.h"
#include "FreePluginAllPassFitRegression.h"
#include "FreePluginSpectralPhaseRegression.h"
#include "FreePluginAlignmentSectionsRegression.h"
#include "FreePluginSparseAlignmentRegression.h"
#include "FreePluginProjectSpanRegression.h"
#include "FreePluginOctaveAnalysisRegression.h"
#include "FreePluginIRGeometryRegression.h"
#include "FreePluginAlignmentGroupsRegression.h"
#include "FreePluginVintageConversionRegression.h"
#include "FreePluginVintageTankRateRegression.h"
#include "FreePluginLongPredelayRegression.h"
#include "FreePluginLowRateChannelRegression.h"
#include "FreePluginModalPlateRegression.h"
#include "FreePluginSpatialLongDelayRegression.h"
#include "FreePluginIRBrightnessRegression.h"
#include "FreePluginIRSourceBlendRegression.h"
#include "FreePluginSynthOscillatorRegression.h"
#include "FreePluginSynthExpandedMatrixRegression.h"
#include "FreePluginSynthDestinationsRegression.h"
#include "FreePluginGuitarArticulationRegression.h"
#include "FreePluginCoupledBodyRegression.h"
#include "FreePluginIRPreparationRegression.h"
#include "FreePluginConvolutionExtensionRegression.h"
#include "FreePluginCompactRoomRegression.h"
#include "FreePluginSpatialShelfRegression.h"
#include "FreePluginEQSketchRegression.h"
#include "FreePluginEQMixedSketchRegression.h"
#include "FreePluginPeakHoldRegression.h"
#include "FreePluginReverbReconstructedPeakRegression.h"
#include "FreePluginMIDIOrderRegression.h"
#include "FreePluginRelativeRPNRegression.h"
#include "FreePluginVintageBuildUpRegression.h"
#include "FreePluginDriftingReverbRegression.h"
#include "FreePluginClearReverbRegression.h"
#include "FreePluginRetroReverbRegression.h"
#include "FreePluginStudioFilterRegression.h"
#include "FreePluginPlateFilterRegression.h"
#include "FreePluginModalMaterialRegression.h"
#include "FreePluginFETTiltRegression.h"
#include "FreePluginFETMultiRegression.h"
#include "FreePluginVCAMonitorRegression.h"
#include "FreePluginNonlinearMotionRegression.h"
#include "FreePluginDrumArticulationRegression.h"
#include "FreePluginLimiterStylesRegression.h"
#include "FreePluginMIDIOutputPolicyRegression.h"
#include "FreePluginSpringHoldRegression.h"
#include "FreePluginMagneticHoldRegression.h"
#include "FreePluginNonlinearHoldRegression.h"
#include "FreePluginPositionedHoldRegression.h"
#include "FreePluginEQMIDIProgramsRegression.h"
#include "FreePluginEQPreparedProgramsRegression.h"
#include "FreePluginContinuousAlignmentRegression.h"
#include "FreePluginPitchCostRegression.h"
#include "FreePluginReverbResponseRegression.h"
#include "FreePluginEQDraftRegression.h"
#include "FreePluginSostenutoRegression.h"
#include "FreePluginMacroCCRegression.h"
#include "FreePluginMIDIChannelMixRegression.h"
#include "FreePluginLimiterOversamplingRegression.h"
#include "FreePluginEQShapeRegression.h"
#include "FreePluginMIDISeekStateRegression.h"
#include "FreePluginMIDIHistoryRegression.h"
#include "FreePluginMIDIMultiplicityRegression.h"

juce::var checkGuitarPluckedLoop()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Guitar plucked loop and delay chorus");
    double pitchErrorCents=0,partitionError=0;bool finite=true,muteEffect=true;juce::Array<juce::var> pitches;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInPluckedLoop loop;loop.prepare(rate);BuiltInPluckedLoop::Parameters parameters;parameters.decay=5;parameters.damping=.1f;parameters.body=0;parameters.hardness=.8f;
        for(int note:{40,69,88})
        {
            const float frequency=static_cast<float>(juce::MidiMessage::getMidiNoteInHertz(note));loop.reset();loop.start(0,note,.8f,parameters);
            const int count=static_cast<int>(rate*2),skip=static_cast<int>(rate*.25),window=static_cast<int>(rate*1.5);int order=1;while((1<<order)<count)++order;const int size=1<<order;
            std::vector<float> spectrum(static_cast<size_t>(size*2),0);
            for(int i=0;i<count;++i){const float value=loop.process(0,frequency,parameters);finite=finite&&std::isfinite(value)&&std::abs(value)<4;if(i>=skip&&i<skip+window)spectrum[static_cast<size_t>(i-skip)]=value*static_cast<float>(.5-.5*std::cos(juce::MathConstants<double>::twoPi*(i-skip)/(window-1)));}
            juce::dsp::FFT fft(order);fft.performFrequencyOnlyForwardTransform(spectrum.data());int peak=juce::roundToInt(frequency*size/rate);const int first=juce::jmax(2,static_cast<int>(frequency*.9*size/rate)),last=static_cast<int>(frequency*1.1*size/rate);for(int bin=first;bin<=last;++bin)if(spectrum[static_cast<size_t>(bin)]>spectrum[static_cast<size_t>(peak)])peak=bin;
            const double a=std::log(spectrum[static_cast<size_t>(peak-1)]+1e-20f),b=std::log(spectrum[static_cast<size_t>(peak)]+1e-20f),c=std::log(spectrum[static_cast<size_t>(peak+1)]+1e-20f);const double offset=.5*(a-c)/(a-2*b+c);const double measured=(peak+offset)*rate/size;const double error=1200*std::log2(measured/frequency);pitchErrorCents=juce::jmax(pitchErrorCents,std::abs(error));auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("note",note);row->setProperty("centsError",error);pitches.add(row);
        }
        std::array<double,2> energy{};
        for(int muted=0;muted<2;++muted){parameters.mute=static_cast<float>(muted);loop.reset();loop.start(0,69,.8f,parameters);for(int i=0;i<static_cast<int>(rate*1.2);++i){const float value=loop.process(0,440,parameters);if(i>rate*.7)energy[static_cast<size_t>(muted)]+=static_cast<double>(value)*value;}}
        muteEffect=muteEffect&&energy[0]>.00001&&energy[1]<energy[0]*.1;
    }
    const auto render=[](int blockSize,int bendChannel,float wet)
    {
        auto guitar=std::make_unique<OpenStudioCleanGuitarInstrument>();guitar->stringEngine.store(1);guitar->stringMode.store(0);guitar->chorusMix.store(wet);guitar->body.store(0);guitar->pickNoise.store(0);guitar->prepareToPlay(48000,blockSize);
        constexpr int length=24000,change=9600;juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;){int count=juce::jmin(blockSize,length-start);if(start<change)count=juce::jmin(count,change-start);block.setSize(2,count,false,false,true);block.clear();midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(2,69,.75f),0);if(start==change&&bendChannel>0)midi.addEvent(juce::MidiMessage::pitchWheel(bendChannel,16383),0);guitar->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;}return output;
    };
    const auto a=render(127,2,.4f),b=render(512,2,.4f),dry=render(127,0,0),otherChannel=render(127,1,0),bent=render(127,2,0);double otherError=0,bendDifference=0;
    for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){finite=finite&&std::isfinite(a.getSample(ch,i))&&std::abs(a.getSample(ch,i))<=2.5f;partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));otherError=juce::jmax(otherError,std::abs(static_cast<double>(dry.getSample(ch,i)-otherChannel.getSample(ch,i))));bendDifference+=std::abs(dry.getSample(ch,i)-bent.getSample(ch,i));}
    writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/guitar-loop-listening/bend-chorus.wav"),a,48000);writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/guitar-loop-listening/dry-pluck.wav"),dry,48000);
    BuiltInGuitarChorus chorus;chorus.prepare(48000,1,1,0);juce::AudioBuffer<float> impulse(2,1024);impulse.clear();impulse.setSample(0,0,.2f);impulse.setSample(1,0,-.1f);chorus.process(impulse,1,1,0);bool delay=true;for(int i=0;i<1024;++i)delay=delay&&std::abs(impulse.getSample(0,i)-(i==576?.2f:0))<1e-7&&std::abs(impulse.getSample(1,i)-(i==576?-.1f:0))<1e-7;
    auto original=std::make_unique<OpenStudioCleanGuitarInstrument>();bool setters=true;for(const auto& control:OpenStudioCleanGuitarInstrument::stringControls)setters=setters&&setFreePluginParamForRegression(*original,control.id,control.maximum);juce::MemoryBlock state;original->getStateInformation(state);auto restored=std::make_unique<OpenStudioCleanGuitarInstrument>();restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=true;for(const auto& control:OpenStudioCleanGuitarInstrument::stringControls)recall=recall&&(original.get()->*control.member).load()==(restored.get()->*control.member).load();auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(const auto& control:OpenStudioCleanGuitarInstrument::stringControls)tree.removeProperty(control.id,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);restored->setStateInformation(old.getData(),static_cast<int>(old.getSize()));bool migration=true;for(const auto& control:OpenStudioCleanGuitarInstrument::stringControls)migration=migration&&(restored.get()->*control.member).load()==control.initial;
    const auto schema=describeFreePluginForRegression(*original);const auto* descriptors=schema["parameters"].getArray();const bool appended=descriptors&&descriptors->size()>=19&&(*descriptors)[9]["id"].toString()=="stringEngine"&&(*descriptors)[18]["id"].toString()=="chorusDepth";
    result->setProperty("pass",pitchErrorCents<5&&partitionError<1e-8&&finite&&muteEffect&&otherError==0&&bendDifference>1&&delay&&setters&&recall&&migration&&appended);result->setProperty("pitchErrorCents",pitchErrorCents);result->setProperty("pitchMeasurements",pitches);result->setProperty("partitionError",partitionError);result->setProperty("finite",finite);result->setProperty("palmMuteLoss",muteEffect);result->setProperty("otherChannelBendError",otherError);result->setProperty("sameChannelBendDifference",bendDifference);result->setProperty("chorusDelayImpulse",delay);result->setProperty("setters",setters);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkDrumPieceControls()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Drum piece tuning pan and native mapping");
    const auto render=[](double rate,int blockSize,float semitones,float pan,bool automate)
    {
        OpenStudioDrumInstrument drums;drums.ambience.store(0);drums.outputGain.store(-30);drums.stereoWidth.store(1);drums.pieceTuning[4].store(semitones);drums.piecePan[4].store(pan);drums.prepareToPlay(rate,blockSize);
        const int length=static_cast<int>(rate*.6),change=juce::roundToInt(rate*.2);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<length;){int count=juce::jmin(blockSize,length-start);if(automate&&start<change)count=juce::jmin(count,change-start);if(automate&&start==change){drums.pieceTuning[4].store(12);drums.piecePan[4].store(.5f);}block.setSize(2,count,false,false,true);block.clear();midi.clear();if(start==0)midi.addEvent(juce::MidiMessage::noteOn(10,41,.75f),0);drums.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;}return output;
    };
    double frequencyError=0,partitionError=0;bool panIsolation=true,finite=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(float semitones:{-12.0f,0.0f,12.0f})
        {
            const auto audio=render(rate,127,semitones,-1,false);double first=-1,last=0;int crossings=0;
            for(int i=static_cast<int>(rate*.2)+1;i<static_cast<int>(rate*.55);++i){const float a=audio.getSample(0,i-1),b=audio.getSample(0,i);if(a<=0&&b>0){const double position=i-1-a/(b-a);if(first<0)first=position;last=position;++crossings;}}
            if(crossings>1)frequencyError=juce::jmax(frequencyError,std::abs((crossings-1)*rate/(last-first)-82*std::exp2(semitones/12.0f)));else finite=false;
        }
        const auto left=render(rate,127,0,-1,false),right=render(rate,127,0,1,false);
        // Low tom's existing +.34 placement plus -1 is -.66, whereas +1 clamps fully right.
        panIsolation=panIsolation&&left.getMagnitude(0,0,left.getNumSamples())>left.getMagnitude(1,0,left.getNumSamples())&&right.getMagnitude(0,0,right.getNumSamples())==0&&right.getMagnitude(1,0,right.getNumSamples())>0;
        const auto a=render(rate,127,0,0,true),b=render(rate,512,0,0,true);for(int ch=0;ch<2;++ch)for(int i=0;i<a.getNumSamples();++i){const double value=a.getSample(ch,i);finite=finite&&std::isfinite(value)&&std::abs(value)<1;partitionError=juce::jmax(partitionError,std::abs(value-b.getSample(ch,i)));}
    }
    OpenStudioDrumInstrument drums;const auto gm=drums.describeMapping();drums.mapPreset.store(1);const auto td=drums.describeMapping();bool mapping=true;for(const auto& pair:std::array<std::pair<int,int>,9>{{{22,42},{26,46},{47,45},{50,48},{58,43},{55,49},{52,57},{59,51},{53,51}}})mapping=mapping&&drums.mappedNote(pair.first)==pair.second;
    bool setters=true;for(int i=0;i<8;++i){setters=setters&&setFreePluginParamForRegression(drums,"pieceTuning"+juce::String(i),static_cast<float>(i-4));setters=setters&&setFreePluginParamForRegression(drums,"piecePan"+juce::String(i),static_cast<float>(i-4)/4);}
    juce::MemoryBlock state;drums.getStateInformation(state);OpenStudioDrumInstrument restored;restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=true;for(size_t i=0;i<8;++i)recall=recall&&drums.pieceTuning[i].load()==restored.pieceTuning[i].load()&&drums.piecePan[i].load()==restored.piecePan[i].load();
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(int i=0;i<8;++i){tree.removeProperty("pieceTuning"+juce::String(i),nullptr);tree.removeProperty("piecePan"+juce::String(i),nullptr);}juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));bool migration=true;for(size_t i=0;i<8;++i)migration=migration&&restored.pieceTuning[i].load()==0&&restored.piecePan[i].load()==0;
    const auto schema=describeFreePluginForRegression(drums);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size() >= 33&&(*parameters)[17]["id"].toString()=="pieceTuning0";
    result->setProperty("pass",frequencyError<.05&&partitionError<1e-8&&panIsolation&&finite&&mapping&&setters&&recall&&migration&&appended);result->setProperty("frequencyErrorHz",frequencyError);result->setProperty("partitionError",partitionError);result->setProperty("panOffset",panIsolation);result->setProperty("finite",finite);result->setProperty("tdMapping",mapping);result->setProperty("setters",setters);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("gmMapping",gm);result->setProperty("tdMappingRows",td);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkPianoExpressivePerformance()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Piano expressive strikes and pedals");
    const auto render=[](double rate,int blockSize,int pedal,int sostenutoChannel,bool noteAfterPedal,float velocityValue,bool soft,bool expressive)
    {
        auto piano=std::make_unique<OpenStudioPianoInstrument>();piano->performanceMode.store(expressive?1.0f:0.0f);piano->strikeColour.store(1);piano->releaseVelocity.store(0);piano->releaseMs.store(200);piano->prepareToPlay(rate,blockSize);
        const int length=static_cast<int>(rate*.8);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
        const int noteStart=noteAfterPedal?juce::roundToInt(rate*.06):0,noteEnd=juce::roundToInt(rate*.1),sostenutoStart=juce::roundToInt(rate*.04);
        for(int start=0;start<length;start+=blockSize){const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);block.clear();midi.clear();const auto event=[&](int time,const juce::MidiMessage& message){if(time>=start&&time<start+count)midi.addEvent(message,time-start);};event(0,juce::MidiMessage::controllerEvent(1,64,pedal));if(soft)event(0,juce::MidiMessage::controllerEvent(1,67,127));if(sostenutoChannel>0)event(sostenutoStart,juce::MidiMessage::controllerEvent(sostenutoChannel,66,127));event(noteStart,juce::MidiMessage::noteOn(1,69,velocityValue));event(noteEnd,juce::MidiMessage::noteOff(1,69));piano->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);}return output;
    };
    const auto energy=[](const juce::AudioBuffer<float>& audio,int from,int to){double sum=0;for(int ch=0;ch<audio.getNumChannels();++ch)for(int i=from;i<to;++i)sum+=static_cast<double>(audio.getSample(ch,i))*audio.getSample(ch,i);return sum;};
    double partitionError=0;bool finite=true,pedalOrder=true,sostenuto=true,softEffect=true,strikeEffect=true;juce::Array<juce::var> rows;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto dry=render(rate,127,0,0,false,.7f,false,true),half=render(rate,127,64,0,false,.7f,false,true),full=render(rate,127,127,0,false,.7f,false,true),partition=render(rate,512,64,0,false,.7f,false,true);
        for(int ch=0;ch<2;++ch)for(int i=0;i<half.getNumSamples();++i){const double value=half.getSample(ch,i);finite=finite&&std::isfinite(value)&&std::abs(value)<=2.5;partitionError=juce::jmax(partitionError,std::abs(value-partition.getSample(ch,i)));}
        const int from=static_cast<int>(rate*.45),to=static_cast<int>(rate*.6);const double dryEnergy=energy(dry,from,to),halfEnergy=energy(half,from,to),fullEnergy=energy(full,from,to);pedalOrder=pedalOrder&&dryEnergy<1e-12&&halfEnergy>.001&&fullEnergy>halfEnergy*2;
        const auto captured=render(rate,127,0,1,false,.7f,false,true),later=render(rate,127,0,1,true,.7f,false,true),otherChannel=render(rate,127,0,2,false,.7f,false,true);sostenuto=sostenuto&&energy(captured,from,to)>.01&&energy(later,from,to)<1e-12&&energy(otherChannel,from,to)<1e-12;
        const auto softened=render(rate,127,127,0,false,.7f,true,true);softEffect=softEffect&&energy(softened,from,to)<fullEnergy*.9;
        const auto quiet=render(rate,127,127,0,false,.25f,false,true),hard=render(rate,127,127,0,false,.8f,false,true);double difference=0;for(int i=0;i<static_cast<int>(rate*.09);++i)difference+=std::abs(quiet.getSample(0,i)/.25f-hard.getSample(0,i)/.8f);strikeEffect=strikeEffect&&difference>.1;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("dryReleaseEnergy",dryEnergy);row->setProperty("halfPedalEnergy",halfEnergy);row->setProperty("fullPedalEnergy",fullEnergy);row->setProperty("normalizedStrikeDifference",difference);rows.add(row);
        if(rate==48000){writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/piano-expressive-listening/half-pedal.wav"),half,rate);writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/piano-expressive-listening/full-pedal.wav"),full,rate);}
    }
    auto original=std::make_unique<OpenStudioPianoInstrument>();bool setters=true;for(const auto& control:OpenStudioPianoInstrument::performanceControls)setters=setters&&setFreePluginParamForRegression(*original,control.id,control.maximum);juce::MemoryBlock state;original->getStateInformation(state);auto restored=std::make_unique<OpenStudioPianoInstrument>();restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=true;for(const auto& control:OpenStudioPianoInstrument::performanceControls)recall=recall&&(original.get()->*control.member).load()==(restored.get()->*control.member).load();
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(const auto& control:OpenStudioPianoInstrument::performanceControls)tree.removeProperty(control.id,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);restored->setStateInformation(old.getData(),static_cast<int>(old.getSize()));bool migration=true;for(const auto& control:OpenStudioPianoInstrument::performanceControls)migration=migration&&(restored.get()->*control.member).load()==control.initial;
    const auto schema=describeFreePluginForRegression(*original);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size() >= 14&&(*parameters)[8]["id"].toString()=="performanceMode";
    result->setProperty("pass",partitionError<1e-8&&finite&&pedalOrder&&sostenuto&&softEffect&&strikeEffect&&setters&&recall&&migration&&appended);result->setProperty("partitionError",partitionError);result->setProperty("finite",finite);result->setProperty("continuousPedalOrdering",pedalOrder);result->setProperty("sostenutoCaptureAndChannel",sostenuto);result->setProperty("softPedalEffect",softEffect);result->setProperty("velocityStrikeEffect",strikeEffect);result->setProperty("setters",setters);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("rates",rows);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkPitchSourceConfidence()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Pitch source confidence and detector history");
    double frequencyError=0;bool routing=true,finite=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int source=0;source<3;++source)
    {
        OpenStudioPitchCorrector pitch;pitch.detectionSource.store(static_cast<float>(source));pitch.prepareToPlay(rate,127);
        juce::AudioBuffer<float> block(2,127);juce::MidiBuffer midi;
        for(int start=0;start<static_cast<int>(rate*.2);start+=127){for(int i=0;i<127;++i){const float tone=static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*440*(start+i)/rate));block.setSample(0,i,source==2?-tone:0);block.setSample(1,i,tone);}midi.clear();pitch.processBlock(block,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)finite=finite&&std::isfinite(block.getSample(ch,i));}
        const auto data=pitch.getCurrentPitchData();if(source==1){frequencyError=juce::jmax(frequencyError,std::abs(static_cast<double>(data.detectedHz)-440));routing=routing&&data.confidence>.8f;}else routing=routing&&data.detectedHz==0&&data.confidence==0;
    }
    OpenStudioPitchCorrector pitch;pitch.midiOutputEnabled.store(1);pitch.prepareToPlay(48000,512);juce::AudioBuffer<float> block(2,512);juce::MidiBuffer midi;bool noteOn=false,noteOff=false;
    for(int start=0;start<12000;start+=512){block.clear();for(int i=0;i<512;++i)block.setSample(0,i,static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*440*(start+i)/48000)));midi.clear();pitch.processBlock(block,midi);for(const auto event:midi)noteOn=noteOn||event.getMessage().isNoteOn();}
    const int latency=pitch.getLatencySamples();pitch.detectionSource.store(1);midi.clear();block.clear();pitch.processBlock(block,midi);for(const auto event:midi)noteOff=noteOff||event.getMessage().isNoteOff();const bool transition=noteOn&&noteOff&&pitch.getLatencySamples()==latency&&pitch.getCurrentPitchData().detectedHz==0;
    setFreePluginParamForRegression(pitch,"detectionSource",2);juce::MemoryBlock state;pitch.getStateInformation(state);OpenStudioPitchCorrector restored;restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=restored.detectionSource.load()==2;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("detectionSource",nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));const bool migration=restored.detectionSource.load()==0;
    PitchDetector detector;detector.prepare(48000,512);std::atomic<bool> running{true},historyValid{true};std::atomic<int> reads{0};
    std::thread reader([&]{while(running.load()){for(const auto& frame:detector.getRecentFrames(512))if(!std::isfinite(frame.frequency)||!std::isfinite(frame.confidence)||!std::isfinite(frame.rmsDB)||frame.confidence<0||frame.confidence>1)historyValid.store(false);reads.fetch_add(1);std::this_thread::yield();}});
    std::array<float,512> input{};for(int part=0;part<600;++part){for(int i=0;i<512;++i)input[static_cast<size_t>(i)]=part%7==0?0.0f:static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*440*(part*512+i)/48000));detector.processSamples(input.data(),512);}running.store(false);reader.join();detector.reset();bool cleared=detector.getRecentFrames(-1).empty();for(const auto& frame:detector.getRecentFrames(512))cleared=cleared&&frame.frequency==0&&frame.confidence==0;
    const auto schema=describeFreePluginForRegression(pitch);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size()>=29&&(*parameters)[27]["id"].toString()=="detectionSource"&&(*parameters)[28]["id"].toString()=="humanizeMode";
    result->setProperty("pass",frequencyError<.3&&routing&&finite&&transition&&recall&&migration&&historyValid.load()&&reads.load()>0&&cleared&&appended);result->setProperty("frequencyErrorHz",frequencyError);result->setProperty("routing",routing);result->setProperty("finite",finite);result->setProperty("sourceChangeMidiOffAndLatency",transition);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("historyReads",reads.load());result->setProperty("historyValid",historyValid.load());result->setProperty("historyReset",cleared);result->setProperty("appendedParameter",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkSynthFilterModulation()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Synth voice filter and modulation");
    double responseErrorDb = 0, partitionError = 0; bool finite = true, effect = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (int mode : {1, 2, 3}) for (double frequency : {100.0, 1000.0, 8000.0})
        {
            BuiltInSynthModulation filter; filter.prepare(rate, {static_cast<float>(mode),1000,.707f,0,0,0,1,0,0});
            BuiltInSynthModulation::Voice voice; const auto frame = filter.next();
            double sine = 0, cosine = 0; const int warm = static_cast<int>(rate / 5), count = static_cast<int>(rate);
            for (int i = 0; i < warm + count; ++i)
            {
                const double phase = juce::MathConstants<double>::twoPi * frequency * i / rate;
                const float output = filter.process(voice, frame, static_cast<float>(std::sin(phase)), 0, 60, 1, 0);
                if (i >= warm) { sine += output * std::sin(phase); cosine += output * std::cos(phase); }
            }
            const double amplitude = 2 * std::hypot(sine, cosine) / count;
            const double w = std::tan(juce::MathConstants<double>::pi * frequency / rate) / std::tan(juce::MathConstants<double>::pi * 1000 / rate);
            const double denominator = std::hypot(1-w*w, w/.707f);
            const double expected = (mode == 1 ? 1 : mode == 2 ? w*w : w/.707f) / denominator;
            responseErrorDb = juce::jmax(responseErrorDb, std::abs(20 * std::log10(amplitude / expected)));
        }
        const auto render = [rate](int blockSize, int destination, float depth)
        {
            OpenStudioBasicSynthInstrument synth; synth.filterMode.store(1); synth.filterCutoff.store(1800); synth.filterQ.store(2); synth.filterEnvelope.store(1.5f); synth.filterKeyTrack.store(.5f); synth.lfoDestination.store(static_cast<float>(destination)); synth.lfoDepth.store(depth); synth.lfoRate.store(4); synth.prepareToPlay(rate,blockSize);
            const int length = static_cast<int>(rate*.35); juce::AudioBuffer<float> output(2,length),block(2,blockSize); juce::MidiBuffer midi;
            for(int start=0;start<length;start+=blockSize){const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);block.clear();midi.clear();if(start==0){midi.addEvent(juce::MidiMessage::noteOn(1,48,.7f),0);midi.addEvent(juce::MidiMessage::noteOn(2,67,.5f),0);}synth.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);}return output;
        };
        const auto dry = render(127,0,0);
        for (int destination : {1,2,3})
        {
            const auto audio = render(127,destination,.8f), other = render(512,destination,.8f); double difference = 0;
            for(int i=0;i<audio.getNumSamples();++i){const double value=audio.getSample(0,i);finite=finite&&std::isfinite(value)&&std::abs(value)<=2.5;partitionError=juce::jmax(partitionError,std::abs(value-other.getSample(0,i)));difference+=std::abs(value-dry.getSample(0,i));}
            effect=effect&&difference>1;
            if(rate==48000)writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/synth-filter-listening/lfo-"+juce::String(destination)+".wav"),audio,rate);
        }
        // High resonance and full modulation remain finite across all filter/LFO shapes.
        for(int mode : {1,2,3})for(int shape=0;shape<4;++shape)
        {
            BuiltInSynthModulation filter;filter.prepare(rate,{static_cast<float>(mode),20000,12,1,4,1,20,1,static_cast<float>(shape)});BuiltInSynthModulation::Voice voice;
            for(int i=0;i<static_cast<int>(rate*.15);++i){const auto frame=filter.next();const float lfo=filter.lfo(voice,frame);const float value=filter.process(voice,frame,static_cast<float>(.2*std::sin(i*.17)),0,12,0,lfo);finite=finite&&std::isfinite(value)&&std::abs(value)<20;}
        }
    }
    OpenStudioBasicSynthInstrument original;bool setters=true;for(const auto& control:OpenStudioBasicSynthInstrument::modulationControls)setters=setters&&setFreePluginParamForRegression(original,control.id,control.maximum);
    juce::MemoryBlock state;original.getStateInformation(state);OpenStudioBasicSynthInstrument restored;restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=original.modulationValues()==restored.modulationValues();
    juce::ValueTree old("OpenStudioBasicSynthInstrument");juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);old.writeToStream(stream);restored.setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));bool migration=true;for(const auto& control:OpenStudioBasicSynthInstrument::modulationControls)migration=migration&&(restored.*control.member).load()==control.initial;
    const auto schema=describeFreePluginForRegression(original);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size()>=36&&(*parameters)[10]["id"].toString()=="filterMode";
    result->setProperty("pass",responseErrorDb<.002&&partitionError<1e-8&&finite&&effect&&setters&&recall&&migration&&appended);result->setProperty("responseErrorDb",responseErrorDb);result->setProperty("partitionError",partitionError);result->setProperty("finite",finite);result->setProperty("destinationsChangeAudio",effect);result->setProperty("setters",setters);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkChorusSyncAndModes()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Modulation sync and mode controls");
    struct Clock : juce::AudioPlayHead { double bpm=120; juce::Optional<PositionInfo> getPosition() const override {PositionInfo p;p.setBpm(bpm);return p;} } clock;
    OpenStudioChorus synced; synced.setPlayHead(&clock); synced.tempoSync.store(1);
    double rateError=0, partitionError=0; bool migration=true, finite=true, voicesEffective=true;
    for(double bpm:{60.0,120.0,180.0})for(size_t division=0;division<OpenStudioChorus::cycleBeats.size();++division)
    {
        clock.bpm=bpm;synced.syncDivision.store(static_cast<float>(division));
        rateError=juce::jmax(rateError,std::abs(static_cast<double>(synced.resolveLFORate())-bpm/(60*OpenStudioChorus::cycleBeats[division])));
    }
    clock.bpm=150;synced.syncDivision.store(5);synced.resolveLFORate();clock.bpm=std::numeric_limits<double>::quiet_NaN();const bool invalidTempo=synced.resolveLFORate()==2.5f;
    for(int index=0;index<6;++index)
    {
        juce::ValueTree old("OpenStudioChorus");old.setProperty("rate",index,nullptr);old.setProperty("tempoSync",1,nullptr);juce::MemoryBlock bytes;{juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);}
        OpenStudioChorus restored;restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));
        migration=migration&&std::abs(restored.resolveLFORate()-2.0f/std::array<float,6>{16,8,4,2,1,.5f}[static_cast<size_t>(index)])<1e-6;
    }
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int mode=0;mode<3;++mode)
    {
        const auto render=[&](int blockSize,float voices,float feedback)
        {
            OpenStudioChorus processor;processor.mode.store(static_cast<float>(mode));processor.voices.store(voices);processor.fbAmount.store(feedback);processor.depth.store(.8f);processor.rate.store(1.7f);processor.prepareToPlay(rate,blockSize);
            const int length=juce::roundToInt(rate*.3);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
            for(int start=0;start<length;start+=blockSize)
            {
                const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);
                for(int i=0;i<count;++i){const float input=static_cast<float>(.05*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/rate));block.setSample(0,i,input);block.setSample(1,i,input*.7f);}
                processor.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);
            }
            return output;
        };
        const auto one=render(127,1,.4f),many=render(127,6,.4f),partition=render(512,6,.4f);double difference=0;
        for(int i=0;i<one.getNumSamples();++i){difference+=std::abs(one.getSample(0,i)-many.getSample(0,i));partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(many.getSample(0,i)-partition.getSample(0,i))));}
        voicesEffective=voicesEffective&&difference>.01;
        for(float feedback:{-.95f,.95f}){const auto extreme=render(127,6,feedback);for(int ch=0;ch<2;++ch)for(int i=0;i<extreme.getNumSamples();++i)finite=finite&&std::isfinite(extreme.getSample(ch,i))&&std::abs(extreme.getSample(ch,i))<10;}
    }
    OpenStudioChorus original,restored;const bool setter=setFreePluginParamForRegression(original,"syncDivision",3);original.rate.store(3.7f);original.tempoSync.store(1);
    juce::MemoryBlock bytes;original.getStateInformation(bytes);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));const bool recall=restored.syncDivision.load()==3&&restored.rate.load()==3.7f&&restored.tempoSync.load()==1;
    const auto schema=describeFreePluginForRegression(original);const auto* parameters=schema["parameters"].getArray();const bool prefix=parameters&&parameters->size() >= 13&&(*parameters)[12]["id"].toString()=="syncDivision";
    result->setProperty("pass",rateError<1e-6&&partitionError<1e-7&&invalidTempo&&migration&&finite&&voicesEffective&&setter&&recall&&prefix);
    result->setProperty("rateErrorHz",rateError);result->setProperty("partitionError",partitionError);result->setProperty("invalidTempoRetainsLast",invalidTempo);result->setProperty("oldSyncMigration",migration);result->setProperty("voicesEffectiveAllModes",voicesEffective);result->setProperty("finiteFeedbackExtremes",finite);result->setProperty("setter",setter);result->setProperty("stateRecall",recall);result->setProperty("prefix",prefix);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkSynthModulationMatrix()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Synth three-route modulation matrix");
    bool routing=true,controllers=true,finite=true,effect=true,recall=true;double partitionError=0,slewError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int source=0;source<8;++source)for(int target=0;target<4;++target)for(float amount:{-1.0f,1.0f})
        {
            BuiltInSynthMatrix matrix;matrix.prepare(rate,{0,0,static_cast<float>(source),static_cast<float>(target),amount,0,0,0,0,0,0});
            std::array<float,9> sources{};sources[static_cast<size_t>(source)]=source==0?0:.7f;
            const auto values=BuiltInSynthMatrix::apply(matrix.next(),sources);
            for(int i=0;i<4;++i)routing=routing&&std::abs(values[static_cast<size_t>(i)]-(i==target?amount*sources[static_cast<size_t>(source)]:0))<1e-6;
        }
        BuiltInSynthMatrix matrix;matrix.prepare(rate,{0,0,1,2,0,1,2,0,1,2,0});matrix.setTargets({1,1,1,2,1,1,2,1,1,2,1});
        matrix.wheelTarget(0,1);matrix.pressureTarget(2,.5f);matrix.polyTarget(2,3,.75f);
        const int steps=static_cast<int>(rate*.02);BuiltInSynthMatrix::Frame frame;
        for(int i=0;i<steps;++i){frame=matrix.next();const float progress=static_cast<float>(i+1)/static_cast<float>(steps);slewError=juce::jmax(slewError,std::abs(static_cast<double>(frame.routes[0].amount-progress)));controllers=controllers&&std::abs(matrix.poly(2,3)-.75f*progress)<1e-4&&matrix.poly(2,4)==0&&frame.wheel[1]==0&&frame.pressure[1]==0;}
        const auto summed=BuiltInSynthMatrix::apply(frame,{0,1,0,0,0,0,0,0});routing=routing&&summed[2]==1&&frame.globalLfo==1&&frame.legacyWheel==0;
        matrix.resetChannel(2);for(int i=0;i<steps;++i){frame=matrix.next();matrix.poly(2,3);}controllers=controllers&&frame.pressure[2]==0&&matrix.poly(2,3)==0&&frame.wheel[0]==1;
        matrix.startVoice(2,3);controllers=controllers&&matrix.poly(2,3)==0;
        const auto render=[rate](int blockSize,int source,int target,int eventChannel,int eventNote,bool shared,int noteAt=0)
        {
            OpenStudioBasicSynthInstrument synth;synth.noiseLevel.store(0);synth.filterMode.store(1);synth.filterCutoff.store(1000);synth.wheelMode.store(1);synth.lfoMode.store(shared?1.0f:0.0f);synth.lfoRate.store(4);
            synth.matrix1Source.store(static_cast<float>(source));synth.matrix1Target.store(static_cast<float>(target));synth.matrix1Amount.store(.6f);synth.prepareToPlay(rate,blockSize);
            const int length=juce::roundToInt(rate*.18)+noteAt;juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;
            for(int start=0;start<length;start+=blockSize)
            {
                const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);block.clear();midi.clear();
                const auto event=[&](int at,const juce::MidiMessage& message){if(at>=start&&at<start+count)midi.addEvent(message,at-start);};
                event(noteAt,juce::MidiMessage::noteOn(1,60,.7f));event(noteAt+97,juce::MidiMessage::controllerEvent(eventChannel,1,100));event(noteAt+101,juce::MidiMessage::channelPressureChange(eventChannel,100));event(noteAt+103,juce::MidiMessage::aftertouchChange(eventChannel,eventNote,100));
                synth.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);
            }return output;
        };
        const auto dry=render(127,0,0,1,60,false);
        for(int source=1;source<8;++source)for(int target=0;target<4;++target)
        {
            const auto audio=render(127,source,target,1,60,true),other=render(512,source,target,1,60,true);double difference=0;
            for(int i=0;i<audio.getNumSamples();++i){const float sample=audio.getSample(0,i);finite=finite&&std::isfinite(sample)&&std::abs(sample)<=2.5f;partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(sample-other.getSample(0,i))));difference+=std::abs(sample-dry.getSample(0,i));}effect=effect&&difference>.01;
        }
        for(int source:{2,3,4}){const auto ignored=render(127,source,2,2,60,false);for(int i=0;i<dry.getNumSamples();++i)controllers=controllers&&ignored.getSample(0,i)==dry.getSample(0,i);}
        const auto ignoredKey=render(127,4,2,1,61,false);for(int i=0;i<dry.getNumSamples();++i)controllers=controllers&&ignoredKey.getSample(0,i)==dry.getSample(0,i);
        const int delay=juce::roundToInt(rate*.0625);const auto perNote=render(127,7,2,1,60,false),delayed=render(127,7,2,1,60,false,delay),shared=render(127,7,2,1,60,true,delay);double globalDifference=0;
        for(int i=0;i<perNote.getNumSamples();++i){routing=routing&&perNote.getSample(0,i)==delayed.getSample(0,i+delay);globalDifference+=std::abs(perNote.getSample(0,i)-shared.getSample(0,i+delay));}routing=routing&&globalDifference>1;
        if(rate==48000)writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/synth-filter-listening/matrix-shared-lfo.wav"),shared,rate);
    }
    OpenStudioBasicSynthInstrument original,restored;for(size_t i=15;i<original.modulationControls.size();++i){const auto& control=original.modulationControls[i];recall=recall&&setFreePluginParamForRegression(original,control.id,control.maximum);}
    juce::MemoryBlock bytes;original.getStateInformation(bytes);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));recall=recall&&original.matrixValues()==restored.matrixValues();
    const auto schema=describeFreePluginForRegression(original);const auto* params=schema["parameters"].getArray();const bool appended=params&&params->size()>=36&&(*params)[24]["id"].toString()=="filterVelocity"&&(*params)[25]["id"].toString()=="lfoMode"&&(*params)[35]["id"].toString()=="matrix3Amount";
    result->setProperty("pass",routing&&controllers&&finite&&effect&&recall&&appended&&partitionError==0&&slewError<1e-4);result->setProperty("routingAndPhase",routing);result->setProperty("channelAndKeyIsolation",controllers);result->setProperty("finite",finite);result->setProperty("allSourcesAndTargetsEffective",effect);result->setProperty("stateRecall",recall);result->setProperty("appendedParameters",appended);result->setProperty("partitionError",partitionError);result->setProperty("slewError",slewError);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkSynthIndependentEnvelope()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Synth independent filter envelope");
    double stageError = 0, partitionError = 0; bool effect = true, finite = true, recall = true;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        BuiltInSynthEnvelope envelope;
        envelope.start(rate, 10, 30, .25f, 40, .5f, 1);
        const int attack = juce::roundToInt(rate * .01), decay = juce::roundToInt(rate * .03), release = juce::roundToInt(rate * .04);
        float value = 0;
        for (int i = 0; i < attack; ++i) value = envelope.next(false);
        stageError = juce::jmax(stageError, std::abs(static_cast<double>(value) - .5));
        for (int i = 0; i < decay; ++i) value = envelope.next(false);
        stageError = juce::jmax(stageError, std::abs(static_cast<double>(value) - .125));
        for (int i = 0; i < release; ++i)
        {
            value = envelope.next(true);
            stageError = juce::jmax(stageError, std::abs(static_cast<double>(value) - .125 * (1.0 - static_cast<double>(i + 1) / release)));
        }
        envelope.start(rate, 10, 30, .25f, 40, 1, 0);
        for (int i = 0; i < attack / 2; ++i) value = envelope.next(false);
        const double releaseStart = value;
        for (int i = 0; i < release; ++i)
            stageError = juce::jmax(stageError, std::abs(static_cast<double>(envelope.next(true)) - releaseStart * (1.0 - static_cast<double>(i + 1) / release)));
        const auto render = [rate](int blockSize, bool independent)
        {
            OpenStudioBasicSynthInstrument synth; synth.filterMode.store(1); synth.filterCutoff.store(200); synth.filterEnvelope.store(4);
            synth.filterEnvelopeSource.store(independent ? 1.0f : 0.0f); synth.filterAttackMs.store(100); synth.filterDecayMs.store(200); synth.filterSustain.store(.1f); synth.filterReleaseMs.store(50); synth.filterVelocity.store(.7f);
            synth.releaseMs.store(500); synth.prepareToPlay(rate, blockSize);
            const int length = juce::roundToInt(rate), off = juce::roundToInt(rate * .35), pedalOff = juce::roundToInt(rate * .55);
            juce::AudioBuffer<float> output(2, length), block(2, blockSize); juce::MidiBuffer midi;
            for (int start = 0; start < length; start += blockSize)
            {
                const int count = juce::jmin(blockSize, length - start); block.setSize(2, count, false, false, true); block.clear(); midi.clear();
                const auto event = [&](int at, const juce::MidiMessage& message) { if (at >= start && at < start + count) midi.addEvent(message, at - start); };
                event(0, juce::MidiMessage::noteOn(1, 48, .7f)); event(12, juce::MidiMessage::noteOn(1, 48, .4f));
                event(20, juce::MidiMessage::controllerEvent(1, 64, 127)); event(off, juce::MidiMessage::noteOff(1, 48)); event(off + 20, juce::MidiMessage::noteOff(1, 48));
                event(pedalOff, juce::MidiMessage::controllerEvent(1, 64, 0));
                synth.processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
            }
            return output;
        };
        const auto audio = render(127, true), other = render(512, true), amp = render(127, false); double difference = 0;
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            const double valueNow = audio.getSample(0, i); finite = finite && std::isfinite(valueNow) && std::abs(valueNow) < 2.5;
            partitionError = juce::jmax(partitionError, std::abs(valueNow - other.getSample(0, i))); difference += std::abs(valueNow - amp.getSample(0, i));
        }
        effect = effect && difference > 1;
        if (rate == 48000) writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/synth-filter-listening/independent-envelope.wav"), audio, rate);
    }
    OpenStudioBasicSynthInstrument original, restored;
    for (const auto& control : OpenStudioBasicSynthInstrument::modulationControls) setFreePluginParamForRegression(original, control.id, control.maximum);
    juce::MemoryBlock state; original.getStateInformation(state); restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    for (const auto& control : OpenStudioBasicSynthInstrument::modulationControls) recall = recall && (original.*control.member).load() == (restored.*control.member).load();
    result->setProperty("pass", stageError < 1.0e-6 && partitionError == 0 && effect && finite && recall);
    result->setProperty("stageError", stageError); result->setProperty("partitionError", partitionError); result->setProperty("independentAudio", effect); result->setProperty("finite", finite); result->setProperty("stateRecall", recall);
    result->setProperty("schema", describeFreePluginForRegression(original)); result->setProperty("audioQuality", "not_asserted"); return result;
}

juce::var checkStandaloneDelayModes()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Standalone Multi Dual delay and controls");
    const auto render=[](bool extended,int mode,double rate,int blockSize,bool impulse)
    {
        OpenStudioDelay delay(.5f,extended);delay.delayMode.store(static_cast<float>(mode));delay.delayTimeL.store(100);delay.delayTimeR.store(100);delay.mix.store(1);delay.feedback.store(impulse?0.0f:.6f);delay.multiFeedback.store(impulse?0.0f:.4f);delay.dualFeedback.store(impulse?0.0f:.3f);delay.dualModDepthMs.store(0);delay.dualTimeRatio.store(.75f);if(impulse)delay.wowDepthMs.store(0);delay.prepareToPlay(rate,blockSize);
        const int count=static_cast<int>(rate*.6);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer midi;
        for(int start=0;start<count;start+=blockSize){const int length=juce::jmin(blockSize,count-start);block.setSize(2,length,false,false,true);for(int i=0;i<length;++i){const float input=impulse?(start+i==juce::roundToInt(rate*.1)?.2f:0.0f):static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/rate));block.setSample(0,i,input);block.setSample(1,i,-input*.7f);}delay.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,length);}return output;
    };
    double oldModeError=0,partition=0,tapError=0;bool finite=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        for(int mode=0;mode<3;++mode){const auto old=render(false,mode,rate,127,false),modern=render(true,mode,rate,127,false);for(int ch=0;ch<2;++ch)for(int i=0;i<old.getNumSamples();++i)oldModeError=juce::jmax(oldModeError,std::abs(static_cast<double>(old.getSample(ch,i)-modern.getSample(ch,i))));}
        for(int mode:{3,4})
        {
            const auto audio=render(true,mode,rate,127,true),other=render(true,mode,rate,512,true);
            for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i){const double value=audio.getSample(ch,i);finite=finite&&std::isfinite(value)&&std::abs(value)<1;partition=juce::jmax(partition,std::abs(value-other.getSample(ch,i)));}
            const std::vector<double> ratios=mode==3?std::vector<double>{1,.79-.08*.18,.61-.08*.18,.43-.07*.18}:std::vector<double>{1,.75};
            const std::vector<double> weights=mode==3?std::vector<double>{.42,.25,.20,.13}:std::vector<double>{1-(.35+.15*.18),.35+.15*.18};
            for(size_t i=0;i<ratios.size();++i){const int center=juce::roundToInt(rate*.1)+juce::roundToInt(rate*.1*ratios[i]);double sum=0;for(int sample=center-2;sample<=center+2;++sample)sum+=audio.getSample(0,sample);tapError=juce::jmax(tapError,std::abs(sum-.2*weights[i]*(mode==3&&i%2==1?-.7:1.0)));}
        }
    }
    OpenStudioDelay processor(.5f,true);bool setters=true;for(const auto& control:OpenStudioDelay::standaloneParameters)setters=setters&&setFreePluginParamForRegression(processor,control.id,control.maximum);
    setFreePluginParamForRegression(processor,"delayMode",4);juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioDelay restored(.5f,true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=restored.delayMode.load()==4;
    for(const auto& control:OpenStudioDelay::standaloneParameters)recall=recall&&(restored.*control.member).load()==(processor.*control.member).load();
    const bool custom=restored.wowDepthMs.load()==4;
    juce::ValueTree old("OpenStudioDelay");old.setProperty("delayMode",1.9f,nullptr);juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);old.writeToStream(stream);restored.setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));bool migration=restored.delayMode.load()==1&&restored.wowDepthMs.load()==-1;for(const auto& control:OpenStudioDelay::standaloneParameters)migration=migration&&(restored.*control.member).load()==control.initial;
    const auto schema=describeFreePluginForRegression(processor);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size()>=32&&(*parameters)[15]["id"].toString()=="topologyControl";
    OpenStudioDelay embedded(.5f);juce::MemoryBlock embeddedState;embedded.getStateInformation(embeddedState);const auto embeddedTree=juce::ValueTree::readFromData(embeddedState.getData(),embeddedState.getSize());const bool isolated=!embeddedTree.hasProperty("standaloneControls")&&!embedded.setStandaloneControl("duckAttackMs",20);
    result->setProperty("pass",oldModeError==0&&partition<1e-8&&tapError<.0002&&finite&&setters&&recall&&custom&&migration&&appended&&isolated);result->setProperty("oldModeError",oldModeError);result->setProperty("partitionError",partition);result->setProperty("tapWeightError",tapError);result->setProperty("finite",finite);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("customMotion",custom);result->setProperty("embeddedStateUnchanged",isolated);result->setProperty("appendedParameters",appended);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkGateExpansion()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Downward expansion and detector audition");
    const auto render=[](double rate,int blockSize,float ratio,float knee,bool listen,float mixValue)
    {
        OpenStudioGate gate(true);gate.expansionMode.store(1);gate.expansionRatio.store(ratio);gate.expansionKnee.store(knee);gate.detectorListen.store(listen?1.0f:0.0f);gate.threshold.store(-35);gate.range.store(-50);gate.attackMs.store(1);gate.releaseMs.store(5);gate.sidechainHPF.store(300);gate.sidechainLPF.store(6000);gate.mix.store(mixValue);gate.prepareToPlay(rate,blockSize);
        const int count=static_cast<int>(rate*2);juce::AudioBuffer<float> output(2,count),block(2,blockSize);juce::MidiBuffer midi;double inputEnergy=0,outputEnergy=0;
        for(int start=0;start<count;start+=blockSize){const int length=juce::jmin(blockSize,count-start);block.setSize(2,length,false,false,true);for(int i=0;i<length;++i){const float value=static_cast<float>(.01*std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/rate));block.setSample(0,i,value);block.setSample(1,i,-value);if(start+i>count-static_cast<int>(rate*.2))inputEnergy+=value*value;}gate.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,length);for(int i=0;i<length;++i)if(start+i>count-static_cast<int>(rate*.2))outputEnergy+=block.getSample(0,i)*block.getSample(0,i);}
        const double measured=10*std::log10(juce::jmax(1e-30,outputEnergy/inputEnergy));const float expected=OpenStudioGate::expansionGainDb(gate.detectorLevelDb.load()+35,ratio,knee,-50);
        return std::make_tuple(std::move(output),measured,expected,gate.envelopeStage.load());
    };
    double lawError=0,unityError=0,partitionError=0,auditionMixError=0;bool stage=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(float ratio:{1.0f,2.0f,5.0f})
    {
        const auto [audio,measured,expected,status]=render(rate,127,ratio,6,false,1);juce::ignoreUnused(audio);lawError=juce::jmax(lawError,std::abs(measured-expected));if(ratio==1)unityError=juce::jmax(unityError,std::abs(measured));stage=stage&&status==5;
    }
    const auto a=render(48000,127,2,6,false,1),b=render(48000,512,2,6,false,1),listenA=render(48000,127,10,12,true,0),listenB=render(48000,127,10,12,true,1);
    for(int ch=0;ch<2;++ch)for(int i=0;i<std::get<0>(a).getNumSamples();++i){partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(std::get<0>(a).getSample(ch,i)-std::get<0>(b).getSample(ch,i))));auditionMixError=juce::jmax(auditionMixError,std::abs(static_cast<double>(std::get<0>(listenA).getSample(ch,i)-std::get<0>(listenB).getSample(ch,i))));}
    const bool knee=std::abs(OpenStudioGate::expansionGainDb(0,3,8,-80)+2)<1e-6&&OpenStudioGate::expansionGainDb(-100,10,0,-20)==-20&&OpenStudioGate::expansionGainDb(10,5,12,-80)==0;
    OpenStudioGate processor(true);processor.expansionMode.store(1);processor.expansionRatio.store(3);processor.expansionKnee.store(9);processor.detectorListen.store(1);juce::MemoryBlock bytes;processor.getStateInformation(bytes);OpenStudioGate restored(true);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));const bool recall=restored.expansionMode.load()==1&&restored.expansionRatio.load()==3&&restored.expansionKnee.load()==9&&restored.detectorListen.load()==1;
    juce::ValueTree old("OpenStudioGate");juce::MemoryBlock oldBytes;juce::MemoryOutputStream stream(oldBytes,false);old.writeToStream(stream);restored.setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));const bool migration=restored.expansionMode.load()==0&&restored.expansionRatio.load()==2&&restored.expansionKnee.load()==6&&restored.detectorListen.load()==0;
    const auto schema=describeFreePluginForRegression(processor);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size()>=15&&(*parameters)[11]["id"].toString()=="expansionMode";
    const bool setters=setFreePluginParamForRegression(processor,"expansionMode",0)&&setFreePluginParamForRegression(processor,"expansionRatio",4)&&setFreePluginParamForRegression(processor,"expansionKnee",7)&&setFreePluginParamForRegression(processor,"detectorListen",0)&&processor.expansionRatio.load()==4;
    result->setProperty("pass",lawError<.12&&unityError<.002&&partitionError==0&&auditionMixError==0&&std::get<1>(listenA)> -1&&stage&&knee&&recall&&migration&&appended&&setters);result->setProperty("maximumLawErrorDb",lawError);result->setProperty("unityErrorDb",unityError);result->setProperty("partitionError",partitionError);result->setProperty("auditionMixError",auditionMixError);result->setProperty("auditionLevelDb",std::get<1>(listenA));result->setProperty("stage",stage);result->setProperty("softKneeAndRange",knee);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkEQMatching()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","EQ spectrum learning and bounded bell matching");
    bool pass=true;double worstFit=0,curveError=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto hz=BuiltInEQMatch::frequencies(rate);BuiltInEQMatch::Curve current{},reference{};
        const auto first=BuiltInEQMatch::response({700,5,.7},hz,rate),second=BuiltInEQMatch::response({4200,-4,1.4},hz,rate);
        for(size_t i=0;i<hz.size();++i){current[i]=-45;reference[i]=current[i]+first[i]+second[i]+7;}
        const auto fitted=BuiltInEQMatch::fit(current,reference,rate,8);worstFit=juce::jmax(worstFit,fitted.after);
        OpenStudioEQ eq(true);for(auto& band:eq.bands)band.enabled.store(0);
        for(size_t i=0;i<fitted.bands.size();++i){eq.bands[i].enabled.store(1);eq.bands[i].freq.store(static_cast<float>(fitted.bands[i].frequency));eq.bands[i].gain.store(static_cast<float>(fitted.bands[i].gain));eq.bands[i].q.store(static_cast<float>(fitted.bands[i].q));eq.bands[i].type.store(0);}
        eq.prepareToPlay(rate,127);std::vector<float> frequencies;for(auto frequency:hz)frequencies.push_back(static_cast<float>(frequency));const auto native=eq.getMagnitudeResponse(frequencies);
        for(size_t i=0;i<hz.size();++i)curveError=juce::jmax(curveError,std::abs(native[i]-fitted.curve[i]));
        pass=pass&&fitted.accepted&&fitted.bands.size()<=8&&fitted.after<.8&&fitted.after<fitted.before*.4;
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("before",fitted.before);item->setProperty("after",fitted.after);item->setProperty("bands",static_cast<int>(fitted.bands.size()));cases.add(item);
    }
    BuiltInEQMatch::Curve flat{},silent{},narrow{};flat.fill(-45);silent.fill(-120);narrow.fill(-120);narrow[50]=-40;
    const auto identical=BuiltInEQMatch::fit(flat,flat,48000,4),silence=BuiltInEQMatch::fit(flat,silent,48000,4),tone=BuiltInEQMatch::fit(flat,narrow,48000,4);
    struct Clock:juce::AudioPlayHead{juce::int64 sample=0;juce::Optional<PositionInfo> getPosition()const override{PositionInfo p;p.setTimeInSamples(sample);p.setIsPlaying(true);return p;}} clock;
    OpenStudioEQ eq(true);eq.outputGain.store(6);eq.prepareToPlay(48000,127);eq.setPlayHead(&clock);juce::MidiBuffer midi;juce::AudioBuffer<float> block(2,127);juce::Random random(61723);
    const bool armed=eq.matchCapture->arm(254,32768,48000);double captureError=0;
    for(int start=0;start<33528;start+=127){clock.sample=start;for(int i=0;i<127;++i){const float value=(random.nextFloat()-.5f)*.3f;block.setSample(0,i,value);block.setSample(1,i,-value);}eq.processBlock(block,midi);for(int i=0;i<127;++i){const int position=start+i-254;if(position>=0&&position<32768)for(size_t ch=0;ch<2;++ch)captureError=juce::jmax(captureError,std::abs(static_cast<double>(eq.matchCapture->audio[ch][static_cast<size_t>(position)]-block.getSample(static_cast<int>(ch),i))));}}
    BuiltInEQMatch::Learner learner;learner.add(*eq.matchCapture);const auto spectrum=learner.spectrum(48000);const double peak=*std::max_element(spectrum.begin(),spectrum.end());
    const bool capture=armed&&eq.matchCapture->state.load()==2&&captureError==0&&learner.windows==7&&peak> -65;
    pass=pass&&curveError<.002&&identical.accepted&&identical.bands.empty()&&!silence.accepted&&!tone.accepted&&capture;
    result->setProperty("pass",pass);result->setProperty("cases",cases);result->setProperty("maximumResponseErrorDb",curveError);result->setProperty("worstFitErrorDb",worstFit);result->setProperty("identicalNoCorrection",identical.accepted&&identical.bands.empty());result->setProperty("silenceRejected",!silence.accepted);result->setProperty("narrowbandRejected",!tone.accepted);result->setProperty("postCaptureExact",captureError==0);result->setProperty("oppositePolarityPowerPeakDb",peak);result->setProperty("learnerWindows",learner.windows);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkLinkedStereoAlignment()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Linked stereo alignment policy");
    bool shared=true,rejected=true,weak=true;double lagError=0,stereoError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        constexpr int count=8192,lag=37;std::array<std::vector<float>,2> reference,target;
        juce::Random random(89121);
        for(size_t ch=0;ch<2;++ch){reference[ch].resize(count);target[ch].resize(count);for(auto& value:reference[ch])value=(random.nextFloat()-.5f)*.2f;for(int i=lag;i<count;++i)target[ch][static_cast<size_t>(i)]=-reference[ch][static_cast<size_t>(i-lag)]*.5f;}
        std::array<BuiltInAlignmentEstimate,2> channels;for(size_t ch=0;ch<2;++ch)channels[ch]=estimateBuiltInAlignment(reference[ch].data(),target[ch].data(),count);
        const auto common=linkBuiltInAlignment(channels);shared=shared&&common.accepted&&common.invert;lagError=juce::jmax(lagError,std::abs(common.lag-lag));
        auto conflicting=channels;conflicting[1].lag+=2;rejected=rejected&&!linkBuiltInAlignment(conflicting).accepted;conflicting=channels;conflicting[1].invert=false;rejected=rejected&&!linkBuiltInAlignment(conflicting).accepted;conflicting=channels;conflicting[1].accepted=false;rejected=rejected&&!linkBuiltInAlignment(conflicting).accepted;
        auto silent=channels;silent[1]={};const auto fromLeft=linkBuiltInAlignment(silent);silent=channels;silent[0]={};const auto fromRight=linkBuiltInAlignment(silent);weak=weak&&fromLeft.accepted&&fromRight.accepted&&fromLeft.reason.contains("Left")&&fromRight.reason.contains("Right")&&!linkBuiltInAlignment({BuiltInAlignmentEstimate{},BuiltInAlignmentEstimate{}}).accepted;
        auto weighted=channels;weighted[0].lag=5;weighted[1].lag=5.5;weighted[0].referenceRms=weighted[0].targetRms=.2;weighted[1].referenceRms=weighted[1].targetRms=.1;lagError=juce::jmax(lagError,std::abs(linkBuiltInAlignment(weighted).lag-5.1));
        OpenStudioUtilityEffect processor(OpenStudioUtilityEffect::Kind::GainPhase);for(const auto* suffix:{"L","R"}){processor.setControl("delay"+juce::String(suffix),37);processor.setControl("fine"+juce::String(suffix),.25f);processor.setControl("polarity"+juce::String(suffix),1);}processor.prepareToPlay(rate,127);juce::AudioBuffer<float> audio(2,127);juce::MidiBuffer midi;
        for(int block=0;block<40;++block){for(int i=0;i<127;++i){const float sample=static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*997*(block*127+i)/rate));audio.setSample(0,i,sample);audio.setSample(1,i,-sample*.5f);}processor.processBlock(audio,midi);for(int i=0;i<127;++i)stereoError=juce::jmax(stereoError,std::abs(static_cast<double>(audio.getSample(1,i)+audio.getSample(0,i)*.5f)));}
    }
    result->setProperty("pass",shared&&rejected&&weak&&lagError<.025&&stereoError<1e-8);result->setProperty("sharedDelayAndPolarity",shared);result->setProperty("conflictingAndAmbiguousRejected",rejected);result->setProperty("silentPartnerUsesDisclosedBasis",weak);result->setProperty("lagErrorSamples",lagError);result->setProperty("stereoRelationError",stereoError);result->setProperty("liveDevice","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkAutomaticAlignment()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Synchronized alignment capture and correlation");
    constexpr int count=16384;std::vector<float> source(count+1024),reference(count),target(count);juce::Random random(571919);
    for(auto& value:source)value=(random.nextFloat()-.5f)*.4f;
    for(int i=0;i<count;++i)reference[static_cast<size_t>(i)]=source[static_cast<size_t>(i+512)];
    bool estimatesPass=true;juce::Array<juce::var> cases;
    for(double lag:{37.0,-123.0,5.25,-.4})
    {
        for(int i=0;i<count;++i){const double position=i+512-lag;const int center=static_cast<int>(std::floor(position));double sum=0,weight=0;for(int tap=-32;tap<=32;++tap){const double distance=position-(center+tap);const double sinc=std::abs(distance)<1e-12?1:std::sin(juce::MathConstants<double>::pi*distance)/(juce::MathConstants<double>::pi*distance);const double window=.5+.5*std::cos(juce::MathConstants<double>::pi*distance/33);const double coefficient=sinc*window;sum+=source[static_cast<size_t>(center+tap)]*coefficient;weight+=coefficient;}target[static_cast<size_t>(i)]=static_cast<float>(-sum/weight);}
        const auto estimate=estimateBuiltInAlignment(reference.data(),target.data(),count);estimatesPass=estimatesPass&&estimate.accepted&&estimate.invert&&std::abs(estimate.lag-lag)<.025;
        auto* item=new juce::DynamicObject();item->setProperty("expectedLag",lag);item->setProperty("estimatedLag",estimate.lag);item->setProperty("correlation",estimate.correlation);item->setProperty("peakRatio",estimate.peakRatio);item->setProperty("accepted",estimate.accepted);cases.add(item);
    }
    for(int i=0;i<count;++i)target[static_cast<size_t>(i)]=static_cast<float>(.3*std::sin(juce::MathConstants<double>::twoPi*i/64));
    const auto periodic=estimateBuiltInAlignment(target.data(),target.data(),count);std::fill(target.begin(),target.end(),0.0f);const auto silent=estimateBuiltInAlignment(reference.data(),target.data(),count);
    struct Clock:juce::AudioPlayHead { juce::int64 sample=0;juce::Optional<PositionInfo> getPosition()const override{PositionInfo p;p.setTimeInSamples(sample);p.setIsPlaying(true);return p;} } clock;
    OpenStudioUtilityEffect utility(OpenStudioUtilityEffect::Kind::GainPhase);utility.prepareToPlay(48000,64);utility.setPlayHead(&clock);const bool armed=utility.alignmentCapture->arm(100,200,48000);juce::AudioBuffer<float> buffer(2,64);juce::MidiBuffer midi;
    for(int block=0;block<5;++block){clock.sample=block*64;for(int ch=0;ch<2;++ch)for(int i=0;i<64;++i)buffer.setSample(ch,i,static_cast<float>(block*64+i)*.001f);utility.processBlock(buffer,midi);}
    bool exact=armed&&utility.alignmentCapture->state.load()==2;for(int i=0;i<200;++i)exact=exact&&utility.alignmentCapture->audio[0][static_cast<size_t>(i)]==static_cast<float>(100+i)*.001f;
    const bool rearmed=utility.alignmentCapture->arm(0,200,48000);clock.sample=0;utility.processBlock(buffer,midi);clock.sample=128;utility.processBlock(buffer,midi);const bool gapRejected=rearmed&&utility.alignmentCapture->state.load()==-1;
    const bool cancelArm=utility.alignmentCapture->arm(1000,200,48000);utility.alignmentCapture->abort();const bool cancelled=cancelArm&&utility.alignmentCapture->state.load()==-1&&utility.alignmentCapture->arm(1000,200,48000);utility.alignmentCapture->abort();
    result->setProperty("pass",estimatesPass&&!periodic.accepted&&!silent.accepted&&exact&&gapRejected&&cancelled);result->setProperty("lagCases",cases);result->setProperty("periodicRejected",!periodic.accepted);result->setProperty("silenceRejected",!silent.accepted);result->setProperty("exactCaptureWindow",exact);result->setProperty("clockGapRejected",gapRejected);result->setProperty("cancelAndRearm",cancelled);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkDispersiveSpring()
{
    juce::ScopedNoDenormals noDenormals;
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Dispersive spring propagation and dwell");
    const auto render=[](double rate,int block,BuiltInSpringReverb::Settings settings,bool impulse)
    {
        BuiltInSpringReverb engine;engine.prepare(rate);const int count=static_cast<int>(rate*.6);juce::AudioBuffer<float> output(2,count);
        for(int start=0;start<count;start+=block){engine.configure(true,settings);for(int i=start;i<juce::jmin(count,start+block);++i){const float input=impulse?(i==0?.5f:0.0f):static_cast<float>(.3*std::sin(juce::MathConstants<double>::twoPi*997*i/rate));const auto y=engine.process(input,-input);output.setSample(0,i,y[0]);output.setSample(1,i,y[1]);}}
        return output;
    };
    BuiltInSpringReverb::Settings settings;double minimumEnergy=1e20,peak=0;bool finite=true;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0}){const auto audio=render(rate,127,settings,true);double energy=0;for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i){const double value=audio.getSample(ch,i);finite=finite&&std::isfinite(value);energy+=value*value;peak=juce::jmax(peak,std::abs(value));}minimumEnergy=juce::jmin(minimumEnergy,energy);auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("energy",energy);cases.add(item);}
    const auto base=render(48000,127,settings,false),partitioned=render(48000,512,settings,false);double partitionError=0;for(int ch=0;ch<2;++ch)for(int i=0;i<base.getNumSamples();++i)partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(base.getSample(ch,i)-partitioned.getSample(ch,i))));
    juce::Array<juce::var> changes;bool controls=true;
    for(int control=0;control<6;++control){auto changed=settings;if(control==0)changed.count=1;if(control==1)changed.count=3;if(control==2)changed.dwell=3;if(control==3)changed.dispersion=.1f;if(control==4)changed.tension=.9f;if(control==5)changed.bass=-10;const auto audio=render(48000,127,changed,false);double difference=0;for(int i=0;i<audio.getNumSamples();++i)difference+=std::abs(audio.getSample(0,i)-base.getSample(0,i));changes.add(difference);controls=controls&&difference>.01;}
    BuiltInSpringReverb engine;engine.prepare(48000);engine.configure(true,settings);for(int i=0;i<10000;++i)engine.process(i==0?.5f:0.0f,0);engine.configure(false,settings);for(int i=0;i<3000;++i)engine.process(0,0);const bool suspended=engine.isSuspended();engine.configure(true,settings);double stale=0;for(int i=0;i<10000;++i){const auto y=engine.process(0,0);stale+=std::abs(y[0])+std::abs(y[1]);}
    OpenStudioReverb processor(true);processor.algorithm.store(4);processor.springControls[0].store(1);processor.springControls[1].store(2);processor.springControls[2].store(3);juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioReverb restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=restored.springControls[0].load()==1&&restored.springControls[1].load()==2&&restored.springControls[2].load()==3;
    juce::ValueTree old("OpenStudioReverb");old.setProperty("algorithm",4,nullptr);juce::MemoryBlock bytes;juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));const bool migration=restored.springControls[0].load()==0;
    const auto schema=describeFreePluginForRegression(processor);const auto* params=schema["parameters"].getArray();const bool appended=params&&params->size()>=486&&(*params)[473]["id"].toString()=="springEngine";bool setters=true;for(size_t i=0;i<OpenStudioReverb::springIds.size();++i)setters=setters&&setFreePluginParamForRegression(processor,OpenStudioReverb::springIds[i],OpenStudioReverb::springMax[i]);
    result->setProperty("pass",finite&&minimumEnergy>1e-8&&peak<1&&partitionError==0&&controls&&suspended&&stale==0&&recall&&migration&&appended&&setters);result->setProperty("cases",cases);result->setProperty("minimumEnergy",minimumEnergy);result->setProperty("peak",peak);result->setProperty("partitionError",partitionError);result->setProperty("controlDifferences",changes);result->setProperty("suspended",suspended);result->setProperty("staleEnergy",stale);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkAmbientSpaces()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Rising bloom cloud and vowel networks");
    const auto render=[](int mode,double rate,int block,BuiltInAmbientReverb::Settings settings)
    {
        BuiltInAmbientReverb processor;processor.prepare(rate,mode);juce::AudioBuffer<float> output(2,static_cast<int>(rate*.75));
        for(int start=0;start<output.getNumSamples();start+=block){processor.configure(mode,settings);for(int i=start;i<juce::jmin(output.getNumSamples(),start+block);++i){const float x=i==0?.25f:0;const auto value=processor.process(x,-x);output.setSample(0,i,value[0]);output.setSample(1,i,value[1]);}}return output;
    };
    bool finite=true,nonzero=true;double minEnergy=1e20;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int mode=0;mode<4;++mode){BuiltInAmbientReverb::Settings settings;const auto audio=render(mode,rate,127,settings);double energy=0,peak=0;for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i){const float x=audio.getSample(ch,i);finite=finite&&std::isfinite(x);energy+=x*x;peak=juce::jmax(peak,std::abs(static_cast<double>(x)));}minEnergy=juce::jmin(minEnergy,energy);nonzero=nonzero&&energy>1e-9&&peak<8;auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("mode",mode);item->setProperty("energy",energy);item->setProperty("peak",peak);cases.add(item);}
    BuiltInAmbientReverb::Settings settings;settings.vowel=6;const auto a=render(3,48000,127,settings),b=render(3,48000,512,settings);double partition=0;for(int i=0;i<a.getNumSamples();++i)partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(0,i)-b.getSample(0,i))));
    double frozenPeak=0,minimumInfiniteEnergy=1e20;
    for(int mode=0;mode<4;++mode){settings.hold=2;const auto frozen=render(mode,48000,127,settings);frozenPeak=juce::jmax(frozenPeak,static_cast<double>(frozen.getMagnitude(0,0,frozen.getNumSamples())));settings.hold=1;const auto infinite=render(mode,48000,127,settings);double energy=0;for(int i=0;i<infinite.getNumSamples();++i)energy+=std::pow(infinite.getSample(0,i),2);minimumInfiniteEnergy=juce::jmin(minimumInfiniteEnergy,energy);}
    settings={};settings.swellMode=1;settings.rise=.5f;BuiltInAmbientReverb swell;swell.prepare(48000,0);swell.configure(0,settings);double firstDry=0,halfDry=0,endDry=0,retriggerDry=0;for(int i=0;i<24000;++i){const auto x=swell.process(.2f,.2f);if(i==0)firstDry=x[3];if(i==11999)halfDry=x[3];if(i==23999)endDry=x[3];}for(int i=0;i<4800;++i)swell.process(0,0);for(int i=0;i<240;++i)retriggerDry=swell.process(.2f,.2f)[3];
    const bool riseCorrect=firstDry<1e-5&&std::abs(halfDry-.0988)<.001&&endDry>.198&&retriggerDry<.045;
    settings={};settings.length=.1f;const auto shortBloom=render(1,48000,127,settings);settings.length=1.5f;const auto longBloom=render(1,48000,127,settings);settings.vowel=0;const auto ah=render(3,48000,127,settings);settings.vowel=2;const auto oo=render(3,48000,127,settings);double bloomDifference=0,vowelDifference=0;for(int i=0;i<shortBloom.getNumSamples();++i){bloomDifference+=std::abs(shortBloom.getSample(0,i)-longBloom.getSample(0,i));vowelDifference+=std::abs(ah.getSample(0,i)-oo.getSample(0,i));}
    swell.configure(-1,settings);for(int i=0;i<4000;++i)swell.process(0,0);const auto frames=swell.processedFrames();for(int i=0;i<1000;++i)swell.process(0,0);const bool suspended=frames==swell.processedFrames();
    OpenStudioReverb source(true);source.selectAlgorithm(17);source.ambientControls[0][0].store(1.2f);source.selectAlgorithm(18);source.ambientControls[1][3].store(.7f);source.selectAlgorithm(19);source.ambientControls[2][8].store(50);source.selectAlgorithm(20);source.ambientControls[3][6].store(6);source.ambientControls[3][9].store(2);juce::MemoryBlock state;source.getStateInformation(state);OpenStudioReverb restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=restored.algorithm.load()==20;for(size_t bank=0;bank<4;++bank)for(size_t control=0;control<11;++control)recall=recall&&source.ambientControls[bank][control].load()==restored.ambientControls[bank][control].load();
    juce::ValueTree old("OpenStudioReverb");juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);old.writeToStream(stream);restored.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));bool migration=true;for(const auto& bank:restored.ambientControls)for(size_t i=0;i<bank.size();++i)migration=migration&&bank[i].load()==OpenStudioReverb::ambientDefaults[i];
    const auto schema=describeFreePluginForRegression(source);const auto* params=schema.getProperty("parameters",juce::var()).getArray();const bool ordered=params&&params->size()>=473&&(*params)[362].getProperty("id","").toString()=="ambRise";const bool setters=setFreePluginParamForRegression(source,"ambVowel",2)&&source.ambientControls[3][6].load()==2&&setFreePluginParamForRegression(source,"ambient0.0",.8f)&&source.ambientControls[0][0].load()==.8f;
    const bool pass=finite&&nonzero&&partition==0&&frozenPeak==0&&minimumInfiniteEnergy>1e-9&&riseCorrect&&bloomDifference>.01&&vowelDifference>.01&&suspended&&recall&&migration&&ordered&&setters;
    result->setProperty("pass",pass);result->setProperty("cases",cases);result->setProperty("minimumEnergy",minEnergy);result->setProperty("partitionError",partition);result->setProperty("frozenInputPeak",frozenPeak);result->setProperty("minimumInfiniteEnergy",minimumInfiniteEnergy);result->setProperty("firstSwellDry",firstDry);result->setProperty("halfSwellDry",halfDry);result->setProperty("endSwellDry",endDry);result->setProperty("retriggerDry",retriggerDry);result->setProperty("riseCorrect",riseCorrect);result->setProperty("bloomDifference",bloomDifference);result->setProperty("vowelDifference",vowelDifference);result->setProperty("inactiveSuspended",suspended);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",ordered);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkEchoRooms()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Magnetic heads and positioned room");
    const auto render=[](int mode,double rate,int block,BuiltInEchoRoom::Settings settings)
    {
        BuiltInEchoRoom processor;processor.prepare(rate,mode);juce::AudioBuffer<float> output(2,static_cast<int>(rate));
        for(int start=0;start<output.getNumSamples();start+=block){processor.configure(mode,settings);for(int i=start;i<juce::jmin(output.getNumSamples(),start+block);++i){const float x=i==0?.25f:0;const auto value=processor.process(x,-x);output.setSample(0,i,value[0]);output.setSample(1,i,value[1]);}}return output;
    };
    BuiltInEchoRoom::Settings clean;clean.damping=0;clean.diffusion=0;clean.motion=0;clean.feedback=0;clean.heads=0;const auto three=render(0,48000,127,clean);double headError=0;for(int i=0;i<three.getNumSamples();++i){const float expected=i==9600||i==19200||i==28800?.25f/3:0;headError=juce::jmax(headError,std::abs(static_cast<double>(three.getSample(0,i)-expected)));}
    clean.heads=2;const auto six=render(0,48000,127,clean);double sixError=0;for(int head=1;head<=6;++head)sixError=juce::jmax(sixError,std::abs(static_cast<double>(six.getSample(0,4800*head)-.25f/6)));
    bool finite=true,nonzero=true;double minimumEnergy=1e20;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int mode=0;mode<2;++mode){BuiltInEchoRoom::Settings settings;settings.motion=.7f;settings.feedback=.8f;const auto audio=render(mode,rate,127,settings);double energy=0,peak=0;for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i){const float x=audio.getSample(ch,i);finite=finite&&std::isfinite(x);energy+=x*x;peak=juce::jmax(peak,std::abs(static_cast<double>(x)));}nonzero=nonzero&&energy>1e-7&&peak<2;minimumEnergy=juce::jmin(minimumEnergy,energy);auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("mode",mode);item->setProperty("energy",energy);item->setProperty("peak",peak);cases.add(item);}
    BuiltInEchoRoom::Settings room;room.damping=0;const auto a=render(1,48000,127,room),b=render(1,48000,512,room);double partition=0,tail=0;int first=-1;for(int i=0;i<a.getNumSamples();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(0,i)-b.getSample(0,i))));if(first<0&&std::abs(a.getSample(0,i))>1e-10)first=i;if(i>24000)tail=juce::jmax(tail,std::abs(static_cast<double>(a.getSample(0,i))));}
    const double side=std::sqrt(9.3+83.6*.5),frontDistance=std::sqrt(.06*.06+std::pow(.6*side,2)),verticalDistance=std::sqrt(.06*.06+std::pow(.4*side,2)+2.8*2.8);const int expectedFirst=static_cast<int>(juce::jmin(frontDistance,verticalDistance)/343*48000);
    room.x=.1f;const auto moved=render(1,48000,127,room);double movement=0;for(int i=0;i<a.getNumSamples();++i)movement+=std::abs(a.getSample(0,i)-moved.getSample(0,i));BuiltInEchoRoom position;position.prepare(48000,1);room.x=0;position.configure(1,room);const auto dry=position.process(.2f,.2f);const bool dryPan=dry[3]>0&&std::abs(dry[4])<1e-9;
    position.configure(-1,room);for(int i=0;i<4000;++i)position.process(0,0);const auto frames=position.processedFrames();for(int i=0;i<1000;++i)position.process(0,0);const bool suspended=frames==position.processedFrames();
    OpenStudioReverb source(true);source.selectAlgorithm(15);source.echoRoomControls[0][0].store(900);source.echoRoomControls[0][1].store(2);source.selectAlgorithm(16);source.echoRoomControls[1][6].store(.25f);source.echoRoomControls[1][5].store(1);juce::MemoryBlock state;source.getStateInformation(state);OpenStudioReverb restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=restored.algorithm.load()==16&&restored.echoRoomControls[0][0].load()==900&&restored.echoRoomControls[1][6].load()==.25f;
    juce::ValueTree old("OpenStudioReverb");juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);old.writeToStream(stream);restored.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));bool migration=true;for(const auto& bank:restored.echoRoomControls)for(size_t i=0;i<bank.size();++i)migration=migration&&bank[i].load()==OpenStudioReverb::echoRoomDefaults[i];
    const auto schema=describeFreePluginForRegression(source);const auto* params=schema.getProperty("parameters",juce::var()).getArray();const bool ordered=params&&params->size()>=362&&(*params)[310].getProperty("id","").toString()=="headTime";const bool setters=setFreePluginParamForRegression(source,"sourceX",.75f)&&source.echoRoomControls[1][6].load()==.75f&&setFreePluginParamForRegression(source,"echoRoom0.0",800)&&source.echoRoomControls[0][0].load()==800;
    const bool pass=headError<1e-5&&sixError<1e-5&&finite&&nonzero&&partition==0&&tail==0&&std::abs(first-expectedFirst)<=1&&movement>.01&&dryPan&&suspended&&recall&&migration&&ordered&&setters;
    result->setProperty("pass",pass);result->setProperty("headError",headError);result->setProperty("sixHeadError",sixError);result->setProperty("cases",cases);result->setProperty("minimumEnergy",minimumEnergy);result->setProperty("partitionError",partition);result->setProperty("finiteTailPeak",tail);result->setProperty("firstReflection",first);result->setProperty("expectedFirstReflection",expectedFirst);result->setProperty("positionDifference",movement);result->setProperty("dryPan",dryPan);result->setProperty("inactiveSuspended",suspended);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",ordered);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkPlateColour()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Plate colour chorus and shelves");
    double neutralError=0,filterError=0,shelfError=0;bool finite=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInPlateColour neutral,hp,eq;neutral.prepare(rate);hp.prepare(rate);eq.prepare(rate);BuiltInPlateColour::Settings settings;neutral.configure(settings,true);settings.cut=500;hp.configure(settings,true);settings.cut=20;settings.eq=1;settings.lowFrequency=1000;settings.lowGain=12;eq.configure(settings,true);
        double inputPower=0,hpPower=0,eqPower=0;
        for(int i=0;i<static_cast<int>(rate);++i)
        {
            const float x=.1f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*1000*i/rate));const auto a=neutral.post(neutral.pre(neutral.input({x,-x}))),h=hp.post(hp.pre(hp.input({x,-x}))),e=eq.post(eq.pre(eq.input({x,-x})));
            neutralError=juce::jmax(neutralError,std::abs(static_cast<double>(a[0]-x)));finite=finite&&std::isfinite(h[0])&&std::isfinite(e[0]);if(i>=rate*.5){inputPower+=x*x;hpPower+=h[0]*h[0];eqPower+=e[0]*e[0];}
        }
        const double ratio=std::tan(juce::MathConstants<double>::pi*500/rate)/std::tan(juce::MathConstants<double>::pi*1000/rate);
        filterError=juce::jmax(filterError,std::abs(10*std::log10(hpPower/inputPower)+10*std::log10(1+std::pow(ratio,4))));shelfError=juce::jmax(shelfError,std::abs(10*std::log10(eqPower/inputPower)-6));
    }
    const auto render=[](int block,bool drive,bool chorus,bool post)
    {
        OpenStudioReverb processor(true);processor.selectAlgorithm(2);processor.wetLevel.store(0);processor.dryLevel.store(1);processor.plateColourControls[0].store(drive?18.0f:0);processor.plateColourControls[2].store(chorus?1.0f:0);processor.plateColourControls[3].store(post?1.0f:0);processor.prepareToPlay(48000,block);
        juce::AudioBuffer<float> output(2,24000),buffer(2,block);juce::MidiBuffer midi;
        for(int start=0;start<output.getNumSamples();start+=block){const int n=juce::jmin(block,output.getNumSamples()-start);buffer.setSize(2,n,false,false,true);for(int i=0;i<n;++i)for(int ch=0;ch<2;++ch)buffer.setSample(ch,i,.2f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*440*(start+i)/48000)));processor.processBlock(buffer,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,buffer,ch,0,n);}return output;
    };
    const auto dry=render(127,false,false,false),coloured=render(127,true,false,false),partitioned=render(512,true,false,false),chorused=render(127,false,true,true);double partition=0,dryChorus=0,colourDifference=0;
    for(int i=0;i<dry.getNumSamples();++i){partition=juce::jmax(partition,std::abs(static_cast<double>(coloured.getSample(0,i)-partitioned.getSample(0,i))));dryChorus=juce::jmax(dryChorus,std::abs(static_cast<double>(dry.getSample(0,i)-chorused.getSample(0,i))));colourDifference+=std::abs(dry.getSample(0,i)-coloured.getSample(0,i));}
    BuiltInPlateColour pre,post;pre.prepare(48000);post.prepare(48000);BuiltInPlateColour::Settings settings;settings.chorus=1;settings.amount=1;pre.configure(settings,true);settings.post=1;post.configure(settings,true);double preDifference=0,postDifference=0;
    for(int i=0;i<4800;++i){const float x=i==0?.25f:0;const auto a=pre.pre(pre.input({x,0})),b=post.pre(post.input({x,0}));const auto c=pre.post({0,0}),d=post.post({x,0});preDifference+=std::abs(a[0]-b[0]);postDifference+=std::abs(c[0]-d[0]);}
    OpenStudioReverb source(true);source.selectAlgorithm(2);source.plateColourControls[0].store(18);source.plateColourControls[2].store(1);source.plateColourControls[5].store(1);source.plateColourControls[7].store(6);juce::MemoryBlock state;source.getStateInformation(state);OpenStudioReverb restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));bool recall=true;for(size_t i=0;i<source.plateColourControls.size();++i)recall=recall&&source.plateColourControls[i].load()==restored.plateColourControls[i].load();
    juce::ValueTree old("OpenStudioReverb");juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);old.writeToStream(stream);restored.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));bool migration=true;for(size_t i=0;i<source.plateColourControls.size();++i)migration=migration&&restored.plateColourControls[i].load()==OpenStudioReverb::plateColourDefaults[i];
    const auto schema=describeFreePluginForRegression(source);const auto* params=schema.getProperty("parameters",juce::var()).getArray();bool ordered=params&&params->size()>=310;if(params)for(size_t i=0;i<OpenStudioReverb::plateColourIds.size();++i)ordered=ordered&&(*params)[300+static_cast<int>(i)].getProperty("id","").toString()==OpenStudioReverb::plateColourIds[i];
    const bool pass=finite&&neutralError==0&&filterError<.001&&shelfError<.001&&partition==0&&dryChorus==0&&colourDifference>1&&preDifference>.01&&postDifference>.01&&recall&&migration&&ordered;
    result->setProperty("pass",pass);result->setProperty("neutralError",neutralError);result->setProperty("filterErrorDb",filterError);result->setProperty("shelfErrorDb",shelfError);result->setProperty("partitionError",partition);result->setProperty("dryChorusError",dryChorus);result->setProperty("colourDifference",colourDifference);result->setProperty("preDifference",preDifference);result->setProperty("postDifference",postDifference);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",ordered);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkSpatialReverbs()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Contour room open hall and diffuse loop");
    const auto render=[](int mode,double rate,int block,BuiltInSpatialReverb::Settings settings,bool antiPhase=false)
    {
        BuiltInSpatialReverb processor;processor.prepare(rate,mode);juce::AudioBuffer<float> output(2,static_cast<int>(rate*2));
        for(int start=0;start<output.getNumSamples();start+=block){processor.configure(mode,settings);for(int i=start;i<juce::jmin(output.getNumSamples(),start+block);++i){const float x=i==0?.25f:0;const auto y=processor.process(x,antiPhase?-x:0);output.setSample(0,i,y[0]);output.setSample(1,i,y[1]);}}
        return output;
    };
    bool finite=true,nonzero=true;double minimumEnergy=1e20;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int mode=0;mode<3;++mode)
    {
        BuiltInSpatialReverb::Settings settings;settings.modulation=.4f;settings.feedback=.6f;const auto audio=render(mode,rate,127,settings,true);double energy=0,peak=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<audio.getNumSamples();++i){const float value=audio.getSample(ch,i);finite=finite&&std::isfinite(value);energy+=value*value;peak=juce::jmax(peak,std::abs(static_cast<double>(value)));}
        minimumEnergy=juce::jmin(minimumEnergy,energy);nonzero=nonzero&&energy>1e-7&&peak<4;
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("mode",mode);item->setProperty("energy",energy);item->setProperty("peak",peak);cases.add(item);
    }
    BuiltInSpatialReverb::Settings echo;echo.amount=0;echo.delayMs=10;echo.feedback=.5f;echo.modulation=0;
    const auto echoes=render(0,48000,127,echo);double echoError=0;for(int repeat=1;repeat<=8;++repeat)echoError=juce::jmax(echoError,std::abs(echoes.getSample(0,repeat*480)-.25*std::pow(.5,repeat-1)));
    echo.feedback=1;const auto loop=render(1,48000,127,echo);double loopError=0;for(int repeat=1;repeat<=100;++repeat)loopError=juce::jmax(loopError,std::abs(static_cast<double>(loop.getSample(0,repeat*480)-.25f)));
    BuiltInSpatialReverb::Settings settings;settings.delayMs=0;settings.modulation=.3f;const auto a=render(2,48000,127,settings),b=render(2,48000,512,settings),room=render(0,48000,127,settings),hall=render(1,48000,127,settings);double partition=0,roomHallDifference=0,loopHallDifference=0;
    for(int i=0;i<a.getNumSamples();++i)for(int ch=0;ch<2;++ch){partition=juce::jmax(partition,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));roomHallDifference+=std::abs(room.getSample(ch,i)-hall.getSample(ch,i));loopHallDifference+=std::abs(a.getSample(ch,i)-hall.getSample(ch,i));}
    settings.freeze=true;const auto frozen=render(0,48000,127,settings);double frozenPeak=frozen.getMagnitude(0,0,frozen.getNumSamples());
    BuiltInSpatialReverb schedule;schedule.prepare(48000,0);schedule.configure(0,settings);for(int i=0;i<1000;++i)schedule.process(.1f,.1f);schedule.configure(-1,settings);for(int i=0;i<4000;++i)schedule.process(0,0);const auto before=schedule.processedFrames();for(int i=0;i<10000;++i)schedule.process(0,0);const bool suspended=before==schedule.processedFrames();
    BuiltInSpatialReverb inputFilter;inputFilter.prepare(48000,0);BuiltInSpatialReverb::Settings filtered;filtered.amount=0;filtered.delayMs=0;filtered.feedback=0;filtered.highCut=1000;inputFilter.configure(0,filtered);double inputPower=0,outputPower=0;
    for(int i=0;i<48000;++i){const float x=.1f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*8000*i/48000));const auto y=inputFilter.process(x,x);if(i>=24000){inputPower+=x*x;outputPower+=y[0]*y[0];}}
    const double pole=std::exp(-juce::MathConstants<double>::twoPi*1000/48000),expectedGain=(1-pole)/std::sqrt(1+pole*pole-2*pole*std::cos(juce::MathConstants<double>::twoPi*8000/48000));
    const double inputFilterError=std::abs(10*std::log10(outputPower/inputPower)-20*std::log10(expectedGain));
    OpenStudioReverb processor(true);processor.selectAlgorithm(12);processor.roomSize.store(.7f);processor.spatialControls[0][1].store(.6f);processor.selectAlgorithm(13);processor.spatialControls[1][6].store(1.7f);processor.selectAlgorithm(14);processor.spatialControls[2][2].store(1);processor.spatialControls[2][3].store(14);processor.spatialControls[2][6].store(13);processor.workflowTempo.store(10);
    const bool capped=processor.requestedSpatialDelay()==96000&&processor.effectivePredelay()==6000;
    juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioReverb restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=restored.algorithm.load()==14&&restored.spatialControls[0][1].load()==.6f&&restored.spatialControls[1][6].load()==1.7f&&restored.spatialControls[2][6].load()==13&&restored.getBankValue(12,0)==.7f;
    juce::ValueTree legacy("OpenStudioReverb");juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));bool migration=restored.algorithm.load()==0;for(const auto& bank:restored.spatialControls)for(size_t i=0;i<bank.size();++i)migration=migration&&bank[i].load()==OpenStudioReverb::spatialDefaults[i];
    const auto schema=describeFreePluginForRegression(processor);const auto* params=schema.getProperty("parameters",juce::var()).getArray();juce::String prefix;if(params&&params->size()>=226)for(int i=0;i<226;++i)prefix+=(*params)[i].getProperty("id","").toString()+"\n";const bool ordered=params&&params->size()>=300&&juce::SHA256(prefix.toRawUTF8(),prefix.getNumBytesAsUTF8()).toHexString()=="95c918123a88b7f79c7b2fbd75084a5544cfb1faa596dc0e7037311302739c75";
    const bool setters=setFreePluginParamForRegression(processor,"spatialFeedback",.8f)&&processor.spatialControls[2][1].load()==.8f&&setFreePluginParamForRegression(processor,"spatial0.0",123)&&processor.spatialControls[0][0].load()==123;
    const bool passed=inputFilterError<.01&&finite&&nonzero&&echoError<1e-8&&loopError==0&&partition==0&&roomHallDifference>.01&&loopHallDifference>.01&&frozenPeak<1e-7&&suspended&&recall&&migration&&ordered&&capped&&setters;
    result->setProperty("pass",passed);result->setProperty("cases",cases);result->setProperty("minimumEnergy",minimumEnergy);result->setProperty("inputFilterErrorDb",inputFilterError);result->setProperty("echoAmplitudeError",echoError);result->setProperty("integerLoopError",loopError);result->setProperty("partitionError",partition);result->setProperty("roomHallDifference",roomHallDifference);result->setProperty("loopHallDifference",loopHallDifference);result->setProperty("frozenInputPeak",frozenPeak);result->setProperty("inactiveSuspended",suspended);result->setProperty("stateRecall",recall);result->setProperty("legacyMigration",migration);result->setProperty("parameterPrefix",ordered);result->setProperty("syncCap",capped);result->setProperty("setters",setters);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkSaturationColour()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Stateful saturation voices and tone");
    const auto render=[](int engine,float dynamics,int quality,int block,float mix,bool boost=false,bool compensation=false,bool reset=false)
    {
        OpenStudioSaturator processor;processor.colourEngine.store(static_cast<float>(engine));processor.colourDynamics.store(dynamics);processor.setOversamplingMode(static_cast<float>(quality));processor.drive.store(12);processor.driveCompensation.store(compensation?1.0f:0.0f);processor.boostDrive.store(boost?1.0f:0.0f);processor.mix.store(mix);processor.prepareToPlay(48000,block);if(reset)processor.reset();
        constexpr int count=48000;juce::AudioBuffer<float> audio(2,count),buffer(2,block);juce::MidiBuffer midi;
        for(int start=0;start<count;start+=block){const int n=juce::jmin(block,count-start);buffer.setSize(2,n,false,false,true);buffer.clear();for(int i=0;i<n;++i){const double time=(start+i)/48000.0;buffer.setSample(0,i,static_cast<float>((time<.4?.3:.03)*std::sin(juce::MathConstants<double>::twoPi*7500*time)));}processor.processBlock(buffer,midi);for(int ch=0;ch<2;++ch)audio.copyFrom(ch,start,buffer,ch,0,n);}
        return audio;
    };
    bool voices=true;double smallestHistoryDifference=1e20,zeroChannel=0;juce::Array<juce::var> voiceCases;
    for(int engine=1;engine<=5;++engine)
    {
        const auto dynamic=render(engine,1,1,127,1),staticVoice=render(engine,0,1,127,1);double difference=0,mean=0;bool finite=true;
        for(int i=0;i<dynamic.getNumSamples();++i){finite=finite&&std::isfinite(dynamic.getSample(0,i));zeroChannel=juce::jmax(zeroChannel,std::abs(static_cast<double>(dynamic.getSample(1,i))));if(i>20000)difference+=std::abs(dynamic.getSample(0,i)-staticVoice.getSample(0,i));if(i>=36000)mean+=dynamic.getSample(0,i)/12000.0;}
        smallestHistoryDifference=juce::jmin(smallestHistoryDifference,difference);voices=voices&&finite&&difference>.01&&std::abs(mean)<.001;
        auto* item=new juce::DynamicObject();item->setProperty("engine",engine);item->setProperty("historyDifference",difference);item->setProperty("tailMean",mean);voiceCases.add(item);
    }
    const auto wet=render(2,1,2,127,1),partitioned=render(2,1,2,512,1),dry=render(2,1,2,127,0),parallel=render(2,1,2,127,.5f),boosted=render(2,1,2,127,1,true),compensated=render(2,1,2,127,1,false,true);
    double partitionError=0,mixError=0,boostDifference=0,compensationError=0,dryError=0;OpenStudioSaturator latencyProbe;latencyProbe.setOversamplingMode(2);latencyProbe.prepareToPlay(48000,127);const int latency=latencyProbe.getLatencySamples();
    for(int i=latency;i<wet.getNumSamples();++i)
    {
        partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(wet.getSample(0,i)-partitioned.getSample(0,i))));mixError=juce::jmax(mixError,std::abs(static_cast<double>(parallel.getSample(0,i)-.5f*(wet.getSample(0,i)+dry.getSample(0,i)))));
        const double time=(i-latency)/48000.0;const float expected=static_cast<float>((time<.4?.3:.03)*std::sin(juce::MathConstants<double>::twoPi*7500*time));dryError=juce::jmax(dryError,std::abs(static_cast<double>(dry.getSample(0,i)-expected)));
        boostDifference+=std::abs(boosted.getSample(0,i)-wet.getSample(0,i));compensationError=juce::jmax(compensationError,std::abs(static_cast<double>(compensated.getSample(0,i)-wet.getSample(0,i)*juce::Decibels::decibelsToGain(-12.0f*.42f))));
    }
    const auto resetReference=render(3,1,2,127,1,true,true),resetAudio=render(3,1,2,127,1,true,true,true);double resetError=0;
    for(int i=0;i<resetReference.getNumSamples();++i)resetError=juce::jmax(resetError,std::abs(static_cast<double>(resetReference.getSample(0,i)-resetAudio.getSample(0,i))));
    double filterError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(bool steep:{false,true})for(double frequency:{2000.0,8000.0})
    {
        BuiltInSaturationColour colour;colour.prepare(rate);BuiltInSaturationColour::Settings settings;settings.engine=1;settings.highCut=2000;settings.steep=steep;colour.configure(settings,1);double inPower=0,outPower=0;
        for(int i=0;i<static_cast<int>(rate);++i){const float input=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate));const float output=colour.post(input,0);if(i>=static_cast<int>(rate*.5)){inPower+=input*input;outPower+=output*output;}}
        const double ratio=std::tan(juce::MathConstants<double>::pi*frequency/rate)/std::tan(juce::MathConstants<double>::pi*2000/rate);const double expected=-10*std::log10(1+std::pow(ratio,steep?10:2));filterError=juce::jmax(filterError,std::abs(10*std::log10(outPower/inPower)-expected));
    }
    juce::Array<juce::var> aliasCases;
    for(int quality=0;quality<3;++quality)
    {
        const auto audio=render(2,1,quality,127,1);double aliasPower=0;for(double frequency:{4500.0,10500.0}){double real=0,imag=0;for(int i=6000;i<18000;++i){const double phase=juce::MathConstants<double>::twoPi*frequency*i/48000;real+=audio.getSample(0,i)*std::cos(phase);imag+=audio.getSample(0,i)*std::sin(phase);}aliasPower+=(real*real+imag*imag)/(6000.0*6000.0);}auto* item=new juce::DynamicObject();item->setProperty("quality",quality);item->setProperty("selectedAliasBinPowerDbFS",10*std::log10(juce::jmax(1e-20,aliasPower)));item->setProperty("status","diagnostic_only");aliasCases.add(item);
    }
    OpenStudioSaturator processor;processor.colourEngine.store(4);processor.inputTrim.store(-3);processor.boostDrive.store(1);processor.driveCompensation.store(0);processor.colourTone.store(.6f);processor.cornerBump.store(4);processor.colourDynamics.store(.7f);processor.steepCut.store(1);juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioSaturator restored;restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));juce::MemoryBlock roundTrip;restored.getStateInformation(roundTrip);const bool recall=state==roundTrip;
    juce::ValueTree legacy("OpenStudioSaturator");juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));const bool migration=restored.colourEngine.load()==0&&restored.inputTrim.load()==0&&restored.boostDrive.load()==0&&restored.driveCompensation.load()==1;
    const auto schema=describeFreePluginForRegression(processor);const auto* params=schema.getProperty("parameters",juce::var()).getArray();const std::array<const char*,8> prefix{"satType","drive","mix","toneFreq","lowCutFreq","outputGain","asymmetry","oversampleMode"};bool ordered=params&&params->size() >= 16;if(params)for(size_t i=0;i<prefix.size();++i)ordered=ordered&&(*params)[static_cast<int>(i)].getProperty("id","").toString()==prefix[i];
    const bool passed=resetError==0&&voices&&zeroChannel==0&&partitionError<1e-6&&mixError<1e-6&&dryError<1e-7&&boostDifference>.1&&compensationError<1e-6&&filterError<.01&&recall&&migration&&ordered;
    result->setProperty("resetError",resetError);result->setProperty("pass",passed);result->setProperty("voiceCases",voiceCases);result->setProperty("zeroChannel",zeroChannel);result->setProperty("smallestHistoryDifference",smallestHistoryDifference);result->setProperty("partitionError",partitionError);result->setProperty("parallelMixError",mixError);result->setProperty("dryLatencyError",dryError);result->setProperty("boostDifference",boostDifference);result->setProperty("compensationError",compensationError);result->setProperty("filterErrorDb",filterError);result->setProperty("aliasCases",aliasCases);result->setProperty("stateRoundTrip",recall);result->setProperty("legacyMigration",migration);result->setProperty("parameterPrefix",ordered);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkLimiterGainWorkflow()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Limiter gain workflow");
    double maximumError = 0.0, transitionJump = 0.0; bool latency = true;
    for (int style = 0; style < 4; ++style)
        for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        {
            OpenStudioLimiter normal(true), audition(true);
            for (auto* limiter : {&normal, &audition})
            {
                limiter->limitingStyle.store(static_cast<float>(style)); limiter->threshold.store(-12);
                limiter->ceiling.store(-1); limiter->continuousGain.store(1); limiter->truePeak.store(0);
                limiter->prepareToPlay(rate, 127);
            }
            audition.unityAudition.store(1); audition.reset();
            juce::AudioBuffer<float> a(2,127), b(2,127); juce::MidiBuffer midi;
            for (int block = 0; block < 200; ++block)
            {
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 127; ++i)
                    a.setSample(ch,i,static_cast<float>(.8*std::sin(juce::MathConstants<double>::twoPi*701*(block*127+i)/rate)));
                b.makeCopyOf(a); normal.processBlock(a,midi); audition.processBlock(b,midi);
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 127; ++i)
                    maximumError=juce::jmax(maximumError,std::abs(static_cast<double>(b.getSample(ch,i)-a.getSample(ch,i)*juce::Decibels::decibelsToGain(-11.0f))));
            }
            latency=latency&&normal.getLatencySamples()==audition.getLatencySamples();
        }
    OpenStudioLimiter processor(true); processor.threshold.store(-12); processor.truePeak.store(0); processor.prepareToPlay(48000,1);
    juce::AudioBuffer<float> sample(2,1);juce::MidiBuffer midi;float previous=0;
    for(int i=0;i<3000;++i){sample.setSample(0,0,.01f);sample.setSample(1,0,.01f);if(i==1500)processor.unityAudition.store(1);processor.processBlock(sample,midi);if(i>1500&&i<2500)transitionJump=juce::jmax(transitionJump,std::abs(static_cast<double>(sample.getSample(0,0)-previous)));previous=sample.getSample(0,0);}
    processor.linkedEdits.store(1);juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioLimiter restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));const bool recall=restored.linkedEdits.load()==1&&restored.unityAudition.load()==1;
    juce::ValueTree old("OpenStudioLimiter");juce::MemoryBlock bytes;juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));const bool migration=restored.linkedEdits.load()==0&&restored.unityAudition.load()==0;
    const auto schema=describeFreePluginForRegression(processor);const auto* parameters=schema["parameters"].getArray();const bool appended=parameters&&parameters->size()>=13&&(*parameters)[11]["id"].toString()=="linkedEdits"&&(*parameters)[12]["id"].toString()=="unityAudition";
    result->setProperty("pass",maximumError<2e-7&&transitionJump<.00004&&latency&&recall&&migration&&appended);result->setProperty("makeupRemovalError",maximumError);result->setProperty("maximumTransitionStep",transitionJump);result->setProperty("latencyUnchanged",latency);result->setProperty("stateRecall",recall);result->setProperty("migration",migration);result->setProperty("appendedParameters",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkLimiterResponses()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Limiter dual envelopes and channel links");
    const auto render=[](int style,bool automatic,float link,int block,bool tp,double rate)
    {
        OpenStudioLimiter processor(true);processor.limitingStyle.store(static_cast<float>(style));processor.automaticRelease.store(automatic?1.0f:0.0f);processor.transientLink.store(link);processor.releaseLink.store(link);processor.threshold.store(-12);processor.ceiling.store(-1);processor.continuousGain.store(tp?1.0f:0.0f);processor.truePeak.store(tp?1.0f:0.0f);processor.prepareToPlay(rate,block);
        const int count=static_cast<int>(rate*1.2);juce::AudioBuffer<float> output(2,count),buffer(2,block);juce::MidiBuffer midi;
        for(int start=0;start<count;start+=block)
        {
            const int n=juce::jmin(block,count-start);buffer.setSize(2,n,false,false,true);
            for(int i=0;i<n;++i){const double time=(start+i)/rate;buffer.setSample(0,i,static_cast<float>((time>.1&&time<.5?.9:.08)*std::sin(juce::MathConstants<double>::twoPi*(tp?rate*.45:997)*time)));buffer.setSample(1,i,static_cast<float>(.03*std::sin(juce::MathConstants<double>::twoPi*701*time)));}
            processor.processBlock(buffer,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,buffer,ch,0,n);
        }
        return output;
    };
    const auto independent=render(2,false,0,127,false,48000),linked=render(2,false,1,127,false,48000),partitioned=render(2,false,0,512,false,48000),automatic=render(2,true,0,127,false,48000),swift=render(1,false,0,127,false,48000),sustain=render(3,false,0,127,false,48000);
    double isolation=0,partition=0,linkedEnergy=0,independentEnergy=0,autoDifference=0,styleDifference=0;
    for(int i=2000;i<independent.getNumSamples();++i)
    {
        const float expected=static_cast<float>(.03*std::sin(juce::MathConstants<double>::twoPi*701*(i-960)/48000.0));isolation=juce::jmax(isolation,std::abs(static_cast<double>(independent.getSample(1,i)-expected)));
        for(int ch=0;ch<2;++ch)partition=juce::jmax(partition,std::abs(static_cast<double>(independent.getSample(ch,i)-partitioned.getSample(ch,i))));
        if(i>6000&&i<24000){linkedEnergy+=std::pow(linked.getSample(1,i),2);independentEnergy+=std::pow(independent.getSample(1,i),2);}
        if(i>25000){autoDifference+=std::abs(automatic.getSample(0,i)-independent.getSample(0,i));styleDifference+=std::abs(swift.getSample(0,i)-sustain.getSample(0,i));}
    }
    double maximumPeak=0;bool tpPass=true;juce::Array<juce::var> peaks;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto audio=render(2,true,0,127,true,rate);juce::dsp::Oversampling<float> oracle(2,4,juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,true);oracle.initProcessing(static_cast<size_t>(audio.getNumSamples()));juce::dsp::AudioBlock<const float> block(audio);const auto up=oracle.processSamplesUp(block);float peak=0;
        for(size_t ch=0;ch<up.getNumChannels();++ch)for(size_t i=0;i<up.getNumSamples();++i)peak=juce::jmax(peak,std::abs(up.getSample(static_cast<int>(ch),static_cast<int>(i))));
        maximumPeak=juce::jmax(maximumPeak,static_cast<double>(peak));tpPass=tpPass&&peak<=juce::Decibels::decibelsToGain(-1.0f)+1e-4f;
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("peakDbTP",juce::Decibels::gainToDecibels(peak));peaks.add(item);
    }
    OpenStudioLimiter processor(true);processor.limitingStyle.store(3);processor.slowAttackMs.store(67);processor.automaticRelease.store(1);processor.transientLink.store(.2f);processor.releaseLink.store(.7f);juce::MemoryBlock state;processor.getStateInformation(state);OpenStudioLimiter restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));
    const bool recall=restored.limitingStyle.load()==3&&restored.slowAttackMs.load()==67&&restored.automaticRelease.load()==1&&restored.transientLink.load()==.2f&&restored.releaseLink.load()==.7f;
    juce::ValueTree legacy("OpenStudioLimiter");juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);legacy.writeToStream(stream);restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));const bool migration=restored.limitingStyle.load()==0&&restored.transientLink.load()==1&&restored.releaseLink.load()==1;
    const auto schema=describeFreePluginForRegression(processor);const auto* params=schema.getProperty("parameters",juce::var()).getArray();const std::array<const char*,6> prefix{"threshold","releaseMs","ceiling","lookaheadMs","continuousGain","truePeak"};bool ordered=params&&params->size()>=11;if(params)for(size_t i=0;i<prefix.size();++i)ordered=ordered&&(*params)[static_cast<int>(i)].getProperty("id","").toString()==prefix[i];
    const bool passed=isolation<1e-7&&partition==0&&linkedEnergy<independentEnergy*.5&&autoDifference>.01&&styleDifference>.01&&tpPass&&recall&&migration&&ordered;
    result->setProperty("pass",passed);result->setProperty("isolatedRightError",isolation);result->setProperty("partitionError",partition);result->setProperty("linkedRightEnergyRatio",linkedEnergy/independentEnergy);result->setProperty("automaticReleaseDifference",autoDifference);result->setProperty("styleDifference",styleDifference);result->setProperty("truePeakCases",peaks);result->setProperty("maximumReconstructedPeak",maximumPeak);result->setProperty("stateRoundTrip",recall);result->setProperty("legacyMigration",migration);result->setProperty("parameterPrefix",ordered);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkIntegratedLoudness()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Integrated loudness and loudness range");
    const auto power=[](double db){return std::pow(10.0,(db+.691)/10);};
    BuiltInLoudnessHistory history;history.prepare(1000);
    const auto feed=[&](double db,int samples){history.beginBlock();const double energy=power(db);for(int i=0;i<samples;++i)history.sample(energy,energy);};
    feed(-20,20000);feed(-30,20000);const auto twoTone=history.read();
    const double expected=-.691+10*std::log10((197*power(-20)+200*power(-30))/397);
    const double gateError=std::abs(twoTone.integrated-expected),lraError=std::abs(twoTone.lra-10);
    history.running.store(false);feed(-3,10000);const auto paused=history.read();const bool pause=paused.integrated==twoTone.integrated&&paused.seconds==twoTone.seconds&&!paused.running;
    history.running.store(true);feed(-90,10000);const auto silence=history.read();const bool gate=silence.integrated==twoTone.integrated&&silence.lra==twoTone.lra;
    history.requestReset();const bool pendingClear=!history.read().integratedReady;history.beginBlock();const bool cleared=!history.read().integratedReady;
    feed(-50,20000);feed(-35,20000);feed(-20,20000);feed(-35,20000);feed(-50,20000);const auto fiveTone=history.read();const bool range=std::abs(fiveTone.lra-15)<.02&&!fiveTone.provisional;
    BuiltInOutputMeter meter;meter.prepare(48000,127);juce::AudioBuffer<float> audio(2,127);
    for(int start=0;start<192024;start+=127)
    {
        for(int i=0;i<127;++i){const float sample=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi/48*(start+i)));audio.setSample(0,i,sample);audio.setSample(1,i,sample);}meter.process(audio);
    }
    const auto measured=meter.loudnessHistory.read();const double meterAgreement=std::abs(measured.integrated-meter.momentary.load());
    const bool calibrated=measured.integratedReady&&measured.lraReady&&std::abs(measured.integrated+20)<.1&&meterAgreement<.01&&measured.lra<.02&&measured.provisional;
    OpenStudioLimiter limiter(true);const bool commands=setFreePluginParamForRegression(limiter,"meterRunning",0)&&!limiter.outputMeter.loudnessHistory.running.load()&&setFreePluginParamForRegression(limiter,"meterReset",1);
    const bool passed=gateError<.001&&lraError<.02&&pause&&gate&&pendingClear&&cleared&&range&&calibrated&&commands;
    result->setProperty("pass",passed);result->setProperty("integratedGateErrorLU",gateError);result->setProperty("twoToneLraErrorLU",lraError);result->setProperty("fiveToneLraLU",fiveTone.lra);result->setProperty("pausePreservesMeasurement",pause);result->setProperty("silenceGated",gate);result->setProperty("resetClearsWithoutCallback",pendingClear);result->setProperty("resetApplied",cleared);result->setProperty("meterAgreementLU",meterAgreement);result->setProperty("calibrationPass",calibrated);result->setProperty("commands",commands);
    auto* viz=new juce::DynamicObject();viz->setProperty("integratedLUFS",measured.integrated);viz->setProperty("loudnessRangeLU",measured.lra);viz->setProperty("integratedReady",measured.integratedReady);viz->setProperty("loudnessRangeReady",measured.lraReady);viz->setProperty("loudnessRangeProvisional",measured.provisional);viz->setProperty("measurementSeconds",measured.seconds);viz->setProperty("meterRunning",true);viz->setProperty("maximumMomentaryLUFS",measured.maximumMomentary);viz->setProperty("maximumShortTermLUFS",measured.maximumShortTerm);viz->setProperty("momentaryLUFS",meter.momentary.load());viz->setProperty("shortTermLUFS",meter.shortTerm.load());viz->setProperty("outputLevelDb",meter.peakDb.load());viz->setProperty("outputTruePeakDb",meter.truePeakDb.load());viz->setProperty("gainReductionDb",0);
    const auto schema=describeFreePluginForRegression(limiter);schema.getDynamicObject()->setProperty("visualization",viz);result->setProperty("schema",schema);result->setProperty("standardCertification","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkExpandedEQ()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Expanded EQ bands and targets");
    double matrixError=0,isolationError=0,cutError=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        double outputPower=0,inputPower=0,expected=0;
        for(int inputChannel=0;inputChannel<2;++inputChannel)
        {
            OpenStudioEQ processor(true);for(auto& band:processor.bands)band.enabled.store(0);
            processor.bands[8].enabled.store(1);processor.bands[8].freq.store(500);processor.bands[8].gain.store(6);processor.bands[8].target.store(1);
            processor.bands[23].enabled.store(1);processor.bands[23].freq.store(1250);processor.bands[23].gain.store(-9);processor.bands[23].target.store(3);
            processor.prepareToPlay(rate,128);expected=processor.getMagnitudeResponse({static_cast<float>(rate/64)})[0];juce::MidiBuffer midi;
            for(int start=0;start<8192;start+=128)
            {
                juce::AudioBuffer<float> block(2,128);block.clear();for(int i=0;i<128;++i){const float input=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi/64*(start+i)));block.setSample(inputChannel,i,input);if(start>=4096)inputPower+=input*input;}
                processor.processBlock(block,midi);if(start>=4096)for(int ch=0;ch<2;++ch)for(int i=0;i<128;++i)outputPower+=block.getSample(ch,i)*block.getSample(ch,i);
            }
        }
        const double error=std::abs(10*std::log10(outputPower/inputPower)-expected);matrixError=juce::jmax(matrixError,error);
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("matrixResponseErrorDb",error);cases.add(item);
        for(int slope:{4,5})
        {
            OpenStudioEQ processor(true);for(auto& band:processor.bands)band.enabled.store(0);processor.bands[23].enabled.store(1);processor.bands[23].type.store(3);processor.bands[23].freq.store(2000);processor.bands[23].slope.store(static_cast<float>(slope));processor.prepareToPlay(rate,128);
            const double ratio=std::tan(juce::MathConstants<double>::pi*2000/rate)/std::tan(juce::MathConstants<double>::pi*1000/rate);
            const double expectedCut=-10*std::log10(1+std::pow(ratio,slope==4?24:32));
            cutError=juce::jmax(cutError,std::abs(processor.getMagnitudeResponse({1000})[0]-expectedCut));
        }
    }
    for(int target=1;target<=4;++target)
    {
        OpenStudioEQ processor(true);for(auto& band:processor.bands)band.enabled.store(0);processor.bands[23].enabled.store(1);processor.bands[23].gain.store(12);processor.bands[23].target.store(static_cast<float>(target));processor.prepareToPlay(48000,127);juce::MidiBuffer midi;
        for(int start=0;start<8001;start+=127)
        {
            juce::AudioBuffer<float> block(2,127),dry(2,127);
            for(int i=0;i<127;++i){const float input=static_cast<float>(.1*std::sin(.13*(start+i)));dry.setSample(0,i,target==1?0:input);dry.setSample(1,i,target==2?0:target==3?-input:input);}block.makeCopyOf(dry);processor.processBlock(block,midi);
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)isolationError=juce::jmax(isolationError,static_cast<double>(std::abs(block.getSample(ch,i)-dry.getSample(ch,i))));
        }
    }
    OpenStudioEQ source(true),copy(true),legacy;source.bands[23].enabled.store(1);source.bands[23].gain.store(9);source.bands[23].target.store(4);source.bands[23].slope.store(5);
    juce::MemoryBlock before,after,old;source.getStateInformation(before);copy.setStateInformation(before.getData(),static_cast<int>(before.getSize()));copy.getStateInformation(after);const bool state=before==after;
    legacy.getStateInformation(old);copy.setStateInformation(old.getData(),static_cast<int>(old.getSize()));bool migration=copy.bands[7].type.load()==4&&legacy.bandCount==8;
    for(int b=8;b<24;++b)migration=migration&&copy.bands[b].enabled.load()==0&&copy.bands[b].target.load()==0;
    const auto schema=describeFreePluginForRegression(source),oldSchema=describeFreePluginForRegression(legacy);bool prefix=schema["parameters"].size()>=293;
    for(int i=0;i<oldSchema["parameters"].size();++i)prefix=prefix&&schema["parameters"][i]["id"].toString()==oldSchema["parameters"][i]["id"].toString();
    const bool setter=setFreePluginParamForRegression(source,"band23.target",2)&&setFreePluginParamForRegression(source,"auditionBand",24)&&source.bands[23].target.load()==2&&source.auditionBand.load()==24;
    result->setProperty("pass",matrixError<.003&&isolationError<1e-6&&cutError<.05&&state&&migration&&prefix&&setter);result->setProperty("matrixCases",cases);result->setProperty("matrixResponseErrorDb",matrixError);result->setProperty("isolationError",isolationError);result->setProperty("steepCutErrorDb",cutError);
    result->setProperty("stateRoundTrip",state);result->setProperty("legacyMigration",migration);result->setProperty("parameterPrefix",prefix);result->setProperty("band24SetterAndAudition",setter);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkManualPhaseAlignment()
{
    using Phase=BuiltInPhaseAlignment; using Utility=OpenStudioUtilityEffect;
    auto* result=new juce::DynamicObject(); result->setProperty("plugin","Fractional timing and allpass phase");
    double phaseError=0, independenceError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0}) for(int stages=1;stages<=4;++stages)
    {
        Phase engine; engine.prepare(rate); std::array<Phase::Channel,2> settings {}; settings[0]={1,static_cast<float>(rate/48),static_cast<float>(stages-1)}; engine.configure(settings);
        double sine=0,cosine=0; const double omega=juce::MathConstants<double>::twoPi/48;
        for(int i=0;i<9600;++i)
        {
            const float input=static_cast<float>(.1*std::sin(omega*i)); const float output=engine.process(0,input), other=engine.process(1,input);
            independenceError=juce::jmax(independenceError,static_cast<double>(std::abs(other-input)));
            if(i>=4800) { sine+=output*std::sin(omega*i); cosine+=output*std::cos(omega*i); }
        }
        const double expectedPhase=-stages*juce::MathConstants<double>::halfPi;
        phaseError=juce::jmax(phaseError,std::abs(sine/240-std::cos(expectedPhase)),std::abs(cosine/240-std::sin(expectedPhase)));
    }
    const auto render=[](int size,bool impulse) {
        Utility processor(Utility::Kind::GainPhase); processor.setControl("delayL",7); processor.setControl("fineL",.5f); processor.setControl("delayR",11); processor.setControl("fineR",.25f);
        if(!impulse) { processor.setControl("phaseEnabledL",1); processor.setControl("phaseFrequencyL",1200); processor.setControl("phaseStagesL",2); processor.setControl("polarityR",1); }
        processor.prepareToPlay(48000,size); juce::AudioBuffer<float> audio(2,9600); juce::MidiBuffer midi;
        for(int start=0;start<audio.getNumSamples();start+=size)
        {
            const int count=juce::jmin(size,audio.getNumSamples()-start); juce::AudioBuffer<float> block(2,count);
            for(int i=0;i<count;++i) { const float input=impulse?(start+i==0?1.0f:0.0f):static_cast<float>(.1*std::sin(.13*(start+i))); block.setSample(0,i,input); block.setSample(1,i,input); }
            processor.processBlock(block,midi); for(int ch=0;ch<2;++ch) audio.copyFrom(ch,start,block,ch,0,count);
        }
        return audio;
    };
    const auto impulse=render(127,true), a=render(127,false), b=render(512,false); double impulseError=0, partitionError=0;
    const std::array<double,4> left {.3125,.9375,-.3125,.0625}, right {.6015625,.6015625,-.2578125,.0546875};
    for(int ch=0;ch<2;++ch) for(int i=0;i<impulse.getNumSamples();++i)
    {
        const int start=ch==0?7:11; const double expected=i>=start&&i<start+4?(ch==0?left:right)[static_cast<size_t>(i-start)]:0;
        impulseError=juce::jmax(impulseError,std::abs(impulse.getSample(ch,i)-expected));
        partitionError=juce::jmax(partitionError,static_cast<double>(std::abs(a.getSample(ch,i)-b.getSample(ch,i))));
    }
    Utility source(Utility::Kind::GainPhase), copy(Utility::Kind::GainPhase); source.setControl("delayL",125); source.setControl("fineL",.375f); source.setControl("phaseEnabledL",1); source.setControl("phaseFrequencyL",750); source.setControl("phaseStagesL",3);
    juce::MemoryBlock before,after; source.getStateInformation(before); copy.setStateInformation(before.getData(),static_cast<int>(before.getSize())); copy.getStateInformation(after); const bool state=before==after;
    auto tree=juce::ValueTree::readFromData(before.getData(),before.getSize()); for(size_t i=6;i<source.controls.size();++i) tree.removeProperty(source.controls[i].id,nullptr);
    juce::MemoryBlock old; {juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);} copy.setStateInformation(old.getData(),static_cast<int>(old.getSize()));
    const bool migration=copy.values[3].load()==125&&copy.values[6].load()==0&&copy.values[8].load()==0&&copy.values[12].load()==0;
    const bool prefix=source.controls.size()>=14&&juce::String(source.controls[0].id)=="gain"&&juce::String(source.controls[5].id)=="bypass";
    const bool passed=phaseError<1e-6&&independenceError==0&&impulseError<1e-7&&partitionError<1e-7&&state&&migration&&prefix;
    result->setProperty("pass",passed);result->setProperty("allpassCornerCases",16);result->setProperty("allpassComplexError",phaseError);result->setProperty("otherChannelError",independenceError);result->setProperty("fractionalImpulseError",impulseError);result->setProperty("partitionError",partitionError);
    result->setProperty("stateRoundTrip",state);result->setProperty("legacyMigration",migration);result->setProperty("parameterPrefix",prefix);result->setProperty("schema",describeFreePluginForRegression(source));result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkGraphicEQWorkflow()
{
    using Graphic = BuiltInGraphicEQ;
    using Utility = OpenStudioUtilityEffect;
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Graphic EQ banks and analysis");
    bool passed = true; double centreError = 0, responseError = 0;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
        for (double hz : Graphic::frequencies) for (double db : { -12.0, 6.0, 12.0 })
            centreError = juce::jmax(centreError, std::abs(juce::Decibels::gainToDecibels(Graphic::magnitude(Graphic::peak(rate,hz,db,Graphic::q()),rate,juce::jmin(hz,rate*.45)))-db));
    juce::Array<juce::var> cases;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 }) for (int mode : { 0, 1 })
    {
        Utility processor(Utility::Kind::GraphicEQ); processor.setControl("graphicMode",static_cast<float>(mode));
        processor.setControl(mode == 0 ? "geq5" : "third17",6); processor.setControl("graphicHPEnabled",1); processor.setControl("graphicHP",100);
        processor.setControl("graphicLPEnabled",1); processor.setControl("graphicLP",6000); processor.setControl("outputGain",-3); processor.prepareToPlay(rate,127);
        const auto viz = processor.graphicVisualization(); const int bin = 72;
        const double hz = static_cast<double>(viz["frequencies"][bin]), expected = static_cast<double>(viz["responseDb"][bin]);
        double inputPower=0, outputPower=0; juce::MidiBuffer midi; const int total=static_cast<int>(rate*.4), warm=total/2;
        for (int start=0;start<total;start+=127)
        {
            const int count=juce::jmin(127,total-start); juce::AudioBuffer<float> block(2,count);
            for(int i=0;i<count;++i) { const float input=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*hz/rate*(start+i))); block.setSample(0,i,input); block.setSample(1,i,-input); if(start+i>=warm) inputPower+=input*input; }
            processor.processBlock(block,midi); for(int i=0;i<count;++i) if(start+i>=warm) outputPower+=block.getSample(0,i)*block.getSample(0,i);
        }
        const double error=std::abs(10*std::log10(outputPower/inputPower)-expected); responseError=juce::jmax(responseError,error);
        auto* item=new juce::DynamicObject(); item->setProperty("rate",rate); item->setProperty("mode",mode); item->setProperty("errorDb",error); cases.add(item);
    }
    const auto render=[](int size,int target,bool opposite) {
        Utility processor(Utility::Kind::GraphicEQ); processor.setControl("graphicMode",1); processor.setControl("third17",9); processor.setControl("graphicTarget",static_cast<float>(target)); processor.prepareToPlay(48000,size);
        juce::AudioBuffer<float> audio(2,9600); juce::MidiBuffer midi;
        for(int start=0;start<audio.getNumSamples();start+=size)
        {
            const int count=juce::jmin(size,audio.getNumSamples()-start); juce::AudioBuffer<float> block(2,count);
            for(int i=0;i<count;++i) { const float input=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi/48*(start+i))); block.setSample(0,i,input); block.setSample(1,i,opposite?-input:input); }
            processor.processBlock(block,midi); for(int ch=0;ch<2;++ch) audio.copyFrom(ch,start,block,ch,0,count);
        }
        return audio;
    };
    double routingError=0, partitionError=0;
    for(int target=0;target<5;++target)
    {
        const auto a=render(127,target,target==3), b=render(512,target,target==3);
        for(int ch=0;ch<2;++ch) for(int i=0;i<a.getNumSamples();++i)
        {
            partitionError=juce::jmax(partitionError,static_cast<double>(std::abs(a.getSample(ch,i)-b.getSample(ch,i))));
            if((target==1&&ch==1)||(target==2&&ch==0)||target>=3)
            {
                const float dry=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi/48*i))*(target==3&&ch==1?-1.0f:1.0f);
                routingError=juce::jmax(routingError,static_cast<double>(std::abs(a.getSample(ch,i)-dry)));
            }
        }
    }
    Utility source(Utility::Kind::GraphicEQ), copy(Utility::Kind::GraphicEQ);
    source.setControl("graphicMode",1); source.setControl("geq5",3); source.setControl("third17",7); source.setControl("graphicTarget",4);
    juce::MemoryBlock before,after; source.getStateInformation(before); copy.setStateInformation(before.getData(),static_cast<int>(before.getSize())); copy.getStateInformation(after);
    const bool state=before==after;
    auto old=juce::ValueTree::readFromData(before.getData(),before.getSize()); for(size_t i=12;i<source.controls.size();++i) old.removeProperty(source.controls[i].id,nullptr);
    juce::MemoryBlock oldData; { juce::MemoryOutputStream stream(oldData,false); old.writeToStream(stream); }
    copy.setStateInformation(oldData.getData(),static_cast<int>(oldData.getSize()));
    const bool migration=copy.values[12].load()==0&&copy.values[13].load()==0&&copy.values[14].load()==0&&copy.values[16].load()==0&&copy.values[5].load()==3&&copy.values[35].load()==0;
    bool prefix=source.controls.size()==49; for(int i=0;i<10;++i) prefix=prefix&&juce::String(source.controls[static_cast<size_t>(i)].id)=="geq"+juce::String(i);
    prefix=prefix&&juce::String(source.controls[10].id)=="outputGain"&&juce::String(source.controls[11].id)=="bypass";
    BuiltInSpectrumCapture capture; capture.prepare(48000); capture.read(); capture.beginBlock(2048);
    for(int i=0;i<2048;++i) { const float input=static_cast<float>(.5*std::sin(juce::MathConstants<double>::twoPi*64/2048*i)); capture.push(input,-input,input*.5f,-input*.5f); }
    const auto spectrum=capture.read(); const double spectrumError=juce::jmax(std::abs(spectrum.pre[64]+6.020599913),std::abs(spectrum.post[64]+12.041199827));
    capture.reset(); const bool reset=!capture.read().ready;
    passed=centreError<.0001&&responseError<.03&&routingError<1e-7&&partitionError<1e-7&&state&&migration&&prefix&&spectrum.ready&&spectrumError<.02&&reset;
    result->setProperty("pass",passed); result->setProperty("centreCases",372); result->setProperty("centreErrorDb",centreError); result->setProperty("responseCases",cases); result->setProperty("responseErrorDb",responseError);
    result->setProperty("routingError",routingError); result->setProperty("partitionError",partitionError); result->setProperty("stateRoundTrip",state); result->setProperty("legacyMigration",migration); result->setProperty("parameterPrefix",prefix);
    result->setProperty("antiphaseSpectrumErrorDb",spectrumError); result->setProperty("spectrumReset",reset); source.prepareToPlay(48000,127); result->setProperty("schema",describeFreePluginForRegression(source)); result->setProperty("audioQuality","not_asserted"); return result;
}

juce::var checkVCAWorkflow()
{
    using VCA = BuiltInVCACompressor;
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Independent RMS VCA workflows");
    bool passed = true; juce::Array<juce::var> cases;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 }) for (bool punch : { false, true })
        for (bool infinity : { false, true }) for (float db : { -30.0f, -18.0f, -6.0f })
    {
        VCA engine; engine.prepare(rate, punch); auto settings = VCA::defaults(punch); settings.channels[0][VCA::Infinity] = infinity ? 1.0f : 0.0f; engine.configure(settings);
        const float level = juce::Decibels::decibelsToGain(db);
        for (int i = 0; i < static_cast<int>(rate * .5); ++i) engine.process(level, -level, level, -level);
        const double expected = (db == -30 ? 0 : db == -18 ? (punch ? 0 : .75) : 12) * (infinity ? 1 : punch ? .75 : .5);
        const double error = std::abs(engine.gainReduction() - expected);
        auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("punch", punch); item->setProperty("infinity", infinity); item->setProperty("inputDb", db);
        item->setProperty("steadyErrorDb", error); item->setProperty("pass", error < .0001); cases.add(item); passed = passed && error < .0001;
    }
    juce::Array<juce::var> routingCases;
    for (bool punch : { false, true })
    {
        VCA linked, dual, ms; for (auto* engine : { &linked, &dual, &ms }) engine->prepare(48000, punch);
        auto settings = VCA::defaults(punch); linked.configure(settings); settings.routing = 1; dual.configure(settings);
        settings.routing = 2; settings.channels[1][VCA::Threshold] = punch ? -9.0f : -10.0f; ms.configure(settings);
        std::array<float, 2> a {}, b {}, c {};
        for (int i = 0; i < 24000; ++i)
        {
            a = linked.process(.5f, .02f, .5f, .02f); b = dual.process(.5f, .02f, .5f, .02f);
            c = ms.process(.52f, .48f, .52f, .48f);
        }
        const bool independence = a[1] < .015f && std::abs(b[1] - .02f) < 1e-6f && std::abs(a[0]-b[0]) < 1e-6f;
        const bool msIsolation = std::abs((c[0]-c[1]) - .04f) < 1e-6f && c[0]+c[1] < .8f;
        VCA sine, constant; sine.prepare(48000, punch); constant.prepare(48000, punch); settings = VCA::defaults(punch); sine.configure(settings); constant.configure(settings);
        double sineGr = 0, dcGr = 0;
        for (int i = 0; i < 24000; ++i)
        {
            const float input = static_cast<float>(.5 * std::sin(juce::MathConstants<double>::twoPi * .1 * i));
            sine.process(input, -input, input, -input); constant.process(.5f, -.5f, .5f, -.5f);
            if (i >= 19200) { sineGr += sine.gainReduction(); dcGr += constant.gainReduction(); }
        }
        const double rmsError = std::abs((dcGr-sineGr)/4800 - 3.01029995664 * (punch ? .75 : .5));
        auto* item = new juce::DynamicObject(); item->setProperty("punch", punch); item->setProperty("dualMonoIndependent", independence); item->setProperty("midSideIsolation", msIsolation);
        item->setProperty("rmsCrestErrorDb", rmsError); item->setProperty("pass", independence && msIsolation && rmsError < .05); routingCases.add(item);
        passed = passed && independence && msIsolation && rmsError < .05;
    }
    VCA autoFast, autoSlow; autoFast.prepare(48000, false); autoSlow.prepare(48000, false);
    auto autoSettings = VCA::defaults(false); autoSettings.channels[0][VCA::AutoRelease] = 1; autoSettings.channels[0][VCA::Release] = 100; autoFast.configure(autoSettings);
    autoSettings.channels[0][VCA::Release] = 4000; autoSlow.configure(autoSettings); double autoError = 0;
    for (int i = 0; i < 48000; ++i)
    {
        const float input = i < 24000 ? .5f : .01f;
        const auto a = autoFast.process(input, input, input, input), b = autoSlow.process(input, input, input, input);
        autoError = juce::jmax(autoError, static_cast<double>(std::abs(a[0]-b[0])));
    }
    // HPF belongs only to detection; neutral mode changes must preserve polarity and unity.
    VCA neutral; neutral.prepare(48000, true); auto neutralSettings = VCA::defaults(true);
    for (auto& channel : neutralSettings.channels) { channel[VCA::Ratio] = 1; channel[VCA::HighPass] = 1; }
    double neutralError = 0;
    for (int i = 0; i < 6000; ++i)
    {
        if (i % 100 == 0) { neutralSettings.routing = (i / 100) % 3; neutral.configure(neutralSettings); }
        const float l = static_cast<float>(.1 * std::sin(.07*i)), r = static_cast<float>(.03 * std::cos(.13*i));
        const auto output = neutral.process(l, r, l, r); neutralError = juce::jmax(neutralError, static_cast<double>(std::abs(output[0]-l)), static_cast<double>(std::abs(output[1]-r)));
    }
    OpenStudioCompressor source(true), copy(true); source.selectModel(5); bool setters = true;
    for (size_t bank = 0; bank < 2; ++bank)
    {
        const juce::String prefix = bank == 0 ? "busVca" : "punchVca";
        setters = setFreePluginParamForRegression(source, prefix + "Routing", 2) && setters;
        for (size_t ch = 0; ch < 2; ++ch) for (size_t field = 0; field < VCA::Count; ++field)
        {
            if (!VCA::applicable(field, bank == 1)) continue;
            const auto range = VCA::spec(field, bank == 1);
            setters = setFreePluginParamForRegression(source, prefix + juce::String(static_cast<int>(ch)) + range.id, ch == 0 ? range.min : range.max) && setters;
        }
    }
    juce::MemoryBlock before, after; source.getStateInformation(before); source.selectModel(6); source.selectModel(5);
    copy.setStateInformation(before.getData(), static_cast<int>(before.getSize())); copy.getStateInformation(after);
    const bool state = before == after && source.vcaControls[0].channels[1][VCA::Release].load() == 4000;
    auto tree = juce::ValueTree::readFromData(before.getData(), before.getSize()); tree.removeProperty("busVcaEngine", nullptr); tree.removeProperty("punchVcaEngine", nullptr);
    juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy.setStateInformation(old.getData(), static_cast<int>(old.getSize())); const bool migration = copy.vcaControls[0].engine.load() == 0 && copy.vcaControls[1].engine.load() == 0;
    const auto render = [](int model, int size, int routing, float wet, bool quiet) {
        OpenStudioCompressor processor(true); processor.selectModel(model); processor.mix.store(wet);
        auto& controls = processor.vcaControls[static_cast<size_t>(model-5)]; controls.routing.store(static_cast<float>(routing));
        if (quiet) for (auto& channel : controls.channels) channel[VCA::Output].store(6);
        processor.prepareToPlay(48000, size); juce::AudioBuffer<float> audio(2, 9600); juce::MidiBuffer midi;
        for (int start = 0; start < audio.getNumSamples(); start += size)
        {
            const int count = juce::jmin(size, audio.getNumSamples()-start); juce::AudioBuffer<float> block(2, count);
            for (int i = 0; i < count; ++i) { const float input = static_cast<float>((quiet ? .0001 : .5) * std::sin(.13*(start+i))); block.setSample(0,i,input); block.setSample(1,i,-input*.5f); }
            processor.processBlock(block,midi); for (int ch=0;ch<2;++ch) audio.copyFrom(ch,start,block,ch,0,count);
        }
        return audio;
    };
    double partitionError = 0, mixError = 0;
    for (int model : { 5, 6 }) for (int routing : { 0, 1, 2 })
    {
        const auto a = render(model,127,routing,1,false), b = render(model,512,routing,1,false);
        for (int ch=0;ch<2;++ch) for (int i=0;i<a.getNumSamples();++i) partitionError=juce::jmax(partitionError,static_cast<double>(std::abs(a.getSample(ch,i)-b.getSample(ch,i))));
        for (float wet : { 0.0f, .5f, 1.0f })
        {
            const auto audio=render(model,127,routing,wet,true);
            for (int i=0;i<audio.getNumSamples();++i)
            {
                const double expected=i<960?0:.0001*std::sin(.13*(i-960))*(1-wet+wet*juce::Decibels::decibelsToGain(6.0));
                mixError=juce::jmax(mixError,std::abs(audio.getSample(0,i)-expected),std::abs(audio.getSample(1,i)+expected*.5));
            }
        }
    }
    passed = passed && autoError == 0 && neutralError < 1e-6 && setters && state && migration && partitionError < 1e-7 && mixError < 1e-7;
    result->setProperty("pass",passed); result->setProperty("curveCases",cases); result->setProperty("routingCases",routingCases);
    result->setProperty("autoIgnoresManualError",autoError); result->setProperty("neutralModeSwitchError",neutralError); result->setProperty("stateRoundTrip",state); result->setProperty("legacyMigration",migration);
    result->setProperty("partitionError",partitionError); result->setProperty("alignedMixError",mixError);
    result->setProperty("schema",describeFreePluginForRegression(source)); result->setProperty("audioQuality","not_asserted"); return result;
}

juce::var checkOpticalWorkflow()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Independent optical workflows");
    bool passed = true; juce::Array<juce::var> cases;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 }) for (int model = 0; model < 2; ++model)
    {
        for (int mode = 0; mode < 2; ++mode)
        {
            BuiltInOpticalCompressor engine; engine.prepare(rate, model == 1);
            BuiltInOpticalCompressor::Settings settings; settings.reduction = 60; settings.mode = static_cast<float>(mode); engine.configure(settings);
            for (int i = 0; i < static_cast<int>(rate * 2); ++i) engine.process(.5f, -.5f, 1);
            const double expected = (juce::Decibels::gainToDecibels(.5) + 24) * (mode == 0 ? 2.0/3 : 1);
            const double error = std::abs(engine.gainReduction() - expected);
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("model", model + 3); item->setProperty("mode", mode);
            item->setProperty("steadyCurveErrorDb", error); item->setProperty("pass", error < .001); cases.add(item); passed = passed && error < .001;
        }
        BuiltInOpticalCompressor shortBurst, sustained, trimmed;
        for (auto* engine : { &shortBurst, &sustained, &trimmed }) engine->prepare(rate, model == 1);
        BuiltInOpticalCompressor::Settings settings; settings.reduction = 60;
        shortBurst.configure(settings); sustained.configure(settings); settings.gain = 6; trimmed.configure(settings);
        double baseGain = 1, trimmedGain = 1;
        for (int i = 0; i < static_cast<int>(rate * 2); ++i) { baseGain = sustained.process(.5f, -.5f, 1); trimmedGain = trimmed.process(.5f, -.5f, 1); }
        for (int i = 0; i < static_cast<int>(rate * .05); ++i) shortBurst.process(.5f, -.5f, 1);
        const double shortStart = shortBurst.gainReduction(), longStart = sustained.gainReduction();
        const bool routing = std::abs(juce::Decibels::gainToDecibels(trimmedGain / baseGain) - 6) < .0001 && sustained.gainReduction() == trimmed.gainReduction();
        for (int i = 0; i < static_cast<int>(rate * .2); ++i) { shortBurst.process(0, 0, 1); sustained.process(0, 0, 1); }
        const double shortResidual = shortBurst.gainReduction() / shortStart, longResidual = sustained.gainReduction() / longStart;
        const bool memory = longResidual > shortResidual + .03 && longResidual < .6;
        settings.reduction = 0; trimmed.configure(settings); double offGain = 0;
        for (int i = 0; i < static_cast<int>(rate * .021); ++i) offGain = trimmed.process(.9f, -.9f, 1);
        const bool off = trimmed.gainReduction() == 0 && std::abs(juce::Decibels::gainToDecibels(offGain) - 6) < .0001;
        auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("model", model + 3);
        item->setProperty("gainOutsideDetector", routing); item->setProperty("shortNormalizedResidual", shortResidual); item->setProperty("longNormalizedResidual", longResidual);
        item->setProperty("historyDependentRelease", memory); item->setProperty("zeroReductionRetainsGain", off); item->setProperty("pass", routing && memory && off);
        cases.add(item); passed = passed && routing && memory && off;
    }
    // Detector emphasis must suppress LF sensitivity, without behaving as audible EQ.
    juce::Array<juce::var> emphasisCases;
    for (int model = 0; model < 2; ++model) for (double frequency : { 100.0, 8000.0 })
    {
        BuiltInOpticalCompressor flat, emphasized; flat.prepare(48000, model == 1); emphasized.prepare(48000, model == 1);
        BuiltInOpticalCompressor::Settings settings; settings.reduction = 75; flat.configure(settings); settings.emphasis = 1; emphasized.configure(settings);
        for (int i = 0; i < 96000; ++i) { const float input = static_cast<float>(.5 * std::sin(juce::MathConstants<double>::twoPi * frequency * i / 48000)); flat.process(input, -input, 1); emphasized.process(input, -input, 1); }
        const double delta = flat.gainReduction() - emphasized.gainReduction(); const bool ok = frequency == 100 ? delta > 7 : std::abs(delta) < 1;
        auto* item = new juce::DynamicObject(); item->setProperty("model", model + 3); item->setProperty("frequency", frequency); item->setProperty("reductionDifferenceDb", delta); item->setProperty("pass", ok);
        emphasisCases.add(item); passed = passed && ok;
    }
    BuiltInOpticalCompressor tube, solid; tube.prepare(48000, false); solid.prepare(48000, true); tube.configure({}); solid.configure({});
    for (int i = 0; i < 240; ++i) { tube.process(.5f, .5f, 1); solid.process(.5f, .5f, 1); }
    const bool distinctAttack = solid.gainReduction() > tube.gainReduction() + 1;
    OpenStudioCompressor source(true), copy(true); source.selectModel(3);
    bool setters = true;
    for (const auto& prefix : { juce::String("tubeOpto"), juce::String("solidOpto") })
    {
        setters = setFreePluginParamForRegression(source, prefix + "Reduction", prefix == "tubeOpto" ? 63.0f : 71.0f) && setters;
        setters = setFreePluginParamForRegression(source, prefix + "Gain", 6) && setters;
        setters = setFreePluginParamForRegression(source, prefix + "Mode", 1) && setters;
        setters = setFreePluginParamForRegression(source, prefix + "Emphasis", .7f) && setters;
    }
    juce::MemoryBlock before, after; source.getStateInformation(before); source.selectModel(4); source.selectModel(3);
    copy.setStateInformation(before.getData(), static_cast<int>(before.getSize())); copy.getStateInformation(after);
    const bool state = before == after && source.opticalControls[0].reduction.load() == 63 && source.opticalControls[1].reduction.load() == 71;
    auto tree = juce::ValueTree::readFromData(before.getData(), before.getSize()); tree.removeProperty("tubeOptoEngine", nullptr); tree.removeProperty("solidOptoEngine", nullptr);
    juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy.setStateInformation(old.getData(), static_cast<int>(old.getSize())); const bool migration = copy.opticalControls[0].engine.load() == 0 && copy.opticalControls[1].engine.load() == 0;
    const auto render = [](int model, int size, float wet, bool off) {
        OpenStudioCompressor processor(true); processor.selectModel(model); processor.mix.store(wet);
        processor.opticalControls[static_cast<size_t>(model - 3)].reduction.store(off ? 0.0f : 65.0f);
        processor.opticalControls[static_cast<size_t>(model - 3)].gain.store(6);
        processor.prepareToPlay(48000, size); juce::AudioBuffer<float> audio(2, 9600); juce::MidiBuffer midi;
        for (int start = 0; start < audio.getNumSamples(); start += size)
        {
            const int count = juce::jmin(size, audio.getNumSamples() - start); juce::AudioBuffer<float> block(2, count);
            for (int i = 0; i < count; ++i) { const float input = static_cast<float>(.1 * std::sin(.13 * (start + i))); block.setSample(0, i, input); block.setSample(1, i, -input); }
            processor.processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) audio.copyFrom(ch, start, block, ch, 0, count);
        }
        return audio;
    };
    double partitionError = 0, mixError = 0;
    for (int model : { 3, 4 })
    {
        const auto a = render(model, 127, 1, false), b = render(model, 512, 1, false);
        for (int i = 0; i < a.getNumSamples(); ++i) partitionError = juce::jmax(partitionError, static_cast<double>(std::abs(a.getSample(0, i)-b.getSample(0, i))));
        for (float wet : { 0.0f, .5f, 1.0f })
        {
            const auto audio = render(model, 127, wet, true);
            for (int i = 0; i < audio.getNumSamples(); ++i)
            {
                const double expected = i < 960 ? 0 : .1 * std::sin(.13*(i-960)) * (1-wet+wet*juce::Decibels::decibelsToGain(6.0));
                mixError = juce::jmax(mixError, std::abs(audio.getSample(0, i)-expected), std::abs(audio.getSample(1, i)+expected));
            }
        }
    }
    passed = passed && distinctAttack && setters && state && migration && partitionError < 1e-7 && mixError < 1e-6;
    result->setProperty("pass", passed); result->setProperty("responseCases", cases); result->setProperty("emphasisCases", emphasisCases);
    result->setProperty("distinctAttack", distinctAttack); result->setProperty("stateRoundTrip", state); result->setProperty("legacyMigration", migration);
    result->setProperty("partitionError", partitionError); result->setProperty("alignedMixError", mixError);
    result->setProperty("schema", describeFreePluginForRegression(source)); result->setProperty("audioQuality", "not_asserted"); return result;
}

juce::var checkFETWorkflow()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Input-driven FET workflow");
    bool passed = true; juce::Array<juce::var> curves, timing;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        for (int mode = 0; mode < 4; ++mode) for (float db : { -30.0f, -18.0f, -6.0f })
        {
            BuiltInFETCompressor engine; engine.prepare(rate); BuiltInFETCompressor::Settings settings;
            settings.ratio = static_cast<float>(mode); settings.recovery = 0; engine.configure(settings);
            const float level = juce::Decibels::decibelsToGain(db);
            double gain = 1; for (int i = 0; i < static_cast<int>(rate * .02); ++i) gain = engine.process(level);
            constexpr double ratios[] { 4, 8, 12, 20 };
            const double expected = (db == -30 ? 0 : db == -18 ? .375 : 12) * (1 - 1 / ratios[mode]);
            const double error = std::abs(engine.gainReduction() - expected);
            const bool ok = error < .0001 && std::abs(juce::Decibels::gainToDecibels(gain) + expected) < .0001;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("ratio", ratios[mode]); item->setProperty("inputDb", db);
            item->setProperty("expectedReductionDb", expected); item->setProperty("errorDb", error); item->setProperty("pass", ok); curves.add(item); passed = passed && ok;
        }
        for (float attackMs : { .02f, .8f }) for (float releaseMs : { 50.0f, 1100.0f })
        {
            BuiltInFETCompressor engine; engine.prepare(rate); BuiltInFETCompressor::Settings settings;
            settings.attack = attackMs; settings.release = releaseMs; settings.recovery = 0; engine.configure(settings);
            const int attackSamples = juce::jmax(1, juce::roundToInt(rate * attackMs * .001));
            for (int i = 0; i < attackSamples; ++i) engine.process(juce::Decibels::decibelsToGain(-6.0f));
            const double expectedAttack = 9 * (1 - std::exp(-attackSamples / (rate * attackMs * .001)));
            const double attackError = std::abs(engine.gainReduction() - expectedAttack), start = engine.gainReduction();
            const int releaseSamples = juce::roundToInt(rate * .05);
            for (int i = 0; i < releaseSamples; ++i) engine.process(0);
            const double releaseError = std::abs(engine.gainReduction() - start * std::exp(-releaseSamples / (rate * releaseMs * .001)));
            const bool ok = attackError < .0001 && releaseError < .0001;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("attackMs", attackMs); item->setProperty("releaseMs", releaseMs);
            item->setProperty("attackErrorDb", attackError); item->setProperty("releaseErrorDb", releaseError); item->setProperty("pass", ok); timing.add(item); passed = passed && ok;
        }
    }
    BuiltInFETCompressor base, driven, trimmed, allFast, allSlow; BuiltInFETCompressor::Settings settings;
    settings.recovery = 0;
    for (auto* engine : { &base, &driven, &trimmed, &allFast, &allSlow }) engine->prepare(48000);
    base.configure(settings); settings.input = 6; driven.configure(settings); settings.output = -12; trimmed.configure(settings);
    settings = {}; settings.ratio = 4; settings.recovery = 0; allFast.configure(settings); settings.recovery = 1; allSlow.configure(settings);
    double a = 0, b = 0, c = 0;
    for (int i = 0; i < 24000; ++i) { a = base.process(.5f); b = driven.process(.5f); c = trimmed.process(.5f); allFast.process(.5f); allSlow.process(.5f); }
    const bool routing = std::abs(juce::Decibels::gainToDecibels(b / a) - 1.5) < .0001 && std::abs(juce::Decibels::gainToDecibels(c / b) + 12) < .0001
        && std::abs(driven.gainReduction() - trimmed.gainReduction()) < .0001;
    for (int i = 0; i < 4800; ++i) { allFast.process(0); allSlow.process(0); }
    const bool memory = allSlow.gainReduction() > allFast.gainReduction() + .1;
    settings = {}; settings.ratio = 5; settings.input = 6; settings.output = -3; driven.configure(settings);
    for (int i = 0; i < 1000; ++i) b = driven.process(.5f);
    const bool off = driven.gainReduction() == 0 && std::abs(juce::Decibels::gainToDecibels(b) - 3) < .0001;
    OpenStudioCompressor source(true), copy(true); source.selectModel(2);
    const bool setters = setFreePluginParamForRegression(source, "fetAttack", .02f) && setFreePluginParamForRegression(source, "fetRatio", 4)
        && setFreePluginParamForRegression(source, "fetInput", 9) && setFreePluginParamForRegression(source, "fetOutput", -7);
    source.selectModel(3); source.selectModel(2);
    juce::MemoryBlock before, after; source.getStateInformation(before); copy.setStateInformation(before.getData(), static_cast<int>(before.getSize())); copy.getStateInformation(after);
    const bool state = before == after && copy.fetInput.load() == 9 && copy.fetAttack.load() == .02f && copy.fetRatio.load() == 4;
    auto tree = juce::ValueTree::readFromData(before.getData(), before.getSize());
    for (const char* id : { "fetEngine", "fetInput", "fetOutput", "fetRatio", "fetAttack", "fetRelease", "fetRecovery" }) tree.removeProperty(id, nullptr);
    juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy.setStateInformation(old.getData(), static_cast<int>(old.getSize())); const bool migration = copy.fetEngine.load() == 0 && copy.model.load() == 2;
    // Full processor path: Ratio Off keeps input/output gain, Mix keeps aligned dry.
    bool alignment = true; double maxError = 0;
    for (float mix : { 0.0f, .5f, 1.0f })
    {
        OpenStudioCompressor processor(true); processor.selectModel(2); processor.fetRatio.store(5); processor.fetInput.store(6); processor.fetOutput.store(-3); processor.mix.store(mix);
        processor.prepareToPlay(48000, 512); juce::MidiBuffer midi; int start = 0;
        while (start < 6000)
        {
            const int count = start % 2 == 0 ? 127 : 512; juce::AudioBuffer<float> block(2, count);
            for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < count; ++i) block.setSample(ch, i, start + i == 0 ? .1f : 0);
            processor.processBlock(block, midi);
            for (int i = 0; i < count; ++i)
            {
                const double expected = start + i == processor.getLatencySamples() ? .1 * (1 - mix + mix * juce::Decibels::decibelsToGain(3.0)) : 0;
                maxError = juce::jmax(maxError, std::abs(block.getSample(0, i) - expected));
            }
            start += count;
        }
        alignment = alignment && processor.getLatencySamples() == 960;
    }
    const auto renderPartition = [](int size) {
        OpenStudioCompressor processor(true); processor.selectModel(2); processor.fetRatio.store(4); processor.fetInput.store(6); processor.fetOutput.store(-6);
        processor.prepareToPlay(48000, size); juce::AudioBuffer<float> audio(2, 9600); juce::MidiBuffer midi;
        for (int start = 0; start < audio.getNumSamples(); start += size)
        {
            const int count = juce::jmin(size, audio.getNumSamples() - start); juce::AudioBuffer<float> block(2, count);
            for (int i = 0; i < count; ++i) { const float input = static_cast<float>(.25 * std::sin(.13 * (start + i))); block.setSample(0, i, input); block.setSample(1, i, -input * .5f); }
            processor.processBlock(block, midi); for (int ch = 0; ch < 2; ++ch) audio.copyFrom(ch, start, block, ch, 0, count);
        }
        return audio;
    };
    const auto smallBlocks = renderPartition(127), largeBlocks = renderPartition(512); double partitionError = 0;
    for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < smallBlocks.getNumSamples(); ++i)
        partitionError = juce::jmax(partitionError, static_cast<double>(std::abs(smallBlocks.getSample(ch, i) - largeBlocks.getSample(ch, i))));
    passed = passed && routing && memory && off && setters && state && migration && alignment && maxError < 1e-6 && partitionError < 1e-7;
    result->setProperty("pass", passed); result->setProperty("curveCases", curves); result->setProperty("timingCases", timing);
    result->setProperty("inputOutputRouting", routing); result->setProperty("allButtonsRecoveryMemory", memory); result->setProperty("offDisablesReduction", off);
    result->setProperty("stateRoundTrip", state); result->setProperty("legacyMigration", migration); result->setProperty("alignedMixError", maxError);
    result->setProperty("partitionError", partitionError);
    result->setProperty("schema", describeFreePluginForRegression(source)); result->setProperty("audioQuality", "not_asserted"); return result;
}

juce::var checkPreampReferenceAndMeters()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Preamp digital reference and levels");
    double normalizationError=0,partitionError=0,linearError=0,meterError=0;bool finite=true,influence=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto render=[rate](float reference,float amplitude,float colour,int blockSize,float drive=0,float trim=0)
        {
            OpenStudioUtilityEffect processor(OpenStudioUtilityEffect::Kind::Preamp);processor.setControl("saturationReference",reference);processor.setControl("colour",colour);processor.setControl("drive",drive);processor.setControl("outputGain",trim);processor.prepareToPlay(rate,blockSize);
            const int length=juce::roundToInt(rate*.25);juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;float inputPeak=0;
            for(int start=0;start<length;start+=blockSize){const int count=juce::jmin(blockSize,length-start);block.setSize(2,count,false,false,true);inputPeak=0;for(int i=0;i<count;++i){const float sample=amplitude*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*997*(start+i)/rate));inputPeak=juce::jmax(inputPeak,std::abs(sample));block.setSample(0,i,sample);block.setSample(1,i,sample*.5f);}processor.processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);}
            const auto levels=processor.levelVisualization();const double inputError=std::abs(static_cast<double>(levels["inputLevelDb"])-juce::Decibels::gainToDecibels(inputPeak,-100.0f));const double outputError=std::abs(static_cast<double>(levels["outputLevelDb"])-juce::Decibels::gainToDecibels(block.getMagnitude(0,block.getNumSamples()),-100.0f));
            return std::make_tuple(std::move(output),levels,juce::jmax(inputError,outputError));
        };
        const auto [base,baseMeters,baseError]=render(0,.8f,1,127);
        for(float reference:{-24.0f,-18.0f,-6.0f})
        {
            const float gain=juce::Decibels::decibelsToGain(reference);
            const auto [scaled,meters,error]=render(reference,.8f*gain,1,127);const auto [partition,otherMeters,otherError]=render(reference,.8f*gain,1,512);
            const auto [linear,linearMeters,linearMeterError]=render(reference,.3f,0,127);const auto [linearBase,ignored,ignoredError]=render(0,.3f,0,127);
            const auto [coloured,colouredMeters,colouredError]=render(reference,.3f,1,127);double difference=0;
            juce::ignoreUnused(baseMeters,otherMeters,linearMeters,ignored,colouredMeters,linearMeterError,ignoredError,colouredError);
            meterError=juce::jmax(meterError,juce::jmax(baseError,error,otherError));
            for(int ch=0;ch<2;++ch)for(int i=0;i<scaled.getNumSamples();++i){normalizationError=juce::jmax(normalizationError,std::abs(static_cast<double>(scaled.getSample(ch,i)/gain-base.getSample(ch,i))));partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(scaled.getSample(ch,i)-partition.getSample(ch,i))));linearError=juce::jmax(linearError,std::abs(static_cast<double>(linear.getSample(ch,i)-linearBase.getSample(ch,i))));finite=finite&&std::isfinite(coloured.getSample(ch,i));difference+=std::abs(coloured.getSample(ch,i)-linear.getSample(ch,i));}
            influence=influence&&difference>1;
            const auto* input=meters["inputAverageDb"].getArray();const auto* output=meters["outputAverageDb"].getArray();finite=finite&&input&&output&&input->size()==2&&output->size()==2&&static_cast<double>((*input)[0])>static_cast<double>((*input)[1])+5.9&&std::isfinite(static_cast<double>(meters["drivenReferenceDb"]));
            if(rate==48000&&reference==-18)writeProbeWave(juce::File::getCurrentWorkingDirectory().getChildFile("output/preamp-reference-listening/reference-minus18.wav"),coloured,rate);
        }
        const auto [quiet,quietMeters,quietError]=render(-18,.00001f,1,127,6,-3);const auto [transparent,transparentMeters,transparentError]=render(-18,.00001f,0,127,6,-3);juce::ignoreUnused(quietMeters,quietError,transparentMeters,transparentError);
        for(int i=0;i<quiet.getNumSamples();++i)linearError=juce::jmax(linearError,std::abs(static_cast<double>(quiet.getSample(0,i)-transparent.getSample(0,i))));
    }
    OpenStudioUtilityEffect original(OpenStudioUtilityEffect::Kind::Preamp),restored(OpenStudioUtilityEffect::Kind::Preamp);original.setControl("saturationReference",-18);juce::MemoryBlock bytes;original.getStateInformation(bytes);restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));bool recall=restored.values[11].load()==-18;
    auto old=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());old.removeProperty("saturationReference",nullptr);juce::MemoryBlock oldBytes;{juce::MemoryOutputStream stream(oldBytes,false);old.writeToStream(stream);}restored.setStateInformation(oldBytes.getData(),static_cast<int>(oldBytes.getSize()));recall=recall&&restored.values[11].load()==0;
    restored.prepareToPlay(48000,127);const auto reset=restored.levelVisualization();const bool cleared=static_cast<float>(reset["inputLevelDb"])==-100&&static_cast<float>(reset["outputLevelDb"])==-100&&static_cast<float>(reset["drivenReferenceDb"])==-100;
    const auto schema=describeFreePluginForRegression(original);const auto* params=schema["parameters"].getArray();const bool appended=params&&params->size() >= 12&&(*params)[3]["id"].toString()=="bypass"&&(*params)[11]["id"].toString()=="saturationReference";
    result->setProperty("pass",normalizationError<2e-5&&partitionError<1e-7&&linearError<1e-7&&meterError<1e-6&&finite&&influence&&recall&&cleared&&appended);result->setProperty("normalizationError",normalizationError);result->setProperty("partitionError",partitionError);result->setProperty("linearError",linearError);result->setProperty("meterErrorDb",meterError);result->setProperty("finiteAndChannelLevels",finite);result->setProperty("referenceChangesColour",influence);result->setProperty("recallAndMigration",recall);result->setProperty("resetClearsMeters",cleared);result->setProperty("appendedParameters",appended);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkExternalDetectors()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone external detector buses");
    bool response = true, finite = true, stateRecall = true, migration = true, embedded = true;
    double auxiliaryError = 0, internalParity = 0;
    juce::Array<juce::var> cases;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        for (int kind = 0; kind < 9; ++kind)
        {
            const auto make = [&] (bool external)
            {
                std::unique_ptr<OpenStudioBuiltInEffect> processor;
                if (kind < 7)
                {
                    auto compressor = std::make_unique<OpenStudioCompressor>(true);
                    compressor->selectModel(kind);
                    compressor->threshold.store(-30); compressor->ratio.store(4);
                    compressor->fetInput.store(12);
                    processor = std::move(compressor);
                }
                else if (kind == 7)
                {
                    auto gate = std::make_unique<OpenStudioGate>(true);
                    gate->threshold.store(-30); processor = std::move(gate);
                }
                else
                {
                    auto eq = std::make_unique<OpenStudioEQ>(true);
                    for (int band = 0; band < eq->bandCount; ++band) eq->bands[band].enabled.store(0);
                    eq->bands[1].enabled.store(1); eq->bands[1].freq.store(997);
                    eq->bands[1].dynamicEnabled.store(1); eq->bands[1].dynamicThreshold.store(-30);
                    eq->bands[1].dynamicRange.store(-12); processor = std::move(eq);
                }
                processor->externalDetector.store(external ? 1.0f : 0.0f);
                processor->prepareToPlay(rate, 127);
                return processor;
            };
            auto external = make(true), missing = make(true), internal = make(false), internalWithKey = make(false);
            juce::MidiBuffer midi;
            const int duration = static_cast<int>(rate * .4);
            for (int start = 0; start < duration; start += 127)
            {
                const int count = juce::jmin(127, duration - start);
                juce::AudioBuffer<float> keyed(4, count), main(2, count), absent(2, count), neutral(4, count);
                for (int sample = 0; sample < count; ++sample)
                    for (int channel = 0; channel < 4; ++channel)
                    {
                        const float wave = static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 997 * (start + sample) / rate));
                        keyed.setSample(channel, sample, wave * (channel < 2 ? .005f : .5f));
                        neutral.setSample(channel, sample, keyed.getSample(channel, sample));
                        if (channel < 2) { main.setSample(channel, sample, wave * .005f); absent.setSample(channel, sample, wave * .005f); }
                    }
                external->processBlock(keyed, midi); missing->processBlock(absent, midi);
                internal->processBlock(main, midi); internalWithKey->processBlock(neutral, midi);
                finite = finite && ProcessorSafety::isFinite(keyed) && ProcessorSafety::isFinite(absent);
                for (int sample = 0; sample < count; ++sample)
                {
                    for (int channel = 0; channel < 2; ++channel)
                        internalParity = juce::jmax(internalParity, std::abs(static_cast<double>(main.getSample(channel, sample) - neutral.getSample(channel, sample))));
                    auxiliaryError = juce::jmax(auxiliaryError, std::abs(static_cast<double>(keyed.getSample(2, sample) - neutral.getSample(2, sample))));
                }
            }
            const float keyedReduction = kind == 8 ? dynamic_cast<OpenStudioEQ*>(external.get())->getBandDynamicGainDB(1) : external->getGainReductionDB();
            const float missingReduction = kind == 8 ? dynamic_cast<OpenStudioEQ*>(missing.get())->getBandDynamicGainDB(1) : missing->getGainReductionDB();
            const bool reacted = kind == 7 ? keyedReduction > -1 && missingReduction < -40
                : keyedReduction < -.5f && std::abs(missingReduction) < .01f;
            response = response && reacted;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("kind", kind);
            item->setProperty("keyedReductionDb", keyedReduction); item->setProperty("missingReductionDb", missingReduction); item->setProperty("pass", reacted); cases.add(item);
            juce::MemoryBlock saved; external->getStateInformation(saved);
            internal->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
            stateRecall = stateRecall && internal->externalDetector.load() == 1;
            auto legacy = juce::ValueTree::readFromData(saved.getData(), saved.getSize()); legacy.removeProperty("externalDetector", nullptr);
            juce::MemoryBlock bytes; juce::MemoryOutputStream stream(bytes, false); legacy.writeToStream(stream);
            internal->setStateInformation(bytes.getData(), static_cast<int>(bytes.getSize()));
            migration = migration && internal->externalDetector.load() == 0;
        }
    }
    OpenStudioEQ eq; OpenStudioGate gate; OpenStudioCompressor compressor;
    embedded = !eq.supportsExternalKey() && !gate.supportsExternalKey() && !compressor.supportsExternalKey();
    result->setProperty("pass", response && finite && stateRecall && migration && embedded && internalParity == 0 && auxiliaryError == 0);
    result->setProperty("cases", cases); result->setProperty("finite", finite); result->setProperty("stateRecall", stateRecall);
    result->setProperty("legacyDefaultsInternal", migration); result->setProperty("embeddedBusUnchanged", embedded);
    result->setProperty("internalMainParity", internalParity); result->setProperty("auxiliaryInputUntouched", auxiliaryError);
    result->setProperty("audioQuality", "not_asserted"); return result;
}

juce::var checkReverbLevelReadouts()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Standalone Reverb input/output sample peaks");
    double error=0;bool reset=true,embedded=true;juce::MidiBuffer midi;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        OpenStudioReverb processor(true);processor.prepareToPlay(rate,127);
        for(int type=0;type<OpenStudioReverb::standaloneTypeCount;++type)
        {
            processor.selectAlgorithm(type);juce::AudioBuffer<float> audio(2,127);audio.clear();audio.setSample(0,0,.2f);audio.setSample(1,5,-.7f);processor.processBlock(audio,midi);
            for(int channel=0;channel<2;++channel){const double input=juce::Decibels::gainToDecibels(channel==0?.2f:.7f,-100.0f),output=juce::Decibels::gainToDecibels(audio.getMagnitude(channel,0,127),-100.0f);error=juce::jmax(error,std::abs(processor.inputPeaksDb[static_cast<size_t>(channel)].load()-input),std::abs(processor.outputPeaksDb[static_cast<size_t>(channel)].load()-output));}
        }
        processor.resetTailState();reset=reset&&processor.inputPeaksDb[0].load()==-100&&processor.outputPeaksDb[1].load()==-100;
        juce::AudioBuffer<float> mono(1,127);mono.clear();mono.setSample(0,0,.25f);processor.processBlock(mono,midi);error=juce::jmax(error,static_cast<double>(std::abs(processor.inputPeaksDb[0].load()-processor.inputPeaksDb[1].load())),static_cast<double>(std::abs(processor.outputPeaksDb[0].load()-processor.outputPeaksDb[1].load())));
        OpenStudioReverb legacy;legacy.prepareToPlay(rate,127);legacy.processBlock(mono,midi);embedded=embedded&&legacy.inputPeaksDb[0].load()==-100&&legacy.outputPeaksDb[0].load()==-100;
    }
    result->setProperty("pass",error<1e-6&&reset&&embedded);result->setProperty("meterErrorDb",error);result->setProperty("types",OpenStudioReverb::standaloneTypeCount);result->setProperty("resetClears",reset);result->setProperty("embeddedMeterPathSkipped",embedded);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkEQAnalyzerResolution()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","EQ analyzer resolution and channel source");
    double levelError=0,audioError=0;bool ready=true,switches=true,reset=true,unchangedState=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int size:{1024,2048,4096,8192})
    {
        OpenStudioEQ processor;processor.prepareToPlay(rate,127);juce::MemoryBlock before;processor.getStateInformation(before);
        int offset=0;juce::MidiBuffer midi;
        const auto render=[&](int count,float leftGain,float rightGain){while(count>0){const int block=juce::jmin(127,count);juce::AudioBuffer<float> audio(2,block);for(int i=0;i<block;++i){const float tone=static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*31*(offset+i)/size));audio.setSample(0,i,leftGain*tone);audio.setSample(1,i,rightGain*tone);}juce::AudioBuffer<float> copy(audio);processor.processBlock(audio,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<block;++i)audioError=juce::jmax(audioError,static_cast<double>(std::abs(audio.getSample(ch,i)-copy.getSample(ch,i))));offset+=block;count-=block;}};
        for(int source=0;source<3;++source)
        {
            const auto pending=processor.getSpectrumData(size,source);if(source>0)switches=switches&&!pending.ready;
            render(size*2,.1f,-.05f);const auto spectrum=processor.getSpectrumData(size,source);
            const double expected=20*std::log10(source==0?.1:(source==1?.05:std::sqrt((.01+.0025)*.5)));
            ready=ready&&spectrum.ready&&spectrum.fftLength==size&&spectrum.source==source;
            levelError=juce::jmax(levelError,std::abs(spectrum.preEQ[31]-expected),std::abs(spectrum.postEQ[31]-expected));
        }
        const int nextSize=size==8192?1024:8192;switches=switches&&!processor.getSpectrumData(nextSize,2).ready;render(nextSize*3,.1f,-.1f);const auto opposite=processor.getSpectrumData(nextSize,2);ready=ready&&opposite.ready&&opposite.fftLength==nextSize;
        processor.reset();reset=reset&&!processor.getSpectrumData(nextSize,2).ready;
        const auto fallback=processor.getSpectrumData(1234,7);switches=switches&&fallback.fftLength==2048&&fallback.source==2&&!fallback.ready;
        juce::MemoryBlock after;processor.getStateInformation(after);unchangedState=unchangedState&&before==after&&processor.getLatencySamples()==0;
    }
    bool externalPass = true; double externalError = 0;
    for(double rate : {44100.0,48000.0,96000.0,192000.0}) for(int source = 0; source < 3; ++source)
    {
        auto processor = std::make_unique<OpenStudioEQ>(true); processor->setNonRealtime(true);
        if(rate == 48000)processor->setPhaseConfiguration(1,0);
        processor->prepareToPlay(rate,127); processor->getSpectrumData(2048,source);
        juce::MidiBuffer midi;
        const auto capture = [&](bool key)
        {
            for(int offset=0;offset<4096;offset+=127)
            {
                const int count=juce::jmin(127,4096-offset);juce::AudioBuffer<float> audio(key?4:2,count);
                for(int i=0;i<count;++i)
                {
                    const float main=static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*31*(offset+i)/2048));
                    audio.setSample(0,i,main);audio.setSample(1,i,-main);
                    if(key){const float aux=static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*71*(offset+i)/2048));audio.setSample(2,i,.2f*aux);audio.setSample(3,i,-.1f*aux);}
                }
                processor->processBlock(audio,midi);
            }
            return processor->getSpectrumData(2048,source);
        };
        const auto withKey=capture(true);
        const double expected=20*std::log10(source==0?.2:(source==1?.1:std::sqrt((.04+.01)*.5)));
        externalError=juce::jmax(externalError,std::abs(withKey.externalKey[71]-expected));
        externalPass=externalPass&&withKey.ready&&withKey.externalKey[31]<-80&&withKey.preEQ[71]<-80&&processor->externalDetector.load()==0;
        processor->reset();processor->getSpectrumData(2048,source);const auto absent=capture(false);
        externalPass=externalPass&&absent.ready&&absent.externalKey[71]==-100&&absent.preEQ[31]>-21;
    }
    result->setProperty("externalRawBusIsolationAndMissingSilence",externalPass);result->setProperty("externalCalibrationErrorDb",externalError);
    result->setProperty("pass",ready&&switches&&reset&&unchangedState&&externalPass&&externalError<.002&&levelError<.002&&audioError<1e-6);result->setProperty("calibrationErrorDb",levelError);result->setProperty("audioError",audioError);result->setProperty("allWindowsAndSourcesReady",ready);result->setProperty("switchInvalidationAndRequestBounds",switches);result->setProperty("resetInvalidation",reset);result->setProperty("stateAndLatencyUnchanged",unchangedState);result->setProperty("scope","Deterministic coherent tones at four rates; CPU deadline stress and real-device capture not asserted");return result;
}

juce::var checkIRBandDecayEstimate()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Convolution frequency-band decay diagnostics");
    double error=0,channelError=0;bool accepted=true,bounds=true,rejected=true,ordered=true;
    juce::var example;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const int count=juce::roundToInt(rate*3);juce::AudioBuffer<float> impulse(1,count),stereo(2,count);
        for(int band=0;band<3;++band)
        {
            const double frequency=band==0?80.0:(band==1?1200.0:12000.0),seconds=band==0?1.8:(band==1?1.2:.7);
            for(int i=0;i<count;++i){const float v=static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate)*std::exp(-std::log(1000.0)*i/(rate*seconds)));impulse.setSample(0,i,v);stereo.setSample(0,i,v);stereo.setSample(1,i,-v);}
            const auto mono=BuiltInIRDecay::analyzeBands(impulse,rate,.08,250,4000),pair=BuiltInIRDecay::analyzeBands(stereo,rate,.08,250,4000);
            const auto index=static_cast<size_t>(band);accepted=accepted&&mono.bands[index].available&&pair.bands[index].available;
            error=juce::jmax(error,std::abs(mono.bands[index].rt60/seconds-1));channelError=juce::jmax(channelError,std::abs(mono.bands[index].rt60-pair.bands[index].rt60));
            bounds=bounds&&mono.bands[0].lowHz==0&&mono.bands[0].highHz==250&&mono.bands[1].highHz==4000&&mono.bands[2].highHz==rate*.5;
        }
        for(int i=0;i<count;++i){double value=0;for(int band=0;band<3;++band){const double frequency=band==0?80.0:(band==1?1200.0:12000.0),seconds=band==0?1.8:(band==1?1.2:.7);value+=.25*std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate)*std::exp(-std::log(1000.0)*i/(rate*seconds));}impulse.setSample(0,i,static_cast<float>(value));}
        const auto mixed=BuiltInIRDecay::analyzeBands(impulse,rate,.08,250,4000);
        for(const auto& band:mixed.bands)ordered=ordered&&band.available;
        ordered=ordered&&mixed.bands[0].rt60>mixed.bands[1].rt60&&mixed.bands[1].rt60>mixed.bands[2].rt60;
        if(rate==48000)example=mixed.toVar();
        impulse.clear();const auto silent=BuiltInIRDecay::analyzeBands(impulse,rate,.08,250,4000);for(const auto& band:silent.bands)rejected=rejected&&!band.available;
        for(int i=0;i<count;++i)impulse.setSample(0,i,.1f);
        const auto constant=BuiltInIRDecay::analyzeBands(impulse,rate,.08,250,4000);
        rejected=rejected&&!constant.bands[0].available;
    }
    juce::AudioBuffer<float> lowRate(1,1600);lowRate.clear();const auto clamped=BuiltInIRDecay::analyzeBands(lowRate,8000,.08,2000,16000);bounds=bounds&&clamped.bands[0].highHz==1800&&clamped.bands[1].highHz==3600&&clamped.bands[2].highHz==4000;
    result->setProperty("pass",accepted&&error<.01&&channelError<1e-8&&bounds&&rejected&&ordered);result->setProperty("isolatedToneRelativeError",error);result->setProperty("opposedChannelErrorSeconds",channelError);result->setProperty("allToneFits",accepted);result->setProperty("mixedTailOrdering",ordered);result->setProperty("sourceRateBounds",bounds);result->setProperty("invalidTailRejection",rejected);result->setProperty("example",example);result->setProperty("acousticAccuracy","diagnostic_only");result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkIRDecayEstimate()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Convolution diagnostic decay estimate");
    double relativeError=0,channelError=0;bool accepted=true,rejected=true;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(double seconds:{.3,1.0,3.0})
    {
        const int count=juce::roundToInt(rate*seconds*1.5);juce::AudioBuffer<float> impulse(1,count),matrix(4,count);
        for(int i=0;i<count;++i){const float value=static_cast<float>(std::exp(-std::log(10.0)*3*i/(rate*seconds)));impulse.setSample(0,i,value);for(int ch=0;ch<4;++ch)matrix.setSample(ch,i,value*(ch%2==0?1.0f:-.5f));}
        const auto mono=BuiltInIRDecay::analyze(impulse,rate,0),stereo=BuiltInIRDecay::analyze(matrix,rate,0);
        accepted=accepted&&mono.available&&stereo.available;relativeError=juce::jmax(relativeError,std::abs(mono.rt60/seconds-1));channelError=juce::jmax(channelError,std::abs(mono.rt60-stereo.rt60));
        juce::AudioBuffer<float> shortTail(1,juce::roundToInt(rate*.2));for(int i=0;i<shortTail.getNumSamples();++i)shortTail.setSample(0,i,static_cast<float>(std::exp(-std::log(10.0)*3*i/(rate*3))));rejected=rejected&&!BuiltInIRDecay::analyze(shortTail,rate,0).available;
        shortTail.clear();rejected=rejected&&!BuiltInIRDecay::analyze(shortTail,rate,0).available;
        for(int i=0;i<shortTail.getNumSamples();++i)shortTail.setSample(0,i,.1f);
        rejected=rejected&&!BuiltInIRDecay::analyze(shortTail,rate,0).available;
        shortTail.setSample(0,10,std::numeric_limits<float>::quiet_NaN());rejected=rejected&&!BuiltInIRDecay::analyze(shortTail,rate,0).available;
    }
    const double rate=48000;juce::AudioBuffer<float> impulse(2,96000);for(int i=0;i<impulse.getNumSamples();++i){const float v=static_cast<float>(.2*std::sin(juce::MathConstants<double>::twoPi*997*i/rate)*std::exp(-std::log(10.0)*3*i/rate));impulse.setSample(0,i,v);impulse.setSample(1,i,-v);}
    const auto file=juce::File::getCurrentWorkingDirectory().getChildFile("output/ir-decay-estimate.wav");writeProbeWave(file,impulse,rate);BuiltInConvolution convolution;bool integration=convolution.loadFile(file);auto initial=convolution.info()["decayEstimate"];integration=integration&&static_cast<bool>(initial["available"]);const double before=static_cast<double>(initial["rt60Seconds"]);
    auto* edit=new juce::DynamicObject();edit->setProperty("size",2.0);integration=integration&&convolution.edit(juce::var(edit));const auto doubled=convolution.info()["decayEstimate"];integration=integration&&static_cast<bool>(doubled["available"])&&std::abs(static_cast<double>(doubled["rt60Seconds"])/before-2)<.005;
    edit=new juce::DynamicObject();edit->setProperty("eq1Gain",6.0);integration=integration&&convolution.edit(juce::var(edit))&&juce::JSON::toString(convolution.info()["decayEstimate"])==juce::JSON::toString(doubled);
    edit=new juce::DynamicObject();edit->setProperty("size",1.0);edit->setProperty("end",.2);integration=integration&&convolution.edit(juce::var(edit))&&!static_cast<bool>(convolution.info()["decayEstimate"]["available"]);
    result->setProperty("pass",accepted&&rejected&&integration&&relativeError<.001&&channelError<1e-10);result->setProperty("exponentialRelativeError",relativeError);result->setProperty("channelEnergyErrorSeconds",channelError);result->setProperty("exponentialFits",accepted);result->setProperty("invalidShortNoisyTruncatedRejected",rejected);result->setProperty("shapeUpdatesAndEqReuse",integration);result->setProperty("example",initial);result->setProperty("acousticAccuracy","diagnostic_only");result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkPreampTone()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Preamp stepped tone section");
    bool passed = true; juce::Array<juce::var> cases;
    for (double hostRate : { 44100.0, 48000.0, 96000.0, 192000.0 }) for (int mode = 0; mode < 6; ++mode)
    {
        const double rate = hostRate * 4; BuiltInPreampTone tone; tone.prepare(rate); BuiltInPreampTone::Settings settings;
        settings.enabled = 1; double frequency = 1000, expected = 0;
        if (mode == 0) { settings.lowFrequency = 3; settings.lowGain = 12; frequency = 110; expected = 6; }
        if (mode == 1) { settings.midFrequency = 3; settings.midGain = -12; frequency = 1600; expected = -12; }
        if (mode == 2) { settings.highGain = 12; frequency = 12000; expected = 6; }
        if (mode == 3) { settings.highPass = 2; frequency = 80; expected = -3.01029995664; }
        if (mode == 4) { settings.highPass = 2; frequency = 40; expected = -10 * std::log10(1 + std::pow(std::tan(juce::MathConstants<double>::pi * 80 / rate) / std::tan(juce::MathConstants<double>::pi * 40 / rate), 6)); }
        if (mode == 5) { settings.enabled = 0; settings.lowGain = 16; settings.midGain = 18; settings.highGain = -16; settings.highPass = 4; }
        tone.configure(settings); double inputEnergy = 0, outputEnergy = 0, bypassError = 0; bool stereo = true;
        for (int i = 0; i < static_cast<int>(rate); ++i)
        {
            const float input = static_cast<float>(.1 * std::sin(juce::MathConstants<double>::twoPi * frequency * i / rate));
            const auto output = tone.process(input, -input);
            if (i > rate * .5) { inputEnergy += input * input; outputEnergy += output[0] * output[0]; }
            stereo = stereo && output[0] == -output[1];
            if (mode == 5) bypassError = juce::jmax(bypassError, static_cast<double>(std::abs(output[0] - input)));
        }
        const double measured = 10 * std::log10(outputEnergy / inputEnergy);
        const bool ok = std::abs(measured - expected) < .025 && stereo && bypassError == 0;
        auto* item = new juce::DynamicObject(); item->setProperty("hostRate", hostRate); item->setProperty("mode", mode);
        item->setProperty("expectedDb", expected); item->setProperty("measuredDb", measured); item->setProperty("bypassError", bypassError); item->setProperty("pass", ok);
        cases.add(item); passed = passed && ok;
    }
    OpenStudioUtilityEffect source(OpenStudioUtilityEffect::Kind::Preamp), copy(OpenStudioUtilityEffect::Kind::Preamp);
    bool setter = source.setControl("toneEnabled", 1) && source.setControl("toneLowFrequency", 4) && source.setControl("toneMidFrequency", 6)
        && source.setControl("toneLowGain", 9) && source.setControl("toneMidGain", -8) && source.setControl("toneHighGain", 7) && source.setControl("toneHighPass", 3);
    juce::MemoryBlock before, after; source.getStateInformation(before); copy.setStateInformation(before.getData(), static_cast<int>(before.getSize())); copy.getStateInformation(after);
    const bool roundTrip = before == after;
    auto tree = juce::ValueTree::readFromData(before.getData(), before.getSize());
    for (const auto& control : source.controls) if (juce::String(control.id).startsWith("tone")) tree.removeProperty(control.id, nullptr);
    juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy.setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    bool defaults = true; for (size_t i = 4; i < copy.controls.size(); ++i) defaults = defaults && copy.values[i].load() == copy.controls[i].initial;
    OpenStudioUtilityEffect dry(OpenStudioUtilityEffect::Kind::Preamp), wet(OpenStudioUtilityEffect::Kind::Preamp);
    dry.setControl("colour", 0); wet.setControl("colour", 0); wet.setControl("toneEnabled", 1); wet.setControl("toneMidGain", 6);
    dry.prepareToPlay(48000, 512); wet.prepareToPlay(48000, 512);
    double dryEnergy = 0, wetEnergy = 0; juce::MidiBuffer midi;
    for (int start = 0; start < 48000;)
    {
        const int count = juce::jmin(start % 2 == 0 ? 127 : 512, 48000 - start);
        juce::AudioBuffer<float> a(2, count), b(2, count);
        for (int i = 0; i < count; ++i) for (int ch = 0; ch < 2; ++ch) a.setSample(ch, i, static_cast<float>(.05 * std::sin(juce::MathConstants<double>::twoPi * 1600 * (start + i) / 48000)));
        b.makeCopyOf(a); dry.processBlock(a, midi); wet.processBlock(b, midi);
        if (start > 24000) for (int i = 0; i < count; ++i) { dryEnergy += std::pow(a.getSample(0, i), 2); wetEnergy += std::pow(b.getSample(0, i), 2); }
        start += count;
    }
    const double integratedDb = 10 * std::log10(wetEnergy / dryEnergy);
    const bool integrated = std::abs(integratedDb - 6) < .025 && dry.getLatencySamples() == wet.getLatencySamples();
    result->setProperty("pass", passed && setter && roundTrip && defaults && integrated); result->setProperty("cases", cases);
    result->setProperty("integratedGainDb", integratedDb); result->setProperty("integratedGainAndLatency", integrated);
    result->setProperty("setters", setter); result->setProperty("stateRoundTrip", roundTrip); result->setProperty("oldDefaults", defaults);
    result->setProperty("schema", describeFreePluginForRegression(source)); result->setProperty("audioQuality", "not_asserted");
    return result;
}

juce::var checkVintageBassDecay()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Vintage frequency dependent decay");
    double responseError = 0, neutralError = 0, partitionError = 0; bool finite = true, decayOrder = true;
    juce::Array<juce::var> tails;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        for (double crossover : {500.0, 5000.0}) for (double frequency : {40.0, 400.0, 4000.0, 16000.0})
        {
            const double g = std::tan(juce::MathConstants<double>::pi * crossover / rate);
            const float coefficient = static_cast<float>(g / (1 + g));
            BuiltInVintageReverb::DecayShelf shelf, neutral;
            const int count = juce::roundToInt(rate * .25); double inputEnergy = 0, outputEnergy = 0;
            for (int i = 0; i < count * 2; ++i)
            {
                const float input = static_cast<float>(.1 * std::sin(juce::MathConstants<double>::twoPi * frequency * i / rate));
                const float output = shelf.process(input, .7f, .92f, coefficient);
                neutralError = juce::jmax(neutralError, std::abs(static_cast<double>(neutral.process(input, .7f, .7f, coefficient) - input * .7f)));
                if (i >= count) { inputEnergy += input * input; outputEnergy += output * output; }
            }
            const std::complex<double> z = std::exp(std::complex<double>(0, -juce::MathConstants<double>::twoPi * frequency / rate));
            const auto low = static_cast<double>(coefficient) * (1.0 + z) / (1.0 + (2.0 * coefficient - 1.0) * z);
            const double expected = std::abs(static_cast<double>(.7f) + static_cast<double>(.92f - .7f) * low);
            responseError = juce::jmax(responseError, std::abs(10 * std::log10(outputEnergy / inputEnergy) - 20 * std::log10(expected)));
        }
        for (int type = 0; type < 2; ++type)
        {
            std::array<double, 3> energy {};
            const auto render = [&](float ratio, int block)
            {
                BuiltInVintageReverb engine; engine.prepare(rate, type); BuiltInVintageReverb::Settings settings;
                settings.decay = .5f; settings.bassRatio = ratio; settings.bassFrequency = 1000; settings.damping = 0; settings.modulation = 0; settings.colour = 2;
                std::vector<float> audio(static_cast<size_t>(juce::roundToInt(rate * 1.5)));
                for (size_t i = 0; i < audio.size(); ++i)
                {
                    if (i % static_cast<size_t>(block) == 0) engine.configure(type, settings);
                    const double time = static_cast<double>(i) / rate;
                    const float input = time < .2 ? static_cast<float>(.1 * std::sin(juce::MathConstants<double>::twoPi * 80 * time) * std::pow(std::sin(juce::MathConstants<double>::pi * time / .2), 2)) : 0;
                    audio[i] = engine.process(input, input)[0]; finite = finite && std::isfinite(audio[i]) && std::abs(audio[i]) < 2;
                }
                return audio;
            };
            for (size_t ratio = 0; ratio < 3; ++ratio)
            {
                const auto audio = render(std::array<float,3>{.25f,1,4}[ratio], 127);
                for (size_t i = static_cast<size_t>(rate); i < audio.size(); ++i) energy[ratio] += audio[i] * audio[i];
                if (ratio == 2)
                {
                    const auto other = render(4, 512);
                    for (size_t i = 0; i < audio.size(); ++i) partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(audio[i] - other[i])));
                }
            }
            decayOrder = decayOrder && energy[1] > energy[0] && energy[2] > energy[1];
            auto* item = new juce::DynamicObject(); item->setProperty("rate",rate); item->setProperty("type",type); item->setProperty("short",energy[0]); item->setProperty("neutral",energy[1]); item->setProperty("long",energy[2]); tails.add(item);
        }
    }
    OpenStudioReverb original(true), restored(true); original.selectAlgorithm(10);
    bool state = setFreePluginParamForRegression(original,"vintageBassRatio",3) && setFreePluginParamForRegression(original,"vintageBassFrequency",800);
    original.selectAlgorithm(11); state = state && setFreePluginParamForRegression(original,"vintageBassRatio",.5f) && setFreePluginParamForRegression(original,"vintageBassFrequency",1500);
    juce::MemoryBlock bytes; original.getStateInformation(bytes); restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));
    state = state && restored.vintageBassRatio[0].load()==3 && restored.vintageBassRatio[1].load()==.5f && restored.vintageBassFrequency[0].load()==800 && restored.vintageBassFrequency[1].load()==1500;
    auto old = juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());
    for (int bank=0;bank<2;++bank) for(const char* key:{"BassRatio","BassFrequency"}) old.removeProperty("vintage"+juce::String(bank)+key,nullptr);
    bytes.reset(); {juce::MemoryOutputStream stream(bytes,false);old.writeToStream(stream);} restored.setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));
    bool migration=true;for(size_t bank=0;bank<2;++bank)migration=migration&&restored.vintageBassRatio[bank].load()==1&&restored.vintageBassFrequency[bank].load()==500;
    original.selectAlgorithm(10);original.wetLevel.store(1);original.decayTime.store(2);const bool tail=original.getTailLengthSeconds()>=14;
    const auto schema=describeFreePluginForRegression(original);const auto* parameters=schema["parameters"].getArray();const bool prefix=parameters&&parameters->size()>=486&&(*parameters)[480]["id"].toString()=="vintageBassRatio";
    result->setProperty("pass",responseError<.002&&neutralError==0&&partitionError==0&&finite&&decayOrder&&state&&migration&&tail&&prefix);
    result->setProperty("responseErrorDb",responseError);result->setProperty("neutralError",neutralError);result->setProperty("partitionError",partitionError);result->setProperty("finite",finite);result->setProperty("decayOrder",decayOrder);result->setProperty("tails",tails);result->setProperty("stateRecall",state);result->setProperty("migration",migration);result->setProperty("tailReported",tail);result->setProperty("prefix",prefix);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkVintageSpaces()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Original vintage hall and random spaces");
    bool passed = true; juce::Array<juce::var> cases;
    const auto render = [](double rate, int type, BuiltInVintageReverb::Settings settings, int block, bool anti = false) {
        BuiltInVintageReverb engine; engine.prepare(rate, type);
        juce::AudioBuffer<float> audio(2, static_cast<int>(rate));
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            if (i % block == 0) engine.configure(type, settings);
            const auto value = engine.process(i == 0 ? .5f : 0, i == 0 ? (anti ? -.5f : .5f) : 0);
            for (int ch = 0; ch < 2; ++ch) audio.setSample(ch, i, value[static_cast<size_t>(ch)]);
        }
        return audio;
    };
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 }) for (int type = 0; type < 2; ++type) for (int colour = 0; colour < 3; ++colour)
    {
        BuiltInVintageReverb::Settings settings; settings.colour = static_cast<float>(colour);
        const auto audio = render(rate, type, settings, 127, true);
        double energy = 0, peak = 0; bool finite = true;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            const double value = audio.getSample(ch, i); finite = finite && std::isfinite(value); energy += value * value; peak = juce::jmax(peak, std::abs(value));
        }
        const bool ok = finite && energy > 1e-7 && peak < 1;
        auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("type", type); item->setProperty("colour", colour);
        item->setProperty("energy", energy); item->setProperty("peak", peak); item->setProperty("pass", ok); cases.add(item); passed = passed && ok;
    }
    juce::Array<juce::var> behaviors;
    for (int type = 0; type < 2; ++type)
    {
        BuiltInVintageReverb::Settings settings; settings.colour = 2; settings.modulation = 0;
        const auto reference = render(48000, type, settings, 512), partition = render(48000, type, settings, 127);
        settings.preDelay = 100; const auto delayed = render(48000, type, settings, 127);
        settings.preDelay = 0; settings.width = 0; const auto mono = render(48000, type, settings, 127);
        settings.width = 1; settings.modulation = 1; const auto moving = render(48000, type, settings, 127);
        settings.modulation = 0; settings.decay = .1f; const auto shortTail = render(48000, type, settings, 127);
        double partitionError = 0, predelayError = 0, motionDifference = 0, longEnergy = 0, shortEnergy = 0; bool monoPass = true;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 48000; ++i)
        {
            const double sample = reference.getSample(ch, i);
            partitionError = juce::jmax(partitionError, std::abs(sample - partition.getSample(ch, i)));
            predelayError = juce::jmax(predelayError, std::abs(static_cast<double>(delayed.getSample(ch, i)) - (i < 4800 ? 0 : reference.getSample(ch, i - 4800))));
            motionDifference += std::abs(sample - moving.getSample(ch, i)); monoPass = monoPass && mono.getSample(0, i) == mono.getSample(1, i);
            if (i > 24000) { longEnergy += sample * sample; shortEnergy += std::pow(shortTail.getSample(ch, i), 2); }
        }
        BuiltInVintageReverb sleeping; sleeping.prepare(48000, type); sleeping.configure(type, settings);
        for (int i = 0; i < 1000; ++i) sleeping.process(.2f, -.2f);
        bool scheduler = sleeping.processingFrames(static_cast<size_t>(1 - type)) == 0;
        sleeping.configure(-1, settings);
        for (int i = 0; i < 144000; ++i) sleeping.process(.2f, -.2f);
        const auto frames = sleeping.processingFrames(static_cast<size_t>(type));
        for (int i = 0; i < 1000; ++i) sleeping.process(.2f, -.2f);
        scheduler = scheduler && sleeping.processingFrames(static_cast<size_t>(type)) == frames;
        sleeping.configure(type, settings); bool wakeSilent = true;
        for (int i = 0; i < 48000; ++i) { const auto value = sleeping.process(0, 0); wakeSilent = wakeSilent && value[0] == 0 && value[1] == 0; }
        const bool ok = partitionError == 0 && predelayError < 1e-7 && monoPass && motionDifference > .01 && longEnergy > shortEnergy * 10 && scheduler && wakeSilent;
        auto* item = new juce::DynamicObject(); item->setProperty("type", type); item->setProperty("pass", ok);
        item->setProperty("partitionError", partitionError); item->setProperty("predelayError", predelayError); item->setProperty("mono", monoPass);
        item->setProperty("motionDifference", motionDifference); item->setProperty("longTailEnergy", longEnergy); item->setProperty("shortTailEnergy", shortEnergy);
        item->setProperty("dormancy", scheduler); item->setProperty("wakeSilent", wakeSilent); behaviors.add(item); passed = passed && ok;
    }
    OpenStudioReverb source(true), copy(true); source.selectAlgorithm(10);
    bool setters = setFreePluginParamForRegression(source, "vintageColour", 2) && setFreePluginParamForRegression(source, "vintageRate", .7f);
    source.decayTime.store(4); source.selectAlgorithm(11); source.decayTime.store(7);
    setters = setters && setFreePluginParamForRegression(source, "vintageModulation", .8f);
    juce::MemoryBlock before, after; source.getStateInformation(before); copy.setStateInformation(before.getData(), static_cast<int>(before.getSize())); copy.getStateInformation(after);
    bool state = before == after && copy.algorithm.load() == 11 && copy.vintageModulation[1].load() == .8f;
    copy.selectAlgorithm(10); state = state && copy.decayTime.load() == 4 && copy.vintageColour[0].load() == 2 && copy.vintageRate[0].load() == .7f;
    auto tree = juce::ValueTree::readFromData(before.getData(), before.getSize()); tree.setProperty("algorithm", 1, nullptr);
    for (int slot = 0; slot < 2; ++slot) for (const char* id : { "Colour", "Modulation", "Rate" }) tree.removeProperty("vintage" + juce::String(slot) + id, nullptr);
    juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
    copy.setStateInformation(old.getData(), static_cast<int>(old.getSize()));
    const bool defaults = copy.algorithm.load() == 1 && copy.vintageColour[0].load() == 0 && copy.vintageRate[0].load() == .3f && copy.vintageModulation[1].load() == .35f;
    result->setProperty("pass", passed && setters && state && defaults); result->setProperty("cases", cases); result->setProperty("behaviors", behaviors);
    result->setProperty("setters", setters); result->setProperty("stateRoundTrip", state); result->setProperty("oldDefaults", defaults);
    result->setProperty("schema", describeFreePluginForRegression(source)); result->setProperty("audioQuality", "not_asserted");
    return result;
}

juce::var checkStudioSpaces()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Dedicated Room Hall Chamber Church Ambience");
    bool passed = true; juce::Array<juce::var> cases;
    const auto render = [](double rate, int type, BuiltInStudioReverb::Settings settings, int block, double seconds, bool antiPhase = false)
    {
        BuiltInStudioReverb engine; engine.prepare(rate,type);
        juce::AudioBuffer<float> audio(2,static_cast<int>(rate*seconds));
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            if (i%block == 0) engine.configure(type,settings);
            const auto sample = engine.process(i==0 ? .5f : 0, i==0 ? (antiPhase ? -.5f : .5f) : 0);
            for (int ch=0; ch<2; ++ch) audio.setSample(ch,i,sample[static_cast<size_t>(ch)]);
        }
        return audio;
    };
    // Schroeder backwards integration; fit -5 to -35 dB, extrapolate T60.
    const auto decay = [](const juce::AudioBuffer<float>& audio, double rate)
    {
        std::vector<double> energy(static_cast<size_t>(audio.getNumSamples())); double sum = 0;
        for (int i = audio.getNumSamples(); --i >= 0;)
        {
            for (int ch = 0; ch < 2; ++ch) sum += std::pow(audio.getSample(ch, i), 2);
            energy[static_cast<size_t>(i)] = sum;
        }
        double count = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (size_t i = 0; i < energy.size(); ++i)
        {
            const double db = 10 * std::log10(juce::jmax(1e-30, energy[i] / juce::jmax(sum, 1e-30)));
            if (db > -5 || db < -35) continue;
            const double time = static_cast<double>(i) / rate;
            ++count; sx += time; sy += db; sxx += time * time; sxy += time * db;
        }
        return count > 10 ? -60.0 * (count * sxx - sx * sx) / (count * sxy - sx * sy) : 0.0;
    };
    for (double rate : {44100.0,48000.0,96000.0,192000.0}) for (int type=0; type<5; ++type) for (float size : {0.0f,1.0f})
    {
        BuiltInStudioReverb::Settings settings; settings.damping=0; settings.modulation=0; settings.early=0; settings.size=size;
        const auto audio=render(rate,type,settings,127,4); const double measured=decay(audio,rate);
        const bool ok=std::isfinite(measured)&&std::abs(measured-2)<.1;
        auto* item=new juce::DynamicObject(); item->setProperty("rate",rate); item->setProperty("type",type); item->setProperty("size",size);
        item->setProperty("measuredT60",measured); item->setProperty("targetT60",2); item->setProperty("pass",ok); cases.add(item); passed=passed&&ok;
    }
    juce::Array<juce::var> behaviors;
    for (int type=0; type<5; ++type)
    {
        BuiltInStudioReverb::Settings settings; settings.modulation=0;
        const auto reference=render(48000,type,settings,512,1);
        const auto sampleBlocks=render(48000,type,settings,1,1);
        settings.preDelay=100; const auto delayed=render(48000,type,settings,127,1);
        settings.preDelay=0; settings.width=0; const auto mono=render(48000,type,settings,127,1);
        settings.width=1; const auto anti=render(48000,type,settings,127,1,true);
        double partitionError=0,predelayError=0,antiEnergy=0; bool monoPass=true;
        for (int ch=0;ch<2;++ch) for (int i=0;i<48000;++i)
        {
            partitionError=juce::jmax(partitionError,static_cast<double>(std::abs(reference.getSample(ch,i)-sampleBlocks.getSample(ch,i))));
            predelayError=juce::jmax(predelayError,std::abs(static_cast<double>(delayed.getSample(ch,i))-(i<4800 ? 0 : reference.getSample(ch,i-4800))));
            antiEnergy+=anti.getSample(ch,i)*anti.getSample(ch,i); monoPass=monoPass&&mono.getSample(0,i)==mono.getSample(1,i);
        }
        settings.modulation=1; const auto moving=render(48000,type,settings,127,1); double modulationDifference=0;
        settings.modulation=0; settings.early=0; const auto lateOnly=render(48000,type,settings,127,1); double earlyDifference=0;
        settings.damping=0; settings.bassRatio=.5f; const double shortBass=decay(render(48000,type,settings,127,6),48000);
        settings.bassRatio=2; const double longBass=decay(render(48000,type,settings,127,8),48000);
        for (int i=0;i<48000;++i) { modulationDifference+=std::abs(reference.getSample(0,i)-moving.getSample(0,i)); earlyDifference+=std::abs(reference.getSample(0,i)-lateOnly.getSample(0,i)); }
        BuiltInStudioReverb a,b; a.prepare(48000,type); b.prepare(48000,type); settings={}; settings.modulation=0;
        a.configure(type,settings); b.configure(type,settings); double freezeError=0,heldEnergy=0;
        for (int i=0;i<144000;++i)
        {
            if (i==24000) {settings.freeze=true; a.configure(type,settings); b.configure(type,settings);}
            const auto x=a.process(i==0 ? .5f : 0,0), y=b.process(i==0 ? .5f : (i>30000 ? .2f : 0),0);
            if (i>48000) {freezeError=juce::jmax(freezeError,static_cast<double>(std::abs(x[0]-y[0]))); heldEnergy+=x[0]*x[0];}
        }
        const bool ok=partitionError<1e-7&&predelayError<1e-7&&monoPass&&antiEnergy>1e-6&&modulationDifference>.01&&earlyDifference>.001
            &&longBass>shortBass+.1&&freezeError==0&&heldEnergy>1e-7;
        auto* item=new juce::DynamicObject();item->setProperty("type",type);item->setProperty("pass",ok);item->setProperty("partitionError",partitionError);
        item->setProperty("predelayError",predelayError);item->setProperty("monoWidth",monoPass);item->setProperty("antiphaseWetEnergy",antiEnergy);
        item->setProperty("modulationDifference",modulationDifference);item->setProperty("earlyDifference",earlyDifference);
        item->setProperty("shortBassBroadbandT60",shortBass);item->setProperty("longBassBroadbandT60",longBass);
        item->setProperty("freezeError",freezeError);item->setProperty("heldEnergy",heldEnergy);behaviors.add(item);passed=passed&&ok;
    }
    OpenStudioReverb source(true); source.studioModulation[0].store(.2f);source.studioModulation[1].store(.7f);source.studioModulation[2].store(.4f);
    source.studioBassRatio[1].store(1.5f);source.studioEngines[2].store(0);
    juce::MemoryBlock state,recalled;source.getStateInformation(state);OpenStudioReverb copy(true);
    copy.setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy.getStateInformation(recalled);
    const bool roundTrip=state==recalled&&copy.studioModulation[1].load()==.7f&&copy.studioEngines[2].load()==0;
    bool legacyPass=true; double legacyError=0;
    for (int type : {0,1,3})
    {
        source.selectAlgorithm(type);source.getStateInformation(state);
        auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());
        for (int index=0;index<3;++index) for (const char* name : {"Engine","Modulation","BassRatio"}) tree.removeProperty("studio"+juce::String(index)+name,nullptr);
        juce::MemoryBlock legacy;{juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);}
        copy.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));
        OpenStudioReverb old(false);old.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));
        copy.prepareToPlay(48000,127);old.prepareToPlay(48000,127);juce::AudioBuffer<float> a(2,127),b(2,127);juce::MidiBuffer midi;
        for (int start=0;start<24000;start+=127)
        {
            a.clear();if(start==0){a.setSample(0,0,.3f);a.setSample(1,0,.3f);}b.makeCopyOf(a);copy.processBlock(a,midi);old.processBlock(b,midi);
            for (int ch=0;ch<2;++ch)for(int i=0;i<127;++i)legacyError=juce::jmax(legacyError,static_cast<double>(std::abs(a.getSample(ch,i)-b.getSample(ch,i))));
        }
        legacyPass=legacyPass&&copy.studioEngines[copy.studioSlot()].load()==0;
    }
    legacyPass=legacyPass&&legacyError==0;passed=passed&&roundTrip&&legacyPass;
    result->setProperty("pass",passed);result->setProperty("decayCases",cases);result->setProperty("behaviorCases",behaviors);
    result->setProperty("stateRoundTrip",roundTrip);result->setProperty("legacyRecallParity",legacyPass);result->setProperty("legacyError",legacyError);
    result->setProperty("scope","Original orthogonal FDNs; 40 undamped/unmodulated late-only T60 cases within 5%; no commercial or measured-room equivalence");
    return result;
}

juce::var checkReverbWorkflow()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Reverb tempo predelay and wet ducking");
    bool passed=true;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInReverbWorkflow workflow;workflow.prepare(rate);workflow.configure(true,125,0,-24,250);
        const double target=rate*.125;double sum=0,centroid=0;
        for(int i=0;i<static_cast<int>(rate*.2);++i)
        {
            const auto value=workflow.process(i==0?1.0f:0.0f,0,0);sum+=value[0];centroid+=i*static_cast<double>(value[0]);
        }
        const bool ok=std::abs(sum-1)<1e-6&&std::abs(centroid/juce::jmax(sum,1e-9)-target)<.01;
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("centroidSamples",centroid/sum);item->setProperty("pass",ok);cases.add(item);passed=passed&&ok;
    }
    bool tempoPass=true;
    for(int division=0;division<9;++division) for(float bpm:{10.0f,60.0f,120.0f,300.0f})
        tempoPass=tempoPass&&std::abs(BuiltInReverbWorkflow::milliseconds(bpm,static_cast<float>(division))*bpm/60000-BuiltInReverbWorkflow::beats[static_cast<size_t>(division)])<1e-6;
    BuiltInReverbWorkflow ducker;ducker.prepare(48000);ducker.configure(false,0,18,-30,250);
    std::array<float,2> ducked {};
    for(int i=0;i<48000;++i)ducked=ducker.process(.2f,-.2f,.5f);
    const float reduction=ducker.gainReductionDb();
    const bool duckPass=std::abs(reduction-18)<.01&&std::abs(ducked[0]/.2f-juce::Decibels::decibelsToGain(-18.0f))<1e-5&&ducked[0]==-ducked[1];
    for(int i=0;i<144000;++i)ducker.process(0,0,0);
    const bool recovery=ducker.gainReductionDb()<.01;
    ducker.configure(true,125,0,-24,250);
    for(int i=0;i<12000;++i)ducker.process(.2f,.2f,0);
    ducker.reset();ducker.configure(true,125,0,-24,250);
    bool resetSilent=true;
    for(int i=0;i<12000;++i){const auto sample=ducker.process(0,0,0);resetSilent=resetSilent&&sample[0]==0&&sample[1]==0;}
    bool dryPass=true,statePass=true,oldDefaults=true;
    for(int type=0;type<OpenStudioReverb::standaloneTypeCount;++type)
    {
        OpenStudioReverb processor(true);processor.selectAlgorithm(type);processor.predelaySync.store(1);processor.predelayDivision.store(8);
        processor.wetDuckDepth.store(18);processor.wetDuckThreshold.store(-30);processor.wetDuckRelease.store(400);
        processor.wetLevel.store(0);processor.earlyLevel.store(0);processor.dryLevel.store(.7f);processor.prepareToPlay(48000,127);
        juce::AudioBuffer<float> audio(2,127);juce::MidiBuffer midi;
        for(int block=0;block<30;++block)
        {
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)audio.setSample(ch,i,ch==0?.25f:-.25f);
            processor.processBlock(audio,midi);
            // Positioned room intentionally attenuates/pans direct sound before wet-only ducking.
            const double expected=.175*(type==16?1/(1+.15*.4*std::sqrt(9.3+83.6*.5)):1);
            for(int i=0;i<127;++i)dryPass=dryPass&&std::abs(audio.getSample(0,i)-expected)<1e-6&&std::abs(audio.getSample(1,i)+expected)<1e-6;
        }
        juce::MemoryBlock before,after;processor.getStateInformation(before);OpenStudioReverb restored(true);
        restored.setStateInformation(before.getData(),static_cast<int>(before.getSize()));restored.getStateInformation(after);statePass=statePass&&before==after;
        auto tree=juce::ValueTree::readFromData(before.getData(),before.getSize());
        for(const char* id:{"predelaySync","predelayDivision","wetDuckDepth","wetDuckThreshold","wetDuckRelease"})tree.removeProperty(id,nullptr);
        juce::MemoryBlock old;{juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);}
        restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));oldDefaults=oldDefaults&&restored.predelaySync.load()==0&&restored.wetDuckDepth.load()==0;
        if(type>=8)oldDefaults=oldDefaults&&restored.studioEngines[restored.studioSlot()].load()==1;
    }
    // Verify complete processor sync against its manual impulse response, not just the delay primitive.
    double shiftError=0;
    for(int type:{0,2,4,6,7,8,9})
    {
        OpenStudioReverb a(true),b(true);a.selectAlgorithm(type);b.selectAlgorithm(type);
        for(auto* processor:{&a,&b}){processor->wetLevel.store(1);processor->dryLevel.store(0);processor->preDelay.store(0);}
        b.predelaySync.store(1);b.predelayDivision.store(4);
        a.prepareToPlay(48000,127);b.prepareToPlay(48000,127);juce::AudioBuffer<float> x(2,127),y(2,127);juce::MidiBuffer midi;
        std::vector<float> reference(36000,0);
        for(int start=0;start<36000;start+=127)
        {
            x.clear();y.clear();if(start==0){x.setSample(0,0,.3f);y.setSample(0,0,.3f);}a.processBlock(x,midi);b.processBlock(y,midi);
            for(int i=0;i<127&&start+i<36000;++i){const int n=start+i;reference[static_cast<size_t>(n)]=x.getSample(0,i);shiftError=juce::jmax(shiftError,std::abs(static_cast<double>(y.getSample(0,i))-(n<6000?0:reference[static_cast<size_t>(n-6000)])));}
        }
    }
    passed=passed&&tempoPass&&duckPass&&recovery&&resetSilent&&dryPass&&statePass&&oldDefaults&&shiftError<1e-6;
    result->setProperty("pass",passed);result->setProperty("delayCases",cases);result->setProperty("tempoDivisions",tempoPass);
    result->setProperty("linkedDucking",duckPass);result->setProperty("settledReductionDb",reduction);result->setProperty("releaseRecovery",recovery);result->setProperty("resetHistorySilent",resetSilent);
    result->setProperty("dryMatchesTypeRouting",dryPass);result->setProperty("stateRoundTrip",statePass);result->setProperty("olderStateDisabled",oldDefaults);
    result->setProperty("processorShiftError",shiftError);return result;
}

juce::var checkStudioPlate()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Dedicated studio plate");
    bool passed = true; juce::Array<juce::var> cases;
    const auto render = [](double rate, int character, BuiltInPlateReverb::Settings settings, int block, double seconds)
    {
        BuiltInPlateReverb plate; plate.prepare(rate, character);
        juce::AudioBuffer<float> audio(2, static_cast<int>(rate * seconds));
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            if (i % block == 0) plate.configure(character, settings);
            const auto out = plate.process(i == 0 ? .5f : 0, i == 0 ? .5f : 0);
            for (int ch = 0; ch < 2; ++ch) audio.setSample(ch, i, out[static_cast<size_t>(ch)]);
        }
        return audio;
    };
    // Schroeder backwards integration; fit -5 to -35 dB, extrapolate T60.
    const auto decay = [](const juce::AudioBuffer<float>& audio, double rate)
    {
        std::vector<double> energy(static_cast<size_t>(audio.getNumSamples())); double sum = 0;
        for (int i = audio.getNumSamples(); --i >= 0;)
        {
            for (int ch = 0; ch < 2; ++ch) sum += std::pow(audio.getSample(ch, i), 2);
            energy[static_cast<size_t>(i)] = sum;
        }
        double count = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (size_t i = 0; i < energy.size(); ++i)
        {
            const double db = 10 * std::log10(juce::jmax(1e-30, energy[i] / juce::jmax(sum, 1e-30)));
            if (db > -5 || db < -35) continue;
            const double time = static_cast<double>(i) / rate;
            ++count; sx += time; sy += db; sxx += time * time; sxy += time * db;
        }
        return count > 10 ? -60.0 * (count * sxx - sx * sx) / (count * sxy - sx * sy) : 0.0;
    };
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int character = 0; character < 3; ++character)
        {
            BuiltInPlateReverb::Settings settings; settings.damping = 0; settings.modulation = 0;
            const auto audio = render(rate, character, settings, 127, 4);
            const double measured = decay(audio, rate);
            double stereoDifference = 0;
            for (int i = 0; i < audio.getNumSamples(); ++i) stereoDifference += std::abs(audio.getSample(0,i) - audio.getSample(1,i));
            const bool ok = std::isfinite(measured) && std::abs(measured - settings.decay) < .35 && stereoDifference > .01;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("character", character);
            item->setProperty("targetT60", settings.decay); item->setProperty("measuredT60", measured); item->setProperty("pass", ok);
            cases.add(item); passed = passed && ok;
        }
    BuiltInPlateReverb::Settings settings; settings.modulation = 0;
    const auto baseline = render(48000, 1, settings, 512, 1);
    settings.preDelay = 100;
    const auto delayed = render(48000, 1, settings, 127, 1);
    double predelayError = 0;
    for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 48000; ++i)
        predelayError = juce::jmax(predelayError, std::abs(static_cast<double>(delayed.getSample(ch, i)) - (i < 4800 ? 0 : baseline.getSample(ch, i - 4800))));
    settings.preDelay = 0;
    const auto sampleBlocks = render(48000, 1, settings, 1, 1);
    double partitionError = 0;
    for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 48000; ++i)
        partitionError = juce::jmax(partitionError, static_cast<double>(std::abs(sampleBlocks.getSample(ch, i) - baseline.getSample(ch, i))));
    settings.width = 0;
    const auto mono = render(48000, 1, settings, 127, 1);
    bool monoPass = true; for (int i = 0; i < mono.getNumSamples(); ++i) monoPass = monoPass && mono.getSample(0,i) == mono.getSample(1,i);
    settings.width = 1; settings.modulation = 1;
    const auto modulated = render(48000, 1, settings, 127, 1);
    double modulationDifference = 0;
    for (int i = 0; i < 48000; ++i) modulationDifference += std::abs(modulated.getSample(0,i) - baseline.getSample(0,i));
    settings = {}; settings.modulation = 0; settings.damping = 0;
    const auto bright = render(48000, 1, settings, 127, 2);
    settings.damping = 1;
    const auto dark = render(48000, 1, settings, 127, 2);
    const auto highFrequencyFraction = [](const juce::AudioBuffer<float>& audio)
    {
        double high = 0, total = 0;
        for (int i = 12000; i < audio.getNumSamples(); ++i) for (int ch = 0; ch < 2; ++ch)
        {
            const double value = audio.getSample(ch,i), difference = value - audio.getSample(ch,i-1);
            high += difference*difference; total += value*value;
        }
        return high / juce::jmax(1e-30,total);
    };
    const double dampingRatio = highFrequencyFraction(dark) / highFrequencyFraction(bright);
    settings.damping = 0; settings.diffusion = 0;
    const auto sparse = render(48000,1,settings,127,1);
    settings.diffusion = 1;
    const auto dense = render(48000,1,settings,127,1);
    double diffusionDifference = 0;
    for (int i = 0; i < 48000; ++i) diffusionDifference += std::abs(sparse.getSample(0,i)-dense.getSample(0,i));
    bool decayRangePass = true;
    for (float seconds : {.5f, 8.0f})
    {
        settings.diffusion = .5f; settings.decay = seconds;
        const double measured = decay(render(48000,1,settings,512,seconds*2+1),48000);
        const bool ok = std::abs(measured-seconds) < seconds*.18;
        auto* item = new juce::DynamicObject(); item->setProperty("rate",48000); item->setProperty("character",1);
        item->setProperty("targetT60",seconds); item->setProperty("measuredT60",measured); item->setProperty("pass",ok);
        cases.add(item); decayRangePass = decayRangePass && ok;
    }
    // Freeze rejects new input after the smoothing interval; captured tank keeps sounding.
    BuiltInPlateReverb a, b; a.prepare(48000,1); b.prepare(48000,1);
    settings = {}; settings.modulation = 0;
    a.configure(1,settings); b.configure(1,settings);
    double freezeError = 0, heldEnergy = 0;
    for (int i = 0; i < 192000; ++i)
    {
        if (i == 24000) { settings.freeze = true; a.configure(1,settings); b.configure(1,settings); }
        const auto x = a.process(i == 0 ? .5f : 0, i == 0 ? .5f : 0);
        const auto y = b.process(i == 0 ? .5f : (i > 30000 ? .2f : 0), i == 0 ? .5f : 0);
        if (i > 48000) { freezeError = juce::jmax(freezeError, static_cast<double>(std::abs(x[0]-y[0]))); heldEnergy += x[0]*x[0]; }
    }
    OpenStudioReverb source(true); source.selectAlgorithm(2); source.plateCharacter.store(2); source.plateModulation.store(.7f);
    juce::MemoryBlock state, recalled; source.getStateInformation(state);
    OpenStudioReverb copy(true); copy.setStateInformation(state.getData(), static_cast<int>(state.getSize())); copy.getStateInformation(recalled);
    const bool recallPass = state == recalled && copy.plateEngine.load() == 1 && copy.plateCharacter.load() == 2;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize());
    for (const char* name : {"plateEngine", "plateCharacter", "plateModulation"}) tree.removeProperty(name,nullptr);
    juce::MemoryBlock legacy; { juce::MemoryOutputStream stream(legacy, false); tree.writeToStream(stream); }
    copy.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    bool legacyPass = copy.plateEngine.load() == 0;
    OpenStudioReverb old(false); old.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    copy.prepareToPlay(48000,127); old.prepareToPlay(48000,127);
    juce::AudioBuffer<float> left(2,127), right(2,127); juce::MidiBuffer midi;
    double legacyError = 0;
    for (int start = 0; start < 48000; start += 127)
    {
        left.clear(); if (start == 0) { left.setSample(0,0,.3f); left.setSample(1,0,.3f); } right.makeCopyOf(left);
        copy.processBlock(left,midi); old.processBlock(right,midi);
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 127; ++i)
            legacyError = juce::jmax(legacyError, static_cast<double>(std::abs(left.getSample(ch,i)-right.getSample(ch,i))));
    }
    legacyPass = legacyPass && legacyError == 0;
    passed = passed && predelayError < 1e-7 && partitionError < 1e-7 && monoPass && modulationDifference > .01
        && freezeError == 0 && heldEnergy > 1e-6 && recallPass && legacyPass && dampingRatio < .5
        && diffusionDifference > .01 && decayRangePass;
    result->setProperty("pass", passed); result->setProperty("decayCases", cases);
    result->setProperty("predelayError", predelayError); result->setProperty("partitionError", partitionError);
    result->setProperty("monoWidth", monoPass); result->setProperty("modulationDifference", modulationDifference);
    result->setProperty("freezeInputError", freezeError); result->setProperty("heldEnergy", heldEnergy);
    result->setProperty("dampingHighFrequencyRatio", dampingRatio); result->setProperty("diffusionDifference",diffusionDifference);
    result->setProperty("decayRange",decayRangePass);
    result->setProperty("stateRoundTrip", recallPass); result->setProperty("legacyRecallParity", legacyPass); result->setProperty("legacyError", legacyError);
    result->setProperty("scope", "Algorithmic plate, unmodulated undamped T60 +/-0.35s at 2s; not physical plate or commercial equivalence");
    return result;
}

juce::var checkReverbScheduling()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Reverb dormant scheduling and history invalidation");
    bool passed=true;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        bool resetPass=true;
        // Reset non-empty wrapped histories and compare against fresh engines.
        // Predelay includes a fractional tap and an exact zero-delay path.
        for(int type=0;type<5;++type)
        {
            BuiltInStudioReverb used,fresh;used.prepare(rate,type);fresh.prepare(rate,type);
            BuiltInStudioReverb::Settings settings;settings.preDelay=type%2==0?0:7.123f;
            used.configure(type,settings);
            for(int i=0;i<static_cast<int>(rate*.65);++i)used.process(.1f,-.07f);
            used.reset();used.configure(type,settings);fresh.configure(type,settings);
            for(int i=0;i<static_cast<int>(rate*.1);++i)
                resetPass=(used.process(i==0?.5f:0,0)==fresh.process(i==0?.5f:0,0))&&resetPass;
        }
        for(int character=0;character<3;++character)
        {
            BuiltInPlateReverb used,fresh;used.prepare(rate,character);fresh.prepare(rate,character);
            BuiltInPlateReverb::Settings settings;settings.preDelay=character==0?0:7.123f;
            used.configure(character,settings);
            for(int i=0;i<static_cast<int>(rate*.65);++i)used.process(.1f,-.07f);
            used.reset();used.configure(character,settings);fresh.configure(character,settings);
            for(int i=0;i<static_cast<int>(rate*.1);++i)
                resetPass=(used.process(i==0?.5f:0,0)==fresh.process(i==0?.5f:0,0))&&resetPass;
        }
        bool creativePass=true;
        for(int type=4;type<=6;++type)
        {
            BuiltInAdditionalReverbs engine;engine.prepare(rate,type);
            BuiltInAdditionalReverbs::Settings settings {.1f,.5f,.5f,.5f,0,20,20000,.5f,1};
            engine.configure(type,settings);
            for(int i=0;i<1024;++i)engine.process(i==0?.5f:0,0);
            const auto activeCounts=engine.processingFrames();
            for(size_t kind=0;kind<3;++kind)
                creativePass=creativePass&&(activeCounts[kind]==(kind==static_cast<size_t>(type-4)?1024u:0u));
            engine.configure(-1,settings);
            for(int i=0;i<static_cast<int>(rate*3);++i)engine.process(.1f,-.1f);
            creativePass=engine.isDormant()&&creativePass;
            const auto sleepingCounts=engine.processingFrames();
            for(int i=0;i<1024;++i)creativePass=(engine.process(.5f,.5f)==std::array<float,3>{})&&creativePass;
            creativePass=(engine.processingFrames()==sleepingCounts)&&creativePass;
            // A dormant predelay must not replay input supplied while unselected.
            settings.preDelay=100;engine.configure(type,settings);
            double stalePeak=0;
            for(int i=0;i<static_cast<int>(rate*.3);++i)
            {
                const auto wet=engine.process(0,0);
                stalePeak=juce::jmax(stalePeak,static_cast<double>(std::abs(wet[0])),static_cast<double>(std::abs(wet[1])));
            }
            creativePass=creativePass&&stalePeak<1e-7;
        }
        for(int block:{127,512})
        {
            BuiltInConvolution engine;engine.selectDefault();engine.prepare(rate,block);
            juce::AudioBuffer<float> audio(2,block);
            audio.clear();audio.setSample(0,0,.5f);engine.process(audio,0,20,20000,1,false);
            bool convolutionPass=engine.processingFrames()==0&&audio.getMagnitude(0,block)==0;
            audio.setSample(0,0,.5f);engine.process(audio,100,20,20000,1,true);
            for(int offset=0;offset<static_cast<int>(rate*4);offset+=block)
            {audio.clear();engine.process(audio,100,20,20000,1,false);}
            convolutionPass=engine.isDormant()&&convolutionPass;
            const auto sleepCount=engine.processingFrames();
            // Apply both IR and EQ edits while asleep. Match a fresh engine
            // restored from the edited state when playback resumes.
            convolutionPass=engine.trim(.08)&&convolutionPass;
            auto* settings=new juce::DynamicObject();settings->setProperty("eq0Gain",6.0);
            convolutionPass=engine.edit(juce::var(settings))&&convolutionPass;
            audio.clear();engine.process(audio,0,20,20000,1,false);
            convolutionPass=engine.processingFrames()==sleepCount&&convolutionPass;
            juce::ValueTree state("Reverb");engine.save(state);
            BuiltInConvolution fresh;convolutionPass=fresh.restore(state)&&convolutionPass;fresh.prepare(rate,block);
            juce::AudioBuffer<float> reference(2,block);double error=0;
            for(int offset=0;offset<static_cast<int>(rate*.2);offset+=block)
            {
                audio.clear();reference.clear();if(offset==0){audio.setSample(0,0,.5f);reference.setSample(0,0,.5f);}
                engine.process(audio,0,20,20000,1,true);fresh.process(reference,0,20,20000,1,true);
                for(int ch=0;ch<2;++ch)for(int i=0;i<block;++i)
                    error=juce::jmax(error,static_cast<double>(std::abs(audio.getSample(ch,i)-reference.getSample(ch,i))));
            }
            convolutionPass=convolutionPass&&error<2e-6;
            auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("block",block);
            item->setProperty("resetExact",resetPass);item->setProperty("creativeDormant",creativePass);
            item->setProperty("convolutionDormantEdits",convolutionPass);item->setProperty("convolutionWakeError",error);
            const bool ok=resetPass&&creativePass&&convolutionPass;item->setProperty("pass",ok);cases.add(item);passed=passed&&ok;
        }
    }
    result->setProperty("pass",passed);result->setProperty("cases",cases);
    result->setProperty("scope","Dormant operation counts, reset parity and pending edit/wake behavior; CPU/device deadlines and sound quality not_asserted");
    return result;
}

juce::var checkPortableConvolution()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Portable convolution and failures");
    const auto file = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("OpenStudio-IR-QA", ".wav");
    juce::AudioBuffer<float> impulse(2, 4800); impulse.clear();
    impulse.setSample(0, 0, .5f); impulse.setSample(1, 0, .5f);
    impulse.setSample(0, 1200, .2f); impulse.setSample(1, 1700, -.15f);
    bool passed = writeProbeWave(file, impulse, 48000);
    OpenStudioReverb source(true); source.selectAlgorithm(7); source.wetLevel.store(1); source.dryLevel.store(0);
    passed = source.convolutionSpace.loadFile(file) && passed;
    source.convolutionSpace.trim(.08);
    juce::MemoryBlock state; source.getStateInformation(state);
    passed = file.deleteFile() && passed;
    const auto metadata = source.convolutionSpace.info();
    const bool missingRejected = !source.convolutionSpace.loadFile(file);
    juce::MemoryBlock after; source.getStateInformation(after);
    const bool failureRetained = state == after;
    juce::MemoryBlock invalid; invalid.append("bad", 3);
    const bool corruptRejected = !source.convolutionSpace.restore(juce::var(invalid), "bad", .1);
    juce::Array<juce::var> cases;
    for (const double rate : {44100.0, 48000.0, 96000.0})
        for (const int block : {1, 127, 512})
        {
            OpenStudioReverb restored(true);
            restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            source.prepareToPlay(rate, block); restored.prepareToPlay(rate, block);
            juce::MidiBuffer midi; juce::AudioBuffer<float> a(2, block), b(2, block);
            double difference = 0, energy = 0;
            for (int start = 0; start < static_cast<int>(rate * .3); start += block)
            {
                a.clear(); b.clear();
                if (start == 0) { a.setSample(0, 0, .3f); a.setSample(1, 0, .3f); b.makeCopyOf(a); }
                source.processBlock(a, midi); restored.processBlock(b, midi);
                for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < block; ++i)
                {
                    difference = juce::jmax(difference, static_cast<double>(std::abs(a.getSample(ch, i) - b.getSample(ch, i))));
                    energy += b.getSample(ch, i) * b.getSample(ch, i);
                }
            }
            const bool ok = difference < 1e-6 && std::isfinite(energy) && energy > 1e-5;
            passed = passed && ok;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("block", block);
            item->setProperty("maxPortableDifference", difference); item->setProperty("energy", energy); item->setProperty("pass", ok); cases.add(item);
        }
    result->setProperty("pass", passed && missingRejected && corruptRejected && failureRetained);
    result->setProperty("missingFileRejected", missingRejected); result->setProperty("corruptRejected", corruptRejected);
    result->setProperty("failureRetainsState", failureRetained); result->setProperty("embeddedIR", metadata); result->setProperty("cases", cases);
    return result;
}

juce::var checkMatrixConvolution()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","True stereo IR routing, shaping and publication");
    bool passed=true;juce::Array<juce::var> cases;
    const auto directory=juce::File::getCurrentWorkingDirectory().getChildFile("output/free-suite-10-ir-tests");directory.createDirectory();
    const auto edit=[](std::initializer_list<std::pair<const char*,juce::var>> values){auto* o=new juce::DynamicObject();for(const auto& entry:values)o->setProperty(entry.first,entry.second);return juce::var(o);};
    const auto render=[](BuiltInConvolution& engine,double rate,int block,float left,float right,int length)
    {
        engine.prepare(rate,block);juce::AudioBuffer<float> resultBuffer(2,length),audio(2,block);resultBuffer.clear();
        for(int start=0;start<length;start+=block){audio.clear();if(start==0){audio.setSample(0,0,left);audio.setSample(1,0,right);}engine.process(audio,0,20,20000,1,true);const int count=juce::jmin(block,length-start);for(int ch=0;ch<2;++ch)resultBuffer.copyFrom(ch,start,audio,ch,0,count);}return resultBuffer;
    };
    const auto filter=[](juce::AudioBuffer<float> audio,double rate)
    {
        const float fs=static_cast<float>(rate),lp=1-std::exp(-juce::MathConstants<float>::twoPi*juce::jlimit(1000.0f,fs*.45f,20000.0f)/fs),hp=1-std::exp(-juce::MathConstants<float>::twoPi*20/fs);
        for(int ch=0;ch<2;++ch){float low=0,high=0;for(int i=0;i<audio.getNumSamples();++i){low+=lp*(audio.getSample(ch,i)-low);high+=hp*(low-high);audio.setSample(ch,i,low-high);}}return audio;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int block:{1,127,512})for(int order:{0,1})
    {
        const auto file=directory.getChildFile("true-stereo-"+juce::String(static_cast<int>(rate))+".wav");
        juce::AudioBuffer<float> ir(4,1024);ir.clear();ir.setSample(0,0,.5f);ir.setSample(1,73,.25f);ir.setSample(2,109,-.125f);ir.setSample(3,151,.4f);
        bool ok=writeProbeWave(file,ir,rate);BuiltInConvolution engine;ok=engine.loadFile(file)&&engine.edit(edit({{"normalise",false},{"channelOrder",order}}))&&ok;
        const auto actual=render(engine,rate,block,.25f,-.5f,2048);juce::AudioBuffer<float> expected(2,2048);expected.clear();
        expected.setSample(0,0,.125f);expected.setSample(1,151,-.2f);
        expected.setSample(order==0?1:0,73,order==0?.0625f:-.125f);expected.setSample(order==0?0:1,109,order==0?.0625f:-.03125f);
        expected=filter(std::move(expected),rate);double error=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<2048;++i)error=juce::jmax(error,static_cast<double>(std::abs(actual.getSample(ch,i)-expected.getSample(ch,i))));
        ok=ok&&error<2e-6;auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("block",block);item->setProperty("order",order);item->setProperty("maxError",error);item->setProperty("pass",ok);cases.add(item);passed=passed&&ok;
    }
    const auto file=directory.getChildFile("shaping.wav");juce::AudioBuffer<float> original(2,4800);original.clear();
    for(int ch=0;ch<2;++ch){original.setSample(ch,100,.4f);original.setSample(ch,960,.3f);original.setSample(ch,2400,-.2f);original.setSample(ch,4200,.1f);}passed=writeProbeWave(file,original,48000)&&passed;
    juce::Array<juce::var> shapeCases;
    for(int mode=0;mode<4;++mode)
    {
        BuiltInConvolution engine;bool ok=engine.loadFile(file);auto values=edit({{"normalise",false}});auto* object=values.getDynamicObject();
        juce::AudioBuffer<float> expected(2,6000);expected.clear();
        if(mode==0){object->setProperty("reverse",true);for(int ch=0;ch<2;++ch)for(int i=0;i<4800;++i)expected.setSample(ch,i,original.getSample(ch,4799-i));}
        if(mode==1){object->setProperty("attack",.04);for(int ch=0;ch<2;++ch)for(int i=0;i<4800;++i)expected.setSample(ch,i,original.getSample(ch,i)*juce::jmin(1.0f,static_cast<float>(i)/1920));}
        if(mode==2){object->setProperty("start",.01);object->setProperty("end",.08);for(int ch=0;ch<2;++ch)expected.copyFrom(ch,0,original,ch,480,3360);for(int ch=0;ch<2;++ch)expected.applyGainRamp(ch,2880,480,1,0);}
        if(mode==3){object->setProperty("directDb",-6.0);object->setProperty("earlyDb",-12.0);object->setProperty("tailDb",-60.0);for(int ch=0;ch<2;++ch){expected.setSample(ch,100,.4f*juce::Decibels::decibelsToGain(-6.0f));expected.setSample(ch,960,.3f*juce::Decibels::decibelsToGain(-12.0f));expected.setSample(ch,2400,-.2f*juce::Decibels::decibelsToGain(-12.0f));}}
        ok=engine.edit(values)&&ok;const auto actual=render(engine,48000,127,1,1,6000);expected=filter(std::move(expected),48000);double error=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<6000;++i)error=juce::jmax(error,static_cast<double>(std::abs(actual.getSample(ch,i)-expected.getSample(ch,i))));
        ok=ok&&error<2e-6;auto* item=new juce::DynamicObject();item->setProperty("mode",mode);item->setProperty("pass",ok);item->setProperty("maxError",error);shapeCases.add(item);passed=passed&&ok;
    }
    // Size must move the measured impulse, with antialias filtering when shortened.
    juce::AudioBuffer<float> single(2,4800);single.clear();single.setSample(0,960,.5f);single.setSample(1,960,.5f);const auto sizeFile=directory.getChildFile("size.wav");writeProbeWave(sizeFile,single,48000);
    bool sizePass=true;for(double scale:{.5,1.5,2.0}){BuiltInConvolution engine;engine.loadFile(sizeFile);engine.edit(edit({{"normalise",false},{"size",scale}}));const auto audio=render(engine,48000,127,1,1,12000);int peak=0;for(int i=1;i<audio.getNumSamples();++i)if(std::abs(audio.getSample(0,i))>std::abs(audio.getSample(0,peak)))peak=i;sizePass=sizePass&&std::abs(peak-960*scale)<2&&std::abs(engine.tail()-.1*scale)<1e-5;}
    double lowEnergy=0,highEnergy=0;
    for(int frequency:{1000,18000}){juce::AudioBuffer<float> tone(2,4800);for(int i=0;i<4800;++i)for(int ch=0;ch<2;++ch)tone.setSample(ch,i,.1f*std::sin(juce::MathConstants<float>::twoPi*static_cast<float>(frequency*i)/48000));const auto toneFile=directory.getChildFile("size-tone-"+juce::String(frequency)+".wav");writeProbeWave(toneFile,tone,48000);BuiltInConvolution engine;engine.loadFile(toneFile);engine.edit(edit({{"normalise",false},{"size",.5}}));const auto audio=render(engine,48000,127,1,1,4800);double energy=0;for(int i=100;i<2300;++i)energy+=std::pow(audio.getSample(0,i),2);if(frequency==1000)lowEnergy=energy;else highEnergy=energy;}
    const bool antialias=highEnergy<lowEnergy*.001;
    OpenStudioReverb source(true);source.selectAlgorithm(7);source.convolutionSpace.loadFile(directory.getChildFile("true-stereo-48000.wav"));
    juce::ValueTree beforeIR("state");source.convolutionSpace.save(beforeIR);source.convolutionSpace.edit(edit({{"reverse",true},{"attack",.001},{"size",1.5},{"channelOrder",1},{"directDb",-3.0}}));
    juce::MemoryBlock state,recalled;source.getStateInformation(state);OpenStudioReverb copy(true);copy.setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy.getStateInformation(recalled);
    juce::ValueTree afterIR("state");copy.convolutionSpace.save(afterIR);const bool portable=state==recalled&&beforeIR.getProperty("irData")==afterIR.getProperty("irData");
    const bool rejected=!copy.convolutionSpace.edit(edit({{"start",.09},{"end",.01}}))&&!copy.convolutionSpace.edit(edit({{"size",std::numeric_limits<double>::infinity()}}));
    juce::MemoryBlock unchanged;copy.getStateInformation(unchanged);const bool atomicFailure=unchanged==state;
    // Old states without shaping metadata must retain their exact original path.
    auto legacyTree=juce::ValueTree::readFromData(state.getData(),state.getSize());legacyTree.removeProperty("irShape",nullptr);
    juce::MemoryBlock legacy;{juce::MemoryOutputStream stream(legacy,false);legacyTree.writeToStream(stream);}copy.setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));
    const auto legacyInfo=copy.convolutionSpace.info().getProperty("shape",{});const bool oldDefaults=!static_cast<bool>(legacyInfo.getProperty("reverse",true))&&static_cast<double>(legacyInfo.getProperty("size",0))==1;
    // Swapping a prepared matrix/diagonal kernel during processing stays finite,
    // completes one coherent transition, and reset discards its previous input.
    BuiltInConvolution swap;swap.loadFile(file);swap.prepare(48000,127);juce::AudioBuffer<float> buffer(2,127);bool swapPass=true;
    for(int block=0;block<100;++block){if(block==10)swapPass=swap.loadFile(directory.getChildFile("true-stereo-48000.wav"))&&swapPass;if(block==15)swapPass=swap.edit(edit({{"channelOrder",1}}))&&swapPass;for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)buffer.setSample(ch,i,.1f);swap.process(buffer,0,20,20000,1,true);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)swapPass=swapPass&&std::isfinite(buffer.getSample(ch,i))&&std::abs(buffer.getSample(ch,i))<4;}
    swap.reset();double resetEnergy=0;for(int block=0;block<40;++block){buffer.clear();swap.process(buffer,0,20,20000,1,true);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)resetEnergy+=std::pow(buffer.getSample(ch,i),2);}swapPass=swapPass&&resetEnergy<1e-12;
    BuiltInConvolution bridgeRoundTrip;bridgeRoundTrip.loadFile(directory.getChildFile("true-stereo-48000.wav"));
    const auto beforeBridge=bridgeRoundTrip.info();
    const auto bridgeShape=juce::JSON::parse(juce::JSON::toString(beforeBridge.getProperty("shape",{}),true));
    const bool bridgeBoundary=bridgeRoundTrip.edit(bridgeShape)
        && static_cast<double>(bridgeRoundTrip.info().getProperty("processedDuration",0))==static_cast<double>(beforeBridge.getProperty("processedDuration",0));
    result->setProperty("unchangedBridgeCropBoundary",bridgeBoundary);
    // Preset/project restoration uses this shared host path. Hold the callback
    // publication lock to establish that complete IR preparation happens first.
    OpenStudioReverb hostRestore(true);hostRestore.prepareToPlay(48000,127);
    bool restoredByHost=false,preparedBeforePublication=false;std::thread worker;
    {
        const juce::ScopedLock callbackGuard(hostRestore.getCallbackLock());
        worker=std::thread([&]{restoredByHost=restoreFreePluginStateForRegression(hostRestore,state);});
        for(int attempt=0;attempt<500&&!preparedBeforePublication;++attempt)
        {
            preparedBeforePublication=static_cast<bool>(hostRestore.convolutionSpace.info().getProperty("shape",{}).getProperty("reverse",false));
            if(!preparedBeforePublication)std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
    worker.join();juce::MemoryBlock hostState;hostRestore.getStateInformation(hostState);
    juce::MemoryBlock wrongType;{juce::ValueTree wrong("OtherProcessor");juce::MemoryOutputStream stream(wrongType,false);wrong.writeToStream(stream);}
    const bool wrongRejected=!restoreFreePluginStateForRegression(hostRestore,wrongType);
    juce::MemoryBlock afterWrong;hostRestore.getStateInformation(afterWrong);
    const bool hostRecall=restoredByHost&&preparedBeforePublication&&hostState==state&&wrongRejected&&afterWrong==state;
    result->setProperty("hostPresetProjectRecall",hostRecall);result->setProperty("preparedOutsideCallbackLock",preparedBeforePublication);
    passed=passed&&sizePass&&antialias&&portable&&rejected&&atomicFailure&&oldDefaults&&swapPass&&hostRecall&&bridgeBoundary;
    result->setProperty("pass",passed);result->setProperty("matrixCases",cases);result->setProperty("shapeCases",shapeCases);result->setProperty("sizeTiming",sizePass);result->setProperty("downsizeAntialias",antialias);result->setProperty("highToLowEnergy",highEnergy/juce::jmax(lowEnergy,1e-30));
    result->setProperty("portableOriginalAndShape",portable);result->setProperty("invalidEditRejected",rejected);result->setProperty("failureRetainsState",atomicFailure);result->setProperty("legacyShapeDefaults",oldDefaults);result->setProperty("liveSwapAndReset",swapPass);result->setProperty("scope","Known impulse matrix, shaping nulls and sine-band rejection; commercial IR libraries, acoustic fidelity and listening acceptance not asserted");return result;
}

juce::var checkConvolutionColour()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Convolution band damping and wet EQ");
    bool passed=true;juce::Array<juce::var> eqCases,dampingCases,decayCases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
        for(int block:{1,127,512})for(int band=0;band<4;++band)for(double gain:{-9.0,9.0})
        {
            BuiltInIRColour::Settings settings;settings.eqFrequency={120,800,3200,9000};settings.eqQ={.7071067811865476,1.7,.8,.7071067811865476};settings.eqGain[static_cast<size_t>(band)]=gain;
            BuiltInIRColour::Eq eq;eq.prepare(settings,rate);
            const double frequency=settings.eqFrequency[static_cast<size_t>(band)],q=settings.eqQ[static_cast<size_t>(band)],linearGain=std::pow(10.0,gain/20);
            const auto coefficients=band==0?juce::dsp::IIR::Coefficients<double>::makeLowShelf(rate,frequency,q,linearGain)
                :band==3?juce::dsp::IIR::Coefficients<double>::makeHighShelf(rate,frequency,q,linearGain)
                :juce::dsp::IIR::Coefficients<double>::makePeakFilter(rate,frequency,q,linearGain);
            juce::dsp::IIR::Filter<double> reference;reference.coefficients=coefficients;reference.reset();
            juce::AudioBuffer<float> audio(2,block);double maximumError=0,responseError=0;const int length=static_cast<int>(rate*.2);
            for(int offset=0;offset<length;offset+=block)
            {
                audio.clear();if(offset==0)audio.setSample(0,0,1);eq.process(audio,block);
                for(int i=0;i<block;++i){const double expected=reference.processSample(offset+i==0?1.0:0.0);maximumError=juce::jmax(maximumError,std::abs(audio.getSample(0,i)-expected),static_cast<double>(std::abs(audio.getSample(1,i))));}
            }
            const auto response=eq.response();if(const auto* points=response.getArray())for(const auto& point:*points)
            {
                const double f=static_cast<double>(point.getProperty("frequency",0));const double expected=20*std::log10(coefficients->getMagnitudeForFrequency(f,rate));
                responseError=juce::jmax(responseError,std::abs(expected-static_cast<double>(point.getProperty("db",0))));
            }
            const bool ok=maximumError<2e-6&&responseError<1e-7;passed=passed&&ok;
            auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("block",block);item->setProperty("band",band);item->setProperty("gain",gain);item->setProperty("sampleError",maximumError);item->setProperty("graphErrorDb",responseError);item->setProperty("pass",ok);eqCases.add(item);
        }
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const int length=static_cast<int>(rate);juce::AudioBuffer<float> source(2,length);
        for(int band=0;band<3;++band)for(double frequency:{40.0,1000.0,14000.0})
        {
            for(int i=0;i<length;++i){source.setSample(0,i,static_cast<float>(.1*std::sin(juce::MathConstants<double>::twoPi*frequency*i/rate)));source.setSample(1,i,0);}
            auto processed=source;BuiltInIRColour::Settings settings;
            if(band==0)settings.lowDecay=.5;else if(band==1)settings.midDecay=.5;else settings.highDecay=.5;
            BuiltInIRColour::damp(processed,rate,settings,.08);
            const double low=std::pow(juce::dsp::IIR::Coefficients<double>::makeLowPass(rate,250)->getMagnitudeForFrequency(frequency,rate),2);
            const double upper=std::pow(juce::dsp::IIR::Coefficients<double>::makeLowPass(rate,4000)->getMagnitudeForFrequency(frequency,rate),2);
            const double weight=band==0?low:band==1?upper-low:1-upper;
            double error=0;bool directExact=true;
            for(int i=0;i<length;++i)
            {
                if(i/rate<=.08)directExact=directExact&&source.getSample(0,i)==processed.getSample(0,i);
                if(i/rate>=.12&&i/rate<.7){const double envelope=1-weight+weight*std::pow(.001,(i/rate-.08)/.5);error=juce::jmax(error,std::abs(processed.getSample(0,i)-source.getSample(0,i)*envelope),static_cast<double>(std::abs(processed.getSample(1,i))));}
            }
            const bool ok=error<2e-5&&directExact;passed=passed&&ok;
            auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("band",band);item->setProperty("frequency",frequency);item->setProperty("maxError",error);item->setProperty("earlyUnchanged",directExact);item->setProperty("pass",ok);dampingCases.add(item);
        }
        for(double extra:{.5,1.0,4.0})
        {
            for(int i=0;i<length;++i)for(int ch=0;ch<2;++ch)source.setSample(ch,i,static_cast<float>(.1*std::pow(.001,i/rate/2)*std::sin(juce::MathConstants<double>::twoPi*1000*i/rate)));
            BuiltInIRColour::Settings settings;settings.lowDecay=settings.midDecay=settings.highDecay=extra;
            BuiltInIRColour::damp(source,rate,settings,0);
            const auto energy=[&](double begin){double sum=0;const int start=juce::roundToInt(begin*rate),end=juce::roundToInt((begin+.02)*rate);for(int i=start;i<end;++i)sum+=std::pow(source.getSample(0,i),2);return sum/(end-start);};
            const double measured=-6*.2/std::log10(energy(.3)/energy(.1));const double expected=1/(.5+1/extra);
            const bool ok=std::abs(measured/expected-1)<.01;passed=passed&&ok;
            auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("extraDecay",extra);item->setProperty("expectedT60",expected);item->setProperty("measuredT60",measured);item->setProperty("pass",ok);decayCases.add(item);
        }
    }
    const auto values=[](std::initializer_list<std::pair<const char*,juce::var>> entries){auto* object=new juce::DynamicObject();for(const auto& entry:entries)object->setProperty(entry.first,entry.second);return juce::var(object);};
    OpenStudioReverb original(true);original.selectAlgorithm(7);juce::MemoryBlock neutral;original.getStateInformation(neutral);
    const bool edited=original.convolutionSpace.edit(values({{"lowDecay",4.0},{"midDecay",2.0},{"highDecay",.5},{"eq1Gain",9.0},{"eq1Frequency",800.0},{"eq1Q",1.7}}));
    juce::MemoryBlock state,copyState;original.getStateInformation(state);OpenStudioReverb copy(true);
    const bool hostRestore=restoreFreePluginStateForRegression(copy,state);copy.getStateInformation(copyState);const bool completeRecall=copyState==state;
    const bool invalid=!copy.convolutionSpace.edit(values({{"highCrossover",1000.0},{"lowCrossover",1000.0}}))&&!copy.convolutionSpace.edit(values({{"lowDecay",.01}}))&&!copy.convolutionSpace.edit(values({{"eq1Q",0.0}}));
    juce::MemoryBlock afterInvalid;copy.getStateInformation(afterInvalid);
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());
    // Hold the var owner while reading its binary data.
    const auto shapeVar=tree.getProperty("irShape");const auto* shapeBytes=shapeVar.getBinaryData();
    auto oldShape=juce::ValueTree::readFromData(shapeBytes->getData(),shapeBytes->getSize());
    for(const char* name:{"lowDecay","midDecay","highDecay","lowCrossover","highCrossover","eqEnabled"})oldShape.removeProperty(name,nullptr);
    for(int band=0;band<4;++band)for(const char* suffix:{"Frequency","Gain","Q"})oldShape.removeProperty("eq"+juce::String(band)+suffix,nullptr);
    juce::MemoryBlock oldShapeBytes;{juce::MemoryOutputStream out(oldShapeBytes,false);oldShape.writeToStream(out);}tree.setProperty("irShape",juce::var(oldShapeBytes),nullptr);
    juce::MemoryBlock oldState;{juce::MemoryOutputStream out(oldState,false);tree.writeToStream(out);}copy.setStateInformation(oldState.getData(),static_cast<int>(oldState.getSize()));copy.getStateInformation(copyState);
    const bool oldDefaults=copyState==neutral;
    const bool persistence=edited&&hostRestore&&completeRecall&&state==afterInvalid&&invalid&&oldDefaults;
    passed=passed&&persistence;result->setProperty("stateAndLegacy",persistence);
    // Check that the published convolution kernel actually includes EQ and its
    // reported curve, rather than merely testing the standalone filter helper.
    const auto directory=juce::File::getCurrentWorkingDirectory().getChildFile("output/free-suite-11-ir-tests");directory.createDirectory();
    juce::AudioBuffer<float> impulse(2,128);impulse.clear();impulse.setSample(0,0,.5f);impulse.setSample(1,0,.5f);
    const auto file=directory.getChildFile("unit.wav");bool integration=writeProbeWave(file,impulse,48000);
    BuiltInConvolution dryEq,coloured;integration=dryEq.loadFile(file)&&coloured.loadFile(file)&&dryEq.edit(values({{"normalise",false}}))&&coloured.edit(values({{"normalise",false},{"eq1Gain",9.0},{"eq1Frequency",1000.0}}))&&integration;
    dryEq.prepare(48000,127);coloured.prepare(48000,127);
    juce::dsp::IIR::Filter<double> filter;filter.coefficients=juce::dsp::IIR::Coefficients<double>::makePeakFilter(48000,1000,1,std::pow(10.0,9.0/20));filter.reset();
    double residual=0;juce::AudioBuffer<float> a(2,127),b(2,127);
    for(int block=0;block<400;++block){a.clear();b.clear();if(block==0){a.setSample(0,0,1);b.setSample(0,0,1);}dryEq.process(a,0,20,20000,1,true);coloured.process(b,0,20,20000,1,true);for(int i=0;i<127;++i)residual=juce::jmax(residual,std::abs(b.getSample(0,i)-filter.processSample(a.getSample(0,i))));}
    const auto metadata=coloured.info();double peakDb=0;if(const auto* curve=metadata.getProperty("eqResponse",{}).getArray())for(const auto& point:*curve)peakDb=juce::jmax(peakDb,static_cast<double>(point.getProperty("db",0)));
    integration=integration&&residual<2e-6&&peakDb>8.8&&coloured.tail()>dryEq.tail();
    // A live EQ edit must preserve an already sounding FIR tail, including a
    // complete editor shape payload transported through decimal JSON.
    juce::AudioBuffer<float> tailIR(2,48001);juce::Random random(99117);
    for(int i=0;i<tailIR.getNumSamples();++i)for(int ch=0;ch<2;++ch)tailIR.setSample(ch,i,(random.nextFloat()-.5f)*.01f*std::exp(-static_cast<float>(i)/48000));
    const auto tailFile=directory.getChildFile("live-tail.wav");bool live=writeProbeWave(tailFile,tailIR,48000);
    BuiltInConvolution unchanged,liveEQ;live=unchanged.loadFile(tailFile)&&liveEQ.loadFile(tailFile)&&live;
    unchanged.prepare(48000,127);liveEQ.prepare(48000,127);double referenceEnergy=0,editedEnergy=0;
    for(int block=0;block<200;++block)
    {
        if(block==70){auto edit=juce::JSON::parse(juce::JSON::toString(liveEQ.info().getProperty("shape",{}),true));edit.getDynamicObject()->setProperty("eq1Gain",6.0);live=liveEQ.edit(edit)&&live;}
        a.clear();b.clear();if(block==0){a.setSample(0,0,1);b.setSample(0,0,1);}unchanged.process(a,0,20,20000,1,true);liveEQ.process(b,0,20,20000,1,true);
        if(block>=110)for(int i=0;i<127;++i){referenceEnergy+=std::pow(a.getSample(0,i),2);editedEnergy+=std::pow(b.getSample(0,i),2);live=live&&std::isfinite(b.getSample(0,i));}
    }
    live=live&&referenceEnergy>1e-8&&editedEnergy>referenceEnergy*.5;
    result->setProperty("eqEditPreservesLiveTail",live);result->setProperty("liveTailEnergyRatio",editedEnergy/juce::jmax(1e-30,referenceEnergy));
    passed=passed&&integration&&live;result->setProperty("publishedEqAndTail",integration);result->setProperty("publishedEqResidual",residual);result->setProperty("nativeEqResponse",metadata.getProperty("eqResponse",{}));
    result->setProperty("pass",passed);result->setProperty("eqCases",eqCases);result->setProperty("dampingCases",dampingCases);result->setProperty("decayCases",decayCases);
    result->setProperty("scope","Independent filter/response oracle, known-signal damping, neutral migration and prepared host state. Commercial equivalence and listening acceptance not asserted.");return result;
}

juce::var checkOutputMeters()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Output meter calibration");
    bool passed = true; juce::Array<juce::var> cases;
    for (const double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int channels : {1, 2})
        {
            BuiltInOutputMeter meter; meter.prepare(rate, 127); juce::AudioBuffer<float> buffer(channels, 127);
            for (int start = 0; start < static_cast<int>(rate * 3.2); start += 127)
            {
                for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < 127; ++i)
                    buffer.setSample(ch, i, .1f * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 997 * (start + i) / rate)));
                meter.process(buffer);
            }
            const float expected = channels == 1 ? -23.0f : -19.9897f;
            const bool ok = std::abs(meter.momentary.load() - expected) < .12f && std::abs(meter.shortTerm.load() - expected) < .12f
                && std::abs(meter.truePeakDb.load() + 20) < .05f;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("channels", channels);
            item->setProperty("M", meter.momentary.load()); item->setProperty("S", meter.shortTerm.load()); item->setProperty("dBTP", meter.truePeakDb.load());
            item->setProperty("pass", ok); cases.add(item); passed = passed && ok;
            meter.reset(); passed = passed && meter.momentary.load() == -100 && meter.truePeakDb.load() == -100;
        }
    result->setProperty("pass", passed); result->setProperty("cases", cases);
    result->setProperty("scope", "997 Hz calibration at four rates, mono/stereo, reset; full EBU test-set certification not asserted"); return result;
}

juce::var checkCompressorAverageMeter()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Compressor selectable average meter");
    double levelError=0,stepError=0,partitionError=0;bool routing=true;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInAverageMeter fixed,varied,step;fixed.prepare(rate);varied.prepare(rate);step.prepare(rate);
        const int count=static_cast<int>(rate*2);juce::AudioBuffer<float> signal(2,count);
        const float amplitude=juce::Decibels::decibelsToGain(-18.0f);
        for(int i=0;i<count;++i){const float value=amplitude*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*997*i/rate));signal.setSample(0,i,value);signal.setSample(1,i,value*.5f);}
        fixed.measure(signal,false);
        for(int start=0;start<count;){const int length=juce::jmin(1+(start%257),count-start);float* pointers[]={signal.getWritePointer(0,start),signal.getWritePointer(1,start)};juce::AudioBuffer<float> segment(pointers,2,length);varied.measure(segment,false);start+=length;}
        levelError=juce::jmax(levelError,std::abs(static_cast<double>(fixed.db(false,0)+18)));
        levelError=juce::jmax(levelError,std::abs(static_cast<double>(fixed.db(false,1)+18+6.020599913)));
        partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(fixed.db(false,0)-varied.db(false,0))));
        juce::AudioBuffer<float> constant(1,static_cast<int>(rate*.3));for(int i=0;i<constant.getNumSamples();++i)constant.setSample(0,i,static_cast<float>(.1/juce::MathConstants<double>::halfPi));step.measure(constant,true);
        const double reached=juce::Decibels::decibelsToGain(static_cast<double>(step.db(true,0)))/.1;
        stepError=juce::jmax(stepError,std::abs(reached-.99));routing=routing&&step.db(true,0)==step.db(true,1)&&step.db(false,0)==-100;
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("leftDb",fixed.db(false,0));item->setProperty("rightDb",fixed.db(false,1));item->setProperty("stepFraction300ms",reached);cases.add(item);
    }
    bool integrated=true;
    for(int model=0;model<7;++model)
    {
        OpenStudioCompressor processor(true);processor.selectModel(model);processor.mix.store(0);processor.prepareToPlay(48000,256);
        juce::AudioBuffer<float> audio(2,256);juce::MidiBuffer midi;
        for(int block=0;block<400;++block){for(int i=0;i<256;++i){const float value=.1f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*997*(block*256+i)/48000));audio.setSample(0,i,value);audio.setSample(1,i,value*.5f);}processor.processBlock(audio,midi);}
        integrated=integrated&&std::abs(processor.averageMeter.db(false,0)+20)<.01f&&std::abs(processor.averageMeter.db(true,0)+20)<.01f;
    }
    OpenStudioCompressor original(true);const auto schema=describeFreePluginForRegression(original);const auto* params=schema["parameters"].getArray();bool appended=params&&params->size()>=69;
    if(params)for(int i=0;i<3;++i)appended=appended&&(*params)[66+i]["id"].toString()==juce::StringArray{"meterMode","meterReference","meterChannel"}[i]&&!static_cast<bool>((*params)[66+i]["automatable"]);
    const bool setters=setFreePluginParamForRegression(original,"meterMode",2)&&setFreePluginParamForRegression(original,"meterReference",-20)&&setFreePluginParamForRegression(original,"meterChannel",2);
    juce::MemoryBlock state;original.getStateInformation(state);OpenStudioCompressor restored(true);restored.setStateInformation(state.getData(),static_cast<int>(state.getSize()));
    const bool recall=restored.meterMode.load()==2&&restored.meterReference.load()==-20&&restored.meterChannel.load()==2;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(const char* id:{"meterMode","meterReference","meterChannel"})tree.removeProperty(id,nullptr);
    juce::MemoryBlock old;{juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);}restored.setStateInformation(old.getData(),static_cast<int>(old.getSize()));
    const bool migration=restored.meterMode.load()==0&&restored.meterReference.load()==-18&&restored.meterChannel.load()==0;
    const bool passed=levelError<.01&&stepError<.00003&&partitionError==0&&routing&&integrated&&appended&&setters&&recall&&migration;
    result->setProperty("pass",passed);result->setProperty("levelErrorDb",levelError);result->setProperty("stepError",stepError);result->setProperty("partitionErrorDb",partitionError);result->setProperty("channelRouting",routing);result->setProperty("allModelsPostMix",integrated);result->setProperty("appendedNonAutomatable",appended);result->setProperty("recall",recall);result->setProperty("migration",migration);result->setProperty("cases",cases);result->setProperty("schema",schema);return result;
}

juce::var checkConvolutionCrossTerms()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Convolution cross terms");
    const auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("openstudio-ir-cross-"+juce::Uuid().toString()+".wav");
    juce::AudioBuffer<float> impulse(4,4800);impulse.clear();
    impulse.setSample(0,10,.8f);impulse.setSample(1,3840,.6f);impulse.setSample(2,3600,-.4f);impulse.setSample(3,40,.2f);impulse.setSample(0,4000,.4f);
    bool passed=writeProbeWave(file,impulse,48000),recall=true;double staticError=0,partitionError=0;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int order:{0,1})for(bool normalise:{false,true})
    {
        BuiltInConvolution source;passed=source.loadFile(file)&&passed;
        const auto edit=[&](double cross){auto* settings=new juce::DynamicObject();settings->setProperty("normalise",normalise);settings->setProperty("channelOrder",order);settings->setProperty("crossTerms",cross);return source.edit(juce::var(settings));};
        passed=edit(1)&&passed;auto full=renderBuiltInIRAudition(source,rate,0,1,{});
        passed=edit(.25)&&passed;auto quarter=renderBuiltInIRAudition(source,rate,0,1,{});
        const bool valid=full.error.isEmpty()&&quarter.error.isEmpty()&&full.audio.getNumSamples()==quarter.audio.getNumSamples();passed=passed&&valid;
        if(valid)for(int ch=0;ch<2;++ch)for(int i=0;i<full.audio.getNumSamples();++i)
            staticError=juce::jmax(staticError,std::abs(static_cast<double>(quarter.audio.getSample(ch,i)-full.audio.getSample(ch,i)*(ch==0?1.0f:.25f))));
        juce::ValueTree state("Snapshot");source.save(state);BuiltInConvolution restored;recall=restored.restore(state)&&recall;
        recall=recall&&static_cast<double>(restored.info()["shape"]["crossTerms"])==.25;
    }
    const auto renderChanged=[&](int block)
    {
        BuiltInConvolution source;source.loadFile(file);auto* settings=new juce::DynamicObject();settings->setProperty("normalise",false);source.edit(juce::var(settings));source.prepare(48000,512);
        juce::AudioBuffer<float> output(2,6000),chunk(2,512);output.clear();
        for(int position=0;position<6000;)
        {
            if(position==256){auto* change=new juce::DynamicObject();change->setProperty("crossTerms",0.0);source.edit(juce::var(change));}
            const int length=juce::jmin(block,6000-position,position<256?256-position:6000-position);chunk.setSize(2,length,false,false,true);chunk.clear();
            if(position==0)chunk.setSample(0,0,1);
            source.process(chunk,0,20,20000,1,true,false);
            for(int ch=0;ch<2;++ch)output.copyFrom(ch,position,chunk,ch,0,length);
            position+=length;
        }
        return output;
    };
    const auto fixed=renderChanged(256),varied=renderChanged(37);
    for(int ch=0;ch<2;++ch)for(int i=0;i<fixed.getNumSamples();++i)partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(fixed.getSample(ch,i)-varied.getSample(ch,i))));
    const bool history=std::abs(fixed.getSample(0,4000)-.4f)<1e-6&&std::abs(fixed.getSample(1,3840))<1e-6;
    BuiltInConvolution legacy;legacy.loadFile(file);juce::ValueTree state("Legacy");legacy.save(state);
    // No irShape was present in the original portable format.
    state.removeProperty("irShape",nullptr);BuiltInConvolution migrated;
    const bool migration=migrated.restore(state)&&static_cast<double>(migrated.info()["shape"]["crossTerms"])==1;
    auto* invalid=new juce::DynamicObject();invalid->setProperty("crossTerms",1.01);const bool rejected=!migrated.edit(juce::var(invalid));
    file.deleteFile();passed=passed&&recall&&staticError<1e-6&&partitionError<1e-6&&history&&migration&&rejected;
    result->setProperty("pass",passed);result->setProperty("staticError",staticError);result->setProperty("partitionError",partitionError);
    result->setProperty("normalizationAndDiagonalPreserved",staticError<1e-6);result->setProperty("historyRetained",history);result->setProperty("stateRecall",recall);result->setProperty("legacyMigration",migration);result->setProperty("invalidRejected",rejected);return result;
}

juce::var checkIRAudition()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Isolated convolution audition");
    const auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("openstudio-ir-audition-"+juce::Uuid().toString()+".wav");
    juce::AudioBuffer<float> impulse(4,4800);impulse.clear();
    impulse.setSample(0,10,.8f);impulse.setSample(1,20,.6f);impulse.setSample(2,30,-.4f);impulse.setSample(3,40,.2f);
    BuiltInConvolution source;bool passed=writeProbeWave(file,impulse,48000)&&source.loadFile(file);
    auto* settings=new juce::DynamicObject();settings->setProperty("normalise",false);passed=source.edit(juce::var(settings))&&passed;
    file.deleteFile();juce::ValueTree before("Snapshot");source.save(before);
    bool finite=true,bounded=true,channelRouting=true;double impulseError=0;juce::Array<juce::var> cases;
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int sound:{0,1})for(int input:{0,1,2})
    {
        auto rendered=renderBuiltInIRAudition(source,rate,sound,input,{});float peak=0;
        const bool valid=rendered.error.isEmpty()&&rendered.audio.getNumChannels()==2&&rendered.audio.getNumSamples()>0;
        passed=passed&&valid;if(!valid)continue;
        for(int ch=0;ch<2;++ch)for(int i=0;i<rendered.audio.getNumSamples();++i){const float value=rendered.audio.getSample(ch,i);finite=finite&&std::isfinite(value);peak=juce::jmax(peak,std::abs(value));}
        bounded=bounded&&peak<=.250001f&&peak>0;
        if(rate==48000&&sound==0)
        {
            const int onset=480;
            for(int ch=0;ch<2;++ch)for(int i=0;i<100;++i)
            {
                float expected=0;
                if(input!=2&&ch==0&&i==10)expected=.08f;
                if(input!=2&&ch==1&&i==20)expected=.06f;
                if(input!=1&&ch==0&&i==30)expected=-.04f;
                if(input!=1&&ch==1&&i==40)expected=.02f;
                impulseError=juce::jmax(impulseError,std::abs(static_cast<double>(rendered.audio.getSample(ch,onset+i)-expected)));
            }
            channelRouting=channelRouting&&impulseError<1e-6;
        }
        auto* item=new juce::DynamicObject();item->setProperty("rate",rate);item->setProperty("sound",sound);item->setProperty("input",input);item->setProperty("peak",peak);cases.add(item);
    }
    juce::ValueTree after("Snapshot");source.save(after);const bool unchanged=before.isEquivalentTo(after);
    auto cancelled=renderBuiltInIRAudition(source,48000,1,0,[](float progress){return progress<.3f;});
    const bool cancelledClean=cancelled.error.isNotEmpty()&&cancelled.audio.getNumSamples()==0;
    auto* louder=new juce::DynamicObject();louder->setProperty("directDb",12);source.edit(juce::var(louder));
    auto limited=renderBuiltInIRAudition(source,48000,0,0,{});
    const bool peakCap=limited.error.isEmpty()&&limited.attenuationDb<0&&limited.audio.getMagnitude(0,limited.audio.getNumSamples())<=.250001f;
    auto owner=std::make_shared<OpenStudioBasicSynthInstrument>();BuiltInIRPreview preview;
    const auto stale=preview.begin("old"),ticket=preview.begin("new");
    juce::AudioBuffer<float> staleAudio(2,2000);staleAudio.clear();
    const bool staleRejected=!preview.publish(stale,std::move(staleAudio),48000,owner);
    juce::AudioBuffer<float> audio(2,2000);for(int ch=0;ch<2;++ch)for(int i=0;i<2000;++i)audio.setSample(ch,i,.1f);
    const bool published=preview.publish(ticket,std::move(audio),48000,owner);preview.stop("old");
    juce::AudioBuffer<float> output(2,512);output.clear();preview.render(output.getArrayOfWritePointers(),2,512,48000);
    const bool otherOwnerCannotStop=output.getMagnitude(0,512)==.1f;
    preview.stop("new");output.clear();preview.render(output.getArrayOfWritePointers(),2,512,48000);
    output.clear();preview.render(output.getArrayOfWritePointers(),2,512,48000);const bool stopped=output.getMagnitude(0,512)==0;
    const auto removedTicket=preview.begin("removed");juce::AudioBuffer<float> removedAudio(2,2000);removedAudio.clear();removedAudio.applyGain(1);
    preview.publish(removedTicket,std::move(removedAudio),48000,owner);owner.reset();output.clear();preview.render(output.getArrayOfWritePointers(),2,512,48000);
    const bool removalStops=!static_cast<bool>(preview.status("removed")["playing"]);
    passed=passed&&finite&&bounded&&channelRouting&&unchanged&&cancelledClean&&peakCap&&staleRejected&&published&&otherOwnerCannotStop&&stopped&&removalStops;
    result->setProperty("pass",passed);result->setProperty("cases",cases);result->setProperty("impulseError",impulseError);
    result->setProperty("sourceUnchanged",unchanged);result->setProperty("cancelledClean",cancelledClean);result->setProperty("peakCap",peakCap);
    result->setProperty("staleRejected",staleRejected);result->setProperty("ownerStop",otherOwnerCannotStop&&stopped);result->setProperty("removalStops",removalStops);
    result->setProperty("audioQuality","not_asserted");return result;
}

juce::var checkPreviewOwnership()
{
    auto source = std::make_shared<OpenStudioBasicSynthInstrument>(); source->prepareToPlay(48000, 256);
    BuiltInInstrumentPreview preview;
    const auto make = [] { return std::make_unique<OpenStudioBasicSynthInstrument>(); };
    bool passed = preview.send("one", source, 60, true, 48000, make) && preview.send("two", source, 60, true, 48000, make);
    juce::AudioBuffer<float> buffer(2, 256), original(2, 256); juce::MidiBuffer midi;
    double previewEnergy = 0, sourceEnergy = 0;
    for (int i = 0; i < 30; ++i)
    {
        buffer.clear(); original.clear(); preview.render(buffer.getArrayOfWritePointers(), 2, 256, 48000); source->processBlock(original, midi);
        previewEnergy += buffer.getMagnitude(0, 256); sourceEnergy += original.getMagnitude(0, 256);
    }
    preview.send("one", source, -1, false, 48000, make);
    for (int i = 0; i < 5; ++i) { buffer.clear(); preview.render(buffer.getArrayOfWritePointers(), 2, 256, 48000); }
    const bool secondSurvives = buffer.getMagnitude(0, 256) > 0;
    preview.stopAll();
    for (int i = 0; i < 5; ++i) { buffer.clear(); preview.render(buffer.getArrayOfWritePointers(), 2, 256, 48000); }
    const bool stopped = buffer.getMagnitude(0, 256) == 0;
    bool bindingsMatch = true, previewRoutesIsolated = true;
    const auto checkBindings = [&bindingsMatch,&previewRoutesIsolated](const std::shared_ptr<juce::AudioProcessor>& controlSource, std::unique_ptr<juce::AudioProcessor> clone)
    {
        const auto synchronize = bindBuiltInPreviewControls(controlSource, *clone);
        const auto schema = describeFreePluginForRegression(*controlSource);
        for (const auto& parameter : *schema["parameters"].getArray())
            bindingsMatch = bindingsMatch && setFreePluginParamForRegression(*controlSource, parameter["id"].toString(), static_cast<float>(parameter["max"]));
        synchronize();
        const auto expected = describeFreePluginForRegression(*controlSource), actual = describeFreePluginForRegression(*clone);
        const auto* left = expected["parameters"].getArray(); const auto* right = actual["parameters"].getArray();
        bindingsMatch = bindingsMatch && left && right && left->size() == right->size();
        if (left && right && left->size() == right->size()) for (int i = 0; i < left->size(); ++i)
        {
            if(dynamic_cast<OpenStudioDrumInstrument*>(clone.get())&&(*left)[i]["id"].toString().startsWith("pieceOutput"))
                previewRoutesIsolated=previewRoutesIsolated&&static_cast<float>((*right)[i]["value"])==0;
            else bindingsMatch = bindingsMatch && (*left)[i]["value"] == (*right)[i]["value"];
        }
    };
    checkBindings(std::make_shared<OpenStudioBasicSynthInstrument>(), std::make_unique<OpenStudioBasicSynthInstrument>());
    checkBindings(std::make_shared<OpenStudioPianoInstrument>(), std::make_unique<OpenStudioPianoInstrument>());
    checkBindings(std::make_shared<OpenStudioDrumInstrument>(), std::make_unique<OpenStudioDrumInstrument>());
    checkBindings(std::make_shared<OpenStudioCleanGuitarInstrument>(), std::make_unique<OpenStudioCleanGuitarInstrument>());
    passed = passed && previewEnergy > 0 && sourceEnergy == 0 && secondSurvives && stopped;
    passed = passed && bindingsMatch && previewRoutesIsolated;
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Isolated preview leases"); result->setProperty("pass", passed);
    result->setProperty("sourceRemainsSilent", sourceEnergy == 0); result->setProperty("otherEditorSurvivesStop", secondSurvives); result->setProperty("panicClears", stopped); result->setProperty("liveParameterBindings", bindingsMatch);result->setProperty("previewRoutesStayStereo",previewRoutesIsolated); return result;
}

juce::var checkModelMemoryAndHost()
{
    OpenStudioCompressor compressor(true); compressor.selectModel(2); compressor.attack.store(.32f);
    compressor.selectModel(3); compressor.threshold.store(-27); compressor.selectModel(2);
    bool memory = compressor.attack.load() == .32f;
    juce::MemoryBlock state; compressor.getStateInformation(state);
    OpenStudioCompressor restored(true); restored.setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored.selectModel(3);
    memory = memory && restored.threshold.load() == -27;
    bool host = true; juce::Array<juce::var> cases;
    for (const double rate : {44100.0, 48000.0, 96000.0})
    {
        TrackProcessor processed, aligned;
        processed.prepareToPlay(rate, 512); aligned.prepareToPlay(rate, 512);
        auto processor = std::make_unique<OpenStudioCompressor>(true);
        processed.addTrackFX(std::move(processor), rate, 512);
        const int latency = processed.getChainLatency(); aligned.setPDCDelay(latency);
        processed.resetOfflineRenderState(); aligned.resetOfflineRenderState();
        juce::AudioBuffer<float> a(2, 512), b(2, 512); juce::MidiBuffer midi;
        int peakA = -1, peakB = -1; float maximumA = 0, maximumB = 0;
        for (int start = 0; start < latency + 2048; start += 512)
        {
            a.clear(); b.clear(); if (start == 0) for (int ch = 0; ch < 2; ++ch) { a.setSample(ch, 0, .1f); b.setSample(ch, 0, .1f); }
            processed.processBlock(a, midi); aligned.processBlock(b, midi);
            for (int i = 0; i < 512; ++i)
            {
                if (std::abs(a.getSample(0, i)) > maximumA) { maximumA = std::abs(a.getSample(0, i)); peakA = start + i; }
                if (std::abs(b.getSample(0, i)) > maximumB) { maximumB = std::abs(b.getSample(0, i)); peakB = start + i; }
            }
        }
        const bool ok = latency == static_cast<int>(std::ceil(rate * .02)) && peakA == latency && peakB == latency;
        host = host && ok; auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("latency", latency);
        item->setProperty("processedPeak", peakA); item->setProperty("compensatedPeak", peakB); item->setProperty("pass", ok); cases.add(item);
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Model memory and track PDC"); result->setProperty("pass", memory && host);
    result->setProperty("modelRecall", memory); result->setProperty("cases", cases); return result;
}

using Factory = std::function<std::unique_ptr<juce::AudioProcessor>()>;
template<class Processor> Factory factory()
{
    return [] { return std::make_unique<Processor>(); };
}

juce::var checkSuiteControlMatrix(const std::vector<Factory>& factories)
{
    bool passed = true; juce::Array<juce::var> cases;
    for (const auto& make : factories)
        for (const double rate : {44100.0, 48000.0, 96000.0})
            for (const int channels : {1, 2})
                for (const int block : {1, 32, 127, 512})
                {
                    auto processor = make(); auto layout = processor->getBusesLayout();
                    if (!layout.inputBuses.isEmpty()) layout.inputBuses.set(0, channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
                    layout.outputBuses.set(0, channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
                    bool ok = processor->setBusesLayout(layout);
                    processor->setRateAndBufferSizeDetails(rate, block); processor->prepareToPlay(rate, block);
                    const auto schema = describeFreePluginForRegression(*processor);
                    juce::AudioBuffer<float> buffer(channels, block); juce::MidiBuffer midi;
                    double maximum = 0;
                    for (int iteration = 0; iteration < 12; ++iteration)
                    {
                        if (iteration == 3 || iteration == 7)
                            if (const auto* parameters = schema["parameters"].getArray())
                                for (const auto& parameter : *parameters)
                                    if (parameter["automatable"] && parameter["type"].toString() != "meter")
                                        ok = setFreePluginParamForRegression(*processor, parameter["id"].toString(),
                                            static_cast<float>(static_cast<double>(parameter[iteration == 3 ? "max" : "min"]))) && ok;
                        buffer.clear(); midi.clear();
                        if (processor->acceptsMidi())
                        {
                            if (iteration == 0 || iteration == 4) midi.addEvent(juce::MidiMessage::noteOn(1, 60, .8f), block / 2);
                            if (iteration == 8) midi.addEvent(juce::MidiMessage::allSoundOff(1), 0);
                        }
                        else for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < block; ++i)
                            buffer.setSample(ch, i, static_cast<float>(.1 * std::sin((iteration * block + i) * .071 + ch * .31)));
                        processor->processBlock(buffer, midi);
                        for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < block; ++i)
                        {
                            const float value = buffer.getSample(ch, i); ok = ok && std::isfinite(value) && std::abs(value) < 64;
                            maximum = juce::jmax(maximum, static_cast<double>(std::abs(value)));
                        }
                    }
                    juce::MemoryBlock state, recalled; processor->getStateInformation(state);
                    auto restored = make(); restored->setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored->getStateInformation(recalled);
                    const bool roundTrip = juce::ValueTree::readFromData(state.getData(), state.getSize()).isEquivalentTo(juce::ValueTree::readFromData(recalled.getData(), recalled.getSize()));
                    ok = ok && roundTrip; processor->reset(); processor->releaseResources();
                    auto* item = new juce::DynamicObject(); item->setProperty("name", processor->getName()); item->setProperty("rate", rate);
                    item->setProperty("channels", channels); item->setProperty("block", block); item->setProperty("peak", maximum);
                    item->setProperty("nonDefaultState", roundTrip); item->setProperty("pass", ok); cases.add(item); passed = passed && ok;
                }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Suite control/rate/block/channel matrix");
    result->setProperty("pass", passed); result->setProperty("cases", cases);
    result->setProperty("scope", "Exposed automatable control extrema, finite bounded output, non-default state recall, reset/release. Sound and performance quality diagnostic_only.");
    return result;
}

juce::var renderListeningExamples()
{
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/free-suite-05-listening");
    directory.createDirectory();
    constexpr double rate = 48000;
    constexpr int length = 48000 * 6;
    juce::AudioBuffer<float> source(2, length); source.clear();
    for (int i = 0; i < 96000; ++i)
    {
        const double time = i / rate;
        const double envelope = std::exp(-std::fmod(time, .25) * 28);
        const float sample = static_cast<float>(.2 * envelope * (std::sin(juce::MathConstants<double>::twoPi * 220 * time)
            + .4 * std::sin(juce::MathConstants<double>::twoPi * 1320 * time)));
        source.setSample(0, i, sample); source.setSample(1, i, sample * .8f);
    }
    bool passed = writeProbeWave(directory.getChildFile("source.wav"), source, rate);
    juce::Array<juce::var> manifest;
    auto render = [&](std::unique_ptr<juce::AudioProcessor> processor, const juce::String& name, bool wetOnly)
    {
        processor->setRateAndBufferSizeDetails(rate, 512); processor->prepareToPlay(rate, 512);
        juce::AudioBuffer<float> output(2, length), buffer(2, 512); juce::MidiBuffer midi;
        for (int start = 0; start < length; start += 512)
        {
            const int count = juce::jmin(512, length-start); buffer.clear(); midi.clear();
            if (processor->acceptsMidi())
            {
                for (int sample : {0, 12000, 24000, 36000, 48000, 60000})
                    if (sample >= start && sample < start + count)
                    {
                        const int note = dynamic_cast<OpenStudioDrumInstrument*>(processor.get()) ? (sample % 24000 == 0 ? 36 : 38) : 60 + (sample / 12000) % 5 * 2;
                        midi.addEvent(juce::MidiMessage::noteOn(1, note, .65f), sample - start);
                    }
                if (start <= 96000 && start + count > 96000) midi.addEvent(juce::MidiMessage::allNotesOff(1), 96000-start);
            }
            else for (int ch = 0; ch < 2; ++ch) buffer.copyFrom(ch, 0, source, ch, start, count);
            processor->processBlock(buffer, midi);
            for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, buffer, ch, 0, count);
        }
        passed = writeProbeWave(directory.getChildFile(name + ".wav"), output, rate) && passed;
        juce::MemoryBlock state; processor->getStateInformation(state); passed = directory.getChildFile(name + ".state").replaceWithData(state.getData(), state.getSize()) && passed;
        auto* item = new juce::DynamicObject(); item->setProperty("file", name + ".wav"); item->setProperty("settings", describeFreePluginForRegression(*processor));
        item->setProperty("wetOnly", wetOnly); item->setProperty("quality", "not_asserted"); manifest.add(item);
    };
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(type); processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-" + juce::String(type), true);
    }
    for(int variant=0;variant<2;++variant)
    {
        auto processor=std::make_unique<OpenStudioReverb>(true);processor->selectAlgorithm(7);processor->wetLevel.store(1);processor->dryLevel.store(0);
        auto* settings=new juce::DynamicObject();settings->setProperty("normalise",false);
        if(variant==0){settings->setProperty("lowDecay",4.0);settings->setProperty("midDecay",2.0);settings->setProperty("highDecay",.5);}
        else{settings->setProperty("eq0Gain",-6.0);settings->setProperty("eq1Gain",3.0);settings->setProperty("eq1Frequency",800.0);settings->setProperty("eq3Gain",-9.0);}
        passed=processor->convolutionSpace.edit(juce::var(settings))&&passed;
        render(std::move(processor),variant==0?"reverb-convolution-damping":"reverb-convolution-eq",true);
    }
    for (int type : {0,1,3})
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(type);
        processor->studioEngines[processor->studioSlot()].store(0); processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-" + juce::String(type) + "-legacy", true);
    }
    for (int character = -1; character < 3; ++character)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(2);
        processor->plateEngine.store(character < 0 ? 0.0f : 1.0f);
        processor->plateCharacter.store(static_cast<float>(juce::jmax(0, character)));
        processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-plate-" + (character < 0 ? juce::String("legacy") : juce::String(character)), true);
    }
    // Keep a render of the old octave path as an exact compatibility oracle,
    // alongside new dual-voice and envelope listening diagnostics.
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(5);
        processor->shimmerVoiceEngine.store(0); processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-5-legacy", true);
    }
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(5);
        processor->shimmerPitchA.store(12); processor->shimmerPitchB.store(7); processor->shimmerVoiceMix.store(.5f);
        processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-dual-fifth", true);
    }
    for (int shape = 1; shape < 6; ++shape)
    {
        auto processor = std::make_unique<OpenStudioReverb>(true); processor->selectAlgorithm(6);
        processor->nonlinearShape.store(static_cast<float>(shape)); processor->decayTime.store(.7f);
        processor->wetLevel.store(1); processor->dryLevel.store(0);
        render(std::move(processor), "reverb-envelope-" + juce::String(shape), true);
    }
    for (int model = 1; model < 7; ++model)
    {
        auto processor = std::make_unique<OpenStudioCompressor>(true); processor->selectModel(model); processor->threshold.store(-24);
        render(std::move(processor), "compressor-" + juce::String(model), false);
    }
    for (int model : { 3, 4 })
    {
        auto processor = std::make_unique<OpenStudioCompressor>(true); processor->selectModel(model); processor->threshold.store(-24);
        processor->opticalControls[static_cast<size_t>(model - 3)].engine.store(0);
        render(std::move(processor), "compressor-" + juce::String(model) + "-legacy", false);
    }
    for (int model : { 5, 6 })
    {
        auto processor = std::make_unique<OpenStudioCompressor>(true); processor->selectModel(model); processor->threshold.store(-24);
        processor->vcaControls[static_cast<size_t>(model - 5)].engine.store(0);
        render(std::move(processor), "compressor-" + juce::String(model) + "-legacy", false);
    }
    for (int variant = 0; variant < 2; ++variant)
    {
        auto processor = std::make_unique<OpenStudioCompressor>(true); processor->selectModel(2); processor->threshold.store(-24);
        if (variant == 0) processor->fetEngine.store(0); else { processor->fetRatio.store(4); processor->fetInput.store(12); processor->fetOutput.store(-6); }
        render(std::move(processor), variant == 0 ? "compressor-2-legacy" : "compressor-fet-all", false);
    }
    for (int type = 0; type < 8; ++type)
    {
        auto processor = std::make_unique<OpenStudioSaturator>(); processor->satType.store(static_cast<float>(type));
        render(std::move(processor), "saturator-" + juce::String(type), false);
    }
    for (int type = 0; type < 3; ++type)
    {
        auto processor = std::make_unique<OpenStudioChorus>(); processor->mode.store(static_cast<float>(type));
        render(std::move(processor), "modulation-" + juce::String(type), false);
    }
    {
        auto processor = std::make_unique<OpenStudioEQ>();
        setFreePluginParamForRegression(*processor, "band0.enabled", 1); setFreePluginParamForRegression(*processor, "band0.freq", 90);
        setFreePluginParamForRegression(*processor, "band7.enabled", 1); setFreePluginParamForRegression(*processor, "band7.freq", 4000);
        setFreePluginParamForRegression(*processor, "band2.gain", -4); render(std::move(processor), "eq", false);
    }
    {
        auto processor = std::make_unique<OpenStudioGate>(true); processor->threshold.store(-30); render(std::move(processor), "gate", false);
    }
    {
        auto processor = std::make_unique<OpenStudioLimiter>(true); processor->threshold.store(-18); processor->ceiling.store(-1); render(std::move(processor), "limiter", false);
    }
    {
        auto processor = std::make_unique<OpenStudioPitchCorrector>();
        setFreePluginParamForRegression(*processor, "transpose", 4); render(std::move(processor), "pitch-correct", false);
    }
    for (const auto kind : {OpenStudioUtilityEffect::Kind::Preamp, OpenStudioUtilityEffect::Kind::GraphicEQ, OpenStudioUtilityEffect::Kind::GainPhase})
    {
        auto processor = std::make_unique<OpenStudioUtilityEffect>(kind);
        if (kind == OpenStudioUtilityEffect::Kind::Preamp) { processor->setControl("drive", 18); processor->setControl("outputGain", -12); }
        if (kind == OpenStudioUtilityEffect::Kind::GraphicEQ) processor->setControl("geq3", -4);
        if (kind == OpenStudioUtilityEffect::Kind::GainPhase) processor->setControl("delayR", 16);
        const auto name = kind == OpenStudioUtilityEffect::Kind::Preamp ? "preamp" : kind == OpenStudioUtilityEffect::Kind::GraphicEQ ? "graphic-eq" : "gain-phase";
        render(std::move(processor), name, false);
    }
    {
        auto processor = std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);
        processor->setControl("drive", 18); processor->setControl("outputGain", -12); processor->setControl("toneEnabled", 1);
        processor->setControl("toneLowGain", 3); processor->setControl("toneMidGain", -4); processor->setControl("toneHighGain", 3); processor->setControl("toneHighPass", 1);
        render(std::move(processor), "preamp-tone", false);
    }
    render(std::make_unique<OpenStudioDelay>(), "delay", false);
    render(std::make_unique<OpenStudioBasicSynthInstrument>(), "synth", false);
    render(std::make_unique<OpenStudioPianoInstrument>(), "piano", false);
    render(std::make_unique<OpenStudioCleanGuitarInstrument>(), "guitar", false);
    render(std::make_unique<OpenStudioDrumInstrument>(), "drums", false);
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Listening artifacts"); result->setProperty("pass", passed);
    result->setProperty("path", directory.getFullPathName()); result->setProperty("files", manifest);
    result->setProperty("subjectiveAcceptance", "not_asserted");
    const juce::var report(result);
    directory.getChildFile("manifest.json").replaceWithText(juce::JSON::toString(report, true));
    return report;
}

bool containsHistoricalState(const juce::ValueTree& saved, const juce::ValueTree& current)
{
    if (!saved.isValid() || !current.isValid() || saved.getType() != current.getType()
        || saved.getNumChildren() != current.getNumChildren())
        return false;
    for (int i = 0; i < saved.getNumProperties(); ++i)
    {
        const auto property = saved.getPropertyName(i);
        if (!current.hasProperty(property) || saved[property] != current[property])
            return false;
    }
    for (int i = 0; i < saved.getNumChildren(); ++i)
        if (!containsHistoricalState(saved.getChild(i), current.getChild(i)))
            return false;
    return true;
}

juce::var checkProcessor(const Factory& make, const juce::File& directory, bool captureMissingFixtures)
{
    auto processor = make();
    const auto name = processor->getName();
    juce::MemoryBlock initial, recalled;
    processor->getStateInformation(initial);
    auto restored = make();
    restored->setStateInformation(initial.getData(), static_cast<int>(initial.getSize()));
    restored->getStateInformation(recalled);
    const auto initialTree = juce::ValueTree::readFromData(initial.getData(), initial.getSize());
    const auto recalledTree = juce::ValueTree::readFromData(recalled.getData(), recalled.getSize());
    const bool roundTrip = initialTree.isValid() && initialTree.isEquivalentTo(recalledTree);
    bool finite = true;
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        processor->setRateAndBufferSizeDetails(rate, 512);
        processor->prepareToPlay(rate, 512);
        juce::AudioBuffer<float> buffer(2, 512);
        juce::MidiBuffer midi;
        for (int block = 0; block < 20; ++block)
        {
            buffer.clear();
            midi.clear();
            if (processor->acceptsMidi())
            {
                if (block == 0 || block == 3)
                    midi.addEvent(juce::MidiMessage::noteOn(1, 60, 0.6f), 7);
                if (block == 8 || block == 10)
                    midi.addEvent(juce::MidiMessage::noteOff(1, 60), 11);
                if (block == 14)
                    midi.addEvent(juce::MidiMessage::allNotesOff(1), 0);
            }
            else
            {
                for (int i = 0; i < buffer.getNumSamples(); ++i)
                {
                    const auto time = static_cast<double>(block * 512 + i) / rate;
                    buffer.setSample(0, i, static_cast<float>(0.15 * std::sin(time * 1382.3)));
                    buffer.setSample(1, i, static_cast<float>(0.12 * std::sin(time * 2378.7)));
                }
            }
            processor->processBlock(buffer, midi);
            for (int ch = 0; ch < 2; ++ch)
                for (int i = 0; i < buffer.getNumSamples(); ++i)
                    finite = finite && std::isfinite(buffer.getSample(ch, i));
        }
        processor->reset();
        processor->releaseResources();
    }
    // Baseline capture is opt-in and never overwrites existing fixtures.
    bool fixturePass = true;
    if (directory != juce::File())
    {
        const auto file = directory.getChildFile(name.replaceCharacter(' ', '_') + ".state");
        if (!file.existsAsFile())
            fixturePass = captureMissingFixtures && directory.createDirectory()
                && file.replaceWithData(initial.getData(), initial.getSize());
        else
        {
            juce::MemoryBlock saved;
            fixturePass = file.loadFileAsData(saved);
            auto legacy = make();
            legacy->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
            juce::MemoryBlock after;
            legacy->getStateInformation(after);
            const auto savedTree = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
            const auto afterTree = juce::ValueTree::readFromData(after.getData(), after.getSize());
            // Include children (EQ bands, etc.), not just top-level controls.
            fixturePass = fixturePass && containsHistoricalState(savedTree, afterTree);
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", name);
    result->setProperty("schema", describeFreePluginForRegression(*processor));
    result->setProperty("stateRoundTrip", roundTrip);
    result->setProperty("historicalProperties", fixturePass);
    result->setProperty("finiteOutput", finite);
    result->setProperty("pass", roundTrip && finite && fixturePass);
    return juce::var(result);
}

juce::var checkMonoPitchSafety()
{
    OpenStudioPitchCorrector processor;
    auto layout = processor.getBusesLayout();
    layout.inputBuses.set(0, juce::AudioChannelSet::mono());
    layout.outputBuses.set(0, juce::AudioChannelSet::mono());
    bool passed = processor.setBusesLayout(layout);
    processor.mix.store(0.5f);
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        processor.setRateAndBufferSizeDetails(rate, 512);
        processor.prepareToPlay(rate, 512);
        for (const int blockSize : { 1, 32, 127, 512 })
        {
            juce::AudioBuffer<float> buffer(1, blockSize);
            juce::MidiBuffer midi;
            for (int block = 0; block < 40; ++block)
            {
                for (int i = 0; i < blockSize; ++i)
                    buffer.setSample(0, i, static_cast<float>(0.2 * std::sin(1382.3 * (block * blockSize + i) / rate)));
                processor.processBlock(buffer, midi);
                for (int i = 0; i < blockSize; ++i)
                    passed = passed && std::isfinite(buffer.getSample(0, i));
            }
        }
        processor.releaseResources();
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Pitch Correct mono buffer safety");
    result->setProperty("pass", passed);
    result->setProperty("scope", "Finite mono output at 3 sample rates and 4 block lengths; mix timing and sound quality not asserted");
    return juce::var(result);
}

juce::var checkEQEditorContract()
{
    OpenStudioEQ processor;
    const auto schema = describeFreePluginForRegression(processor);
    bool defaultsMatch = true;
    if (const auto* parameters = schema["parameters"].getArray())
    {
        for (const auto& parameter : *parameters)
            defaultsMatch = defaultsMatch
                && std::abs(static_cast<double>(parameter["value"])
                    - static_cast<double>(parameter["defaultValue"])) < 1.0e-6;
    }
    else defaultsMatch = false;

    bool bypassPass = true;
    bool metersPass = true;
    bool responsePass = true;
    bool spectrumPass = true;
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        processor.setRateAndBufferSizeDetails(rate, 512);
        processor.prepareToPlay(rate, 512);
        processor.bands[4].gain.store(9.0f);
        processor.outputGain.store(3.0f);
        processor.editorBypass.store(1.0f);
        juce::AudioBuffer<float> buffer(2, 512);
        juce::MidiBuffer midi;
        for (int block = 0; block < 40; ++block)
        {
            for (int sample = 0; sample < 512; ++sample)
            {
                const float input = static_cast<float>(0.1 * std::sin(6283.185307179586 * (block * 512 + sample) / rate));
                buffer.setSample(0, sample, input);
                buffer.setSample(1, sample, input * 0.5f);
            }
            auto dry = buffer;
            processor.processBlock(buffer, midi);
            if (block > 20)
                for (int channel = 0; channel < 2; ++channel)
                    for (int sample = 0; sample < 512; ++sample)
                        bypassPass = bypassPass && std::abs(buffer.getSample(channel, sample) - dry.getSample(channel, sample)) < 1.0e-6f;
        }
        metersPass = metersPass
            && std::abs(processor.outputPeaks[0].load() + 20.0f) < 0.1f
            && std::abs(processor.outputPeaks[1].load() + 26.0206f) < 0.1f;
        processor.editorBypass.store(0.0f);
        processor.outputGain.store(0.0f);
        processor.bands[4].gain.store(0.0f);
        for (int block = 0; block < 40; ++block) { buffer.clear(); processor.processBlock(buffer, midi); }
        const auto response = processor.getMagnitudeResponse({ 30.0f, 100.0f, 1000.0f, 10000.0f, 18000.0f });
        for (const auto db : response) responsePass = responsePass && std::abs(db) < 0.01f;
        processor.getSpectrumData();
        for (int block = 0; block < 8; ++block)
        {
            for (int sample = 0; sample < 512; ++sample)
            {
                const float tone = static_cast<float>(0.1 * std::sin(6.283185307179586 * 32.0 * (block * 512 + sample) / OpenStudioEQ::fftSize));
                buffer.setSample(0, sample, tone);
                buffer.setSample(1, sample, tone);
            }
            processor.processBlock(buffer, midi);
        }
        const auto spectrum = processor.getSpectrumData();
        spectrumPass = spectrumPass && spectrum.ready
            && std::abs(spectrum.preEQ[32] + 20.0f) < 0.1f
            && std::abs(spectrum.postEQ[32] + 20.0f) < 0.1f;
        processor.reset();
        processor.releaseResources();
    }
    processor.editorBypass.store(1.0f);
    processor.bands[0].enabled.store(1.0f);
    processor.bands[0].freq.store(83.0f);
    processor.bands[3].dynamicEnabled.store(1.0f);
    processor.bands[3].dynamicRange.store(-6.0f);
    juce::MemoryBlock state, after;
    processor.getStateInformation(state);
    OpenStudioEQ restored;
    restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    restored.getStateInformation(after);
    const bool statePass = juce::ValueTree::readFromData(state.getData(), state.getSize())
        .isEquivalentTo(juce::ValueTree::readFromData(after.getData(), after.getSize()));
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "EQ editor processing contract");
    result->setProperty("factoryDescriptorDefaults", defaultsMatch);
    result->setProperty("bypassDryParityAfterRamp", bypassPass);
    result->setProperty("stereoPeakCalibration", metersPass);
    result->setProperty("flatResponse", responsePass);
    result->setProperty("spectrumAmplitudeCalibration", spectrumPass);
    result->setProperty("nonDefaultStateRoundTrip", statePass);
    result->setProperty("pass", defaultsMatch && bypassPass && metersPass && responsePass && spectrumPass && statePass);
    result->setProperty("scope", "Three sample rates; parameter defaults, bypass, stereo peaks, flat response and non-default EQ state. Audio quality not asserted.");
    return juce::var(result);
}

juce::var checkDynamicsAndPitchTiming()
{
    bool compressorPass = true, pitchPass = true, resetPass = true, modelsPass = true;
    double pitchWetMaximumError = 0.0;
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        for (const float wet : { 0.0f, 0.5f, 1.0f })
        {
            for (const float ahead : { 0.0f, 5.0f, 20.0f })
            {
                OpenStudioCompressor compressor(true);
                compressor.mix.store(wet);
                compressor.lookaheadMs.store(ahead);
                compressor.setRateAndBufferSizeDetails(rate, 127);
                compressor.prepareToPlay(rate, 127);
                const int latency = compressor.getLatencySamples();
                compressorPass = compressorPass && latency == static_cast<int>(std::ceil(rate * 0.020));
                juce::AudioBuffer<float> block(2, 127);
                juce::MidiBuffer midi;
                for (int start = 0; start < latency + 512; start += 127)
                {
                    block.clear();
                    if (start == 0) { block.setSample(0, 0, 0.5f); block.setSample(1, 0, -0.25f); }
                    compressor.processBlock(block, midi);
                    for (int i = 0; i < 127; ++i)
                        compressorPass = compressorPass && std::abs(block.getSample(0, i) - (start + i == latency ? 0.5f : 0.0f)) < 1.0e-6f
                            && std::abs(block.getSample(1, i) - (start + i == latency ? -0.25f : 0.0f)) < 1.0e-6f;
                }
                compressor.reset();
                block.clear();
                compressor.processBlock(block, midi);
                resetPass = resetPass && block.getMagnitude(0, 127) < 1.0e-8f;
            }
            OpenStudioPitchCorrector pitch;
            pitch.mix.store(wet);
            pitch.getMapper().setCorrectionStrength(0.0f);
            pitch.setRateAndBufferSizeDetails(rate, 127);
            pitch.prepareToPlay(rate, 127);
            const int latency = pitch.getLatencySamples();
            juce::AudioBuffer<float> block(2, 127);
            juce::MidiBuffer midi;
            for (int start = 0; start < latency + 8192; start += 127)
            {
                for (int i = 0; i < 127; ++i)
                    for (int ch = 0; ch < 2; ++ch)
                        block.setSample(ch, i, static_cast<float>(0.1 * std::sin(juce::MathConstants<double>::twoPi * 220.0 * (start + i) / rate)));
                pitch.processBlock(block, midi);
                for (int i = 0; i < 127; ++i)
                {
                    const int position = start + i - latency;
                    const double expected = position < 0 ? 0.0 : 0.1 * std::sin(juce::MathConstants<double>::twoPi * 220.0 * position / rate);
                    const double error = std::abs(block.getSample(0, i) - expected);
                    if (wet == 0.0f) pitchPass = pitchPass && error < 1.0e-6;
                    else if (position > 4096) pitchWetMaximumError = juce::jmax(pitchWetMaximumError, error);
                }
            }
            pitch.reset();
            for (int i = 0; i < 100; ++i)
            {
                block.clear(); pitch.processBlock(block, midi);
                resetPass = resetPass && block.getMagnitude(0, 127) < 1.0e-6f;
            }
        }
        OpenStudioCompressor a(true), b(true);
        a.model.store(3); b.model.store(2);
        a.threshold.store(-24); b.threshold.store(-24);
        a.ratio.store(4); b.ratio.store(4);
        a.prepareToPlay(rate, 127); b.prepareToPlay(rate, 127);
        juce::AudioBuffer<float> blockA(2, 127), blockB(2, 127);
        juce::MidiBuffer midi;
        float difference = 0.0f;
        for (int block = 0; block < 100; ++block)
        {
            for (int i = 0; i < 127; ++i)
                for (int ch = 0; ch < 2; ++ch)
                {
                    const float sample = block < 50 ? static_cast<float>(0.5 * std::sin(1382.3 * (block * 127 + i) / rate)) : 0.001f;
                    blockA.setSample(ch, i, sample); blockB.setSample(ch, i, sample);
                }
            a.processBlock(blockA, midi); b.processBlock(blockB, midi);
            difference += std::abs(a.getCurrentGainReduction() - b.getCurrentGainReduction());
        }
        modelsPass = modelsPass && difference > 1.0f;
        juce::MemoryBlock saved, recalled;
        a.getStateInformation(saved);
        b.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
        b.getStateInformation(recalled);
        modelsPass = modelsPass && saved == recalled;
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Standalone dynamics and pitch timing");
    result->setProperty("compressorParallelImpulse", compressorPass);
    result->setProperty("pitchDryLatency", pitchPass);
    result->setProperty("resetSilence", resetPass);
    result->setProperty("opticalVsFetAndRecall", modelsPass);
    result->setProperty("pitchUnityWetMaximumError", pitchWetMaximumError);
    result->setProperty("pitchUnityWetParity", pitchWetMaximumError < 1.0e-5);
    result->setProperty("pass", compressorPass && pitchPass && resetPass && modelsPass && pitchWetMaximumError < 1.0e-5);
    result->setProperty("scope", "44.1/48/96 kHz, 127-sample blocks; processor timing and state only. Host PDC and subjective sound not asserted.");
    return juce::var(result);
}

juce::var checkReverbTypeState()
{
    OpenStudioReverb reverb(true);
    reverb.decayTime.store(0.8f);
    reverb.preDelay.store(7.0f);
    reverb.selectAlgorithm(1);
    reverb.decayTime.store(5.2f);
    reverb.preDelay.store(35.0f);
    reverb.selectAlgorithm(2);
    reverb.decayTime.store(2.4f);
    reverb.selectAlgorithm(0);
    bool passed = reverb.decayTime.load() == 0.8f && reverb.preDelay.load() == 7.0f;
    reverb.selectAlgorithm(1);
    passed = passed && reverb.decayTime.load() == 5.2f && reverb.preDelay.load() == 35.0f;
    reverb.wetLevel.store(0.27f); reverb.dryLevel.store(0.8f);
    reverb.selectSendMode(true);
    passed = passed && reverb.wetLevel.load() == 1.0f && reverb.dryLevel.load() == 0.0f;
    reverb.mixLock.store(1.0f);
    juce::MemoryBlock state, recalled;
    reverb.getStateInformation(state);
    OpenStudioReverb copy(true);
    copy.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    copy.getStateInformation(recalled);
    passed = passed && state == recalled;
    copy.selectSendMode(false);
    passed = passed && copy.wetLevel.load() == 0.27f && copy.dryLevel.load() == 0.8f;
    copy.selectAlgorithm(0);
    passed = passed && copy.decayTime.load() == 0.8f;
    copy.selectAlgorithm(2);
    passed = passed && copy.decayTime.load() == 2.4f;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Reverb type banks and send recall");
    result->setProperty("pass", passed);
    result->setProperty("scope", "Per-type parameter recall and binary state used by project/preset serialization. No new reverb engine or subjective qualification.");
    return juce::var(result);
}

juce::var checkUtilityAndLimiterContracts()
{
    bool delayPass = true, flatPass = true, bandPass = true, ceilingPass = true, gainPass = true;
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        OpenStudioUtilityEffect utility(OpenStudioUtilityEffect::Kind::GainPhase);
        utility.setControl("delayL", 17); utility.setControl("delayR", 53); utility.setControl("polarityR", 1);
        utility.prepareToPlay(rate, 127);
        juce::AudioBuffer<float> block(2, 127);
        juce::MidiBuffer midi;
        block.clear(); block.setSample(0, 0, 0.5f); block.setSample(1, 0, 0.5f);
        utility.processBlock(block, midi);
        for (int i = 0; i < 127; ++i)
            delayPass = delayPass && std::abs(block.getSample(0, i) - (i == 17 ? 0.5f : 0.0f)) < 1.0e-7f
                && std::abs(block.getSample(1, i) - (i == 53 ? -0.5f : 0.0f)) < 1.0e-7f;
        OpenStudioUtilityEffect graphic(OpenStudioUtilityEffect::Kind::GraphicEQ);
        graphic.prepareToPlay(rate, 127);
        double inputEnergy = 0.0, flatEnergy = 0.0, boostedEnergy = 0.0;
        for (int mode = 0; mode < 2; ++mode)
        {
            if (mode == 1) graphic.setControl("geq5", 6);
            graphic.reset();
            for (int start = 0; start < static_cast<int>(rate); start += 127)
            {
                for (int i = 0; i < 127; ++i)
                {
                    const float sample = static_cast<float>(0.1 * std::sin(juce::MathConstants<double>::twoPi * 1000.0 * (start + i) / rate));
                    block.setSample(0, i, sample); block.setSample(1, i, sample);
                    if (mode == 0 && start > rate * 0.5) inputEnergy += sample * sample;
                }
                graphic.processBlock(block, midi);
                if (start > rate * 0.5)
                    for (int i = 0; i < 127; ++i)
                    {
                        const double sample = block.getSample(0, i);
                        if (mode == 0) flatEnergy += sample * sample; else boostedEnergy += sample * sample;
                    }
            }
        }
        flatPass = flatPass && std::abs(flatEnergy / inputEnergy - 1.0) < 1.0e-5;
        bandPass = bandPass && std::abs(10.0 * std::log10(boostedEnergy / inputEnergy) - 6.0) < 0.02;
        for (const int size : { 1, 32, 127, 512 })
        {
            OpenStudioLimiter limiter(true);
            limiter.threshold.store(-12); limiter.ceiling.store(-1); limiter.truePeak.store(0);
            limiter.prepareToPlay(rate, size);
            juce::AudioBuffer<float> limited(2, size);
            const float ceiling = juce::Decibels::decibelsToGain(-1.0f);
            for (int start = 0; start < limiter.getLatencySamples() + 2048; start += size)
            {
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < size; ++i) limited.setSample(ch, i, start + i < 1024 ? 0.01f : (i % 2 ? -2.0f : 2.0f));
                limiter.processBlock(limited, midi);
                for (int i = 0; i < size; ++i)
                {
                    const float sample = limited.getSample(0, i);
                    ceilingPass = ceilingPass && std::isfinite(sample) && std::abs(sample) <= ceiling + 1.0e-6f;
                    if (start + i >= limiter.getLatencySamples() && start + i < limiter.getLatencySamples() + 127)
                        gainPass = gainPass && std::abs(sample - 0.01f * juce::Decibels::decibelsToGain(11.0f)) < 1.0e-6f;
                }
            }
        }
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Utility and limiter contracts");
    result->setProperty("sampleAccurateDelayPolarity", delayPass);
    result->setProperty("graphicFlatParity", flatPass);
    result->setProperty("graphic1kHzGain", bandPass);
    result->setProperty("limiterSampleCeiling", ceilingPass);
    result->setProperty("limiterContinuousMakeup", gainPass);
    result->setProperty("truePeakCeiling", "not_asserted");
    result->setProperty("pass", delayPass && flatPass && bandPass && ceilingPass && gainPass);
    return juce::var(result);
}


juce::var checkReconstructedLimiter()
{
    juce::Array<juce::var> cases;
    bool passed = true;
    double worst = -100;
    for (const double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
        for (const int blockSize : { 1, 127, 512 })
            for (int stimulus = 0; stimulus < 9; ++stimulus)
            {
                OpenStudioLimiter processor(true);
                processor.threshold.store(-12); processor.ceiling.store(-1);
                processor.releaseMs.store(stimulus >= 5 ? 10.0f : 100.0f);
                processor.lookaheadMs.store(stimulus % 2 ? 0.0f : 20.0f);
                processor.prepareToPlay(rate, blockSize);
                juce::dsp::Oversampling<float> measurement(2, 4,
                    juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, true);
                measurement.initProcessing(static_cast<size_t>(blockSize));
                juce::AudioBuffer<float> block(2, blockSize);
                juce::MidiBuffer midi;
                juce::Random random(4271);
                float peak = 0;
                const int inputLength = 4096;
                const int total = inputLength + processor.getLatencySamples() + 256;
                for (int start = 0; start < total; start += blockSize)
                {
                    for (int ch = 0; ch < 2; ++ch)
                        for (int i = 0; i < blockSize; ++i)
                        {
                            const int sample = start + i;
                            const double phase = juce::MathConstants<double>::twoPi * sample;
                            float value = 0;
                            if (sample < inputLength)
                            {
                                if (stimulus == 0) value = static_cast<float>(1.5 * std::sin(phase * .25 + .785398));
                                if (stimulus == 1) value = static_cast<float>(1.5 * std::sin(phase * .45 + .37));
                                if (stimulus == 2) value = random.nextFloat() * 4 - 2;
                                if (stimulus == 3) value = sample % 137 == 0 ? 3.0f : 0.0f;
                                if (stimulus == 4) value = static_cast<float>(std::sin(phase * .031) + std::sin(phase * .21) + .7 * std::sin(phase * .39));
                                if (stimulus == 5) value = static_cast<float>(2.0 * std::sin(juce::MathConstants<double>::twoPi * (.47 * sample + .0299 * sample * sample / (2.0 * inputLength)) + .785398));
                                if (stimulus == 6) value = sample % 601 < 300 ? 2.0f : -2.0f;
                                if (stimulus == 7) value = sample % 1024 < 128 ? static_cast<float>(2 * std::sin(phase * .233 + .41)) : 0;
                                if (stimulus == 8) value = static_cast<float>(2 * std::sin(phase * .497 + .63));
                            }
                            block.setSample(ch, i, ch == 0 ? value : value * -.73f);
                        }
                    processor.processBlock(block, midi);
                    const auto reconstructed = measurement.processSamplesUp(juce::dsp::AudioBlock<const float>(block));
                    for (size_t ch = 0; ch < reconstructed.getNumChannels(); ++ch)
                        for (size_t i = 0; i < reconstructed.getNumSamples(); ++i)
                        {
                            const float sample = reconstructed.getSample(static_cast<int>(ch), static_cast<int>(i));
                            passed = passed && std::isfinite(sample);
                            peak = juce::jmax(peak, std::abs(sample));
                        }
                }
                const double db = juce::Decibels::gainToDecibels(static_cast<double>(peak), -100.0);
                worst = juce::jmax(worst, db);
                const bool ceilingPass = db <= -0.99;
                passed = passed && ceilingPass;
                auto* item = new juce::DynamicObject();
                item->setProperty("rate", rate); item->setProperty("block", blockSize);
                item->setProperty("stimulus", stimulus); item->setProperty("measuredDbTP", db); item->setProperty("pass", ceilingPass);
                cases.add(juce::var(item));
            }
    OpenStudioLimiter saved(true), recalled(true);
    saved.truePeak.store(1); saved.ceiling.store(-2); saved.continuousGain.store(0);
    juce::MemoryBlock state, after; saved.getStateInformation(state);
    recalled.setStateInformation(state.getData(), static_cast<int>(state.getSize())); recalled.getStateInformation(after);
    const bool statePass = state == after;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize()); tree.removeProperty("truePeak", nullptr);
    juce::MemoryBlock legacy; juce::MemoryOutputStream stream(legacy, false); tree.writeToStream(stream);
    recalled.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    const bool legacyPass = recalled.truePeak.load() == 0;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Reconstructed limiter ceiling"); result->setProperty("pass", passed && statePass && legacyPass);
    result->setProperty("stateRoundTrip", statePass); result->setProperty("legacyDefaultsToSamplePeak", legacyPass);
    result->setProperty("worstDbTPAtMinus1Ceiling", worst); result->setProperty("cases", cases);
    result->setProperty("measurement", "Independent JUCE 16x high-quality FIR; processing detector is a separate 8-phase 48-tap windowed sinc. BS.1770 conformance and arbitrary-input proof not asserted.");
    return juce::var(result);
}

juce::var checkInstrumentArticulation()
{
    bool passed = true;
    juce::Array<juce::var> cases;
    const std::array<Factory, 4> makers { factory<OpenStudioBasicSynthInstrument>(), factory<OpenStudioPianoInstrument>(),
        factory<OpenStudioCleanGuitarInstrument>(), factory<OpenStudioDrumInstrument>() };
    for (size_t kind = 0; kind < makers.size(); ++kind)
    {
        auto processor = makers[kind](); processor->prepareToPlay(48000, 128);
        juce::AudioBuffer<float> block(2, 128); juce::MidiBuffer midi;
        const int note = kind == 3 ? 49 : 60;
        const auto render = [&] (int blocks)
        {
            double energy = 0;
            for (int n = 0; n < blocks; ++n)
            {
                block.clear(); processor->processBlock(block, midi); midi.clear();
                for (int i = 0; i < block.getNumSamples(); ++i) energy += block.getSample(0, i) * block.getSample(0, i);
            }
            return energy;
        };
        midi.addEvent(juce::MidiMessage::noteOn(1, note, .8f), 17);
        render(20);
        midi.addEvent(juce::MidiMessage::noteOn(1, note, .6f), 31);
        render(20);
        midi.addEvent(juce::MidiMessage::noteOff(1, note), 5);
        render(400);
        const double heldEnergy = render(10);
        // Guitar string allocation deliberately damps the previous string voice;
        // its second repeated strike must survive the first FIFO note-off too.
        const bool overlap = heldEnergy > (kind == 3 ? 1.0e-12 : 1.0e-7);
        midi.addEvent(juce::MidiMessage::allSoundOff(1), 0);
        const bool allSoundOff = render(2) == 0;
        bool pedal = true, reset = true, choke = true;
        if (kind != 3)
        {
            processor->reset();
            midi.addEvent(juce::MidiMessage::controllerEvent(1, 64, 127), 0);
            midi.addEvent(juce::MidiMessage::noteOn(1, note, .8f), 0); render(20);
            midi.addEvent(juce::MidiMessage::noteOff(1, note), 0); render(500);
            const double down = render(5);
            midi.addEvent(juce::MidiMessage::controllerEvent(1, 64, 0), 0); render(500);
            const double up = render(5);
            pedal = down > 1.0e-10 && up < 1.0e-12;
        }
        else
        {
            processor->reset();
            midi.addEvent(juce::MidiMessage::noteOn(1, 49, .8f), 0); render(20);
            midi.addEvent(juce::MidiMessage::aftertouchChange(1, 49, 127), 23); render(4);
            choke = render(3) == 0;
            midi.addEvent(juce::MidiMessage::noteOn(1, 46, .8f), 0); render(20);
            midi.addEvent(juce::MidiMessage::controllerEvent(1, 4, 127), 0); render(4);
            choke = choke && render(3) == 0;
        }
        midi.addEvent(juce::MidiMessage::noteOn(2, note, .8f), 0); render(20);
        processor->reset(); reset = render(2) == 0;
        midi.addEvent(juce::MidiMessage::noteOn(1, note, .8f), 0);
        midi.addEvent(juce::MidiMessage::noteOn(2, note + 2, .7f), 0); render(20);
        midi.addEvent(juce::MidiMessage::allSoundOff(1), 0);
        const bool channelIsolation = render(10) > 1.0e-7;
        midi.addEvent(juce::MidiMessage::allSoundOff(2), 0); render(2);
        // More than the voice limit: deterministic stealing must remain finite.
        for (int n = 0; n < 40; ++n) midi.addEvent(juce::MidiMessage::noteOn(1, 48 + n % 24, .8f), n);
        const double dense = render(10);
        const bool finite = std::isfinite(dense) && dense > 0;
        const bool success = overlap && allSoundOff && pedal && reset && choke && finite && channelIsolation;
        passed = passed && success;
        auto* item = new juce::DynamicObject(); item->setProperty("name", processor->getName());
        item->setProperty("repeatedNoteSurvivesFirstOff", overlap); item->setProperty("heldEnergy", heldEnergy);
        item->setProperty("sustain", pedal); item->setProperty("choke", choke); item->setProperty("allSoundOff", allSoundOff);
        item->setProperty("reset", reset); item->setProperty("channelIsolation", channelIsolation); item->setProperty("voiceStealingFinite", finite); item->setProperty("pass", success); cases.add(juce::var(item));
    }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Instrument articulation");
    result->setProperty("pass", passed); result->setProperty("cases", cases); result->setProperty("subjectiveQuality", "not_asserted");
    return juce::var(result);
}

juce::var checkAdditionalReverbs()
{
    bool passed = true;
    juce::Array<juce::var> cases;
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
        for (int algorithm = 4; algorithm <= 6; ++algorithm)
        {
            OpenStudioReverb processor(true); processor.selectAlgorithm(algorithm);
            processor.decayTime.store(.35f); processor.preDelay.store(15); processor.wetLevel.store(1); processor.dryLevel.store(0);
            processor.prepareToPlay(rate, 127);
            juce::AudioBuffer<float> block(2, 127); juce::MidiBuffer midi;
            double energy = 0, late = 0, beforePreDelay = 0; bool finite = true;
            for (int start = 0; start < static_cast<int>(rate * 1.2); start += 127)
            {
                block.clear(); if (start == 0) block.setSample(0, 0, .5f);
                processor.processBlock(block, midi);
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < 127; ++i)
                    {
                        const float sample = block.getSample(ch, i);
                        finite = finite && std::isfinite(sample) && std::abs(sample) < 1;
                        energy += sample * sample;
                        if (start + i < rate * .015) beforePreDelay += sample * sample;
                        if (start > rate) late += sample * sample;
                    }
            }
            juce::MemoryBlock state, after; processor.getStateInformation(state);
            OpenStudioReverb restored(true); restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            restored.getStateInformation(after);
            const bool statePass = state == after && restored.algorithm.load() == static_cast<float>(algorithm);
            processor.reset(); block.clear(); processor.processBlock(block, midi);
            const bool resetPass = block.getMagnitude(0, 127) == 0;
            const bool success = finite && beforePreDelay == 0 && energy > 1.0e-5 && late < 1.0e-6 && statePass && resetPass;
            passed = passed && success;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("algorithm", algorithm);
            item->setProperty("preDelaySilence", beforePreDelay == 0); item->setProperty("energy", energy); item->setProperty("lateEnergy", late); item->setProperty("finite", finite);
            item->setProperty("state", statePass); item->setProperty("reset", resetPass); item->setProperty("pass", success); cases.add(juce::var(item));
        }
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Additional reverb engines");
    result->setProperty("pass", passed); result->setProperty("cases", cases); result->setProperty("subjectiveQuality", "not_asserted");
    return juce::var(result);
}

juce::var checkCreativeRoutingAndLateDecay()
{
    using Space = BuiltInAdditionalReverbs;
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Shimmer routing and Nonlinear feedback/late decay");
    const auto render = [] (double rate, int type, Space::Settings settings, int block = 127, double seconds = 1.5)
    {
        Space space; space.prepare(rate, type);
        juce::AudioBuffer<float> audio(2, static_cast<int>(rate * seconds));
        for (int sample = 0; sample < audio.getNumSamples(); ++sample)
        {
            if (sample % block == 0) space.configure(type, settings);
            const float input = type == 5 && sample < static_cast<int>(rate * .15)
                ? .1f * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 997 * sample / rate)) : sample == 0 ? .5f : 0.0f;
            const auto wet = space.process(input, input * .7f);
            for (int ch = 0; ch < 2; ++ch) audio.setSample(ch, sample, wet[static_cast<size_t>(ch)]);
        }
        return audio;
    };
    const auto difference = [] (const auto& a, const auto& b)
    {
        double energy = 0;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i)
        { const double delta = a.getSample(ch, i) - b.getSample(ch, i); energy += delta * delta; }
        return energy;
    };
    const auto lateEnergy = [] (const auto& audio, double rate)
    {
        double energy = 0;
        for (int ch = 0; ch < 2; ++ch) for (int i = static_cast<int>(rate * .8); i < audio.getNumSamples(); ++i)
            energy += static_cast<double>(audio.getSample(ch, i)) * audio.getSample(ch, i);
        return energy;
    };
    bool passed = true, finite = true; double neutralError = 0, partitionError = 0;
    juce::Array<juce::var> cases;
    for (double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        Space::Settings settings { .3f, .5f, .3f, .5f, 0, 20, 20000, .8f, 1 };
        const auto tank = render(rate, 5, settings); settings.shimmerRoute = 1;
        const auto input = render(rate, 5, settings); settings.shimmerRoute = 2;
        const auto both = render(rate, 5, settings);
        settings.shimmer = 0;
        const auto dryBoth = render(rate, 5, settings); settings.shimmerRoute = 0;
        neutralError = juce::jmax(neutralError, difference(dryBoth, render(rate, 5, settings)));
        settings.shimmer = .8f; settings.shimmerRoute = 2;
        partitionError = juce::jmax(partitionError, difference(both, render(rate, 5, settings, 512)));
        settings.shape = 7; const auto early = render(rate, 6, settings);
        settings.nonlinearFeedback = .75f; const auto feedback = render(rate, 6, settings);
        settings.nonlinearFeedback = 0; settings.lateLevel = 1; settings.lateDecay = 3;
        const auto late = render(rate, 6, settings); settings.nonlinearDiffusion = .7f;
        const auto diffused = render(rate, 6, settings);
        partitionError = juce::jmax(partitionError, difference(diffused, render(rate, 6, settings, 512)));
        const double routeDifference = juce::jmin(difference(input, tank), difference(both, input), difference(both, tank));
        const bool tails = lateEnergy(early, rate) < 1e-12 && lateEnergy(feedback, rate) > 1e-10 && lateEnergy(late, rate) > 1e-9;
        finite = finite && ProcessorSafety::isFinite(tank) && ProcessorSafety::isFinite(input)
            && ProcessorSafety::isFinite(both) && ProcessorSafety::isFinite(feedback) && ProcessorSafety::isFinite(late);
        const bool distinct = routeDifference > 1e-6 && difference(late, diffused) > 1e-6;
        passed = passed && tails && distinct;
        auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("routeDifferenceEnergy", routeDifference);
        item->setProperty("earlyTailEnergy", lateEnergy(early, rate)); item->setProperty("feedbackTailEnergy", lateEnergy(feedback, rate));
        item->setProperty("lateTailEnergy", lateEnergy(late, rate)); item->setProperty("pass", tails && distinct); cases.add(item);
    }
    Space::Settings shapeSettings { .4f, .5f, .3f, .5f, 0, 20, 20000, 0, 1 };
    shapeSettings.shape = 6; const auto swoosh = render(48000, 6, shapeSettings);
    shapeSettings.shape = 7; const bool newShapes = difference(swoosh, render(48000, 6, shapeSettings)) > 1e-5;
    OpenStudioReverb source(true); source.selectAlgorithm(6); source.nonlinearShape.store(7);
    for (size_t i = 0; i < source.creativeControls.size(); ++i) source.creativeControls[i].store(OpenStudioReverb::creativeMax[i]);
    juce::MemoryBlock state, roundTrip; source.getStateInformation(state); OpenStudioReverb restored(true);
    restored.setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored.getStateInformation(roundTrip);
    const bool recalled = state == roundTrip && restored.nonlinearShape.load() == 7 && restored.getTailLengthSeconds() >= 100;
    auto old = juce::ValueTree::readFromData(state.getData(), state.getSize()); for (const auto* id : OpenStudioReverb::creativeIds) old.removeProperty(id, nullptr);
    juce::MemoryBlock legacy; { juce::MemoryOutputStream stream(legacy, false); old.writeToStream(stream); }
    restored.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize())); bool migrated = true, setters = true;
    for (size_t i = 0; i < source.creativeControls.size(); ++i)
    {
        migrated = migrated && restored.creativeControls[i].load() == OpenStudioReverb::creativeDefaults[i];
        setters = setters && setFreePluginParamForRegression(restored, OpenStudioReverb::creativeIds[i], OpenStudioReverb::creativeMax[i]);
    }
    const auto schema = describeFreePluginForRegression(restored); bool prefix = schema["parameters"].size() >= 491;
    for (size_t i = 0; i < source.creativeControls.size(); ++i)
        prefix = prefix && schema["parameters"][486 + static_cast<int>(i)]["id"].toString() == OpenStudioReverb::creativeIds[i];
    result->setProperty("pass", passed && finite && neutralError == 0 && partitionError < 1e-12 && newShapes && recalled && migrated && setters && prefix);
    result->setProperty("cases", cases); result->setProperty("finite", finite); result->setProperty("zeroAmountRouteParity", neutralError);
    result->setProperty("partitionErrorEnergy", partitionError); result->setProperty("newShapesDistinct", newShapes); result->setProperty("stateAndTail", recalled);
    result->setProperty("legacyNeutralDefaults", migrated); result->setProperty("setters", setters); result->setProperty("appendedDescriptors", prefix);
    result->setProperty("schema", schema); result->setProperty("audioQuality", "not_asserted"); return result;
}

juce::var checkCreativeReverbControls()
{
    bool passed = true;
    juce::Array<juce::var> pitchCases, shapeCases;
    // Frequency-selective measurements of the pitch primitive, independent of
    // the reverb tail's intentionally broad spectrum. Not an audio quality test.
    for (const double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
        for (const float semitones : { -24.0f, -12.0f, -7.0f, 0.0f, 7.0f, 12.0f, 24.0f })
        {
            BuiltInReverbPitchVoice shifter;
            shifter.prepare(rate);
            const float ratio = std::pow(2.0f, semitones / 12.0f);
            const double expected = 997.0 * std::pow(2.0, semitones / 12.0);
            std::array<double, 3> real {}, imaginary {};
            const std::array<double, 3> frequencies { expected, expected * std::pow(2.0, -1.0 / 12), expected * std::pow(2.0, 1.0 / 12) };
            const int warmup = static_cast<int>(rate * .25), count = static_cast<int>(rate * .5);
            for (int i = 0; i < warmup + count; ++i)
            {
                const float sample = shifter.process(.2f * static_cast<float>(std::sin(juce::MathConstants<double>::twoPi * 997 * i / rate)), 0, ratio)[0];
                if (i < warmup) continue;
                for (size_t bin = 0; bin < frequencies.size(); ++bin)
                {
                    const double phase = juce::MathConstants<double>::twoPi * frequencies[bin] * i / rate;
                    real[bin] += sample * std::cos(phase); imaginary[bin] += sample * std::sin(phase);
                }
            }
            std::array<double, 3> amplitude {};
            for (size_t bin = 0; bin < amplitude.size(); ++bin) amplitude[bin] = 2 * std::hypot(real[bin], imaginary[bin]) / count;
            const bool ok = amplitude[0] > .02 && amplitude[0] > 4 * juce::jmax(amplitude[1], amplitude[2]);
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("semitones", semitones);
            item->setProperty("targetHz", expected); item->setProperty("targetAmplitude", amplitude[0]); item->setProperty("pass", ok);
            pitchCases.add(item); passed = passed && ok;
        }
    for (const double rate : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        std::array<double, 6> centroids {}, energies {};
        bool finite = true;
        for (int shape = 0; shape < 6; ++shape)
        {
            BuiltInAdditionalReverbs space;
            space.prepare(rate, 6);
            BuiltInAdditionalReverbs::Settings settings { .4f, .5f, .5f, .5f, 20, 20, 20000, .5f, 1 };
            settings.shape = static_cast<float>(shape); space.configure(6, settings);
            double energy = 0, weighted = 0, before = 0, late = 0;
            for (int i = 0; i < static_cast<int>(rate * .8); ++i)
            {
                const auto output = space.process(i == 0 ? .5f : 0, 0);
                const double power = output[0] * output[0] + output[1] * output[1];
                energy += power; weighted += power * i / rate;
                if (i < rate * .02) before += power;
                if (i > rate * .6) late += power;
                finite = finite && std::isfinite(power) && power < 1;
            }
            const auto slot = static_cast<size_t>(shape);
            centroids[slot] = weighted / juce::jmax(energy, 1e-30); energies[slot] = energy;
            const bool ok = finite && before == 0 && late < 1e-8 && energy > 1e-5;
            auto* item = new juce::DynamicObject(); item->setProperty("rate", rate); item->setProperty("shape", shape);
            item->setProperty("energy", energy); item->setProperty("centroidSeconds", centroids[slot]); item->setProperty("pass", ok);
            shapeCases.add(item); passed = passed && ok;
        }
        // These are envelope behavior contracts: reverse is later than gate;
        // decay is earlier, Gaussian centered, every family audibly changes DSP.
        passed = passed && centroids[2] > centroids[1] + .08 && centroids[4] < centroids[1] - .08
            && std::abs(centroids[5] - .22) < .03 && centroids[3] > centroids[0] + .01;
        for (const auto energy : energies) passed = passed && energy / energies[0] > .9 && energy / energies[0] < 1.1;
    }

    OpenStudioReverb source(true); source.selectAlgorithm(5);
    source.shimmerPitchA.store(-12); source.shimmerPitchB.store(19); source.shimmerVoiceMix.store(.37f);
    source.selectAlgorithm(6); source.nonlinearShape.store(5); source.selectAlgorithm(5);
    juce::MemoryBlock state, after; source.getStateInformation(state);
    OpenStudioReverb restored(true); restored.setStateInformation(state.getData(), static_cast<int>(state.getSize())); restored.getStateInformation(after);
    const bool roundTrip = state == after && restored.shimmerPitchA.load() == -12 && restored.shimmerPitchB.load() == 19 && restored.shimmerVoiceMix.load() == .37f && restored.shimmerVoiceEngine.load() == 1;
    restored.selectAlgorithm(6); const bool bankRecall = restored.nonlinearShape.load() == 5;
    auto old = juce::ValueTree::readFromData(state.getData(), state.getSize());
    for (const char* property : { "shimmerPitchA", "shimmerPitchB", "shimmerVoiceMix", "nonlinearShape", "shimmerVoiceEngine" }) old.removeProperty(property, nullptr);
    for (int bank = 0; bank < 8; ++bank) for (int control = 10; control < 14; ++control)
        old.removeProperty("bank" + juce::String(bank) + "_" + juce::String(control), nullptr);
    juce::MemoryBlock legacy; { juce::MemoryOutputStream stream(legacy, false); old.writeToStream(stream); }
    restored.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    bool legacyDefaults = restored.shimmerPitchA.load() == 12 && restored.shimmerPitchB.load() == 7 && restored.shimmerVoiceMix.load() == 0 && restored.shimmerVoiceEngine.load() == 0;
    restored.selectAlgorithm(6); legacyDefaults = legacyDefaults && restored.nonlinearShape.load() == 0;
    // Inactive voice must be silent at the blend endpoint; both voice controls
    // must change the actual reverb when their contribution is selected.
    const auto render = [](float a, float b, float blend, int blockSize)
    {
        OpenStudioReverb processor(true); processor.selectAlgorithm(5);
        processor.shimmerPitchA.store(a); processor.shimmerPitchB.store(b); processor.shimmerVoiceMix.store(blend);
        processor.shimmerAmount.store(1); processor.wetLevel.store(1); processor.dryLevel.store(0);
        processor.prepareToPlay(48000, blockSize);
        std::vector<float> output(48000);
        juce::AudioBuffer<float> block(2, blockSize); juce::MidiBuffer midi;
        for (int start = 0; start < 48000; start += blockSize)
        {
            const int count = juce::jmin(blockSize, 48000 - start); block.clear();
            for (int i = 0; i < count; ++i) if (start + i < 4800)
                block.setSample(0, i, .1f * std::sin(juce::MathConstants<float>::twoPi * 997 * static_cast<float>(start + i) / 48000));
            processor.processBlock(block, midi);
            for (int i = 0; i < count; ++i) output[static_cast<size_t>(start + i)] = block.getSample(0, i);
        }
        return output;
    };
    const auto difference = [](const auto& a, const auto& b)
    {
        double energy = 0;
        for (size_t i = 0; i < a.size(); ++i) { const double delta = a[i] - b[i]; energy += delta * delta; }
        return energy;
    };
    const auto baseline = render(12, 7, 0, 127);
    const bool voices = difference(baseline, render(12, -12, 0, 127)) == 0
        && difference(baseline, render(-12, 7, 0, 127)) > 1e-5
        && difference(render(12, 7, 1, 127), render(12, -12, 1, 127)) > 1e-5;
    const bool blockParity = difference(baseline, render(12, 7, 0, 1)) < 1e-10 && difference(baseline, render(12, 7, 0, 512)) < 1e-10;
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Creative reverb pitches, envelopes and migration");
    result->setProperty("pass", passed && roundTrip && bankRecall && legacyDefaults && voices && blockParity);
    result->setProperty("pitchCases", pitchCases); result->setProperty("shapeCases", shapeCases);
    result->setProperty("stateRoundTrip", roundTrip); result->setProperty("bankRecall", bankRecall); result->setProperty("legacyDefaults", legacyDefaults);
    result->setProperty("independentVoices", voices); result->setProperty("blockParity", blockParity); result->setProperty("audioQuality", "not_asserted");
    return result;
}

juce::var checkPitchTelemetryPublication()
{
    OpenStudioPitchCorrector processor;
    processor.setRateAndBufferSizeDetails(48000.0, 512);
    processor.prepareToPlay(48000.0, 512);
    std::atomic<bool> stop { false };
    std::atomic<bool> valid { processor.getPitchHistory(-1).empty() };
    std::atomic<int> reads { 0 };
    std::thread reader([&]
    {
        while (!stop.load())
        {
            const auto frames = processor.getPitchHistory(1024);
            if (frames.size() != 512) valid.store(false);
            for (const auto& frame : frames)
                if (!std::isfinite(frame.detectedMidi) || !std::isfinite(frame.correctedMidi)
                    || !std::isfinite(frame.confidence) || frame.confidence < 0.0f || frame.confidence > 1.0f)
                    valid.store(false);
            const auto latest = processor.getCurrentPitchData();
            if (!std::isfinite(latest.detectedHz) || !std::isfinite(latest.correctedHz)) valid.store(false);
            reads.fetch_add(1);
            std::this_thread::yield();
        }
    });
    juce::AudioBuffer<float> buffer(2, 512);
    juce::MidiBuffer midi;
    for (int block = 0; block < 600; ++block)
    {
        for (int sample = 0; sample < 512; ++sample)
            for (int channel = 0; channel < 2; ++channel)
                buffer.setSample(channel, sample, static_cast<float>(0.1 * std::sin(1382.3 * (block * 512 + sample) / 48000.0)));
        processor.processBlock(buffer, midi);
    }
    stop.store(true);
    reader.join();
    processor.releaseResources();
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Pitch telemetry publication");
    result->setProperty("pass", valid.load() && reads.load() > 0);
    result->setProperty("concurrentReads", reads.load());
    result->setProperty("scope", "Bounded reads and finite data during ring wrap; not a thread-sanitizer or audio-quality verdict");
    return juce::var(result);
}
}

juce::var runFreePluginRegression(const juce::File& fixtureDirectory, bool captureMissingFixtures, const juce::String& selectedCase)
{
    juce::Array<juce::var> results;
    if (selectedCase.isNotEmpty())
    {
        const std::map<juce::String, std::function<juce::var()>> focused {
            {"plugin-discovery-identities", PluginManager::runDiscoveryIdentityRegression},
            {"low-rate-channel-safety", checkLowRateChannelSafety},
            {"automation-registry", checkFreePluginAutomationRegistry},
            {"mute-point-timing", checkTrackMutePointTiming},
            {"send-automation", checkSendAutomation},
            {"fallback-automation", checkFallbackAutomation},
            {"jsfx-automation", checkJSFXAutomation},
            {"clap-automation", runOpenStudioCLAPAutomationRegression},
            {"vst3-sample-queues", checkVST3SampleQueues},
            {"stage-automation", [] { auto engine = std::make_unique<AudioEngine>(); engine->getDeviceManager().closeAudioDevice(); return engine->runFXStageAutomationRegression(); }},
            {"automation-trim", [] { auto engine = std::make_unique<AudioEngine>(); return engine->runAutomationTrimRegression(); }},
            {"offline-mutation-dispatch", checkOfflineMutationDispatch},
            {"automation-preview", [] { auto engine = std::make_unique<AudioEngine>(); return engine->runAutomationPreviewRegression(); }},
            {"vendor-automation", checkVendorAutomationRegistry},
            {"vendor-render-diagnostic", checkVendorRenderDiagnostic},
            {"guitar-performance", checkGuitarPerformanceTelemetry}, {"original-colour-spectra", checkOriginalColourSpectra}, {"original-colour", checkOriginalColourStages}, {"gate-expansion", checkGateExpansion}, {"pitch-source-confidence", checkPitchSourceConfidence}, {"delay-timing-telemetry", checkDelayTimingTelemetry}, {"humanize-sustained", checkSustainedHumanize}, {"gate-onset", checkGateOnsetQualification}, {"instrument-performance", checkInstrumentPerformanceTelemetry}, {"instrument-tails", checkInstrumentReleaseTails}, {"performance", measureFreePluginPerformance}, {"drum-multi-output", checkDrumMultiOutputs}, {"convolution-outputs", checkConvolutionOutputs},
            {"delay-diffusion", checkDelayDiffusion}, {"midi-multiplicity", checkMIDINoteMultiplicity}, {"eq-shapes", checkExtendedEQShapes}, {"limiter-oversampling", checkLimiterOversampling}, {"macro-cc", checkMacroCCMapping}, {"midi-channel-mix", checkMIDIChannelMix}, {"instrument-preview", checkPreviewOwnership}, {"sostenuto-receivers", checkSynthGuitarSostenuto}, {"eq-draft", checkEQDraftPreview}, {"eq-draft-update", checkEQDraftUpdates}, {"reverb-response", checkRenderedReverbResponse}, {"retro-reverb", checkRetroReverb}, {"clear-reverb", checkClearReverb}, {"studio-filters", checkStudioDecayFilters}, {"plate-filters", checkPlateDecayFilters}, {"modal-material", checkModalPlateMaterial}, {"limiter-strategies", checkLimiterStrategies}, {"limiter-responses", checkLimiterResponses}, {"drum-articulations", checkDrumArticulations}, {"drum-pieces", checkDrumPieceControls}, {"nonlinear-motion", checkNonlinearMotion}, {"vca-monitor", checkVCANoiseMonitor}, {"fet-multi", checkFETMultiButtons}, {"fet-tilt", checkFETDetectorTilt}, {"drifting-reverb", checkDriftingReverb}, {"midi-history", checkMIDIControllerHistory}, {"eq-linear-dynamics", checkLinearBandDynamics}, {"eq-spectral", checkSpectralEQ}, {"midi-seek-state", checkMIDISeekState}, {"vintage-build-up", checkVintageBuildUp}, {"performance-stress", measureFreeSuiteStress}, {"pitch-cost-parity", checkPitchBoundedLagParity}, {"alignment-continuous", checkContinuousAlignment}, {"editor-schemas", describeSuiteEditors}, {"eq-prepared-programs", checkEQPreparedPrograms}, {"eq-midi-programs", checkEQMIDIPrograms}, {"positioned-hold", checkPositionedHold}, {"nonlinear-hold", checkNonlinearHold}, {"magnetic-hold", checkMagneticHold}, {"spring-hold", checkSpringHold}, {"ten-hour-listening", renderTenHourListeningExamples}, {"midi-output-policy", checkMIDIOutputPolicy}, {"midi-output-queue", TrackProcessor::runMIDIOutputQueueRegression}, {"relative-rpn", checkRelativeRPN}, {"midi-overlap-order", checkOverlappingMIDIOrder}, {"reverb-peak-hold", checkReverbPeakHold}, {"reverb-reconstructed-peaks", checkReverbReconstructedPeaks}, {"eq-mixed-sketch", checkMixedEQSketch}, {"eq-sketch", checkEQSketch}, {"spatial-shelf", checkSpatialShelf}, {"compact-room", checkCompactStudioRoom}, {"convolution-extension", checkConvolutionExtension}, {"ir-preparation", checkIRPreparationCancellation}, {"guitar-loop", checkGuitarPluckedLoop}, {"coupled-bodies", checkCoupledInstrumentBodies}, {"guitar-articulations", checkGuitarArticulations}, {"synth-destinations", checkSynthDestinations}, {"synth-expanded-matrix", checkExpandedSynthMatrix}, {"synth-oscillators", checkSynthOscillatorShapes}, {"ir-source-blend", checkIRSourceBlend}, {"ir-brightness", checkIRBrightness}, {"spatial-reverb", checkSpatialReverbs}, {"spatial-long-delay", checkSpatialLongDelay}, {"modal-plate", checkModalPlate}, {"reverb-long-predelay", checkLongReverbPredelay}, {"vintage-tank-rate", checkVintageTankRate}, {"vintage-conversion", checkVintageConversion}, {"alignment-groups", checkAlignmentGroups}, {"ir-direct-geometry", checkIRDirectGeometry}, {"ir-octaves", checkOctaveIRAnalysis}, {"alignment-project-span", checkProjectSpanAlignment}, {"alignment-sparse", checkSparseAlignment}, {"alignment-sections", checkAlignmentSections}, {"spectral-phase", checkSpectralPhaseAlignment}, {"phase-fit", checkAllPassFitting}, {"alignment-time", checkAutomaticAlignment}, {"alignment-linked", checkLinkedStereoAlignment}, {"convolution-motion", checkConvolutionMotion}, {"automation-ranges", checkFreePluginAutomationRanges}, {"reverb-spillover", checkReverbSpillover}, {"reverb-hold", checkReverbHoldPolicies}, {"eq-adaptive", checkEQAdaptiveDynamics}, {"eq-draft-modes", checkEQDraftProcessingModes}, {"eq-analog-target", checkAnalogTargetEQ}, {"eq-minimum-fir", checkMinimumPhaseEQ}, {"eq-cuts", checkAdvancedEQCuts}, {"eq-detectors", checkEQBandDetectors}, {"eq-phase", checkLinearPhaseEQ},
            {"eq-analyzer", checkEQAnalyzerResolution}, {"external-detectors", checkExternalDetectors},
            {"mpe", checkSynthMPE}, {"creative-routing", checkCreativeRoutingAndLateDecay}
        };
        const auto found = focused.find(selectedCase);
        if (found != focused.end()) results.add(found->second());
        auto* root = new juce::DynamicObject();
        root->setProperty("overallPass", !results.isEmpty() && static_cast<bool>(results[0]["pass"]));
        root->setProperty("checks", results); root->setProperty("selectedCase", selectedCase);
        root->setProperty("scope", "Selected regression group only; full-suite result is not asserted");
        root->setProperty("audioQuality", "not_asserted");
        if (found == focused.end()) root->setProperty("error", "Unknown regression case");
        return root;
    }
    const std::vector<Factory> factories {
        factory<OpenStudioEQ>(), [] { return std::make_unique<OpenStudioCompressor>(true); }, [] { return std::make_unique<OpenStudioGate>(true); },
        [] { return std::make_unique<OpenStudioLimiter>(true); }, [] { return std::make_unique<OpenStudioDelay>(24.1f,true); }, [] { return std::make_unique<OpenStudioReverb>(true); },
        factory<OpenStudioChorus>(), factory<OpenStudioSaturator>(), factory<OpenStudioPitchCorrector>(),
        factory<OpenStudioBasicSynthInstrument>(), factory<OpenStudioPianoInstrument>(),
        factory<OpenStudioDrumInstrument>(), factory<OpenStudioCleanGuitarInstrument>()
    };
    bool passed = true;
    for (const auto& make : factories)
    {
        auto result = checkProcessor(make, fixtureDirectory, captureMissingFixtures);
        passed = passed && static_cast<bool>(result["pass"]);
        results.add(result);
    }
    auto matrixFactories = factories;
    for (const auto kind : { OpenStudioUtilityEffect::Kind::Preamp, OpenStudioUtilityEffect::Kind::GraphicEQ, OpenStudioUtilityEffect::Kind::GainPhase })
        matrixFactories.push_back([kind] { return std::make_unique<OpenStudioUtilityEffect>(kind); });
    for (const auto& result : { checkSuiteControlMatrix(matrixFactories), renderListeningExamples() })
    {
        passed = passed && static_cast<bool>(result["pass"]); results.add(result);
    }
    const auto monoPitch = checkMonoPitchSafety();
    passed = passed && static_cast<bool>(monoPitch["pass"]);
    results.add(monoPitch);
    const auto lowRateChannels = checkLowRateChannelSafety();
    passed = passed && static_cast<bool>(lowRateChannels["pass"]);
    results.add(lowRateChannels);
    const auto discoveryIdentities = PluginManager::runDiscoveryIdentityRegression();
    passed = passed && static_cast<bool>(discoveryIdentities["pass"]);
    results.add(discoveryIdentities);
    const auto eqContract = checkEQEditorContract();
    passed = passed && static_cast<bool>(eqContract["pass"]);
    results.add(eqContract);
    const auto pitchTelemetry = checkPitchTelemetryPublication();
    passed = passed && static_cast<bool>(pitchTelemetry["pass"]);
    results.add(pitchTelemetry);
    const auto dynamicsTiming = checkDynamicsAndPitchTiming();
    passed = passed && static_cast<bool>(dynamicsTiming["pass"]);
    results.add(dynamicsTiming);
    for (const auto kind : { OpenStudioUtilityEffect::Kind::Preamp, OpenStudioUtilityEffect::Kind::GraphicEQ, OpenStudioUtilityEffect::Kind::GainPhase })
    {
        const auto result = checkProcessor([kind] { return std::make_unique<OpenStudioUtilityEffect>(kind); }, {}, false);
        passed = passed && static_cast<bool>(result["pass"]);
        results.add(result);
    }
    const auto utilityContracts = checkUtilityAndLimiterContracts();
    passed = passed && static_cast<bool>(utilityContracts["pass"]);
    results.add(utilityContracts);
    const auto reverbBanks = checkReverbTypeState();
    passed = passed && static_cast<bool>(reverbBanks["pass"]);
    results.add(reverbBanks);
    for (const auto& result : { checkGuitarPerformanceTelemetry(), checkOriginalColourSpectra(), checkOriginalColourStages(), checkDelayTimingTelemetry(), checkInstrumentPerformanceTelemetry(), checkSustainedHumanize(), checkGateOnsetQualification(), checkInstrumentReleaseTails(), checkConvolutionOutputs(), checkDrumMultiOutputs(), checkReconstructedLimiter(), checkInstrumentArticulation(), checkAdditionalReverbs(), checkCreativeReverbControls(), checkCreativeRoutingAndLateDecay(), checkReverbHoldPolicies(), checkReverbSpillover(), checkFreePluginAutomationRanges(), checkConvolutionMotion(), checkStudioPlate(), checkStudioSpaces(), checkVintageSpaces(), checkVintageBassDecay(), checkVintageConversion(), checkVintageTankRate(), checkLongReverbPredelay(), checkModalPlate(), checkSpatialLongDelay(), checkIRBrightness(), checkIRSourceBlend(), checkPreampTone(), checkPreampReferenceAndMeters(), checkFETWorkflow(), checkFETDetectorTilt(), checkFETMultiButtons(), checkVCANoiseMonitor(), checkNonlinearMotion(), checkOpticalWorkflow(), checkVCAWorkflow(), checkGraphicEQWorkflow(), checkManualPhaseAlignment(), checkSpectralPhaseAlignment(), checkExpandedEQ(), checkLinearPhaseEQ(), checkEQBandDetectors(), checkAdvancedEQCuts(), checkMinimumPhaseEQ(), checkAnalogTargetEQ(), checkEQDraftProcessingModes(), checkEQAdaptiveDynamics(), checkSpectralEQ(), checkLinearBandDynamics(), checkExtendedEQShapes(), checkLimiterOversampling(), checkIntegratedLoudness(), checkLimiterResponses(), checkLimiterStrategies(), checkLimiterGainWorkflow(), checkSaturationColour(), checkSpatialReverbs(), checkPlateColour(), checkEchoRooms(), checkAmbientSpaces(), checkDispersiveSpring(), checkSpringHold(), checkMagneticHold(), checkNonlinearHold(), checkPositionedHold(), checkEQMIDIPrograms(), checkEQPreparedPrograms(), checkContinuousAlignment(), checkPitchBoundedLagParity(), checkAutomaticAlignment(), checkLinkedStereoAlignment(), checkAllPassFitting(), checkAlignmentSections(), checkSparseAlignment(), checkProjectSpanAlignment(), checkAlignmentGroups(), checkEQMatching(), checkGateExpansion(), checkStandaloneDelayModes(), checkDelayDiffusion(), checkSynthFilterModulation(), checkSynthIndependentEnvelope(), checkSynthModulationMatrix(), checkSynthMPE(), checkSynthOscillatorShapes(), checkExpandedSynthMatrix(), checkSynthDestinations(), checkGuitarArticulations(), checkCoupledInstrumentBodies(), checkIRPreparationCancellation(), checkConvolutionExtension(), checkCompactStudioRoom(), checkSpatialShelf(), checkEQSketch(), checkMixedEQSketch(), checkReverbPeakHold(), checkReverbReconstructedPeaks(), checkMIDISeekState(), checkMIDIControllerHistory(), checkMIDINoteMultiplicity(), checkVintageBuildUp(), checkDriftingReverb(), checkClearReverb(), checkRetroReverb(), checkStudioDecayFilters(), checkPlateDecayFilters(), checkModalPlateMaterial(), checkRenderedReverbResponse(), checkEQDraftPreview(), checkEQDraftUpdates(), checkSynthGuitarSostenuto(), checkMacroCCMapping(), checkMIDIChannelMix(), checkMIDIOutputPolicy(), TrackProcessor::runMIDIOutputQueueRegression(), checkRelativeRPN(), checkOverlappingMIDIOrder(), checkPitchSourceConfidence(), checkPianoExpressivePerformance(), checkDrumPieceControls(), checkDrumArticulations(), checkGuitarPluckedLoop(), checkChorusSyncAndModes(), checkReverbWorkflow(), checkReverbScheduling(), checkPortableConvolution(), checkMatrixConvolution(), checkConvolutionColour(), checkConvolutionCrossTerms(), checkCompressorAverageMeter(), checkOutputMeters(), checkIRAudition(), checkIRDecayEstimate(), checkIRBandDecayEstimate(), checkOctaveIRAnalysis(), checkIRDirectGeometry(), checkEQAnalyzerResolution(), checkReverbLevelReadouts(), checkExternalDetectors(), checkPreviewOwnership(), checkModelMemoryAndHost() })
    {
        passed = passed && static_cast<bool>(result["pass"]);
        results.add(result);
    }
    auto* root = new juce::DynamicObject();
    root->setProperty("overallPass", passed);
    root->setProperty("checks", results);
    root->setProperty("audioQuality", "not_asserted");
    root->setProperty("scope", "Default-state round trip, legacy property recall and finite stereo output; not sonic equivalence");
    return juce::var(root);
}
