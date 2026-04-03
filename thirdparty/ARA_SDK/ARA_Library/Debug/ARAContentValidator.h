//------------------------------------------------------------------------------
//! \file       ARAContentValidator.h
//!             utility classes vor validating content readers
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

#ifndef ARAContentValidator_h
#define ARAContentValidator_h

#include "ARA_Library/Debug/ARADebug.h"

#if ARA_VALIDATE_API_CALLS

#include "ARA_Library/Dispatch/ARAContentReader.h"

namespace ARA {

/*******************************************************************************/
// ContentReaderValidatorImplementation
// Internal helper template class for validating content reader implementations,
// to be used only by ContentReaderValidator.
/*******************************************************************************/

template <ARAContentType contentType>
struct ContentReaderValidatorImplementation;

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeNotes>
{
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount >= 0); }

    static inline void validateEvent (const ARAContentNote* event)
    {
        if ((event->frequency == kARAInvalidFrequency) || (event->pitchNumber == kARAInvalidPitchNumber))
            ARA_VALIDATE_API_CONDITION ((event->frequency == kARAInvalidFrequency) && (event->pitchNumber == kARAInvalidPitchNumber));
        else
            ARA_VALIDATE_API_CONDITION ((event->frequency != kARAInvalidFrequency) && (event->pitchNumber != kARAInvalidPitchNumber));

        ARA_VALIDATE_API_CONDITION (event->volume >= 0.0f);

        ARA_VALIDATE_API_CONDITION (event->attackDuration >= 0.0);
        ARA_VALIDATE_API_CONDITION (event->noteDuration >= 0.0);
        ARA_VALIDATE_API_CONDITION (event->signalDuration >= 0.0);
    }

    static inline void validateEventSequence (const ARAContentNote* event, const ARAContentNote* prevEvent)
    {
        ARA_VALIDATE_API_CONDITION (prevEvent->startPosition <= event->startPosition);
    }
};

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeTempoEntries>
{
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount > 1); }

    static inline void validateEvent (const ARAContentTempoEntry* /*event*/) {}

    static inline void validateEventSequence (const ARAContentTempoEntry* event, const ARAContentTempoEntry* prevEvent)
    {
        ARA_VALIDATE_API_CONDITION ((prevEvent->timePosition < event->timePosition) && (prevEvent->quarterPosition < event->quarterPosition));
    }
};

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeBarSignatures>
{
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount > 0); }

    static inline void validateEvent (const ARAContentBarSignature* event)
    {
        ARA_VALIDATE_API_CONDITION (event->numerator > 0);
        ARA_VALIDATE_API_CONDITION (event->denominator > 0);
    }

    static inline void validateEventSequence (const ARAContentBarSignature* event, const ARAContentBarSignature* prevEvent)
    {
        ARA_VALIDATE_API_CONDITION (prevEvent->position < event->position);

        const auto barLength { static_cast<double> (prevEvent->numerator) / static_cast<double> (prevEvent->denominator) };
        const auto signatureDuration { event->position - prevEvent->position };
        constexpr auto roundingWindow { 1.0 / 32.0 };   // a 1/128th note in quarter units
        ARA_VALIDATE_API_CONDITION ((std::fmod (signatureDuration, barLength) < roundingWindow) ||
                                    (std::fmod (signatureDuration, barLength) > barLength - roundingWindow));
    }
};

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeStaticTuning>
{
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount == 1); }

    static inline void validateEvent (const ARAContentTuning* event)
    {
        ARA_VALIDATE_API_CONDITION (event->concertPitchFrequency > 0.0);
    }

    static inline void validateEventSequence (const ARAContentTuning* /*event*/, const ARAContentTuning* /*prevEvent*/) {}
};

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeKeySignatures>
{
    // this may fail in older versions of Studio One if no key has been set for the song - fixed in version 5.2.1
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount > 0); }

    static inline void validateEvent (const ARAContentKeySignature* /*event*/) {}

    static inline void validateEventSequence (const ARAContentKeySignature* event, const ARAContentKeySignature* prevEvent)
    {
        ARA_VALIDATE_API_CONDITION (prevEvent->position < event->position);
    }
};

template <>
struct ContentReaderValidatorImplementation<kARAContentTypeSheetChords>
{
    static inline void validateEventCount (ARAInt32 eventCount) { ARA_VALIDATE_API_CONDITION (eventCount >= 0); }

    static inline void validateEvent (const ARAContentChord* /*event*/) {}

    static inline void validateEventSequence (const ARAContentChord* event, const ARAContentChord* prevEvent)
    {
        ARA_VALIDATE_API_CONDITION (prevEvent->position < event->position);
    }
};


/*******************************************************************************/
// ContentReaderValidator
// Template class for validating content reader implementations.
// Not called directly, but used as argument for the ContentReader template.
/*******************************************************************************/

template <ARAContentType contentType, typename ControllerType, typename ContentReaderRefType>
class ContentValidator
{
public:
    using DataType = typename ContentTypeMapper<contentType>::DataType;

    inline void validateEventCount (ARAInt32 eventCount)
    {
        ContentReaderValidatorImplementation<contentType>::validateEventCount (eventCount);
    }

    inline void prepareValidateEvent (ControllerType* controller, ContentReaderRefType ref, ARAInt32 eventIndex)
    {
        if ((eventIndex > 0) && (_cachedEventIndex != eventIndex - 1))
            _cachedData = *static_cast<const DataType*> (controller->getContentReaderDataForEvent (ref, eventIndex - 1));
    }

    inline void validateEvent (const DataType* dataPtr, ARAInt32 eventIndex)
    {
        ARA_VALIDATE_API_CONDITION (dataPtr != nullptr);
        if (dataPtr != nullptr)
        {
            ContentReaderValidatorImplementation<contentType>::validateEvent (dataPtr);

            if (eventIndex > 0)
                ContentReaderValidatorImplementation<contentType>::validateEventSequence (dataPtr, &_cachedData);
            _cachedData = *dataPtr;
            _cachedEventIndex = eventIndex;
        }
    }

private:
    ARAInt32 _cachedEventIndex { -1 };
    DataType _cachedData {};
};

} // namespace ARA

#endif // ARA_VALIDATE_API_CALLS

#endif // ARAContentValidator_h
