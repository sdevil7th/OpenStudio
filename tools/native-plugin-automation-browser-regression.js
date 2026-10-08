// Attach playwright-cli to the task-owned Windows WebView2 CDP port. Requires
// a QA project copy, nativeAutomationQA on its main page, and an open editor.
async page => {
  const main=page.context().pages().find(p=>p.url().includes('window=main'));
  if(!main || !page.url().includes('window=pluginEditor')) throw new Error('Select the native plugin editor tab');
  const session=JSON.parse(new URL(page.url()).searchParams.get('sessionId'));
  const address=session.address;
  const schema=await main.evaluate(async address=>{
    const appSource=await (await fetch('/src/App.tsx')).text();
    const storeSource=await (await fetch(appSource.match(/from "([^"]*store\/useDAWStore[^"]*)"/)[1])).text();
    const automationSource=await (await fetch(storeSource.match(/from "([^"]*actions\/automation[^"/]*)"/)[1])).text();
    window.nativeAutomationQA.helpers=await import(automationSource.match(/from "([^"]*storeHelpers[^"]*)"/)[1]);
    return window.nativeAutomationQA.b.getBuiltInPluginSchema(address);
  },address);
  const controls=await page.getByRole('slider').evaluateAll((els,schema)=>els.map(el=>{
    const owner=el.closest('[data-param], [data-param-id]');
    const id=owner?.getAttribute('data-param')??owner?.getAttribute('data-param-id');
    const p=schema.parameters.find(p=>p.id===id),r=el.getBoundingClientRect();
    return p?.automatable&&r.width&&r.height&&r.top>=0&&r.bottom<=innerHeight ? {id,name:el.getAttribute('aria-label')} : null;
  }).filter(Boolean),schema);
  if(!controls.length) throw new Error('No visible automatable control in '+schema.name);
  const control=controls[0], param=`builtin_${address.chain}_${address.fxIndex}_${control.id}`;
  await main.evaluate(async address=>{
    const q=window.nativeAutomationQA,s=q.s.getState();
    await s.stop(); await s.seekTo(0); s.setAutomationWriteBehavior('touch');
    s.setTrackAutomationWrite(address.trackId,true); await s.play();
  },address);
  const slider=page.getByRole('slider',{name:control.name,exact:true}).first();
  const box=await slider.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2-12,{steps:6});
  await main.waitForFunction(({trackId,param})=>{
    const { _automationTouchedParams,automationTouchKey }=window.nativeAutomationQA.helpers;
    const t=window.nativeAutomationQA.s.getState().tracks.find(t=>t.id===trackId);
    return _automationTouchedParams.has(automationTouchKey(trackId,param))&&t.automationLanes.some(l=>l.param===param&&l.points.length);
  },{trackId:address.trackId,param});
  await page.waitForTimeout(500);
  const held=await main.evaluate(async ({trackId,param})=>{
    const {_automationTouchedParams,automationTouchKey}=window.nativeAutomationQA.helpers;
    return _automationTouchedParams.has(automationTouchKey(trackId,param));
  },{trackId:address.trackId,param});
  await page.mouse.up();
  await main.waitForFunction(({trackId,param})=>{
    const {_automationTouchedParams,automationTouchKey}=window.nativeAutomationQA.helpers;
    return !_automationTouchedParams.has(automationTouchKey(trackId,param));
  },{trackId:address.trackId,param});
  const result=await main.evaluate(async ({address,param,id})=>{
    const q=window.nativeAutomationQA,s=q.s.getState();await s.stop();
    const lane=q.s.getState().tracks.find(t=>t.id===address.trackId).automationLanes.find(l=>l.param===param);
    const native=await q.b.getBuiltInPluginSchema(address);
    q.lastEditorCheck={address,param,control:id};
    return {native:q.b.isNative,plugin:native.name,param,pointCount:lane.points.length,
      normalized:lane.points.every(p=>Number.isFinite(p.value)&&p.value>=0&&p.value<=1),nativeValue:native.parameters.find(p=>p.id===id).value};
  },{address,param,id:control.id});
  if(!held||!result.native||!result.normalized||!result.pointCount)throw new Error('Native Touch capture did not pass: '+JSON.stringify({held,...result}));
  await page.screenshot({path:`output/playwright/native-${schema.pluginId}-automation.png`});
  return {status:'pass',heldBeyondValueTimeout:held,released:true,...result,audioQuality:'not_asserted'};
}
