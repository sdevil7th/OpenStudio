// Visual inventory with mock backend data. Captured is not a feature pass.
// Start Vite separately; use --output, --url and optionally --webkit-executable.
import {chromium,webkit} from '../frontend/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const root = option('--output', 'output/ui-surface-audit');
const baseURL = option('--url', 'http://127.0.0.1:5183/');
const webkitExecutable = option('--webkit-executable', undefined);
await fs.mkdir(root,{recursive:true});
const surfaces=[
 ['workspace',{}],['settings',{showSettings:true}],['project-settings',{showProjectSettings:true}],
 ['preferences',{showPreferences:true}],['shortcuts',{showKeyboardShortcuts:true}],['render',{showRenderModal:true}],
 ['routing-matrix',{showRoutingMatrix:true}],['track-routing',{showTrackRouting:true,trackRoutingTrackId:'qa-audio'}],
 ['channel-eq',{showChannelStripEQ:true,channelStripEQTrackId:'qa-audio'}],['plugins',{showPluginBrowser:true,pluginBrowserTrackId:'qa-audio'}],
 ['envelopes',{showEnvelopeManager:true,envelopeManagerTrackId:'qa-audio'}],['clip-properties',{showClipProperties:true}],
 ['piano-roll',{}],['pitch-editor',{showPitchEditor:true,pitchEditorTrackId:'qa-audio',pitchEditorClipId:'qa-clip'}],
 ['virtual-keyboard',{showVirtualKeyboard:true}],['media-explorer',{showMediaExplorer:true}],['clip-launcher',{showClipLauncher:true}],
 ['markers',{showRegionMarkerManager:true}],['render-queue',{showRenderQueue:true}],['region-render',{showRegionRenderMatrix:true}],
 ['batch-converter',{showBatchConverter:true}],['dynamic-split',{showDynamicSplit:true,dynamicSplitClipId:'qa-clip'}],
 ['theme',{showThemeEditor:true}],['toolbar-editor',{showToolbarEditor:true}],['timecode',{showTimecodeSettings:true}],
 ['script-editor',{showScriptEditor:true}],['ai-setup',{showAiToolsSetup:true}],['stem-separation',{showStemSeparation:true,stemSepTrackId:'qa-audio',stemSepClipId:'qa-clip',stemSepClipName:'QA tone',stemSepClipDuration:4}],
 ['help',{showContextualHelp:true}],['guide',{showGettingStarted:true}],['command-palette',{showCommandPalette:true}],
 ['clean-project',{showCleanProject:true}],['compare',{showProjectCompare:true}],['ddp',{showDDPExport:true}],['undo-history',{showUndoHistory:true}]
];
const results=[];
for(const engine of ['chromium','webkit']){
 const browser=await ({chromium,webkit}[engine]).launch(engine==='webkit' && webkitExecutable ? {executablePath:webkitExecutable} : {});
 for(const size of [{width:1280,height:800},{width:800,height:600}]){
  for(const [name,state] of surfaces){
   const id=`${engine}-${size.width}-${name}`;const errors=[];
   const context=await browser.newContext({viewport:size,userAgent:`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Safari/605.1.15`});
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
   const result={id,engine,size,surface:name,setup:'mock frontend; fixture injected through store, subsequent inputs real',errors};
   try{
    await page.addInitScript(()=>{localStorage.setItem('openstudio.inputProfiles.v1',JSON.stringify({schemaVersion:1,keyboardProfileId:'openstudio',mouseProfileId:'openstudio',onboardingSeen:true}));localStorage.setItem('openstudio_essentialControlsDismissed','true');});
    await page.goto(baseURL);
    await page.getByRole('button',{name:'Add new audio track'}).waitFor();
    await page.getByText('Starting OpenStudio...', {exact:true}).waitFor({state:'hidden',timeout:20000});
    if (name === 'workspace' && size.width === 1280) {
     const actions = await page.evaluate(async () => {
      const registry = await import('/src/store/actionRegistry.ts');
      return registry.getRegisteredActions().map(a => ({id:a.id,name:a.name,category:a.category,status:'untested',scope:a.shortcutScope ?? 'global'}));
     });
     await fs.writeFile(`${root}/${engine}-registered-actions.json`, JSON.stringify(actions,null,2));
    }
    await page.evaluate(async ({state,name})=>{
     const {useDAWStore:s,createDefaultTrack}=await import('/src/store/useDAWStore.ts');
     const a=createDefaultTrack('qa-audio','Vocal recording with a long descriptive track name','#ce6f85','audio');
     a.clips=[{id:'qa-clip',filePath:'/tmp/openstudio-qa-tone.wav',name:'Vocal take 01',startTime:1,duration:4,offset:0,color:'#ce6f85',volumeDB:0,fadeIn:0,fadeOut:0,sampleRate:48000}];
     const m=createDefaultTrack('qa-midi','MIDI piano','#6a9fe2','midi');
     m.midiClips=[{id:'qa-midi-clip',name:'Piano phrase',startTime:0,duration:4,offset:0,sourceStart:0,sourceLength:4,loopEnabled:true,loopOffset:0,loopLength:4,color:'#6a9fe2',ccEvents:[],events:[{type:'noteOn',note:60,velocity:96,timestamp:.5,channel:1},{type:'noteOff',note:60,velocity:0,timestamp:1.5,channel:1}]}];
     s.setState({tracks:[a,m],selectedTrackIds:['qa-audio'],selectedClipId:'qa-clip',selectedClipIds:['qa-clip'],projectName:'Linux UI audit',...state});
     if(name==='piano-roll')s.getState().openPianoRoll('qa-midi','qa-midi-clip');
    },{state,name});
    await page.waitForTimeout(400);
    result.geometry=await page.evaluate(()=>{
     const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
     const label=e=>e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent?.trim().slice(0,80)||e.getAttribute('placeholder')||e.tagName;
     const roots=[...document.querySelectorAll('[role="dialog"], [role="menu"], [data-headlessui-state]')].filter(visible);
     const ctrls=[...document.querySelectorAll('button,input,select,textarea,[role="slider"],[role="tab"]')].filter(visible).filter(e=>!e.closest('[inert]'));
     return {bodyScroll:[document.documentElement.scrollWidth,innerWidth],dialogs:roots.map(e=>({label:label(e),rect:e.getBoundingClientRect().toJSON(),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})).slice(0,15),
      outsideViewport:ctrls.filter(e=>{const r=e.getBoundingClientRect();return r.left< -1||r.right>innerWidth+1||r.top< -1||r.bottom>innerHeight+1;}).map(e=>({label:label(e),rect:e.getBoundingClientRect().toJSON(),scrollAncestor:!!e.parentElement?.closest('[class*="overflow"]')})),
      unnamedControls:ctrls.filter(e=>!e.getAttribute('aria-label')&&!e.getAttribute('title')&&!e.textContent?.trim()&&!e.labels?.length&&!e.getAttribute('aria-labelledby')).map(e=>({tag:e.tagName,type:e.getAttribute('type'),placeholder:e.getAttribute('placeholder')})),
      text:document.body.innerText.slice(-16000)};
    });
    await page.screenshot({path:`${root}/${id}.png`});
    const dialog=page.getByRole('dialog').last();
    if(await dialog.count()){
     await page.keyboard.press('Tab');
     result.focusInside=await dialog.evaluate(e=>e.contains(document.activeElement));
     await page.keyboard.press('Escape');await page.waitForTimeout(220);
     result.escapeCloses=!(await dialog.isVisible().catch(()=>false));
    }
    result.status='captured';
   }catch(e){result.status='harness_error';result.error=String(e);await page.screenshot({path:`${root}/${id}-error.png`}).catch(()=>{});}
   results.push(result);await fs.writeFile(`${root}/surfaces.json`,JSON.stringify(results,null,2));
   console.log(id,result.status,'errors',errors.length,'outside',result.geometry?.outsideViewport.length,'escape',result.escapeCloses);
   await context.close();
  }
 }
 await browser.close();
}
