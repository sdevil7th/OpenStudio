//------------------------------------------------------------------------------
//! \file       ARATimelineConversion.h
//!             classes to effectively iterate over tempo and signature content readers
//!             and convert between in seconds or quarters and between quarters and beats
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

#ifndef ARATimelineConversion_h
#define ARATimelineConversion_h

#include "ARA_Library/Dispatch/ARAContentReader.h"
#include "ARA_Library/Utilities/ARASamplePositionConversion.h"

#include <algorithm>
#include <iterator>
#include <cmath>

namespace ARA {

//! @addtogroup ARA_Library_Utility_Timeline_Conversion
//! @{

/*******************************************************************************/
// TempoConverter
/** Efficient conversion between physical time in seconds and musical time in quarters.
    Utilizes internal cache of last access to optimize next access if "close" to last access,
    which is the typical case during playback, when drawing a time line, etc.
    templated so it can be used in both hosts and plug-ins with content readers,
    or with any other data structure that provides a matching interface.
 */
/*******************************************************************************/

template <typename TempoContentReader>
class TempoConverter
{
public:
    //! Construct using a host or plug-in ::kARAContentTypeTempoEntries reader.
    TempoConverter (const TempoContentReader& contentReader)
    : _contentReader { contentReader },
      _leftEntryCache { this->_contentReader.begin () },
      _rightEntryCache { std::next (this->_leftEntryCache) }
    {}

    //! Convert a position in time to a quarter position.
    ARAQuarterPosition getQuarterForTime (const ARATimePosition timePosition) const
    {
        this->updateCacheByPosition (timePosition, [] (ARATimePosition position, const ARAContentTempoEntry& tempoEntry)
                                                    {
                                                        return position < tempoEntry.timePosition;
                                                    });

        const auto quartersPerSecond { (this->_rightEntryCache->quarterPosition - this->_leftEntryCache->quarterPosition) / (this->_rightEntryCache->timePosition - this->_leftEntryCache->timePosition) };
        return this->_leftEntryCache->quarterPosition + (timePosition - this->_leftEntryCache->timePosition) * quartersPerSecond;
    }

    //! Convert a quarter position to a position in time.
    ARATimePosition getTimeForQuarter (const ARAQuarterPosition quarterPosition) const
    {
        this->updateCacheByPosition (quarterPosition, [] (ARAQuarterPosition position, const ARAContentTempoEntry& tempoEntry)
                                                    {
                                                        return position < tempoEntry.quarterPosition;
                                                    });

        const auto secondsPerQuarter { (this->_rightEntryCache->timePosition - this->_leftEntryCache->timePosition) / (this->_rightEntryCache->quarterPosition - this->_leftEntryCache->quarterPosition) };
        return this->_leftEntryCache->timePosition + (quarterPosition - this->_leftEntryCache->quarterPosition) * secondsPerQuarter;
    }

private:
    template <typename T, typename Func>
    void updateCacheByPosition (const T position, Func findByPosition) const
    {
        if (findByPosition (position, *this->_leftEntryCache))
        {
            if (this->_leftEntryCache != this->_contentReader.begin ())
            {
                // test if we're hitting the entries pair right before the current entries pair
                const auto prevLeft { std::prev (this->_leftEntryCache) };
                if ((prevLeft == this->_contentReader.begin ()) || !findByPosition (position, *prevLeft))
                {
                    this->_rightEntryCache = this->_leftEntryCache;
                    this->_leftEntryCache = prevLeft;
                }
                else
                {
                    // find the entry after position, then pick left and right entry based on position being before or after first entry
                    const auto it { std::upper_bound (this->_contentReader.begin (), prevLeft, position, findByPosition) };
                    if (it == this->_contentReader.begin ())
                    {
                        this->_leftEntryCache = it;
                        this->_rightEntryCache = std::next (it);
                    }
                    else
                    {
                        this->_leftEntryCache = std::prev (it);
                        this->_rightEntryCache = it;
                    }
                }
            }
        }
        else if (!findByPosition (position, *this->_rightEntryCache))
        {
            const auto nextRight { std::next (this->_rightEntryCache) };
            if (nextRight != this->_contentReader.end ())
            {
                // test if we're hitting the entries pair right after the current entries pair
                const auto last { std::prev (this->_contentReader.end ()) };
                if ((nextRight == last) || findByPosition (position, *nextRight))
                {
                    this->_leftEntryCache = this->_rightEntryCache;
                    this->_rightEntryCache = nextRight;
                }
                else
                {
                    // find the entry after position (or last entry)
                    this->_rightEntryCache = std::upper_bound (std::next (nextRight), last, position, findByPosition);
                    this->_leftEntryCache = std::prev (this->_rightEntryCache);
                }
            }
        }

        ARA_INTERNAL_ASSERT (!findByPosition (position, *this->_leftEntryCache) || this->_leftEntryCache == this->_contentReader.begin ());
        ARA_INTERNAL_ASSERT (findByPosition (position, *this->_rightEntryCache) || std::next (this->_rightEntryCache) == this->_contentReader.end ());
        ARA_INTERNAL_ASSERT (this->_leftEntryCache == std::prev (this->_rightEntryCache));
    }

private:
    const TempoContentReader& _contentReader;
    mutable typename TempoContentReader::const_iterator _leftEntryCache;
    mutable typename TempoContentReader::const_iterator _rightEntryCache;
};

/*******************************************************************************/
// BarSignaturesConverter
/** Mapping between a given quarter position and its associated bar signature and beat position.
    Utilizes internal cache of last access to optimize next access if "close" to last access,
    which is the typical case during playback, when drawing a time line, etc.
    templated so it can be used in both hosts and plug-ins with content readers,
    or with any other data structure that provides a matching interface.
 */
/*******************************************************************************/

template <typename BarSignaturesContentReader>
class BarSignaturesConverter
{
public:
    //! Construct using a host or plug-in ::kARAContentTypeBarSignatures reader.
    inline BarSignaturesConverter (const BarSignaturesContentReader& reader) noexcept
    : _contentReader { reader },
      _entryCache { this->_contentReader.begin () }
    {}

    //! Look up the bar signature at a particular quarter position.
    inline const ARAContentBarSignature getBarSignatureForQuarter (const ARAQuarterPosition quarterPosition) const noexcept
    {
        this->updateCacheByQuarterPosition (quarterPosition);
        return *this->_entryCache;
    }

    //! Look up the bar signature at a particular beat position.
    inline const ARAContentBarSignature getBarSignatureForBeat (const double beatPosition) const noexcept
    {
        this->updateCacheByBeatPosition (beatPosition);
        return *this->_entryCache;
    }

    //! Get the beats per quarter for \p barSignature.
    static inline double getBeatsPerQuarter (const ARAContentBarSignature& barSignature) noexcept
    {
        return static_cast<double> (barSignature.denominator) / 4.0;
    }

    //! Get the quarters per bar for \p barSignature.
    static inline double getQuartersPerBar (const ARAContentBarSignature& barSignature) noexcept
    {
        return static_cast<double> (barSignature.numerator) / BarSignaturesConverter::getBeatsPerQuarter (barSignature);
    }

    //! Get the beat position for a particular quarter position.
    inline double getBeatForQuarter (const ARAQuarterPosition quarterPosition) const noexcept
    {
        this->updateCacheByQuarterPosition (quarterPosition);
        return this->_entryStartBeatCache + BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, quarterPosition);
    }

    //! Get the quarter position for a particular beat position.
    inline ARAQuarterPosition getQuarterForBeat (const double beatPosition) const noexcept
    {
        this->updateCacheByBeatPosition (beatPosition);
        return this->_entryCache->position + (beatPosition - this->_entryStartBeatCache) / BarSignaturesConverter::getBeatsPerQuarter (*this->_entryCache);
    }

    //! Get the distance in beats from the start of the bar signature at \p quarterPosition.
    inline double getBeatDistanceFromBarStartForQuarter (const ARAQuarterPosition quarterPosition) const noexcept
    {
        this->updateCacheByQuarterPosition (quarterPosition);
        const auto beatDistance { BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, quarterPosition) };
        const auto beatsPerBar { static_cast<double> (this->_entryCache->numerator) };
        const auto remainder { fmod (beatDistance, beatsPerBar) };
        return (beatDistance >= 0) ? remainder : beatsPerBar + remainder;
    }

    //! Get the index of the bar at \p quarterPosition.
    //! Relatively expensive since bar indices aren't cached in the current implementation.
    inline int getBarIndexForQuarter (const ARAQuarterPosition quarterPosition) const noexcept
    {
        this->updateCacheByQuarterPosition (quarterPosition);
        auto bars { floor ((quarterPosition - this->_entryCache->position) / BarSignaturesConverter::getQuartersPerBar (*this->_entryCache)) };
        auto it { this->_entryCache };
        while (it != this->_contentReader.begin ())
        {
            const auto prevEndQuarter { it->position };
            --it;
            bars += (prevEndQuarter - it->position) / BarSignaturesConverter::getQuartersPerBar (*it);
        }
        return (int) (bars + 0.5);
    }

    //! Get the quarter position of the start of the bar at \p barIndex.
    //! Relatively expensive since bar indices aren't cached in the current implementation.
    inline ARAQuarterPosition getQuarterForBarIndex (const int barIndex) const noexcept
    {
        this->_entryCache = this->_contentReader.begin ();
        this->_entryStartBeatCache = 0.0;
        bool didUpdateEntryStartBeatCache { false };
        int startBar { 0 };

        while (true)
        {
            const auto next { std::next (this->_entryCache) };
            if (next == this->_contentReader.end ())
                break;

            const auto nextStartBar { startBar + roundSamplePosition<int> ((next->position - this->_entryCache->position) / BarSignaturesConverter::getQuartersPerBar (*this->_entryCache)) };
            if (nextStartBar > barIndex)
                break;

            startBar = nextStartBar;
            this->_entryStartBeatCache = this->_entryStartBeatCache + BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, next->position);
            didUpdateEntryStartBeatCache = true;
            this->_entryCache = next;
        }

        // to avoid errors adding up over time, we round the cache to an integer value after modification
        if (didUpdateEntryStartBeatCache)
            this->_entryStartBeatCache = std::round (this->_entryStartBeatCache);

        return this->_entryCache->position + (barIndex - startBar) * BarSignaturesConverter::getQuartersPerBar (*this->_entryCache);
    }

private:
    static inline double getBeatDistanceFromQuarterPosition (const typename BarSignaturesContentReader::const_iterator& it, const ARAQuarterPosition quarterPosition) noexcept
    {
        return (quarterPosition - it->position) * BarSignaturesConverter::getBeatsPerQuarter (*it);
    }

    void updateCacheByQuarterPosition (const ARAQuarterPosition quarterPosition) const noexcept
    {
        bool didUpdateEntryStartBeatCache { false };

        if (quarterPosition < this->_entryCache->position)
        {
            // before our entry - go back until first entry or entry before quarter
            while (this->_entryCache != this->_contentReader.begin ())
            {
                const auto prevEndQuarter { this->_entryCache->position };
                --this->_entryCache;
                this->_entryStartBeatCache -= BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, prevEndQuarter);
                didUpdateEntryStartBeatCache = true;
                if (this->_entryCache->position <= quarterPosition)
                    break;
            }
        }
        else
        {
            // at or after our entry - go forward until last entry or entry before quarter
            while (true)
            {
                const auto next { std::next (this->_entryCache) };
                if ((next == this->_contentReader.end ()) || (next->position > quarterPosition))
                    break;

                this->_entryStartBeatCache += BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, next->position);
                didUpdateEntryStartBeatCache = true;
                this->_entryCache = next;
            }
        }

        // to avoid errors adding up over time, we round the cache to an integer value after modification
        if (didUpdateEntryStartBeatCache)
            this->_entryStartBeatCache = std::round (this->_entryStartBeatCache);
    }

    void updateCacheByBeatPosition (const double beatPosition) const noexcept
    {
        bool didUpdateEntryStartBeatCache { false };

        if (beatPosition < this->_entryStartBeatCache)
        {
            // before our entry - go back until first entry or entry before beat
            while (this->_entryCache != this->_contentReader.begin ())
            {
                const auto prevEndQuarter { this->_entryCache->position };
                --this->_entryCache;
                this->_entryStartBeatCache -= BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, prevEndQuarter);
                didUpdateEntryStartBeatCache = true;
                if (this->_entryStartBeatCache <= beatPosition)
                    break;
            }
        }
        else
        {
            // at or after our entry - go forward until last entry or entry before beat
            while (true)
            {
                const auto next { std::next (this->_entryCache) };
                if (next == this->_contentReader.end ())
                    break;

                const auto nextStartBeat { this->_entryStartBeatCache + BarSignaturesConverter::getBeatDistanceFromQuarterPosition (this->_entryCache, next->position) };
                if (nextStartBeat > beatPosition)
                    break;

                this->_entryStartBeatCache = nextStartBeat;
                didUpdateEntryStartBeatCache = true;
                this->_entryCache = next;
            }
        }

        // to avoid errors adding up over time, we round the cache to an integer value after modification
        if (didUpdateEntryStartBeatCache)
            this->_entryStartBeatCache = std::round (this->_entryStartBeatCache);
    }

private:
    const BarSignaturesContentReader& _contentReader;
    mutable typename BarSignaturesContentReader::const_iterator _entryCache;
    mutable double _entryStartBeatCache { 0.0 };
};

//! @} ARA_Library_Utility_Timeline_Conversion

}   // namespace ARA

#endif // ARATimelineConversion_h
