## To be implemented later:

7. Read and Write live change automation tracking tracks (preffered flow in cubase): 
like voume automation, pan automation, reverb automation
    i. R and W buttons to be added to track headers
    ii. when in write mode, any action performed while playing, like changing the volume of that track or pan or some changes in the the fx chain (say I increased the volume of my amp from the amplitube plugin) and be called action tracks, should be tracked and mapped along with the timeline. Different kinds of actions should be tracked on different action tracks and all action tracks for a specific track should be below that track only and should be grouped and collapsible
    iii. Once there is an action track it can be modified by clicking and adding points in the line graph that action graph will create to add or remove actions.

5. Can we add support for other DAW project files?

4. Default scrolling behaviour is prefered the reaper one, the current one could be kept as a setting separately

1. The mixer should be dockable, can be moved to places and should stick there

2. Inbuilt Plugins- priority based -> 1. EQ, 2. Delay

---

## In Progress:

### 8. Built-in JSFX Plugin System (S13FX)
Full REAPER .jsfx compatibility via YSFX runtime (Apache 2.0). Users can write custom audio effects as plain text files, drop in existing REAPER community effects, and share effects by sharing text files. EEL2 scripts are JIT-compiled to x64 SSE assembly for near-native performance. Features slider-based parameter UI, hot-reload, and MIDI effect support.

**Stock effects included:** Gain/Utility, Simple EQ, Compressor, Delay, Reverb, Chorus, Saturation, Gate

### 9. Lua Scripting for DAW Automation (S13Script)
Full Lua 5.4 scripting API (MIT license) for automating any DAW action. Scripts run on the message thread and can manipulate tracks, clips, transport, FX, markers, regions, and time selections. Includes a Script Console UI panel, REPL support, and stock scripts (Normalize All Clips, Remove Empty Tracks, Split All at Playhead, etc.).