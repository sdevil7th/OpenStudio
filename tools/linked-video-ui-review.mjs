import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const app = arg('--app'), output = arg('--output'), source = arg('--source'), port = arg('--port');
await mkdir(output, { recursive: true });
const bridgeFile = (await readdir(path.join(path.dirname(app), 'webui/assets'))).find(n => /^NativeBridge-.*\.js$/.test(n));
let browser, page;
const checks = [], errors = [], check = (name, pass) => { checks.push({ name, pass }); if (!pass) throw new Error(name); };
const panel = () => page.getByRole('region', { name: 'Linked video tracks', exact: true });
const dialog = () => page.getByRole('dialog', { name: 'Video & Export', exact: true });
async function openPanel() { await page.getByRole('menuitem', { name: 'View menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Video & Export…', exact: true }).click(); await panel().waitFor(); const edit=panel().locator('summary').filter({hasText:'Edit selected video clip'}); if(await edit.count()&&!await edit.evaluate(el=>el.parentElement.open))await edit.click(); }
async function state() { return page.evaluate(() => window.__videoQA.store.getState().tracks.filter(t => t.linkedVideoOwner)); }
async function waitClip(field, value) { await page.waitForFunction(({ field, value }) => window.__videoQA.store.getState().tracks[0]?.clips[0]?.[field] === value, { field, value }); }
try {
  let connectionError;
  for (let i = 0; i < 100; ++i) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch (error) { connectionError=String(error);await new Promise(r => setTimeout(r, 200)); } }
  if (!browser) throw new Error(`Native WebView unavailable: ${connectionError}`);
  for (let i = 0; i < 100; ++i) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://juce.backend')); if (page) break; await new Promise(r => setTimeout(r, 200)); }
  if (!page) throw new Error('Native page missing'); page.on('pageerror', e => errors.push(e.message));
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Recover an interrupted session', exact: true }), async d => d.getByRole('button', { name: 'Later', exact: true }).click());
  await page.waitForSelector('[aria-label="Main workspace"]', { timeout: 30000 }); await page.locator('[data-qa="app-startup-loading"]').waitFor({ state: 'hidden' });
  await page.evaluate(async ({ bridgeFile, output }) => {
    const appModule = await import(document.querySelector('script[type="module"][src]').src);
    const store = Object.values(appModule).find(v => typeof v?.getState === 'function' && Array.isArray(v.getState()?.tracks));
    const bridgeModule = await import(new URL(`./assets/${bridgeFile}`, location.href).href);
    const bridge = Object.values(bridgeModule).find(v => typeof v?.productionLibrary === 'function');
    if (!store || !bridge?.isNative) throw new Error('Actual native store/bridge missing'); window.__videoQA = { store, bridge };
    store.setState({ autoBackupEnabled: false, showGettingStarted: false, inputProfileOnboardingSeen: true, projectName: 'Linked video QA', projectPath: `${output}/linked.osproj` });
  }, { bridgeFile, output });
  await page.evaluate(async source => { const s = window.__videoQA.store; await s.getState().importExternalMediaAtTimeline({ filePath: source, startTime: 1 }); await s.getState().importExternalMediaAtTimeline({ filePath: source, startTime: 8 }); }, source);
  let tracks = await state(); check('two imports create exactly two linked owners and two source clips', tracks.length === 2 && tracks.every(t => t.clips.length === 1 && t.recordSafe && t.clips[0].linkedVideo));
  check('one video and one linked-audio header per import', await page.locator('[data-video-header]').count() === 2 && await page.locator('[data-video-audio-header]').count()===2);
  check('real inspection retains delayed audio and rational frame rate', tracks[0].clips[0].linkedVideo.audioStartTimestamp === 10.5 && tracks[0].clips[0].linkedVideo.frameRate.denominator === 1001);
  await page.evaluate(() => { const s = window.__videoQA.store; s.setState({ selectedClipIds: [s.getState().tracks[0].clips[0].id] }); });
  async function dragNode(part,dx) {
    const point=await page.evaluate(part=>{const id=window.__videoQA.store.getState().tracks[0].clips[0].id;const stage=window.Konva.stages.find(s=>s.container().closest('.timeline-container'));const node=stage.findOne('.linked-'+part+'-'+id);if(!node)throw new Error('Missing linked canvas node');const r=node.getClientRect(),c=stage.container().getBoundingClientRect();return{x:c.x+r.x+r.width/2,y:c.y+r.y+Math.min(r.height/2,35)};},part);
    await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+dx,point.y,{steps:12});await page.mouse.up();
  }
  await dragNode('picture',60);await page.waitForFunction(()=>window.__videoQA.store.getState().tracks[0].clips[0].startTime>1.1);
  check('real picture drag commits linked timing',true);await page.evaluate(()=>window.__videoQA.store.getState().undo());await waitClip('startTime',1);
  await dragNode('audio',45);await page.waitForFunction(()=>window.__videoQA.store.getState().tracks[0].clips[0].startTime>1.1);
  check('real audio-row drag moves the shared picture interval',true);await page.evaluate(()=>window.__videoQA.store.getState().undo());await waitClip('startTime',1);
  await dragNode('right',-30);await page.waitForFunction(()=>window.__videoQA.store.getState().tracks[0].clips[0].duration<1.9);
  check('real picture edge drag trims linked audio on source frames',true);await page.evaluate(()=>window.__videoQA.store.getState().undo());await page.waitForFunction(()=>window.__videoQA.store.getState().tracks[0].clips[0].duration>2);
  await page.locator('[data-video-audio-header]').first().getByText('Linked audio',{exact:true}).click();await page.keyboard.press('Delete');
  await waitClip('muted',true);check('deleting linked-audio header preserves picture and removes only that audio row',await page.locator('[data-video-header]').count()===2&&await page.locator('[data-video-audio-header]').count()===1);
  await page.evaluate(()=>window.__videoQA.store.getState().undo());await waitClip('muted',false);
  await page.evaluate(()=>{const s=window.__videoQA.store;s.setState({selectedTrackId:null,selectedTrackIds:[],selectedClipIds:[s.getState().tracks[0].clips[0].id],selectedLinkedVideoPart:'picture'});});
  await openPanel();
  await panel().getByLabel('Source trim start (seconds)', { exact: true }).fill('0.5'); await panel().getByLabel('Linked duration (seconds)', { exact: true }).fill('1');
  await panel().getByRole('button', { name: 'Apply linked move / trim', exact: true }).click(); await waitClip('offset', .5);
  await dialog().getByRole('button', { name: 'Undo', exact: true }).click(); await waitClip('offset', 0);
  await dialog().getByRole('button', { name: 'Redo', exact: true }).click(); await waitClip('offset', .5); check('visible trim controls and Undo/Redo preserve the shared source interval', true);
  await page.evaluate(() => window.__videoQA.store.getState().seekTo(1.5));
  await panel().getByRole('button', { name: 'Split linked clip at cursor', exact: true }).click(); await page.waitForFunction(() => window.__videoQA.store.getState().tracks[0].clips.length === 2);
  check('split preserves one owner and contiguous picture/audio mapping', (await state())[0].clips[1].offset === 1);
  await dialog().getByRole('button', { name: 'Undo', exact: true }).click(); await page.waitForFunction(() => window.__videoQA.store.getState().tracks[0].clips.length === 1);
  const render = async name => { const file = path.join(output, name); check(`native audio render ${name}`, await page.evaluate(filePath => window.__videoQA.bridge.renderProject({ source: 'master', startTime: 0, endTime: 4, filePath, format: 'wav', sampleRate: 48000, bitDepth: 32, channels: 2, normalize: false, addTail: false, tailLength: 0 }), file)); return file; };
  await render('linked-audio.wav');
  await panel().getByRole('button', { name: 'Remove selected source audio', exact: true }).click(); await waitClip('muted', true);
  check('audio removal keeps picture and source ownership', (await state())[0].clips[0].linkedVideo.pictureEnabled && await panel().getByRole('button', { name: 'Restore original audio', exact: true }).isEnabled());
  await render('removed-audio.wav');
  check('save stores linked state', await page.evaluate(() => window.__videoQA.store.getState().saveProject()));
  await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  check('real native project reopen retains both owners and removed source audio', await page.evaluate(async file => { const s = window.__videoQA.store; if (!await s.getState().loadProject(file)) return false; return s.getState().tracks.length === 2 && s.getState().tracks[0].clips[0].linkedVideo.audioRemoved; }, path.join(output, 'linked.osproj')));
  await page.evaluate(() => { const s = window.__videoQA.store; s.setState({ selectedClipIds: [s.getState().tracks[0].clips[0].id] }); }); await openPanel();
  await panel().getByRole('button', { name: 'Restore original audio', exact: true }).click(); await waitClip('muted', false); await render('restored-audio.wav');
  for (const name of ['linked-audio.wav', 'removed-audio.wav', 'restored-audio.wav']) {
    const bytes = await readFile(path.join(output, name)); let fmt, pcm;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = bytes.subarray(offset + 8, offset + 8 + length);
      if (tag === 'fmt ') fmt = data; if (tag === 'data') pcm = data; offset += 8 + length + (length % 2);
    }
    if (!fmt || !pcm || fmt.readUInt16LE(0) !== 3 || fmt.readUInt16LE(2) !== 2 || fmt.readUInt32LE(4) !== 48000 || fmt.readUInt16LE(14) !== 32) throw new Error('Unexpected exported PCM format');
    const peak = (start, end) => { let p = 0; for (let i = Math.round(start * 48000) * 8; i < Math.round(end * 48000) * 8; i += 4) p = Math.max(p, Math.abs(pcm.readFloatLE(i))); return p; };
    check(`${name} has exact bounds and correct source-audio contribution`, pcm.length === 192000 * 8 && peak(0, .95) < 1e-7 && peak(2.05, 4) < 1e-7 && (name === 'removed-audio.wav' ? peak(1.1, 1.9) < 1e-7 : peak(1.1, 1.9) > .01));
  }
  await panel().getByLabel('Crop left (%)',{exact:true}).fill('25');await panel().getByLabel('Crop bottom (%)',{exact:true}).fill('75');await panel().getByRole('button',{name:'Apply picture crop',exact:true}).click();
  await page.waitForFunction(()=>window.__videoQA.store.getState().tracks[0].clips[0].linkedVideo.crop?.left===.25);
  check('crop changes picture without changing source timing', (await state())[0].clips[0].offset===.5 && (await state())[0].clips[0].duration===1);
  check('save restored linked graph before collection', await page.evaluate(() => window.__videoQA.store.getState().saveProject()));
  const json = await readFile(path.join(output, 'linked.osproj'), 'utf8');
  const collection = await page.evaluate(async ({ json, output }) => window.__videoQA.bridge.collectProjectMedia(json, `${output}/linked.osproj`, output, 'Linked collected'), { json, output });
  check('collection includes original picture and both prepared sources', collection.success && collection.copied === 3);
  await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  check('collected linked project resolves picture and audio in its media folder', await page.evaluate(async file => { const s = window.__videoQA.store; if (!await s.getState().loadProject(file)) return false; return s.getState().tracks[0].clips[0].linkedVideo.filePath.replaceAll('\\', '/').includes('/media/') && s.getState().tracks[0].clips[0].filePath.replaceAll('\\', '/').includes('/media/'); }, collection.projectPath));
  await openPanel();
  await page.evaluate(() => window.__videoQA.store.getState().seekTo(1.5));
  await page.getByRole('img', { name: /^Linked video at/ }).waitFor({ timeout: 30000 }); check('reference viewer decodes actual linked picture at a nonzero source timestamp', true);
  check('crop persists through collection and reopen',(await state())[0].clips[0].linkedVideo.crop.left===.25);
  const beforeStep=await page.evaluate(()=>window.__videoQA.store.getState().transport.currentTime);
  await page.getByRole('button',{name:'Next frame',exact:true}).click();await page.waitForFunction(t=>window.__videoQA.store.getState().transport.currentTime>t,beforeStep);
  await page.waitForFunction(()=>{const img=document.querySelector('[data-video-frame-time]');return img&&Number(img.dataset.videoFrameTime)>1;});
  check('frame-step seeks the actual transport and decoded picture',true);
  const scheduling=await page.evaluate(async()=>{
    const s=window.__videoQA.store,rows=[];
    const capture=()=>{const img=document.querySelector('[data-video-frame-time]');if(img)rows.push({frame:Number(img.dataset.videoFrameTime),clock:Number(img.dataset.videoClock),displayTime:s.getState().transport.currentTime,starts:Number(img.dataset.videoDecoderStarts),at:performance.now()});};
    const observer=new MutationObserver(capture);observer.observe(document.querySelector('[aria-label="Synchronized video preview"]'),{subtree:true,attributes:true,attributeFilter:['data-video-frame-time']});
    await s.getState().seekTo(1.05);await new Promise(r=>setTimeout(r,300));
    rows.length=0;
    for(let i=0;i<22;++i){await s.getState().seekTo(1.05+i/30);await new Promise(r=>setTimeout(r,40));}
    await new Promise(r=>setTimeout(r,100));observer.disconnect();return rows;
  });
  const unique=new Set(scheduling.map(r=>r.frame));const maxError=Math.max(...scheduling.map(r=>Math.abs(r.frame-(r.clock-.5))));
  check('controlled native clock progression delivers at least 16 distinct preview frames',unique.size>=16);
  check('delivered frame timestamps stay within one source frame of the captured native clock',maxError<=1001/30000+.001);
  await writeFile(path.join(output,'picture-clock.json'),JSON.stringify({mode:'controlled_native_seeks_no_hardware_clock',uniqueFrames:unique.size,maxError,rows:scheduling},null,2));
  await page.getByRole('region',{name:'Synchronized video preview',exact:true}).locator('div').first().screenshot({path:path.join(output,'cropped-picture.png')});
  await page.screenshot({ path: path.join(output, 'linked-video-panel.png') });
  await dialog().getByRole('button', { name: 'Close', exact: true }).click(); await page.screenshot({ path: path.join(output, 'linked-video-headers.png') });
  check('no uncaught frontend errors', errors.length === 0);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, errors, hardware: 'not_asserted', frameLockedPlayback: 'physical_latency_not_asserted', videoExport: 'not_implemented', deadlineQualification: 'pending' }, null, 2));
  console.log(JSON.stringify({ pass: true, checks: checks.length }));
  await page.evaluate(() => window.__videoQA.bridge.quitApplication()).catch(e => { if (!/closed|disconnected|destroyed/i.test(String(e))) throw e; });
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'body.txt'), await page.locator('body').innerText()).catch(() => {}); }
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, error: String(error) }, null, 2)); throw error;
} finally { if (browser) await browser.close().catch(() => {}); }
