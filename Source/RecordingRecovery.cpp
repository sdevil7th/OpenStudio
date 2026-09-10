#include "RecordingRecovery.h"
#include "RecordingWriterSafety.h"
#include <cmath>

namespace
{
struct WaveInfo
{
    juce::int64 offset = 0, bytes = 0, frames = 0, ignoredTail = 0;
    int rate = 0, channels = 0;
    bool staleHeader = false;
    juce::String error;
};
WaveInfo inspectWave(const juce::var& entry)
{
    WaveInfo info;
    const auto fail = [&info](const char* error) { info.error = error; return info; };
    const auto path = entry.getProperty("path", "").toString();
    if (entry.getProperty("kind", "").toString() != "recording" || !juce::File::isAbsolutePath(path))
        return fail("Invalid recording journal");
    const juce::File file(path);
    if (file.isSymbolicLink() || !file.existsAsFile() || file.getSize() > (juce::int64(1) << 40))
        return fail("Recording file is missing or unsupported");
    auto input = file.createInputStream();
    if (!input || input->getTotalLength() < 44) return fail("Recording header is incomplete");
    const auto container = input->readInt();
    input->readInt();
    if ((container != 0x46464952 && container != 0x34364652) || input->readInt() != 0x45564157)
        return fail("Only journalled RIFF/RF64 WAV recordings can be repaired");
    bool foundFormat = false;
    juce::int64 declaredDataBytes = 0;
    for (int chunk = 0; chunk < 256 && input->getPosition() + 8 <= input->getTotalLength(); ++chunk)
    {
        const auto tag = input->readInt();
        const auto length = static_cast<juce::int64>(static_cast<juce::uint32>(input->readInt()));
        const auto start = input->getPosition();
        if (tag == 0x61746164) // data. Our recording writer emits no chunks after PCM.
        {
            if (!foundFormat) return fail("Recording format chunk is missing");
            info.offset = start;
            const auto available = input->getTotalLength() - start;
            // Finalized files must respect the declared data size; interrupted
            // writes may have a stale zero/short header but more PCM on disk.
            const bool finalized = entry.getProperty("status", "").toString() == "finalized";
            const auto declared = length == 0xffffffffLL ? declaredDataBytes : length;
            info.bytes = finalized ? juce::jmin(available, declared) : available;
            const auto alignment = info.channels * 2;
            info.ignoredTail = info.bytes % alignment;
            info.bytes -= info.ignoredTail;
            info.frames = info.bytes / alignment;
            info.staleHeader = declared != available;
            if (info.frames <= 0) return fail("No complete audio samples reached disk");
            return info;
        }
        if (length > 16 * 1024 * 1024 || start + length > input->getTotalLength())
            return fail("Invalid recording chunk bounds");
        if (tag == 0x20746d66) // fmt
        {
            if (foundFormat || length < 16) return fail("Invalid recording format");
            const int format = static_cast<juce::uint16>(input->readShort());
            info.channels = static_cast<juce::uint16>(input->readShort());
            info.rate = input->readInt();
            const auto byteRate = input->readInt();
            const int alignment = static_cast<juce::uint16>(input->readShort());
            const int bits = static_cast<juce::uint16>(input->readShort());
            if (format == 0xfffe)
            {
                if (length < 40 || input->readShort() < 22) return fail("Invalid extensible WAV format");
                const int validBits = input->readShort();
                input->readInt(); // Channel mask; preserve channel order.
                if (validBits != 16 || input->readInt() != 1 || input->readInt() != 0x00100000
                    || input->readInt() != static_cast<int>(0xaa000080U) || input->readInt() != 0x719b3800)
                    return fail("Only 16-bit PCM recordings are supported");
            }
            else if (format != 1) return fail("Only 16-bit PCM recordings are supported");
            if (bits != 16 || info.channels < 1 || info.channels > 64 || info.rate < 8000 || info.rate > 384000
                || alignment != info.channels * 2 || byteRate != info.rate * alignment
                || static_cast<int>(entry.getProperty("channels", 0)) != info.channels
                || static_cast<double>(entry.getProperty("sampleRate", 0)) != info.rate)
                return fail("Audio format does not match the recording journal");
            foundFormat = true;
        }
        if (tag == 0x34367364 && length >= 28) // ds64
        {
            input->readInt64();
            declaredDataBytes = input->readInt64();
            if (declaredDataBytes < 0) return fail("Invalid RF64 data size");
        }
        if (!input->setPosition(start + length + (length & 1))) return fail("Could not read recording header");
    }
    return fail("Recording data chunk is missing");
}
juce::var resultFor(const juce::var& entry, const WaveInfo& info)
{
    auto result = entry.clone();
    if (!result.isObject()) result = juce::var(new juce::DynamicObject());
    auto* object = result.getDynamicObject();
    object->setProperty("error", info.error);
    object->setProperty("duration", info.rate > 0 ? static_cast<double>(info.frames) / info.rate : 0);
    object->setProperty("recoverableFrames", info.frames);
    object->setProperty("ignoredTailBytes", info.ignoredTail);
    object->setProperty("staleHeader", info.staleHeader);
    return result;
}
}
juce::var RecordingRecovery::inspect(const juce::var& entry) { return resultFor(entry, inspectWave(entry)); }

juce::var RecordingRecovery::repair(const juce::String& id, const std::function<bool()>& keepRunning, const juce::File& root)
{
    const auto entry = RecoveryJournal::readInactive(id, root);
    const auto info = inspectWave(entry);
    auto result = resultFor(entry, info);
    const auto fail = [&](const char* error) { result.getDynamicObject()->setProperty("error", error); return result; };
    if (info.error.isNotEmpty()) return result;
    const juce::File source(entry.getProperty("path", "").toString());
    const auto sourceSize = source.getSize();
    const auto modified = source.getLastModificationTime();
    const auto parts = juce::StringArray::fromTokens(id, "/", ""); // Validated by readInactive.
    const auto destination = root.getChildFile(parts[0]).getChildFile(parts[1])
        .getNonexistentChildFile("take-" + juce::Uuid().toString().substring(0, 12), ".wav", false);
    juce::TemporaryFile temporary(destination, juce::TemporaryFile::useHiddenFile);
    auto input = source.createInputStream();
    std::unique_ptr<juce::OutputStream> stream = temporary.getFile().createOutputStream();
    if (!input || !stream || !input->setPosition(info.offset)) return fail("Could not open the recovery copy");
    auto status = std::make_shared<RecordingWriteStatus>();
    stream = std::make_unique<CheckedRecordingStream>(std::move(stream), status);
    juce::WavAudioFormat format;
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(info.rate).withNumChannels(info.channels).withBitsPerSample(16));
    if (!writer) return fail("Could not create the recovery WAV writer");
    constexpr int blockSize = 4096;
    juce::HeapBlock<char> bytes(static_cast<size_t>(blockSize * info.channels * 2));
    juce::AudioBuffer<float> buffer(info.channels, blockSize);
    juce::int64 written = 0;
    while (written < info.frames)
    {
        if (keepRunning && !keepRunning()) return fail("Recording repair cancelled; original retained");
        const int frames = static_cast<int>(juce::jmin<juce::int64>(blockSize, info.frames - written));
        const int count = frames * info.channels * 2;
        if (input->read(bytes.getData(), count) != count) return fail("Recording read failed; original retained");
        for (int channel = 0; channel < info.channels; ++channel)
            for (int sample = 0; sample < frames; ++sample)
            {
                const auto value = static_cast<juce::int16>(juce::ByteOrder::littleEndianShort(bytes.getData() + (sample * info.channels + channel) * 2));
                buffer.setSample(channel, sample, static_cast<float>(value) / 32768.0f);
            }
        if (!writer->writeFromAudioSampleBuffer(buffer, 0, frames)) return fail("Recovery write failed; original retained");
        written += frames;
    }
    const bool finalized = writer->flush();
    writer.reset();
    input.reset();
    if (!finalized || status->fault.load() != RecordingWriteStatus::none || source.getSize() != sourceSize
        || source.getLastModificationTime() != modified || (keepRunning && !keepRunning()))
        return fail("Recording changed or recovery finalization failed; original retained");
    if (!temporary.overwriteTargetFileWithTemporary()) return fail("Could not publish the repaired copy; original retained");
    result.getDynamicObject()->setProperty("repairedPath", destination.getFullPathName());
    return result;
}
