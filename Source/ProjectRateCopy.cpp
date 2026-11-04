#include "ProjectRateCopy.h"
#include "AudioFileConversion.h"
#include <cmath>

namespace
{
constexpr const char* quality = "swr64-phase10-cutoff0.97-f32-v1";
class CancelledFileStream final : public juce::InputStream
{
public:
    CancelledFileStream(const juce::File& file, const std::function<bool()>& alive) : input(file), keepRunning(alive) {}
    juce::int64 getTotalLength() override { return input.getTotalLength(); }
    juce::int64 getPosition() override { return input.getPosition(); }
    bool setPosition(juce::int64 position) override { return active() && input.setPosition(position); }
    bool isExhausted() override { return !active() || input.isExhausted(); }
    int read(void* destination, int bytes) override { return active() ? input.read(destination, bytes) : 0; }
    bool complete() { return active() && input.getStatus().wasOk() && getPosition() == getTotalLength(); }
private:
    bool active() const { return !keepRunning || keepRunning(); }
    juce::FileInputStream input;
    const std::function<bool()>& keepRunning;
};
juce::String cancellableHash(const juce::File& file, const std::function<bool()>& alive)
{
    CancelledFileStream stream(file, alive);
    const auto hash = juce::SHA256(stream).toHexString();
    return stream.complete() ? hash : juce::String();
}
}

juce::var ProjectRateCopy::create(const juce::File& source, const juce::File& cacheDirectory,
                                 int targetRate, const std::function<bool()>& keepRunning)
{
    auto* result = new juce::DynamicObject();
    result->setProperty("success", false); result->setProperty("quality", quality);
    const auto cancelled = [&] { return keepRunning && !keepRunning(); };
    const auto fail = [&](const juce::String& error) {
        result->setProperty("error", error); result->setProperty("cancelled", cancelled()); return juce::var(result);
    };
    if (cancelled()) return fail("Conversion cancelled");
    if (!source.existsAsFile() || targetRate < 8000 || targetRate > 384000)
        return fail("The source or project sample rate is invalid");
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(source));
    if (!reader || !std::isfinite(reader->sampleRate) || reader->sampleRate < 8000 || reader->sampleRate > 384000
        || reader->lengthInSamples < 1 || reader->numChannels < 1 || reader->numChannels > 64)
        return fail("The source audio could not be read");
    const double sourceRate = reader->sampleRate;
    const int channels = static_cast<int>(reader->numChannels);
    const double expectedLength = static_cast<double>(reader->lengthInSamples) * targetRate / sourceRate;
    if (!std::isfinite(expectedLength) || expectedLength < 0.5 || expectedLength > 1.0e12) return fail("The source duration is unsupported");
    const auto expectedFrames = static_cast<juce::int64>(std::llround(expectedLength));
    reader.reset();
    const auto sourceIdentity = cancellableHash(source, keepRunning);
    if (sourceIdentity.isEmpty()) return fail("Source identity could not be verified or the conversion was cancelled");
    const auto identity = sourceIdentity + ":" + juce::String(targetRate) + ":" + quality;
    const auto key = juce::SHA256(identity.toRawUTF8(), identity.getNumBytesAsUTF8()).toHexString();
    if (cacheDirectory.createDirectory().failed()) return fail("The project audio cache is not writable");
    const auto destination = cacheDirectory.getChildFile(key + ".wav");
    const auto metadataFile = destination.withFileExtension("json");
    const auto metadata = juce::JSON::parse(metadataFile);
    bool cacheHit = metadata["sourceIdentity"].toString() == sourceIdentity
        && metadata["quality"].toString() == quality && static_cast<int>(metadata["sampleRate"]) == targetRate
        && destination.existsAsFile();
    if (cacheHit)
    {
        const auto outputHash = cancellableHash(destination, keepRunning);
        cacheHit = outputHash.isNotEmpty() && metadata["outputIdentity"].toString() == outputHash;
    }
    if (!cacheHit)
    {
        juce::TemporaryFile publication(destination, cacheDirectory.getNonexistentChildFile(
            ".os-rate-" + juce::Uuid().toString().removeCharacters("-"), ".wav"));
        AudioFileConversion::Options options;
        options.sampleRate = targetRate; options.bitDepth = 32; options.channels = channels;
        const auto converted = AudioFileConversion::convert(source, publication.getFile(), options, keepRunning);
        if (converted.failed()) return fail(converted.getErrorMessage());
        if (cancellableHash(source, keepRunning) != sourceIdentity)
            return fail("The source changed during conversion; no clip was replaced");
        const auto outputIdentity = cancellableHash(publication.getFile(), keepRunning);
        if (outputIdentity.isEmpty() || cancelled()) return fail("Conversion cancelled");
        auto* manifest = new juce::DynamicObject();
        manifest->setProperty("sourceIdentity", sourceIdentity); manifest->setProperty("outputIdentity", outputIdentity);
        manifest->setProperty("sampleRate", targetRate); manifest->setProperty("quality", quality);
        manifest->setProperty("channels", channels); manifest->setProperty("frames", expectedFrames);
        juce::TemporaryFile metadataPublication(metadataFile, cacheDirectory.getNonexistentChildFile(
            ".os-rate-meta-" + juce::Uuid().toString().removeCharacters("-"), ".json"));
        if (!metadataPublication.getFile().replaceWithText(juce::JSON::toString(juce::var(manifest), true)) || cancelled()
            || !publication.overwriteTargetFileWithTemporary() || !metadataPublication.overwriteTargetFileWithTemporary())
            return fail("The converted copy could not be published");
    }
    reader.reset(formats.createReaderFor(destination));
    if (cancelled()) return fail("Conversion cancelled");
    if (!reader || reader->sampleRate != targetRate || static_cast<int>(reader->numChannels) != channels
        || !reader->usesFloatingPointData || reader->bitsPerSample != 32 || reader->lengthInSamples != expectedFrames)
        return fail("The cached copy failed sample-rate, channel, length or precision validation");
    result->setProperty("success", true); result->setProperty("filePath", destination.getFullPathName());
    result->setProperty("sourceIdentity", sourceIdentity); result->setProperty("cacheHit", cacheHit);
    result->setProperty("sampleRate", targetRate); result->setProperty("numChannels", channels);
    result->setProperty("duration", static_cast<double>(reader->lengthInSamples) / reader->sampleRate);
    return juce::var(result);
}
