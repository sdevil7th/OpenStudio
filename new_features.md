1. Drag and select should multi-select clips  in the timeline
2. After selecting multiple tracks, the selected state should also be shown in the channel strips, and when multiple are selected if one of the channel strip is right clicked, show option to link the tracks together, and once linked all the linked tracks should behave the same way, any action done on one track should be applied on the other one.
3. track headers should be draggable by clicking on the empty space in its body, and if multiple are selected all should be dragged together
4. Need volume knobs on every track headers, right now volume can only be controlled from the channel strips through a slider, it should also be controllable from a small knob like rotating button (because that saves space) in the track header.


1. The mixer should be dockable, can be moved to places and should stick there
2. Inbuilt Plugins- priority based -> 1. EQ, 2. Delay
3. Snap grid options - bar, beat, seconds and minutes, 1/2, 1/4, 1/8
4. Default scrolling behaviour is prefered the reaper one, the current one could be kept as a setting separately
5. Can we add support for other DAW project files?
6. time range selection is done and 
    i. then if copy action is triggered through, say ctrl + c, all the tracks/clips present during that selection should be copied and pasted later at a selected point
    ii. if delete action is triggered, remove that part of the clip from all the tracks, might require to perform multiple split/cut actions and delete the clips in the selection zone and remove the empty space by joining the two ends
    iii. insert slience by some hotkey
    iv. these options should be present under actions for global selection under the edit tab dropdown


7. Read and Write live change automation tracking tracks (preffered flow in cubase): 
like voume automation, pan automation, reverb automation
    i. R and W buttons to be added to track headers
    ii. when in write mode, any action performed while playing, like changing the volume of that track or pan or some changes in the the fx chain (say I increased the volume of my amp from the amplitube plugin) and be called action tracks, should be tracked and mapped along with the timeline. Different kinds of actions should be tracked on different action tracks and all action tracks for a specific track should be below that track only and should be grouped and collapsible
    iii. Once there is an action track it can be modified by clicking and adding points in the line graph that action graph will create to add or remove actions.

8. Render in place / Bounce: For midi or plugin native tracks, right click clip and click render in place to add a track with a rendered version of the clip with the fx chain

9. Muter / Muting curosr state: An option in the toolbar and with hotkeys to change the curosr to a muter state, when in this state any clips clicked should be muted and can be unmuted if clicked again. The muted clip should be darkened.