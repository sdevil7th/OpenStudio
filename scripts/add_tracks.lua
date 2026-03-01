-- @desc Add Multiple Tracks — create several tracks at once
-- Demonstrates track management from Lua

local numTracks = 4  -- Change this to add more or fewer tracks

s13.print("Adding " .. numTracks .. " new tracks...")

local ids = {}
for i = 1, numTracks do
    local trackId = s13.addTrack()
    if trackId then
        table.insert(ids, trackId)
        s13.print("  Created track " .. i .. ": " .. trackId)
    else
        s13.print("  Failed to create track " .. i)
    end
end

s13.print("")
s13.print("Created " .. #ids .. " tracks.")
s13.print("Total track count: " .. s13.getTrackCount())
