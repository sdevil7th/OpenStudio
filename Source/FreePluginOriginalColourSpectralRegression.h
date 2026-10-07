#pragma once

inline juce::var checkOriginalColourSpectra()
{
    constexpr double rate = 48000.0;
    constexpr int blockSize = 256, length = 33600, start = 24000, analysisLength = length-start;
    // Actual production paths use prepared16x resampling. The independent
    // offline comparison runs the same original stage laws at64x; this is
    // an anti-alias diagnostic oracle, not a licensed/reference processor.
    const auto render = [=](BuiltInOriginalColour::Profile profile, int stages, int signal, double inputGain, double outputGain, double amplitude, double headroomDb = 0, double referenceDb = 0)
    {
        const auto inputSample = [=](int sample)
        {
            const double t=sample/rate;
            return amplitude*(signal==1?.5*(std::sin(juce::MathConstants<double>::twoPi*60*t)+std::sin(juce::MathConstants<double>::twoPi*7000*t))
                :std::sin(juce::MathConstants<double>::twoPi*(signal==2?6170:1000)*t));
        };
        if(profile==BuiltInOriginalColour::Preamp&&stages==BuiltInOversampledColour::oversamplingStages)
        {
            // This row uses the actual production preamp, including its FIR
            // resampler, intermediate DC blocker and float gain staging.
            auto processor=std::make_unique<OpenStudioUtilityEffect>(OpenStudioUtilityEffect::Kind::Preamp);
            processor->setControl("audioCharacter",1);processor->setControl("colour",1);
            processor->setControl("headroom",static_cast<float>(headroomDb));processor->setControl("saturationReference",static_cast<float>(referenceDb));
            processor->setControl("drive",static_cast<float>(juce::Decibels::gainToDecibels(inputGain)));
            processor->setControl("outputDrive",static_cast<float>(juce::Decibels::gainToDecibels(outputGain)));
            processor->prepareToPlay(rate,blockSize);
            juce::AudioBuffer<float> audio(2,blockSize);juce::MidiBuffer midi;std::vector<float> result;result.reserve(length);
            for(int position=0;position<length;position+=blockSize)
            {
                const int count=juce::jmin(blockSize,length-position);audio.setSize(2,count,false,false,true);
                for(int i=0;i<count;++i)for(int ch=0;ch<2;++ch)audio.setSample(ch,i,static_cast<float>(inputSample(position+i)));
                processor->processBlock(audio,midi);result.insert(result.end(),audio.getReadPointer(0),audio.getReadPointer(0)+count);
            }
            return result;
        }
        const double headroomGain=juce::Decibels::decibelsToGain(-headroomDb-referenceDb);
        if(stages==BuiltInOversampledColour::oversamplingStages)
        {
            BuiltInOversampledColour processor;processor.prepare(rate,profile);
            std::vector<float> result;result.reserve(length);
            for(int i=0;i<length;++i)result.push_back(processor.process({inputSample(i),inputSample(i)},
                {inputGain,inputGain},{1,1},{outputGain,outputGain},headroomGain)[0]);
            return result;
        }
        juce::dsp::Oversampling<float> resampler(1);resampler.clearOversamplingStages();
        for(int i=0;i<stages;++i)resampler.addOversamplingStage(juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
            i==0?.06f:.12f,i==0?-100.0f:-90.0f,i==0?.06f:.12f,i==0?-100.0f:-90.0f);
        resampler.setUsingIntegerLatency(true);resampler.initProcessing(blockSize);
        BuiltInOriginalColour core;core.prepare(rate*static_cast<double>(1<<stages),profile);
        float dcInput=0,dcOutput=0;
        const float dcCoefficient=static_cast<float>(std::exp(-juce::MathConstants<double>::twoPi*5/(rate*(1<<stages))));
        juce::AudioBuffer<float> buffer(1,blockSize);std::vector<float> result;result.reserve(length);
        for(int position=0;position<length;position+=blockSize)
        {
            const int count=juce::jmin(blockSize,length-position);buffer.setSize(1,count,false,false,true);
            for(int i=0;i<count;++i)
            {
                buffer.setSample(0,i,static_cast<float>(inputSample(position+i)));
            }
            juce::dsp::AudioBlock<float> block(buffer);auto up=resampler.processSamplesUp(block);
            for(size_t i=0;i<up.getNumSamples();++i)
            {
                double amplified=core.input(up.getSample(0,static_cast<int>(i))*inputGain*headroomGain);
                if(profile==BuiltInOriginalColour::Preamp)
                {
                    const float coloured=static_cast<float>(amplified);
                    const float filtered=coloured-dcInput+dcCoefficient*dcOutput;dcInput=coloured;dcOutput=filtered;amplified=filtered;
                }
                up.setSample(0,static_cast<int>(i),static_cast<float>(core.output(amplified*outputGain)/headroomGain));
            }
            resampler.processSamplesDown(block);
            result.insert(result.end(),buffer.getReadPointer(0),buffer.getReadPointer(0)+count);
        }
        return result;
    };
    const auto magnitude = [=](const std::vector<float>& samples,double frequency)
    {
        double real=0,imaginary=0;
        const double step=juce::MathConstants<double>::twoPi*frequency/rate,rotationReal=std::cos(step),rotationImaginary=std::sin(step);
        double oscillatorReal=std::cos(step*start),oscillatorImaginary=std::sin(step*start);
        for(int i=start;i<length;++i)
        {
            real+=samples[static_cast<size_t>(i)]*oscillatorReal;imaginary-=samples[static_cast<size_t>(i)]*oscillatorImaginary;
            const double next=oscillatorReal*rotationReal-oscillatorImaginary*rotationImaginary;
            oscillatorImaginary=oscillatorImaginary*rotationReal+oscillatorReal*rotationImaginary;oscillatorReal=next;
        }
        return std::sqrt(real*real+imaginary*imaginary)*2/analysisLength;
    };
    bool finite=true,smallSignal=true,stagesDistinct=true,aliasBins=true,highDriveAlias=true;
    constexpr int productionStages=BuiltInOversampledColour::oversamplingStages, oracleStages=6;
    std::vector<double> aliasFrequencies {730,4710,7630,11610,13070};
    // Cover newly folded even and odd harmonics around the first two multiples
    // of the production sample rate, as well as the historical4x failure bins.
    // Every measured bin is a6170Hz harmonic folded into base-rate Nyquist.
    for(int multiple=1;multiple<=2;++multiple)
    {
        const double centre=multiple*rate*BuiltInOversampledColour::oversamplingFactor;
        for(int harmonic=static_cast<int>(std::ceil((centre-rate*.5)/6170));harmonic<=(centre+rate*.5)/6170;++harmonic)
        {
            const double residual=std::fmod(harmonic*6170.0,rate),fold=juce::jmin(residual,rate-residual);
            if(fold>0&&fold!=6170&&fold!=12340&&fold!=18510&&std::find(aliasFrequencies.begin(),aliasFrequencies.end(),fold)==aliasFrequencies.end())aliasFrequencies.push_back(fold);
        }
    }
    juce::Array<juce::var> rows;
    for(int kind=0;kind<6;++kind)
    {
        const auto profile=static_cast<BuiltInOriginalColour::Profile>(kind);
        const auto quiet=render(profile,productionStages,0,1,1,.0001);
        const double gainDb=juce::Decibels::gainToDecibels(magnitude(quiet,1000)/.0001,-180.0);
        smallSignal=smallSignal&&std::abs(gainDb)<.05;
        const auto input=render(profile,productionStages,0,4,1,.15),output=render(profile,productionStages,0,1,4,.15);
        double stageError=0;
        for(int i=start;i<length;++i)stageError=juce::jmax(stageError,std::abs(static_cast<double>(input[static_cast<size_t>(i)]-output[static_cast<size_t>(i)]))/4);
        stagesDistinct=stagesDistinct&&stageError>1.0e-6;
        const auto imd=render(profile,productionStages,1,1,1,.65);
        juce::Array<juce::var> imdBins;
        for(double frequency:{60.0,7000.0,6880.0,6940.0,7060.0,7120.0})
        {
            auto* bin=new juce::DynamicObject();bin->setProperty("frequencyHz",frequency);bin->setProperty("dbFS",juce::Decibels::gainToDecibels(magnitude(imd,frequency),-180.0));imdBins.add(juce::var(bin));
        }
        const auto aliasProduction=render(profile,productionStages,2,1,1,.65),aliasOracle=render(profile,oracleStages,2,1,1,.65);
        juce::Array<juce::var> aliasMeasurements;
        for(double frequency:aliasFrequencies)
        {
            const double four=juce::Decibels::gainToDecibels(magnitude(aliasProduction,frequency),-180.0);
            const double reference=juce::Decibels::gainToDecibels(magnitude(aliasOracle,frequency),-180.0);
            aliasBins=aliasBins&&four<=-80&&reference<=-80;
            auto* bin=new juce::DynamicObject();bin->setProperty("frequencyHz",frequency);bin->setProperty("production16xDbFS",four);bin->setProperty("oracle64xDbFS",reference);aliasMeasurements.add(juce::var(bin));
        }
        juce::Array<juce::var> highDrive;
        for(double driveDb:{12.0,24.0})for(bool atOutput:{false,true})
        {
            const double drive=juce::Decibels::decibelsToGain(driveDb);
            const auto driven=render(profile,productionStages,2,atOutput?1:drive,atOutput?drive:1,.65);
            double largest=0;for(double frequency:aliasFrequencies)largest=juce::jmax(largest,magnitude(driven,frequency));
            const auto oracle=render(profile,oracleStages,2,atOutput?1:drive,atOutput?drive:1,.65);
            double oracleLargest=0;for(double frequency:aliasFrequencies)oracleLargest=juce::jmax(oracleLargest,magnitude(oracle,frequency));
            const bool passed=largest<=1.0e-4&&oracleLargest<=1.0e-4;highDriveAlias=highDriveAlias&&passed;
            auto* measure=new juce::DynamicObject();measure->setProperty("driveDb",driveDb);measure->setProperty("stage",atOutput?"Output":"Input");measure->setProperty("maximumSelectedAliasDbFS",juce::Decibels::gainToDecibels(largest,-180.0));measure->setProperty("oracleMaximumSelectedAliasDbFS",juce::Decibels::gainToDecibels(oracleLargest,-180.0));measure->setProperty("pass",passed);highDrive.add(juce::var(measure));
            for(float value:driven)finite=finite&&std::isfinite(value);
        }
        juce::Array<juce::var> limits;
        for(bool atOutput:{false,true})
        {
            // Parameter extremes remain visible even when far outside the
            // qualified nominal-headroom drive range. They are never silently
            // covered by the bounded12/24dB single-tone pass above.
            const double maximumDb=atOutput?(kind==0?24.0:40.0):36.0,referenceDb=kind==0?-24.0:0;
            const double gain=juce::Decibels::decibelsToGain(maximumDb);
            const auto extreme=render(profile,productionStages,2,atOutput?1:gain,atOutput?gain:1,.65,-12,referenceDb);
            double largest=0;for(double frequency:aliasFrequencies)largest=juce::jmax(largest,magnitude(extreme,frequency));
            auto* limit=new juce::DynamicObject();limit->setProperty("stage",atOutput?"Output":"Input");limit->setProperty("driveDb",maximumDb);limit->setProperty("headroomDb",-12);limit->setProperty("referenceDb",referenceDb);limit->setProperty("maximumSelectedAliasDbFS",juce::Decibels::gainToDecibels(largest,-180.0));limit->setProperty("status","diagnostic_only");limits.add(juce::var(limit));
            for(float value:extreme)finite=finite&&std::isfinite(value);
        }
        for(const auto* samples:{&quiet,&input,&output,&imd,&aliasProduction,&aliasOracle})for(float value:*samples)finite=finite&&std::isfinite(value);
        auto* row=new juce::DynamicObject();row->setProperty("profile",kind);row->setProperty("pipeline",kind==0?"Actual production Preamp16xFIR;64xFIR core oracle":"Actual compressor amplifier wrapper16xFIR;64xFIR core oracle; dynamics disabled");row->setProperty("smallSignalGainDb",gainDb);row->setProperty("inputVsOutputMatchedGainDifference",stageError);row->setProperty("imdDiagnostic",imdBins);row->setProperty("aliasBins",aliasMeasurements);row->setProperty("highDriveAliasQualification",highDrive);row->setProperty("extremeControlDiagnostics",limits);rows.add(juce::var(row));
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Original amplifier spectral qualification");
    result->setProperty("pass",finite&&smallSignal&&stagesDistinct&&aliasBins&&highDriveAlias);result->setProperty("finite",finite);result->setProperty("smallSignalGainWithin0_05dB",smallSignal);result->setProperty("independentInputOutputStages",stagesDistinct);result->setProperty("selectedAliasBinsBelowMinus80dBFS",aliasBins);result->setProperty("highDriveSelectedAliasBinsBelowMinus80dBFS",highDriveAlias);result->setProperty("cases",rows);
    result->setProperty("aliasScope","48kHz,6170Hz sine at0.65peak; unit and12/24dB separate input/output drives, nominal headroom/reference. Historical4x bins plus even/odd harmonic folds around1x/2x production16x rate, production16x versus64x oracle. Other levels/frequencies, combined drives, extremes, automation and broadband aliasing not_asserted.");
    result->setProperty("imdScope","48kHz,60Hz+7kHz each0.325peak. Published sideband measurements are diagnostic_only, not a hardware-equivalence or perceptual gate.");result->setProperty("referenceAndListeningAcceptance","not_asserted");
    return juce::var(result);
}
