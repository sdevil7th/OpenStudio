//------------------------------------------------------------------------------
//! \file       ARAContentReader.h
//!             content reading utility classes
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

#ifndef ARAContentReader_h
#define ARAContentReader_h

#include "ARA_Library/Dispatch/ARADispatchBase.h"

#include <type_traits>
#include <iterator>
#include <algorithm>
#include <cmath>

namespace ARA {

/*******************************************************************************/
// ContentTypeMapper
// Map between ARAContentType and its associated event data structs.
/*******************************************************************************/

template <ARAContentType contentType>
struct ContentTypeMapper;

#define ARA_SPECIALIZE_CONTENT_TYPE_MAPPER(contentType, StructType) \
    template <> \
    struct ContentTypeMapper<contentType> \
    { \
        using DataType = StructType; \
        static constexpr auto enumName { #contentType }; \
        static constexpr auto typeName { #StructType }; \
    };

    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeNotes, ARAContentNote)
    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeTempoEntries, ARAContentTempoEntry)
    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeBarSignatures, ARAContentBarSignature)
    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeStaticTuning, ARAContentTuning)
    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeKeySignatures, ARAContentKeySignature)
    ARA_SPECIALIZE_CONTENT_TYPE_MAPPER (kARAContentTypeSheetChords, ARAContentChord)

#undef ARA_SPECIALIZE_CONTENT_TYPE_MAPPER

/*******************************************************************************/
// ContentReaderFunctionMapper
// Map to allow templated content reader code to pick the proper non-polymorphic ARA interface calls.
/*******************************************************************************/

template <typename ControllerType, typename ModelObjectRefType> struct ContentReaderFunctionMapper;

#define ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER(ObjectName, RefName) \
    template <typename ControllerType> \
    struct ContentReaderFunctionMapper<ControllerType, RefName> \
    { \
        static constexpr auto isContentAvailable { &ControllerType::is##ObjectName##ContentAvailable }; \
        static constexpr auto getContentGrade { &ControllerType::get##ObjectName##ContentGrade }; \
        static constexpr auto createContentReader { &ControllerType::create##ObjectName##ContentReader }; \
        static constexpr auto modelObjectRefTypeName { #RefName }; \
    };

    ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER (AudioSource, ARAAudioSourceHostRef)
    ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER (MusicalContext, ARAMusicalContextHostRef)
    ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER (AudioSource, ARAAudioSourceRef)
    ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER (AudioModification, ARAAudioModificationRef)
    ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER (PlaybackRegion, ARAPlaybackRegionRef)

#undef ARA_SPECIALIZE_CONTENT_READER_FUNCTION_MAPPER


//! @addtogroup ARA_Library_Utility_Content_Readers
//! @{

/*******************************************************************************/
// ContentReaderEventIterator
/** Fully C++11 stl-compatible iterator adapter for ContentReader.
    \code{.cpp}
    auto tempoContentReader = createTempoReaderForAudioSource (...);
    for (const auto& tempoEntry : tempoContentReader)
        processTempoEntry (tempoEntry);
    \endcode
    See also https://en.cppreference.com/w/cpp/iterator
*/
/*******************************************************************************/

template <typename ContentReader>
class ContentReaderEventIterator
{
public:
    using iterator_category = std::random_access_iterator_tag;
    using value_type = typename ContentReader::DataType;
    using difference_type = ARAInt32;
    using pointer = const value_type*;
    using reference = const value_type&;

    ContentReaderEventIterator () = delete;

    inline ContentReaderEventIterator (const ContentReader* contentReader, ARAInt32 initialEventIndex) noexcept
    : _contentReader { contentReader },
      _eventIndex { initialEventIndex },
      _cachedEventIndex { -1 }
    {}

    inline ContentReaderEventIterator& operator++ () noexcept { ++this->_eventIndex; return *this; }
    inline ContentReaderEventIterator operator++ (int) noexcept { ContentReaderEventIterator result = *this; ++(*this); return result; }
    inline ContentReaderEventIterator& operator-- () noexcept { --this->_eventIndex; return *this; }
    inline ContentReaderEventIterator operator-- (int) noexcept { ContentReaderEventIterator result = *this; --(*this); return result; }
    inline ContentReaderEventIterator& operator+= (ARAInt32 offset) noexcept { this->_eventIndex += offset; return *this; }
    inline ContentReaderEventIterator& operator-= (ARAInt32 offset) noexcept { this->_eventIndex -= offset; return *this; }
    inline ContentReaderEventIterator operator+ (ARAInt32 offset) const noexcept { return ContentReaderEventIterator (*this) + offset; }
    inline friend ContentReaderEventIterator operator+ (ARAInt32 offset, const ContentReaderEventIterator& it) noexcept { return ContentReaderEventIterator (it) + offset; }
    inline ContentReaderEventIterator operator- (ARAInt32 offset) const noexcept { return ContentReaderEventIterator (*this) - offset; }
    inline friend ContentReaderEventIterator operator- (ARAInt32 offset, const ContentReaderEventIterator& it) noexcept { return ContentReaderEventIterator (it) - offset; }
    inline ARAInt32 operator- (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex - other._eventIndex; }

    inline bool operator== (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex == other._eventIndex; }
    inline bool operator!= (const ContentReaderEventIterator& other) const noexcept { return !(*this == other); }
    inline bool operator< (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex < other._eventIndex; }
    inline bool operator> (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex > other._eventIndex; }
    inline bool operator<= (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex <= other._eventIndex; }
    inline bool operator>= (const ContentReaderEventIterator& other) const noexcept { return this->_eventIndex >= other._eventIndex; }

    inline reference operator* () const noexcept { return *this->getCachedData (this->_eventIndex); }
    inline pointer operator-> () const noexcept { return this->getCachedData (this->_eventIndex); }
    inline reference operator[] (ARAInt32 offset) const noexcept { return *this->getCachedData (this->_eventIndex + offset); }

private:
    inline pointer getCachedData (ARAInt32 index) const noexcept
    {
        if (this->_cachedEventIndex != index)
        {
            _cachedData = this->_contentReader->getDataForEvent (index);
            this->_cachedEventIndex = index;
        }
        return &this->_cachedData;
    }

private:
    const ContentReader* _contentReader;
    ARAInt32 _eventIndex;
    mutable ARAInt32 _cachedEventIndex;
    mutable value_type _cachedData;
};

/*******************************************************************************/

// Internal no-op validation class for ContentReaders

template <ARAContentType contentType, typename ControllerType, typename ContentReaderRefType>
struct NoContentValidator
{
    inline void validateEventCount (ARAInt32 /*eventCount*/) {}
    inline void prepareValidateEvent (ControllerType* /*controller*/, ContentReaderRefType /*ref*/, ARAInt32 /*eventIndex*/) {}
    inline void validateEvent (const void* /*dataPtr*/, ARAInt32 /*eventIndex*/) {}
};

/*******************************************************************************/
// ContentReader
/** Wrapper class for convenient and type safe content reading.
*/
/*******************************************************************************/

template <ARAContentType contentType, typename ControllerType, typename ContentReaderRefType, typename ValidatorClass = NoContentValidator<contentType, ControllerType, ContentReaderRefType>>
class ContentReader
{
protected:
    inline ContentReader () noexcept = default;  // not to be called externally, used as helper for move c'tor only

public:
    //! The type of ARA content data for this reader.
    using DataType = typename ContentTypeMapper<contentType>::DataType;

    template<typename ModelObjectRefType>
    inline ContentReader (ControllerType* controller, ModelObjectRefType modelObjectRef, const ARAContentTimeRange* range = nullptr) noexcept
    : _controller { controller },
      _isAvailable { (controller) ? (controller->*ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::isContentAvailable) (modelObjectRef, contentType) : false },
      _grade { this->_isAvailable ? (controller->*ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::getContentGrade) (modelObjectRef, contentType) : kARAContentGradeInitial },
      _ref { this->_isAvailable ? (controller->*ContentReaderFunctionMapper<ControllerType, ModelObjectRefType>::createContentReader) (modelObjectRef, contentType, range) : nullptr },
      _eventCount { this->_isAvailable ? controller->getContentReaderEventCount (this->_ref) : 0 }
    {
        if (this->_isAvailable)
            this->_validator.validateEventCount (this->_eventCount);
    }

    ContentReader (const ContentReader& other) = delete;
    ContentReader& operator= (const ContentReader& other) = delete;

    inline ContentReader (ContentReader&& other) noexcept
    : ContentReader {}
    { *this = std::move (other); }

    inline ContentReader& operator= (ContentReader&& other) noexcept
    {
        std::swap (this->_controller, other._controller);
        std::swap (this->_isAvailable, other._isAvailable);
        this->_grade = other._grade;
        std::swap (this->_ref, other._ref);
        this->_eventCount = other._eventCount;
        return *this;
    }

    inline ~ContentReader () noexcept
    {
        if (this->_isAvailable)
            this->_controller->destroyContentReader (this->_ref);
    }

    //! Tests whether content is available.
    //! Can be written as `if (someContentReader) ...`
    inline operator bool () const noexcept
    { return this->_isAvailable; }

    //! Get the grade of the content.
    inline ARAContentGrade getGrade () const noexcept
    { return this->_grade; }

    //! Get the number of content events.
    //! Will be 0 if content is not available, or for time-limited content types if range does not cover any events.
    inline ARAInt32 getEventCount () const noexcept
    { return this->_eventCount; }

    //! Returns a pointer to the data at index \p eventIndex.
    //! Care must be taken when accessing this pointer, its content will only be valid until
    //! any other content reading call is made or the reader is destroyed!
    inline const DataType* getDataPtrForEvent (ARAInt32 eventIndex) const noexcept
    {
#if defined (ARA_INTERNAL_ASSERT)
        ARA_INTERNAL_ASSERT (eventIndex < this->_eventCount);
#endif
        _validator.prepareValidateEvent (this->_controller, this->_ref, eventIndex);
        const DataType* dataPtr = static_cast<const DataType*> (this->_controller->getContentReaderDataForEvent (this->_ref, eventIndex));
        _validator.validateEvent (dataPtr, eventIndex);
        return dataPtr;
    }

    //! Returns the data at index \p eventIndex.
    inline DataType getDataForEvent (ARAInt32 eventIndex) const noexcept
    { return *this->getDataPtrForEvent (eventIndex); }

    //! \copybrief getDataForEvent
    inline DataType operator[] (ARAInt32 eventIndex) const noexcept
    { return this->getDataForEvent (eventIndex); }
    inline DataType operator[] (size_t eventIndex) const noexcept
    { return this->getDataForEvent (static_cast<ARAInt32> (eventIndex)); }

//! @name STL Iterator Compatibility
//! See ContentReaderEventIterator <>.
//@{
    using const_iterator = ContentReaderEventIterator<ContentReader>;
    inline const_iterator begin () const
    { return const_iterator (this, 0); }
    inline const_iterator end () const
    { return const_iterator (this, this->_eventCount); }
//@}

private:
    ControllerType* _controller { nullptr };
    bool _isAvailable { false };
    ARAContentGrade _grade { kARAContentGradeInitial };
    ContentReaderRefType _ref { nullptr };
    ARAInt32 _eventCount { 0 };
    mutable ValidatorClass _validator;
};

//! @} ARA_Library_Utility_Content_Readers

} // namespace ARA

#endif // ARAContentReader_h
