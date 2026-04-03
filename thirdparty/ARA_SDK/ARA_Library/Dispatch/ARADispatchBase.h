//------------------------------------------------------------------------------
//! \file       ARADispatchBase.h
//!             C-to-C++ adapter helpers shared by ARA plug-in and host implementations
//!             Originally written and contributed to the ARA SDK by PreSonus Software Ltd.
//!             Typically, this file is not included directly - either ARAHostDispatch.h or
//!             ARAPlugInDispatch.h will be used instead.
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

#ifndef ARADispatchBase_h
#define ARADispatchBase_h

#include <cstddef>
#include <type_traits>
#include <algorithm>
#include <memory>

#include "ARA_API/ARAInterface.h"


namespace ARA {

/*******************************************************************************/
// Helper templates for type safe conversions between external opaque (host)refs
// and internal object pointers.
/*******************************************************************************/

template <typename Class, typename... RefTypes>
class ToRefConversionHelper;

template <typename Class>
class ToRefConversionHelper<Class>
{
public:
    explicit constexpr inline ToRefConversionHelper (const Class* ptr) noexcept
    : _ptr { ptr }
    {}

protected:
    const Class* const _ptr;
};

template <typename Class, typename FirstRefType, typename... RefTypes>
class ToRefConversionHelper<Class, FirstRefType, RefTypes...> : public ToRefConversionHelper<Class, RefTypes...>
{
public:
    using ToRefConversionHelper<Class, RefTypes...>::ToRefConversionHelper;

    constexpr inline operator FirstRefType () const noexcept
    { return reinterpret_cast<FirstRefType> (const_cast<Class*> (this->_ptr)); }
};


template <typename Class, typename... RefTypes>
class FromRefConversionHelper;

template <typename Class>
class FromRefConversionHelper<Class>
{
protected:
    explicit constexpr inline FromRefConversionHelper (Class* ptr) noexcept
    : _ptr { ptr }
    {}

public:
    constexpr inline operator Class* () const noexcept
    { return this->_ptr; }

    constexpr inline Class* operator-> () const noexcept
    { return this->_ptr; }

protected:
    Class* const _ptr;
};

template <typename Class, typename FirstRefType, typename... RefTypes>
class FromRefConversionHelper<Class, FirstRefType, RefTypes...> : public FromRefConversionHelper<Class, RefTypes...>
{
protected:
    using FromRefConversionHelper<Class, RefTypes...>::FromRefConversionHelper;

public:
    explicit constexpr inline FromRefConversionHelper (const FirstRefType ref) noexcept
    : FromRefConversionHelper<Class, RefTypes...> { reinterpret_cast<Class*> (const_cast<FirstRefType> (ref)) }
    {}
};

//! @addtogroup ARA_Library_Utility_SizedStructs
//! @{

/*******************************************************************************/
// ARA_DISABLE_COPY_AND_MOVE macro
// Used to prevent copying / moving an object managed by the API partner.
/*******************************************************************************/

#if !defined (ARA_DISABLE_COPY_AND_MOVE)
    #define ARA_DISABLE_COPY_AND_MOVE(ClassName) \
        ClassName (const ClassName& other) = delete; \
        ClassName& operator= (const ClassName& other) = delete; \
        ClassName (ClassName&& other) = delete; \
        ClassName& operator= (ClassName&& other) = delete;
#endif

/*******************************************************************************/
// ARA_STRUCT_MEMBER pre-C++17 utility macro
/** When dealing with ARA variable-sized structures, this eases defining the related C++ template arguments */
/*******************************************************************************/

#if defined (__cpp_template_auto)
    // defined here so that code can be written to support both pre-C++17 and C++17 by always using the macro
    // note that code which can rely on C++17 and up does not need to use the macro,
    // writing e.g. SizedStruct<&ARAFactory::supportedPlaybackTransformationFlags> instead.
    #define ARA_STRUCT_MEMBER(StructType, member) &ARA::StructType::member
#else
    #define ARA_STRUCT_MEMBER(StructType, member) ARA::StructType, decltype (ARA::StructType::member), &ARA::StructType::member
#endif

/*******************************************************************************/
// SizedStruct

//! Templated C++ wrapper for ARA's variable-sized structs, ensuring their proper initialization.
//!
//! ARA structs are versioned with a `structSize` member indicating the last implemented member
//! of the struct. Using SizedStruct will automatically set `structSize` according to the
//! `member` template parameter. For example, to declare an ARADocumentControllerInterface
//! struct that implements every function up until ARADocumentControllerInterface::storeObjectsToArchive(),
//! you can declare a SizedStruct like so:
//! \code{.cpp}
//! SizedStruct<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, storeObjectsToArchive)> dci;
//! \endcode
//! In this example, `dci` won't support any function declared after ARADocumentControllerInterface::storeObjectsToArchive(),
//! meaning it won't support ARA Analysis Algorithm selection.
/*******************************************************************************/

#if defined (_MSC_VER)
    __pragma (warning(push))
    __pragma (warning(disable : 4324))  // disable padding warnings, instances of this struct template may need to be padded.
#endif

#if defined (__cpp_template_auto)
template <auto member>
struct alignas (alignof (void*)) SizedStruct;

template <typename StructType, typename MemberType, MemberType StructType::*member>
struct alignas (alignof (void*)) SizedStruct<member> : public StructType
#else
template <typename StructType, typename MemberType, MemberType StructType::*member>
struct alignas (alignof (void*)) SizedStruct : public StructType
#endif
{
protected:
    //! \p SizedStruct alias, to allow any derived class to easily reference its templated base class.
    using BaseType = SizedStruct;

public:
    //! Returns the versioned size of the \p StructType.
    //! ARA uses \p StructType::structSize as a means of versioning, so this function returns
    //! the size of the struct as though \p member was the last implemented field.
    static constexpr inline size_t getImplementedSize ()
    {
        static_assert (std::is_class<StructType>::value && std::is_standard_layout<StructType>::value, "C compatible standard layout struct required");
        return reinterpret_cast<intptr_t> (&(static_cast<StructType*> (nullptr)->*member)) + sizeof (static_cast<StructType*> (nullptr)->*member);
    }

    //! Initializer list constructor.
    //! Can be used initialize the \p StructType fields using a braced initializer list.
    //! Uninitialized members will be set to 0.
    template <typename... InitializerTypes>
    constexpr inline SizedStruct (InitializerTypes... initializers) noexcept
    : StructType { SizedStruct::getImplementedSize (), std::forward<InitializerTypes> (initializers)... }
    {}

    //! Default constructor.
    //! Special-cases the initializer list constructor only to suppress warnings about missing initializers for default construction.
#if __cplusplus >= 201402L
    constexpr
#endif
              inline SizedStruct () noexcept
    : StructType {}
    {
        this->structSize = SizedStruct::getImplementedSize ();
    }
};

#if defined (_MSC_VER)
    __pragma (warning(pop))
#endif

/*******************************************************************************/
// SizedStructPtr

//! Templated smart pointer to conveniently evaluate pointers to ARA variable-sized structures.
//!
//! Wrapping an ARA struct pointer using SizedStructPtr allows easy detection of the struct "version",
//! i.e what members it does and does not support. For example, if we wanted to know whether an
//! ARADocumentControllerInterface instance supports ARA Analysis Algorithm Selection, we could
//! use SizedStructPtr like so:
//! \code{.cpp}
//! bool supportsAnalysisAlgorithmSelection (ARADocumentControllerInterface* dci)
//! {
//!      SizedStructPtr<ARADocumentControllerInterface> sizedStructPtr (dci);
//!      return sizedStructPtr.implements<ARA_STRUCT_MEMBER (ARADocumentControllerInterface, getProcessingAlgorithmsCount)> ();
//! }
//! \endcode
/*******************************************************************************/

template <typename StructType>
class SizedStructPtr
{
public:
    //! Construct from a pointer to \p StructType.
    inline SizedStructPtr (const StructType* ptr) noexcept
    : _ptr { ptr }
    {}

    //! Dereference the underlying \p StructType pointer.
    inline operator const StructType* () const noexcept
    { return this->_ptr; }

    //! Access the underlying \p StructType pointer.
    inline const StructType* operator-> () const noexcept
    { return this->_ptr; }

    //! Check if \p StructType is sized large enough to implement \p member.
    //! ARA uses the \p StructType::structSize member as a means of versioning -
    //! if it is large enough to contain \p member then this function returns true.
    //! This is a C++ version of ARA_IMPLEMENTS_FIELD.
#if defined (__cpp_template_auto)
    template <auto member>
    inline bool implements () const noexcept
    {
    #if defined (__clang__) && (__clang_major__ < 10)
        // see clang bug: https://bugs.llvm.org/show_bug.cgi?id=35655
        // as workaround, we're copying the code from SizedStruct<member>::getImplementedSize () here
        static_assert (std::is_class<StructType>::value && std::is_standard_layout<StructType>::value, "C compatible standard layout struct required");
        return this->_ptr->structSize >= reinterpret_cast<intptr_t> (&(static_cast<StructType*> (nullptr)->*member)) + sizeof (static_cast<StructType*> (nullptr)->*member);
    #else
        return this->_ptr->structSize >= SizedStruct<member>::getImplementedSize ();
    #endif
    }
#else
    template <typename DummyStructType, typename MemberType, MemberType StructType::*member>
    inline bool implements () const noexcept
    {
        static_assert (std::is_same<DummyStructType, StructType>::value, "must test member of same struct");
        return this->_ptr->structSize >= SizedStruct<StructType, MemberType, member>::getImplementedSize ();
    }
#endif

private:
    const StructType* _ptr;
};

/*******************************************************************************/
// InterfaceInstance

//! Templated base class to ease wrapping ARA interface structure callable into C++ classes.
/*******************************************************************************/

template <typename RefType, typename Interface>
class InterfaceInstance
{
protected:
    //! \p InterfaceInstance alias, to allow derived classes to easily reference their templated base class.
    using BaseType = InterfaceInstance;

    //! Constructor for derived classes to wrap a \p ref and \p interface pointer.
    //! The derived classes typically read these values from an instance struct
    //! which is passed to their public c'tor.
    inline InterfaceInstance (RefType ref, const Interface* ifc) noexcept
    : _ref { ref },
      _interface { ifc }
    {}

public:
    //! Retrieve the ARA reference associated with \p Interface.
    inline RefType getRef () const noexcept
    { return this->_ref; }

    //! Retrieve the underlying \p Interface pointer.
    inline const SizedStructPtr<Interface>& getInterface () const noexcept
    { return this->_interface; }

    //! Returns whether or not an implementation of the interface was provided.
    inline bool isProvided () const noexcept
    { return (this->_interface != nullptr); }

private:
    RefType const _ref;
    const SizedStructPtr<Interface> _interface;
};

//! @} ARA_Library_Utility_SizedStructs

//! @addtogroup ARA_Library_Utility_Content_Update_Scopes
//! @{

/*******************************************************************************/
// ContentUpdateScopes

//! Utility class to conveniently deal with ARAContentUpdateFlags.
//! This class contains static constants that can be combined with operator+
//! to describe any given change, for example notesAreAffected () + timelineIsAffected ().
//! Likewise, its member functions allow for testing these conditions.
/*******************************************************************************/

class ContentUpdateScopes
{
public:

//! @name Sending content updates.
//! These constants are meant to be used when sending
//! a content update notification. They can be combined using
//! operator+ and operator+= to define a particular update scope.
//@{
    //! Nothing is affected by the change.
    static constexpr ContentUpdateScopes nothingIsAffected () noexcept { return ContentUpdateScopes (); }

    //! The actual signal is affected by the change.
    static constexpr ContentUpdateScopes samplesAreAffected () noexcept { return nothingIsAffected ()._flags & ~kARAContentUpdateSignalScopeRemainsUnchanged; }
    //! Content information for notes, beat-markers etc. is affected by the change.
    static constexpr ContentUpdateScopes notesAreAffected () noexcept { return nothingIsAffected ()._flags & ~kARAContentUpdateNoteScopeRemainsUnchanged; }
    //! Content information for tempo, bar signatures etc. is affected by the change.
    static constexpr ContentUpdateScopes timelineIsAffected () noexcept { return nothingIsAffected ()._flags & ~kARAContentUpdateTimingScopeRemainsUnchanged; }
    //! Content readers for tuning etc. are affected by the change.
    static constexpr ContentUpdateScopes tuningIsAffected () noexcept { return nothingIsAffected ()._flags & ~kARAContentUpdateTuningScopeRemainsUnchanged; }
    //! Content readers for key signatures, chords etc. are affected by the change.
    static constexpr ContentUpdateScopes harmoniesAreAffected () noexcept { return nothingIsAffected ()._flags & ~kARAContentUpdateHarmonicScopeRemainsUnchanged; }

    //! Everything is affected by the change.
    static constexpr ContentUpdateScopes everythingIsAffected () noexcept { return kARAContentUpdateEverythingChanged; }
//@}

//! @name Creating update scopes.
//@{
    //! Default constructor sets flags to nothingIsAffected.
    //! This sets flags to mean nothing has changed, and is rarely to be used directly.
    constexpr ContentUpdateScopes () noexcept : _flags { _knownFlags } {}

    //! Construct from ARAContentFlags.
    constexpr ContentUpdateScopes (const ARAContentUpdateFlags flags) noexcept : _flags { flags } {}

    //! Conversion to ARAContentUpdateFlags.
    constexpr operator ARAContentUpdateFlags () const noexcept { return _flags; }

    //! Combine two scopes into a single ContentUpdateScopes.
    ContentUpdateScopes operator+= (const ContentUpdateScopes& other) noexcept
    {
        _flags &= other._flags;
        return *this;
    }

    //! \copybrief operator+=
    constexpr ContentUpdateScopes operator+ (const ContentUpdateScopes& other) const noexcept { return (_flags & other._flags); }
//@}

//! @name Receiving content updates.
//! These functions can be used by receivers of content updates
//! to query the scope of what's affected by the update.
//@{
    //! \copybrief samplesAreAffected
    constexpr bool affectSamples () const noexcept { return ((_flags & kARAContentUpdateSignalScopeRemainsUnchanged) == 0); }
    //! \copybrief notesAreAffected
    constexpr bool affectNotes () const noexcept { return ((_flags & kARAContentUpdateNoteScopeRemainsUnchanged) == 0); }
    //! \copybrief timelineIsAffected
    constexpr bool affectTimeline () const noexcept { return ((_flags & kARAContentUpdateTimingScopeRemainsUnchanged) == 0); }
    //! \copybrief tuningIsAffected
    constexpr bool affectTuning () const noexcept { return ((_flags & kARAContentUpdateTuningScopeRemainsUnchanged) == 0); }
    //! \copybrief harmoniesAreAffected
    constexpr bool affectHarmonies () const noexcept { return ((_flags & kARAContentUpdateHarmonicScopeRemainsUnchanged) == 0); }
    //! \copybrief everythingIsAffected
    constexpr bool affectEverything () const noexcept { return ((_flags & _knownFlags) == 0); }
//@}

private:
    static constexpr ARAContentUpdateFlags _knownFlags { (kARAContentUpdateSignalScopeRemainsUnchanged |
                                                          kARAContentUpdateNoteScopeRemainsUnchanged | kARAContentUpdateTimingScopeRemainsUnchanged |
                                                          kARAContentUpdateTuningScopeRemainsUnchanged | kARAContentUpdateHarmonicScopeRemainsUnchanged) };
    ARAContentUpdateFlags _flags;
};

//! @} ARA_Library_Utility_Content_Update_Scopes

}   // namespace ARA

#endif // ARADispatchBase_h
