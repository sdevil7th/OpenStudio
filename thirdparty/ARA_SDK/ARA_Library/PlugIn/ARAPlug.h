//------------------------------------------------------------------------------
//! \file       ARAPlug.h
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

#ifndef ARAPlug_h
#define ARAPlug_h

#include "ARA_Library/Debug/ARADebug.h"
#include "ARA_Library/Dispatch/ARAPlugInDispatch.h"
#include "ARA_Library/Dispatch/ARAContentReader.h"
#include "ARA_Library/Utilities/ARAChannelArrangement.h"
#include "ARA_Library/Utilities/ARAStdVectorUtilities.h"
#include "ARA_Library/Utilities/ARASamplePositionConversion.h"

#if ARA_VALIDATE_API_CALLS
    #include "ARA_Library/Debug/ARAContentValidator.h"
#endif

#include <map>
#include <set>
#include <string>
#include <cstring>
#include <atomic>
#include <stdlib.h>     // workaround, see OptionalProperty::operator=


namespace ARA
{
namespace PlugIn
{


/*******************************************************************************/
// Locally suppress some warnings that may be enabled in some context these headers are compiled.
#if !defined (ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_BEGIN) || !defined (ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_END)
    #if defined (_MSC_VER)
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_BEGIN \
            __pragma (warning(push)) \
            __pragma (warning(disable : 4100))
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_END \
            __pragma (warning(pop))
    #elif defined (__GNUC__)
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_BEGIN \
            _Pragma ("GCC diagnostic push") \
            _Pragma ("GCC diagnostic ignored \"-Wunused-parameter\"")
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_END \
            _Pragma ("GCC diagnostic pop")
    #else
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_BEGIN
        #define ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_END
    #endif
#endif

ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_BEGIN


/*******************************************************************************/
// Classes used to wrap the ARA C Interface into C++ Objects on the plug-in side.
class Document;
class MusicalContext;
class RegionSequence;
class AudioSource;
class AudioModification;
class PlaybackRegion;
class ContentReader;
class RestoreObjectsFilter;
class StoreObjectsFilter;
class DocumentController;
template <ARAContentType contentType> class HostContentReader;
class HostAudioReader;
class HostArchiveReader;
class HostArchiveWriter;
class ViewSelection;
class PlaybackRenderer;
class EditorRenderer;
class EditorView;
class PlugInExtension;
class FactoryConfig;
class PlugInEntry;


//! @addtogroup ARA_Library_ARAPlug_Utility_Classes
//! @{

/*******************************************************************************/
//! Template container class managing optional property data sent from the host.
//! If the host passes nullptr for the property, this is stored, otherwise the property data is
//! copied to newly allocated memory.
template <typename T>
class OptionalProperty;

template <typename T>
class OptionalProperty<T*>
{
public:
    constexpr inline OptionalProperty () noexcept = default;
    constexpr inline OptionalProperty (std::nullptr_t /*other*/) noexcept    // creation with nullptr
    : OptionalProperty () {}

    explicit inline OptionalProperty (const T* value) noexcept
    : OptionalProperty () { *this = value; }

    inline OptionalProperty (const OptionalProperty& other) noexcept
    : OptionalProperty () { *this = other._data; }

    inline OptionalProperty (OptionalProperty&& other) noexcept
    : OptionalProperty () { *this = std::move (other); }

    inline ~OptionalProperty () noexcept { *this = nullptr; }

    inline operator const T* () const noexcept { return this->_data; }

    inline const T* operator-> () const noexcept { return this->_data; }

    inline OptionalProperty& operator= (const T* value) noexcept
    {
        if (this->_data != value)
        {
            // Xcode 8 has namespace issues with std::malloc()/std::free(), so we use the C version for now
            /*std::*/free (const_cast<void *> (static_cast<const void *> (this->_data)));
            this->_data = nullptr;

            if (value)
            {
                const auto dataSize { getAllocSize (value) };
                auto data { /*std::*/malloc (dataSize) };
                ARA_INTERNAL_ASSERT (data);
                std::memcpy (data, value, dataSize);
                this->_data = static_cast<const T*> (data);
            }
        }

        return *this;
    }

    inline OptionalProperty& operator= (const OptionalProperty& other) noexcept
    {
        *this = other._data;
        return *this;
    }

    inline OptionalProperty& operator= (OptionalProperty&& other) noexcept
    {
        std::swap (this->_data, other._data);
        return *this;
    }

    inline bool operator== (const T* value) const noexcept
    {
        if (this->_data == value)
            return true;

        if ((this->_data == nullptr) || (value == nullptr))
            return false;

        const auto dataSize { getAllocSize (this->_data) };
        if (dataSize != getAllocSize (value))
            return false;

        return (0 == std::memcmp (this->_data, value, dataSize));
    }

    inline bool operator!= (const T* value) const noexcept { return !(*this == value); }

    inline bool operator== (const OptionalProperty& other) const noexcept { return (*this == other._data); }

    inline bool operator!= (const OptionalProperty& other) const noexcept { return !(*this == other._data); }

private:
    template<typename Q = T*, typename std::enable_if<!std::is_same<Q, ARAUtf8String>::value, bool>::type = true>
    static constexpr inline size_t getAllocSize (const T* /*value*/) noexcept { return sizeof (T); }
    template<typename Q = T*, typename std::enable_if<std::is_same<Q, ARAUtf8String>::value, bool>::type = true>
    static inline size_t getAllocSize (const ARAUtf8String value) noexcept { return std::strlen (value) + 1; }

private:
    const T* _data { nullptr };
};


/*******************************************************************************/
// Implementation helper for concurrent audio source analysis progress tracking - do not use directly.
class AnalysisProgressTracker
{
public:
    float getProgress () const noexcept { return decodeProgress (_encodedProgress.load (std::memory_order_relaxed)); }
    bool isProgressing () const noexcept { return decodeIsProgressing (_encodedProgress.load (std::memory_order_relaxed)); }

    bool updateProgress (ARAAnalysisProgressState state, float progress) noexcept;
    void notifyProgress (HostModelUpdateController* controller, ARAAudioSourceHostRef audioSourceHostRef) noexcept;

private:
    static float decodeProgress (float encodedProgress) noexcept;
    static bool decodeIsProgressing (float encodedProgress) noexcept;

    std::atomic<float> _encodedProgress { 0.0f };
    // this stores both the progress value and the update state by adding an offset to the actual value:
    // -2..-1 -> last progress start and updates have been sent to host, but no completion
    // 0 -> completion has been sent, idle state
    // 1 -> completed progress must be sent to host
    // 2..3 -> updated progress must be sent to host
    // 4..5 -> started progress must be sent to host
    // 6..7 -> started progress must be sent to host, and completion event for previous progress is pending too
};

//! @} ARA_Library_ARAPlug_Utility_Classes


//! @addtogroup ARA_Library_ARAPlug_Model_Objects
//! @{

/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Document.
class Document
{
public:
    virtual ~Document () noexcept = default;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreateDocument () -
    //! provide a matching c'tor if subclassing Document.
    explicit Document (DocumentController* documentController) noexcept
    : _documentController { documentController } {}
//@}


//! @name Document Properties
//! Copy of the current ARADocumentProperties set by the host.
//@{
    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; } //!< See ARADocumentProperties::name.
//@}

//! @name Document Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_documentController); }

    //! Retrieve the current list of associated AudioSource instances.
    template <typename AudioSource_t = AudioSource>
    std::vector<AudioSource_t*> const& getAudioSources () const noexcept { return vector_cast<AudioSource_t*> (this->_audioSources); }

    //! Retrieve the current list of associated MusicalContext instances, sorted by ARAMusicalContextProperties::orderIndex.
    template <typename MusicalContext_t = MusicalContext>
    std::vector<MusicalContext_t*> const& getMusicalContexts () const noexcept { return vector_cast<MusicalContext_t*> (this->_musicalContexts); }

    //! Retrieve the current list of associated RegionSequence instances, sorted by ARARegionSequenceProperties::orderIndex.
    template <typename RegionSequence_t = RegionSequence>
    std::vector<RegionSequence_t*> const& getRegionSequences () const noexcept { return vector_cast<RegionSequence_t*> (this->_regionSequences); }
//@}

private:
    DocumentController* const _documentController;
    OptionalProperty<ARAUtf8String> _name;
    std::vector<AudioSource*> _audioSources;
    std::vector<MusicalContext*> _musicalContexts;
    std::vector<RegionSequence*> _regionSequences;

    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARADocumentProperties> properties) noexcept;

    friend class AudioSource;
    void addAudioSource (AudioSource* audioSource) noexcept { _audioSources.push_back (audioSource); }
    void removeAudioSource (AudioSource* audioSource) noexcept { find_erase (_audioSources, audioSource); }

    friend class MusicalContext;
    void sortMusicalContextsByOrderIndex ();
    void addMusicalContext (MusicalContext* musicalContext) noexcept { _musicalContexts.push_back (musicalContext); }
    void removeMusicalContext (MusicalContext* musicalContext) noexcept { find_erase (_musicalContexts, musicalContext); }

    friend class RegionSequence;
    void sortRegionSequencesByOrderIndex ();
    void addRegionSequence (RegionSequence* regionSequence) noexcept { _regionSequences.push_back (regionSequence); }
    void removeRegionSequence (RegionSequence* regionSequence) noexcept { find_erase (_regionSequences, regionSequence); }

    ARA_HOST_MANAGED_OBJECT (Document)
};


/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Musical_Context.
class MusicalContext
{
public:
    virtual ~MusicalContext () noexcept;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreateMusicalContext () -
    //! provide a matching c'tor if subclassing MusicalContext.
    explicit MusicalContext (Document* document, ARAMusicalContextHostRef hostRef) noexcept;
//@}

//! @name Musical Context Properties
//! Copy of the current ARAMusicalContextProperties set by the host.
//@{
    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; } //!< See ARAMusicalContextProperties::name.
    ARAInt32 getOrderIndex () const noexcept { return _orderIndex; }                   //!< See ARAMusicalContextProperties::orderIndex.
    const OptionalProperty<ARAColor*>& getColor () const noexcept { return _color; }   //!< See ARAMusicalContextProperties::color.

    //! Convenience function: if host did not provide name, this returns the document name -
    //! note that the fallback may still return nullptr!
    const OptionalProperty<ARAUtf8String>& getEffectiveName () const noexcept;
//@}

//! @name Musical Context Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the opaque host token for this object.
    ARAMusicalContextHostRef getHostRef () const noexcept { return _hostRef; }

    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_document->getDocumentController ()); }

    //! Retrieve the Document instance containing this object.
    template <typename Document_t = Document>
    Document_t* getDocument () const noexcept { return static_cast<Document_t*> (this->_document); }

    //! Retrieve the current list of associated RegionSequence instances, sorted by ARARegionSequenceProperties::orderIndex.
    template <typename RegionSequence_t = RegionSequence>
    std::vector<RegionSequence_t*> const& getRegionSequences () const noexcept { return vector_cast<RegionSequence_t*> (this->_regionSequences); }
//@}

private:
    Document* const _document;
    ARAMusicalContextHostRef const _hostRef;
    OptionalProperty<ARAUtf8String> _name;
    ARAInt32 _orderIndex { 0 };
    OptionalProperty<ARAColor*> _color;
    std::vector<RegionSequence*> _regionSequences;

private:
    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARAMusicalContextProperties> properties) noexcept;
    void sortRegionSequencesByOrderIndex () noexcept;

    friend class RegionSequence;
    void addRegionSequence (RegionSequence* sequence) noexcept { _regionSequences.push_back (sequence); }
    void removeRegionSequence (RegionSequence* sequence) noexcept { find_erase (_regionSequences, sequence); }

    ARA_HOST_MANAGED_OBJECT (MusicalContext)
};
ARA_MAP_REF (MusicalContext, ARAMusicalContextRef)


/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Region_Sequences.
class RegionSequence
{
public:
    virtual ~RegionSequence () noexcept;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreateRegionSequence () -
    //! provide a matching c'tor if subclassing RegionSequence.
    explicit RegionSequence (Document* document, ARARegionSequenceHostRef hostRef) noexcept;
//@}

//! @name Region Sequence Properties
//! Copy of the current ARARegionSequenceProperties set by the host.
//@{
    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; } //!< See ARARegionSequenceProperties::name.
    ARAInt32 getOrderIndex () const noexcept { return _orderIndex; }                   //!< See ARARegionSequenceProperties::orderIndex.
    const OptionalProperty<ARAColor*>& getColor () const noexcept { return _color; }   //!< See ARARegionSequenceProperties::color.
//@}

//! @name Region Sequence Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the opaque host token for this object.
    ARARegionSequenceHostRef getHostRef () const noexcept { return _hostRef; }

    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_document->getDocumentController ()); }

    //! Retrieve the Document instance containing this object.
    template <typename Document_t = Document>
    Document_t* getDocument () const noexcept { return static_cast<Document_t*> (this->_document); }

    //! Retrieve the current underlying MusicalContext instance.
    template <typename MusicalContext_t = MusicalContext>
    MusicalContext_t* getMusicalContext () const noexcept { return static_cast<MusicalContext_t*> (this->_musicalContext); }

    //! Retrieve the current list of associated PlaybackRegion instances.
    template <typename PlaybackRegion_t = PlaybackRegion>
    std::vector<PlaybackRegion_t*> const& getPlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (this->_playbackRegions); }
//@}

private:
    void setMusicalContext (MusicalContext* musicalContext) noexcept;

    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARARegionSequenceProperties> properties) noexcept;

    friend class PlaybackRegion;
    void addPlaybackRegion (PlaybackRegion* region) noexcept { _playbackRegions.push_back (region); }
    void removePlaybackRegion (PlaybackRegion* region) noexcept { find_erase (_playbackRegions, region); }

private:
    Document* const _document;
    ARARegionSequenceHostRef const _hostRef;
    MusicalContext* _musicalContext { nullptr };
    OptionalProperty<ARAUtf8String> _name;
    ARAInt32 _orderIndex { 0 };
    OptionalProperty<ARAColor*> _color;
    std::vector<PlaybackRegion*> _playbackRegions;

    ARA_HOST_MANAGED_OBJECT (RegionSequence)
};
ARA_MAP_REF (RegionSequence, ARARegionSequenceRef)


/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Audio_Source.
class AudioSource
{
public:
    virtual ~AudioSource () noexcept;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreateAudioSource () -
    //! provide a matching c'tor if subclassing AudioSource.
    explicit AudioSource (Document* document, ARAAudioSourceHostRef hostRef) noexcept;
//@}

//! @name Audio Source Properties
//! Copy of the current ARAAudioSourceProperties set by the host.
//@{
    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; }         //!< See ARAAudioSourceProperties::name.
    const std::string& getPersistentID () const noexcept { return _persistentID; }             //!< See ARAAudioSourceProperties::persistentID.

    ARASampleRate getSampleRate () const noexcept { return _sampleRate; }                      //!< See ARAAudioSourceProperties::sampleRate.
    ARASampleCount getSampleCount () const noexcept { return _sampleCount; }                   //!< See ARAAudioSourceProperties::sampleCount.
    ARATimeDuration getDuration () const noexcept { return timeAtSamplePosition (_sampleCount, _sampleRate); }  //!< The duration of the audio source in seconds; sampleRate / sampleCount.
    ARAChannelCount getChannelCount () const noexcept { return _channelCount; }                //!< See ARAAudioSourceProperties::channelCount.
    bool merits64BitSamples () const noexcept { return _merits64BitSamples; }                  //!< See ARAAudioSourceProperties::merits64BitSamples.
//@}

//! @name Host-controlled Audio Source State
//@{
    bool isSampleAccessEnabled () const noexcept { return _sampleAccessEnabled; }              //!< See DocumentController::enableAudioSourceSamplesAccess.
    bool isDeactivatedForUndoHistory () const noexcept { return _deactivatedForUndoHistory; }  //!< See DocumentController::deactivateAudioSourceForUndoHistory.

protected:
    //! Since the channel arrangement is expressed in terms of the Companion API and not
    //! in some native ARA format, translating it into the plug-in's internal representation
    //! is delegated by the library via this call for clients to override as necessary.
    virtual void doUpdateChannelArrangement (const ChannelArrangement& channelArrangement) noexcept {}

public:
//@}

//! @name Audio Source Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the opaque host token for this object.
    ARAAudioSourceHostRef getHostRef () const noexcept { return _hostRef; }

    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_document->getDocumentController ()); }

    //! Retrieve the Document instance containing this object.
    template <typename Document_t = Document>
    Document_t* getDocument () const noexcept { return static_cast<Document_t*> (this->_document); }

    //! Retrieve the current list of associated AudioModification instances.
    template <typename AudioModification_t = AudioModification>
    std::vector<AudioModification_t*> const& getAudioModifications () const noexcept { return vector_cast<AudioModification_t*> (this->_modifications); }
//@}

private:
    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARAAudioSourceProperties> properties) noexcept;
    void setSampleAccessEnabled (bool enable) noexcept { _sampleAccessEnabled = enable; }
    void setDeactivatedForUndoHistory (bool deactivate) noexcept { _deactivatedForUndoHistory = deactivate; }
    AnalysisProgressTracker& getAnalysisProgressTracker () noexcept { return _analysisProgressTracker; }

    friend class AudioModification;
    void addAudioModification (AudioModification* modification) noexcept { _modifications.push_back (modification); }
    void removeAudioModification (AudioModification* modification) noexcept { find_erase (_modifications, modification); }

private:
    Document* const _document;
    ARAAudioSourceHostRef const _hostRef;
    OptionalProperty<ARAUtf8String> _name;
    std::string _persistentID;
    ARASampleCount _sampleCount { 0 };
    ARASampleRate _sampleRate { 44.100 };
    ARAChannelCount _channelCount { 1 };
    bool _merits64BitSamples { false };
    bool _sampleAccessEnabled { false };
    bool _deactivatedForUndoHistory { false };
    std::vector<AudioModification*> _modifications;
    AnalysisProgressTracker _analysisProgressTracker;

    ARA_HOST_MANAGED_OBJECT (AudioSource)
};
ARA_MAP_REF (AudioSource, ARAAudioSourceRef)


/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Audio_Modification.
class AudioModification
{
public:
    virtual ~AudioModification () noexcept;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreateAudioModification () -
    //! provide a matching c'tor if subclassing AudioModification.
    //! \p optionalModificationToClone will be nullptr when creating new modifications with
    //! default state from scratch, or will point to a modification (referencing the same
    //! \p audioSource) from which the internal state should be cloned into the new modification.
    explicit AudioModification (AudioSource* audioSource, ARAAudioModificationHostRef hostRef, const AudioModification* optionalModificationToClone) noexcept;
//@}

//! @name Audio Modification Properties
//! Copy of the current ARAAudioModificationProperties set by the host.
//@{
    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; }         //!< See ARAAudioModificationProperties::name.
    const std::string& getPersistentID () const noexcept { return _persistentID; }             //!< See ARAAudioModificationProperties::persistentID.

    //! Convenience function: if host did not provide name, this returns the audio source name -
    //! note that the fallback may still return nullptr!
    const OptionalProperty<ARAUtf8String>& getEffectiveName () const noexcept;
//@}

//! @name Host-controlled Audio Modification State
//@{
    bool isDeactivatedForUndoHistory () const noexcept { return _deactivatedForUndoHistory; }  //!< See DocumentController::deactivateAudioModificationForUndoHistory.
//@}

//! @name Audio Modification Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the opaque host token for this object.
    ARAAudioModificationHostRef getHostRef () const noexcept { return _hostRef; }

    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_audioSource->getDocumentController ()); }

    //! Retrieve the AudioSource instance containing this object.
    template <typename AudioSource_t = AudioSource>
    AudioSource_t* getAudioSource () const noexcept { return static_cast<AudioSource_t*> (this->_audioSource); }

    //! Retrieve the current list of associated PlaybackRegion instances.
    template <typename PlaybackRegion_t = PlaybackRegion>
    std::vector<PlaybackRegion_t*> const& getPlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (this->_playbackRegions); }
//@}

private:
    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARAAudioModificationProperties> properties) noexcept;
    void setDeactivatedForUndoHistory (bool deactivate) noexcept { _deactivatedForUndoHistory = deactivate; }

    friend class PlaybackRegion;
    void addPlaybackRegion (PlaybackRegion* region) noexcept { _playbackRegions.push_back (region); }
    void removePlaybackRegion (PlaybackRegion* region) noexcept { find_erase (_playbackRegions, region); }

private:
    AudioSource* const _audioSource;
    ARAAudioModificationHostRef const _hostRef;
    OptionalProperty<ARAUtf8String> _name;
    std::string _persistentID;
    bool _deactivatedForUndoHistory { false };
    std::vector<PlaybackRegion*> _playbackRegions;

    ARA_HOST_MANAGED_OBJECT (AudioModification)
};
ARA_MAP_REF (AudioModification, ARAAudioModificationRef)


/*******************************************************************************/
//! Extensible model object class representing an ARA \ref Model_Playback_Region.
class PlaybackRegion
{
public:
    virtual ~PlaybackRegion () noexcept;

//! @name Construction
//@{
    //! Called implicitly through DocumentController::doCreatePlaybackRegion () -
    //! provide a matching c'tor if subclassing PlaybackRegion.
    explicit PlaybackRegion (AudioModification* audioModification, ARAPlaybackRegionHostRef hostRef) noexcept;
//@}

//! @name Playback Region Properties
//! Copy of the current ARAPlaybackRegionProperties set by the host.
//@{
    ARATimePosition getStartInAudioModificationTime () const noexcept { return _startInAudioModificationTime; }       //!< See ARAPlaybackRegionProperties::startInModificationTime
    ARATimeDuration getDurationInAudioModificationTime () const noexcept { return _durationInAudioModificationTime; } //!< See ARAPlaybackRegionProperties::durationInModificationTime
    ARATimePosition getEndInAudioModificationTime () const noexcept
    { return _startInAudioModificationTime + _durationInAudioModificationTime; }                                      //!< The end of the region in modification time; `startInModificationTime + durationInModificationTime`.
    bool intersectsWithAudioModificationTimeRange (ARAContentTimeRange range) const noexcept;                         //!< Returns true if \p range intersects the region in modification time.

    ARASamplePosition getStartInAudioModificationSamples () const noexcept;                                           //!< Modification start time in samples, derived using underlying AudioSource sample rate.
    ARASamplePosition getEndInAudioModificationSamples () const noexcept;                                             //!< Modification end time in samples, derived using underlying AudioSource sample rate.
    ARASampleCount getDurationInAudioModificationSamples () const noexcept;                                           //!< Modification duration in samples, derived using underlying AudioSource sample rate.

    ARATimePosition getStartInPlaybackTime () const noexcept { return _startInPlaybackTime; }                         //!< See ARAPlaybackRegionProperties::startInPlaybackTime
    ARATimeDuration getDurationInPlaybackTime () const noexcept { return _durationInPlaybackTime; }                   //!< See ARAPlaybackRegionProperties::durationInPlaybackTime
    ARATimePosition getEndInPlaybackTime () const noexcept { return _startInPlaybackTime + _durationInPlaybackTime; } //!< The end of the region in playback time; `startInPlaybackTime + durationInPlaybackTime`.
    bool intersectsWithPlaybackTimeRange (ARAContentTimeRange range) const noexcept;                                  //!< Returns true if \p range intersects the region in playback time.

    ARASamplePosition getStartInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept;                    //!< Playback start time in samples, derived using underlying AudioSource sample rate.
    ARASampleCount getDurationInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept;                    //!< Playback duration in samples, derived using underlying AudioSource sample rate.
    ARASamplePosition getEndInPlaybackSamples (ARASampleRate playbackSampleRate) const noexcept;                      //!< Playback end time in samples, derived using underlying AudioSource sample rate.

    bool isTimestretchEnabled () const noexcept { return _timestretchEnabled; }                                       //!< `ARAPlaybackRegionProperties::transformationFlags & ::kARAPlaybackTransformationTimestretch`.
    bool isTimeStretchReflectingTempo () const noexcept { return _timestretchReflectingTempo; }                       //!< `ARAPlaybackRegionProperties::transformationFlags & ::kARAPlaybackTransformationTimestretchReflectingTempo`.

    bool hasContentBasedFadeAtHead () const noexcept { return _contentBasedFadeAtHead; }                              //!< `ARAPlaybackRegionProperties::transformationFlags & ::kARAPlaybackTransformationContentBasedFadeAtHead`.
    bool hasContentBasedFadeAtTail () const noexcept { return _contentBasedFadeAtTail; }                              //!< `ARAPlaybackRegionProperties::transformationFlags & ::kARAPlaybackTransformationContentBasedFadeAtTail`.

    const OptionalProperty<ARAUtf8String>& getName () const noexcept { return _name; }                                //!< See ARAPlaybackRegionProperties::name.
    const OptionalProperty<ARAColor*>& getColor () const noexcept { return _color; }                                  //!< See ARAPlaybackRegionProperties::color.

    //! Convenience function: if host did not provide name, this traverses the graph to find a fallback to show to the user
    //! using either the audio modification or the audio source name -
    //! note that the fallback may still return nullptr!
    const OptionalProperty<ARAUtf8String>& getEffectiveName () const noexcept;

    //! Convenience function: if host did not provide name, this traverses the graph to find a fallback to show to the user
    //! using either the audio modification or the audio source color -
    //! note that the fallback may still return nullptr!
    const OptionalProperty<ARAColor*>& getEffectiveColor () const noexcept;
//@}

//! @name Playback Region Relationships
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the opaque host token for this object.
    ARAPlaybackRegionHostRef getHostRef () const noexcept { return _hostRef; }

    //! Retrieve the DocumentController instance controlling this object.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_audioModification->getAudioSource ()->getDocumentController ()); }

    //! Retrieve the AudioModification instance containing this object.
    template <typename AudioModification_t = AudioModification>
    AudioModification_t* getAudioModification () const noexcept { return static_cast<AudioModification_t*> (this->_audioModification); }

#if ARA_SUPPORT_VERSION_1
    template <typename MusicalContext_t = MusicalContext>
    MusicalContext_t* getMusicalContext () const noexcept { return static_cast<MusicalContext_t*> ((this->_regionSequence) ? this->_regionSequence->getMusicalContext () : this->_musicalContext); }
#endif
    //! Retrieve the current underlying RegionSequence instance.
    template <typename RegionSequence_t = RegionSequence>
    RegionSequence_t* getRegionSequence () const noexcept { return static_cast<RegionSequence_t*> (this->_regionSequence); }
//@}

private:
    void setRegionSequence (RegionSequence* regionSequence) noexcept;

    friend class DocumentController;
    void updateProperties (PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept;

private:
    AudioModification* const _audioModification;
    ARAPlaybackRegionHostRef const _hostRef;
    ARATimePosition _startInAudioModificationTime { 0.0 };
    ARATimeDuration _durationInAudioModificationTime { 0.0 };
    ARATimePosition _startInPlaybackTime { 0.0 };
    ARATimeDuration _durationInPlaybackTime { 0.0 };
    RegionSequence* _regionSequence { nullptr };
#if ARA_SUPPORT_VERSION_1
    MusicalContext* _musicalContext { nullptr };
#endif
    bool _timestretchEnabled { false };
    bool _timestretchReflectingTempo { false };
    bool _contentBasedFadeAtHead { false };
    bool _contentBasedFadeAtTail { false };
    OptionalProperty<ARAUtf8String> _name;
    OptionalProperty<ARAColor*> _color;

    ARA_HOST_MANAGED_OBJECT (PlaybackRegion)
};
ARA_MAP_REF (PlaybackRegion, ARAPlaybackRegionRef)

//! @} ARA_Library_ARAPlug_Model_Objects


//! @addtogroup ARA_Library_ARAPlug_Utility_Classes
//! @{

/*******************************************************************************/
//! Abstract base class for objects that can export plug-in supplied content to the host.
//! If your plug-in can supply ARA content, implementations of this class must be
//! returned that can randomly access and iterate over plug-in content data.
//! Concrete implementations of this class must be returned from
//! DocumentController::doCreateAudioSourceContentReader,
//! DocumentController::doCreateAudioModificationContentReader and
//! DocumentController::doCreatePlaybackRegionContentReader.
class ContentReader
{
protected:
    ContentReader () noexcept = default;

public:
    virtual ~ContentReader () noexcept = default;

    //! Get the count of available content events.
    virtual ARAInt32 getEventCount () noexcept = 0;
    //! Get a pointer to the content for event \p eventIndex.
    virtual const void* getDataForEvent (ARAInt32 eventIndex) noexcept = 0;

    ARA_HOST_MANAGED_OBJECT (ContentReader)
};
ARA_MAP_REF (ContentReader, ARAContentReaderRef)


/*******************************************************************************/
//! Utility class that wraps an ARARestoreObjectsFilter instance.
class RestoreObjectsFilter
{
private:
    struct SortPersistentID
    {
        bool operator() (ARAPersistentID a, ARAPersistentID b) const noexcept
        {
            return std::strcmp (a, b) < 0;
        }
    };

public:
    RestoreObjectsFilter (const ARARestoreObjectsFilter* filter, Document* document) noexcept;

//! @name Filter Queries
//! Use these functions to filter and map the objects restored during DocumentController::doRestoreObjectsFromArchive().
//@{
    bool shouldRestoreDocumentData () const noexcept;

    AudioSource* getAudioSourceToRestoreStateWithID (ARAPersistentID archivedAudioSourceID) const noexcept;
    template <typename AudioSource_t = AudioSource>
    AudioSource_t* getAudioSourceToRestoreStateWithID (ARAPersistentID archivedAudioSourceID) const noexcept { return static_cast<AudioSource_t*> (getAudioSourceToRestoreStateWithID (archivedAudioSourceID)); }

    AudioModification* getAudioModificationToRestoreStateWithID (ARAPersistentID archivedAudioModificationID) const noexcept;
    template <typename AudioModification_t = AudioModification>
    AudioModification_t* getAudioModificationToRestoreStateWithID (ARAPersistentID archivedAudioModificationID) const noexcept { return static_cast<AudioModification_t*> (getAudioModificationToRestoreStateWithID (archivedAudioModificationID)); }
//@}

private:
    const ARARestoreObjectsFilter* _filter;
    std::map<ARAPersistentID, AudioSource*, SortPersistentID> _audioSourcesByID;
    std::map<ARAPersistentID, AudioModification*, SortPersistentID> _audioModificationsByID;
};


/*******************************************************************************/
//! Utility class that wraps an ARAStoreObjectsFilter instance.
class StoreObjectsFilter
{
public:
    explicit StoreObjectsFilter (const ARAStoreObjectsFilter* filter) noexcept;
    explicit StoreObjectsFilter (const Document* document) noexcept;

//! @name Filter Queries
//! Use these functions to filter the objects stored during DocumentController::doStoreObjectsToArchive().
//@{
    bool shouldStoreDocumentData () const noexcept;

    template <typename AudioSource_t = AudioSource>
    std::vector<const AudioSource_t*> const& getAudioSourcesToStore () const noexcept { return vector_cast<const AudioSource_t*> (_audioSourcesToStore); }
    template <typename AudioModification_t = AudioModification>
    std::vector<const AudioModification_t*> const& getAudioModificationsToStore () const noexcept { return vector_cast<const AudioModification_t*> (_audioModificationsToStore); }
//@}

private:
    const ARAStoreObjectsFilter* _filter;
    std::vector<const AudioSource*> _audioSourcesToStore;
    std::vector<const AudioModification*> _audioModificationsToStore;
};

//! @} ARA_Library_ARAPlug_Utility_Classes


//! @addtogroup ARA_Library_ARAPlug_Document_Controller
//! @{

/*******************************************************************************/
//! Customization interface for DocumentController, separated into subclass to enhance clarity.
//! Do not use directly, subclass DocumentController instead.
//! Subclasses of DocumentController should implement these protected `do/will/did` functions as needed.
//! For example, if subclassing AudioSource you should override doCreateAudioSource() and return
//! a newly allocated instance of your custom AudioSource subclass.
//! Functions named do.. are expected to perform the requested operation, whereas functions
//! named will../did.. provide hooks to augment operations already performed by the SDK implementation.
//! For example, if you'd like to know when an audio source's sample access has been enabled, you can
//! override didEnableAudioSourceSamplesAccess(), which will be called directly after the sample
//! access state changes. Accordingly, if you need to take some action before access is disabled,
//! override willEnableAudioSourceSamplesAccess().
//! When overriding any of these functions, you don't need to call the base class implementation
//! from your overrides.
class DocumentControllerDelegate
{
protected:
    //! @name Update Management Hooks
    //@{
    //! Override to customize behavior before a Document edit cycle begins.
    virtual void willBeginEditing () noexcept {}
    //! Override to customize behavior after a Document edit cycle ends.
    virtual void didEndEditing () noexcept {}

    //! Override to customize behavior before sending update notifications to the host.
    virtual void willNotifyModelUpdates () noexcept {}
    //! Override to customize behavior after sending update notifications to the host.
    virtual void didNotifyModelUpdates () noexcept {}
    //@}

    //! @name Archiving Hooks
    //@{
    //! Override to implement restoreObjectsFromArchive().
    virtual bool doRestoreObjectsFromArchive (HostArchiveReader* archiveReader, const RestoreObjectsFilter* filter) noexcept = 0;
    //! Override to implement storeObjectsToArchive().
    virtual bool doStoreObjectsToArchive (HostArchiveWriter* archiveWriter, const StoreObjectsFilter* filter) noexcept = 0;
    //! Override to customize storeAudioSourceToAudioFileChunk() if needed.
    //! The default implementation calls doStoreObjectsToArchive() with an appropriate StoreObjectsFilter
    //! and sets openAutomatically to false - check if your internal data format allows for optimizing
    //! this according to the criteria documented for storeAudioSourceToAudioFileChunk().
    virtual bool doStoreAudioSourceToAudioFileChunk (HostArchiveWriter* archiveWriter, AudioSource* audioSource, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept;
    //@}

    //! @name Document Management Hooks
    //@{
    //! Override to return a custom subclass instance of Document when initializing the DocumentController.
    virtual Document* doCreateDocument () noexcept = 0;
    //! Override if not using plain new in doCreateDocument () or relying on reference counting for your subclass.
    virtual void doDestroyDocument (Document* document) noexcept = 0;
    //! Override to customize pre-update behavior of updateDocumentProperties().
    virtual void willUpdateDocumentProperties (Document* document, PropertiesPtr<ARADocumentProperties> newProperties) noexcept {}
    //! Override to customize post-update behavior of updateDocumentProperties().
    virtual void didUpdateDocumentProperties (Document* document) noexcept {}
    //! Override to customize behavior after createMusicalContext() adds \p musicalContext to \p document.
    virtual void didAddMusicalContextToDocument (Document* document, MusicalContext* musicalContext) noexcept {}
    //! Override to customize behavior before destroyMusicalContext() removes \p musicalContext from \p document.
    virtual void willRemoveMusicalContextFromDocument (Document* document, MusicalContext* musicalContext) noexcept {}
    //! Override to customize behavior before sorting all MusicalContext instances in \p document by ARAMusicalContextProperties::orderIndex.
    virtual void willReorderMusicalContextsInDocument (Document* document) noexcept {}
    //! Override to customize behavior after sorting all MusicalContext instances in \p document by ARAMusicalContextProperties::orderIndex.
    virtual void didReorderMusicalContextsInDocument (Document* document) noexcept {}
    //! Override to customize behavior after createRegionSequence() adds \p regionSequence to \p document.
    virtual void didAddRegionSequenceToDocument (Document* document, RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior before destroyRegionSequence() removes \p regionSequence from \p document.
    virtual void willRemoveRegionSequenceFromDocument (Document* document, RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior before sorting all RegionSequence instances in \p document by ARARegionSequenceProperties::orderIndex.
    virtual void willReorderRegionSequencesInDocument (Document* document) noexcept {}
    //! Override to customize behavior after sorting all RegionSequence instances in \p document by ARARegionSequenceProperties::orderIndex.
    virtual void didReorderRegionSequencesInDocument (Document* document) noexcept {}
    //! Override to customize behavior after createAudioSource() adds \p audioSource to \p document.
    virtual void didAddAudioSourceToDocument (Document* document, AudioSource* audioSource) noexcept {}
    //! Override to customize behavior before destroyAudioSource() removes \p audioSource from \p document.
    virtual void willRemoveAudioSourceFromDocument (Document* document, AudioSource* audioSource) noexcept {}
    //! Override to customize behavior before \p document is destroyed during destroyDocumentController().
    virtual void willDestroyDocument (Document* document) noexcept {}
    //@}

    //! @name Musical Context Management Hooks
    //@{
    //! Override to return a custom subclass instance of MusicalContext from createMusicalContext().
    virtual MusicalContext* doCreateMusicalContext (Document* document, ARAMusicalContextHostRef hostRef) noexcept = 0;
    //! Override if not using plain new in doCreateMusicalContext () or relying on reference counting for your subclass.
    virtual void doDestroyMusicalContext (MusicalContext* musicalContext) noexcept = 0;
    //! Override to customize pre-update behavior of updateMusicalContextProperties().
    virtual void willUpdateMusicalContextProperties (MusicalContext* musicalContext, PropertiesPtr<ARAMusicalContextProperties> newProperties) noexcept {}
    //! Override to customize post-update behavior of updateMusicalContextProperties().
    virtual void didUpdateMusicalContextProperties (MusicalContext* musicalContext) noexcept {}
    //! Override to implement updateMusicalContextContent().
    virtual void doUpdateMusicalContextContent (MusicalContext* musicalContext, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! Override to customize behavior after createRegionSequence() or updateRegionSequenceProperties() adds \p regionSequence to \p musicalContext.
    virtual void didAddRegionSequenceToMusicalContext (MusicalContext* musicalContext, RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior before destroyRegionSequence() or updateRegionSequenceProperties() removes \p regionSequence to \p musicalContext.
    virtual void willRemoveRegionSequenceFromMusicalContext (MusicalContext* musicalContext, RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior before sorting all RegionSequence instances in \p musicalContext by ARARegionSequenceProperties::orderIndex.
    virtual void willReorderRegionSequencesInMusicalContext (MusicalContext* musicalContext) noexcept {}
    //! Override to customize behavior after sorting all RegionSequence instances in \p musicalContext by ARARegionSequenceProperties::orderIndex.
    virtual void didReorderRegionSequencesInMusicalContext (MusicalContext* musicalContext) noexcept {}
    //! Override to customize behavior before \p musicalContext is destroyed during destroyMusicalContext().
    virtual void willDestroyMusicalContext (MusicalContext* musicalContext) noexcept {}
    //@}

    //! @name Region Sequence Management Hooks
    //@{
    //! Override to return a custom subclass instance of RegionSequence from createRegionSequence().
    virtual RegionSequence* doCreateRegionSequence (Document* document, ARARegionSequenceHostRef hostRef) noexcept = 0;
    //! Override if not using plain new in doCreateRegionSequence () or relying on reference counting for your subclass.
    virtual void doDestroyRegionSequence (RegionSequence* regionSequence) noexcept = 0;
    //! Override to customize pre-update behavior of updateRegionSequenceProperties().
    virtual void willUpdateRegionSequenceProperties (RegionSequence* regionSequence, PropertiesPtr<ARARegionSequenceProperties> newProperties) noexcept {}
    //! Override to customize pre-update behavior of updateRegionSequenceProperties().
    virtual void didUpdateRegionSequenceProperties (RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior after createPlaybackRegion() or updatePlaybackRegionProperties() adds \p playbackRegion to \p regionSequence.
    virtual void didAddPlaybackRegionToRegionSequence (RegionSequence* regionSequence, PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before destroyPlaybackRegion() or updatePlaybackRegionProperties() removes \p playbackRegion from \p regionSequence.
    virtual void willRemovePlaybackRegionFromRegionSequence (RegionSequence* regionSequence, PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before \p regionSequence is destroyed during destroyRegionSequence().
    virtual void willDestroyRegionSequence (RegionSequence* regionSequence) noexcept {}
    //@}

    //! @name Audio Source Management Hooks
    //@{
    //! Override to return a custom subclass instance of AudioSource from createAudioSource().
    virtual AudioSource* doCreateAudioSource (Document* document, ARAAudioSourceHostRef hostRef) noexcept = 0;
    //! Override if not using plain new in doCreateAudioSource () or relying on reference counting for your subclass.
    virtual void doDestroyAudioSource (AudioSource* audioSource) noexcept = 0;
    //! Override to customize pre-update behavior of updateAudioSourceProperties().
    virtual void willUpdateAudioSourceProperties (AudioSource* audioSource, PropertiesPtr<ARAAudioSourceProperties> newProperties) noexcept {}
    //! Override to customize pre-update behavior of updateAudioSourceProperties().
    virtual void didUpdateAudioSourceProperties (AudioSource* audioSource) noexcept {}
    //! Override to implement updateAudioSourceContent().
    virtual void doUpdateAudioSourceContent (AudioSource* audioSource, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! Override to customize behavior before enableAudioSourceSamplesAccess() changes \p audioSource's sample access state.
    virtual void willEnableAudioSourceSamplesAccess (AudioSource* audioSource, bool enable) noexcept = 0;
    //! Override to customize behavior after enableAudioSourceSamplesAccess() changes \p audioSource's sample access state.
    virtual void didEnableAudioSourceSamplesAccess (AudioSource* audioSource, bool enable) noexcept = 0;
    //! Override to customize behavior before deactivateAudioSourceForUndoHistory() changes \p audioSource's activated state.
    virtual void willDeactivateAudioSourceForUndoHistory (AudioSource* audioSource, bool deactivate) noexcept {}
    //! Override to customize behavior after deactivateAudioSourceForUndoHistory() changes \p audioSource's activated state.
    virtual void didDeactivateAudioSourceForUndoHistory (AudioSource* audioSource, bool deactivate) noexcept {}
    //! Override to customize behavior after createAudioModification() or updateAudioModificationProperties() adds \p audioModification to \p audioSource.
    virtual void didAddAudioModificationToAudioSource (AudioSource* audioSource, AudioModification* audioModification) noexcept {}
    //! Override to customize behavior before destroyAudioModification() or updateAudioModificationProperties() removes \p audioModification from \p audioSource.
    virtual void willRemoveAudioModificationFromAudioSource (AudioSource* audioSource, AudioModification* audioModification) noexcept {}
    //! Override to customize behavior before \p audioSource is destroyed during destroyAudioSource().
    virtual void willDestroyAudioSource (AudioSource* audioSource) noexcept {}
    //@}

    //! @name Audio Modification Management Hooks
    //@{
    //! Override to return a custom subclass instance of AudioModification from createAudioModification() or cloneAudioModification().
    //! optionalModificationToClone will be nullptr when creating new modifications with default state from scratch,
    //! or will point to a modification from which the internal state should be cloned into the new modification.
    virtual AudioModification* doCreateAudioModification (AudioSource* audioSource, ARAAudioModificationHostRef hostRef, const AudioModification* optionalModificationToClone) noexcept = 0;
    //! Override if not using plain new in doCreateAudioModification () or relying on reference counting for your subclass.
    virtual void doDestroyAudioModification (AudioModification* audioModification) noexcept = 0;
    //! Override to customize pre-update behavior of updateAudioModificationProperties().
    virtual void willUpdateAudioModificationProperties (AudioModification* audioModification, PropertiesPtr<ARAAudioModificationProperties> newProperties) noexcept {}
    //! Override to customize post-update behavior of updateAudioModificationProperties().
    virtual void didUpdateAudioModificationProperties (AudioModification* audioModification) noexcept {}
    //! Override to implement isAudioModificationPreservingAudioSourceSignal().
    virtual bool doIsAudioModificationPreservingAudioSourceSignal (AudioModification* audioModification) noexcept { return false; }
    //! Override to customize behavior before deactivateAudioModificationForUndoHistory() changes \p audioModification's activated state.
    virtual void willDeactivateAudioModificationForUndoHistory (AudioModification* audioModification, bool deactivate) noexcept {}
    //! Override to customize behavior after deactivateAudioModificationForUndoHistory() changes \p audioModification's activated state.
    virtual void didDeactivateAudioModificationForUndoHistory (AudioModification* audioModification, bool deactivate) noexcept {}
    //! Override to customize behavior after createPlaybackRegion() adds \p playbackRegion to \p audioModification.
    virtual void didAddPlaybackRegionToAudioModification (AudioModification* audioModification, PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before destroyPlaybackRegion() removes \p playbackRegion from \p audioModification.
    virtual void willRemovePlaybackRegionFromAudioModification (AudioModification* audioModification, PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before \p audioModification is destroyed during destroyAudioModification().
    virtual void willDestroyAudioModification (AudioModification* audioModification) noexcept {}
    //@}

    //! @name Playback Region Management Hooks
    //@{
    //! Override to return a custom subclass instance of PlaybackRegion.
    virtual PlaybackRegion* doCreatePlaybackRegion (AudioModification* modification, ARAPlaybackRegionHostRef hostRef) noexcept = 0;
    //! Override if not using plain new in doCreatePlaybackRegion () or relying on reference counting for your subclass.
    virtual void doDestroyPlaybackRegion (PlaybackRegion* playbackRegion) noexcept = 0;
    //! Override to customize pre-update behavior of updatePlaybackRegionProperties().
    virtual void willUpdatePlaybackRegionProperties (PlaybackRegion* playbackRegion, PropertiesPtr<ARAPlaybackRegionProperties> newProperties) noexcept {}
    //! Override to customize post-update behavior of updatePlaybackRegionProperties().
    virtual void didUpdatePlaybackRegionProperties (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to define a content based fade for \p playbackRegion by assigning positive values to \p headTime and/or \p tailTime - see getPlaybackRegionHeadAndTailTime().
    virtual void doGetPlaybackRegionHeadAndTailTime (const PlaybackRegion* playbackRegion, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept { *headTime = 0.0; *tailTime = 0.0; }
    //! Override to customize behavior before \p playbackRegion is destroyed during destroyPlaybackRegion().
    virtual void willDestroyPlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //@}

    //! @name Content Reader Management Hooks
    //@{
    //! Override to implement isAudioSourceContentAvailable() for all your supported content types -
    //! the default implementation always returns false, preventing any calls to doGetAudioSourceContentGrade()
    //! and doCreateAudioSourceContentReader().
    virtual bool doIsAudioSourceContentAvailable (const AudioSource* audioSource, ARAContentType type) noexcept;
    //! Override to implement getAudioSourceContentGrade() for all your supported content types.
    virtual ARAContentGrade doGetAudioSourceContentGrade (const AudioSource* audioSource, ARAContentType type) noexcept;
    //! Override to implement createAudioSourceContentReader() for all your supported content types,
    //! returning a custom subclass instance of ContentReader providing data of the requested \p type.
    virtual ContentReader* doCreateAudioSourceContentReader (AudioSource* audioSource, ARAContentType type, const ARAContentTimeRange* range) noexcept;

    //! Override to implement isAudioModificationContentAvailable() for all your supported content types -
    //! the default implementation always returns false.
    //! For read-only data directly inherited from the underlying audio source you can just delegate the
    //! call to the audio source, but user-editable modification data must be specifically handled here.
    virtual bool doIsAudioModificationContentAvailable (const AudioModification* audioModification, ARAContentType type) noexcept;
    //! Override to implement getAudioModificationContentGrade() for all your supported content types.
    //! For read-only data directly inherited from the underlying audio source you can just delegate the
    //! call to the audio source, but user-editable modification data must be specifically handled here.
    virtual ARAContentGrade doGetAudioModificationContentGrade (const AudioModification* audioModification, ARAContentType type) noexcept;
    //! Override to implement createAudioModificationContentReader() for all your supported content types,
    //! returning a custom subclass instance of ContentReader providing data of the requested \p type.
    //! For read-only data directly inherited from the underlying audio source you can just delegate the
    //! call to the audio source, but user-editable modification data must be specifically handled here.
    virtual ContentReader* doCreateAudioModificationContentReader (AudioModification* audioModification, ARAContentType type, const ARAContentTimeRange* range) noexcept;

    //! Override to implement isPlaybackRegionContentAvailable() for all your supported content types -
    //! the default implementation always returns false.
    //! Typically, this call can directly delegate to the underlying audio modification, since most
    //! plug-ins will apply their modification data to the playback region with a transformation that
    //! does not affect content availability.
    virtual bool doIsPlaybackRegionContentAvailable (const PlaybackRegion* playbackRegion, ARAContentType type) noexcept;
    //! Override to implement getPlaybackRegionContentGrade() for all your supported content types.
    //! Typically, this call can directly delegate to the underlying audio modification, since most
    //! plug-ins will apply their modification data to the playback region with a transformation that
    //! does not affect content grade.
    virtual ARAContentGrade doGetPlaybackRegionContentGrade (const PlaybackRegion* playbackRegion, ARAContentType type) noexcept;
    //! Override to implement createPlaybackRegionContentReader() for all your supported content types,
    //! returning a custom subclass instance of ContentReader providing data of the requested \p type.
    virtual ContentReader* doCreatePlaybackRegionContentReader (PlaybackRegion* playbackRegion, ARAContentType type, const ARAContentTimeRange* range) noexcept;

    //! Override if not using plain new in doCreateAudioSourceContentReader (), doCreateAudioModificationContentReader ()
    //! or doCreatePlaybackRegionContentReader () or relying on reference counting for your subclasses.
    virtual void doDestroyContentReader (ContentReader* contentReader) noexcept { delete contentReader; }
    //@}

    //! @name Controlling Analysis Hooks
    //@{
    //! Override to implement isAudioSourceContentAnalysisIncomplete().
    virtual bool doIsAudioSourceContentAnalysisIncomplete (const AudioSource* audioSource, ARAContentType contentType) noexcept;
    //! Override to implement requestAudioSourceContentAnalysis().
    virtual void doRequestAudioSourceContentAnalysis (AudioSource* audioSource, std::vector<ARAContentType> const& contentTypes) noexcept;

    //! Override to implement getProcessingAlgorithmsCount().
    virtual ARAInt32 doGetProcessingAlgorithmsCount () noexcept { return 0; }
    //! Override to implement getProcessingAlgorithmProperties().
    virtual const ARAProcessingAlgorithmProperties* doGetProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept;
    //! Override to implement getProcessingAlgorithmForAudioSource().
    virtual ARAInt32 doGetProcessingAlgorithmForAudioSource (const AudioSource* audioSource) noexcept;
    //! Override to implement requestProcessingAlgorithmForAudioSource().
    virtual void doRequestProcessingAlgorithmForAudioSource (AudioSource* audioSource, ARAInt32 algorithmIndex) noexcept;
    //@}

    //! @name License Management Hooks
    //@{
    //! Override to implement analysis request section of isLicensedForCapabilities().
    bool doIsLicensedForContentAnalysisRequests (std::vector<ARAContentType> const& contentTypes) noexcept { return true; }
    //! Override to implement playback transformation section of isLicensedForCapabilities().
    bool doIsLicensedForPlaybackTransformations (ARAPlaybackTransformationFlags transformationFlags) noexcept { return true; }
    //! Override to implement runModalLicenseActivationForCapabilities().
    void doRunModalLicenseActivationForCapabilities (std::vector<ARAContentType> const& contentTypes, ARAPlaybackTransformationFlags transformationFlags) noexcept;
    //@}

    //! @name Plug-In Instance Management Hooks
    //! These functions are conditionally called from createPlugInExtensionWithRoles(), depending on the roles fulfilled by the plug-in instance.
    //@{
    //! Override to return a custom subclass instance of PlaybackRenderer.
    virtual PlaybackRenderer* doCreatePlaybackRenderer () noexcept = 0;
    //! Override if not using plain new in doCreatePlaybackRenderer () or relying on reference counting for your subclass.
    virtual void doDestroyPlaybackRenderer (PlaybackRenderer* playbackRenderer) noexcept = 0;
    //! Override to return a custom subclass instance of EditorRenderer.
    virtual EditorRenderer* doCreateEditorRenderer () noexcept = 0;
    //! Override if not using plain new in doCreateEditorRenderer () or relying on reference counting for your subclass.
    virtual void doDestroyEditorRenderer (EditorRenderer* editorRenderer) noexcept = 0;
    //! Override to return a custom subclass instance of EditorView.
    virtual EditorView* doCreateEditorView () noexcept = 0;
    //! Override if not using plain new in doCreateEditorView () or relying on reference counting for your subclass.
    virtual void doDestroyEditorView (EditorView* editorView) noexcept = 0;
    //@}

protected:
    DocumentControllerDelegate (const PlugInEntry* entry) noexcept : _entry { entry } {}
    virtual ~DocumentControllerDelegate () { _entry = nullptr; }
    const PlugInEntry* getPlugInEntry () const noexcept { return _entry; }

private:
    const PlugInEntry* _entry;
};


/*******************************************************************************/
//! Customizable default implementation of DocumentControllerInterface.
class DocumentController : public DocumentControllerInterface,
                           protected DocumentControllerDelegate
{
public:
    explicit DocumentController (const PlugInEntry* entry, const ARADocumentControllerHostInstance* instance) noexcept;

protected:
    Document* doCreateDocument () noexcept override { return new Document (this); }
    void doDestroyDocument (Document* document) noexcept override { delete document; }
    MusicalContext* doCreateMusicalContext (Document* document, ARAMusicalContextHostRef hostRef) noexcept override { return new MusicalContext (document, hostRef); }
    void doDestroyMusicalContext (MusicalContext* musicalContext) noexcept override { delete musicalContext; }
    RegionSequence* doCreateRegionSequence (Document* document, ARARegionSequenceHostRef hostRef) noexcept override { return new RegionSequence (document, hostRef); }
    void doDestroyRegionSequence (RegionSequence* regionSequence) noexcept override { delete regionSequence; }
    AudioSource* doCreateAudioSource (Document* document, ARAAudioSourceHostRef hostRef) noexcept override { return new AudioSource (document, hostRef); }
    void doDestroyAudioSource (AudioSource* audioSource) noexcept override { delete audioSource; }
    AudioModification* doCreateAudioModification (AudioSource* audioSource, ARAAudioModificationHostRef hostRef, const AudioModification* optionalModificationToClone) noexcept override { return new AudioModification (audioSource, hostRef, optionalModificationToClone); }
    void doDestroyAudioModification (AudioModification* audioModification) noexcept override { delete audioModification; }
    PlaybackRegion* doCreatePlaybackRegion (AudioModification* modification, ARAPlaybackRegionHostRef hostRef) noexcept override { return new PlaybackRegion (modification, hostRef); }
    void doDestroyPlaybackRegion (PlaybackRegion* playbackRegion) noexcept override { delete playbackRegion; }

    friend class PlugInExtension;
    PlaybackRenderer* doCreatePlaybackRenderer () noexcept override;
    void doDestroyPlaybackRenderer (PlaybackRenderer* playbackRenderer) noexcept override;
    EditorRenderer* doCreateEditorRenderer () noexcept override;
    void doDestroyEditorRenderer (EditorRenderer* editorRenderer) noexcept override;
    EditorView* doCreateEditorView () noexcept override;
    void doDestroyEditorView (EditorView* editorView) noexcept override;

#if !ARA_DOXYGEN_BUILD
public:
    // Inherited public interface used by the C++ dispatcher.
    // These functions will be called from the host via the C++ dispatcher and represent a complete
    // implementation of DocumentControllerInterface.
    // Subclasses typically do not need to override these functions, instead they use the explicit
    // customizations hooks above, prefixed with do, will or did. In the rare case where overriding
    // is necessary, make sure to appropriately call the base class implementation from your override.

    // Destruction
    void destroyDocumentController () noexcept override;

    // Factory
    const ARAFactory* getFactory () const noexcept override;

    // Update Management
    void beginEditing () noexcept override;
    void endEditing () noexcept override;
    void notifyModelUpdates () noexcept override;

    // Archiving
    bool restoreObjectsFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept override;
    bool storeObjectsToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept override;
    bool storeAudioSourceToAudioFileChunk (ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept override;

    // Document Management
    void updateDocumentProperties (PropertiesPtr<ARADocumentProperties> properties) noexcept override;

    // Musical Context Management
    ARAMusicalContextRef createMusicalContext (ARAMusicalContextHostRef hostRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept override;
    void updateMusicalContextProperties (ARAMusicalContextRef musicalContextRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept override;
    void updateMusicalContextContent (ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ContentUpdateScopes flags) noexcept override;
    void destroyMusicalContext (ARAMusicalContextRef musicalContextRef) noexcept override;

    // Region Sequence Management
    ARARegionSequenceRef createRegionSequence (ARARegionSequenceHostRef hostRef, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept override;
    void updateRegionSequenceProperties (ARARegionSequenceRef regionSequence, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept override;
    void destroyRegionSequence (ARARegionSequenceRef regionSequence) noexcept override;

    // Audio Source Management
    ARAAudioSourceRef createAudioSource (ARAAudioSourceHostRef hostRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept override;
    void updateAudioSourceProperties (ARAAudioSourceRef audioSourceRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept override;
    void updateAudioSourceContent (ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ContentUpdateScopes flags) noexcept override;
    void enableAudioSourceSamplesAccess (ARAAudioSourceRef audioSourceRef, bool enable) noexcept override;
    void deactivateAudioSourceForUndoHistory (ARAAudioSourceRef audioSourceRef, bool deactivate) noexcept override;
    void destroyAudioSource (ARAAudioSourceRef audioSourceRef) noexcept override;

    // Audio Modification Management
    ARAAudioModificationRef createAudioModification (ARAAudioSourceRef audioSourceRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept override;
    ARAAudioModificationRef cloneAudioModification (ARAAudioModificationRef audioModificationRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept override;
    void updateAudioModificationProperties (ARAAudioModificationRef audioModificationRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept override;
    bool isAudioModificationPreservingAudioSourceSignal (ARAAudioModificationRef audioModificationRef) noexcept override;
    void deactivateAudioModificationForUndoHistory (ARAAudioModificationRef audioModificationRef, bool deactivate) noexcept override;
    void destroyAudioModification (ARAAudioModificationRef audioModificationRef) noexcept override;

    // Playback Region Management
    ARAPlaybackRegionRef createPlaybackRegion (ARAAudioModificationRef audioModificationRef, ARAPlaybackRegionHostRef hostRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept override;
    void updatePlaybackRegionProperties (ARAPlaybackRegionRef playbackRegionRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept override;
    void getPlaybackRegionHeadAndTailTime (ARAPlaybackRegionRef playbackRegionRef, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept override;
    void destroyPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept override;

    // Content Reader Management
    bool isAudioSourceContentAvailable (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept override;
    ARAContentGrade getAudioSourceContentGrade (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept override;
    ARAContentReaderRef createAudioSourceContentReader (ARAAudioSourceRef audioSourceRef, ARAContentType type, const ARAContentTimeRange* range) noexcept override;

    bool isAudioModificationContentAvailable (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept override;
    ARAContentGrade getAudioModificationContentGrade (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept override;
    ARAContentReaderRef createAudioModificationContentReader (ARAAudioModificationRef audioModificationRef, ARAContentType type, const ARAContentTimeRange* range) noexcept override;

    bool isPlaybackRegionContentAvailable (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept override;
    ARAContentGrade getPlaybackRegionContentGrade (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept override;
    ARAContentReaderRef createPlaybackRegionContentReader (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type, const ARAContentTimeRange* range) noexcept override;

    ARAInt32 getContentReaderEventCount (ARAContentReaderRef contentReaderRef) noexcept override;
    const void* getContentReaderDataForEvent (ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept override;
    void destroyContentReader (ARAContentReaderRef contentReaderRef) noexcept override;

    // Controlling Analysis
    bool isAudioSourceContentAnalysisIncomplete (ARAAudioSourceRef audioSourceRef, ARAContentType contentType) noexcept override;
    void requestAudioSourceContentAnalysis (ARAAudioSourceRef audioSourceRef, ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept override;

    ARAInt32 getProcessingAlgorithmsCount () noexcept override;
    const ARAProcessingAlgorithmProperties* getProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept override;
    ARAInt32 getProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef) noexcept override;
    void requestProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept override;

    // License Management
    bool isLicensedForCapabilities (bool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept override;
#endif

public:
//! @name Global versioning
//@{
    //! Query the API version configured by the host via ARAInterfaceConfiguration::desiredApiGeneration.
    ARAAPIGeneration getUsedApiGeneration () const noexcept;
//@}

//! @name Host Interface Access
//@{
    //! Returns the audio access controller that the host has provided for this document controller.
    HostAudioAccessController* getHostAudioAccessController () noexcept { return &_hostAudioAccessController; }
    //! Returns the archiving controller that the host has provided for this document controller.
    HostArchivingController* getHostArchivingController () noexcept { return &_hostArchivingController; }
    //! Returns the optional content access controller that the host has provided for this document controller.
    HostContentAccessController* getHostContentAccessController () noexcept { return (_hostContentAccessController.isProvided ()) ? &_hostContentAccessController : nullptr; }
    //! Returns the optional model update controller that the host has provided for this document controller.
    HostModelUpdateController* getHostModelUpdateController () noexcept { return (_hostModelUpdateController.isProvided ()) ? &_hostModelUpdateController : nullptr; }
    //! Returns the optional playback controller that the host has provided for this document controller.
    HostPlaybackController* getHostPlaybackController () noexcept { return (_hostPlaybackController.isProvided ()) ? &_hostPlaybackController : nullptr; }
//@}

//! @name Document Access
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the Document controlled by this instance.
    //! Note that during destruction phase, the document controller may have already
    //! deleted its document and associated graph - this call will then return nullptr.
    template <typename Document_t = Document>
    Document_t* getDocument () const noexcept { return static_cast<Document_t*> (this->_document); }

    //! Returns true if called between beginEditing() and endEditing().
    bool isHostEditingDocument () const noexcept { return _isHostEditingDocument; }
//@}

//! @name Bound Plug-In Instance Management
//@{
    //! Retrieve the current list of bound PlaybackRenderer instances.
    template <typename PlaybackRenderer_t = PlaybackRenderer>
    std::vector<PlaybackRenderer_t*> const& getPlaybackRenderers () const noexcept { return vector_cast<PlaybackRenderer_t*> (this->_playbackRenderers); }

    //! Retrieve the current list of bound EditorRenderer instances.
    template <typename EditorRenderer_t = EditorRenderer>
    std::vector<EditorRenderer_t*> const& getEditorRenderers () const noexcept { return vector_cast<EditorRenderer_t*> (this->_editorRenderers); }

    //! Retrieve the current list of bound EditorView instances.
    template <typename EditorView_t = EditorView>
    std::vector<EditorView_t*> const& getEditorViews () const noexcept { return vector_cast<EditorView_t*> (this->_editorViews); }
//@}

//! @name Sending analysis progress to the host
//! Contrary to most DocumentController functions, these calls can be made from any thread.
//! The implementation will internally enqueue the updates in a non-blocking way and later send
//! them to the host from notifyModelUpdates ().
//! Note that calling code must ensure start and completion are always balanced,
//! and must send the updates in ascending order.
//@{
    void notifyAudioSourceAnalysisProgressStarted (AudioSource* audioSource) noexcept;
    void notifyAudioSourceAnalysisProgressUpdated (AudioSource* audioSource, float progress) noexcept;
    void notifyAudioSourceAnalysisProgressCompleted (AudioSource* audioSource) noexcept;
//@}

//! @name Sending content updates to the host
//! The implementation will internally enqueue the updates and later send them to the host
//! from notifyModelUpdates ().
//! Note that while the ARA API allows for specifying affected time ranges for content updates,
//! this feature is not yet supported in our current plug-in implementation (since most hosts
//! do not evaluate this either).
//@{
    void notifyAudioSourceContentChanged (AudioSource* audioSource, ContentUpdateScopes scopeFlags) noexcept;
    void notifyAudioModificationContentChanged (AudioModification* audioModification, ContentUpdateScopes scopeFlags) noexcept;
    void notifyPlaybackRegionContentChanged (PlaybackRegion* playbackRegion, ContentUpdateScopes scopeFlags) noexcept;
//@}

    // Helper for analysis requests.
    bool canContentTypeBeAnalyzed (ARAContentType type) noexcept;

#if ARA_VALIDATE_API_CALLS
    // Object Ref validation helpers.
    static bool hasValidInstancesForPlugInEntry (const PlugInEntry* entry) noexcept;
    static bool isValidDocumentController (const DocumentController* documentController) noexcept;
    bool isValidMusicalContext (const MusicalContext* ptr) const noexcept;
    bool isValidRegionSequence (const RegionSequence* ptr) const noexcept;
    bool isValidAudioSource (const AudioSource* ptr) const noexcept;
    bool isValidAudioModification (const AudioModification* ptr) const noexcept;
    bool isValidPlaybackRegion (const PlaybackRegion* ptr) const noexcept;
    bool isValidContentReader (const ContentReader* ptr) const noexcept;
    bool isValidPlaybackRenderer (const PlaybackRenderer* ptr) const noexcept;
    bool isValidEditorRenderer (const EditorRenderer* ptr) const noexcept;
    bool isValidEditorView (const EditorView* ptr) const noexcept;
#endif

#if !ARA_DOXYGEN_BUILD
private:
    friend class PlugInEntry;

    // Creation Helper
    // Only to be called by the ARAFactory::createDocumentControllerWithDocument () implementations
    // provided via PlugInEntry.
    // Must be called directly after construction of the DocumentController
    // (cannot be called from constructor because it calls virtual functions).
    void initializeDocument (const ARADocumentProperties* properties) noexcept;

    // Creation Helper
    // Only to be called by the ARAFactory::createDocumentControllerWithDocument () implementations
    // provided via PlugInEntry.
    const ARADocumentControllerInstance* getInstance () const noexcept { return &_instance; }
#endif

private:
    void _destroyIfUnreferenced () noexcept;

    void _willChangeMusicalContextOrder () noexcept;
    void _willChangeRegionSequenceOrder (MusicalContext* affectedMusicalContext) noexcept;

    void _validateAudioSourceChannelArrangement (PropertiesPtr<ARAAudioSourceProperties> properties) noexcept;

    std::vector<ARAContentType> const _getValidatedAnalyzableContentTypes (ARASize contentTypesCount, const ARAContentType contentTypes[], bool mayBeEmpty) noexcept;

    friend class PlaybackRenderer;
    void addPlaybackRenderer (PlaybackRenderer* playbackRenderer) noexcept { _playbackRenderers.push_back (playbackRenderer); }
    void removePlaybackRenderer (PlaybackRenderer* playbackRenderer) noexcept { find_erase (_playbackRenderers, playbackRenderer); if (_playbackRenderers.empty ()) _destroyIfUnreferenced (); }

    friend class EditorRenderer;
    void addEditorRenderer (EditorRenderer* editorRenderer) noexcept { _editorRenderers.push_back (editorRenderer); }
    void removeEditorRenderer (EditorRenderer* editorRenderer) noexcept { find_erase (_editorRenderers, editorRenderer); if (_editorRenderers.empty ()) _destroyIfUnreferenced (); }

    friend class EditorView;
    void addEditorView (EditorView* editorView) noexcept { _editorViews.push_back (editorView); }
    void removeEditorView (EditorView* editorView) noexcept { find_erase (_editorViews, editorView); if (_editorViews.empty ()) _destroyIfUnreferenced (); }

private:
    DocumentControllerInstance _instance;

    HostAudioAccessController _hostAudioAccessController;
    HostArchivingController _hostArchivingController;
    HostContentAccessController _hostContentAccessController;
    HostModelUpdateController _hostModelUpdateController;
    HostPlaybackController _hostPlaybackController;

    Document* _document { nullptr };    // will be reset to nullptr when this controller is destroyed by the host
                                        // (it may outlive that call if still referenced from plug-in instances)

    std::map<AudioSource*, ContentUpdateScopes> _audioSourceContentUpdates;
    std::map<AudioModification*, ContentUpdateScopes> _audioModificationContentUpdates;
    std::map<PlaybackRegion*, ContentUpdateScopes> _playbackRegionContentUpdates;
    std::atomic_flag _analysisProgressIsSynced/* { true } C++ standard only allows for default-init to false */;

    bool _isHostEditingDocument { false };

    bool _musicalContextOrderChanged { false };
    bool _regionSequenceOrderChanged { false };
    std::vector<MusicalContext*> _musicalContextsWithChangedRegionSequenceOrder;

#if ARA_VALIDATE_API_CALLS
    std::vector<ContentReader*> _contentReaders;
#endif

    std::vector<PlaybackRenderer*> _playbackRenderers;
    std::vector<EditorRenderer*> _editorRenderers;
    std::vector<EditorView*> _editorViews;

    ARA_HOST_MANAGED_OBJECT (DocumentController)
};

//! @} ARA_Library_ARAPlug_Document_Controller


//! @addtogroup ARA_Library_ARAPlug_Utility_Classes
//! @{

//! Internal helper template class for HostContentReader.
template <ARAContentType contentType>
#if ARA_VALIDATE_API_CALLS
using HostContentReaderBase = ARA::ContentReader<contentType, HostContentAccessController, ARAContentReaderHostRef, ARA::ContentValidator<contentType, HostContentAccessController, ARAContentReaderHostRef>>;
#else
using HostContentReaderBase = ARA::ContentReader<contentType, HostContentAccessController, ARAContentReaderHostRef, ARA::NoContentValidator<contentType, HostContentAccessController, ARAContentReaderHostRef>>;
#endif

/*******************************************************************************/
//! Utility class that wraps the host ARAContentAccessControllerInterface.
//! \tparam contentType The type of ARA content event that can be read.

template <ARAContentType contentType>
class HostContentReader : public HostContentReaderBase<contentType>
{
public:
    //! Read musical context content with an optional time range.
    explicit inline HostContentReader (const MusicalContext* musicalContext, const ARAContentTimeRange* range = nullptr) noexcept
    : HostContentReaderBase<contentType> { musicalContext->getDocument ()->getDocumentController ()->getHostContentAccessController (), musicalContext->getHostRef (), range }
    {}

    //! Read audio source content with an optional time range.
    explicit inline HostContentReader(const AudioSource* audioSource, const ARAContentTimeRange* range = nullptr) noexcept
    : HostContentReaderBase<contentType> { audioSource->getDocument ()->getDocumentController ()->getHostContentAccessController (), audioSource->getHostRef (), range }
    {}
};


/*******************************************************************************/
//! Utility class that wraps the host ARAAudioAccessControllerInterface.
class HostAudioReader
{
public:
    //! Convenience constructor - use to read samples from \p audioSource.
    explicit HostAudioReader (const AudioSource* audioSource, bool use64BitSamples = false) noexcept;
    //! Primitive constructor - see ARAAudioAccessControllerInterface::createAudioReaderForSource.
    explicit HostAudioReader (HostAudioAccessController* audioAccessController, ARAAudioSourceHostRef audioSourceHostRef, bool use64BitSamples = false) noexcept;
    ~HostAudioReader () noexcept;

    HostAudioReader (const HostAudioReader& other) = delete;
    HostAudioReader& operator= (const HostAudioReader& other) = delete;

    HostAudioReader (HostAudioReader&& other) noexcept;
    HostAudioReader& operator= (HostAudioReader&& other) noexcept;

    bool readAudioSamples (ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) const noexcept; //!< \copydoc ARAAudioAccessControllerInterface::readAudioSamples

private:
    HostAudioAccessController* _audioAccessController;
    ARAAudioReaderHostRef _hostRef;
};


/*******************************************************************************/
//! Utility class that wraps the host ARAArchivingControllerInterface archive reading functions.
class HostArchiveReader
{
public:
    HostArchiveReader (DocumentController* documentController, ARAArchiveReaderHostRef archiveReaderHostRef) noexcept;

    ARASize getArchiveSize () const noexcept;                                                       //!< \copydoc ARAArchivingControllerInterface::getArchiveSize
    bool readBytesFromArchive (ARASize position, ARASize length, ARAByte buffer[]) const noexcept;  //!< \copydoc ARAArchivingControllerInterface::readBytesFromArchive

    void notifyDocumentUnarchivingProgress (float value) noexcept;                                  //!< \copydoc ARAArchivingControllerInterface::notifyDocumentUnarchivingProgress

    ARAPersistentID getDocumentArchiveID () const noexcept;                                         //!< \copydoc ARAArchivingControllerInterface::getDocumentArchiveID

private:
    HostArchivingController* const  _hostArchivingController;
    ARAArchiveReaderHostRef _hostRef;
};


/*******************************************************************************/
//! Utility class that wraps the host ARAArchivingControllerInterface archive writing functions.
class HostArchiveWriter
{
public:
    HostArchiveWriter (DocumentController* documentController, ARAArchiveWriterHostRef archiveWriterHostRef) noexcept;

    bool writeBytesToArchive (ARASize position, ARASize length, const ARAByte buffer[]) noexcept;   //!< \copydoc ARAArchivingControllerInterface::writeBytesToArchive
    void notifyDocumentArchivingProgress (float value) noexcept;                                    //!< \copydoc ARAArchivingControllerInterface::notifyDocumentArchivingProgress

private:
    HostArchivingController* const _hostArchivingController;
    ARAArchiveWriterHostRef _hostRef;
};


/*******************************************************************************/
//! Utility class that wraps an ARAViewSelection instance.
class ViewSelection
{
public:
    ViewSelection () noexcept = default;
    ViewSelection (const DocumentController* documentController, SizedStructPtr<ARAViewSelection> selection) noexcept;

//! @name Selection Queries
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the current list of selected playback regions.
    template <typename PlaybackRegion_t = PlaybackRegion>
    std::vector<PlaybackRegion_t*> const& getPlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (this->_playbackRegions); }

    //! Retrieve the current list of selected region sequences.
    template <typename RegionSequence_t = RegionSequence>
    std::vector<RegionSequence_t*> const& getRegionSequences () const noexcept { return vector_cast<RegionSequence_t*> (this->_regionSequences); }

    //! Get the selected time range - may be nullptr if not supported by the host.
    OptionalProperty<ARAContentTimeRange*> const& getTimeRange () const noexcept { return _timeRange; }
//@}

//! @name Effective Selection Functions
//! These variants interpret the selection and return explicitly or implicitly selected data.
//! For example if a selection is made across region sequences and time range (e.g. marquee tool
//! in Logic, range tool in Studio One) getPlaybackRegions() will return an empty vector,
//! whereas getEffectivePlaybackRegions() returns all regions in those selected sequences
//! which intersect with the given time range.
//! Likewise, if no time range is provided because the selection was made by selecting individual
//! playback regions, the effective time range would be the union of the time range of all regions.
//!
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Return selected playback regions, or all playback regions in getRegionSequences() (limited to those intersecting getTimeRange() if provided)
    std::vector<PlaybackRegion*> getEffectivePlaybackRegions () const noexcept;
    template <typename PlaybackRegion_t>
    std::vector<PlaybackRegion_t*> getEffectivePlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (getEffectivePlaybackRegions ()); }

    //! Return the selected region sequences, or the sequences of all regions in getPlaybackRegions() if no sequences are selected.
    std::vector<RegionSequence*> getEffectiveRegionSequences () const noexcept;
    template <typename RegionSequence_t>
    std::vector<RegionSequence_t*> getEffectiveRegionSequences () const noexcept { return vector_cast<RegionSequence_t*> (getEffectiveRegionSequences ()); }

    //! Return the host provided time range, or the range enclosing getEffectivePlaybackRegions() if no time range is provided.
    ARAContentTimeRange getEffectiveTimeRange () const noexcept;
//@}

private:
    std::vector<PlaybackRegion*> _playbackRegions;
    std::vector<RegionSequence*> _regionSequences;
    OptionalProperty<ARAContentTimeRange*> _timeRange;
};

//! @} ARA_Library_ARAPlug_Utility_Classes


//! @addtogroup ARA_Library_ARAPlug_PlugInInstanceRoles
//! @{

/*******************************************************************************/
//! Extensible plug-in instance role class implementing an ARA \ref Playback_Renderer_Interface.
class PlaybackRenderer : public PlaybackRendererInterface
{
public:
    explicit PlaybackRenderer (DocumentController* documentController) noexcept;
    ~PlaybackRenderer () noexcept override;

//! @name Member Access
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the DocumentController instance the renderer is bound to.
    //! Note that during destruction phase, the document controller may have already
    //! deleted its document and associated graph - its getDocument () will then return nullptr.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_documentController); }

    template <typename PlaybackRegion_t = PlaybackRegion>           //! Retrieve the current list of playback regions assigned to the renderer.
    std::vector<PlaybackRegion_t*> const& getPlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (this->_playbackRegions); }
//@}

protected:
//! @name PlaybackRenderer Region Assignment Customization
//! To be overridden by subclasses if needed.
//! Overrides do not need to call base class implementation.
//@{
    //! Override to customize behavior before \p playbackRegion is assigned to the renderer during addPlaybackRegion().
    virtual void willAddPlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior after \p playbackRegion is assigned to the renderer during addPlaybackRegion().
    virtual void didAddPlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before \p playbackRegion is removed from the renderer during removePlaybackRegion().
    virtual void willRemovePlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior after \p playbackRegion is removed from the renderer during removePlaybackRegion().
    virtual void didRemovePlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
//@}

#if !ARA_DOXYGEN_BUILD
public:
    // Inherited public interface used by the C++ dispatcher, to be called by the ARAPlugInDispatch code exclusively.
    // Typically not overridden - need to call base class implementation if so.
    void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept override;
    void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept override;
#endif

private:
    DocumentController* _documentController;
    std::vector<PlaybackRegion*> _playbackRegions;

    ARA_HOST_MANAGED_OBJECT (PlaybackRenderer)
};


/*******************************************************************************/
//! Extensible plug-in instance role class implementing an ARA \ref Editor_Renderer_Interface.
class EditorRenderer : public EditorRendererInterface
{
public:
    explicit EditorRenderer (DocumentController* documentController) noexcept;
    ~EditorRenderer () noexcept override;

//! @name Member Access
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the DocumentController instance the renderer is bound to.
    //! Note that during destruction phase, the document controller may have already
    //! deleted its document and associated graph - its getDocument () will then return nullptr.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_documentController); }

    //! Retrieve the current list of playback regions assigned to the renderer.
    template <typename PlaybackRegion_t = PlaybackRegion>
    std::vector<PlaybackRegion_t*> const& getPlaybackRegions () const noexcept { return vector_cast<PlaybackRegion_t*> (this->_playbackRegions); }

    //! Retrieve the current list of region sequences assigned to the renderer.
    template <typename RegionSequence_t = RegionSequence>
    std::vector<RegionSequence_t*> const& getRegionSequences () const noexcept { return vector_cast<RegionSequence_t*> (this->_regionSequences); }
//@}

protected:
//! @name EditorRenderer Region Assignment Customization
//! To be overridden by subclasses if needed.
//! Overrides do not need to call base class implementation.
//@{
    //! Override to customize behavior before \p playbackRegion is assigned to the renderer during addPlaybackRegion().
    virtual void willAddPlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior after \p playbackRegion is assigned to the renderer during addPlaybackRegion().
    virtual void didAddPlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior before \p playbackRegion is removed from renderer during removePlaybackRegion().
    virtual void willRemovePlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}
    //! Override to customize behavior after \p playbackRegion is removed from renderer during removePlaybackRegion().
    virtual void didRemovePlaybackRegion (PlaybackRegion* playbackRegion) noexcept {}

    //! Override to customize behavior before all regions in \p regionSequence are added to the renderer during addRegionSequence().
    virtual void willAddRegionSequence (RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior after all regions in \p regionSequence are added to the renderer during addRegionSequence().
    virtual void didAddRegionSequence (RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior before all regions in \p regionSequence are removed from the renderer during removeRegionSequence().
    virtual void willRemoveRegionSequence (RegionSequence* regionSequence) noexcept {}
    //! Override to customize behavior after all regions in \p regionSequence are removed from the renderer during removeRegionSequence().
    virtual void didRemoveRegionSequence (RegionSequence* regionSequence) noexcept {}
//@}

#if !ARA_DOXYGEN_BUILD
public:
    // Inherited public interface used by the C++ dispatcher, to be called by the ARAPlugInDispatch code exclusively.
    // Typically not overridden - need to call base class implementation if so.
    void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept override;
    void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept override;

    void addRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept override;
    void removeRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept override;
#endif

private:
    DocumentController* _documentController;
    std::vector<PlaybackRegion*> _playbackRegions;
    std::vector<RegionSequence*> _regionSequences;

    ARA_HOST_MANAGED_OBJECT (EditorRenderer)
};


/*******************************************************************************/
//! Extensible plug-in instance role class implementing an ARA \ref Editor_View_Interface.
class EditorView : public EditorViewInterface
{
public:
    explicit EditorView (DocumentController* documentController) noexcept;
    ~EditorView () noexcept override;

//! @name Member Access
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    //! Retrieve the DocumentController instance the view is bound to.
    //! Note that during destruction phase, the document controller may have already
    //! deleted its document and associated graph - its getDocument () will then return nullptr.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_documentController); }

    //! Retrieves the last view selection sent from the host.
    //! If some of the selected objects have been deleted by the host, this will return an
    //! empty selection, because the host will eventually send a new, properly updated selection.
    //! Note that while it clears the selection, the deletion does not trigger doNotifySelection ()
    //! for the same reason that the host will send it afterwards.
    //! This should only be called while there actually is an editor UI open, because otherwise
    //! the host will not maintain the view selection in this plug-in instance.
    const ViewSelection& getViewSelection () const noexcept { ARA_INTERNAL_ASSERT (_isEditorOpen); return _viewSelection; }

    //! Retrieves the hidden region sequences sent from the host.
    //! If a hidden region sequence has been deleted by the host, it will no longer appear in
    //! this list, but doNotifyHideRegionSequences () will not be triggered implicitly - the host
    //! is expected to trigger this once all its updates have completed.
    //! This should only be called while there actually is an editor UI open, because otherwise
    //! the host will not maintain the hidden region sequences in this plug-in instance.
    template <typename RegionSequence_t = RegionSequence>
    std::vector<RegionSequence_t*> const& getHiddenRegionSequences () const noexcept { ARA_INTERNAL_ASSERT (this->_isEditorOpen); return vector_cast<RegionSequence_t*> (this->_hiddenRegionSequences); }

    //! Must be called by the companion API implementations whenever the UI is opened or closed.
    void setEditorOpen (bool isOpen) noexcept;
//@}

protected:
//! @name EditorView Host UI notification Customization
//! To be overridden by subclasses if needed.
//! Overrides do not need to call base class implementation.
//! Only called while there actually is an editor UI open.
//@{
    //! Override to implement notifySelection().
    virtual void doNotifySelection (const ViewSelection* selection) noexcept {}
    //! Override to implement notifyHideRegionSequences().
    virtual void doNotifyHideRegionSequences (std::vector<RegionSequence*> const& hiddenRegionSequences) noexcept {}
//@}

#if !ARA_DOXYGEN_BUILD
public:
    // Inherited public interface used by the C++ dispatcher, to be called by the ARAPlugInDispatch code exclusively.
    // Typically not overridden - need to call base class implementation if so.
    void notifySelection (SizedStructPtr<ARAViewSelection> selection) noexcept override;
    void notifyHideRegionSequences (ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept override;
#endif

private:
    // to be called by DocumentController during destruction exclusively
    friend class DocumentController;
    void willDestroyRegionSequence (RegionSequence* regionSequence) noexcept;
    void willDestroyPlaybackRegion (PlaybackRegion* playbackRegion) noexcept;

private:
    void clearViewSelection () noexcept;

private:
    DocumentController* _documentController;
    ViewSelection _viewSelection;
    std::vector<RegionSequence*> _hiddenRegionSequences;
    bool _isEditorOpen { false };

    ARA_HOST_MANAGED_OBJECT (EditorView)
};


/*******************************************************************************/
//! Utility class that wraps an ARAPlugInExtensionInstance.
//! Each companion API plug-in instance owns one PlugInExtension (or custom subclass thereof).
class PlugInExtension
{
public:
    PlugInExtension () noexcept = default;
    virtual ~PlugInExtension () noexcept;

    //! Establish the binding to ARA when requested through the companion API,
    //! switching the plug-in from regular processing to ARA mode.
    const ARAPlugInExtensionInstance* bindToARA (ARADocumentControllerRef documentControllerRef, ARAPlugInInstanceRoleFlags knownRoles, ARAPlugInInstanceRoleFlags assignedRoles) noexcept;

    //! Test whether bindToDocumentController () has been called.
    bool isBoundToARA () const noexcept { return _documentController != nullptr; }

    //! Retrieve the DocumentController instance the plug-in instance is bound to.
    //! Returns nullptr if bindToDocumentController () hasn't been called yet.
    //! Note that during destruction phase, the document controller may have already
    //! deleted its document and associated graph - its getDocument () will then return nullptr.
    template <typename DocumentController_t = DocumentController>
    DocumentController_t* getDocumentController () const noexcept { return static_cast<DocumentController_t*> (this->_documentController); }

//! @name ARA2 Instance Roles
//! Use these functions to access the plug-in extension roles defined by ARA.
//! These functions return nullptr if the plug-in instance doesn't fill the requested role -
//! i.e if the plug-in instance is not an EditorView, getEditorView() returns nullptr.
//!
//! Where applicable, use the optional template parameter to cast the returned instances to your custom subclass.
//@{
    template <typename PlaybackRenderer_t = PlaybackRenderer>   //! Get the PlaybackRenderer instance role, if it exists.
    PlaybackRenderer_t* getPlaybackRenderer () const noexcept { return static_cast<PlaybackRenderer_t*> (this->_instance.getPlaybackRenderer ()); }

    template <typename EditorRenderer_t = EditorRenderer>       //! Get the EditorRenderer instance role, if it exists.
    EditorRenderer_t* getEditorRenderer () const noexcept { return static_cast<EditorRenderer_t*> (this->_instance.getEditorRenderer ()); }

    template <typename EditorView_t = EditorView>               //! Get the EditorView instance role, if it exists.
    EditorView_t* getEditorView () const noexcept { return static_cast<EditorView_t*> (this->_instance.getEditorView ()); }
//@}

protected:
    //! Optional hook for derived classes to perform any additional initialization that may be needed.
    virtual void didBindToARA () noexcept {}

private:
    DocumentController* _documentController { nullptr };
    PlugInExtensionInstance _instance { nullptr, nullptr, nullptr };

    ARA_HOST_MANAGED_OBJECT (PlugInExtension)
};

//! @} ARA_Library_ARAPlug_PlugInInstanceRoles


//! @addtogroup ARA_Library_ARAPlug_PlugInEntry
//! @{

/*******************************************************************************/
//! Customization interface for defining ARAFactory instances in the PlugInEntry.
class FactoryConfig
{
public:
    FactoryConfig () = default;
    virtual ~FactoryConfig () = default;

    //! \copydoc ARAFactory::lowestSupportedApiGeneration
    virtual ARAAPIGeneration getLowestSupportedApiGeneration () const noexcept
#if ARA_SUPPORT_VERSION_1
                                                                                { return kARAAPIGeneration_1_0_Final; }
#elif ARA_CPU_ARM
                                                                                { return kARAAPIGeneration_2_0_Final; }
#else
                                                                                { return kARAAPIGeneration_2_0_Draft; }
#endif
    //! \copydoc ARAFactory::highestSupportedApiGeneration
    virtual ARAAPIGeneration getHighestSupportedApiGeneration () const noexcept { return kARAAPIGeneration_2_X_Draft; }

    virtual DocumentController* createDocumentController (const PlugInEntry* entry, const ARADocumentControllerHostInstance* instance) const noexcept = 0;
    virtual void destroyDocumentController (DocumentController* documentController) const noexcept { delete documentController; }

    //! \copydoc ARAFactory::factoryID
    virtual const char* getFactoryID () const noexcept = 0;
    //! \copydoc ARAFactory::plugInName
    virtual const char* getPlugInName () const noexcept = 0;
    //! \copydoc ARAFactory::manufacturerName
    virtual const char* getManufacturerName () const noexcept = 0;
    //! \copydoc ARAFactory::informationURL
    virtual const char* getInformationURL () const noexcept = 0;
    //! \copydoc ARAFactory::version
    virtual const char* getVersion () const noexcept = 0;

    //! \copydoc ARAFactory::documentArchiveID
    virtual const char* getDocumentArchiveID () const noexcept = 0;
    //! \copydoc ARAFactory::compatibleDocumentArchiveIDsCount
    virtual ARASize getCompatibleDocumentArchiveIDsCount () const noexcept { return 0; }
    //! \copydoc ARAFactory::compatibleDocumentArchiveIDs
    virtual const ARAPersistentID* getCompatibleDocumentArchiveIDs () const noexcept { return nullptr; }

    //! \copydoc ARAFactory::analyzeableContentTypesCount
    virtual ARASize getAnalyzeableContentTypesCount () const noexcept { return 0; }
    //! \copydoc ARAFactory::analyzeableContentTypes
    virtual const ARAContentType* getAnalyzeableContentTypes () const noexcept { return nullptr; }

    //! \copydoc ARAFactory::supportedPlaybackTransformationFlags
    virtual ARAPlaybackTransformationFlags getSupportedPlaybackTransformationFlags () const noexcept { return kARAPlaybackTransformationNoChanges; }

    //! \copydoc ARAFactory::supportsStoringAudioFileChunks
    virtual bool supportsStoringAudioFileChunks () const noexcept { return false; }
};


/*******************************************************************************/
//! Singleton class to define the entry into ARA.
//! For each document controller class in your plug-in, create a single static instance of this class
//! by using the static member template getPlugInEntry () which takes your custom FactoryConfig
//! and DocumentController subclasses as template arguments.
class PlugInEntry
{
private:
    // internal helper template to provide distinct dispatcher functions for each entry instance
    template<PlugInEntry* (*entryFunc) ()>
    struct DispatcherFunctions
    {
        static void ARA_CALL initializeARAWithConfiguration (const ARAInterfaceConfiguration* config)
            { entryFunc ()->initializeARAWithConfiguration (config); }
        static void ARA_CALL uninitializeARA ()
            { entryFunc ()->uninitializeARA (); }
        static const ARADocumentControllerInstance* ARA_CALL createDocumentControllerWithDocument (const ARADocumentControllerHostInstance* hostInstance, const ARADocumentProperties* properties)
            { return entryFunc ()->createDocumentControllerWithDocument (hostInstance, properties); }
    };

    // internal helper template class used to subclass FactoryConfigClass if DocumentControllerClass
    // is provided to inject its creation/deletion.
    template<typename FactoryConfigClass, typename DocumentControllerClass>
    class WrappedFactoryConfig : public FactoryConfigClass
    {
    public:
        using FactoryConfigClass::FactoryConfigClass;

        DocumentController* createDocumentController (const PlugInEntry* entry, const ARADocumentControllerHostInstance* instance) const noexcept override
        {
            return new DocumentControllerClass (entry, instance);
        }
        void destroyDocumentController (DocumentController* documentController) const noexcept override
        {
            delete documentController;
        }
    };
    template<typename FactoryConfigClass>
    class WrappedFactoryConfig<FactoryConfigClass, void> : public FactoryConfigClass
    {
        public:
            using FactoryConfigClass::FactoryConfigClass;
    };

    // internal helper template class used to provide the correct template argument for the DispatcherFunctions<>
    template<typename FactoryConfigClass, typename DocumentControllerClass>
    struct EntryWrapper
    {
        static inline PlugInEntry* getEntry () noexcept
        {
            static WrappedFactoryConfig<FactoryConfigClass, DocumentControllerClass> factoryConfig;
            using Dispatcher = DispatcherFunctions<getEntry>;
            static PlugInEntry entry { &factoryConfig, Dispatcher::initializeARAWithConfiguration, Dispatcher::uninitializeARA, Dispatcher::createDocumentControllerWithDocument };
            return &entry;
        }
    };

protected:
    using CreateDocumentControllerCall = DocumentController* (*) (PlugInEntry* entry, const ARADocumentControllerHostInstance* instance);
    PlugInEntry (const FactoryConfig* factoryConfig,
                 void (ARA_CALL * initializeARAWithConfigurationFunc) (const ARAInterfaceConfiguration*),
                 void (ARA_CALL * uninitializeARAFunc) (),
                 const ARADocumentControllerInstance* (ARA_CALL *createDocumentControllerWithDocumentFunc) (const ARADocumentControllerHostInstance*, const ARADocumentProperties*)) noexcept;
    ~PlugInEntry ();

    void initializeARAWithConfiguration (const ARAInterfaceConfiguration* config) noexcept;
    void uninitializeARA () noexcept;
    const ARADocumentControllerInstance* createDocumentControllerWithDocument (const ARADocumentControllerHostInstance* hostInstance, const ARADocumentProperties* properties) noexcept;

public:

//! @name PlugInEntry creation
//@{
    //! This static template function should be used to create a single static PlugInEntry per
    //! DocumentController class.
    //! The DocumentControllerClass parameter is optional - if omitted, the FactoryConfigClass
    //! must overload createDocumentController () and can optionally overload destroyDocumentController (),
    //! otherwise the template takes care of this using new and delete.
    //!
    //! \code{.cpp}
    //!     class MyFactoryConfig : public FactoryConfig
    //!     {
    //!         // ... implement customization overrides ...
    //!     };
    //!     class MyDocumentController : public DocumentController
    //!     {
    //!         using DocumentController::DocumentController;   // publish inherited constructor
    //!         // ... implement customization overrides ...
    //!     };
    //!     static const ARAFactory* getMyARAFactory () noexcept
    //!     {
    //!         return PlugInEntry::getPlugInEntry<MyFactoryConfig, MyDocumentController> ()->getFactory ();
    //!     }
    //! \endcode
    template<typename FactoryConfigClass, typename DocumentControllerClass = void>
    static inline PlugInEntry* getPlugInEntry () noexcept
    {
        return EntryWrapper<FactoryConfigClass, DocumentControllerClass>::getEntry ();
    }
//@}

//! @name Getters for Document Controller and Companion API implementations
//@{
    const ARAFactory* getFactory () const noexcept { return  &_factory; }
    ARAAPIGeneration getUsedApiGeneration () const noexcept { return _usedApiGeneration; }
//@}

private:
    // to be called by DocumentController during destruction exclusively
    friend class DocumentController;
    void destroyDocumentController (DocumentController* documentController) const noexcept { _factoryConfig->destroyDocumentController (documentController); }

private:
    const FactoryConfig* const _factoryConfig;
    const SizedStruct<ARA_STRUCT_MEMBER (ARAFactory, supportsStoringAudioFileChunks)> _factory;
    ARAAPIGeneration _usedApiGeneration { 0 };

    ARA_DISABLE_COPY_AND_MOVE (PlugInEntry)
};

//! @} ARA_Library_ARAPlug_PlugInEntry


ARA_DISABLE_UNREFERENCED_PARAMETER_WARNING_END
}   // namespace PlugIn
}   // namespace ARA

#endif // ARAPlug_h
