#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <memory>

class TimecodeMIDIOutputDispatcher;

//==============================================================================
// SMPTE Frame Rates
//==============================================================================

enum class SMPTEFrameRate
{
    fps24    = 0,
    fps25    = 1,
    fps2997df = 2, // 29.97 drop frame
    fps30    = 3
};

//==============================================================================
// MIDI Clock Output — sends 24 ppqn to external devices
//==============================================================================

class MIDIClockOutput
{
public:
    MIDIClockOutput();
    ~MIDIClockOutput();

    bool connect(const juce::String& midiOutputName);
    void disconnect();
    bool isConnected() const noexcept;

    void setEnabled(bool enabled) noexcept;
    bool getEnabled() const noexcept { return isEnabled.load(std::memory_order_acquire); }

    // Call from audio callback
    void processBlock(int numSamples, double sampleRate, double bpm, bool playing);

    // Call from a non-audio transport/control thread. These messages may block
    // in the operating-system MIDI driver, but never contend with processBlock().
    void sendStart();
    void sendStop();
    void sendContinue();

private:
    std::unique_ptr<TimecodeMIDIOutputDispatcher> outputDispatcher;
    std::atomic<bool> isEnabled { false };
    std::atomic<bool> resetClockAccumulatorRequested { false };
    double clockAccumulator = 0.0;  // Fractional clock tick accumulator

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIClockOutput)
};

//==============================================================================
// MIDI Clock Input — sync transport to external clock
//==============================================================================

class MIDIClockInput : public juce::MidiInputCallback
{
public:
    MIDIClockInput() = default;
    ~MIDIClockInput() override;

    bool connect(const juce::String& midiInputName);
    void disconnect();
    bool isConnected() const { return input != nullptr; }

    void setEnabled(bool enabled) { isEnabled = enabled; }
    bool getEnabled() const { return isEnabled; }

    // Measured external BPM (smoothed via PLL)
    double getExternalBPM() const { return externalBPM.load(); }
    bool isLocked() const { return locked.load(); }
    bool isExternalPlaying() const { return externalPlaying.load(); }

    // Callback for transport control
    std::function<void()> onExternalStart;
    std::function<void()> onExternalStop;
    std::function<void()> onExternalContinue;
    std::function<void(double bpm)> onBPMUpdate;

    // MidiInputCallback
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;

private:
    std::unique_ptr<juce::MidiInput> input;
    std::atomic<bool> isEnabled { false };
    std::atomic<double> externalBPM { 120.0 };
    std::atomic<bool> locked { false };
    std::atomic<bool> externalPlaying { false };

    // PLL for jitter smoothing
    double lastClockTime = 0.0;
    int clockCount = 0;
    static constexpr int kClocksPerBeat = 24;
    static constexpr int kMeasureWindow = 24; // 1 beat of clocks for BPM measurement

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MIDIClockInput)
};

//==============================================================================
// MTC (MIDI Time Code) — send/receive SMPTE timecode over MIDI
//==============================================================================

class MTCGenerator
{
public:
    MTCGenerator();
    ~MTCGenerator();

    bool connect(const juce::String& midiOutputName);
    void disconnect();
    bool isConnected() const noexcept;

    void setEnabled(bool enabled) noexcept;
    bool getEnabled() const noexcept { return isEnabled.load(std::memory_order_acquire); }

    void setFrameRate(SMPTEFrameRate rate) noexcept;
    SMPTEFrameRate getFrameRate() const noexcept { return frameRate.load(std::memory_order_acquire); }

    // Call from audio callback to send quarter-frame messages
    void processBlock(int numSamples, double sampleRate, double positionSeconds, bool playing);

    // Send a full-frame MTC message from a non-audio control thread
    // (for locate/scrub).
    void sendFullFrame(double positionSeconds);

private:
    std::unique_ptr<TimecodeMIDIOutputDispatcher> outputDispatcher;
    std::atomic<bool> isEnabled { false };
    std::atomic<SMPTEFrameRate> frameRate { SMPTEFrameRate::fps25 };
    std::atomic<bool> resetGeneratorStateRequested { false };

    int qfCounter = 0; // Quarter-frame counter (0-7)
    double qfAccumulator = 0.0;

    struct SMPTETime { int hours; int minutes; int seconds; int frames; };
    static SMPTETime positionToSMPTE(double seconds, SMPTEFrameRate rate);
    static double getActualFrameRate(SMPTEFrameRate rate) noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MTCGenerator)
};

class MTCReceiver : public juce::MidiInputCallback
{
public:
    MTCReceiver() = default;
    ~MTCReceiver() override;

    bool connect(const juce::String& midiInputName);
    void disconnect();
    bool isConnected() const { return input != nullptr; }

    void setEnabled(bool enabled) { isEnabled = enabled; }
    bool getEnabled() const { return isEnabled; }

    double getCurrentPosition() const { return currentPosition.load(); }
    bool isLocked() const { return locked.load(); }

    std::function<void(double positionSeconds)> onPositionUpdate;

    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;

private:
    std::unique_ptr<juce::MidiInput> input;
    std::atomic<bool> isEnabled { false };
    std::atomic<double> currentPosition { 0.0 };
    std::atomic<bool> locked { false };

    // Quarter-frame assembly
    int qfData[8] = {};
    int qfCount = 0;
    SMPTEFrameRate detectedFrameRate = SMPTEFrameRate::fps25;

    double assemblePosition() const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MTCReceiver)
};

//==============================================================================
// Timecode Sync Manager — owns all sync modules
//==============================================================================

class TimecodeSyncManager
{
public:
    TimecodeSyncManager() = default;
    ~TimecodeSyncManager() = default;

    MIDIClockOutput& getClockOutput() { return clockOutput; }
    MIDIClockInput& getClockInput() { return clockInput; }
    MTCGenerator& getMTCGenerator() { return mtcGenerator; }
    MTCReceiver& getMTCReceiver() { return mtcReceiver; }

    enum class SyncSource { Internal, MIDIClock, MTC };

    void setSyncSource(SyncSource source) { syncSource = source; }
    SyncSource getSyncSource() const { return syncSource; }

    // Call from audio callback
    void processBlock(int numSamples, double sampleRate, double bpm,
                      double positionSeconds, bool playing);

    bool isSyncLocked() const;

private:
    MIDIClockOutput clockOutput;
    MIDIClockInput clockInput;
    MTCGenerator mtcGenerator;
    MTCReceiver mtcReceiver;
    SyncSource syncSource = SyncSource::Internal;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TimecodeSyncManager)
};
