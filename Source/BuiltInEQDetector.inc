void OpenStudioEQ::resetDetectorConfiguration(bool prepare)
{
    const int listen = supportsExternalKey() ? juce::jlimit(0, bandCount, juce::roundToInt(detectorListenBand.load())) : 0;
    if (prepare) detectorListenMix.reset(cachedSampleRate, .015);
    detectorListenMix.setCurrentAndTargetValue(listen > 0 ? 1.0f : 0.0f);
    detectorListenScratch.clear();
    for (int band = 0; band < bandCount; ++band)
    {
        const auto index = static_cast<size_t>(band);
        if(prepare)adaptiveDetectors[index].prepare(cachedSampleRate);else adaptiveDetectors[index].reset();
        adaptiveWasActive[index]=false;
        effectiveDynamicControls[index][0].store(bands[band].dynamicThreshold.load());
        effectiveDynamicControls[index][1].store(bands[band].dynamicAttack.load());
        effectiveDynamicControls[index][2].store(bands[band].dynamicRelease.load());
        const int source = supportsExternalKey() ? juce::jlimit(0, 2, juce::roundToInt(bands[band].detectorSource.load())) : 0;
        for (int choice = 0; choice < 3; ++choice)
        {
            auto& weight = detectorSourceWeights[index][static_cast<size_t>(choice)];
            if (prepare) weight.reset(cachedSampleRate, .01);
            weight.setCurrentAndTargetValue(choice == source ? 1.0f : 0.0f);
        }
        if (prepare) { freeDetectorWeights[index].reset(cachedSampleRate, .01); detectorListenWeights[index].reset(cachedSampleRate, .015); }
        freeDetectorWeights[index].setCurrentAndTargetValue(supportsExternalKey() && bands[band].detectorMode.load() >= .5f ? 1.0f : 0.0f);
        detectorListenWeights[index].setCurrentAndTargetValue(listen == band + 1 ? 1.0f : 0.0f);
        cachedFreeDetectorCuts[index] = {0, 0};
        for (auto& channel : freeDetectorFilters[band]) for (auto& filter : channel) filter.reset();
    }
}
