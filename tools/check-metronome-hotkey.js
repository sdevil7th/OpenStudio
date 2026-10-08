// With a disposable browser at the app's Vite URL:
// playwright-cli run-code --filename tools/check-metronome-hotkey.js
// Exercises the actual App dispatcher and controls with trusted keyboard input.
// Native practice acceptance is mocked; this does not assert device/audio quality.
async page => {
  await page.reload();
  await page.getByText('Starting OpenStudio...', {exact:true}).waitFor({state:'hidden'});
  await page.evaluate(async () => {
    const {useDAWStore:store} = await import('/src/store/useDAWStore.ts');
    const {nativeBridge:bridge} = await import('/src/services/NativeBridge.ts');
    const {KEYBOARD_SHORTCUT_PROFILES:profiles} = await import('/src/utils/shortcutProfiles.ts');
    const qa = window.__metronomeHotkeyQA = {store,profiles,calls:[],enableCalls:[],hold:false,reject:false,play:0,stop:0};
    store.getState().markInputProfileOnboardingSeen();
    store.setState({showGettingStarted:false,showGettingStartedGuide:false,showMixer:true,
      keyboardShortcutProfileId:'openstudio',customShortcuts:{},isProjectLoading:false,
      metronomeEnabled:false,metronomePracticeEnabled:false,metronomePracticePending:false,
      transport:{...store.getState().transport,isPlaying:false,isPaused:false,isRecording:false,currentTime:12.345},recordSession:null,
      play:async()=>{qa.play++;},stop:async()=>{qa.stop++;}});
    bridge.setMetronomePracticeEnabled = async enabled => {
      qa.calls.push(enabled);
      if(qa.hold) return new Promise(resolve=>{qa.release=resolve;});
      return !qa.reject;
    };
    bridge.setMetronomeEnabled = async enabled => {qa.enableCalls.push(enabled);return true;};
  });
  const checks = [];
  const verify = async (label,condition) => {
    if(!await condition()) throw new Error(label);
    checks.push(label);
  };
  const read = () => page.evaluate(() => {
    const qa=window.__metronomeHotkeyQA,s=qa.store.getState();
    return {practice:s.metronomePracticeEnabled,pending:s.metronomePracticePending,enabled:s.metronomeEnabled,
      playing:s.transport.isPlaying,recording:s.transport.isRecording,time:s.transport.currentTime,
      session:s.recordSession,calls:qa.calls,enableCalls:qa.enableCalls,play:qa.play,stop:qa.stop};
  });
  const settle = () => page.waitForFunction(() => !window.__metronomeHotkeyQA.store.getState().metronomePracticePending);
  const key = async () => {await page.keyboard.press('Control+Shift+Space');await settle();};
  const practice = page.locator('[data-qa="metronome-practice"]');
  await key();
  await verify('shortcut starts with settings closed and parks playhead',async()=>{
    const s=await read();return s.practice&&!s.enabled&&!s.playing&&!s.recording&&s.time===12.345&&s.calls.join(',')==='true';
  });
  await verify('control shows effective default shortcut',()=>practice.getAttribute('title').then(t=>t.includes('Ctrl+Shift+Space')));
  await practice.click(); await settle();
  await verify('button stops shortcut-started practice',async()=>!(await read()).practice);
  await practice.click(); await settle(); await key();
  await verify('shortcut stops button-started practice',async()=>!(await read()).practice);
  await page.getByRole('button',{name:'Metronome Settings',exact:true}).click();
  const dialog=page.getByRole('dialog').filter({hasText:'Metronome Settings'});
  await dialog.waitFor(); await key();
  await verify('modal and transport controls update together',async()=>
    await practice.count()===2&&(await practice.evaluateAll(buttons=>buttons.every(b=>b.getAttribute('aria-pressed')==='true'))));
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.down('Space'); await settle();
  const callsBeforeRepeat=(await read()).calls.length;
  await page.keyboard.down('Space'); await page.keyboard.down('Space');
  await page.keyboard.up('Space'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await verify('held-key repeats do not toggle again',async()=>!(await read()).practice&&(await read()).calls.length===callsBeforeRepeat);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  const slider=page.getByRole('slider',{name:/Pan for MASTER/});
  const sliderValue=await slider.getAttribute('aria-valuenow'); await slider.focus(); await key();
  await verify('modified Space works from focused slider without changing its value',async()=>
    (await read()).practice&&(await slider.getAttribute('aria-valuenow'))===sliderValue);
  await key();
  // Keep native text entry separate from the transport's plain-Space gesture.
  const text=page.getByRole('textbox',{name:'Beats per bar (1-32)',exact:true});
  await text.focus(); const beforeTyping=await read(); await page.keyboard.press('Space');
  await verify('plain Space in text entry does not run transport or click-only',async()=>{
    const s=await read();return s.play===beforeTyping.play&&s.stop===beforeTyping.stop&&s.calls.length===beforeTyping.calls.length;
  });
  await text.fill('4'); await page.keyboard.press('Enter');
  await practice.focus(); await page.keyboard.press('Space');
  await verify('plain Space still starts transport instead of practice',async()=>{
    const s=await read();return s.play===1&&!s.practice;
  });
  await page.evaluate(()=>{
    const qa=window.__metronomeHotkeyQA,s=qa.store.getState();
    qa.store.setState({metronomeEnabled:true,
      transport:{...s.transport,isPlaying:true,isRecording:true},
      recordSession:{id:'hotkey-browser-recording',startTime:12.345,trackIds:[]}});
  });
  await key(); await key();
  await verify('start/stop preserves recording and transport-driven Enable',async()=>{
    const s=await read();return s.playing&&s.recording&&s.enabled&&!s.practice&&s.session.id==='hotkey-browser-recording'&&s.enableCalls.length===0&&s.stop===0;
  });
  // The normal Space debounce is 150 ms; recording should still stop through transport.
  await page.waitForTimeout(160); await page.keyboard.press('Space');
  await verify('plain Space still calls transport stop during recording',async()=>(await read()).stop===1);
  await page.evaluate(()=>{
    const qa=window.__metronomeHotkeyQA,s=qa.store.getState();
    qa.store.setState({transport:{...s.transport,isPlaying:false,isRecording:false},recordSession:null});
  });
  for(const id of await page.evaluate(()=>window.__metronomeHotkeyQA.profiles.map(p=>p.id))) {
    await page.evaluate(id=>window.__metronomeHotkeyQA.store.setState({keyboardShortcutProfileId:id}),id);
    await key(); await verify(`real keyboard starts in ${id}`,async()=>(await read()).practice);
    await key(); await verify(`real keyboard stops in ${id}`,async()=>!(await read()).practice);
  }
  await page.evaluate(()=>window.__metronomeHotkeyQA.store.setState({keyboardShortcutProfileId:'openstudio',customShortcuts:{'transport.metronomePractice':'Ctrl+Shift+K'}}));
  // Once unassigned, Space belongs to a focused button's native activation.
  // Test old-chord dispatch from a neutral surface, rather than pressing that button.
  await page.getByRole('main',{name:'Main workspace',exact:true}).evaluate(el=>{el.tabIndex=-1;el.focus();});
  await verify('tooltip updates after custom remapping',()=>practice.getAttribute('title').then(t=>t.includes('Ctrl+Shift+K')&&!t.includes('Ctrl+Shift+Space')));
  await key(); await verify('old chord is unassigned after remapping',async()=>!(await read()).practice);
  await page.keyboard.press('Control+Shift+K'); await settle();
  await verify('custom binding replaces the original chord',async()=>(await read()).practice);
  await page.keyboard.press('Control+Shift+K'); await settle();
  await page.evaluate(()=>window.__metronomeHotkeyQA.store.setState({customShortcuts:{'transport.metronomePractice':''}}));
  await key(); await verify('explicit unbinding disables original chord',async()=>!(await read()).practice);
  await page.evaluate(()=>{const qa=window.__metronomeHotkeyQA;qa.store.setState({customShortcuts:{}});qa.hold=true;});
  await page.keyboard.press('Control+Shift+Space');
  await page.waitForFunction(()=>Boolean(window.__metronomeHotkeyQA.release));
  await verify('pending native request disables the practice button',()=>practice.isDisabled());
  const pendingCalls=(await read()).calls.length;
  await page.keyboard.press('Control+Shift+Space');
  await verify('pending hotkey does not enqueue a second toggle',async()=>(await read()).calls.length===pendingCalls);
  await page.evaluate(()=>{const qa=window.__metronomeHotkeyQA;qa.hold=false;qa.release(true);});await settle();await key();
  await page.evaluate(()=>window.__metronomeHotkeyQA.store.setState({isProjectLoading:true}));
  const loadingCalls=(await read()).calls.length;
  await page.keyboard.press('Control+Shift+Space');
  await verify('project loading blocks button and shortcut',async()=>await practice.isDisabled()&&(await read()).calls.length===loadingCalls);
  await page.evaluate(()=>{const qa=window.__metronomeHotkeyQA;qa.store.setState({isProjectLoading:false});qa.reject=true;});
  await key();
  await verify('native rejection preserves practice state and reports error',()=>page.evaluate(()=>{
    const s=window.__metronomeHotkeyQA.store.getState();return !s.metronomePracticeEnabled&&Boolean(s.metronomePracticeError);
  }));
  await page.evaluate(()=>{window.__metronomeHotkeyQA.reject=false;});
  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder('Type a command...', {exact:true}).fill('click-only');
  await verify('new action is discoverable in Command Palette',()=>page.getByText('Start / Stop Click-Only Metronome',{exact:true}).isVisible());
  await page.keyboard.press('Escape');
  await page.screenshot({path:'output/playwright/metronome-hotkey.png'});
  return {status:'pass',classification:'ui_behavior_only',checks};
}
