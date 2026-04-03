//------------------------------------------------------------------------------
//! \file       ARAPitchInterpretation.h
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

#ifndef ARAPitchInterpretation_h
#define ARAPitchInterpretation_h

#include "ARA_API/ARAInterface.h"

#include <string>

namespace ARA {

//! @addtogroup ARA_Library_Utility_Pitch_Interpretation
//! @{

//! Base class for chord and key signature interpretation, provides basic configuration.
class PitchInterpreter
{
public:
    //! Construct to use ASCII symbols and/or German note names.
    explicit PitchInterpreter (bool useAsciiSymbols = false, bool useGermanNoteNames = false)
    : _asciiSymbols { useAsciiSymbols }, _germanNoteNames { useGermanNoteNames } {}

    bool usesASCIISymbols () const noexcept { return _asciiSymbols; }          //!< True if the interpreter uses ASCII symbols.
    void setUseASCIISymbols (bool use) noexcept { _asciiSymbols = use; }       //!< Enable or disable the use of ASCII symbols.

    bool usesGermanNoteNames () const noexcept { return _germanNoteNames; }    //!< True if the interpreter uses German note names.
    void setUseGermanNoteNames (bool use) noexcept { _germanNoteNames = use; } //!< Enable or disable the use of German note names.

    //! Get the name of the note at the given ::ARACircleOfFifthsIndex.
    //! If usesASCIISymbols() is false, the returned std::string may contain ::ARAUtf8Char (potentially multi-byte) symbols.
    std::string getNoteNameForCircleOfFifthIndex (ARACircleOfFifthsIndex index) const;

protected:
    ARAUtf8String getFlatSymbol () const noexcept;
    ARAUtf8String getSharpSymbol () const noexcept;

private:
    bool _asciiSymbols;
    bool _germanNoteNames;
};

//! Provides a user-readable name for an ARAContentChord based on its interval description.
class ChordInterpreter : public PitchInterpreter
{
public:
    using PitchInterpreter::PitchInterpreter;

    //! Returns true if \p chord is the "no chord".
    //! A chord is considered "no chord" if it contains no notes, i.e. all intervals are unused.
    static bool isNoChord (const ARAContentChord& chord) noexcept;

    //! Get the user-readable name of \p chord.
    //! Will always generate a name based on the abstract chord data and ignore ARAContentChord.name.
    //! If usesASCIISymbols() is false, the returned std::string may contain ::ARAUtf8Char (potentially multi-byte) symbols.
    std::string getNameForChord (const ARAContentChord& chord) const;
};

//! Provides a user-readable name for an ARAContentKeySignature based on its interval description.
class KeySignatureInterpreter : public PitchInterpreter
{
public:
    using PitchInterpreter::PitchInterpreter;

    //! Scale mode type returned from getScaleMode().
    enum ScaleMode
    {
        kInvalid = 0,
        kIonian = 1,
        kDorian = 2,
        kPhrygian = 3,
        kLydian = 4,
        kMixolydian = 5,
        kAeolian = 6,
        kLocrian = 7
    };

    //! True if scale of \p keySignature contains a major third, false otherwise.
    static bool hasMajorThird (const ARAContentKeySignature& keySignature) noexcept { return keySignature.intervals[4] != kARAKeySignatureIntervalUnused; }

    //! True if scale of \p keySignature contains a minor third, false otherwise.
    static bool hasMinorThird (const ARAContentKeySignature& keySignature) noexcept { return keySignature.intervals[3] != kARAKeySignatureIntervalUnused; }

    //! True if scale of \p keySignature contains a major seventh, false otherwise.
    static bool hasMajorSeventh (const ARAContentKeySignature& keySignature) noexcept { return keySignature.intervals[11] != kARAKeySignatureIntervalUnused; }

    //! True if scale of \p keySignature contains a minor seventh, false otherwise.
    static bool hasMinorSeventh (const ARAContentKeySignature& keySignature) noexcept { return keySignature.intervals[10] != kARAKeySignatureIntervalUnused; }

    //! Returns the scale mode of \p keySignature.
    static ScaleMode getScaleMode (const ARAContentKeySignature& keySignature) noexcept;

    //! Get the user-readable name of \p keySignature.
    //! Will always try to generate a name based on the abstract key signature data and ignore ARAContentKeySignature.name.
    //! Only covers a commonly used subset of the key signatures that the abstract key signature data can describe -
    //! will return empty string if no suitable name can be provided.
    //! If usesASCIISymbols() is false, the returned std::string may contain ::ARAUtf8Char (potentially multi-byte) symbols.
    std::string getNameForKeySignature (const ARAContentKeySignature& keySignature) const;

    //! Returns the name of the root note of \p keySignature (useful if getNameForKeySignature() fails).
    //! If usesASCIISymbols() is false, the returned std::string may contain ::ARAUtf8Char (potentially multi-byte) symbols.
    std::string getRootNoteNameForKeySignature (const ARAContentKeySignature& keySignature) const { return getNoteNameForCircleOfFifthIndex(keySignature.root); }
};

//! @} ARA_Library_Utility_Pitch_Interpretation

}   // namespace ARA

#endif // ARAPitchInterpretation_h
