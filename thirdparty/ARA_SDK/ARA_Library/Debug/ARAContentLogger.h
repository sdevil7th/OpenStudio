//------------------------------------------------------------------------------
//! \file       ARAContentLogger.h
//!             class to conveniently log (and validate) ARA content
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

#ifndef ARAContentLogger_h
#define ARAContentLogger_h

#include "ARA_Library/Debug/ARADebug.h"
#if ARA_VALIDATE_API_CALLS
    #include "ARA_Library/Debug/ARAContentValidator.h"
#endif

#if ARA_ENABLE_DEBUG_OUTPUT

#include "ARA_Library/Dispatch/ARAContentReader.h"
#include "ARA_Library/Utilities/ARAPitchInterpretation.h"

#include <array>

namespace ARA {

/*******************************************************************************/
// ContentLogger
// Debugging tool to print all content reported by the API partner.
/*******************************************************************************/

struct ContentLogger
{
    template <typename ControllerType, typename ModelObjectRefType>
    using ContentReaderRef = typename std::result_of<decltype (ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::createContentReader)(ControllerType, ModelObjectRefType, ARAContentType, const ARAContentTimeRange*)>::type;

    template <ARAContentType contentType, typename ControllerType, typename ModelObjectRefType>
#if ARA_VALIDATE_API_CALLS
    using ContentValidator = ContentValidator<contentType, ControllerType, ContentReaderRef<ControllerType, ModelObjectRefType>>;
#else
    using ContentValidator = NoContentValidator<contentType, ControllerType, ContentReaderRef<ControllerType, ModelObjectRefType>>;
#endif

    template <ARAContentType contentType, typename ControllerType, typename ModelObjectRefType>
    using ContentReader = ContentReader<contentType, ControllerType, ContentReaderRef<ControllerType, ModelObjectRefType>, ContentValidator<contentType, ControllerType, ModelObjectRefType>>;

    // array of all content types defined in the api

    static inline constexpr std::array<ARAContentType, 6> getAllContentTypes () noexcept
    {
        return { { kARAContentTypeNotes,
                   kARAContentTypeTempoEntries, kARAContentTypeBarSignatures,
                   kARAContentTypeStaticTuning,
                   kARAContentTypeKeySignatures, kARAContentTypeSheetChords
               } };
    }

    // logging of time ranges

    static inline double getStartOfRange (const ARAContentTimeRange* range)
    {
        return (range) ? range->start : -std::numeric_limits<ARATimePosition>::infinity ();
    }

    static inline double getEndOfRange (const ARAContentTimeRange* range)
    {
        return (range) ? range->start + range->duration : std::numeric_limits<ARATimeDuration>::infinity ();
    }

    // debug text helpers

    static inline const char* getEnumNameForContentType (ARAContentType contentType) noexcept
    {
        switch (contentType)
        {
            case kARAContentTypeNotes:         return ContentTypeMapper<kARAContentTypeNotes>::enumName;
            case kARAContentTypeTempoEntries:  return ContentTypeMapper<kARAContentTypeTempoEntries>::enumName;
            case kARAContentTypeBarSignatures: return ContentTypeMapper<kARAContentTypeBarSignatures>::enumName;
            case kARAContentTypeStaticTuning:  return ContentTypeMapper<kARAContentTypeStaticTuning>::enumName;
            case kARAContentTypeKeySignatures: return ContentTypeMapper<kARAContentTypeKeySignatures>::enumName;
            case kARAContentTypeSheetChords:   return ContentTypeMapper<kARAContentTypeSheetChords>::enumName;
            default: ARA_INTERNAL_ASSERT (false); return "kARAContentType???";
        }
    }

    static inline const char* getTypeNameForContentType (ARAContentType contentType) noexcept
    {
        switch (contentType)
        {
            case kARAContentTypeNotes:         return ContentTypeMapper<kARAContentTypeNotes>::typeName;
            case kARAContentTypeTempoEntries:  return ContentTypeMapper<kARAContentTypeTempoEntries>::typeName;
            case kARAContentTypeBarSignatures: return ContentTypeMapper<kARAContentTypeBarSignatures>::typeName;
            case kARAContentTypeStaticTuning:  return ContentTypeMapper<kARAContentTypeStaticTuning>::typeName;
            case kARAContentTypeKeySignatures: return ContentTypeMapper<kARAContentTypeKeySignatures>::typeName;
            case kARAContentTypeSheetChords:   return ContentTypeMapper<kARAContentTypeSheetChords>::typeName;
            default: ARA_INTERNAL_ASSERT (false); return "ARAContent???";
        }
    }

    static inline const char* getNameForContentGrade (ARAContentGrade contentGrade) noexcept
    {
        switch (contentGrade)
        {
            case kARAContentGradeInitial:  return "initial";
            case kARAContentGradeDetected: return "detected";
            case kARAContentGradeAdjusted: return "adjusted";
            case kARAContentGradeApproved: return "approved";
            default: ARA_INTERNAL_ASSERT (false); return "kARAContentGrade???";
        }
    }

    // Logging individual content events
    // The value of \p idx is used only for decorating the output, e.g. when log() and its variants are iterating over content events.
    static inline void logEvent (ARAInt32 idx, const ARAContentNote& noteData)
    {
        if ((noteData.frequency == kARAInvalidFrequency) || (noteData.pitchNumber == kARAInvalidPitchNumber))
        {
            ARA_LOG ("%s[%i] no pitch, vol = %.3f, %.3f - %.3f - %.3f - %.3f", getTypeNameForContentType (kARAContentTypeNotes), idx,
                noteData.volume,
                noteData.startPosition, noteData.startPosition + noteData.attackDuration,
                noteData.startPosition + noteData.noteDuration, noteData.startPosition + noteData.signalDuration);
        }
        else
        {
            const std::array<const char*, 12> noteNames { "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B" };
            ARA_LOG ("%s[%i] %.2f Hz (%i, %s), vol = %.3f, %.3f - %.3f - %.3f - %.3f", getTypeNameForContentType (kARAContentTypeNotes), idx,
                noteData.frequency, noteData.pitchNumber, noteNames[static_cast<size_t> (noteData.pitchNumber % 12)], noteData.volume,
                noteData.startPosition, noteData.startPosition + noteData.attackDuration,
                noteData.startPosition + noteData.noteDuration, noteData.startPosition + noteData.signalDuration);
        }
    }

    static inline void logEvent (ARAInt32 idx, const ARAContentTempoEntry& tempoData)
    {
        ARA_LOG ("%s[%i] sec = %.3f, quarters = %.3f", getTypeNameForContentType (kARAContentTypeTempoEntries), idx, tempoData.timePosition, tempoData.quarterPosition);
    }

    static inline void logEvent (ARAInt32 idx, const ARAContentBarSignature& signatureData)
    {
        ARA_LOG ("%s[%i] %i/%i, quarters = %.3f", getTypeNameForContentType (kARAContentTypeBarSignatures), idx, signatureData.numerator, signatureData.denominator, signatureData.position);
    }

    static inline void logEvent (ARAInt32 idx, const ARAContentTuning& tuning)
    {
        static const PitchInterpreter interpreter { true };
        const auto rootName { interpreter.getNoteNameForCircleOfFifthIndex (tuning.root) };

        ARA_LOG ("%s[%i] %.2f, %s {%.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f}",
            getTypeNameForContentType (kARAContentTypeStaticTuning), idx,
            tuning.concertPitchFrequency, rootName.c_str (),
            tuning.tunings[0], tuning.tunings[1], tuning.tunings[2], tuning.tunings[3],
            tuning.tunings[4], tuning.tunings[5], tuning.tunings[6], tuning.tunings[7],
            tuning.tunings[8], tuning.tunings[9], tuning.tunings[10], tuning.tunings[11]);
    }

    static inline void logEvent (ARAInt32 idx, const ARAContentKeySignature& signatureData)
    {
        const auto logGivenName { signatureData.name != nullptr };

        static const KeySignatureInterpreter interpreter { true };
        const auto parsedSignatureName { interpreter.getNameForKeySignature (signatureData) };
        const auto logParsedName { !parsedSignatureName.empty () && (!logGivenName || (parsedSignatureName.compare (signatureData.name) != 0)) };

        ARA_LOG ("%s[%i] %s%s%s, quarters = %.3f", getTypeNameForContentType (kARAContentTypeKeySignatures), idx,
            (logGivenName) ? signatureData.name : (logParsedName) ? parsedSignatureName.c_str () : (interpreter.getRootNoteNameForKeySignature (signatureData) + " ???").c_str (),
            (logGivenName && logParsedName) ? " aka " : "", (logGivenName && logParsedName) ? parsedSignatureName.c_str () : "", signatureData.position);
    }

    static inline void logEvent (ARAInt32 idx, const ARAContentChord& chordData)
    {
        const auto logGivenName { chordData.name != nullptr };

        static const ChordInterpreter interpreter { true };
        const auto parsedChordName { interpreter.getNameForChord (chordData) };
        const auto logParsedName { !logGivenName || (parsedChordName.compare (chordData.name) != 0) };

        ARA_LOG ("%s[%i] %s%s%s, quarters = %.3f", getTypeNameForContentType (kARAContentTypeSheetChords), idx,
            (logGivenName) ? chordData.name : parsedChordName.c_str (),
            (logGivenName && logParsedName) ? " aka " : "", (logGivenName && logParsedName) ? parsedChordName.c_str () : "", chordData.position);
    }

    // internal helper for log ()

    template <ARAContentType contentType, typename ContentReader, typename std::enable_if<contentType != kARAContentTypeTempoEntries, bool>::type = true>
    static inline void logEventIteration (ContentReader& reader, ARAInt32 i)
    {
        logEvent (i, reader[i]);
    }
    template <ARAContentType contentType, typename ContentReader, typename std::enable_if<contentType == kARAContentTypeTempoEntries, bool>::type = true>
    static inline void logEventIteration (ContentReader& reader, ARAInt32 i)
    {
        const auto event { reader[i] };
        if (i != 0)
        {
            const auto prevEvent { reader[i - 1] };
            const auto tempo { 60.0 * (event.quarterPosition - prevEvent.quarterPosition) / (event.timePosition - prevEvent.timePosition) };
            ARA_LOG ("tempo between entries [%i:%i] is %.2f BPM", i - 1, i, tempo);
        }
        logEvent (i, event);
    }

    // Logging Model Objects
    // Log content associated with the model object referenced by \p modelObjectRef.
    // If \p range is not nullptr, the logged content will be limited to events with \p range.

    // Main logging method, with \p contentType being a template parameter.
    // Returns true if any content of type \p contentType was available for \p modelObjectRef.
    template <ARAContentType contentType, typename ControllerType, typename ModelObjectRefType>
    static inline bool log (ControllerType& controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range = nullptr, bool logIfNotAvailable = true)
    {
        if (ContentReader<contentType, ControllerType, ModelObjectRefType> reader { &controller, modelObjectRef, range })
        {
            ARA_LOG ("%i %s of %s grade available for %s %p", reader.getEventCount (), getEnumNameForContentType (contentType),
                        getNameForContentGrade (reader.getGrade ()), ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName, modelObjectRef);

            for (auto i { 0 }; i < reader.getEventCount (); ++i)
                logEventIteration<contentType> (reader, i);

            return true;
        }

        if (logIfNotAvailable)
            ARA_LOG ("no %s available for %s %p", getEnumNameForContentType (contentType), ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName, modelObjectRef);

        return false;
    }

    // Main logging methods, with \p contentType being a runtime parameter.
    // Returns true if any content of type \p contentType was available for \p modelObjectRef.
    template <typename ControllerType, typename ModelObjectRefType>
    static inline bool log (ControllerType& controller, ModelObjectRefType modelObjectRef, ARAContentType contentType, const ARAContentTimeRange* range = nullptr, bool logIfNotAvailable = true)
    {
        switch (contentType)
        {
            case kARAContentTypeNotes:         return log<kARAContentTypeNotes> (controller, modelObjectRef, range, logIfNotAvailable);
            case kARAContentTypeTempoEntries:  return log<kARAContentTypeTempoEntries> (controller, modelObjectRef, range, logIfNotAvailable);
            case kARAContentTypeBarSignatures: return log<kARAContentTypeBarSignatures> (controller, modelObjectRef, range, logIfNotAvailable);
            case kARAContentTypeStaticTuning:  return log<kARAContentTypeStaticTuning> (controller, modelObjectRef, range, logIfNotAvailable);
            case kARAContentTypeKeySignatures: return log<kARAContentTypeKeySignatures> (controller, modelObjectRef, range, logIfNotAvailable);
            case kARAContentTypeSheetChords:   return log<kARAContentTypeSheetChords> (controller, modelObjectRef, range, logIfNotAvailable);
            default: ARA_INTERNAL_ASSERT (false); return false;
        }
    }

    // Variant of log() for logging all ARA content types.
    template <typename ControllerType, typename ModelObjectRefType>
    static inline void logAllContent (ControllerType& controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range = nullptr) noexcept
    {
        ARA_LOG ("all content of %s %p in range %.3f to %.3f:", ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName,
                    modelObjectRef, ContentLogger::getStartOfRange (range), ContentLogger::getEndOfRange (range));

        for (const auto& contentType : getAllContentTypes ())
            log (controller, modelObjectRef, contentType, range);
    }

    // Variant of log() for logging content that may have been analyzed by the plug-in.
    template <typename ControllerType, typename ModelObjectRefType>
    static inline void logAnalyzableContent (ControllerType& controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range) noexcept
    {
        ARA_LOG ("analyzable content of %s %p in range %.3f to %.3f:", ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName,
                    modelObjectRef, ContentLogger::getStartOfRange (range), ContentLogger::getEndOfRange (range));

        for (auto i { 0 }; i < controller.getFactory ()->analyzeableContentTypesCount; ++i)
            log (controller, modelObjectRef, controller.getFactory ()->analyzeableContentTypes[i], range);
    }

    // Variant of log() for logging available content.
    template <typename ControllerType, typename ModelObjectRefType>
    static inline void logAvailableContent (ControllerType& controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range = nullptr)
    {
        ARA_LOG ("available content of %s %p in range %.3f to %.3f:", ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName,
                    modelObjectRef, ContentLogger::getStartOfRange (range), ContentLogger::getEndOfRange (range));

        bool didLogContent { false };
        for (const auto contentType : getAllContentTypes ())
            didLogContent = log (controller, modelObjectRef, contentType, range, false) || didLogContent;

        if (!didLogContent)
            ARA_LOG ("no content available for %s %p", ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName, modelObjectRef);
    }

    // Variant of log() for logging content change notifications.
    template <typename ControllerType, typename ModelObjectRefType>
    static inline void logUpdatedContent (ControllerType& controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags)
    {
        ARA_LOG ("content of %s %p was updated from %.3f to %.3f, flags 0x%X", ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::modelObjectRefTypeName,
                    modelObjectRef, ContentLogger::getStartOfRange (range), ContentLogger::getEndOfRange (range), scopeFlags);
        if (scopeFlags.affectNotes ())
        {
            ARA_LOG ("note scope updated, related content is:");
            log<kARAContentTypeNotes> (controller, modelObjectRef, range, false);
        }
        if (scopeFlags.affectTimeline ())
        {
            ARA_LOG ("timing scope updated, related content is:");
            log<kARAContentTypeTempoEntries> (controller, modelObjectRef, range, false);
            log<kARAContentTypeBarSignatures> (controller, modelObjectRef, range, false);
        }
        if (scopeFlags.affectTuning ())
        {
            ARA_LOG ("pitch scope updated, related content is:");
            log<kARAContentTypeStaticTuning> (controller, modelObjectRef, range, false);
        }
        if (scopeFlags.affectHarmonies ())
        {
            ARA_LOG ("harmonic scope updated, related content is:");
            log<kARAContentTypeKeySignatures> (controller, modelObjectRef, range, false);
            log<kARAContentTypeSheetChords> (controller, modelObjectRef, range, false);
        }
    }
};

#endif // ARA_ENABLE_DEBUG_OUTPUT

}   // namespace ARA

#endif // ARAContentLogger_h
