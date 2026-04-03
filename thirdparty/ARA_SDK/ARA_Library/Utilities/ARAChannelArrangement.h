//------------------------------------------------------------------------------
//! \file       ARAChannelArrangement.h
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

#ifndef ARAChannelArrangement_h
#define ARAChannelArrangement_h

#include "ARA_API/ARAInterface.h"

namespace ARA {

//! @addtogroup ARA_Library_Utility_Channel_Arrangement
//! @{

//! Helper class to parse the opaque, Companion-API-dependent channel arrangement information.
class ChannelArrangement
{
public:
    //! Construct either as default, undefined format, or construct with explicit data.
    ChannelArrangement ()
    : ChannelArrangement { kARAChannelArrangementUndefined, nullptr } {}

    ChannelArrangement (const ARAChannelArrangementDataType channelArrangementDataType,
                        const void* const channelArrangement)
    : _channelArrangementDataType { channelArrangementDataType }, _channelArrangement { channelArrangement } {}

    //! Equality tests.
    bool operator== (const ChannelArrangement& other) const noexcept;
    bool operator!= (const ChannelArrangement& other) const noexcept { return !(*this == other); }

    //! Returns the channel arrangement data type.
    ARAChannelArrangementDataType getChannelArrangementDataType () const noexcept { return _channelArrangementDataType; }

    //! Returns the Companion-API-dependent channel arrangement data.
    const void* getChannelArrangement () const noexcept { return _channelArrangement; }

    //! Returns the size of the opaque channel arrangement data.
    ARASize getDataSize () const noexcept;

    //! Returns the channel count encoded in the channel arrangement data.
    //! May return 0 if the arrangement data does not imply a certain channel count.
    ARAChannelCount getImpliedChannelCount () const noexcept;

    //! Validation helper for use at API boundary.
    bool isValidForChannelCount (ARAChannelCount requiredChannelCount) const noexcept;
    
private:
    const ARAChannelArrangementDataType _channelArrangementDataType;
    const void* const _channelArrangement;
};

//! @} ARA_Library_Utility_Channel_Arrangement

}   // namespace ARA

#endif // ARAChannelArrangement_h
