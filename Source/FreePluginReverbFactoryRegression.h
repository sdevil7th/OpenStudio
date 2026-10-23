#pragma once
#include "BuiltInReverbFactoryPresets.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <tuple>

inline juce::String reverbFactoryHistoricalHash(const juce::ValueTree& state, bool includeIR)
{
    auto historical = state.createCopy();
    for (const char* id : { "shimmerScheduling", "ambBody", "reverbControlMode" })
        historical.removeProperty(id, nullptr);
    if (!includeIR) historical.removeProperty("irData", nullptr);
    juce::MemoryBlock bytes;
    { juce::MemoryOutputStream stream(bytes, false); historical.writeToStream(stream); }
    return juce::SHA256(bytes.getData(), bytes.getSize()).toHexString();
}

inline bool reverbFactoryHistoricalDefaults(const juce::ValueTree& state)
{
    for (const char* id : { "shimmerScheduling", "ambBody", "reverbControlMode" })
        if (!state[id].isDouble() || static_cast<double>(state[id]) != 0.0) return false;
    return true;
}

struct ReverbFactoryHistoricalIRCheck
{
    bool pass = false;
    juce::uint32 maximumULP = 0;
};

inline ReverbFactoryHistoricalIRCheck checkReverbFactoryHistoricalIR(const juce::var& data)
{
    ReverbFactoryHistoricalIRCheck result;
    constexpr int frames = 57600;
    const auto* bytes = data.getBinaryData();
    if (bytes == nullptr || bytes->getSize() != 20u + 2u * frames * sizeof(float)) return result;
    juce::MemoryInputStream stream(*bytes, false);
    if (stream.readInt() != 0x4f534952 || stream.readDouble() != 48000.0
        || stream.readInt() != 2 || stream.readInt() != frames) return result;

    // Frozen 2026-10-10 generated-room recipe, independent of the production
    // generator. Double exp supplies a reference rounded to float. libm expf
    // varies by a final ULP (two after multiplication) between Windows/glibc;
    // every sample must stay within two ULPs, with silence and tap positions exact.
    juce::AudioBuffer<float> reference(2, frames);
    juce::uint64 seed = 0x4f534952;
    float filtered[2] {};
    for (int sample = 0; sample < frames; ++sample)
        for (int channel = 0; channel < 2; ++channel)
        {
            seed = (seed * 0x5deece66dULL + 11u) & 0xffffffffffffULL;
            const float noise = juce::jmin(static_cast<float>(static_cast<juce::uint32>(seed >> 16))
                / 4294967296.0f, 1.0f - std::numeric_limits<float>::epsilon());
            filtered[channel] += .35f * ((noise * 2 - 1) - filtered[channel]);
            const float exponent = -6.9f * static_cast<float>(sample) / 57600.0f;
            reference.setSample(channel, sample, sample < 480 ? 0.0f
                : filtered[channel] * .025f * static_cast<float>(std::exp(static_cast<double>(exponent))));
        }
    reference.setSample(0, 480, .45f);
    reference.setSample(1, 617, .4f);
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = 0; sample < frames; ++sample)
        {
            const float actual = stream.readFloat(), expected = reference.getSample(channel, sample);
            if (!std::isfinite(actual) || std::signbit(actual) != std::signbit(expected)) return result;
            juce::uint32 actualBits = 0, expectedBits = 0;
            std::memcpy(&actualBits, &actual, sizeof(actual));
            std::memcpy(&expectedBits, &expected, sizeof(expected));
            const auto distance = actualBits > expectedBits ? actualBits - expectedBits : expectedBits - actualBits;
            result.maximumULP = juce::jmax(result.maximumULP, distance);
            const bool exact = sample < 480 || (channel == 0 && sample == 480) || (channel == 1 && sample == 617);
            if (distance > (exact ? 0u : 2u)) return result;
        }
    result.pass = true;
    return result;
}

// Only persisted family memories are classified here. Live aliases such as
// decayTime/nonlinearShape describe the selected bank and are checked separately.
inline int reverbFactoryMemoryOwner(const juce::String& property)
{
    const auto indexed = [&property](const char* prefix, int first, int count)
    {
        // Check long numeric indices first (retro10 must not match retro1).
        for (int slot = count - 1; slot >= 0; --slot)
            if (property.startsWith(juce::String(prefix) + juce::String(slot))) return first + slot;
        return -1;
    };
    for (const auto& group : std::array<std::tuple<const char*, int, int>, 9> {{
             { "ambient", 17, 4 }, { "echoRoom", 15, 2 }, { "spatialLowShelf", 12, 3 },
             { "spatialDelayCapacity", 12, 3 }, { "spatial", 12, 3 }, { "clear", 24, 3 },
             { "retro", 27, 14 }, { "drifting", 21, 3 }, { "vintage", 10, 2 } }})
    {
        const int owner = indexed(std::get<0>(group), std::get<1>(group), std::get<2>(group));
        if (owner >= 0) return owner;
    }
    constexpr std::array<int, 5> studioTypes { 0, 1, 3, 8, 9 };
    for (int slot = 0; slot < 5; ++slot)
        if (property.startsWith("studio" + juce::String(slot)) || property.startsWith("studioTone" + juce::String(slot)))
            return studioTypes[static_cast<size_t>(slot)];
    if (property == "roomCharacter") return 0;
    if (property.startsWith("plate")) return 2;
    if (property.startsWith("spring")) return 4;
    if (property == "shimmerRouting" || property == "shimmerVoiceEngine" || property == "shimmerHold"
        || property == "shimmerScheduling") return 5;
    for (const char* id : { "nonlinearFeedback", "nonlinearLateDecay", "nonlinearLateLevel", "nonlinearDiffusion",
                           "nonlinearModulation", "nonlinearRate", "nonlinearHold" })
        if (property == id) return 6;
    if (property.startsWith("ir")) return 7;
    if (property == "ambBody") return 20;
    return -1;
}

inline bool reverbFactoryEnumsExact(OpenStudioReverb& processor)
{
    bool valid = true;
    const auto check = [&valid](float value) { valid = std::isfinite(value) && value == std::round(value) && valid; };
    for (int type = 0; type < OpenStudioReverb::standaloneTypeCount; ++type)
    { check(processor.getBankValue(type, 8)); check(processor.getBankValue(type, 13)); }
    for (size_t slot = 0; slot < processor.studioEngines.size(); ++slot)
    { check(processor.studioEngines[slot].load()); check(processor.studioToneControls[slot][0].load()); }
    for (size_t slot = 0; slot < processor.vintageColour.size(); ++slot)
    { check(processor.vintageColour[slot].load()); check(processor.vintageConversion[slot].load()); check(processor.vintageTankRate[slot].load()); }
    for (const auto& controls : processor.spatialControls)
    { check(controls[2].load()); check(controls[3].load()); }
    for (const auto& controls : processor.echoRoomControls)
    { check(controls[1].load()); check(controls[2].load()); check(controls[5].load()); }
    for (const auto& controls : processor.ambientControls)
    { check(controls[1].load()); check(controls[6].load()); check(controls[7].load()); check(controls[9].load()); }
    for (const auto& controls : processor.retroControls) check(controls[5].load());
    for (size_t field = 0; field < 3; ++field) check(processor.springControls[field].load());
    check(processor.plateEngine.load()); check(processor.plateCharacter.load()); check(processor.roomCharacter.load());
    check(processor.creativeControls[0].load()); check(processor.shimmerVoiceEngine.load()); check(processor.shimmerScheduling.load());
    return valid;
}

inline juce::var checkReverbFactoryPresets()
{
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Explicit standalone reverb factory voices");
    bool states = true, finite = true, unchanged = true, mixLock = true, files = true;
    bool coverage = true, distinctProfiles = true, collectionMemories = true, oldVoices = true, otherMemories = true, enumControls = true;
    std::array<bool, OpenStudioReverb::standaloneTypeCount> covered {};
    juce::StringArray profileFingerprints;
    juce::Array<juce::var> cases;
    juce::StringArray names, encodedStates;
    auto defaults = std::make_unique<OpenStudioReverb>(true);
    auto embedded = std::make_unique<OpenStudioReverb>(false);
    juce::MemoryBlock defaultBefore, embeddedBefore;
    defaults->getStateInformation(defaultBefore);
    embedded->getStateInformation(embeddedBefore);
    const auto directory = juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-factory/responses");
    files = directory.createDirectory().wasOk();
    const auto defaultTree = juce::ValueTree::readFromData(defaultBefore.getData(), defaultBefore.getSize());
    juce::MemoryBlock collectionBytes;
    collectionMemories = OpenStudioReverbFactoryPresets::buildState(OpenStudioReverbFactoryPresets::collection.name, collectionBytes);
    auto collection = std::make_unique<OpenStudioReverb>(true);
    collection->setStateInformation(collectionBytes.getData(), static_cast<int>(collectionBytes.getSize()));
    const auto collectionTree = juce::ValueTree::readFromData(collectionBytes.getData(), collectionBytes.getSize());
    // Full hashes captured from the eight Windows portable factory files on
    // 2026-10-10, before the opt-in controls. Keep these original witnesses;
    // procedural expf PCM is not guaranteed bit-identical across platforms.
    constexpr std::array<const char*, 8> historicalHashes {
        "a155d04bd12aa719c763644e2bf142f8c04fca9fc366c81e286f0eb5ed1c351a",
        "4b3c9e1ad4ce62f74ebf661f34e505b785a48df721a661dabf5081fcb503556d",
        "fbee1f26a5fe12279c67002faeac4028992e0ea4b5e7579ae932197ec805d192",
        "6428f50a8148545cc524ee729b3d21b5d29d414009e770e6781e561c3c224d8a",
        "25d8df3419069403dfa81ad6f404f84d4e3a8d10f3e59c51935eb62c4cd3bf19",
        "63d8c4e4a233d8eb150fed7d55d5cf5b2037586a698a0e32168007b449bbb580",
        "e3c4049ede2a86d9b1259e65560ff8ae33edb00bacdb16c0895c881f77eb633f",
        "ab362d62a8667794e28e4d70d9f5ee787479a602fb57fa53cc30d5985634ec83"
    };
    // Derived from those same archived states after verifying every original
    // hash above, excluding only irData and the three asserted default additions.
    // Values, var types, property order, unknown properties, children and IR
    // shape/metadata remain byte-exact; the generated PCM is checked separately.
    constexpr std::array<const char*, 8> historicalControlHashes {
        "fa803164b19e942209c3c5dcef84b669d960b6de4cd20f6bac34bef21a66e21f",
        "a82e22930d57c234ca51cf3aab78904e7de2c0b63e434018c3ab11d75d9c3fca",
        "766a5615cdacc63f9c1be550cd31d07593e684b638f2fe3dce52029eb5f0762d",
        "6b094a21cd23825d364b4acf4fa05a2c4af443c7ef372ca02fe469e2438b0af5",
        "f410235cda4d15664741040306fbaf6e1ea1594581bb1437a5a36bf602087415",
        "cf2d3e5ad0e1137355e9fe757600f07ba999d7ba9673984cb5a1be453db02dda",
        "d5f185f03c4745f378f4bc1d69c6327728eeebd24bb73eae3cbfbcf0d0b3a866",
        "272ba87038d63319859c1fa701af5506bd47f6f5fc3a495ce6e80e30be9aa724"
    };
    const auto defaultIR = defaultTree["irData"];
    const auto historicalIR = checkReverbFactoryHistoricalIR(defaultIR);
    bool negativeControls = historicalIR.pass;
    if (const auto* originalIR = defaultIR.getBinaryData())
    {
        auto corrupted = *originalIR;
        static_cast<char*>(corrupted.getData())[12] = 1; // Reject mono/header changes.
        negativeControls = !checkReverbFactoryHistoricalIR(juce::var(corrupted)).pass && negativeControls;
        corrupted = *originalIR;
        corrupted.setSize(corrupted.getSize() - sizeof(float));
        negativeControls = !checkReverbFactoryHistoricalIR(juce::var(corrupted)).pass && negativeControls;
        for (const float replacement : { .1f, std::numeric_limits<float>::quiet_NaN() })
        {
            corrupted = *originalIR;
            juce::uint32 bits = 0;
            std::memcpy(&bits, &replacement, sizeof(bits));
            bits = juce::ByteOrder::swapIfBigEndian(bits);
            std::memcpy(static_cast<char*>(corrupted.getData()) + 20 + 1000 * sizeof(float), &bits, sizeof(bits));
            negativeControls = !checkReverbFactoryHistoricalIR(juce::var(corrupted)).pass && negativeControls;
        }
    }
    else negativeControls = false;
    size_t existingIndex = 0;

    for (const auto& voice : OpenStudioReverbFactoryPresets::voices)
    {
        juce::MemoryBlock state, repeated;
        const bool built = OpenStudioReverbFactoryPresets::buildState(voice.name, state)
            && OpenStudioReverbFactoryPresets::buildState(voice.name, repeated);
        const auto nameKey = juce::String(voice.name).toLowerCase();
        const auto encoded = state.toBase64Encoding();
        states = built && state == repeated && ! names.contains(nameKey)
            && ! encodedStates.contains(encoded) && states;
        names.add(nameKey); encodedStates.add(encoded);
        auto restored = std::make_unique<OpenStudioReverb>(true);
        restored->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        juce::MemoryBlock roundTrip;
        restored->getStateInformation(roundTrip);
        const auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize());
        const bool isCollection = voice.kind == OpenStudioReverbFactoryPresets::Kind::Collection;
        const bool isIndividual = voice.kind == OpenStudioReverbFactoryPresets::Kind::Individual;
        const bool enumValid = (!isIndividual && !isCollection) || reverbFactoryEnumsExact(*restored);
        enumControls = enumValid && enumControls;
        const bool refined = isCollection || (isIndividual ? OpenStudioReverbFactoryPresets::refinedProfile(voice.type)
            : voice.type == 2 || voice.type == 19 || voice.type >= 21);
        bool valid = built && tree.hasType("OpenStudioReverb") && state == roundTrip
            && restored->algorithm.load() == static_cast<float>(voice.type)
            && restored->outputTrimDb.load() == voice.outputTrimDb
            && restored->reverbReturnMode.load() == 1
            && restored->reverbCharacterMode.load() == (refined ? 1.0f : 0.0f);
        for (size_t field = 0; field < voice.controls.size(); ++field)
            valid = valid && restored->getBankValue(voice.type, static_cast<int>(field)) == voice.controls[field];
        for (int bank = 0; bank < OpenStudioReverb::standaloneTypeCount; ++bank)
            if (!isCollection && bank != voice.type)
                for (int field = 0; field < OpenStudioReverb::bankControlCount; ++field)
                    valid = valid && restored->getBankValue(bank, field) == defaults->getBankValue(bank, field);
        states = valid && states;
        bool memoryValid = true;
        if (!isCollection)
            for (int property = 0; property < defaultTree.getNumProperties(); ++property)
            {
                const auto id = defaultTree.getPropertyName(property);
                const int owner = reverbFactoryMemoryOwner(id.toString());
                if (owner >= 0 && owner != voice.type)
                    memoryValid = tree.getProperty(id) == defaultTree.getProperty(id) && memoryValid;
            }
        otherMemories = memoryValid && otherMemories;
        bool legacyStable = true;
        bool fullHistoricalBytesMatch = true;
        if (voice.kind == OpenStudioReverbFactoryPresets::Kind::Existing)
        {
            const auto controlsHash = reverbFactoryHistoricalHash(tree, false);
            fullHistoricalBytesMatch = existingIndex < historicalHashes.size()
                && reverbFactoryHistoricalHash(tree, true) == historicalHashes[existingIndex];
            legacyStable = reverbFactoryHistoricalDefaults(tree) && historicalIR.pass
                && tree["irData"] == defaultIR && existingIndex < historicalControlHashes.size()
                && controlsHash == historicalControlHashes[existingIndex];
           #if JUCE_WINDOWS
            legacyStable = fullHistoricalBytesMatch && legacyStable;
           #endif
            if (existingIndex == 0)
            {
                auto changed = tree.createCopy(); changed.setProperty("algorithm", 1.0, nullptr);
                negativeControls = reverbFactoryHistoricalHash(changed, false) != controlsHash && negativeControls;
                changed = tree.createCopy(); changed.setProperty("algorithm", 0, nullptr); // Same value, different var type.
                negativeControls = reverbFactoryHistoricalHash(changed, false) != controlsHash && negativeControls;
                changed = tree.createCopy(); changed.setProperty("unrecognisedState", 1, nullptr);
                negativeControls = reverbFactoryHistoricalHash(changed, false) != controlsHash && negativeControls;
                changed = tree.createCopy(); changed.setProperty("shimmerScheduling", 1.0, nullptr);
                negativeControls = !reverbFactoryHistoricalDefaults(changed) && negativeControls;
            }
            ++existingIndex;
            oldVoices = legacyStable && oldVoices;
        }
        if (isIndividual)
        {
            covered[static_cast<size_t>(voice.type)] = true;
            // Fingerprint only the authored common profile, without name/type.
            // This rejects copied default tables but makes no audible assertion.
            juce::MemoryBlock fields;
            { juce::MemoryOutputStream stream(fields, false); for (float value : voice.controls) stream.writeFloat(value); }
            const auto fingerprint = juce::SHA256(fields.getData(), fields.getSize()).toHexString();
            distinctProfiles = !profileFingerprints.contains(fingerprint) && distinctProfiles;
            profileFingerprints.add(fingerprint);
            for (int field = 0; field < OpenStudioReverb::bankControlCount; ++field)
                collectionMemories = collection->getBankValue(voice.type, field) == restored->getBankValue(voice.type, field) && collectionMemories;
            for (int property = 0; property < tree.getNumProperties(); ++property)
            {
                const auto id = tree.getPropertyName(property);
                if (reverbFactoryMemoryOwner(id.toString()) == voice.type)
                    collectionMemories = collectionTree.getProperty(id) == tree.getProperty(id) && collectionMemories;
            }
            collection->selectAlgorithm(voice.type);
            for (size_t field = 0; field < voice.controls.size(); ++field)
                collectionMemories = collection->getBankValue(voice.type, static_cast<int>(field)) == voice.controls[field] && collectionMemories;
        }

        // Exercise the native factory Mix Lock transformation. Output remains
        // part of the new voice; only the established six mix fields are locked.
        defaults->wetLevel.store(.17f); defaults->dryLevel.store(.81f);
        defaults->sendMode.store(1); defaults->mixLock.store(1);
        defaults->insertWet.store(.23f); defaults->insertDry.store(.64f);
        defaults->outputTrimDb.store(-11);
        auto lockedState = state;
        OpenStudioReverbFactoryPresets::preserveLockedMix(*defaults, lockedState);
        auto locked = std::make_unique<OpenStudioReverb>(true);
        locked->setStateInformation(lockedState.getData(), static_cast<int>(lockedState.getSize()));
        mixLock = locked->wetLevel.load() == .17f && locked->dryLevel.load() == .81f
            && locked->sendMode.load() == 1 && locked->mixLock.load() == 1
            && locked->insertWet.load() == .23f && locked->insertDry.load() == .64f
            && locked->outputTrimDb.load() == voice.outputTrimDb && mixLock;
        defaults->setStateInformation(defaultBefore.getData(), static_cast<int>(defaultBefore.getSize()));

        // Finite nonzero network response is deterministic sanity only. This
        // wet-only override does not establish perceived difference or quality.
        constexpr int blockSize = 128, length = 96000;
        restored->wetLevel.store(1); restored->dryLevel.store(0); restored->sendMode.store(1);
        restored->setRateAndBufferSizeDetails(48000, blockSize);
        restored->prepareToPlay(48000, blockSize);
        const int channels = juce::jmax(2, restored->getTotalNumOutputChannels());
        juce::AudioBuffer<float> block(channels, blockSize), output(2, length);
        juce::MidiBuffer midi;
        for (int start = 0; start < 4800; start += blockSize)
        { block.clear(); restored->processBlock(block, midi); }
        bool sane = true;
        double energy = 0, peak = 0;
        for (int start = 0; start < length; start += blockSize)
        {
            block.clear();
            if (start == 0) { block.setSample(0, 0, .25f); block.setSample(1, 0, .25f); }
            restored->processBlock(block, midi);
            for (int channel = 0; channel < 2; ++channel)
            {
                output.copyFrom(channel, start, block, channel, 0, blockSize);
                for (int sample = 0; sample < blockSize; ++sample)
                {
                    const double value = block.getSample(channel, sample);
                    sane = sane && std::isfinite(value);
                    energy += value * value; peak = juce::jmax(peak, std::abs(value));
                }
            }
        }
        const auto filename = juce::String(voice.name).replace("Factory - ", "").replaceCharacter(' ', '-') + ".wav";
        const bool written = writeProbeWave(directory.getChildFile(filename), output, 48000);
        finite = sane && energy > 0 && finite; files = written && files;
        auto* row = new juce::DynamicObject();
        row->setProperty("name", voice.name); row->setProperty("type", voice.type);
        row->setProperty("fullStateRoundTrip", valid); row->setProperty("finiteNonzero", sane && energy > 0);
        row->setProperty("collection", isCollection); row->setProperty("canonicalProfile", isIndividual);
        row->setProperty("authoredEnumsExact", enumValid);
        row->setProperty("nonselectedMemoriesUnchanged", memoryValid); row->setProperty("historicalFactoryStateStable", legacyStable);
        if (voice.kind == OpenStudioReverbFactoryPresets::Kind::Existing)
            row->setProperty("historicalWindowsFullBytesMatchDiagnostic", fullHistoricalBytesMatch);
        row->setProperty("outputTrimDb", voice.outputTrimDb); row->setProperty("peakDiagnostic", peak);
        row->setProperty("energyDiagnostic", energy); row->setProperty("file", filename);
        row->setProperty("fileWritten", written); cases.add(row);
        restored->releaseResources();
    }
    collection->selectAlgorithm(0);
    juce::MemoryBlock browsedCollection;
    collection->getStateInformation(browsedCollection);
    collectionMemories = collectionMemories && browsedCollection == collectionBytes;
    for (bool present : covered) coverage = present && coverage;
    coverage = coverage && profileFingerprints.size() == 41 && cases.size() == 50 && existingIndex == 8;
    juce::MemoryBlock defaultAfter, embeddedAfter, untouched;
    defaults->getStateInformation(defaultAfter); embedded->getStateInformation(embeddedAfter);
    auto fresh = std::make_unique<OpenStudioReverb>(true); fresh->getStateInformation(untouched);
    unchanged = defaultBefore == defaultAfter && defaultBefore == untouched && embeddedBefore == embeddedAfter;
    juce::MemoryBlock rejected;
    states = states && ! OpenStudioReverbFactoryPresets::buildState("Unknown factory voice", rejected)
        && ! OpenStudioReverbFactoryPresets::isFactory("OpenStudio NAM Rack", OpenStudioReverbFactoryPresets::voices[0].name);
    result->setProperty("cases", cases); result->setProperty("portableFullStates", states);
    result->setProperty("constructorAndEmbeddedDefaultsUnchanged", unchanged);
    result->setProperty("everyTypeAuthored", coverage); result->setProperty("distinctParameterProfiles", distinctProfiles);
    result->setProperty("collectionContainsEveryProfileAndBrowsesWithoutMutation", collectionMemories);
    result->setProperty("historicalEightFactoryStatesUnchanged", oldVoices);
    result->setProperty("historicalGeneratedIRRecipe", historicalIR.pass);
    result->setProperty("historicalGeneratedIRMaximumULP", static_cast<int>(historicalIR.maximumULP));
    result->setProperty("historicalCompatibilityNegativeControls", negativeControls);
    result->setProperty("historicalComparison", "Exact historical state excluding procedural IR PCM; all PCM samples within two ULPs of the frozen recipe, exact header/silence/direct taps. Windows additionally retains original full-byte hashes.");
    result->setProperty("individualNonselectedFamilyMemoriesUnchanged", otherMemories);
    result->setProperty("authoredEnumsExact", enumControls);
    result->setProperty("collectionSchema", describeFreePluginForRegression(*collection));
    result->setProperty("sixFieldMixLock", mixLock); result->setProperty("finiteNonzeroResponses", finite);
    result->setProperty("responseFiles", files); result->setProperty("directory", directory.getFullPathName());
    result->setProperty("pass", states && unchanged && mixLock && finite && files && coverage
        && distinctProfiles && collectionMemories && oldVoices && otherMemories && enumControls && negativeControls);
    result->setProperty("audioQuality", "not_asserted"); result->setProperty("loudnessMatch", "not_asserted");
    result->setProperty("perceptualDifference", "not_asserted");
    result->setProperty("window", "Two-second diagnostic responses can truncate long tails");
    return result;
}
