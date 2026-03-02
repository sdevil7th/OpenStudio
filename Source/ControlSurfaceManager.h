#pragma once

#include <JuceHeader.h>
#include <map>
#include <vector>
#include <functional>

//==============================================================================
// MIDI CC → DAW parameter mapping
//==============================================================================

struct MIDICCMapping
{
    int channel = 0;         // MIDI channel (0-15, or -1 for any)
    int cc = 0;              // CC number (0-127)
    juce::String trackId;    // Target track ID (or "master")
    juce::String parameter;  // "volume", "pan", "mute", "solo", "recordArm"
};

//==============================================================================
// Callback interface for control surface actions → DAW
//==============================================================================

class ControlSurfaceCallback
{
public:
    virtual ~ControlSurfaceCallback() = default;

    virtual void onControlSurfaceTrackVolume(const juce::String& trackId, float value01) = 0;
    virtual void onControlSurfaceTrackPan(const juce::String& trackId, float valueMinus1To1) = 0;
    virtual void onControlSurfaceTrackMute(const juce::String& trackId, bool muted) = 0;
    virtual void onControlSurfaceTrackSolo(const juce::String& trackId, bool soloed) = 0;
    virtual void onControlSurfaceTrackRecordArm(const juce::String& trackId, bool armed) = 0;
    virtual void onControlSurfaceTransportPlay() = 0;
    virtual void onControlSurfaceTransportStop() = 0;
    virtual void onControlSurfaceTransportRecord() = 0;
    virtual void onControlSurfaceMasterVolume(float value01) = 0;

    // Get current state for feedback
    virtual float getTrackVolume01(const juce::String& trackId) const = 0;
    virtual float getTrackPan(const juce::String& trackId) const = 0;
    virtual bool getTrackMuted(const juce::String& trackId) const = 0;
    virtual bool getTrackSoloed(const juce::String& trackId) const = 0;
    virtual std::vector<juce::String> getTrackIds() const = 0;
};

//==============================================================================
// Generic MIDI Control Surface
//==============================================================================

class GenericMIDIControl : public juce::MidiInputCallback
{
public:
    GenericMIDIControl();
    ~GenericMIDIControl() override;

    void setCallback(ControlSurfaceCallback* cb) { callback = cb; }

    // Connection
    bool connect(const juce::String& midiInputName, const juce::String& midiOutputName);
    void disconnect();
    bool isConnected() const { return connected; }

    // MIDI Learn
    void startLearn(const juce::String& trackId, const juce::String& parameter);
    void cancelLearn();
    bool isLearning() const { return learnActive; }

    // Mapping management
    void addMapping(const MIDICCMapping& mapping);
    void removeMapping(int channel, int cc);
    void clearMappings();
    std::vector<MIDICCMapping> getMappings() const;
    void loadMappings(const juce::File& file);
    void saveMappings(const juce::File& file);

    // Send feedback to motorized faders
    void sendFeedback(const juce::String& trackId, const juce::String& parameter, float value);

    // MidiInputCallback
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;

private:
    ControlSurfaceCallback* callback = nullptr;
    std::unique_ptr<juce::MidiInput> midiInput;
    std::unique_ptr<juce::MidiOutput> midiOutput;
    bool connected = false;

    // MIDI Learn state
    bool learnActive = false;
    juce::String learnTrackId;
    juce::String learnParameter;

    // CC Mappings: key = (channel << 8) | cc
    std::map<int, MIDICCMapping> mappings;
    mutable juce::CriticalSection mappingLock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(GenericMIDIControl)
};

//==============================================================================
// OSC Control Surface
//==============================================================================

class OSCControl : private juce::OSCReceiver::Listener<juce::OSCReceiver::MessageLoopCallback>
{
public:
    OSCControl();
    ~OSCControl() override;

    void setCallback(ControlSurfaceCallback* cb) { callback = cb; }

    bool connect(int receivePort, const juce::String& sendHost, int sendPort);
    void disconnect();
    bool isConnected() const { return connected; }

    // Send state updates to OSC clients
    void sendTrackState(int trackIndex, const juce::String& param, float value);
    void sendTransportState(const juce::String& param, float value);

private:
    // OSCReceiver::Listener
    void oscMessageReceived(const juce::OSCMessage& message) override;

    ControlSurfaceCallback* callback = nullptr;
    juce::OSCReceiver receiver;
    juce::OSCSender sender;
    bool connected = false;

    // Track ID list cache (updated from callback)
    std::vector<juce::String> cachedTrackIds;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OSCControl)
};

//==============================================================================
// Mackie Control Universal (MCU) Protocol
//==============================================================================

class MCUControl : public juce::MidiInputCallback
{
public:
    MCUControl();
    ~MCUControl() override;

    void setCallback(ControlSurfaceCallback* cb) { callback = cb; }

    bool connect(const juce::String& midiInputName, const juce::String& midiOutputName);
    void disconnect();
    bool isConnected() const { return connected; }

    // Send feedback to MCU surface
    void updateFader(int channel, float value01);   // 0-7 for channels
    void updateVPot(int channel, int mode, int value); // LED ring around encoders
    void updateMeter(int channel, int level);        // Channel meter LEDs
    void updateLCD(int channel, const juce::String& topLine, const juce::String& bottomLine);
    void updateButtonLED(int noteNumber, bool on);   // Transport/channel button LEDs

    // Bank navigation
    void setBankOffset(int offset) { bankOffset = offset; refreshSurface(); }
    int getBankOffset() const { return bankOffset; }

    // Full surface refresh (call when tracks change or bank switches)
    void refreshSurface();

    // MidiInputCallback
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;

private:
    // MCU Note Numbers for buttons
    static constexpr int kMCU_RecArm1  = 0x00; // Channels 1-8
    static constexpr int kMCU_Solo1    = 0x08;
    static constexpr int kMCU_Mute1    = 0x10;
    static constexpr int kMCU_Select1  = 0x18;
    static constexpr int kMCU_VPot1    = 0x20;
    static constexpr int kMCU_Rewind   = 0x5B;
    static constexpr int kMCU_Forward  = 0x5C;
    static constexpr int kMCU_Stop     = 0x5D;
    static constexpr int kMCU_Play     = 0x5E;
    static constexpr int kMCU_Record   = 0x5F;
    static constexpr int kMCU_BankLeft = 0x2E;
    static constexpr int kMCU_BankRight= 0x2F;
    static constexpr int kMCU_ChLeft   = 0x30;
    static constexpr int kMCU_ChRight  = 0x31;

    void handleNoteOn(int note, int velocity);
    void handleCC(int cc, int value);
    void handlePitchBend(int channel, int value14bit);

    ControlSurfaceCallback* callback = nullptr;
    std::unique_ptr<juce::MidiInput> midiInput;
    std::unique_ptr<juce::MidiOutput> midiOutput;
    bool connected = false;
    int bankOffset = 0; // Which 8-channel bank we're viewing

    // Cached track IDs (refreshed on bank change)
    std::vector<juce::String> cachedTrackIds;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MCUControl)
};

//==============================================================================
// Control Surface Manager — owns and coordinates all control surfaces
//==============================================================================

class ControlSurfaceManager
{
public:
    ControlSurfaceManager();
    ~ControlSurfaceManager();

    void setCallback(ControlSurfaceCallback* cb);

    GenericMIDIControl& getMIDIControl() { return midiControl; }
    OSCControl& getOSCControl() { return oscControl; }
    MCUControl& getMCUControl() { return mcuControl; }

    // Convenience: get available MIDI devices
    static juce::StringArray getAvailableMIDIInputs();
    static juce::StringArray getAvailableMIDIOutputs();

private:
    GenericMIDIControl midiControl;
    OSCControl oscControl;
    MCUControl mcuControl;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ControlSurfaceManager)
};
