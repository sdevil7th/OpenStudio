//------------------------------------------------------------------------------
//! \file       ARASamplePositionConversion.h
//!             convenience functions to ensure consistent conversion from
//!             continuous time to discrete sample positions and vice versa.
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

#ifndef ARASamplePositionConversion_h
#define ARASamplePositionConversion_h

#include <vector>
#include <algorithm>
#include <cmath>

namespace ARA {

//! @addtogroup ARA_Library_Utility_Rounding
//! @{

/*******************************************************************************/
//! @name Rounding to Sample Position
//! Rounding from a continuous time or sample position to a discrete sample position.
//! The rounding intervals are closed on the negative and open on the positive end, which keeps them
//! consistent with all other ARA intervals and prevents potential rounding issues when ranges cross 0.
//! For positive values, this matches regular llround(), but for negative values it rounds -x.5 towards
//! +inf not -inf.
//@{

template<typename SamplePositionType = ARASamplePosition>
inline SamplePositionType roundSamplePosition (double continuousSample) { return static_cast<SamplePositionType> (std::floor (continuousSample + 0.5)); }

template<typename SamplePositionType = ARASamplePosition>
inline SamplePositionType samplePositionAtTime (ARATimePosition timePosition, ARASampleRate sampleRate) { return roundSamplePosition<SamplePositionType> (timePosition * sampleRate); }

//@}

/*******************************************************************************/
//! @name Converting Sample Position To Time
//! Inverse operation of samplePositionAtTime (ARATimePosition t, ARASampleRate sampleRate).
//@{

template<typename SamplePositionType = ARASamplePosition>
inline ARATimePosition timeAtSamplePosition (SamplePositionType samplePositon, ARASampleRate sampleRate) { return static_cast<double> (samplePositon) / sampleRate; }

//@}

//! @} ARA_Library_Utility_Rounding

}   // namespace ARA

#endif // ARASamplePositionConversion_h
