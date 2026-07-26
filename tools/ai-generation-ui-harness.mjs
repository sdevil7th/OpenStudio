#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:5183";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_OUT_DIR = `qa/ai-generation/${new Date().toISOString().slice(0, 10)}`;
const SCENARIOS = [
  "ai-track-model-selector",
  "clip-context-ai-menu",
  "ai-clip-generation-modal",
  "stable-audio-setup",
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 950 },
  { name: "compact", width: 820, height: 760 },
];
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
  node tools/ai-generation-ui-harness.mjs [options]

Options:
  --scenario all|${SCENARIOS.join("|")}
  --base http://127.0.0.1:5183
  --cdp http://127.0.0.1:9222
  --out qa/ai-generation/YYYY-MM-DD
  --edge "C:/Path/To/msedge.exe"
  --keep-browser
`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function assertServer(url) {
  try {
    await fetch(url);
  } catch {
    throw new Error(`Vite app is not reachable at ${url}. Start it before running this harness.`);
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
      // keep looking
    }
  }
  throw new Error("Could not find Edge or Chrome. Pass --edge with a browser executable path.");
}

async function launchBrowserIfNeeded(args) {
  if (await isCdpReachable(args.cdpUrl)) return null;
  const browserPath = await findBrowserPath(args.edgePath);
  const cdpPort = new URL(args.cdpUrl).port || "9222";
  const profile = path.join(process.env.TEMP || ".", `studio13-ai-generation-qa-${Date.now()}`);
  const child = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    args.baseUrl,
  ], { detached: false, stdio: "ignore", windowsHide: true });

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
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
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
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", reject);
  });
}

async function openTab(args, viewport) {
  const target = await fetchJson(`${args.cdpUrl}/json/new?${encodeURIComponent(args.baseUrl)}`, { method: "PUT" });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: args.baseUrl });
  await sleep(600);
  return cdp;
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const wrappedExpression = awaitPromise
    ? `(() => { globalThis.__studio13AiQaPromise = (${expression}); return globalThis.__studio13AiQaPromise; })()`
    : expression;
  const result = await cdp.send("Runtime.evaluate", {
    expression: wrappedExpression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function setupFixture(cdp) {
  await evaluate(cdp, `
    (async () => {
      const storeModule = await import('/src/store/useDAWStore.ts');
      const workflowModule = await import('/src/data/aiWorkflows.ts');
      const { useDAWStore, createDefaultTrack } = storeModule;
      const audioTrack = createDefaultTrack('qa-audio-track', 'Source Track', '#0078d4', 'audio');
      audioTrack.clips = [{
        id: 'qa-audio-clip',
        filePath: 'C:/qa/source.wav',
        name: 'Source Loop',
        startTime: 10,
        duration: 8,
        offset: 0,
        color: '#0078d4',
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: 44100,
        sourceLength: 8,
      }];
      const aiTrack = createDefaultTrack('qa-ai-track', 'AI Track', '#22c55e', 'ai');
      aiTrack.aiMusicModelId = workflowModule.ACE_STEP_MODEL_ID;
      aiTrack.aiWorkflow = 'text-to-music';
      aiTrack.aiWorkflowParams = workflowModule.getDefaultWorkflowParams('text-to-music', workflowModule.ACE_STEP_MODEL_ID);
      const current = useDAWStore.getState();
      useDAWStore.setState({
        tracks: [audioTrack, aiTrack],
        selectedTrackId: aiTrack.id,
        selectedTrackIds: [aiTrack.id],
        timeSelection: { start: 12, end: 15 },
        aiToolsStatus: {
          ...current.aiToolsStatus,
          features: {
            ...current.aiToolsStatus.features,
            audioGeneration: {
              id: 'audioGeneration',
              label: 'Audio Generation',
              ready: true,
              installed: true,
              compatible: true,
              blocked: false,
              message: 'Audio Generation ready for QA.',
            },
          },
          musicModels: {
            'ace-step-v15-xl-turbo': {
              id: 'ace-step-v15-xl-turbo',
              label: 'ACE-Step 1.5 XL Turbo',
              installed: true,
              ready: true,
              compatible: true,
              blocked: false,
              message: 'ACE ready for QA.',
            },
            'stable-audio-3-medium': {
              id: 'stable-audio-3-medium',
              label: 'Stable Audio 3 Medium',
              installed: false,
              ready: false,
              compatible: true,
              blocked: true,
              blockReason: 'Stable Audio 3 Medium has not been imported.',
              message: 'Import the Stable Audio 3 Medium Hugging Face snapshot.',
              attribution: 'Powered by Stability AI',
              runtimeReady: false,
              modelReady: false,
              missingFiles: ['model.safetensors', 'model_config.json'],
            },
          },
        },
      });
      return true;
    })()
  `);
  await sleep(350);
}

async function screenshot(cdp, filePath) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(filePath, Buffer.from(shot.data, "base64"));
}

async function qualityChecks(cdp) {
  return evaluate(cdp, `
    (() => {
      const overflow = Array.from(document.querySelectorAll('button,label,summary,[role="menu"],[role="dialog"],.modal'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 90),
            className: typeof el.className === 'string' ? el.className : '',
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((item) => item.clientWidth > 0 && item.scrollWidth > item.clientWidth + 2);
      const fixedPanels = Array.from(document.querySelectorAll('.fixed,[role="dialog"]')).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim().slice(0, 80),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          withinViewport: rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
        };
      });
      const bodyText = document.body.innerText;
      return {
        overflow,
        fixedPanels,
        hasDawThemeClasses: Array.from(document.querySelectorAll('[class]')).some((el) => String(el.className).includes('daw-')),
        forbiddenWorkflowText: ['Extract', 'Lego', 'Complete'].filter((term) => bodyText.includes(term)),
      };
    })()
  `);
}

async function scenarioAiTrackSelector(cdp, viewport, outDir) {
  await setupFixture(cdp);
  await evaluate(cdp, `document.querySelector('[aria-label="Open AI parameters"]')?.click()`);
  await sleep(300);
  await screenshot(cdp, path.join(outDir, `ai-track-model-selector-${viewport.name}-ace.png`));
  await evaluate(cdp, `
    (async () => {
      const { useDAWStore } = await import('/src/store/useDAWStore.ts');
      const { STABLE_AUDIO_3_MODEL_ID } = await import('/src/data/aiWorkflows.ts');
      useDAWStore.getState().setAITrackModel('qa-ai-track', STABLE_AUDIO_3_MODEL_ID);
      return true;
    })()
  `);
  await sleep(300);
  await screenshot(cdp, path.join(outDir, `ai-track-model-selector-${viewport.name}-stable.png`));
}

async function scenarioClipContextMenu(cdp, viewport, outDir) {
  await setupFixture(cdp);
  const menuOpened = await evaluate(cdp, `
    (() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.min(360, rect.width - 40),
        clientY: rect.top + 110,
        button: 2,
      }));
      return true;
    })()
  `);
  await sleep(500);
  await screenshot(cdp, path.join(outDir, `clip-context-ai-menu-${viewport.name}.png`));
  return { menuOpened };
}

async function scenarioClipGenerationModal(cdp, viewport, outDir) {
  await setupFixture(cdp);
  for (const workflow of ["variation", "inpaint-selection", "continue-clip"]) {
    await evaluate(cdp, `
      (async () => {
        const { useDAWStore } = await import('/src/store/useDAWStore.ts');
        useDAWStore.getState().openAIClipGeneration({
          sourceTrackId: 'qa-audio-track',
          sourceClipId: 'qa-audio-clip',
          workflowId: '${workflow}',
        });
        return true;
      })()
    `);
    await sleep(300);
    await screenshot(cdp, path.join(outDir, `ai-clip-generation-modal-${workflow}-${viewport.name}.png`));
    await evaluate(cdp, `(async () => { const { useDAWStore } = await import('/src/store/useDAWStore.ts'); useDAWStore.getState().closeAIClipGeneration(); return true; })()`);
  }
}

async function scenarioStableAudioSetup(cdp, viewport, outDir) {
  await setupFixture(cdp);
  await evaluate(cdp, `(async () => { const { useDAWStore } = await import('/src/store/useDAWStore.ts'); useDAWStore.getState().openAiToolsSetup('audioGeneration'); return true; })()`);
  await sleep(350);
  await screenshot(cdp, path.join(outDir, `stable-audio-setup-${viewport.name}.png`));
}

async function runScenario(name, cdp, viewport, screenshotDir) {
  if (name === "ai-track-model-selector") return scenarioAiTrackSelector(cdp, viewport, screenshotDir);
  if (name === "clip-context-ai-menu") return scenarioClipContextMenu(cdp, viewport, screenshotDir);
  if (name === "ai-clip-generation-modal") return scenarioClipGenerationModal(cdp, viewport, screenshotDir);
  if (name === "stable-audio-setup") return scenarioStableAudioSetup(cdp, viewport, screenshotDir);
  throw new Error(`Unknown scenario: ${name}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const scenarios = args.scenario === "all" ? SCENARIOS : [args.scenario];
  for (const scenario of scenarios) {
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  }
  await assertServer(args.baseUrl);
  await mkdir(path.join(args.outDir, "screenshots"), { recursive: true });
  const browser = await launchBrowserIfNeeded(args);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    scenarios: [],
  };

  try {
    for (const viewport of VIEWPORTS) {
      for (const scenario of scenarios) {
        const cdp = await openTab(args, viewport);
        const item = { scenario, viewport: viewport.name, pass: true, checks: null, error: null };
        try {
          const result = await runScenario(scenario, cdp, viewport, path.join(args.outDir, "screenshots"));
          item.result = result ?? null;
          item.checks = await qualityChecks(cdp);
          item.pass = item.checks.overflow.length === 0
            && item.checks.forbiddenWorkflowText.length === 0
            && item.checks.hasDawThemeClasses;
        } catch (error) {
          item.pass = false;
          item.error = error instanceof Error ? error.message : String(error);
        } finally {
          cdp.close();
        }
        report.scenarios.push(item);
      }
    }
  } finally {
    if (browser && !args.keepBrowser) browser.kill();
  }

  await writeFile(path.join(args.outDir, "report.json"), JSON.stringify(report, null, 2));
  const failed = report.scenarios.filter((item) => !item.pass);
  if (failed.length > 0) {
    console.error(`AI generation UI harness failed ${failed.length} scenario(s). Report: ${path.join(args.outDir, "report.json")}`);
    process.exit(1);
  }
  console.log(`AI generation UI harness passed. Report: ${path.join(args.outDir, "report.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
