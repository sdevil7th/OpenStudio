//------------------------------------------------------------------------------
//! \file       ARAHostDispatch.cpp
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

#include "ARAHostDispatch.h"

namespace ARA {
namespace Host {

/*******************************************************************************/
// AudioAccessControllerDispatcher
/*******************************************************************************/

namespace AudioAccessControllerDispatcher
{
    static ARAAudioReaderHostRef ARA_CALL createAudioReaderForSource (ARAAudioAccessControllerHostRef controllerHostRef,
                                                                      ARAAudioSourceHostRef audioSourceHostRef, ARABool use64BitSamples) noexcept
    {
        return fromHostRef (controllerHostRef)->createAudioReaderForSource (audioSourceHostRef, use64BitSamples != kARAFalse);
    }

    static ARABool ARA_CALL readAudioSamples (ARAAudioAccessControllerHostRef controllerHostRef, ARAAudioReaderHostRef audioReaderHostRef,
                                              ARASamplePosition samplePosition, ARASampleCount samplesPerChannel, void* const buffers[]) noexcept
    {
        return (fromHostRef (controllerHostRef)->readAudioSamples (audioReaderHostRef, samplePosition, samplesPerChannel, buffers)) ? kARATrue : kARAFalse;
    }

    static void ARA_CALL destroyAudioReader (ARAAudioAccessControllerHostRef controllerHostRef, ARAAudioReaderHostRef audioReaderHostRef) noexcept
    {
        fromHostRef (controllerHostRef)->destroyAudioReader (audioReaderHostRef);
    }

    static const ARAAudioAccessControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAAudioAccessControllerInterface, destroyAudioReader)> ifc =
        {
            AudioAccessControllerDispatcher::createAudioReaderForSource,
            AudioAccessControllerDispatcher::readAudioSamples,
            AudioAccessControllerDispatcher::destroyAudioReader
        };
        return &ifc;
    }
}

/*******************************************************************************/
// ArchivingControllerDispatcher
/*******************************************************************************/

namespace ArchivingControllerDispatcher
{
    static ARASize ARA_CALL getArchiveSize (ARAArchivingControllerHostRef controllerHostRef, ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
    {
        return fromHostRef (controllerHostRef)->getArchiveSize (archiveReaderHostRef);
    }

    static ARABool ARA_CALL readBytesFromArchive (ARAArchivingControllerHostRef controllerHostRef, ARAArchiveReaderHostRef archiveReaderHostRef,
                                                  ARASize position, ARASize length, ARAByte buffer[]) noexcept
    {
        return (fromHostRef (controllerHostRef)->readBytesFromArchive (archiveReaderHostRef, position, length, buffer)) ? kARATrue : kARAFalse;
    }

    static ARABool ARA_CALL writeBytesToArchive (ARAArchivingControllerHostRef controllerHostRef, ARAArchiveWriterHostRef archiveWriterHostRef,
                                                 ARASize position, ARASize length, const ARAByte buffer[]) noexcept
    {
        return (fromHostRef (controllerHostRef)->writeBytesToArchive (archiveWriterHostRef, position, length, buffer)) ? kARATrue : kARAFalse;
    }

    static void ARA_CALL notifyDocumentArchivingProgress (ARAArchivingControllerHostRef controllerHostRef, float value) noexcept
    {
        fromHostRef (controllerHostRef)->notifyDocumentArchivingProgress (value);
    }

    static void ARA_CALL notifyDocumentUnarchivingProgress (ARAArchivingControllerHostRef controllerHostRef, float value) noexcept
    {
        fromHostRef (controllerHostRef)->notifyDocumentUnarchivingProgress (value);
    }

    static ARAPersistentID ARA_CALL getDocumentArchiveID (ARAArchivingControllerHostRef controllerHostRef, ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
    {
        return fromHostRef (controllerHostRef)->getDocumentArchiveID (archiveReaderHostRef);
    }

    static const ARAArchivingControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAArchivingControllerInterface, getDocumentArchiveID)> ifc =
        {
            ArchivingControllerDispatcher::getArchiveSize,
            ArchivingControllerDispatcher::readBytesFromArchive,
            ArchivingControllerDispatcher::writeBytesToArchive,
            ArchivingControllerDispatcher::notifyDocumentArchivingProgress,
            ArchivingControllerDispatcher::notifyDocumentUnarchivingProgress,
            ArchivingControllerDispatcher::getDocumentArchiveID
        };
        return &ifc;
    }
}

/*******************************************************************************/
// ContentAccessControllerDispatcher
/*******************************************************************************/

namespace ContentAccessControllerDispatcher
{
    static ARABool ARA_CALL isMusicalContextContentAvailable (ARAContentAccessControllerHostRef controllerHostRef, ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type) noexcept
    {
        return (fromHostRef (controllerHostRef)->isMusicalContextContentAvailable (musicalContextHostRef, type)) ? kARATrue : kARAFalse;
    }

    static ARAContentGrade ARA_CALL getMusicalContextContentGrade (ARAContentAccessControllerHostRef controllerHostRef, ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type) noexcept
    {
        return fromHostRef (controllerHostRef)->getMusicalContextContentGrade (musicalContextHostRef, type);
    }

    static ARAContentReaderHostRef ARA_CALL createMusicalContextContentReader (ARAContentAccessControllerHostRef controllerHostRef,
                                                                               ARAMusicalContextHostRef musicalContextHostRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
    {
        return fromHostRef (controllerHostRef)->createMusicalContextContentReader (musicalContextHostRef, type, range);
    }

    static ARABool ARA_CALL isAudioSourceContentAvailable (ARAContentAccessControllerHostRef controllerHostRef, ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type) noexcept
    {
        return (fromHostRef (controllerHostRef)->isAudioSourceContentAvailable (audioSourceHostRef, type)) ? kARATrue : kARAFalse;
    }

    static ARAContentGrade ARA_CALL getAudioSourceContentGrade (ARAContentAccessControllerHostRef controllerHostRef, ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type) noexcept
    {
        return fromHostRef (controllerHostRef)->getAudioSourceContentGrade (audioSourceHostRef, type);
    }

    static ARAContentReaderHostRef ARA_CALL createAudioSourceContentReader (ARAContentAccessControllerHostRef controllerHostRef,
                                                                            ARAAudioSourceHostRef audioSourceHostRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
    {
        return fromHostRef (controllerHostRef)->createAudioSourceContentReader (audioSourceHostRef, type, range);
    }

    static ARAInt32 ARA_CALL getContentReaderEventCount (ARAContentAccessControllerHostRef controllerHostRef, ARAContentReaderHostRef contentReaderHostRef) noexcept
    {
        return fromHostRef (controllerHostRef)->getContentReaderEventCount (contentReaderHostRef);
    }

    static const void* ARA_CALL getContentReaderDataForEvent (ARAContentAccessControllerHostRef controllerHostRef,
                                                              ARAContentReaderHostRef contentReaderHostRef, ARAInt32 eventIndex) noexcept
    {
        return fromHostRef (controllerHostRef)->getContentReaderDataForEvent (contentReaderHostRef, eventIndex);
    }

    static void ARA_CALL destroyContentReader (ARAContentAccessControllerHostRef controllerHostRef, ARAContentReaderHostRef contentReaderHostRef) noexcept
    {
        fromHostRef (controllerHostRef)->destroyContentReader (contentReaderHostRef);
    }

    static const ARAContentAccessControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAContentAccessControllerInterface, destroyContentReader)> ifc =
        {
            ContentAccessControllerDispatcher::isMusicalContextContentAvailable,
            ContentAccessControllerDispatcher::getMusicalContextContentGrade,
            ContentAccessControllerDispatcher::createMusicalContextContentReader,
            ContentAccessControllerDispatcher::isAudioSourceContentAvailable,
            ContentAccessControllerDispatcher::getAudioSourceContentGrade,
            ContentAccessControllerDispatcher::createAudioSourceContentReader,
            ContentAccessControllerDispatcher::getContentReaderEventCount,
            ContentAccessControllerDispatcher::getContentReaderDataForEvent,
            ContentAccessControllerDispatcher::destroyContentReader
        };
        return &ifc;
    }
}

/*******************************************************************************/
// ModelUpdateControllerDispatcher
/*******************************************************************************/

namespace ModelUpdateControllerDispatcher
{
    static void ARA_CALL notifyAudioSourceAnalysisProgress (ARAModelUpdateControllerHostRef controllerHostRef,
                                                            ARAAudioSourceHostRef audioSourceHostRef, ARAAnalysisProgressState state, float value) noexcept
    {
        fromHostRef (controllerHostRef)->notifyAudioSourceAnalysisProgress (audioSourceHostRef, state, value);
    }

    static void ARA_CALL notifyAudioSourceContentChanged (ARAModelUpdateControllerHostRef controllerHostRef, ARAAudioSourceHostRef audioSourceHostRef,
                                                          const ARAContentTimeRange* range, ARAContentUpdateFlags flags) noexcept
    {
        fromHostRef (controllerHostRef)->notifyAudioSourceContentChanged (audioSourceHostRef, range, flags);
    }

    static void ARA_CALL notifyAudioModificationContentChanged (ARAModelUpdateControllerHostRef controllerHostRef, ARAAudioModificationHostRef audioModificationHostRef,
                                                                const ARAContentTimeRange* range, ARAContentUpdateFlags flags) noexcept
    {
        fromHostRef (controllerHostRef)->notifyAudioModificationContentChanged (audioModificationHostRef, range, flags);
    }

    static void ARA_CALL notifyPlaybackRegionContentChanged (ARAModelUpdateControllerHostRef controllerHostRef, ARAPlaybackRegionHostRef playbackRegionHostRef,
                                                             const ARAContentTimeRange* range, ARAContentUpdateFlags flags) noexcept
    {
        fromHostRef (controllerHostRef)->notifyPlaybackRegionContentChanged (playbackRegionHostRef, range, flags);
    }

    static const ARAModelUpdateControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAModelUpdateControllerInterface, notifyPlaybackRegionContentChanged)> ifc =
        {
            ModelUpdateControllerDispatcher::notifyAudioSourceAnalysisProgress,
            ModelUpdateControllerDispatcher::notifyAudioSourceContentChanged,
            ModelUpdateControllerDispatcher::notifyAudioModificationContentChanged,
            ModelUpdateControllerDispatcher::notifyPlaybackRegionContentChanged
        };
        return &ifc;
    }
}

/*******************************************************************************/
// PlaybackControllerDispatcher
/*******************************************************************************/

namespace PlaybackControllerDispatcher
{
    static void ARA_CALL requestStartPlayback (ARAPlaybackControllerHostRef controllerHostRef) noexcept
    {
        fromHostRef (controllerHostRef)->requestStartPlayback ();
    }

    static void ARA_CALL requestStopPlayback (ARAPlaybackControllerHostRef controllerHostRef) noexcept
    {
        fromHostRef (controllerHostRef)->requestStopPlayback ();
    }

    static void ARA_CALL requestSetPlaybackPosition (ARAPlaybackControllerHostRef controllerHostRef, ARATimePosition timePosition) noexcept
    {
        fromHostRef (controllerHostRef)->requestSetPlaybackPosition (timePosition);
    }

    static void ARA_CALL requestSetCycleRange (ARAPlaybackControllerHostRef controllerHostRef, ARATimePosition startTime, ARATimeDuration duration) noexcept
    {
        fromHostRef (controllerHostRef)->requestSetCycleRange (startTime, duration);
    }

    static void ARA_CALL requestEnableCycle (ARAPlaybackControllerHostRef controllerHostRef, ARABool enable) noexcept
    {
        fromHostRef (controllerHostRef)->requestEnableCycle (enable != kARAFalse);
    }

    static const ARAPlaybackControllerInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackControllerInterface, requestEnableCycle)> ifc =
        {
            PlaybackControllerDispatcher::requestStartPlayback,
            PlaybackControllerDispatcher::requestStopPlayback,
            PlaybackControllerDispatcher::requestSetPlaybackPosition,
            PlaybackControllerDispatcher::requestSetCycleRange,
            PlaybackControllerDispatcher::requestEnableCycle
        };
        return &ifc;
    }
}

/*******************************************************************************/
// DocumentControllerHostInstance
/*******************************************************************************/

DocumentControllerHostInstance::DocumentControllerHostInstance (AudioAccessControllerInterface* audioAccessController, ArchivingControllerInterface* archivingController,
                                                                ContentAccessControllerInterface* contentAccessController, ModelUpdateControllerInterface* modelUpdateController,
                                                                PlaybackControllerInterface* playbackController) noexcept
: BaseType {}
{
    setAudioAccessController (audioAccessController);
    setArchivingController (archivingController);
    if (contentAccessController)
        setContentAccessController (contentAccessController);
    if (modelUpdateController)
        setModelUpdateController (modelUpdateController);
    if (playbackController)
        setPlaybackController (playbackController);
}

void DocumentControllerHostInstance::setAudioAccessController (AudioAccessControllerInterface* audioAccessController) noexcept
{
    audioAccessControllerHostRef = toHostRef (audioAccessController);
    audioAccessControllerInterface = AudioAccessControllerDispatcher::getInterface ();
}

void DocumentControllerHostInstance::setArchivingController (ArchivingControllerInterface* archivingController) noexcept
{
    archivingControllerHostRef = toHostRef (archivingController);
    archivingControllerInterface = ArchivingControllerDispatcher::getInterface ();
}

void DocumentControllerHostInstance::setContentAccessController (ContentAccessControllerInterface* contentAccessController) noexcept
{
    contentAccessControllerHostRef = toHostRef (contentAccessController);
    contentAccessControllerInterface = (contentAccessController) ? ContentAccessControllerDispatcher::getInterface () : nullptr;
}

void DocumentControllerHostInstance::setModelUpdateController (ModelUpdateControllerInterface* modelUpdateController) noexcept
{
    modelUpdateControllerHostRef = toHostRef (modelUpdateController);
    modelUpdateControllerInterface = (modelUpdateController) ? ModelUpdateControllerDispatcher::getInterface () : nullptr;
}

void DocumentControllerHostInstance::setPlaybackController (PlaybackControllerInterface* playbackController) noexcept
{
    playbackControllerHostRef = toHostRef (playbackController);
    playbackControllerInterface = (playbackController) ? PlaybackControllerDispatcher::getInterface () : nullptr;
}

/*******************************************************************************/
// DocumentController
/*******************************************************************************/

void DocumentController::destroyDocumentController () noexcept
{
    getInterface ()->destroyDocumentController (getRef ());
}

const ARAFactory* DocumentController::getFactory () noexcept
{
    return getInterface ()->getFactory (getRef ());
}

void DocumentController::beginEditing () noexcept
{
    getInterface ()->beginEditing (getRef ());
}

void DocumentController::endEditing () noexcept
{
    getInterface ()->endEditing (getRef ());
}

void DocumentController::notifyModelUpdates () noexcept
{
    getInterface ()->notifyModelUpdates (getRef ());
}

void DocumentController::updateDocumentProperties (const ARADocumentProperties* properties) noexcept
{
    getInterface ()->updateDocumentProperties (getRef (), properties);
}

bool DocumentController::beginRestoringDocumentFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
{
    // begin-/endRestoringDocumentFromArchive () is deprecated, prefer to use the new partial persistency calls if supported by the plug-in
    if (supportsPartialPersistency ())
    {
        getInterface ()->beginEditing (getRef ());
        return true;
    }
    else
    {
        return (getInterface ()->beginRestoringDocumentFromArchive (getRef (), archiveReaderHostRef) != kARAFalse);
    }
}

bool DocumentController::endRestoringDocumentFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef) noexcept
{
    // begin-/endRestoringDocumentFromArchive () is deprecated, prefer to use the new partial persistency calls if supported by the plug-in
    if (supportsPartialPersistency ())
    {
        const auto result { getInterface ()->restoreObjectsFromArchive (getRef (), archiveReaderHostRef, nullptr) };
        getInterface ()->endEditing (getRef ());
        return (result != kARAFalse);
    }
    else
    {
        return (getInterface ()->endRestoringDocumentFromArchive (getRef (), archiveReaderHostRef) != kARAFalse);
    }
}

bool DocumentController::storeDocumentToArchive (ARAArchiveWriterHostRef archiveWriterHostRef) noexcept
{
    // storeDocumentToArchive () is deprecated, prefer to use the new partial persistency calls if supported by the plug-in
    if (supportsPartialPersistency ())
        return (getInterface ()->storeObjectsToArchive (getRef (), archiveWriterHostRef, nullptr) != kARAFalse);
    else
        return (getInterface ()->storeDocumentToArchive (getRef (), archiveWriterHostRef) != kARAFalse);
}

bool DocumentController::supportsPartialPersistency () noexcept
{
    return getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, storeObjectsToArchive)> ();
}

bool DocumentController::restoreObjectsFromArchive (ARAArchiveReaderHostRef archiveReaderHostRef, const ARARestoreObjectsFilter* filter) noexcept
{
    if (!supportsPartialPersistency ())
        return false;

    return (getInterface ()->restoreObjectsFromArchive (getRef (), archiveReaderHostRef, filter) != kARAFalse);
}

bool DocumentController::storeObjectsToArchive (ARAArchiveWriterHostRef archiveWriterHostRef, const ARAStoreObjectsFilter* filter) noexcept
{
    if (!supportsPartialPersistency ())
        return false;

    return (getInterface ()->storeObjectsToArchive (getRef (), archiveWriterHostRef, filter) != kARAFalse);
}

bool DocumentController::supportsStoringAudioFileChunks () noexcept
{
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, storeAudioSourceToAudioFileChunk)> ())
        return false;

    const SizedStructPtr<ARAFactory> factory { getInterface ()->getFactory (getRef ()) };
    if (!factory.implements<ARA_STRUCT_MEMBER (ARAFactory, supportsStoringAudioFileChunks)> ())
        return false;
    return (factory->supportsStoringAudioFileChunks != kARAFalse);
}

bool DocumentController::storeAudioSourceToAudioFileChunk (ARAArchiveWriterHostRef archiveWriterHostRef, ARAAudioSourceRef audioSourceRef, ARAPersistentID* documentArchiveID, bool* openAutomatically) noexcept
{
    if (!supportsStoringAudioFileChunks ())
        return false;

    ARABool autoOpen { kARAFalse };
    const auto result { getInterface ()->storeAudioSourceToAudioFileChunk (getRef (), archiveWriterHostRef, audioSourceRef, documentArchiveID, &autoOpen) };
    *openAutomatically = (autoOpen != kARAFalse);
    return (result != kARAFalse);
}

ARAMusicalContextRef DocumentController::createMusicalContext (ARAMusicalContextHostRef hostRef, const ARAMusicalContextProperties* properties) noexcept
{
    return getInterface ()->createMusicalContext (getRef (), hostRef, properties);
}

void DocumentController::updateMusicalContextProperties (ARAMusicalContextRef musicalContextRef, const ARAMusicalContextProperties* properties) noexcept
{
    getInterface ()->updateMusicalContextProperties (getRef (), musicalContextRef, properties);
}

void DocumentController::updateMusicalContextContent (ARAMusicalContextRef musicalContextRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept
{
    getInterface ()->updateMusicalContextContent (getRef (), musicalContextRef, range, scopeFlags);
}

void DocumentController::destroyMusicalContext (ARAMusicalContextRef musicalContextRef) noexcept
{
    getInterface ()->destroyMusicalContext (getRef (), musicalContextRef);
}

ARARegionSequenceRef DocumentController::createRegionSequence (ARARegionSequenceHostRef hostRef, const ARARegionSequenceProperties* properties) noexcept
{
#if ARA_SUPPORT_VERSION_1
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, destroyRegionSequence)> ())
        return nullptr;
#endif

    return getInterface ()->createRegionSequence (getRef (), hostRef, properties);
}

void DocumentController::updateRegionSequenceProperties (ARARegionSequenceRef regionSequenceRef, const ARARegionSequenceProperties* properties) noexcept
{
#if ARA_SUPPORT_VERSION_1
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, destroyRegionSequence)> ())
        return;
#endif

    return getInterface ()->updateRegionSequenceProperties (getRef (), regionSequenceRef, properties);
}

void DocumentController::destroyRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
#if ARA_SUPPORT_VERSION_1
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, destroyRegionSequence)> ())
        return;
#endif

    return getInterface ()->destroyRegionSequence (getRef (), regionSequenceRef);
}

ARAAudioSourceRef DocumentController::createAudioSource (ARAAudioSourceHostRef hostRef, const ARAAudioSourceProperties* properties) noexcept
{
    return getInterface ()->createAudioSource (getRef (), hostRef, properties);
}

void DocumentController::updateAudioSourceProperties (ARAAudioSourceRef audioSourceRef, const ARAAudioSourceProperties* properties) noexcept
{
    getInterface ()->updateAudioSourceProperties (getRef (), audioSourceRef, properties);
}

void DocumentController::updateAudioSourceContent (ARAAudioSourceRef audioSourceRef, const ARAContentTimeRange* range, ContentUpdateScopes scopeFlags) noexcept
{
    getInterface ()->updateAudioSourceContent (getRef (), audioSourceRef, range, scopeFlags);
}

void DocumentController::enableAudioSourceSamplesAccess (ARAAudioSourceRef audioSourceRef, bool enable) noexcept
{
    getInterface ()->enableAudioSourceSamplesAccess (getRef (), audioSourceRef, (enable) ? kARATrue : kARAFalse);
}

void DocumentController::deactivateAudioSourceForUndoHistory (ARAAudioSourceRef audioSourceRef, bool deactivate) noexcept
{
    getInterface ()->deactivateAudioSourceForUndoHistory (getRef (), audioSourceRef, (deactivate) ? kARATrue : kARAFalse);
}

void DocumentController::destroyAudioSource (ARAAudioSourceRef audioSourceRef) noexcept
{
    getInterface ()->destroyAudioSource (getRef (), audioSourceRef);
}

ARAAudioModificationRef DocumentController::createAudioModification (ARAAudioSourceRef audioSourceRef, ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept
{
    return getInterface ()->createAudioModification (getRef (), audioSourceRef, hostRef, properties);
}

ARAAudioModificationRef DocumentController::cloneAudioModification (ARAAudioModificationRef audioModificationRef, ARAAudioModificationHostRef hostRef, const ARAAudioModificationProperties* properties) noexcept
{
    return getInterface ()->cloneAudioModification (getRef (), audioModificationRef, hostRef, properties);
}

void DocumentController::updateAudioModificationProperties (ARAAudioModificationRef audioModificationRef, const ARAAudioModificationProperties* properties) noexcept
{
    getInterface ()->updateAudioModificationProperties (getRef (), audioModificationRef, properties);
}

bool DocumentController::supportsIsAudioModificationPreservingAudioSourceSignal () noexcept
{
    return getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, isAudioModificationPreservingAudioSourceSignal)> ();
}

bool DocumentController::isAudioModificationPreservingAudioSourceSignal (ARAAudioModificationRef audioModificationRef) noexcept
{
    if (!supportsIsAudioModificationPreservingAudioSourceSignal ())
        return false;
    return (getInterface ()->isAudioModificationPreservingAudioSourceSignal (getRef (), audioModificationRef) != kARAFalse);
}

void DocumentController::deactivateAudioModificationForUndoHistory (ARAAudioModificationRef audioModificationRef, bool deactivate) noexcept
{
    getInterface ()->deactivateAudioModificationForUndoHistory (getRef (), audioModificationRef, (deactivate) ? kARATrue : kARAFalse);
}

void DocumentController::destroyAudioModification (ARAAudioModificationRef audioModificationRef) noexcept
{
    getInterface ()->destroyAudioModification (getRef (), audioModificationRef);
}

ARAPlaybackRegionRef DocumentController::createPlaybackRegion (ARAAudioModificationRef audioModificationRef, ARAPlaybackRegionHostRef hostRef, const ARAPlaybackRegionProperties* properties) noexcept
{
    return getInterface ()->createPlaybackRegion (getRef (), audioModificationRef, hostRef, properties);
}

void DocumentController::updatePlaybackRegionProperties (ARAPlaybackRegionRef playbackRegionRef, const ARAPlaybackRegionProperties* properties) noexcept
{
    getInterface ()->updatePlaybackRegionProperties (getRef (), playbackRegionRef, properties);
}

void DocumentController::getPlaybackRegionHeadAndTailTime (ARAPlaybackRegionRef playbackRegionRef, ARATimeDuration* headTime, ARATimeDuration* tailTime) noexcept
{
#if ARA_SUPPORT_VERSION_1
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, getPlaybackRegionHeadAndTailTime)> ())
    {
        *headTime = 0.0;
        *tailTime = 0.0;
        return;
    }
#endif

    return getInterface ()->getPlaybackRegionHeadAndTailTime (getRef (), playbackRegionRef, headTime, tailTime);
}

void DocumentController::destroyPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    getInterface ()->destroyPlaybackRegion (getRef (), playbackRegionRef);
}

bool DocumentController::isAudioSourceContentAvailable (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    return (getInterface ()->isAudioSourceContentAvailable (getRef (), audioSourceRef, type) != kARAFalse);
}

ARAContentGrade DocumentController::getAudioSourceContentGrade (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    return getInterface ()->getAudioSourceContentGrade (getRef (), audioSourceRef, type);
}

ARAContentReaderRef DocumentController::createAudioSourceContentReader (ARAAudioSourceRef audioSourceRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    return getInterface ()->createAudioSourceContentReader (getRef (), audioSourceRef, type, range);
}

bool DocumentController::isAudioModificationContentAvailable (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
{
    return (getInterface ()->isAudioModificationContentAvailable (getRef (), audioModificationRef, type) != kARAFalse);
}

ARAContentGrade DocumentController::getAudioModificationContentGrade (ARAAudioModificationRef audioModificationRef, ARAContentType type) noexcept
{
    return getInterface ()->getAudioModificationContentGrade (getRef (), audioModificationRef, type);
}

ARAContentReaderRef DocumentController::createAudioModificationContentReader (ARAAudioModificationRef audioModificationRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    return getInterface ()->createAudioModificationContentReader (getRef (), audioModificationRef, type, range);
}

bool DocumentController::isPlaybackRegionContentAvailable (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
{
    return (getInterface ()->isPlaybackRegionContentAvailable (getRef (), playbackRegionRef, type) != kARAFalse);
}

ARAContentGrade DocumentController::getPlaybackRegionContentGrade (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type) noexcept
{
    return getInterface ()->getPlaybackRegionContentGrade (getRef (), playbackRegionRef, type);
}

ARAContentReaderRef DocumentController::createPlaybackRegionContentReader (ARAPlaybackRegionRef playbackRegionRef, ARAContentType type, const ARAContentTimeRange* range) noexcept
{
    return getInterface ()->createPlaybackRegionContentReader (getRef (), playbackRegionRef, type, range);
}

ARAInt32 DocumentController::getContentReaderEventCount (ARAContentReaderRef contentReaderRef) noexcept
{
    return getInterface ()->getContentReaderEventCount (getRef (), contentReaderRef);
}

const void* DocumentController::getContentReaderDataForEvent (ARAContentReaderRef contentReaderRef, ARAInt32 eventIndex) noexcept
{
    return getInterface ()->getContentReaderDataForEvent (getRef (), contentReaderRef, eventIndex);
}

void DocumentController::destroyContentReader (ARAContentReaderRef contentReaderRef) noexcept
{
    getInterface ()->destroyContentReader (getRef (), contentReaderRef);
}

bool DocumentController::isAudioSourceContentAnalysisIncomplete (ARAAudioSourceRef audioSourceRef, ARAContentType type) noexcept
{
    return (getInterface ()->isAudioSourceContentAnalysisIncomplete (getRef (), audioSourceRef, type) != kARAFalse);
}

void DocumentController::requestAudioSourceContentAnalysis (ARAAudioSourceRef audioSourceRef, ARASize contentTypesCount, const ARAContentType contentTypes[]) noexcept
{
    getInterface ()->requestAudioSourceContentAnalysis (getRef (), audioSourceRef, contentTypesCount, contentTypes);
}

bool DocumentController::supportsProcessingAlgorithms () noexcept
{
    return (getProcessingAlgorithmsCount () > 0);
}

ARAInt32 DocumentController::getProcessingAlgorithmsCount () noexcept
{
    if (getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, requestProcessingAlgorithmForAudioSource)> ())
        return getInterface ()->getProcessingAlgorithmsCount (getRef ());
    else
        return 0;
}

const ARAProcessingAlgorithmProperties* DocumentController::getProcessingAlgorithmProperties (ARAInt32 algorithmIndex) noexcept
{
    return getInterface ()->getProcessingAlgorithmProperties (getRef (), algorithmIndex);
}

ARAInt32 DocumentController::getProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef) noexcept
{
    return getInterface ()->getProcessingAlgorithmForAudioSource (getRef (), audioSourceRef);
}

void DocumentController::requestProcessingAlgorithmForAudioSource (ARAAudioSourceRef audioSourceRef, ARAInt32 algorithmIndex) noexcept
{
    getInterface ()->requestProcessingAlgorithmForAudioSource (getRef (), audioSourceRef, algorithmIndex);
}

bool DocumentController::isLicensedForCapabilities (bool runModalActivationDialogIfNeeded, ARASize contentTypesCount, const ARAContentType contentTypes[], ARAPlaybackTransformationFlags transformationFlags) noexcept
{
    if (!getInterface ().implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, isLicensedForCapabilities)> ())
        return true;

    return (getInterface ()->isLicensedForCapabilities (getRef (), (runModalActivationDialogIfNeeded) ? kARATrue : kARAFalse, contentTypesCount, contentTypes, transformationFlags) != kARAFalse);
}

/*******************************************************************************/
// PlaybackRenderer
/*******************************************************************************/

#if ARA_SUPPORT_VERSION_1

bool supportsARA2 (const ARAPlugInExtensionInstance* instance)
{
    return SizedStructPtr<ARAPlugInExtensionInstance> (instance).implements<ARA_STRUCT_MEMBER (ARAPlugInExtensionInstance, editorViewInterface)> ();
}

class ARA1PlugInExtension : public InterfaceInstance<ARAPlugInExtensionRef, ARAPlugInExtensionInterface>
{
public:
    explicit ARA1PlugInExtension (const ARAPlugInExtensionInstance* instance) noexcept
    : BaseType { instance->plugInExtensionRef, instance->plugInExtensionInterface }
    {}
};
// this is not really a host ref but rather a dummy plug-in ref created by the host,
// but since this macro only deals with proper casting this difference does not matter.
ARA_MAP_HOST_REF (ARA1PlugInExtension, ARAPlaybackRendererRef)

// playback renderer for ARA 1 is forwarding to plug-in extension
namespace ARA1PlaybackRendererAdapterDispatcher
{
    static void ARA_CALL addPlaybackRegion (ARAPlaybackRendererRef playbackRendererRef, ARAPlaybackRegionRef playbackRegionRef)
    {
        auto plugInExtension { fromHostRef (playbackRendererRef) };
        fromHostRef (playbackRendererRef)->getInterface ()->setPlaybackRegion (plugInExtension->getRef (), playbackRegionRef);
    }

    static void ARA_CALL removePlaybackRegion (ARAPlaybackRendererRef playbackRendererRef, ARAPlaybackRegionRef playbackRegionRef)
    {
        auto plugInExtension { fromHostRef (playbackRendererRef) };
        plugInExtension->getInterface ()->removePlaybackRegion (plugInExtension->getRef (), playbackRegionRef);
    }

    static const ARAPlaybackRendererInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackRendererInterface, removePlaybackRegion)> ifc =
        {
            ARA1PlaybackRendererAdapterDispatcher::addPlaybackRegion,
            ARA1PlaybackRendererAdapterDispatcher::removePlaybackRegion
        };
        return &ifc;
    }
}

PlaybackRenderer::PlaybackRenderer (const ARAPlugInExtensionInstance* instance)
: BaseType { supportsARA2 (instance) ? instance->playbackRendererRef : toHostRef (new ARA1PlugInExtension (instance)),
             supportsARA2 (instance) ? instance->playbackRendererInterface : ARA1PlaybackRendererAdapterDispatcher::getInterface () }
{}

PlaybackRenderer::~PlaybackRenderer ()
{
    // ARA 2 plug-ins will provide their own distinct interface pointers, so this test
    // basically equals a dynamic_cast<ARA1PlugInExtension> (PlaybackRenderer.getRef ())
    if (getInterface () == ARA1PlaybackRendererAdapterDispatcher::getInterface ())
        delete reinterpret_cast<ARA1PlugInExtension*> (getRef ());
}

#endif    // ARA_SUPPORT_VERSION_1

void PlaybackRenderer::addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    getInterface ()->addPlaybackRegion (getRef (), playbackRegionRef);
}

void PlaybackRenderer::removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    getInterface ()->removePlaybackRegion (getRef (), playbackRegionRef);
}

//************************************************************************************************
// EditorRenderer
//************************************************************************************************

#if ARA_SUPPORT_VERSION_1

// editor renderer for ARA 1 is empty stub
namespace ARA1EditorRendererAdapterDispatcher
{
    static void ARA_CALL addPlaybackRegion (ARAEditorRendererRef /*editorRendererRef*/, ARAPlaybackRegionRef /*playbackRegionRef*/)
    {}

    static void ARA_CALL removePlaybackRegion (ARAEditorRendererRef /*editorRendererRef*/, ARAPlaybackRegionRef /*playbackRegionRef*/)
    {}

    static void ARA_CALL addRegionSequence (ARAEditorRendererRef /*editorRendererRef*/, ARARegionSequenceRef /*regionSequenceRef*/)
    {}

    static void ARA_CALL removeRegionSequence (ARAEditorRendererRef /*editorRendererRef*/, ARARegionSequenceRef /*regionSequenceRef*/)
    {}

    static const ARAEditorRendererInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAEditorRendererInterface, removeRegionSequence)> ifc =
        {
            ARA1EditorRendererAdapterDispatcher::addPlaybackRegion,
            ARA1EditorRendererAdapterDispatcher::removePlaybackRegion,
            ARA1EditorRendererAdapterDispatcher::addRegionSequence,
            ARA1EditorRendererAdapterDispatcher::removeRegionSequence
        };
        return &ifc;
    }
}

EditorRenderer::EditorRenderer (const ARAPlugInExtensionInstance* instance) noexcept
: BaseType { supportsARA2 (instance) ? instance->editorRendererRef : nullptr,
             supportsARA2 (instance) ? instance->editorRendererInterface : ARA1EditorRendererAdapterDispatcher::getInterface () }
{}

#endif    // ARA_SUPPORT_VERSION_1

void EditorRenderer::addPlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    getInterface ()->addPlaybackRegion (getRef (), playbackRegionRef);
}

void EditorRenderer::removePlaybackRegion (ARAPlaybackRegionRef playbackRegionRef) noexcept
{
    getInterface ()->removePlaybackRegion (getRef (), playbackRegionRef);
}

void EditorRenderer::addRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
    getInterface ()->addRegionSequence (getRef (), regionSequenceRef);
}

void EditorRenderer::removeRegionSequence (ARARegionSequenceRef regionSequenceRef) noexcept
{
    getInterface ()->removeRegionSequence (getRef (), regionSequenceRef);
}

//************************************************************************************************
// EditorView
//************************************************************************************************

#if ARA_SUPPORT_VERSION_1

// editor view for ARA 1 is empty stub
namespace ARA1EditorViewAdapterDispatcher
{
    static void ARA_CALL notifySelection (ARAEditorViewRef /*editorViewRef*/, const ARAViewSelection* /*selection*/)
    {}

    static void ARA_CALL notifyHideRegionSequences (ARAEditorViewRef /*editorViewRef*/, ARASize /*regionSequenceRefsCount*/, const ARARegionSequenceRef /*regionSequenceRefs*/[])
    {}

    static const ARAEditorViewInterface* getInterface () noexcept
    {
        static const SizedStruct<ARA_STRUCT_MEMBER (ARAEditorViewInterface, notifyHideRegionSequences)> ifc =
        {
            ARA1EditorViewAdapterDispatcher::notifySelection,
            ARA1EditorViewAdapterDispatcher::notifyHideRegionSequences
        };
        return &ifc;
    }
}

EditorView::EditorView (const ARAPlugInExtensionInstance* instance) noexcept
: BaseType { supportsARA2 (instance) ? instance->editorViewRef : nullptr,
             supportsARA2 (instance) ? instance->editorViewInterface : ARA1EditorViewAdapterDispatcher::getInterface () }
{}

#endif    // ARA_SUPPORT_VERSION_1

void EditorView::notifySelection (const ARAViewSelection* selection) noexcept
{
    getInterface ()->notifySelection (getRef (), selection);
}

void EditorView::notifyHideRegionSequences (ARASize regionSequenceRefsCount, const ARARegionSequenceRef regionSequenceRefs[]) noexcept
{
    getInterface ()->notifyHideRegionSequences (getRef (), regionSequenceRefsCount, regionSequenceRefs);
}

}   // namespace Host
}   // namespace ARA
