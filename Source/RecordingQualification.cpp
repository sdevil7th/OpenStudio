#include "RecordingQualification.h"
#include "AudioRecorder.h"
#include <algorithm>
#include <chrono>
#include <thread>
#include <vector>

juce::var runRecordingQualification(const juce::File& source,
                                   const juce::File& outputDirectory,
                                   double seconds)
{
    auto* root = new juce::DynamicObject();
    juce::Array<juce::var> checks;
    bool success = true;
    const auto check = [&] (const char* id, bool pass, const juce::String& detail)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", id); item->setProperty("status", pass ? "pass" : "fail");
        item->setProperty("detail", detail); checks.add(juce::var(item)); success &= pass;
    };
    root->setProperty("scope", "Paced native AudioRecorder capture of actual project PCM, concurrent live-peak queries and maintenance; no device opened.");
    root->setProperty("hardwareRecording", "not_asserted");
    root->setProperty("electricalTiming", "not_asserted");
    root->setProperty("listeningAcceptance", "not_asserted");
    const auto finish = [&] { root->setProperty("success", success); root->setProperty("objectiveGateStatus", success ? "pass" : "fail"); root->setProperty("checks", checks); return juce::var(root); };
    if (!std::isfinite(seconds) || seconds < 1.0 || seconds > 600.0)
    { check("bounded_duration", false, "Expected 1..600 seconds"); return finish(); }
    if (!outputDirectory.createDirectory().wasOk())
    { check("output_directory", false, outputDirectory.getFullPathName()); return finish(); }
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> sourceReader(formats.createReaderFor(source));
    if (!sourceReader || !std::isfinite(sourceReader->sampleRate)
        || sourceReader->sampleRate < 8000 || sourceReader->sampleRate > 192000)
    { check("source_readable", false, source.getFullPathName()); return finish(); }
    const double rate = sourceReader->sampleRate;
    const int frames = static_cast<int>(std::llround(rate * seconds));
    const int channels = juce::jlimit(1, 2, static_cast<int>(sourceReader->numChannels));
    juce::AudioBuffer<float> input(channels, frames);
    if (sourceReader->lengthInSamples < frames || !sourceReader->read(&input, 0, frames, 0, true, channels > 1))
    { check("source_pcm_loaded", false, "Source must contain the whole requested capture"); return finish(); }
    input.applyGain(0.25f); // Keep the 16-bit production recorder comfortably below clipping.
    sourceReader.reset();
    AudioRecorder recorder(outputDirectory.getChildFile("recovery"));
    const auto destination = outputDirectory.getNonexistentChildFile("paced-project-capture", ".wav");
    const auto start = juce::Time::getMillisecondCounterHiRes();
    const bool started = recorder.startRecording("qualification", destination, rate, channels);
    root->setProperty("recordStartMilliseconds", juce::Time::getMillisecondCounterHiRes() - start);
    check("recorder_started", started, destination.getFullPathName());
    if (!started) return finish();
    std::atomic<int> published { 0 };
    std::atomic<bool> stop { false };
    int queryCount = 0, invalidResponses = 0, tailPeaks = 0;
    std::vector<double> queryTimes, callbackTimes;
    constexpr int blockSize = 8;
    root->setProperty("blockSize", blockSize);
    callbackTimes.reserve(static_cast<size_t>(frames / blockSize + 1));
    std::thread preview([&]
    {
        while (!stop.load(std::memory_order_acquire))
        {
            recorder.maintainRecordingPreviews();
            const int available = published.load(std::memory_order_acquire);
            // Exercise both overview aggregation and detailed, moving right edge.
            const int stride = queryCount % 2 == 0 ? 256 : 8192;
            const auto first = static_cast<juce::int64>(juce::jmax(0, available / stride - 2048)) * stride;
            const auto began = juce::Time::getMillisecondCounterHiRes();
            const auto peaks = recorder.getRecordingPeaks("qualification", stride, 8192, first);
            queryTimes.push_back(juce::Time::getMillisecondCounterHiRes() - began);
            if (const auto* values = peaks.getArray(); values != nullptr && !values->isEmpty())
            {
                const int count = (values->size() - 1) / (channels * 2);
                if (static_cast<int>((*values)[0]) != channels || count > 8192) ++invalidResponses;
                for (int index = 1; index < values->size(); ++index)
                    if (!std::isfinite(static_cast<double>((*values)[index]))) ++invalidResponses;
                if (available > static_cast<int>(rate * 121.0)) tailPeaks = juce::jmax(tailPeaks, count);
            }
            ++queryCount;
            std::this_thread::sleep_for(std::chrono::milliseconds(40));
        }
    });
    using Clock = std::chrono::steady_clock;
    const auto clockStart = Clock::now();
    for (int position = 0; position < frames;)
    {
        const int count = juce::jmin(blockSize, frames - position);
        float* pointers[2] { input.getWritePointer(0, position), input.getWritePointer(channels - 1, position) };
        juce::AudioBuffer<float> block(pointers, channels, count);
        const auto began = juce::Time::getMillisecondCounterHiRes();
        recorder.writeBlock("qualification", block, count, 17.25 + position / rate);
        callbackTimes.push_back(juce::Time::getMillisecondCounterHiRes() - began);
        position += count;
        published.store(position, std::memory_order_release);
        std::this_thread::sleep_until(clockStart + std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(position / rate)));
    }
    root->setProperty("elapsedSeconds", std::chrono::duration<double>(Clock::now() - clockStart).count());
    stop.store(true, std::memory_order_release); preview.join();
    const auto takes = recorder.stopAllRecordings(rate);
    check("one_completed_take", takes.size() == 1, juce::String(static_cast<int>(takes.size())));
    check("writer_lock_misses", recorder.getWriteLockMissCount() == 0, juce::String(recorder.getWriteLockMissCount()));
    check("writer_fifo_overflows", recorder.getWriterBufferOverflowCount() == 0, juce::String(recorder.getWriterBufferOverflowCount()));
    const auto failures = recorder.takeWriteFailures();
    check("disk_write_failures", failures.getArray() != nullptr && failures.getArray()->isEmpty(), juce::JSON::toString(failures));
    check("concurrent_live_peaks", queryCount > seconds * 10 && invalidResponses == 0, juce::String(queryCount) + " queries, invalid=" + juce::String(invalidResponses));
    if (seconds > 122.0) check("preview_after_120_second_chunk", tailPeaks > 0, juce::String(tailPeaks));
    if (!takes.empty())
    {
        check("first_block_sample_placement", std::abs(takes[0].startTime - 17.25) < 1.0 / rate, juce::String(takes[0].startTime, 9));
        check("duration_no_dropped_frames", std::abs(takes[0].duration * rate - frames) < 0.5, juce::String(takes[0].duration, 9));
    }
    std::unique_ptr<juce::AudioFormatReader> recorded(formats.createReaderFor(destination));
    check("complete_pcm_file", recorded != nullptr && recorded->lengthInSamples == frames && static_cast<int>(recorded->numChannels) == channels, destination.getFullPathName());
    double maxError = 0.0;
    if (recorded)
    {
        juce::AudioBuffer<float> block(channels, 8192);
        bool readable = true;
        for (int position = 0; position < frames; position += block.getNumSamples())
        {
            const int count = juce::jmin(block.getNumSamples(), frames - position);
            readable &= recorded->read(&block, 0, count, position, true, channels > 1);
            for (int channel = 0; channel < channels; ++channel)
                for (int index = 0; index < count; ++index)
                    maxError = juce::jmax(maxError, std::abs(static_cast<double>(block.getSample(channel, index) - input.getSample(channel, position + index))));
        }
        check("entire_capture_matches_source_within_pcm16_quantization", readable && maxError <= 1.1 / 32768.0, juce::String(maxError, 12));
    }
    const auto timing = [] (std::vector<double>& times)
    {
        auto* value = new juce::DynamicObject();
        std::sort(times.begin(), times.end());
        if (!times.empty())
        {
            value->setProperty("count", static_cast<int>(times.size()));
            value->setProperty("p95Milliseconds", times[static_cast<size_t>((times.size() - 1) * 0.95)]);
            value->setProperty("p99Milliseconds", times[static_cast<size_t>((times.size() - 1) * 0.99)]);
            value->setProperty("maximumMilliseconds", times.back());
        }
        return juce::var(value);
    };
    root->setProperty("writeBlockTiming", timing(callbackTimes));
    root->setProperty("peakQueryTiming", timing(queryTimes));
    root->setProperty("timingClassification", "diagnostic_only: wall-clock timings depend on machine scheduling and Debug build");
    root->setProperty("sampleRate", rate); root->setProperty("channels", channels);
    root->setProperty("frames", frames); root->setProperty("source", source.getFullPathName());
    root->setProperty("capture", destination.getFullPathName()); root->setProperty("maxPCMError", maxError);
    return finish();
}
