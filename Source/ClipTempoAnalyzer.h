#pragma once
#include <JuceHeader.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

// Bounded worker-only analysis. Project BPM and QA samples are never inputs.
// Ellis 2007: log-spectral novelty, autocorrelation and log-tempo listener prior.
// Adaptive spectral whitening follows the approach documented by aubio.
namespace ClipTempoAnalyzer
{
namespace detail
{
constexpr double rate = 11025.0;
constexpr int fftSize = 1024, hop = 128;
constexpr double frameRate = rate / hop;
inline double preference(double bpm) { return std::exp(-0.5 * std::pow(std::log2(bpm / 120.0) / 0.9, 2.0)); }
inline bool sameFamily(double a, double b)
{
    for (const double ratio : { 0.5, 2.0 / 3.0, 1.0, 1.5, 2.0, 3.0 })
        if (std::abs(a / b / ratio - 1.0) < 0.035) return true;
    return false;
}
struct Segment
{
    double start = 0.0, duration = 0.0, energy = 0.0, threshold = 0.0;
    int channel = 0;
    std::vector<double> onset, correlation;
    double at(double lag) const
    {
        if (lag < 1.0 || lag + 1.0 >= static_cast<double>(correlation.size())) return 0.0;
        const auto index = static_cast<size_t>(lag);
        return correlation[index] + (lag - static_cast<double>(index)) * (correlation[index + 1] - correlation[index]);
    }
    double score(double bpm) const
    {
        const double lag = frameRate * 60.0 / bpm;
        return juce::jmax(0.0, (at(lag) + 0.35 * at(lag * 2.0) + 0.15 * at(lag * 3.0)) / 1.5);
    }
};
inline bool analyzeSegment(juce::AudioFormatReader& reader, double offset, Segment& segment, const std::atomic<bool>* cancelled)
{
    const int count = static_cast<int>(segment.duration * rate);
    std::vector<float> audio(static_cast<size_t>(count), 0.0f);
    constexpr int blockSize = 65536;
    juce::AudioBuffer<float> input(juce::jlimit(1, 2, static_cast<int>(reader.numChannels)), blockSize + 1);
    const auto sourceStart = static_cast<juce::int64>((offset + segment.start) * reader.sampleRate);
    juce::int64 loadedStart = -1;
    int loadedCount = 0;
    double energy = 0.0;
    for (int sample = 0; sample < count; ++sample)
    {
        if ((sample & 4095) == 0 && cancelled && cancelled->load(std::memory_order_relaxed)) return false;
        const double source = sample * reader.sampleRate / rate;
        const auto sourceIndex = static_cast<juce::int64>(source);
        if (loadedStart < 0 || sourceIndex + 1 >= loadedStart + loadedCount)
        {
            loadedStart = sourceIndex;
            loadedCount = static_cast<int>(std::min<juce::int64>(blockSize + 1, reader.lengthInSamples - sourceStart - loadedStart));
            if (loadedCount <= 0 || !reader.read(&input, 0, loadedCount, sourceStart + loadedStart, true, true)) return false;
        }
        const int position = static_cast<int>(sourceIndex - loadedStart);
        const float fraction = static_cast<float>(source - static_cast<double>(sourceIndex));
        const float a = input.getSample(segment.channel, position);
        const float b = input.getSample(segment.channel, juce::jmin(position + 1, loadedCount - 1));
        const float value = a + (b - a) * fraction;
        if (!std::isfinite(value)) return false;
        audio[static_cast<size_t>(sample)] = value;
        energy += value * value;
    }
    if (energy / juce::jmax(1, count) < 1.0e-10) return false;
    juce::dsp::FFT fft(10);
    std::array<float, fftSize * 2> transform {};
    std::array<float, fftSize / 2> previous {}, average {};
    std::array<float, fftSize> hann {};
    for (int sample = 0; sample < fftSize; ++sample)
        hann[static_cast<size_t>(sample)] = 0.5f - 0.5f * std::cos(juce::MathConstants<float>::twoPi * static_cast<float>(sample) / static_cast<float>(fftSize - 1));
    std::vector<std::array<double, 4>> bands;
    std::vector<double> frameEnergies;
    bands.reserve(static_cast<size_t>(count / hop));
    for (int start = 0; start + fftSize <= count; start += hop)
    {
        if (cancelled && cancelled->load(std::memory_order_relaxed)) return false;
        transform.fill(0.0f);
        double frameEnergy = 0.0;
        for (int sample = 0; sample < fftSize; ++sample)
        {
            const float value = audio[static_cast<size_t>(start + sample)] * hann[static_cast<size_t>(sample)];
            transform[static_cast<size_t>(sample)] = value;
            frameEnergy += value * value;
        }
        frameEnergies.push_back(frameEnergy);
        fft.performFrequencyOnlyForwardTransform(transform.data());
        std::array<double, 4> flux {};
        for (int bin = 4; bin < fftSize / 2; ++bin)
        {
            const auto index = static_cast<size_t>(bin);
            const float magnitude = transform[index];
            average[index] = bands.empty() ? magnitude : 0.97f * average[index] + 0.03f * magnitude;
            const float whitened = std::log1p(4.0f * magnitude / juce::jmax(1.0e-4f, average[index]));
            const double frequency = bin * rate / fftSize;
            const int band = frequency < 180.0 ? 0 : frequency < 800.0 ? 1 : frequency < 2500.0 ? 2 : 3;
            if (frequency < 5000.0) flux[static_cast<size_t>(band)] += juce::jmax(0.0f, whitened - previous[index]);
            previous[index] = whitened;
        }
        bands.push_back(flux);
    }
    if (bands.size() < 128) return false;
    // Whitening must not amplify tiny, periodic FFT leakage from a sustained
    // tone into fictitious note attacks. Require actual envelope modulation.
    std::sort(frameEnergies.begin(), frameEnergies.end());
    const auto lowEnergy = frameEnergies[frameEnergies.size() / 20];
    const auto highEnergy = frameEnergies[frameEnergies.size() * 19 / 20];
    if (highEnergy < 1.0e-12 || (highEnergy - lowEnergy) / highEnergy < 0.01) return false;
    bands.front().fill(0.0);
    segment.onset.assign(bands.size(), 0.0);
    constexpr std::array<double, 4> weights { 0.35, 0.15, 0.35, 0.15 };
    const int radius = juce::roundToInt(frameRate * 0.5);
    for (size_t band = 0; band < weights.size(); ++band)
    {
        std::vector<double> prefix(bands.size() + 1, 0.0), novelty(bands.size(), 0.0);
        for (size_t i = 0; i < bands.size(); ++i) prefix[i + 1] = prefix[i] + bands[i][band];
        for (size_t i = 0; i < bands.size(); ++i)
        {
            const auto first = static_cast<size_t>(juce::jmax(0, static_cast<int>(i) - radius));
            const auto last = juce::jmin(bands.size(), i + static_cast<size_t>(radius) + 1);
            novelty[i] = juce::jmax(0.0, bands[i][band] - (prefix[last] - prefix[first]) / static_cast<double>(last - first));
        }
        auto sorted = novelty;
        std::sort(sorted.begin(), sorted.end());
        const double scale = juce::jmax(1.0e-8, sorted[sorted.size() * 9 / 10]);
        for (size_t i = 0; i < bands.size(); ++i)
            segment.onset[i] += weights[band] * juce::jmin(3.0, novelty[i] / scale);
    }
    const double maximum = *std::max_element(segment.onset.begin(), segment.onset.end());
    int attacks = 0;
    for (size_t i = 1; i + 1 < segment.onset.size(); ++i)
        if (segment.onset[i] > maximum * 0.15 && segment.onset[i] > segment.onset[i - 1] && segment.onset[i] >= segment.onset[i + 1]) ++attacks;
    if (maximum < 1.0e-5 || attacks < 4) return false;
    double mean = 0.0;
    for (const auto value : segment.onset) mean += value;
    mean /= static_cast<double>(segment.onset.size());
    segment.threshold = juce::jmax(0.2, 3.0 / std::sqrt(static_cast<double>(segment.onset.size()) / (fftSize / hop)));
    const int end = juce::jmin(static_cast<int>(std::ceil(frameRate * 60.0 / 45.0)) * 3 + 2, static_cast<int>(segment.onset.size() / 2));
    segment.correlation.assign(static_cast<size_t>(end + 1), 0.0);
    double strongest = 0.0;
    for (int lag = 1; lag <= end; ++lag)
    {
        if (cancelled && cancelled->load(std::memory_order_relaxed)) return false;
        double product = 0.0, firstEnergy = 0.0, secondEnergy = 0.0;
        for (size_t i = static_cast<size_t>(lag); i < segment.onset.size(); ++i)
        {
            const double a = segment.onset[i] - mean, b = segment.onset[i - static_cast<size_t>(lag)] - mean;
            product += a * b; firstEnergy += a * a; secondEnergy += b * b;
        }
        const double correlation = product / std::sqrt(juce::jmax(1.0e-20, firstEnergy * secondEnergy));
        segment.correlation[static_cast<size_t>(lag)] = correlation;
        if (lag >= static_cast<int>(frameRate * 60.0 / 240.0)) strongest = juce::jmax(strongest, correlation);
    }
    return strongest >= segment.threshold;
}
}

inline juce::var analyze(const juce::File& file, double offset, double duration, const std::atomic<bool>* cancelled = nullptr)
{
    auto* result = new juce::DynamicObject(); result->setProperty("source", "audio");
    const auto fail = [result](const juce::String& message) {
        result->setProperty("error", message); result->setProperty("confidence", 0.0);
        result->setProperty("candidates", juce::Array<juce::var>()); return juce::var(result);
    };
    const auto isCancelled = [&] { return cancelled && cancelled->load(std::memory_order_relaxed); };
    const auto cancelledResult = [&] { result->setProperty("cancelled", true); return fail("Tempo analysis cancelled."); };
    if (isCancelled()) return cancelledResult();
    juce::AudioFormatManager manager; manager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(file));
    if (reader == nullptr || !std::isfinite(reader->sampleRate) || reader->sampleRate < 8000.0 || reader->sampleRate > 384000.0
        || reader->lengthInSamples <= 0 || !std::isfinite(offset) || !std::isfinite(duration) || offset < 0.0 || duration < 3.0)
        return fail("Select at least three seconds of readable audio with a steady pulse.");
    const double available = juce::jmin(duration, static_cast<double>(reader->lengthInSamples) / reader->sampleRate - offset);
    if (available < 3.0) return fail("The clip has too little readable audio for tempo analysis.");
    const double window = juce::jmin(available, 20.0, juce::jmax(6.0, available / 3.0));
    std::vector<detail::Segment> probes;
    const double probeDuration = juce::jmin(2.0, available);
    const int probeSamples = juce::jmax(1, juce::roundToInt(reader->sampleRate * probeDuration));
    juce::AudioBuffer<float> probe(juce::jlimit(1, 2, static_cast<int>(reader->numChannels)), probeSamples);
    for (int index = 0; index < 9; ++index)
    {
        if (isCancelled()) return cancelledResult();
        const double center = available * (static_cast<double>(index) + 0.5) / 9.0;
        const double probeStart = juce::jlimit(0.0, available - probeDuration, center - probeDuration * 0.5);
        if (!reader->read(&probe, 0, probeSamples, static_cast<juce::int64>((offset + probeStart) * reader->sampleRate), true, true)) return fail("An audio source read failed.");
        detail::Segment segment; segment.start = juce::jlimit(0.0, available - window, center - window * 0.5); segment.duration = window;
        for (int channel = 0; channel < probe.getNumChannels(); ++channel)
        {
            const double rms = probe.getRMSLevel(channel, 0, probeSamples);
            if (rms * rms > segment.energy) { segment.energy = rms * rms; segment.channel = channel; }
        }
        probes.push_back(std::move(segment));
    }
    std::stable_sort(probes.begin(), probes.end(), [](const auto& a, const auto& b) { return a.energy > b.energy; });
    std::vector<detail::Segment> segments;
    int attempted = 0;
    for (auto& segment : probes)
    {
        if (segment.energy < 1.0e-10 || std::any_of(segments.begin(), segments.end(), [&](const auto& other) {
            return std::abs(segment.start - other.start) <= window * 0.4; })) continue;
        ++attempted;
        if (isCancelled()) return cancelledResult();
        if (detail::analyzeSegment(*reader, offset, segment, cancelled)) segments.push_back(std::move(segment));
        if (attempted == 3) break; // Includes rejected/noisy windows: at most 60 seconds of FFT/onset work.
    }
    if (isCancelled()) return cancelledResult();
    if (segments.empty()) return fail("No repeated pulse stands out. Try a steadier range, tap the pulse, or count beats manually.");
    struct Candidate { double bpm = 0.0, score = 0.0, evidence = 0.0; };
    std::vector<Candidate> grid;
    for (int index = 0; index <= 1950; ++index)
    {
        if (isCancelled()) return cancelledResult();
        const double bpm = 45.0 + index * 0.1;
        double evidence = 0.0;
        for (const auto& segment : segments) evidence += segment.score(bpm);
        evidence /= static_cast<double>(segments.size());
        grid.push_back({ bpm, evidence * detail::preference(bpm), evidence });
    }
    std::stable_sort(grid.begin(), grid.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
    const auto best = grid.front();
    if (best.evidence < 0.07) return fail("No stable beat grid was found across the sections. Select a clearer rhythm or count beats manually.");
    std::vector<Candidate> ranked;
    for (const auto& candidate : grid)
    {
        if (std::all_of(ranked.begin(), ranked.end(), [&](const auto& other) { return std::abs(candidate.bpm / other.bpm - 1.0) > 0.025; })) ranked.push_back(candidate);
        if (ranked.size() == 6) break;
    }
    double minimumBpm = 1.0e9, maximumBpm = 0.0, totalDuration = 0.0;
    size_t phaseSegment = 0; double phaseScore = -1.0;
    juce::Array<juce::var> segmentResults;
    for (size_t index = 0; index < segments.size(); ++index)
    {
        if (isCancelled()) return cancelledResult();
        const auto& segment = segments[index];
        auto segmentBest = best;
        for (const auto& candidate : grid)
            if (segment.score(candidate.bpm) * detail::preference(candidate.bpm) > segment.score(segmentBest.bpm) * detail::preference(segmentBest.bpm)) segmentBest = candidate;
        double folded = segmentBest.bpm;
        for (const double ratio : { 0.5, 2.0 / 3.0, 1.0, 1.5, 2.0, 3.0 })
            if (std::abs(segmentBest.bpm * ratio - best.bpm) < std::abs(folded - best.bpm)) folded = segmentBest.bpm * ratio;
        minimumBpm = juce::jmin(minimumBpm, folded); maximumBpm = juce::jmax(maximumBpm, folded); totalDuration += segment.duration;
        const double score = segment.score(best.bpm);
        if (score > phaseScore) { phaseScore = score; phaseSegment = index; }
        auto* item = new juce::DynamicObject(); item->setProperty("startSeconds", segment.start); item->setProperty("durationSeconds", segment.duration);
        item->setProperty("bpm", folded); item->setProperty("confidence", juce::jlimit(0.0, 0.85, score)); segmentResults.add(item);
    }
    const double spread = maximumBpm - minimumBpm;
    const bool stable = spread / best.bpm < 0.04;
    double contrast = 1.0;
    for (const auto& candidate : ranked) if (!detail::sameFamily(candidate.bpm, best.bpm)) {
        contrast = juce::jlimit(0.0, 1.0, 1.0 - candidate.score / juce::jmax(1.0e-8, best.score)); break;
    }
    const double confidence = juce::jmin(stable ? 0.88 : 0.35, 0.88 * juce::jlimit(0.0, 1.0, best.evidence / 0.45) * (0.45 + 0.55 * contrast));
    const auto& primary = segments[phaseSegment];
    const double period = 60.0 / best.bpm;
    std::array<double, 128> phases {};
    for (size_t i = 0; i < primary.onset.size(); ++i)
    {
        const double time = primary.start + (static_cast<double>(i) * detail::hop + detail::fftSize * 0.5) / detail::rate;
        const int phase = static_cast<int>(std::floor(std::fmod(time, period) / period * static_cast<double>(phases.size()))) % static_cast<int>(phases.size());
        phases[static_cast<size_t>(phase)] += primary.onset[i];
    }
    const double phase = static_cast<double>(std::distance(phases.begin(), std::max_element(phases.begin(), phases.end())));
    result->setProperty("bpm", best.bpm); result->setProperty("confidence", confidence);
    result->setProperty("beatOffsetSeconds", (phase + 0.5) / static_cast<double>(phases.size()) * period);
    result->setProperty("analysisStartSeconds", primary.start); result->setProperty("analysisDurationSeconds", primary.duration);
    result->setProperty("analyzedDurationSeconds", totalDuration); result->setProperty("tempoSpreadBpm", spread); result->setProperty("segments", segmentResults);
    juce::Array<juce::var> alternatives;
    for (const auto& candidate : ranked) {
        auto* item = new juce::DynamicObject(); item->setProperty("bpm", candidate.bpm);
        item->setProperty("confidence", confidence * candidate.score / juce::jmax(1.0e-8, best.score)); alternatives.add(item);
    }
    for (const double ratio : { 0.5, 2.0 / 3.0, 1.5, 2.0 }) {
        const double bpm = best.bpm * ratio;
        if (bpm < 20.0 || bpm > 400.0) continue;
        bool present = false;
        for (const auto& alternative : alternatives) if (std::abs(static_cast<double>(alternative["bpm"]) / bpm - 1.0) < 0.02) present = true;
        if (!present) { auto* item = new juce::DynamicObject(); item->setProperty("bpm", bpm); item->setProperty("confidence", confidence * 0.7); alternatives.add(item); }
    }
    result->setProperty("candidates", alternatives);
    result->setProperty("warning", juce::String(stable ? "" : "Sections suggest different tempos; one BPM may not fit the range. ")
        + "Compared " + juce::String(static_cast<int>(segments.size())) + " audible section(s), " + juce::String(totalDuration, 1)
        + " s in total. Check half/double or triplet pulse levels and adjust beat phase while auditioning. Confidence is evidence strength; downbeat is not detected.");
    return juce::var(result);
}
}
