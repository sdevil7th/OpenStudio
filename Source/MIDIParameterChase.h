#pragma once
#include <JuceHeader.h>
#include <array>

// Reconstruct complete RPN/NRPN values before expression and chased note-ons.
// Fixed capacity bounds realtime storage/work; the 64 most recently changed
// parameters are retained, including independent RPN 0 and RPN 6 values.
class MIDIParameterChase
{
public:
    static bool isParameterController(int number) noexcept
    {
        return number == 6 || number == 38 || (number >= 96 && number <= 101);
    }
    void add(const juce::MidiMessage& message, double time) noexcept
    {
        if (!message.isController()) return;
        const int channel = message.getChannel(), number = message.getControllerNumber(), value = message.getControllerValue();
        auto& selection = selections[static_cast<size_t>(channel - 1)];
        if (number == 99 || number == 101) { selection.msb = value; selection.nrpn = number == 99; selection.used = true; }
        if (number == 98 || number == 100) { selection.lsb = value; selection.nrpn = number == 98; selection.used = true; }
        if (number == 121)
        {
            selection = { 127, 127, false, true };
            (void) parser.tryParse(channel, 101, 127); (void) parser.tryParse(channel, 100, 127);
            return;
        }
        if (number == 96 || number == 97)
        {
            // RP-018: relative changes are reconstructible only after an
            // absolute value for this parameter. Never invent host defaults.
            const int parameter = selection.msb * 128 + selection.lsb;
            if (selection.nrpn || parameter > 4) return;
            for (auto& record : records)
            {
                auto& messageValue = record.message;
                if (!record.used || !record.relativeBaselineValid || messageValue.channel != channel || messageValue.isNRPN
                    || messageValue.parameterNumber != parameter || time < record.time) continue;
                const int direction = number == 96 ? 1 : -1;
                const int coarse = messageValue.is14BitValue ? messageValue.value / 128 : messageValue.value;
                const int fine = messageValue.is14BitValue ? messageValue.value % 128 : 0;
                if (parameter == 0)
                {
                    const int cents = juce::jlimit(0, 12799, coarse * 100 + fine + direction);
                    messageValue.value = (cents / 100) * 128 + cents % 100;
                    messageValue.is14BitValue = true;
                }
                else if (parameter == 1)
                {
                    messageValue.value = juce::jlimit(0, 16383, coarse * 128 + fine + direction);
                    messageValue.is14BitValue = true;
                }
                else
                {
                    const int next = juce::jlimit(0, 127, coarse + direction);
                    messageValue.value = messageValue.is14BitValue ? next * 128 + fine : next;
                }
                record.time = time; record.sequence = ++sequence;
                // Keep subsequent Data Entry LSB messages based on the updated
                // coarse value, rather than the parser's pre-increment cache.
                (void) parser.tryParse(channel, 6, messageValue.is14BitValue ? messageValue.value / 128 : messageValue.value);
                if (messageValue.is14BitValue) (void) parser.tryParse(channel, 38, messageValue.value % 128);
                break;
            }
            return;
        }
        if (auto parsed = parser.tryParse(channel, number, value))
        {
            if (parsed->parameterNumber == 16383) return;
            if (!parsed->isNRPN && parsed->parameterNumber == 6 && (channel == 1 || channel == 16))
            {
                // MPE zone configuration resets sensitivity. An earlier value
                // is still replayed in order, but cannot seed a later relative
                // edit; require a fresh explicit baseline after configuration.
                const int members = parsed->is14BitValue ? parsed->value / 128 : parsed->value;
                if (members <= 15) for (auto& record : records)
                {
                    const int receiver = record.message.channel;
                    if (record.used && !record.message.isNRPN && record.message.parameterNumber == 0
                        && (channel == 1 ? receiver >= 1 && receiver <= members + 1 : receiver >= 16 - members && receiver <= 16))
                        record.relativeBaselineValid = false;
                }
            }
            size_t target = records.size();
            for (size_t i = 0; i < records.size(); ++i)
                if (records[i].used && records[i].message.channel == channel && records[i].message.isNRPN == parsed->isNRPN
                    && records[i].message.parameterNumber == parsed->parameterNumber) { target = i; break; }
            if (target == records.size())
                for (size_t i = 0; i < records.size(); ++i) if (!records[i].used) { target = i; break; }
            if (target == records.size())
            {
                target = 0;
                for (size_t i = 1; i < records.size(); ++i) if (before(records[i], records[target])) target = i;
            }
            if (!records[target].used || time >= records[target].time)
                records[target] = { *parsed, time, ++sequence, true };
        }
    }
    void append(juce::MidiBuffer& destination) const
    {
        std::array<size_t, 64> ordered {}; size_t count = 0;
        for (size_t i = 0; i < records.size(); ++i) if (records[i].used)
        {
            size_t position = count;
            while (position > 0 && before(records[i], records[ordered[position - 1]]))
            { ordered[position] = ordered[position - 1]; --position; }
            ordered[position] = i; ++count;
        }
        const auto cc = [&destination](int channel, int number, int value)
        { destination.addEvent(juce::MidiMessage::controllerEvent(channel, number, value), 0); };
        for (size_t i = 0; i < count; ++i)
        {
            const auto& message = records[ordered[i]].message;
            cc(message.channel, message.isNRPN ? 99 : 101, message.parameterNumber / 128);
            cc(message.channel, message.isNRPN ? 98 : 100, message.parameterNumber % 128);
            cc(message.channel, 6, message.is14BitValue ? message.value / 128 : message.value);
            if (message.is14BitValue) cc(message.channel, 38, message.value % 128);
        }
        for (size_t i = 0; i < selections.size(); ++i)
        {
            const auto& selection = selections[i];
            if (!selection.used) continue;
            cc(static_cast<int>(i) + 1, selection.nrpn ? 99 : 101, selection.msb);
            cc(static_cast<int>(i) + 1, selection.nrpn ? 98 : 100, selection.lsb);
        }
    }
private:
    struct Record { juce::MidiRPNMessage message {}; double time = 0; size_t sequence = 0; bool used = false, relativeBaselineValid = true; };
    struct Selection { int msb = 127, lsb = 127; bool nrpn = false, used = false; };
    static bool before(const Record& a, const Record& b) noexcept
    { return a.time < b.time || (a.time == b.time && a.sequence < b.sequence); }
    std::array<Record, 64> records {};
    std::array<Selection, 16> selections {};
    size_t sequence = 0;
    juce::MidiRPNDetector parser;
};
