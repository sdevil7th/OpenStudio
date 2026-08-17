#!/usr/bin/env node

import path from "node:path";

function parseArgs(argv) {
  const args = {
    cdpUrl: "http://127.0.0.1:9333",
    sourceFile: "",
    outputFile: path.resolve("qa/render-native/render-repro.wav"),
    duration: 10,
    timeoutMs: 120000,
    fxName: "",
    bitDepth: 24,
    channels: "stereo",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cdp" && next) args.cdpUrl = next;
    else if (arg === "--source" && next) args.sourceFile = path.resolve(next);
    else if (arg === "--output" && next) args.outputFile = path.resolve(next);
    else if (arg === "--duration" && next) args.duration = Number(next);
    else if (arg === "--timeout" && next) args.timeoutMs = Number(next);
    else if (arg === "--fx" && next) args.fxName = next;
    else if (arg === "--bit-depth" && next) args.bitDepth = Number(next);
    else if (arg === "--channels" && next) args.channels = next;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
    index += 1;
  }

  if (!args.sourceFile) throw new Error("--source is required");
  if (!(args.duration > 0)) throw new Error("--duration must be greater than zero");
  return args;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function connect(wsUrl, events) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
      return;
    }
    events.push(message);
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("error", reject);
  });
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "Runtime evaluation failed";
    throw new Error(detail);
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv);
  const targets = await fetchJson(`${args.cdpUrl}/json/list`);
  const target = targets.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:5183"));
  if (!target) throw new Error("OpenStudio WebView target was not found");

  const events = [];
  const cdp = await connect(target.webSocketDebuggerUrl, events);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const fixture = {
      sourceFile: args.sourceFile.replaceAll("\\", "/"),
      outputFile: args.outputFile.replaceAll("\\", "/"),
      outputDirectory: path.dirname(args.outputFile).replaceAll("\\", "/"),
      outputBaseName: path.basename(args.outputFile, path.extname(args.outputFile)),
      duration: args.duration,
      fxName: args.fxName,
      bitDepth: args.bitDepth,
      channels: args.channels,
    };

    const setup = await evaluate(cdp, `(async () => {
      const fixture = ${JSON.stringify(fixture)};
      const storeModule = await import('/src/store/useDAWStore.ts');
      const bridgeModule = await import('/src/services/NativeBridge.ts');
      const { useDAWStore, createDefaultTrack, createDefaultRenderDialogOptions } = storeModule;
      const { nativeBridge } = bridgeModule;
      const trackId = 'qa-native-render-track';
      const auxiliaryTrackId = 'qa-native-render-aux-track';
      const clipId = 'qa-native-render-clip';
      const track = createDefaultTrack(trackId, 'Native Render Repro', '#0078d4', 'audio');
      track.clips = [{
        id: clipId,
        filePath: fixture.sourceFile,
        name: 'Recorded Take',
        startTime: 0,
        duration: fixture.duration,
        offset: 0,
        color: '#0078d4',
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: 44100,
      }];
      const auxiliaryTrack = createDefaultTrack(auxiliaryTrackId, 'Native Render Auxiliary', '#5a45cc', 'audio');

      globalThis.__renderQa = { alerts: [], started: false, setup: null };
      window.alert = (message) => globalThis.__renderQa.alerts.push(String(message));

      await nativeBridge.clearPlaybackClips();
      const nativeTrackId = await nativeBridge.addTrack(trackId, 'audio');
      const nativeAuxiliaryTrackId = await nativeBridge.addTrack(auxiliaryTrackId, 'audio');
      const fxResults = fixture.fxName ? await Promise.all([
        nativeBridge.addTrackBuiltInFX(trackId, fixture.fxName, false),
        nativeBridge.addTrackBuiltInFX(auxiliaryTrackId, fixture.fxName, false),
      ]) : [];
      if (fixture.fxName) {
        track.trackFxCount = 1;
        auxiliaryTrack.trackFxCount = 1;
      }
      useDAWStore.setState({
        tracks: [auxiliaryTrack, track],
        selectedTrackIds: [trackId],
        selectedClipIds: [clipId],
        projectName: 'Native Render Repro',
        projectPath: '',
        showRenderModal: true,
        secondaryOutputEnabled: false,
        addToProjectAfterRender: false,
        renderDialogOptions: {
          ...createDefaultRenderDialogOptions(),
          source: 'master',
          bounds: 'custom',
          startTime: 0,
          endTime: fixture.duration,
          addTail: Boolean(fixture.fxName),
          directory: fixture.outputDirectory,
          fileName: fixture.outputBaseName,
          format: 'wav',
          sampleRate: 44100,
          bitDepth: fixture.bitDepth,
          channels: fixture.channels,
          normalize: false,
          dither: false,
        },
      });
      await useDAWStore.getState().syncClipsWithBackend();
      globalThis.__renderQa.setup = { nativeTrackId, nativeAuxiliaryTrackId, fxResults, isNative: Boolean(window.__JUCE__) };
      return globalThis.__renderQa.setup;
    })()`);

    await sleep(500);
    const clicked = await evaluate(cdp, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        /^Render \\d+ file/.test(candidate.textContent?.trim() || '')
      );
      if (!button) return { clicked: false, buttons: Array.from(document.querySelectorAll('button')).map((item) => item.textContent?.trim()) };
      globalThis.__renderQa.started = true;
      button.click();
      return { clicked: true, text: button.textContent?.trim() };
    })()`, false);
    if (!clicked.clicked) throw new Error(`Render button not found: ${JSON.stringify(clicked.buttons)}`);

    const deadline = Date.now() + args.timeoutMs;
    let state;
    while (Date.now() < deadline) {
      state = await evaluate(cdp, `(async () => {
        const { nativeBridge } = await import('/src/services/NativeBridge.ts');
        const outputFile = ${JSON.stringify(fixture.outputFile)};
        const exists = await nativeBridge.fileExists(outputFile);
        const modalOpen = Boolean(document.querySelector('[role="dialog"]'));
        const renderText = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /^Rendering/.test(candidate.textContent?.trim() || '')
        )?.textContent?.trim() || '';
        return { ...globalThis.__renderQa, exists, modalOpen, renderText };
      })()`);
      if (state.alerts.length > 0 || (state.exists && !state.modalOpen)) break;
      await sleep(250);
    }

    const exceptions = events
      .filter((event) => event.method === "Runtime.exceptionThrown")
      .map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    const consoleErrors = events
      .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      .map((event) => event.params.args.map((arg) => arg.value || arg.description || "").join(" "));

    const result = { setup, clicked, state, exceptions, consoleErrors };
    console.log(JSON.stringify(result, null, 2));
    if (state?.alerts?.length || !state?.exists || state?.modalOpen || exceptions.length) process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
