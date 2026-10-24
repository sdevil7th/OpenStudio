#pragma once
#include "BuiltInEffects2.h"

// Explicit, opt-in voices. Generating one never changes constructor defaults,
// a live processor, or a user's stored preset file. The collection deliberately
// authors all type memories; individual voices author only their selected type.
// These parameter choices require listening; they are not acoustic models or a
// perceptually calibrated loudness match.
namespace OpenStudioReverbFactoryPresets
{
enum class Kind { Existing, Individual, Collection };
struct Voice
{
    const char* name;
    const char* character;
    int type;
    // Size, damping, pre-delay, diffusion, low/high cut, early, decay.
    std::array<float, 8> controls;
    float width, wet, outputTrimDb;
    Kind kind = Kind::Existing;
};

// Keep this table and its existing build path stable. New profiles are separate
// choices, so previously selected factory names retain their parameter values.
inline constexpr std::array<Voice, 8> existingVoices {{
    { "Factory - Tight room", "Short, narrow early field with little late wash", 0,
      { .16f, .28f, 3, .25f, 100, 14000, .85f, .38f }, .55f, .25f, 0 },
    { "Factory - Long dark hall", "Broad, delayed tail with restrained high frequencies", 1,
      { .85f, .78f, 42, .90f, 130, 4800, .18f, 5.8f }, 1, .33f, 0 },
    { "Factory - Bright short plate", "Compact plate tank with bright, dense reflections", 2,
      { .32f, .12f, 14, .88f, 180, 16000, .12f, 1.1f }, .95f, .33f, 0 },
    { "Factory - Metallic spring", "Dispersive two-spring response with modest motion", 4,
      { .40f, .22f, 0, .45f, 100, 9500, .25f, 1.7f }, .75f, .30f, 0 },
    { "Factory - Sparse image room", "Off-centre finite image-source reflection field", 16,
      { .72f, .18f, 7, .20f, 100, 14000, .90f, 1.0f }, .85f, .45f, 0 },
    { "Factory - Modulated cloud", "Slow, diffuse cloud with a long softened tail", 19,
      { .82f, .60f, 65, .92f, 180, 6200, .10f, 8.0f }, 1, .28f, -3 },
    { "Factory - Grand gallery", "Spacious digital field with a spread onset", 38,
      { .78f, .35f, 28, .80f, 150, 10500, .70f, 7.5f }, 1, .33f, 0 },
    { "Factory - Shimmer halo", "Long pitch-shifted tail above a dark diffuse field", 5,
      { .68f, .58f, 55, .75f, 240, 7500, .10f, 6.5f }, 1, .22f, -3 }
}};

// Fixed Output trims reserve roughly 3 dB on the original-level shared guitar
// at Dry 70 / Wet 100. They scale the whole mix, never feedback or wet/dry ratio.
// Other source levels and held accumulation still require normal gain staging.
// One deliberately authored profile per selector type. Shared controls are not
// equally meaningful in every topology: family controls below set the actual
// Retro/Cloud decay, Spatial delay and finite envelopes where appropriate.
inline constexpr std::array<Voice, OpenStudioReverb::standaloneTypeCount> profiles {{
    { "Factory - Voiced Room", "Compact bright room; close early image, short restrained tail", 0,
      { .12f, .15f, 4, .32f, 110, 15500, .88f, .42f }, .62f, .34f, -2, Kind::Individual },
    { "Factory - Voiced Hall", "Soft dark hall separated from the source by a delayed onset", 1,
      { .77f, .68f, 38, .86f, 100, 6900, .20f, 4.8f }, 1, .33f, -3, Kind::Individual },
    { "Factory - Voiced Plate", "Bright dense plate with a clear attack and subtle color", 2,
      { .36f, .17f, 12, .94f, 190, 16500, .10f, 1.65f }, .94f, .32f, 0, Kind::Individual },
    { "Factory - Voiced Chamber", "Mid-sized warm chamber with prominent early returns", 3,
      { .39f, .47f, 19, .58f, 75, 10300, .72f, 1.15f }, .74f, .34f, -5, Kind::Individual },
    { "Factory - Voiced Spring", "Driven three-spring twang with strong dispersion and limited motion", 4,
      { .30f, .32f, 0, .28f, 140, 7200, .22f, 1.85f }, .68f, .30f, -4, Kind::Individual },
    { "Factory - Voiced Shimmer", "Octave/fifth pitched input into a dark long tail; no pitch recirculation", 5,
      { .80f, .59f, 78, .91f, 290, 6800, .06f, 11.5f }, 1, .26f, -5, Kind::Individual },
    { "Factory - Voiced Nonlinear", "Short reverse envelope with a small diffuse release", 6,
      { .28f, .24f, 9, .38f, 170, 12500, .12f, .68f }, .82f, .35f, -13, Kind::Individual },
    { "Factory - Voiced Convolution", "Portable generated room IR; trimmed, tightened and early-weighted", 7,
      { .22f, .30f, 6, .42f, 95, 11900, .78f, .70f }, .78f, .35f, -2, Kind::Individual },
    { "Factory - Voiced Church", "Long dark sanctuary with a slow onset and sustained low body", 8,
      { .95f, .76f, 86, .96f, 80, 4200, .22f, 12.0f }, 1, .28f, -2, Kind::Individual },
    { "Factory - Voiced Ambience", "Very short bright close field with little late buildup", 9,
      { .09f, .09f, 0, .20f, 160, 17800, .95f, .24f }, .46f, .42f, -4, Kind::Individual },
    { "Factory - Voiced Vintage hall", "Dark early-digital hall with deliberate slow chorus and buildup", 10,
      { .71f, .57f, 31, .75f, 130, 7700, .18f, 3.9f }, .92f, .34f, -5, Kind::Individual },
    { "Factory - Voiced Vintage random", "Compact brighter randomized tail with faster stationary-tap motion", 11,
      { .42f, .30f, 17, .91f, 210, 13100, .28f, 1.75f }, 1, .34f, -4, Kind::Individual },
    { "Factory - Voiced Contour room", "Sparse integral-tap room with a clearly delayed early image", 12,
      { .21f, .23f, 55, .36f, 125, 14500, .80f, .72f }, .65f, .39f, -3, Kind::Individual },
    { "Factory - Voiced Open hall", "Broad open field with a detached dense arrival", 13,
      { .88f, .37f, 145, .83f, 95, 10400, .26f, 5.2f }, 1, .32f, -3, Kind::Individual },
    { "Factory - Voiced Diffuse loop", "Audible repeating allpass loop, darkened with restrained diffusion", 14,
      { .54f, .72f, 235, .41f, 190, 5600, .14f, 2.8f }, .90f, .37f, -2, Kind::Individual },
    { "Factory - Voiced Magnetic heads", "Three uneven dark echo heads with feedback and slow motion", 15,
      { .48f, .66f, 13, .24f, 150, 6100, .24f, 2.4f }, .81f, .36f, -9, Kind::Individual },
    { "Factory - Voiced Positioned room", "Asymmetric finite image reflections from an off-centre source", 16,
      { .66f, .19f, 8, .12f, 70, 15200, .93f, .82f }, .86f, .42f, 0, Kind::Individual },
    { "Factory - Voiced Rising space", "Long wet swell with an intentionally softened entrance", 17,
      { .73f, .64f, 28, .79f, 220, 6400, .10f, 6.7f }, 1, .33f, -7, Kind::Individual },
    { "Factory - Voiced Bloom field", "Shorter feedback bloom with a pulsing delayed arrival", 18,
      { .57f, .43f, 47, .84f, 160, 9800, .12f, 4.4f }, .96f, .32f, -5, Kind::Individual },
    { "Factory - Voiced Cloud field", "Deep slowly moving cloud with a very long filtered late wash", 19,
      { .91f, .72f, 92, .97f, 250, 5100, .05f, 16.0f }, 1, .26f, -5, Kind::Individual },
    { "Factory - Voiced Vowel hall", "Resonant rounded vowel field with slow formant motion", 20,
      { .63f, .35f, 23, .69f, 180, 8800, .16f, 3.3f }, .93f, .30f, -1, Kind::Individual },
    { "Factory - Voiced Drifting hall", "Warm saturated long hall with slow wow and strong low decay", 21,
      { .82f, .63f, 44, .87f, 90, 5900, .16f, 5.6f }, 1, .32f, -7, Kind::Individual },
    { "Factory - Voiced Drifting chamber", "Tight chamber with quick flutter and little wow", 22,
      { .25f, .29f, 7, .41f, 170, 11700, .63f, .85f }, .68f, .37f, -2, Kind::Individual },
    { "Factory - Voiced Drifting diffuse", "Smoothed medium field with pronounced tape motion", 23,
      { .60f, .48f, 26, .98f, 200, 8200, .12f, 2.7f }, .97f, .34f, -3, Kind::Individual },
    { "Factory - Voiced Clear plate", "Bright fast-dense plate with almost stationary late motion", 24,
      { .33f, .12f, 15, .95f, 240, 17200, .08f, 1.9f }, .96f, .32f, -3, Kind::Individual },
    { "Factory - Voiced Clear room", "Dry-facing sparse room with a direct early pattern", 25,
      { .14f, .19f, 2, .28f, 100, 14800, .91f, .55f }, .57f, .39f, -5, Kind::Individual },
    { "Factory - Voiced Clear random", "Broad randomized clean field with a longer diffuse entrance", 26,
      { .69f, .38f, 36, .81f, 130, 11600, .27f, 3.4f }, 1, .33f, -3, Kind::Individual },
    { "Factory - Voiced Radiant hall", "Bright expansive late field with a moderate onset spread", 27,
      { .75f, .23f, 32, .84f, 170, 15900, .22f, 4.3f }, 1, .32f, -4, Kind::Individual },
    { "Factory - Voiced Diffuse plate", "Dense soft plate field with little early image and low motion", 28,
      { .43f, .53f, 18, .99f, 250, 9200, .06f, 2.1f }, .94f, .34f, -4, Kind::Individual },
    { "Factory - Voiced Compact room", "Small hard room with short decay and strong discrete early image", 29,
      { .07f, .11f, 1, .19f, 145, 18000, .98f, .36f }, .42f, .42f, -2, Kind::Individual },
    { "Factory - Voiced Cross chamber", "Warm nested-loop chamber with a restrained stereo image", 30,
      { .32f, .61f, 14, .57f, 95, 7400, .63f, 1.3f }, .70f, .37f, -4, Kind::Individual },
    { "Factory - Voiced Ensemble space", "Wide moving ensemble tail with a delayed diffuse attack", 31,
      { .65f, .35f, 58, .90f, 220, 12100, .10f, 4.9f }, 1, .29f, -2, Kind::Individual },
    { "Factory - Voiced Reflection field", "Early-dominant low-density reflections with a quiet short tail", 32,
      { .40f, .18f, 6, .23f, 70, 16000, .96f, .95f }, .83f, .41f, -8, Kind::Individual },
    { "Factory - Voiced Vault", "Huge dark vault with long spread and strengthened low body", 33,
      { .97f, .79f, 74, .93f, 65, 3900, .31f, 10.5f }, 1, .27f, -9, Kind::Individual },
    { "Factory - Voiced Grain hall", "Rough early-digital hall with slow movement and darker bandwidth", 34,
      { .70f, .58f, 29, .64f, 180, 7100, .34f, 4.1f }, .87f, .34f, -4, Kind::Individual },
    { "Factory - Voiced Grain plate", "Short gritty bright-digital plate with a sharp entrance", 35,
      { .27f, .32f, 9, .73f, 280, 10400, .12f, 1.4f }, .76f, .36f, -2, Kind::Individual },
    { "Factory - Voiced Shaped reflections", "Finite rising reflection envelope with no recursive late tail", 36,
      { .29f, .23f, 16, .17f, 210, 13700, .88f, .65f }, .89f, .41f, -2, Kind::Individual },
    { "Factory - Voiced Long nave", "Very long dark dual-voice space with a pronounced onset spread", 37,
      { .94f, .70f, 88, .96f, 90, 4700, .39f, 14.0f }, 1, .25f, -5, Kind::Individual },
    { "Factory - Voiced Grand gallery", "Large open gallery with broad early reflections and medium-long decay", 38,
      { .76f, .28f, 24, .78f, 140, 13200, .77f, 6.8f }, 1, .31f, -6, Kind::Individual },
    { "Factory - Voiced Aperture chamber", "Filtered nested chamber with strong loop aperture and short warm decay", 39,
      { .38f, .62f, 11, .62f, 160, 6800, .58f, 1.7f }, .73f, .36f, -3, Kind::Individual },
    { "Factory - Voiced Aperture hall", "Broad aperture hall with a slower filtered late field", 40,
      { .84f, .51f, 49, .88f, 110, 8700, .24f, 5.9f }, 1, .31f, -2, Kind::Individual }
}};

inline constexpr Voice collection { "Factory - Voiced collection",
    "Loads all 41 authored type profiles; select types to browse their stored settings", 0,
    profiles[0].controls, 1, .33f, -14, Kind::Collection };

inline constexpr auto voices = []
{
    std::array<Voice, existingVoices.size() + profiles.size() + 1> result {};
    size_t index = 0;
    for (const auto& voice : existingVoices) result[index++] = voice;
    for (const auto& voice : profiles) result[index++] = voice;
    result[index] = collection;
    return result;
}();

inline bool refinedProfile(int type) noexcept
{
    return type == 2 || type == 19 || (type >= 21 && type <= 40 && type != 36);
}

template <size_t Count>
inline void storeControls(std::array<std::atomic<float>, Count>& destination,
                          const std::array<float, Count>& values) noexcept
{
    for (size_t field = 0; field < Count; ++field) destination[field].store(values[field]);
}

inline bool applyProfile(OpenStudioReverb& processor, const Voice& voice)
{
    for (size_t field = 0; field < voice.controls.size(); ++field)
        processor.setBankValue(voice.type, static_cast<int>(field), voice.controls[field]);
    switch (voice.type)
    {
        case 0: case 1: case 3: case 8: case 9:
        {
            const size_t slot = voice.type == 0 ? 0 : voice.type == 1 ? 1 : voice.type == 3 ? 2 : voice.type == 8 ? 3 : 4;
            constexpr std::array<float, 5> modulation { .015f, .32f, .07f, .24f, 0 };
            constexpr std::array<float, 5> bass { .70f, .85f, 1.12f, 1.35f, .55f };
            constexpr std::array<float, 5> cutoff { 16500, 5700, 9600, 3300, 19000 };
            processor.studioEngines[slot].store(1);
            processor.studioModulation[slot].store(modulation[slot]);
            processor.studioBassRatio[slot].store(bass[slot]);
            storeControls(processor.studioToneControls[slot], { 0, cutoff[slot], 0 });
            if (voice.type == 0) processor.roomCharacter.store(1);
            break;
        }
        case 2:
            processor.plateEngine.store(1); processor.plateCharacter.store(1); processor.plateModulation.store(.035f);
            storeControls(processor.plateToneControls, { 0, 15500, 0 });
            storeControls(processor.plateColourControls, { 3, 160, 1, 1, .14f, 1, 180, -2, 6500, 1.5f });
            break;
        case 4:
            storeControls(processor.springControls, { 1, 2, 1, .93f, .62f, -2.5f, .12f });
            break;
        case 5:
            processor.setBankValue(5, 9, .56f); processor.setBankValue(5, 10, 12);
            processor.setBankValue(5, 11, 19); processor.setBankValue(5, 12, .32f);
            processor.creativeControls[0].store(1); processor.shimmerVoiceEngine.store(1);
            processor.shimmerScheduling.store(1); // Opt-in spread pitch-hop scheduling.
            break;
        case 6:
            processor.setBankValue(6, 13, 2); // Reverse finite envelope.
            for (size_t i = 1; i < processor.creativeControls.size(); ++i)
                processor.creativeControls[i].store(std::array<float, 4> { .12f, .48f, .12f, .55f }[i - 1]);
            processor.nonlinearModulation.store(.04f); processor.nonlinearRate.store(.8f);
            break;
        case 7:
        {
            // Keep the deterministic generated source embedded. This is a shaped
            // version of that source, not a newly claimed acoustic measurement.
            auto* edits = new juce::DynamicObject();
            edits->setProperty("end", .82); edits->setProperty("size", .78);
            edits->setProperty("directDb", -8.0); edits->setProperty("earlyDb", 2.0);
            edits->setProperty("tailDb", -5.0); edits->setProperty("highDecay", .45);
            edits->setProperty("eq2Gain", -1.5); edits->setProperty("eq3Gain", -2.0);
            return processor.convolutionSpace.edit(juce::var(edits));
        }
        case 10: case 11:
        {
            const size_t slot = static_cast<size_t>(voice.type - 10);
            processor.vintageColour[slot].store(slot == 0 ? 0.0f : 1.0f);
            processor.vintageConversion[slot].store(1); processor.vintageTankRate[slot].store(slot == 0 ? 1.0f : 2.0f);
            processor.vintageBuildUp[slot].store(slot == 0 ? 105.0f : 18.0f);
            processor.vintageInputDiffusion[slot].store(slot == 0 ? .58f : .92f);
            processor.vintageModulation[slot].store(slot == 0 ? .52f : .22f);
            processor.vintageRate[slot].store(slot == 0 ? .17f : .78f);
            processor.vintageBassRatio[slot].store(slot == 0 ? 1.15f : .72f);
            processor.vintageBassFrequency[slot].store(slot == 0 ? 390.0f : 730.0f);
            break;
        }
        case 12: case 13: case 14:
        {
            const size_t slot = static_cast<size_t>(voice.type - 12);
            constexpr std::array<std::array<float, 8>, 3> values {{
                { 55, .08f, 0, 8, .38f, .015f, .31f, 1 },
                { 145, .16f, 0, 8, .94f, .21f, .23f, 1 },
                { 235, .57f, 0, 8, .68f, .33f, .48f, 1 }
            }};
            storeControls(processor.spatialControls[slot], values[slot]);
            processor.spatialLowShelf[slot].store(slot == 1 ? -1.5f : -3.0f);
            break;
        }
        case 15:
            storeControls(processor.echoRoomControls[0], { 370, 2, 1, .61f, .29f, 0, .5f, .5f });
            break;
        case 16:
            storeControls(processor.echoRoomControls[1], { 600, 1, 0, .35f, .1f, 2, .17f, .79f });
            break;
        case 17: case 18: case 19: case 20:
        {
            const size_t slot = static_cast<size_t>(voice.type - 17);
            constexpr std::array<std::array<float, 11>, 4> values {{
                { 1.35f, 0, .8f, .30f, .15f, .14f, 0, 1, 10, 0, .82f },
                { .24f, 0, .43f, .72f, .47f, .42f, 0, 1, 10, 0, 1.12f },
                { .5f, 0, .8f, .3f, .82f, .075f, 0, 1, 16, 0, .68f },
                { .5f, 0, .8f, .3f, .36f, .13f, 4, 1, 10, 0, .88f }
            }};
            storeControls(processor.ambientControls[slot], values[slot]);
            if (voice.type == 20) processor.ambBody.store(.5f);
            break;
        }
        case 21: case 22: case 23:
        {
            constexpr std::array<std::array<float, 7>, 3> values {{
                { 9, .43f, .065f, .14f, .66f, 1.18f, 380 },
                { 3, .045f, .37f, 1.1f, .22f, .62f, 720 },
                { 6.5f, .62f, .22f, .37f, .47f, .86f, 520 }
            }};
            storeControls(processor.driftingControls[static_cast<size_t>(voice.type - 21)], values[static_cast<size_t>(voice.type - 21)]);
            break;
        }
        case 24: case 25: case 26:
        {
            constexpr std::array<std::array<float, 6>, 3> values {{
                { .94f, 13, .025f, .22f, .72f, 650 },
                { .25f, 4, .035f, .60f, .62f, 410 },
                { .76f, 94, .44f, .43f, .96f, 580 }
            }};
            storeControls(processor.clearControls[static_cast<size_t>(voice.type - 24)], values[static_cast<size_t>(voice.type - 24)]);
            break;
        }
        default:
        {
            // Decay, attack, early diffusion, depth/rate, era, bass ratio,
            // crossover and aperture are independently authored for all 14.
            constexpr std::array<std::array<float, 9>, 14> values {{
                { 4.3f, .35f, .81f, .22f, .26f, 2, .85f, 530, .25f },
                { 2.1f, .12f, .99f, .075f, .18f, 2, .67f, 740, .25f },
                { .36f, .025f, .18f, 0, .30f, 2, .55f, 360, .25f },
                { 1.3f, .19f, .47f, .13f, .35f, 2, 1.07f, 410, .25f },
                { 4.9f, .64f, .91f, .74f, .57f, 2, .78f, 620, .25f },
                { .95f, .07f, .20f, .035f, .25f, 2, .65f, 480, .25f },
                { 10.5f, .87f, .94f, .28f, .12f, 2, 1.42f, 290, .25f },
                { 4.1f, .38f, .62f, .37f, .19f, 0, 1.10f, 440, .25f },
                { 1.4f, .06f, .73f, .09f, .66f, 1, .69f, 810, .25f },
                { .65f, .91f, .17f, 0, .30f, 2, 1, 500, .25f },
                { 14, .96f, .96f, .48f, .095f, 2, 1.28f, 310, .25f },
                { 6.8f, .49f, .76f, .31f, .31f, 2, .94f, 510, .25f },
                { 1.7f, .16f, .58f, .12f, .27f, 2, .81f, 630, .86f },
                { 5.9f, .69f, .86f, .42f, .21f, 2, 1.13f, 390, .62f }
            }};
            if (voice.type < 27 || voice.type > 40) return false;
            const size_t slot = static_cast<size_t>(voice.type - 27);
            storeControls(processor.retroControls[slot], values[slot]);
            break;
        }
    }
    return true;
}

inline const Voice* find(const juce::String& name) noexcept
{
    for (const auto& voice : voices)
        if (name.equalsIgnoreCase(voice.name))
            return &voice;
    return nullptr;
}

inline bool isFactory(const juce::String& pluginName, const juce::String& name) noexcept
{
    return pluginName == "OpenStudio Reverb" && find(name) != nullptr;
}

inline juce::var metadata(const Voice& voice)
{
    auto* value = new juce::DynamicObject();
    value->setProperty("source", "OpenStudio factory");
    value->setProperty("character", voice.character);
    value->setProperty("reverbType", voice.type);
    value->setProperty("collection", voice.kind == Kind::Collection);
    value->setProperty("authoredTypeCount", voice.kind == Kind::Collection ? 41 : 1);
    value->setProperty("audioQuality", "not_asserted");
    value->setProperty("loudnessMatch", "not_asserted");
    return value;
}

inline bool buildState(const juce::String& name, juce::MemoryBlock& state)
{
    const auto* voice = find(name);
    if (voice == nullptr)
        return false;

    auto processor = std::make_unique<OpenStudioReverb>(true);
    processor->reverbControlMode.store(voice->kind == Kind::Existing ? 0.0f : 1.0f);
    processor->selectAlgorithm(voice->type);
    if (voice->kind != Kind::Existing)
    {
        if (voice->kind == Kind::Collection)
        {
            for (const auto& profile : profiles)
                if (! applyProfile(*processor, profile)) return false;
        }
        else if (! applyProfile(*processor, *voice)) return false;
        processor->width.store(voice->width);
        processor->wetLevel.store(voice->wet); processor->insertWet.store(voice->wet);
        processor->outputTrimDb.store(voice->outputTrimDb);
        processor->reverbCharacterMode.store(voice->kind == Kind::Collection || refinedProfile(voice->type) ? 1.0f : 0.0f);
        processor->getStateInformation(state);
        return !state.isEmpty();
    }
    for (size_t field = 0; field < voice->controls.size(); ++field)
        processor->setBankValue(voice->type, static_cast<int>(field), voice->controls[field]);
    processor->width.store(voice->width);
    processor->wetLevel.store(voice->wet);
    processor->insertWet.store(voice->wet);
    processor->outputTrimDb.store(voice->outputTrimDb);
    processor->reverbCharacterMode.store(voice->type == 2 || voice->type == 19 || voice->type >= 21 ? 1.0f : 0.0f);

    switch (voice->type)
    {
        case 0:
            processor->studioModulation[0].store(.02f);
            processor->studioBassRatio[0].store(.75f);
            break;
        case 1:
            processor->studioModulation[1].store(.35f);
            processor->studioBassRatio[1].store(.80f);
            break;
        case 2:
            processor->plateCharacter.store(0);
            processor->plateModulation.store(.08f);
            break;
        case 4:
            processor->springControls[0].store(1); // Dispersive engine.
            processor->springControls[1].store(1); // Two springs.
            processor->springControls[2].store(.40f);
            processor->springControls[3].store(.90f);
            processor->springControls[4].store(.68f);
            processor->springControls[5].store(-2);
            processor->springControls[6].store(.12f);
            break;
        case 16:
            processor->echoRoomControls[1][5].store(1); // Non-square geometry.
            processor->echoRoomControls[1][6].store(.22f);
            processor->echoRoomControls[1][7].store(.72f);
            break;
        case 19:
            processor->ambientControls[2][4].store(.70f);
            processor->ambientControls[2][5].store(.12f);
            processor->ambientControls[2][8].store(8);
            processor->ambientControls[2][10].store(.85f);
            break;
        case 38:
            processor->retroControls[11][0].store(7.5f);
            processor->retroControls[11][1].store(.65f);
            processor->retroControls[11][2].store(.85f);
            processor->retroControls[11][3].store(.38f);
            processor->retroControls[11][4].store(.18f);
            processor->retroControls[11][6].store(.80f);
            break;
        case 5:
            processor->setBankValue(5, 9, .38f);
            processor->setBankValue(5, 10, 12);
            processor->setBankValue(5, 11, 7);
            processor->setBankValue(5, 12, .25f);
            processor->creativeControls[0].store(0); // Tank-source pitch routing.
            break;
        default:
            break;
    }
    processor->getStateInformation(state);
    return !state.isEmpty();
}

// Match the existing editor Mix Lock contract when a factory voice is recalled
// directly through the native API, as well as through the shared toolbar.
inline void preserveLockedMix(const OpenStudioReverb& processor, juce::MemoryBlock& state)
{
    if (processor.mixLock.load() < .5f)
        return;
    auto tree = juce::ValueTree::readFromData(state.getData(), state.getSize());
    tree.setProperty("wetLevel", processor.wetLevel.load(), nullptr);
    tree.setProperty("dryLevel", processor.dryLevel.load(), nullptr);
    tree.setProperty("sendMode", processor.sendMode.load(), nullptr);
    tree.setProperty("mixLock", processor.mixLock.load(), nullptr);
    tree.setProperty("insertWet", processor.insertWet.load(), nullptr);
    tree.setProperty("insertDry", processor.insertDry.load(), nullptr);
    juce::MemoryOutputStream stream(state, false);
    tree.writeToStream(stream);
}
}
