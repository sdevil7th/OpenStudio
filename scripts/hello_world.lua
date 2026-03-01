-- @desc Hello World — verify that Lua scripting is working
-- Studio13 starter script

s13.print("Hello from Studio13 Lua scripting!")
s13.print("App version: " .. s13.getAppVersion())
s13.print("Current tempo: " .. s13.getTempo() .. " BPM")

local ts = s13.getTimeSignature()
s13.print("Time signature: " .. ts.num .. "/" .. ts.den)

local trackCount = s13.getTrackCount()
s13.print("Number of tracks: " .. trackCount)

s13.print("")
s13.print("Scripting engine is ready!")
