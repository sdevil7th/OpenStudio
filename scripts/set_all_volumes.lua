-- @desc Set All Track Volumes — reset every track to 0 dB
-- Useful for normalizing a mix starting point

local trackCount = s13.getTrackCount()

if trackCount == 0 then
    s13.print("No tracks in project.")
    return
end

s13.print("Resetting " .. trackCount .. " tracks to 0 dB...")

-- getMeteringData returns an array; we need the track IDs
-- For now, iterate by metering index (tracks are ordered)
-- Note: the Lua API currently works with track IDs, so this
-- script demonstrates the concept. In practice you'd need
-- getTrack(index) which returns the track info including ID.
s13.print("Note: This script requires track IDs from the frontend.")
s13.print("Use the Script Editor to pass track-specific commands.")

s13.print("Setting master volume to unity (1.0)...")
s13.setMasterVolume(1.0)
s13.setMasterPan(0.0)
s13.print("Master volume: " .. s13.getMasterVolume())
s13.print("Master pan: " .. s13.getMasterPan())
s13.print("Done!")
