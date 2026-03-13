#include "RubberBandShifter.h"
#include <rubberband/RubberBandStretcher.h>
#include <cmath>
#include <algorithm>
#include <cstring>

using RubberBand::RubberBandStretcher;

std::vector<std::vector<float>> RubberBandShifter::process(
    const float* const* input,
    int numChannels,
    int numSamples,
    double sampleRate,
    const std::vector<float>& ratios,
    int blockSize,
    bool preserveFormants)
{
    if (numSamples <= 0 || numChannels <= 0)
        return {};

    // Use RealTime mode so setPitchScale() can be called between process() blocks.
    // Use R3 (Finer) engine for highest quality.
    // OptionPitchHighConsistency (not HighQuality) is critical for dynamically varying
    // pitch — it ensures smooth transitions when the pitch ratio changes between blocks.
    int options = RubberBandStretcher::OptionProcessRealTime
                | RubberBandStretcher::OptionEngineFiner
                | RubberBandStretcher::OptionPitchHighConsistency
                | RubberBandStretcher::OptionChannelsTogether;

    if (preserveFormants)
        options |= RubberBandStretcher::OptionFormantPreserved;

    RubberBandStretcher stretcher(
        static_cast<size_t>(sampleRate),
        static_cast<size_t>(numChannels),
        options);

    stretcher.setTimeRatio(1.0);
    stretcher.setPitchScale(1.0);

    // RealTime mode has latency — the first `latency` output samples are delayed.
    // We must compensate by:
    //   1. Processing all input + flushing with silence
    //   2. Skipping the first `latency` output samples
    //   3. Taking exactly numSamples from the remaining output
    const int latency = static_cast<int>(stretcher.getLatency());

    // Collect ALL output (will be latency + numSamples total)
    std::vector<std::vector<float>> rawOutput(static_cast<size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        rawOutput[static_cast<size_t>(ch)].reserve(
            static_cast<size_t>(numSamples + latency + blockSize * 4));

    // Temporary buffers for retrieving output
    const int maxRetrieve = blockSize * 4;
    std::vector<std::vector<float>> retrieveBuf(static_cast<size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        retrieveBuf[static_cast<size_t>(ch)].resize(static_cast<size_t>(maxRetrieve));

    std::vector<float*> retrievePtrs(static_cast<size_t>(numChannels));

    // Helper to drain all available output
    auto drainOutput = [&]()
    {
        int avail = stretcher.available();
        while (avail > 0)
        {
            int toRetrieve = std::min(avail, maxRetrieve);
            for (int ch = 0; ch < numChannels; ++ch)
            {
                if (static_cast<int>(retrieveBuf[static_cast<size_t>(ch)].size()) < toRetrieve)
                    retrieveBuf[static_cast<size_t>(ch)].resize(static_cast<size_t>(toRetrieve));
                retrievePtrs[static_cast<size_t>(ch)] = retrieveBuf[static_cast<size_t>(ch)].data();
            }

            size_t got = stretcher.retrieve(retrievePtrs.data(), static_cast<size_t>(toRetrieve));
            if (got == 0) break;

            for (int ch = 0; ch < numChannels; ++ch)
            {
                rawOutput[static_cast<size_t>(ch)].insert(
                    rawOutput[static_cast<size_t>(ch)].end(),
                    retrieveBuf[static_cast<size_t>(ch)].begin(),
                    retrieveBuf[static_cast<size_t>(ch)].begin() + static_cast<ptrdiff_t>(got));
            }

            avail = stretcher.available();
        }
    };

    // Process all real input blocks (never mark as final — we flush with silence after)
    for (int pos = 0; pos < numSamples; pos += blockSize)
    {
        int thisBlock = std::min(blockSize, numSamples - pos);

        // Compute average ratio for this block
        float avgRatio = 0.0f;
        for (int i = 0; i < thisBlock; ++i)
        {
            size_t idx = static_cast<size_t>(pos + i);
            avgRatio += (idx < ratios.size()) ? ratios[idx] : 1.0f;
        }
        avgRatio /= static_cast<float>(thisBlock);

        stretcher.setPitchScale(static_cast<double>(avgRatio));

        std::vector<const float*> inPtrs(static_cast<size_t>(numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            inPtrs[static_cast<size_t>(ch)] = input[ch] + pos;

        stretcher.process(inPtrs.data(), static_cast<size_t>(thisBlock), false);

        drainOutput();
    }

    // Flush the pipeline with silence to drain remaining audio (latency compensation).
    // Mark the last flush block as final to signal end-of-stream.
    {
        std::vector<std::vector<float>> silenceBuf(static_cast<size_t>(numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            silenceBuf[static_cast<size_t>(ch)].resize(static_cast<size_t>(blockSize), 0.0f);

        std::vector<const float*> silPtrs(static_cast<size_t>(numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            silPtrs[static_cast<size_t>(ch)] = silenceBuf[static_cast<size_t>(ch)].data();

        int totalFlush = latency + blockSize * 2;
        int flushed = 0;
        while (flushed < totalFlush)
        {
            int thisBlock = blockSize;
            bool isFinal = (flushed + thisBlock >= totalFlush);
            stretcher.process(silPtrs.data(), static_cast<size_t>(thisBlock), isFinal);
            drainOutput();
            flushed += thisBlock;
        }
    }

    // Final drain
    drainOutput();

    // Extract latency-compensated output: skip first `latency` samples, take numSamples
    std::vector<std::vector<float>> output(static_cast<size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& raw = rawOutput[static_cast<size_t>(ch)];
        auto& out = output[static_cast<size_t>(ch)];
        out.resize(static_cast<size_t>(numSamples), 0.0f);

        int available = static_cast<int>(raw.size());
        int srcStart = latency;
        int copyLen = std::min(numSamples, available - srcStart);

        if (copyLen > 0 && srcStart < available)
        {
            std::memcpy(out.data(), raw.data() + srcStart,
                        static_cast<size_t>(copyLen) * sizeof(float));
        }
    }

    return output;
}
