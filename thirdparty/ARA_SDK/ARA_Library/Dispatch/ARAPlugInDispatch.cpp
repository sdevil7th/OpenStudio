//------------------------------------------------------------------------------
//! \file       ARAPlugInDispatch.cpp
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

#include "ARAPlugInDispatch.h"

namespace ARA {
namespace PlugIn {

/*******************************************************************************/
// DocumentControllerDispatcher
/*******************************************************************************/

namespace DocumentControllerDispatcher
{
    // Destruction

    static void ARA_CALL destroyDocumentController (ARADocumentControllerRef controllerRef) noexcept
    {
        fromRef (controllerRef)->destroyDocumentController ();
    }

    // Factory

    static const ARAFactory* ARA_CALL getFactory (ARADocumentControllerRef controllerRef) noexcept
    {
        return fromRef (controllerRef)->getFactory ();
    }

    // Update Management

    static void ARA_CALL beginEditing (ARADocumentControllerRef controllerRef) noexcept
    {
        fromRef (controllerRef)->beginEditing ();
    }

    static void ARA_CALL endEditing (ARADocumentControllerRef controllerRef) noexcept
    {
        fromRef (controllerRef)->endEditing ();
    }

    static void ARA_CALL notifyModelUpdates (ARADocumentControllerRef controllerRef) noexcept
    {
        fromRef (controllerRef)->notifyModelUpdates ();
    }

    // Archiving

    static ARABool ARA_CALL beginRestoringDocumentFromArchive (ARADocumentControllerRef controllerRef, ARAArchiveReaderHostRef /*archiveReaderHostRef*/) noexcept
    {
        // begin-/endRestoringDocumentFromArchive () is deprecated, but can be fully mapped to supported calls
        fromRef (controllerRef)->beginEditing ();
        return kARATrue;
    }

    static ARABool ARA_CALL endRestoringDocumentFromArchive (ARADocumentControllerRef controllerRef, ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
    {
        // begin-/endRestoringDocumentFromArchive () is deprecated, but can be fully mapped to supported calls
        const auto result { fromRef (controllerRef)->restoreObjectsFromArchive (archiveReaderHostRef, nullptr) };
        fromRef (controllerRef)->endEditing ();
        return (result) ? kARATrue : kARAFalse;
    }

    static ARABool ARA_CALL storeDocumentToArchive (ARADocumentControllerRef controllerRef, ARAArchiveWriterHostRef archiveWriterHostRef) noexcept
    {
        // storeDocumentToArchive () is deprecated, but can be fully mapped to supported calls
        return (fromRef (controllerRef)->storeObjectsToArchive (archiveWriterHostRef, nullptr)) ? kARATrue : kARAFalse;
    }

    static ARABool ARA_CALL restoreObjectsFromArchive (ARADocumentControllerRef controllerRef, ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept
    {
        return (fromRef (controllerRef)->restoreObjectsFromArchive (archiveReaderHostRef, filter)) ? kARATrue : kARAFalse;
    }

    static ARABool ARA_CALL storeObjectsToArchive (ARADocumentControllerRef controllerRef, ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept
    {
        return (fromRef (controllerRef)->storeObjectsToArchive (archiveWriterHostRef, filter)) ? kARATrue : kARAFalse;
    }

    static ARABool ARA_CALL storeAudioSourceToAudioFileChunk (ARADocumentControllerRef controllerRef, ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, ARABool* openAutomatically) noexcept
    {
        bool autoOpen { false };
        const auto result {fromRef (controllerRef)->storeAudioSourceToAudioFileChunk (archiveWriterHostRef, audioSourceRef, documentArchiveID, &autoOpen) };
        *openAutomatically = (autoOpen) ? kARATrue : kARAFalse;
        return (result) ? kARATrue : kARAFalse;
    }

    // Document Management

    static void ARA_CALL updateDocumentProperties (ARADocumentControllerRef controllerRef, const ARADocumentProperties* properties) noexcept
    {
        fromRef (controllerRef)->updateDocumentProperties (properties);
    }

    // Musical Context Management

    static ARAMusicalContextRef ARA_CALL createMusicalContext (ARADocumentControllerRef controllerRef, ARAMusicalContextHostRef hostRef, const ARAMusicalContextProperties* properties) noexcept
    {
        return fromRef (controllerRef)->createMusicalContext (hostRef, properties);
    }

    static void ARA_CALL updateMusicalContextProperties (ARADocumentControllerRef controllerRef, ARAMusicalContextRef musicalContext, const ARAMusicalContextProperties* properties) noexcept
    {
        fromRef (controllerRef)->updateMusicalContextProperties (musicalContext, properties);
    }

    static void ARA_CALL destroyMusicalContext (ARADocumentControllerRef controllerRef, ARAMusicalContextRef musicalContext) noexcept
    {
        fromRef (controllerRef)->destroyMusicalContext (musicalContext);
    }

    static void ARA_CALL updateMusicalContextContent (ARADocumentControllerRef controllerRef, ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ARAContentUpdateFlags flags) noexcept
    {
        fromRef (controllerRef)->updateMusicalContextContent (musicalContextRef, range, flags);
    }

    // Region Sequence Management

    static ARARegionSequenceRef ARA_CALL createRegionSequence (ARADocumentControllerRef controllerRef, ARARegionSequenceHostRef hostRef, const ARARegionSequenceProperties* properties) noexcept
    {
        return fromRef (controllerRef)->createRegionSequence (hostRef, properties);
    }

    static void ARA_CALL updateRegionSequenceProperties (ARADocumentControllerRef controllerRef, ARARegionSequenceRef regionSequenceRef, const ARARegionSequenceProperties* properties) noexcept
    {
        fromRef (controllerRef)->updateRegionSequenceProperties (regionSequenceRef, properties);
    }

    static void ARA_CALL destroyRegionSequence (ARADocumentControllerRef controllerRef, ARARegionSequenceRef regionSequenceRef) noexcept
    {
        fromRef (controllerRef)->destroyRegionSequence (regionSequenceRef);
    }

    // Audio Source Management

    static ARAAudioSourceRef ARA_CALL createAudioSource (ARADocumentControllerRef controllerRef, ARAAudioSourceHostRef hostRef, const ARAAudioSourceProperties* properties) noexcept
    {
        return fromRef (controllerRef)->createAudioSource (hostRef, properties);
    }

    static void ARA_CALL updateAudioSourceProperties (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, const ARAAudioSourceProperties* properties) noexcept
    {
        fromRef (controllerRef)->updateAudioSourceProperties (audioSourceRef, properties);
    }

    static void ARA_CALL updateAudioSourceContent (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ARAContentUpdateFlags flags) noexcept
    {
        fromRef (controllerRef)->updateAudioSourceContent (audioSourceRef, range, flags);
    }

    static void ARA_CALL enableAudioSourceSamplesAccess (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARABool enable) noexcept
    {
        fromRef (controllerRef)->enableAudioSourceSamplesAccess (audioSourceRef, enable != kARAFalse);
    }

    static void ARA_CALL deactivateAudioSourceForUndoHistory (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARABool enable) noexcept
    {
        fromRef (controllerRef)->deactivateAudioSourceForUndoHistory (audioSourceRef, enable != kARAFalse);
    }

    static void ARA_CALL destroyAudioSource (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef) noexcept
    {
        fromRef (controllerRef)->destroyAudioSource (audioSourceRef);
    }

    // Audio Modification Management

    static ARAAudioModificationRef ARA_CALL createAudioModification (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef,
                                                                     ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept
    {
        return fromRef (controllerRef)->createAudioModification (audioSourceRef, hostRef, properties);
    }

    static ARAAudioModificationRef ARA_CALL cloneAudioModification (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef,
                                                                    ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept
    {
        return fromRef (controllerRef)->cloneAudioModification (audioModificationRef, hostRef, properties);
    }

    static void ARA_CALL updateAudioModificationProperties (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef, const ARAAudioModificationProperties* properties) noexcept
    {
        fromRef (controllerRef)->updateAudioModificationProperties (audioModificationRef, properties);
    }

    static ARABool ARA_CALL isAudioModificationPreservingAudioSourceSignal (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef) noexcept
    {
        return fromRef (controllerRef)->isAudioModificationPreservingAudioSourceSignal (audioModificationRef) ? kARATrue : kARAFalse;
    }

    static void ARA_CALL deactivateAudioModificationForUndoHistory (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef, ARABool enable) noexcept
    {
        fromRef (controllerRef)->deactivateAudioModificationForUndoHistory (audioModificationRef, enable != kARAFalse);
    }

    static void ARA_CALL destroyAudioModification (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef) noexcept
    {
        fromRef (controllerRef)->destroyAudioModification (audioModificationRef);
    }

    // Playback Region Management

    static ARAPlaybackRegionRef ARA_CALL createPlaybackRegion (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef,
                                                               ARAPlaybackRegionHostRef hostRef, const ARAPlaybackRegionProperties* properties) noexcept
    {
        return fromRef (controllerRef)->createPlaybackRegion (audioModificationRef, hostRef, properties);
    }

    static void ARA_CALL updatePlaybackRegionProperties (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef, const ARAPlaybackRegionProperties* properties) noexcept
    {
        fromRef (controllerRef)->updatePlaybackRegionProperties (playbackRegionRef, properties);
    }

    static void ARA_CALL destroyPlaybackRegion (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (controllerRef)->destroyPlaybackRegion (playbackRegionRef);
    }

    static void ARA_CALL getPlaybackRegionHeadAndTailTime (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef,
                                                           ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept
    {
        fromRef (controllerRef)->getPlaybackRegionHeadAndTailTime (playbackRegionRef, headTime, tailTime);
    }

    // Content Reader Management

    static ARABool ARA_CALL isAudioSourceContentAvailable (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
    {
        return (fromRef (controllerRef)->isAudioSourceContentAvailable (audioSourceRef, type)) ? kARATrue : kARAFalse;
    }

    static ARAContentGrade ARA_CALL getAudioSourceContentGrade (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
    {
        return fromRef (controllerRef)->getAudioSourceContentGrade (audioSourceRef, type);
    }

    static ARAContentReaderRef ARA_CALL createAudioSourceContentReader (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef,
                                                                        ARAContentType type, const ARAContentTimeRange* range) noexcept
    {
        return fromRef (controllerRef)->createAudioSourceContentReader (audioSourceRef, type, range);
    }

    static ARABool ARA_CALL isAudioModificationContentAvailable (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
    {
        return (fromRef (controllerRef)->isAudioModificationContentAvailable (audioModificationRef, type)) ? kARATrue : kARAFalse;
    }

    static ARAContentGrade ARA_CALL getAudioModificationContentGrade (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
    {
        return fromRef (controllerRef)->getAudioModificationContentGrade (audioModificationRef, type);
    }

    static ARAContentReaderRef ARA_CALL createAudioModificationContentReader (ARADocumentControllerRef controllerRef, ARAAudioModificationRef audioModificationRef,
                                                                              ARAContentType type, const ARAContentTimeRange* range) noexcept
    {
        return fromRef (controllerRef)->createAudioModificationContentReader (audioModificationRef, type, range);
    }

    static ARABool ARA_CALL isPlaybackRegionContentAvailable (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
    {
        return (fromRef (controllerRef)->isPlaybackRegionContentAvailable (playbackRegionRef, type)) ? kARATrue : kARAFalse;
    }

    static ARAContentGrade ARA_CALL getPlaybackRegionContentGrade (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
    {
        return fromRef (controllerRef)->getPlaybackRegionContentGrade (playbackRegionRef, type);
    }

    static ARAContentReaderRef ARA_CALL createPlaybackRegionContentReader (ARADocumentControllerRef controllerRef, ARAPlaybackRegionRef playbackRegionRef,
                                                                           ARAContentType type, const ARAContentTimeRange* range) noexcept
    {
        return fromRef (controllerRef)->createPlaybackRegionContentReader (playbackRegionRef, type, range);
    }

    static ARAInt32 ARA_CALL getContentReaderEventCount (ARADocumentControllerRef controllerRef, ARAContentReaderRef contentReaderRef) noexcept
    {
        return fromRef (controllerRef)->getContentReaderEventCount (contentReaderRef);
    }

    static const void* ARA_CALL getContentReaderDataForEvent (ARADocumentControllerRef controllerRef, ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept
    {
        return fromRef (controllerRef)->getContentReaderDataForEvent (contentReaderRef, eventIndex);
    }

    static void ARA_CALL destroyContentReader (ARADocumentControllerRef controllerRef, ARAContentReaderRef contentReaderRef) noexcept
    {
        fromRef (controllerRef)->destroyContentReader (contentReaderRef);
    }

    // Controlling Analysis

    static ARABool ARA_CALL isAudioSourceContentAnalysisIncomplete (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
    {
        return (fromRef (controllerRef)->isAudioSourceContentAnalysisIncomplete (audioSourceRef, type)) ? kARATrue : kARAFalse;
    }

    static void ARA_CALL requestAudioSourceContentAnalysis (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef,
                                                            ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept
    {
        fromRef (controllerRef)->requestAudioSourceContentAnalysis (audioSourceRef, contentTypesCount, contentTypes);
    }

    static ARAInt32 ARA_CALL getProcessingAlgorithmsCount (ARADocumentControllerRef controllerRef) noexcept
    {
        return fromRef (controllerRef)->getProcessingAlgorithmsCount ();
    }

    static const ARAProcessingAlgorithmProperties* ARA_CALL getProcessingAlgorithmProperties (ARADocumentControllerRef controllerRef, ARAInt32 algorithmIndex) noexcept
    {
        return fromRef (controllerRef)->getProcessingAlgorithmProperties (algorithmIndex);
    }

    static ARAInt32 ARA_CALL getProcessingAlgorithmForAudioSource (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef) noexcept
    {
        return fromRef (controllerRef)->getProcessingAlgorithmForAudioSource (audioSourceRef);
    }

    static void ARA_CALL requestProcessingAlgorithmForAudioSource (ARADocumentControllerRef controllerRef, ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept
    {
        fromRef (controllerRef)->requestProcessingAlgorithmForAudioSource (audioSourceRef, algorithmIndex);
    }

    // License Management

    static ARABool ARA_CALL isLicensedForCapabilities (ARADocumentControllerRef controllerRef, ARABool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept
    {
        return (fromRef (controllerRef)->isLicensedForCapabilities ((runModalActivationDialogIfNeeded != kARAFalse), contentTypesCount, contentTypes, transformationFlags)) ? kARATrue : kARAFalse;
    }

    static const ARADocumentControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, isAudioModificationPreservingAudioSourceSignal)> ifc =
        {
            DocumentControllerDispatcher::destroyDocumentController,
            DocumentControllerDispatcher::getFactory,
            DocumentControllerDispatcher::beginEditing,
            DocumentControllerDispatcher::endEditing,
            DocumentControllerDispatcher::notifyModelUpdates,
            DocumentControllerDispatcher::beginRestoringDocumentFromArchive,
            DocumentControllerDispatcher::endRestoringDocumentFromArchive,
            DocumentControllerDispatcher::storeDocumentToArchive,
            DocumentControllerDispatcher::updateDocumentProperties,
            DocumentControllerDispatcher::createMusicalContext,
            DocumentControllerDispatcher::updateMusicalContextProperties,
            DocumentControllerDispatcher::updateMusicalContextContent,
            DocumentControllerDispatcher::destroyMusicalContext,
            DocumentControllerDispatcher::createAudioSource,
            DocumentControllerDispatcher::updateAudioSourceProperties,
            DocumentControllerDispatcher::updateAudioSourceContent,
            DocumentControllerDispatcher::enableAudioSourceSamplesAccess,
            DocumentControllerDispatcher::deactivateAudioSourceForUndoHistory,
            DocumentControllerDispatcher::destroyAudioSource,
            DocumentControllerDispatcher::createAudioModification,
            DocumentControllerDispatcher::cloneAudioModification,
            DocumentControllerDispatcher::updateAudioModificationProperties,
            DocumentControllerDispatcher::deactivateAudioModificationForUndoHistory,
            DocumentControllerDispatcher::destroyAudioModification,
            DocumentControllerDispatcher::createPlaybackRegion,
            DocumentControllerDispatcher::updatePlaybackRegionProperties,
            DocumentControllerDispatcher::destroyPlaybackRegion,
            DocumentControllerDispatcher::isAudioSourceContentAvailable,
            DocumentControllerDispatcher::isAudioSourceContentAnalysisIncomplete,
            DocumentControllerDispatcher::requestAudioSourceContentAnalysis,
            DocumentControllerDispatcher::getAudioSourceContentGrade,
            DocumentControllerDispatcher::createAudioSourceContentReader,
            DocumentControllerDispatcher::isAudioModificationContentAvailable,
            DocumentControllerDispatcher::getAudioModificationContentGrade,
            DocumentControllerDispatcher::createAudioModificationContentReader,
            DocumentControllerDispatcher::isPlaybackRegionContentAvailable,
            DocumentControllerDispatcher::getPlaybackRegionContentGrade,
            DocumentControllerDispatcher::createPlaybackRegionContentReader,
            DocumentControllerDispatcher::getContentReaderEventCount,
            DocumentControllerDispatcher::getContentReaderDataForEvent,
            DocumentControllerDispatcher::destroyContentReader,
            DocumentControllerDispatcher::createRegionSequence,
            DocumentControllerDispatcher::updateRegionSequenceProperties,
            DocumentControllerDispatcher::destroyRegionSequence,
            DocumentControllerDispatcher::getPlaybackRegionHeadAndTailTime,
            DocumentControllerDispatcher::restoreObjectsFromArchive,
            DocumentControllerDispatcher::storeObjectsToArchive,
            DocumentControllerDispatcher::getProcessingAlgorithmsCount,
            DocumentControllerDispatcher::getProcessingAlgorithmProperties,
            DocumentControllerDispatcher::getProcessingAlgorithmForAudioSource,
            DocumentControllerDispatcher::requestProcessingAlgorithmForAudioSource,
            DocumentControllerDispatcher::isLicensedForCapabilities,
            DocumentControllerDispatcher::storeAudioSourceToAudioFileChunk,
            DocumentControllerDispatcher::isAudioModificationPreservingAudioSourceSignal
        };
        return &ifc;
    }
}

/*******************************************************************************/
// DocumentControllerInstance
/*******************************************************************************/

DocumentControllerInstance::DocumentControllerInstance (DocumentControllerInterface* documentController) noexcept
: BaseType { toRef (documentController), DocumentControllerDispatcher::getInterface () }
{}

/*******************************************************************************/
// PlaybackRendererDispatcher
/*******************************************************************************/

namespace PlaybackRendererDispatcher
{
    static void ARA_CALL addPlaybackRegion (ARAPlaybackRendererRef playbackRendererRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (playbackRendererRef)->addPlaybackRegion (playbackRegionRef);
    }

    static void ARA_CALL removePlaybackRegion (ARAPlaybackRendererRef playbackRendererRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (playbackRendererRef)->removePlaybackRegion (playbackRegionRef);
    }

    static const ARAPlaybackRendererInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackRendererInterface, removePlaybackRegion)> ifc =
        {
            PlaybackRendererDispatcher::addPlaybackRegion,
            PlaybackRendererDispatcher::removePlaybackRegion
        };
        return &ifc;
    }
}

/*******************************************************************************/
// EditorRendererDispatcher
/*******************************************************************************/

namespace EditorRendererDispatcher
{
    static void ARA_CALL addPlaybackRegion (ARAEditorRendererRef editorRendererRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (editorRendererRef)->addPlaybackRegion (playbackRegionRef);
    }

    static void ARA_CALL removePlaybackRegion (ARAEditorRendererRef editorRendererRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (editorRendererRef)->removePlaybackRegion (playbackRegionRef);
    }

    static void ARA_CALL addRegionSequence (ARAEditorRendererRef editorRendererRef, ARARegionSequenceRef regionSequenceRef) noexcept
    {
        fromRef (editorRendererRef)->addRegionSequence (regionSequenceRef);
    }

    static void ARA_CALL removeRegionSequence (ARAEditorRendererRef editorRendererRef, ARARegionSequenceRef regionSequenceRef) noexcept
    {
        fromRef (editorRendererRef)->removeRegionSequence (regionSequenceRef);
    }

    static const ARAEditorRendererInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAEditorRendererInterface, removeRegionSequence)> ifc =
        {
            EditorRendererDispatcher::addPlaybackRegion,
            EditorRendererDispatcher::removePlaybackRegion,
            EditorRendererDispatcher::addRegionSequence,
            EditorRendererDispatcher::removeRegionSequence
        };
        return &ifc;
    }
}

/*******************************************************************************/
// EditorViewDispatcher
/*******************************************************************************/

namespace EditorViewDispatcher
{
    static void ARA_CALL notifySelection (ARAEditorViewRef editorViewRef, const ARAViewSelection* selection) noexcept
    {
        fromRef (editorViewRef)->notifySelection (selection);
    }

    static void ARA_CALL notifyHideRegionSequences (ARAEditorViewRef editorViewRef, ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept
    {
        fromRef (editorViewRef)->notifyHideRegionSequences (regionSequenceRefsCount, regionSequenceRefs);
    }

    static const ARAEditorViewInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAEditorViewInterface, notifyHideRegionSequences)> ifc =
        {
            EditorViewDispatcher::notifySelection,
            EditorViewDispatcher::notifyHideRegionSequences
        };
        return &ifc;
    }
}

/*******************************************************************************/
// ARA1PlugInExtensionDispatcher
/*******************************************************************************/

#if ARA_SUPPORT_VERSION_1

ARA_MAP_REF (PlugInExtensionInstance, ARAPlugInExtensionRef)

namespace ARA1PlugInExtensionDispatcher
{
    static void ARA_CALL setPlaybackRegion (ARAPlugInExtensionRef plugInExtensionRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (plugInExtensionRef)->setPlaybackRegion (playbackRegionRef);
    }

    static void ARA_CALL removePlaybackRegion (ARAPlugInExtensionRef plugInExtensionRef, ARAPlaybackRegionRef playbackRegionRef) noexcept
    {
        fromRef (plugInExtensionRef)->removePlaybackRegion (playbackRegionRef);
    }

    static const ARAPlugInExtensionInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAPlugInExtensionInterface, removePlaybackRegion)> ifc =
        {
            ARA1PlugInExtensionDispatcher::setPlaybackRegion,
            ARA1PlugInExtensionDispatcher::removePlaybackRegion
        };
        return &ifc;
    }
}

#endif

/*******************************************************************************/
// PlugInExtensionInstance
/*******************************************************************************/

PlugInExtensionInstance::PlugInExtensionInstance (PlaybackRendererInterface* playbackRenderer, EditorRendererInterface* editorRenderer, EditorViewInterface* editorView) noexcept
#if ARA_SUPPORT_VERSION_1
: BaseType { toRef (this), ARA1PlugInExtensionDispatcher::getInterface (),
#else
: BaseType { nullptr, nullptr,
#endif
             toRef (playbackRenderer), (playbackRenderer) ? PlaybackRendererDispatcher::getInterface () : nullptr,
             toRef (editorRenderer), (editorRenderer) ? EditorRendererDispatcher::getInterface () : nullptr,
             toRef (editorView), (editorView) ? EditorViewDispatcher::getInterface () : nullptr }
{}

#if ARA_SUPPORT_VERSION_1
void PlugInExtensionInstance::setPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    if (_hasPlaybackRegion)
        removePlaybackRegion (_playbackRegionRef);

    if (getPlaybackRenderer ())
        getPlaybackRenderer ()->addPlaybackRegion (playbackRegionRef);
    if (getEditorRenderer ())
        getEditorRenderer ()->addPlaybackRegion (playbackRegionRef);

    _playbackRegionRef = playbackRegionRef;
    _hasPlaybackRegion = true;
}

void PlugInExtensionInstance::removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    if (getPlaybackRenderer ())
        getPlaybackRenderer ()->removePlaybackRegion (playbackRegionRef);
    if (getEditorRenderer ())
        getEditorRenderer ()->removePlaybackRegion (playbackRegionRef);

    _playbackRegionRef = nullptr;
    _hasPlaybackRegion = false;
}
#endif

/*******************************************************************************/
// AudioAccessController
/*******************************************************************************/

ARAAudioReaderHostRef HostAudioAccessController::createAudioReaderForSource (ARAAudioSourceHostRef audioSourceHostRef, bool use64BitSamples) noexcept
{
    return getInterface ()->createAudioReaderForSource (getRef (), audioSourceHostRef, (use64BitSamples) ? kARATrue : kARAFalse);
}

bool HostAudioAccessController::readAudioSamples (ARAAudioReaderHostRef audioReaderHostRef,
                                                 ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) noexcept
{
    return (getInterface ()->readAudioSamples (getRef (), audioReaderHostRef, samplePosition, samplesPerChannel, buffers) != kARAFalse);
}

void HostAudioAccessController::destroyAudioReader (ARAAudioReaderHostRef audioReaderHostRef) noexcept
{
    getInterface ()->destroyAudioReader (getRef (), audioReaderHostRef);
}

/*******************************************************************************/
// ArchivingController
/*******************************************************************************/

ARASize HostArchivingController::getArchiveSize (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
{
    return getInterface ()->getArchiveSize (getRef (), archiveReaderHostRef);
}

bool HostArchivingController::readBytesFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef,
                                                   ARASize position, ARASize length, ARAByte buffer[]) noexcept
{
    return (getInterface ()->readBytesFromArchive (getRef (), archiveReaderHostRef, position, length, buffer) != kARAFalse);
}

bool HostArchivingController::writeBytesToArchive (ARAArchiveWriterHostRef archiveWriterHostRef,
                                                  ARASize position, ARASize length, const ARAByte buffer[]) noexcept
{
    return (getInterface ()->writeBytesToArchive (getRef (), archiveWriterHostRef, position, length, buffer) != kARAFalse);
}

void HostArchivingController::notifyDocumentArchivingProgress (float value) noexcept
{
    getInterface ()->notifyDocumentArchivingProgress (getRef (), value);
}

void HostArchivingController::notifyDocumentUnarchivingProgress (float value) noexcept
{
    getInterface ()->notifyDocumentUnarchivingProgress (getRef (), value);
}

ARAPersistentID HostArchivingController::getDocumentArchiveID (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
{
    // getDocumentArchiveID() was added in the ARA 2.0 final release, so check its presence here to support older hosts
    if (getInterface ().implements<ARA_STRUCT_MEMBER (ARAArchivingControllerInterface, getDocumentArchiveID)> ())
        return getInterface ()->getDocumentArchiveID (getRef (), archiveReaderHostRef);
    return nullptr;
}

/*******************************************************************************/
// ContentAccessController
/*******************************************************************************/

bool HostContentAccessController::isMusicalContextContentAvailable (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType contentType) noexcept
{
    return (getInterface ()->isMusicalContextContentAvailable (getRef (), musicalContextHostRef, contentType) != kARAFalse);
}

ARAContentGrade HostContentAccessController::getMusicalContextContentGrade (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType contentType) noexcept
{
    return getInterface ()->getMusicalContextContentGrade (getRef (), musicalContextHostRef, contentType);
}

ARAContentReaderHostRef HostContentAccessController::createMusicalContextContentReader (ARAMusicalContextHostRef musicalContextHostRef, ARAContentType contentType, const ARAContentTimeRange* range) noexcept
{
    return getInterface ()->createMusicalContextContentReader (getRef (), musicalContextHostRef, contentType, range);
}

bool HostContentAccessController::isAudioSourceContentAvailable (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType contentType) noexcept
{
    return (getInterface ()->isAudioSourceContentAvailable (getRef (), audioSourceHostRef, contentType) != kARAFalse);
}

ARAContentGrade HostContentAccessController::getAudioSourceContentGrade (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType contentType) noexcept
{
    return getInterface ()->getAudioSourceContentGrade (getRef (), audioSourceHostRef, contentType);
}

ARAContentReaderHostRef HostContentAccessController::createAudioSourceContentReader (ARAAudioSourceHostRef audioSourceHostRef, ARAContentType contentType, const ARAContentTimeRange* range) noexcept
{
    return getInterface ()->createAudioSourceContentReader (getRef (), audioSourceHostRef, contentType, range);
}

ARAInt32 HostContentAccessController::getContentReaderEventCount (ARAContentReaderHostRef contentReaderHostRef) noexcept
{
    return getInterface ()->getContentReaderEventCount (getRef (), contentReaderHostRef);
}

const void* HostContentAccessController::getContentReaderDataForEvent (ARAContentReaderHostRef contentReaderHostRef, ARAInt32 eventIndex) noexcept
{
    return getInterface ()->getContentReaderDataForEvent (getRef (), contentReaderHostRef, eventIndex);
}

void HostContentAccessController::destroyContentReader (ARAContentReaderHostRef contentReaderHostRef) noexcept
{
    return getInterface ()->destroyContentReader (getRef (), contentReaderHostRef);
}

/*******************************************************************************/
// ModelUpdateController
/*******************************************************************************/

void HostModelUpdateController::notifyAudioSourceAnalysisProgress (ARAAudioSourceHostRef audioSourceHostRef,
                                                               ARAAnalysisProgressState state, float value) noexcept
{
    getInterface ()->notifyAudioSourceAnalysisProgress (getRef (), audioSourceHostRef, state, value);
}

void HostModelUpdateController::notifyAudioSourceContentChanged (ARAAudioSourceHostRef audioSourceHostRef,
                                                             const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept
{
    getInterface ()->notifyAudioSourceContentChanged (getRef (), audioSourceHostRef, range, scopeFlags);
}

void HostModelUpdateController::notifyAudioModificationContentChanged (ARAAudioModificationHostRef audioModificationHostRef,
                                                                   const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept
{
    getInterface ()->notifyAudioModificationContentChanged (getRef (), audioModificationHostRef, range, scopeFlags);
}

void HostModelUpdateController::notifyPlaybackRegionContentChanged (ARAPlaybackRegionHostRef playbackRegionHostRef,
                                                                const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept
{
    // notifyPlaybackRegionContentChanged was optional in the ARA 2.0 draft, so check its presence here to be safe
    if (getInterface ().implements<ARA_STRUCT_MEMBER (ARAModelUpdateControllerInterface, notifyPlaybackRegionContentChanged)> ())
        getInterface ()->notifyPlaybackRegionContentChanged (getRef (), playbackRegionHostRef, range, scopeFlags);
}

/*******************************************************************************/
// PlaybackController
/*******************************************************************************/

void HostPlaybackController::requestStartPlayback () noexcept
{
    getInterface ()->requestStartPlayback (getRef ());
}

void HostPlaybackController::requestStopPlayback () noexcept
{
    getInterface ()->requestStopPlayback (getRef ());
}

void HostPlaybackController::requestSetPlaybackPosition (ARATimePosition timePosition) noexcept
{
    getInterface ()->requestSetPlaybackPosition (getRef (), timePosition);
}

void HostPlaybackController::requestSetCycleRange (ARATimePosition startTime, ARATimeDuration duration) noexcept
{
    getInterface ()->requestSetCycleRange (getRef (), startTime, duration);
}

void HostPlaybackController::requestEnableCycle (bool enable) noexcept
{
    getInterface ()->requestEnableCycle (getRef (), (enable) ? kARATrue : kARAFalse);
}

}   // namespace PlugIn
}   // namespace ARA
