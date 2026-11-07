#include "PackedWaveformPeaksRegression.h"
#include "PackedWaveformPeaks.h"
#include "PeakCache.h"
#include <array>
#include <vector>

namespace
{
bool exactPackedFloatBits(const juce::var& flat, const juce::var& packed)
{
    const auto* values = flat.getArray();
    const auto* object = packed.getDynamicObject();
    if (values == nullptr || object == nullptr || object->hasProperty("error")) return false;
    juce::MemoryOutputStream decoded;
    if (!juce::Base64::convertFromBase64(decoded, object->getProperty("data").toString())) return false;
    const auto expected = values->isEmpty() ? 0 : values->size() - 1;
    if (decoded.getDataSize() != static_cast<size_t>(expected) * 4
        || static_cast<int>(object->getProperty("byteLength")) != expected * 4) return false;
    const auto* bytes = static_cast<const std::uint8_t*>(decoded.getData());
    for (int index = 0; index < expected; ++index)
    {
        const auto sample = static_cast<float>(static_cast<double>((*values)[index + 1]));
        std::uint32_t expectedBits = 0;
        std::memcpy(&expectedBits, &sample, sizeof(expectedBits));
        std::uint32_t actualBits = 0;
        for (int byte = 0; byte < 4; ++byte)
            actualBits |= static_cast<std::uint32_t>(bytes[static_cast<size_t>(index) * 4 + static_cast<size_t>(byte)]) << (byte * 8);
        if (actualBits != expectedBits) return false;
    }
    return true;
}
}

juce::var runPackedWaveformPeaksRegression()
{
    auto* report = new juce::DynamicObject();
    juce::Array<juce::var> checks;
    const auto check = [&checks](const char* name, bool pass)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", name);
        item->setProperty("pass", pass);
        item->setProperty("detail", "Lossless Float32 waveform transport, bounded metadata and native source-edge parity.");
        checks.add(juce::var(item));
    };
    {
        juce::Array<juce::var> values { 2 };
        for (const std::uint32_t bits : { 0x80000000u, 0u, 0x00000001u, 0x80000001u,
                                        0xff7fffffu, 0x7f7fffffu, 0xbe000000u, 0x3f400000u })
        {
            float value = 0.0f;
            std::memcpy(&value, &bits, sizeof(value));
            values.add(value);
        }
        const auto packed = PackedWaveformPeaks::encode(values);
        check("waveform_packed_stereo_exact_float32_bits", exactPackedFloatBits(values, packed)
            && static_cast<int>(packed["channels"]) == 2 && static_cast<int>(packed["peakCount"]) == 2
            && packed["byteOrder"].toString() == "little" && static_cast<int>(packed["version"]) == 1);
    }
    {
        const auto empty = PackedWaveformPeaks::encode(juce::Array<juce::var>());
        check("waveform_packed_empty_explicit", static_cast<int>(empty["channels"]) == 0
            && static_cast<int>(empty["peakCount"]) == 0 && exactPackedFloatBits(juce::Array<juce::var>(), empty));
        const auto badShape = PackedWaveformPeaks::encode(juce::Array<juce::var> { 2, 0.5f });
        const auto badChannel = PackedWaveformPeaks::encode(juce::Array<juce::var> { 65 });
        const auto badChannelType = PackedWaveformPeaks::encode(juce::Array<juce::var> { "1", 0.0f, 0.5f });
        const auto badValue = PackedWaveformPeaks::encode(juce::Array<juce::var> { 1, 0.0f, std::numeric_limits<double>::infinity() });
        check("waveform_packed_invalid_input_reported", badShape.hasProperty("error")
            && badChannel.hasProperty("error") && badChannelType.hasProperty("error") && badValue.hasProperty("error")
            && PackedWaveformPeaks::encode(juce::var()).hasProperty("error"));
    }
    {
        juce::TemporaryFile source(".wav");
        juce::AudioBuffer<float> samples(2, 1537);
        samples.clear();
        samples.setSample(0, 63, 1.0f); samples.setSample(0, 1499, 0.5f); samples.setSample(0, 1500, 1.0f);
        samples.setSample(1, 63, -1.0f); samples.setSample(1, 1499, -0.25f); samples.setSample(1, 1500, -1.0f);
        std::unique_ptr<juce::OutputStream> stream = source.getFile().createOutputStream();
        juce::WavAudioFormat wav;
        auto writer = wav.createWriterFor(stream, juce::AudioFormatWriterOptions()
            .withSampleRate(48000).withNumChannels(2).withBitsPerSample(32)
            .withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
        bool ready = writer != nullptr && writer->writeFromAudioSampleBuffer(samples, 0, samples.getNumSamples());
        writer.reset();
        PeakCache cache;
        ready = ready && cache.generateSync(source.getFile());
        const auto clipped = cache.getPeaks(source.getFile(), 1024, 0, 4096, 64, 1500);
        const auto* values = clipped.getArray();
        check("waveform_packed_trim_edges_exact", ready && values != nullptr && values->size() == 9
            && static_cast<double>((*values)[2]) == 0.0 && static_cast<double>((*values)[6]) == 0.5
            && static_cast<double>((*values)[7]) == -0.25
            && exactPackedFloatBits(clipped, PackedWaveformPeaks::encode(clipped)));
        const auto tail = cache.getPeaks(source.getFile(), 4096, 0, 4096);
        check("waveform_packed_partial_final_pixel_exact", ready && tail.getArray() != nullptr && tail.size() == 5
            && exactPackedFloatBits(tail, PackedWaveformPeaks::encode(tail)));
        cache.invalidate(source.getFile());
    }
    {
        juce::Array<juce::var> values { 2 };
        for (int index = 0; index < 4096 * 4; ++index)
            values.add(static_cast<float>((index % 2047) - 1023) / 1024.0f);
        const auto packed = PackedWaveformPeaks::encode(values);
        const auto packingStart = juce::Time::getHighResolutionTicks();
        size_t encodedBytes = 0;
        for (int repeat = 0; repeat < 8; ++repeat)
            encodedBytes += PackedWaveformPeaks::encode(values)["data"].toString().getNumBytesAsUTF8();
        const auto oldStart = juce::Time::getHighResolutionTicks();
        size_t legacyBytes = 0;
        for (int repeat = 0; repeat < 8; ++repeat) legacyBytes += juce::JSON::toString(values, true).getNumBytesAsUTF8();
        const auto oldEnd = juce::Time::getHighResolutionTicks();
        size_t packedBytes = 0;
        for (int repeat = 0; repeat < 8; ++repeat) packedBytes += juce::JSON::toString(packed, true).getNumBytesAsUTF8();
        const auto packedEnd = juce::Time::getHighResolutionTicks();
        auto* benchmark = new juce::DynamicObject();
        benchmark->setProperty("classification", "diagnostic_only");
        benchmark->setProperty("tiles", 8);
        benchmark->setProperty("peaksPerTile", 4096);
        benchmark->setProperty("workerPackingMs", juce::Time::highResolutionTicksToSeconds(oldStart - packingStart) * 1000.0);
        benchmark->setProperty("legacyJsonMs", juce::Time::highResolutionTicksToSeconds(oldEnd - oldStart) * 1000.0);
        benchmark->setProperty("packedCompletionJsonMs", juce::Time::highResolutionTicksToSeconds(packedEnd - oldEnd) * 1000.0);
        benchmark->setProperty("legacyJsonBytes", static_cast<juce::int64>(legacyBytes));
        benchmark->setProperty("packedJsonBytes", static_cast<juce::int64>(packedBytes));
        benchmark->setProperty("workerBase64Bytes", static_cast<juce::int64>(encodedBytes));
        report->setProperty("benchmark", juce::var(benchmark));
        check("waveform_packed_full_tile_exact", exactPackedFloatBits(values, packed)
            && static_cast<int>(packed["peakCount"]) == 4096 && legacyBytes > 0 && packedBytes > 0);
    }
    report->setProperty("checks", checks);
    return juce::var(report);
}
