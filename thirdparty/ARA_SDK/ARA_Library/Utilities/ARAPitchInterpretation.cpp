//------------------------------------------------------------------------------
//! \file       ARAPitchInterpretation.cpp
//!             classes to find proper names for pitches, ARAContentChord and ARAContentKeySignature
//!             if not provided by the API partner
//! \project    ARA SDK Library
//! \copyright  Copyright (c) 2018-2022, Celemony Software GmbH, All Rights Reserved.
//! \license    Licensed under the Apache License, Version 2.0 (the "License");
//!             you may not use this file except in compliance with the License.
//!             You may obtain a copy of the License at
//!
//!               http://www.apache.org/licenses/LICENSE-2.0
//!
//!             Unless required by applicable law or agreed to in writing, software
//!             distributed under the License is distributed on an "AS IS" BASIS,
//!             WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//!             See the License for the specific language governing permissions and
//!             limitations under the License.
//------------------------------------------------------------------------------

#include "ARAPitchInterpretation.h"
#include "ARA_Library/Dispatch/ARADispatchBase.h"

#include <algorithm>
#include <cctype>
#include <cstring>

namespace ARA {

// some multi-byte UTF8 chars used in musical notation
#define MUSIC_FLAT_SIGN  "\xE2\x99\xAD"
#define MUSIC_SHARP_SIGN "\xE2\x99\xAF"
#define INCREMENT "\xE2\x88\x86"
#define O_WITH_STROKE "\xC3\xB8"
#define DEGREE_SIGN "\xC2\xB0"

std::string PitchInterpreter::getNoteNameForCircleOfFifthIndex (ARACircleOfFifthsIndex index) const
{
    constexpr char englishNames[] = { 'F', 'C', 'G', 'D', 'A', 'E', 'B' };
    constexpr auto firstValueIndex { -1 };
    constexpr auto lastValueIndex { 5 };
    static_assert (lastValueIndex - firstValueIndex + 1 == sizeof (englishNames) / sizeof (englishNames[0]), "array size/index mismatch");
    static_assert (lastValueIndex - firstValueIndex + 1 == 7, "array size/index mismatch");
    static_assert (englishNames[-firstValueIndex] == 'C', "array size/index mismatch");

    ARAUtf8String accidental { "" };
    auto accidentalCount { 0U };
    char noteName;
    if (index < 0)
    {
        while (index < firstValueIndex)
        {
            ++accidentalCount;
            index += 7;
        }
        index -= firstValueIndex;
        noteName = englishNames[index];
        if (_germanNoteNames && (noteName == 'B'))
            --accidentalCount;
        if (accidentalCount != 0)
            accidental = getFlatSymbol ();
    }
    else
    {
        while (index > lastValueIndex)
        {
            ++accidentalCount;
            index -= 7;
        }
        index -= firstValueIndex;
        noteName = englishNames[index];
        if (_germanNoteNames && (noteName == 'B'))
            noteName = 'H';
        if (accidentalCount != 0)
            accidental = getSharpSymbol ();
    }

    std::string result;
    result.reserve (1 + accidentalCount * std::strlen (accidental));
    result.append (1, noteName);
    while (accidentalCount-- > 0)
        result.append (accidental);

    return result;
}

ARAUtf8String PitchInterpreter::getFlatSymbol () const noexcept
{
    return _asciiSymbols ? "b" : MUSIC_FLAT_SIGN;
}

ARAUtf8String PitchInterpreter::getSharpSymbol () const noexcept
{
    return _asciiSymbols ? "#" : MUSIC_SHARP_SIGN;
}

/*******************************************************************************/

bool ChordInterpreter::isNoChord (const ARAContentChord& chord) noexcept
{
    return std::all_of (std::begin (chord.intervals), std::end (chord.intervals), [] (ARAChordIntervalUsage i) noexcept { return i == kARAChordIntervalUnused; });
}

static inline bool isUnisonChord (const ARAContentChord& chord) noexcept
{
    return std::all_of (std::next (std::begin (chord.intervals)), std::end (chord.intervals), [] (ARAChordIntervalUsage i) noexcept { return i == kARAChordIntervalUnused; });
}

static inline bool testInterval (const ARAChordIntervalUsage* intervals, int interval) noexcept
{
    return (intervals[interval] != kARAChordIntervalUnused);
}

static inline bool testInterval (const ARAChordIntervalUsage* intervals, int interval, ARAChordIntervalUsage usage) noexcept
{
    return (intervals[interval] == usage);
}

static inline bool testAndClearInterval (ARAChordIntervalUsage* intervals, int interval) noexcept
{
    const bool result { testInterval (intervals, interval) };
    if (result)
        intervals[interval] = kARAChordIntervalUnused;
    return result;
}

static inline bool testAndClearInterval (ARAChordIntervalUsage* intervals, int interval, ARAChordIntervalUsage usage) noexcept
{
    const bool result { testInterval (intervals, interval, usage) };
    if (result)
        intervals[interval] = kARAChordIntervalUnused;
    return result;
}

// after evaluating a certain degree at certain intervals, this function is used to clear out
// any other, unexpected usage of that degree by replacing it with kARAChordIntervalUsed
static inline bool cleanupRemainingOccurencesOfDegree (ARAChordIntervalUsage* intervals, ARAChordIntervalUsage usage) noexcept
{
    bool isClean { true };
    for (auto i { 0 }; i < 12; ++i)
    {
        if (intervals[i] == usage)
        {
            intervals[i] = kARAChordIntervalUsed;
            isClean = false;
        }
    }
    return isClean;
}

static inline void appendInterval (std::string& text, const ARAUtf8String prefix, const ARAUtf8String sign, const ARAUtf8String interval) noexcept
{
    if ((prefix == nullptr) && (sign == nullptr) && std::isdigit (static_cast<unsigned char> (text.back ())))
        text += '/';    // separate two consecutive digits by slash

    if (prefix)
        text.append (prefix);
    if (sign)
        text.append (sign);

    text.append (interval);
}

std::string ChordInterpreter::getNameForChord (const ARAContentChord& chord) const
{
    if (isNoChord (chord))
        return "N.C.";

    auto result { getNoteNameForCircleOfFifthIndex (chord.root) };

    if (isUnisonChord (chord) && (chord.root == chord.bass))
    {
        result.append (" bass");
        return result;
    }

    const auto prefixOmit { "omit" };
    const auto prefixAdd { "add" };

    ARAChordIntervalUsage intervals[12];
    std::copy (std::begin (chord.intervals), std::end (chord.intervals), intervals);

    std::string altered;
    std::string added;
    std::string omitted;

    bool canBePowerChord { true };
    // unless a degree of at least 7 is specified, power chord can have no notes (except root and fifth) below minor 7
    for (auto i { 1 }; i < 10; ++i)
    {
        if ((i == 7) || (intervals[i] == kARAChordIntervalUnused))
            continue;

        if ((intervals[i] == kARAChordIntervalUsed) ||
            (intervals[i] < kARAChordDiatonicDegree7))
        {
            canBePowerChord = false;
            break;
        }
    }

    // root note
    if (!testAndClearInterval (intervals, 0))   // ignoring potential degree on root
    {
        appendInterval (omitted, prefixOmit, nullptr, "1");
        canBePowerChord = false;
    }

    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree1);

    // first interval: third (or sus)
    // precedence: check major third before minor, major or minor before sus2 or sus4, sus4 before sus2
    int third { 0 };
    if (testAndClearInterval (intervals, 4, kARAChordDiatonicDegree3))
        third = 4;
    else if (testAndClearInterval (intervals, 3, kARAChordDiatonicDegree3))
        third = 3;
    else if (testAndClearInterval (intervals, 5, kARAChordDiatonicDegree4) ||
             testAndClearInterval (intervals, 5, kARAChordDiatonicDegree3))
        third = 5;
    else if (testAndClearInterval (intervals, 2, kARAChordDiatonicDegree2) ||
             testAndClearInterval (intervals, 2, kARAChordDiatonicDegree3))
        third = 2;
    else if (testAndClearInterval (intervals, 4, kARAChordIntervalUsed))
        third = 4;
    else if (testAndClearInterval (intervals, 3, kARAChordIntervalUsed))
        third = 3;
    else if (testInterval (intervals, 7) &&     // sus4 shall only be implicitly deduced if there's a perfect fifth
             testAndClearInterval (intervals, 5, kARAChordIntervalUsed))
        third = 5;
    else if (testInterval (intervals, 7) &&     // sus2 shall only be implicitly deduced if there's a perfect fifth
             testAndClearInterval (intervals, 2, kARAChordIntervalUsed))
        third = 2;
    else
        appendInterval (omitted, prefixOmit, nullptr, "3");

    canBePowerChord &= (third == 0);

    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree2);
    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree3);
    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree4);

    // second interval: fifth
    // precedence: perfect, flat, sharp
    int fifth { 0 };
    if (testAndClearInterval (intervals, 7))    // ignoring potential degree on fifth
        fifth = 7;
    else if (testAndClearInterval (intervals, 6, kARAChordDiatonicDegree5))
        fifth = 6;
    else if (testAndClearInterval (intervals, 8, kARAChordDiatonicDegree5))
        fifth = 8;
    else if (testAndClearInterval (intervals, 6, kARAChordIntervalUsed))
        fifth = 6;
    else if (testAndClearInterval (intervals, 8, kARAChordIntervalUsed))
        fifth = 8;
    else
        appendInterval (omitted, prefixOmit, nullptr, "5");

    canBePowerChord &= (fifth == 7);

    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree5);

    // third interval: seventh (or 6th)
    // precedence: major 7, minor 7, major 6, minor 6
    int seventh { 0 };
    if (testAndClearInterval (intervals, 11))       // ignoring potential degree on major seventh
        seventh = 11;
    else if (testAndClearInterval (intervals, 10))  // ignoring potential degree on minor seventh
        seventh = 10;
    else if (testAndClearInterval (intervals, 9, kARAChordDiatonicDegree7))
        seventh = 9;

    if (testAndClearInterval (intervals, 9, kARAChordDiatonicDegree6))
    {
        if (seventh != 0)
            appendInterval (added, prefixAdd, nullptr, "6");
        else
            seventh = 9;
    }
    else if (testAndClearInterval (intervals, 8, kARAChordDiatonicDegree6))
    {
        if (seventh != 0)
            appendInterval (added, prefixAdd, getFlatSymbol (), "6");
        else
            seventh = 8;
    }

    if (seventh == 0)
    {
        if (testAndClearInterval (intervals, 8, kARAChordIntervalUsed))
            seventh = 8;
        else if (testAndClearInterval (intervals, 9, kARAChordIntervalUsed))
            seventh = 9;
    }

    canBePowerChord &= (seventh == 0 || seventh >= 10);

    canBePowerChord &= cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree6);
    cleanupRemainingOccurencesOfDegree (intervals, kARAChordDiatonicDegree7);

    // append chord type to string
    bool pending4 { false };
    bool pending7 { seventh >= 10 };
    bool impliesflat5 { false };
    bool impliessharp5 { false };
    if (canBePowerChord)
    {
        result.append ("5");
    }
    else if (third == 4)
    {
        if (fifth == 8)
        {
            result.append ("+");
            impliessharp5 = true;
        }
    }
    else if (third == 3)
    {
        if ((fifth == 6) && (seventh == 10))
        {
            result.append (usesASCIISymbols () ? "halfdim" : O_WITH_STROKE);
            pending7 = false;
            impliesflat5 = true;
        }
        else if ((fifth == 6) && (seventh != 10))
        {
            result.append (usesASCIISymbols () ? "dim" : DEGREE_SIGN);
            impliesflat5 = true;
        }
        else
        {
            result.append ("m");
        }
    }
    else if (third == 2)
    {
        result.append ("sus2");
    }
    else if (third == 5)
    {
        result.append ("sus");
        pending4 = (seventh == 0);
    }

    if (seventh == 11)
        result.append (usesASCIISymbols () ? "maj" : INCREMENT);
    else if (seventh == 8)
        appendInterval (result, nullptr, getFlatSymbol (), "6");
    else if ((seventh == 9) && ((third != 3) || (fifth != 6)))
        appendInterval (result, nullptr, nullptr, "6");

    // first octave alterations
    if ((fifth == 6) && !impliesflat5)
        appendInterval (altered, nullptr, getFlatSymbol (), "5");
    if ((fifth == 8) && !impliessharp5)
        appendInterval (altered, nullptr, getSharpSymbol (), "5");

    // ninth
    bool willBeAdd9 { seventh == 0 };
    int pending9 { 0 };
    if (testInterval (intervals, 2))
    {
        if (willBeAdd9)
            appendInterval (added, prefixAdd, nullptr, "9");
        else
            pending9 = 14;
        willBeAdd9 = true;
    }
    if (testInterval (intervals, 1))
    {
        if (willBeAdd9)
            appendInterval (added, prefixAdd, getFlatSymbol (), "9");
        else
            pending9 = 13;
        willBeAdd9 = true;
    }
    if (testInterval (intervals, 3))
    {
        if (willBeAdd9)
            appendInterval (added, prefixAdd, getSharpSymbol (), "9");
        else
            pending9 = 15;
    }

    if (pending9 != 0)
        pending7 = false;

    // eleventh
    bool willBeAdd11 { pending9 == 0 };
    int pending11 { 0 };
    if (testInterval (intervals, 5))
    {
        if (willBeAdd11)
            appendInterval (added, prefixAdd, nullptr, "11");
        else
            pending11 = 17;
        willBeAdd11 = true;
    }
    if (testInterval (intervals, 4))
    {
        if (willBeAdd11)
            appendInterval (added, prefixAdd, getFlatSymbol (), "11");
        else
            pending11 = 16;
        willBeAdd11 = true;
    }
    if (testInterval (intervals, 6))
    {
        if (willBeAdd11)
            appendInterval (added, prefixAdd, getSharpSymbol (), "11");
        else
            pending11 = 18;
    }

    // thirteenth (will be added immediatley to result or added)
    bool willBeAdd13 { pending9 == 0 };
    bool hasNonAdd13 { false };
    if (testInterval (intervals, 9))
    {
        if (willBeAdd13)
            appendInterval (added, prefixAdd, nullptr, "13");
        else
            appendInterval (result, nullptr, nullptr, "13");
        hasNonAdd13 |= !willBeAdd13;
        willBeAdd13 = true;
    }
    if (testInterval (intervals, 8))
    {
        if (willBeAdd13)
            appendInterval (added, prefixAdd, getFlatSymbol (), "13");
        else
            appendInterval (result, nullptr, getFlatSymbol (), "13");
        hasNonAdd13 |= !willBeAdd13;
        willBeAdd13 = true;
    }
    if (testInterval (intervals, 10))
    {
        if (willBeAdd13)
            appendInterval (added, prefixAdd, getSharpSymbol (), "13");
        else
            appendInterval (result, nullptr, getSharpSymbol (), "13");
        hasNonAdd13 |= !willBeAdd13;
    }

    if ((pending11 != 0) || hasNonAdd13)
    {
        if (pending9 == 13)
            appendInterval (altered, nullptr, getFlatSymbol (), "9");
        else if (pending9 == 15)
            appendInterval (altered, nullptr, getSharpSymbol (), "9");
        pending9 = 0;
    }

    // extensions
    if (pending4)
        result.append ("4");    // continues "sus", can never have digit before

    if (pending7)
        appendInterval (result, nullptr, nullptr, "7");

    if (pending9 != 0)
    {
        if (pending9 == 13)
            appendInterval (result, nullptr, getFlatSymbol (), "9");
        else if (pending9 == 15)
            appendInterval (result, nullptr, getSharpSymbol (), "9");
        else
            appendInterval (result, nullptr, nullptr, "9");
    }

    if (pending11 != 0)
    {
        auto& addTo { (hasNonAdd13) ? added : result };
        if (pending11 == 16)
            appendInterval (addTo, (hasNonAdd13) ? prefixAdd : nullptr, getFlatSymbol (), "11");
        else if (pending11 == 18)
            appendInterval (addTo, (hasNonAdd13) ? prefixAdd : nullptr, getSharpSymbol (), "11");
        else
            appendInterval (addTo, (hasNonAdd13) ? prefixAdd : nullptr, nullptr, "11");
    }

    // additions, alterations, omits
    if (!canBePowerChord)
        result.append (altered);

    result.append (added);

    if (!canBePowerChord)
        result.append (omitted);

    // bass note
    if (chord.root != chord.bass)
    {
        result.append ("/");
        result.append (getNoteNameForCircleOfFifthIndex (chord.bass));
    }

    return result;
}

/*******************************************************************************/

static_assert (sizeof (ARAContentKeySignature::intervals) / sizeof (ARAContentKeySignature::intervals[0] == 12), "key signature note count mismatch");

// for easy comparison, scales are encoded as a 12-bit mask, with highest bit matching lowest byte in the key signature intervals
// this function rotates the scale by one note
static inline void rotateScale (unsigned int& scale) noexcept
{
    constexpr unsigned int overflowMask { 1 << 12 };
    scale = scale << 1;
    if (scale >= overflowMask)
        scale -= overflowMask - 1;
}

KeySignatureInterpreter::ScaleMode KeySignatureInterpreter::getScaleMode (const ARAContentKeySignature& keySignature) noexcept
{
    // convert input to bit mask
    unsigned int inputScale { 0 };
    for (const auto& interval : keySignature.intervals)
    {
        rotateScale (inputScale);
        if (interval != kARAKeySignatureIntervalUnused)
            inputScale += 1;
    }

    // starting from ionian mode, rotate through all the modes and test for match
    unsigned int currentScale { 0xAD5 };
    for (int currentMode { ScaleMode::kIonian }; currentMode <= ScaleMode::kLocrian; ++currentMode)
    {
        if (inputScale == currentScale)
            return static_cast<ScaleMode> (currentMode);

        rotateScale (currentScale);
        if ((currentScale & (1 << 11)) == 0)    // if root is not set, rotate one further
            rotateScale (currentScale);
    }

    return ScaleMode::kInvalid;
}

std::string KeySignatureInterpreter::getNameForKeySignature (const ARAContentKeySignature& keySignature) const
{
    const auto noteName { getNoteNameForCircleOfFifthIndex (keySignature.root) };

    switch (getScaleMode (keySignature))
    {
        case ScaleMode::kInvalid:       break;
        case ScaleMode::kIonian:        return noteName;
        case ScaleMode::kDorian:        return noteName + " Dorian";
        case ScaleMode::kPhrygian:      return noteName + " Phrygian";
        case ScaleMode::kLydian:        return noteName + " Lydian";
        case ScaleMode::kMixolydian:    return noteName + " Mixolydian";
        case ScaleMode::kAeolian:       return noteName + "m";
        case ScaleMode::kLocrian:       return noteName + " Locrian";
    }

    return "";
}

#undef MUSIC_FLAT_SIGN
#undef MUSIC_SHARP_SIGN
#undef INCREMENT
#undef O_WITH_STROKE
#undef DEGREE_SIGN

}   // namespace ARA
