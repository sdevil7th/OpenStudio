#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_OUT_DIR = `qa/midi-editor/${new Date().toISOString().slice(0, 10)}/implementation`;

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    cdpUrl: DEFAULT_CDP_URL,
    outDir: DEFAULT_OUT_DIR,
    scenario: "all",
    keepBrowser: false,
    edgePath: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--base" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (arg === "--cdp" && next) {
      args.cdpUrl = next;
      index += 1;
    } else if (arg === "--out" && next) {
      args.outDir = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      args.scenario = next;
      index += 1;
    } else if (arg === "--edge" && next) {
      args.edgePath = next;
      index += 1;
    } else if (arg === "--keep-browser") {
      args.keepBrowser = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node tools/midi-editor-acceptance-harness.mjs [options]

Options:
  --scenario all|app-shortcuts|app-docked-piano-focus|app-midi-multi-session|app-midi-recording-visibility|midi-fx-controls|midi-fx-placement|midi-project-persistence|midi-export-payload|timeline-basic|timeline-arrange|timeline-actions|timeline-cross-track|timeline-drop-targets|timeline-selection|timeline-keyboard-actions|timeline-snap-undo|timeline-source-context|timeline-backend-payload|piano-basic|piano-inspector|piano-tools|piano-range|piano-multi-item|piano-visual-viewports|piano-responsive-toolbar|piano-source-header|piano-audition-insert|piano-navigation-tools|piano-controller-lane|piano-controller-shapes|piano-velocity-line|piano-cc-direct|piano-note-metadata-lanes|piano-pitchbend-direct|piano-advanced-lanes|piano-lane-management
  --base http://127.0.0.1:5173
  --cdp http://127.0.0.1:9222
  --out qa/midi-editor/YYYY-MM-DD/implementation
  --edge "C:/Path/To/msedge.exe"
  --keep-browser

Requires the Vite dev server to be running, usually:
  cd frontend && npm run dev
`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.text();
}

async function assertServer(url, label) {
  try {
    await fetch(url, { method: "GET" });
  } catch (error) {
    throw new Error(`${label} is not reachable at ${url}. Start it before running this harness.`);
  }
}

async function isCdpReachable(cdpUrl) {
  try {
    await fetchJson(`${cdpUrl}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function findBrowserPath(explicitPath) {
  if (explicitPath) return explicitPath;
  const { access } = await import("node:fs/promises");
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error("Could not find Edge or Chrome. Pass --edge with a browser executable path.");
}

async function launchBrowserIfNeeded(args) {
  if (await isCdpReachable(args.cdpUrl)) return null;

  const browserPath = await findBrowserPath(args.edgePath);
  const cdpPort = new URL(args.cdpUrl).port || "9222";
  const profile = path.join(process.env.TEMP || ".", `studio13-midi-qa-${Date.now()}`);
  const child = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    args.baseUrl,
  ], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isCdpReachable(args.cdpUrl)) return child;
    await sleep(250);
  }

  child.kill();
  throw new Error(`Browser launched but CDP did not become reachable at ${args.cdpUrl}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }

    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params);
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        },
        once(method) {
          return new Promise((resolve) => {
            const listener = (params) => {
              listeners.set(method, (listeners.get(method) || []).filter((item) => item !== listener));
              resolve(params);
            };
            listeners.set(method, [...(listeners.get(method) || []), listener]);
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", reject);
  });
}

async function resolveStoreUrl(baseUrl, componentPath) {
  const transformed = await fetchText(`${baseUrl}${componentPath}`);
  const match = transformed.match(/from "([^"]*useDAWStore\.ts[^"]*)"/);
  if (!match) {
    throw new Error(`Could not resolve useDAWStore import from ${componentPath}`);
  }
  return new URL(match[1], baseUrl).href;
}

async function openTab(args, width, height) {
  const target = await fetchJson(`${args.cdpUrl}/json/new?${encodeURIComponent(args.baseUrl)}`, {
    method: "PUT",
  });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Input.setIgnoreInputEvents", { ignore: false });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: args.baseUrl });
  await loaded;
  return cdp;
}

async function evalInPage(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function screenshot(cdp, outDir, name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const filePath = path.join(outDir, name);
  await writeFile(filePath, Buffer.from(shot.data, "base64"));
  return filePath;
}

function pagePrelude() {
  return `
    document.body.innerHTML = '<div id="qa-root" style="width:100vw;height:100vh;overflow:hidden;background:#111318;display:flex;flex-direction:column"></div>';
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default ?? ReactModule;
    const ReactDOMModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const ReactDOM = ReactDOMModule.default ?? ReactDOMModule;
  `;
}

function timelineFixtureExpression(baseUrl, storeUrl, options = {}) {
  const config = {
    clipId: "qa-midi-clip",
    startTime: 1,
    duration: 2,
    offset: 0,
    sourceLength: 1,
    loopEnabled: true,
    loopOffset: 0,
    loopLength: 1,
    includeTargetTrack: false,
    targetTrackType: "instrument",
    includeSecondClip: false,
    initialSelectedClipIds: null,
    snapEnabled: false,
    gridSize: "beat",
    ...options,
  };

  return `
    (async () => {
      ${pagePrelude()}
      const storeModule = await import('${storeUrl}');
      const timelineModule = await import('${baseUrl}/src/components/Timeline.tsx');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      const fixtureConfig = ${JSON.stringify(config)};
      const track = createDefaultTrack('qa-midi-track', 'Timeline MIDI', '#49a7c7', 'midi');
      track.midiClips = [{
        id: fixtureConfig.clipId,
        name: 'MIDI Item',
        startTime: fixtureConfig.startTime,
        duration: fixtureConfig.duration,
        offset: fixtureConfig.offset,
        sourceStart: 0,
        sourceLength: fixtureConfig.sourceLength,
        loopEnabled: fixtureConfig.loopEnabled,
        loopOffset: fixtureConfig.loopOffset,
        loopLength: fixtureConfig.loopLength,
        color: '#49a7c7',
        events: [
          { type: 'noteOn', timestamp: 0, note: 60, velocity: 96, channel: 1, probability: 0.92, velocityVariance: 7 },
          { type: 'noteOff', timestamp: 0.5, note: 60, velocity: 32, releaseVelocity: 32, channel: 1 },
          { type: 'noteOn', timestamp: 0.5, note: 64, velocity: 80, channel: 2, playCount: 3 },
          { type: 'noteOff', timestamp: 0.95, note: 64, velocity: 20, releaseVelocity: 20, channel: 2 },
          { type: 'pitchBend', timestamp: 0.0, value: 8192, channel: 1 },
          { type: 'pitchBend', timestamp: 0.5, value: 10600, channel: 1 }
        ],
        ccEvents: [
          { cc: 1, time: 0, value: 18, channel: 1 },
          { cc: 1, time: 0.5, value: 96, channel: 1 },
          { cc: 33, time: 0.5, value: 12, channel: 1 }
        ]
      }];
      if (fixtureConfig.includeSecondClip) {
        track.midiClips.push({
          id: 'qa-midi-clip-b',
          name: 'MIDI Item B',
          startTime: 4,
          duration: 1.25,
          offset: 0,
          sourceStart: 0,
          sourceLength: 1.25,
          loopEnabled: true,
          loopOffset: 0,
          loopLength: 1.25,
          color: '#c77d49',
          events: [
            { type: 'noteOn', timestamp: 0, note: 67, velocity: 96, channel: 1 },
            { type: 'noteOff', timestamp: 0.75, note: 67, velocity: 32, releaseVelocity: 32, channel: 1 }
          ],
          ccEvents: []
        });
      }
      const tracks = [track];
      if (fixtureConfig.includeTargetTrack) {
        const targetTrack = createDefaultTrack('qa-midi-target', 'Target Instrument', '#a78bfa', fixtureConfig.targetTrackType);
        targetTrack.midiClips = [];
        tracks.push(targetTrack);
      }
      const selectedClipIds = Array.isArray(fixtureConfig.initialSelectedClipIds)
        ? fixtureConfig.initialSelectedClipIds
        : [fixtureConfig.clipId];
      useDAWStore.setState({
        tracks,
        selectedClipIds,
        selectedClipId: selectedClipIds[0] ?? null,
        pixelsPerSecond: 110,
        scrollX: 0,
        scrollY: 0,
        showAutomation: false,
        snapEnabled: fixtureConfig.snapEnabled,
        gridSize: fixtureConfig.gridSize,
        toolMode: 'select',
      });
      function Harness() {
        const tracks = useDAWStore((state) => state.tracks);
        return React.createElement(timelineModule.Timeline, { tracks, showRuler: true });
      }
      ReactDOM.createRoot(document.getElementById('qa-root')).render(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const clip = useDAWStore.getState().tracks[0].midiClips[0];
      const canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      });
      return {
        start: clip.startTime,
        duration: clip.duration,
        offset: clip.offset || 0,
        clipCount: useDAWStore.getState().tracks[0].midiClips.length,
        clips: useDAWStore.getState().tracks.flatMap((candidateTrack) => candidateTrack.midiClips.map((candidate) => ({
          id: candidate.id,
          trackId: candidateTrack.id,
          start: candidate.startTime,
          duration: candidate.duration,
          offset: candidate.offset || 0,
          sourceLength: candidate.sourceLength,
          loopLength: candidate.loopLength,
          loopOffset: candidate.loopOffset || 0,
        }))),
        trackIds: useDAWStore.getState().tracks.map((candidateTrack) => candidateTrack.id),
        canvases,
      };
    })()
  `;
}

function timelineStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clips = state.tracks.flatMap((track) => track.midiClips.map((clip) => ({ track, clip })));
      const clip = clips[0];
      return {
        start: clip?.clip.startTime ?? null,
        duration: clip?.clip.duration ?? null,
        offset: clip?.clip.offset || 0,
        muted: Boolean(clip?.clip.muted),
        locked: Boolean(clip?.clip.locked),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        selectedClipIds: state.selectedClipIds,
        toolMode: state.toolMode,
        clipCount: clips.length,
        clips: clips.map(({ track, clip: candidate }) => ({
          id: candidate.id,
          trackId: track.id,
          trackType: track.type,
          start: candidate.startTime,
          duration: candidate.duration,
          offset: candidate.offset || 0,
          sourceLength: candidate.sourceLength,
          loopLength: candidate.loopLength,
          loopOffset: candidate.loopOffset || 0,
          muted: Boolean(candidate.muted),
          locked: Boolean(candidate.locked),
        })),
        trackCount: state.tracks.length,
        trackTypes: state.tracks.map((track) => ({ id: track.id, type: track.type })),
      };
    })()
  `;
}

function setTimelineToolExpression(storeUrl, toolMode) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().setToolMode('${toolMode}');
      return useDAWStore.getState().toolMode;
    })()
  `;
}

function setPianoToolExpression(storeUrl, tool) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().setActiveMidiTool('${tool}');
      return useDAWStore.getState().activeMidiTool;
    })()
  `;
}

async function drag(cdp, fromX, fromY, toX, toY, options = {}) {
  const steps = options.steps ?? 8;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  for (let index = 1; index <= steps; index += 1) {
    const x = fromX + ((toX - fromX) * index) / steps;
    const y = fromY + ((toY - fromY) * index) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      modifiers: options.modifiers ?? 0,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  await sleep(options.settleMs ?? 350);
}

async function click(cdp, x, y, options = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers: options.modifiers ?? 0 });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  await sleep(options.settleMs ?? 250);
}

async function contextClick(cdp, x, y, options = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers: options.modifiers ?? 0 });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "right",
    buttons: 2,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "right",
    buttons: 0,
    clickCount: 1,
    modifiers: options.modifiers ?? 0,
  });
  await sleep(options.settleMs ?? 350);
}

async function clickContextMenuLabel(cdp, label) {
  const target = await evalInPage(cdp, `
    (() => {
      const candidates = [...document.querySelectorAll('span, div')]
        .filter((element) => element.textContent && element.textContent.trim() === ${JSON.stringify(label)})
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
        })
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return candidates[0] || null;
    })()
  `);
  if (!target) throw new Error(`Could not find context-menu item: ${label}`);
  await click(cdp, target.x, target.y);
  return target;
}

async function activateContextMenuLabel(cdp, label) {
  const activated = await evalInPage(cdp, `
    (() => {
      const labels = [...document.querySelectorAll('span, div')]
        .filter((element) => element.textContent && element.textContent.trim() === ${JSON.stringify(label)});
      for (const labelElement of labels) {
        const row = labelElement.closest('.cursor-pointer') || labelElement.parentElement;
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        return true;
      }
      return false;
    })()
  `);
  if (!activated) throw new Error(`Could not activate context-menu item: ${label}`);
  await sleep(250);
}

async function hoverContextMenuLabel(cdp, label) {
  const target = await evalInPage(cdp, `
    (() => {
      const candidates = [...document.querySelectorAll('span')]
        .filter((element) => element.textContent && element.textContent.trim() === ${JSON.stringify(label)})
        .map((element) => {
          const row = element.closest('.relative') || element.parentElement || element;
          row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: element.getBoundingClientRect().left + 4, clientY: element.getBoundingClientRect().top + 4 }));
          row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: element.getBoundingClientRect().left + 4, clientY: element.getBoundingClientRect().top + 4 }));
          const rect = row.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
        })
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return candidates[0] || null;
    })()
  `);
  if (!target) throw new Error(`Could not find context-menu item to hover: ${label}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "none" });
  await sleep(500);
  return target;
}

function storeUndoRedoExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      const state = useDAWStore.getState();
      const clips = state.tracks.flatMap((track) => track.midiClips.map((clip) => ({ track, clip })));
      const first = clips[0];
      return {
        start: first?.clip.startTime ?? null,
        duration: first?.clip.duration ?? null,
        offset: first?.clip.offset || 0,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        clipCount: clips.length,
        clips: clips.map(({ track, clip }) => ({
          id: clip.id,
          trackId: track.id,
          start: clip.startTime,
          duration: clip.duration,
          offset: clip.offset || 0,
          sourceLength: clip.sourceLength,
          loopLength: clip.loopLength,
          loopEnabled: clip.loopEnabled,
          loopOffset: clip.loopOffset || 0,
        })),
      };
    })()
  `;
}

function appShortcutFixtureExpression(storeUrl) {
  return `
    (async () => {
      const storeModule = await import('${storeUrl}');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      const track = createDefaultTrack('qa-app-track', 'App MIDI', '#49a7c7', 'midi');
      track.midiClips = [{
        id: 'qa-app-midi-clip',
        name: 'Shortcut MIDI',
        startTime: 1,
        duration: 2,
        offset: 0,
        sourceStart: 0,
        sourceLength: 1,
        loopEnabled: true,
        loopOffset: 0,
        loopLength: 1,
        color: '#49a7c7',
        events: [
          { type: 'noteOn', timestamp: 0, note: 60, velocity: 96, channel: 1 },
          { type: 'noteOff', timestamp: 0.5, note: 60, velocity: 32, releaseVelocity: 32, channel: 1 }
        ],
        ccEvents: []
      }];
      useDAWStore.setState({
        tracks: [track],
        selectedClipIds: ['qa-app-midi-clip'],
        selectedClipId: 'qa-app-midi-clip',
        pixelsPerSecond: 110,
        scrollX: 0,
        scrollY: 0,
        showAutomation: false,
        showPianoRoll: false,
        showPitchEditor: false,
        showCommandPalette: false,
        showGettingStarted: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      useDAWStore.getState().setMIDIClipSourceWindow(
        'qa-app-midi-clip',
        { sourceLength: 2.5, loopLength: 2.5 },
        'QA app shortcut source length edit',
      );
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      const clip = useDAWStore.getState().tracks[0].midiClips[0];
      return {
        sourceLength: clip.sourceLength,
        loopLength: clip.loopLength,
        canUndo: useDAWStore.getState().canUndo,
        canRedo: useDAWStore.getState().canRedo,
      };
    })()
  `;
}

function appShortcutStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clip = state.tracks[0]?.midiClips[0];
      return {
        sourceLength: clip?.sourceLength ?? null,
        loopLength: clip?.loopLength ?? null,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function appTimelineFixtureExpression(storeUrl) {
  return `
    (async () => {
      const storeModule = await import('${storeUrl}');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      const track = createDefaultTrack('qa-app-track', 'App MIDI', '#49a7c7', 'midi');
      track.midiClips = [{
        id: 'qa-app-midi-clip',
        name: 'Shortcut MIDI',
        startTime: 1,
        duration: 2,
        offset: 0,
        sourceStart: 0,
        sourceLength: 1,
        loopEnabled: true,
        loopOffset: 0,
        loopLength: 1,
        color: '#49a7c7',
        events: [
          { type: 'noteOn', timestamp: 0, note: 60, velocity: 96, channel: 1 },
          { type: 'noteOff', timestamp: 0.5, note: 60, velocity: 32, releaseVelocity: 32, channel: 1 }
        ],
        ccEvents: []
      }];
      useDAWStore.setState({
        tracks: [track],
        selectedClipIds: ['qa-app-midi-clip'],
        selectedClipId: 'qa-app-midi-clip',
        pixelsPerSecond: 110,
        scrollX: 0,
        scrollY: 0,
        showAutomation: false,
        showPianoRoll: false,
        showPitchEditor: false,
        showCommandPalette: false,
        showGettingStarted: false,
      });
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const clips = useDAWStore.getState().tracks.flatMap((candidateTrack) => candidateTrack.midiClips.map((clip) => ({ trackId: candidateTrack.id, clip })));
      return {
        clipCount: clips.length,
        selectedClipIds: useDAWStore.getState().selectedClipIds,
        canUndo: useDAWStore.getState().canUndo,
        canRedo: useDAWStore.getState().canRedo,
        clips: clips.map(({ trackId, clip }) => ({
          id: clip.id,
          trackId,
          start: clip.startTime,
          duration: clip.duration,
        })),
      };
    })()
  `;
}

function appTimelineClipStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clips = state.tracks.flatMap((track) => track.midiClips.map((clip) => ({ trackId: track.id, clip })));
      return {
        clipCount: clips.length,
        selectedClipIds: state.selectedClipIds,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        clips: clips.map(({ trackId, clip }) => ({
          id: clip.id,
          trackId,
          start: clip.startTime,
          duration: clip.duration,
        })),
      };
    })()
  `;
}

function appDockedPianoFixtureExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      const storeModule = await import('${storeUrl}');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      const track = createDefaultTrack('qa-dock-track', 'Docked MIDI', '#58c3a3', 'midi');
      track.midiClips = [
        {
          id: 'qa-dock-clip-a',
          name: 'Dock Clip A',
          startTime: 0.5,
          duration: 1.2,
          offset: 0,
          sourceStart: 0,
          sourceLength: 1.2,
          loopEnabled: false,
          color: '#58c3a3',
          events: [
            { type: 'noteOn', timestamp: 0.1, note: 60, velocity: 92, channel: 1 },
            { type: 'noteOff', timestamp: 0.7, note: 60, velocity: 0, releaseVelocity: 32, channel: 1 },
          ],
          ccEvents: [],
        },
        {
          id: 'qa-dock-clip-b',
          name: 'Dock Clip B',
          startTime: 2.15,
          duration: 1.25,
          offset: 0,
          sourceStart: 0,
          sourceLength: 1.25,
          loopEnabled: false,
          color: '#a78bfa',
          events: [
            { type: 'noteOn', timestamp: 0.15, note: 67, velocity: 88, channel: 1 },
            { type: 'noteOff', timestamp: 0.8, note: 67, velocity: 0, releaseVelocity: 40, channel: 1 },
          ],
          ccEvents: [],
        },
      ];
      useDAWStore.setState({
        tracks: [track],
        selectedTrackId: track.id,
        selectedTrackIds: [track.id],
        selectedClipIds: ['qa-dock-clip-a', 'qa-dock-clip-b'],
        selectedClipId: 'qa-dock-clip-a',
        pixelsPerSecond: 110,
        scrollX: 0,
        scrollY: 0,
        snapEnabled: false,
        trackHeight: 72,
        tcpWidth: 220,
        lowerZoneHeight: 320,
        showAutomation: false,
        showMixer: false,
        showPianoRoll: true,
        pianoRollTrackId: track.id,
        pianoRollClipId: 'qa-dock-clip-a',
        showPitchEditor: false,
        showCommandPalette: false,
        showGettingStarted: false,
        showMediaExplorer: false,
        showClipLauncher: false,
      });
      document.getElementById('openstudio-boot-overlay')?.remove();
      const bridgeModule = await import('${baseUrl}/src/services/NativeBridge.ts');
      window.__studio13QAMidiWindowCalls = { open: [], prewarm: [], focus: [], close: [], publish: [] };
      bridgeModule.nativeBridge.openMidiEditorWindow = async (sessionId, bounds) => {
        window.__studio13QAMidiWindowCalls.open.push({ sessionId, bounds });
        return true;
      };
      bridgeModule.nativeBridge.prewarmMidiEditorWindow = async (sessionId, bounds) => {
        window.__studio13QAMidiWindowCalls.prewarm.push({ sessionId, bounds });
        return true;
      };
      bridgeModule.nativeBridge.focusMidiEditorWindow = async (sessionId) => {
        window.__studio13QAMidiWindowCalls.focus.push({ sessionId });
        return true;
      };
      bridgeModule.nativeBridge.closeMidiEditorWindow = async (sessionId, reason = 'close') => {
        window.__studio13QAMidiWindowCalls.close.push({ sessionId, reason });
        return true;
      };
      bridgeModule.nativeBridge.publishMidiEditorUISnapshot = async (sessionId, snapshot) => {
        window.__studio13QAMidiWindowCalls.publish.push({
          sessionId,
          trackCount: snapshot?.tracks?.length ?? 0,
          clipId: snapshot?.pianoRollClipId ?? null,
        });
        return true;
      };
      window.__studio13QANotePreviewEvents = [];
      window.addEventListener('openstudio-midi-note-preview', (event) => {
        window.__studio13QANotePreviewEvents.push(event.detail);
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      useDAWStore.getState().openMidiEditorForClip(track.id, 'qa-dock-clip-a');
      await new Promise((resolve) => setTimeout(resolve, 350));
      return (${appDockedPianoStateBody()})();
    })()
  `;
}

function appDockedPianoStateBody() {
  return `() => {
    const useDAWStore = window.__studio13QADAWStore;
    const state = useDAWStore.getState();
    const track = state.tracks[0];
    const dock = document.querySelector('[data-qa="docked-piano-roll"]');
    const activeSelect = document.querySelector('.piano-roll-clip-select');
    const pianoCanvas = dock?.querySelector('.piano-roll-editor-pane canvas') ?? null;
    const pianoSidebar = dock?.querySelector('[data-qa="piano-roll-left-sidebar"]') ?? null;
    const resizeHandle = dock?.querySelector('[data-qa="piano-roll-resize-handle"]') ?? null;
    const ruler = dock?.querySelector('[data-qa="piano-roll-ruler"]') ?? null;
    const rulerPlayhead = dock?.querySelector('[data-qa="piano-roll-ruler-playhead"]') ?? null;
    const keyViewport = dock?.querySelector('[data-qa="piano-roll-key-viewport"]') ?? null;
    const popOutButton = dock?.querySelector('[data-qa="docked-midi-editor-pop-out"]') ?? null;
    const rectFor = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const timelineCanvases = [...document.querySelectorAll('.timeline-container canvas')]
      .map((canvas) => ({ element: canvas, rect: rectFor(canvas) }))
      .filter((entry) => entry.rect && entry.rect.height > 80)
      .sort((a, b) => b.rect.height - a.rect.height);
    const timelineRect = timelineCanvases[0]?.rect ?? null;
    const clickForClip = (clipId) => {
      const clip = track?.midiClips.find((candidate) => candidate.id === clipId);
      if (!clip || !timelineRect) return null;
      const clipTop = timelineRect.top + 5;
      const clipHeight = 62;
      return {
        x: timelineRect.left + ((clip.startTime + clip.duration / 2) * state.pixelsPerSecond) - state.scrollX,
        y: clipTop + clipHeight / 2,
      };
    };
    const expectedClipRects = (track?.midiClips || []).map((clip) => ({
      id: clip.id,
      left: timelineRect ? timelineRect.left + clip.startTime * state.pixelsPerSecond - state.scrollX : null,
      top: timelineRect ? timelineRect.top + 5 : null,
      right: timelineRect ? timelineRect.left + (clip.startTime + clip.duration) * state.pixelsPerSecond - state.scrollX : null,
      bottom: timelineRect ? timelineRect.top + 67 : null,
    }));
    const secondClick = clickForClip('qa-dock-clip-b');
    const elementAtSecond = secondClick ? document.elementFromPoint(secondClick.x, secondClick.y) : null;
    return {
      showPianoRoll: state.showPianoRoll,
      pianoRollClipId: state.pianoRollClipId,
      selectedClipIds: [...state.selectedClipIds],
      dockRect: rectFor(dock),
      pianoCanvasRect: rectFor(pianoCanvas),
      pianoSidebarRect: rectFor(pianoSidebar),
      resizeHandleRect: rectFor(resizeHandle),
      rulerRect: rectFor(ruler),
      rulerPlayheadRect: rectFor(rulerPlayhead),
      keyViewportRect: rectFor(keyViewport),
      popOutButtonRect: rectFor(popOutButton),
      tcpWidth: state.tcpWidth,
      pixelsPerSecond: state.pixelsPerSecond,
      scrollX: state.scrollX,
      transportCurrentTime: state.transport.currentTime,
      timelineRect,
      hasDockedPianoRoll: Boolean(dock),
      activeSelectValue: activeSelect?.value ?? null,
      activeSelectOptions: activeSelect ? [...activeSelect.options].map((option) => ({ value: option.value, text: option.textContent })) : [],
      dockedTitle: document.querySelector('[data-qa="docked-midi-editor-title"]')?.textContent?.trim() ?? null,
      hasPopOutButton: Boolean(document.querySelector('[data-qa="docked-midi-editor-pop-out"]')),
      midiEditorSessions: (state.midiEditorSessions || []).map((session) => ({
        sessionId: session.sessionId,
        trackId: session.trackId,
        clipId: session.clipId,
        mode: session.mode,
      })),
      activeMidiEditorSessionId: state.activeMidiEditorSessionId,
      dockedMidiEditorSessionId: state.dockedMidiEditorSessionId,
      midiWindowCalls: window.__studio13QAMidiWindowCalls || { open: [], prewarm: [], focus: [], close: [], publish: [] },
      notePreviewEvents: window.__studio13QANotePreviewEvents || [],
      firstClipClick: clickForClip('qa-dock-clip-a'),
      secondClipClick: secondClick,
      expectedClipRects,
      elementAtSecond: elementAtSecond ? {
        tag: elementAtSecond.tagName,
        className: elementAtSecond.className,
        id: elementAtSecond.id,
        text: elementAtSecond.textContent?.slice(0, 80) ?? '',
      } : null,
      pianoSidebarWidthMatchesTcp: Boolean(pianoSidebar) && Math.abs(rectFor(pianoSidebar).width - state.tcpWidth) <= 1,
      pianoCanvasStartsUnderTimeline: Boolean(pianoCanvas && pianoSidebar) && Math.abs(rectFor(pianoCanvas).left - rectFor(pianoSidebar).right - 6) <= 2,
    };
  }`;
}

function appDockedPianoStateExpression() {
  return `
    (() => (${appDockedPianoStateBody()})())()
  `;
}

function midiFXFixtureExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      ${pagePrelude()}
      const storeModule = await import('${storeUrl}');
      const midiFXModule = await import('${baseUrl}/src/components/MIDIFXControls.tsx');
      const bridgeModule = await import('${baseUrl}/src/services/NativeBridge.ts');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      window.__studio13QAMIDIFXSyncPayloads = [];
      bridgeModule.nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
        window.__studio13QAMIDIFXSyncPayloads.push({ trackId, clips: JSON.parse(JSON.stringify(clips)) });
        return true;
      };
      const track = createDefaultTrack('qa-midi-fx-track', 'MIDI FX Track', '#49a7c7', 'midi');
      track.midiEffects = [];
      track.midiClips = [{
        id: 'qa-midi-fx-clip',
        name: 'MIDI FX Payload Clip',
        startTime: 1,
        duration: 1,
        offset: 0,
        sourceStart: 0,
        sourceLength: 1,
        loopEnabled: false,
        color: '#49a7c7',
        events: [
          { type: 'noteOn', timestamp: 0.125, note: 64, velocity: 80, channel: 2, probability: 1, velocityVariance: 12 },
          { type: 'noteOff', timestamp: 0.375, note: 64, velocity: 0, releaseVelocity: 31, channel: 2 },
          { type: 'noteOn', timestamp: 0.25, note: 60, velocity: 80, channel: 2, probability: 1, velocityVariance: 0 },
          { type: 'noteOff', timestamp: 0.75, note: 60, velocity: 44, releaseVelocity: 44, channel: 2 },
          { type: 'noteOn', timestamp: 0.1, note: 72, velocity: 80, channel: 2, probability: 0 },
          { type: 'noteOff', timestamp: 0.5, note: 72, velocity: 0, channel: 2 },
        ],
        ccEvents: [
          { cc: 1, time: 0.2, value: 64, channel: 2 },
        ],
      }];
      useDAWStore.setState({ tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id] });
      function Harness() {
        const currentTrack = useDAWStore((state) => state.tracks[0]);
        return React.createElement(
          'div',
          { style: { padding: '24px', color: 'white', background: '#111318', height: '100%' } },
          React.createElement(midiFXModule.MIDIFXControls, { track: currentTrack }),
        );
      }
      ReactDOM.createRoot(document.getElementById('qa-root')).render(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 350));
      return {
        hasControls: Boolean(document.querySelector('[title="MIDI velocity processor"]')),
        effectCount: useDAWStore.getState().tracks[0].midiEffects.length,
        effects: useDAWStore.getState().tracks[0].midiEffects,
        canUndo: useDAWStore.getState().canUndo,
        canRedo: useDAWStore.getState().canRedo,
      };
    })()
  `;
}

function midiFXPlacementFixtureExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      ${pagePrelude()}
      const storeModule = await import('${storeUrl}');
      const trackHeaderModule = await import('${baseUrl}/src/components/TrackHeader.tsx');
      const bridgeModule = await import('${baseUrl}/src/services/NativeBridge.ts');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      window.__studio13QAPromptCount = 0;
      window.__studio13QASamplerCalls = [];
      window.prompt = () => {
        window.__studio13QAPromptCount += 1;
        return null;
      };
      bridgeModule.nativeBridge.getMIDIInputDevices = async () => [];
      bridgeModule.nativeBridge.getMIDIOutputDevices = async () => [];
      bridgeModule.nativeBridge.getOpenMIDIDevices = async () => [];
      bridgeModule.nativeBridge.getTrackInputFX = async () => [];
      bridgeModule.nativeBridge.getTrackFX = async () => [];
      bridgeModule.nativeBridge.getAvailablePlugins = async () => [];
      bridgeModule.nativeBridge.getAvailableS13FX = async () => [];
      bridgeModule.nativeBridge.getAvailableBuiltInFX = async () => [];
      bridgeModule.nativeBridge.showOpenDialog = async () => 'C:/qa/review-sampler.wav';
      bridgeModule.nativeBridge.setTrackSamplerSample = async (trackId, samplePath, rootNote) => {
        window.__studio13QASamplerCalls.push({ trackId, samplePath, rootNote });
        return true;
      };
      bridgeModule.nativeBridge.clearTrackSamplerSample = async () => true;
      bridgeModule.nativeBridge.setTrackMIDIClips = async () => true;
      const track = createDefaultTrack('qa-midi-fx-placement-track', 'MIDI Placement Track', '#49a7c7', 'instrument');
      track.midiEffects = [];
      useDAWStore.setState({
        tracks: [track],
        selectedTrackId: track.id,
        selectedTrackIds: [track.id],
        trackHeight: 96,
        audioDeviceSetup: {
          driverType: 'WASAPI',
          inputDeviceName: '',
          outputDeviceName: '',
          sampleRate: 48000,
          bufferSize: 512,
          numInputChannels: 2,
          numOutputChannels: 2,
          inputChannelNames: ['In 1', 'In 2'],
          outputChannelNames: ['Out 1', 'Out 2'],
        },
      });
      function Harness() {
        const currentTrack = useDAWStore((state) => state.tracks[0]);
        return React.createElement(
          'div',
          {
            id: 'qa-track-header',
            style: {
              width: '420px',
              height: '120px',
              overflow: 'hidden',
              color: 'white',
              background: '#111318',
            },
          },
          React.createElement(trackHeaderModule.TrackHeader, { track: currentTrack, isSelected: true }),
        );
      }
      ReactDOM.createRoot(document.getElementById('qa-root')).render(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (${midiFXPlacementStateBody()})();
    })()
  `;
}

function midiFXPlacementStateBody() {
  return `
    (() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const midiFxLabels = new Set(['Arp', 'Pit', 'Vel', 'Tim']);
      const header = document.querySelector('#qa-track-header');
      const headerButtons = [...(header?.querySelectorAll('button') || [])].map((button) => normalize(button.textContent));
      const samplerButton = [...(header?.querySelectorAll('button') || [])].find((button) => button.getAttribute('aria-label') === 'Load built-in sampler sample');
      const panel = document.querySelector('.fx-chain-panel-two-column');
      const panelButtons = [...(panel?.querySelectorAll('button') || [])].map((button) => normalize(button.textContent));
      const state = window.__studio13QADAWStore?.getState?.();
      const track = state?.tracks?.[0];
      return {
        headerMidiFxButtons: headerButtons.filter((label) => midiFxLabels.has(label)),
        panelMidiFxButtons: panelButtons.filter((label) => midiFxLabels.has(label)),
        hasFxButton: headerButtons.includes('FX'),
        hasSamplerButton: Boolean(samplerButton),
        hasSamplerDialog: Boolean(document.querySelector('#sampler-root-note-input')),
        samplerSamplePath: track?.samplerSamplePath ?? null,
        samplerRootNote: track?.samplerRootNote ?? null,
        samplerCalls: window.__studio13QASamplerCalls || [],
        promptCount: window.__studio13QAPromptCount || 0,
        hasPanel: Boolean(panel),
        hasPanelMidiFxSection: Boolean(panel && normalize(panel.textContent).includes('MIDI FX')),
      };
    })
  `;
}

function midiFXPlacementStateExpression() {
  return `
    (${midiFXPlacementStateBody()})();
  `;
}

function appTcpMidiHeaderPlacementFixtureExpression(storeUrl) {
  return `
    (async () => {
      const storeModule = await import('${storeUrl}');
      const { useDAWStore, createDefaultTrack } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      document.getElementById('openstudio-boot-overlay')?.remove();
      const midiTrack = createDefaultTrack('qa-app-midi-track', 'QA MIDI Track', '#49a7c7', 'midi');
      const instrumentTrack = createDefaultTrack('qa-app-instrument-track', 'QA Instrument Track', '#a78bfa', 'instrument');
      midiTrack.midiEffects = [];
      instrumentTrack.midiEffects = [];
      useDAWStore.setState({
        tracks: [midiTrack, instrumentTrack],
        selectedTrackId: instrumentTrack.id,
        selectedTrackIds: [instrumentTrack.id],
        trackHeight: 96,
        tcpWidth: 440,
        showMixer: false,
        showPianoRoll: false,
        showPitchEditor: false,
        showCommandPalette: false,
        showGettingStarted: false,
        showMediaExplorer: false,
        showClipLauncher: false,
        showVirtualKeyboard: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      return (${appTcpMidiHeaderPlacementStateBody()})();
    })()
  `;
}

function appTcpMidiHeaderPlacementStateBody() {
  return `() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const midiFxLabels = new Set(['Arp', 'Pit', 'Vel', 'Tim']);
    const rows = [...document.querySelectorAll('.track-control-panel [data-track-id]')].map((row) => {
      const labels = [...row.querySelectorAll('button')].map((button) => normalize(button.textContent));
      return {
        trackId: row.getAttribute('data-track-id'),
        labels,
        midiFxButtons: labels.filter((label) => midiFxLabels.has(label)),
        hasFxButton: labels.includes('FX'),
        hasSamplerButton: Boolean(row.querySelector('[aria-label="Load built-in sampler sample"]')),
        text: normalize(row.textContent),
      };
    });
    return {
      rowCount: rows.length,
      rows,
      headerMidiFxButtons: rows.flatMap((row) => row.midiFxButtons),
      midiRow: rows.find((row) => row.trackId === 'qa-app-midi-track') ?? null,
      instrumentRow: rows.find((row) => row.trackId === 'qa-app-instrument-track') ?? null,
    };
  }`;
}

function midiFXBackendPayloadExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      await new Promise((resolve) => setTimeout(resolve, 350));
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const direct = serializationModule.serializeMIDIClipsForBackend(track?.midiClips || [], track?.midiEffects || []);
      const directAgain = serializationModule.serializeMIDIClipsForBackend(track?.midiClips || [], track?.midiEffects || []);
      const payloads = window.__studio13QAMIDIFXSyncPayloads || [];
      const lastSync = payloads[payloads.length - 1] || null;
      const events = lastSync?.clips?.[0]?.events || [];
      const shiftedNote = events.find((event) => event.type === 'noteOn' && event.note === 67);
      const shiftedOff = events.find((event) => event.type === 'noteOff' && event.note === 67);
      const varianceNote = events.find((event) => event.type === 'noteOn' && event.note === 71);
      const varianceOff = events.find((event) => event.type === 'noteOff' && event.note === 71);
      const droppedProbabilityZero = !events.some((event) => event.note === 79 || event.note === 72);
      const shiftedCC = events.find((event) => event.type === 'cc' && event.controller === 1);
      return {
        effects: track?.midiEffects || [],
        syncPayloadCount: payloads.length,
        direct,
        lastSync,
        events,
        checks: {
          directMatchesLastSync: JSON.stringify(direct) === JSON.stringify(lastSync?.clips || []),
          repeatedSerializationDeterministic: JSON.stringify(direct) === JSON.stringify(directAgain),
          hasShiftedNote: Boolean(shiftedNote && shiftedNote.velocity === 94 && Math.abs(shiftedNote.timestamp - 0.2915) < 0.0001 && shiftedNote.channel === 2),
          hasShiftedNoteOff: Boolean(shiftedOff && shiftedOff.releaseVelocity === 44 && Math.abs(shiftedOff.timestamp - 0.7915) < 0.0001),
          hasDeterministicVelocityVariance: Boolean(varianceNote && varianceNote.velocity === 82 && Math.abs(varianceNote.timestamp - 0.1665) < 0.0001 && varianceOff && varianceOff.releaseVelocity === 31 && Math.abs(varianceOff.timestamp - 0.389) < 0.0001),
          droppedProbabilityZero,
          timeShiftedCC: Boolean(shiftedCC && shiftedCC.value === 64 && Math.abs(shiftedCC.timestamp - 0.2415) < 0.0001),
        },
      };
    })()
  `;
}

function midiFXStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const effects = state.tracks[0]?.midiEffects || [];
      return {
        effects,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        promptCount: [...document.querySelectorAll('input')].filter((input) => input.id.startsWith('midi-fx-')).length,
      };
    })()
  `;
}

function midiFXUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      const state = useDAWStore.getState();
      const effects = state.tracks[0]?.midiEffects || [];
      return {
        effects,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function midiProjectPersistenceExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      document.body.innerHTML = '<pre id="qa-root" style="margin:0;padding:16px;width:100vw;height:100vh;overflow:auto;background:#111318;color:#d7dde8;font:12px/1.5 Consolas,monospace">MIDI project persistence QA</pre>';
      document.documentElement.style.width = '100%';
      document.documentElement.style.height = '100%';
      document.body.style.margin = '0';
      document.body.style.width = '100%';
      document.body.style.height = '100%';

      const storeModule = await import('${storeUrl}');
      const bridgeModule = await import('${baseUrl}/src/services/NativeBridge.ts');
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      const { useDAWStore, createDefaultTrack } = storeModule;
      const { nativeBridge } = bridgeModule;
      window.__studio13QADAWStore = useDAWStore;

      const path = 'C:/qa/midi-project-persistence.s13';
      const savedFiles = {};
      const syncPayloads = [];
      const samplerCalls = [];
      const instrumentCalls = [];
      const panicCalls = [];
      const bridgeCallLog = [];
      const ok = async (name, value = true) => {
        bridgeCallLog.push(name);
        return value;
      };

      nativeBridge.showSaveDialog = async () => path;
      nativeBridge.showOpenDialog = async () => path;
      nativeBridge.saveProjectToFile = async (filePath, jsonContent) => {
        savedFiles[filePath] = jsonContent;
        bridgeCallLog.push('saveProjectToFile');
        return true;
      };
      nativeBridge.loadProjectFromFile = async (filePath) => {
        bridgeCallLog.push('loadProjectFromFile');
        return savedFiles[filePath] || '';
      };
      nativeBridge.getTrackInputFX = async () => [];
      nativeBridge.getTrackFX = async () => [];
      nativeBridge.getPluginState = async () => '';
      nativeBridge.getInstrumentState = async () => 'qa-instrument-state';
      nativeBridge.getMasterFX = async () => [];
      nativeBridge.getMasterPluginState = async () => '';
      nativeBridge.addTrack = async (trackId) => ok('addTrack', trackId || 'qa-track');
      nativeBridge.removeTrack = async (trackId) => ok('removeTrack:' + trackId);
      nativeBridge.closeAllPluginWindows = async () => ok('closeAllPluginWindows');
      nativeBridge.setProcessingPrecision = async () => ok('setProcessingPrecision');
      nativeBridge.setTempo = async () => ok('setTempo');
      nativeBridge.setTimeSignature = async () => ok('setTimeSignature');
      nativeBridge.setMetronomeEnabled = async () => ok('setMetronomeEnabled');
      nativeBridge.setMetronomeAccentBeats = async () => ok('setMetronomeAccentBeats');
      nativeBridge.setMetronomeVolume = async () => ok('setMetronomeVolume');
      nativeBridge.setMasterVolume = async () => ok('setMasterVolume');
      nativeBridge.setMasterPan = async () => ok('setMasterPan');
      nativeBridge.setMasterMono = async () => ok('setMasterMono');
      nativeBridge.setTrackType = async () => ok('setTrackType');
      nativeBridge.setTrackVolume = async () => ok('setTrackVolume');
      nativeBridge.setTrackPan = async () => ok('setTrackPan');
      nativeBridge.setTrackMute = async () => ok('setTrackMute');
      nativeBridge.setTrackSolo = async () => ok('setTrackSolo');
      nativeBridge.setTrackRecordArm = async () => ok('setTrackRecordArm');
      nativeBridge.setTrackInputMonitoring = async () => ok('setTrackInputMonitoring');
      nativeBridge.setTrackInputChannels = async () => ok('setTrackInputChannels');
      nativeBridge.openMIDIDevice = async () => ok('openMIDIDevice');
      nativeBridge.setTrackMIDIInput = async () => ok('setTrackMIDIInput');
      nativeBridge.setTrackMIDIOutput = async () => ok('setTrackMIDIOutput');
      nativeBridge.loadInstrument = async (trackId, pluginPath) => {
        instrumentCalls.push({ type: 'load', trackId, pluginPath });
        return true;
      };
      nativeBridge.setInstrumentState = async (trackId, state) => {
        instrumentCalls.push({ type: 'state', trackId, state });
        return true;
      };
      nativeBridge.setTrackSamplerSample = async (trackId, samplePath, rootNote) => {
        samplerCalls.push({ trackId, samplePath, rootNote });
        return true;
      };
      nativeBridge.fileExists = async () => true;
      nativeBridge.getMidiDiagnostics = async () => ({
        inputDevices: [],
        outputDevices: [],
        openDevices: [],
        trackCount: 1,
        midiTrackCount: 0,
        instrumentTrackCount: 1,
        scheduledMIDITrackCount: 0,
        scheduledMIDIClipCount: 0,
        scheduledMIDIEventCount: 0,
        tracks: [{ trackId: 'qa-persist-track', trackType: 'instrument', scheduledMIDIClipCount: 0, scheduledMIDIEventCount: 0 }],
      });
      nativeBridge.panicMIDI = async () => {
        panicCalls.push(true);
        return true;
      };
      nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
        syncPayloads.push({ trackId, clips: JSON.parse(JSON.stringify(clips)) });
        return true;
      };

      const track = createDefaultTrack('qa-persist-track', 'QA Persist Instrument', '#49a7c7', 'instrument');
      Object.assign(track, {
        inputType: 'midi',
        inputStartChannel: 0,
        inputChannelCount: 2,
        volumeDB: -4,
        pan: 0.15,
        armed: true,
        monitorEnabled: true,
        midiInputDevice: 'QA Keyboard',
        midiChannel: 11,
        midiOutputDevice: 'QA MIDI Out',
        midiPitchBendRangeUp: 12,
        midiPitchBendRangeDown: 7,
        midiPitchBendRangeLinked: false,
        instrumentPlugin: 'C:/qa/Synth.vst3',
        samplerSamplePath: 'C:/qa/piano.sf2',
        samplerRootNote: 36,
        samplerSourceType: 'soundfont',
        midiEffects: [
          { id: 'fx-pitch-neutral', type: 'pitch', enabled: true, semitones: 0 },
          { id: 'fx-time-neutral', type: 'time', enabled: true, offsetMs: 0, swing: 0, gridSeconds: 0.25 },
        ],
        clips: [],
        midiClips: [{
          id: 'qa-persist-clip',
          name: 'Persisted Controller Clip',
          startTime: 3,
          duration: 4,
          offset: 0.25,
          sourceStart: 0.5,
          sourceLength: 2,
          loopEnabled: true,
          loopOffset: 0.25,
          loopLength: 2,
          color: '#49a7c7',
          events: [
            { type: 'noteOn', timestamp: 0.1, note: 60, velocity: 92, channel: 11, probability: 0.65, playCount: 3, velocityVariance: 9, centOffset: -14 },
            { type: 'noteOff', timestamp: 0.9, note: 60, velocity: 37, releaseVelocity: 37, channel: 11 },
            { type: 'pitchBend', timestamp: 0.35, value: 12970, channel: 11 },
            { type: 'programChange', timestamp: 0.05, value: 21, channel: 11 },
            { type: 'channelPressure', timestamp: 0.45, value: 84, channel: 11 },
            { type: 'polyPressure', timestamp: 0.55, note: 60, value: 70, channel: 11 },
          ],
          ccEvents: [
            { cc: 0, time: 0.08, value: 4, channel: 11, interpolation: 'step' },
            { cc: 32, time: 0.09, value: 64, channel: 11, interpolation: 'step' },
            { cc: 1, time: 0.2, value: 96, channel: 11, interpolation: 'curve' },
            { cc: 33, time: 0.2, value: 12, channel: 11, interpolation: 'curve' },
            { cc: 74, time: 0.6, value: 35, channel: 11, interpolation: 'parabola' },
          ],
        }],
      });

      useDAWStore.setState({
        projectPath: null,
        projectName: 'QA MIDI Persistence',
        isModified: true,
        tracks: [track],
        transport: { ...useDAWStore.getState().transport, tempo: 132 },
      });

      const saveOK = await useDAWStore.getState().saveProject(true);
      const saved = JSON.parse(savedFiles[path] || '{}');
      const savedTrack = saved.tracks?.[0] || null;
      const savedClip = savedTrack?.midiClips?.[0] || null;

      const loadOK = await useDAWStore.getState().loadProject(path, { bypassFX: false });
      const loadedState = useDAWStore.getState();
      const loadedTrack = loadedState.tracks.find((candidate) => candidate.id === 'qa-persist-track') || null;
      const loadedClip = loadedTrack?.midiClips?.find((candidate) => candidate.id === 'qa-persist-clip') || null;
      const directPayload = loadedTrack
        ? serializationModule.serializeMIDIClipsForBackend(loadedTrack.midiClips || [], loadedTrack.midiEffects || [])
        : [];
      const lastSync = syncPayloads[syncPayloads.length - 1] || null;
      const lastEvents = lastSync?.clips?.[0]?.events || [];
      const loadedEvents = loadedClip?.events || [];
      const loadedCC = loadedClip?.ccEvents || [];
      const checks = {
        savedNoteMetadata: Boolean(savedClip?.events?.some((event) => event.type === 'noteOn' && event.probability === 0.65 && event.playCount === 3 && event.velocityVariance === 9 && event.centOffset === -14)),
        savedReleaseVelocity: Boolean(savedClip?.events?.some((event) => event.type === 'noteOff' && event.releaseVelocity === 37 && event.channel === 11)),
        savedPitchBend: Boolean(savedClip?.events?.some((event) => event.type === 'pitchBend' && event.value === 12970 && event.channel === 11)),
        savedBankSelect: Boolean(savedClip?.ccEvents?.some((event) => event.cc === 0 && event.value === 4 && event.channel === 11) && savedClip?.ccEvents?.some((event) => event.cc === 32 && event.value === 64 && event.channel === 11)),
        savedCC74Parabola: Boolean(savedClip?.ccEvents?.some((event) => event.cc === 74 && event.value === 35 && event.interpolation === 'parabola')),
        loadedNoteMetadata: Boolean(loadedEvents.some((event) => event.type === 'noteOn' && event.probability === 0.65 && event.playCount === 3 && event.velocityVariance === 9 && event.centOffset === -14)),
        loadedReleaseVelocity: Boolean(loadedEvents.some((event) => event.type === 'noteOff' && event.releaseVelocity === 37 && event.channel === 11)),
        loadedPitchBend: Boolean(loadedEvents.some((event) => event.type === 'pitchBend' && event.value === 12970 && event.channel === 11)),
        loadedProgramPressure: Boolean(loadedEvents.some((event) => event.type === 'programChange' && event.value === 21) && loadedEvents.some((event) => event.type === 'channelPressure' && event.value === 84) && loadedEvents.some((event) => event.type === 'polyPressure' && event.note === 60 && event.value === 70)),
        loadedBankSelect: Boolean(loadedCC.some((event) => event.cc === 0 && event.value === 4 && event.channel === 11) && loadedCC.some((event) => event.cc === 32 && event.value === 64 && event.channel === 11)),
        loadedCC74Parabola: Boolean(loadedCC.some((event) => event.cc === 74 && event.value === 35 && event.interpolation === 'parabola')),
        loadedRanges: Boolean(loadedTrack?.midiPitchBendRangeUp === 12 && loadedTrack?.midiPitchBendRangeDown === 7 && loadedTrack?.midiPitchBendRangeLinked === false),
        loadedSampler: Boolean(loadedTrack?.samplerSamplePath === 'C:/qa/piano.sf2' && loadedTrack?.samplerRootNote === 36 && loadedTrack?.samplerSourceType === 'soundfont'),
        loadedEffects: Boolean(loadedTrack?.midiEffects?.some((effect) => effect.id === 'fx-pitch-neutral' && effect.enabled === true && effect.semitones === 0)),
        backendPitchBend: Boolean(lastEvents.some((event) => event.type === 'pitchBend' && event.value === 12970 && event.channel === 11)),
        backendCC74: Boolean(lastEvents.some((event) => event.type === 'cc' && event.controller === 74 && event.value === 35 && event.channel === 11)),
        backendBankSelect: Boolean(lastEvents.some((event) => event.type === 'cc' && event.controller === 0 && event.value === 4 && event.channel === 11) && lastEvents.some((event) => event.type === 'cc' && event.controller === 32 && event.value === 64 && event.channel === 11)),
        backendNoteMetadata: Boolean(lastEvents.some((event) => event.type === 'noteOn' && event.probability === 0.65 && event.velocityVariance === 9 && event.playCount === 3 && event.centOffset === -14)),
        backendReleaseVelocity: Boolean(lastEvents.some((event) => event.type === 'noteOff' && event.releaseVelocity === 37 && event.channel === 11)),
        backendProgramPressure: Boolean(lastEvents.some((event) => event.type === 'programChange' && event.value === 21) && lastEvents.some((event) => event.type === 'channelPressure' && event.value === 84) && lastEvents.some((event) => event.type === 'polyPressure' && event.note === 60 && event.value === 70)),
        directMatchesLastSync: JSON.stringify(directPayload) === JSON.stringify(lastSync?.clips || []),
        repairedMIDIBackend: syncPayloads.length >= 2 && panicCalls.length >= 1,
        samplerRestored: samplerCalls.some((call) => call.trackId === 'qa-persist-track' && call.samplePath === 'C:/qa/piano.sf2' && call.rootNote === 36),
        instrumentStateRestored: instrumentCalls.some((call) => call.type === 'state' && call.trackId === 'qa-persist-track' && call.state === 'qa-instrument-state'),
      };
      const summary = {
        saveOK,
        loadOK,
        savedJsonBytes: savedFiles[path]?.length || 0,
        savedTrack: savedTrack && {
          id: savedTrack.id,
          type: savedTrack.type,
          midiEffects: savedTrack.midiEffects,
          midiInputDevice: savedTrack.midiInputDevice,
          midiOutputDevice: savedTrack.midiOutputDevice,
          midiPitchBendRangeUp: savedTrack.midiPitchBendRangeUp,
          midiPitchBendRangeDown: savedTrack.midiPitchBendRangeDown,
          midiPitchBendRangeLinked: savedTrack.midiPitchBendRangeLinked,
          samplerSamplePath: savedTrack.samplerSamplePath,
          samplerRootNote: savedTrack.samplerRootNote,
          samplerSourceType: savedTrack.samplerSourceType,
          instrumentState: savedTrack.instrumentState,
        },
        savedClip,
        loadedTrack: loadedTrack && {
          id: loadedTrack.id,
          type: loadedTrack.type,
          midiEffects: loadedTrack.midiEffects,
          midiInputDevice: loadedTrack.midiInputDevice,
          midiOutputDevice: loadedTrack.midiOutputDevice,
          midiPitchBendRangeUp: loadedTrack.midiPitchBendRangeUp,
          midiPitchBendRangeDown: loadedTrack.midiPitchBendRangeDown,
          midiPitchBendRangeLinked: loadedTrack.midiPitchBendRangeLinked,
          samplerSamplePath: loadedTrack.samplerSamplePath,
          samplerRootNote: loadedTrack.samplerRootNote,
          samplerSourceType: loadedTrack.samplerSourceType,
        },
        loadedClip,
        syncPayloadCount: syncPayloads.length,
        lastSync,
        directPayload,
        samplerCalls,
        instrumentCalls,
        panicCount: panicCalls.length,
        bridgeCallLog,
        checks,
      };

      document.getElementById('qa-root').textContent = JSON.stringify({
        scenario: 'midi-project-persistence',
        saveOK,
        loadOK,
        syncPayloadCount: syncPayloads.length,
        checks,
      }, null, 2);

      return summary;
    })()
  `;
}

function midiExportPayloadExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      document.body.innerHTML = '<pre id="qa-root" style="margin:0;padding:16px;width:100vw;height:100vh;overflow:auto;background:#111318;color:#d7dde8;font:12px/1.5 Consolas,monospace">MIDI export payload QA</pre>';
      document.documentElement.style.width = '100%';
      document.documentElement.style.height = '100%';
      document.body.style.margin = '0';
      document.body.style.width = '100%';
      document.body.style.height = '100%';

      const storeModule = await import('${storeUrl}');
      const bridgeModule = await import('${baseUrl}/src/services/NativeBridge.ts');
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      const { useDAWStore, createDefaultTrack } = storeModule;
      const { nativeBridge } = bridgeModule;
      window.__studio13QADAWStore = useDAWStore;

      const exportCalls = [];
      const filePath = 'C:/qa/midi-export-payload.mid';
      nativeBridge.showSaveDialog = async () => filePath;
      nativeBridge.exportProjectMIDI = async (path, midiTracks) => {
        exportCalls.push({ path, midiTracks: JSON.parse(JSON.stringify(midiTracks)) });
        return true;
      };

      const track = createDefaultTrack('qa-midi-export-track', 'QA MIDI Export', '#49a7c7', 'instrument');
      track.midiEffects = [
        { id: 'export-pitch', type: 'pitch', enabled: true, semitones: 2 },
        { id: 'export-velocity', type: 'velocity', enabled: true, scale: 1.1, offset: -3 },
      ];
      track.midiClips = [{
        id: 'qa-midi-export-clip',
        name: 'Export Fixture Clip',
        startTime: 2,
        duration: 1.5,
        offset: 0,
        sourceStart: 0,
        sourceLength: 1.5,
        loopEnabled: false,
        color: '#49a7c7',
        events: [
          { type: 'programChange', timestamp: 0.02, value: 8, channel: 4 },
          { type: 'noteOn', timestamp: 0.1, note: 60, velocity: 90, channel: 4, probability: 1 },
          { type: 'noteOff', timestamp: 0.8, note: 60, releaseVelocity: 45, channel: 4 },
          { type: 'noteOn', timestamp: 0.2, note: 67, velocity: 90, channel: 4, probability: 0 },
          { type: 'noteOff', timestamp: 0.5, note: 67, channel: 4 },
          { type: 'pitchBend', timestamp: 0.3, value: 12345, channel: 4 },
          { type: 'channelPressure', timestamp: 0.4, value: 77, channel: 4 },
          { type: 'polyPressure', timestamp: 0.45, note: 60, value: 66, channel: 4 },
        ],
        ccEvents: [
          { cc: 0, time: 0.04, value: 3, channel: 4 },
          { cc: 32, time: 0.05, value: 45, channel: 4 },
          { cc: 1, time: 0.25, value: 96, channel: 4 },
          { cc: 33, time: 0.25, value: 12, channel: 4 },
          { cc: 74, time: 0.65, value: 44, channel: 4 },
        ],
      }];

      useDAWStore.setState({
        tracks: [track],
        selectedTrackId: track.id,
        selectedTrackIds: [track.id],
      });

      const exportOK = await useDAWStore.getState().exportProjectMIDI();
      const direct = serializationModule.serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []);
      const directExportShape = direct.map((clip) => ({
        startTime: clip.startTime,
        duration: clip.duration,
        events: clip.events,
      }));
      const call = exportCalls[0] || null;
      const exportedClip = call?.midiTracks?.[0]?.clips?.[0] || null;
      const exportedEvents = exportedClip?.events || [];
      const checks = {
        exportOK,
        filePath: call?.path === filePath,
        directMatchesExport: JSON.stringify(directExportShape) === JSON.stringify(call?.midiTracks?.[0]?.clips || []),
        pitchAndVelocityApplied: Boolean(exportedEvents.some((event) => event.type === 'noteOn' && event.note === 62 && event.velocity === 96 && event.channel === 4)),
        probabilityZeroDropped: !exportedEvents.some((event) => event.note === 69 || event.note === 67),
        releaseVelocityExported: Boolean(exportedEvents.some((event) => event.type === 'noteOff' && event.note === 62 && event.releaseVelocity === 45 && event.channel === 4)),
        pitchBendExported: Boolean(exportedEvents.some((event) => event.type === 'pitchBend' && event.value === 12345 && event.channel === 4)),
        pressureExported: Boolean(exportedEvents.some((event) => event.type === 'channelPressure' && event.value === 77 && event.channel === 4) && exportedEvents.some((event) => event.type === 'polyPressure' && event.note === 62 && event.value === 66 && event.channel === 4)),
        ccExported: Boolean(exportedEvents.some((event) => event.type === 'cc' && event.controller === 1 && event.value === 96 && event.channel === 4) && exportedEvents.some((event) => event.type === 'cc' && event.controller === 33 && event.value === 12 && event.channel === 4) && exportedEvents.some((event) => event.type === 'cc' && event.controller === 74 && event.value === 44 && event.channel === 4)),
        bankSelectExported: Boolean(exportedEvents.some((event) => event.type === 'cc' && event.controller === 0 && event.value === 3 && event.channel === 4) && exportedEvents.some((event) => event.type === 'cc' && event.controller === 32 && event.value === 45 && event.channel === 4)),
        programExported: Boolean(exportedEvents.some((event) => event.type === 'programChange' && event.value === 8 && event.channel === 4)),
      };

      const summary = { exportOK, exportCalls, direct, checks };
      document.getElementById('qa-root').textContent = JSON.stringify({
        scenario: 'midi-export-payload',
        checks,
        eventCount: exportedEvents.length,
      }, null, 2);
      return summary;
    })()
  `;
}

async function setInputValue(cdp, selector, value) {
  const applied = await evalInPage(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor.set.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!applied) throw new Error(`Could not find input ${selector}`);
  await sleep(120);
}

async function setSelectValue(cdp, selector, value) {
  const applied = await evalInPage(cdp, `
    (() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return false;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      descriptor.set.call(select, ${JSON.stringify(String(value))});
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!applied) throw new Error(`Could not find select ${selector}`);
  await sleep(160);
}

async function setCheckboxValue(cdp, selector, checked) {
  const applied = await evalInPage(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input || input.type !== 'checkbox') return false;
      const wanted = ${checked ? "true" : "false"};
      if (input.checked !== wanted) {
        input.click();
      }
      return true;
    })()
  `);
  if (!applied) throw new Error(`Could not find checkbox ${selector}`);
  await sleep(160);
}

async function clickInspectorButton(cdp, label) {
  const result = await evalInPage(cdp, `
    (() => {
      const wanted = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('.piano-roll-inspector button')];
      const button = buttons.find((candidate) => normalize(candidate.textContent).includes(wanted));
      if (!button) return { clicked: false, reason: 'missing' };
      if (button.disabled) return { clicked: false, reason: 'disabled', text: normalize(button.textContent) };
      button.click();
      return { clicked: true, text: normalize(button.textContent) };
    })()
  `);
  if (!result?.clicked) {
    throw new Error(`Could not click inspector button ${label}: ${JSON.stringify(result)}`);
  }
  await sleep(180);
}

async function clickButtonByText(cdp, label) {
  const result = await evalInPage(cdp, `
    (() => {
      const wanted = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => normalize(candidate.textContent) === wanted || normalize(candidate.textContent).includes(wanted));
      if (!button) return { clicked: false, reason: 'missing' };
      if (button.disabled) return { clicked: false, reason: 'disabled', text: normalize(button.textContent) };
      button.click();
      return { clicked: true, text: normalize(button.textContent) };
    })()
  `);
  if (!result?.clicked) {
    throw new Error(`Could not click button ${label}: ${JSON.stringify(result)}`);
  }
  await sleep(180);
}

async function removeLaneByLabel(cdp, label) {
  const result = await evalInPage(cdp, `
    (() => {
      const wanted = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const row = [...document.querySelectorAll('.piano-roll-lane-row')]
        .find((candidate) => normalize(candidate.textContent).includes(wanted));
      if (!row) return { removed: false, reason: 'missing-row' };
      const remove = row.querySelector('.piano-roll-lane-remove');
      if (!remove) return { removed: false, reason: 'missing-remove' };
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: remove.getBoundingClientRect().left + 4, clientY: remove.getBoundingClientRect().top + 4 }));
      return { removed: true, text: normalize(row.textContent) };
    })()
  `);
  if (!result?.removed) {
    throw new Error(`Could not remove lane ${label}: ${JSON.stringify(result)}`);
  }
  await sleep(180);
}

async function clickLaneByLabel(cdp, label) {
  const result = await evalInPage(cdp, `
    (() => {
      const wanted = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const row = [...document.querySelectorAll('.piano-roll-lane-row')]
        .find((candidate) => normalize(candidate.textContent).includes(wanted));
      if (!row) return { clicked: false, reason: 'missing-row' };
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + 12, clientY: rect.top + rect.height / 2 }));
      row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + 12, clientY: rect.top + rect.height / 2 }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 12, clientY: rect.top + rect.height / 2 }));
      return { clicked: true, text: normalize(row.textContent) };
    })()
  `);
  if (!result?.clicked) {
    throw new Error(`Could not click lane ${label}: ${JSON.stringify(result)}`);
  }
  await sleep(220);
}

async function configureLaneRow(cdp, label, config) {
  const result = await evalInPage(cdp, `
    (() => {
      const wanted = ${JSON.stringify(label)};
      const config = ${JSON.stringify(config)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const row = [...document.querySelectorAll('.piano-roll-lane-row')]
        .find((candidate) => normalize(candidate.textContent).includes(wanted));
      if (!row) return { configured: false, reason: 'missing-row' };
      const setInput = (input, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        descriptor.set.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setSelect = (select, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        descriptor.set.call(select, String(value));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (config.height != null) {
        const range = row.querySelector('input[type="range"]');
        if (!range) return { configured: false, reason: 'missing-height' };
        setInput(range, config.height);
      }
      if (config.interpolation) {
        const select = row.querySelector('select');
        if (!select) return { configured: false, reason: 'missing-interpolation' };
        setSelect(select, config.interpolation);
      }
      return { configured: true, text: normalize(row.textContent) };
    })()
  `);
  if (!result?.configured) {
    throw new Error(`Could not configure lane ${label}: ${JSON.stringify(result)}`);
  }
  await sleep(180);
}

async function submitControllerDialog(cdp, config) {
  const result = await evalInPage(cdp, `
    (async () => {
      const config = ${JSON.stringify(config)};
      const dialog = document.querySelector('.piano-roll-controller-dialog');
      if (!dialog) return { submitted: false, reason: 'missing-dialog' };
      const setInput = (input, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        descriptor.set.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setSelect = (select, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        descriptor.set.call(select, String(value));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (config.type === 'line') {
        const select = dialog.querySelector('select');
        if (select && config.interpolation) {
          setSelect(select, config.interpolation);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const inputs = [...dialog.querySelectorAll('input[type="number"]')];
        let index = 0;
        if (config.interpolation === 'curve') {
          if (!inputs[index]) return { submitted: false, reason: 'missing-curve-input' };
          setInput(inputs[index], config.curve ?? 0.5);
          index += 1;
        }
        if (!inputs[index] || !inputs[index + 1]) return { submitted: false, reason: 'missing-line-inputs', inputCount: inputs.length };
        setInput(inputs[index], config.startValue);
        setInput(inputs[index + 1], config.endValue);
      } else if (config.type === 'lfo') {
        const inputs = [...dialog.querySelectorAll('input[type="number"]')];
        if (inputs.length < 3) return { submitted: false, reason: 'missing-lfo-inputs', inputCount: inputs.length };
        setInput(inputs[0], config.rateHz);
        setInput(inputs[1], config.centerValue);
        setInput(inputs[2], config.depth);
      } else if (config.type === 'thin') {
        const input = dialog.querySelector('input[type="number"]');
        if (!input) return { submitted: false, reason: 'missing-thin-input' };
        setInput(input, config.tolerance);
      } else if (config.type === 'transform') {
        const inputs = [...dialog.querySelectorAll('input[type="number"]')];
        if (inputs.length < 4) return { submitted: false, reason: 'missing-transform-inputs', inputCount: inputs.length };
        setInput(inputs[0], config.timeScalePercent);
        setInput(inputs[1], config.valueScalePercent);
        setInput(inputs[2], config.valueOffset);
        setInput(inputs[3], config.tilt);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const apply = [...dialog.querySelectorAll('button')].find((button) => normalize(button.textContent).includes('Apply'));
      if (!apply) return { submitted: false, reason: 'missing-apply' };
      apply.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { submitted: true };
    })()
  `);
  if (!result?.submitted) {
    throw new Error(`Could not submit controller dialog: ${JSON.stringify(result)}`);
  }
  await sleep(220);
}

async function keyPress(cdp, key, options = {}) {
  const definitions = {
    b: { key: "b", code: "KeyB", vk: 66 },
    d: { key: "d", code: "KeyD", vk: 68 },
    x: { key: "x", code: "KeyX", vk: 88 },
    y: { key: "y", code: "KeyY", vk: 89 },
    z: { key: "z", code: "KeyZ", vk: 90 },
    Delete: { key: "Delete", code: "Delete", vk: 46 },
  };
  const def = definitions[key];
  if (!def) throw new Error(`Unsupported key in harness: ${key}`);
  const event = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
    modifiers: options.modifiers ?? 0,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await sleep(options.settleMs ?? 250);
}

async function runAppShortcuts(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 1280, 760);
  try {
    const before = await evalInPage(cdp, appShortcutFixtureExpression(storeUrl));
    if (Math.abs(before.sourceLength - 2.5) > 0.0001 || !before.canUndo) {
      throw new Error(`App shortcut fixture did not create undoable MIDI edit: ${JSON.stringify(before)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "app-shortcuts-before-undo.png");
    await keyPress(cdp, "z", { modifiers: 2, settleMs: 350 });
    const afterUndo = await evalInPage(cdp, appShortcutStateExpression(storeUrl));
    if (Math.abs(afterUndo.sourceLength - 1) > 0.0001 || !afterUndo.canRedo) {
      throw new Error(`App Ctrl+Z undo failed: ${JSON.stringify({ before, afterUndo })}`);
    }
    const undoShot = await screenshot(cdp, args.outDir, "app-shortcuts-after-ctrl-z.png");
    await keyPress(cdp, "y", { modifiers: 2, settleMs: 350 });
    const afterRedo = await evalInPage(cdp, appShortcutStateExpression(storeUrl));
    if (Math.abs(afterRedo.sourceLength - 2.5) > 0.0001 || !afterRedo.canUndo) {
      throw new Error(`App Ctrl+Y redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
    }
    const redoShot = await screenshot(cdp, args.outDir, "app-shortcuts-after-ctrl-y.png");

    return {
      scenario: "app-shortcuts",
      status: "passed",
      before,
      afterUndo,
      afterRedo,
      screenshots: [beforeShot, undoShot, redoShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runAppDockedPianoFocus(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 1280, 860);
  try {
    const before = await evalInPage(cdp, appDockedPianoFixtureExpression(args.baseUrl, storeUrl));
    if (
      !before.hasDockedPianoRoll
      || before.pianoRollClipId !== "qa-dock-clip-a"
      || before.activeSelectValue !== "qa-dock-clip-a"
      || before.dockedTitle !== "Docked MIDI - Dock Clip A"
      || !before.hasPopOutButton
      || before.midiEditorSessions.length !== 1
      || before.midiEditorSessions[0]?.mode !== "docked"
      || before.selectedClipIds.length !== 2
      || !before.secondClipClick
      || !before.timelineRect
      || !before.dockRect
      || !before.pianoCanvasRect
      || !before.resizeHandleRect
      || !before.pianoSidebarWidthMatchesTcp
      || !before.pianoCanvasStartsUnderTimeline
      || before.timelineRect.bottom > before.dockRect.top + 2
    ) {
      throw new Error(`Docked Piano Roll fixture did not expose a clickable timeline and active editor: ${JSON.stringify(before)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "app-docked-piano-focus-before.png");

    await click(cdp, before.secondClipClick.x, before.secondClipClick.y, { settleMs: 500 });
    const afterSecond = await evalInPage(cdp, appDockedPianoStateExpression());
    const selectedAfterSecond = new Set(afterSecond.selectedClipIds);
    const afterSecondWindowed = afterSecond.midiEditorSessions.find((session) => session.clipId === "qa-dock-clip-b");
    if (
      afterSecond.pianoRollClipId !== "qa-dock-clip-a"
      || afterSecond.activeSelectValue !== "qa-dock-clip-a"
      || afterSecond.midiEditorSessions.length !== 2
      || !afterSecondWindowed
      || afterSecondWindowed.mode !== "windowed"
      || !afterSecond.midiWindowCalls.open.some((call) => call.sessionId === afterSecondWindowed.sessionId)
      || !selectedAfterSecond.has("qa-dock-clip-a")
      || !selectedAfterSecond.has("qa-dock-clip-b")
      || selectedAfterSecond.size !== 2
      || !afterSecond.hasDockedPianoRoll
    ) {
      throw new Error(`Clicking a second selected arrange MIDI item did not open a windowed MIDI editor session: ${JSON.stringify({ before, afterSecond })}`);
    }
    const secondShot = await screenshot(cdp, args.outDir, "app-docked-piano-focus-after-second.png");

    await click(cdp, afterSecond.firstClipClick.x, afterSecond.firstClipClick.y, { settleMs: 500 });
    const afterFirst = await evalInPage(cdp, appDockedPianoStateExpression());
    const selectedAfterFirst = new Set(afterFirst.selectedClipIds);
    if (
      afterFirst.pianoRollClipId !== "qa-dock-clip-a"
      || afterFirst.activeSelectValue !== "qa-dock-clip-a"
      || afterFirst.midiEditorSessions.length !== 2
      || afterFirst.dockedTitle !== "Docked MIDI - Dock Clip A"
      || !selectedAfterFirst.has("qa-dock-clip-a")
      || !selectedAfterFirst.has("qa-dock-clip-b")
      || selectedAfterFirst.size !== 2
      || !afterFirst.hasDockedPianoRoll
    ) {
      throw new Error(`Clicking back to the first selected MIDI item did not preserve docked focus: ${JSON.stringify({ afterSecond, afterFirst })}`);
    }
    const firstShot = await screenshot(cdp, args.outDir, "app-docked-piano-focus-after-first.png");

    await evalInPage(cdp, `
      (() => {
        const useDAWStore = window.__studio13QADAWStore;
        useDAWStore.getState().setLowerZoneHeight(${Math.round(afterFirst.dockRect.height + 110)});
        return true;
      })()
    `);
    await sleep(500);
    const afterResize = await evalInPage(cdp, appDockedPianoStateExpression());
    if (
      !afterResize.pianoCanvasRect
      || afterResize.pianoCanvasRect.height <= afterFirst.pianoCanvasRect.height + 40
      || !afterResize.pianoSidebarWidthMatchesTcp
      || !afterResize.pianoCanvasStartsUnderTimeline
    ) {
      throw new Error(`Resizing docked Piano Roll did not resize aligned canvas/sidebar: ${JSON.stringify({ afterFirst, afterResize })}`);
    }
    const resizeShot = await screenshot(cdp, args.outDir, "app-docked-piano-focus-after-resize.png");

    return {
      scenario: "app-docked-piano-focus",
      status: "passed",
      before,
      afterSecond,
      afterFirst,
      afterResize,
      screenshots: [beforeShot, secondShot, firstShot, resizeShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runAppMidiMultiSession(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 1360, 900);
  try {
    const before = await evalInPage(cdp, appDockedPianoFixtureExpression(args.baseUrl, storeUrl));
    if (
      !before.hasDockedPianoRoll
      || before.midiEditorSessions.length !== 1
      || before.midiEditorSessions[0]?.mode !== "docked"
      || before.dockedTitle !== "Docked MIDI - Dock Clip A"
      || !before.rulerRect
      || !before.rulerPlayheadRect
      || !before.keyViewportRect
      || !before.popOutButtonRect
      || before.midiWindowCalls.prewarm.length > 1
    ) {
      throw new Error(`Multi-session fixture did not render docked MIDI editor: ${JSON.stringify(before)}`);
    }

    const beforeShot = await screenshot(cdp, args.outDir, "app-midi-multi-session-before.png");

    await evalInPage(cdp, `
      (() => {
        const useDAWStore = window.__studio13QADAWStore;
        useDAWStore.getState().setCurrentTime(1.25);
        return true;
      })()
    `);
    await sleep(180);
    const afterPlayhead = await evalInPage(cdp, appDockedPianoStateExpression());
    const expectedPlayheadCenter = afterPlayhead.rulerRect.left
      + (afterPlayhead.transportCurrentTime * afterPlayhead.pixelsPerSecond)
      - afterPlayhead.scrollX;
    const actualPlayheadCenter = afterPlayhead.rulerPlayheadRect.left + (afterPlayhead.rulerPlayheadRect.width / 2);
    if (Math.abs(expectedPlayheadCenter - actualPlayheadCenter) > 2) {
      throw new Error(`MIDI ruler playhead is not aligned to project time: ${JSON.stringify({ afterPlayhead, expectedPlayheadCenter, actualPlayheadCenter })}`);
    }

    const seekTarget = 1.75;
    await click(
      cdp,
      afterPlayhead.rulerRect.left + (seekTarget * afterPlayhead.pixelsPerSecond) - afterPlayhead.scrollX,
      afterPlayhead.rulerRect.top + afterPlayhead.rulerRect.height / 2,
      { settleMs: 450 },
    );
    const afterRulerClick = await evalInPage(cdp, appDockedPianoStateExpression());
    if (Math.abs(afterRulerClick.transportCurrentTime - seekTarget) > 0.03) {
      throw new Error(`Clicking MIDI ruler did not seek transport playhead: ${JSON.stringify({ afterRulerClick, seekTarget })}`);
    }

    await drag(
      cdp,
      afterRulerClick.keyViewportRect.left + afterRulerClick.keyViewportRect.width * 0.82,
      afterRulerClick.keyViewportRect.top + 24,
      afterRulerClick.keyViewportRect.left + afterRulerClick.keyViewportRect.width * 0.82,
      afterRulerClick.keyViewportRect.top + 150,
      { steps: 12, settleMs: 500 },
    );
    const afterKeyDrag = await evalInPage(cdp, appDockedPianoStateExpression());
    const noteOnEvents = afterKeyDrag.notePreviewEvents.filter((event) => event.isNoteOn && event.velocity > 0);
    const noteOffEvents = afterKeyDrag.notePreviewEvents.filter((event) => !event.isNoteOn || event.velocity === 0);
    const distinctNotes = new Set(noteOnEvents.map((event) => event.note));
    if (distinctNotes.size < 3 || noteOffEvents.length < 1) {
      throw new Error(`Dragging across piano keys did not audition crossed notes with cleanup: ${JSON.stringify({ events: afterKeyDrag.notePreviewEvents })}`);
    }

    await click(cdp, afterKeyDrag.secondClipClick.x, afterKeyDrag.secondClipClick.y, { settleMs: 650 });
    const afterSecondClip = await evalInPage(cdp, appDockedPianoStateExpression());
    const secondSession = afterSecondClip.midiEditorSessions.find((session) => session.clipId === "qa-dock-clip-b");
    if (
      afterSecondClip.pianoRollClipId !== "qa-dock-clip-a"
      || !secondSession
      || secondSession.mode !== "windowed"
      || !afterSecondClip.midiWindowCalls.open.some((call) => call.sessionId === secondSession.sessionId)
      || !afterSecondClip.midiWindowCalls.publish.some((call) => call.sessionId === secondSession.sessionId)
      || afterSecondClip.midiWindowCalls.prewarm.filter((call) => call.sessionId !== before.dockedMidiEditorSessionId).length > 0
    ) {
      throw new Error(`Opening a second MIDI clip did not create a lightweight windowed session: ${JSON.stringify(afterSecondClip)}`);
    }

    await click(
      cdp,
      afterSecondClip.popOutButtonRect.left + afterSecondClip.popOutButtonRect.width / 2,
      afterSecondClip.popOutButtonRect.top + afterSecondClip.popOutButtonRect.height / 2,
      { settleMs: 650 },
    );
    const afterPopOut = await evalInPage(cdp, appDockedPianoStateExpression());
    const firstSession = afterPopOut.midiEditorSessions.find((session) => session.clipId === "qa-dock-clip-a");
    if (
      afterPopOut.hasDockedPianoRoll
      || !firstSession
      || firstSession.mode !== "windowed"
      || !afterPopOut.midiWindowCalls.open.some((call) => call.sessionId === firstSession.sessionId)
    ) {
      throw new Error(`Pop Out did not move the docked MIDI editor session to a window: ${JSON.stringify(afterPopOut)}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "app-midi-multi-session-after.png");

    return {
      scenario: "app-midi-multi-session",
      status: "passed",
      before,
      afterPlayhead,
      afterRulerClick,
      afterKeyDrag: {
        distinctAuditionedNotes: [...distinctNotes],
        noteOffEvents: noteOffEvents.length,
      },
      afterSecondClip,
      afterPopOut,
      screenshots: [beforeShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runAppMidiRecordingVisibility(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const bridgeUrl = new URL("/src/services/NativeBridge.ts", args.baseUrl).href;
  const cdp = await openTab(args, 1280, 760);
  try {
    const result = await evalInPage(cdp, `
      (async () => {
        const storeModule = await import('${storeUrl}');
        const bridgeModule = await import('${bridgeUrl}');
        const { useDAWStore, createDefaultTrack } = storeModule;
        const { nativeBridge } = bridgeModule;
        window.__studio13QADAWStore = useDAWStore;

        const calls = [];
        nativeBridge.getMIDIInputDevices = async () => ['QA MIDI Keyboard'];
        nativeBridge.getOpenMIDIDevices = async () => [];
        nativeBridge.openMIDIDevice = async (deviceName) => {
          calls.push({ method: 'openMIDIDevice', deviceName });
          return true;
        };
        nativeBridge.addTrack = async (trackId, initialType) => {
          calls.push({ method: 'addTrack', trackId, initialType });
          return trackId || 'qa-created-track';
        };
        nativeBridge.setTrackType = async (trackId, type) => {
          calls.push({ method: 'setTrackType', trackId, type });
          return true;
        };
        nativeBridge.setTrackRecordArm = async (trackId, armed) => {
          calls.push({ method: 'setTrackRecordArm', trackId, armed });
          return true;
        };
        nativeBridge.setTrackInputMonitoring = async (trackId, enabled) => {
          calls.push({ method: 'setTrackInputMonitoring', trackId, enabled });
          return true;
        };
        nativeBridge.setTrackInputChannels = async (trackId, startChannel, count) => {
          calls.push({ method: 'setTrackInputChannels', trackId, startChannel, count });
          return true;
        };
        nativeBridge.setTrackMIDIInput = async (trackId, deviceName, channel) => {
          calls.push({ method: 'setTrackMIDIInput', trackId, deviceName, channel });
          return true;
        };
        nativeBridge.setTransportPlaying = async (playing) => {
          calls.push({ method: 'setTransportPlaying', playing });
          return true;
        };
        nativeBridge.setTransportRecording = async (recording) => {
          calls.push({ method: 'setTransportRecording', recording });
          return true;
        };
        nativeBridge.setTransportPosition = async (seconds) => {
          calls.push({ method: 'setTransportPosition', seconds });
          return true;
        };
        nativeBridge.setPunchRange = async (startTime, endTime, enabled) => {
          calls.push({ method: 'setPunchRange', startTime, endTime, enabled });
          return true;
        };
        nativeBridge.getAudioDebugSnapshot = async () => ({
          transportPlaying: false,
          transportRecording: false,
          transportPosition: 0,
          sampleRate: 44100,
          blockSize: 512,
          playbackClipCount: 0,
          activeOutputChannels: 2,
          lastAudioCallbackProcessMs: 0,
          maxAudioCallbackProcessMs: 0,
          audioCallbackDeadlineMissCount: 0,
          audioCallbackTrackBufferResizeCount: 0,
          audioCallbackPitchScrubBufferResizeCount: 0,
          audioCallbackSidechainBufferResizeCount: 0,
          spectrumFftPublishCount: 0,
          spectrumFftLockMissCount: 0,
          postTrackPlaybackPeak: 0,
        });
        nativeBridge.getLastCompletedClips = async () => [];
        nativeBridge.getLastCompletedMIDIClips = async () => [{
          trackId: 'qa-midi-record-track',
          startTime: 2,
          duration: 1.25,
          events: [
            { timestamp: 0, type: 'noteOn', note: 60, velocity: 96 },
            { timestamp: 0.5, type: 'noteOff', note: 60, velocity: 0 },
            { timestamp: 0.75, type: 'noteOn', note: 64, velocity: 88 },
            { timestamp: 1.2, type: 'noteOff', note: 64, velocity: 0 },
          ],
        }];
        nativeBridge.clearPlaybackClips = async () => true;
        nativeBridge.addPlaybackClipsBatch = async () => true;
        nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
          calls.push({ method: 'setTrackMIDIClips', trackId, clipCount: clips.length });
          return true;
        };
        nativeBridge.setAutomationPoints = async () => true;
        nativeBridge.setAutomationMode = async () => true;
        nativeBridge.clearTempoMarkers = async () => true;

        const track = createDefaultTrack('qa-midi-record-track', 'QA MIDI Record', '#49a7c7', 'midi');
        track.armed = true;
        track.midiInputDevice = '';
        track.midiClips = [];
        track.clips = [];

        useDAWStore.setState({
          tracks: [track],
          selectedTrackId: track.id,
          selectedTrackIds: [track.id],
          selectedClipIds: [],
          selectedClipId: null,
          transport: {
            ...useDAWStore.getState().transport,
            isPlaying: false,
            isPaused: false,
            isRecording: false,
            currentTime: 2,
            punchEnabled: false,
            punchStart: 0,
            punchEnd: 0,
          },
          playStartPosition: 2,
          recordingClips: [],
          recordingMIDIPreviews: {},
          midiInputQuantizeEnabled: false,
          pixelsPerSecond: 120,
          scrollX: 0,
          scrollY: 0,
          timeSelection: null,
          tempoMarkers: [],
          masterAutomationLanes: [],
          showPianoRoll: false,
          showPitchEditor: false,
          showGettingStarted: false,
        });

        await new Promise((resolve) => setTimeout(resolve, 250));
        await useDAWStore.getState().record();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const duringState = useDAWStore.getState();
        const during = {
          isRecording: duringState.transport.isRecording,
          recordingClips: duringState.recordingClips,
          midiClipCount: duringState.tracks[0].midiClips.length,
        };

        useDAWStore.setState((state) => ({
          transport: {
            ...state.transport,
            currentTime: 3.25,
          },
        }));
        await useDAWStore.getState().stop();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const afterState = useDAWStore.getState();
        const afterTrack = afterState.tracks.find((candidate) => candidate.id === 'qa-midi-record-track');
        const canvasRect = document.querySelector('canvas')?.getBoundingClientRect();
        return {
          during,
          after: {
            isRecording: afterState.transport.isRecording,
            recordingClips: afterState.recordingClips,
            midiClipCount: afterTrack?.midiClips.length ?? 0,
            midiClip: afterTrack?.midiClips[0] ?? null,
            canvasRect: canvasRect ? {
              left: canvasRect.left,
              top: canvasRect.top,
              width: canvasRect.width,
              height: canvasRect.height,
            } : null,
          },
          calls,
        };
      })()
    `);

    if (
      !result.during.isRecording
      || result.during.recordingClips.length !== 1
      || result.during.recordingClips[0]?.trackId !== "qa-midi-record-track"
      || Math.abs(result.during.recordingClips[0]?.startTime - 2) > 0.001
      || result.during.midiClipCount !== 0
    ) {
      throw new Error(`MIDI recording did not create the live timeline recording state: ${JSON.stringify(result)}`);
    }

    if (
      result.after.isRecording
      || result.after.recordingClips.length !== 0
      || result.after.midiClipCount !== 1
      || result.after.midiClip?.name !== "MIDI Recording"
      || Math.abs(result.after.midiClip?.startTime - 2) > 0.001
      || Math.abs(result.after.midiClip?.duration - 1.25) > 0.001
      || result.after.midiClip?.events?.length !== 4
      || !result.calls.some((call) => call.method === "addTrack" && call.trackId === "qa-midi-record-track" && call.initialType === "midi")
      || !result.calls.some((call) => call.method === "setTrackType" && call.trackId === "qa-midi-record-track" && call.type === "midi")
      || !result.calls.some((call) => call.method === "setTrackRecordArm" && call.trackId === "qa-midi-record-track" && call.armed === true)
      || !result.calls.some((call) => call.method === "setTrackMIDIInput" && call.trackId === "qa-midi-record-track" && call.deviceName === "" && call.channel === 0)
      || !result.calls.some((call) => call.method === "openMIDIDevice" && call.deviceName === "QA MIDI Keyboard")
      || !result.calls.some((call) => call.method === "setTransportRecording" && call.recording === true)
      || !result.calls.some((call) => call.method === "setTransportRecording" && call.recording === false)
    ) {
      throw new Error(`MIDI recording stop did not append the completed timeline clip: ${JSON.stringify(result)}`);
    }

    const shot = await screenshot(cdp, args.outDir, "app-midi-recording-visibility.png");

    return {
      scenario: "app-midi-recording-visibility",
      status: "passed",
      result,
      screenshots: [shot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runMIDIFXControls(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/MIDIFXControls.tsx");
  const cdp = await openTab(args, 640, 360);
  try {
    const effectSignature = (state) => JSON.stringify(state.effects || []);
    const before = await evalInPage(cdp, midiFXFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasControls) {
      throw new Error(`MIDI FX controls did not render: ${JSON.stringify(before)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "midi-fx-controls-before.png");

    await clickButtonByText(cdp, "Pit");
    await setInputValue(cdp, "#midi-fx-pitch-semitones", 7);
    await clickButtonByText(cdp, "Apply");
    const afterPitch = await evalInPage(cdp, midiFXStateExpression(storeUrl));
    const pitch = afterPitch.effects.find((effect) => effect.type === "pitch");
    if (!pitch?.enabled || pitch.semitones !== 7 || !afterPitch.canUndo) {
      throw new Error(`MIDI FX pitch dialog failed: ${JSON.stringify(afterPitch)}`);
    }
    const afterPitchUndo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "undo"));
    if (effectSignature(afterPitchUndo) !== effectSignature(before) || !afterPitchUndo.canRedo) {
      throw new Error(`MIDI FX pitch undo failed: ${JSON.stringify({ before, afterPitch, afterPitchUndo })}`);
    }
    const afterPitchRedo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "redo"));
    if (effectSignature(afterPitchRedo) !== effectSignature(afterPitch) || !afterPitchRedo.canUndo) {
      throw new Error(`MIDI FX pitch redo failed: ${JSON.stringify({ afterPitch, afterPitchUndo, afterPitchRedo })}`);
    }

    await clickButtonByText(cdp, "Vel");
    await setInputValue(cdp, "#midi-fx-velocity-percent", 125);
    await setInputValue(cdp, "#midi-fx-velocity-offset", -6);
    await clickButtonByText(cdp, "Apply");
    const afterVelocity = await evalInPage(cdp, midiFXStateExpression(storeUrl));
    const velocity = afterVelocity.effects.find((effect) => effect.type === "velocity");
    if (!velocity?.enabled || Math.abs(velocity.scale - 1.25) > 0.0001 || velocity.offset !== -6) {
      throw new Error(`MIDI FX velocity dialog failed: ${JSON.stringify(afterVelocity)}`);
    }
    const afterVelocityUndo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "undo"));
    if (effectSignature(afterVelocityUndo) !== effectSignature(afterPitchRedo) || !afterVelocityUndo.canRedo) {
      throw new Error(`MIDI FX velocity undo failed: ${JSON.stringify({ afterPitchRedo, afterVelocity, afterVelocityUndo })}`);
    }
    const afterVelocityRedo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "redo"));
    if (effectSignature(afterVelocityRedo) !== effectSignature(afterVelocity) || !afterVelocityRedo.canUndo) {
      throw new Error(`MIDI FX velocity redo failed: ${JSON.stringify({ afterVelocity, afterVelocityUndo, afterVelocityRedo })}`);
    }

    await clickButtonByText(cdp, "Tim");
    await setInputValue(cdp, "#midi-fx-time-swing", 22);
    await setInputValue(cdp, "#midi-fx-time-offset", 14);
    await clickButtonByText(cdp, "Apply");
    const afterTime = await evalInPage(cdp, midiFXStateExpression(storeUrl));
    const time = afterTime.effects.find((effect) => effect.type === "time");
    if (!time?.enabled || Math.abs(time.swing - 0.22) > 0.0001 || time.offsetMs !== 14) {
      throw new Error(`MIDI FX time dialog failed: ${JSON.stringify(afterTime)}`);
    }
    const afterTimeUndo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "undo"));
    if (effectSignature(afterTimeUndo) !== effectSignature(afterVelocityRedo) || !afterTimeUndo.canRedo) {
      throw new Error(`MIDI FX time undo failed: ${JSON.stringify({ afterVelocityRedo, afterTime, afterTimeUndo })}`);
    }
    const afterTimeRedo = await evalInPage(cdp, midiFXUndoRedoStateExpression(storeUrl, "redo"));
    if (effectSignature(afterTimeRedo) !== effectSignature(afterTime) || !afterTimeRedo.canUndo) {
      throw new Error(`MIDI FX time redo failed: ${JSON.stringify({ afterTime, afterTimeUndo, afterTimeRedo })}`);
    }
    const backendPayload = await evalInPage(cdp, midiFXBackendPayloadExpression(args.baseUrl, storeUrl));
    const failedPayloadChecks = Object.entries(backendPayload.checks || {})
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (backendPayload.syncPayloadCount < 3 || failedPayloadChecks.length > 0) {
      throw new Error(`MIDI FX backend payload failed: ${JSON.stringify({ failedPayloadChecks, backendPayload })}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "midi-fx-controls-after.png");

    return {
      scenario: "midi-fx-controls",
      status: "passed",
      before,
      afterPitch,
      afterPitchUndo,
      afterPitchRedo,
      afterVelocity,
      afterVelocityUndo,
      afterVelocityRedo,
      afterTime,
      afterTimeUndo,
      afterTimeRedo,
      backendPayload,
      screenshots: [beforeShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runMIDIFXPlacement(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/TrackHeader.tsx");
  const cdp = await openTab(args, 820, 420);
  try {
    const before = await evalInPage(cdp, midiFXPlacementFixtureExpression(args.baseUrl, storeUrl));
    if (before.headerMidiFxButtons.length > 0 || !before.hasFxButton || !before.hasSamplerButton) {
      throw new Error(`MIDI FX controls should not render in the track header: ${JSON.stringify(before)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "midi-fx-placement-header.png");

    const samplerOpened = await evalInPage(cdp, `
      (() => {
        const header = document.querySelector('#qa-track-header');
        const samplerButton = [...(header?.querySelectorAll('button') || [])]
          .find((button) => button.getAttribute('aria-label') === 'Load built-in sampler sample');
        if (!samplerButton) return false;
        samplerButton.click();
        return true;
      })()
    `);
    if (!samplerOpened) {
      throw new Error(`Could not open sampler dialog from track header: ${JSON.stringify(before)}`);
    }
    await sleep(300);
    const samplerDialog = await evalInPage(cdp, midiFXPlacementStateExpression());
    if (!samplerDialog.hasSamplerDialog || samplerDialog.promptCount !== 0) {
      throw new Error(`Sampler root note flow should use the in-app dialog without window.prompt: ${JSON.stringify(samplerDialog)}`);
    }
    await setInputValue(cdp, "#sampler-root-note-input", 36);
    await clickButtonByText(cdp, "Load");
    await sleep(500);
    const afterSampler = await evalInPage(cdp, midiFXPlacementStateExpression());
    const loadedSampler = afterSampler.samplerSamplePath === "C:/qa/review-sampler.wav"
      && afterSampler.samplerRootNote === 36
      && afterSampler.samplerCalls.some((call) => call.samplePath === "C:/qa/review-sampler.wav" && call.rootNote === 36)
      && afterSampler.promptCount === 0;
    if (!loadedSampler) {
      throw new Error(`Sampler root note dialog did not load sample undoably: ${JSON.stringify(afterSampler)}`);
    }

    const opened = await evalInPage(cdp, `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const header = document.querySelector('#qa-track-header');
        const fxButton = [...(header?.querySelectorAll('button') || [])].find((button) => normalize(button.textContent) === 'FX');
        if (!fxButton) return false;
        fxButton.click();
        return true;
      })()
    `);
    if (!opened) {
      throw new Error(`Could not open FX chain from track header: ${JSON.stringify(before)}`);
    }
    await sleep(700);

    const after = await evalInPage(cdp, midiFXPlacementStateExpression());
    const expectedPanelButtons = ["Arp", "Pit", "Vel", "Tim"];
    const missingPanelButtons = expectedPanelButtons.filter((label) => !after.panelMidiFxButtons.includes(label));
    if (
      after.headerMidiFxButtons.length > 0
      || !after.hasPanel
      || !after.hasPanelMidiFxSection
      || missingPanelButtons.length > 0
    ) {
      throw new Error(`MIDI FX controls were not placed exclusively in the FX panel: ${JSON.stringify({ before, after, missingPanelButtons })}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "midi-fx-placement-fx-panel.png");
    const appTcp = await runAppTCPMidiHeaderPlacement(args);

    return {
      scenario: "midi-fx-placement",
      status: "passed",
      before,
      samplerDialog,
      afterSampler,
      after,
      appTcp,
      screenshots: [beforeShot, afterShot, ...appTcp.screenshots],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runAppTCPMidiHeaderPlacement(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 1100, 620);
  try {
    const state = await evalInPage(cdp, appTcpMidiHeaderPlacementFixtureExpression(storeUrl));
    if (
      state.headerMidiFxButtons.length > 0
      || !state.midiRow?.hasFxButton
      || !state.instrumentRow?.hasFxButton
      || !state.instrumentRow?.hasSamplerButton
    ) {
      throw new Error(`Actual App TCP should not render MIDI FX controls in MIDI/instrument headers: ${JSON.stringify(state)}`);
    }
    const shot = await screenshot(cdp, args.outDir, "midi-fx-placement-app-tcp.png");
    return {
      status: "passed",
      state,
      screenshots: [shot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runMIDIProjectPersistence(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 900, 640);
  let step = "start";
  try {
    step = "save-load";
    const result = await evalInPage(cdp, midiProjectPersistenceExpression(args.baseUrl, storeUrl));
    const failedChecks = Object.entries(result.checks || {})
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (!result.saveOK || !result.loadOK || result.savedJsonBytes <= 0 || failedChecks.length > 0) {
      throw new Error(`MIDI project persistence failed: ${JSON.stringify({ failedChecks, result })}`);
    }
    const shot = await screenshot(cdp, args.outDir, "midi-project-persistence-after-load.png");
    return {
      scenario: "midi-project-persistence",
      status: "passed",
      savedJsonBytes: result.savedJsonBytes,
      savedTrack: result.savedTrack,
      loadedTrack: result.loadedTrack,
      syncPayloadCount: result.syncPayloadCount,
      panicCount: result.panicCount,
      checks: result.checks,
      screenshots: [shot],
    };
  } catch (error) {
    throw new Error(`midi-project-persistence ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runMIDIExportPayload(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 860, 560);
  try {
    const result = await evalInPage(cdp, midiExportPayloadExpression(args.baseUrl, storeUrl));
    const failedChecks = Object.entries(result.checks || {})
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (!result.exportOK || failedChecks.length > 0) {
      throw new Error(`MIDI export payload failed: ${JSON.stringify({ failedChecks, result })}`);
    }
    const shot = await screenshot(cdp, args.outDir, "midi-export-payload.png");
    return {
      scenario: "midi-export-payload",
      status: "passed",
      result,
      screenshots: [shot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runTimelineBasic(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const cdp = await openTab(args, 1280, 520);
  try {
    const closeEnough = (left, right) => Math.abs(left - right) <= 0.0001;
    const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "timeline-basic-before.png");

    await drag(cdp, 180, 70, 240, 70);
    const afterMove = await evalInPage(cdp, timelineStateExpression(storeUrl));
    if (!(afterMove.start > before.start + 0.05)) {
      throw new Error(`Timeline move failed: start ${before.start} -> ${afterMove.start}`);
    }
    if (!afterMove.canUndo) {
      throw new Error("Timeline move did not enable undo");
    }
    const moveShot = await screenshot(cdp, args.outDir, "timeline-basic-after-move.png");

    const afterMoveUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (!closeEnough(afterMoveUndo.start, before.start) || !closeEnough(afterMoveUndo.duration, before.duration) || !afterMoveUndo.canRedo) {
      throw new Error(`Timeline move undo failed: ${JSON.stringify({ before, afterMove, afterMoveUndo })}`);
    }
    const moveUndoShot = await screenshot(cdp, args.outDir, "timeline-basic-after-move-undo.png");

    const afterMoveRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
    if (!closeEnough(afterMoveRedo.start, afterMove.start) || !closeEnough(afterMoveRedo.duration, afterMove.duration) || !afterMoveRedo.canUndo) {
      throw new Error(`Timeline move redo failed: ${JSON.stringify({ before, afterMove, afterMoveUndo, afterMoveRedo })}`);
    }
    const moveRedoShot = await screenshot(cdp, args.outDir, "timeline-basic-after-move-redo.png");

    const rightEdgeX = Math.round((afterMoveRedo.start + afterMoveRedo.duration) * 110);
    await drag(cdp, rightEdgeX - 3, 70, rightEdgeX + 80, 70);
    const afterResize = await evalInPage(cdp, timelineStateExpression(storeUrl));
    if (!(afterResize.duration > afterMoveRedo.duration + 0.05) || !afterResize.canUndo) {
      throw new Error(`Timeline right resize failed: duration ${afterMoveRedo.duration} -> ${afterResize.duration}`);
    }
    const resizeShot = await screenshot(cdp, args.outDir, "timeline-basic-after-right-resize.png");

    const afterResizeUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (!closeEnough(afterResizeUndo.start, afterMoveRedo.start) || !closeEnough(afterResizeUndo.duration, afterMoveRedo.duration) || !afterResizeUndo.canRedo) {
      throw new Error(`Timeline right resize undo failed: ${JSON.stringify({ afterMoveRedo, afterResize, afterResizeUndo })}`);
    }
    const resizeUndoShot = await screenshot(cdp, args.outDir, "timeline-basic-after-right-resize-undo.png");

    const afterResizeRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
    if (!closeEnough(afterResizeRedo.start, afterResize.start) || !closeEnough(afterResizeRedo.duration, afterResize.duration) || !afterResizeRedo.canUndo) {
      throw new Error(`Timeline right resize redo failed: ${JSON.stringify({ afterMoveRedo, afterResize, afterResizeUndo, afterResizeRedo })}`);
    }
    const resizeRedoShot = await screenshot(cdp, args.outDir, "timeline-basic-after-right-resize-redo.png");

    return {
      scenario: "timeline-basic",
      status: "passed",
      before,
      afterMove,
      afterMoveUndo,
      afterMoveRedo,
      afterResize,
      afterResizeUndo,
      afterResizeRedo,
      screenshots: [beforeShot, moveShot, moveUndoShot, moveRedoShot, resizeShot, resizeUndoShot, resizeRedoShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runTimelineArrange(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const checks = [];

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-arrange-left-trim-before.png");
      const leftEdgeX = Math.round(before.start * 110 + 4);
      await drag(cdp, leftEdgeX, 70, leftEdgeX + 55, 70);
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!(after.start > before.start + 0.05 && after.duration < before.duration - 0.05 && after.offset > before.offset + 0.05)) {
        throw new Error(`Timeline left trim/source slip failed: ${JSON.stringify({ before, after })}`);
      }
      const bridgeResult = await evalInPage(cdp, `
        (async () => {
          const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
          const bridgeModule = await import('${args.baseUrl}/src/services/NativeBridge.ts');
          const serializationModule = await import('${args.baseUrl}/src/utils/midiClipSerialization.ts');
          const state = useDAWStore.getState();
          const track = state.tracks.find((candidate) => candidate.id === 'qa-midi-track');
          const direct = serializationModule.serializeMIDIClipsForBackend(track?.midiClips || [], track?.midiEffects || []);
          const original = bridgeModule.nativeBridge.setTrackMIDIClips;
          window.__studio13LastMIDIBackendPayload = null;
          bridgeModule.nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
            window.__studio13LastMIDIBackendPayload = {
              trackId,
              clips: JSON.parse(JSON.stringify(clips)),
            };
            return true;
          };
          await useDAWStore.getState().syncMIDITrackToBackend('qa-midi-track', { debounce: false });
          bridgeModule.nativeBridge.setTrackMIDIClips = original;
          return {
            direct,
            payload: window.__studio13LastMIDIBackendPayload,
            clipState: track?.midiClips?.[0] || null,
          };
        })()
      `);
      const payloadClip = bridgeResult?.payload?.clips?.find((clip) => clip.id === "qa-midi-clip");
      const events = payloadClip?.events || [];
      if (bridgeResult?.payload?.trackId !== "qa-midi-track" || !payloadClip) {
        throw new Error(`Left-trim backend bridge payload was not captured: ${JSON.stringify(bridgeResult)}`);
      }
      if (JSON.stringify(bridgeResult.payload.clips) !== JSON.stringify(bridgeResult.direct)) {
        throw new Error(`Left-trim bridge payload diverged from serializeMIDIClipsForBackend output: ${JSON.stringify(bridgeResult)}`);
      }
      if (Math.abs(payloadClip.startTime - after.start) > 0.001 || Math.abs(payloadClip.duration - after.duration) > 0.001) {
        throw new Error(`Left-trim serialized clip timing mismatch: ${JSON.stringify({ after, payloadClip })}`);
      }
      if (!events.every((event) => event.timestamp >= -0.0001 && event.timestamp <= after.duration + 0.0001)) {
        throw new Error(`Left-trim serialized MIDI events escaped the visible item window: ${JSON.stringify({ after, events })}`);
      }
      if (!events.some((event) => event.type === "noteOn" && event.note === 64 && event.channel === 2 && event.timestamp <= 0.01)) {
        throw new Error(`Left-trim serialization did not start from the slipped source window: ${JSON.stringify({ after, events })}`);
      }
      if (!events.some((event) => event.type === "noteOn" && event.timestamp > 0.95)) {
        throw new Error(`Left-trim serialization did not preserve loop-resolved MIDI content after the slipped window: ${JSON.stringify({ after, events })}`);
      }
      if (!events.some((event) => event.type === "pitchBend" && event.value === 10600 && event.timestamp <= 0.01)) {
        throw new Error(`Left-trim serialization did not preserve source-window pitchbend at the new item start: ${JSON.stringify({ after, events })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-arrange-left-trim-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        Math.abs(afterUndo.start - before.start) > 0.001
        || Math.abs(afterUndo.duration - before.duration) > 0.001
        || Math.abs(afterUndo.offset - before.offset) > 0.001
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline left trim/source slip undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-arrange-left-trim-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        Math.abs(afterRedo.start - after.start) > 0.001
        || Math.abs(afterRedo.duration - after.duration) > 0.001
        || Math.abs(afterRedo.offset - after.offset) > 0.001
        || !afterRedo.canUndo
      ) {
        throw new Error(`Timeline left trim/source slip redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-arrange-left-trim-after-redo.png");
      checks.push({
        name: "left-trim-source-slip",
        status: "passed",
        before,
        after,
        backendPayload: payloadClip,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        offset: 0.25,
        sourceLength: 4,
        loopEnabled: false,
        loopLength: 4,
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-arrange-alt-slip-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX - 60, 70, { modifiers: 1 });
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!(Math.abs(after.start - before.start) < 0.001 && Math.abs(after.duration - before.duration) < 0.001 && after.offset > before.offset + 0.05)) {
        throw new Error(`Timeline Alt-slip failed: ${JSON.stringify({ before, after })}`);
      }
      const bridgeResult = await evalInPage(cdp, `
        (async () => {
          const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
          const bridgeModule = await import('${args.baseUrl}/src/services/NativeBridge.ts');
          const serializationModule = await import('${args.baseUrl}/src/utils/midiClipSerialization.ts');
          const state = useDAWStore.getState();
          const track = state.tracks.find((candidate) => candidate.id === 'qa-midi-track');
          const direct = serializationModule.serializeMIDIClipsForBackend(track?.midiClips || [], track?.midiEffects || []);
          const original = bridgeModule.nativeBridge.setTrackMIDIClips;
          window.__studio13LastMIDIBackendPayload = null;
          bridgeModule.nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
            window.__studio13LastMIDIBackendPayload = {
              trackId,
              clips: JSON.parse(JSON.stringify(clips)),
            };
            return true;
          };
          await useDAWStore.getState().syncMIDITrackToBackend('qa-midi-track', { debounce: false });
          bridgeModule.nativeBridge.setTrackMIDIClips = original;
          return {
            direct,
            payload: window.__studio13LastMIDIBackendPayload,
            clipState: track?.midiClips?.[0] || null,
          };
        })()
      `);
      const payloadClip = bridgeResult?.payload?.clips?.find((clip) => clip.id === "qa-midi-clip");
      const events = payloadClip?.events || [];
      if (bridgeResult?.payload?.trackId !== "qa-midi-track" || !payloadClip) {
        throw new Error(`Alt-slip backend bridge payload was not captured: ${JSON.stringify(bridgeResult)}`);
      }
      if (JSON.stringify(bridgeResult.payload.clips) !== JSON.stringify(bridgeResult.direct)) {
        throw new Error(`Alt-slip bridge payload diverged from serializeMIDIClipsForBackend output: ${JSON.stringify(bridgeResult)}`);
      }
      if (Math.abs(payloadClip.startTime - after.start) > 0.001 || Math.abs(payloadClip.duration - after.duration) > 0.001) {
        throw new Error(`Alt-slip serialized clip timing mismatch: ${JSON.stringify({ after, payloadClip })}`);
      }
      if (!events.every((event) => event.timestamp >= -0.0001 && event.timestamp <= after.duration + 0.0001)) {
        throw new Error(`Alt-slip serialized MIDI events escaped the visible item window: ${JSON.stringify({ after, events })}`);
      }
      if (!events.some((event) => event.type === "noteOn" && event.note === 64 && event.channel === 2 && event.timestamp <= 0.01)) {
        throw new Error(`Alt-slip serialization did not start from the slipped source window: ${JSON.stringify({ after, events })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-arrange-alt-slip-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        Math.abs(afterUndo.start - before.start) > 0.001
        || Math.abs(afterUndo.duration - before.duration) > 0.001
        || Math.abs(afterUndo.offset - before.offset) > 0.001
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline Alt-slip undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-arrange-alt-slip-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        Math.abs(afterRedo.start - after.start) > 0.001
        || Math.abs(afterRedo.duration - after.duration) > 0.001
        || Math.abs(afterRedo.offset - after.offset) > 0.001
        || !afterRedo.canUndo
      ) {
        throw new Error(`Timeline Alt-slip redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-arrange-alt-slip-after-redo.png");
      checks.push({
        name: "alt-slip-source-window",
        status: "passed",
        before,
        after,
        backendPayload: payloadClip,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-arrange-copy-drag-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX + 90, 70, { modifiers: 2 });
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!(after.clipCount === before.clipCount + 1 && after.clips.some((clip) => clip.start > before.start + 0.05))) {
        throw new Error(`Timeline copy-drag failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-arrange-copy-drag-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterUndo.clipCount !== before.clipCount
        || !afterUndo.clips.some((clip) => clip.id === "qa-midi-clip" && Math.abs(clip.start - before.start) < 0.001)
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline copy-drag undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-arrange-copy-drag-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterRedo.clipCount !== after.clipCount
        || !afterRedo.clips.some((clip) => clip.id !== "qa-midi-clip" && clip.start > before.start + 0.05)
        || !afterRedo.canUndo
      ) {
        throw new Error(`Timeline copy-drag redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-arrange-copy-drag-after-redo.png");
      checks.push({
        name: "copy-drag",
        status: "passed",
        before,
        after,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-arrange-split-before.png");
      await evalInPage(cdp, setTimelineToolExpression(storeUrl, "split"));
      const splitX = Math.round((before.start + before.duration / 2) * 110);
      await click(cdp, splitX, 70);
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!(after.clipCount === before.clipCount + 1 && after.clips.every((clip) => clip.duration > 0))) {
        throw new Error(`Timeline split tool failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-arrange-split-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterUndo.clipCount !== before.clipCount
        || Math.abs(afterUndo.clips[0]?.start - before.start) > 0.001
        || Math.abs(afterUndo.clips[0]?.duration - before.duration) > 0.001
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline split undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-arrange-split-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterRedo.clipCount !== after.clipCount || !afterRedo.clips.every((clip) => clip.duration > 0) || !afterRedo.canUndo) {
        throw new Error(`Timeline split redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-arrange-split-after-redo.png");
      checks.push({
        name: "split-tool-click",
        status: "passed",
        before,
        after,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-arrange-duplicate-delete-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await clickContextMenuLabel(cdp, "Duplicate");
      const afterDuplicate = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterDuplicate.clipCount !== before.clipCount + 1) {
        throw new Error(`Timeline context-menu duplicate failed: ${JSON.stringify({ before, afterDuplicate })}`);
      }
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterDuplicateUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterDuplicateUndo.clipCount !== before.clipCount
        || !afterDuplicateUndo.clips.some((clip) => clip.id === "qa-midi-clip")
        || !afterDuplicateUndo.canRedo
      ) {
        throw new Error(`Timeline context-menu duplicate undo failed: ${JSON.stringify({ before, afterDuplicate, afterDuplicateUndo })}`);
      }
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterDuplicateRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterDuplicateRedo.clipCount !== afterDuplicate.clipCount
        || !afterDuplicateRedo.clips.some((clip) => clip.id !== "qa-midi-clip")
        || !afterDuplicateRedo.canUndo
      ) {
        throw new Error(`Timeline context-menu duplicate redo failed: ${JSON.stringify({ before, afterDuplicateUndo, afterDuplicateRedo })}`);
      }
      const duplicatedClip = [...afterDuplicateRedo.clips].filter((clip) => clip.id !== "qa-midi-clip").sort((a, b) => b.start - a.start)[0];
      const duplicatedCenterX = Math.round((duplicatedClip.start + duplicatedClip.duration / 2) * 110);
      await contextClick(cdp, duplicatedCenterX, 70);
      await clickContextMenuLabel(cdp, "Delete");
      const afterDelete = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!(afterDelete.clipCount < afterDuplicateRedo.clipCount)) {
        throw new Error(`Timeline context-menu delete failed: ${JSON.stringify({ afterDuplicateRedo, afterDelete })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-arrange-duplicate-delete-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterDeleteUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterDeleteUndo.clipCount !== afterDuplicateRedo.clipCount
        || !afterDeleteUndo.clips.some((clip) => clip.id === duplicatedClip.id)
        || !afterDeleteUndo.canRedo
      ) {
        throw new Error(`Timeline context-menu delete undo failed: ${JSON.stringify({ duplicatedClip, afterDelete, afterDeleteUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-arrange-duplicate-delete-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterDeleteRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (
        afterDeleteRedo.clipCount !== afterDelete.clipCount
        || afterDeleteRedo.clips.some((clip) => clip.id === duplicatedClip.id)
        || !afterDeleteRedo.canUndo
      ) {
        throw new Error(`Timeline context-menu delete redo failed: ${JSON.stringify({ duplicatedClip, afterDeleteUndo, afterDeleteRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-arrange-duplicate-delete-after-redo.png");
      checks.push({
        name: "context-duplicate-delete",
        status: "passed",
        before,
        afterDuplicate,
        afterDuplicateUndo,
        afterDuplicateRedo,
        afterDelete,
        afterDeleteUndo,
        afterDeleteRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "timeline-arrange",
    status: "passed",
    checks,
  };
}

async function runTimelineActions(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const checks = [];

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-actions-mute-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await evalInPage(cdp, setTimelineToolExpression(storeUrl, "mute"));
      await click(cdp, centerX, 70);
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!after.muted) {
        throw new Error(`Timeline mute tool failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-actions-mute-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterUndo.muted || !afterUndo.canRedo) {
        throw new Error(`Timeline mute undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-actions-mute-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!afterRedo.muted || !afterRedo.canUndo) {
        throw new Error(`Timeline mute redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-actions-mute-after-redo.png");
      checks.push({
        name: "mute-tool-click",
        status: "passed",
        before,
        after,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-actions-context-lock-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      const menuShot = await screenshot(cdp, args.outDir, "timeline-actions-context-lock-menu.png");
      await clickContextMenuLabel(cdp, "Lock Clip");
      const afterLock = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!afterLock.locked) {
        throw new Error(`Timeline context-menu lock failed: ${JSON.stringify({ before, afterLock })}`);
      }
      await drag(cdp, centerX, 70, centerX + 90, 70);
      const afterDrag = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (Math.abs(afterDrag.start - before.start) > 0.001) {
        throw new Error(`Locked MIDI clip moved: ${JSON.stringify({ before, afterLock, afterDrag })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-actions-context-lock-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterUndo.locked || Math.abs(afterUndo.start - before.start) > 0.001 || !afterUndo.canRedo) {
        throw new Error(`Timeline context-menu lock undo failed: ${JSON.stringify({ before, afterLock, afterDrag, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-actions-context-lock-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (!afterRedo.locked || Math.abs(afterRedo.start - before.start) > 0.001 || !afterRedo.canUndo) {
        throw new Error(`Timeline context-menu lock redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-actions-context-lock-after-redo.png");
      checks.push({
        name: "context-lock-prevents-move",
        status: "passed",
        before,
        afterLock,
        afterDrag,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, menuShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-actions-repeat-dialog-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await clickContextMenuLabel(cdp, "Repeat Clip...");
      await setInputValue(cdp, "#timeline-repeat-clip-count-input", 2);
      const applied = await evalInPage(cdp, `
        (() => {
          const buttons = [...document.querySelectorAll('button')];
          const button = buttons.find((candidate) => candidate.textContent.trim() === 'Apply');
          if (!button) return false;
          button.click();
          return true;
        })()
      `);
      if (!applied) throw new Error("Could not apply repeat clip dialog");
      await sleep(250);
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (after.clipCount !== before.clipCount + 2 || !after.canUndo) {
        throw new Error(`Timeline repeat clip dialog failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-actions-repeat-dialog-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterUndo.clipCount !== before.clipCount || !afterUndo.canRedo) {
        throw new Error(`Timeline repeat clip undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-actions-repeat-dialog-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (afterRedo.clipCount !== after.clipCount || !afterRedo.canUndo) {
        throw new Error(`Timeline repeat clip redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-actions-repeat-dialog-after-redo.png");
      checks.push({
        name: "repeat-clip-dialog",
        status: "passed",
        before,
        after,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "timeline-actions",
    status: "passed",
    checks,
  };
}

async function runTimelineCrossTrack(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const checks = [];

  {
    const cdp = await openTab(args, 1280, 620);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        includeTargetTrack: true,
        targetTrackType: "instrument",
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-cross-track-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX + 70, 150, { steps: 12, settleMs: 500 });
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const movedClip = after.clips.find((clip) => clip.id === "qa-midi-clip");
      if (!movedClip || movedClip.trackId !== "qa-midi-target" || movedClip.start <= before.start + 0.05) {
        throw new Error(`Timeline cross-track MIDI move failed: ${JSON.stringify({ before, after, movedClip })}`);
      }
      if (!after.canUndo) {
        throw new Error("Timeline cross-track MIDI move did not enable undo");
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-cross-track-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const undoMovedClip = afterUndo.clips.find((clip) => clip.id === "qa-midi-clip");
      if (
        !undoMovedClip
        || undoMovedClip.trackId !== "qa-midi-track"
        || Math.abs(undoMovedClip.start - before.start) > 0.001
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline cross-track MIDI move undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-cross-track-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const redoMovedClip = afterRedo.clips.find((clip) => clip.id === "qa-midi-clip");
      if (
        !redoMovedClip
        || redoMovedClip.trackId !== "qa-midi-target"
        || redoMovedClip.start <= before.start + 0.05
        || !afterRedo.canUndo
      ) {
        throw new Error(`Timeline cross-track MIDI move redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-cross-track-after-redo.png");
      checks.push({
        name: "move-compatible-track-undo-redo",
        status: "passed",
        before,
        after,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterShot, undoShot, redoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 620);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        includeTargetTrack: true,
        targetTrackType: "instrument",
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-cross-track-copy-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX + 70, 150, { modifiers: 2, steps: 12, settleMs: 500 });
      const afterCopy = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const originalClip = afterCopy.clips.find((clip) => clip.id === "qa-midi-clip");
      const copiedClip = afterCopy.clips.find((clip) => clip.id !== "qa-midi-clip" && clip.trackId === "qa-midi-target");
      if (
        afterCopy.clipCount !== before.clipCount + 1
        || !originalClip
        || originalClip.trackId !== "qa-midi-track"
        || Math.abs(originalClip.start - before.start) > 0.001
        || !copiedClip
        || copiedClip.start <= before.start + 0.05
        || !afterCopy.canUndo
      ) {
        throw new Error(`Timeline cross-track MIDI copy-drag failed: ${JSON.stringify({ before, afterCopy, originalClip, copiedClip })}`);
      }
      const afterCopyShot = await screenshot(cdp, args.outDir, "timeline-cross-track-copy-after.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(250);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const undoOriginal = afterUndo.clips.find((clip) => clip.id === "qa-midi-clip");
      if (
        afterUndo.clipCount !== before.clipCount
        || !undoOriginal
        || undoOriginal.trackId !== "qa-midi-track"
        || Math.abs(undoOriginal.start - before.start) > 0.001
        || afterUndo.clips.some((clip) => clip.trackId === "qa-midi-target")
        || !afterUndo.canRedo
      ) {
        throw new Error(`Timeline cross-track copy undo failed: ${JSON.stringify({ before, afterCopy, afterUndo })}`);
      }
      const afterUndoShot = await screenshot(cdp, args.outDir, "timeline-cross-track-copy-after-undo.png");
      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(250);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const redoCopiedClip = afterRedo.clips.find((clip) => clip.id !== "qa-midi-clip" && clip.trackId === "qa-midi-target");
      if (afterRedo.clipCount !== before.clipCount + 1 || !redoCopiedClip || !afterRedo.canUndo) {
        throw new Error(`Timeline cross-track copy redo failed: ${JSON.stringify({ before, afterUndo, afterRedo })}`);
      }
      const afterRedoShot = await screenshot(cdp, args.outDir, "timeline-cross-track-copy-after-redo.png");
      checks.push({
        name: "copy-compatible-track-undo-redo",
        status: "passed",
        before,
        afterCopy,
        afterUndo,
        afterRedo,
        screenshots: [beforeShot, afterCopyShot, afterUndoShot, afterRedoShot],
      });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "timeline-cross-track",
    status: "passed",
    checks,
  };
}

async function runTimelineDropTargets(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const checks = [];

  {
    const cdp = await openTab(args, 1280, 620);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        includeTargetTrack: true,
        targetTrackType: "audio",
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-incompatible-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX + 70, 150, { steps: 12, settleMs: 500 });
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const movedClip = after.clips.find((clip) => clip.id === "qa-midi-clip");
      if (!movedClip || movedClip.trackId !== "qa-midi-track" || movedClip.trackId === "qa-midi-target" || after.trackCount !== before.trackIds.length) {
        throw new Error(`Timeline incompatible MIDI drop target failed: ${JSON.stringify({ before, after, movedClip })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-incompatible-after.png");
      checks.push({ name: "incompatible-audio-target-suppressed", status: "passed", before, after, screenshots: [beforeShot, afterShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 620);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-ghost-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await drag(cdp, centerX, 70, centerX + 70, 165, { steps: 12, settleMs: 700 });
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const movedClip = after.clips.find((clip) => clip.id === "qa-midi-clip");
      const targetTrack = movedClip ? after.trackTypes.find((track) => track.id === movedClip.trackId) : null;
      if (!movedClip || movedClip.trackId === "qa-midi-track" || after.trackCount !== before.trackIds.length + 1 || targetTrack?.type !== "midi" || !after.canUndo) {
        throw new Error(`Timeline MIDI ghost-track creation failed: ${JSON.stringify({ before, after, movedClip, targetTrack })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-ghost-after.png");

      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().undo();
          return true;
        })()
      `);
      await sleep(180);
      const afterUndo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const undoClip = afterUndo.clips.find((clip) => clip.id === "qa-midi-clip");
      if (!undoClip || undoClip.trackId !== "qa-midi-track" || afterUndo.trackCount !== before.trackIds.length || !afterUndo.canRedo) {
        throw new Error(`Timeline MIDI ghost-track undo failed: ${JSON.stringify({ before, after, afterUndo, undoClip })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-ghost-after-undo.png");

      await evalInPage(cdp, `
        (() => {
          window.__studio13QADAWStore.getState().redo();
          return true;
        })()
      `);
      await sleep(180);
      const afterRedo = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const redoClip = afterRedo.clips.find((clip) => clip.id === "qa-midi-clip");
      const redoTrack = redoClip ? afterRedo.trackTypes.find((track) => track.id === redoClip.trackId) : null;
      if (!redoClip || redoClip.trackId === "qa-midi-track" || afterRedo.trackCount !== before.trackIds.length + 1 || redoTrack?.type !== "midi" || !afterRedo.canUndo) {
        throw new Error(`Timeline MIDI ghost-track redo failed: ${JSON.stringify({ before, afterUndo, afterRedo, redoClip, redoTrack })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-drop-targets-ghost-after-redo.png");
      checks.push({ name: "ghost-midi-track-create-and-move", status: "passed", before, after, afterUndo, afterRedo, screenshots: [beforeShot, afterShot, undoShot, redoShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "timeline-drop-targets",
    status: "passed",
    checks,
  };
}

async function runTimelineSelection(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const cdp = await openTab(args, 1280, 520);
  try {
    const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
      includeSecondClip: true,
      initialSelectedClipIds: [],
    }));
    const beforeShot = await screenshot(cdp, args.outDir, "timeline-selection-before.png");
    const firstClip = before.clips.find((clip) => clip.id === "qa-midi-clip");
    const secondClip = before.clips.find((clip) => clip.id === "qa-midi-clip-b");
    if (!firstClip || !secondClip) {
      throw new Error(`Timeline selection fixture missing clips: ${JSON.stringify(before)}`);
    }

    const firstX = Math.round((firstClip.start + firstClip.duration / 2) * 110);
    const secondX = Math.round((secondClip.start + secondClip.duration / 2) * 110);
    await click(cdp, firstX, 70);
    const afterSelect = await evalInPage(cdp, timelineStateExpression(storeUrl));
    if (afterSelect.selectedClipIds.length !== 1 || afterSelect.selectedClipIds[0] !== "qa-midi-clip") {
      throw new Error(`Timeline single-select failed: ${JSON.stringify({ before, afterSelect })}`);
    }
    const selectShot = await screenshot(cdp, args.outDir, "timeline-selection-after-single.png");

    await click(cdp, secondX, 70, { modifiers: 2 });
    const afterMulti = await evalInPage(cdp, timelineStateExpression(storeUrl));
    const selected = new Set(afterMulti.selectedClipIds);
    if (!(selected.has("qa-midi-clip") && selected.has("qa-midi-clip-b") && selected.size === 2)) {
      throw new Error(`Timeline Ctrl multi-select failed: ${JSON.stringify({ afterSelect, afterMulti })}`);
    }
    const multiShot = await screenshot(cdp, args.outDir, "timeline-selection-after-multi.png");

    return {
      scenario: "timeline-selection",
      status: "passed",
      before,
      afterSelect,
      afterMulti,
      screenshots: [beforeShot, selectShot, multiShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runTimelineKeyboardActions(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/App.tsx");
  const cdp = await openTab(args, 1280, 760);
  try {
    const clipIds = (state) => (state.clips || []).map((clip) => clip.id).sort().join("|");
    const before = await evalInPage(cdp, appTimelineFixtureExpression(storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-before.png");
    await keyPress(cdp, "d", { modifiers: 2, settleMs: 300 });
    const afterDuplicate = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (afterDuplicate.clipCount !== before.clipCount + 1 || !afterDuplicate.canUndo) {
      throw new Error(`Timeline Ctrl+D duplicate failed: ${JSON.stringify({ before, afterDuplicate })}`);
    }
    const duplicateShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-duplicate.png");

    await keyPress(cdp, "z", { modifiers: 2, settleMs: 350 });
    const afterDuplicateUndo = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (afterDuplicateUndo.clipCount !== before.clipCount || clipIds(afterDuplicateUndo) !== clipIds(before) || !afterDuplicateUndo.canRedo) {
      throw new Error(`Timeline Ctrl+D undo failed: ${JSON.stringify({ before, afterDuplicate, afterDuplicateUndo })}`);
    }
    const duplicateUndoShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-duplicate-undo.png");

    await keyPress(cdp, "y", { modifiers: 2, settleMs: 350 });
    const afterDuplicateRedo = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (afterDuplicateRedo.clipCount !== afterDuplicate.clipCount || clipIds(afterDuplicateRedo) !== clipIds(afterDuplicate) || !afterDuplicateRedo.canUndo) {
      throw new Error(`Timeline Ctrl+D redo failed: ${JSON.stringify({ before, afterDuplicate, afterDuplicateUndo, afterDuplicateRedo })}`);
    }
    const duplicateRedoShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-duplicate-redo.png");

    await keyPress(cdp, "Delete", { settleMs: 300 });
    const afterDelete = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (!(afterDelete.clipCount < afterDuplicateRedo.clipCount && afterDelete.canUndo)) {
      throw new Error(`Timeline Delete shortcut failed: ${JSON.stringify({ afterDuplicateRedo, afterDelete })}`);
    }
    const deleteShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-delete.png");

    await keyPress(cdp, "z", { modifiers: 2, settleMs: 350 });
    const afterDeleteUndo = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (afterDeleteUndo.clipCount !== afterDuplicateRedo.clipCount || clipIds(afterDeleteUndo) !== clipIds(afterDuplicateRedo) || !afterDeleteUndo.canRedo) {
      throw new Error(`Timeline Delete undo failed: ${JSON.stringify({ afterDuplicateRedo, afterDelete, afterDeleteUndo })}`);
    }
    const deleteUndoShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-delete-undo.png");

    await keyPress(cdp, "y", { modifiers: 2, settleMs: 350 });
    const afterDeleteRedo = await evalInPage(cdp, appTimelineClipStateExpression(storeUrl));
    if (afterDeleteRedo.clipCount !== afterDelete.clipCount || clipIds(afterDeleteRedo) !== clipIds(afterDelete) || !afterDeleteRedo.canUndo) {
      throw new Error(`Timeline Delete redo failed: ${JSON.stringify({ afterDuplicateRedo, afterDelete, afterDeleteUndo, afterDeleteRedo })}`);
    }
    const deleteRedoShot = await screenshot(cdp, args.outDir, "timeline-keyboard-actions-after-delete-redo.png");

    return {
      scenario: "timeline-keyboard-actions",
      status: "passed",
      before,
      afterDuplicate,
      afterDuplicateUndo,
      afterDuplicateRedo,
      afterDelete,
      afterDeleteUndo,
      afterDeleteRedo,
      screenshots: [beforeShot, duplicateShot, duplicateUndoShot, duplicateRedoShot, deleteShot, deleteUndoShot, deleteRedoShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runTimelineSnapUndo(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const cdp = await openTab(args, 1280, 520);
  try {
    const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
      snapEnabled: true,
      gridSize: "beat",
    }));
    const beforeShot = await screenshot(cdp, args.outDir, "timeline-snap-undo-before.png");
    const centerX = Math.round((before.start + before.duration / 2) * 110);
    await drag(cdp, centerX, 70, centerX + 73, 70);
    const afterMove = await evalInPage(cdp, timelineStateExpression(storeUrl));
    if (Math.abs(afterMove.start - 1.5) > 0.0001 || !afterMove.canUndo) {
      throw new Error(`Timeline snap move failed: ${JSON.stringify({ before, afterMove })}`);
    }
    const moveShot = await screenshot(cdp, args.outDir, "timeline-snap-undo-after-move.png");
    const afterUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (Math.abs(afterUndo.start - before.start) > 0.0001 || !afterUndo.canRedo) {
      throw new Error(`Timeline undo after snap move failed: ${JSON.stringify({ before, afterMove, afterUndo })}`);
    }
    const undoShot = await screenshot(cdp, args.outDir, "timeline-snap-undo-after-undo.png");
    const afterRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
    if (Math.abs(afterRedo.start - afterMove.start) > 0.0001 || !afterRedo.canUndo) {
      throw new Error(`Timeline redo after snap move failed: ${JSON.stringify({ before, afterMove, afterUndo, afterRedo })}`);
    }
    const redoShot = await screenshot(cdp, args.outDir, "timeline-snap-undo-after-redo.png");

    return {
      scenario: "timeline-snap-undo",
      status: "passed",
      before,
      afterMove,
      afterUndo,
      afterRedo,
      screenshots: [beforeShot, moveShot, undoShot, redoShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runTimelineSourceContext(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const checks = [];

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        offset: 0.5,
        loopOffset: 0.5,
        sourceLength: 4,
        loopLength: 4,
        loopEnabled: false,
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-source-context-reset-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await hoverContextMenuLabel(cdp, "MIDI Source");
      const menuShot = await screenshot(cdp, args.outDir, "timeline-source-context-reset-menu.png");
      await activateContextMenuLabel(cdp, "Reset Source Offset");
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (Math.abs(after.offset) > 0.0001 || Math.abs((after.clips[0]?.loopOffset ?? 0)) > 0.0001 || !after.canUndo) {
        throw new Error(`MIDI source reset context action failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-source-context-reset-after.png");
      const afterUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
      if (Math.abs(afterUndo.offset - before.offset) > 0.0001 || Math.abs((afterUndo.clips[0]?.loopOffset ?? 0) - (before.clips[0]?.loopOffset ?? 0)) > 0.0001 || !afterUndo.canRedo) {
        throw new Error(`MIDI source reset undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-source-context-reset-after-undo.png");
      const afterRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
      if (Math.abs(afterRedo.offset) > 0.0001 || Math.abs((afterRedo.clips[0]?.loopOffset ?? 0)) > 0.0001 || !afterRedo.canUndo) {
        throw new Error(`MIDI source reset redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-source-context-reset-after-redo.png");
      checks.push({ name: "reset-source-offset", status: "passed", before, after, afterUndo, afterRedo, screenshots: [beforeShot, menuShot, afterShot, undoShot, redoShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        duration: 2,
        sourceLength: 4,
        loopLength: 4,
        loopEnabled: false,
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-source-context-length-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await hoverContextMenuLabel(cdp, "MIDI Source");
      await activateContextMenuLabel(cdp, "Source Length = Item");
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      if (Math.abs((after.clips[0]?.sourceLength ?? 0) - before.duration) > 0.0001 || Math.abs((after.clips[0]?.loopLength ?? 0) - before.duration) > 0.0001 || !after.canUndo) {
        throw new Error(`MIDI source length=item context action failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-source-context-length-after.png");
      const afterUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
      if (Math.abs((afterUndo.clips[0]?.sourceLength ?? 0) - (before.clips[0]?.sourceLength ?? 0)) > 0.0001 || Math.abs((afterUndo.clips[0]?.loopLength ?? 0) - (before.clips[0]?.loopLength ?? 0)) > 0.0001 || !afterUndo.canRedo) {
        throw new Error(`MIDI source length=item undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-source-context-length-after-undo.png");
      const afterRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
      if (Math.abs((afterRedo.clips[0]?.sourceLength ?? 0) - before.duration) > 0.0001 || Math.abs((afterRedo.clips[0]?.loopLength ?? 0) - before.duration) > 0.0001 || !afterRedo.canUndo) {
        throw new Error(`MIDI source length=item redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-source-context-length-after-redo.png");
      checks.push({ name: "source-length-item", status: "passed", before, after, afterUndo, afterRedo, screenshots: [beforeShot, afterShot, undoShot, redoShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        duration: 2,
        sourceLength: 4,
        loopLength: 4,
        loopEnabled: false,
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-source-context-content-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await hoverContextMenuLabel(cdp, "MIDI Source");
      await activateContextMenuLabel(cdp, "Source Length = Content");
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const sourceLength = after.clips[0]?.sourceLength ?? 0;
      const loopLength = after.clips[0]?.loopLength ?? 0;
      if (Math.abs(sourceLength - 0.95) > 0.0001 || Math.abs(loopLength - 0.95) > 0.0001 || !after.canUndo) {
        throw new Error(`MIDI source length=content context action failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-source-context-content-after.png");
      const afterUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
      if (Math.abs((afterUndo.clips[0]?.sourceLength ?? 0) - (before.clips[0]?.sourceLength ?? 0)) > 0.0001 || Math.abs((afterUndo.clips[0]?.loopLength ?? 0) - (before.clips[0]?.loopLength ?? 0)) > 0.0001 || !afterUndo.canRedo) {
        throw new Error(`MIDI source length=content undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-source-context-content-after-undo.png");
      const afterRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
      if (Math.abs((afterRedo.clips[0]?.sourceLength ?? 0) - 0.95) > 0.0001 || Math.abs((afterRedo.clips[0]?.loopLength ?? 0) - 0.95) > 0.0001 || !afterRedo.canUndo) {
        throw new Error(`MIDI source length=content redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-source-context-content-after-redo.png");
      checks.push({ name: "source-length-content", status: "passed", before, after, afterUndo, afterRedo, screenshots: [beforeShot, afterShot, undoShot, redoShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  {
    const cdp = await openTab(args, 1280, 520);
    try {
      const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
        duration: 2,
        sourceLength: 4,
        loopLength: 4,
        loopEnabled: false,
      }));
      const beforeShot = await screenshot(cdp, args.outDir, "timeline-source-context-custom-before.png");
      const centerX = Math.round((before.start + before.duration / 2) * 110);
      await contextClick(cdp, centerX, 70);
      await hoverContextMenuLabel(cdp, "MIDI Source");
      await activateContextMenuLabel(cdp, "Set Source Length...");
      await setInputValue(cdp, "#timeline-midi-source-length-input", 3.25);
      const applied = await evalInPage(cdp, `
        (() => {
          const buttons = [...document.querySelectorAll('button')];
          const button = buttons.find((candidate) => candidate.textContent.trim() === 'Apply');
          if (!button) return false;
          button.click();
          return true;
        })()
      `);
      if (!applied) throw new Error("Could not apply custom source length dialog");
      await sleep(220);
      const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
      const sourceLength = after.clips[0]?.sourceLength ?? 0;
      const loopLength = after.clips[0]?.loopLength ?? 0;
      if (Math.abs(sourceLength - 3.25) > 0.0001 || Math.abs(loopLength - 3.25) > 0.0001 || !after.canUndo) {
        throw new Error(`MIDI custom source length dialog failed: ${JSON.stringify({ before, after })}`);
      }
      const afterShot = await screenshot(cdp, args.outDir, "timeline-source-context-custom-after.png");
      const afterUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
      if (Math.abs((afterUndo.clips[0]?.sourceLength ?? 0) - (before.clips[0]?.sourceLength ?? 0)) > 0.0001 || Math.abs((afterUndo.clips[0]?.loopLength ?? 0) - (before.clips[0]?.loopLength ?? 0)) > 0.0001 || !afterUndo.canRedo) {
        throw new Error(`MIDI custom source length undo failed: ${JSON.stringify({ before, after, afterUndo })}`);
      }
      const undoShot = await screenshot(cdp, args.outDir, "timeline-source-context-custom-after-undo.png");
      const afterRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
      if (Math.abs((afterRedo.clips[0]?.sourceLength ?? 0) - 3.25) > 0.0001 || Math.abs((afterRedo.clips[0]?.loopLength ?? 0) - 3.25) > 0.0001 || !afterRedo.canUndo) {
        throw new Error(`MIDI custom source length redo failed: ${JSON.stringify({ before, after, afterUndo, afterRedo })}`);
      }
      const redoShot = await screenshot(cdp, args.outDir, "timeline-source-context-custom-after-redo.png");
      checks.push({ name: "custom-source-length-dialog", status: "passed", before, after, afterUndo, afterRedo, screenshots: [beforeShot, afterShot, undoShot, redoShot] });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "timeline-source-context",
    status: "passed",
    checks,
  };
}

async function runTimelineBackendPayload(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/Timeline.tsx");
  const cdp = await openTab(args, 1280, 520);
  try {
    const before = await evalInPage(cdp, timelineFixtureExpression(args.baseUrl, storeUrl, {
      duration: 2,
      sourceLength: 1,
      loopEnabled: true,
      loopLength: 1,
    }));
    const beforeShot = await screenshot(cdp, args.outDir, "timeline-backend-payload-before.png");

    const rightEdgeX = Math.round((before.start + before.duration) * 110);
    await drag(cdp, rightEdgeX - 3, 70, rightEdgeX + 92, 70, { settleMs: 500 });
    const after = await evalInPage(cdp, timelineStateExpression(storeUrl));
    if (!(after.duration > before.duration + 0.2)) {
      throw new Error(`Timeline backend payload setup did not resize the MIDI item enough: ${JSON.stringify({ before, after })}`);
    }

    const bridgeResult = await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        const bridgeModule = await import('${args.baseUrl}/src/services/NativeBridge.ts');
        const serializationModule = await import('${args.baseUrl}/src/utils/midiClipSerialization.ts');
        const state = useDAWStore.getState();
        const track = state.tracks.find((candidate) => candidate.id === 'qa-midi-track');
        const direct = serializationModule.serializeMIDIClipsForBackend(track?.midiClips || [], track?.midiEffects || []);
        const original = bridgeModule.nativeBridge.setTrackMIDIClips;
        window.__studio13LastMIDIBackendPayload = null;
        bridgeModule.nativeBridge.setTrackMIDIClips = async (trackId, clips) => {
          window.__studio13LastMIDIBackendPayload = {
            trackId,
            clips: JSON.parse(JSON.stringify(clips)),
          };
          return true;
        };
        await useDAWStore.getState().syncMIDITrackToBackend('qa-midi-track', { debounce: false });
        bridgeModule.nativeBridge.setTrackMIDIClips = original;
        return {
          direct,
          payload: window.__studio13LastMIDIBackendPayload,
          clipState: track?.midiClips?.[0] || null,
        };
      })()
    `);

    const payload = bridgeResult?.payload;
    const payloadClips = payload?.clips || [];
    const payloadClip = payloadClips.find((clip) => clip.id === "qa-midi-clip");
    const events = payloadClip?.events || [];
    if (payload?.trackId !== "qa-midi-track" || !payloadClip) {
      throw new Error(`MIDI backend bridge payload was not captured for the edited track: ${JSON.stringify(bridgeResult)}`);
    }
    if (JSON.stringify(payloadClips) !== JSON.stringify(bridgeResult.direct)) {
      throw new Error(`Bridge payload diverged from serializeMIDIClipsForBackend output: ${JSON.stringify(bridgeResult)}`);
    }
    if (Math.abs(payloadClip.duration - after.duration) > 0.001) {
      throw new Error(`Serialized MIDI clip duration does not match edited item duration: ${JSON.stringify({ after, payloadClip })}`);
    }
    if (!events.every((event) => event.timestamp >= -0.0001 && event.timestamp <= after.duration + 0.0001)) {
      throw new Error(`Serialized MIDI events escaped the visible item window: ${JSON.stringify({ after, events })}`);
    }
    if (!events.some((event) => event.timestamp > 1.05)) {
      throw new Error(`Serialized MIDI payload did not include loop-resolved events past the source length: ${JSON.stringify({ after, events })}`);
    }
    if (!events.some((event) => event.type === "noteOn" && event.channel === 2)) {
      throw new Error(`Serialized MIDI payload did not preserve per-event note channel: ${JSON.stringify(events)}`);
    }
    if (!events.some((event) => event.type === "noteOff" && event.channel === 2 && event.releaseVelocity === 20)) {
      throw new Error(`Serialized MIDI payload did not preserve note-off release velocity: ${JSON.stringify(events)}`);
    }
    if (!events.some((event) => event.type === "pitchBend" && event.value === 10600 && event.channel === 1)) {
      throw new Error(`Serialized MIDI payload did not preserve pitchbend events: ${JSON.stringify(events)}`);
    }
    if (!events.some((event) => event.type === "cc" && event.controller === 33 && event.channel === 1)) {
      throw new Error(`Serialized MIDI payload did not preserve controller lane events: ${JSON.stringify(events)}`);
    }
    if (!events.some((event) => event.probability !== undefined || event.velocityVariance !== undefined || event.playCount !== undefined)) {
      throw new Error(`Serialized MIDI payload did not preserve MIDI metadata fields: ${JSON.stringify(events)}`);
    }

    const afterShot = await screenshot(cdp, args.outDir, "timeline-backend-payload-after.png");
    return {
      scenario: "timeline-backend-payload",
      status: "passed",
      before,
      after,
      eventCount: events.length,
      metadataEventCount: events.filter((event) => event.probability !== undefined || event.velocityVariance !== undefined || event.playCount !== undefined).length,
      screenshots: [beforeShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

function pianoFixtureExpression(baseUrl, storeUrl, options = {}) {
  const config = {
    activeLaneId: "pitch-bend",
    includeAdditionalClip: false,
    ...options,
  };

  return `
    (async () => {
      ${pagePrelude()}
      const storeModule = await import('${storeUrl}');
      const pianoModule = await import('${baseUrl}/src/components/PianoRoll.tsx');
      const { useDAWStore, createDefaultTrack, DEFAULT_PIANO_ROLL_VISIBLE_LANES } = storeModule;
      window.__studio13QADAWStore = useDAWStore;
      const fixtureConfig = ${JSON.stringify(config)};
      const track = createDefaultTrack('qa-track', 'QA Instrument', '#5bc0de', 'instrument');
      track.midiPitchBendRangeUp = 12;
      track.midiPitchBendRangeDown = 7;
      track.midiPitchBendRangeLinked = false;
      track.samplerSamplePath = 'qa/piano-sample.wav';
      track.samplerRootNote = 60;
      track.midiEffects = [{ id: 'arp', type: 'arpeggiator', enabled: true, rateSeconds: 0.125, gate: 0.8, mode: 'up' }];
      track.midiClips = [{
        id: 'qa-clip',
        name: 'Looped Chords',
        startTime: 0,
        duration: 8,
        offset: 0,
        sourceStart: 0,
        sourceLength: 2,
        loopEnabled: true,
        loopOffset: 0,
        loopLength: 2,
        color: '#49a7c7',
        events: [
          { type: 'noteOn', timestamp: 0.00, note: 60, velocity: 88, channel: 1, probability: 0.92, velocityVariance: 7, centOffset: -3 },
          { type: 'noteOff', timestamp: 0.75, note: 60, velocity: 42, releaseVelocity: 42, channel: 1 },
          { type: 'noteOn', timestamp: 0.25, note: 64, velocity: 76, channel: 2, probability: 0.8, playCount: 3 },
          { type: 'noteOff', timestamp: 1.0, note: 64, velocity: 38, releaseVelocity: 38, channel: 2 },
          { type: 'noteOn', timestamp: 0.50, note: 67, velocity: 104, channel: 3, velocityVariance: 10 },
          { type: 'noteOff', timestamp: 1.35, note: 67, velocity: 55, releaseVelocity: 55, channel: 3 },
          { type: 'pitchBend', timestamp: 0.0, value: 8192, channel: 1 },
          { type: 'pitchBend', timestamp: 0.5, value: 10600, channel: 1 },
          { type: 'channelPressure', timestamp: 0.35, value: 54, channel: 1 },
          { type: 'polyPressure', timestamp: 0.7, note: 64, value: 86, channel: 2 },
          { type: 'programChange', timestamp: 0.0, value: 12, channel: 1 }
        ],
        ccEvents: [
          { cc: 1, time: 0.0, value: 18, channel: 1 },
          { cc: 1, time: 0.5, value: 96, channel: 1 },
          { cc: 33, time: 0.5, value: 12, channel: 1 }
        ]
      }];
      if (fixtureConfig.includeAdditionalClip) {
        track.midiClips.push({
          id: 'qa-clip-b',
          name: 'Counter Melody',
          startTime: 1,
          duration: 4,
          offset: 0,
          sourceStart: 0,
          sourceLength: 2,
          loopEnabled: true,
          loopOffset: 0,
          loopLength: 2,
          color: '#ff6b9d',
          events: [
            { type: 'noteOn', timestamp: 0.10, note: 72, velocity: 91, channel: 4 },
            { type: 'noteOff', timestamp: 0.70, note: 72, velocity: 34, releaseVelocity: 34, channel: 4 },
            { type: 'noteOn', timestamp: 0.90, note: 74, velocity: 84, channel: 4 },
            { type: 'noteOff', timestamp: 1.35, note: 74, velocity: 30, releaseVelocity: 30, channel: 4 }
          ],
          ccEvents: []
        });
      }
      const pianoClipIds = fixtureConfig.includeAdditionalClip ? ['qa-clip', 'qa-clip-b'] : ['qa-clip'];
      useDAWStore.setState({
        tracks: [track],
        showPianoRoll: true,
        pianoRollTrackId: 'qa-track',
        pianoRollClipId: 'qa-clip',
        selectedClipIds: pianoClipIds,
        selectedNoteIds: ['qa-clip:0.000000:60'],
        pianoRollVisibleLanes: [
          ...DEFAULT_PIANO_ROLL_VISIBLE_LANES,
          { id: 'chance', kind: 'chance', label: 'Chance', height: 68, interpolation: 'step' },
          { id: 'off-vel', kind: 'noteOffVelocity', label: 'Note-Off Velocity', height: 68, interpolation: 'step' },
          { id: 'variance', kind: 'velocityVariance', label: 'Velocity Variance', height: 68, interpolation: 'step' },
          { id: 'cc14-1', kind: 'cc14', label: '14-bit CC#1/33', height: 84, cc: 1, interpolation: 'curve' }
        ],
        pianoRollActiveLaneId: fixtureConfig.activeLaneId,
        pixelsPerSecond: 200,
        scrollX: 0,
        transport: { ...useDAWStore.getState().transport, tempo: 120 },
      });
      function Harness() {
        const activeClipId = useDAWStore((state) => state.pianoRollClipId || 'qa-clip');
        const additionalClipIds = pianoClipIds.filter((candidate) => candidate !== activeClipId);
        return React.createElement(pianoModule.PianoRoll, { trackId: 'qa-track', clipId: activeClipId, additionalClipIds });
      }
      const root = ReactDOM.createRoot(document.getElementById('qa-root'));
      root.render(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const state = useDAWStore.getState();
      const note = useDAWStore.getState().tracks[0].midiClips[0].events.find((event) => event.type === 'noteOn' && event.note === 60);
      const noteOff = useDAWStore.getState().tracks[0].midiClips[0].events.find((event) => event.type === 'noteOff' && event.note === 60);
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const activeLane = (state.pianoRollVisibleLanes || []).find((lane) => lane.id === state.pianoRollActiveLaneId) || null;
      return {
        noteStart: note.timestamp,
        noteEnd: noteOff.timestamp,
        noteDuration: noteOff.timestamp - note.timestamp,
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        hasEditor: Boolean(document.querySelector('.piano-roll')),
        laneRows: document.querySelectorAll('.piano-roll-lane-row').length,
        activeClipId: useDAWStore.getState().pianoRollClipId,
        clipCount: useDAWStore.getState().tracks[0].midiClips.length,
        activeLane,
      };
    })()
  `;
}

function pianoStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const note = useDAWStore.getState().tracks[0].midiClips[0].events.find((event) => event.type === 'noteOn' && event.note === 60);
      return {
        noteStart: note.timestamp,
        canUndo: useDAWStore.getState().canUndo,
        selectedNoteIds: useDAWStore.getState().selectedNoteIds,
      };
    })()
  `;
}

function pianoDetailedStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const events = state.tracks[0].midiClips[0].events;
      const clipId = state.tracks[0].midiClips[0].id;
      const used = new Set();
      const pairs = [];
      const noteIdFor = (start, note) => clipId + ':' + Number(start).toFixed(6) + ':' + note;
      for (const noteOn of events.filter((event) => event.type === 'noteOn')) {
        let bestIndex = -1;
        let best = null;
        events.forEach((event, index) => {
          if (
            used.has(index)
            || event.type !== 'noteOff'
            || event.note !== noteOn.note
            || (event.channel ?? 1) !== (noteOn.channel ?? 1)
            || event.timestamp <= noteOn.timestamp
          ) return;
          if (!best || event.timestamp < best.timestamp) {
            best = event;
            bestIndex = index;
          }
        });
        if (!best) continue;
        used.add(bestIndex);
        pairs.push({
          id: noteIdFor(noteOn.timestamp, noteOn.note),
          note: noteOn.note,
          start: noteOn.timestamp,
          end: best.timestamp,
          duration: best.timestamp - noteOn.timestamp,
          velocity: noteOn.velocity,
          channel: noteOn.channel ?? 1,
          offChannel: best.channel ?? 1,
          probability: noteOn.probability,
          playCount: noteOn.playCount,
          velocityVariance: noteOn.velocityVariance,
          centOffset: noteOn.centOffset,
          releaseVelocity: best.releaseVelocity ?? best.velocity,
          muted: Boolean(noteOn.muted || best.muted),
        });
      }
      const selectedPairs = pairs.filter((pair) => state.selectedNoteIds.includes(pair.id));
      const inspected = selectedPairs.length === 1 ? selectedPairs[0] : (selectedPairs[0] || pairs[0] || null);
      return {
        pairs,
        selectedPairs,
        selectedCount: selectedPairs.length,
        note: inspected?.note,
        start: inspected?.start,
        duration: inspected?.duration,
        velocity: inspected?.velocity,
        channel: inspected?.channel,
        offChannel: inspected?.offChannel,
        probability: inspected?.probability,
        playCount: inspected?.playCount,
        velocityVariance: inspected?.velocityVariance,
        centOffset: inspected?.centOffset,
        releaseVelocity: inspected?.releaseVelocity,
        muted: inspected?.muted,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        selectedNoteIds: state.selectedNoteIds,
      };
    })()
  `;
}

function pianoSelectFirstTwoNotesExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips[0];
      const noteOns = clip.events
        .filter((event) => event.type === 'noteOn')
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp || a.note - b.note);
      const ids = noteOns.slice(0, 2).map((event) => clip.id + ':' + Number(event.timestamp).toFixed(6) + ':' + event.note);
      useDAWStore.getState().setSelectedNoteIds(ids);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const velocityInput = document.querySelector('#pr-ins-note-velocity');
      const channelInput = document.querySelector('#pr-ins-note-channel');
      return {
        ids,
        velocityValue: velocityInput?.value ?? null,
        velocityPlaceholder: velocityInput?.getAttribute('placeholder') ?? null,
        channelValue: channelInput?.value ?? null,
        selectedNoteIds: useDAWStore.getState().selectedNoteIds,
      };
    })()
  `;
}

function pianoUndoRedoDetailedStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = useDAWStore.getState();
      const events = state.tracks[0].midiClips[0].events;
      const clipId = state.tracks[0].midiClips[0].id;
      const used = new Set();
      const pairs = [];
      const noteIdFor = (start, note) => clipId + ':' + Number(start).toFixed(6) + ':' + note;
      for (const noteOn of events.filter((event) => event.type === 'noteOn')) {
        let bestIndex = -1;
        let best = null;
        events.forEach((event, index) => {
          if (
            used.has(index)
            || event.type !== 'noteOff'
            || event.note !== noteOn.note
            || (event.channel ?? 1) !== (noteOn.channel ?? 1)
            || event.timestamp <= noteOn.timestamp
          ) return;
          if (!best || event.timestamp < best.timestamp) {
            best = event;
            bestIndex = index;
          }
        });
        if (!best) continue;
        used.add(bestIndex);
        pairs.push({
          id: noteIdFor(noteOn.timestamp, noteOn.note),
          note: noteOn.note,
          start: noteOn.timestamp,
          end: best.timestamp,
          duration: best.timestamp - noteOn.timestamp,
          velocity: noteOn.velocity,
          channel: noteOn.channel ?? 1,
          offChannel: best.channel ?? 1,
          probability: noteOn.probability,
          playCount: noteOn.playCount,
          velocityVariance: noteOn.velocityVariance,
          centOffset: noteOn.centOffset,
          releaseVelocity: best.releaseVelocity ?? best.velocity,
          muted: Boolean(noteOn.muted || best.muted),
        });
      }
      const selectedPairs = pairs.filter((pair) => state.selectedNoteIds.includes(pair.id));
      const inspected = selectedPairs.length === 1 ? selectedPairs[0] : (selectedPairs[0] || pairs[0] || null);
      return {
        pairs,
        selectedPairs,
        selectedCount: selectedPairs.length,
        note: inspected?.note,
        start: inspected?.start,
        duration: inspected?.duration,
        velocity: inspected?.velocity,
        channel: inspected?.channel,
        offChannel: inspected?.offChannel,
        probability: inspected?.probability,
        playCount: inspected?.playCount,
        velocityVariance: inspected?.velocityVariance,
        centOffset: inspected?.centOffset,
        releaseVelocity: inspected?.releaseVelocity,
        muted: inspected?.muted,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        selectedNoteIds: state.selectedNoteIds,
      };
    })()
  `;
}

function pianoNoteMetadataLaneStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips[0];
      const noteOn = clip.events.find((event) => event.type === 'noteOn' && event.note === 60);
      const noteOff = clip.events.find((event) => event.type === 'noteOff' && event.note === 60);
      const activeLane = (state.pianoRollVisibleLanes || []).find((lane) => lane.id === state.pianoRollActiveLaneId) || null;
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        activeLane,
        laneLabels: (state.pianoRollVisibleLanes || []).map((lane) => lane.label),
        releaseVelocity: noteOff?.releaseVelocity ?? noteOff?.velocity,
        probabilityPercent: Math.round(((noteOn?.probability ?? noteOn?.chance ?? 1) > 1 ? (noteOn?.probability ?? noteOn?.chance ?? 1) / 100 : (noteOn?.probability ?? noteOn?.chance ?? 1)) * 100),
        velocityVariance: noteOn?.velocityVariance ?? 0,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        disabledCommands: [...document.querySelectorAll('.piano-roll-command-grid button:disabled')].map((button) => normalize(button.textContent)),
      };
    })()
  `;
}

function pianoNoteMetadataLaneUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips[0];
      const noteOn = clip.events.find((event) => event.type === 'noteOn' && event.note === 60);
      const noteOff = clip.events.find((event) => event.type === 'noteOff' && event.note === 60);
      const activeLane = (state.pianoRollVisibleLanes || []).find((lane) => lane.id === state.pianoRollActiveLaneId) || null;
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        activeLane,
        laneLabels: (state.pianoRollVisibleLanes || []).map((lane) => lane.label),
        releaseVelocity: noteOff?.releaseVelocity ?? noteOff?.velocity,
        probabilityPercent: Math.round(((noteOn?.probability ?? noteOn?.chance ?? 1) > 1 ? (noteOn?.probability ?? noteOn?.chance ?? 1) / 100 : (noteOn?.probability ?? noteOn?.chance ?? 1)) * 100),
        velocityVariance: noteOn?.velocityVariance ?? 0,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        disabledCommands: [...document.querySelectorAll('.piano-roll-command-grid button:disabled')].map((button) => normalize(button.textContent)),
      };
    })()
  `;
}

function pianoToolStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const events = state.tracks[0].midiClips[0].events;
      const used = new Set();
      const pairs = [];
      for (const noteOn of events.filter((event) => event.type === 'noteOn')) {
        let bestIndex = -1;
        let best = null;
        events.forEach((event, index) => {
          if (
            used.has(index)
            || event.type !== 'noteOff'
            || event.note !== noteOn.note
            || (event.channel ?? 1) !== (noteOn.channel ?? 1)
            || event.timestamp <= noteOn.timestamp
          ) return;
          if (!best || event.timestamp < best.timestamp) {
            best = event;
            bestIndex = index;
          }
        });
        if (!best) continue;
        used.add(bestIndex);
        pairs.push({
          note: noteOn.note,
          start: noteOn.timestamp,
          end: best.timestamp,
          duration: best.timestamp - noteOn.timestamp,
          velocity: noteOn.velocity,
          muted: Boolean(noteOn.muted || best.muted),
          channel: noteOn.channel ?? 1,
        });
      }
      return {
        pairCount: pairs.length,
        pairs,
        selectedNoteIds: state.selectedNoteIds,
        midiEditRange: state.midiEditRange,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        activeMidiTool: state.activeMidiTool,
      };
    })()
  `;
}

function pianoControllerLaneStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips[0];
      const cc1 = (clip.ccEvents || [])
        .filter((event) => event.cc === 1)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value }));
      const cc33 = (clip.ccEvents || []).filter((event) => event.cc === 33);
      const cc74 = (clip.ccEvents || [])
        .filter((event) => event.cc === 74)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value }));
      const values = cc1.map((event) => event.value);
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const pasteButton = [...document.querySelectorAll('.piano-roll-inspector button')]
        .find((button) => normalize(button.textContent).includes('Paste'));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        selectedCC: Number(document.querySelector('#pr-ins-cc-number')?.value ?? -999),
        cc1Count: cc1.length,
        cc1,
        cc1Values: values,
        cc1Min: values.length ? Math.min(...values) : null,
        cc1Max: values.length ? Math.max(...values) : null,
        cc33Count: cc33.length,
        cc74Count: cc74.length,
        cc74,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        promptCalls: window.__studio13QAPromptCalls || 0,
        pasteDisabled: pasteButton ? pasteButton.disabled : null,
      };
    })()
  `;
}

function pianoControllerLaneUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips[0];
      const cc1 = (clip.ccEvents || [])
        .filter((event) => event.cc === 1)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value }));
      const cc33 = (clip.ccEvents || []).filter((event) => event.cc === 33);
      const cc74 = (clip.ccEvents || [])
        .filter((event) => event.cc === 74)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value }));
      const values = cc1.map((event) => event.value);
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const pasteButton = [...document.querySelectorAll('.piano-roll-inspector button')]
        .find((button) => normalize(button.textContent).includes('Paste'));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        selectedCC: Number(document.querySelector('#pr-ins-cc-number')?.value ?? -999),
        cc1Count: cc1.length,
        cc1,
        cc1Values: values,
        cc1Min: values.length ? Math.min(...values) : null,
        cc1Max: values.length ? Math.max(...values) : null,
        cc33Count: cc33.length,
        cc74Count: cc74.length,
        cc74,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        promptCalls: window.__studio13QAPromptCalls || 0,
        pasteDisabled: pasteButton ? pasteButton.disabled : null,
      };
    })()
  `;
}

function pianoAuditionInsertStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const events = state.tracks[0].midiClips[0].events;
      const used = new Set();
      const pairs = [];
      for (const noteOn of events.filter((event) => event.type === 'noteOn')) {
        let bestIndex = -1;
        let best = null;
        events.forEach((event, index) => {
          if (
            used.has(index)
            || event.type !== 'noteOff'
            || event.note !== noteOn.note
            || (event.channel ?? 1) !== (noteOn.channel ?? 1)
            || event.timestamp <= noteOn.timestamp
          ) return;
          if (!best || event.timestamp < best.timestamp) {
            best = event;
            bestIndex = index;
          }
        });
        if (!best) continue;
        used.add(bestIndex);
        pairs.push({
          note: noteOn.note,
          start: noteOn.timestamp,
          duration: best.timestamp - noteOn.timestamp,
          velocity: noteOn.velocity,
        });
      }
      return {
        insertVelocity: state.pianoRollInsertVelocity,
        auditionEnabled: state.pianoRollAuditionEnabled,
        insertVelocityInput: document.querySelector('#pr-insert-velocity')?.value ?? null,
        auditionButtonLabel: document.querySelector('button[aria-label*="MIDI note audition"]')?.getAttribute('aria-label') ?? null,
        pairs,
        auditionCalls: window.__studio13QAAuditionCalls || [],
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoAuditionInsertUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = useDAWStore.getState();
      const events = state.tracks[0].midiClips[0].events;
      const used = new Set();
      const pairs = [];
      for (const noteOn of events.filter((event) => event.type === 'noteOn')) {
        let bestIndex = -1;
        let best = null;
        events.forEach((event, index) => {
          if (
            used.has(index)
            || event.type !== 'noteOff'
            || event.note !== noteOn.note
            || (event.channel ?? 1) !== (noteOn.channel ?? 1)
            || event.timestamp <= noteOn.timestamp
          ) return;
          if (!best || event.timestamp < best.timestamp) {
            best = event;
            bestIndex = index;
          }
        });
        if (!best) continue;
        used.add(bestIndex);
        pairs.push({
          note: noteOn.note,
          start: noteOn.timestamp,
          duration: best.timestamp - noteOn.timestamp,
          velocity: noteOn.velocity,
        });
      }
      return {
        insertVelocity: state.pianoRollInsertVelocity,
        auditionEnabled: state.pianoRollAuditionEnabled,
        insertVelocityInput: document.querySelector('#pr-insert-velocity')?.value ?? null,
        auditionButtonLabel: document.querySelector('button[aria-label*="MIDI note audition"]')?.getAttribute('aria-label') ?? null,
        pairs,
        auditionCalls: window.__studio13QAAuditionCalls || [],
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoNavigationToolsStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const scrollbar = document.querySelector('.piano-roll-horizontal-scroll');
      return {
        activeTool: state.activeMidiTool,
        activeLaneId: state.pianoRollActiveLaneId,
        zoomValue: state.pixelsPerSecond,
        storeScrollX: state.scrollX,
        scrollLeft: scrollbar ? scrollbar.scrollLeft : null,
        scrollWidth: scrollbar ? scrollbar.scrollWidth : null,
        clientWidth: scrollbar ? scrollbar.clientWidth : null,
        lineDialogOpen: Boolean(document.querySelector('.piano-roll-controller-dialog')),
        promptCalls: window.__studio13QAPromptCalls || 0,
      };
    })()
  `;
}

function pianoSourceHeaderStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const clip = state.tracks[0].midiClips.find((candidate) => candidate.id === state.pianoRollClipId) || state.tracks[0].midiClips[0];
      const canvas = document.querySelector('canvas')?.getBoundingClientRect();
      return {
        sourceLength: clip.sourceLength,
        loopLength: clip.loopLength,
        loopOffset: clip.loopOffset ?? 0,
        duration: clip.duration,
        loopEnabled: Boolean(clip.loopEnabled),
        noteBeyondSource: (clip.events || []).some((event) => event.timestamp >= 5 && event.note === 72),
        inputValue: document.querySelector('[data-qa="piano-roll-source-length-input"]')?.value ?? null,
        itemReadout: document.querySelector('[data-qa="piano-roll-item-length-readout"]')?.textContent ?? null,
        hasHeader: Boolean(document.querySelector('[data-qa="piano-roll-source-header"]')),
        canvas: canvas ? { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height } : null,
        pixelsPerSecond: state.pixelsPerSecond,
        scrollX: state.scrollX,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoCCDirectStateExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const cc1 = (clip.ccEvents || [])
        .filter((event) => event.cc === 1)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value, channel: event.channel ?? 1 }));
      const cc74 = (clip.ccEvents || [])
        .filter((event) => event.cc === 74)
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((event) => ({ time: event.time, value: event.value, channel: event.channel ?? 1 }));
      const payload = serializationModule.serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []);
      const backendCC1 = (payload.find((candidate) => candidate.id === 'qa-clip')?.events || [])
        .filter((event) => event.type === 'cc' && event.controller === 1)
        .map((event) => ({ timestamp: event.timestamp, value: event.value, channel: event.channel }));
      const backendCC74 = (payload.find((candidate) => candidate.id === 'qa-clip')?.events || [])
        .filter((event) => event.type === 'cc' && event.controller === 74)
        .map((event) => ({ timestamp: event.timestamp, value: event.value, channel: event.channel }));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        selectedCC: Number(document.querySelector('#pr-ins-cc-number')?.value ?? -999),
        cc1Count: cc1.length,
        cc1,
        cc1Values: cc1.map((event) => event.value),
        cc74Count: cc74.length,
        cc74,
        cc74Values: cc74.map((event) => event.value),
        backendCC1,
        backendCC74,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoLaneManagementStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const lanes = (state.pianoRollVisibleLanes || []).map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        label: lane.label,
        cc: lane.cc,
        height: lane.height,
        interpolation: lane.interpolation,
      }));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        activeLane: lanes.find((lane) => lane.id === state.pianoRollActiveLaneId) ?? null,
        lanes,
        laneLabels: lanes.map((lane) => lane.label),
        cc1Count: (clip.ccEvents || []).filter((event) => event.cc === 1).length,
        cc33Count: (clip.ccEvents || []).filter((event) => event.cc === 33).length,
        pitchBendRangeUp: track.midiPitchBendRangeUp,
        pitchBendRangeDown: track.midiPitchBendRangeDown,
        pitchBendRangeLinked: track.midiPitchBendRangeLinked,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoLaneManagementUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const lanes = (state.pianoRollVisibleLanes || []).map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        label: lane.label,
        cc: lane.cc,
        height: lane.height,
        interpolation: lane.interpolation,
      }));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        activeLane: lanes.find((lane) => lane.id === state.pianoRollActiveLaneId) ?? null,
        lanes,
        laneLabels: lanes.map((lane) => lane.label),
        cc1Count: (clip.ccEvents || []).filter((event) => event.cc === 1).length,
        cc33Count: (clip.ccEvents || []).filter((event) => event.cc === 33).length,
        pitchBendRangeUp: track.midiPitchBendRangeUp,
        pitchBendRangeDown: track.midiPitchBendRangeDown,
        pitchBendRangeLinked: track.midiPitchBendRangeLinked,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoAdvancedLaneStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const events = clip.events || [];
      const ccEvents = clip.ccEvents || [];
      const valuesFor = (type) => events
        .filter((event) => event.type === type)
        .map((event) => ({ time: event.timestamp, value: event.value, note: event.note, channel: event.channel }));
      const pitchBends = valuesFor('pitchBend');
      const pitchValues = valuesFor('pitchBend').map((event) => event.value);
      const cc0 = ccEvents.filter((event) => event.cc === 0).map((event) => ({ time: event.time, value: event.value }));
      const cc1 = ccEvents.filter((event) => event.cc === 1).map((event) => ({ time: event.time, value: event.value }));
      const cc32 = ccEvents.filter((event) => event.cc === 32).map((event) => ({ time: event.time, value: event.value }));
      const cc33 = ccEvents.filter((event) => event.cc === 33).map((event) => ({ time: event.time, value: event.value }));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        laneLabels: (state.pianoRollVisibleLanes || []).map((lane) => lane.label),
        pitchBends,
        pitchBendCount: pitchValues.length,
        pitchBendMin: pitchValues.length ? Math.min(...pitchValues) : null,
        pitchBendMax: pitchValues.length ? Math.max(...pitchValues) : null,
        cc0Count: cc0.length,
        cc1Count: cc1.length,
        cc32Count: cc32.length,
        cc33Count: cc33.length,
        cc0,
        cc1,
        cc32,
        cc33,
        program: valuesFor('programChange'),
        channelPressure: valuesFor('channelPressure'),
        polyPressure: valuesFor('polyPressure'),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoAdvancedLaneUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 140));
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const events = clip.events || [];
      const ccEvents = clip.ccEvents || [];
      const valuesFor = (type) => events
        .filter((event) => event.type === type)
        .map((event) => ({ time: event.timestamp, value: event.value, note: event.note, channel: event.channel }));
      const pitchBends = valuesFor('pitchBend');
      const pitchValues = pitchBends.map((event) => event.value);
      const cc0 = ccEvents.filter((event) => event.cc === 0).map((event) => ({ time: event.time, value: event.value }));
      const cc1 = ccEvents.filter((event) => event.cc === 1).map((event) => ({ time: event.time, value: event.value }));
      const cc32 = ccEvents.filter((event) => event.cc === 32).map((event) => ({ time: event.time, value: event.value }));
      const cc33 = ccEvents.filter((event) => event.cc === 33).map((event) => ({ time: event.time, value: event.value }));
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        laneLabels: (state.pianoRollVisibleLanes || []).map((lane) => lane.label),
        pitchBends,
        pitchBendCount: pitchValues.length,
        pitchBendMin: pitchValues.length ? Math.min(...pitchValues) : null,
        pitchBendMax: pitchValues.length ? Math.max(...pitchValues) : null,
        cc0Count: cc0.length,
        cc1Count: cc1.length,
        cc32Count: cc32.length,
        cc33Count: cc33.length,
        cc0,
        cc1,
        cc32,
        cc33,
        program: valuesFor('programChange'),
        channelPressure: valuesFor('channelPressure'),
        polyPressure: valuesFor('polyPressure'),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoAdvancedLaneBackendPayloadExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const payload = serializationModule.serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []);
      const clip = payload.find((candidate) => candidate.id === 'qa-clip');
      const events = clip?.events || [];
      return {
        clipCount: payload.length,
        eventCount: events.length,
        hasPitchBend: events.some((event) => event.type === 'pitchBend' && event.value !== 8192),
        hasBankMSB: events.some((event) => event.type === 'cc' && event.controller === 0 && (event.value === 3 || event.value === 9)),
        hasBankLSB: events.some((event) => event.type === 'cc' && event.controller === 32 && (event.value === 44 || event.value === 88)),
        hasCC14MSB: events.some((event) => event.type === 'cc' && event.controller === 1),
        hasCC14LSB: events.some((event) => event.type === 'cc' && event.controller === 33),
        hasProgram: events.some((event) => event.type === 'programChange'),
        hasChannelPressure: events.some((event) => event.type === 'channelPressure'),
        hasPolyPressure: events.some((event) => event.type === 'polyPressure' && event.note === 64),
        events: events
          .filter((event) => ['pitchBend', 'cc', 'programChange', 'channelPressure', 'polyPressure'].includes(event.type))
          .slice(0, 80),
      };
    })()
  `;
}

function pianoPitchBendDirectStateExpression(baseUrl, storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const controllerModule = await import('${baseUrl}/src/utils/midiControllerLanes.ts');
      const serializationModule = await import('${baseUrl}/src/utils/midiClipSerialization.ts');
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const clip = track.midiClips[0];
      const pitchBends = (clip.events || [])
        .filter((event) => event.type === 'pitchBend')
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((event) => {
          const value = event.value ?? event.pitchBend ?? 8192;
          return {
            time: event.timestamp,
            value,
            channel: event.channel ?? 1,
            semitones: Number(controllerModule.pitchBendValueToSemitonesWithRange(
              value,
              track.midiPitchBendRangeUp,
              track.midiPitchBendRangeDown,
            ).toFixed(4)),
          };
        });
      const payload = serializationModule.serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []);
      const backendPitchBends = (payload.find((candidate) => candidate.id === 'qa-clip')?.events || [])
        .filter((event) => event.type === 'pitchBend')
        .map((event) => ({ timestamp: event.timestamp, value: event.value, channel: event.channel }));
      const activeLane = (state.pianoRollVisibleLanes || []).find((lane) => lane.id === state.pianoRollActiveLaneId) || null;
      const snapInput = document.querySelector('#pr-ins-pb-snap');
      return {
        activeLaneId: state.pianoRollActiveLaneId,
        activeLane,
        pitchBendRangeUp: track.midiPitchBendRangeUp,
        pitchBendRangeDown: track.midiPitchBendRangeDown,
        snapChecked: Boolean(snapInput && snapInput.checked),
        pitchBendCount: pitchBends.length,
        pitchBends,
        backendPitchBends,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoVisualLayoutStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const rectFor = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const shell = rectFor('.piano-roll');
      const strip = rectFor('.piano-roll-key-strip');
      const infoLine = rectFor('.piano-roll-info-line');
      const editor = rectFor('.piano-roll-editor-pane');
      const inspector = rectFor('.piano-roll-inspector');
      const sidebar = rectFor('[data-qa="piano-roll-left-sidebar"]');
      const keyStrip = rectFor('[data-qa="piano-roll-key-strip"]');
      const keyViewport = rectFor('[data-qa="piano-roll-key-viewport"]');
      const ruler = rectFor('[data-qa="piano-roll-ruler"]');
      const horizontalScroll = rectFor('[data-qa="piano-roll-horizontal-scrollbar"]');
      const verticalScroll = rectFor('[data-qa="piano-roll-vertical-scrollbar"]');
      const sourceHeader = rectFor('[data-qa="piano-roll-source-header"]');
      const canvas = rectFor('canvas');
      const laneStack = rectFor('.piano-roll-lane-stack');
      const sidebarElement = document.querySelector('.piano-roll-sidebar');
      const horizontalScrollElement = document.querySelector('[data-qa="piano-roll-horizontal-scrollbar"]');
      const verticalScrollElement = document.querySelector('[data-qa="piano-roll-vertical-scrollbar"]');
      const hasOverflow = document.documentElement.scrollWidth > window.innerWidth + 2
        || document.documentElement.scrollHeight > window.innerHeight + 2;
      const intersects = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      const aligned = (a, b, epsilon = 2) => Math.abs(a - b) <= epsilon;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        shell,
        strip,
        infoLine,
        editor,
        inspector,
        sidebar,
        keyStrip,
        keyViewport,
        ruler,
        horizontalScroll,
        verticalScroll,
        sourceHeader,
        canvas,
        laneStack,
        laneRows: document.querySelectorAll('.piano-roll-lane-row').length,
        hasOverflow,
        editorInspectorOverlap: intersects(editor, inspector),
        sidebarWidthMatchesTcp: Boolean(sidebar) && Math.abs(sidebar.width - state.tcpWidth) <= 1,
        canvasStartsAfterSidebar: Boolean(canvas && sidebar) && Math.abs(canvas.left - sidebar.right - 6) <= 2,
        keyStripInsideSidebar: Boolean(keyStrip && sidebar) && keyStrip.left >= sidebar.left && keyStrip.right <= sidebar.right + 1,
        keyStripTouchesDivider: Boolean(keyStrip && sidebar) && aligned(keyStrip.right, sidebar.right, 2),
        keyViewportMatchesCanvasTop: Boolean(keyViewport && canvas) && aligned(keyViewport.top, canvas.top, 2),
        rulerMatchesCanvasLeft: Boolean(ruler && canvas) && aligned(ruler.left, canvas.left, 2),
        hasUsableHorizontalScrollbar: Boolean(horizontalScrollElement) && horizontalScrollElement.scrollWidth > horizontalScrollElement.clientWidth,
        hasUsableVerticalScrollbar: Boolean(verticalScrollElement) && verticalScrollElement.scrollHeight > verticalScrollElement.clientHeight,
        visibleControllerGraphs: Number(Boolean(canvas)),
        sidebarScrollTop: sidebarElement ? sidebarElement.scrollTop : null,
        storeScrollX: state.scrollX,
        activeLaneId: state.pianoRollActiveLaneId,
      };
    })()
  `;
}

function pianoResponsiveToolbarStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const rectFor = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const toolbar = document.querySelector('[data-qa="piano-roll-responsive-toolbar"]');
      const moreButton = document.querySelector('[data-qa="piano-roll-toolbar-more"]');
      const menu = document.querySelector('[data-qa="piano-roll-toolbar-overflow-menu"]');
      const menuHitTestMatches = (() => {
        if (!menu) return false;
        const rect = menu.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + Math.min(rect.width / 2, 32)));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + Math.min(rect.height / 2, 32)));
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && menu.contains(hit));
      })();
      const groups = [...document.querySelectorAll('[data-qa="piano-roll-toolbar-group"]')].map((element) => ({
        id: element.getAttribute('data-toolbar-group-id'),
        state: element.getAttribute('data-overflow-state'),
        text: String(element.textContent || '').replace(/\\s+/g, ' ').trim(),
        rect: rectFor(element),
      }));
      const visibleGroupIds = String(toolbar?.getAttribute('data-visible-group-ids') || '')
        .split(/\\s+/)
        .filter(Boolean);
      const overflowGroupIds = String(toolbar?.getAttribute('data-overflow-group-ids') || '')
        .split(/\\s+/)
        .filter(Boolean);
      const toolbarRect = rectFor(toolbar);
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        toolbar: toolbarRect,
        toolbarClientWidth: toolbar?.clientWidth ?? 0,
        toolbarScrollWidth: toolbar?.scrollWidth ?? 0,
        toolbarHasHorizontalOverflow: Boolean(toolbar && toolbar.scrollWidth > toolbar.clientWidth + 2),
        documentHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        moreVisible: Boolean(moreButton),
        moreRect: rectFor(moreButton),
        menuOpen: Boolean(menu),
        menuHitTestMatches,
        menuRect: rectFor(menu),
        visibleGroupIds,
        overflowGroupIds,
        groups,
        auditionEnabled: state.pianoRollAuditionEnabled,
        insertVelocity: state.pianoRollInsertVelocity,
        activeLaneId: state.pianoRollActiveLaneId,
        showSelectedRefs: Boolean(document.querySelector('[data-qa="piano-roll-toolbar-overflow-menu"] input[type="checkbox"]')),
      };
    })()
  `;
}

function pianoMultiItemStateExpression(storeUrl) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const summarize = (clipId, note) => {
        const clip = track.midiClips.find((candidate) => candidate.id === clipId);
        const noteOn = clip?.events.find((event) => event.type === 'noteOn' && event.note === note);
        const noteOff = clip?.events.find((event) => event.type === 'noteOff' && event.note === note);
        return {
          clipId,
          note,
          start: noteOn?.timestamp ?? null,
          end: noteOff?.timestamp ?? null,
          channel: noteOn?.channel ?? null,
        };
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        activeClipId: state.pianoRollClipId,
        selectedClipIds: state.selectedClipIds,
        selectedNoteIds: state.selectedNoteIds,
        refText: normalize([...document.querySelectorAll('.piano-roll-multi-clip')].map((node) => node.textContent).join(' ')),
        clip60: summarize('qa-clip', 60),
        clip72: summarize('qa-clip-b', 72),
        clip74: summarize('qa-clip-b', 74),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

function pianoMultiItemUndoRedoStateExpression(storeUrl, action) {
  return `
    (async () => {
      const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
      useDAWStore.getState().${action}();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = useDAWStore.getState();
      const track = state.tracks[0];
      const summarize = (clipId, note) => {
        const clip = track.midiClips.find((candidate) => candidate.id === clipId);
        const noteOn = clip?.events.find((event) => event.type === 'noteOn' && event.note === note);
        const noteOff = clip?.events.find((event) => event.type === 'noteOff' && event.note === note);
        return {
          clipId,
          note,
          start: noteOn?.timestamp ?? null,
          end: noteOff?.timestamp ?? null,
          channel: noteOn?.channel ?? null,
        };
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        activeClipId: state.pianoRollClipId,
        selectedClipIds: state.selectedClipIds,
        selectedNoteIds: state.selectedNoteIds,
        refText: normalize([...document.querySelectorAll('.piano-roll-multi-clip')].map((node) => node.textContent).join(' ')),
        clip60: summarize('qa-clip', 60),
        clip72: summarize('qa-clip-b', 72),
        clip74: summarize('qa-clip-b', 74),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    })()
  `;
}

async function runPianoBasic(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1024, 720);
  try {
    const closeEnough = (left, right) => Math.abs(left - right) <= 0.0001;
    const note60 = (state) => (state.pairs || []).find((pair) => pair.note === 60);
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasEditor || before.laneRows < 3) {
      throw new Error(`Piano roll did not render expected shell/lane stack: ${JSON.stringify(before)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-basic-before.png");

    const startX = Math.round(before.canvas.left + 95);
    const startY = Math.round(before.canvas.top + 340);
    await drag(cdp, startX, startY, startX + 60, startY);
    const afterDrag = await evalInPage(cdp, pianoStateExpression(storeUrl));
    if (!(afterDrag.noteStart > before.noteStart + 0.05)) {
      throw new Error(`Piano note drag failed: start ${before.noteStart} -> ${afterDrag.noteStart}`);
    }
    if (!afterDrag.canUndo) {
      throw new Error("Piano note drag did not enable undo");
    }
    const dragShot = await screenshot(cdp, args.outDir, "piano-basic-after-note-drag.png");

    const afterUndo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    const undoNote = note60(afterUndo);
    if (!undoNote || !closeEnough(undoNote.start, before.noteStart) || !closeEnough(undoNote.duration, before.noteDuration) || !afterUndo.canRedo) {
      throw new Error(`Piano note drag undo failed: ${JSON.stringify({ before, afterDrag, afterUndo })}`);
    }
    const undoShot = await screenshot(cdp, args.outDir, "piano-basic-after-note-drag-undo.png");

    const afterRedo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const redoNote = note60(afterRedo);
    if (!redoNote || !closeEnough(redoNote.start, afterDrag.noteStart) || !closeEnough(redoNote.duration, before.noteDuration) || !afterRedo.canUndo) {
      throw new Error(`Piano note drag redo failed: ${JSON.stringify({ before, afterDrag, afterUndo, afterRedo })}`);
    }
    const redoShot = await screenshot(cdp, args.outDir, "piano-basic-after-note-drag-redo.png");

    return {
      scenario: "piano-basic",
      status: "passed",
      before,
      afterDrag,
      afterUndo,
      afterRedo,
      screenshots: [beforeShot, dragShot, undoShot, redoShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoInspector(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1024, 720);
  try {
    const normalizeNumber = (value) => value == null ? null : Number(Number(value).toFixed(6));
    const pairSignature = (state) => JSON.stringify((state.pairs || [])
      .map((pair) => ({
        note: pair.note,
        start: normalizeNumber(pair.start),
        duration: normalizeNumber(pair.duration),
        velocity: pair.velocity,
        channel: pair.channel,
        offChannel: pair.offChannel,
        releaseVelocity: pair.releaseVelocity,
        probability: normalizeNumber(pair.probability),
        playCount: pair.playCount ?? null,
        velocityVariance: pair.velocityVariance ?? null,
        centOffset: pair.centOffset ?? null,
        muted: Boolean(pair.muted),
      }))
      .sort((a, b) => a.start - b.start || a.note - b.note || a.channel - b.channel));

    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoDetailedStateExpression(storeUrl));
    const beforeSignature = pairSignature(beforeState);
    const beforeShot = await screenshot(cdp, args.outDir, "piano-inspector-before.png");

    await setInputValue(cdp, "#pr-ins-note-pitch", 61);
    await setInputValue(cdp, "#pr-ins-note-start", 0.125);
    await setInputValue(cdp, "#pr-ins-note-length", 0.5);
    await setInputValue(cdp, "#pr-ins-note-velocity", 101);
    await setInputValue(cdp, "#pr-ins-note-channel", 5);
    await setInputValue(cdp, "#pr-ins-note-off", 27);
    await setInputValue(cdp, "#pr-ins-note-chance", 63);
    await setInputValue(cdp, "#pr-ins-note-var", 14);
    await setInputValue(cdp, "#pr-ins-note-plays", 4);
    await setInputValue(cdp, "#pr-ins-note-cent", -12);

    const after = await evalInPage(cdp, pianoDetailedStateExpression(storeUrl));
    const probabilityPercent = Math.round((after.probability ?? 0) * 100);
    if (
      after.note !== 61
      || Math.abs(after.start - 0.125) > 0.0001
      || Math.abs(after.duration - 0.5) > 0.0001
      || after.velocity !== 101
      || after.channel !== 5
      || after.offChannel !== 5
      || after.releaseVelocity !== 27
      || probabilityPercent !== 63
      || after.velocityVariance !== 14
      || after.playCount !== 4
      || after.centOffset !== -12
      || !after.canUndo
    ) {
      throw new Error(`Piano inspector metadata edit failed: ${JSON.stringify({ beforeState, after })}`);
    }
    const afterSignature = pairSignature(after);
    const afterShot = await screenshot(cdp, args.outDir, "piano-inspector-after.png");

    const metadataEditCount = 10;
    let afterMetadataUndo = after;
    for (let index = 0; index < metadataEditCount; index += 1) {
      afterMetadataUndo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    }
    if (pairSignature(afterMetadataUndo) !== beforeSignature || !afterMetadataUndo.canRedo) {
      throw new Error(`Piano inspector metadata undo chain failed: ${JSON.stringify({ beforeState, after, afterMetadataUndo })}`);
    }

    let afterMetadataRedo = afterMetadataUndo;
    for (let index = 0; index < metadataEditCount; index += 1) {
      afterMetadataRedo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    }
    if (pairSignature(afterMetadataRedo) !== afterSignature || !afterMetadataRedo.canUndo) {
      throw new Error(`Piano inspector metadata redo chain failed: ${JSON.stringify({ after, afterMetadataUndo, afterMetadataRedo })}`);
    }

    const mixedBefore = await evalInPage(cdp, pianoSelectFirstTwoNotesExpression(storeUrl));
    if (mixedBefore.selectedNoteIds.length !== 2 || mixedBefore.velocityValue !== "" || mixedBefore.velocityPlaceholder !== "mixed") {
      throw new Error(`Piano inspector mixed multi-note state failed: ${JSON.stringify(mixedBefore)}`);
    }

    await setInputValue(cdp, "#pr-ins-note-velocity", 90);
    const afterBatch = await evalInPage(cdp, pianoDetailedStateExpression(storeUrl));
    const selectedVelocities = afterBatch.selectedPairs.map((pair) => pair.velocity);
    if (
      afterBatch.selectedCount !== 2
      || selectedVelocities.length !== 2
      || !selectedVelocities.every((velocity) => velocity === 90)
      || !afterBatch.canUndo
    ) {
      throw new Error(`Piano inspector batch velocity edit failed: ${JSON.stringify({ mixedBefore, afterBatch })}`);
    }

    const afterUndo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    const undoVelocities = afterUndo.selectedPairs.map((pair) => pair.velocity);
    if (!afterUndo.canRedo || undoVelocities.filter((velocity) => velocity === 90).length === 2) {
      throw new Error(`Piano inspector undo did not restore previous mixed velocities: ${JSON.stringify({ afterBatch, afterUndo })}`);
    }

    const afterRedo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const redoVelocities = afterRedo.selectedPairs.map((pair) => pair.velocity);
    if (afterRedo.selectedCount !== 2 || !redoVelocities.every((velocity) => velocity === 90)) {
      throw new Error(`Piano inspector redo did not reapply batch velocity: ${JSON.stringify({ afterUndo, afterRedo })}`);
    }
    const batchShot = await screenshot(cdp, args.outDir, "piano-inspector-batch-after.png");

    return {
      scenario: "piano-inspector",
      status: "passed",
      before,
      beforeState,
      after,
      afterMetadataUndo,
      afterMetadataRedo,
      mixedBefore,
      afterBatch,
      afterUndo,
      afterRedo,
      screenshots: [beforeShot, afterShot, batchShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoTools(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1024, 720);
  let step = "start";
  try {
    const normalizeNumber = (value) => Number(Number(value ?? 0).toFixed(6));
    const pairSignature = (state) => JSON.stringify((state.pairs || [])
      .map((pair) => ({
        note: pair.note,
        start: normalizeNumber(pair.start),
        end: normalizeNumber(pair.end),
        duration: normalizeNumber(pair.duration),
        velocity: pair.velocity,
        muted: Boolean(pair.muted),
        channel: pair.channel ?? 1,
      }))
      .sort((a, b) => a.note - b.note || a.start - b.start || a.end - b.end || a.channel - b.channel));
    const assertUndoRedo = async (name, beforeAction, afterAction) => {
      step = `${name}-undo`;
      const afterUndo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
      if (pairSignature(afterUndo) !== pairSignature(beforeAction) || !afterUndo.canRedo) {
        throw new Error(`${name} undo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo })}`);
      }
      step = `${name}-redo`;
      const afterRedo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
      if (pairSignature(afterRedo) !== pairSignature(afterAction) || !afterRedo.canUndo) {
        throw new Error(`${name} redo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo, afterRedo })}`);
      }
      return { afterUndo, afterRedo };
    };

    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    step = "initial-state";
    const beforeState = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    step = "before-screenshot";
    const beforeShot = await screenshot(cdp, args.outDir, "piano-tools-before.png");
    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const yForNote = (note) => stageTop + ((127 - note) * 12 - 464);

    step = "draw-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "draw"));
    await sleep(150);
    await drag(cdp, xAt(1.5), yForNote(72) + 6, xAt(2.0), yForNote(72) + 6, { steps: 6, settleMs: 350 });
    step = "after-draw-state";
    const afterDraw = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    if (!(afterDraw.pairCount === beforeState.pairCount + 1 && afterDraw.pairs.some((pair) => pair.note >= 71 && pair.note <= 73 && pair.start >= 1.45))) {
      throw new Error(`Piano draw tool failed: ${JSON.stringify({ beforeState, afterDraw })}`);
    }
    const drawnPair = afterDraw.pairs.find((pair) => pair.note >= 71 && pair.note <= 73 && pair.start >= 1.45);
    const drawHistory = await assertUndoRedo("Piano draw tool", beforeState, afterDraw);
    step = "draw-screenshot";
    const drawShot = await screenshot(cdp, args.outDir, "piano-tools-after-draw.png");

    step = "erase-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "erase"));
    await sleep(150);
    await click(cdp, xAt(0.2), yForNote(60) + 6);
    step = "after-erase-state";
    const afterErase = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    if (afterErase.pairCount !== afterDraw.pairCount - 1 || afterErase.pairs.some((pair) => pair.note === 60)) {
      throw new Error(`Piano erase tool failed: ${JSON.stringify({ beforeState, afterDraw, afterErase })}`);
    }
    const eraseHistory = await assertUndoRedo("Piano erase tool", afterDraw, afterErase);
    step = "erase-screenshot";
    const eraseShot = await screenshot(cdp, args.outDir, "piano-tools-after-erase.png");

    step = "resize-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "select"));
    await sleep(150);
    await drag(cdp, xAt(1.0) - 3, yForNote(64) + 6, xAt(1.5), yForNote(64) + 6, { steps: 7, settleMs: 350 });
    step = "after-resize-state";
    const afterResize = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const resized64 = afterResize.pairs.find((pair) => pair.note === 64 && Math.abs(pair.start - 0.25) < 0.001);
    if (!resized64 || resized64.duration < 1.2) {
      throw new Error(`Piano note resize failed: ${JSON.stringify({ afterResize })}`);
    }
    const resizeHistory = await assertUndoRedo("Piano note resize", afterErase, afterResize);
    step = "resize-screenshot";
    const resizeShot = await screenshot(cdp, args.outDir, "piano-tools-after-resize.png");

    step = "split-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "split"));
    await sleep(150);
    await click(cdp, xAt(0.75), yForNote(64) + 6);
    step = "after-split-state";
    const afterSplit = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const split64Pairs = afterSplit.pairs.filter((pair) => pair.note === 64);
    if (split64Pairs.length !== 2 || split64Pairs.some((pair) => pair.duration > 0.8)) {
      throw new Error(`Piano split tool failed: ${JSON.stringify({ afterResize, afterSplit })}`);
    }
    const splitHistory = await assertUndoRedo("Piano split tool", afterResize, afterSplit);
    step = "split-screenshot";
    const splitShot = await screenshot(cdp, args.outDir, "piano-tools-after-split.png");

    step = "glue-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "glue"));
    await sleep(150);
    await click(cdp, xAt(0.45), yForNote(64) + 6);
    step = "after-glue-state";
    const afterGlue = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const glued64Pairs = afterGlue.pairs.filter((pair) => pair.note === 64);
    if (glued64Pairs.length !== 1 || glued64Pairs[0].duration < 1.2) {
      throw new Error(`Piano glue tool failed: ${JSON.stringify({ afterSplit, afterGlue })}`);
    }
    const glueHistory = await assertUndoRedo("Piano glue tool", afterSplit, afterGlue);
    step = "glue-screenshot";
    const glueShot = await screenshot(cdp, args.outDir, "piano-tools-after-glue.png");

    step = "mute-tool";
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "mute"));
    await sleep(150);
    await click(cdp, xAt(0.55), yForNote(64) + 6);
    step = "after-mute-state";
    const afterMute = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    if (!afterMute.pairs.some((pair) => pair.note === 64 && pair.muted)) {
      throw new Error(`Piano mute tool failed: ${JSON.stringify({ afterMute })}`);
    }
    const muteHistory = await assertUndoRedo("Piano mute tool", afterGlue, afterMute);
    step = "mute-screenshot";
    const muteShot = await screenshot(cdp, args.outDir, "piano-tools-after-mute.png");

    step = "velocity-tool";
    await evalInPage(cdp, `
      (() => {
        const useDAWStore = window.__studio13QADAWStore;
        useDAWStore.getState().setPianoRollActiveLane('velocity');
        return true;
      })()
    `);
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "velocity"));
    await sleep(150);
    const velocityLayout = await evalInPage(cdp, `
      (() => {
        const rect = document.querySelector('.piano-roll-editor-pane canvas').getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      })()
    `);
    const velocityLaneY = velocityLayout.top + velocityLayout.height - 61;
    await drag(cdp, xAt(0.25), velocityLaneY + 30, xAt(0.25), velocityLaneY + 2, { steps: 6, settleMs: 350 });
    step = "after-velocity-state";
    const afterVelocity = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const velocity64 = afterVelocity.pairs.find((pair) => pair.note === 64 && pair.velocity >= 88);
    if (!velocity64 || !afterVelocity.canUndo) {
      throw new Error(`Piano velocity lane edit failed: ${JSON.stringify({ afterVelocity })}`);
    }
    const velocityHistory = await assertUndoRedo("Piano velocity lane edit", afterMute, afterVelocity);
    step = "velocity-screenshot";
    const velocityShot = await screenshot(cdp, args.outDir, "piano-tools-after-velocity.png");

    return {
      scenario: "piano-tools",
      status: "passed",
      before,
      beforeState,
      afterDraw,
      afterErase,
      afterResize,
      afterSplit,
      afterGlue,
      afterMute,
      afterVelocity,
      histories: {
        drawHistory,
        eraseHistory,
        resizeHistory,
        splitHistory,
        glueHistory,
        muteHistory,
        velocityHistory,
      },
      screenshots: [beforeShot, drawShot, eraseShot, resizeShot, splitShot, glueShot, muteShot, velocityShot],
    };
  } catch (error) {
    throw new Error(`piano-tools ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoRange(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1024, 720);
  try {
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const yForNote = (note) => stageTop + ((127 - note) * 12 - 464);
    const beforeShot = await screenshot(cdp, args.outDir, "piano-range-before.png");

    await evalInPage(cdp, setPianoToolExpression(storeUrl, "range"));
    await sleep(150);
    await drag(cdp, xAt(0.05), yForNote(70), xAt(1.1), yForNote(56) + 12, { steps: 8, settleMs: 350 });
    const afterRange = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    if (!afterRange.midiEditRange || afterRange.selectedNoteIds.length < 2) {
      throw new Error(`Piano range select failed: ${JSON.stringify({ afterRange })}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "piano-range-after.png");

    return {
      scenario: "piano-range",
      status: "passed",
      before,
      afterRange,
      screenshots: [beforeShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoMultiItem(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1024, 720);
  try {
    const closeEnough = (left, right) => Math.abs(left - right) <= 0.0001;
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, {
      includeAdditionalClip: true,
    }));
    if (!before.hasEditor || before.clipCount !== 2) {
      throw new Error(`Piano multi-item fixture did not render expected clips: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoMultiItemStateExpression(storeUrl));
    if (beforeState.activeClipId !== "qa-clip" || !String(beforeState.refText).includes("Refs 1")) {
      throw new Error(`Piano multi-item fixture did not expose active/reference state: ${JSON.stringify(beforeState)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-multi-item-before.png");

    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const yForNote = (note) => stageTop + ((127 - note) * 12 - 464);

    await evalInPage(cdp, setPianoToolExpression(storeUrl, "select"));
    await drag(cdp, xAt(0.18), yForNote(60) + 6, xAt(0.48), yForNote(60) + 6, { steps: 6, settleMs: 350 });
    const afterPrimaryDrag = await evalInPage(cdp, pianoMultiItemStateExpression(storeUrl));
    if (
      afterPrimaryDrag.activeClipId !== "qa-clip"
      || !(afterPrimaryDrag.clip60.start > beforeState.clip60.start + 0.05)
      || Math.abs(afterPrimaryDrag.clip72.start - beforeState.clip72.start) > 0.0001
      || !afterPrimaryDrag.canUndo
    ) {
      throw new Error(`Piano multi-item active clip drag failed or edited reference item: ${JSON.stringify({ beforeState, afterPrimaryDrag })}`);
    }
    const afterPrimaryUndo = await evalInPage(cdp, pianoMultiItemUndoRedoStateExpression(storeUrl, "undo"));
    if (
      !closeEnough(afterPrimaryUndo.clip60.start, beforeState.clip60.start)
      || !closeEnough(afterPrimaryUndo.clip72.start, beforeState.clip72.start)
      || !afterPrimaryUndo.canRedo
    ) {
      throw new Error(`Piano multi-item primary drag undo failed or touched reference item: ${JSON.stringify({ beforeState, afterPrimaryDrag, afterPrimaryUndo })}`);
    }
    const afterPrimaryRedo = await evalInPage(cdp, pianoMultiItemUndoRedoStateExpression(storeUrl, "redo"));
    if (
      !closeEnough(afterPrimaryRedo.clip60.start, afterPrimaryDrag.clip60.start)
      || !closeEnough(afterPrimaryRedo.clip72.start, beforeState.clip72.start)
      || !afterPrimaryRedo.canUndo
    ) {
      throw new Error(`Piano multi-item primary drag redo failed or touched reference item: ${JSON.stringify({ beforeState, afterPrimaryDrag, afterPrimaryUndo, afterPrimaryRedo })}`);
    }
    const primaryShot = await screenshot(cdp, args.outDir, "piano-multi-item-after-active-drag.png");

    await click(cdp, xAt(1.1), yForNote(72) + 6, { settleMs: 450 });
    const afterSwitch = await evalInPage(cdp, pianoMultiItemStateExpression(storeUrl));
    if (afterSwitch.activeClipId !== "qa-clip-b" || !afterSwitch.selectedNoteIds.some((id) => String(id).startsWith("qa-clip-b:0.100000:72"))) {
      throw new Error(`Piano multi-item reference click did not switch active item: ${JSON.stringify({ afterPrimaryDrag, afterSwitch })}`);
    }
    const switchShot = await screenshot(cdp, args.outDir, "piano-multi-item-after-switch.png");

    await drag(cdp, xAt(1.18), yForNote(72) + 6, xAt(1.48), yForNote(72) + 6, { steps: 6, settleMs: 350 });
    const afterSecondaryDrag = await evalInPage(cdp, pianoMultiItemStateExpression(storeUrl));
    if (
      afterSecondaryDrag.activeClipId !== "qa-clip-b"
      || !(afterSecondaryDrag.clip72.start > afterSwitch.clip72.start + 0.05)
      || Math.abs(afterSecondaryDrag.clip60.start - afterPrimaryDrag.clip60.start) > 0.0001
      || !afterSecondaryDrag.canUndo
    ) {
      throw new Error(`Piano multi-item switched active clip drag failed or touched prior active item: ${JSON.stringify({ afterSwitch, afterSecondaryDrag })}`);
    }
    const afterSecondaryUndo = await evalInPage(cdp, pianoMultiItemUndoRedoStateExpression(storeUrl, "undo"));
    if (
      !closeEnough(afterSecondaryUndo.clip72.start, afterSwitch.clip72.start)
      || !closeEnough(afterSecondaryUndo.clip60.start, afterPrimaryRedo.clip60.start)
      || !afterSecondaryUndo.canRedo
    ) {
      throw new Error(`Piano multi-item secondary drag undo failed or touched prior active item: ${JSON.stringify({ afterPrimaryRedo, afterSwitch, afterSecondaryDrag, afterSecondaryUndo })}`);
    }
    const afterSecondaryRedo = await evalInPage(cdp, pianoMultiItemUndoRedoStateExpression(storeUrl, "redo"));
    if (
      !closeEnough(afterSecondaryRedo.clip72.start, afterSecondaryDrag.clip72.start)
      || !closeEnough(afterSecondaryRedo.clip60.start, afterPrimaryRedo.clip60.start)
      || !afterSecondaryRedo.canUndo
    ) {
      throw new Error(`Piano multi-item secondary drag redo failed or touched prior active item: ${JSON.stringify({ afterPrimaryRedo, afterSwitch, afterSecondaryDrag, afterSecondaryUndo, afterSecondaryRedo })}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "piano-multi-item-after-secondary-drag.png");

    return {
      scenario: "piano-multi-item",
      status: "passed",
      before,
      beforeState,
      afterPrimaryDrag,
      afterPrimaryUndo,
      afterPrimaryRedo,
      afterSwitch,
      afterSecondaryDrag,
      afterSecondaryUndo,
      afterSecondaryRedo,
      screenshots: [beforeShot, primaryShot, switchShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoVisualViewports(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const viewports = [
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1280x720", width: 1280, height: 720 },
    { name: "1024x720", width: 1024, height: 720 },
    { name: "short-zone", width: 1024, height: 560 },
  ];
  const checks = [];

  for (const viewport of viewports) {
    const cdp = await openTab(args, viewport.width, viewport.height);
    try {
      const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, {
        includeAdditionalClip: true,
        activeLaneId: "cc-1",
      }));
      if (!before.hasEditor) {
        throw new Error(`Piano visual fixture did not render at ${viewport.name}: ${JSON.stringify(before)}`);
      }
      const layout = await evalInPage(cdp, pianoVisualLayoutStateExpression(storeUrl));
      if (
        !layout.shell
        || !layout.strip
        || !layout.infoLine
        || !layout.editor
        || !layout.inspector
        || !layout.sidebar
        || !layout.keyStrip
        || !layout.keyViewport
        || !layout.ruler
        || !layout.horizontalScroll
        || !layout.verticalScroll
        || !layout.sourceHeader
        || !layout.sidebarWidthMatchesTcp
        || !layout.canvasStartsAfterSidebar
        || !layout.keyStripInsideSidebar
        || !layout.keyStripTouchesDivider
        || !layout.keyViewportMatchesCanvasTop
        || !layout.rulerMatchesCanvasLeft
        || !layout.hasUsableHorizontalScrollbar
        || !layout.hasUsableVerticalScrollbar
        || !layout.laneStack
        || layout.laneRows < 3
        || layout.hasOverflow
        || layout.editorInspectorOverlap
      ) {
        throw new Error(`Piano visual layout failed at ${viewport.name}: ${JSON.stringify(layout)}`);
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(layout.inspector.left + layout.inspector.width / 2),
        y: Math.round(layout.inspector.top + 100),
        deltaX: 0,
        deltaY: 160,
      });
      await sleep(160);
      const afterSidebarWheel = await evalInPage(cdp, pianoVisualLayoutStateExpression(storeUrl));
      if (afterSidebarWheel.sidebarScrollTop <= layout.sidebarScrollTop || afterSidebarWheel.storeScrollX !== layout.storeScrollX) {
        throw new Error(`Piano sidebar wheel did not scroll sidebar independently at ${viewport.name}: ${JSON.stringify({ layout, afterSidebarWheel })}`);
      }
      const shot = await screenshot(cdp, args.outDir, `piano-visual-${viewport.name}.png`);
      checks.push({ name: viewport.name, status: "passed", layout, afterSidebarWheel, screenshot: shot });
    } finally {
      await cdp.send("Page.close").catch(() => undefined);
      cdp.close();
    }
  }

  return {
    scenario: "piano-visual-viewports",
    status: "passed",
    checks,
    screenshots: checks.map((check) => check.screenshot),
  };
}

async function runPianoResponsiveToolbar(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const checks = [];

  const wide = await openTab(args, 3840, 1440);
  try {
    const before = await evalInPage(wide, pianoFixtureExpression(args.baseUrl, storeUrl, {
      includeAdditionalClip: true,
      activeLaneId: "cc-1",
    }));
    if (!before.hasEditor) {
      throw new Error(`Responsive toolbar wide fixture did not render: ${JSON.stringify(before)}`);
    }
    const layout = await evalInPage(wide, pianoResponsiveToolbarStateExpression(storeUrl));
    const expectedWideGroups = ["tools", "scale", "lane", "quantize", "audition", "step", "clip"];
    if (
      layout.moreVisible
      || layout.toolbarHasHorizontalOverflow
      || layout.documentHasHorizontalOverflow
      || expectedWideGroups.some((id) => !layout.visibleGroupIds.includes(id))
      || layout.overflowGroupIds.length > 0
    ) {
      throw new Error(`Responsive toolbar wide layout failed: ${JSON.stringify(layout)}`);
    }
    const shot = await screenshot(wide, args.outDir, "piano-responsive-toolbar-wide.png");
    checks.push({ name: "wide", status: "passed", layout, screenshot: shot });
  } finally {
    await wide.send("Page.close").catch(() => undefined);
    wide.close();
  }

  const macbook = await openTab(args, 1280, 800);
  try {
    const before = await evalInPage(macbook, pianoFixtureExpression(args.baseUrl, storeUrl, {
      includeAdditionalClip: true,
      activeLaneId: "cc-1",
    }));
    if (!before.hasEditor) {
      throw new Error(`Responsive toolbar laptop fixture did not render: ${JSON.stringify(before)}`);
    }
    const layout = await evalInPage(macbook, pianoResponsiveToolbarStateExpression(storeUrl));
    if (
      !layout.moreVisible
      || !layout.visibleGroupIds.includes("tools")
      || layout.overflowGroupIds.length === 0
      || layout.toolbarHasHorizontalOverflow
      || layout.documentHasHorizontalOverflow
    ) {
      throw new Error(`Responsive toolbar laptop layout failed: ${JSON.stringify(layout)}`);
    }
    const shot = await screenshot(macbook, args.outDir, "piano-responsive-toolbar-macbook.png");
    checks.push({ name: "macbook", status: "passed", layout, screenshot: shot });
  } finally {
    await macbook.send("Page.close").catch(() => undefined);
    macbook.close();
  }

  const compact = await openTab(args, 560, 720);
  try {
    const before = await evalInPage(compact, pianoFixtureExpression(args.baseUrl, storeUrl, {
      includeAdditionalClip: true,
      activeLaneId: "velocity",
    }));
    if (!before.hasEditor) {
      throw new Error(`Responsive toolbar compact fixture did not render: ${JSON.stringify(before)}`);
    }
    const initial = await evalInPage(compact, pianoResponsiveToolbarStateExpression(storeUrl));
    if (
      !initial.moreVisible
      || !initial.visibleGroupIds.includes("tools")
      || !initial.overflowGroupIds.includes("audition")
      || !initial.overflowGroupIds.includes("lane")
      || !initial.overflowGroupIds.includes("quantize")
      || !initial.overflowGroupIds.includes("clip")
      || initial.toolbarHasHorizontalOverflow
      || initial.documentHasHorizontalOverflow
    ) {
      throw new Error(`Responsive toolbar compact initial layout failed: ${JSON.stringify(initial)}`);
    }

    const toolButtonRect = await evalInPage(compact, `
      (() => {
        const button = document.querySelector('.piano-roll-icon-tool[aria-label^="Draw tool"]')
          || document.querySelector('.piano-roll-icon-tool');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()
    `);
    if (!toolButtonRect) {
      throw new Error(`Responsive toolbar tool button was not found: ${JSON.stringify(initial)}`);
    }
    await click(
      compact,
      toolButtonRect.left + toolButtonRect.width / 2,
      toolButtonRect.top + toolButtonRect.height / 2,
      { settleMs: 120 },
    );
    const focusAfterToolClick = await evalInPage(compact, `
      (() => {
        const active = document.activeElement;
        return {
          activeTag: active?.tagName ?? null,
          activeClass: String(active?.className || ''),
          activeLabel: active?.getAttribute?.('aria-label') ?? null,
          activeIsToolbarButton: Boolean(active?.closest?.('.piano-roll-key-strip') && active?.tagName === 'BUTTON'),
        };
      })()
    `);
    if (focusAfterToolClick.activeIsToolbarButton) {
      throw new Error(`Responsive toolbar button retained focus after mouse click: ${JSON.stringify(focusAfterToolClick)}`);
    }

    await evalInPage(compact, `document.querySelector('[data-qa="piano-roll-toolbar-more"]')?.click()`);
    await sleep(160);
    const open = await evalInPage(compact, pianoResponsiveToolbarStateExpression(storeUrl));
    if (!open.menuOpen || !open.menuHitTestMatches) {
      throw new Error(`Responsive toolbar overflow menu did not open: ${JSON.stringify(open)}`);
    }

    await setInputValue(compact, "#pr-overflow-insert-velocity", 73);
    await setSelectValue(compact, "#pr-overflow-visible-lane", "cc-1");
    const controls = await evalInPage(compact, `
      (() => {
        const menu = document.querySelector('[data-qa="piano-roll-toolbar-overflow-menu"]');
        const labels = [...(menu?.querySelectorAll('label') || [])];
        const refs = labels.find((label) => String(label.textContent || '').includes('Refs'))?.querySelector('input');
        const ghost = labels.find((label) => String(label.textContent || '').includes('Ghost'))?.querySelector('input');
        const quantize = menu?.querySelector('button[aria-label="Quantize notes using last settings"]');
        quantize?.click();
        refs?.click();
        ghost?.click();
        return {
          velocity: menu?.querySelector('#pr-overflow-insert-velocity')?.value ?? null,
          lane: menu?.querySelector('#pr-overflow-visible-lane')?.value ?? null,
          quantizeFound: Boolean(quantize),
          refsChecked: refs?.checked ?? null,
          ghostChecked: ghost?.checked ?? null,
        };
      })()
    `);
    await sleep(180);
    if (
      controls.velocity !== "73"
      || controls.lane !== "cc-1"
      || !controls.quantizeFound
      || controls.refsChecked !== false
      || controls.ghostChecked !== false
    ) {
      throw new Error(`Responsive toolbar overflow controls failed: ${JSON.stringify({ initial, open, controls })}`);
    }

    await compact.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await compact.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await sleep(120);
    const afterEscape = await evalInPage(compact, pianoResponsiveToolbarStateExpression(storeUrl));
    if (afterEscape.menuOpen) {
      throw new Error(`Responsive toolbar overflow menu did not close on Escape: ${JSON.stringify(afterEscape)}`);
    }

    await evalInPage(compact, `document.querySelector('[data-qa="piano-roll-toolbar-more"]')?.click()`);
    await sleep(120);
    await click(compact, 10, 10, { settleMs: 160 });
    const afterOutside = await evalInPage(compact, pianoResponsiveToolbarStateExpression(storeUrl));
    if (afterOutside.menuOpen) {
      throw new Error(`Responsive toolbar overflow menu did not close on outside click: ${JSON.stringify(afterOutside)}`);
    }

    const shot = await screenshot(compact, args.outDir, "piano-responsive-toolbar-compact.png");
    checks.push({ name: "compact", status: "passed", initial, focusAfterToolClick, open, controls, afterEscape, afterOutside, screenshot: shot });
  } finally {
    await compact.send("Page.close").catch(() => undefined);
    compact.close();
  }

  return {
    scenario: "piano-responsive-toolbar",
    status: "passed",
    checks,
    screenshots: checks.map((check) => check.screenshot),
  };
}

async function runPianoSourceHeader(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1180, 760);
  try {
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "cc-1" }));
    if (!before.hasEditor) {
      throw new Error(`Piano source header fixture did not render: ${JSON.stringify(before)}`);
    }
    await evalInPage(cdp, `
      (() => {
        const useDAWStore = window.__studio13QADAWStore;
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map((track) => ({
            ...track,
            midiClips: track.midiClips.map((clip) => clip.id === 'qa-clip'
              ? {
                  ...clip,
                  duration: 8,
                  sourceLength: 4,
                  loopLength: 4,
                  loopEnabled: true,
                  events: [
                    ...clip.events,
                    { type: 'noteOn', timestamp: 5, note: 72, velocity: 93, channel: 1 },
                    { type: 'noteOff', timestamp: 5.5, note: 72, velocity: 0, channel: 1 },
                  ],
                }
              : clip),
          })),
          canUndo: false,
          canRedo: false,
        }));
        return true;
      })()
    `);
    await sleep(220);
    const initial = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (!initial.hasHeader || Math.abs(initial.sourceLength - 4) > 0.0001 || !initial.noteBeyondSource) {
      throw new Error(`Piano source header initial state invalid: ${JSON.stringify(initial)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-source-header-before.png");

    const loopEndX = initial.canvas.left + initial.sourceLength * initial.pixelsPerSecond - initial.scrollX;
    const loopDragTargetSeconds = 4.125;
    const loopEndDragX = initial.canvas.left + loopDragTargetSeconds * initial.pixelsPerSecond - initial.scrollX;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(loopEndX),
      y: Math.round(initial.canvas.top + 28),
      button: "left",
      buttons: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(loopEndDragX),
      y: Math.round(initial.canvas.top + 28),
      button: "left",
      buttons: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(loopEndDragX),
      y: Math.round(initial.canvas.top + 28),
      button: "left",
      buttons: 0,
    });
    await sleep(220);
    const afterLoopDrag = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (Math.abs(afterLoopDrag.sourceLength - loopDragTargetSeconds) > 0.0001 || Math.abs(afterLoopDrag.loopLength - loopDragTargetSeconds) > 0.0001 || afterLoopDrag.duration !== 8 || !afterLoopDrag.canUndo) {
      throw new Error(`Piano loop end drag failed: ${JSON.stringify({ initial, afterLoopDrag })}`);
    }
    const afterLoopDragUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (Math.abs((afterLoopDragUndo.clips[0]?.sourceLength ?? 0) - 4) > 0.0001 || Math.abs((afterLoopDragUndo.clips[0]?.loopLength ?? 0) - 4) > 0.0001 || !afterLoopDragUndo.canRedo) {
      throw new Error(`Piano loop end drag undo failed: ${JSON.stringify({ afterLoopDrag, afterLoopDragUndo })}`);
    }

    await evalInPage(cdp, `
      (() => {
        const input = document.querySelector('[data-qa="piano-roll-source-length-input"]');
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        input.focus();
        descriptor.set.call(input, '2.5');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(220);
    const afterCustom = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (Math.abs(afterCustom.sourceLength - 2.5) > 0.0001 || Math.abs(afterCustom.loopLength - 2.5) > 0.0001 || afterCustom.duration !== 8 || !afterCustom.noteBeyondSource || !afterCustom.canUndo) {
      throw new Error(`Piano source length input failed: ${JSON.stringify({ initial, afterCustom })}`);
    }
    const afterCustomUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (Math.abs((afterCustomUndo.clips[0]?.sourceLength ?? 0) - 4) > 0.0001 || Math.abs((afterCustomUndo.clips[0]?.loopLength ?? 0) - 4) > 0.0001 || !afterCustomUndo.canRedo) {
      throw new Error(`Piano source length input undo failed: ${JSON.stringify({ afterCustom, afterCustomUndo })}`);
    }
    const afterCustomRedo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "redo"));
    if (Math.abs((afterCustomRedo.clips[0]?.sourceLength ?? 0) - 2.5) > 0.0001 || Math.abs((afterCustomRedo.clips[0]?.loopLength ?? 0) - 2.5) > 0.0001 || !afterCustomRedo.canUndo) {
      throw new Error(`Piano source length input redo failed: ${JSON.stringify({ afterCustom, afterCustomUndo, afterCustomRedo })}`);
    }

    await evalInPage(cdp, `document.querySelector('[data-qa="piano-roll-source-item"]')?.click()`);
    await sleep(220);
    const afterItem = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (Math.abs(afterItem.sourceLength - 8) > 0.0001 || Math.abs(afterItem.loopLength - 8) > 0.0001 || afterItem.duration !== 8 || !afterItem.canUndo) {
      throw new Error(`Piano Source = Item failed: ${JSON.stringify({ afterCustomRedo, afterItem })}`);
    }

    await evalInPage(cdp, `document.querySelector('[data-qa="piano-roll-source-content"]')?.click()`);
    await sleep(220);
    const afterContent = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (Math.abs(afterContent.sourceLength - 5.5) > 0.0001 || Math.abs(afterContent.loopLength - 5.5) > 0.0001 || afterContent.duration !== 8 || !afterContent.noteBeyondSource || !afterContent.canUndo) {
      throw new Error(`Piano Source = Content failed: ${JSON.stringify({ afterItem, afterContent })}`);
    }

    await evalInPage(cdp, `document.querySelector('[data-qa="piano-roll-source-loop"]')?.click()`);
    await sleep(220);
    const afterLoop = await evalInPage(cdp, pianoSourceHeaderStateExpression(storeUrl));
    if (afterLoop.loopEnabled === afterContent.loopEnabled || !afterLoop.canUndo) {
      throw new Error(`Piano source loop toggle failed: ${JSON.stringify({ afterContent, afterLoop })}`);
    }
    const afterLoopUndo = await evalInPage(cdp, storeUndoRedoExpression(storeUrl, "undo"));
    if (afterLoopUndo.clips[0]?.loopEnabled !== afterContent.loopEnabled || !afterLoopUndo.canRedo) {
      throw new Error(`Piano source loop toggle undo failed: ${JSON.stringify({ afterContent, afterLoop, afterLoopUndo })}`);
    }
    const afterShot = await screenshot(cdp, args.outDir, "piano-source-header-after.png");

    return {
      scenario: "piano-source-header",
      status: "passed",
      initial,
      afterCustom,
      afterCustomUndo,
      afterCustomRedo,
      afterItem,
      afterContent,
      afterLoop,
      afterLoopUndo,
      afterLoopDrag,
      afterLoopDragUndo,
      screenshots: [beforeShot, afterShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoAuditionInsert(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1180, 760);
  try {
    const normalizeNumber = (value) => Number(Number(value ?? 0).toFixed(6));
    const pairSignature = (state) => JSON.stringify((state.pairs || [])
      .map((pair) => ({
        note: pair.note,
        start: normalizeNumber(pair.start),
        duration: normalizeNumber(pair.duration),
        velocity: pair.velocity,
      }))
      .sort((a, b) => a.note - b.note || a.start - b.start || a.duration - b.duration || a.velocity - b.velocity));
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }

    await evalInPage(cdp, `
      (async () => {
        const bridgeModule = await import('${args.baseUrl}/src/services/NativeBridge.ts');
        window.__studio13QAAuditionCalls = [];
        bridgeModule.nativeBridge.sendMidiNote = async (trackId, note, velocity, isNoteOn) => {
          window.__studio13QAAuditionCalls.push({ trackId, note, velocity, isNoteOn });
          return true;
        };
        return true;
      })()
    `);

    await setInputValue(cdp, "#pr-insert-velocity", 111);
    const configured = await evalInPage(cdp, pianoAuditionInsertStateExpression(storeUrl));
    if (configured.insertVelocity !== 111 || configured.insertVelocityInput !== "111" || configured.auditionEnabled !== true) {
      throw new Error(`Insert velocity/audition controls did not configure: ${JSON.stringify(configured)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-audition-insert-before.png");

    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const yForNote = (note) => stageTop + ((127 - note) * 12 - 464);

    await evalInPage(cdp, setPianoToolExpression(storeUrl, "draw"));
    await sleep(150);
    await drag(cdp, xAt(1.5), yForNote(72) + 6, xAt(1.875), yForNote(72) + 6, { steps: 6, settleMs: 620 });
    const afterDraw = await evalInPage(cdp, pianoAuditionInsertStateExpression(storeUrl));
    const drawn = afterDraw.pairs.find((pair) => pair.note >= 71 && pair.note <= 73 && pair.start >= 1.45);
    const noteOn = afterDraw.auditionCalls.find((call) => call.isNoteOn && call.velocity === 111 && call.note >= 71 && call.note <= 73);
    const noteOff = afterDraw.auditionCalls.find((call) => !call.isNoteOn && call.velocity === 0 && call.note === noteOn?.note);
    if (!drawn || drawn.velocity !== 111 || !noteOn || !noteOff || !afterDraw.canUndo) {
      throw new Error(`Audition enabled draw did not use insert velocity and balanced note off: ${JSON.stringify({ configured, afterDraw, drawn, noteOn, noteOff })}`);
    }
    const afterDrawUndo = await evalInPage(cdp, pianoAuditionInsertUndoRedoStateExpression(storeUrl, "undo"));
    if (pairSignature(afterDrawUndo) !== pairSignature(configured) || !afterDrawUndo.canRedo) {
      throw new Error(`Audition enabled draw undo failed: ${JSON.stringify({ configured, afterDraw, afterDrawUndo })}`);
    }
    const afterDrawRedo = await evalInPage(cdp, pianoAuditionInsertUndoRedoStateExpression(storeUrl, "redo"));
    if (pairSignature(afterDrawRedo) !== pairSignature(afterDraw) || !afterDrawRedo.canUndo) {
      throw new Error(`Audition enabled draw redo failed: ${JSON.stringify({ afterDraw, afterDrawUndo, afterDrawRedo })}`);
    }
    const drawShot = await screenshot(cdp, args.outDir, "piano-audition-insert-after-draw.png");

    const disabled = await evalInPage(cdp, `
      (() => {
        const button = document.querySelector('button[aria-label="Disable MIDI note audition"]');
        if (!button) return { clicked: false };
        button.click();
        return { clicked: true };
      })()
    `);
    if (!disabled?.clicked) {
      throw new Error(`Could not disable MIDI audition from toolbar: ${JSON.stringify(disabled)}`);
    }
    await sleep(180);
    const beforeDisabledDraw = await evalInPage(cdp, pianoAuditionInsertStateExpression(storeUrl));
    const callsBeforeDisabledDraw = beforeDisabledDraw.auditionCalls.length;
    if (beforeDisabledDraw.auditionEnabled !== false) {
      throw new Error(`Audition did not disable from toolbar: ${JSON.stringify(beforeDisabledDraw)}`);
    }

    await drag(cdp, xAt(2.125), yForNote(76) + 6, xAt(2.375), yForNote(76) + 6, { steps: 5, settleMs: 420 });
    const afterDisabledDraw = await evalInPage(cdp, pianoAuditionInsertStateExpression(storeUrl));
    const disabledDraw = afterDisabledDraw.pairs.find((pair) => pair.note >= 75 && pair.note <= 77 && pair.start >= 2.0);
    if (!disabledDraw || disabledDraw.velocity !== 111 || afterDisabledDraw.auditionCalls.length !== callsBeforeDisabledDraw) {
      throw new Error(`Audition disabled draw should add a note without preview calls: ${JSON.stringify({ beforeDisabledDraw, afterDisabledDraw, disabledDraw })}`);
    }
    const afterDisabledUndo = await evalInPage(cdp, pianoAuditionInsertUndoRedoStateExpression(storeUrl, "undo"));
    if (pairSignature(afterDisabledUndo) !== pairSignature(beforeDisabledDraw) || afterDisabledUndo.auditionCalls.length !== callsBeforeDisabledDraw || !afterDisabledUndo.canRedo) {
      throw new Error(`Audition disabled draw undo failed or emitted preview calls: ${JSON.stringify({ beforeDisabledDraw, afterDisabledDraw, afterDisabledUndo })}`);
    }
    const afterDisabledRedo = await evalInPage(cdp, pianoAuditionInsertUndoRedoStateExpression(storeUrl, "redo"));
    if (pairSignature(afterDisabledRedo) !== pairSignature(afterDisabledDraw) || afterDisabledRedo.auditionCalls.length !== callsBeforeDisabledDraw || !afterDisabledRedo.canUndo) {
      throw new Error(`Audition disabled draw redo failed or emitted preview calls: ${JSON.stringify({ beforeDisabledDraw, afterDisabledDraw, afterDisabledUndo, afterDisabledRedo })}`);
    }
    const disabledShot = await screenshot(cdp, args.outDir, "piano-audition-insert-disabled-draw.png");

    return {
      scenario: "piano-audition-insert",
      status: "passed",
      configured,
      afterDraw,
      afterDrawUndo,
      afterDrawRedo,
      beforeDisabledDraw,
      afterDisabledDraw,
      afterDisabledUndo,
      afterDisabledRedo,
      screenshots: [beforeShot, drawShot, disabledShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoNavigationTools(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1180, 760);
  try {
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "cc-1" }));
    if (!before.hasEditor || before.activeLane?.id !== "cc-1") {
      throw new Error(`Piano navigation fixture did not select CC#1 lane: ${JSON.stringify(before)}`);
    }
    await evalInPage(cdp, `
      (() => {
        const useDAWStore = window.__studio13QADAWStore;
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map((track) => ({
            ...track,
            midiClips: track.midiClips.map((clip) => clip.id === 'qa-clip'
              ? { ...clip, sourceLength: 8, loopLength: 8, loopEnabled: false }
              : clip),
          })),
        }));
        return true;
      })()
    `);
    await sleep(220);
    await evalInPage(cdp, `
      (() => {
        window.__studio13QAPromptCalls = 0;
        const originalPrompt = window.prompt;
        window.prompt = (...args) => {
          window.__studio13QAPromptCalls += 1;
          return originalPrompt ? originalPrompt(...args) : null;
        };
        return true;
      })()
    `);
    const initial = await evalInPage(cdp, pianoNavigationToolsStateExpression(storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "piano-navigation-tools-before.png");

    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    await evalInPage(cdp, setPianoToolExpression(storeUrl, "zoom"));
    await click(cdp, stageLeft + 520, stageTop + 170, { settleMs: 220 });
    const afterZoom = await evalInPage(cdp, pianoNavigationToolsStateExpression(storeUrl));
    if (afterZoom.activeTool !== "zoom" || !(afterZoom.zoomValue > initial.zoomValue)) {
      throw new Error(`Zoom tool click did not increase horizontal zoom: ${JSON.stringify({ initial, afterZoom })}`);
    }
    const zoomShot = await screenshot(cdp, args.outDir, "piano-navigation-tools-after-zoom.png");

    await evalInPage(cdp, setPianoToolExpression(storeUrl, "pan"));
    await sleep(180);
    await drag(cdp, stageLeft + 780, stageTop + 190, stageLeft + 520, stageTop + 145, { steps: 8, settleMs: 260 });
    const afterPan = await evalInPage(cdp, pianoNavigationToolsStateExpression(storeUrl));
    if (afterPan.activeTool !== "pan" || !(afterPan.scrollLeft > afterZoom.scrollLeft + 40)) {
      throw new Error(`Pan tool drag did not move the Piano Roll viewport: ${JSON.stringify({ afterZoom, afterPan })}`);
    }
    const panShot = await screenshot(cdp, args.outDir, "piano-navigation-tools-after-pan.png");

    await evalInPage(cdp, setPianoToolExpression(storeUrl, "line"));
    await sleep(180);
    const laneHeight = before.activeLane?.height ?? 84;
    const laneTop = stageTop + before.canvas.height - laneHeight;
    await click(cdp, stageLeft + 260, laneTop + laneHeight * 0.5, { settleMs: 260 });
    const afterLine = await evalInPage(cdp, pianoNavigationToolsStateExpression(storeUrl));
    if (afterLine.activeTool !== "line" || !afterLine.lineDialogOpen || afterLine.promptCalls !== 0) {
      throw new Error(`Line tool did not open controller dialog without prompt: ${JSON.stringify({ afterPan, afterLine })}`);
    }
    const lineShot = await screenshot(cdp, args.outDir, "piano-navigation-tools-after-line.png");

    return {
      scenario: "piano-navigation-tools",
      status: "passed",
      initial,
      afterZoom,
      afterPan,
      afterLine,
      screenshots: [beforeShot, zoomShot, panShot, lineShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoControllerLane(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  try {
    const normalizeEvents = (events = []) => events
      .map((event) => ({
        time: Number(Number(event.time ?? 0).toFixed(6)),
        value: event.value,
      }))
      .sort((a, b) => a.time - b.time || a.value - b.value);
    const controllerSignature = (state) => JSON.stringify({
      cc1: normalizeEvents(state.cc1),
      cc33Count: state.cc33Count,
      cc74: normalizeEvents(state.cc74),
    });
    const assertControllerUndoRedo = async (name, beforeAction, afterAction) => {
      step = `${name}-undo`;
      const afterUndo = await evalInPage(cdp, pianoControllerLaneUndoRedoStateExpression(storeUrl, "undo"));
      if (controllerSignature(afterUndo) !== controllerSignature(beforeAction) || !afterUndo.canRedo) {
        throw new Error(`${name} undo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo })}`);
      }
      step = `${name}-redo`;
      const afterRedo = await evalInPage(cdp, pianoControllerLaneUndoRedoStateExpression(storeUrl, "redo"));
      if (controllerSignature(afterRedo) !== controllerSignature(afterAction) || !afterRedo.canUndo) {
        throw new Error(`${name} redo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo, afterRedo })}`);
      }
      return { afterUndo, afterRedo };
    };

    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "cc-1" }));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    step = "initial-state";
    const beforeState = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (beforeState.activeLaneId !== "cc-1" || beforeState.cc1Count !== 2) {
      throw new Error(`Controller lane fixture did not select CC#1: ${JSON.stringify(beforeState)}`);
    }
    step = "before-screenshot";
    const beforeShot = await screenshot(cdp, args.outDir, "piano-controller-lane-before.png");

    step = "curve-line";
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "curve",
      curve: 0.35,
      startValue: 12,
      endValue: 112,
    });
    const afterCurve = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterCurve.cc1Count <= beforeState.cc1Count || afterCurve.cc1Min > 13 || afterCurve.cc1Max < 110 || !afterCurve.canUndo) {
      throw new Error(`Controller curve generation failed: ${JSON.stringify({ beforeState, afterCurve })}`);
    }
    const curveHistory = await assertControllerUndoRedo("Controller curve generation", beforeState, afterCurve);
    const curveShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-curve.png");

    step = "transform";
    await clickInspectorButton(cdp, "Transform");
    await submitControllerDialog(cdp, {
      type: "transform",
      timeScalePercent: 50,
      valueScalePercent: 70,
      valueOffset: 8,
      tilt: 10,
    });
    const afterTransform = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const curveSpan = afterCurve.cc1[afterCurve.cc1.length - 1]?.time - afterCurve.cc1[0]?.time;
    const transformSpan = afterTransform.cc1[afterTransform.cc1.length - 1]?.time - afterTransform.cc1[0]?.time;
    if (
      afterTransform.cc1Count !== afterCurve.cc1Count
      || JSON.stringify(afterTransform.cc1Values) === JSON.stringify(afterCurve.cc1Values)
      || !(transformSpan < curveSpan * 0.75)
      || !afterTransform.canUndo
    ) {
      throw new Error(`Controller transform failed: ${JSON.stringify({ afterCurve, afterTransform })}`);
    }
    const transformHistory = await assertControllerUndoRedo("Controller transform", curveHistory.afterRedo, afterTransform);
    const transformShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-transform.png");

    step = "stretch-transform";
    await clickInspectorButton(cdp, "Transform");
    await submitControllerDialog(cdp, {
      type: "transform",
      timeScalePercent: 150,
      valueScalePercent: 100,
      valueOffset: 0,
      tilt: 0,
    });
    const afterStretch = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const stretchSpan = afterStretch.cc1[afterStretch.cc1.length - 1]?.time - afterStretch.cc1[0]?.time;
    if (afterStretch.cc1Count !== afterTransform.cc1Count || !(stretchSpan > transformSpan * 1.35) || !afterStretch.canUndo) {
      throw new Error(`Controller stretch transform failed: ${JSON.stringify({ afterTransform, afterStretch, transformSpan, stretchSpan })}`);
    }
    const stretchHistory = await assertControllerUndoRedo("Controller stretch transform", transformHistory.afterRedo, afterStretch);

    step = "thin";
    await clickInspectorButton(cdp, "Thin");
    await submitControllerDialog(cdp, {
      type: "thin",
      tolerance: 8,
    });
    const afterThin = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (!(afterThin.cc1Count > 0 && afterThin.cc1Count < afterStretch.cc1Count) || !afterThin.canUndo) {
      throw new Error(`Controller thinning failed: ${JSON.stringify({ afterStretch, afterThin })}`);
    }
    const thinHistory = await assertControllerUndoRedo("Controller thinning", stretchHistory.afterRedo, afterThin);
    const thinShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-thin.png");

    step = "copy";
    await clickInspectorButton(cdp, "Copy");
    const afterCopy = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterCopy.pasteDisabled !== false) {
      throw new Error(`Controller copy did not enable paste: ${JSON.stringify(afterCopy)}`);
    }

    step = "cross-lane-paste";
    await setInputValue(cdp, "#pr-ins-cc-number", 74);
    await clickInspectorButton(cdp, "Paste");
    const afterCrossPaste = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterCrossPaste.selectedCC !== 74 || afterCrossPaste.cc74Count !== afterThin.cc1Count || afterCrossPaste.cc1Count !== afterThin.cc1Count) {
      throw new Error(`Controller cross-lane paste failed: ${JSON.stringify({ afterThin, afterCrossPaste })}`);
    }
    const crossPasteHistory = await assertControllerUndoRedo("Controller cross-lane paste", thinHistory.afterRedo, afterCrossPaste);
    const afterCrossPasteUndo = crossPasteHistory.afterUndo;
    const afterCrossPasteRedo = crossPasteHistory.afterRedo;
    await setInputValue(cdp, "#pr-ins-cc-number", 1);

    step = "clear";
    await clickInspectorButton(cdp, "Clear");
    const afterClear = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterClear.cc1Count !== 0 || afterClear.cc33Count !== 1 || afterClear.cc74Count !== afterThin.cc1Count) {
      throw new Error(`Controller clear failed or cleared unrelated CC data: ${JSON.stringify(afterClear)}`);
    }
    const clearHistory = await assertControllerUndoRedo("Controller clear", afterCrossPasteRedo, afterClear);
    const clearShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-clear.png");

    step = "paste";
    await clickInspectorButton(cdp, "Paste");
    const afterPaste = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterPaste.cc1Count !== afterThin.cc1Count || afterPaste.cc1Max !== afterThin.cc1Max || afterPaste.cc1Min !== afterThin.cc1Min) {
      throw new Error(`Controller paste failed: ${JSON.stringify({ afterThin, afterPaste })}`);
    }
    const pasteHistory = await assertControllerUndoRedo("Controller same-lane paste", clearHistory.afterRedo, afterPaste);
    const pasteShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-paste.png");

    step = "lfo";
    await clickInspectorButton(cdp, "LFO");
    await submitControllerDialog(cdp, {
      type: "lfo",
      rateHz: 3,
      centerValue: 64,
      depth: 28,
    });
    const afterLFO = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (afterLFO.cc1Count <= afterPaste.cc1Count || afterLFO.cc1Min > 40 || afterLFO.cc1Max < 88 || !afterLFO.canUndo) {
      throw new Error(`Controller LFO generation failed: ${JSON.stringify({ afterPaste, afterLFO })}`);
    }
    const lfoHistory = await assertControllerUndoRedo("Controller LFO generation", pasteHistory.afterRedo, afterLFO);
    const lfoShot = await screenshot(cdp, args.outDir, "piano-controller-lane-after-lfo.png");

    return {
      scenario: "piano-controller-lane",
      status: "passed",
      before,
      beforeState,
      afterCurve,
      afterTransform,
      afterStretch,
      afterThin,
      afterCopy,
      afterCrossPaste,
      afterCrossPasteUndo,
      afterCrossPasteRedo,
      afterClear,
      afterPaste,
      afterLFO,
      histories: {
        curveHistory,
        transformHistory,
        stretchHistory,
        thinHistory,
        crossPasteHistory,
        clearHistory,
        pasteHistory,
        lfoHistory,
      },
      screenshots: [beforeShot, curveShot, transformShot, thinShot, clearShot, pasteShot, lfoShot],
    };
  } catch (error) {
    throw new Error(`piano-controller-lane ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoControllerShapes(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  const ccSignature = (state) => JSON.stringify(
    state.cc1.map((event) => ({
      time: Number(event.time.toFixed(6)),
      value: event.value,
    })),
  );
  try {
    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "cc-1" }));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    await evalInPage(cdp, `
      (() => {
        window.__studio13QAPromptCalls = 0;
        window.prompt = () => {
          window.__studio13QAPromptCalls += 1;
          return null;
        };
        return true;
      })()
    `);
    const beforeState = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "piano-controller-shapes-before.png");

    step = "ramp-line";
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "linear",
      startValue: 10,
      endValue: 110,
    });
    const afterRamp = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const rampMidpoint = afterRamp.cc1[Math.floor(afterRamp.cc1.length / 2)];
    if (
      afterRamp.cc1Count <= beforeState.cc1Count
      || afterRamp.cc1[0]?.value !== 10
      || afterRamp.cc1[afterRamp.cc1.length - 1]?.value !== 110
      || !rampMidpoint
      || rampMidpoint.value < 55
      || rampMidpoint.value > 65
      || afterRamp.promptCalls !== 0
      || !afterRamp.canUndo
    ) {
      throw new Error(`Controller ramp generation failed: ${JSON.stringify({ beforeState, afterRamp, rampMidpoint })}`);
    }
    const rampShot = await screenshot(cdp, args.outDir, "piano-controller-shapes-after-ramp.png");

    step = "undo-ramp";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterRampUndo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterRampUndo) !== ccSignature(beforeState) || !afterRampUndo.canRedo) {
      throw new Error(`Undo after ramp line failed: ${JSON.stringify({ beforeState, afterRamp, afterRampUndo })}`);
    }
    await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const afterRampRedo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterRampRedo) !== ccSignature(afterRamp)) {
      throw new Error(`Redo after ramp line failed: ${JSON.stringify({ afterRamp, afterRampRedo })}`);
    }
    await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    const afterRampRedoUndo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterRampRedoUndo) !== ccSignature(beforeState)) {
      throw new Error(`Undo after ramp redo failed to reset state: ${JSON.stringify({ beforeState, afterRampRedoUndo })}`);
    }

    step = "step-line";
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "step",
      startValue: 18,
      endValue: 118,
    });
    const afterStep = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const stepValues = [...new Set(afterStep.cc1Values)];
    if (
      afterStep.cc1Count <= beforeState.cc1Count
      || stepValues.length !== 2
      || !stepValues.includes(18)
      || !stepValues.includes(118)
      || afterStep.cc1[0]?.value !== 18
      || afterStep.cc1[afterStep.cc1.length - 1]?.value !== 118
      || afterStep.promptCalls !== 0
      || !afterStep.canUndo
    ) {
      throw new Error(`Controller step line generation failed: ${JSON.stringify({ beforeState, afterStep, stepValues })}`);
    }
    const stepShot = await screenshot(cdp, args.outDir, "piano-controller-shapes-after-step.png");

    step = "undo-step";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterStepUndo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterStepUndo) !== ccSignature(beforeState) || !afterStepUndo.canRedo) {
      throw new Error(`Undo after step line failed: ${JSON.stringify({ beforeState, afterStep, afterStepUndo })}`);
    }
    await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const afterStepRedo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterStepRedo) !== ccSignature(afterStep)) {
      throw new Error(`Redo after step line failed: ${JSON.stringify({ afterStep, afterStepRedo })}`);
    }
    await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    const afterStepRedoUndo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterStepRedoUndo) !== ccSignature(beforeState)) {
      throw new Error(`Undo after step redo failed to reset state: ${JSON.stringify({ beforeState, afterStepRedoUndo })}`);
    }

    step = "parabola-line";
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "parabola",
      startValue: 0,
      endValue: 120,
    });
    const afterParabola = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    const midpoint = afterParabola.cc1[Math.floor(afterParabola.cc1.length / 2)];
    if (
      afterParabola.cc1Count <= beforeState.cc1Count
      || afterParabola.cc1[0]?.value !== 0
      || afterParabola.cc1[afterParabola.cc1.length - 1]?.value < 119
      || !midpoint
      || midpoint.value >= 45
      || afterParabola.promptCalls !== 0
      || !afterParabola.canUndo
    ) {
      throw new Error(`Controller parabola generation failed: ${JSON.stringify({ beforeState, afterParabola, midpoint })}`);
    }
    const parabolaShot = await screenshot(cdp, args.outDir, "piano-controller-shapes-after-parabola.png");

    step = "undo-parabola";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterParabolaUndo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterParabolaUndo) !== ccSignature(beforeState) || !afterParabolaUndo.canRedo) {
      throw new Error(`Undo after parabola line failed: ${JSON.stringify({ beforeState, afterParabola, afterParabolaUndo })}`);
    }
    await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const afterParabolaRedo = await evalInPage(cdp, pianoControllerLaneStateExpression(storeUrl));
    if (ccSignature(afterParabolaRedo) !== ccSignature(afterParabola)) {
      throw new Error(`Redo after parabola line failed: ${JSON.stringify({ afterParabola, afterParabolaRedo })}`);
    }

    return {
      scenario: "piano-controller-shapes",
      status: "passed",
      before,
      beforeState,
      afterRamp,
      afterRampUndo,
      afterRampRedo,
      afterStep,
      afterStepUndo,
      afterStepRedo,
      afterParabola,
      afterParabolaUndo,
      afterParabolaRedo,
      screenshots: [beforeShot, rampShot, stepShot, parabolaShot],
    };
  } catch (error) {
    throw new Error(`piano-controller-shapes ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoVelocityLine(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1180, 780);
  try {
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "velocity" }));
    const beforeState = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const beforeVelocities = beforeState.pairs.map((pair) => pair.velocity);
    const beforeShot = await screenshot(cdp, args.outDir, "piano-velocity-line-before.png");

    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "linear",
      startValue: 30,
      endValue: 110,
    });
    const afterLine = await evalInPage(cdp, pianoToolStateExpression(storeUrl));
    const afterVelocities = afterLine.pairs.map((pair) => pair.velocity);
    if (
      afterLine.pairCount < 3
      || afterVelocities[0] !== 30
      || !(afterVelocities[1] > afterVelocities[0])
      || !(afterVelocities[2] > afterVelocities[1])
      || !afterLine.canUndo
    ) {
      throw new Error(`Velocity lane line generation failed: ${JSON.stringify({ beforeState, afterLine })}`);
    }
    const lineShot = await screenshot(cdp, args.outDir, "piano-velocity-line-after-ramp.png");

    const afterUndo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "undo"));
    const undoVelocities = afterUndo.pairs.map((pair) => pair.velocity);
    if (JSON.stringify(undoVelocities) !== JSON.stringify(beforeVelocities) || !afterUndo.canRedo) {
      throw new Error(`Velocity lane line undo failed: ${JSON.stringify({ beforeVelocities, undoVelocities, afterUndo })}`);
    }

    const afterRedo = await evalInPage(cdp, pianoUndoRedoDetailedStateExpression(storeUrl, "redo"));
    const redoVelocities = afterRedo.pairs.map((pair) => pair.velocity);
    if (JSON.stringify(redoVelocities) !== JSON.stringify(afterVelocities)) {
      throw new Error(`Velocity lane line redo failed: ${JSON.stringify({ afterVelocities, redoVelocities, afterRedo })}`);
    }

    return {
      scenario: "piano-velocity-line",
      status: "passed",
      before,
      beforeVelocities,
      afterVelocities,
      undoVelocities,
      redoVelocities,
      screenshots: [beforeShot, lineShot],
    };
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoCCDirect(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  const ccSignature = (state) => JSON.stringify(
    state.cc1.map((event) => ({
      time: Number(event.time.toFixed(6)),
      value: event.value,
      channel: event.channel,
    })),
  );
  const cc74Signature = (state) => JSON.stringify(
    state.cc74.map((event) => ({
      time: Number(event.time.toFixed(6)),
      value: event.value,
      channel: event.channel,
    })),
  );
  try {
    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "cc-1" }));
    if (!before.hasEditor || before.activeLane?.kind !== "cc7") {
      throw new Error(`Piano roll did not render CC#1 lane fixture: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (beforeState.selectedCC !== 1) {
      throw new Error(`CC#1 lane did not select controller 1: ${JSON.stringify(beforeState)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-cc-direct-before.png");

    step = "direct-draw";
    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const laneHeight = before.activeLane?.height ?? 88;
    const laneTop = stageTop + before.canvas.height - laneHeight;
    await drag(cdp, xAt(1.25), laneTop + laneHeight * 0.2, xAt(1.5), laneTop + laneHeight * 0.12, { steps: 8, settleMs: 450 });
    const afterDraw = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    const drawnCC = afterDraw.cc1.filter((event) => event.time >= 1.12 && event.time <= 1.63);
    if (afterDraw.cc1Count <= beforeState.cc1Count || drawnCC.length === 0 || !drawnCC.some((event) => event.value >= 95) || !afterDraw.canUndo) {
      throw new Error(`Direct CC#1 lane draw failed: ${JSON.stringify({ beforeState, afterDraw, drawnCC })}`);
    }
    if (!drawnCC.some((drawn) => afterDraw.backendCC1.some((event) =>
      Math.abs(event.timestamp - drawn.time) < 0.0001 && event.value === drawn.value
    ))) {
      throw new Error(`Serialized MIDI payload missed drawn CC#1 data: ${JSON.stringify({ drawnCC, backendCC1: afterDraw.backendCC1 })}`);
    }
    const drawShot = await screenshot(cdp, args.outDir, "piano-cc-direct-after-draw.png");

    step = "undo";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterUndo = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (ccSignature(afterUndo) !== ccSignature(beforeState) || !afterUndo.canRedo) {
      throw new Error(`Undo after direct CC#1 draw failed: ${JSON.stringify({ beforeState, afterDraw, afterUndo })}`);
    }
    step = "redo";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().redo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterRedo = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (ccSignature(afterRedo) !== ccSignature(afterDraw) || !afterRedo.canUndo) {
      throw new Error(`Redo after direct CC#1 draw failed: ${JSON.stringify({ beforeState, afterDraw, afterUndo, afterRedo })}`);
    }
    step = "undo-after-redo";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterRedoUndo = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (ccSignature(afterRedoUndo) !== ccSignature(beforeState) || !afterRedoUndo.canRedo) {
      throw new Error(`Undo after direct CC#1 redo failed: ${JSON.stringify({ beforeState, afterRedo, afterRedoUndo })}`);
    }

    step = "select-cc74";
    await setInputValue(cdp, "#pr-ins-cc-number", 74);
    const afterSelectCC74 = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (afterSelectCC74.selectedCC !== 74 || afterSelectCC74.cc74Count !== 0) {
      throw new Error(`Arbitrary CC number selection failed: ${JSON.stringify({ afterUndo, afterSelectCC74 })}`);
    }

    step = "direct-draw-cc74";
    await drag(cdp, xAt(1.75), laneTop + laneHeight * 0.72, xAt(1.875), laneTop + laneHeight * 0.68, { steps: 6, settleMs: 450 });
    const afterCC74Draw = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    const drawnCC74 = afterCC74Draw.cc74.filter((event) => event.time >= 1.62 && event.time <= 1.98);
    if (afterCC74Draw.selectedCC !== 74 || drawnCC74.length === 0 || !drawnCC74.some((event) => event.value <= 45) || !afterCC74Draw.canUndo) {
      throw new Error(`Direct arbitrary CC#74 draw failed: ${JSON.stringify({ afterSelectCC74, afterCC74Draw, drawnCC74 })}`);
    }
    if (!drawnCC74.some((drawn) => afterCC74Draw.backendCC74.some((event) =>
      Math.abs(event.timestamp - drawn.time) < 0.0001 && event.value === drawn.value
    ))) {
      throw new Error(`Serialized MIDI payload missed drawn CC#74 data: ${JSON.stringify({ drawnCC74, backendCC74: afterCC74Draw.backendCC74 })}`);
    }
    const drawCC74Shot = await screenshot(cdp, args.outDir, "piano-cc-direct-after-cc74-draw.png");

    step = "undo-cc74";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterCC74Undo = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (afterCC74Undo.cc74Count !== 0 || ccSignature(afterCC74Undo) !== ccSignature(beforeState) || !afterCC74Undo.canRedo) {
      throw new Error(`Undo after direct CC#74 draw failed: ${JSON.stringify({ beforeState, afterCC74Draw, afterCC74Undo })}`);
    }
    step = "redo-cc74";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().redo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterCC74Redo = await evalInPage(cdp, pianoCCDirectStateExpression(args.baseUrl, storeUrl));
    if (
      cc74Signature(afterCC74Redo) !== cc74Signature(afterCC74Draw)
      || ccSignature(afterCC74Redo) !== ccSignature(beforeState)
      || !afterCC74Redo.canUndo
    ) {
      throw new Error(`Redo after direct CC#74 draw failed: ${JSON.stringify({ beforeState, afterCC74Draw, afterCC74Undo, afterCC74Redo })}`);
    }

    return {
      scenario: "piano-cc-direct",
      status: "passed",
      before,
      beforeState,
      afterDraw,
      drawnCC,
      afterUndo,
      afterRedo,
      afterRedoUndo,
      afterSelectCC74,
      afterCC74Draw,
      drawnCC74,
      afterCC74Undo,
      afterCC74Redo,
      screenshots: [beforeShot, drawShot, drawCC74Shot],
    };
  } catch (error) {
    throw new Error(`piano-cc-direct ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoNoteMetadataLanes(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  try {
    const metadataSignature = (state) => JSON.stringify({
      releaseVelocity: state.releaseVelocity,
      probabilityPercent: state.probabilityPercent,
      velocityVariance: state.velocityVariance,
    });
    const assertMetadataUndoRedo = async (name, beforeAction, afterAction) => {
      step = `${name}-undo`;
      const afterUndo = await evalInPage(cdp, pianoNoteMetadataLaneUndoRedoStateExpression(storeUrl, "undo"));
      if (metadataSignature(afterUndo) !== metadataSignature(beforeAction) || !afterUndo.canRedo) {
        throw new Error(`${name} undo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo })}`);
      }
      step = `${name}-redo`;
      const afterRedo = await evalInPage(cdp, pianoNoteMetadataLaneUndoRedoStateExpression(storeUrl, "redo"));
      if (metadataSignature(afterRedo) !== metadataSignature(afterAction) || !afterRedo.canUndo) {
        throw new Error(`${name} redo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo, afterRedo })}`);
      }
      return { afterUndo, afterRedo };
    };

    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "off-vel" }));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    if (!beforeState.laneLabels.includes("Note-Off Velocity") || !beforeState.laneLabels.includes("Chance") || !beforeState.laneLabels.includes("Velocity Variance")) {
      throw new Error(`Note metadata lane fixture missing lane rows: ${JSON.stringify(beforeState)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-note-metadata-lanes-before.png");

    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const laneHeight = 68;
    const laneTop = stageTop + before.canvas.height - laneHeight;

    step = "note-off-velocity-drag";
    await drag(cdp, xAt(0.25), laneTop + laneHeight - 8, xAt(0.25), laneTop + 4, { steps: 6, settleMs: 350 });
    const afterOffVelocity = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    if (afterOffVelocity.releaseVelocity < 110 || !afterOffVelocity.canUndo) {
      throw new Error(`Note-off velocity lane drag failed: ${JSON.stringify({ beforeState, afterOffVelocity })}`);
    }
    const offVelocityHistory = await assertMetadataUndoRedo("Note-off velocity lane drag", beforeState, afterOffVelocity);
    const offVelocityShot = await screenshot(cdp, args.outDir, "piano-note-metadata-lanes-after-off-velocity.png");

    step = "chance-lane-drag";
    await clickLaneByLabel(cdp, "Chance");
    const beforeChanceDrag = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    await drag(cdp, xAt(0.25), laneTop + 6, xAt(0.25), laneTop + laneHeight - 8, { steps: 6, settleMs: 350 });
    const afterChance = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    if (afterChance.activeLane?.kind !== "chance" || afterChance.probabilityPercent > 25 || !afterChance.canUndo) {
      throw new Error(`Chance lane drag failed: ${JSON.stringify({ afterOffVelocity, afterChance })}`);
    }
    const chanceHistory = await assertMetadataUndoRedo("Chance lane drag", beforeChanceDrag, afterChance);
    const chanceShot = await screenshot(cdp, args.outDir, "piano-note-metadata-lanes-after-chance.png");

    step = "variance-lane-drag";
    await clickLaneByLabel(cdp, "Velocity Variance");
    const beforeVarianceDrag = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    if (beforeVarianceDrag.velocityVariance !== afterChance.velocityVariance) {
      throw new Error(`Selecting velocity variance lane changed data before drag: ${JSON.stringify({ afterChance, beforeVarianceDrag })}`);
    }
    await drag(cdp, xAt(0.25), laneTop + laneHeight - 8, xAt(0.25), laneTop + 6, { steps: 6, settleMs: 350 });
    const afterVariance = await evalInPage(cdp, pianoNoteMetadataLaneStateExpression(storeUrl));
    if (afterVariance.activeLane?.kind !== "velocityVariance" || afterVariance.velocityVariance < 100 || !afterVariance.canUndo) {
      throw new Error(`Velocity variance lane drag failed: ${JSON.stringify({ afterChance, afterVariance })}`);
    }
    const varianceHistory = await assertMetadataUndoRedo("Velocity variance lane drag", beforeVarianceDrag, afterVariance);
    const varianceShot = await screenshot(cdp, args.outDir, "piano-note-metadata-lanes-after-variance.png");

    return {
      scenario: "piano-note-metadata-lanes",
      status: "passed",
      before,
      beforeState,
      afterOffVelocity,
      beforeChanceDrag,
      afterChance,
      beforeVarianceDrag,
      afterVariance,
      histories: {
        offVelocityHistory,
        chanceHistory,
        varianceHistory,
      },
      screenshots: [beforeShot, offVelocityShot, chanceShot, varianceShot],
    };
  } catch (error) {
    throw new Error(`piano-note-metadata-lanes ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoPitchBendDirect(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  const pitchSignature = (state) => JSON.stringify(
    state.pitchBends.map((event) => ({
      time: Number(event.time.toFixed(6)),
      value: event.value,
      channel: event.channel,
    })),
  );
  try {
    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "pitch-bend" }));
    if (!before.hasEditor || before.activeLane?.kind !== "pitchBend") {
      throw new Error(`Piano roll did not render pitchbend lane fixture: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoPitchBendDirectStateExpression(args.baseUrl, storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "piano-pitchbend-direct-before.png");

    step = "enable-snap";
    await setCheckboxValue(cdp, "#pr-ins-pb-snap", true);
    const afterSnap = await evalInPage(cdp, pianoPitchBendDirectStateExpression(args.baseUrl, storeUrl));
    if (!afterSnap.snapChecked) {
      throw new Error(`Pitchbend snap checkbox did not enable: ${JSON.stringify(afterSnap)}`);
    }

    step = "direct-draw";
    const stageLeft = before.canvas.left;
    const stageTop = before.canvas.top;
    const xAt = (time) => stageLeft + time * 200;
    const laneHeight = before.activeLane?.height ?? 96;
    const laneTop = stageTop + before.canvas.height - laneHeight;
    await drag(cdp, xAt(1.25), laneTop + laneHeight * 0.22, xAt(1.5), laneTop + laneHeight * 0.18, { steps: 8, settleMs: 450 });
    const afterDraw = await evalInPage(cdp, pianoPitchBendDirectStateExpression(args.baseUrl, storeUrl));
    const drawnBends = afterDraw.pitchBends.filter((event) => event.time >= 1.12 && event.time <= 1.63);
    const snappedBends = drawnBends.filter((event) =>
      Math.abs(event.semitones - Math.round(event.semitones)) < 0.025
      && Math.abs(event.semitones) >= 1
    );
    if (afterDraw.pitchBendCount <= beforeState.pitchBendCount || snappedBends.length === 0 || !afterDraw.canUndo) {
      throw new Error(`Direct snapped pitchbend draw failed: ${JSON.stringify({ beforeState, afterSnap, afterDraw, drawnBends, snappedBends })}`);
    }
    if (!snappedBends.some((drawn) => afterDraw.backendPitchBends.some((event) =>
      Math.abs(event.timestamp - drawn.time) < 0.0001 && event.value === drawn.value
    ))) {
      throw new Error(`Serialized MIDI payload missed drawn pitchbend: ${JSON.stringify({ snappedBends, backendPitchBends: afterDraw.backendPitchBends })}`);
    }
    const afterDrawShot = await screenshot(cdp, args.outDir, "piano-pitchbend-direct-after-draw.png");

    step = "undo";
    const afterUndo = await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().undo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    if (!afterUndo) {
      throw new Error("Pitchbend undo did not run");
    }
    const afterUndoState = await evalInPage(cdp, pianoPitchBendDirectStateExpression(args.baseUrl, storeUrl));
    if (pitchSignature(afterUndoState) !== pitchSignature(beforeState) || !afterUndoState.canRedo) {
      throw new Error(`Undo after pitchbend direct draw failed: ${JSON.stringify({ beforeState, afterDraw, afterUndoState })}`);
    }
    step = "redo";
    await evalInPage(cdp, `
      (async () => {
        const useDAWStore = window.__studio13QADAWStore ?? (await import('${storeUrl}')).useDAWStore;
        useDAWStore.getState().redo();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      })()
    `);
    const afterRedoState = await evalInPage(cdp, pianoPitchBendDirectStateExpression(args.baseUrl, storeUrl));
    if (pitchSignature(afterRedoState) !== pitchSignature(afterDraw) || !afterRedoState.canUndo) {
      throw new Error(`Redo after pitchbend direct draw failed: ${JSON.stringify({ beforeState, afterDraw, afterUndoState, afterRedoState })}`);
    }

    return {
      scenario: "piano-pitchbend-direct",
      status: "passed",
      before,
      beforeState,
      afterSnap,
      afterDraw,
      snappedBends,
      afterUndoState,
      afterRedoState,
      screenshots: [beforeShot, afterDrawShot],
    };
  } catch (error) {
    throw new Error(`piano-pitchbend-direct ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoAdvancedLanes(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  try {
    const normalizeEvents = (events = []) => events
      .map((event) => ({
        time: Number(Number(event.time ?? 0).toFixed(6)),
        value: event.value,
        note: event.note ?? null,
        channel: event.channel ?? null,
      }))
      .sort((a, b) => a.time - b.time || (a.note ?? -1) - (b.note ?? -1) || (a.value ?? -1) - (b.value ?? -1) || (a.channel ?? -1) - (b.channel ?? -1));
    const advancedSignature = (state) => JSON.stringify({
      pitchBends: normalizeEvents(state.pitchBends),
      cc0: normalizeEvents(state.cc0),
      cc1: normalizeEvents(state.cc1),
      cc32: normalizeEvents(state.cc32),
      cc33: normalizeEvents(state.cc33),
      program: normalizeEvents(state.program),
      channelPressure: normalizeEvents(state.channelPressure),
      polyPressure: normalizeEvents(state.polyPressure),
    });
    const assertAdvancedUndoRedo = async (name, beforeAction, afterAction) => {
      step = `${name}-undo`;
      const afterUndo = await evalInPage(cdp, pianoAdvancedLaneUndoRedoStateExpression(storeUrl, "undo"));
      if (advancedSignature(afterUndo) !== advancedSignature(beforeAction) || !afterUndo.canRedo) {
        throw new Error(`${name} undo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo })}`);
      }
      step = `${name}-redo`;
      const afterRedo = await evalInPage(cdp, pianoAdvancedLaneUndoRedoStateExpression(storeUrl, "redo"));
      if (advancedSignature(afterRedo) !== advancedSignature(afterAction) || !afterRedo.canUndo) {
        throw new Error(`${name} redo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo, afterRedo })}`);
      }
      return { afterUndo, afterRedo };
    };

    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "pitch-bend" }));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    const beforeShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-before.png");

    step = "pitchbend-line";
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "linear",
      startValue: -2,
      endValue: 4,
    });
    const afterPitch = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (
      afterPitch.pitchBendCount <= beforeState.pitchBendCount
      || afterPitch.pitchBendMin >= 8192
      || afterPitch.pitchBendMax <= 8192
      || !afterPitch.canUndo
    ) {
      throw new Error(`Pitchbend line generation failed: ${JSON.stringify({ beforeState, afterPitch })}`);
    }
    const pitchHistory = await assertAdvancedUndoRedo("Pitchbend line generation", beforeState, afterPitch);
    const pitchShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-pitchbend.png");

    step = "cc14-line";
    await clickInspectorButton(cdp, "CC14");
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "curve",
      curve: 0.25,
      startValue: 1000,
      endValue: 15000,
    });
    const afterCC14 = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (
      afterCC14.cc1Count <= beforeState.cc1Count
      || afterCC14.cc33Count <= beforeState.cc33Count
      || afterCC14.cc1Count !== afterCC14.cc33Count
      || !afterCC14.canUndo
    ) {
      throw new Error(`14-bit CC line generation failed: ${JSON.stringify({ beforeState, afterCC14 })}`);
    }
    const cc14History = await assertAdvancedUndoRedo("14-bit CC line generation", pitchHistory.afterRedo, afterCC14);
    const cc14Shot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-cc14.png");

    step = "program-line";
    await clickInspectorButton(cdp, "Program");
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "step",
      startValue: 5,
      endValue: 21,
    });
    const afterProgram = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (afterProgram.program.length < 2 || !afterProgram.program.some((event) => event.value === 5) || !afterProgram.program.some((event) => event.value === 21) || !afterProgram.canUndo) {
      throw new Error(`Program lane generation failed: ${JSON.stringify(afterProgram)}`);
    }
    const programHistory = await assertAdvancedUndoRedo("Program lane generation", cc14History.afterRedo, afterProgram);
    const programShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-program.png");

    step = "bank-msb-line";
    await setSelectValue(cdp, "#pr-ins-controller", 0);
    await setCheckboxValue(cdp, "#pr-ins-cc14", false);
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "step",
      startValue: 3,
      endValue: 9,
    });
    const afterBankMSB = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (
      afterBankMSB.cc0Count <= beforeState.cc0Count
      || !afterBankMSB.cc0.some((event) => event.value === 3)
      || !afterBankMSB.cc0.some((event) => event.value === 9)
      || !afterBankMSB.canUndo
    ) {
      throw new Error(`Bank MSB lane generation failed: ${JSON.stringify({ beforeState, afterBankMSB })}`);
    }
    const bankMSBHistory = await assertAdvancedUndoRedo("Bank MSB lane generation", programHistory.afterRedo, afterBankMSB);
    const bankMSBShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-bank-msb.png");

    step = "bank-lsb-line";
    await setSelectValue(cdp, "#pr-ins-controller", 32);
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "step",
      startValue: 44,
      endValue: 88,
    });
    const afterBankLSB = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (
      afterBankLSB.cc32Count <= beforeState.cc32Count
      || !afterBankLSB.cc32.some((event) => event.value === 44)
      || !afterBankLSB.cc32.some((event) => event.value === 88)
      || !afterBankLSB.canUndo
    ) {
      throw new Error(`Bank LSB lane generation failed: ${JSON.stringify({ beforeState, afterBankLSB })}`);
    }
    const bankLSBHistory = await assertAdvancedUndoRedo("Bank LSB lane generation", bankMSBHistory.afterRedo, afterBankLSB);
    const bankLSBShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-bank-lsb.png");

    step = "channel-pressure-line";
    await clickInspectorButton(cdp, "Pressure");
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "linear",
      startValue: 18,
      endValue: 99,
    });
    const afterPressure = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    if (afterPressure.channelPressure.length < 2 || !afterPressure.channelPressure.some((event) => event.value <= 18) || !afterPressure.channelPressure.some((event) => event.value >= 99) || !afterPressure.canUndo) {
      throw new Error(`Channel pressure lane generation failed: ${JSON.stringify(afterPressure)}`);
    }
    const pressureHistory = await assertAdvancedUndoRedo("Channel pressure lane generation", bankLSBHistory.afterRedo, afterPressure);
    const pressureShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-pressure.png");

    step = "poly-pressure-line";
    await clickInspectorButton(cdp, "Poly");
    await setInputValue(cdp, "#pr-ins-poly-note", 64);
    await clickInspectorButton(cdp, "Line");
    await submitControllerDialog(cdp, {
      type: "line",
      interpolation: "linear",
      startValue: 11,
      endValue: 87,
    });
    const afterPoly = await evalInPage(cdp, pianoAdvancedLaneStateExpression(storeUrl));
    const poly64 = afterPoly.polyPressure.filter((event) => event.note === 64);
    if (poly64.length < 2 || !poly64.some((event) => event.value <= 11) || !poly64.some((event) => event.value >= 87) || !afterPoly.canUndo) {
      throw new Error(`Poly pressure lane generation failed: ${JSON.stringify(afterPoly)}`);
    }
    const polyHistory = await assertAdvancedUndoRedo("Poly pressure lane generation", pressureHistory.afterRedo, afterPoly);
    const polyShot = await screenshot(cdp, args.outDir, "piano-advanced-lanes-after-poly-pressure.png");

    step = "backend-payload";
    const backendPayload = await evalInPage(cdp, pianoAdvancedLaneBackendPayloadExpression(args.baseUrl, storeUrl));
    if (
      !backendPayload.hasPitchBend
      || !backendPayload.hasBankMSB
      || !backendPayload.hasBankLSB
      || !backendPayload.hasCC14MSB
      || !backendPayload.hasCC14LSB
      || !backendPayload.hasProgram
      || !backendPayload.hasChannelPressure
      || !backendPayload.hasPolyPressure
    ) {
      throw new Error(`Advanced lane backend payload missing generated metadata: ${JSON.stringify(backendPayload)}`);
    }

    return {
      scenario: "piano-advanced-lanes",
      status: "passed",
      before,
      beforeState,
      afterPitch,
      afterCC14,
      afterProgram,
      afterBankMSB,
      afterBankLSB,
      afterPressure,
      afterPoly,
      histories: {
        pitchHistory,
        cc14History,
        programHistory,
        bankMSBHistory,
        bankLSBHistory,
        pressureHistory,
        polyHistory,
      },
      backendPayload,
      screenshots: [beforeShot, pitchShot, cc14Shot, programShot, bankMSBShot, bankLSBShot, pressureShot, polyShot],
    };
  } catch (error) {
    throw new Error(`piano-advanced-lanes ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function runPianoLaneManagement(args) {
  const storeUrl = await resolveStoreUrl(args.baseUrl, "/src/components/PianoRoll.tsx");
  const cdp = await openTab(args, 1200, 760);
  let step = "start";
  try {
    const rangeSignature = (state) => JSON.stringify({
      up: state.pitchBendRangeUp,
      down: state.pitchBendRangeDown,
      linked: Boolean(state.pitchBendRangeLinked),
    });
    const assertRangeUndoRedo = async (name, beforeAction, afterAction) => {
      step = `${name}-undo`;
      const afterUndo = await evalInPage(cdp, pianoLaneManagementUndoRedoStateExpression(storeUrl, "undo"));
      if (rangeSignature(afterUndo) !== rangeSignature(beforeAction) || !afterUndo.canRedo) {
        throw new Error(`${name} undo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo })}`);
      }
      step = `${name}-redo`;
      const afterRedo = await evalInPage(cdp, pianoLaneManagementUndoRedoStateExpression(storeUrl, "redo"));
      if (rangeSignature(afterRedo) !== rangeSignature(afterAction) || !afterRedo.canUndo) {
        throw new Error(`${name} redo failed: ${JSON.stringify({ beforeAction, afterAction, afterUndo, afterRedo })}`);
      }
      return { afterUndo, afterRedo };
    };

    step = "fixture";
    const before = await evalInPage(cdp, pianoFixtureExpression(args.baseUrl, storeUrl, { activeLaneId: "pitch-bend" }));
    if (!before.hasEditor) {
      throw new Error(`Piano roll did not render expected shell: ${JSON.stringify(before)}`);
    }
    const beforeState = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (!beforeState.laneLabels.includes("CC#1 Modulation") || beforeState.pitchBendRangeLinked !== false) {
      throw new Error(`Lane management fixture not ready: ${JSON.stringify(beforeState)}`);
    }
    const beforeShot = await screenshot(cdp, args.outDir, "piano-lane-management-before.png");

    step = "hide-cc1-lane";
    await removeLaneByLabel(cdp, "CC#1 Modulation");
    const afterHide = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (afterHide.laneLabels.includes("CC#1 Modulation") || afterHide.cc1Count !== beforeState.cc1Count || afterHide.cc33Count !== beforeState.cc33Count) {
      throw new Error(`Hiding CC#1 lane deleted data or failed to hide row: ${JSON.stringify({ beforeState, afterHide })}`);
    }
    const hideShot = await screenshot(cdp, args.outDir, "piano-lane-management-after-hide.png");

    step = "add-cc14-lane";
    await clickInspectorButton(cdp, "CC14");
    const afterAdd = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    const addedCC14 = afterAdd.lanes.find((lane) => lane.kind === "cc14" && lane.cc === 1);
    if (!addedCC14 || afterAdd.activeLane?.id !== addedCC14.id || afterAdd.cc1Count !== beforeState.cc1Count || afterAdd.cc33Count !== beforeState.cc33Count) {
      throw new Error(`Adding CC14 lane failed or touched CC data: ${JSON.stringify({ afterAdd })}`);
    }
    const addShot = await screenshot(cdp, args.outDir, "piano-lane-management-after-add-cc14.png");

    step = "configure-cc14-lane";
    await configureLaneRow(cdp, "14-bit CC#1/33", { height: 120, interpolation: "curve" });
    const afterConfigure = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    const configuredCC14 = afterConfigure.lanes.find((lane) => lane.kind === "cc14" && lane.cc === 1);
    if (!configuredCC14 || configuredCC14.height !== 120 || configuredCC14.interpolation !== "curve") {
      throw new Error(`Configuring CC14 lane controls failed: ${JSON.stringify({ afterConfigure })}`);
    }
    const configureShot = await screenshot(cdp, args.outDir, "piano-lane-management-after-configure.png");

    step = "pitchbend-linked";
    await setCheckboxValue(cdp, "#pr-ins-pb-link", true);
    const afterLinkToggle = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (afterLinkToggle.pitchBendRangeLinked !== true || !afterLinkToggle.canUndo) {
      throw new Error(`Linked pitchbend toggle failed: ${JSON.stringify(afterLinkToggle)}`);
    }
    const linkToggleHistory = await assertRangeUndoRedo("Linked pitchbend toggle", afterConfigure, afterLinkToggle);
    await setInputValue(cdp, "#pr-ins-pb-up", 9);
    const afterLinked = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (afterLinked.pitchBendRangeUp !== 9 || afterLinked.pitchBendRangeDown !== 9 || afterLinked.pitchBendRangeLinked !== true || !afterLinked.canUndo) {
      throw new Error(`Linked pitchbend range edit failed: ${JSON.stringify(afterLinked)}`);
    }
    const linkedRangeHistory = await assertRangeUndoRedo("Linked pitchbend range edit", linkToggleHistory.afterRedo, afterLinked);

    step = "pitchbend-unlinked";
    await setCheckboxValue(cdp, "#pr-ins-pb-link", false);
    const afterUnlinkToggle = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (afterUnlinkToggle.pitchBendRangeUp !== 9 || afterUnlinkToggle.pitchBendRangeDown !== 9 || afterUnlinkToggle.pitchBendRangeLinked !== false || !afterUnlinkToggle.canUndo) {
      throw new Error(`Unlinked pitchbend toggle failed: ${JSON.stringify(afterUnlinkToggle)}`);
    }
    const unlinkToggleHistory = await assertRangeUndoRedo("Unlinked pitchbend toggle", linkedRangeHistory.afterRedo, afterUnlinkToggle);
    await setInputValue(cdp, "#pr-ins-pb-down", 5);
    const afterUnlinked = await evalInPage(cdp, pianoLaneManagementStateExpression(storeUrl));
    if (afterUnlinked.pitchBendRangeUp !== 9 || afterUnlinked.pitchBendRangeDown !== 5 || afterUnlinked.pitchBendRangeLinked !== false || !afterUnlinked.canUndo) {
      throw new Error(`Unlinked pitchbend range edit failed: ${JSON.stringify(afterUnlinked)}`);
    }
    const unlinkedRangeHistory = await assertRangeUndoRedo("Unlinked pitchbend range edit", unlinkToggleHistory.afterRedo, afterUnlinked);
    const pitchbendShot = await screenshot(cdp, args.outDir, "piano-lane-management-after-pitchbend-range.png");

    return {
      scenario: "piano-lane-management",
      status: "passed",
      before,
      beforeState,
      afterHide,
      afterAdd,
      afterConfigure,
      afterLinkToggle,
      afterLinked,
      afterUnlinkToggle,
      afterUnlinked,
      histories: {
        linkToggleHistory,
        linkedRangeHistory,
        unlinkToggleHistory,
        unlinkedRangeHistory,
      },
      screenshots: [beforeShot, hideShot, addShot, configureShot, pitchbendShot],
    };
  } catch (error) {
    throw new Error(`piano-lane-management ${step}: ${error.message}`);
  } finally {
    await cdp.send("Page.close").catch(() => undefined);
    cdp.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await mkdir(args.outDir, { recursive: true });
  await assertServer(args.baseUrl, "Vite dev server");
  const launchedBrowser = await launchBrowserIfNeeded(args);

  const scenarios = args.scenario === "all"
    ? ["app-shortcuts", "app-docked-piano-focus", "app-midi-multi-session", "app-midi-recording-visibility", "midi-fx-controls", "midi-fx-placement", "midi-project-persistence", "midi-export-payload", "timeline-basic", "timeline-arrange", "timeline-actions", "timeline-cross-track", "timeline-drop-targets", "timeline-selection", "timeline-keyboard-actions", "timeline-snap-undo", "timeline-source-context", "timeline-backend-payload", "piano-basic", "piano-inspector", "piano-tools", "piano-range", "piano-multi-item", "piano-visual-viewports", "piano-responsive-toolbar", "piano-source-header", "piano-audition-insert", "piano-navigation-tools", "piano-controller-lane", "piano-controller-shapes", "piano-velocity-line", "piano-cc-direct", "piano-note-metadata-lanes", "piano-pitchbend-direct", "piano-advanced-lanes", "piano-lane-management"]
    : [args.scenario];

  const results = [];
  try {
    for (const scenario of scenarios) {
      if (scenario === "app-shortcuts") {
        results.push(await runAppShortcuts(args));
      } else if (scenario === "app-docked-piano-focus") {
        results.push(await runAppDockedPianoFocus(args));
      } else if (scenario === "app-midi-multi-session") {
        results.push(await runAppMidiMultiSession(args));
      } else if (scenario === "app-midi-recording-visibility") {
        results.push(await runAppMidiRecordingVisibility(args));
      } else if (scenario === "midi-fx-controls") {
        results.push(await runMIDIFXControls(args));
      } else if (scenario === "midi-fx-placement") {
        results.push(await runMIDIFXPlacement(args));
      } else if (scenario === "midi-project-persistence") {
        results.push(await runMIDIProjectPersistence(args));
      } else if (scenario === "midi-export-payload") {
        results.push(await runMIDIExportPayload(args));
      } else if (scenario === "timeline-basic") {
        results.push(await runTimelineBasic(args));
      } else if (scenario === "timeline-arrange") {
        results.push(await runTimelineArrange(args));
      } else if (scenario === "timeline-actions") {
        results.push(await runTimelineActions(args));
      } else if (scenario === "timeline-cross-track") {
        results.push(await runTimelineCrossTrack(args));
      } else if (scenario === "timeline-drop-targets") {
        results.push(await runTimelineDropTargets(args));
      } else if (scenario === "timeline-selection") {
        results.push(await runTimelineSelection(args));
      } else if (scenario === "timeline-keyboard-actions") {
        results.push(await runTimelineKeyboardActions(args));
      } else if (scenario === "timeline-snap-undo") {
        results.push(await runTimelineSnapUndo(args));
      } else if (scenario === "timeline-source-context") {
        results.push(await runTimelineSourceContext(args));
      } else if (scenario === "timeline-backend-payload") {
        results.push(await runTimelineBackendPayload(args));
      } else if (scenario === "piano-basic") {
        results.push(await runPianoBasic(args));
      } else if (scenario === "piano-inspector") {
        results.push(await runPianoInspector(args));
      } else if (scenario === "piano-tools") {
        results.push(await runPianoTools(args));
      } else if (scenario === "piano-range") {
        results.push(await runPianoRange(args));
      } else if (scenario === "piano-multi-item") {
        results.push(await runPianoMultiItem(args));
      } else if (scenario === "piano-visual-viewports") {
        results.push(await runPianoVisualViewports(args));
      } else if (scenario === "piano-responsive-toolbar") {
        results.push(await runPianoResponsiveToolbar(args));
      } else if (scenario === "piano-source-header") {
        results.push(await runPianoSourceHeader(args));
      } else if (scenario === "piano-audition-insert") {
        results.push(await runPianoAuditionInsert(args));
      } else if (scenario === "piano-navigation-tools") {
        results.push(await runPianoNavigationTools(args));
      } else if (scenario === "piano-controller-lane") {
        results.push(await runPianoControllerLane(args));
      } else if (scenario === "piano-controller-shapes") {
        results.push(await runPianoControllerShapes(args));
      } else if (scenario === "piano-velocity-line") {
        results.push(await runPianoVelocityLine(args));
      } else if (scenario === "piano-cc-direct") {
        results.push(await runPianoCCDirect(args));
      } else if (scenario === "piano-note-metadata-lanes") {
        results.push(await runPianoNoteMetadataLanes(args));
      } else if (scenario === "piano-pitchbend-direct") {
        results.push(await runPianoPitchBendDirect(args));
      } else if (scenario === "piano-advanced-lanes") {
        results.push(await runPianoAdvancedLanes(args));
      } else if (scenario === "piano-lane-management") {
        results.push(await runPianoLaneManagement(args));
      } else {
        throw new Error(`Unknown scenario: ${scenario}`);
      }
    }

    const report = {
      createdAt: new Date().toISOString(),
      baseUrl: args.baseUrl,
      scenarios: results,
    };
    const reportPath = path.join(args.outDir, "midi-editor-acceptance-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`MIDI editor acceptance harness passed. Report: ${reportPath}`);
  } finally {
    if (launchedBrowser && !args.keepBrowser) {
      launchedBrowser.kill();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
