-- @desc Tempo Ramp — gradually change tempo over a range
-- Demonstrates transport and tempo control from Lua

local startBPM = s13.getTempo()
local endBPM = startBPM + 20  -- ramp up by 20 BPM

s13.print("Current tempo: " .. startBPM .. " BPM")
s13.print("This script will set tempo to " .. endBPM .. " BPM")
s13.print("(In a full implementation, this would create tempo automation)")

-- For now, just set the final tempo
s13.setTempo(endBPM)
s13.print("Tempo set to: " .. s13.getTempo() .. " BPM")
s13.print("")
s13.print("Tip: Use s13.setTempo(bpm) to set any tempo.")
s13.print("     Use s13.getTempo() to read current tempo.")
