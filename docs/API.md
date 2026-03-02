# Studio13 Lua Scripting API Reference

Studio13 provides a Lua scripting engine accessible via `s13.*` functions. Scripts can be edited and run from the Script Editor (View > Script Editor).

## Track Operations

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.getTrackCount()` | none | `number` | Returns total number of tracks |
| `s13.addTrack(name)` | `name: string` | `trackId: string` | Creates a new audio track |
| `s13.removeTrack(trackId)` | `trackId: string` | `boolean` | Removes a track |
| `s13.setTrackVolume(trackId, dB)` | `trackId: string, dB: number` | none | Set track volume (-60 to +12 dB) |
| `s13.setTrackPan(trackId, pan)` | `trackId: string, pan: number` | none | Set track pan (-1.0 L to +1.0 R) |
| `s13.setTrackMute(trackId, muted)` | `trackId: string, muted: boolean` | none | Set track mute state |
| `s13.setTrackSolo(trackId, soloed)` | `trackId: string, soloed: boolean` | none | Set track solo state |
| `s13.setTrackArm(trackId, armed)` | `trackId: string, armed: boolean` | none | Set track record arm |
| `s13.reorderTrack(fromIdx, toIdx)` | `from: number, to: number` | none | Move track position |

## Transport

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.play()` | none | none | Start playback |
| `s13.stop()` | none | none | Stop playback |
| `s13.record()` | none | none | Start recording (arms must be set) |
| `s13.isPlaying()` | none | `boolean` | Check if transport is playing |
| `s13.isRecording()` | none | `boolean` | Check if transport is recording |
| `s13.getPlayhead()` | none | `number` | Get playhead position in seconds |
| `s13.setPlayhead(time)` | `time: number` | none | Set playhead position in seconds |
| `s13.getTempo()` | none | `number` | Get current BPM |
| `s13.setTempo(bpm)` | `bpm: number` | none | Set tempo (20-999 BPM) |
| `s13.getTimeSignature()` | none | `num, den` | Get time signature (two return values) |
| `s13.setTimeSignature(num, den)` | `num: number, den: number` | none | Set time signature |
| `s13.setLoop(enabled, start, end)` | `enabled: boolean, start: number, end: number` | none | Set loop region |

## FX Chain

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.getTrackFX(trackId)` | `trackId: string` | `table` | Get list of track FX plugins |
| `s13.getTrackInputFX(trackId)` | `trackId: string` | `table` | Get list of input FX plugins |
| `s13.addTrackFX(trackId, pluginId)` | `trackId: string, pluginId: string` | `boolean` | Add FX plugin to track |
| `s13.removeTrackFX(trackId, index)` | `trackId: string, index: number` | `boolean` | Remove FX at index |
| `s13.bypassTrackFX(trackId, index, bypassed)` | `trackId: string, index: number, bypassed: boolean` | none | Toggle FX bypass |
| `s13.addTrackS13FX(trackId, effectName)` | `trackId: string, name: string` | `boolean` | Add built-in S13 effect |
| `s13.getAvailableS13FX()` | none | `table` | List available built-in effects |

## Master Bus

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.setMasterVolume(volume)` | `volume: number` | none | Set master volume (0.0 to 2.0 linear) |
| `s13.getMasterVolume()` | none | `number` | Get master volume |
| `s13.setMasterPan(pan)` | `pan: number` | none | Set master pan (-1.0 to +1.0) |
| `s13.getMasterPan()` | none | `number` | Get master pan |

## Sends

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.addTrackSend(trackId, destTrackId)` | `trackId, destTrackId: string` | `number` | Add send, returns send index |
| `s13.removeTrackSend(trackId, index)` | `trackId: string, index: number` | none | Remove send at index |
| `s13.setTrackSendLevel(trackId, index, level)` | `trackId: string, index: number, level: number` | none | Set send level (0.0 to 1.0) |
| `s13.getTrackSends(trackId)` | `trackId: string` | `table` | Get all sends for a track |

## Playback Clips

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.addPlaybackClip(file, start, duration, trackId, offset, volumeDB)` | see args | none | Add audio clip for playback |
| `s13.removePlaybackClip(trackId, file, start)` | `trackId, file: string, start: number` | none | Remove a playback clip |
| `s13.clearPlaybackClips()` | none | none | Remove all playback clips |

## Automation

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.setAutomationPoints(trackId, param, points)` | `trackId: string, param: string, points: table` | none | Set automation points (table of {time, value}) |
| `s13.setAutomationMode(trackId, param, mode)` | `trackId: string, param: string, mode: string` | none | Set automation mode ("read", "write", "touch", "latch") |
| `s13.getAutomationMode(trackId, param)` | `trackId: string, param: string` | `string` | Get automation mode |
| `s13.clearAutomation(trackId, param)` | `trackId: string, param: string` | none | Clear all automation points |

## Audio Analysis

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.measureLUFS(filePath)` | `filePath: string` | `table` | Measure loudness (integrated, shortTerm, momentary, truePeak, range) |
| `s13.detectTransients(filePath, threshold)` | `filePath: string, threshold: number` | `table` | Detect transient positions in seconds |
| `s13.reverseAudioFile(filePath, outputPath)` | `filePath, outputPath: string` | `boolean` | Reverse an audio file |
| `s13.detectSilentRegions(filePath, thresholdDB, minDuration)` | `filePath: string, thresholdDB: number, minDuration: number` | `table` | Detect silent regions |

## Track Freeze

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.freezeTrack(trackId)` | `trackId: string` | `boolean` | Freeze track (render FX to audio) |
| `s13.unfreezeTrack(trackId)` | `trackId: string` | `boolean` | Unfreeze track (restore original) |

## Render

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.renderProject(filePath, format, bitDepth, sampleRate, startTime, endTime)` | see args | `boolean` | Offline render project to file |

## MIDI

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.getMIDIDevices()` | none | `table` | List available MIDI input devices |

## Metronome

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.setMetronomeEnabled(enabled)` | `enabled: boolean` | none | Enable/disable metronome |
| `s13.isMetronomeEnabled()` | none | `boolean` | Check if metronome is enabled |

## Plugins

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.scanForPlugins()` | none | none | Trigger VST3 plugin scan |
| `s13.getAvailablePlugins()` | none | `table` | List all scanned plugins |

## Utility

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `s13.print(...)` | any values | none | Print to script console |
| `s13.getAppVersion()` | none | `string` | Get Studio13 version string |
| `s13.showMessage(title, message)` | `title, message: string` | none | Show a message dialog |
| `s13.fileDialog(title, filters)` | `title, filters: string` | `string` | Open file picker dialog |

## Examples

### Create a track and set its volume
```lua
local id = s13.addTrack("Vocals")
s13.setTrackVolume(id, -6.0)  -- -6 dB
s13.setTrackPan(id, -0.5)     -- pan left 50%
```

### Set up a loop and play
```lua
s13.setTempo(120)
s13.setLoop(true, 0, 8)  -- loop first 8 seconds
s13.play()
```

### Analyze audio loudness
```lua
local stats = s13.measureLUFS("C:/audio/mix.wav")
s13.print("Integrated LUFS: " .. stats.integrated)
s13.print("True Peak: " .. stats.truePeak .. " dBTP")
```

### Batch add effects to all tracks
```lua
for i = 1, s13.getTrackCount() do
    -- Add built-in EQ to every track
    s13.addTrackS13FX(tostring(i), "S13 EQ")
end
```
