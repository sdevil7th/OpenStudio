// With Vite running, open / using playwright-cli, then:
// playwright-cli run-code --filename ../tools/input-profile-browser-regression.js
// playwright-cli eval '() => window.inputProfileRegression'
// Uses the real App and trusted keyboard/wheel input. Store access seeds the
// project and reads results; it never calls the wheel resolver or input handler.
async page => {
  await page.setViewportSize({width:1280,height:800});
  await page.evaluate(async () => {
    const {useDAWStore} = await import('/src/store/useDAWStore.ts');
    window.profileQAStore = useDAWStore;
    const s=useDAWStore.getState();
    s.markInputProfileOnboardingSeen();
    useDAWStore.setState({tracks:[],showMixer:false,showKeyboardShortcuts:false,showPianoRoll:false,showPitchEditor:false,
      midiEditorSessions:[],activeMidiEditorSessionId:null,dockedMidiEditorSessionId:null,detachedPanels:[]});
    for(let i=0;i<16;i++) s.addTrack({id:`profile-qa-${i}`,name:`Track ${i+1}`,type:i===0?'midi':'audio'});
    window.inputProfileRegression = [];
  });
  const snapshot = () => page.evaluate(() => {
    const s=window.profileQAStore.getState();
    return {x:s.scrollX,y:s.scrollY,zoom:s.pixelsPerSecond,height:s.trackHeight,
      waveform:s.tracks.reduce((sum,t)=>sum+(t.waveformZoom??1),0),snap:s.snapEnabled};
  });
  const record = async (entry) => page.evaluate(entry => window.inputProfileRegression.push(entry),entry);
  const choose = async (mouse,keyboard='cubase') => {
    await page.evaluate(()=>window.profileQAStore.setState({showKeyboardShortcuts:true}));
    const dialog=page.getByRole('dialog',{name:'Keyboard, Mouse & Trackpad',exact:true});
    await dialog.getByLabel('Keyboard profile',{exact:true}).selectOption(keyboard);
    await dialog.getByLabel('Mouse & scroll profile',{exact:true}).selectOption(mouse);
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    const workspace=await page.locator('.workspace').boundingBox();
    const timeline=await page.locator('.timeline-container').boundingBox();
    await page.mouse.move(timeline.x+300,workspace.y+140);
  };
  const wheel = async (keys,dx=0,dy=120) => {
    for(const key of keys) await page.keyboard.down(key);
    await page.mouse.wheel(dx,dy);
    await page.waitForTimeout(100);
    for(const key of [...keys].reverse()) await page.keyboard.up(key);
  };
  // Windows expectations, independent of implementation tables.
  // Fields are plain, Ctrl, Alt, Shift, Ctrl+Shift wheel, respectively.
  const matrix = {
    openstudio:['y','zoom','height','x','waveform'],
    cubase:['y','zoom','y','x','height'],
    pro_tools:['y','y','zoom','x','none'],
    reaper:['zoom','height','x','none','none'],
    audacity:['y','zoom','y','x','none'],
    logic_pro:['y','none','y','none','none'],
    fl_studio:['y','zoom','y','reorder','none'],
    ableton_live:['y','zoom','y','x','none'],
    studio_one:['y','height','y','x','zoom'],
    bitwig_studio:['y','none','y','none','none'],
    reason:['y','zoom','y','x','height'],
    cakewalk_sonar:['y','none','zoom','none','none'],
    garageband:['y','none','y','none','none'],
    digital_performer:['y','none','zoom','none','none'],
    ardour:['y','zoom','y','x','none'],
    adobe_audition:['y','none','y','none','none'],
    mixcraft:['zoom','x','y','y','none'],
    waveform:['zoom','height','y','none','none'],
    renoise:['y','none','y','none','none'],
  };
  const combinations=[[],['Control'],['Alt'],['Shift'],['Control','Shift']];
  for(const [profile,expected] of Object.entries(matrix)) {
    await choose(profile);
    for(let i=0;i<combinations.length;i++) {
      await page.evaluate(()=>{
        const s=window.profileQAStore.getState();
        s.setZoom(80); s.setTrackHeight(100); s.setScroll(400,200);
        document.querySelector('.workspace').scrollTop=200;
      });
      await page.waitForTimeout(50);
      const workspace=await page.locator('.workspace').boundingBox();
      const timeline=await page.locator('.timeline-container').boundingBox();
      await page.mouse.move(timeline.x+300,workspace.y+140);
      const before=await snapshot();
      const trackOrder=await page.evaluate(()=>window.profileQAStore.getState().tracks.map(t=>t.id).join(','));
      await wheel(combinations[i]);
      const after=await snapshot();
      const changed=Object.keys(before).filter(key=>before[key]!==after[key]);
      const operation=expected[i];
      const passed=operation==='reorder'
        ? trackOrder!==await page.evaluate(()=>window.profileQAStore.getState().tracks.map(t=>t.id).join(','))
        : operation==='none' ? changed.length===0 : changed.includes(operation);
      await record({surface:'timeline',profile,keys:combinations[i],expected:operation,before,after,pass:passed});
      if(!passed) throw new Error(`${profile} ${combinations[i]} expected ${operation}, changed ${changed}`);
    }
    const before=await snapshot();
    await wheel([],80,35);
    const after=await snapshot();
    const passed=after.x>before.x && after.y>before.y && after.zoom===before.zoom;
    await record({surface:'timeline',profile,input:'two-axis',pass:passed});
    if(!passed) throw new Error(`${profile} lost two-axis scroll`);
  }
  for(const [profile,keys,field] of [
    ['logic_pro',['Control','Alt'],'zoom'],
    ['bitwig_studio',['Control','Alt'],'zoom'],
    ['reaper',['Control','Alt'],'y'],
    ['cakewalk_sonar',['Control','Alt'],'height'],
    ['cakewalk_sonar',['Alt','Shift'],'zoom'],
    ['pro_tools',['Alt','Shift'],'waveform'],
  ]) {
    await choose(profile);
    const before=await snapshot();
    await wheel(keys);
    const after=await snapshot();
    if(before[field]===after[field]) throw new Error(`${profile} ${keys} did not change ${field}`);
    await record({surface:'timeline',profile,keys,expected:field,pass:true});
  }
  await choose('studio_one');
  const physicalBefore=await snapshot();
  await wheel(['Control'],0,3);
  const physicalAfter=await snapshot();
  if(physicalBefore.zoom!==physicalAfter.zoom || physicalBefore.height===physicalAfter.height) throw new Error('Physical Ctrl+wheel was mistaken for pinch');
  const cdp=await page.context().newCDPSession(page);
  const pointer=await page.locator('.workspace').boundingBox();
  const timelineBox=await page.locator('.timeline-container').boundingBox();
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:timelineBox.x+300,y:pointer.y+140,deltaX:0,deltaY:-3,modifiers:2});
  await page.waitForTimeout(150);
  if((await snapshot()).zoom===physicalAfter.zoom) throw new Error('Simulated trackpad pinch did not zoom');
  await cdp.detach();
  await record({input:'physical Control vs Chromium pinch simulation',pass:true});
  await choose('cubase');
  await page.locator('.timeline-container').click({position:{x:300,y:100},force:true});
  const beforeKey=await snapshot();
  await page.keyboard.press('j');
  const afterKey=await snapshot();
  if(beforeKey.snap===afterKey.snap) throw new Error('Cubase J did not toggle snap in the App');
  await record({input:'Cubase J',pass:true});
  await page.keyboard.press('h');
  if((await snapshot()).zoom===afterKey.zoom) throw new Error('Cubase H did not zoom');
  await record({input:'Cubase H',pass:true});
  await page.evaluate(()=>{
    const s=window.profileQAStore.getState();
    const id=s.addMIDIClip('profile-qa-0',0,30);
    s.openPianoRoll('profile-qa-0',id);
  });
  const grid=page.locator('.piano-roll-stage-wrap');
  await grid.waitFor({state:'visible'});
  const gridBox=await grid.boundingBox();
  const keysBox=await page.locator('.piano-roll-key-viewport').boundingBox();
  await page.mouse.move(gridBox.x+250,keysBox.y+keysBox.height/2);
  const beforePiano=await snapshot();
  await wheel(['Control']);
  const afterPiano=await snapshot();
  if(beforePiano.zoom===afterPiano.zoom) throw new Error('Cubase Ctrl+wheel did not zoom the real Piano Roll');
  await record({surface:'piano_roll',input:'Ctrl+wheel',pass:true});
  const beforePan=await snapshot();
  await wheel(['Shift']);
  if((await snapshot()).x===beforePan.x) throw new Error('Cubase Shift+wheel did not pan the real Piano Roll');
  await record({surface:'piano_roll',input:'Shift+wheel',pass:true});

  // Empty contour fixture exercises the actual Pitch Editor without DSP.
  await page.evaluate(async()=>{
    const {usePitchEditorStore}=await import('/src/store/pitchEditorStore.ts');
    window.pitchQAStore=usePitchEditorStore;
    window.profileQAStore.getState().addClip('profile-qa-1',{id:'qa-pitch',name:'Navigation QA',filePath:'',startTime:0,duration:30,offset:0,color:'#7ab',volumeDB:0,fadeIn:0,fadeOut:0});
    usePitchEditorStore.setState({trackId:'profile-qa-1',clipId:'qa-pitch',notes:[],contour:{clipId:'qa-pitch',frames:{times:[],midi:[],confidence:[],rms:[],voiced:[]},notes:[],sampleRate:44100,hopSize:256},isAnalyzing:false,clipStartTime:0,clipDuration:30});
    window.profileQAStore.setState({showPianoRoll:false,showPitchEditor:true,pitchEditorTrackId:'profile-qa-1',pitchEditorClipId:'qa-pitch'});
  });
  const pitchCanvas=page.locator('[data-shortcut-context="pitch_editor"] canvas').first();
  await pitchCanvas.waitFor({state:'visible'});
  await page.waitForTimeout(350);
  const pitchBox=await pitchCanvas.boundingBox();
  await page.mouse.move(pitchBox.x+pitchBox.width/2,pitchBox.y+pitchBox.height/2);
  const pitchState=()=>page.evaluate(()=>({x:window.profileQAStore.getState().scrollX,zoom:window.profileQAStore.getState().pixelsPerSecond,y:window.pitchQAStore.getState().scrollY,height:window.pitchQAStore.getState().zoomY}));
  for(const [keys,field] of [[[],'y'],[['Control'],'zoom'],[['Shift'],'x'],[['Control','Shift'],'height']]) {
    const before=await pitchState();
    await wheel(keys,0,100);
    const after=await pitchState();
    const pass=before[field]!==after[field];
    await record({surface:'pitch_editor',keys,before,after,pass});
    if(!pass) throw new Error(`Pitch editor ${keys} did not change ${field}`);
  }
}
