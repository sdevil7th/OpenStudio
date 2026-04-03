//------------------------------------------------------------------------------
//! \file       ARAPlugInDispatch.h
//!             C-to-C++ adapter for implementing ARA plug-ins
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

#ifndef ARAPlugInDispatch_h
#define ARAPlugInDispatch_h

#include "ARA_Library/Dispatch/ARADispatchBase.h"

namespace ARA {
namespace PlugIn {

//! @addtogroup ARA_Library_PlugIn_Dispatch
//! @{

/*******************************************************************************/
/** Optional ARA 1 backwards compatibility.
    Plug-ins can choose support ARA 1 hosts in addition to ARA 2 hosts.
    Plug-ins will have to implement a lot of fallbacks in addition to the support
    provided by this implementation:
    - create dummy region sequences for the playback regions, utilizing the
      context information provided via the companion APIs
    - implicitly derive ARA selection state from companion API actions
*/
/*******************************************************************************/
#if !defined (ARA_SUPPORT_VERSION_1)
    #define ARA_SUPPORT_VERSION_1 0
#endif

#if ARA_SUPPORT_VERSION_1 && ARA_CPU_ARM
    #error "ARA v1 is not supported on ARM architecture"
#endif

/*******************************************************************************/
/** Type safe conversions to/from ref: toRef () and fromRef<> ().
    This macro defines custom overloads of the toRef () and fromRef<> () conversion functions
    which act as type safe casts between your implementation class pointers and the opaque refs
    that the ARA API uses.
    fromRef<>() additionally allows for optional up-casting from base to derived classes if needed.
    The first macro argument is your implementation class, followed by all ref types that you
    want this class to comply with.
    \br
    Whenever using your C++ object pointers as plug-in refs, you should apply the conversion macros like so:
    \code{.cpp}
        // declare the conversion in the appropriate header
        class MyAudioSource;
        ARA_MAP_REF (MyAudioSource, ARAAudioSourceRef)

        // whenever exporting refs to the host, use toRef ()
        MyAudioSource* audioSource = ...;
        ARAAudioSourceRef audioSourceRef = toRef (audioSource);

        // whenever the host passes a plug-in ref back to you, use fromRef<> ()
        ARAAudioSourceRef audioSourceRef;   // usually provided as argument to a function call
        MyAudioSource* audioSource = fromRef (audioSourceRef);
    \endcode
*/
/*******************************************************************************/

#if !defined (ARA_MAP_REF)
    #define ARA_MAP_REF(ClassType, FirstRefType, ...) \
        static inline ARA::ToRefConversionHelper<ClassType, FirstRefType, ##__VA_ARGS__> toRef (const ClassType* ptr) noexcept { return ARA::ToRefConversionHelper<ClassType, FirstRefType, ##__VA_ARGS__> { ptr }; } \
        template <typename DesiredClassType = ClassType, typename RefType, typename std::enable_if<std::is_constructible<ARA::FromRefConversionHelper<ClassType, FirstRefType, ##__VA_ARGS__>, RefType>::value, bool>::type = true> \
        static inline DesiredClassType* fromRef (RefType ref) noexcept { ClassType* object { ARA::FromRefConversionHelper<ClassType, FirstRefType, ##__VA_ARGS__> (ref) }; return static_cast<DesiredClassType*> (object); }
#endif

/*******************************************************************************/
/** Tag objects maintained by the host to prevent accidentally copying/moving them. */
/*******************************************************************************/

#if !defined (ARA_HOST_MANAGED_OBJECT)
    #define ARA_HOST_MANAGED_OBJECT ARA_DISABLE_COPY_AND_MOVE
#endif

/*******************************************************************************/
// Properties
/** Template to conveniently evaluate pointers to ARA variable-sized properties structs. */
/*******************************************************************************/

template <typename StructType>
using PropertiesPtr = SizedStructPtr<StructType>;

//! @defgroup ARA_Library_Host_Dispatch_Plug-In_Interfaces Plug-In Interfaces
//! @{

/*******************************************************************************/
// DocumentController
/** Base class for implementing ARADocumentControllerInterface. */
/*******************************************************************************/

class DocumentControllerInterface
{
public:
    virtual ~DocumentControllerInterface () = default;

//! @name Destruction
//@{
    //! \copydoc ARADocumentControllerInterface::destroyDocumentController
    virtual void destroyDocumentController () noexcept = 0;
//@}

//! @name Factory
    //! \copydoc ARADocumentControllerInterface::getFactory
    virtual const ARAFactory* getFactory () const noexcept = 0;
//@}

//! @name Update Management
//@{
    //! \copydoc ARADocumentControllerInterface::beginEditing
    virtual void beginEditing () noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::endEditing
    virtual void endEditing () noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::notifyModelUpdates
    virtual void notifyModelUpdates () noexcept = 0;
//@}

//! @name Archiving
//@{
    //! \copydoc ARADocumentControllerInterface::restoreObjectsFromArchive
    virtual bool restoreObjectsFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::storeObjectsToArchive
    virtual bool storeObjectsToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::storeAudioSourceToAudioFileChunk
    virtual bool storeAudioSourceToAudioFileChunk (ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept = 0;
//@}

//! @name Document Management
//@{
    //! \copydoc ARADocumentControllerInterface::updateDocumentProperties
    virtual void updateDocumentProperties (PropertiesPtr<ARADocumentProperties> properties) noexcept = 0;
//@}

//! @name Musical Context Management
//@{
    //! \copydoc ARADocumentControllerInterface::createMusicalContext
    virtual ARAMusicalContextRef createMusicalContext (ARAMusicalContextHostRef hostRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateMusicalContextProperties
    virtual void updateMusicalContextProperties (ARAMusicalContextRef musicalContextRef, PropertiesPtr<ARAMusicalContextProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateMusicalContextContent
    virtual void updateMusicalContextContent (ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyMusicalContext
    virtual void destroyMusicalContext (ARAMusicalContextRef musicalContextRef) noexcept = 0;
//@}

//! @name Region Sequence Management
//@{
    //! \copydoc ARADocumentControllerInterface::createRegionSequence
    virtual ARARegionSequenceRef createRegionSequence (ARARegionSequenceHostRef hostRef, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateRegionSequenceProperties
    virtual void updateRegionSequenceProperties (ARARegionSequenceRef regionSequence, PropertiesPtr<ARARegionSequenceProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyRegionSequence
    virtual void destroyRegionSequence (ARARegionSequenceRef regionSequence) noexcept = 0;
//@}

//! @name Audio Source Management
//@{
    //! \copydoc ARADocumentControllerInterface::createAudioSource
    virtual ARAAudioSourceRef createAudioSource (ARAAudioSourceHostRef hostRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateAudioSourceProperties
    virtual void updateAudioSourceProperties (ARAAudioSourceRef audioSourceRef, PropertiesPtr<ARAAudioSourceProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateAudioSourceContent
    virtual void updateAudioSourceContent (ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::enableAudioSourceSamplesAccess
    virtual void enableAudioSourceSamplesAccess (ARAAudioSourceRef audioSourceRef, bool enable) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::deactivateAudioSourceForUndoHistory
    virtual void deactivateAudioSourceForUndoHistory (ARAAudioSourceRef audioSourceRef, bool deactivate) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyAudioSource
    virtual void destroyAudioSource (ARAAudioSourceRef audioSourceRef) noexcept = 0;
//@}

//! @name Audio Modification Management
//@{
    //! \copydoc ARADocumentControllerInterface::createAudioModification
    virtual ARAAudioModificationRef createAudioModification (ARAAudioSourceRef audioSourceRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::cloneAudioModification
    virtual ARAAudioModificationRef cloneAudioModification (ARAAudioModificationRef audioModificationRef, ARAAudioModificationHostRef hostRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updateAudioModificationProperties
    virtual void updateAudioModificationProperties (ARAAudioModificationRef audioModificationRef, PropertiesPtr<ARAAudioModificationProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::isAudioModificationPreservingAudioSourceSignal
    virtual bool isAudioModificationPreservingAudioSourceSignal (ARAAudioModificationRef audioModificationRef) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::deactivateAudioModificationForUndoHistory
    virtual void deactivateAudioModificationForUndoHistory (ARAAudioModificationRef audioModificationRef, bool deactivate) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyAudioModification
    virtual void destroyAudioModification (ARAAudioModificationRef audioModificationRef) noexcept = 0;
//@}

//! @name Playback Region Management
//@{
    //! \copydoc ARADocumentControllerInterface::createPlaybackRegion
    virtual ARAPlaybackRegionRef createPlaybackRegion (ARAAudioModificationRef audioModificationRef, ARAPlaybackRegionHostRef hostRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::updatePlaybackRegionProperties
    virtual void updatePlaybackRegionProperties (ARAPlaybackRegionRef playbackRegionRef, PropertiesPtr<ARAPlaybackRegionProperties> properties) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyPlaybackRegion
    virtual void destroyPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getPlaybackRegionHeadAndTailTime
    virtual void getPlaybackRegionHeadAndTailTime (ARAPlaybackRegionRef playbackRegionRef, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept = 0;
//@}

//! @name Content Reader Management
//@{
    //! \copydoc ARADocumentControllerInterface::isAudioSourceContentAvailable
    virtual bool isAudioSourceContentAvailable (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getAudioSourceContentGrade
    virtual ARAContentGrade getAudioSourceContentGrade (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::createAudioSourceContentReader
    virtual ARAContentReaderRef createAudioSourceContentReader (ARAAudioSourceRef audioSourceRef, ARAContentType type, const ARAContentTimeRange* range) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::isAudioModificationContentAvailable
    virtual bool isAudioModificationContentAvailable (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getAudioModificationContentGrade
    virtual ARAContentGrade getAudioModificationContentGrade (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::createAudioModificationContentReader
    virtual ARAContentReaderRef createAudioModificationContentReader (ARAAudioModificationRef audioModificationRef, ARAContentType type, const ARAContentTimeRange* range) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::isPlaybackRegionContentAvailable
    virtual bool isPlaybackRegionContentAvailable (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getPlaybackRegionContentGrade
    virtual ARAContentGrade getPlaybackRegionContentGrade (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::createPlaybackRegionContentReader
    virtual ARAContentReaderRef createPlaybackRegionContentReader (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type, const ARAContentTimeRange* range) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getContentReaderEventCount
    virtual ARAInt32 getContentReaderEventCount (ARAContentReaderRef contentReaderRef) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getContentReaderDataForEvent
    virtual const void* getContentReaderDataForEvent (ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::destroyContentReader
    virtual void destroyContentReader (ARAContentReaderRef contentReaderRef) noexcept = 0;
//@}

//! @name Controlling Analysis
//@{
    //! \copydoc ARADocumentControllerInterface::isAudioSourceContentAnalysisIncomplete
    virtual bool isAudioSourceContentAnalysisIncomplete (ARAAudioSourceRef audioSourceRef, ARAContentType contentType) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::requestAudioSourceContentAnalysis
    virtual void requestAudioSourceContentAnalysis (ARAAudioSourceRef audioSourceRef, ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept = 0;

    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmsCount
    virtual ARAInt32 getProcessingAlgorithmsCount () noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmProperties
    virtual const ARAProcessingAlgorithmProperties* getProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::getProcessingAlgorithmForAudioSource
    virtual ARAInt32 getProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef) noexcept = 0;
    //! \copydoc ARADocumentControllerInterface::requestProcessingAlgorithmForAudioSource
    virtual void requestProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept = 0;
//@}

//! @name License Management
//@{
    //! \copydoc ARADocumentControllerInterface::isLicensedForCapabilities
    virtual bool isLicensedForCapabilities (bool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept = 0;
//@}
};
ARA_MAP_REF (DocumentControllerInterface, ARADocumentControllerRef)

/*******************************************************************************/
// DocumentControllerInstance
/** Wrapper class for the ARADocumentControllerInstance. */
/*******************************************************************************/

class DocumentControllerInstance : public SizedStruct<ARA_STRUCT_MEMBER (ARADocumentControllerInstance, documentControllerInterface)>
{
public:
    explicit DocumentControllerInstance (DocumentControllerInterface* documentController) noexcept;

    DocumentControllerInterface* getDocumentController () const noexcept
    { return fromRef (documentControllerRef); }
};

/*******************************************************************************/
// PlaybackRendererInterface
/** Base class for implementing ARAPlaybackRendererInterface. */
/*******************************************************************************/

class PlaybackRendererInterface
{
public:
    virtual ~PlaybackRendererInterface () = default;

//! @name Assigning the playback region(s) for playback rendering
//! For details, see \ref Assigning_ARAPlaybackRendererInterface_Regions "ARAPlaybackRendererInterface".
//@{
    virtual void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept = 0;
    virtual void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept = 0;
//@}
};
ARA_MAP_REF (PlaybackRendererInterface, ARAPlaybackRendererRef)

/*******************************************************************************/
// EditorRendererInterface
/** Base class for implementing ARAEditorRendererInterface. */
/*******************************************************************************/

class EditorRendererInterface
{
public:
    virtual ~EditorRendererInterface () = default;

//! @name Assigning the playback region(s) for preview while editing
//! For details, see \ref Assigning_ARAEditorRendererInterface_Regions "ARAEditorRendererInterface".
//@{
    virtual void addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept = 0;
    virtual void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept = 0;
    virtual void addRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept = 0;
    virtual void removeRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept = 0;
//@}
};
ARA_MAP_REF (EditorRendererInterface, ARAEditorRendererRef)

/*******************************************************************************/
// EditorViewInterface
/** Base class for implementing ARAEditorViewInterface. */
/*******************************************************************************/

class EditorViewInterface
{
public:
    virtual ~EditorViewInterface () = default;

//! @name Host UI notifications
//@{
    //! \copydoc ARAEditorViewInterface::notifySelection
    virtual void notifySelection (SizedStructPtr<ARAViewSelection> selection) noexcept = 0;
    //! \copydoc ARAEditorViewInterface::notifyHideRegionSequences
    virtual void notifyHideRegionSequences (ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept = 0;
//@}
};
ARA_MAP_REF (EditorViewInterface, ARAEditorViewRef)

/*******************************************************************************/
// PlugInExtensionInstance
/** Wrapper class for ARAPlugInExtensionInstance. */
/*******************************************************************************/

class PlugInExtensionInstance : public SizedStruct<ARA_STRUCT_MEMBER (ARAPlugInExtensionInstance, editorViewInterface)>
{
public:
    explicit PlugInExtensionInstance (PlaybackRendererInterface* playbackRenderer, EditorRendererInterface* editorRenderer, EditorViewInterface* editorView) noexcept;

    PlaybackRendererInterface* getPlaybackRenderer () const noexcept
    { return fromRef (playbackRendererRef); }

    EditorRendererInterface* getEditorRenderer () const noexcept
    { return fromRef (editorRendererRef); }

    EditorViewInterface* getEditorView () const noexcept
    { return fromRef (editorViewRef); }

#if ARA_SUPPORT_VERSION_1
    void setPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;
    void removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept;

private:
    ARAPlaybackRegionRef _playbackRegionRef { nullptr };    // only valid if _hasPlaybackRegion is true
    bool _hasPlaybackRegion { false };
#endif
};

//! @}

//! @addtogroup ARA_Library_Host_Dispatch_Host_Interface_Wrappers Host Interface Wrappers
//! Wrappers for the interfaces used to communicate with and control the ARA host.
//! @{

/*******************************************************************************/
// HostAudioAccessController
/** Wrapper class for the ARAAudioAccessControllerInterface provided by the host. */
/*******************************************************************************/

class HostAudioAccessController : public InterfaceInstance<ARAAudioAccessControllerHostRef, ARAAudioAccessControllerInterface>
{
public:
    explicit HostAudioAccessController (const ARADocumentControllerHostInstance* instance) noexcept
    : BaseType { instance->audioAccessControllerHostRef, instance->audioAccessControllerInterface }
    {}

    //! \copydoc ARAAudioAccessControllerInterface::createAudioReaderForSource
    ARAAudioReaderHostRef createAudioReaderForSource (ARAAudioSourceHostRef audioSourceHostRef, bool use64BitSamples) noexcept;
    //! \copydoc ARAAudioAccessControllerInterface::readAudioSamples
    bool readAudioSamples (ARAAudioReaderHostRef audioReaderHostRef,
                           ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) noexcept;
    //! \copydoc ARAAudioAccessControllerInterface::destroyAudioReader
    void destroyAudioReader (ARAAudioReaderHostRef audioReaderHostRef) noexcept;
};

/*******************************************************************************/
// HostArchivingController
/** Wrapper class for the ARAArchivingControllerInterface provided by the host. */
/*******************************************************************************/

class HostArchivingController : public InterfaceInstance<ARAArchivingControllerHostRef, ARAArchivingControllerInterface>
{
public:
    explicit HostArchivingController (const ARADocumentControllerHostInstance* instance) noexcept
    : BaseType { instance->archivingControllerHostRef, instance->archivingControllerInterface }
    {}

    //! \copydoc ARAArchivingControllerInterface::getArchiveSize
    ARASize getArchiveSize (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept;
    //! \copydoc ARAArchivingControllerInterface::readBytesFromArchive
    bool readBytesFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef,
                               ARASize position, ARASize length, ARAByte buffer[]) noexcept;
    //! \copydoc ARAArchivingControllerInterface::writeBytesToArchive
    bool writeBytesToArchive (ARAArchiveWriterHostRef archiveWriterHostRef,
                              ARASize position, ARASize length, const ARAByte buffer[]) noexcept;
    //! \copydoc ARAArchivingControllerInterface::notifyDocumentArchivingProgress
    void notifyDocumentArchivingProgress (float value) noexcept;
    //! \copydoc ARAArchivingControllerInterface::notifyDocumentUnarchivingProgress
    void notifyDocumentUnarchivingProgress (float value) noexcept;
    //! \copydoc ARAArchivingControllerInterface::getDocumentArchiveID
    ARAPersistentID getDocumentArchiveID (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept;
};

/*******************************************************************************/
// HostContentAccessController
/** Wrapper class for the ARAContentAccessControllerInterface by the host.
    Note that ARAPlug.h includes convenient wrappers for content readers via the HostContentReader
    classes that allow to use them with stl iterators and also provide additional validation.
*/
/*******************************************************************************/

class HostContentAccessController : public InterfaceInstance<ARAContentAccessControllerHostRef, ARAContentAccessControllerInterface>
{
public:
    explicit HostContentAccessController (const ARADocumentControllerHostInstance* instance) noexcept
    : BaseType { instance->contentAccessControllerHostRef, instance->contentAccessControllerInterface }
    {}

    //! \copydoc ARAContentAccessControllerInterface::isMusicalContextContentAvailable
    bool isMusicalContextContentAvailable (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType contentType) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::getMusicalContextContentGrade
    ARAContentGrade getMusicalContextContentGrade (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType contentType) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::createMusicalContextContentReader
    ARAContentReaderHostRef createMusicalContextContentReader (ARAMusicalContextHostRef musicalContextHostRef,
                                                               ARAContentType contentType, const ARAContentTimeRange* range) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::isAudioSourceContentAvailable
    bool isAudioSourceContentAvailable (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType contentType) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::getAudioSourceContentGrade
    ARAContentGrade getAudioSourceContentGrade (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType contentType) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::createAudioSourceContentReader
    ARAContentReaderHostRef createAudioSourceContentReader (ARAAudioSourceHostRef audioSourceHostRef,
                                                            ARAContentType contentType, const ARAContentTimeRange* range) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::getContentReaderEventCount
    ARAInt32 getContentReaderEventCount (ARAContentReaderHostRef contentReaderHostRef) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::getContentReaderDataForEvent
    const void* getContentReaderDataForEvent (ARAContentReaderHostRef contentReaderHostRef, ARAInt32 eventIndex) noexcept;
    //! \copydoc ARAContentAccessControllerInterface::destroyContentReader
    void destroyContentReader (ARAContentReaderHostRef contentReaderHostRef) noexcept;
};

/*******************************************************************************/
// HostModelUpdateController
/** Wrapper class for the ARAModelUpdateControllerInterface provided by the host. */
/*******************************************************************************/

class HostModelUpdateController : public InterfaceInstance<ARAModelUpdateControllerHostRef, ARAModelUpdateControllerInterface>
{
public:
    explicit HostModelUpdateController (const ARADocumentControllerHostInstance* instance) noexcept
    : BaseType { instance->modelUpdateControllerHostRef, instance->modelUpdateControllerInterface }
    {}

    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioSourceAnalysisProgress
    void notifyAudioSourceAnalysisProgress (ARAAudioSourceHostRef audioSourceHostRef,
                                            ARAAnalysisProgressState state, float value) noexcept;
    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioSourceContentChanged
    void notifyAudioSourceContentChanged (ARAAudioSourceHostRef audioSourceHostRef,
                                          const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept;
    //! \copydoc ARAModelUpdateControllerInterface::notifyAudioModificationContentChanged
    void notifyAudioModificationContentChanged (ARAAudioModificationHostRef audioModificationHostRef,
                                                const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept;
    //! \copydoc ARAModelUpdateControllerInterface::notifyPlaybackRegionContentChanged
    void notifyPlaybackRegionContentChanged (ARAPlaybackRegionHostRef playbackRegionHostRef,
                                             const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept;
};

/*******************************************************************************/
// HostPlaybackController
/** Wrapper class for the ARAPlaybackControllerInterface provided by the host. */
/*******************************************************************************/

class HostPlaybackController : public InterfaceInstance<ARAPlaybackControllerHostRef, ARAPlaybackControllerInterface>
{
public:
    explicit HostPlaybackController (const ARADocumentControllerHostInstance* instance) noexcept
    : BaseType { instance->playbackControllerHostRef, instance->playbackControllerInterface }
    {}

    //! \copydoc ARAPlaybackControllerInterface::requestStartPlayback
    void requestStartPlayback () noexcept;
    //! \copydoc ARAPlaybackControllerInterface::requestStopPlayback
    void requestStopPlayback () noexcept;
    //! \copydoc ARAPlaybackControllerInterface::requestSetPlaybackPosition
    void requestSetPlaybackPosition (ARATimePosition timePosition) noexcept;
    //! \copydoc ARAPlaybackControllerInterface::requestSetCycleRange
    void requestSetCycleRange (ARATimePosition startTime, ARATimeDuration duration) noexcept;
    //! \copydoc ARAPlaybackControllerInterface::requestEnableCycle
    void requestEnableCycle (bool enable) noexcept;
};

//! @} ARA_Library_Host_Dispatch_Host_Interface_Wrappers

//! @} ARA_Library_PlugIn_Dispatch

}   // namespace PlugIn
}   // namespace ARA

#endif // ARAPlugInDispatch_h
