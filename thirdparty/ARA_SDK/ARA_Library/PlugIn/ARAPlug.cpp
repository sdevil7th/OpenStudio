//------------------------------------------------------------------------------
//! \file       ARAPlug.cpp
//!             implementation of base classes for ARA plug-ins
//! \project    ARA SDK Library
//! \copyright  Copyright (c) 2012-2022, Celemony Software GmbH, All Rights Reserved.
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

#include "ARAPlug.h"

#include "ARA_Library/Utilities/ARAChannelArrangement.h"

#include <sstream>

namespace ARA {
namespace PlugIn {

/*******************************************************************************/

// configuration switches for debug output
// each can be defined as a nonzero integer to enable the associated logging

// log each entry from the host into the document controller (except for notifyModelUpdates (), which is called too often)
#ifndef ARA_ENABLE_HOST_ENTRY_LOG
    #define ARA_ENABLE_HOST_ENTRY_LOG 0
#endif

// log the entire document upon each endEditing ()/endRestoring ()
#ifndef ARA_ENABLE_MODEL_EDIT_LOG
    #define ARA_ENABLE_MODEL_EDIT_LOG 0
#endif

// log the creation and destruction of plug-in objects
#ifndef ARA_ENABLE_OBJECT_LIFETIME_LOG
    #define ARA_ENABLE_OBJECT_LIFETIME_LOG 0
#endif

// log object state when its properties are updated
#ifndef ARA_ENABLE_PROPERTY_CHANGE_LOG
    #define ARA_ENABLE_PROPERTY_CHANGE_LOG 0
#endif

// log view configuration events
#ifndef ARA_ENABLE_VIEW_UPDATE_LOG
    #define ARA_ENABLE_VIEW_UPDATE_LOG 0
#endif

/*******************************************************************************/

// conditional logging helper functions based on the above switches

#if ARA_ENABLE_HOST_ENTRY_LOG
    #define ARA_LOG_HOST_ENTRY(object) ARA_LOG ("Host calls into %s (%p)", __FUNCTION__, object);
#else
    #define ARA_LOG_HOST_ENTRY(object) ((void) 0)
#endif

#if ARA_ENABLE_MODEL_EDIT_LOG
    #define ARA_LOG_EDITED_DOCUMENT(message, object) logDocumentChange (message, object, object->getDocumentController (), false, true, true)
#else
    #define ARA_LOG_EDITED_DOCUMENT(message, object) ((void) 0)
#endif

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    #define ARA_LOG_MODELOBJECT_LIFETIME(message, object) logDocumentChange (message, object, object->getDocumentController (), true, false, false)
#else
    #define ARA_LOG_MODELOBJECT_LIFETIME(message, object) ((void) 0)
#endif

#if ARA_ENABLE_PROPERTY_CHANGE_LOG
    #define ARA_LOG_PROPERTY_CHANGES(message, object) logDocumentChange (message, object, object->getDocumentController (), false, true, false)
#else
    #define ARA_LOG_PROPERTY_CHANGES(message, object) ((void) 0)
#endif

/*******************************************************************************/

// helper for logging to sort objects by position index
struct SortByOrderIndex
{
    bool operator() (const MusicalContext* a, const MusicalContext* b) const noexcept
    {
        return a->getOrderIndex () < b->getOrderIndex ();
    }

    bool operator() (const RegionSequence* a, const RegionSequence* b) const noexcept
    {
        if (a->getOrderIndex () == b->getOrderIndex ())
            return operator() (a->getMusicalContext (), b->getMusicalContext ());

        return (a->getOrderIndex () < b->getOrderIndex ());
    }

    bool operator() (const PlaybackRegion* a, const PlaybackRegion* b) const noexcept
    {
        if (!a->getRegionSequence ())
            return true;
        if (!b->getRegionSequence ())
            return false;

        return operator() (a->getRegionSequence (), b->getRegionSequence ());
    }
} sortByOrderIndex;     // singleton instance

/*******************************************************************************/

// stream operator for color (r,g,b)
std::ostream& operator<< (std::ostream& oss, const ARAColor& color)
{
    oss << "(" << color.r << "," << color.g << "," << color.b << ")";
    return oss;
}

/*******************************************************************************/

// stream operator for optional properties
// if the property is nullptr, we print the string "(nullptr)"
// otherwise we invoke the stream operator on our data type
template <typename T>
std::ostream& operator<< (std::ostream& oss, const OptionalProperty<T*>& prop)
{
    if (prop)
        oss << *prop;
    else
        oss << "(nullptr)";
    return oss;
}

// specialization of the above for optional strings - in this case we don't
// want to deref the property but instead treat it like a c-string pointer
template <>
std::ostream& operator<< (std::ostream& oss, const OptionalProperty<ARAUtf8String>& prop)
{
    if (prop)
        oss << "\'" << static_cast<const char*> (prop) << "\'";
    else
        oss << "(nullptr)";
    return oss;
}

/*******************************************************************************/

// logging the contents of our model graph objects

void logToStream (const PlaybackRegion* playbackRegion, std::ostringstream& oss, bool detailed, bool /*recursive*/, std::string indentation)
{
    oss << indentation <<  playbackRegion << "(" << playbackRegion->getHostRef () << "):" << playbackRegion->getName ()
        << ", playback time:" << playbackRegion->getStartInPlaybackTime () << " to " << playbackRegion->getEndInPlaybackTime ();
    if (detailed)
    {
        oss << ", modification:" << playbackRegion->getStartInAudioModificationTime () << " to " << playbackRegion->getEndInAudioModificationTime ()
            << ", time-stretching:" << (playbackRegion->isTimestretchEnabled () ? (playbackRegion->isTimeStretchReflectingTempo () ? "musical" : "linear") : "off)")
            << ", content based fades:" << (playbackRegion->hasContentBasedFadeAtHead () ? (playbackRegion->hasContentBasedFadeAtTail () ? "both" : "head only") : (playbackRegion->hasContentBasedFadeAtTail () ? "tail only" : "none"))
            << ", regionSequence:" << playbackRegion->getRegionSequence ()->getName ()
            << ", color:"  << playbackRegion->getColor ();
    }
    oss << "\n";
}

void logToStream (const AudioModification* audioModification, std::ostringstream& oss, bool detailed, bool recursive, std::string indentation)
{
    oss << indentation <<  audioModification << "(" << audioModification->getHostRef () << "):" << audioModification->getName () << ", ID: \"" << audioModification->getPersistentID () << "\"";

    oss << "\n" << indentation << audioModification->getPlaybackRegions ().size () << " playback region(s)\n";
    if (recursive)
    {
        std::vector<PlaybackRegion*> sortedPlaybackRegions { audioModification->getPlaybackRegions () };
        std::sort (sortedPlaybackRegions.begin (), sortedPlaybackRegions.end (), sortByOrderIndex);
        for (const auto& playbackRegion : sortedPlaybackRegions)
            logToStream (playbackRegion, oss, detailed, true, indentation + "\t");
    }
}

void logToStream (const AudioSource* audioSource, std::ostringstream& oss, bool detailed, bool recursive, std::string indentation)
{
    oss << indentation <<  audioSource << "(" << audioSource->getHostRef () << "):" << audioSource->getName () << ", ID: \"" << audioSource->getPersistentID () << "\"\n";
    if (detailed)
        oss << indentation << audioSource->getChannelCount () << " channel(s) w/ " << audioSource->getSampleCount () << " samples @ " << (audioSource->getSampleRate ()/1000) << "kHz, " << (audioSource->merits64BitSamples () ? "64" : "32") << " bit\n";

    oss << indentation  << audioSource->getAudioModifications ().size () << " audio modification(s)\n";
    if (recursive)
    {
        for (const auto& audioModification : audioSource->getAudioModifications ())
            logToStream (audioModification, oss, detailed, true, indentation + "\t");
    }
}

void logToStream (const RegionSequence* regionSequence, std::ostringstream& oss, bool detailed, bool /*recursive*/, std::string indentation)
{
    oss << indentation <<  regionSequence << "(" << regionSequence->getHostRef () << "):" << regionSequence->getName ();
    if (detailed)
        oss << ", orderIndex" << regionSequence->getOrderIndex () << ", color:"  << regionSequence->getColor ();

    oss << "\n" << indentation << regionSequence->getPlaybackRegions ().size () << " playback region(s)";
    if (detailed && regionSequence->getPlaybackRegions ().size ())
    {
        std::vector<PlaybackRegion*> sortedPlaybackRegions { regionSequence->getPlaybackRegions () };
        std::sort (sortedPlaybackRegions.begin (), sortedPlaybackRegions.end (), sortByOrderIndex);

        oss << "):[" << sortedPlaybackRegions[0] << ":" << sortedPlaybackRegions[0]->getName ();
        if (sortedPlaybackRegions.size () > 1)
        {
            oss << ", " << sortedPlaybackRegions[1] << ":" << sortedPlaybackRegions[1]->getName ();

            if (sortedPlaybackRegions.size () > 2)
            {
                oss << ", ";
                if (sortedPlaybackRegions.size () > 3)
                    oss << "... ";

                oss << sortedPlaybackRegions.back () << ":" << sortedPlaybackRegions.back ()->getName ();
            }
        }
        oss << "]\n";
    }
}

void logToStream (const MusicalContext* musicalContext, std::ostringstream& oss, bool detailed, bool recursive, std::string indentation)
{
    oss << indentation <<  musicalContext << "(" << musicalContext->getHostRef () << "):" << musicalContext->getName ();
    if (detailed)
        oss  << ", orderIndex" << musicalContext->getOrderIndex () << ", color:" << musicalContext->getColor ();

    oss << "\n" << indentation << musicalContext->getRegionSequences ().size () << " region sequence(s)\n";
    if (recursive)
    {
        std::vector<RegionSequence*> sortedRegionSequences { musicalContext->getRegionSequences () };
        std::sort (sortedRegionSequences.begin (), sortedRegionSequences.end (), sortByOrderIndex);
        for (const auto& regionSequence : sortedRegionSequences)
            logToStream (regionSequence, oss, detailed, true, indentation + "\t");
    }
}

void logToStream (const Document* document, std::ostringstream& oss, bool detailed, bool recursive, std::string indentation)
{
    oss << indentation << document << ":" << document->getName () << "\n";

    oss << indentation << document->getMusicalContexts ().size () << " musical context(s)\n";
    if (recursive)
    {
        std::vector<MusicalContext*> sortedMusicalContexts { document->getMusicalContexts () };
        std::sort (sortedMusicalContexts.begin (), sortedMusicalContexts.end (), sortByOrderIndex);
        for (const auto& musicalContext : sortedMusicalContexts)
            logToStream (musicalContext, oss, detailed, true, indentation + "\t");
    }

    oss << indentation << document->getAudioSources ().size () << " audio source(s)\n";
    if (recursive)
    {
        for (const auto& audioSource : document->getAudioSources ())
            logToStream (audioSource, oss, detailed, true, indentation + "\t");
    }
}

// helper for converting from cpp-style internal logging to printf-style ARA_LOG
template <typename T>
void logDocumentChange (std::string change, const T object, const DocumentController* documentController, bool refOnly, bool detailed, bool recursive)
{
    std::ostringstream oss;
    if (!change.empty ())
        oss << "Plug success: document controller " << documentController << " " << change << " " << object;
    if (!refOnly)
    {
        oss << "\n";
        logToStream (object, oss, detailed, recursive, "\t");
    }

    ARA_LOG ("%s", oss.str ().c_str ());
}

/*******************************************************************************/

float AnalysisProgressTracker::decodeProgress (float encodedProgress) noexcept
{
    if (encodedProgress >= 6.0f)
        return encodedProgress - 6.0f;
    else if (encodedProgress >= 4.0f)
        return encodedProgress - 4.0f;
    else if (encodedProgress >= 2.0f)
        return encodedProgress - 2.0f;
    else if (encodedProgress < 0.0f)
        return encodedProgress + 2.0f;
    else
        return 1.0f;
}

bool AnalysisProgressTracker::decodeIsProgressing (float encodedProgress) noexcept
{
    return ((encodedProgress < 0.0f) || (1.0f < encodedProgress));
}

bool AnalysisProgressTracker::updateProgress (ARAAnalysisProgressState state, float progress) noexcept
{
#if (__cplusplus >= 201703L)
    static_assert (decltype (_encodedProgress)::is_always_lock_free);
#else
    ARA_INTERNAL_ASSERT (_encodedProgress.is_lock_free ());
#endif
    ARA_INTERNAL_ASSERT (0.0f <= progress);
    ARA_INTERNAL_ASSERT (progress <= 1.0f);

    float encodedValue, oldEncodedValue;
    do                                                          // retry point for compare and exchange
    {
        oldEncodedValue = _encodedProgress.load (std::memory_order_relaxed);

        // ensure proper state transitions and ascending progress
        if (state == kARAAnalysisProgressStarted)
            ARA_INTERNAL_ASSERT (!decodeIsProgressing (oldEncodedValue));
        else
            ARA_INTERNAL_ASSERT ((progress >= decodeProgress (oldEncodedValue)) && decodeIsProgressing (oldEncodedValue));

        // for an ongoing update, check if the progress has changed by a at least a delta of 0.001 since last reported
        if ((state == kARAAnalysisProgressUpdated) && (oldEncodedValue < 0.0f) &&
            (progress <= oldEncodedValue + 2.0f + 0.001f))
            return false;

        // encode new value
        if (state == kARAAnalysisProgressCompleted)
        {
            if (oldEncodedValue >= 6.0f)
                encodedValue = 1.0f;
            else if (oldEncodedValue >= 4.0f)
                encodedValue = 0.0f;
            else if (oldEncodedValue == 0.0f)
                encodedValue = 0.0f;
            else
                encodedValue = 1.0f;
        }
        else
        {
            if (oldEncodedValue >= 6.0f)
                encodedValue = progress + 6.0f;
            else if (oldEncodedValue >= 4.0f)
                encodedValue = progress + 4.0f;
            else if (oldEncodedValue == 1.0f)
                encodedValue = progress + 6.0f;
            else if (oldEncodedValue == 0.0f)
                encodedValue = progress + 4.0f;
            else
                encodedValue = progress + ((state == kARAAnalysisProgressStarted) ? 6.0f : 2.0f);
        }

    }
    while (!_encodedProgress.compare_exchange_strong (oldEncodedValue, encodedValue, std::memory_order_release, std::memory_order_relaxed));

    return true;
}

void AnalysisProgressTracker::notifyProgress (HostModelUpdateController* controller, ARAAudioSourceHostRef audioSourceHostRef) noexcept
{
    float oldEncodedValue, encodedValue, progress;
    ARAAnalysisProgressState state;

    do                                                          // retry point for compare and exchange
    {
        oldEncodedValue = _encodedProgress.load (std::memory_order_relaxed);
        if (oldEncodedValue <= 0.0f)                            // bail if no updates pending
            return;

        progress = decodeProgress (oldEncodedValue);

        if (oldEncodedValue >= 4.0f)
        {
            state = kARAAnalysisProgressStarted;
            encodedValue = progress - 2.0f;
        }
        else if (oldEncodedValue >= 2.0f)
        {
            state = kARAAnalysisProgressUpdated;
            encodedValue = progress - 2.0f;
        }
        else
        {
            state = kARAAnalysisProgressCompleted;
            encodedValue = 0.0f;
        }
    }
    while (!_encodedProgress.compare_exchange_strong (oldEncodedValue, encodedValue, std::memory_order_release, std::memory_order_relaxed));

    if (oldEncodedValue >= 6.0f)
        controller->notifyAudioSourceAnalysisProgress (audioSourceHostRef, kARAAnalysisProgressCompleted, 1.0f);

    controller->notifyAudioSourceAnalysisProgress (audioSourceHostRef, state, progress);
}

/*******************************************************************************/

void Document::updateProperties (PropertiesPtr<ARADocumentProperties> properties) noexcept
{
    _name = properties->name;
}

void Document::sortMusicalContextsByOrderIndex ()
{
    std::sort (_musicalContexts.begin (), _musicalContexts.end (), sortByOrderIndex);
}

void Document::sortRegionSequencesByOrderIndex ()
{
    std::sort (_regionSequences.begin (), _regionSequences.end (), sortByOrderIndex);
}

/*******************************************************************************/

MusicalContext::MusicalContext (Document* document, ARAMusicalContextHostRef hostRef) noexcept
: _document { document },
  _hostRef { hostRef }
{
    _document->addMusicalContext (this);
}

MusicalContext::~MusicalContext () noexcept
{
    _document->removeMusicalContext (this);
}

const OptionalProperty<ARAUtf8String>& MusicalContext::getEffectiveName () const noexcept
{
    if (_name)
        return _name;

    return _document->getName ();
}

void MusicalContext::updateProperties (PropertiesPtr<ARAMusicalContextProperties> properties) noexcept
{
    if (properties.implements<ARA_STRUCT_MEMBER (ARAMusicalContextProperties, name)> ())
        _name = properties->name;
    else
        _name = nullptr;

    if (properties.implements<ARA_STRUCT_MEMBER (ARAMusicalContextProperties, orderIndex)> ())
        _orderIndex = properties->orderIndex;
    else
        _orderIndex = 0;        // for position, we have no markup for "unknown" position - we'll just remain unsorted

    if (properties.implements<ARA_STRUCT_MEMBER (ARAMusicalContextProperties, color)> ())
        _color = properties->color;
    else
        _color = nullptr;
}

void MusicalContext::sortRegionSequencesByOrderIndex () noexcept
{
    std::sort (_regionSequences.begin (), _regionSequences.end (), sortByOrderIndex);
}

/*******************************************************************************/

RegionSequence::RegionSequence (Document* document, ARARegionSequenceHostRef hostRef) noexcept
: _document { document },
  _hostRef { hostRef }
{
    _document->addRegionSequence (this);
}

RegionSequence::~RegionSequence () noexcept
{
    setMusicalContext (nullptr);
    _document->removeRegionSequence (this);
}

void RegionSequence::updateProperties (PropertiesPtr<ARARegionSequenceProperties> properties) noexcept
{
    _name = properties->name;
    _orderIndex = properties->orderIndex;

    if (properties.implements<ARA_STRUCT_MEMBER (ARARegionSequenceProperties, color)> ())
        _color = properties->color;
    else
        _color = nullptr;

    auto musicalContext { fromRef (properties->musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (properties->musicalContextRef, getDocumentController ()->isValidMusicalContext (musicalContext));
    setMusicalContext (musicalContext);
}

void RegionSequence::setMusicalContext (MusicalContext* musicalContext) noexcept
{
    if (_musicalContext != musicalContext)
    {
        if (_musicalContext)
            _musicalContext->removeRegionSequence (this);
        _musicalContext = musicalContext;
        if (musicalContext)
            musicalContext->addRegionSequence (this);
    }
}

/*******************************************************************************/

AudioSource::AudioSource (Document* document, ARAAudioSourceHostRef hostRef) noexcept
: _document { document },
  _hostRef { hostRef }
{
    _document->addAudioSource (this);
}

AudioSource::~AudioSource () noexcept
{
    _document->removeAudioSource (this);
}

void AudioSource::updateProperties (PropertiesPtr<ARAAudioSourceProperties> properties) noexcept
{
    _name = properties->name;

    ARA_VALIDATE_API_ARGUMENT (properties->persistentID, properties->persistentID != nullptr);
    ARA_VALIDATE_API_ARGUMENT (properties->persistentID, std::strlen (properties->persistentID) > 0);
    _persistentID = properties->persistentID;

    _sampleCount = properties->sampleCount;
    _sampleRate = properties->sampleRate;
    _channelCount = properties->channelCount;
    _merits64BitSamples = (properties->merits64BitSamples != kARAFalse);

    if (properties.implements<ARA_STRUCT_MEMBER (ARAAudioSourceProperties, channelArrangement)> ())
        doUpdateChannelArrangement (ChannelArrangement { properties->channelArrangementDataType, properties->channelArrangement });
    else
        doUpdateChannelArrangement (ChannelArrangement {});
}

/*******************************************************************************/

AudioModification::AudioModification (AudioSource* audioSource, ARAAudioModificationHostRef hostRef, const AudioModification* /*optionalModificationToClone*/) noexcept
: _audioSource { audioSource },
  _hostRef { hostRef }
{
    _audioSource->addAudioModification (this);
}

AudioModification::~AudioModification () noexcept
{
    _audioSource->removeAudioModification (this);
}

const OptionalProperty<ARAUtf8String>& AudioModification::getEffectiveName () const noexcept
{
    if (_name)
        return _name;

    return _audioSource->getName ();
}

void AudioModification::updateProperties (PropertiesPtr<ARAAudioModificationProperties> properties) noexcept
{
    _name = properties->name;

    ARA_VALIDATE_API_ARGUMENT (properties->persistentID, properties->persistentID != nullptr);
    ARA_VALIDATE_API_ARGUMENT (properties->persistentID, std::strlen (properties->persistentID) > 0);
    _persistentID = properties->persistentID;
}

/*******************************************************************************/

PlaybackRegion::PlaybackRegion (AudioModification* audioModification, ARAPlaybackRegionHostRef hostRef) noexcept
: _audioModification { audioModification },
  _hostRef { hostRef }
{
    _audioModification->addPlaybackRegion (this);
}

PlaybackRegion::~PlaybackRegion () noexcept
{
    setRegionSequence (nullptr);
    _audioModification->removePlaybackRegion (this);
}

const OptionalProperty<ARAUtf8String>& PlaybackRegion::getEffectiveName () const noexcept
{
    if (_name)
        return _name;

    return _audioModification->getEffectiveName ();
}

const OptionalProperty<ARAColor*>& PlaybackRegion::getEffectiveColor () const noexcept
{
    if (_color)
        return _color;

    return _regionSequence->getColor ();
}

void PlaybackRegion::updateProperties (PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept
{
    ARA_VALIDATE_API_ARGUMENT (properties, properties->durationInModificationTime >= 0.0);
    ARA_VALIDATE_API_ARGUMENT (properties, properties->durationInPlaybackTime >= 0.0);
    _startInAudioModificationTime = properties->startInModificationTime;
    _durationInAudioModificationTime = properties->durationInModificationTime;
    _startInPlaybackTime = properties->startInPlaybackTime;
    _durationInPlaybackTime = properties->durationInPlaybackTime;

#if ARA_VALIDATE_API_CALLS
    const auto supportedTransformationFlags { getDocumentController ()->getFactory ()->supportedPlaybackTransformationFlags };
    // this may fail in older versions of Studio One which always set the flag (despite never actually stretching if not supported) - fixed in version 5.2.1
    ARA_VALIDATE_API_ARGUMENT (properties, (properties->transformationFlags & ~supportedTransformationFlags) == 0);
    if (((properties->transformationFlags & kARAPlaybackTransformationTimestretch) == 0) ||
        ((supportedTransformationFlags & kARAPlaybackTransformationTimestretch) == 0))
        ARA_VALIDATE_API_ARGUMENT (properties, properties->durationInModificationTime == properties->durationInPlaybackTime);
#endif

    _timestretchEnabled = ((properties->transformationFlags & kARAPlaybackTransformationTimestretch) != 0);
    _timestretchReflectingTempo = ((properties->transformationFlags & kARAPlaybackTransformationTimestretchReflectingTempo) != 0);

    _contentBasedFadeAtHead = ((properties->transformationFlags & kARAPlaybackTransformationContentBasedFadeAtHead) != 0);
    _contentBasedFadeAtTail = ((properties->transformationFlags & kARAPlaybackTransformationContentBasedFadeAtTail) != 0);

    if (properties.implements<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, name)> ())
        _name = properties->name;
    else
        _name = nullptr;

    if (properties.implements<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, color)> ())
        _color = properties->color;
    else
        _color = nullptr;

#if ARA_SUPPORT_VERSION_1
    if (properties.implements<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, regionSequenceRef)> ())
    {
        ARA_VALIDATE_API_STATE (_musicalContext == nullptr);
        auto regionSequence { fromRef (properties->regionSequenceRef) };
        ARA_VALIDATE_API_ARGUMENT (properties->regionSequenceRef, getDocumentController ()->isValidRegionSequence (regionSequence));
        setRegionSequence (regionSequence);
    }
    else
    {
        ARA_VALIDATE_API_STATE (DocumentController::getUsedApiGeneration () < kARAAPIGeneration_2_0_Draft);
        ARA_VALIDATE_API_STATE (getRegionSequence () == nullptr);

        auto musicalContext { fromRef (properties->musicalContextRef) };
        ARA_VALIDATE_API_ARGUMENT (properties->musicalContextRef, getDocumentController ()->isValidMusicalContext (musicalContext));
        _musicalContext = musicalContext;
    }
#else
    ARA_VALIDATE_API_ARGUMENT (properties, properties.implements<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, regionSequenceRef)> ());
    auto regionSequence { fromRef (properties->regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (properties->regionSequenceRef, getDocumentController ()->isValidRegionSequence (regionSequence));
    setRegionSequence (regionSequence);
#endif
}

bool PlaybackRegion::intersectsWithAudioModificationTimeRange (ARAContentTimeRange range) const noexcept
{
    return (_startInAudioModificationTime < (range.start + range.duration)) &&
            (range.start < (_startInAudioModificationTime + _durationInAudioModificationTime));
}

ARASamplePosition PlaybackRegion::getStartInAudioModificationSamples () const noexcept
{
    return samplePositionAtTime (_startInAudioModificationTime, _audioModification->getAudioSource ()->getSampleRate ());
}

ARASampleCount PlaybackRegion::getDurationInAudioModificationSamples () const noexcept
{
    return getEndInAudioModificationSamples () - getStartInAudioModificationSamples ();
}

ARASamplePosition PlaybackRegion::getEndInAudioModificationSamples () const noexcept
{
    return samplePositionAtTime (getEndInAudioModificationTime (), _audioModification->getAudioSource ()->getSampleRate ());
}

bool PlaybackRegion::intersectsWithPlaybackTimeRange (ARAContentTimeRange range) const noexcept
{
    return (_startInPlaybackTime < (range.start + range.duration)) &&
            (range.start < (_startInPlaybackTime + _durationInPlaybackTime));
}

ARASamplePosition PlaybackRegion::getStartInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept
{
    return samplePositionAtTime (_startInPlaybackTime, playbackSampleRate);
}

ARASampleCount PlaybackRegion::getDurationInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept
{
    return getEndInPlaybackSamples (playbackSampleRate) - getStartInPlaybackSamples (playbackSampleRate);
}

ARASamplePosition PlaybackRegion::getEndInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept
{
    return samplePositionAtTime (getEndInPlaybackTime (), playbackSampleRate);
}

void PlaybackRegion::setRegionSequence (RegionSequence* regionSequence) noexcept
{
    if (_regionSequence != regionSequence)
    {
        if (_regionSequence)
            _regionSequence->removePlaybackRegion (this);
        _regionSequence = regionSequence;
        if (regionSequence)
            regionSequence->addPlaybackRegion (this);
    }
}

/*******************************************************************************/

RestoreObjectsFilter::RestoreObjectsFilter (const ARARestoreObjectsFilter* filter, Document* document) noexcept
: _filter { filter }
{
    for (const auto& audioSource : document->getAudioSources ())
    {
        auto audioSourceID { audioSource->getPersistentID ().c_str () };
        ARA_VALIDATE_API_STATE (_audioSourcesByID.count (audioSourceID) == 0);                  // make sure all current audio source persistentIDs are unique
        _audioSourcesByID[audioSourceID] = audioSource;

        for (const auto& audioModification : audioSource->getAudioModifications ())
        {
            auto audioModificationID { audioModification->getPersistentID ().c_str () };
            ARA_VALIDATE_API_STATE (_audioModificationsByID.count (audioModificationID) == 0);  // make sure all current audio modification persistentIDs are unique
            _audioModificationsByID[audioModificationID] = audioModification;
        }
    }

    if (filter)
    {
        decltype (_audioSourcesByID) audioSourcesByMappedIDs;
        for (ARASize i { 0 }; i < filter->audioSourceIDsCount; ++i)
        {
            auto audioSourceArchiveID { filter->audioSourceArchiveIDs[i] };
            ARA_VALIDATE_API_STATE (audioSourcesByMappedIDs.count (audioSourceArchiveID) == 0); // make sure audio source persistentIDs in filter are unique
            auto audioSourceCurrentID { (filter->audioSourceCurrentIDs != nullptr) ? filter->audioSourceCurrentIDs[i] : audioSourceArchiveID };

            const auto it { _audioSourcesByID.find (audioSourceCurrentID) };
            if (it != _audioSourcesByID.end ())
                audioSourcesByMappedIDs[audioSourceArchiveID] = it->second;
        }
        _audioSourcesByID = std::move (audioSourcesByMappedIDs);

        decltype (_audioModificationsByID) audioModificationsByMappedIDs;
        for (ARASize i { 0 }; i < filter->audioModificationIDsCount; ++i)
        {
            auto audioModificationArchiveID { filter->audioModificationArchiveIDs[i] };
            ARA_VALIDATE_API_STATE (audioModificationsByMappedIDs.count (audioModificationArchiveID) == 0); // make sure audio Modification persistentIDs in filter are unique
            auto audioModificationCurrentID { (filter->audioModificationCurrentIDs != nullptr) ? filter->audioModificationCurrentIDs[i] : audioModificationArchiveID };

            const auto it { _audioModificationsByID.find (audioModificationCurrentID) };
            if (it != _audioModificationsByID.end ())
                audioModificationsByMappedIDs[audioModificationArchiveID] = it->second;
        }
        _audioModificationsByID = std::move (audioModificationsByMappedIDs);
    }
}

bool RestoreObjectsFilter::shouldRestoreDocumentData () const noexcept
{
    if (_filter)
        return (_filter->documentData != kARAFalse);
    return true;
}

AudioSource* RestoreObjectsFilter::getAudioSourceToRestoreStateWithID (ARAPersistentID audioSourceID) const noexcept
{
    const auto it { _audioSourcesByID.find (audioSourceID) };
    return (it != _audioSourcesByID.end ()) ? it->second : nullptr;
}

AudioModification* RestoreObjectsFilter::getAudioModificationToRestoreStateWithID (ARAPersistentID audioModificationID) const noexcept
{
    const auto it { _audioModificationsByID.find (audioModificationID) };
    return (it != _audioModificationsByID.end ()) ? it->second : nullptr;
}

/*******************************************************************************/

StoreObjectsFilter::StoreObjectsFilter (const ARAStoreObjectsFilter* filter) noexcept
: _filter { filter }
{
    ARA_INTERNAL_ASSERT (filter != nullptr);
    for (ARASize i { 0 }; i < _filter->audioSourceRefsCount; ++i)
        _audioSourcesToStore.push_back (fromRef (_filter->audioSourceRefs[i]));
    for (ARASize i { 0 }; i < _filter->audioModificationRefsCount; ++i)
        _audioModificationsToStore.push_back (fromRef (_filter->audioModificationRefs[i]));
}

StoreObjectsFilter::StoreObjectsFilter (const Document* document) noexcept
: _filter { nullptr }
{
    _audioSourcesToStore = document->getAudioSources<const AudioSource> ();
    _audioModificationsToStore.reserve (_audioSourcesToStore.size ());
    for (const auto& audioSource : _audioSourcesToStore)
        _audioModificationsToStore.insert (_audioModificationsToStore.end (), audioSource->getAudioModifications ().begin (), audioSource->getAudioModifications ().end ());
}

bool StoreObjectsFilter::shouldStoreDocumentData () const noexcept
{
    if (_filter)
        return (_filter->documentData != kARAFalse);
    return true;
}

/*******************************************************************************/

#if ARA_VALIDATE_API_CALLS

static std::map<const DocumentController*, const PlugInEntry*> _documentControllers;

bool DocumentController::hasValidInstancesForPlugInEntry (const PlugInEntry* entry) noexcept
{
    for (const auto& x : _documentControllers)
    {
        if (x.second == entry)
            return x.first->getDocument () != nullptr;
    }
    return false;
}

bool DocumentController::isValidDocumentController (const DocumentController* documentController) noexcept
{
    auto plugInEntry = _documentControllers.find (documentController);
    if (plugInEntry == _documentControllers.end ())
        return false;

    return (documentController->getPlugInEntry () == plugInEntry->second) && (documentController->_document != nullptr);
}

bool DocumentController::isValidMusicalContext (const MusicalContext* musicalContext) const noexcept
{
    if (musicalContext == nullptr)
        return false;

    if (musicalContext->getDocument () != _document)
        return false;

    return contains (_document->getMusicalContexts (), musicalContext);
}

bool DocumentController::isValidRegionSequence (const RegionSequence* regionSequence) const noexcept
{
    if (regionSequence == nullptr)
        return false;

    if (regionSequence->getDocument () != _document)
        return false;

    return contains (_document->getRegionSequences (), regionSequence);
}

bool DocumentController::isValidAudioSource (const AudioSource* audioSource) const noexcept
{
    if (audioSource == nullptr)
        return false;

    if (audioSource->getDocument () != _document)
        return false;

    return contains (_document->getAudioSources (), audioSource);
}

bool DocumentController::isValidAudioModification (const AudioModification* audioModification) const noexcept
{
    if (audioModification == nullptr)
        return false;

    auto audioSource { audioModification->getAudioSource () };
    if (!isValidAudioSource (audioSource))
        return false;

    return contains (audioSource->getAudioModifications (), audioModification);
}

bool DocumentController::isValidPlaybackRegion (const PlaybackRegion* playbackRegion) const noexcept
{
    if (playbackRegion == nullptr)
        return false;

    auto audioModification { playbackRegion->getAudioModification () };
    if (!isValidAudioModification (audioModification))
        return false;

    return contains (audioModification->getPlaybackRegions (), playbackRegion);
}

bool DocumentController::isValidContentReader (const ContentReader* contentReader) const noexcept
{
    return contains (_contentReaders, contentReader);
}

bool DocumentController::isValidPlaybackRenderer (const PlaybackRenderer* playbackRenderer) const noexcept
{
    return contains (_playbackRenderers, playbackRenderer);
}

bool DocumentController::isValidEditorRenderer (const EditorRenderer* editorRenderer) const noexcept
{
    return contains (_editorRenderers, editorRenderer);
}

bool DocumentController::isValidEditorView (const EditorView* editorView) const noexcept
{
    return contains (_editorViews, editorView);
}

#endif    // ARA_VALIDATE_API_CALLS

/*******************************************************************************/

DocumentController::DocumentController (const PlugInEntry* entry, const ARADocumentControllerHostInstance* instance) noexcept
: DocumentControllerDelegate { entry },
  _instance { this },
  _hostAudioAccessController { instance },
  _hostArchivingController { instance },
  _hostContentAccessController { instance },
  _hostModelUpdateController { instance },
  _hostPlaybackController { instance }
{
    _analysisProgressIsSynced.test_and_set (std::memory_order_release);

#if ARA_VALIDATE_API_CALLS
    _documentControllers.emplace (this, entry);
#endif
}

void DocumentController::initializeDocument (const ARADocumentProperties* properties) noexcept
{
    _document = doCreateDocument ();
    ARA_INTERNAL_ASSERT (_document != nullptr);
    ARA_LOG_MODELOBJECT_LIFETIME ("did create document", getDocument ());

    willUpdateDocumentProperties (_document, properties);
    getDocument ()->updateProperties (properties);
    didUpdateDocumentProperties (_document);
}

void DocumentController::destroyDocumentController () noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
// \todo this is currently not required by the api - we shall discuss whether or not it should be.
//  ARA_VALIDATE_API_STATE (!isHostEditingDocument ());

    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    ARA_VALIDATE_API_STATE (_document->getMusicalContexts ().empty ());
    ARA_VALIDATE_API_STATE (_document->getAudioSources ().empty ());

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy document", _document);
    willDestroyDocument (_document);
    doDestroyDocument (_document);
    _document = nullptr;

    _destroyIfUnreferenced ();
}

void DocumentController::_destroyIfUnreferenced () noexcept
{
    // still in use by host?
    if (_document != nullptr)
        return;

    // still referenced from plug-in instances?
    if (!_playbackRenderers.empty () ||
        !_editorRenderers.empty () ||
        !_editorViews.empty ())
        return;

#if ARA_VALIDATE_API_CALLS
    _documentControllers.erase (this);
#endif
    getPlugInEntry ()->destroyDocumentController (this);
}

/*******************************************************************************/

PlaybackRenderer* DocumentController::doCreatePlaybackRenderer () noexcept
{
    return new PlaybackRenderer (this);
}

void DocumentController::doDestroyPlaybackRenderer (PlaybackRenderer* playbackRenderer) noexcept
{
    delete playbackRenderer;
}

EditorRenderer* DocumentController::doCreateEditorRenderer () noexcept
{
    return new EditorRenderer (this);
}

void DocumentController::doDestroyEditorRenderer (EditorRenderer* editorRenderer) noexcept
{
    delete editorRenderer;
}

EditorView* DocumentController::doCreateEditorView () noexcept
{
    return new EditorView (this);
}

void DocumentController::doDestroyEditorView (EditorView* editorView) noexcept
{
    delete editorView;
}

/*******************************************************************************/

const ARAFactory* DocumentController::getFactory () const noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    return getPlugInEntry ()->getFactory ();
}

ARAAPIGeneration DocumentController::getUsedApiGeneration () const noexcept
{
    return getPlugInEntry ()->getUsedApiGeneration ();
}

/*******************************************************************************/

void DocumentController::beginEditing () noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (!isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    willBeginEditing ();

    _isHostEditingDocument = true;
}

void DocumentController::endEditing () noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    if (_musicalContextOrderChanged)
    {
        _document->sortMusicalContextsByOrderIndex ();
        _musicalContextOrderChanged = false;
        didReorderMusicalContextsInDocument (_document);
    }

    if (_regionSequenceOrderChanged)
    {
        _document->sortRegionSequencesByOrderIndex ();
        _regionSequenceOrderChanged = false;
        didReorderRegionSequencesInDocument (_document);
    }

    for (MusicalContext* musicalContext : _musicalContextsWithChangedRegionSequenceOrder)
    {
        musicalContext->sortRegionSequencesByOrderIndex ();
        didReorderRegionSequencesInMusicalContext (musicalContext);
    }
    _musicalContextsWithChangedRegionSequenceOrder.clear ();

    _isHostEditingDocument = false;

    didEndEditing ();

    ARA_LOG_EDITED_DOCUMENT ("finished editing document", _document);
}

void DocumentController::notifyModelUpdates () noexcept
{
#if ARA_ENABLE_HOST_ENTRY_LOG
    static int logCount { 0 };
    constexpr int maxLogCount { 3 };
    if ((++logCount) <= maxLogCount)
    {
        ARA_LOG_HOST_ENTRY (this);
        if (logCount >= maxLogCount)
            ARA_LOG ("notifyModelUpdates () called %i times, will now suppress logging future calls to it", maxLogCount);
    }
#endif
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto hostModelUpdateController { getHostModelUpdateController () };
    if (!hostModelUpdateController)
        return;

    willNotifyModelUpdates ();

    if (!_analysisProgressIsSynced.test_and_set (std::memory_order_release))
        for (auto& audioSource : _document->getAudioSources ())
            audioSource->getAnalysisProgressTracker ().notifyProgress (hostModelUpdateController, audioSource->getHostRef ());

    for (const auto& audioSourceUpdate : _audioSourceContentUpdates)
        hostModelUpdateController->notifyAudioSourceContentChanged (audioSourceUpdate.first->getHostRef (), nullptr, audioSourceUpdate.second);
    _audioSourceContentUpdates.clear ();

    for (const auto& audioModificationUpdate : _audioModificationContentUpdates)
        hostModelUpdateController->notifyAudioModificationContentChanged (audioModificationUpdate.first->getHostRef (), nullptr, audioModificationUpdate.second);
    _audioModificationContentUpdates.clear ();

    for (const auto& playbackRegionUpdate : _playbackRegionContentUpdates)
        hostModelUpdateController->notifyPlaybackRegionContentChanged (playbackRegionUpdate.first->getHostRef (), nullptr, playbackRegionUpdate.second);
    _playbackRegionContentUpdates.clear ();

    didNotifyModelUpdates ();
}

bool DocumentController::restoreObjectsFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    HostArchiveReader archiveReader (this, archiveReaderHostRef);

#if ARA_VALIDATE_API_CALLS
    if (DocumentController::getUsedApiGeneration () >= kARAAPIGeneration_2_0_Final)
    {
        const auto documentArchiveID { archiveReader.getDocumentArchiveID () };

        ARA_VALIDATE_API_STATE ((documentArchiveID != nullptr) && (std::strlen (documentArchiveID) > 0));

        bool isValidDocumentArchiveID { 0 == std::strcmp (documentArchiveID, getFactory ()->documentArchiveID) };
        for (ARASize i { 0 }; !isValidDocumentArchiveID && (i < getFactory ()->compatibleDocumentArchiveIDsCount); ++i)
            isValidDocumentArchiveID = (0 == std::strcmp (documentArchiveID, getFactory ()->compatibleDocumentArchiveIDs[i]));
        ARA_VALIDATE_API_STATE (isValidDocumentArchiveID);
    }
#endif

    const RestoreObjectsFilter restoreObjectsFilter (filter, getDocument ());

    return doRestoreObjectsFromArchive (&archiveReader, &restoreObjectsFilter);
}

bool DocumentController::storeObjectsToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (!isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    HostArchiveWriter archiveWriter (this, archiveWriterHostRef);
    if (filter)
    {
        for (ARASize i { 0 }; i < filter->audioSourceRefsCount; ++i)
            ARA_VALIDATE_API_ARGUMENT (filter->audioSourceRefs[i], isValidAudioSource (fromRef (filter->audioSourceRefs[i])));
        for (ARASize i { 0 }; i < filter->audioModificationRefsCount; ++i)
            ARA_VALIDATE_API_ARGUMENT (filter->audioModificationRefs[i], isValidAudioModification (fromRef (filter->audioModificationRefs[i])));
        const StoreObjectsFilter storeObjectsFilter (filter);
        return doStoreObjectsToArchive (&archiveWriter, &storeObjectsFilter);
    }
    else
    {
        const StoreObjectsFilter storeObjectsFilter (getDocument ());
        return doStoreObjectsToArchive (&archiveWriter, &storeObjectsFilter);
    }
}

bool DocumentController::storeAudioSourceToAudioFileChunk (ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));

    ARA_VALIDATE_API_ARGUMENT (documentArchiveID, documentArchiveID != nullptr);
    ARA_VALIDATE_API_ARGUMENT (openAutomatically, openAutomatically != nullptr);

    ARA_VALIDATE_API_STATE (getFactory ()->supportsStoringAudioFileChunks != kARAFalse);
    ARA_VALIDATE_API_STATE (!isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    HostArchiveWriter archiveWriter (this, archiveWriterHostRef);
    *documentArchiveID = nullptr;
    const auto result { doStoreAudioSourceToAudioFileChunk (&archiveWriter, audioSource, documentArchiveID, openAutomatically) };
    ARA_INTERNAL_ASSERT (*documentArchiveID != nullptr);
#if ARA_ENABLE_INTERNAL_ASSERTS
    bool isValidID { *documentArchiveID == getFactory ()->documentArchiveID };
    for (auto i { 0U }; !isValidID && (i < getFactory ()->compatibleDocumentArchiveIDsCount); ++i)
        isValidID = (*documentArchiveID == getFactory ()->compatibleDocumentArchiveIDs[i]);
    ARA_INTERNAL_ASSERT (isValidID);
#endif
    return result;
}

bool DocumentControllerDelegate::doStoreAudioSourceToAudioFileChunk (HostArchiveWriter* archiveWriter, AudioSource* audioSource, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept
{
    *documentArchiveID = getPlugInEntry ()->getFactory ()->documentArchiveID;
    *openAutomatically = false;

    ARAAudioSourceRef audioSourceRef { toRef (audioSource) };
    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAStoreObjectsFilter, audioModificationRefs)> filter { ARA::kARATrue,
                                                                                                      1U, &audioSourceRef,
                                                                                                      0U, nullptr
                                                                                                    };
    const StoreObjectsFilter storeObjectsFilter { &filter };
    return doStoreObjectsToArchive (archiveWriter, &storeObjectsFilter);
}

void DocumentController::updateDocumentProperties (PropertiesPtr<ARADocumentProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARADocumentProperties);

    willUpdateDocumentProperties (_document, properties);
    _document->updateProperties (properties);
    didUpdateDocumentProperties (_document);

    ARA_LOG_PROPERTY_CHANGES ("did update properties of document", _document);
}

/*******************************************************************************/

void DocumentController::_willChangeMusicalContextOrder () noexcept
{
    if (!_musicalContextOrderChanged)
    {
        willReorderMusicalContextsInDocument (_document);
        _musicalContextOrderChanged = true;
    }
}

ARAMusicalContextRef DocumentController::createMusicalContext (ARAMusicalContextHostRef hostRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAMusicalContextProperties);

    auto musicalContext { doCreateMusicalContext (_document, hostRef) };
    ARA_INTERNAL_ASSERT (musicalContext != nullptr);

    _willChangeMusicalContextOrder ();

    willUpdateMusicalContextProperties (musicalContext, properties);
    musicalContext->updateProperties (properties);
    didUpdateMusicalContextProperties (musicalContext);

    didAddMusicalContextToDocument (_document, musicalContext);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create musical context", musicalContext);
    return toRef (musicalContext);
}

void DocumentController::updateMusicalContextProperties (ARAMusicalContextRef musicalContextRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (musicalContextRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto musicalContext { fromRef (musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (musicalContextRef, isValidMusicalContext (musicalContext));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAMusicalContextProperties);

    if (properties.implements<ARA_STRUCT_MEMBER (ARAMusicalContextProperties, orderIndex)> ())
    {
        if (properties->orderIndex != musicalContext->getOrderIndex ())
        {
            _willChangeMusicalContextOrder ();
            _willChangeRegionSequenceOrder (nullptr);
        }
    }

    willUpdateMusicalContextProperties (musicalContext, properties);
    musicalContext->updateProperties (properties);
    didUpdateMusicalContextProperties (musicalContext);

    ARA_LOG_PROPERTY_CHANGES ("did update properties of musical context", musicalContext);
}

void DocumentController::updateMusicalContextContent (ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ContentUpdateScopes flags) noexcept
{
    ARA_LOG_HOST_ENTRY (musicalContextRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto musicalContext { fromRef (musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (musicalContextRef, isValidMusicalContext (musicalContext));
    doUpdateMusicalContextContent (musicalContext, range, flags);
}

void DocumentController::destroyMusicalContext (ARAMusicalContextRef musicalContextRef) noexcept
{
    ARA_LOG_HOST_ENTRY (musicalContextRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto musicalContext { fromRef (musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (musicalContextRef, isValidMusicalContext (musicalContext));
    ARA_VALIDATE_API_STATE (musicalContext->getRegionSequences ().empty ());

    if (find_erase (_musicalContextsWithChangedRegionSequenceOrder, musicalContext))
        didReorderRegionSequencesInMusicalContext (musicalContext);
    _willChangeMusicalContextOrder ();

    willRemoveMusicalContextFromDocument (_document, musicalContext);

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy musical context", musicalContext);
    willDestroyMusicalContext (musicalContext);
    doDestroyMusicalContext (musicalContext);
}

/*******************************************************************************/

void DocumentController::_willChangeRegionSequenceOrder (MusicalContext* musicalContext) noexcept
{
    if (!_regionSequenceOrderChanged)
    {
        _regionSequenceOrderChanged = true;
        willReorderRegionSequencesInDocument (_document);
    }

    if ((musicalContext != nullptr) && !contains (_musicalContextsWithChangedRegionSequenceOrder, musicalContext))
    {
        willReorderRegionSequencesInMusicalContext (musicalContext);
        _musicalContextsWithChangedRegionSequenceOrder.push_back (musicalContext);
    }
}

ARARegionSequenceRef DocumentController::createRegionSequence (ARARegionSequenceHostRef hostRef, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARARegionSequenceProperties);

    auto musicalContext { fromRef (properties->musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (properties->musicalContextRef, isValidMusicalContext (musicalContext));

    auto regionSequence { doCreateRegionSequence (_document, hostRef) };
    ARA_INTERNAL_ASSERT (regionSequence != nullptr);

    _willChangeRegionSequenceOrder (musicalContext);

    willUpdateRegionSequenceProperties (regionSequence, properties);
    regionSequence->updateProperties (properties);
    didUpdateRegionSequenceProperties (regionSequence);

    didAddRegionSequenceToDocument (_document, regionSequence);

    didAddRegionSequenceToMusicalContext (musicalContext, regionSequence);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create region sequence", regionSequence);
    return toRef (regionSequence);
}

void DocumentController::updateRegionSequenceProperties (ARARegionSequenceRef regionSequenceRef, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (regionSequenceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARARegionSequenceProperties);

    auto regionSequence { fromRef (regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, isValidRegionSequence (regionSequence));

    auto newMusicalContext { fromRef (properties->musicalContextRef) };
    ARA_VALIDATE_API_ARGUMENT (properties->musicalContextRef, isValidMusicalContext (newMusicalContext));

    auto currentMusicalContext { regionSequence->getMusicalContext () };
    const bool orderIndexChange { properties->orderIndex != regionSequence->getOrderIndex () };
    const bool musicalContextChange { newMusicalContext != currentMusicalContext };

    if (orderIndexChange || musicalContextChange)
        _willChangeRegionSequenceOrder (currentMusicalContext);
    if (musicalContextChange)
        _willChangeRegionSequenceOrder (newMusicalContext);

    if (musicalContextChange)
        willRemoveRegionSequenceFromMusicalContext (currentMusicalContext, regionSequence);

    willUpdateRegionSequenceProperties (regionSequence, properties);
    regionSequence->updateProperties (properties);
    didUpdateRegionSequenceProperties (regionSequence);

    if (musicalContextChange)
        didAddRegionSequenceToMusicalContext (newMusicalContext, regionSequence);

    ARA_LOG_PROPERTY_CHANGES ("did update properties of region sequence", regionSequence);
}

void DocumentController::destroyRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
    ARA_LOG_HOST_ENTRY (regionSequenceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto regionSequence { fromRef (regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, isValidRegionSequence (regionSequence));
    ARA_VALIDATE_API_STATE (regionSequence->getPlaybackRegions ().empty ());

    for (auto& editorView : _editorViews)
        editorView->willDestroyRegionSequence (regionSequence);
#if ARA_VALIDATE_API_CALLS
    for (const auto& editorRenderer : _editorRenderers)
        ARA_VALIDATE_API_STATE (!contains (editorRenderer->getRegionSequences (), regionSequence));
#endif

    _willChangeRegionSequenceOrder (regionSequence->getMusicalContext ());

    willRemoveRegionSequenceFromMusicalContext (regionSequence->getMusicalContext (), regionSequence);
    willRemoveRegionSequenceFromDocument (_document, regionSequence);

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy region sequence", regionSequence);
    willDestroyRegionSequence (regionSequence);
    doDestroyRegionSequence (regionSequence);
}

/*******************************************************************************/

void DocumentController::_validateAudioSourceChannelArrangement (PropertiesPtr<ARAAudioSourceProperties> properties) noexcept
{
    if (properties.implements<ARA_STRUCT_MEMBER (ARAAudioSourceProperties, channelArrangement)> ())
    {
        ARA_VALIDATE_API_ARGUMENT (properties,
                                   (ChannelArrangement { properties->channelArrangementDataType, properties->channelArrangement }
                                    .isValidForChannelCount (properties->channelCount)));
    }
    else
    {
        ARA_VALIDATE_API_ARGUMENT (properties, !properties.implements<ARA_STRUCT_MEMBER (ARAAudioSourceProperties, channelArrangementDataType)> ());
        ARA_VALIDATE_API_ARGUMENT (properties, (properties->channelCount <= 2));
    }
}

ARAAudioSourceRef DocumentController::createAudioSource (ARAAudioSourceHostRef hostRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAAudioSourceProperties);

    auto audioSource { doCreateAudioSource (_document, hostRef) };
    ARA_INTERNAL_ASSERT (audioSource != nullptr);

    _validateAudioSourceChannelArrangement (properties);
    
    willUpdateAudioSourceProperties (audioSource, properties);
    audioSource->updateProperties (properties);
    didUpdateAudioSourceProperties (audioSource);

    didAddAudioSourceToDocument (_document, audioSource);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create audio source", audioSource);
    return toRef (audioSource);
}

void DocumentController::updateAudioSourceProperties (ARAAudioSourceRef audioSourceRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAAudioSourceProperties);

    if ((audioSource->getSampleRate () != properties->sampleRate) ||
        (audioSource->getSampleCount () != properties->sampleCount) ||
        (audioSource->getChannelCount () != properties->channelCount))
    {
        // the host may change these properties only while access is disabled
        ARA_VALIDATE_API_STATE (!audioSource->isSampleAccessEnabled ());
    }

    _validateAudioSourceChannelArrangement (properties);

    willUpdateAudioSourceProperties (audioSource, properties);
    audioSource->updateProperties (properties);
    didUpdateAudioSourceProperties (audioSource);

    ARA_LOG_PROPERTY_CHANGES ("did update properties of audio source", audioSource);
}

void DocumentController::updateAudioSourceContent (ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ContentUpdateScopes flags) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    doUpdateAudioSourceContent (audioSource, range, flags);
}

void DocumentController::enableAudioSourceSamplesAccess (ARAAudioSourceRef audioSourceRef, bool enable) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    if (enable != audioSource->isSampleAccessEnabled ())
    {
        willEnableAudioSourceSamplesAccess (audioSource, enable);
        audioSource->setSampleAccessEnabled (enable);
        didEnableAudioSourceSamplesAccess (audioSource, enable);
    }
}

void DocumentController::deactivateAudioSourceForUndoHistory (ARAAudioSourceRef audioSourceRef, bool deactivate) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    if (deactivate != audioSource->isDeactivatedForUndoHistory ())
    {
        willDeactivateAudioSourceForUndoHistory (audioSource, deactivate);
        audioSource->setDeactivatedForUndoHistory (deactivate);
        didDeactivateAudioSourceForUndoHistory (audioSource, deactivate);
    }
}

void DocumentController::destroyAudioSource (ARAAudioSourceRef audioSourceRef) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    ARA_VALIDATE_API_STATE (audioSource->getAudioModifications ().empty ());

    willRemoveAudioSourceFromDocument (_document, audioSource);

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy audio source", audioSource);
    willDestroyAudioSource (audioSource);

    _audioSourceContentUpdates.erase (audioSource);

    doDestroyAudioSource (audioSource);
}

/*******************************************************************************/

ARAAudioModificationRef DocumentController::createAudioModification (ARAAudioSourceRef audioSourceRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAAudioModificationProperties);

    auto audioModification { doCreateAudioModification (audioSource, hostRef, nullptr) };
    ARA_INTERNAL_ASSERT (audioModification != nullptr);

    willUpdateAudioModificationProperties (audioModification, properties);
    audioModification->updateProperties (properties);
    didUpdateAudioModificationProperties (audioModification);

    didAddAudioModificationToAudioSource (audioSource, audioModification);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create audio modification", audioModification);
    return toRef (audioModification);
}

ARAAudioModificationRef DocumentController::cloneAudioModification (ARAAudioModificationRef srcAudioModificationRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (srcAudioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    const auto srcAudioModification { fromRef (srcAudioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (srcAudioModificationRef, isValidAudioModification (srcAudioModification));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAAudioModificationProperties);

    auto clonedAudioModification { doCreateAudioModification (srcAudioModification->getAudioSource (), hostRef, srcAudioModification) };
    willUpdateAudioModificationProperties (clonedAudioModification, properties);
    clonedAudioModification->updateProperties (properties);
    didUpdateAudioModificationProperties (clonedAudioModification);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create cloned audio modification", clonedAudioModification);
    return toRef (clonedAudioModification);
}

void DocumentController::updateAudioModificationProperties (ARAAudioModificationRef audioModificationRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAAudioModificationProperties);

    willUpdateAudioModificationProperties (audioModification, properties);
    audioModification->updateProperties (properties);
    didUpdateAudioModificationProperties (audioModification);

    ARA_LOG_PROPERTY_CHANGES ("did update properties of audio modification", audioModification);
}

bool DocumentController::isAudioModificationPreservingAudioSourceSignal (ARAAudioModificationRef audioModificationRef) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    return doIsAudioModificationPreservingAudioSourceSignal (audioModification);
}

void DocumentController::deactivateAudioModificationForUndoHistory (ARAAudioModificationRef audioModificationRef, bool deactivate) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    if (deactivate != audioModification->isDeactivatedForUndoHistory ())
    {
        willDeactivateAudioModificationForUndoHistory (audioModification, deactivate);
        audioModification->setDeactivatedForUndoHistory (deactivate);
        didDeactivateAudioModificationForUndoHistory (audioModification, deactivate);
    }
}

void DocumentController::destroyAudioModification (ARAAudioModificationRef audioModificationRef) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    ARA_VALIDATE_API_STATE (audioModification->getPlaybackRegions ().empty ());

    willRemoveAudioModificationFromAudioSource (audioModification->getAudioSource (), audioModification);

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy audio modification", audioModification);
    willDestroyAudioModification (audioModification);

    _audioModificationContentUpdates.erase (audioModification);

    doDestroyAudioModification (audioModification);
}

/*******************************************************************************/

ARAPlaybackRegionRef DocumentController::createPlaybackRegion (ARAAudioModificationRef audioModificationRef, ARAPlaybackRegionHostRef hostRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAPlaybackRegionProperties);

    auto playbackRegion { doCreatePlaybackRegion (audioModification, hostRef) };
    ARA_INTERNAL_ASSERT (playbackRegion != nullptr);

    willUpdatePlaybackRegionProperties (playbackRegion, properties);
    playbackRegion->updateProperties (properties);
    didUpdatePlaybackRegionProperties (playbackRegion);

    didAddPlaybackRegionToAudioModification (audioModification, playbackRegion);

    auto regionSequence { playbackRegion->getRegionSequence () };
#if ARA_SUPPORT_VERSION_1
    if (regionSequence)
#endif
        didAddPlaybackRegionToRegionSequence (regionSequence, playbackRegion);

    ARA_LOG_MODELOBJECT_LIFETIME ("did create playback region", playbackRegion);
    return toRef (playbackRegion);
}

void DocumentController::updatePlaybackRegionProperties (ARAPlaybackRegionRef playbackRegionRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARAPlaybackRegionProperties);

    // determine if the region sequence will change from this update
    auto currentSequence { playbackRegion->getRegionSequence () };
    auto newSequence { fromRef (properties->regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (newSequence, isValidRegionSequence (newSequence));

    if (currentSequence && (currentSequence != newSequence))
        willRemovePlaybackRegionFromRegionSequence (currentSequence, playbackRegion);

    willUpdatePlaybackRegionProperties (playbackRegion, properties);
    playbackRegion->updateProperties (properties);
    didUpdatePlaybackRegionProperties (playbackRegion);

#if ARA_SUPPORT_VERSION_1
    if (newSequence)
#endif
    {
        if (currentSequence != newSequence)
            didAddPlaybackRegionToRegionSequence (newSequence, playbackRegion);
    }

    ARA_LOG_PROPERTY_CHANGES ("did update properties of playback region", playbackRegion);
}

void DocumentController::getPlaybackRegionHeadAndTailTime (ARAPlaybackRegionRef playbackRegionRef, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_ARGUMENT (headTime, headTime != nullptr);
    ARA_VALIDATE_API_ARGUMENT (tailTime, tailTime != nullptr);

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));
    doGetPlaybackRegionHeadAndTailTime (playbackRegion, headTime, tailTime);
}

void DocumentController::destroyPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());
    ARA_VALIDATE_API_STATE (_contentReaders.empty ());

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));

    for (auto& editorView : _editorViews)
        editorView->willDestroyPlaybackRegion (playbackRegion);
#if ARA_VALIDATE_API_CALLS
    for (const auto& editorRenderer : _editorRenderers)
        ARA_VALIDATE_API_STATE (!contains (editorRenderer->getPlaybackRegions (), playbackRegion));
    for (const auto& playbackRenderer : _playbackRenderers)
        ARA_VALIDATE_API_STATE (!contains (playbackRenderer->getPlaybackRegions (), playbackRegion));
#endif

#if ARA_SUPPORT_VERSION_1
    if (playbackRegion->getRegionSequence ())
#endif
        willRemovePlaybackRegionFromRegionSequence (playbackRegion->getRegionSequence (), playbackRegion);

    willRemovePlaybackRegionFromAudioModification (playbackRegion->getAudioModification (), playbackRegion);

    ARA_LOG_MODELOBJECT_LIFETIME ("will destroy playback region", playbackRegion);
    willDestroyPlaybackRegion (playbackRegion);

    _playbackRegionContentUpdates.erase (playbackRegion);

    doDestroyPlaybackRegion (playbackRegion);
}

/*******************************************************************************/

bool DocumentController::isAudioSourceContentAvailable (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    return doIsAudioSourceContentAvailable (audioSource, type);
}

bool DocumentControllerDelegate::doIsAudioSourceContentAvailable (const AudioSource* /*audioSource*/, ARAContentType /*type*/) noexcept
{
    // must be overridden if plug-in supports analysis
    ARA_INTERNAL_ASSERT (_entry->getFactory ()->analyzeableContentTypesCount == 0);
    return false;
}

ARAContentGrade DocumentController::getAudioSourceContentGrade (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    return doGetAudioSourceContentGrade (audioSource, type);
}

ARAContentGrade DocumentControllerDelegate::doGetAudioSourceContentGrade (const AudioSource* /*audioSource*/, ARAContentType /*type*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsAudioSourceContentAvailable () requires overriding doGetAudioSourceContentGrade () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return kARAContentGradeInitial;
}

ARAContentReaderRef DocumentController::createAudioSourceContentReader (ARAAudioSourceRef audioSourceRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (getFactory ()->analyzeableContentTypesCount > 0);

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    ARA_VALIDATE_API_STATE (doIsAudioSourceContentAvailable (audioSource, type));

    auto contentReader { doCreateAudioSourceContentReader (audioSource, type, range) };
    ARA_INTERNAL_ASSERT (contentReader != nullptr);

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: did create content reader %p for audio source %p", contentReader, audioSource);
#endif
#if ARA_VALIDATE_API_CALLS
    _contentReaders.push_back (contentReader);
#endif
    return toRef (contentReader);
}

ContentReader* DocumentControllerDelegate::doCreateAudioSourceContentReader (AudioSource* /*audioSource*/, ARAContentType /*type*/, const ARAContentTimeRange* /*range*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsAudioSourceContentAvailable () requires overriding doCreateAudioSourceContentReader () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return nullptr;
}

/*******************************************************************************/

bool DocumentController::isAudioModificationContentAvailable (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    return doIsAudioModificationContentAvailable (audioModification, type);
}

bool DocumentControllerDelegate::doIsAudioModificationContentAvailable (const AudioModification* /*audioModification*/, ARAContentType /*type*/) noexcept
{
    return false;
}

ARAContentGrade DocumentController::getAudioModificationContentGrade (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    return doGetAudioModificationContentGrade (audioModification, type);
}

ARAContentGrade DocumentControllerDelegate::doGetAudioModificationContentGrade (const AudioModification* /*audioModification*/, ARAContentType /*type*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsAudioModificationContentAvailable () requires overriding doGetAudioModificationContentGrade () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return kARAContentGradeInitial;
}

ARAContentReaderRef DocumentController::createAudioModificationContentReader (ARAAudioModificationRef audioModificationRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    ARA_LOG_HOST_ENTRY (audioModificationRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (getFactory ()->analyzeableContentTypesCount > 0);

    auto audioModification { fromRef (audioModificationRef) };
    ARA_VALIDATE_API_ARGUMENT (audioModificationRef, isValidAudioModification (audioModification));
    ARA_VALIDATE_API_STATE (doIsAudioModificationContentAvailable (audioModification, type));

    auto contentReader { doCreateAudioModificationContentReader (audioModification, type, range) };
    ARA_INTERNAL_ASSERT (contentReader != nullptr);

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: did create content reader %p for audio modification %p", contentReader, audioModification);
#endif
#if ARA_VALIDATE_API_CALLS
    _contentReaders.push_back (contentReader);
#endif
    return toRef (contentReader);
}

ContentReader* DocumentControllerDelegate::doCreateAudioModificationContentReader (AudioModification* /*audioModification*/, ARAContentType /*type*/, const ARAContentTimeRange* /*range*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsAudioModificationContentAvailable () requires overriding doCreateAudioModificationContentReader () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return nullptr;
}

/*******************************************************************************/

bool DocumentController::isPlaybackRegionContentAvailable (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));
    return doIsPlaybackRegionContentAvailable (playbackRegion, type);
}

bool DocumentControllerDelegate::doIsPlaybackRegionContentAvailable (const PlaybackRegion* /*playbackRegion*/, ARAContentType /*type*/) noexcept
{
    return false;
}

ARAContentGrade DocumentController::getPlaybackRegionContentGrade (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));
    return doGetPlaybackRegionContentGrade (playbackRegion, type);
}

ARAContentGrade DocumentControllerDelegate::doGetPlaybackRegionContentGrade (const PlaybackRegion* /*playbackRegion*/, ARAContentType /*type*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsPlaybackRegionContentAvailable () requires overriding doGetPlaybackRegionContentGrade () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return kARAContentGradeInitial;
}

ARAContentReaderRef DocumentController::createPlaybackRegionContentReader (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    ARA_LOG_HOST_ENTRY (playbackRegionRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (getFactory ()->analyzeableContentTypesCount > 0);

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_STATE (doIsPlaybackRegionContentAvailable (playbackRegion, type));

    auto contentReader { doCreatePlaybackRegionContentReader (playbackRegion, type, range) };
    ARA_INTERNAL_ASSERT (contentReader != nullptr);

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: did create content reader %p for playback region %p", contentReader, playbackRegion);
#endif
#if ARA_VALIDATE_API_CALLS
    _contentReaders.push_back (contentReader);
#endif
    return toRef (contentReader);
}

ContentReader* DocumentControllerDelegate::doCreatePlaybackRegionContentReader (PlaybackRegion* /*playbackRegion*/, ARAContentType /*type*/, const ARAContentTimeRange* /*range*/) noexcept
{
#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4127))
#endif
    ARA_INTERNAL_ASSERT (false && "Overriding doIsPlaybackRegionContentAvailable () requires overriding doCreatePlaybackRegionContentReader () accordingly!");
#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif
    return nullptr;
}

/*******************************************************************************/

ARAInt32 DocumentController::getContentReaderEventCount (ARAContentReaderRef contentReaderRef) noexcept
{
    ARA_LOG_HOST_ENTRY (contentReaderRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto contentReader { fromRef (contentReaderRef) };
    ARA_VALIDATE_API_ARGUMENT (contentReaderRef, isValidContentReader (contentReader));

    return contentReader->getEventCount ();
}

const void* DocumentController::getContentReaderDataForEvent (ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept
{
    ARA_LOG_HOST_ENTRY (contentReaderRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto contentReader { fromRef (contentReaderRef) };
    ARA_VALIDATE_API_ARGUMENT (contentReaderRef, isValidContentReader (contentReader));
    ARA_VALIDATE_API_ARGUMENT (nullptr, 0 <= eventIndex);
    ARA_VALIDATE_API_ARGUMENT (nullptr, eventIndex < contentReader->getEventCount ());

    return contentReader->getDataForEvent (eventIndex);
}

void DocumentController::destroyContentReader (ARAContentReaderRef contentReaderRef) noexcept
{
    ARA_LOG_HOST_ENTRY (contentReaderRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    auto contentReader { fromRef (contentReaderRef) };
    ARA_VALIDATE_API_ARGUMENT (contentReaderRef, isValidContentReader (contentReader));

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: will destroy content reader %p", contentReader);
#endif
#if ARA_VALIDATE_API_CALLS
    find_erase (_contentReaders, contentReader);
#endif
    doDestroyContentReader (contentReader);
}

/*******************************************************************************/

std::vector<ARAContentType> const DocumentController::_getValidatedAnalyzableContentTypes (ARASize contentTypesCount, const ARAContentType contentTypes[], bool mayBeEmpty) noexcept
{
    ARA_VALIDATE_API_ARGUMENT (contentTypes, contentTypesCount <= getFactory ()->analyzeableContentTypesCount);
    if (mayBeEmpty)
    {
        if (contentTypesCount == 0)
            ARA_VALIDATE_API_ARGUMENT (contentTypes, contentTypes == nullptr);
        else
            ARA_VALIDATE_API_ARGUMENT (contentTypes, contentTypes != nullptr);
    }
    else
    {
        ARA_VALIDATE_API_ARGUMENT (contentTypes, 0 < contentTypesCount);
        ARA_VALIDATE_API_ARGUMENT (contentTypes, contentTypes != nullptr);
    }

    std::vector<ARAContentType> validatedContentTypes;
    validatedContentTypes.reserve (contentTypesCount);
    for (ARASize i { 0 }; i < contentTypesCount; ++i)
    {
        ARA_VALIDATE_API_ARGUMENT (contentTypes, canContentTypeBeAnalyzed (contentTypes[i]));
        if (canContentTypeBeAnalyzed (contentTypes[i]))
            validatedContentTypes.push_back (contentTypes[i]);
    }
    return validatedContentTypes;
}

bool DocumentController::canContentTypeBeAnalyzed (ARAContentType type) noexcept
{
    const auto analyzeableTypesCount { getFactory ()->analyzeableContentTypesCount };
    const auto analyzeableTypes { getFactory ()->analyzeableContentTypes };
    for (ARASize i { 0 }; i < analyzeableTypesCount; ++i)
    {
        if (type == analyzeableTypes[i])
            return true;
    }
    return false;
}

bool DocumentController::isAudioSourceContentAnalysisIncomplete (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    ARA_VALIDATE_API_ARGUMENT (nullptr, canContentTypeBeAnalyzed (type));
    if (!canContentTypeBeAnalyzed (type))
        return false;

    const auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));
    return doIsAudioSourceContentAnalysisIncomplete (audioSource, type);
}

bool DocumentControllerDelegate::doIsAudioSourceContentAnalysisIncomplete (const AudioSource* /*audioSource*/, ARAContentType /*type*/) noexcept
{
    // must be overridden if plug-in supports analysis
    ARA_INTERNAL_ASSERT (_entry->getFactory ()->analyzeableContentTypesCount == 0);
    return false;
}

void DocumentController::requestAudioSourceContentAnalysis (ARAAudioSourceRef audioSourceRef, ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));

    const auto validatedContentTypes { _getValidatedAnalyzableContentTypes (contentTypesCount, contentTypes, false) };
    if (validatedContentTypes.size ())
        doRequestAudioSourceContentAnalysis (audioSource, validatedContentTypes);
}

void DocumentControllerDelegate::doRequestAudioSourceContentAnalysis (AudioSource* /*audioSource*/, std::vector<ARAContentType> const& /*contentTypes*/) noexcept
{
    // must be overridden if plug-in supports analysis
    ARA_INTERNAL_ASSERT (_entry->getFactory ()->analyzeableContentTypesCount == 0);
}

ARAInt32 DocumentController::getProcessingAlgorithmsCount () noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    return doGetProcessingAlgorithmsCount ();
}

const ARAProcessingAlgorithmProperties* DocumentController::getProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_ARGUMENT (nullptr, 0 <= algorithmIndex);
    ARA_VALIDATE_API_ARGUMENT (nullptr, algorithmIndex < doGetProcessingAlgorithmsCount ());

    return doGetProcessingAlgorithmProperties (algorithmIndex);
}

const ARAProcessingAlgorithmProperties* DocumentControllerDelegate::doGetProcessingAlgorithmProperties (ARAInt32 /*algorithmIndex*/) noexcept
{
    if (doGetProcessingAlgorithmsCount () > 0)
        ARA_WARN ("doGetProcessingAlgorithmProperties () not implemented yet");

    return nullptr;
}

ARAInt32 DocumentController::getProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));

    const ARAInt32 algorithmIndex { doGetProcessingAlgorithmForAudioSource (audioSource) };
    ARA_INTERNAL_ASSERT ((0 <= algorithmIndex) && (algorithmIndex < doGetProcessingAlgorithmsCount ()));
    return algorithmIndex;
}

ARAInt32 DocumentControllerDelegate::doGetProcessingAlgorithmForAudioSource (const AudioSource* /*audioSource*/) noexcept
{
    if (doGetProcessingAlgorithmsCount () > 0)
        ARA_WARN ("doGetProcessingAlgorithmForAudioSource () not implemented yet");

    return 0;
}

void DocumentController::requestProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept
{
    ARA_LOG_HOST_ENTRY (audioSourceRef);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));
    ARA_VALIDATE_API_STATE (isHostEditingDocument ());

    auto audioSource { fromRef (audioSourceRef) };
    ARA_VALIDATE_API_ARGUMENT (audioSourceRef, isValidAudioSource (audioSource));

    ARA_VALIDATE_API_ARGUMENT (nullptr, 0 <= algorithmIndex);
    ARA_VALIDATE_API_ARGUMENT (nullptr, algorithmIndex < doGetProcessingAlgorithmsCount ());

    doRequestProcessingAlgorithmForAudioSource (audioSource, algorithmIndex);
}

void DocumentControllerDelegate::doRequestProcessingAlgorithmForAudioSource (AudioSource* /*audioSource*/, ARAInt32 /*algorithmIndex*/) noexcept
{
    if (doGetProcessingAlgorithmsCount () > 0)
        ARA_WARN ("doGetProcessingAlgorithmForAudioSource () not implemented yet");
}

/*******************************************************************************/

bool DocumentController::isLicensedForCapabilities (bool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, isValidDocumentController (this));

    const auto validatedContentTypes { _getValidatedAnalyzableContentTypes (contentTypesCount, contentTypes, true) };

    const auto supportedTransformationFlags { getFactory ()->supportedPlaybackTransformationFlags };
    ARA_VALIDATE_API_ARGUMENT (nullptr, (transformationFlags & ~supportedTransformationFlags) == 0);
    const auto validatedTransformationFlags { transformationFlags & supportedTransformationFlags };

    ARA_VALIDATE_API_ARGUMENT (nullptr, (contentTypesCount > 0) || (transformationFlags != kARAPlaybackTransformationNoChanges));

    if (doIsLicensedForContentAnalysisRequests (validatedContentTypes) && doIsLicensedForPlaybackTransformations (validatedTransformationFlags))
        return true;

    if (!runModalActivationDialogIfNeeded)
        return false;

    doRunModalLicenseActivationForCapabilities (validatedContentTypes, validatedTransformationFlags);
    return doIsLicensedForContentAnalysisRequests (validatedContentTypes) && doIsLicensedForPlaybackTransformations (validatedTransformationFlags);
}

void DocumentControllerDelegate::doRunModalLicenseActivationForCapabilities (std::vector<ARAContentType> const& /*contentTypes*/, ARAPlaybackTransformationFlags /*transformationFlags*/) noexcept
{
    ARA_WARN ("doRunModalLicenseActivationForCapabilities () not implemented yet");
}

/*******************************************************************************/

void DocumentController::notifyAudioSourceAnalysisProgressStarted (AudioSource* audioSource) noexcept
{
    if (getHostModelUpdateController ())
        if (audioSource->getAnalysisProgressTracker ().updateProgress (kARAAnalysisProgressStarted, 0.0f))
            _analysisProgressIsSynced.clear (std::memory_order_release);
}

void DocumentController::notifyAudioSourceAnalysisProgressUpdated (AudioSource* audioSource, float progress) noexcept
{
    if (getHostModelUpdateController ())
        if (audioSource->getAnalysisProgressTracker ().updateProgress (kARAAnalysisProgressUpdated, progress))
            _analysisProgressIsSynced.clear (std::memory_order_release);
}

void DocumentController::notifyAudioSourceAnalysisProgressCompleted (AudioSource* audioSource) noexcept
{
    if (getHostModelUpdateController ())
        if (audioSource->getAnalysisProgressTracker ().updateProgress (kARAAnalysisProgressCompleted, 1.0f))
            _analysisProgressIsSynced.clear (std::memory_order_release);
}

/*******************************************************************************/

void DocumentController::notifyAudioSourceContentChanged (AudioSource* audioSource, ContentUpdateScopes scopeFlags) noexcept
{
    ARA_INTERNAL_ASSERT (scopeFlags.affectEverything () || !scopeFlags.affectSamples ());

    if (getHostModelUpdateController ())
        _audioSourceContentUpdates[audioSource] += scopeFlags;
}

void DocumentController::notifyAudioModificationContentChanged (AudioModification* audioModification, ContentUpdateScopes scopeFlags) noexcept
{
    if (getHostModelUpdateController ())
        _audioModificationContentUpdates[audioModification] += scopeFlags;
}

void DocumentController::notifyPlaybackRegionContentChanged (PlaybackRegion* playbackRegion, ContentUpdateScopes scopeFlags) noexcept
{
    if (getHostModelUpdateController ())
        _playbackRegionContentUpdates[playbackRegion] += scopeFlags;
}

/*******************************************************************************/

HostAudioReader::HostAudioReader (const AudioSource* audioSource, bool use64BitSamples) noexcept
: HostAudioReader { audioSource->getDocumentController ()->getHostAudioAccessController (), audioSource->getHostRef (), use64BitSamples }
{}

HostAudioReader::HostAudioReader (HostAudioAccessController* audioAccessController, ARAAudioSourceHostRef audioSourceHostRef, bool use64BitSamples) noexcept
: _audioAccessController { audioAccessController },
  _hostRef { audioAccessController->createAudioReaderForSource (audioSourceHostRef, use64BitSamples) }
{}

HostAudioReader::~HostAudioReader () noexcept
{
    if (_audioAccessController)     // can only be a null_ptr after move c'tor/assigment
        _audioAccessController->destroyAudioReader (_hostRef);
}

HostAudioReader::HostAudioReader (HostAudioReader&& other) noexcept
{
    _audioAccessController = nullptr;
    _hostRef = nullptr;
    *this = std::move (other);
}

HostAudioReader& HostAudioReader::operator= (HostAudioReader&& other) noexcept
{
    std::swap (_audioAccessController, other._audioAccessController);
    std::swap (_hostRef, other._hostRef);
    return *this;
}

bool HostAudioReader::readAudioSamples (ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) const noexcept
{
    return _audioAccessController->readAudioSamples (_hostRef, samplePosition, samplesPerChannel, buffers);
}

/*******************************************************************************/

HostArchiveReader::HostArchiveReader (DocumentController* documentController, ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
: _hostArchivingController { documentController->getHostArchivingController () },
  _hostRef { archiveReaderHostRef }
{}

ARASize HostArchiveReader::getArchiveSize () const noexcept
{
    return _hostArchivingController->getArchiveSize (_hostRef);
}

bool HostArchiveReader::readBytesFromArchive (ARASize position, ARASize length, ARAByte buffer[]) const noexcept
{
    return _hostArchivingController->readBytesFromArchive (_hostRef, position, length, buffer);
}

void HostArchiveReader::notifyDocumentUnarchivingProgress (float value) noexcept
{
    _hostArchivingController->notifyDocumentUnarchivingProgress (value);
}

ARAPersistentID HostArchiveReader::getDocumentArchiveID () const noexcept
{
    return _hostArchivingController->getDocumentArchiveID (_hostRef);
}

/*******************************************************************************/

HostArchiveWriter::HostArchiveWriter (DocumentController* documentController, ARAArchiveWriterHostRef archiveWriterHostRef) noexcept
: _hostArchivingController { documentController->getHostArchivingController () },
  _hostRef { archiveWriterHostRef }
{}

bool HostArchiveWriter::writeBytesToArchive (ARASize position, ARASize length, const ARAByte buffer[]) noexcept
{
    return _hostArchivingController->writeBytesToArchive (_hostRef, position, length, buffer);
}

void HostArchiveWriter::notifyDocumentArchivingProgress (float value) noexcept
{
    _hostArchivingController->notifyDocumentArchivingProgress (value);
}

/*******************************************************************************/

std::vector<PlaybackRegion*> _convertPlaybackRegionsArray (const DocumentController* ARA_MAYBE_UNUSED_ARG (documentController), ARASize playbackRegionsCount, const ARAPlaybackRegionRef playbackRegionRefs[])
{
    std::vector<PlaybackRegion*> playbackRegions;
    if (playbackRegionsCount > 0)
    {
        ARA_VALIDATE_API_ARGUMENT (playbackRegionRefs, playbackRegionRefs != nullptr);
        playbackRegions.reserve (playbackRegionsCount);
        for (ARASize i { 0 }; i < playbackRegionsCount; ++i)
        {
            auto playbackRegion { fromRef (playbackRegionRefs[i]) };
            ARA_VALIDATE_API_ARGUMENT (playbackRegionRefs[i], documentController->isValidPlaybackRegion (playbackRegion));
            playbackRegions.push_back (playbackRegion);
        }
    }

    return playbackRegions;
}

std::vector<RegionSequence*> _convertRegionSequencesArray (const DocumentController* ARA_MAYBE_UNUSED_ARG (documentController), ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[])
{
    std::vector<RegionSequence*> regionSequences;
    if (regionSequenceRefsCount > 0)
    {
        ARA_VALIDATE_API_ARGUMENT (regionSequenceRefs, regionSequenceRefs != nullptr);
        regionSequences.reserve (regionSequenceRefsCount);
        for (ARASize i { 0 }; i < regionSequenceRefsCount; ++i)
        {
            auto regionSequence { fromRef (regionSequenceRefs[i]) };
            ARA_VALIDATE_API_ARGUMENT (regionSequenceRefs[i], documentController->isValidRegionSequence (regionSequence));
            regionSequences.push_back (regionSequence);
        }
    }

    return regionSequences;
}

/*******************************************************************************/

ViewSelection::ViewSelection (const DocumentController* documentController, SizedStructPtr<ARAViewSelection> selection) noexcept
: _playbackRegions { _convertPlaybackRegionsArray (documentController, selection->playbackRegionRefsCount, selection->playbackRegionRefs) },
  _regionSequences { _convertRegionSequencesArray (documentController, selection->regionSequenceRefsCount, selection->regionSequenceRefs) },
  _timeRange { selection->timeRange }
{}

std::vector<PlaybackRegion*> ViewSelection::getEffectivePlaybackRegions () const noexcept
{
    std::vector<PlaybackRegion*> result { _playbackRegions };

    if (result.empty ())
    {
        for (const auto& regionSequence : _regionSequences)
        {
            for (const auto& playbackRegion : regionSequence->getPlaybackRegions ())
            {
                if ((_timeRange == nullptr) || playbackRegion->intersectsWithPlaybackTimeRange (*_timeRange))
                    result.push_back (playbackRegion);
            }
        }
    }

    return result;
}

std::vector<RegionSequence*> ViewSelection::getEffectiveRegionSequences () const noexcept
{
    std::vector<RegionSequence*> result { _regionSequences };

    if (result.empty ())
    {
        for (const auto& playbackRegion : _playbackRegions)
        {
            if (!contains (result, playbackRegion->getRegionSequence ()))
                result.push_back (playbackRegion->getRegionSequence ());
        }
    }

    return result;
}

ARAContentTimeRange getUnionTimeRangeOfPlaybackRegions (std::vector<PlaybackRegion*> const& playbackRegions) noexcept
{
    ARA_INTERNAL_ASSERT (!playbackRegions.empty ());

    auto start { playbackRegions.front ()->getStartInPlaybackTime () };
    auto end { playbackRegions.front ()->getEndInPlaybackTime () };
    for (const auto& playbackRegion : playbackRegions)
    {
        start = std::min (start, playbackRegion->getStartInPlaybackTime ());
        end = std::max (end, playbackRegion->getEndInPlaybackTime ());
    }
    return { start, end - start };
}

ARAContentTimeRange ViewSelection::getEffectiveTimeRange () const noexcept
{
    if (_timeRange != nullptr)
        return *_timeRange;

    if (!_playbackRegions.empty ())
        return getUnionTimeRangeOfPlaybackRegions (_playbackRegions);

    auto effectivePlaybackRegions { getEffectivePlaybackRegions () };
    if (!effectivePlaybackRegions.empty ())
        return getUnionTimeRangeOfPlaybackRegions (effectivePlaybackRegions);

    return {};
}

/*******************************************************************************/

PlaybackRenderer::PlaybackRenderer (DocumentController* documentController) noexcept
: _documentController { documentController }
{
    _documentController->addPlaybackRenderer (this);
}

PlaybackRenderer::~PlaybackRenderer () noexcept
{
    if (_documentController)
        _documentController->removePlaybackRenderer (this);
}

void PlaybackRenderer::addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidPlaybackRenderer (this));

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, _documentController->isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, !contains (_playbackRegions, playbackRegion));

    willAddPlaybackRegion (playbackRegion);
    _playbackRegions.push_back (playbackRegion);
    didAddPlaybackRegion (playbackRegion);
}

void PlaybackRenderer::removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidPlaybackRenderer (this));

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, _documentController->isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, contains (_playbackRegions, playbackRegion));

    willRemovePlaybackRegion (playbackRegion);
    find_erase (_playbackRegions, playbackRegion);
    didRemovePlaybackRegion (playbackRegion);
}


/*******************************************************************************/

EditorRenderer::EditorRenderer (DocumentController* documentController) noexcept
: _documentController { documentController }
{
    _documentController->addEditorRenderer (this);
}

EditorRenderer::~EditorRenderer () noexcept
{
    if (_documentController)
        _documentController->removeEditorRenderer (this);
}

void EditorRenderer::addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorRenderer (this));
    ARA_VALIDATE_API_STATE (_regionSequences.empty ());

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, _documentController->isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, !contains (_playbackRegions, playbackRegion));

    willAddPlaybackRegion (playbackRegion);
    _playbackRegions.push_back (playbackRegion);
    didAddPlaybackRegion (playbackRegion);
}

void EditorRenderer::removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorRenderer (this));

    auto playbackRegion { fromRef (playbackRegionRef) };
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, _documentController->isValidPlaybackRegion (playbackRegion));
    ARA_VALIDATE_API_ARGUMENT (playbackRegionRef, contains (_playbackRegions, playbackRegion));

    willRemovePlaybackRegion (playbackRegion);
    find_erase (_playbackRegions, playbackRegion);
    didRemovePlaybackRegion (playbackRegion);
}

void EditorRenderer::addRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorRenderer (this));
    ARA_VALIDATE_API_STATE (_playbackRegions.empty ());

    auto regionSequence { fromRef (regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, _documentController->isValidRegionSequence (regionSequence));
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, !contains (_regionSequences, regionSequence));

    willAddRegionSequence (regionSequence);
    _regionSequences.push_back (regionSequence);
    didAddRegionSequence (regionSequence);
}

void EditorRenderer::removeRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorRenderer (this));

    auto regionSequence { fromRef (regionSequenceRef) };
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, _documentController->isValidRegionSequence (regionSequence));
    ARA_VALIDATE_API_ARGUMENT (regionSequenceRef, contains (_regionSequences, regionSequence));

    willRemoveRegionSequence (regionSequence);
    find_erase (_regionSequences, regionSequence);
    didRemoveRegionSequence (regionSequence);
}

/*******************************************************************************/

EditorView::EditorView (DocumentController* documentController) noexcept
: _documentController { documentController }
{
    _documentController->addEditorView (this);
}

EditorView::~EditorView () noexcept
{
    if (_documentController)
        _documentController->removeEditorView (this);
}

void EditorView::setEditorOpen (bool isOpen) noexcept
{
    _isEditorOpen = isOpen;

    if (!isOpen)                    // when closing the editor, we clear the view selection & hidden sequences since the host will no longer maintain it
    {
        clearViewSelection ();
        _hiddenRegionSequences.clear ();
    }
}

void EditorView::willDestroyRegionSequence (RegionSequence* regionSequence) noexcept
{
    if (contains (_viewSelection.getRegionSequences (), regionSequence))
        clearViewSelection ();

    find_erase (_hiddenRegionSequences, regionSequence);
}

void EditorView::willDestroyPlaybackRegion (PlaybackRegion* playbackRegion) noexcept
{
    if (contains (_viewSelection.getPlaybackRegions (), playbackRegion))
        clearViewSelection ();
}

void EditorView::notifySelection (SizedStructPtr<ARAViewSelection> selection) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorView (this));
    ARA_VALIDATE_API_STRUCT_PTR (selection, ARAViewSelection);
    _viewSelection = ViewSelection (_documentController, selection);

#if ARA_ENABLE_VIEW_UPDATE_LOG
    auto timeRangeStart { (_viewSelection.getTimeRange ()) ? _viewSelection.getTimeRange ()->start : -std::numeric_limits<ARATimeDuration>::infinity () };
    auto timeRangeEnd { (_viewSelection.getTimeRange ()) ? _viewSelection.getTimeRange ()->start + _viewSelection.getTimeRange ()->duration: +std::numeric_limits<ARATimeDuration>::infinity () };
    ARA_LOG ("Plug success: notifying selection of %i playback regions, %i region sequences, time range from %+.2f to %+.2f in editor view %p",
            _viewSelection.getPlaybackRegions ().size (), _viewSelection.getRegionSequences ().size (),
            timeRangeStart, timeRangeEnd, this);
#endif

    if (_isEditorOpen)
        doNotifySelection (&_viewSelection);
}

void EditorView::notifyHideRegionSequences (ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept
{
    ARA_LOG_HOST_ENTRY (this);
    ARA_VALIDATE_API_ARGUMENT (this, DocumentController::isValidDocumentController (_documentController) && _documentController->isValidEditorView (this));
    _hiddenRegionSequences = _convertRegionSequencesArray (_documentController, regionSequenceRefsCount, regionSequenceRefs);

#if ARA_ENABLE_VIEW_UPDATE_LOG
    if (_hiddenRegionSequences.empty ())
    {
        ARA_LOG ("Plug success: notifying no region sequences hidden in editor view %p", this);
    }
    else
    {
        for (const auto& regionSequence : _hiddenRegionSequences)
        {
            std::string regionSequenceName { (regionSequence->getName ()) ? regionSequence->getName () : "(nullptr)" };
            ARA_LOG ("Plug success: notifying region sequence %s hidden in editor view %p", regionSequenceName.c_str (), this);
        }
    }
#endif

    if (_isEditorOpen)
        doNotifyHideRegionSequences (_hiddenRegionSequences);
}

void EditorView::clearViewSelection () noexcept
{
    _viewSelection = ViewSelection ();
}

/*******************************************************************************/

PlugInExtension::~PlugInExtension () noexcept
{
    ARA_LOG_HOST_ENTRY (this);
#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    if (isBoundToARA ())
        ARA_LOG ("Plug success: will destroy plug-in extension %p (playbackRenderer %p, editorRenderer %p, editorView %p)", this, getPlaybackRenderer (), getEditorRenderer (), getEditorView ());
#endif

    if (auto editorView = getEditorView ())
        editorView->getDocumentController ()->doDestroyEditorView (editorView);
    if (auto editorRenderer = getEditorRenderer ())
        editorRenderer->getDocumentController ()->doDestroyEditorRenderer (editorRenderer);
    if (auto playbackRenderer = getPlaybackRenderer ())
        playbackRenderer->getDocumentController ()->doDestroyPlaybackRenderer (playbackRenderer);
}

const ARAPlugInExtensionInstance* PlugInExtension::bindToARA (ARADocumentControllerRef documentControllerRef,
                                                              ARAPlugInInstanceRoleFlags knownRoles, ARAPlugInInstanceRoleFlags assignedRoles) noexcept
{
    ARA_LOG_HOST_ENTRY (this);

    // verify this is only called once
    if (_documentController)
    {
        ARA_VALIDATE_API_STATE (false && "binding already established");
        return nullptr;
    }

    _documentController = fromRef<DocumentController> (documentControllerRef);
    ARA_VALIDATE_API_ARGUMENT (documentControllerRef, DocumentController::isValidDocumentController (_documentController));

    const bool isPlaybackRenderer { ((knownRoles & kARAPlaybackRendererRole) == 0) || ((assignedRoles & kARAPlaybackRendererRole) != 0) };
    const bool isEditorRenderer { ((knownRoles & kARAEditorRendererRole) == 0) || ((assignedRoles & kARAEditorRendererRole) != 0) };
    const bool isEditorView { ((knownRoles & kARAEditorViewRole) == 0) || ((assignedRoles & kARAEditorViewRole) != 0) };

    _instance = PlugInExtensionInstance (isPlaybackRenderer ? _documentController->doCreatePlaybackRenderer () : nullptr,
                                         isEditorRenderer   ? _documentController->doCreateEditorRenderer ()   : nullptr,
                                         isEditorView       ? _documentController->doCreateEditorView ()       : nullptr);

#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: did create plug-in extension %p (playbackRenderer %p, editorRenderer %p, editorView %p)", this, getPlaybackRenderer (), getEditorRenderer (), getEditorView ());
#endif

    didBindToARA ();

    return &_instance;
}

/*******************************************************************************/

#if ARA_VALIDATE_API_CALLS
static int _assertInitCount { 0 };
#endif

PlugInEntry::PlugInEntry (const FactoryConfig* factoryConfig,
                          void (ARA_CALL * initializeARAWithConfigurationFunc) (const ARAInterfaceConfiguration*),
                          void (ARA_CALL * uninitializeARAFunc) (),
                          const ARADocumentControllerInstance* (ARA_CALL *createDocumentControllerWithDocumentFunc) (const ARADocumentControllerHostInstance*, const ARADocumentProperties*)) noexcept
  : _factoryConfig { factoryConfig },
    _factory { factoryConfig->getLowestSupportedApiGeneration (), factoryConfig->getHighestSupportedApiGeneration (),
               factoryConfig->getFactoryID (),
               initializeARAWithConfigurationFunc, uninitializeARAFunc,
               factoryConfig->getPlugInName (), factoryConfig->getManufacturerName (), factoryConfig->getInformationURL (), factoryConfig->getVersion (),
               createDocumentControllerWithDocumentFunc,
               factoryConfig->getDocumentArchiveID (), factoryConfig->getCompatibleDocumentArchiveIDsCount (), factoryConfig->getCompatibleDocumentArchiveIDs (),
               factoryConfig->getAnalyzeableContentTypesCount (), factoryConfig->getAnalyzeableContentTypes (),
               factoryConfig->getSupportedPlaybackTransformationFlags (),
               (factoryConfig->supportsStoringAudioFileChunks ()) ? kARATrue : kARAFalse
             }
{
#if ARA_CPU_ARM
    ARA_INTERNAL_ASSERT (_factory.lowestSupportedApiGeneration >= kARAAPIGeneration_2_0_Final);
#else
    ARA_INTERNAL_ASSERT (_factory.lowestSupportedApiGeneration >= kARAAPIGeneration_1_0_Draft);
#endif
    ARA_INTERNAL_ASSERT (_factory.highestSupportedApiGeneration >= _factory.lowestSupportedApiGeneration);

    ARA_INTERNAL_ASSERT (std::strlen (_factory.factoryID) > 5);             // at least "xx.y." needed to form a valid url-based unique ID
    ARA_INTERNAL_ASSERT (std::strlen (_factory.plugInName) > 0);
    ARA_INTERNAL_ASSERT (std::strlen (_factory.manufacturerName) > 0);
    ARA_INTERNAL_ASSERT (std::strlen (_factory.informationURL) > 0);
    ARA_INTERNAL_ASSERT (std::strlen (_factory.version) > 0);

    ARA_INTERNAL_ASSERT (std::strlen (_factory.documentArchiveID) > 5);     // at least "xx.y." needed to form a valid url-based unique ID
    if (_factory.compatibleDocumentArchiveIDsCount == 0)
        ARA_INTERNAL_ASSERT (_factory.compatibleDocumentArchiveIDs == nullptr);
    else
        ARA_INTERNAL_ASSERT (_factory.compatibleDocumentArchiveIDs != nullptr);
    for (auto i { 0U }; i < _factory.compatibleDocumentArchiveIDsCount; ++i)
        ARA_INTERNAL_ASSERT (std::strlen (_factory.compatibleDocumentArchiveIDs[i]) > 5);

    if (_factory.analyzeableContentTypesCount == 0)
        ARA_INTERNAL_ASSERT (_factory.analyzeableContentTypes == nullptr);
    else
        ARA_INTERNAL_ASSERT (_factory.analyzeableContentTypes != nullptr);

    // if content based fades are supported, they shall be supported on both ends
    if ((_factory.supportedPlaybackTransformationFlags & kARAPlaybackTransformationContentBasedFades) != 0)
        ARA_INTERNAL_ASSERT ((_factory.supportedPlaybackTransformationFlags & kARAPlaybackTransformationContentBasedFades) == kARAPlaybackTransformationContentBasedFades);
}

PlugInEntry::~PlugInEntry ()
{
    ARA_VALIDATE_API_STATE ((_usedApiGeneration == 0) && "ARAFactory::uninitializeARA () not called!");
}

void PlugInEntry::initializeARAWithConfiguration (const ARAInterfaceConfiguration* config) noexcept
{
    ARA_LOG_HOST_ENTRY (nullptr);
    ARA_VALIDATE_API_STATE (_usedApiGeneration == 0);

    const SizedStructPtr<ARAInterfaceConfiguration> ptr { config };
    ARA_VALIDATE_API_STRUCT_PTR (ptr, ARAInterfaceConfiguration);
    ARA_VALIDATE_API_ARGUMENT (ptr, getFactory ()->lowestSupportedApiGeneration <= ptr->desiredApiGeneration);
    ARA_VALIDATE_API_ARGUMENT (ptr, ptr->desiredApiGeneration <= getFactory ()->highestSupportedApiGeneration);

    _usedApiGeneration = ptr->desiredApiGeneration;

#if ARA_VALIDATE_API_CALLS
    ++_assertInitCount;
#if defined (NDEBUG)
    // when not debugging from our side, use host asserts (if provided)
    ARASetExternalAssertReference (ptr->assertFunctionAddress);
#else
    // when debugging from our side, switch host to our asserts
    if (ptr->assertFunctionAddress)
        *ptr->assertFunctionAddress = &ARAInterfaceAssert;
#endif
#endif
}

void PlugInEntry::uninitializeARA () noexcept
{
    ARA_LOG_HOST_ENTRY (nullptr);
    ARA_VALIDATE_API_STATE (_usedApiGeneration != 0);
    ARA_VALIDATE_API_STATE (!DocumentController::hasValidInstancesForPlugInEntry (this));

#if ARA_VALIDATE_API_CALLS
    if ((--_assertInitCount) == 0)
        ARASetExternalAssertReference (nullptr);
#endif

    _usedApiGeneration = 0;
}

const ARADocumentControllerInstance* PlugInEntry::createDocumentControllerWithDocument (const ARADocumentControllerHostInstance* hostInstance, const ARADocumentProperties* properties) noexcept
{
    ARA_LOG_HOST_ENTRY (nullptr);
    ARA_VALIDATE_API_STRUCT_PTR (hostInstance, ARADocumentControllerHostInstance);
    ARA_VALIDATE_API_INTERFACE (hostInstance->audioAccessControllerInterface, ARAAudioAccessControllerInterface);
    ARA_VALIDATE_API_INTERFACE (hostInstance->archivingControllerInterface, ARAArchivingControllerInterface);
    if (_usedApiGeneration >= kARAAPIGeneration_2_0_Final)
        ARA_VALIDATE_API_ARGUMENT (hostInstance->archivingControllerInterface, SizedStructPtr<ARAArchivingControllerInterface> (hostInstance->archivingControllerInterface).implements<ARA_STRUCT_MEMBER (ARAArchivingControllerInterface, getDocumentArchiveID)> ());
    if (hostInstance->contentAccessControllerInterface)
        ARA_VALIDATE_API_INTERFACE (hostInstance->contentAccessControllerInterface, ARAContentAccessControllerInterface);
    if (hostInstance->modelUpdateControllerInterface)
        ARA_VALIDATE_API_INTERFACE (hostInstance->modelUpdateControllerInterface, ARAModelUpdateControllerInterface);
    if (hostInstance->playbackControllerInterface)
        ARA_VALIDATE_API_INTERFACE (hostInstance->playbackControllerInterface, ARAPlaybackControllerInterface);
    ARA_VALIDATE_API_STRUCT_PTR (properties, ARADocumentProperties);

    auto documentController { _factoryConfig->createDocumentController (this, hostInstance) };
    ARA_INTERNAL_ASSERT (documentController != nullptr);
#if ARA_ENABLE_OBJECT_LIFETIME_LOG
    ARA_LOG ("Plug success: did create document controller %p", documentController);
#endif

    documentController->initializeDocument (properties);

    return documentController->getInstance ();
}

}   // namespace PlugIn
}   // namespace ARA
