//------------------------------------------------------------------------------
//! \file       ARAStdVectorUtilities.h
//!             convenience functions to ease casting, searching and modifying
//!             STL's std::vector, e.g. when searching derived class pointers
//!             in base class vectors and vice versa
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

#ifndef ARAStdVectorUtilities_h
#define ARAStdVectorUtilities_h

#include <vector>
#include <algorithm>

namespace ARA {

//! @addtogroup ARA_Library_Utility_StdVec
//! @{

/*******************************************************************************/
//! @name std::vector casts
//! Up-casting vectors of base class pointers to vectors of derived class pointers.
//@{

template <typename T, typename U, typename std::enable_if<(sizeof (T) == sizeof (U)) && (std::is_convertible<T, U>::value || std::is_convertible<U, T>::value), bool>::type = true>
inline std::vector<T>& vector_cast (std::vector<U>& container) noexcept
{
    return reinterpret_cast<std::vector<T>&> (container);
}

template <typename T, typename U, typename std::enable_if<(sizeof (T) == sizeof (U)) && (std::is_convertible<T, U>::value || std::is_convertible<U, T>::value), bool>::type = true>
inline std::vector<T> const& vector_cast (std::vector<U> const& container) noexcept
{
    return reinterpret_cast<std::vector<T> const&> (container);
}
//@}

/*******************************************************************************/
//! @name find_erase
//! Find an element in the vector and, if found, erase it from the vector.
//! Returns true if found & erased, otherwise false.
//@{

template <typename T, typename U, typename std::enable_if<std::is_convertible<T, U>::value || std::is_convertible<U, T>::value, bool>::type = true>
inline bool find_erase (std::vector<T>& container, const U& element) noexcept
{
    const auto it { std::find (container.begin (), container.end (), element) };
    if (it == container.end ())
        return false;

    container.erase (it);
    return true;
}
//@}

/*******************************************************************************/
//! @name contains
//! Determine if an element exists in a vector.
//@{

template <typename T, typename U, typename std::enable_if<std::is_convertible<T, U>::value || std::is_convertible<U, T>::value, bool>::type = true>
inline bool contains (std::vector<T> const& container, const U& element) noexcept
{
    return std::find (container.begin (), container.end (), element) != container.end ();
}

//@}

//! @} ARA_Library_Utility_StdVec

}   // namespace ARA

#endif // ARAStdVectorUtilities_h
