//------------------------------------------------------------------------------
//! \file       ARAChannelArrangement.cpp
//!             utility class dealing with the Companion-API-dependent surround channel arrangements
//! \project    ARA SDK Library
//! \copyright  Copyright (c) 2021-2022, Celemony Software GmbH, All Rights Reserved.
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

#include "ARAChannelArrangement.h"

#include "ARA_Library/Debug/ARADebug.h"

#include <cstring>

#if defined (__APPLE__)
    // \todo hotfix: JUCE #defines Point as juce::Point, which clashes with QuickDraw's Point in MacTypes.h
    #if defined (Point)
        #undef Point
    #endif

    #include <CoreAudio/CoreAudioTypes.h>
#endif

namespace ARA {

bool ChannelArrangement::operator== (const ChannelArrangement& other) const noexcept
{
    if (_channelArrangementDataType != other._channelArrangementDataType)
        return false;

    if (_channelArrangement == other._channelArrangement)
        return true;

    if (getDataSize () != other.getDataSize ())
        return false;

    return (0 == std::memcmp (_channelArrangement, other._channelArrangement, getDataSize ()));
}

ARASize ChannelArrangement::getDataSize () const noexcept
{
    switch (_channelArrangementDataType)
    {
        case kARAChannelArrangementUndefined:
        {
            return 0;
        }
        case kARAChannelArrangementVST3SpeakerArrangement:
        {
            return sizeof (uint64_t);
        }
        case kARAChannelArrangementCoreAudioChannelLayout:
        {
#if defined (__APPLE__)
            const auto audioChannelLayout { static_cast<const AudioChannelLayout*> (_channelArrangement) };
            return offsetof (AudioChannelLayout, mChannelDescriptions) +
                                sizeof (AudioChannelDescription) * audioChannelLayout->mNumberChannelDescriptions;
#else
            ARA_INTERNAL_ASSERT (false && "Audio Unit data can only be used on Apple platforms");
            return 0;
#endif
        }
        case kARAChannelArrangementAAXStemFormat:
        {
            return sizeof (uint32_t);
        }
        default:
        {
            ARA_INTERNAL_ASSERT (false && "unknown channel arrangement data type");
            return 0;
        }
    }
}

ARAChannelCount ChannelArrangement::getImpliedChannelCount () const noexcept
{
    switch (_channelArrangementDataType)
    {
        case kARAChannelArrangementUndefined:
        {
            return 0;
        }
        case kARAChannelArrangementVST3SpeakerArrangement:
        {
            // copied from Steinberg::Vst::SpeakerArr::getChannelCount () to avoid dependency on VST3 SDK in this library
            auto speakerArrangement { *static_cast<const uint64_t*> (_channelArrangement) };
            ARAChannelCount arrangementChannelCount { 0 };
            while (speakerArrangement)
            {
                if (speakerArrangement & 1UL)
                    ++arrangementChannelCount;
                speakerArrangement >>= 1;
            }
            return arrangementChannelCount;
        }
        case kARAChannelArrangementCoreAudioChannelLayout:
        {
#if defined (__APPLE__)
            const auto audioChannelLayout { static_cast<const AudioChannelLayout*> (_channelArrangement) };
            const auto layoutChannelCount { (audioChannelLayout->mChannelLayoutTag == kAudioChannelLayoutTag_UseChannelDescriptions) ?
                                                    audioChannelLayout->mNumberChannelDescriptions :
                                                    AudioChannelLayoutTag_GetNumberOfChannels (audioChannelLayout->mChannelLayoutTag) };
            return static_cast<ARAChannelCount> (layoutChannelCount);
#else
            return 0;
#endif
        }
        case kARAChannelArrangementAAXStemFormat:
        {
            const auto stemFormat { *static_cast<const uint32_t*> (_channelArrangement) };
            // copied from AAX_STEM_FORMAT_CHANNEL_COUNT() to avoid dependency on AAX SDK in this library
            return static_cast<uint16_t> (stemFormat & 0xFFFF);
        }
        default:
        {
            ARA_INTERNAL_ASSERT (false && "unknown channel arrangement data type");
            return 0;
        }
    }
}

bool ChannelArrangement::isValidForChannelCount (ARAChannelCount requiredChannelCount) const noexcept
{
    if (_channelArrangementDataType == kARAChannelArrangementUndefined)
    {
        // for more than stereo, a valid arrangement must be provided
        if (requiredChannelCount > 2)
            return false;
        
        // for undefined arrangement, the data pointer must be NULL
        if (_channelArrangement != nullptr)
            return false;
    }
    else
    {
        const auto impliedChannelCount { getImpliedChannelCount () };
        if ((impliedChannelCount != 0) &&
            (impliedChannelCount != requiredChannelCount))
            return false;
            
        if (_channelArrangementDataType == kARAChannelArrangementCoreAudioChannelLayout)
        {
#if defined (__APPLE__)
            // kAudioChannelLayoutTag_UseChannelBitmap is not allowed for Audio Units
            const auto audioChannelLayout { static_cast<const AudioChannelLayout*> (_channelArrangement) };
            if (audioChannelLayout->mChannelLayoutTag == kAudioChannelLayoutTag_UseChannelBitmap)
                return false;
#else
            ARA_INTERNAL_ASSERT (false && "Audio Unit data can only be used on Apple platforms");
            return false;
#endif
        }
    }
    return true;
}

}   // namespace ARA
