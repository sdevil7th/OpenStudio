# OpenStudio Lua Scripting API Reference

OpenStudio currently provides a Lua scripting engine through the legacy `openstudio.*` namespace for compatibility. Scripts can be edited and run from the Script Editor (View > Script Editor).

## Track Operations

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.getTrackCount()` | none | `number` | Returns total number of tracks |
| `openstudio.addTrack(name)` | `name: string` | `trackId: string` | Creates a new audio track |
| `openstudio.removeTrack(trackId)` | `trackId: string` | `boolean` | Removes a track |
| `openstudio.setTrackVolume(trackId, dB)` | `trackId: string, dB: number` | none | Set track volume (-60 to +12 dB) |
| `openstudio.setTrackPan(trackId, pan)` | `trackId: string, pan: number` | none | Set track pan (-1.0 L to +1.0 R) |
| `openstudio.setTrackMute(trackId, muted)` | `trackId: string, muted: boolean` | none | Set track mute state |
| `openstudio.setTrackSolo(trackId, soloed)` | `trackId: string, soloed: boolean` | none | Set track solo state |
| `openstudio.setTrackArm(trackId, armed)` | `trackId: string, armed: boolean` | none | Set track record arm |
| `openstudio.reorderTrack(fromIdx, toIdx)` | `from: number, to: number` | none | Move track position |

## Transport

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.play()` | none | none | Start playback |
| `openstudio.stop()` | none | none | Stop playback |
| `openstudio.record()` | none | none | Start recording (arms must be set) |
| `openstudio.isPlaying()` | none | `boolean` | Check if transport is playing |
| `openstudio.isRecording()` | none | `boolean` | Check if transport is recording |
| `openstudio.getPlayhead()` | none | `number` | Get playhead position in seconds |
| `openstudio.setPlayhead(time)` | `time: number` | none | Set playhead position in seconds |
| `openstudio.getTempo()` | none | `number` | Get current BPM |
| `openstudio.setTempo(bpm)` | `bpm: number` | none | Set tempo (20-999 BPM) |
| `openstudio.getTimeSignature()` | none | `num, den` | Get time signature (two return values) |
| `openstudio.setTimeSignature(num, den)` | `num: number, den: number` | none | Set time signature |
| `openstudio.setLoop(enabled, start, end)` | `enabled: boolean, start: number, end: number` | none | Set loop region |

## FX Chain

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.getTrackFX(trackId)` | `trackId: string` | `table` | Get list of track FX plugins |
| `openstudio.getTrackInputFX(trackId)` | `trackId: string` | `table` | Get list of input FX plugins |
| `openstudio.addTrackFX(trackId, pluginId)` | `trackId: string, pluginId: string` | `boolean` | Add FX plugin to track |
| `openstudio.removeTrackFX(trackId, index)` | `trackId: string, index: number` | `boolean` | Remove FX at index |
| `openstudio.bypassTrackFX(trackId, index, bypassed)` | `trackId: string, index: number, bypassed: boolean` | none | Toggle FX bypass |
| `openstudio.addTrackJSFX(trackId, effectName)` | `trackId: string, name: string` | `boolean` | Add a built-in OpenStudio effect (legacy `OpenStudio` names still work) |
| `openstudio.getAvailableJSFX()` | none | `table` | List available built-in OpenStudio effects |

## Master Bus

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.setMasterVolume(volume)` | `volume: number` | none | Set master volume (0.0 to 2.0 linear) |
| `openstudio.getMasterVolume()` | none | `number` | Get master volume |
| `openstudio.setMasterPan(pan)` | `pan: number` | none | Set master pan (-1.0 to +1.0) |
| `openstudio.getMasterPan()` | none | `number` | Get master pan |

## Sends

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.addTrackSend(trackId, destTrackId)` | `trackId, destTrackId: string` | `number` | Add send, returns send index |
| `openstudio.removeTrackSend(trackId, index)` | `trackId: string, index: number` | none | Remove send at index |
| `openstudio.setTrackSendLevel(trackId, index, level)` | `trackId: string, index: number, level: number` | none | Set send level (0.0 to 1.0) |
| `openstudio.getTrackSends(trackId)` | `trackId: string` | `table` | Get all sends for a track |

## Playback Clips

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.addPlaybackClip(file, start, duration, trackId, offset, volumeDB)` | see args | none | Add audio clip for playback |
| `openstudio.removePlaybackClip(trackId, file, start)` | `trackId, file: string, start: number` | none | Remove a playback clip |
| `openstudio.clearPlaybackClips()` | none | none | Remove all playback clips |

## Automation

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.setAutomationPoints(trackId, param, points)` | `trackId: string, param: string, points: table` | none | Set automation points (table of {time, value}) |
| `openstudio.setAutomationMode(trackId, param, mode)` | `trackId: string, param: string, mode: string` | none | Set automation mode ("read", "write", "touch", "latch") |
| `openstudio.getAutomationMode(trackId, param)` | `trackId: string, param: string` | `string` | Get automation mode |
| `openstudio.clearAutomation(trackId, param)` | `trackId: string, param: string` | none | Clear all automation points |

## Audio Analysis

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.measureLUFS(filePath)` | `filePath: string` | `table` | Measure loudness (integrated, shortTerm, momentary, truePeak, range) |
| `openstudio.detectTransients(filePath, threshold)` | `filePath: string, threshold: number` | `table` | Detect transient positions in seconds |
| `openstudio.reverseAudioFile(filePath, outputPath)` | `filePath, outputPath: string` | `boolean` | Reverse an audio file |
| `openstudio.detectSilentRegions(filePath, thresholdDB, minDuration)` | `filePath: string, thresholdDB: number, minDuration: number` | `table` | Detect silent regions |

## Track Freeze

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.freezeTrack(trackId)` | `trackId: string` | `boolean` | Freeze track (render FX to audio) |
| `openstudio.unfreezeTrack(trackId)` | `trackId: string` | `boolean` | Unfreeze track (restore original) |

## Render

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.renderProject(filePath, format, bitDepth, sampleRate, startTime, endTime)` | see args | `boolean` | Offline render project to file |

## MIDI

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.getMIDIDevices()` | none | `table` | List available MIDI input devices |

## Metronome

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.setMetronomeEnabled(enabled)` | `enabled: boolean` | none | Enable/disable metronome |
| `openstudio.isMetronomeEnabled()` | none | `boolean` | Check if metronome is enabled |

## Plugins

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.scanForPlugins()` | none | none | Trigger VST3 plugin scan |
| `openstudio.getAvailablePlugins()` | none | `table` | List all scanned plugins |

## Utility

| Function | Arguments | Returns | Description |
|----------|-----------|---------|-------------|
| `openstudio.print(...)` | any values | none | Print to script console |
| `openstudio.getAppVersion()` | none | `string` | Get OpenStudio version string |
| `openstudio.showMessage(title, message)` | `title, message: string` | none | Show a message dialog |
| `openstudio.fileDialog(title, filters)` | `title, filters: string` | `string` | Open file picker dialog |

## Examples

### Create a track and set its volume
```lua
local id = openstudio.addTrack("Vocals")
openstudio.setTrackVolume(id, -6.0)  -- -6 dB
openstudio.setTrackPan(id, -0.5)     -- pan left 50%
```

### Set up a loop and play
```lua
openstudio.setTempo(120)
openstudio.setLoop(true, 0, 8)  -- loop first 8 seconds
openstudio.play()
```

### Analyze audio loudness
```lua
local stats = openstudio.measureLUFS("C:/audio/mix.wav")
openstudio.print("Integrated LUFS: " .. stats.integrated)
openstudio.print("True Peak: " .. stats.truePeak .. " dBTP")
```

### Batch add effects to all tracks
```lua
for i = 1, openstudio.getTrackCount() do
    -- Add built-in EQ to every track
    openstudio.addTrackJSFX(tostring(i), "OpenStudio EQ")
end
```
