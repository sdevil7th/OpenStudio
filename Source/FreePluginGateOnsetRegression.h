#pragma once

inline juce::var checkGateOnsetQualification()
{
    struct Capture
    {
        std::vector<float> gains;
        int firstOpening = -1, firstHalfOpen = -1, lastHalfOpen = -1;
        float burstMaximumGain = 0;
        bool finite = true;
    };
    const auto render = [] (double rate, int blockSize, int detector, double burstMs,
                            float overDb, bool external, bool filtered,
                            float attack, float hold, float release, float response = 0)
    {
        OpenStudioGate gate(true);
        gate.transientResponse.store(response);
        gate.threshold.store(-36);
        gate.detectorMode.store(static_cast<float>(detector));
        gate.attackMs.store(attack); gate.holdMs.store(hold); gate.releaseMs.store(release);
        gate.hysteresis.store(3); gate.range.store(-80);
        gate.externalDetector.store(external ? 1.0f : 0.0f);
        gate.sidechainHPF.store(filtered ? 500.0f : 20.0f);
        gate.sidechainLPF.store(filtered ? 3000.0f : 20000.0f);
        gate.prepareToPlay(rate, blockSize);
        const int onset = juce::roundToInt(rate * .05);
        const int burst = burstMs == 0 ? 1 : juce::roundToInt(rate * burstMs * .001);
        const int length = onset + burst + juce::roundToInt(rate * .9);
        const float level = juce::Decibels::decibelsToGain(-36.0f + overDb);
        Capture capture; capture.gains.resize(static_cast<size_t>(length));
        juce::AudioBuffer<float> buffer(external ? 4 : 2, blockSize);
        juce::MidiBuffer midi;
        for (int start = 0; start < length; start += blockSize)
        {
            const int count = juce::jmin(blockSize, length - start);
            buffer.setSize(external ? 4 : 2, count, false, false, true);
            const auto dry = [&](int position)
            {
                const float sign = std::sin(juce::MathConstants<double>::twoPi * 1000 * position / rate) >= 0 ? 1.0f : -1.0f;
                const bool inBurst = position >= onset && position < onset + burst;
                return sign * (external ? .01f : inBurst ? level : .00001f);
            };
            for (int i = 0; i < count; ++i)
            {
                const int position = start + i;
                const float main = dry(position);
                buffer.setSample(0, i, main); buffer.setSample(1, i, main);
                if (external)
                {
                    const float key = position >= onset && position < onset + burst
                        ? (main < 0 ? -level : level) : 0;
                    buffer.setSample(2, i, key); buffer.setSample(3, i, key);
                }
            }
            gate.processBlock(buffer, midi);
            for (int i = 0; i < count; ++i)
            {
                const int position = start + i;
                const float gain = buffer.getSample(0, i) / dry(position);
                capture.gains[static_cast<size_t>(position)] = gain;
                capture.finite = capture.finite && std::isfinite(gain) && gain >= 0 && gain <= 1.00001f;
                if (position >= onset && gain > .001f && capture.firstOpening < 0) capture.firstOpening = position - onset;
                if (position >= onset && gain >= .5f)
                {
                    if (capture.firstHalfOpen < 0) capture.firstHalfOpen = position - onset;
                    capture.lastHalfOpen = position - onset;
                }
                if (position >= onset && position < onset + burst)
                    capture.burstMaximumGain = juce::jmax(capture.burstMaximumGain, gain);
            }
        }
        return capture;
    };
    auto* result = new juce::DynamicObject();
    juce::Array<juce::var> rows;
    bool finite = true, partition = true, timingOrder = true;
    double partitionError = 0;
    int missedBursts = 0;
    const auto measure = [&](double rate, int detector, double burstMs, float overDb, bool external, bool filtered)
    {
        const auto a = render(rate, 127, detector, burstMs, overDb, external, filtered, 1, 30, 40);
        const auto b = render(rate, 512, detector, burstMs, overDb, external, filtered, 1, 30, 40);
        finite = finite && a.finite && b.finite;
        for (size_t i = 0; i < a.gains.size(); ++i)
            partitionError = juce::jmax(partitionError, std::abs(static_cast<double>(a.gains[i] - b.gains[i])));
        partition = partition && a.firstOpening == b.firstOpening && a.firstHalfOpen == b.firstHalfOpen
            && a.lastHalfOpen == b.lastHalfOpen;
        if (a.burstMaximumGain < .5f) ++missedBursts;
        auto* row = new juce::DynamicObject();
        row->setProperty("sampleRate", rate); row->setProperty("detector", detector);
        row->setProperty("burstMs", burstMs); row->setProperty("thresholdOffsetDb", overDb);
        row->setProperty("externalKey", external); row->setProperty("filteredKey", filtered);
        row->setProperty("firstGainAboveMinus60DbMs", a.firstOpening < 0 ? -1.0 : a.firstOpening / rate * 1000);
        row->setProperty("firstHalfGainMs", a.firstHalfOpen < 0 ? -1.0 : a.firstHalfOpen / rate * 1000);
        row->setProperty("lastHalfGainMs", a.lastHalfOpen < 0 ? -1.0 : a.lastHalfOpen / rate * 1000);
        row->setProperty("maximumGainDuringBurstDb", juce::Decibels::gainToDecibels(a.burstMaximumGain, -100.0f));
        row->setProperty("transientResponseStatus", "diagnostic_only");
        rows.add(row);
    };
    for (int detector = 0; detector < 3; ++detector)
        for (double burstMs : {0.0, 1.0, 5.0, 50.0})
            for (float offset : {3.0f, 12.0f, 24.0f})
            {
                measure(48000, detector, burstMs, offset, false, false);
                measure(48000, detector, burstMs, offset, true, true);
            }
    for (double rate : {44100.0, 96000.0, 192000.0})
        for (int detector = 0; detector < 3; ++detector)
            for (bool external : {false, true}) measure(rate, detector, 50, 12, external, false);
    for (const float response : {0.0f, 1.0f})
    for (int detector = 0; detector < 3; ++detector)
    {
        const auto fast = render(48000, 127, detector, 100, 24, true, false, .01f, 0, 5, response);
        const auto slow = render(48000, 127, detector, 100, 24, true, false, 50, 0, 5, response);
        const auto held = render(48000, 127, detector, 100, 24, true, false, .01f, 100, 5, response);
        const auto release = render(48000, 127, detector, 100, 24, true, false, .01f, 0, 200, response);
        timingOrder = timingOrder && fast.firstHalfOpen >= 0 && slow.firstHalfOpen > fast.firstHalfOpen
            && held.lastHalfOpen >= fast.lastHalfOpen + 4798 && release.lastHalfOpen > fast.lastHalfOpen;
    }
    bool transientContract = true; juce::Array<juce::var> transientRows;
    for (double rate : {44100.0, 48000.0, 96000.0, 192000.0})
        for (int mode : {0, 2}) for (float over : {3.0f, 12.0f, 24.0f})
            for (double burst : {1.0, 5.0, 50.0})
            for (const bool external : {false, true})
            for (const bool filtered : {false, true})
            {
                const auto capture = render(rate, 127, mode, burst, over, external, filtered, .01f, 10, 50, 1);
                const auto alternate = render(rate, 512, mode, burst, over, external, filtered, .01f, 10, 50, 1);
                const double halfMs = capture.firstHalfOpen * 1000.0 / rate;
                const bool same = capture.gains == alternate.gains;
                // The offset is measured BEFORE the key filters. Their phase and
                // attenuation can postpone crossing threshold; it is not valid to
                // impose the wide-open key filter's deadline on that different signal.
                // Require filtered capture inside the shortest qualified (1 ms)
                // burst, while retaining the 0.2 ms wide-open (20 Hz–20 kHz) contract.
                const bool opensInTime = filtered ? halfMs < 1.0 : halfMs <= .2;
                const bool rowPass = capture.finite && same && capture.firstHalfOpen >= 0
                    && opensInTime && capture.burstMaximumGain > .9f;
                transientContract = transientContract && rowPass;
                auto* row = new juce::DynamicObject(); row->setProperty("sampleRate", rate);
                row->setProperty("mode", mode); row->setProperty("overDb", over); row->setProperty("burstMs", burst);
                row->setProperty("externalKey", external); row->setProperty("filteredKey", filtered);
                row->setProperty("halfOpenMs", halfMs); row->setProperty("burstMaximumGain", capture.burstMaximumGain);
                row->setProperty("pass", rowPass); transientRows.add(row);
            }
    OpenStudioGate current(true), restored(true), embedded(false);
    juce::MemoryBlock saved, again; current.getStateInformation(saved);
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize())); restored.getStateInformation(again);
    bool compatible = saved == again && restored.transientResponse.load() == 1 && embedded.transientResponse.load() == 0;
    auto legacyTree = juce::ValueTree::readFromData(saved.getData(), saved.getSize()); legacyTree.removeProperty("transientResponse", nullptr);
    juce::MemoryBlock legacy; { juce::MemoryOutputStream stream(legacy, false); legacyTree.writeToStream(stream); }
    restored.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
    compatible = compatible && restored.transientResponse.load() == 0;
    result->setProperty("transientPeakAutoBurstContract", transientContract);
    result->setProperty("transientCases", transientRows);
    result->setProperty("legacyRecallAndRoundTrip", compatible);
    result->setProperty("plugin", "Gate onset, hold and release qualification");
    result->setProperty("cases", rows);
    result->setProperty("finiteBoundedGain", finite);
    result->setProperty("partitionError", partitionError);
    result->setProperty("timingControlOrdering", timingOrder);
    result->setProperty("burstsNotReachingHalfGain", missedBursts);
    result->setProperty("pass", transientContract && compatible && finite && partition && partitionError < 1e-7 && timingOrder);
    result->setProperty("scope", "Legacy detector remains measured without changing recalled behavior. Transient Peak/Auto contract: 1/5/50 ms bursts at +3/+12/+24 dB before key filtering, internal/external keys at minimum Attack, exceed 0.9 gain during the burst. With wide-open 20 Hz–20 kHz key filters, onset to half gain is at most 0.2 ms; with 500 Hz–3 kHz key filters it must occur inside the shortest qualified 1 ms burst. The measured interval includes both key filtering and gain attack; isolated filter or detector latency is not asserted. No lookahead or single-sample transient preservation is asserted. RMS retains 18 ms integration.");
    result->setProperty("reference", "https://www.fabfilter.com/help/ffprog-manual.pdf");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
