-- @desc Project Info — display current project status
-- Useful for debugging and quick overviews

s13.print("=== Studio13 Project Info ===")
s13.print("")

-- App info
s13.print("App Version: " .. s13.getAppVersion())

-- Transport
s13.print("")
s13.print("--- Transport ---")
s13.print("Playing: " .. tostring(s13.isPlaying()))
s13.print("Recording: " .. tostring(s13.isRecording()))
s13.print("Playhead: " .. string.format("%.2f", s13.getPlayhead()) .. " sec")

-- Tempo & time signature
s13.print("")
s13.print("--- Tempo ---")
s13.print("Tempo: " .. s13.getTempo() .. " BPM")
local ts = s13.getTimeSignature()
s13.print("Time Sig: " .. ts.num .. "/" .. ts.den)

-- Metronome
s13.print("")
s13.print("--- Metronome ---")
s13.print("Enabled: " .. tostring(s13.isMetronomeEnabled()))

-- Tracks
s13.print("")
s13.print("--- Tracks ---")
s13.print("Track count: " .. s13.getTrackCount())

-- Master
s13.print("")
s13.print("--- Master ---")
s13.print("Master Volume: " .. string.format("%.3f", s13.getMasterVolume()))
s13.print("Master Pan: " .. string.format("%.3f", s13.getMasterPan()))

s13.print("")
s13.print("=== End Info ===")
