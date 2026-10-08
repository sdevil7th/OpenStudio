#pragma once
#include "MIDIOutputNotePolicy.h"

inline juce::var checkMIDIOutputPolicy()
{
    MIDIOutputNotePolicy policy;
    const auto send = [&policy](int status, int data, int value, bool merge)
    {
        const std::array<std::uint8_t, 3> bytes {
            static_cast<std::uint8_t>(status), static_cast<std::uint8_t>(data),
            static_cast<std::uint8_t>(value) };
        return policy.accept(bytes.data(), 3, merge);
    };
    bool raw = true, merged = true, isolated = true, controllers = true, transitions = true;
    for (int channel = 0; channel < 16; ++channel)
        for (int key = 0; key < 128; ++key)
        {
            policy.reset(false);
            raw = send(0x90 + channel, key, 100, false) && raw;
            raw = send(0x90 + channel, key, 80, false) && raw;
            raw = send(0x80 + channel, key, 64, false) && raw;
            raw = send(0x90 + channel, key, 0, false) && policy.isIdle() && raw;
            policy.reset(true);
            merged = send(0x90 + channel, key, 100, true) && merged;
            merged = !send(0x90 + channel, key, 80, true) && merged;
            merged = !send(0x80 + channel, key, 64, true) && !policy.isIdle() && merged;
            merged = send(0x90 + channel, key, 0, true) && policy.isIdle() && merged;
            merged = !send(0x80 + channel, key, 0, true) && merged;
        }
    policy.reset(true);
    for (int channel = 0; channel < 16; ++channel)
        isolated = send(0x90 + channel, 60, 100, true) && send(0x90 + channel, 61, 100, true) && isolated;
    for (int channel = 0; channel < 16; ++channel)
        isolated = send(0x80 + channel, 60, 0, true) && send(0x80 + channel, 61, 0, true) && isolated;
    isolated = isolated && policy.isIdle();
    for (int cc : { 64, 66, 121 })
    {
        policy.reset(true);
        controllers = send(0x90, 60, 100, true) && send(0xb0, cc, 0, true)
            && !send(0x90, 60, 80, true) && !send(0x80, 60, 0, true)
            && send(0x80, 60, 0, true) && policy.isIdle() && controllers;
    }
    for (int cc : { 120, 123, 124, 125, 126, 127 })
    {
        policy.reset(true);
        controllers = send(0x90, 60, 100, true) && send(0x91, 60, 100, true)
            && send(0xb0, cc, 0, true) && !send(0x80, 60, 0, true)
            && !policy.isIdle() && send(0x81, 60, 0, true) && policy.isIdle() && controllers;
    }
    for (bool initial : { false, true })
    {
        policy.reset(initial);
        transitions = send(0x90, 60, 100, initial) && transitions;
        const bool second = send(0x90, 60, 100, !initial);
        transitions = second == !initial && policy.isMerging() == initial && transitions;
        const bool firstOff = send(0x80, 60, 0, !initial);
        transitions = firstOff == !initial && send(0x80, 60, 0, !initial) && policy.isIdle() && policy.isMerging()==!initial && transitions;
        transitions = send(0x90, 60, 100, !initial) && policy.isMerging() == !initial && transitions;
        policy.reset(!initial);
        transitions = policy.isIdle() && policy.isMerging() == !initial && transitions;
    }
    policy.reset(true);
    bool other = send(0xa0, 60, 127, true) && send(0xe0, 0, 64, true);
    const std::array<std::uint8_t, 2> program { 0xc0, 12 };
    other = policy.accept(program.data(), 2, true) && other;
    send(0x90, 60, 100, true);
    const std::uint8_t reset = 0xff;
    other = policy.accept(&reset, 1, false) && policy.isIdle() && !policy.isMerging() && other;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Hardware MIDI same-key ownership policy");
    result->setProperty("rawAndMerged2048Keys", raw && merged);
    result->setProperty("channelAndKeyIsolation", isolated);
    result->setProperty("controllerOwnership", controllers);
    result->setProperty("idleOnlyPolicyChangesAndReset", transitions);
    result->setProperty("otherMessagesPassUnmodified", other);
    result->setProperty("externalDeviceBehavior", "not_asserted");
    result->setProperty("pass", raw && merged && isolated && controllers && transitions && other);
    return result;
}
