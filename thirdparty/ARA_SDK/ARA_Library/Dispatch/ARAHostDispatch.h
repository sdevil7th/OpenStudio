//------------------------------------------------------------------------------
//! \file       ARAHostDispatch.h
//!             C-to-C++ adapter for implementing ARA hosts
//!             Originally written and contributed to the ARA SDK by PreSonus Software Ltd.
//! \project    ARA SDK Library
//! \copyright  Copyright (c) 2012-2022, Celemony Software GmbH, All Rights Reserved.
//!             Developed in cooperation with PreSonus Software Ltd.
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

#ifndef ARAHostDispatch_h
#define ARAHostDispatch_h

#include "ARA_Library/Dispatch/ARADispatchBase.h"
#include "ARA_Library/Dispatch/ARAContentReader.h"

namespace ARA {
namespace Host {

//! @addtogroup ARA_Library_Host_Dispatch
//! @{

/*******************************************************************************/
/** Optional ARA 1 backwards compatibility.
    Host can choose support ARA 1 plug-ins in addition to ARA 2 plug-ins.
    This results in several restrictions being implicitly imposed when using such plug-ins
    through the implementation provided here:
    - each plug-in instance assumes all possible roles (see ARAPlugInInstanceRoleFlags)
    - each plug-in instance only is associated with at most one playback region at any time
    - the ARA 1 API is mapped to PlaybackRenderer*, the other interfaces will not be provided
    - archiving must use ARA 1 style monolithic persistency calls
*/
/*******************************************************************************/

#if !defined (ARA_SUPPORT_VERSION_1)
    #define ARA_SUPPORT_VERSION_1 0
#endif

#if ARA_SUPPORT_VERSION_1 && ARA_CPU_ARM
    #error "ARA v1 is not supported on ARM architecture"
#endif

/*******************************************************************************/
/** Type safe conversions to/from host ref: toHostRef () and fromHostRef<> ().
    This macro defines custom overloads of the toHostRef () and fromHostRef<> () conversion functions
    which act as type safe casts between your implementation class pointers and the opaque host refs
    that the ARA API uses.
    fromHostRef<>() additionally allows for optional up-casting from base to derived classes if needed.
    The first macro argument is your implementation class, followed by all host ref types that you
    want this class to comply with.
    \br
    Whenever using your C++ object pointers as host refs, you should apply the conversion macros like so:
    \code{.cpp}
        // declare the conversion in the appropriate header
        class MyHostAudioSource;
        ARA_MAP_HOST_REF (MyHostAudioSource, ARAAudioSourceHostRef)

        // whenever exporting host refs to the plug-in, use toHostRef ()
        MyHostAudioSource* audioSource = ...;
        ARAAudioSourceHostRef audioSourceHostRef = toHostRef (audioSource);

        // whenever the plug-in passes a host ref back to you, use fromHostRef<> ()
        ARAAudioSourceHostRef audioSourceHostRef;   // usually provided as argument to a function call
        MyHostAudioSource* audioSource = fromHostRef (audioSourceHostRef);
    \endcode
*/
/*******************************************************************************/

#if !defined (ARA_MAP_HOST_REF)
    #define ARA_MAP_HOST_REF(HostClassType, FirstHostRefType, ...) \
        static inline ARA::ToRefConversionHelper<HostClassType, FirstHostRefType, ##__VA_ARGS__> toHostRef (const HostClassType* ptr) noexcept { return ARA::ToRefConversionHelper<HostClassType, FirstHostRefType, ##__VA_ARGS__> { ptr }; } \
        template <typename DesiredHostClassType = HostClassType, typename HostRefType, typename std::enable_if<std::is_constructible<ARA::FromRefConversionHelper<HostClassType, FirstHostRefType, ##__VA_ARGS__>, HostRefType>::value, bool>::type = true> \
        static inline DesiredHostClassType* fromHostRef (HostRefType ref) noexcept { HostClassType* object { ARA::FromRefConversionHelper<HostClassType, FirstHostRefType, ##__VA_ARGS__> (ref) }; return static_cast<DesiredHostClassType*> (object); }
#endif

/*******************************************************************************/
/** Tag objects maintained by the plug-in to prevent accidentally copying/moving them. */
/*******************************************************************************/

#if !defined (ARA_PLUGIN_MANAGED_OBJECT)
    #define ARA_PLUGIN_MANAGED_OBJECT ARA_DISABLE_COPY_AND_MOVE
#endif

/*******************************************************************************/
// Properties
/** C++ wrapper for ARA variable-sized properties structs, ensures their proper initialization. */
/*******************************************************************************/

#if defined (__cpp_template_auto)
    template <auto member>
    using Properties = SizedStruct<member>;
#else
    template <typename StructType, typename MemberType, MemberType StructType::*member>
    using Properties = SizedStruct<StructType, MemberType, member>;
#endif

//! @addtogroup ARA_Library_Host_Dispatch_Host_Interfaces Host Interfaces
//! @{

/*******************************************************************************/
// AudioAccessController
/** Base class for implementing ARAAudioAccessControllerInterface. */
/*******************************************************************************/

class AudioAccessControllerInterface
{
public:
    virtual ~AudioAccessControllerInterface () = default;

    //! \copydoc ARAAudioAccessControllerInterface::createAudioReaderForSource
    virtual ARAAudioReaderHostRef createAudioReaderForSource (ARAAudioSourceHostRef audioSourceHostRef, bool use64BitSamples) noexcept = 0;
    //! \copydoc ARAAudioAccessControllerInterface::readAudioSamples
    virtual bool readAudioSamples (ARAAudioReaderHostRef audioReaderHostRef, ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) noexcept = 0;
    //! \copydoc ARAAudioAccessControllerInterface::destroyAudioReader
    virtual void destroyAudioReader (ARAAudioReaderHostRef audioReaderHostRef) noexcept = 0;
};
ARA_MAP_HOST_REF (AudioAccessControllerInterface, ARAAudioAccessControllerHostRef)

/*******************************************************************************/
// ArchivingController
/** Base class for implementing ARAArchivingControllerInterface. */
/*******************************************************************************/

class ArchivingControllerInterface
{
public:
    virtual ~ArchivingControllerInterface () = default;

    //! \copydoc ARAArchivingControllerInterface::getArchiveSize
    virtual ARASize getArchiveSize (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept = 0;
    //! \copydoc ARAArchivingControllerInterface::readBytesFromArchive
    virtual bool readBytesFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, ARASize position, ARASize length, ARAByte buffer[]) noexcept = 0;
    //! \copydoc ARAArchivingControllerInterface::writeBytesToArchive
    virtual bool writeBytesToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, ARASize position, ARASize length, const ARAByte buffer[]) noexcept = 0;
    //! \copydoc ARAArchivingControllerInterface::notifyDocumentArchivingProgress
    virtual void notifyDocumentArchivingProgress (float value) noexcept = 0;
    //! \copydoc ARAArchivingControllerInterface::notifyDocumentUnarchivingProgress
    virtual void notifyDocumentUnarchivingProgress (float value) noexcept = 0;
    //! \copydoc ARAArchivingControllerInterface::getDocumentArchiveID
    virtual ARAPersistentID getDocumentArchiveID (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept = 0;
};
ARA_MAP_HOST_REF (ArchivingControllerInterface, ARAArchivingControllerHostRef)

/*******************************************************************************/
// ContentAccessController
/** Base class for implementing ARAContentAccessControllerInterface. */
/*******************************************************************************/

class ContentAccessControllerInterface
{
public:
    virtual ~ContentAccessControllerInterface () = default;

    //! \copydoc ARAContentAccessControllerInterface::isMusicalContextContentAvailable
    virtual bool isMusicalContextContentAvailable (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::getMusicalContextContentGrade
    virtual ARAContentGrade getMusicalContextContentGrade (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::createMusicalContextContentReader
    virtual ARAContentReaderHostRef createMusicalContextContentReader (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type, const ARAContentTimeRange* range) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::isAudioSourceContentAvailable
    virtual bool isAudioSourceContentAvailable (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::getAudioSourceContentGrade
    virtual ARAContentGrade getAudioSourceContentGrade (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::createAudioSourceContentReader
    virtual ARAContentReaderHostRef createAudioSourceContentReader (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type, const ARAContentTimeRange* range) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::getContentReaderEventCount
    virtual ARAInt32 getContentReaderEventCount (ARAContentReaderHostRef contentReaderHostRef) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::getContentReaderDataForEvent
    virtual const void* getContentReaderDataForEvent (ARAContentReaderHostRef contentReaderHostRef, ARAInt32 eventIndex) noexcept = 0;
    //! \copydoc ARAContentAccessControllerInterface::destroyContentReader
    virtual void destroyContentReader (ARAContentReaderHostRef contentReaderHostRef) noexcept = 0;
};
ARA_MAP_HOST_REF (ContentAccessControllerInterface, ARAContentAccessControllerHostRef)

/*******************************************************************************/
// ModelUpdateController
/** Base class for implementing ARAModelUpdateControllerInterface. */
/*******************************************************************************/

class ModelUpdateControllerInterface
{
public:
    virtual ~ModelUpdateControllerInterface () = default;

    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioSourceAnalysisProgress
    virtual void notifyAudioSourceAnalysisProgress (ARAAudioSourceHostRef audioSourceHostRef, ARAAnalysisProgressState state, float value) noexcept = 0;
    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioSourceContentChanged
    virtual void notifyAudioSourceContentChanged (ARAAudioSourceHostRef audioSourceHostRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioModificationContentChanged
    virtual void notifyAudioModificationContentChanged (ARAAudioModificationHostRef audioModificationHostRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! \copydoc ARAModelUpdateControllerInterface::notifyPlaybackRegionContentChanged
    virtual void notifyPlaybackRegionContentChanged (ARAPlaybackRegionHostRef playbackRegionHostRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
};
ARA_MAP_HOST_REF (ModelUpdateControllerInterface, ARAModelUpdateControllerHostRef)

/*******************************************************************************/
// PlaybackController
/** Base class for implementing ARAPlaybackControllerInterface. */
/*******************************************************************************/

class PlaybackControllerInterface
{
public:
    virtual ~PlaybackControllerInterface () = default;

    //! \copydoc ARAPlaybackControllerInterface::requestStartPlayback
    virtual void requestStartPlayback () noexcept = 0;
    //! \copydoc ARAPlaybackControllerInterface::requestStopPlayback
    virtual void requestStopPlayback () noexcept = 0;
    //! \copydoc ARAPlaybackControllerInterface::requestSetPlaybackPosition
    virtual void requestSetPlaybackPosition (ARATimePosition timePosition) noexcept = 0;
    //! \copydoc ARAPlaybackControllerInterface::requestSetCycleRange
    virtual void requestSetCycleRange (ARATimePosition startTime, ARATimeDuration duration) noexcept = 0;
    //! \copydoc ARAPlaybackControllerInterface::requestEnableCycle
    virtual void requestEnableCycle (bool enable) noexcept = 0;
};
ARA_MAP_HOST_REF (PlaybackControllerInterface, ARAPlaybackControllerHostRef)

/*******************************************************************************/
// DocumentControllerHostInstance
/** Wrapper class for the ARADocumentControllerHostInstance. */
/*******************************************************************************/

class DocumentControllerHostInstance : public SizedStruct<ARA_STRUCT_MEMBER (ARADocumentControllerHostInstance, playbackControllerInterface)>
{
public:
#if __cplusplus >= 201402L
    constexpr
#endif
              DocumentControllerHostInstance () noexcept : BaseType {} {}
    DocumentControllerHostInstance (AudioAccessControllerInterface* audioAccessController,
                                    ArchivingControllerInterface* archivingController,
                                    ContentAccessControllerInterface* contentAccessController = nullptr,
                                    ModelUpdateControllerInterface* modelUpdateController = nullptr,
                                    PlaybackControllerInterface* playbackController = nullptr) noexcept;

    AudioAccessControllerInterface* getAudioAccessController () const noexcept
    { return fromHostRef (audioAccessControllerHostRef); }
    void setAudioAccessController (AudioAccessControllerInterface* audioAccessController) noexcept;

    ArchivingControllerInterface* getArchivingController () const noexcept
    { return fromHostRef (archivingControllerHostRef); }
    void setArchivingController (ArchivingControllerInterface* archivingController) noexcept;

    ContentAccessControllerInterface* getContentAccessController () const noexcept
    { return fromHostRef (contentAccessControllerHostRef); }
    void setContentAccessController (ContentAccessControllerInterface* contentAccessController) noexcept;

    ModelUpdateControllerInterface* getModelUpdateController () const noexcept
    { return fromHostRef (modelUpdateControllerHostRef); }
    void setModelUpdateController (ModelUpdateControllerInterface* modelUpdateController) noexcept;

    PlaybackControllerInterface* getPlaybackController () const noexcept
    { return fromHostRef (playbackControllerHostRef); }
    void setPlaybackController (PlaybackControllerInterface* playbackController) noexcept;
};

//! @} ARA_Library_Host_Dispatch_Host_Interfaces

//! @defgroup ARA_Library_Host_Dispatch_Plug-In_Interface_Wrappers Plug-In Interface Wrappers
//! Wrappers for the interfaces used to communicate with and control ARA plug-ins.
//! @{

/*******************************************************************************/
// DocumentController
/** Wrapper class for the plug-in ARADocumentControllerInterface. */
/*******************************************************************************/

class DocumentController : public InterfaceInstance<ARADocumentControllerRef, ARADocumentControllerInterface>
{
public:
    explicit DocumentController (const ARADocumentControllerInstance* instance) noexcept
    : BaseType { instance->documentControllerRef, instance->documentControllerInterface }
    {}

//! @name Destruction
//@{
    //! \copydoc ARADocumentControllerInterface::destroyDocumentController
    void destroyDocumentController () noexcept;
//@}

//! @name Factory
//@{
    //! \copydoc ARADocumentControllerInterface::getFactory
    const ARAFactory* getFactory () noexcept;
//@}

//! @name Update Management
//@{
    //! \copydoc ARADocumentControllerInterface::beginEditing
    void beginEditing () noexcept;
    //! \copydoc ARADocumentControllerInterface::endEditing
    void endEditing () noexcept;
    //! \copydoc ARADocumentControllerInterface::notifyModelUpdates
    void notifyModelUpdates () noexcept;
//@}

//! @name Archiving
//@{
    // deprecated ARA 1 monolithic persistency calls, must be used unless requiring plug-ins to support kARAAPIGeneration_2_0_Final
    //! \copydoc ARADocumentControllerInterface::beginRestoringDocumentFromArchive
    ARA_DEPRECATED(2_0_Final) bool beginRestoringDocumentFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept;
    //! \copydoc ARADocumentControllerInterface::endRestoringDocumentFromArchive
    ARA_DEPRECATED(2_0_Final) bool endRestoringDocumentFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept;
    //! \copydoc ARADocumentControllerInterface::storeDocumentToArchive
    ARA_DEPRECATED(2_0_Final) bool storeDocumentToArchive (ARAArchiveWriterHostRef archiveWriterHostRef) noexcept;
    //! If supporting both types of persistency, this call can be used to pick the appropriate type for the given plug-in.
    ARA_DEPRECATED(2_0_Final) bool supportsPartialPersistency () noexcept;
    // new ARA 2 partial persistency calls, may only be used for plug-ins that support the new ARA 2 persistency,
    // which is part of kARAAPIGeneration_2_0_Final (but not yet present in kARAAPIGeneration_2_0_Draft !)
    //! \copydoc ARADocumentControllerInterface::restoreObjectsFromArchive
    bool restoreObjectsFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept;
    //! \copydoc ARADocumentControllerInterface::storeObjectsToArchive
    bool storeObjectsToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept;
    //! Test whether storeAudioSourceToAudioFileChunk () is supported by the plug-in.
    bool supportsStoringAudioFileChunks () noexcept;
    //! \copydoc ARADocumentControllerInterface::storeAudioSourceToAudioFileChunk
    bool storeAudioSourceToAudioFileChunk (ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept;
//@}

//! @name Document Management
//@{
    //! \copydoc ARADocumentControllerInterface::updateDocumentProperties
    void updateDocumentProperties (const ARADocumentProperties* properties) noexcept;
//@}

//! @name Musical Context Management
//@{
    //! \copydoc ARADocumentControllerInterface::createMusicalContext
    ARAMusicalContextRef createMusicalContext (ARAMusicalContextHostRef hostRef, const ARAMusicalContextProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateMusicalContextProperties
    void updateMusicalContextProperties (ARAMusicalContextRef musicalContextRef, const ARAMusicalContextProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateMusicalContextContent
    void updateMusicalContextContent (ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyMusicalContext
    void destroyMusicalContext (ARAMusicalContextRef musicalContextRef) noexcept;
//@}

//! @name Region Sequence Management
//! (resolves to no-ops for pre-ARA-2.0 plug-ins)
//@{
    //! \copydoc ARADocumentControllerInterface::createRegionSequence
    ARARegionSequenceRef createRegionSequence (ARARegionSequenceHostRef hostRef, const ARARegionSequenceProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateRegionSequenceProperties
    void updateRegionSequenceProperties (ARARegionSequenceRef regionSequenceRef, const ARARegionSequenceProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyRegionSequence
    void destroyRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept;
//@}

//! @name Audio Source Management
//@{
    //! \copydoc ARADocumentControllerInterface::createAudioSource
    ARAAudioSourceRef createAudioSource (ARAAudioSourceHostRef hostRef, const ARAAudioSourceProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateAudioSourceProperties
    void updateAudioSourceProperties (ARAAudioSourceRef audioSourceRef, const ARAAudioSourceProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateAudioSourceContent
    void updateAudioSourceContent (ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept;
    //! \copydoc ARADocumentControllerInterface::enableAudioSourceSamplesAccess
    void enableAudioSourceSamplesAccess (ARAAudioSourceRef audioSourceRef, bool enable) noexcept;
    //! \copydoc ARADocumentControllerInterface::deactivateAudioSourceForUndoHistory
    void deactivateAudioSourceForUndoHistory (ARAAudioSourceRef audioSourceRef, bool deactivate) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyAudioSource
    void destroyAudioSource (ARAAudioSourceRef audioSourceRef) noexcept;
//@}

//! @name Audio Modification Management
//@{
    //! \copydoc ARADocumentControllerInterface::createAudioModification
    ARAAudioModificationRef createAudioModification (ARAAudioSourceRef audioSourceRef, ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::cloneAudioModification
    ARAAudioModificationRef cloneAudioModification (ARAAudioModificationRef audioModificationRef, ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updateAudioModificationProperties
    void updateAudioModificationProperties (ARAAudioModificationRef audioModificationRef, const ARAAudioModificationProperties* properties) noexcept;
    //! Test whether isAudioModificationPreservingAudioSourceSignal () is supported by the plug-in.
    bool supportsIsAudioModificationPreservingAudioSourceSignal () noexcept;
    //! \copydoc ARADocumentControllerInterface::isAudioModificationPreservingAudioSourceSignal
    bool isAudioModificationPreservingAudioSourceSignal (ARAAudioModificationRef audioModificationRef) noexcept;
    //! \copydoc ARADocumentControllerInterface::deactivateAudioModificationForUndoHistory
    void deactivateAudioModificationForUndoHistory (ARAAudioModificationRef audioModificationRef, bool deactivate) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyAudioModification
    void destroyAudioModification (ARAAudioModificationRef audioModificationRef) noexcept;
//@}

//! @name Playback Region Management
//! (getPlaybackRegionHeadAndTailTime () resolves to no-op for pre-ARA-2.0 plug-ins and always returns 0.0 as times)
//@{
    //! \copydoc ARADocumentControllerInterface::createPlaybackRegion
    ARAPlaybackRegionRef createPlaybackRegion (ARAAudioModificationRef audioModificationRef, ARAPlaybackRegionHostRef hostRef, const ARAPlaybackRegionProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::updatePlaybackRegionProperties
    void updatePlaybackRegionProperties (ARAPlaybackRegionRef playbackRegionRef, const ARAPlaybackRegionProperties* properties) noexcept;
    //! \copydoc ARADocumentControllerInterface::getPlaybackRegionHeadAndTailTime
    void getPlaybackRegionHeadAndTailTime (ARAPlaybackRegionRef playbackRegionRef, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyPlaybackRegion
    void destroyPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
//@}

//! @name Content Reader Management
//! See ContentReader<> class below which conveniently wraps some of these calls.
//@{
    //! \copydoc ARADocumentControllerInterface::isAudioSourceContentAvailable
    bool isAudioSourceContentAvailable (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::getAudioSourceContentGrade
    ARAContentGrade getAudioSourceContentGrade (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::createAudioSourceContentReader
    ARAContentReaderRef createAudioSourceContentReader (ARAAudioSourceRef audioSourceRef, ARAContentType type, const ARAContentTimeRange* range) noexcept;
    //! \copydoc ARADocumentControllerInterface::isAudioModificationContentAvailable
    bool isAudioModificationContentAvailable (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::getAudioModificationContentGrade
    ARAContentGrade getAudioModificationContentGrade (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::createAudioModificationContentReader
    ARAContentReaderRef createAudioModificationContentReader (ARAAudioModificationRef audioModificationRef, ARAContentType type, const ARAContentTimeRange* range) noexcept;
    //! \copydoc ARADocumentControllerInterface::isPlaybackRegionContentAvailable
    bool isPlaybackRegionContentAvailable (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::getPlaybackRegionContentGrade
    ARAContentGrade getPlaybackRegionContentGrade (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept;
    //! \copydoc ARADocumentControllerInterface::createPlaybackRegionContentReader
    ARAContentReaderRef createPlaybackRegionContentReader (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type, const ARAContentTimeRange* range) noexcept;
    //! \copydoc ARADocumentControllerInterface::getContentReaderEventCount
    ARAInt32 getContentReaderEventCount (ARAContentReaderRef contentReaderRef) noexcept;
    //! \copydoc ARADocumentControllerInterface::getContentReaderDataForEvent
    const void* getContentReaderDataForEvent (ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept;
    //! \copydoc ARADocumentControllerInterface::destroyContentReader
    void destroyContentReader (ARAContentReaderRef contentReaderRef) noexcept;
//@}

//! @name Controlling Analysis
//@{
    //! \copydoc ARADocumentControllerInterface::isAudioSourceContentAnalysisIncomplete
    bool isAudioSourceContentAnalysisIncomplete (ARAAudioSourceRef audioSourceRef, ARAContentType contentType) noexcept;
    //! \copydoc ARADocumentControllerInterface::requestAudioSourceContentAnalysis
    void requestAudioSourceContentAnalysis (ARAAudioSourceRef audioSourceRef, ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept;

    //! Test whether the plug-in supports managing processing algorithms.
    bool supportsProcessingAlgorithms () noexcept;
    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmsCount
    ARAInt32 getProcessingAlgorithmsCount () noexcept;
    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmProperties
    //! Supporting processing algorithms is optional, make sure to test supportsProcessingAlgorithms()
    //! before calling this function.
    const ARAProcessingAlgorithmProperties* getProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept;
    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmForAudioSource
    ARAInt32 getProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef) noexcept;
    //! \copydoc ARADocumentControllerInterface::requestProcessingAlgorithmForAudioSource
    void requestProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept;
//@}

//! @name License Management
//@{
    //! \copydoc ARADocumentControllerInterface::isLicensedForCapabilities
    //! Returns true if plug-in does not support the optional license management.
    bool isLicensedForCapabilities (bool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept;
//@}
};

/*******************************************************************************/
// DocumentControllerInstance
/** Optional wrapper class for the plug-in binary ARADocumentControllerInstance.
    \deprecated Hosts should to instead use DocumentController directly.
*/
/*******************************************************************************/

ARA_DEPRECATED(2_0_Final) class DocumentControllerInstance
{
public:
    explicit DocumentControllerInstance (const ARADocumentControllerInstance* instance) noexcept
    : _controller { instance }
    {}

    DocumentController& getController () noexcept
    { return _controller; }

private:
    DocumentController _controller;
};

/*******************************************************************************/
// ContentReader
/** Wrapper class for convenient and type safe content reading.
    \tparam contentType The type of ARA content event that can be read.*/
/*******************************************************************************/

template <ARAContentType contentType>
using ContentReader = ARA::ContentReader<contentType, DocumentController, ARAContentReaderRef>;

/*******************************************************************************/
// PlaybackRenderer (ARA 2.0)
/** Wrapper class for the ARAPlaybackRendererInterface provided by the plug-in. */
/*******************************************************************************/

class PlaybackRenderer : public InterfaceInstance<ARAPlaybackRendererRef, ARAPlaybackRendererInterface>
{
public:
#if ARA_SUPPORT_VERSION_1
    explicit PlaybackRenderer (const ARAPlugInExtensionInstance* instance);
    ~PlaybackRenderer ();
#else
    explicit PlaybackRenderer (const ARAPlugInExtensionInstance* instance) noexcept
    : BaseType { instance->playbackRendererRef, instance->playbackRendererInterface }
    {}
#endif

//! @name Assigning the playback region(s) for playback rendering
//! For details, see \ref Assigning_ARAPlaybackRendererInterface_Regions "ARAPlaybackRendererInterface".
//@{
    void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
    void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
//@}
};

//************************************************************************************************
// EditorRenderer (ARA 2.0)
/** Wrapper class for the ARAEditorRendererInterface provided by the plug-in. */
//************************************************************************************************

class EditorRenderer : public InterfaceInstance<ARAEditorRendererRef, ARAEditorRendererInterface>
{
public:
#if ARA_SUPPORT_VERSION_1
    explicit EditorRenderer (const ARAPlugInExtensionInstance* instance) noexcept;
#else
    explicit EditorRenderer (const ARAPlugInExtensionInstance* instance) noexcept
    : BaseType { instance->editorRendererRef, instance->editorRendererInterface }
    {}
#endif

//! @name Assigning the playback region(s) for preview while editing
//! For details, see \ref Assigning_ARAEditorRendererInterface_Regions "ARAEditorRendererInterface".
//@{
    void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
    void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
    void addRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept;
    void removeRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept;
//@}
};

//************************************************************************************************
// EditorView (ARA 2.0)
/** Wrapper class for the ARAEditorViewInterface provided by the plug-in. */
//************************************************************************************************

class EditorView : public InterfaceInstance<ARAEditorViewRef, ARAEditorViewInterface>
{
public:
#if ARA_SUPPORT_VERSION_1
    explicit EditorView (const ARAPlugInExtensionInstance* instance) noexcept;
#else
    explicit EditorView (const ARAPlugInExtensionInstance* instance) noexcept
    : BaseType { instance->editorViewRef, instance->editorViewInterface }
    {}
#endif

//! @name Host UI notifications
//@{
    //! \copydoc ARAEditorViewInterface::notifySelection
    void notifySelection (const ARAViewSelection* selection) noexcept;
    //! \copydoc ARAEditorViewInterface::notifyHideRegionSequences
    void notifyHideRegionSequences (ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept;
//@}
};

//! @} ARA_Library_Host_Dispatch_Plug-In_Interface_Wrappers

/*******************************************************************************/
// PlugInExtensionInstance
/** Optional wrapper class for the ARAPlugInExtensionInstance provided by the plug-in.
    \deprecated Hosts should to instead use PlaybackRenderer, EditorRenderer and EditorView directly.
 */
/*******************************************************************************/

ARA_DEPRECATED(2_0_Final) class PlugInExtensionInstance
{
public:
#if ARA_SUPPORT_VERSION_1
    explicit PlugInExtensionInstance (const ARAPlugInExtensionInstance* instance)
#else
    explicit PlugInExtensionInstance (const ARAPlugInExtensionInstance* instance) noexcept
#endif
    : _playbackRenderer { instance },
      _editorRenderer { instance },
      _editorView { instance }
    {}

    PlaybackRenderer* getPlaybackRenderer () noexcept
    { return (_playbackRenderer.isProvided ()) ? &_playbackRenderer : nullptr; }

    EditorRenderer* getEditorRenderer () noexcept
    { return (_editorRenderer.isProvided ()) ? &_editorRenderer : nullptr; }

    EditorView* getEditorView () noexcept
    { return (_editorView.isProvided ()) ? &_editorView : nullptr; }

private:
    PlaybackRenderer _playbackRenderer;
    EditorRenderer _editorRenderer;
    EditorView _editorView;
};

//! @} ARA_Library_Host_Dispatch_Plug-In_Interface_Wrappers

}   // namespace Host
}   // namespace ARA

#endif // ARAHostDispatch_h
