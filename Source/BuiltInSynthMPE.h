#pragma once
#include <JuceHeader.h>
#include <array>

// Audio-thread-owned, fixed-storage MPE expression. No MPEInstrument listeners,
// locks, dynamic note containers, or allocation in event/sample processing.
class BuiltInSynthMPE
{
public:
    using Configuration = std::array<float, 7>;
    struct Expression { float bend = 0, pressure = 0, slide = 0, wheel = 0; };
    void prepare(double rate, const Configuration& values)
    {
        for (auto& channel : voices) for (auto& voice : channel)
        {
            voice.bend.reset(rate, .002); voice.pressure.reset(rate, .02);
            voice.slide.reset(rate, .02); voice.wheel.reset(rate, .02);
        }
        reset(values);
    }
    void reset(const Configuration& values) noexcept
    {
        configuration = values; enabled = values[0] >= .5f;
        lower = { juce::jlimit(0, 15, juce::roundToInt(values[1])), values[3], values[4] };
        upper = { juce::jlimit(0, 15, juce::roundToInt(values[2])), values[5], values[6] };
        if (lower.members > 0 && upper.members > 0 && lower.members + upper.members > 14)
            upper.members = juce::jmax(0, 14 - lower.members);
        resetExpression(); rpn.reset(); selections.fill({});
    }
    bool configure(const Configuration& values) noexcept
    {
        if (values == configuration) return false;
        reset(values); return true;
    }
    bool isEnabled() const noexcept { return enabled; }
    int members(bool isUpper) const noexcept { return isUpper ? upper.members : lower.members; }
    int manager(size_t channel) const noexcept
    {
        if (!enabled) return -1;
        if (lower.members > 0 && channel >= 1 && channel <= static_cast<size_t>(lower.members)) return 0;
        if (upper.members > 0 && channel <= 14 && channel >= static_cast<size_t>(15 - upper.members)) return 15;
        return -1;
    }
    bool isManager(size_t channel) const noexcept
    {
        return enabled && ((channel == 0 && lower.members > 0) || (channel == 15 && upper.members > 0));
    }
    bool affects(size_t sender, size_t receiver) const noexcept
    {
        return sender == receiver || (isManager(sender) && manager(receiver) == static_cast<int>(sender));
    }
    bool pedal(size_t channel) const noexcept
    {
        const int master = manager(channel);
        return channels[channel].pedal || (master >= 0 && channels[static_cast<size_t>(master)].pedal);
    }
    void startVoice(size_t channel, size_t slot) noexcept
    {
        owner[channel] = static_cast<int>(slot);
        auto& voice = voices[channel][slot]; voice.member = channels[channel].expression;
        target(channel, voice, true);
    }
    void stopVoice(size_t channel, size_t slot) noexcept
    {
        if (owner[channel] != static_cast<int>(slot)) return;
        owner[channel] = -1;
        channels[channel].expression.bend = 0;
        channels[channel].expression.pressure = 0;
        channels[channel].expression.slide = 0;
    }
    Expression next(size_t channel, size_t slot) noexcept
    {
        auto& voice = voices[channel][slot];
        return { voice.bend.getNextValue(), voice.pressure.getNextValue(),
                 voice.slide.getNextValue(), voice.wheel.getNextValue() };
    }
    Expression currentTarget(size_t channel, size_t slot) const noexcept
    {
        const auto& voice = voices[channel][slot];
        return { voice.bend.getTargetValue(), voice.pressure.getTargetValue(),
                 voice.slide.getTargetValue(), voice.wheel.getTargetValue() };
    }
    // True means zone topology changed: caller must retire old voices/pedals.
    bool handle(const juce::MidiMessage& message) noexcept
    {
        if (!enabled || message.getChannel() < 1) return false;
        const size_t channel = static_cast<size_t>(message.getChannel() - 1);
        auto& value = channels[channel];
        if (message.isController())
        {
            const int number = message.getControllerNumber(), amount = message.getControllerValue();
            auto& selection = selections[channel];
            if (number == 99 || number == 101) { selection.msb = amount; selection.nrpn = number == 99; }
            if (number == 98 || number == 100) { selection.lsb = amount; selection.nrpn = number == 98; }
            if ((number == 96 || number == 97) && !selection.nrpn && selection.msb == 0 && selection.lsb == 0)
            {
                float* range = nullptr;
                if (channel == 0 && lower.members > 0) range = &lower.masterRange;
                else if (channel == 15 && upper.members > 0) range = &upper.masterRange;
                else if (manager(channel) == 0) range = &lower.memberRange;
                else if (manager(channel) == 15) range = &upper.memberRange;
                if (range != nullptr)
                {
                    const int cents = juce::jlimit(0, 9600, juce::roundToInt(*range * 100) + (number == 96 ? 1 : -1));
                    *range = static_cast<float>(cents) * .01f;
                    (void) rpn.tryParse(message.getChannel(), 6, cents / 100);
                    (void) rpn.tryParse(message.getChannel(), 38, cents % 100);
                    refresh();
                }
                return false;
            }
            if (auto parsed = rpn.tryParse(message.getChannel(), number, amount))
            {
                if (!parsed->isNRPN && parsed->parameterNumber == 6 && (channel == 0 || channel == 15))
                {
                    const int count = parsed->is14BitValue ? parsed->value / 128 : parsed->value;
                    if (count <= 15)
                    {
                        auto& zone = channel == 0 ? lower : upper;
                        auto& other = channel == 0 ? upper : lower;
                        const int oldLower = lower.members, oldUpper = upper.members;
                        zone.members = count; zone.memberRange = 48; zone.masterRange = 2;
                        if (count > 0 && other.members > 0 && count + other.members > 14)
                            other.members = juce::jmax(0, 14 - count);
                        if (oldLower != lower.members || oldUpper != upper.members)
                        { resetExpression(); return true; }
                        refresh();
                    }
                }
                else if (!parsed->isNRPN && parsed->parameterNumber == 0)
                {
                    const float range = juce::jlimit(0.0f, 96.0f, parsed->is14BitValue
                        ? static_cast<float>(parsed->value / 128) + static_cast<float>(parsed->value % 128) * .01f
                        : static_cast<float>(parsed->value));
                    if (channel == 0 && lower.members > 0) lower.masterRange = range;
                    else if (channel == 15 && upper.members > 0) upper.masterRange = range;
                    else if (manager(channel) == 0) lower.memberRange = range;
                    else if (manager(channel) == 15) upper.memberRange = range;
                    refresh();
                }
            }
            if (number == 1) value.expression.wheel = static_cast<float>(amount) / 127;
            else if (number == 74) value.expression.slide = centered(amount, 64, 127);
            else if (number == 64) value.pedal = amount >= 64;
            else if (number == 121)
            {
                for (size_t receiver = 0; receiver < 16; ++receiver) if (affects(channel, receiver))
                {
                    channels[receiver] = {};
                    selections[receiver] = {};
                    for (auto& voice : voices[receiver]) voice.member = {};
                    (void) rpn.tryParse(static_cast<int>(receiver) + 1, 101, 127);
                    (void) rpn.tryParse(static_cast<int>(receiver) + 1, 100, 127);
                }
                refresh(); return false;
            }
            else return false;
        }
        else if (message.isPitchWheel()) value.expression.bend = centered(message.getPitchWheelValue(), 8192, 16383);
        else if (message.isChannelPressure()) value.expression.pressure = static_cast<float>(message.getChannelPressureValue()) / 127;
        else return false;
        if (owner[channel] >= 0)
            voices[channel][static_cast<size_t>(owner[channel])].member = value.expression;
        refresh(); return false;
    }
private:
    struct Selection { int msb = 127, lsb = 127; bool nrpn = false; };
    struct Zone { int members = 0; float memberRange = 48, masterRange = 2; };
    struct Channel { Expression expression; bool pedal = false; };
    struct Voice
    {
        Expression member;
        juce::SmoothedValue<float> bend, pressure, slide, wheel;
    };
    static float centered(int value, int middle, int maximum) noexcept
    {
        return static_cast<float>(value - middle) / static_cast<float>(value < middle ? middle : maximum - middle);
    }
    void resetExpression() noexcept
    {
        channels.fill({}); owner.fill(-1);
        for (auto& channel : voices) for (auto& voice : channel)
        {
            voice.member = {}; voice.bend.setCurrentAndTargetValue(0);
            voice.pressure.setCurrentAndTargetValue(0); voice.slide.setCurrentAndTargetValue(0);
            voice.wheel.setCurrentAndTargetValue(0);
        }
    }
    void target(size_t channel, Voice& voice, bool immediate = false) noexcept
    {
        Expression result = voice.member;
        const int master = manager(channel);
        if (master >= 0)
        {
            const auto& zone = master == 0 ? lower : upper;
            const auto& global = channels[static_cast<size_t>(master)].expression;
            result.bend = result.bend * zone.memberRange + global.bend * zone.masterRange;
            result.pressure = juce::jlimit(0.0f, 1.0f, result.pressure + global.pressure);
            result.slide = juce::jlimit(-1.0f, 1.0f, result.slide + global.slide);
            result.wheel = juce::jlimit(0.0f, 1.0f, result.wheel + global.wheel);
        }
        else result.bend *= 2;
        const auto set = [immediate](auto& control, float value)
        { if (immediate) control.setCurrentAndTargetValue(value); else control.setTargetValue(value); };
        set(voice.bend, result.bend); set(voice.pressure, result.pressure);
        set(voice.slide, result.slide); set(voice.wheel, result.wheel);
    }
    void refresh() noexcept
    {
        for (size_t channel = 0; channel < 16; ++channel)
            for (auto& voice : voices[channel]) target(channel, voice);
    }
    bool enabled = false;
    Configuration configuration {};
    Zone lower, upper;
    std::array<Channel, 16> channels {};
    std::array<Selection, 16> selections {};
    std::array<int, 16> owner {};
    std::array<std::array<Voice, 16>, 16> voices;
    juce::MidiRPNDetector rpn;
};
