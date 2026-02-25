1. Track headers should be draggable by clicking anywhere in the empty space present in the track header not just with the thin block on the left (context: SortableTrackHeader)
2. Color selector should popup when clicked on that thin block on the left ideally in the track header. And colors should be displayed with the color shown and not a hex code shown, right now the hex codes are shown in color dropdown.
3. If multiple track headers are selected and one of them is dragged, all should be dragged and moved together.
4. not all actions are considered while updating the undo and redo stack, only main clip editing actions are considered. Can you add support for all possible actions?
5. Even though I add a midi track and instrument, the instrument plugin doesn't load or show up.
6. clip editing doesn't change the peak graph. Like, if I add fade in/fade out or increase/decrease the volume of a clip by the horizontal line we show on top of a clip, these are either not being applied or being applied but not reflected on the peak graph. Anything that can affect the audio should reflect the peak graph (not the fx chain though).
Also, the line that should modify the clip volume should be changable not only if the circle at the center is dragged but the entire line should be draggable, as the circle might not be even present at the viewport.
7. if not tracks are armed, disable the record button and the hotkeys.
8. When a global time selection is selected, the loop is not working as expected. When loop is enabled, if play / record button is pressed, the playhead should start from the time selection and end at time selection (for play it should loop from the start time selection again).
9. Click and drag is working for clips, but once I move a clip from a track to another track, it kind of snaps to the new track and I can't move that clip again without releasing it once, ideally it should be movable and the snap should only be a visual thing that should happen where the cursor is being moved and if that's happening multiple times without releasing the drag then the clip should also follow that.
10. When a track header is selected we show a simple color change in the bg, we need the same color change for the selected state of tracks in the mixer panel where the channel strips are placed. Otherwise it's difficult to remember which  ones were selected from the track headers. Clicking outside should remove the selections.
11. the clip bg needs to be more transparent, so that the vertical lines denoting the bar and beat markers are visible through the bg. the peak graph needs to be solid color, the bg can be 50% transparent.
12. When play, record or stop is pressed (or hotkey is pressed), the horizontal scroll on the timeline should go where the playhead is.
13. Master channel strip has a fx button but that doesn't open the fx chain modal (which usually opens when I add a fx to a track). Is the fx chain not built for the master channel?
14. The fx modal that we show just show the list of plugins available, and the search works on the names only. Can we also show some images for those plugins (only if they are present from the plugin itself, else show some placeholder)? Can the search work like, if reverb is searched, any plugin that can provide reverb shows up? What all metadata are present for the VST plugins?
Can we implement something similar for midi? Like, if piano is searched, the instrument plugins that can provide piano shows up?
15. When a clip is split into two, only one of them is playing, the other one doesn't seem to work, what shows in the graph is not playing in audio. Also can't verify the automatic crossfade because of this.
16. In the File dropdown at very top, the dropdown suboptions doesn't close when the option or suboptions are no longer hovered.
17. Project saving and loading doesn't work. Getting odd errors and previously fx chains were not saving/loading/initializing. Now it seems to be completely broken. Getting this error trying to open a saved project that I saved recently in same version -
  Uncaught TypeError: Cannot read properties of undefined (reading 'map')
    at ChannelStrip (ChannelStrip.tsx:125:24)
    at Object.react_stack_bottom_frame (react-dom-client.development.js:25904:20)
    at renderWithHooks (react-dom-client.development.js:7662:22)
    at updateFunctionComponent (react-dom-client.development.js:10166:19)
    at beginWork (react-dom-client.development.js:11778:18)
    at runWithFiberInDEV (react-dom-client.development.js:871:30)
    at performUnitOfWork (react-dom-client.development.js:17641:22)
    at workLoopSync (react-dom-client.development.js:17469:41)
    at renderRootSync (react-dom-client.development.js:17450:11)
    at performWorkOnRoot (react-dom-client.development.js:16583:35)
  react-dom-client.development.js:9362  An error occurred in the <ChannelStrip> component.

  Consider adding an error boundary to your tree to customize error handling behavior.
  Visit https://react.dev/link/error-boundaries to learn more about error boundaries.
18. When there was this kind of situation, the app had a blank screen, I couldn't even see the close icon for the app. Atleast the main three buttons should still be shown?