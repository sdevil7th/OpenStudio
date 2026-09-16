// Run against a disposable real-App browser with playwright-cli run-code --filename.
async page => {
  await page.reload();
  await page.getByRole('menubar',{name:'Main menu'}).waitFor();
  await page.setViewportSize({width:1280,height:850});
  await page.evaluate(async()=>{
    const {useDAWStore:s}=await import('/src/store/useDAWStore.ts');
    const {nativeBridge:b}=await import('/src/services/NativeBridge.ts');
    window.fxMenuQA={s,b,monitor:[],fx:[],ready:'opening',adds:0,opens:0,results:[]};
    s.getState().markInputProfileOnboardingSeen();
    s.setState({projectTemplates:[],tracks:[],showMixer:true,showGettingStarted:false,showKeyboardShortcuts:false});
    s.getState().addTrack({id:'fx-qa',name:'FX QA',type:'audio'});
    b.getMonitoringFX=async()=>window.fxMenuQA.monitor;
    b.getAvailablePlugins=async()=>[{name:'Slow Test FX',manufacturer:'QA',category:'Fx',fileOrIdentifier:'qa-fx',identifier:'qa-fx',isInstrument:false}];
    b.getAvailableJSFX=async()=>[];
    b.getAvailableBuiltInFX=async()=>[{name:'OpenStudio NAM Rack',category:'Fx'}];
    b.getTrackFX=async()=>window.fxMenuQA.fx;
    b.getTrackInputFX=async()=>[];
    b.getPluginEditorReadiness=async target=>{window.fxMenuQA.target=target;return window.fxMenuQA.ready;};
    b.addMonitoringFX=async()=>{window.fxMenuQA.adds++;return new Promise(resolve=>window.fxMenuQA.finishAdd=resolve);};
    b.openMonitoringFXEditor=async()=>{window.fxMenuQA.opens++;return true;};
    b.openBuiltInPluginEditorWindow=async()=>{window.fxMenuQA.opens++;return true;};
    s.setState({addTrackBuiltInFXWithUndo:async()=>new Promise(resolve=>window.fxMenuQA.finishFX=resolve)});
  });
  const check=async(name,pass)=>{if(!pass)throw new Error(name);await page.evaluate(name=>window.fxMenuQA.results.push(name),name);};
  await page.getByRole('button',{name:'Add monitoring effect plugin',exact:true}).click();
  await page.getByRole('button',{name:'Slow Test FX',exact:true}).click();
  const loading=page.getByRole('status').filter({hasText:'Loading Slow Test FX'});
  await loading.waitFor();
  await check('Monitor Add disables duplicates',await page.getByRole('button',{name:'Slow Test FX',exact:true}).isDisabled());
  await page.screenshot({path:'output/playwright/monitor-fx-loading.png'});
  await page.getByRole('button',{name:'Close plugin picker',exact:true}).click();
  await check('Monitor progress survives closing the picker',await loading.isVisible());
  await page.evaluate(()=>{window.fxMenuQA.monitor=[{index:0,name:'Slow Test FX',type:'vst3'}];window.fxMenuQA.finishAdd(true);});
  await loading.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Open editor for monitor effect Slow Test FX',exact:true}).click();
  const opening=page.getByRole('status').filter({hasText:'Opening Slow Test FX editor'});
  await opening.waitFor();
  await page.waitForTimeout(250);
  await check('Open acceptance does not hide monitor progress',await opening.isVisible());
  await check('Monitor editor checked by address',await page.evaluate(()=>window.fxMenuQA.target.scope==='monitoring_fx'&&window.fxMenuQA.target.fxIndex===0));
  await page.evaluate(()=>window.fxMenuQA.ready='ready');
  await opening.waitFor({state:'hidden'});
  await page.evaluate(()=>window.fxMenuQA.ready='failed');
  await page.getByRole('button',{name:'Open editor for monitor effect Slow Test FX',exact:true}).click();
  await page.getByText('The plugin editor failed to start.',{exact:true}).waitFor();
  await check('Monitor editor failure clears loader',!(await opening.isVisible()));
  await page.evaluate(()=>window.fxMenuQA.ready='opening');
  await page.getByRole('button',{name:'Open FX chain for FX QA',exact:true}).first().click();
  const fx=page.getByRole('dialog',{name:'FX chain for FX QA',exact:true});
  const item=fx.locator('.available-plugin-item').filter({hasText:'OpenStudio NAM Rack'});
  // Catalogue row class is resolved from the visible Add button's parent.
  const add=fx.getByText(/^OpenStudio NAM Rack/).locator('..').locator('..').getByRole('button',{name:'Add',exact:true});
  await add.click();
  const fxLoading=fx.getByRole('status').filter({hasText:'Loading OpenStudio NAM Rack'});
  await fxLoading.waitFor();
  await page.screenshot({path:'output/playwright/track-fx-loading.png'});
  await page.evaluate(()=>{window.fxMenuQA.fx=[{index:0,name:'OpenStudio NAM Rack',type:'builtin'}];window.fxMenuQA.finishFX(true);});
  const fxOpening=fx.getByRole('status').filter({hasText:'Opening OpenStudio NAM Rack editor'});
  await fxOpening.waitFor();
  await page.waitForTimeout(250);
  await check('Built-in FX waits for visible frontend ready',await fxOpening.isVisible());
  await check('Built-in readiness uses matching session',await page.evaluate(()=>JSON.parse(window.fxMenuQA.target.sessionId).address.trackId==='fx-qa'));
  await page.evaluate(()=>window.fxMenuQA.ready='ready');
  await fxOpening.waitFor({state:'hidden'});
  await fx.getByRole('button',{name:'Close FX chain panel'}).click();
  for(const top of ['Options','Help']) {
    await page.getByRole('menuitem',{name:top+' menu',exact:true}).click();
    await page.getByRole('menuitem',{name:'Keyboard, Mouse & Trackpad…',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Keyboard, Mouse & Trackpad',exact:true});
    await dialog.waitFor();
    await check(top+' opens input settings',await dialog.isVisible());
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
  }
  await page.evaluate(()=>{const s=window.fxMenuQA.s.getState();s.saveAsTemplate('QA template');});
  await page.getByRole('menuitem',{name:'File menu',exact:true}).click();
  await page.getByRole('menuitem',{name:'New from Template...',exact:true}).hover();
  await page.getByRole('menuitem',{name:'Delete Template...',exact:true}).hover();
  const third=page.getByRole('menu',{name:'Delete Template... menu',exact:true});
  await third.waitFor();
  await check('Third-level template submenu reachable',await third.getByRole('menuitem',{name:'QA template',exact:true}).isVisible());
  await page.screenshot({path:'output/playwright/menu-nested-template.png'});
  await third.getByRole('menuitem',{name:'QA template',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await check('Cancelled template deletion preserves template',await page.evaluate(()=>window.fxMenuQA.s.getState().projectTemplates.some(t=>t.name==='QA template')));
  // Edits use real store commands, including history, rather than mocked handlers.
  await page.evaluate(async()=>{
    const {activateShortcutContext}=await import('/src/utils/shortcutContext.ts');
    const s=window.fxMenuQA.s.getState();s.addEmptyClip('fx-qa',0,2);s.addEmptyClip('fx-qa',3,2);
    const ids=window.fxMenuQA.s.getState().tracks.find(t=>t.id==='fx-qa').clips.map(c=>c.id);
    window.fxMenuQA.s.setState({selectedClipIds:ids,selectedClipId:ids[0],selectedTrackIds:['fx-qa'],selectedTrackId:'fx-qa'});
    activateShortcutContext({kind:'timeline'});
  });
  const menuAction=async name=>{await page.getByRole('menuitem',{name:'Edit menu',exact:true}).click();await page.getByRole('menuitem',{name,exact:true}).click();};
  await menuAction('Copy');
  await check('Menu Copy captures multi-clip selection',await page.evaluate(()=>window.fxMenuQA.s.getState().clipboard.clips.length===2));
  await menuAction('Delete');
  await check('Timeline menu Delete preserves selected track',await page.evaluate(()=>{const t=window.fxMenuQA.s.getState().tracks.find(t=>t.id==='fx-qa');return t&&t.clips.length===0;}));
  await menuAction('Undo');
  await check('Menu Undo restores both clips',await page.evaluate(()=>window.fxMenuQA.s.getState().tracks.find(t=>t.id==='fx-qa').clips.length===2));
  await page.setViewportSize({width:640,height:640});
  await page.getByRole('menuitem',{name:'View menu',exact:true}).click();
  const view=page.getByRole('menu',{name:'View menu',exact:true});
  await check('Long menu fits compact viewport',await view.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.scrollHeight>e.clientHeight;}));
  await page.getByRole('menuitem',{name:'Grid Type',exact:true}).hover();
  await page.getByRole('menu',{name:'Grid Type menu',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/menu-compact.png'});


  await page.setViewportSize({width:1280,height:850});
  await page.mouse.click(1100,300);
  for(const chain of ['input','master','track']) {
    await page.evaluate(async chain=>{
      const {default:React}=await import('/node_modules/.vite/deps/react.js');
      const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
      const {FXChainPanel}=await import('/src/components/FXChainPanel.tsx');
      const q=window.fxMenuQA;q.ready='opening';
      const slots=[{index:0,name:'External QA FX',type:'vst3'}];
      q.b.getTrackFX=q.b.getTrackInputFX=q.b.getMasterFX=async()=>slots;
      q.b.openPluginEditor=q.b.openMasterFXEditor=async()=>true;
      q.host=document.createElement('div');document.body.append(q.host);q.root=ReactDOM.createRoot(q.host);
      q.root.render(React.createElement(FXChainPanel,{trackId:chain==='master'?'':'fx-qa',trackName:'QA '+chain,chainType:chain,onClose:()=>{q.root.unmount();q.host.remove();}}));
    },chain);
    const dialog=page.getByRole('dialog',{name:'FX chain for QA '+chain,exact:true});
    await dialog.getByText('External QA FX',{exact:true}).click();
    const status=dialog.getByRole('status').filter({hasText:'Opening External QA FX editor'});
    await status.waitFor();await page.waitForTimeout(220);
    const result=await page.evaluate(chain=>{const q=window.fxMenuQA;const expected=chain==='input'?'track_input_fx':chain==='master'?'master_fx':'track_fx';return q.target.scope===expected;},chain);
    if(!result||!await status.isVisible())throw new Error(chain+' editor readiness was not awaited');
    await page.evaluate(chain=>{window.fxMenuQA.ready='ready';window.fxMenuQA.results.push(chain+' external editor waits for readiness');},chain);
    await status.waitFor({state:'hidden'});
    await dialog.getByRole('button',{name:'Close FX chain panel'}).click();
  }
  await page.getByRole('menuitem',{name:'Options menu',exact:true}).click();
  const ripple=page.getByRole('menuitem',{name:'Ripple Editing',exact:true});
  await ripple.focus();await page.keyboard.press('ArrowRight');
  await page.getByRole('menu',{name:'Ripple Editing menu',exact:true}).waitFor();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  if(!await page.evaluate(()=>window.fxMenuQA.s.getState().rippleMode==='per_track'))throw new Error('Keyboard submenu action failed');
  await page.evaluate(()=>window.fxMenuQA.results.push('Keyboard navigation executes submenu action'));

}
