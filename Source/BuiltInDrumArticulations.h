#pragma once
#include <JuceHeader.h>

// Original synthesized articulation contracts. The extended input map follows
// published note identities; no sampled content or reference timbre is included.
namespace BuiltInDrumArticulations
{
enum class Kind { Legacy, Kick, Snare, SideStick, RimShot, RimOnly, SnareEdge, Tom, TomRim, TomRimOnly,
    HatTip, HatEdge, PedalClosed, PedalOpen, RideBow, RideBell, RideEdge, CymbalBow, Crash, Muted, Shaker, Tambourine, OneShot };
struct Voice
{
    int note = 60;
    Kind kind = Kind::Legacy;
    float openness = 0;
    const char* label = "Fallback percussion";
    bool choke = false, closesHat = false;
};
inline Voice hat(bool edge, float openness) noexcept
{
    return {openness >= 0 && openness <= .025f ? 42 : 46, edge ? Kind::HatEdge : Kind::HatTip, openness,
        edge ? (openness == 0 ? "Closed edge hat" : openness < 0 ? "Pedal-controlled edge hat" : "Open edge hat")
             : (openness == 0 ? "Closed tip hat" : openness < 0 ? "Pedal-controlled tip hat" : "Open tip hat"), openness != 0, openness >= 0 && openness <= .025f};
}
inline Voice snare(int style) noexcept
{
    switch(style){case 1:return {37,Kind::SideStick,0,"Side stick"};case 2:return {40,Kind::RimShot,0,"Snare rimshot"};case 3:return {38,Kind::RimOnly,0,"Snare rim only"};case 4:return {38,Kind::SnareEdge,0,"Snare edge"};default:return {38,Kind::Snare,0,"Snare centre"};}
}
inline Voice tom(int note,int style=0) noexcept {return {note,style==1?Kind::TomRim:style==2?Kind::TomRimOnly:Kind::Tom,0,style==1?"Tom rimshot":style==2?"Tom rim only":"Tom centre"};}
inline Voice ride(int style=0) noexcept {return {51,style==1?Kind::RideBell:style==2?Kind::RideEdge:style==3?Kind::Muted:Kind::RideBow,0,style==1?"Ride bell":style==2?"Ride edge":style==3?"Muted ride":"Ride bow",true};}
inline Voice crash(int note=49,bool muted=false) noexcept {return {note,muted?Kind::Muted:Kind::Crash,0,muted?"Muted crash":"Crash",true};}
inline Voice identify(int map,int note) noexcept
{
    if(map==2)
    {
        switch(note)
        {
            case 0:case 4:case 5:return {-1,Kind::Legacy,0,"Unassigned"};
            case 1:return {60,Kind::OneShot,0,"Synthetic one shot"};
            case 2:return {69,Kind::Shaker,0,"Shaker"};case 3:return {54,Kind::Tambourine,0,"Tambourine"};
            case 6:return snare(0);
            case 7:case 18:case 20:return hat(true,-1);
            case 8:case 9:case 19:return hat(false,-1);
            case 10:case 21:case 44:return {44,Kind::PedalClosed,0,"Pedal closed",false,true};
            case 11:case 42:case 61:case 119:return hat(false,0);
            case 12:return hat(false,.12f);case 13:return hat(false,.28f);case 14:return hat(false,.44f);
            case 15:return hat(false,.62f);case 16:return hat(false,.8f);case 17:return hat(false,1);
            case 22:case 65:case 122:return hat(true,0);
            case 23:return {46,Kind::PedalOpen,.65f,"Pedal open",true};
            case 24:return hat(true,.28f);case 25:case 46:case 123:return hat(true,.44f);
            case 26:return hat(true,.62f);case 60:case 121:return hat(true,.8f);
            case 64:case 120:return hat(true,.12f);case 124:return hat(true,1);
            case 62:return hat(true,.025f);case 63:return hat(false,.025f);
            case 27:case 29:case 31:case 51:case 104:case 108:case 111:case 113:case 116:return ride();
            case 30:case 53:case 85:case 88:case 90:case 92:case 97:case 100:case 102:case 105:case 109:case 112:case 114:case 117:return ride(1);
            case 52:case 59:case 110:case 115:return ride(2);
            case 54:case 93:case 118:return ride(3);
            case 28:case 49:case 91:return crash(49);
            case 32:case 57:case 103:return crash(57);
            case 55:case 86:return crash(55);
            case 84:case 87:return {55,Kind::CymbalBow,0,"Crash bow",true};
            case 89:return {49,Kind::CymbalBow,0,"Crash bow",true};case 96:return {52,Kind::CymbalBow,0,"Crash bow",true};case 101:return {57,Kind::CymbalBow,0,"Crash bow",true};
            case 98:return crash(52);
            case 50:case 94:case 95:return crash(49,true);
            case 56:return crash(55,true);case 58:case 106:case 107:return crash(57,true);case 99:return crash(52,true);
            case 33:return snare(4);
            case 34:case 35:case 36:return {36,Kind::Kick,0,"Kick"};
            case 37:case 66:case 67:case 127:return snare(1);
            case 38:case 39:case 68:case 69:case 70:case 125:return snare(0);
            case 40:case 126:return snare(2);
            case 71:case 76:return snare(3);
            case 41:case 43:case 45:case 47:case 48:return tom(note);
            case 72:return tom(41,2);case 73:return tom(41,1);case 74:return tom(43,2);case 75:return tom(43,1);
            case 77:return tom(45,2);case 78:return tom(45,1);case 79:return tom(47,2);case 80:return tom(47,1);
            case 81:return tom(48,2);case 82:return tom(48,1);case 83:return {48,Kind::Muted,0,"Muted tom"};
            default:return {-1,Kind::Legacy,0,"Unassigned"};
        }
    }
    if(map==1)
    {
        switch(note){case 22:return hat(true,0);case 26:return hat(true,1);case 47:return tom(45,1);case 50:return tom(48,1);case 58:return tom(43,1);case 55:return crash(49);case 52:return crash(57);case 59:return ride(2);case 53:return ride(1);default:break;}
    }
    switch(note)
    {
        case 35:case 36:return {note,Kind::Kick,0,"Kick"};
        case 37:return snare(1);case 38:return snare(0);case 40:return snare(2);
        case 22:case 42:return hat(false,0);case 44:return {44,Kind::PedalClosed,0,"Pedal closed",false,true};
        case 26:case 46:return hat(false,1);
        case 41:case 43:case 45:case 47:case 48:case 50:return tom(note);
        case 51:return ride();case 53:return ride(1);case 59:return ride(2);
        case 49:case 52:case 55:case 57:return crash(note);
        case 54:return {54,Kind::Tambourine,0,"Tambourine"};case 69:case 70:return {69,Kind::Shaker,0,"Shaker"};
        default:return {note,Kind::Legacy,0,"Fallback percussion"};
    }
}
inline bool isHat(Kind kind) noexcept {return kind==Kind::HatTip||kind==Kind::HatEdge||kind==Kind::PedalClosed||kind==Kind::PedalOpen;}
inline float decay(const Voice& voice,float pedal) noexcept
{
    const float openness=voice.openness<0?juce::jlimit(0.0f,1.0f,1-pedal):voice.openness;
    switch(voice.kind)
    {
        case Kind::Kick:return .34f;case Kind::Snare:return .18f;case Kind::SideStick:return .055f;case Kind::RimShot:return .22f;case Kind::RimOnly:return .07f;case Kind::SnareEdge:return .12f;
        case Kind::Tom:return .3f;case Kind::TomRim:return .2f;case Kind::TomRimOnly:return .085f;
        case Kind::HatTip:case Kind::HatEdge:return .025f+.55f*openness;case Kind::PedalClosed:return .035f;case Kind::PedalOpen:return .18f;
        case Kind::RideBow:return .8f;case Kind::RideBell:return .65f;case Kind::RideEdge:return 1.0f;case Kind::CymbalBow:return .85f;case Kind::Crash:return 1.1f;case Kind::Muted:return .065f;
        case Kind::Shaker:return .055f;case Kind::Tambourine:return .16f;case Kind::OneShot:return .12f;default:return .2f;
    }
}
inline float render(const Voice& voice,std::array<float,4>& phases,float frequency,float rate,float age,float noise,float velocity,float pedal,float punch) noexcept
{
    size_t oscillator=0;
    const auto sine=[&](float ratio){auto& phase=phases[oscillator++];phase+=frequency*ratio/rate;phase-=std::floor(phase);return frequency*ratio<rate*.45f?std::sin(juce::MathConstants<float>::twoPi*phase):0.0f;};
    const float envelope=std::exp(-age/decay(voice,pedal));
    const float strike=std::exp(-age/.009f),brightness=.6f+.4f*velocity;
    switch(voice.kind)
    {
        case Kind::Kick:return (1.15f*sine(1)*envelope+noise*strike*.2f*(.7f+punch));
        case Kind::Snare:return (noise*.72f*brightness+sine(1)*.34f)*envelope;
        case Kind::SideStick:return (.75f*sine(2.4f)+.25f*sine(4.1f))*envelope+noise*.15f*strike;
        case Kind::RimShot:return (noise*.7f+sine(1)*.42f+sine(3.1f)*.32f)*envelope;
        case Kind::RimOnly:return (sine(3.1f)*.65f+sine(4.8f)*.3f)*envelope;
        case Kind::SnareEdge:return (noise*.88f+sine(1.3f)*.16f)*envelope;
        case Kind::Tom:return (sine(1)*.9f+sine(1.59f)*.12f)*envelope+noise*.08f*strike;
        case Kind::TomRim:return (sine(1)*.65f+sine(3.1f)*.32f+noise*.12f)*envelope;
        case Kind::TomRimOnly:return (sine(3.1f)*.55f+sine(4.7f)*.28f)*envelope;
        case Kind::HatTip:return (noise*.55f+sine(7.1f)*.24f+sine(11.7f)*.18f)*envelope;
        case Kind::HatEdge:return (noise*.78f+sine(5.3f)*.22f+sine(8.7f)*.2f)*envelope;
        case Kind::PedalClosed:return (noise*.7f+sine(6.3f)*.25f)*envelope;
        case Kind::PedalOpen:return (noise*.65f+sine(6.3f)*.2f+sine(10.1f)*.15f)*envelope;
        case Kind::RideBow:return (noise*.24f+sine(1)*.4f+sine(2.73f)*.24f+sine(5.1f)*.12f)*envelope;
        case Kind::RideBell:return (sine(1.8f)*.6f+sine(4.13f)*.3f+noise*.07f)*envelope;
        case Kind::RideEdge:return (noise*.55f+sine(1.41f)*.26f+sine(5.3f)*.17f)*envelope;
        case Kind::CymbalBow:return (noise*.3f+sine(1.3f)*.4f+sine(3.7f)*.22f)*envelope;
        case Kind::Crash:return (noise*.64f+sine(5.3f)*.15f+sine(9.7f)*.12f)*envelope;
        case Kind::Muted:return (noise*.48f+sine(2.7f)*.28f)*envelope;
        case Kind::Shaker:return noise*.8f*envelope;
        case Kind::Tambourine:return (noise*.45f+sine(5.7f)*.3f+sine(9.3f)*.22f)*envelope;
        case Kind::OneShot:return (noise*.45f+sine(1)*.5f)*envelope;
        default:return 0;
    }
}
}
