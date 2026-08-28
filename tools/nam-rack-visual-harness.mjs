#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:5183";
const DEFAULT_CDP_URL = "http://127.0.0.1:9233";
const DEFAULT_OUT_DIR = "docs/nam_visual_qa/screenshots";
const DEFAULT_REPORT = "docs/nam_visual_qa/screenshots/nam-rack-visual-harness-report.json";
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const VIEWPORTS = [
  { name: "4k", width: 3840, height: 2160 },
  { name: "2560x1440", width: 2560, height: 1440 },
  { name: "1920x1296", width: 1920, height: 1296 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1536x960", width: 1536, height: 960 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x700", width: 1024, height: 700 },
  { name: "920x760", width: 920, height: 760 },
];
const SCENARIOS = [
  { name: "rack", params: { namView: "rack", namFocus: "amp" } },
  { name: "source-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namLibraryFlow: "amp" } },
  { name: "source-amp-audition-click", checkName: "source-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namLibraryFlow: "amp" } },
  { name: "source-amp-selected", checkName: "source-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namLibraryFlow: "amp", mockNAMAudition: "1" } },
  { name: "source-amp-empty", checkName: "source-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namLibraryFlow: "amp", namQuery: "zzzz-no-source-flow-match" } },
  { name: "source-amp-rate-limit", checkName: "source-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namLibraryFlow: "amp", mockNAMScenario: "rate-limit" } },
  { name: "source-pedal", params: { namView: "rack", namFocus: "pedal", namSection: "pre", namLibraryFlow: "pedal" } },
  { name: "source-ir", params: { namView: "rack", namFocus: "cab", namSection: "cab", namLibraryFlow: "ir" } },
  { name: "source-ir-local", checkName: "source-ir", params: { namView: "rack", namFocus: "cab", namSection: "cab", namLibraryFlow: "ir", namSourceFilter: "local" } },
  { name: "source-ir-space", checkName: "source-ir", params: { namView: "rack", namFocus: "cab", namSection: "cab", namLibraryFlow: "ir", namSourceFilter: "space-ir" } },
  { name: "source-fx", params: { namView: "rack", namFocus: "delay", namSection: "post", namLibraryFlow: "fx" } },
  { name: "source-fx-mod", checkName: "source-fx", params: { namView: "rack", namFocus: "mod", namSection: "post", namLibraryFlow: "fx", namSourceFilter: "mod" } },
  { name: "source-fx-delay", checkName: "source-fx", params: { namView: "rack", namFocus: "delay", namSection: "post", namLibraryFlow: "fx", namSourceFilter: "delay" } },
  { name: "source-fx-reverb", checkName: "source-fx", params: { namView: "rack", namFocus: "reverb", namSection: "post", namLibraryFlow: "fx", namSourceFilter: "reverb" } },
  { name: "rack-gate", params: { namView: "rack", namFocus: "gate" } },
  { name: "rack-pedal", params: { namView: "rack", namFocus: "pedal" } },
  { name: "rack-eq", params: { namView: "rack", namFocus: "eq" } },
  { name: "rack-delay", params: { namView: "rack", namFocus: "delay" } },
  { name: "rack-chain", params: { namView: "rack", namFocus: "delay", namChain: "1" } },
  { name: "rack-neural-pre", params: { namView: "rack", namFocus: "gate", namSection: "pre" } },
  { name: "rack-neural-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp" } },
  { name: "rack-neural-cab", params: { namView: "rack", namFocus: "cab", namSection: "cab" } },
  { name: "rack-neural-eq", params: { namView: "rack", namFocus: "eq", namSection: "eq" } },
  { name: "rack-neural-post", params: { namView: "rack", namFocus: "delay", namSection: "post" } },
  { name: "rack-neural-pre-debug", checkName: "rack-neural-pre", params: { namView: "rack", namFocus: "gate", namSection: "pre", namVisualMode: "debug-anchors" } },
  { name: "rack-neural-amp-debug", checkName: "rack-neural-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp", namVisualMode: "debug-anchors" } },
  { name: "rack-neural-cab-debug", checkName: "rack-neural-cab", params: { namView: "rack", namFocus: "cab", namSection: "cab", namVisualMode: "debug-anchors" } },
  { name: "rack-neural-eq-debug", checkName: "rack-neural-eq", params: { namView: "rack", namFocus: "eq", namSection: "eq", namVisualMode: "debug-anchors" } },
  { name: "rack-neural-post-debug", checkName: "rack-neural-post", params: { namView: "rack", namFocus: "delay", namSection: "post", namVisualMode: "debug-anchors" } },
  { name: "rack-neural-size-menu", params: { namView: "rack", namFocus: "delay", namSection: "post" } },
  { name: "rack-slot-browser", params: { namView: "rack", namFocus: "amp", namSlotBrowser: "1", namSlotCategory: "amp" } },
  { name: "rack-mod", params: { namView: "rack", namFocus: "mod" } },
  { name: "rack-reverb", params: { namView: "rack", namFocus: "reverb" } },
  { name: "rack-tuner", params: { namView: "rack", namFocus: "amp" } },
  { name: "rack-calibration", checkName: "rack-neural-amp", params: { namView: "rack", namFocus: "amp", namSection: "amp" } },
  { name: "preset-manager", params: { namView: "rack", namFocus: "amp" } },
  { name: "preset-export-dialog", params: { namView: "rack", namFocus: "amp" } },
  { name: "save-tone-modal", params: { namView: "rack", namFocus: "amp" } },
  { name: "browse-cards", params: { namView: "browse", namLayout: "cards" } },
  { name: "browse-list", params: { namView: "browse", namLayout: "list", namFilters: "1" } },
  { name: "mixer", params: { namView: "mixer" } },
  { name: "advanced-alias", params: { namView: "advanced" } },
];

const RACK_MAIN_SCENARIOS = new Set([
  "rack",
  "rack-gate",
  "rack-pedal",
  "rack-eq",
  "rack-delay",
  "rack-mod",
  "rack-reverb",
  "rack-tuner",
  "rack-calibration",
]);

function isRackMainScenario(name) {
  return RACK_MAIN_SCENARIOS.has(name) || name.startsWith("rack-neural-");
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    cdpUrl: DEFAULT_CDP_URL,
    outDir: DEFAULT_OUT_DIR,
    report: DEFAULT_REPORT,
    scenario: "all",
    viewport: "all",
    edgePath: "",
    rackSize: "",
    keepBrowser: false,
    keepServer: false,
    noServer: false,
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
    } else if (arg === "--report" && next) {
      args.report = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      args.scenario = next;
      index += 1;
    } else if (arg === "--viewport" && next) {
      args.viewport = next;
      index += 1;
    } else if (arg === "--edge" && next) {
      args.edgePath = next;
      index += 1;
    } else if (arg === "--rack-size" && next) {
      args.rackSize = next;
      index += 1;
    } else if (arg === "--keep-browser") {
      args.keepBrowser = true;
    } else if (arg === "--keep-server") {
      args.keepServer = true;
    } else if (arg === "--no-server") {
      args.noServer = true;
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
  node tools/nam-rack-visual-harness.mjs [options]

Options:
  --scenario all|neural|neural-debug|${SCENARIOS.map((item) => item.name).join("|")}
  --viewport all|${VIEWPORTS.map((item) => item.name).join("|")}
  --base http://127.0.0.1:5183
  --cdp http://127.0.0.1:9233
  --out docs/nam_visual_qa/screenshots
  --report docs/nam_visual_qa/screenshots/nam-rack-visual-harness-report.json
  --edge "C:/Path/To/msedge.exe"
  --rack-size 100,140  Expand rack-neural scenarios for the requested NAM Rack SIZE values.
  --no-server       Require an already-running Vite server.
  --keep-server     Leave a harness-started Vite server running.
  --keep-browser
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function isHttpReachable(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpReachable(url)) return true;
    await sleep(250);
  }
  throw new Error(`${label} did not become reachable at ${url}`);
}

async function isExpectedOpenStudioApp(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("<title>OpenStudio</title>") || text.includes("OpenStudio");
  } catch {
    return false;
  }
}

function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findFreePort(startPort, host = "127.0.0.1") {
  for (let port = startPort; port < startPort + 40; port += 1) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`Could not find a free local port starting at ${startPort}.`);
}

async function terminateProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform !== "win32") {
    child.kill();
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("exit", resolve);
    killer.once("error", resolve);
  });
}

async function startViteIfNeeded(args) {
  if (await isHttpReachable(args.baseUrl)) {
    if (await isExpectedOpenStudioApp(args.baseUrl)) return null;
    if (args.noServer) {
      throw new Error(`${args.baseUrl} is reachable, but it is not the OpenStudio frontend. Stop the other server or omit --no-server.`);
    }
    const previousBaseUrl = args.baseUrl;
    const current = new URL(args.baseUrl);
    const nextPort = await findFreePort(Number(current.port || "5183") + 1, current.hostname);
    current.port = String(nextPort);
    args.baseUrl = current.toString().replace(/\/$/, "");
    console.warn(`${previousBaseUrl} is serving another app; using ${args.baseUrl} for OpenStudio visual QA.`);
  }
  if (args.noServer) {
    throw new Error(`Vite app is not reachable at ${args.baseUrl}. Start it or omit --no-server.`);
  }

  const url = new URL(args.baseUrl);
  const port = url.port || "5183";
  const frontendDir = path.join(process.cwd(), "frontend");
  const isWindows = process.platform === "win32";
  const child = spawn(
    isWindows ? "cmd.exe" : "npm",
    isWindows
      ? ["/d", "/s", "/c", `npm run dev -- --host ${url.hostname} --port ${port} --strictPort`]
      : ["run", "dev", "--", "--host", url.hostname, "--port", port, "--strictPort"],
    {
      cwd: frontendDir,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );

  await waitForHttp(args.baseUrl, 30000, "Harness Vite server");
  return child;
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
  const cdpPort = new URL(args.cdpUrl).port || "9233";
  const profile = path.join(process.env.TEMP || ".", `studio13-nam-rack-qa-${Date.now()}`);
  const child = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "about:blank",
  ], { detached: false, stdio: "ignore", windowsHide: true });
  child.__profile = profile;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isCdpReachable(args.cdpUrl)) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error(`Browser launched but CDP did not become reachable at ${args.cdpUrl}`);
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

function pluginUrl(args, scenario) {
  const session = {
    address: { trackId: "nam-visual-track", chain: "track", fxIndex: 0 },
    title: "OpenStudio NAM Rack",
    fallbackName: "OpenStudio NAM Rack",
  };
  const url = new URL(args.baseUrl);
  url.searchParams.set("window", "pluginEditor");
  url.searchParams.set("platform", "windows");
  url.searchParams.set("windowChrome", "native");
  url.searchParams.set("mockPlugin", "nam");
  url.searchParams.set("sessionId", JSON.stringify(session));
  for (const [key, value] of Object.entries(scenario.params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function openTab(args, viewport, scenario) {
  const target = await fetchJson(`${args.cdpUrl}/json/new?${encodeURIComponent(pluginUrl(args, scenario))}`, { method: "PUT" });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: pluginUrl(args, scenario) });
  await waitForNAM(cdp);
  return cdp;
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception?.description || details.exception?.value || details.text;
    throw new Error(description || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForNAM(cdp) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `Boolean(document.querySelector('.nam-product'))`);
    if (ready) {
      await sleep(350);
      return;
    }
    await sleep(200);
  }
  throw new Error("NAM product did not render before timeout.");
}

async function waitForDesignPort(cdp) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `
      (() => {
        const host = document.querySelector('.nam-rack-design-port.nam-native-design-surface, .nam-rack-source-flow-design-port.nam-native-design-surface');
        return Boolean(host?.querySelector('.screen-shell') && host.querySelector('[data-rack-design-asset-kind]'));
      })()
    `);
    if (ready) {
      await evaluate(cdp, `
        (async () => {
          if (document.fonts?.ready) await document.fonts.ready;
          const images = Array.from(document.querySelectorAll(
            '.nam-rack-design-port [data-rack-design-asset-kind], .nam-rack-source-flow-design-port [data-rack-design-asset-kind]'
          )).filter((node) => node instanceof HTMLImageElement);
          await Promise.all(images.map(async (image) => {
            if (!image.complete) {
              await new Promise((resolve) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
              });
            }
            if (typeof image.decode === 'function') await image.decode().catch(() => {});
          }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return true;
        })()
      `);
      return;
    }
    await sleep(250);
  }
  throw new Error("NAM Rack design-port board did not become ready.");
}

async function screenshot(cdp, filePath) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(filePath, Buffer.from(shot.data, "base64"));
}

async function runInteractionProbe(cdp) {
  const orderExpression = "Array.from(document.querySelectorAll('.nam-compact-chain-group[data-accent=\"post\"] .nam-compact-chain-node strong')).map((el) => el.textContent || '')";
  const before = await evaluate(cdp, orderExpression);
  await cdp.send("Page.bringToFront").catch(() => {});
  const target = await evaluate(cdp, `
    (() => {
      const delay = Array.from(document.querySelectorAll('.nam-compact-chain-node')).find((el) => el.querySelector('strong')?.textContent === 'Delay');
      const left = delay?.querySelector('button[aria-label="Move Delay earlier"]');
      const rect = left?.getBoundingClientRect();
      if (left && !left.disabled) {
        left.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        left.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        left.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      }
      return {
        found: Boolean(left),
        disabled: Boolean(left?.disabled),
        label: left?.getAttribute('aria-label') || '',
        x: rect ? rect.left + rect.width / 2 : 0,
        y: rect ? rect.top + rect.height / 2 : 0,
        hit: rect ? (document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML || '').slice(0, 160) : '',
      };
    })()
  `);
  await sleep(450);
  const after = await evaluate(cdp, orderExpression);
  const lowerCardClick = await evaluate(cdp, `
    (() => {
      const card = Array.from(document.querySelectorAll('.nam-compact-chain-node')).find((el) => el.querySelector('strong')?.textContent === 'Mod');
      const button = card?.querySelector('.nam-compact-chain-node-main');
      const rect = button?.getBoundingClientRect();
      if (!button || !rect) return { found: false, hit: '' };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return {
        found: true,
        x,
        y,
        hit: (button.outerHTML || '').slice(0, 160),
      };
    })()
  `);
  await sleep(140);
  const lowerCardResult = await evaluate(cdp, `
    (() => {
      const mixer = document.querySelector('[data-qa="nam-rack-mixer"]');
      const result = {
        chainClosed: !document.querySelector('.nam-compact-chain'),
        advancedOpened: Boolean(mixer),
        focusedStage: mixer?.getAttribute('data-focused-stage') || '',
        backRequested: false,
      };
      const back = document.querySelector('[data-qa="nam-mixer-back"]');
      if (back) {
        back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        back.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        result.backRequested = true;
      }
      return result;
    })()
  `);
  await sleep(160);
  const reopenRequested = await evaluate(cdp, `
    (() => {
      const reopen = document.querySelector('[data-qa="nam-premium-signal-chain"]');
      if (!reopen) return false;
      reopen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      reopen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      reopen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return true;
    })()
  `);
  await sleep(160);
  const chainReopened = await evaluate(cdp, `Boolean(document.querySelector('.nam-compact-chain'))`);
  return {
    before,
    after,
    clicked: Boolean(target?.found),
    target,
    changed: before.join('|') !== after.join('|'),
    lowerCardClick: { ...lowerCardClick, ...lowerCardResult, reopenRequested, chainReopened },
  };
}

async function runSourceAmpAuditionProbe(cdp) {
  const snapshotExpression = `
    (() => {
      const source = document.querySelector('.nam-rack-source-flow-design-port');
      const detailName = source?.querySelector('.tone-selected-identity > h1, .tone-detail-heading > b');
      const empty = source?.querySelector('.tone-feed-empty');
      const feed = source?.querySelector('.tone-feed-list');
      const activeRow = source?.querySelector('.tone-feed-row[data-active="true"]');
      return {
        detailName: (detailName?.textContent || '').replace(/\\s+/g, ' ').trim(),
        selectedAvailable: Boolean(source?.querySelector('.tone-selected-info')),
        emptyVisible: Boolean(empty && empty.getBoundingClientRect().width > 0 && empty.getBoundingClientRect().height > 0),
        busy: feed?.getAttribute('data-busy') === 'true',
        activeRowId: activeRow?.getAttribute('data-source-flow-row-id') || '',
      };
    })()
  `;
  const before = await evaluate(cdp, snapshotExpression);
  const click = await evaluate(cdp, `
    (() => {
      const source = document.querySelector('.nam-rack-source-flow-design-port');
      const row = source?.querySelector('.tone-feed-row');
      const button = row?.querySelector('.tone-row-action');
      const rowId = row?.getAttribute('data-source-flow-row-id') || '';
      const rowName = (row?.querySelector('.tone-row-main > strong')?.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!button || !/Audition/i.test(button.textContent || '')) {
        return { clicked: false, rowId, rowName, label: (button?.textContent || '').trim() };
      }
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return { clicked: true, rowId, rowName, label: (button.textContent || '').trim() };
    })()
  `);

  const deadline = Date.now() + 12000;
  let settled = await evaluate(cdp, snapshotExpression);
  while (
    Date.now() < deadline
    && (!settled.selectedAvailable || settled.emptyVisible || settled.busy || !settled.detailName)
  ) {
    await sleep(150);
    settled = await evaluate(cdp, snapshotExpression);
  }

  // The reported bug appeared after the details had rendered, so keep the
  // hydrated selection alive long enough to catch a late stale-state update.
  await sleep(1400);
  const late = await evaluate(cdp, snapshotExpression);
  return {
    before,
    click,
    settled,
    late,
    stable: Boolean(
      click.clicked
      && settled.selectedAvailable
      && late.selectedAvailable
      && !settled.emptyVisible
      && !late.emptyVisible
      && settled.detailName
      && settled.detailName === late.detailName
      && (!click.rowName || late.detailName.includes(click.rowName))
    ),
  };
}

async function openTunerRail(cdp) {
  await evaluate(cdp, `
    (() => {
      const tuner = Array.from(document.querySelectorAll('[data-qa="nam-premium-tuner"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      tuner?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      tuner?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      tuner?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(tuner);
    })()
  `);
  await sleep(160);
}

async function openCalibrationDrawer(cdp) {
  await evaluate(cdp, `
    (() => {
      const trigger = Array.from(document.querySelectorAll('[data-qa="nam-premium-calibration"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(180);
}

async function openPresetManager(cdp) {
  await evaluate(cdp, `
    (() => {
      const trigger = Array.from(document.querySelectorAll('[data-qa="nam-preset-title-trigger"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(180);
}

async function openPresetExportDialog(cdp) {
  await evaluate(cdp, `
    (() => {
      const trigger = Array.from(document.querySelectorAll('.nam-preset-transfer-row button'))
        .find((el) => (el.textContent || '').includes('Export Current') && !el.disabled);
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(180);
}

async function openSaveToneModal(cdp) {
  await evaluate(cdp, `
    (() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const trigger = Array.from(document.querySelectorAll('[data-qa="nam-save-tone-trigger"], .nam-save-tone-topbar, .nam-save-tone-button'))
        .find((el) => isVisible(el) && !el.disabled)
        || Array.from(document.querySelectorAll('.nam-rack-source-flow-design-port [data-source-flow-action="save-tone"], .nam-rack-source-flow-design-port [data-source-flow-action="save-and-return"]') || [])
          .find((el) => isVisible(el) && !el.disabled);
      const eventView = trigger?.ownerDocument?.defaultView || window;
      trigger?.dispatchEvent(new eventView.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new eventView.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new eventView.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(200);
}

async function cycleRackSizeControl(cdp) {
  const readState = `
    (() => {
      const product = document.querySelector('.nam-product');
      const control = document.querySelector('.nam-rack-design-port .footer button[title="Cycle rack display size"]');
      return {
        found: Boolean(control),
        size: product?.getAttribute('data-rack-size') || '',
        label: (control?.textContent || '').replace(/\\s+/g, ' ').trim(),
      };
    })()
  `;
  const before = await evaluate(cdp, readState);
  const clicked = await evaluate(cdp, `
    (() => {
      const control = document.querySelector('.nam-rack-design-port .footer button[title="Cycle rack display size"]');
      control?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      control?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(control);
    })()
  `);
  await sleep(160);
  const after = await evaluate(cdp, readState);
  return {
    before,
    after,
    clicked,
    pass: Boolean(clicked && before.found && after.found && before.size !== after.size && before.label !== after.label),
  };
}

async function runInstrumentProfileProbe(cdp, outDir, viewportName) {
  const result = await evaluate(cdp, `(() => {
    const root = document.querySelector('[data-param-id="instrumentProfile"]');
    if (!(root instanceof HTMLButtonElement)) return { pass: false, reason: 'Instrument profile control missing' };
    const beforeState = root.getAttribute('data-state') || '';
    root.click();
    const read = () => ({
      beforeState,
      state: root.getAttribute('data-state') || '',
      ariaLabel: root.getAttribute('aria-label') || '',
      disabled: root.disabled,
      rootRect: (() => { const r = root.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(read()))));
  })()`);
  const value = result?.result?.value ?? result?.value ?? result;
  await screenshot(cdp, path.join(outDir, `nam-instrument-bass-${viewportName}.png`));
  const bounds = value?.rootRect;
  const pass = value?.beforeState === 'guitar'
    && value?.state === 'bass'
    && value?.ariaLabel?.startsWith('Bass instrument profile.')
    && value?.disabled === false
    && value.documentOverflowX === false
    && bounds?.left >= 0
    && bounds?.top >= 0
    && bounds?.right <= value.viewport.width
    && bounds?.bottom <= value.viewport.height;
  return { ...value, pass };
}

async function readThreePositionSelector(cdp, moduleName, paramId, readoutSelector) {
  return evaluate(cdp, `(() => {
    const module = document.querySelector('[data-module=${JSON.stringify(moduleName)}]');
    const hit = module?.querySelector('.control-hit[data-param-id=${JSON.stringify(paramId)}]');
    const ring = module?.querySelector('.three-position-selector-detents');
    const readout = module?.querySelector(${JSON.stringify(readoutSelector)});
    const knob = module?.querySelector('.asset-control.three-position-rotary');
    const detents = ring ? Array.from(ring.querySelectorAll('i')) : [];
    const activeIndex = detents.findIndex((detent) => detent.getAttribute('data-active') === 'true');
    if (!module || !hit || !ring || !readout || !knob || activeIndex < 0) {
      return { pass: false, reason: 'Three-position faceplate controls missing' };
    }
    const moduleRect = module.getBoundingClientRect();
    const hitRect = hit.getBoundingClientRect();
    const ringRect = ring.getBoundingClientRect();
    const readoutRect = readout.getBoundingClientRect();
    const center = { x: ringRect.left + ringRect.width / 2, y: ringRect.top + ringRect.height / 2 };
    const measured = detents.map((detent) => {
      const rect = detent.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return {
        angle: Math.atan2(x - center.x, center.y - y) * 180 / Math.PI,
        radius: Math.hypot(x - center.x, y - center.y),
      };
    });
    return {
      pass: true,
      value: Number(hit.getAttribute('aria-valuenow')),
      valueText: hit.getAttribute('aria-valuetext') || '',
      aria: hit.getAttribute('aria-label') || '',
      interaction: hit.getAttribute('data-control-interaction') || '',
      text: (readout.textContent || '').replace(/\\s+/g, ' ').trim(),
      activeIndex,
      knobStateClass: Array.from(knob.classList).find((name) => name.startsWith('control-state-')) || '',
      measured,
      moduleRect: { left: moduleRect.left, top: moduleRect.top, right: moduleRect.right, bottom: moduleRect.bottom },
      hitRect: { left: hitRect.left, top: hitRect.top, right: hitRect.right, bottom: hitRect.bottom, width: hitRect.width, height: hitRect.height },
      readoutRect: { left: readoutRect.left, top: readoutRect.top, right: readoutRect.right, bottom: readoutRect.bottom },
    };
  })()`);
}

async function dispatchMouseClick(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(90);
}

async function dispatchVerticalMouseDrag(cdp, point, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y + deltaY * step / 5,
      button: 'left',
      buttons: 1,
      clickCount: 0,
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y + deltaY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(120);
}

function threePositionSelectorSamplePass(sample, expectedValue, expectedText) {
  const expectedAngles = [-52, 0, 52];
  const angleError = sample?.measured?.map((item, index) => Math.abs(item.angle - expectedAngles[index])) ?? [];
  const radii = sample?.measured?.map((item) => item.radius) ?? [];
  const radiusSpread = radii.length > 0 ? Math.max(...radii) - Math.min(...radii) : Number.POSITIVE_INFINITY;
  const moduleRect = sample?.moduleRect;
  const hitRect = sample?.hitRect;
  const readoutRect = sample?.readoutRect;
  return sample?.pass === true
    && sample.value === expectedValue
    && sample.activeIndex === expectedValue
    && sample.knobStateClass === `control-state-${expectedValue}`
    && sample.interaction === 'hybrid'
    && sample.text === expectedText
    && angleError.length === 3
    && angleError.every((error) => error <= 2)
    && radiusSpread <= 1
    && hitRect.left >= moduleRect.left
    && hitRect.right <= moduleRect.right
    && readoutRect.left >= moduleRect.left
    && readoutRect.right <= moduleRect.right
    && readoutRect.top >= moduleRect.top
    && readoutRect.bottom <= moduleRect.bottom;
}

async function runCompressorHpfProbe(cdp, outDir, viewportName) {
  const moduleName = 'compressor';
  const paramId = 'compressorSidechainHPF';
  const readoutSelector = '.compressor-hpf-readout';
  let current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  const center = () => ({
    x: (current.hitRect.left + current.hitRect.right) / 2,
    y: (current.hitRect.top + current.hitRect.bottom) / 2,
  });
  for (let attempt = 0; current.value !== 0 && attempt < 3; attempt += 1) {
    await dispatchMouseClick(cdp, center());
    current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  }

  const samples = [current];
  await screenshot(cdp, path.join(outDir, `nam-compressor-hpf-click-0-${viewportName}.png`));
  for (let value = 1; value <= 2; value += 1) {
    await dispatchMouseClick(cdp, center());
    current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
    samples.push(current);
    await screenshot(cdp, path.join(outDir, `nam-compressor-hpf-click-${value}-${viewportName}.png`));
  }
  await dispatchMouseClick(cdp, center());
  current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  const resetByClick = current.value === 0;

  // The 50 px release point is deliberately outside the compact selector hit
  // ring. Pointer capture must retain the drag, snap to 80 Hz, and suppress
  // the synthetic release click that would otherwise advance to 240 Hz.
  await dispatchVerticalMouseDrag(cdp, center(), -50);
  const dragSample = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  await screenshot(cdp, path.join(outDir, `nam-compressor-hpf-drag-1-${viewportName}.png`));

  const expectedTexts = ['HPFOFF', 'HPF80', 'HPF240'];
  const clickPass = samples.every((sample, index) => threePositionSelectorSamplePass(sample, index, expectedTexts[index]));
  const dragPass = threePositionSelectorSamplePass(dragSample, 1, 'HPF80');
  return { pass: resetByClick && clickPass && dragPass, resetByClick, clickPass, dragPass, samples, dragSample };
}

async function runDistortionModeProbe(cdp, outDir, viewportName) {
  const moduleName = 'distortion';
  const paramId = 'chaosMode';
  const readoutSelector = '.distortion-mode-display';
  let current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  const center = () => ({
    x: (current.hitRect.left + current.hitRect.right) / 2,
    y: (current.hitRect.top + current.hitRect.bottom) / 2,
  });
  for (let attempt = 0; current.value !== 0 && attempt < 3; attempt += 1) {
    await dispatchMouseClick(cdp, center());
    current = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  }
  const initial = current;
  await dispatchMouseClick(cdp, center());
  const clicked = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  current = clicked;
  await dispatchVerticalMouseDrag(cdp, center(), -50);
  const dragged = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  await screenshot(cdp, path.join(outDir, `nam-distortion-mode-click-drag-${viewportName}.png`));
  const initialPass = threePositionSelectorSamplePass(initial, 0, 'HEAVY');
  const clickPass = threePositionSelectorSamplePass(clicked, 1, 'XTREME');
  const dragPass = threePositionSelectorSamplePass(dragged, 2, 'CRUNCH');
  return { pass: initialPass && clickPass && dragPass, initialPass, clickPass, dragPass, initial, clicked, dragged };
}

async function selectMixerStage(cdp, stageId) {
  const changed = await evaluate(cdp, `
    (() => {
      const select = document.querySelector('.nam-rack-mixer-stage-picker select');
      if (!(select instanceof HTMLSelectElement)) return false;
      if (!Array.from(select.options).some((option) => option.value === ${JSON.stringify(stageId)})) return false;
      select.value = ${JSON.stringify(stageId)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!changed) throw new Error(`NAM Rack mixer stage is unavailable: ${stageId}`);
  await sleep(160);
}

async function qualityChecks(cdp, scenarioName) {
  return evaluate(cdp, `
    (() => {
      const scenarioName = ${JSON.stringify(scenarioName)};
      const product = document.querySelector('.nam-product');
      const namWindowTitle = document.querySelector('[data-qa="nam-window-title"]');
      const windowControls = document.querySelector('.builtin-window-controls');
      const headerMeters = Array.from(document.querySelectorAll('.nam-product-topbar .nam-meter-trim .nam-meter-level'));
      const headerMeterReadouts = Array.from(document.querySelectorAll('.nam-product-topbar .nam-meter-trim strong'))
        .map((el) => (el.textContent || '').trim());
      const headerTrimReadoutChips = Array.from(document.querySelectorAll('.nam-product-topbar .nam-meter-trim em:not(.nam-meter-trim-handle)'));
      const headerCompareLabels = Array.from(document.querySelectorAll('[data-qa^="nam-compare-slot-"]'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
      const headerPresetSelectIcons = Array.from(document.querySelectorAll('.nam-product-topbar .nam-preset-select svg'));
      const root = document.documentElement;
      const body = document.body;
      const rootScrollbar = root.scrollHeight > window.innerHeight + 2
        || body.scrollHeight > window.innerHeight + 2
        || root.scrollWidth > window.innerWidth + 2
        || body.scrollWidth > window.innerWidth + 2;
      const productRect = product?.getBoundingClientRect();
      const modules = Array.from(document.querySelectorAll('.nam-compact-chain-node')).map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          active: el.getAttribute('data-active') === 'true',
          selected: el.getAttribute('data-selected') === 'true',
          borderColor: style.borderColor,
          width: rect.width,
          height: rect.height,
          visible: rect.width > 20 && rect.height > 20,
        };
      });
      const maxModuleHeight = modules.reduce((max, item) => Math.max(max, item.height), 0);
      const activeNonSelectedModules = modules.filter((item) => item.active && !item.selected);
      const selectedModules = modules.filter((item) => item.selected);
      const chainCardsNeutralWhenActive = activeNonSelectedModules.length > 0
        && activeNonSelectedModules.every((item) => !item.borderColor.includes('69, 179, 107') && !item.borderColor.includes('142, 245, 194'));
      const selectedChainCardAmber = selectedModules.length === 1
        && selectedModules.every((item) => item.borderColor.includes('245') || item.borderColor.includes('255, 216, 122'));
      const headerLibraryCta = document.querySelector('.nam-product[data-view="rack"] .nam-product-topbar .nam-library-cta');
      const headerPresetManagerAction = document.querySelector('[data-qa="nam-header-preset-manager"]');
      const headerUtilityButtonEls = {
        undo: document.querySelector('[data-qa="nam-header-undo"]'),
        redo: document.querySelector('[data-qa="nam-header-redo"]'),
        more: document.querySelector('[data-qa="nam-header-more"]'),
      };
      const farTunerButton = document.querySelector('[data-qa="nam-premium-tuner"]');
      const chainDragOverlay = document.querySelector('[data-qa="nam-chain-drag-overlay"]');
      const rackMixer = document.querySelector('[data-qa="nam-rack-mixer"]');
      const selectedChainModule = document.querySelector('.nam-product[data-view="rack"] .nam-compact-chain-node[data-qa="nam-compact-chain-node-delay"]');
      const chainSlotActions = Array.from(document.querySelectorAll('.nam-product[data-view="rack"] .nam-compact-chain-order'));
      const visibleBox = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      };
      const rackSectionRail = document.querySelector('.nam-neural-section-rail');
      const rackGlobalStrip = document.querySelector('.nam-neural-global-strip');
      const rackPresetHub = document.querySelector('.nam-neural-preset-hub');
      const rackSectionButtons = Array.from(document.querySelectorAll('.nam-neural-section-rail button')).map((el) => ({
        id: el.getAttribute('data-section') || '',
        label: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        active: el.getAttribute('data-active') === 'true',
        visible: visibleBox(el),
      }));
      const rackGlobalControlCount = rackGlobalStrip
        ? rackGlobalStrip.querySelectorAll('.nam-meter-trim, .nam-neural-global-knob, .nam-neural-stepper').length
        : 0;
      const rackPresetLibraryButton = document.querySelector('.nam-neural-preset-library-button');
      const rackGlobalLibraryButton = document.querySelector('.nam-neural-global-side-right .nam-neural-library-button');
      const rackGlobalDividerCount = rackGlobalStrip
        ? rackGlobalStrip.querySelectorAll('.nam-neural-global-side > * + *').length
        : 0;
      const rackRetiredControlsAbsent = !document.querySelector(
        '.nam-neural-input-mode, [data-param="inputMode"], [data-param="transposeSemitones"], [aria-label="Transpose"]'
      );
      const headerUtilityActions = Object.fromEntries(Object.entries(headerUtilityButtonEls).map(([key, el]) => [
        key,
        {
          iconClass: el?.querySelector('svg')?.getAttribute('class') || '',
          disabled: Boolean(el?.disabled),
          visible: visibleBox(el),
        },
      ]));
      const headerLibraryStyle = headerLibraryCta ? window.getComputedStyle(headerLibraryCta) : null;
      const headerLibraryActiveQuiet = Boolean(headerLibraryCta
        && headerLibraryCta.getAttribute('data-active') === 'true'
        && visibleBox(headerLibraryCta)
        && !headerLibraryStyle?.borderColor.includes('142, 245')
        && !headerLibraryStyle?.borderColor.includes('69, 179')
        && !headerLibraryStyle?.boxShadow.includes('142, 245')
        && !headerLibraryStyle?.boxShadow.includes('69, 179'));
      const visibleHeaderTopActionIconClasses = Array.from(document.querySelectorAll('.nam-top-actions button'))
        .filter((el) => visibleBox(el))
        .map((el) => el.querySelector('svg')?.getAttribute('class') || '')
        .filter(Boolean);
      const headerUtilityReferenceIcons = Boolean(
        headerUtilityActions.undo?.visible
        && headerUtilityActions.undo?.iconClass.includes('lucide-rotate-ccw')
        && headerUtilityActions.redo?.visible
        && headerUtilityActions.redo?.disabled === true
        && headerUtilityActions.redo?.iconClass.includes('lucide-rotate-cw')
        && headerUtilityActions.more?.visible
        && (headerUtilityActions.more?.iconClass.includes('lucide-ellipsis-vertical')
          || headerUtilityActions.more?.iconClass.includes('lucide-more-vertical'))
        && !visibleHeaderTopActionIconClasses.some((item) => item.includes('lucide-save'))
      );
      const selectedChainTextNodes = selectedChainModule
        ? Array.from(selectedChainModule.querySelectorAll('.nam-compact-chain-node-main strong, .nam-compact-chain-node-main small'))
        : [];
      const selectedChainTextMetrics = selectedChainTextNodes.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim(),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          rect: {
            width: Number(rect.width.toFixed(1)),
            height: Number(rect.height.toFixed(1)),
          },
          whiteSpace: window.getComputedStyle(el).whiteSpace,
          fontSize: window.getComputedStyle(el).fontSize,
        };
      });
      const selectedChainTextFits = selectedChainTextNodes.length >= 2
        && selectedChainTextNodes.every((el) => {
          const style = window.getComputedStyle(el);
          return visibleBox(el)
            && (el.scrollWidth <= el.clientWidth + 1 || style.overflowX === 'hidden' || style.overflow === 'hidden')
            && (el.scrollHeight <= el.clientHeight + 1 || style.overflowY === 'hidden' || style.overflow === 'hidden');
        });
      const chainSlotActionStates = chainSlotActions.map((el) => {
        const style = window.getComputedStyle(el);
        return {
          opacity: Number.parseFloat(style.opacity || '1'),
          visibleBox: visibleBox(el),
          buttonCount: el.querySelectorAll('button').length,
        };
      });
      const chainActionsHiddenAtRest = chainSlotActionStates.length >= 8
        && chainSlotActionStates.every((state) => state.opacity <= 0.05 && state.buttonCount >= 2);
      const headerMeterWidths = headerMeters.map((el) => Number(el.getBoundingClientRect().width.toFixed(1)));
      const expectedHeaderMeterMinWidth = (scenarioName.startsWith('browse') || scenarioName === 'mixer')
        ? (window.innerWidth >= 1500
          ? 190
          : window.innerWidth >= 1000
            ? 135
            : 110)
        : window.innerWidth >= 3000
          ? 420
          : window.innerWidth >= 1500
          ? 190
          : window.innerWidth >= 1000
            ? 135
            : 110;
      const headerMetersResponsive = headerMeters.length === 2
        && headerMeterWidths.every((width) => width >= expectedHeaderMeterMinWidth);
      const headerTrimReadoutChipsVisible = headerTrimReadoutChips.length >= 2
        && headerTrimReadoutChips.every((el) => visibleBox(el) && (el.textContent || '').includes('dB'));
      const headerCompareLabelsClean = headerCompareLabels.includes('A')
        && headerCompareLabels.includes('B')
        && headerCompareLabels.every((label) => label === 'A' || label === 'B');
      const headerPresetSelectIconHidden = headerPresetSelectIcons.length >= 1
        && headerPresetSelectIcons.every((el) => !visibleBox(el));
      const tunerPanel = document.querySelector('.premium-tuner-stage, .premium-tuner-drawer');
      const tunerDisplay = tunerPanel?.querySelector('.premium-tuner-stage-copy, .premium-tuner-display');
      const tunerScale = tunerPanel?.querySelector('.premium-tuner-scale, .premium-tuner-cents');
      const tunerNeedle = tunerPanel?.querySelector('.premium-tuner-needle, .premium-tuner-cents > i');
      const tunerNote = tunerPanel?.querySelector('.premium-tuner-stage-copy > strong, .premium-tuner-display > strong');
      const tunerCentsReadout = tunerPanel?.querySelector('.premium-tuner-stage-copy > em, .premium-tuner-display > em');
      const tunerReadoutEntries = Array.from(tunerPanel?.querySelectorAll('.premium-tuner-stage-readouts article, .premium-tuner-readouts article, .nam-tuner-readouts article') || []).map((article) => {
        const label = article.querySelector('span');
        const value = article.querySelector('strong');
        return {
          label: (label?.textContent || '').replace(/\\s+/g, ' ').trim(),
          value: (value?.textContent || '').replace(/\\s+/g, ' ').trim(),
          visible: visibleBox(article) && visibleBox(label) && visibleBox(value),
        };
      });
      const tunerReadout = (label) => tunerReadoutEntries.find((entry) => entry.label === label);
      const tunerText = (tunerPanel?.textContent || '').replace(/\\s+/g, ' ').trim();
      const tunerNeedlePct = tunerPanel
        ? (window.getComputedStyle(tunerPanel).getPropertyValue('--premium-tuner-pct').trim()
          || (tunerScale ? window.getComputedStyle(tunerScale).getPropertyValue('--premium-tuner-pct').trim() : '')
          || (tunerScale ? window.getComputedStyle(tunerScale).getPropertyValue('--nam-tuner-cents-pct').trim() : ''))
        : '';
      const tunerNoteText = (tunerNote?.textContent || '').trim();
      const tunerCentsText = (tunerCentsReadout?.textContent || '').replace(/\\s+/g, ' ').trim();
      const tunerPitchReadout = tunerReadout('Pitch');
      const tunerInputReadout = tunerReadout('Input');
      const tunerTrackingReadout = tunerReadout('Tracking');
      const tunerReferenceReadout = tunerReadout('Reference');
      const tunerNeedleNumber = Number.parseFloat(tunerNeedlePct);
      const tunerHasPitchReadout = Boolean(visibleBox(tunerPanel)
        && visibleBox(tunerDisplay)
        && visibleBox(tunerScale)
        && visibleBox(tunerNeedle)
        && visibleBox(tunerNote)
        && visibleBox(tunerCentsReadout)
        && (tunerPanel?.getAttribute('data-signal') === 'true' || tunerPanel?.getAttribute('data-lock') === 'true')
        && tunerNoteText === 'E4'
        && tunerCentsText.endsWith(' cents')
        && Number.isFinite(Number.parseFloat(tunerCentsText))
        && tunerPitchReadout?.visible === true
        && tunerPitchReadout.value === '329.2 Hz'
        && tunerInputReadout?.visible === true
        && tunerInputReadout.value.endsWith(' dB')
        && Number.isFinite(Number.parseFloat(tunerInputReadout.value))
        && tunerTrackingReadout?.visible === true
        && tunerTrackingReadout.value === '86%'
        && tunerReferenceReadout?.visible === true
        && tunerReferenceReadout.value === '440 Hz'
        && Number.isFinite(tunerNeedleNumber)
        && tunerNeedleNumber >= 0
        && tunerNeedleNumber <= 100
        && Math.abs(tunerNeedleNumber - 50) > 0.1);
      const calibrationDrawer = document.querySelector('.nam-calibration-drawer');
      const calibrationNormalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const calibrationHeader = calibrationDrawer?.querySelector(':scope > header');
      const calibrationEyebrow = calibrationNormalize(calibrationHeader?.querySelector('span')?.textContent);
      const calibrationTitle = calibrationNormalize(calibrationHeader?.querySelector('strong')?.textContent);
      const calibrationExplanation = calibrationNormalize(calibrationHeader?.querySelector('p')?.textContent);
      const calibrationReference = calibrationDrawer?.querySelector('.nam-calibration-reference');
      const calibrationReferenceLabel = calibrationNormalize(calibrationReference?.querySelector('label')?.textContent);
      const calibrationReferenceInput = calibrationReference?.querySelector('input');
      const calibrationReferenceUnit = calibrationNormalize(calibrationReference?.querySelector('div > span')?.textContent);
      const calibrationReferenceHelp = calibrationNormalize(calibrationReference?.querySelector('small')?.textContent);
      const calibrationSlots = Array.from(calibrationDrawer?.querySelectorAll('.nam-calibration-slot') || []).map((slot) => {
        const mode = slot.querySelector('select');
        const fields = Array.from(slot.querySelectorAll('dl > div')).map((field) => ({
          label: calibrationNormalize(field.querySelector('dt')?.textContent),
          value: calibrationNormalize(field.querySelector('dd')?.textContent),
          visible: visibleBox(field) && visibleBox(field.querySelector('dt')) && visibleBox(field.querySelector('dd')),
        }));
        return {
          label: calibrationNormalize(slot.querySelector('header span')?.textContent),
          capture: calibrationNormalize(slot.querySelector('header strong')?.textContent),
          statusText: calibrationNormalize(slot.querySelector('header small')?.textContent),
          status: slot.getAttribute('data-status') || '',
          loaded: slot.getAttribute('data-loaded') === 'true',
          modeLabel: calibrationNormalize(mode?.selectedOptions?.[0]?.textContent),
          modeVisible: visibleBox(mode),
          modeEnabled: Boolean(mode) && !mode.disabled,
          fields,
          visible: visibleBox(slot),
        };
      });
      const calibrationPedalSlot = calibrationSlots.find((slot) => slot.label === 'Pedal capture');
      const calibrationAmpSlot = calibrationSlots.find((slot) => slot.label === 'Amp capture');
      const calibrationFieldLabels = ['Capture IN', 'Capture OUT', 'Applied IN', 'Applied OUT'];
      const calibrationAmpExpectedValues = {
        'Capture IN': '+18.3 dBu',
        'Capture OUT': '+12.3 dBu',
        'Applied IN': '-6.3 dB',
        'Applied OUT': '+0.3 dB',
      };
      const calibrationDrawerRect = calibrationDrawer?.getBoundingClientRect();
      const calibrationContained = Boolean(calibrationDrawerRect
        && calibrationDrawerRect.left >= -1
        && calibrationDrawerRect.top >= -1
        && calibrationDrawerRect.right <= window.innerWidth + 1
        && calibrationDrawerRect.bottom <= window.innerHeight + 1);
      const calibrationTextElements = Array.from(calibrationDrawer?.querySelectorAll('span, strong, p, label, small, dt, dd, option, footer button') || [])
        .filter((el) => visibleBox(el));
      const calibrationTextOverflowFailures = calibrationTextElements
        .filter((el) => el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 5)
        .map((el) => calibrationNormalize(el.textContent || el.getAttribute('aria-label') || el.className || el.tagName).slice(0, 80));
      const calibrationReady = Boolean(visibleBox(calibrationDrawer)
        && calibrationContained
        && calibrationEyebrow === 'LEVEL CALIBRATION'
        && calibrationTitle === 'Capture dBu alignment'
        && calibrationExplanation.includes('inside each NAM wet path')
        && calibrationExplanation.includes('does not move the Input or Output trim controls')
        && visibleBox(calibrationReference)
        && visibleBox(calibrationReferenceInput)
        && calibrationReferenceLabel === 'Interface 0 dBFS reference'
        && Number(calibrationReferenceInput?.value) === 12
        && calibrationReferenceUnit === 'dBu'
        && calibrationReferenceHelp.includes('interface specification')
        && calibrationReferenceHelp.includes('physical input gain')
        && calibrationSlots.length === 2
        && calibrationPedalSlot?.visible === true
        && calibrationPedalSlot.loaded === false
        && calibrationPedalSlot.capture === 'No capture'
        && calibrationPedalSlot.status === 'unavailable'
        && calibrationPedalSlot.modeVisible === true
        && calibrationPedalSlot.modeEnabled === true
        && calibrationPedalSlot.modeLabel === 'Model metadata'
        && calibrationFieldLabels.every((label) => calibrationPedalSlot.fields.some((field) => field.label === label && field.visible && field.value.length > 0))
        && calibrationAmpSlot?.visible === true
        && calibrationAmpSlot.loaded === true
        && calibrationAmpSlot.capture.length > 0
        && calibrationAmpSlot.capture !== 'No capture'
        && calibrationAmpSlot.status === 'complete'
        && calibrationAmpSlot.statusText.includes('Model metadata')
        && calibrationAmpSlot.statusText.includes('applied live')
        && calibrationAmpSlot.modeVisible === true
        && calibrationAmpSlot.modeEnabled === true
        && calibrationAmpSlot.modeLabel === 'Model metadata'
        && calibrationFieldLabels.every((label) => calibrationAmpSlot.fields.some((field) => field.label === label && field.visible && field.value === calibrationAmpExpectedValues[label]))
        && calibrationNormalize(calibrationDrawer?.querySelector('.nam-calibration-footer span')?.textContent).includes('applied live inside the NAM wet paths')
        && visibleBox(calibrationDrawer?.querySelector('.nam-calibration-footer button'))
        && calibrationNormalize(calibrationDrawer?.querySelector('.nam-calibration-footer button')?.textContent) === 'Done'
        && calibrationTextOverflowFailures.length === 0);
      const text = document.body.innerText;
      const forbiddenNormalWords = ['client_id', 'Callback URL', 'Manual access token'].filter((term) => text.includes(term));
      const rawWords = ['Cache', 'Disk', 'Fetch models'].filter((term) => text.includes(term));
      const retiredLaserParamIds = new Set([
        'laserEnabled',
        'laserMode',
        'laserMix',
        'laserSpeedHz',
        'laserSensitivity',
        'laserEnvelopeMode',
        'laserTrigger',
      ]);
      const isRetiredLaserNode = (el) => {
        const paramId = el?.getAttribute?.('data-param')
          || el?.getAttribute?.('data-param-id')
          || '';
        return el?.getAttribute?.('data-section') === 'special'
          || el?.getAttribute?.('data-module') === 'laser'
          || String(el?.getAttribute?.('data-skin') || '').includes('special-laser')
          || retiredLaserParamIds.has(paramId)
          || (el?.tagName === 'OPTION' && el?.value === 'special');
      };
      const retiredLaserSelector =
        '[data-section], [data-module], [data-skin], [data-param], [data-param-id], option[value]';
      const activeRetiredLaserNodes = Array.from(document.querySelectorAll(retiredLaserSelector))
        .filter((el) => isRetiredLaserNode(el) && visibleBox(el))
        .map((el) => el.getAttribute('data-param')
          || el.getAttribute('data-param-id')
          || el.getAttribute('data-skin')
          || el.getAttribute('data-module')
          || el.getAttribute('data-section')
          || el.value
          || el.tagName);
      const activeForbiddenTerms = [
        ...(text.match(/\b(?:Special FX|Glitch|Doubler)\b/g) || []),
        ...activeRetiredLaserNodes,
      ];
      const windowControlItems = Array.from(windowControls?.querySelectorAll('span, button') || []);
      const duplicateWindowControlsHidden = !windowControls
        || !visibleBox(windowControls)
        || windowControlItems.every((el) => !visibleBox(el));
      const saveToneModal = document.querySelector('.nam-save-tone-modal[data-modal-panel="true"]');
      const saveToneForm = saveToneModal?.querySelector('.nam-save-tone-form');
      const saveToneFields = Array.from(saveToneModal?.querySelectorAll('input, textarea') || []);
      const saveToneFooterButtons = Array.from(saveToneModal?.querySelectorAll('button') || [])
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const namRackPrompt = document.querySelector('.nam-rack-prompt-modal');
      const namRackPromptButtons = Array.from(namRackPrompt?.querySelectorAll('button') || [])
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const mixerStageStrips = Array.from(document.querySelectorAll('.nam-rack-mixer-strip'));
      const mixerBackButton = document.querySelector('[data-qa="nam-mixer-back"]');
      const mixerRect = rackMixer?.getBoundingClientRect();
      const mixerStagePicker = rackMixer?.querySelector('.nam-rack-mixer-stage-picker select');
      const mixerStageOptions = Array.from(mixerStagePicker?.options || []).map((option) => option.value);
      const mixerFocusedStage = rackMixer?.getAttribute('data-focused-stage') || '';
      const mixerSingleStage = rackMixer?.getAttribute('data-single-stage') === 'true';
      const mixerControlGroups = Array.from(rackMixer?.querySelectorAll('.nam-rack-mixer-control-group') || []).map((group) => ({
        id: group.getAttribute('data-control-group') || '',
        label: (group.querySelector(':scope > strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
        visible: visibleBox(group),
        paramIds: Array.from(group.querySelectorAll('.nam-rack-control[data-param]'))
          .map((control) => control.getAttribute('data-param') || '')
          .filter(Boolean),
      }));
      const mixerReverbExpectedGroups = {
        reverb: ['reverbEnabled', 'reverbMix', 'reverbDecaySec', 'reverbPreDelayMs', 'reverbLowCutHz', 'reverbTone', 'reverbShimmer'],
      };
      const mixerReverbGroupLabels = {
        reverb: 'Reverb',
      };
      const mixerReverbGroupsReady = mixerFocusedStage === 'reverb'
        && Object.entries(mixerReverbExpectedGroups).every(([id, paramIds]) => {
          const group = mixerControlGroups.find((item) => item.id === id);
          return Boolean(group
            && group.visible
            && group.label === mixerReverbGroupLabels[id]
            && paramIds.every((paramId) => group.paramIds.includes(paramId)));
        })
        && !mixerControlGroups.some((group) => group.id === 'additional');
      const mixerReadable = Boolean(visibleBox(rackMixer)
        && mixerSingleStage
        && mixerStageStrips.length === 1
        && mixerStageStrips.every((el) => visibleBox(el))
        && mixerStageOptions.length >= 9
        && Array.from(document.querySelectorAll('.nam-rack-mixer-strip-head strong')).every((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width >= 24 && rect.height >= 10;
        }));
      const mixerBackVisible = visibleBox(mixerBackButton);
      const mixerViewportFill = Boolean(mixerRect
        && mixerRect.width >= window.innerWidth - 2
        && mixerRect.height >= window.innerHeight - 2);
      const legacySourceFlowEl = document.querySelector('.nam-explorer.tone-source-flow[data-variant="source-flow"]');
      const legacySourceFlowVisible = Boolean(legacySourceFlowEl && visibleBox(legacySourceFlowEl));
      const iframeCount = document.querySelectorAll('iframe[data-rack-design-port-frame="true"], iframe[data-nam-source-flow-design-port-frame="true"]').length;
      const sourceFlowHost = document.querySelector('.nam-rack-source-flow-design-port.nam-native-design-surface');
      const sourceFlowFrame = sourceFlowHost;
      const sourceFlowFrameRect = sourceFlowHost?.getBoundingClientRect();
      const sourceFlowDoc = document;
      const sourceFlowReady = Boolean(sourceFlowHost?.querySelector('.screen-shell .tone-source-flow'));
      const sourceFlowShell = sourceFlowHost?.querySelector('.screen-shell');
      const sourceFlowShellRect = sourceFlowShell?.getBoundingClientRect();
      const sourceFlowEl = sourceFlowHost?.querySelector('.tone-source-flow');
      const sourceVisibleBox = (el) => {
        if (!el) return false;
        const view = el.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      };
      const sourceActuallyVisible = (el) => {
        if (!sourceVisibleBox(el)) return false;
        const rect = el.getBoundingClientRect();
        const flowRect = sourceFlowEl?.getBoundingClientRect();
        if (!flowRect) return false;
        if (rect.right < flowRect.left || rect.left > flowRect.right || rect.bottom < flowRect.top || rect.top > flowRect.bottom) return false;
        const centerX = Math.min(Math.max(rect.left + rect.width / 2, flowRect.left + 1), flowRect.right - 1);
        const centerY = Math.min(Math.max(rect.top + rect.height / 2, flowRect.top + 1), flowRect.bottom - 1);
        const hit = document.elementFromPoint(centerX, centerY);
        return Boolean(hit && (hit === el || el.contains(hit)));
      };
      const sourceFlowRect = sourceFlowEl?.getBoundingClientRect();
      const sourceFlowText = (sourceFlowEl?.textContent || '').replace(/\\s+/g, ' ').trim();
      const sourceFlowReturn = sourceFlowEl?.querySelector('.tone-return-button');
      const sourceFlowBreadcrumb = sourceFlowEl?.querySelector('.tone-breadcrumb');
      const sourceFlowDetailTitleEl = sourceFlowEl?.querySelector('.tone-selected-identity > span')
        || sourceFlowEl?.querySelector('.tone-detail-heading > span');
      const sourceFlowDetailNameEl = sourceFlowEl?.querySelector('.tone-selected-identity > h1')
        || sourceFlowEl?.querySelector('.tone-detail-heading > b');
      const sourceFlowDetailSubtitleEl = sourceFlowEl?.querySelector('.tone-selected-identity > p')
        || sourceFlowEl?.querySelector('.tone-detail-heading > em');
      const sourceFlowGenericFilters = sourceFlowEl?.querySelector('.nam-filters');
      const sourceFlowTargets = Array.from(sourceFlowEl?.querySelectorAll('.tone-target-card') || []).map((el) => ({
        slot: el.getAttribute('data-slot') || '',
        active: el.getAttribute('data-active') === 'true',
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      }));
      if (sourceFlowTargets.length === 0 && sourceFlowEl?.getAttribute('data-target-slot')) {
        sourceFlowTargets.push({
          slot: sourceFlowEl.getAttribute('data-target-slot') || '',
          active: true,
          text: sourceFlowEl.getAttribute('data-target-slot') || '',
        });
      }
      const sourceFlowLanes = Array.from(sourceFlowEl?.querySelectorAll('.tone-tab-row button, .tone-filter-row button, .tone-target-list .tone-target-card, .tone-chain-list .tone-chain-node, .tone-local-path') || []).map((el) => ({
        id: el.getAttribute('data-source-flow-value') || el.getAttribute('data-slot') || el.getAttribute('data-source-flow-action') || '',
        active: el.getAttribute('data-active') === 'true' || el.getAttribute('data-target') === 'true',
        loadable: ['load-local-ir', 'load-local-nam'].includes(el.getAttribute('data-source-flow-action') || '') || el.getAttribute('data-preview') === 'true',
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      }));
      const sourceFlowFilterControls = Array.from(sourceFlowEl?.querySelectorAll('.tone-filter-row button, .tone-filter-row option') || [])
        .map((el) => ({
          id: el.getAttribute('data-source-flow-value') || el.getAttribute('value') || '',
          label: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          active: el.getAttribute('data-active') === 'true' || Boolean(el.selected),
          kind: el.tagName.toLowerCase(),
        }));
      const sourceFlowFilters = sourceFlowFilterControls
        .map((filter) => filter.label)
        .filter(Boolean);
      const sourceFlowSelects = Array.from(sourceFlowEl?.querySelectorAll('.tone-filter-row select') || []).map((el) => ({
        label: el.getAttribute('aria-label') || '',
        value: el.value || '',
        visible: sourceVisibleBox(el),
        options: Array.from(el.options || []).map((option) => (option.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean),
      }));
      const sourceFlowRows = Array.from(sourceFlowEl?.querySelectorAll('.tone-feed-row') || []).map((el) => ({
        source: el.getAttribute('data-source') || '',
        category: el.getAttribute('data-category') || '',
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      }));
      const sourceFlowPagination = sourceFlowEl?.querySelector('.tone-library-pager');
      const sourceFlowActions = Array.from(sourceFlowEl?.querySelectorAll('button') || [])
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const sourceFlowVisibleActions = Array.from(sourceFlowEl?.querySelectorAll('.tone-action-grid button') || [])
        .filter((el) => sourceActuallyVisible(el))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      // Retired or unsupported stages must not return through route copy,
      // hydrated detail state, or old visual manifests.
      const sourceFlowForbiddenText = [
        ...(sourceFlowText.match(/Special FX|Glitch|Doubler|Stereo Width/g) || []),
        ...Array.from(sourceFlowEl?.querySelectorAll(retiredLaserSelector) || [])
          .filter(isRetiredLaserNode)
          .map((el) => el.getAttribute('data-param')
            || el.getAttribute('data-param-id')
            || el.getAttribute('data-skin')
            || el.getAttribute('data-module')
            || el.getAttribute('data-section')
            || el.value
            || el.tagName),
      ];
      const sourceFlowUnsupportedTone3000FXRows = sourceFlowRows.filter((row) => (
        row.source === 'tone3000' && /^(mod|delay|reverb)$/.test(row.category)
      ));
      const sourceFlowUnsupportedPedalRows = sourceFlowRows.filter((row) => (
        scenarioName === 'source-pedal'
        && row.category
        && !['drive', 'boost', 'fuzz', 'distortion', 'overdrive'].includes(row.category)
      ));
      const sourceFlowHasCabinetIR = sourceFlowRows.some((row) => row.category === 'cabinet-ir');
      const sourceFlowHasSpaceIR = sourceFlowRows.some((row) => row.category === 'space-ir');
      const sourceFlowWidthRatio = sourceFlowRect ? sourceFlowRect.width / Math.max(1, sourceFlowFrame?.getBoundingClientRect?.().width || window.innerWidth) : 0;
      const clippedSourceFlowActions = Array.from(sourceFlowEl?.querySelectorAll('.tone-feed-row button, .tone-action-grid button, .tone-return-button, .tone-search-panel button') || [])
        .filter((el) => sourceVisibleBox(el) && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 5))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const sourceFlowLayoutBlocks = Array.from(sourceFlowEl?.querySelectorAll('.tone-source-header, .tone-selected-visual, .tone-selected-info, .tone-selected-stage > .tone-action-grid, .tone-audition-status, .tone-library-heading, .tone-search-panel, .tone-tab-row, .tone-filter-row, .tone-feed-list') || [])
        .filter((el) => sourceVisibleBox(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            cls: el.className || el.tagName,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          };
        });
      const sourceFlowOverlaps = [];
      for (let leftIndex = 0; leftIndex < sourceFlowLayoutBlocks.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < sourceFlowLayoutBlocks.length; rightIndex += 1) {
          const left = sourceFlowLayoutBlocks[leftIndex];
          const right = sourceFlowLayoutBlocks[rightIndex];
          const horizontal = Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const vertical = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          if (horizontal > 2 && vertical > 2) {
            sourceFlowOverlaps.push(String(left.cls) + ' / ' + String(right.cls));
          }
        }
      }
      const sourceFlowDesignImages = Array.from(sourceFlowEl?.querySelectorAll('img') || [])
        .filter((el) => sourceVisibleBox(el));
      const sourceFlowHeroImage = sourceFlowEl?.querySelector('.tone-selected-visual > img');
      const sourceFlowHeroVisual = sourceFlowEl?.querySelector('.tone-selected-visual');
      const sourceFlowHeroImageRect = sourceFlowHeroImage?.getBoundingClientRect();
      const sourceFlowHeroVisualRect = sourceFlowHeroVisual?.getBoundingClientRect();
      const sourceFlowHeroImageReady = Boolean(sourceVisibleBox(sourceFlowHeroImage)
        && sourceFlowHeroImage.complete
        && sourceFlowHeroImage.naturalWidth >= 64
        && sourceFlowHeroImage.naturalHeight >= 48);
      const sourceFlowHeroVisualStyle = sourceFlowHeroVisual ? window.getComputedStyle(sourceFlowHeroVisual) : null;
      const sourceFlowHeroImageContained = Boolean(sourceFlowHeroImageRect
        && sourceFlowHeroVisualRect
        && ['hidden', 'clip'].includes(sourceFlowHeroVisualStyle?.overflow || '')
        && sourceFlowHeroImageRect.left <= sourceFlowHeroVisualRect.left + 2
        && sourceFlowHeroImageRect.top <= sourceFlowHeroVisualRect.top + 2
        && sourceFlowHeroImageRect.right >= sourceFlowHeroVisualRect.right - 2
        && sourceFlowHeroImageRect.bottom >= sourceFlowHeroVisualRect.bottom - 2
        && sourceFlowHeroImageRect.width >= sourceFlowHeroVisualRect.width * 0.9
        && sourceFlowHeroImageRect.height >= sourceFlowHeroVisualRect.height * 0.9
        && sourceFlowHeroImageRect.width <= sourceFlowHeroVisualRect.width * 1.08
        && sourceFlowHeroImageRect.height <= sourceFlowHeroVisualRect.height * 1.08);
      const sourceFlowResultRows = Array.from(sourceFlowEl?.querySelectorAll('.tone-feed-row') || []);
      const sourceFlowRowImages = sourceFlowResultRows
        .map((row) => row.querySelector('.tone-row-art img'))
        .filter(Boolean);
      const sourceFlowRowImagesReady = sourceFlowResultRows.length === 0 || (
        sourceFlowRowImages.length === sourceFlowResultRows.length
        && sourceFlowRowImages.every((image) => image.complete && image.naturalWidth >= 32 && image.naturalHeight >= 24)
      );
      const sourceFlowAssetLoadFailures = sourceFlowDesignImages
        .filter((el) => !el.complete || el.naturalWidth <= 0 || el.naturalHeight <= 0)
        .map((el) => el.getAttribute('data-rack-design-asset-id') || el.getAttribute('src') || 'unknown');
      const sourceFlowDesignBodyIds = [...new Set(sourceFlowDesignImages
        .filter((el) => el.getAttribute('data-rack-design-asset-kind') === 'body')
        .map((el) => el.getAttribute('data-rack-design-asset-id') || '')
        .filter(Boolean))];
      const sourceFlowDesignControlIds = [...new Set(sourceFlowDesignImages
        .filter((el) => el.getAttribute('data-rack-design-asset-kind') === 'control')
        .map((el) => el.getAttribute('data-rack-design-asset-id') || '')
        .filter(Boolean))];
      const sourceFlowTextElements = Array.from(sourceFlowEl?.querySelectorAll('.tone-return-button, .tone-breadcrumb span, .tone-breadcrumb b, .tone-breadcrumb em, .tone-source-flow button, .tone-selected-identity span, .tone-selected-identity h1, .tone-selected-identity p, .tone-selected-meta span, .tone-selected-stats span, .tone-library-heading span, .tone-library-heading strong, .tone-library-heading em, .tone-search-panel input, .tone-filter-row select, .tone-row-main strong, .tone-row-main span, .tone-detail-heading span, .tone-detail-heading b, .tone-detail-heading em, .tone-detail-meta span, .tone-audition-status span, .tone-audition-status b, .tone-audition-status em') || [])
        .filter((el) => sourceVisibleBox(el));
      const sourceFlowTextOverflowAudit = sourceFlowTextElements.map((el) => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const text = normalize(el.textContent || el.getAttribute('aria-label') || '');
        const title = normalize(el.getAttribute('title') || '');
        const style = window.getComputedStyle(el);
        const horizontalOverflow = el.scrollWidth > el.clientWidth + 3;
        const verticalOverflow = el.scrollHeight > el.clientHeight + 5;
        const intentionalTitledEllipsis = horizontalOverflow
          && !verticalOverflow
          && style.textOverflow === 'ellipsis'
          && ['hidden', 'clip'].includes(style.overflowX)
          && style.whiteSpace === 'nowrap'
          && text.length > 0
          && title === text;
        return {
          text,
          title,
          horizontalOverflow,
          verticalOverflow,
          intentionalTitledEllipsis,
          className: String(el.className || el.tagName),
        };
      });
      const sourceFlowTextOverflowFailures = sourceFlowTextOverflowAudit
        .filter((entry) => (entry.horizontalOverflow || entry.verticalOverflow) && !entry.intentionalTitledEllipsis)
        .map((entry) => (entry.text || entry.className).slice(0, 80));
      const sourceFlowAcceptedEllipses = sourceFlowTextOverflowAudit
        .filter((entry) => entry.intentionalTitledEllipsis)
        .map((entry) => ({ text: entry.text.slice(0, 100), titleMatches: entry.title === entry.text, className: entry.className }));
      const sourceFlowFontFloorFailures = sourceFlowTextElements
        .filter((el) => {
          const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
          return Number.isFinite(fontSize) && fontSize > 0 && fontSize < 5;
        })
        .map((el) => {
          const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
          return (el.textContent || el.className || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60) + ':' + fontSize.toFixed(1) + 'px';
        });
      const rackStageView = document.querySelector('.nam-rack-stage-view');
      const rackStageRect = rackStageView?.getBoundingClientRect();
      const activeRackSection = product?.getAttribute('data-rack-section') || '';
      const rackSize = product?.getAttribute('data-rack-size') || '';
      const designPortHost = document.querySelector('.nam-rack-design-port.nam-native-design-surface');
      const designPortFrame = designPortHost;
      const designPortFrameRect = designPortHost?.getBoundingClientRect();
      const designPortDoc = document;
      const designPortReady = Boolean(designPortHost?.querySelector('.screen-shell .module[data-module]'));
      const designPortShell = designPortHost?.querySelector('.screen-shell');
      const designPortShellRect = designPortShell?.getBoundingClientRect();
      const designPortStageCanvasRect = designPortHost?.querySelector('.premium-stage-canvas')?.getBoundingClientRect();
      const designPortBoard = designPortHost?.getAttribute('data-design-board') || designPortHost?.querySelector('.nam-rack-artboard')?.getAttribute('data-design-board') || '';
      const designPortSection = designPortHost?.getAttribute('data-design-section') || designPortShell?.getAttribute('data-section') || '';
      const designPortFooter = designPortHost?.querySelector('.footer');
      const designPortSizeControl = designPortFooter?.querySelector('button[title="Cycle rack display size"]');
      const rackSizeLabel = (designPortSizeControl?.textContent || '').replace(/\\s+/g, ' ').trim();
      const designPortFooterRuntime = Array.from(designPortFooter?.querySelectorAll('.footer-runtime strong') || [])
        .filter((el) => visibleBox(el))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const rackTopStripReady = Boolean(
        visibleBox(rackSectionRail)
        && rackSectionButtons.length >= 5
        && rackSectionButtons.every((item) => item.visible)
        && rackSectionButtons.filter((item) => item.active).length === 1
        && rackSectionButtons.some((item) => item.active && item.id === activeRackSection)
        && visibleBox(rackGlobalStrip)
        && rackGlobalControlCount >= 4
        && visibleBox(rackPresetHub)
        && visibleBox(rackPresetLibraryButton)
        && !visibleBox(rackGlobalLibraryButton)
        && rackGlobalDividerCount >= 3
        && rackRetiredControlsAbsent
      );
      const designExpectedBoardBySection = {
        pre: '03-pre-fx-section',
        amp: '04-amp-section',
        cab: '05-cab-section',
        eq: '06-eq-section',
        post: '07-post-fx-section',
      };
      const expectedDesignAspect = 768 / 341;
      const viewportAspect = window.innerWidth / Math.max(1, window.innerHeight);
      const shellViewportFill = (rect) => Boolean(rect && (
        viewportAspect <= expectedDesignAspect
          ? rect.width >= window.innerWidth * 0.98
          : rect.height >= window.innerHeight * 0.98
      ));
      const shellAspect = (rect) => rect ? Number((rect.width / Math.max(1, rect.height)).toFixed(4)) : 0;
      const shellAspectSafe = (rect) => Boolean(rect && rect.width > 0 && rect.height > 0);
      const frameWindowFill = (rect) => Boolean(rect
        && rect.left <= 8
        && rect.top <= 8
        && rect.width >= window.innerWidth - 16
        && rect.height >= window.innerHeight - 16);
      const designReferenceBoxes = {
        pre: {
          compressor: { x: 85, y: 42, w: 156, h: 232 },
          octaver: { x: 251, y: 42, w: 120, h: 232 },
          'eq-boost': { x: 381, y: 42, w: 156, h: 232 },
          'precision-drive': { x: 547, y: 42, w: 120, h: 232 },
          distortion: { x: 677, y: 42, w: 156, h: 232 },
        },
        amp: {
          'amp-head': { x: 24, y: -2, w: 720, h: 345 },
        },
        cab: {
          'mic-panel': { x: 54, y: -30, w: 660, h: 402 },
        },
        eq: {
          'eq-rack': { x: 24, y: 50, w: 720, h: 240 },
        },
        post: {
          modulator: { x: 25, y: 40, w: 220, h: 175 },
          delay: { x: 254, y: 24, w: 260, h: 200 },
          reverb: { x: 528, y: 29, w: 220, h: 195 },
        },
      };
      const toDesignArtboardBox = (el) => {
        if (!el) return null;
        const style = el.style || {};
        return {
          x: +(Number.parseFloat(style.left || '0')).toFixed(1),
          y: +(Number.parseFloat(style.top || '0')).toFixed(1),
          w: +(Number.parseFloat(style.width || '0')).toFixed(1),
          h: +(Number.parseFloat(style.height || '0')).toFixed(1),
        };
      };
      const designPortModules = Array.from(designPortHost?.querySelectorAll('.screen-shell .module[data-module]') || []);
      const rectWithInset = (node, scale = 1) => {
        const rect = node.getBoundingClientRect();
        const artboard = node.closest('.nam-rack-artboard');
        const matrix = artboard ? new DOMMatrixReadOnly(getComputedStyle(artboard).transform) : null;
        const artboardScale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
        const computedSize = Number.parseFloat(getComputedStyle(node).width);
        // A rotated square's axis-aligned DOMRect grows with its angle. Build
        // the visible dial box from the declared edge and artboard scale so a
        // 45-degree knob is not reported as larger or closer to its label.
        const declaredEdge = Number.isFinite(computedSize) ? computedSize * artboardScale : rect.width;
        const width = declaredEdge * scale;
        const height = declaredEdge * scale;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return {
          left: centerX - width / 2,
          right: centerX + width / 2,
          top: centerY - height / 2,
          bottom: centerY + height / 2,
          width,
          height,
        };
      };
      const horizontalOverlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const verticalGap = (a, b) => Math.max(b.top - a.bottom, a.top - b.bottom);
      const postKnobLabelGapFailures = activeRackSection !== 'post' ? [] : designPortModules.flatMap((module) => {
        const moduleId = module.getAttribute('data-module') || 'post-module';
        const knobs = Array.from(module.querySelectorAll('.asset-control.knob'))
          .filter((node) => visibleBox(node))
          // The knob PNGs intentionally have transparent square padding. The
          // 72% inset matches the visible metal/black dial, which is what can
          // actually collide with typography in a screenshot.
          .map((node) => rectWithInset(node, 0.72));
        const labels = Array.from(module.querySelectorAll('.label.post-label'))
          .filter((node) => visibleBox(node));
        return labels.flatMap((label) => {
          const labelRect = label.getBoundingClientRect();
          const text = (label.textContent || 'label').replace(/\s+/g, ' ').trim();
          const nearestGap = knobs
            .filter((knob) => horizontalOverlap(labelRect, knob) > 1)
            .reduce((gap, knob) => Math.min(gap, verticalGap(labelRect, knob)), Number.POSITIVE_INFINITY);
          return nearestGap < 3
            ? [moduleId + ':' + text + ':gap=' + nearestGap.toFixed(2)]
            : [];
        });
      });
      const postVisibleControlContainmentFailures = activeRackSection !== 'post' ? [] : designPortModules.flatMap((module) => {
        const moduleRect = module.getBoundingClientRect();
        const moduleId = module.getAttribute('data-module') || 'post-module';
        return Array.from(module.querySelectorAll('.asset-control.knob, .label.post-label, .module-title'))
          .filter((node) => visibleBox(node))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left < moduleRect.left + 2
              || rect.right > moduleRect.right - 2
              || rect.top < moduleRect.top + 2
              || rect.bottom > moduleRect.bottom - 2;
          })
          .map((node) => moduleId + ':' + ((node.textContent || node.className || node.tagName).replace(/\s+/g, ' ').trim().slice(0, 40)));
      });
      const postPrimaryHardware = activeRackSection !== 'post' ? [] : [
        { moduleId: 'modulator', paramId: 'modulatorEnabled' },
        { moduleId: 'delay', paramId: 'delayEnabled' },
        { moduleId: 'reverb', paramId: 'reverbEnabled' },
      ].map(({ moduleId, paramId }) => {
        const module = designPortModules.find((node) => node.getAttribute('data-module') === moduleId);
        const paramHits = Array.from(module?.querySelectorAll('.control-hit[data-param-id="' + paramId + '"]') || []);
        const resolveAssetAfter = (node) => {
          if (!node) return null;
          let sibling = node.nextElementSibling;
          while (sibling && !sibling.classList?.contains('asset-control')) sibling = sibling.nextElementSibling;
          return sibling;
        };
        const footHit = paramHits.find((node) => resolveAssetAfter(node)?.classList?.contains('footswitch'));
        const foot = resolveAssetAfter(footHit);
        const footRectForLookup = foot?.getBoundingClientRect();
        const ledCandidates = Array.from(module?.querySelectorAll('.asset-control.led') || []);
        const led = ledCandidates.reduce((best, node) => {
          if (!footRectForLookup) return best || node;
          const rect = node.getBoundingClientRect();
          const delta = Math.abs((rect.left + rect.width / 2) - (footRectForLookup.left + footRectForLookup.width / 2));
          if (!best) return node;
          const bestRect = best.getBoundingClientRect();
          const bestDelta = Math.abs((bestRect.left + bestRect.width / 2) - (footRectForLookup.left + footRectForLookup.width / 2));
          return delta < bestDelta ? node : best;
        }, null);
        const state = module?.querySelector('.primary-foot-state');
        const toMetric = (node) => {
          if (!node || !visibleBox(node)) return null;
          const rect = node.getBoundingClientRect();
          return {
            left: Number(rect.left.toFixed(2)),
            top: Number(rect.top.toFixed(2)),
            right: Number(rect.right.toFixed(2)),
            bottom: Number(rect.bottom.toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
            centerX: Number((rect.left + rect.width / 2).toFixed(2)),
            centerY: Number((rect.top + rect.height / 2).toFixed(2)),
          };
        };
        return { moduleId, foot: toMetric(foot), led: toMetric(led), state: toMetric(state) };
      });
      const postPrimaryHardwareFailures = [];
      if (activeRackSection === 'post') {
        if (postPrimaryHardware.some((entry) => !entry.foot || !entry.led || !entry.state)) {
          postPrimaryHardwareFailures.push('primary-hardware:missing');
        } else {
          const spread = (values) => Math.max(...values) - Math.min(...values);
          const footWidths = postPrimaryHardware.map((entry) => entry.foot.width);
          const ledWidths = postPrimaryHardware.map((entry) => entry.led.width);
          if (spread(footWidths) > 1) postPrimaryHardwareFailures.push('primary-foot-width-spread=' + spread(footWidths).toFixed(2));
          if (spread(ledWidths) > 1) postPrimaryHardwareFailures.push('primary-led-width-spread=' + spread(ledWidths).toFixed(2));
          postPrimaryHardware.forEach((entry) => {
            if (!(entry.led.centerY < entry.state.centerY && entry.state.centerY < entry.foot.centerY)) {
              postPrimaryHardwareFailures.push(entry.moduleId + ':footer-order');
            }
            if (entry.led.bottom > entry.state.top + 0.5) {
              postPrimaryHardwareFailures.push(entry.moduleId + ':led-state-overlap=' + (entry.led.bottom - entry.state.top).toFixed(2));
            }
            if (entry.state.bottom > entry.foot.top + 0.5) {
              postPrimaryHardwareFailures.push(entry.moduleId + ':state-foot-overlap=' + (entry.state.bottom - entry.foot.top).toFixed(2));
            }
          });
        }
      }
      const pedalHardwareContract = { knob: 28, footswitch: 25, toggle: 24, led: 12 };
      const pedalArtboard = designPortHost?.querySelector('.nam-rack-artboard');
      const pedalArtboardRect = pedalArtboard?.getBoundingClientRect();
      const pedalArtboardStyle = pedalArtboard ? getComputedStyle(pedalArtboard) : null;
      const pedalArtboardCssWidth = Number.parseFloat(pedalArtboardStyle?.width || '');
      const pedalArtboardCssHeight = Number.parseFloat(pedalArtboardStyle?.height || '');
      const pedalArtboardScale = {
        x: Number.isFinite(pedalArtboardCssWidth) && pedalArtboardCssWidth > 0 && pedalArtboardRect
          ? pedalArtboardRect.width / pedalArtboardCssWidth
          : 1,
        y: Number.isFinite(pedalArtboardCssHeight) && pedalArtboardCssHeight > 0 && pedalArtboardRect
          ? pedalArtboardRect.height / pedalArtboardCssHeight
          : 1,
      };
      const pedalHardwareMetrics = Array.from(
        // Header utility controls intentionally have their own larger sizing.
        // The physical-pedal contract applies only inside the scaled artboard.
        designPortHost?.querySelectorAll('.nam-rack-artboard .asset-control[data-nam-hardware-kind]') || [],
      ).filter(visibleBox).map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const standardPx = Number.parseFloat(node.getAttribute('data-nam-hardware-standard-px') || '');
        const computedWidth = Number.parseFloat(style.width);
        const computedHeight = Number.parseFloat(style.height);
        let transform = null;
        if (style.transform && style.transform !== 'none') {
          try { transform = new DOMMatrixReadOnly(style.transform); } catch { transform = null; }
        }
        const a = transform?.a ?? 1;
        const b = transform?.b ?? 0;
        const c = transform?.c ?? 0;
        const d = transform?.d ?? 1;
        const expectedBoxWidth = Number.isFinite(computedWidth) && Number.isFinite(computedHeight)
          ? (Math.abs(a) * computedWidth + Math.abs(c) * computedHeight) * pedalArtboardScale.x
          : Number.NaN;
        const expectedBoxHeight = Number.isFinite(computedWidth) && Number.isFinite(computedHeight)
          ? (Math.abs(b) * computedWidth + Math.abs(d) * computedHeight) * pedalArtboardScale.y
          : Number.NaN;
        return {
          renderContext: 'scaled-stage',
          moduleId: node.closest('.module')?.getAttribute('data-module') || 'stage',
          kind: node.getAttribute('data-nam-hardware-kind') || '',
          standardPx: Number.isFinite(standardPx) ? standardPx : null,
          computedWidth: Number.isFinite(computedWidth) ? computedWidth : null,
          computedHeight: Number.isFinite(computedHeight) ? computedHeight : null,
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
          expectedBoxWidth: Number.isFinite(expectedBoxWidth) ? Number(expectedBoxWidth.toFixed(2)) : null,
          expectedBoxHeight: Number.isFinite(expectedBoxHeight) ? Number(expectedBoxHeight.toFixed(2)) : null,
        };
      });
      const pedalHardwareConsistencyFailures = [];
      if (designPortReady) {
        pedalHardwareMetrics
          .filter((entry) => !(entry.kind in pedalHardwareContract))
          .forEach((entry) => pedalHardwareConsistencyFailures.push(entry.moduleId + ':unknown-kind=' + entry.kind));
        Object.entries(pedalHardwareContract).forEach(([kind, expected]) => {
          const entries = pedalHardwareMetrics.filter((entry) => entry.kind === kind);
          if (entries.length === 0) return;
          if (entries.some((entry) => !Number.isFinite(entry.standardPx))) {
            pedalHardwareConsistencyFailures.push(kind + ':non-finite-standard');
          }
          if (entries.some((entry) => Number.isFinite(entry.standardPx) && Math.abs(entry.standardPx - expected) > .01)) {
            pedalHardwareConsistencyFailures.push(kind + ':standard-attr-mismatch');
          }
          if (entries.some((entry) => !Number.isFinite(entry.computedWidth))) {
            pedalHardwareConsistencyFailures.push(kind + ':non-finite-computed-width');
          }
          if (entries.some((entry) => !Number.isFinite(entry.computedHeight))) {
            pedalHardwareConsistencyFailures.push(kind + ':non-finite-computed-height');
          }
          if (entries.some((entry) => Number.isFinite(entry.computedWidth) && Math.abs(entry.computedWidth - expected) > .1)) {
            pedalHardwareConsistencyFailures.push(kind + ':computed-width-mismatch');
          }
          if (entries.some((entry) => Number.isFinite(entry.computedHeight) && Math.abs(entry.computedHeight - expected) > .1)) {
            pedalHardwareConsistencyFailures.push(kind + ':computed-height-mismatch');
          }
          if (entries.some((entry) => !Number.isFinite(entry.width) || !Number.isFinite(entry.expectedBoxWidth))) {
            pedalHardwareConsistencyFailures.push(kind + ':non-finite-rendered-width');
          }
          if (entries.some((entry) => !Number.isFinite(entry.height) || !Number.isFinite(entry.expectedBoxHeight))) {
            pedalHardwareConsistencyFailures.push(kind + ':non-finite-rendered-height');
          }
          if (entries.some((entry) => Number.isFinite(entry.expectedBoxWidth) && Math.abs(entry.width - entry.expectedBoxWidth) > .75)) {
            pedalHardwareConsistencyFailures.push(kind + ':rendered-width-mismatch');
          }
          if (entries.some((entry) => Number.isFinite(entry.expectedBoxHeight) && Math.abs(entry.height - entry.expectedBoxHeight) > .75)) {
            pedalHardwareConsistencyFailures.push(kind + ':rendered-height-mismatch');
          }
        });
      }
      const designEqModule = designPortModules.find((module) => module.getAttribute('data-module') === 'eq-rack');
      const eqFaders = Array.from(designEqModule?.querySelectorAll('.fader[data-param-id]') || [])
        .filter((node) => visibleBox(node));
      const eqFaderParamIds = eqFaders.map((node) => node.getAttribute('data-param-id') || '');
      const eqFilterHits = Array.from(designEqModule?.querySelectorAll('.control-hit[data-param-id="eqHPFHz"], .control-hit[data-param-id="eqLPFHz"]') || [])
        .filter((node) => visibleBox(node));
      const eqFilterParamIds = eqFilterHits.map((node) => node.getAttribute('data-param-id') || '');
      const eqUtilityHits = Array.from(designEqModule?.querySelectorAll('.control-hit[data-param-id="eqHPFHz"], .control-hit[data-param-id="eqLevelDb"], .control-hit[data-param-id="eqLPFHz"]') || [])
        .filter((node) => visibleBox(node));
      const eqUtilityParamIds = eqUtilityHits.map((node) => node.getAttribute('data-param-id') || '');
      const eqFilterCaps = Array.from(designEqModule?.querySelectorAll('.asset-control.eq-filter-knob-hpf, .asset-control.eq-filter-knob-lpf') || [])
        .filter((node) => visibleBox(node));
      const eqFilterCapMetrics = [];
      const eqFilterCapFailures = [];
      const eqFilterLayoutFailures = [];
      if (designEqModule) {
        const moduleRect = designEqModule.getBoundingClientRect();
        const moduleLayoutWidth = designEqModule.clientWidth;
        const gridRect = designEqModule.querySelector('.eq-scale-grid')?.getBoundingClientRect();
        const titleRect = designEqModule.querySelector('.eq-rack-title')?.getBoundingClientRect();
        const controls = eqFilterHits;
        const overlaps = (left, right, tolerance = 1) => (
          Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance
          && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance
        );
        if (eqFilterHits.length !== 2) eqFilterLayoutFailures.push('filter-hit-count:' + eqFilterHits.length);
        if (eqFilterCaps.length !== 2) eqFilterCapFailures.push('filter-cap-count:' + eqFilterCaps.length);
        controls.forEach((node) => {
          const rect = node.getBoundingClientRect();
          const id = node.getAttribute('data-param-id')
            || node.querySelector('[data-param-id]')?.getAttribute('data-param-id')
            || node.className;
          if (rect.left < moduleRect.left - 1 || rect.top < moduleRect.top - 1
              || rect.right > moduleRect.right + 1 || rect.bottom > moduleRect.bottom + 1) {
            eqFilterLayoutFailures.push(id + ':outside-module');
          }
          if (gridRect && overlaps(rect, gridRect, 1)) eqFilterLayoutFailures.push(id + ':grid-overlap');
          if (titleRect && overlaps(rect, titleRect, 1)) eqFilterLayoutFailures.push(id + ':title-overlap');
        });
        for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
            if (overlaps(controls[leftIndex].getBoundingClientRect(), controls[rightIndex].getBoundingClientRect(), 1)) {
              eqFilterLayoutFailures.push('filter-control-overlap:' + leftIndex + ':' + rightIndex);
            }
          }
        }
        eqFilterCaps.forEach((node) => {
          const side = node.classList.contains('eq-filter-knob-hpf')
            ? 'hpf'
            : node.classList.contains('eq-filter-knob-lpf')
              ? 'lpf'
              : 'unknown';
          const paramId = side === 'hpf' ? 'eqHPFHz' : side === 'lpf' ? 'eqLPFHz' : '';
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const computedWidth = Number.parseFloat(style.width);
          const computedHeight = Number.parseFloat(style.height);
          const declaredPercent = Number(node.getAttribute('data-nam-exact-size-percent'));
          const expectedWidth = moduleLayoutWidth * declaredPercent / 100;
          const hit = paramId
            ? designEqModule.querySelector('.control-hit[data-param-id="' + paramId + '"]')
            : null;
          const hitRect = hit?.getBoundingClientRect();
          eqFilterCapMetrics.push({
            side,
            paramId,
            variant: node.getAttribute('data-nam-exact-size-variant') || '',
            declaredPercent: Number.isFinite(declaredPercent) ? Number(declaredPercent.toFixed(5)) : null,
            computedWidth: Number.isFinite(computedWidth) ? Number(computedWidth.toFixed(2)) : null,
            computedHeight: Number.isFinite(computedHeight) ? Number(computedHeight.toFixed(2)) : null,
            expectedWidth: Number.isFinite(expectedWidth) ? Number(expectedWidth.toFixed(2)) : null,
            renderedBounds: {
              left: Number(rect.left.toFixed(2)),
              top: Number(rect.top.toFixed(2)),
              right: Number(rect.right.toFixed(2)),
              bottom: Number(rect.bottom.toFixed(2)),
            },
          });
          if (!paramId) eqFilterCapFailures.push('filter-cap:unknown-side');
          if (node.getAttribute('data-nam-exact-size-variant') !== 'panel-knob') {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':missing-exact-size-variant');
          }
          if (node.hasAttribute('data-nam-hardware-standard-px')) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':inherited-pedal-knob-size');
          }
          if (!Number.isFinite(declaredPercent) || declaredPercent <= 0) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':invalid-declared-percent');
          }
          if (!Number.isFinite(computedWidth) || !Number.isFinite(expectedWidth)
              || Math.abs(computedWidth - expectedWidth) > .3) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':computed-width-mismatch');
          }
          if (!Number.isFinite(computedHeight) || !Number.isFinite(computedWidth)
              || Math.abs(computedHeight - computedWidth) > .3) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':non-square-cap');
          }
          if (rect.left < moduleRect.left - 1 || rect.top < moduleRect.top - 1
              || rect.right > moduleRect.right + 1 || rect.bottom > moduleRect.bottom + 1) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':outside-module');
          }
          if (gridRect && overlaps(rect, gridRect, 1)) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':grid-overlap');
          }
          if (titleRect && overlaps(rect, titleRect, 1)) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':title-overlap');
          }
          if (!hitRect) {
            eqFilterCapFailures.push((paramId || 'filter-cap') + ':missing-hitbox');
          } else {
            const capCenterX = (rect.left + rect.right) / 2;
            const capCenterY = (rect.top + rect.bottom) / 2;
            const hitCenterX = (hitRect.left + hitRect.right) / 2;
            const hitCenterY = (hitRect.top + hitRect.bottom) / 2;
            // NAM knob artwork rotates around the photographed gear centre at
            // 47.5586% Y rather than the transparent bitmap square's exact
            // midpoint. At large render scales that intentional optical
            // anchor moves the transformed bounding-box centre by more than a
            // fixed 1.25 CSS pixels even though the physical cap remains
            // centred on its hit target. Keep the allowance proportional to
            // the rendered cap while containment/collision checks stay strict.
            const opticalCenterTolerance = Math.max(1.25, rect.width * .03);
            if (Math.abs(capCenterX - hitCenterX) > opticalCenterTolerance
                || Math.abs(capCenterY - hitCenterY) > opticalCenterTolerance) {
              eqFilterCapFailures.push((paramId || 'filter-cap') + ':off-centre-hitbox');
            }
          }
        });
        if (new Set(eqFilterCapMetrics.map((entry) => entry.paramId)).size !== 2) {
          eqFilterCapFailures.push('filter-cap:param-id-coverage');
        }
      }
      const headerShell = designPortHost?.querySelector('.premium-nam-shell');
      const headerUtility = designPortHost?.querySelector('.premium-routing-utility');
      const headerPreset = designPortHost?.querySelector('.preset-console');
      const headerInstrument = designPortHost?.querySelector('.premium-output-instrument-switch');
      const headerDoubler = designPortHost?.querySelector('.premium-doubler-utility');
      const headerPresetTitle = designPortHost?.querySelector('.preset-console > .preset-title');
      const headerCalibration = designPortHost?.querySelector('[data-qa="nam-premium-calibration"]');
      const headerInputBlock = designPortHost?.querySelector('.global-block.left');
      const headerOutputBlock = designPortHost?.querySelector('.global-block.right');
      const headerInputPeakMeter = headerInputBlock?.querySelector('.premium-level-meter');
      const headerOutputPeakMeter = headerOutputBlock?.querySelector('.premium-level-meter');
      const headerInputMeterLanes = Array.from(headerInputPeakMeter?.querySelectorAll(':scope > i[data-meter-channel]') || []);
      const headerOutputMeterLanes = Array.from(headerOutputPeakMeter?.querySelectorAll(':scope > i[data-meter-channel]') || []);
      const headerUtilityCards = Array.from(headerUtility?.children || []).filter((node) => visibleBox(node));
      const headerUtilityCardClasses = headerUtilityCards.map((node) => node.className);
      const headerProcessingPresent = Boolean(designPortHost?.querySelector('.premium-processing-choice'));
      const headerPhysicalSourcePresent = Boolean(designPortHost?.querySelector('[data-qa="nam-physical-source"]'));
      const centerMetric = (node) => {
        if (!node || !visibleBox(node)) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: Number(rect.left.toFixed(2)),
          top: Number(rect.top.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          bottom: Number(rect.bottom.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
          centerX: Number((rect.left + rect.width / 2).toFixed(2)),
        };
      };
      const headerGeometry = {
        shell: centerMetric(headerShell),
        utility: centerMetric(headerUtility),
        preset: centerMetric(headerPreset),
        instrument: centerMetric(headerInstrument),
        doubler: centerMetric(headerDoubler),
        title: centerMetric(headerPresetTitle),
        calibration: centerMetric(headerCalibration),
        input: centerMetric(headerInputBlock),
        output: centerMetric(headerOutputBlock),
        inputPeakMeter: centerMetric(headerInputPeakMeter),
        outputPeakMeter: centerMetric(headerOutputPeakMeter),
        inputMeterChannelCount: Number(headerInputPeakMeter?.getAttribute('data-channel-count') || 0),
        outputMeterChannelCount: Number(headerOutputPeakMeter?.getAttribute('data-channel-count') || 0),
        inputMeterLanes: headerInputMeterLanes.map(centerMetric).filter(Boolean),
        outputMeterLanes: headerOutputMeterLanes.map(centerMetric).filter(Boolean),
        utilityCardClasses: headerUtilityCardClasses,
        processingPresent: headerProcessingPresent,
        physicalSourcePresent: headerPhysicalSourcePresent,
      };
      const headerGeometryFailures = [];
      if (designPortReady) {
        const requiredHeaderGeometry = [
          headerGeometry.shell,
          headerGeometry.utility,
          headerGeometry.preset,
          headerGeometry.instrument,
          headerGeometry.doubler,
          headerGeometry.title,
          headerGeometry.calibration,
          headerGeometry.input,
          headerGeometry.output,
        ];
        if (requiredHeaderGeometry.some((metric) => !metric)) {
          headerGeometryFailures.push('header-geometry:missing');
        } else {
          if (headerGeometry.utility.width > headerGeometry.preset.width - 8) {
            headerGeometryFailures.push('utility-not-narrower-than-preset=' + (headerGeometry.preset.width - headerGeometry.utility.width).toFixed(2));
          }
          if (headerGeometry.utilityCardClasses.length !== 1
            || !headerGeometry.utilityCardClasses.includes('premium-doubler-utility')) {
            headerGeometryFailures.push('utility-card-contract=' + headerGeometry.utilityCardClasses.join(','));
          }
          if (headerGeometry.processingPresent) headerGeometryFailures.push('processing-card-present');
          if (headerGeometry.physicalSourcePresent) headerGeometryFailures.push('physical-source-present');
          const validateMeterLanes = (name, meterMetric, channelCount, laneMetrics, expectedCount) => {
            if (!meterMetric || channelCount !== expectedCount || laneMetrics.length !== expectedCount) {
              headerGeometryFailures.push(name + '-meter-lanes=' + channelCount + '/' + laneMetrics.length + ',expected=' + expectedCount);
              return;
            }
            laneMetrics.forEach((lane, index) => {
              const contained = lane.left >= meterMetric.left + 1
                && lane.right <= meterMetric.right - 1
                && lane.top >= meterMetric.top + 1
                && lane.bottom <= meterMetric.bottom - 1;
              if (!contained) headerGeometryFailures.push(name + '-meter-lane-' + index + ':overflow');
            });
            if (laneMetrics.length === 2 && laneMetrics[0].right > laneMetrics[1].left + .1) {
              headerGeometryFailures.push(name + '-meter-lanes:overlap=' + (laneMetrics[0].right - laneMetrics[1].left).toFixed(2));
            }
          };
          validateMeterLanes(
            'input',
            headerGeometry.inputPeakMeter,
            headerGeometry.inputMeterChannelCount,
            headerGeometry.inputMeterLanes,
            headerGeometry.inputMeterChannelCount >= 2 ? 2 : 1,
          );
          validateMeterLanes(
            'output',
            headerGeometry.outputPeakMeter,
            headerGeometry.outputMeterChannelCount,
            headerGeometry.outputMeterLanes,
            2,
          );
          const metricInside = (metric, container, padding = 0) => Boolean(metric && container
            && metric.left >= container.left + padding - 1
            && metric.right <= container.right - padding + 1
            && metric.top >= container.top + padding - 1
            && metric.bottom <= container.bottom - padding + 1);
          if (!metricInside(headerGeometry.utility, headerGeometry.shell)) headerGeometryFailures.push('utility-shell-overflow');
          if (!metricInside(headerGeometry.preset, headerGeometry.shell)) headerGeometryFailures.push('preset-shell-overflow');
          if (!metricInside(headerGeometry.instrument, headerGeometry.output)) headerGeometryFailures.push('instrument-output-overflow');
          if (!metricInside(headerGeometry.doubler, headerGeometry.utility)) headerGeometryFailures.push('doubler-utility-overflow');
          if (!metricInside(headerGeometry.calibration, headerGeometry.shell)) headerGeometryFailures.push('calibration-shell-overflow');
          if (!metricInside(headerGeometry.input, headerGeometry.shell)) headerGeometryFailures.push('input-shell-overflow');
          if (!metricInside(headerGeometry.output, headerGeometry.shell)) headerGeometryFailures.push('output-shell-overflow');

          const intersects = (left, right) => {
            if (!left || !right || !visibleBox(left) || !visibleBox(right)) return false;
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          };
          const headerChrome = [headerCalibration, headerInputBlock, headerOutputBlock].filter(Boolean);
          headerChrome.forEach((node) => {
            const name = node.classList.contains('premium-calibration-launch') ? 'cal'
              : node.classList.contains('left') ? 'input-block' : 'output-block';
            if (intersects(node, headerUtility)) headerGeometryFailures.push(name + '-utility-overlap');
            if (intersects(node, headerPreset)) headerGeometryFailures.push(name + '-preset-overlap');
          });

          // At medium and desktop widths the side gutters are intentional
          // hardware bays, not a shallow mobile strip. Require them to span
          // both centre rows and keep the peak meters physically substantial.
          if (window.innerWidth >= 1264) {
            const inputMetric = headerGeometry.input;
            const outputMetric = headerGeometry.output;
            const inputMeterMetric = headerGeometry.inputPeakMeter;
            const outputMeterMetric = headerGeometry.outputPeakMeter;
            if (!inputMetric || !outputMetric || !inputMeterMetric || !outputMeterMetric) {
              headerGeometryFailures.push('header-side-bay:missing');
            } else {
              const minimumMeterHeight = 136;
              if (inputMeterMetric.height < minimumMeterHeight) {
                headerGeometryFailures.push('input-meter-height=' + inputMeterMetric.height.toFixed(2));
              }
              if (outputMeterMetric.height < minimumMeterHeight) {
                headerGeometryFailures.push('output-meter-height=' + outputMeterMetric.height.toFixed(2));
              }
              if (inputMetric.top > headerGeometry.utility.top + 6
                || outputMetric.top > headerGeometry.utility.top + 6) {
                headerGeometryFailures.push('header-side-bay:top-heavy');
              }
              if (inputMetric.bottom < headerGeometry.preset.bottom - 4
                || outputMetric.bottom < headerGeometry.preset.bottom - 4) {
                headerGeometryFailures.push('header-side-bay:unused-bottom-space');
              }
              if (inputMetric.right > headerGeometry.utility.left - 5) {
                headerGeometryFailures.push('input-rail-clearance=' + (headerGeometry.utility.left - inputMetric.right).toFixed(2));
              }
              if (outputMetric.left < headerGeometry.utility.right + 5) {
                headerGeometryFailures.push('output-rail-clearance=' + (outputMetric.left - headerGeometry.utility.right).toFixed(2));
              }
            }
          }
        }
      }
      const designPostReverb = designPortModules.find((module) => module.getAttribute('data-module') === 'reverb');
      const designPostReverbParamHits = Array.from(designPostReverb?.querySelectorAll('.control-hit[data-param-id]') || []);
      const designPostReverbParamIds = designPostReverbParamHits
        .map((control) => control.getAttribute('data-param-id') || '')
        .filter(Boolean);
      const designPostReverbFootActionLabels = Array.from(designPostReverb?.querySelectorAll('.foot-action-label') || [])
        .map((label) => (label.textContent || '').replace(/\s+/g, ' ').trim());
      const designPostReverbFixedParamIds = [
        'reverbVoice',
        'reverbPreDelayMs',
        'reverbDecaySec',
        'reverbMix',
        'reverbLowCutHz',
        'reverbTone',
        'reverbShimmer',
        'reverbPad',
        'reverbEnabled',
      ];
      const designPostReverbFixedReady = Boolean(designPostReverb
        && designPostReverbFixedParamIds.every((paramId) => designPostReverbParamIds.includes(paramId))
        && designPostReverbParamIds.every((paramId) => designPostReverbFixedParamIds.includes(paramId))
        && designPostReverbFootActionLabels.includes('ON / OFF'));
      const designModuleBoxes = Object.fromEntries(designPortModules.map((module) => [
        module.getAttribute('data-module') || '',
        toDesignArtboardBox(module),
      ]).filter(([id, box]) => id && box));
      const designPlacementFailures = [];
      const designModuleAspectFailures = [];
      const referenceBoxes = designReferenceBoxes[activeRackSection] || {};
      Object.entries(referenceBoxes).forEach(([id, ref]) => {
        const got = designModuleBoxes[id];
        if (!got) {
          designPlacementFailures.push(id + ':missing');
          return;
        }
        const module = designPortModules.find((node) => node.getAttribute('data-module') === id);
        const moduleRect = module?.getBoundingClientRect();
        if (moduleRect?.width && moduleRect?.height) {
          const gotAspect = moduleRect.width / moduleRect.height;
          const refAspect = ref.w / ref.h;
          const aspectDrift = Math.abs((gotAspect / refAspect) - 1);
          if (aspectDrift > 0.035) {
            designModuleAspectFailures.push(id + ':aspect=' + gotAspect.toFixed(3) + ',ref=' + refAspect.toFixed(3));
          }
        }
        const centerDelta = Math.hypot((got.x + got.w / 2) - (ref.x + ref.w / 2), (got.y + got.h / 2) - (ref.y + ref.h / 2));
        const sizeDelta = Math.max(Math.abs(got.w - ref.w), Math.abs(got.h - ref.h));
        if (centerDelta > 6 || sizeDelta > 10) {
          designPlacementFailures.push(id + ':center=' + centerDelta.toFixed(1) + ',size=' + sizeDelta.toFixed(1));
        }
      });
      const containedSkinRect = (module, skin) => {
        const moduleRect = module.getBoundingClientRect();
        // Controls are intentionally composed over the full module box. The
        // raster skin can include transparent safe-area padding, so its
        // natural-image contain rectangle is not the interaction boundary.
        void skin;
        return moduleRect;
      };
      const designSubjectContainmentFailures = designPortModules.flatMap((module) => {
        const skin = module.querySelector('.module-skin');
        if (!skin) return [];
        const skinRect = containedSkinRect(module, skin);
        const moduleId = module.getAttribute('data-module') || 'module';
        return Array.from(module.querySelectorAll('.asset-control, .label, .module-title, .module-display, .fader-track, .asset-button, .amp-brand, .amp-badge, .cab-badge'))
          .filter((node) => visibleBox(node))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX < skinRect.left - 3
              || centerX > skinRect.right + 3
              || centerY < skinRect.top - 3
              || centerY > skinRect.bottom + 3;
          })
          .map((node) => {
            const text = (node.textContent || node.getAttribute('class') || node.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
            return moduleId + ':' + text;
          });
      });
      const rackExpectedBodyIdsBySection = {
        pre: ['stompbox-body-blue-wide', 'stompbox-body-olive', 'stompbox-body-white-wide', 'stompbox-body-red-wide', 'stompbox-body-stone'],
        amp: ['amp-head-body-v5'],
        cab: ['cab-room-integrated-body'],
        eq: ['graphic-eq-body-v6'],
        post: ['wide-pedal-body-copper-tall', 'wide-pedal-body-dark-tall', 'wide-pedal-body-navy-tall'],
      };
      const rackExpectedBodyIds = rackExpectedBodyIdsBySection[activeRackSection] || [];
      const rackDesignImages = Array.from(designPortHost?.querySelectorAll('.screen-shell [data-rack-design-asset-kind]') || [])
        .filter((el) => visibleBox(el));
      const rackDesignBodyIds = [...new Set(rackDesignImages
        .filter((el) => el.getAttribute('data-rack-design-asset-kind') === 'body')
        .map((el) => el.getAttribute('data-rack-design-asset-id') || '')
        .filter(Boolean))];
      const rackDesignControlIds = [...new Set(rackDesignImages
        .filter((el) => el.getAttribute('data-rack-design-asset-kind') === 'control')
        .map((el) => el.getAttribute('data-rack-design-asset-id') || '')
        .filter(Boolean))];
      const rackAssetLoadFailures = rackDesignImages
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
          return !src || rect.width <= 0 || rect.height <= 0 || ('complete' in el && (!el.complete || el.naturalWidth <= 0 || el.naturalHeight <= 0));
        })
        .map((el) => el.getAttribute('data-rack-design-asset-id') || 'unknown');
      const rackSceneDevices = designPortModules
        .filter((el) => visibleBox(el));
      const rackDeviceClipFailures = rackSceneDevices
        .filter((el) => {
          if (!designPortStageCanvasRect) return false;
          const rect = el.getBoundingClientRect();
          return rect.left < designPortStageCanvasRect.left - 2
            || rect.right > designPortStageCanvasRect.right + 2
            || rect.top < designPortStageCanvasRect.top - 2
            || rect.bottom > designPortStageCanvasRect.bottom + 2;
        })
        .map((el) => (
          (el.getAttribute('data-module') || 'device')
          + ':'
          + Math.round(el.getBoundingClientRect().left)
          + ','
          + Math.round(el.getBoundingClientRect().top)
          + ','
          + Math.round(el.getBoundingClientRect().right)
          + ','
          + Math.round(el.getBoundingClientRect().bottom)
        ));
      const rackSuite = designPortShell;
      const rackSuiteRect = designPortShellRect;
      const rackSceneOverflowFailures = [];
      if (rackSuiteRect && rackStageRect) {
        if (rackSuiteRect.left < rackStageRect.left - 2) rackSceneOverflowFailures.push('suite-left');
        if (rackSuiteRect.right > rackStageRect.right + 2) rackSceneOverflowFailures.push('suite-right');
        if (rackSuiteRect.top < rackStageRect.top - 2) rackSceneOverflowFailures.push('suite-top');
        if (rackSuiteRect.bottom > rackStageRect.bottom + 2) rackSceneOverflowFailures.push('suite-bottom');
      }
      const rackTextElements = Array.from(designPortHost?.querySelectorAll('.screen-shell .rack-title, .screen-shell .nav-item, .screen-shell .label, .screen-shell .module-title, .screen-shell .preset, .screen-shell .footer span, .screen-shell .footer b') || [])
        .filter((el) => visibleBox(el));
      const rackTextOverflowFailures = rackTextElements
        .filter((el) => {
          if (el.classList?.contains('rack-title')) return el.scrollWidth > el.clientWidth + 3;
          return el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 5;
        })
        .map((el) => (el.textContent || el.getAttribute('aria-label') || el.className || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 80));
      const rackFontElements = Array.from(designPortHost?.querySelectorAll('.screen-shell :is(button, span, b, strong, em, small, p, .label, .control-label, .value-label, .module-title)') || [])
        .filter((el) => visibleBox(el) && (el.textContent || '').trim());
      const renderedRackFontSize = (el) => {
        const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
        const artboard = el.closest('.nam-rack-artboard');
        const transform = artboard ? window.getComputedStyle(artboard).transform : 'none';
        let scale = 1;
        if (transform && transform !== 'none') {
          try {
            const matrix = new DOMMatrixReadOnly(transform);
            scale = Math.hypot(matrix.a, matrix.b);
          } catch {
            scale = 1;
          }
        }
        return fontSize * scale;
      };
      const rackFontFloorFailures = rackFontElements
        .filter((el) => {
          const fontSize = renderedRackFontSize(el);
          return Number.isFinite(fontSize) && fontSize > 0 && fontSize < 7;
        })
        .map((el) => {
          const fontSize = renderedRackFontSize(el);
          return (el.textContent || el.className || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60) + ':' + fontSize.toFixed(1) + 'px';
        });
      const rackMainForbiddenVisibleTerms = Array.from(designPortHost?.querySelectorAll('.screen-shell') || [])
        .filter((el) => visibleBox(el))
        .flatMap((el) => [
          ...((el.textContent || '').match(/\b(?:Special FX|Glitch|Doubler)\b/g) || []),
          ...Array.from(el.querySelectorAll(retiredLaserSelector))
            .filter(isRetiredLaserNode)
            .map((node) => node.getAttribute('data-param')
              || node.getAttribute('data-param-id')
              || node.getAttribute('data-skin')
              || node.getAttribute('data-module')
              || node.getAttribute('data-section')
              || node.value
              || node.tagName),
        ]);
      return {
        scenario: ${JSON.stringify(scenarioName)},
        productVisible: Boolean(product),
        namWindowTitle: (namWindowTitle?.textContent || '').trim(),
        hasReferenceWindowChrome: (namWindowTitle?.textContent || '').trim() === 'NAM Rack'
          && duplicateWindowControlsHidden,
        headerMeterHeights: headerMeters.map((el) => Number(el.getBoundingClientRect().height.toFixed(1))),
        headerMeterWidths,
        headerMetersResponsive,
        headerMeterReadouts,
        headerTrimReadoutChips: headerTrimReadoutChips.map((el) => (el.textContent || '').trim()),
        headerTrimReadoutChipsVisible,
        headerCompareLabels,
        headerCompareLabelsClean,
        headerPresetSelectIconHidden,
        headerUtilityActions,
        headerUtilityReferenceIcons,
        headerLibraryActiveQuiet,
        hasReferenceHeaderMeters: headerMeters.length === 2 && headerMeters.every((el) => el.getBoundingClientRect().height >= 10),
        productHeight: productRect?.height ?? 0,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        iframeCount,
        rootScrollbar,
        moduleCount: modules.length,
        modules,
        chainCardsNeutralWhenActive,
        selectedChainCardAmber,
        selectedChainTextFits,
        selectedChainText: (selectedChainModule?.textContent || '').replace(/\\s+/g, ' ').trim(),
        selectedChainTextMetrics,
        chainActionsHiddenAtRest,
        chainSlotActionStates,
        maxModuleHeight,
        hasCompactChainLane: maxModuleHeight > 0 && maxModuleHeight <= 96,
        hasRigLane: text.includes('Rig Lane'),
        hasEditableCopy: text.includes('Post-cab order is editable'),
        hasBrowse: Boolean(document.querySelector('.nam-explorer')),
        hasBrowseHero: Boolean(document.querySelector('.nam-browse-hero')),
        hasAdvanced: Boolean(document.querySelector('.nam-advanced-view')),
        hasRackMixer: Boolean(rackMixer),
        mixerReadable,
        mixerBackVisible,
        mixerViewportFill,
        mixerSingleStage,
        mixerFocusedStage,
        mixerStageOptions,
        mixerControlGroups,
        mixerReverbGroupsReady,
        hasSaveToneModal: Boolean(visibleBox(saveToneModal)),
        saveToneFormReadable: Boolean(visibleBox(saveToneForm) && saveToneFields.length >= 9),
        saveToneFooterButtons,
        hasNAMRackPrompt: Boolean(visibleBox(namRackPrompt)),
        namRackPromptButtons,
        hasChainDragOverlay: Boolean(chainDragOverlay),
        hasPresetManager: Boolean(document.querySelector('.nam-preset-manager')),
        presetManagerMetrics: (() => {
          const element = document.querySelector('.nam-preset-manager');
          if (!(element instanceof HTMLElement)) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const matchedDisplayRules = [];
          const visitRules = (rules) => {
            for (const rule of Array.from(rules || [])) {
              if (rule instanceof CSSStyleRule && rule.style.display) {
                try {
                  if (element.matches(rule.selectorText)) {
                    matchedDisplayRules.push({ selector: rule.selectorText, display: rule.style.display, important: rule.style.getPropertyPriority('display') });
                  }
                } catch {
                  // Ignore unsupported selectors in browser-vendor stylesheets.
                }
              }
              if ('cssRules' in rule) visitRules(rule.cssRules);
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try { visitRules(sheet.cssRules); } catch { /* Cross-origin stylesheets are not inspectable. */ }
          }
          return {
            visible: visibleBox(element),
            inViewport: rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            zIndex: style.zIndex,
            matchedDisplayRules,
          };
        })(),
        hasPresetTransfer: Boolean(document.querySelector('.nam-preset-transfer-row')) && text.includes('Import') && text.includes('Export Current'),
        hasSlotBrowser: Boolean(document.querySelector('.nam-slot-browser'))
          && Boolean(document.querySelector('.nam-slot-browser-actions'))
          && text.includes('Duplicate'),
        sourceFlow: {
          visible: sourceVisibleBox(sourceFlowEl),
          frameVisible: visibleBox(sourceFlowFrame),
          ready: sourceFlowReady,
          designBoard: sourceFlowHost?.getAttribute('data-design-board') || sourceFlowHost?.querySelector('.nam-source-flow-artboard')?.getAttribute('data-design-board') || '',
          frameWindowFill: frameWindowFill(sourceFlowFrameRect),
          shellViewportFill: shellViewportFill(sourceFlowShellRect),
          shellAspect: shellAspect(sourceFlowShellRect),
          shellAspectSafe: shellAspectSafe(sourceFlowShellRect),
          frameRect: sourceFlowFrameRect ? {
            left: Number(sourceFlowFrameRect.left.toFixed(1)),
            top: Number(sourceFlowFrameRect.top.toFixed(1)),
            width: Number(sourceFlowFrameRect.width.toFixed(1)),
            height: Number(sourceFlowFrameRect.height.toFixed(1)),
          } : null,
          shellRect: sourceFlowShellRect ? {
            left: Number(sourceFlowShellRect.left.toFixed(1)),
            top: Number(sourceFlowShellRect.top.toFixed(1)),
            width: Number(sourceFlowShellRect.width.toFixed(1)),
            height: Number(sourceFlowShellRect.height.toFixed(1)),
          } : null,
          legacyExplorerVisible: legacySourceFlowVisible,
          mode: sourceFlowEl?.getAttribute('data-source-mode') || '',
          width: sourceFlowRect ? Number(sourceFlowRect.width.toFixed(1)) : 0,
          widthRatio: Number(sourceFlowWidthRatio.toFixed(3)),
          boundedWidth: Boolean(sourceFlowRect && sourceFlowWidthRatio <= 0.985),
          returnTarget: sourceFlowReturn?.getAttribute('data-return-target') || '',
          returnText: (sourceFlowReturn?.textContent || '').replace(/\\s+/g, ' ').trim(),
          breadcrumb: (sourceFlowBreadcrumb?.textContent || '').replace(/\\s+/g, ' ').trim(),
          detailTitle: (sourceFlowDetailTitleEl?.textContent || '').replace(/\\s+/g, ' ').trim(),
          detailName: (sourceFlowDetailNameEl?.textContent || '').replace(/\\s+/g, ' ').trim(),
          detailSubtitle: (sourceFlowDetailSubtitleEl?.textContent || '').replace(/\\s+/g, ' ').trim(),
          selectedAvailable: Boolean(sourceFlowEl?.querySelector('.tone-selected-info')),
          emptyStateVisible: sourceActuallyVisible(sourceFlowEl?.querySelector('.tone-feed-empty')),
          emptyStateText: (sourceFlowEl?.querySelector('.tone-feed-empty')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          targets: sourceFlowTargets,
          lanes: sourceFlowLanes,
          filters: sourceFlowFilters,
          filterControls: sourceFlowFilterControls,
          selects: sourceFlowSelects,
          rows: sourceFlowRows,
          resultRowCount: sourceFlowRows.length,
          paginationVisible: sourceActuallyVisible(sourceFlowPagination),
          paginationText: (sourceFlowPagination?.textContent || '').replace(/\\s+/g, ' ').trim(),
          rowCategories: [...new Set(sourceFlowRows.map((row) => row.category).filter(Boolean))],
          rowSources: [...new Set(sourceFlowRows.map((row) => row.source).filter(Boolean))],
          actions: sourceFlowActions,
          visibleActions: sourceFlowVisibleActions,
          hasLocalIRLane: sourceFlowLanes.some((lane) => lane.id === 'local-ir') || sourceFlowActions.some((label) => /Load Local File/i.test(label)),
          hasCabinetIR: sourceFlowHasCabinetIR,
          hasSpaceIR: sourceFlowHasSpaceIR,
          forbiddenText: sourceFlowForbiddenText,
          unsupportedTone3000FXRows: sourceFlowUnsupportedTone3000FXRows,
          unsupportedPedalRows: sourceFlowUnsupportedPedalRows,
          genericFiltersVisible: visibleBox(sourceFlowGenericFilters),
          clippedActions: clippedSourceFlowActions,
          actionClipFailures: clippedSourceFlowActions,
          layoutOverlaps: sourceFlowOverlaps,
          layoutOverlapFailures: sourceFlowOverlaps,
          imageCount: sourceFlowDesignImages.length,
          heroImageReady: sourceFlowHeroImageReady,
          heroImageContained: sourceFlowHeroImageContained,
          heroImageSource: sourceFlowHeroImage?.getAttribute('src') || '',
          rowImageCount: sourceFlowRowImages.length,
          rowImagesReady: sourceFlowRowImagesReady,
          assetLoadFailures: sourceFlowAssetLoadFailures,
          designBodyIds: sourceFlowDesignBodyIds,
          designControlIds: sourceFlowDesignControlIds,
          textOverflowFailures: sourceFlowTextOverflowFailures,
          acceptedTitledEllipses: sourceFlowAcceptedEllipses,
          fontFloorFailures: sourceFlowFontFloorFailures,
        },
        rackMain: {
          section: activeRackSection,
          size: rackSize,
          sizeLabel: rackSizeLabel,
          designPortReady,
          topStripReady: rackTopStripReady,
          sectionButtons: rackSectionButtons,
          footerVisible: visibleBox(designPortFooter),
          footerRuntime: designPortFooterRuntime,
          sizeControlVisible: visibleBox(designPortSizeControl),
          designBoard: designPortBoard,
          expectedDesignBoard: designExpectedBoardBySection[activeRackSection] || '',
          designSection: designPortSection,
          productWindowFill: frameWindowFill(productRect),
          frameWindowFill: frameWindowFill(designPortFrameRect),
          shellViewportFill: shellViewportFill(designPortShellRect),
          shellAspect: shellAspect(designPortShellRect),
          shellAspectSafe: shellAspectSafe(designPortShellRect),
          frameRect: designPortFrameRect ? {
            left: Number(designPortFrameRect.left.toFixed(1)),
            top: Number(designPortFrameRect.top.toFixed(1)),
            width: Number(designPortFrameRect.width.toFixed(1)),
            height: Number(designPortFrameRect.height.toFixed(1)),
          } : null,
          expectedBodyIds: rackExpectedBodyIds,
          designBodyIds: rackDesignBodyIds,
          designControlIds: rackDesignControlIds,
          generatedBodyAssetReady: rackExpectedBodyIds.length > 0
            && rackExpectedBodyIds.every((id) => rackDesignBodyIds.includes(id)),
          generatedControlAssetReady: rackDesignControlIds.length > 0,
          assetLoadFailures: rackAssetLoadFailures,
          deviceClipFailures: rackDeviceClipFailures,
          sceneOverflowFailures: rackSceneOverflowFailures,
          placementFailures: designPlacementFailures,
          moduleAspectFailures: designModuleAspectFailures,
          subjectContainmentFailures: designSubjectContainmentFailures,
          moduleBoxes: designModuleBoxes,
          textOverflowFailures: rackTextOverflowFailures,
          fontFloorFailures: rackFontFloorFailures,
          forbiddenVisibleTerms: rackMainForbiddenVisibleTerms,
          deviceCount: rackSceneDevices.length,
          reverbFixedControls: {
            ready: designPostReverbFixedReady,
            paramIds: designPostReverbParamIds,
            footActionLabels: designPostReverbFootActionLabels,
          },
          postKnobLabelGapFailures,
          postVisibleControlContainmentFailures,
          postPrimaryHardware,
          postPrimaryHardwareFailures,
          pedalHardwareMetrics,
          pedalHardwareConsistencyFailures,
          eqFaderParamIds,
          eqFilterParamIds,
          eqUtilityParamIds,
          eqFilterCapCount: eqFilterCaps.length,
          eqFilterCapMetrics,
          eqFilterCapFailures,
          eqFilterLayoutFailures,
          headerGeometry,
          headerGeometryFailures,
          suiteRect: rackSuiteRect ? {
            left: Number(rackSuiteRect.left.toFixed(1)),
            top: Number(rackSuiteRect.top.toFixed(1)),
            right: Number(rackSuiteRect.right.toFixed(1)),
            bottom: Number(rackSuiteRect.bottom.toFixed(1)),
            width: Number(rackSuiteRect.width.toFixed(1)),
            height: Number(rackSuiteRect.height.toFixed(1)),
          } : null,
        },
        hasTunerPanel: Boolean(visibleBox(tunerPanel) && visibleBox(tunerDisplay) && visibleBox(tunerScale) && visibleBox(tunerNeedle)),
        tunerHasPitchReadout,
        tunerText,
        tunerNeedlePct,
        tunerDetails: {
          signal: tunerPanel?.getAttribute('data-signal') || tunerPanel?.getAttribute('data-lock') || '',
          note: tunerNoteText,
          cents: tunerCentsText,
          readouts: tunerReadoutEntries,
        },
        tunerButtonEnabled: Boolean(farTunerButton) && !farTunerButton.disabled,
        hasCalibrationDrawer: visibleBox(calibrationDrawer),
        calibration: {
          ready: calibrationReady,
          contained: calibrationContained,
          eyebrow: calibrationEyebrow,
          title: calibrationTitle,
          explanation: calibrationExplanation,
          reference: {
            label: calibrationReferenceLabel,
            value: calibrationReferenceInput?.value || '',
            unit: calibrationReferenceUnit,
            help: calibrationReferenceHelp,
          },
          slots: calibrationSlots,
          textOverflowFailures: calibrationTextOverflowFailures,
        },
        forbiddenNormalWords,
        rawWords,
        activeForbiddenTerms,
        headerPresetManagerHidden: !visibleBox(headerPresetManagerAction),
      };
    })()
  `);
}

function selectScenarios(name) {
  if (name === "all") return SCENARIOS.filter((item) => !item.name.endsWith("-debug"));
  if (name === "source") return SCENARIOS.filter((item) => item.name.startsWith("source-"));
  if (name === "neural") return SCENARIOS.filter((item) => item.name.startsWith("rack-neural-") && !item.name.endsWith("-debug") && item.name !== "rack-neural-size-menu");
  if (name === "neural-debug") return SCENARIOS.filter((item) => item.name.startsWith("rack-neural-") && item.name.endsWith("-debug"));
  const scenario = SCENARIOS.find((item) => item.name === name);
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  return [scenario];
}

function selectViewports(name) {
  if (name === "all") return VIEWPORTS;
  const viewport = VIEWPORTS.find((item) => item.name === name);
  if (!viewport) throw new Error(`Unknown viewport: ${name}`);
  return [viewport];
}

function expandRackSizeScenarios(scenarios, rackSizeArg) {
  if (!rackSizeArg) return scenarios;
  const sizes = rackSizeArg.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set(["80", "100", "140", "180", "220"]);
  const invalid = sizes.filter((size) => !allowed.has(size));
  if (invalid.length > 0) throw new Error(`Unsupported rack size(s): ${invalid.join(", ")}`);
  return scenarios.flatMap((scenario) => {
    if (!scenario.name.startsWith("rack-neural-") || scenario.name.endsWith("-debug") || scenario.name === "rack-neural-size-menu") {
      return [scenario];
    }
    return sizes.map((size) => ({
      ...scenario,
      name: `${scenario.name}-size-${size}`,
      checkName: scenario.checkName || scenario.name,
      params: {
        ...scenario.params,
        namRackSize: size,
      },
    }));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const scenarios = expandRackSizeScenarios(selectScenarios(args.scenario), args.rackSize);
  const viewports = selectViewports(args.viewport);
  const vite = await startViteIfNeeded(args);
  await mkdir(args.outDir, { recursive: true });
  await mkdir(path.dirname(args.report), { recursive: true });
  const browser = await launchBrowserIfNeeded(args);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    scenarios: [],
    failures: [],
  };

  try {
    for (const viewport of viewports) {
      for (const scenario of scenarios) {
        const cdp = await openTab(args, viewport, scenario);
        const checkName = scenario.checkName || scenario.name;
        const fileName = `nam-${scenario.name}-${viewport.name}.png`;
        const filePath = path.join(args.outDir, fileName);
        const item = {
          scenario: scenario.name,
          viewport: viewport.name,
          screenshot: filePath,
          pass: true,
          checks: null,
          interaction: null,
          error: null,
        };
        try {
          if (isRackMainScenario(scenario.name)) {
            await waitForDesignPort(cdp);
          }
          if (scenario.name === "rack-chain") {
            item.interaction = await runInteractionProbe(cdp);
          }
          if (scenario.name === "source-amp-audition-click") {
            item.interaction = await runSourceAmpAuditionProbe(cdp);
          }
          if (scenario.name === "rack-tuner") {
            await openTunerRail(cdp);
          }
          if (scenario.name === "rack-calibration") {
            await openCalibrationDrawer(cdp);
          }
          if (scenario.name === "preset-manager" || scenario.name === "preset-export-dialog") {
            await openPresetManager(cdp);
          }
          if (scenario.name === "preset-export-dialog") {
            await openPresetExportDialog(cdp);
          }
          if (scenario.name === "save-tone-modal") {
            await openSaveToneModal(cdp);
          }
          if (scenario.name === "rack-neural-size-menu") {
            item.interaction = await cycleRackSizeControl(cdp);
          }
          if (scenario.name === "mixer") {
            await selectMixerStage(cdp, "reverb");
          }
          item.checks = await qualityChecks(cdp, checkName);
          await screenshot(cdp, filePath);
          if (checkName === "rack-neural-pre" && viewport.name === "1920x1080") {
            item.compressorHpfInteraction = await runCompressorHpfProbe(cdp, args.outDir, viewport.name);
            if (item.compressorHpfInteraction?.pass !== true) {
              throw new Error(`Compressor HPF interaction failed: ${JSON.stringify(item.compressorHpfInteraction)}`);
            }
            item.distortionModeInteraction = await runDistortionModeProbe(cdp, args.outDir, viewport.name);
            if (item.distortionModeInteraction?.pass !== true) {
              throw new Error(`Distortion mode interaction failed: ${JSON.stringify(item.distortionModeInteraction)}`);
            }
          }
          if (scenario.name === "rack-neural-amp") {
            item.instrumentProfileInteraction = await runInstrumentProfileProbe(cdp, args.outDir, viewport.name);
            if (item.instrumentProfileInteraction?.pass !== true) {
              throw new Error(`Instrument profile interaction failed: ${JSON.stringify(item.instrumentProfileInteraction)}`);
            }
          }
          if (scenario.name.startsWith("source-")) {
            const sourceScenarioKey = scenario.checkName || scenario.name;
            const expectedSourceModes = {
              "source-amp": "tone3000-amp-nam",
              "source-pedal": "tone3000-pedal-nam",
              "source-ir": "ir-sources",
              "source-fx": "openstudio-fx-collection",
            };
            const expectedSourceBoards = {
              "source-amp": "11-tone-library-amp-flow",
              "source-pedal": "12-tone-library-pedal-flow",
              "source-ir": "13-ir-source-flow",
              "source-fx": "14-fx-collection-flow",
            };
            const expectedReturnTargets = {
              "source-amp": "amp",
              "source-pedal": "pre",
              "source-ir": "cab",
              "source-fx": "post",
            };
            const expectedBreadcrumbTokens = {
              "source-amp": ["AMP / Capture Library", "TONE3000 NAM"],
              "source-pedal": ["PEDALS / Capture Library", "TONE3000 NAM Pedals"],
              "source-ir": ["CAB / IR Library", "IR Sources"],
              "source-fx": ["Effect Preset Library", "OpenStudio FX Collection"],
            };
            const flow = item.checks.sourceFlow || {};
            const breadcrumbTokens = expectedBreadcrumbTokens[sourceScenarioKey] || [];
            const activeTargets = flow.targets?.filter((target) => target.active).map((target) => target.slot) || [];
            const allowedPedalCategories = ["drive", "boost", "fuzz", "distortion", "overdrive"];
            const expectedFxCategory = scenario.params?.namSourceFilter || "";
            const compactSourceLayout = Number(item.checks.viewport?.width || 0) <= 960;
            const sourceFlowDesignAssetsReady = (flow.assetLoadFailures || []).length === 0
              && (flow.imageCount >= 1 || (compactSourceLayout && flow.selectedAvailable !== true))
              && (flow.heroImageReady === true || (compactSourceLayout && (flow.rowImagesReady === true || flow.selectedAvailable !== true)))
              && flow.heroImageContained === true
              && flow.rowImagesReady === true;
            const hasExpectedTarget = sourceScenarioKey === "source-amp"
              ? activeTargets.includes("amp")
              : sourceScenarioKey === "source-pedal"
              ? activeTargets.includes("pedal")
              : sourceScenarioKey === "source-ir"
              ? activeTargets.includes("cab")
              : activeTargets.includes(expectedFxCategory || "delay");
            const pedalRowsSupported = sourceScenarioKey !== "source-pedal"
              || (flow.rowCategories || []).every((category) => allowedPedalCategories.includes(category));
            const expectedFilterLabels = {
              "source-amp": ["Amp + Cab", "Amp Head", "Full Rig", "Local .nam", "A1", "A2"],
              "source-pedal": ["Drive", "Boost", "Fuzz", "Distortion", "Overdrive", "Local .nam"],
              "source-ir": ["TONE3000 Cabinet IR", "Local IR File"],
              "source-fx": ["EQ", "Mod", "Delay", "Reverb"],
            }[sourceScenarioKey] || [];
            const expectedSelectLabels = {
              "source-amp": ["Capture type", "Sort Capture Library"],
              "source-pedal": ["Capture type", "Sort Capture Library"],
              "source-ir": ["IR type", "Sort IR Library"],
              "source-fx": ["Effect Preset type", "Sort Effect Preset Library"],
            }[sourceScenarioKey] || [];
            const sourceFilterControlsReady = expectedFilterLabels.every((label) => (flow.filters || []).includes(label))
              && (flow.selects || []).length === 2
              && (flow.selects || []).every((select) => select.visible === true && select.options.length > 0)
              && expectedSelectLabels.every((label) => (flow.selects || []).some((select) => select.label === label));
            const irSourcesReady = sourceScenarioKey !== "source-ir"
              || scenario.name === "source-ir-local"
              || scenario.name === "source-ir-space"
              || flow.hasCabinetIR === true;
            const localIRLaneReady = scenario.name !== "source-ir-local"
              || (
                (flow.filters || []).includes("Local IR File")
                && (flow.filterControls || []).some((filter) => filter.id === "local-ir" && filter.active === true)
                && flow.emptyStateVisible === true
              );
            const fxRowsReady = sourceScenarioKey !== "source-fx"
              || (expectedFxCategory && ["mod", "delay", "reverb"].includes(expectedFxCategory)
                ? (
                  (flow.rowSources || []).includes("openstudio")
                  && (flow.rowCategories || []).length === 1
                  && (flow.rowCategories || [])[0] === expectedFxCategory
                  && (flow.actions || []).some((label) => /Apply Preset/i.test(label))
                )
                : (
                (flow.rowSources || []).includes("openstudio")
                && ["eq", "mod", "delay", "reverb"].every((category) => (flow.rowCategories || []).includes(category))
                && (flow.actions || []).some((label) => /Apply Preset/i.test(label))
              ));
            const expectedDetailTitle = sourceScenarioKey === "source-fx"
              ? "Selected preset - Post FX"
              : sourceScenarioKey === "source-ir"
              ? "Selected cabinet IR"
              : sourceScenarioKey === "source-pedal"
              ? "Selected capture - Pedal slot"
              : "Selected capture - Amp slot";
            const expectedDetailSubtitle = sourceScenarioKey === "source-fx"
              ? "OpenStudio FX Collection"
              : "";
            const selectedVisibleActions = sourceScenarioKey === "source-fx"
              ? ["Preview Preset", "Apply Preset"]
              : sourceScenarioKey === "source-ir"
              ? ["Preview IR", "Use IR"]
              : ["Audition", "Use Capture"];
            const expectedVisibleActions = flow.selectedAvailable === true ? selectedVisibleActions : [];
            const allowedVisibleActions = [...expectedVisibleActions, "Cancel Preview"];
            const visibleActionsReady = (
              (flow.visibleActions || []).length >= expectedVisibleActions.length
              && expectedVisibleActions.every((expectedAction) => (
                flow.visibleActions || []
              ).some((label) => String(label).includes(expectedAction)))
              && (flow.visibleActions || []).every((label) => (
                allowedVisibleActions.some((allowed) => String(label).includes(allowed))
              ))
            );
            const sourceFiltersReady = !["Special FX", "Glitch", "Doubler"].some((label) => (flow.filters || []).includes(label))
              && (flow.forbiddenText || []).length === 0
              && (sourceScenarioKey !== "source-pedal" || !["A1", "A2"].some((label) => (flow.filters || []).includes(label)));
            const sourceDetailReady = flow.selectedAvailable !== true
              ? flow.emptyStateVisible === true
                && String(flow.detailTitle || "").length > 0
                && String(flow.detailSubtitle || "").length > 0
              : flow.detailTitle === expectedDetailTitle
                && String(flow.detailName || "").length > 0
                && String(flow.detailSubtitle || "").length > 0
                && (!expectedDetailSubtitle || String(flow.detailSubtitle || "").includes(expectedDetailSubtitle));
            const emptyStateReady = scenario.name !== "source-amp-empty" || flow.emptyStateVisible === true;
            const paginationReady = (flow.resultRowCount || 0) <= 12
              && (scenario.name !== "source-amp"
                && scenario.name !== "source-amp-selected"
                || flow.paginationVisible === true);
            item.pass = Boolean(item.checks.productVisible)
              && item.checks.hasReferenceWindowChrome === true
              && item.checks.iframeCount === 0
              && item.checks.rootScrollbar === false
              && (item.checks.activeForbiddenTerms || []).length === 0
              && flow.visible === true
              && flow.frameVisible === true
              && flow.ready === true
              && flow.frameWindowFill === true
              && flow.shellViewportFill === true
              && flow.shellAspectSafe === true
              && flow.designBoard === expectedSourceBoards[sourceScenarioKey]
              && flow.legacyExplorerVisible === false
              && flow.mode === expectedSourceModes[sourceScenarioKey]
              && flow.returnTarget === expectedReturnTargets[sourceScenarioKey]
              && breadcrumbTokens.every((token) => String(flow.breadcrumb || "").includes(token))
              && flow.boundedWidth === true
              && flow.forbiddenText?.length === 0
              && flow.unsupportedTone3000FXRows?.length === 0
              && flow.unsupportedPedalRows?.length === 0
              && flow.genericFiltersVisible === false
              && (flow.clippedActions || []).length === 0
              && (flow.layoutOverlaps || []).length === 0
              && (flow.textOverflowFailures || []).length === 0
              && (flow.fontFloorFailures || []).length === 0
              && sourceFlowDesignAssetsReady
              && sourceDetailReady
              && hasExpectedTarget
              && visibleActionsReady
              && pedalRowsSupported
              && sourceFilterControlsReady
              && irSourcesReady
              && localIRLaneReady
              && fxRowsReady
              && sourceFiltersReady
              && emptyStateReady
              && paginationReady;
            if (scenario.name === "source-amp-audition-click") {
              item.pass = item.pass && item.interaction?.stable === true;
            }
          } else if (isRackMainScenario(scenario.name)) {
            const expectedRackSize = scenario.params.namRackSize ? String(scenario.params.namRackSize) : "";
            const rackMain = item.checks.rackMain || {};
            const tunerStageOverlay = scenario.name === "rack-tuner";
            item.pass = Boolean(item.checks.productVisible)
              && item.checks.iframeCount === 0
              && (tunerStageOverlay || rackMain.designPortReady === true)
              && rackMain.designBoard === rackMain.expectedDesignBoard
              && rackMain.designSection === rackMain.section
              && rackMain.productWindowFill === true
              && rackMain.frameWindowFill === true
              && rackMain.shellViewportFill === true
              && rackMain.shellAspectSafe === true
              && (tunerStageOverlay || rackMain.deviceCount === (rackMain.section === "post" ? 3 : rackMain.section === "pre" ? 5 : 1))
              && item.checks.rootScrollbar === false
              && item.checks.forbiddenNormalWords.length === 0
              && (item.checks.activeForbiddenTerms || []).length === 0
              && item.checks.rawWords.length === 0
              && (tunerStageOverlay || rackMain.generatedBodyAssetReady === true)
              && rackMain.generatedControlAssetReady === true
              && (rackMain.assetLoadFailures || []).length === 0
              && (rackMain.forbiddenVisibleTerms || []).length === 0
              && (rackMain.deviceClipFailures || []).length === 0
              && (rackMain.sceneOverflowFailures || []).length === 0
              && (tunerStageOverlay || (rackMain.placementFailures || []).length === 0)
              && (rackMain.moduleAspectFailures || []).length === 0
              && (rackMain.subjectContainmentFailures || []).length === 0
              && (rackMain.textOverflowFailures || []).length === 0
              && (rackMain.fontFloorFailures || []).length === 0
              && (rackMain.headerGeometryFailures || []).length === 0
              && (rackMain.pedalHardwareConsistencyFailures || []).length === 0
              && (rackMain.section !== "post" || rackMain.reverbFixedControls?.ready === true)
              && (rackMain.section !== "post" || (
                (rackMain.postKnobLabelGapFailures || []).length === 0
                && (rackMain.postVisibleControlContainmentFailures || []).length === 0
                && (rackMain.postPrimaryHardwareFailures || []).length === 0
              ))
              && (rackMain.section !== "eq" || (
                (rackMain.eqFaderParamIds || []).length === 9
                && (rackMain.eqFilterParamIds || []).length === 2
                && rackMain.eqFilterParamIds.includes("eqHPFHz")
                && rackMain.eqFilterParamIds.includes("eqLPFHz")
                && (rackMain.eqUtilityParamIds || []).length === 3
                && rackMain.eqUtilityParamIds.includes("eqHPFHz")
                && rackMain.eqUtilityParamIds.includes("eqLevelDb")
                && rackMain.eqUtilityParamIds.includes("eqLPFHz")
                && rackMain.eqFilterCapCount === 2
                && (rackMain.eqFilterCapFailures || []).length === 0
                && (rackMain.eqFilterLayoutFailures || []).length === 0
              ))
              && (scenario.name !== "rack-tuner" || (
                item.checks.tunerButtonEnabled === true
                && item.checks.hasTunerPanel === true
                && item.checks.tunerHasPitchReadout === true
              ))
              && (scenario.name !== "rack-calibration" || (
                item.checks.hasCalibrationDrawer === true
                && item.checks.calibration?.ready === true
              ))
              // The footer now presents semantic rack-size names (for example
              // "Small") while the stored/runtime value remains numeric.  The
              // numeric readback is the authoritative contract for a requested
              // harness size; requiring the old "100%" label made every valid
              // responsive capture fail after the copy was improved.
              && (!expectedRackSize || rackMain.size === expectedRackSize)
              && (scenario.name !== "rack-neural-size-menu" || (
                rackMain.sizeControlVisible === true
                && item.interaction?.pass === true
              ));
          } else if (scenario.name === "rack-chain") {
            item.pass = Boolean(item.checks.productVisible)
              && item.checks.hasReferenceWindowChrome === true
              && item.checks.rootScrollbar === false
              && item.checks.moduleCount >= 17
              && item.checks.hasCompactChainLane === true
              && item.checks.forbiddenNormalWords.length === 0
              && item.checks.rawWords.length === 0
              && item.interaction?.changed === true
              && item.interaction?.lowerCardClick?.chainClosed === true
              && item.interaction?.lowerCardClick?.advancedOpened === true
              && item.interaction?.lowerCardClick?.focusedStage === "mod"
              && item.interaction?.lowerCardClick?.chainReopened === true;
          } else {
            const modalScenario = scenario.name === "save-tone-modal" || scenario.name === "preset-manager" || scenario.name === "preset-export-dialog";
            const overlayScenario = modalScenario || scenario.name === "rack-slot-browser";
            const advancedScenario = scenario.name === "mixer" || scenario.name === "advanced-alias";
            item.pass = Boolean(item.checks.productVisible)
              && item.checks.hasReferenceWindowChrome === true
              && (overlayScenario || advancedScenario || item.checks.hasReferenceHeaderMeters === true)
              && (overlayScenario || advancedScenario || item.checks.headerMetersResponsive === true)
              && (overlayScenario || (!scenario.name.startsWith("rack") && scenario.name !== "preset-manager" ? true : item.checks.moduleCount >= 8))
              && item.checks.forbiddenNormalWords.length === 0
              && item.checks.rawWords.length === 0
              && (scenario.name !== "rack-chain" || (
                item.interaction?.changed === true
                && item.interaction?.lowerCardClick?.chainClosed === true
                && item.interaction?.lowerCardClick?.advancedOpened === true
                && item.interaction?.lowerCardClick?.focusedStage === "mod"
                && item.interaction?.lowerCardClick?.chainReopened === true
              ))
              && (!scenario.name.startsWith("rack") || item.checks.rootScrollbar === false)
              && (!scenario.name.startsWith("rack") || overlayScenario || item.checks.hasCompactChainLane === true)
              && (scenario.name !== "rack-slot-browser" || item.checks.hasSlotBrowser === true)
              && (scenario.name !== "rack-tuner" || (
                item.checks.tunerButtonEnabled === true
                && item.checks.hasTunerPanel === true
                && item.checks.tunerHasPitchReadout === true
              ))
              && (!["mixer", "advanced-alias"].includes(scenario.name) || (
                item.checks.hasRackMixer === true
                && item.checks.mixerReadable === true
                && item.checks.hasAdvanced === false
                && item.checks.mixerBackVisible === true
                && item.checks.mixerViewportFill === true
              ))
              && (scenario.name !== "mixer" || item.checks.mixerReverbGroupsReady === true)
              && (!scenario.name.startsWith("browse") || item.checks.hasBrowseHero === true)
              && (scenario.name !== "save-tone-modal" || (
                item.checks.hasSaveToneModal === true
                && item.checks.saveToneFormReadable === true
                && item.checks.saveToneFooterButtons?.includes('Cancel')
                && item.checks.saveToneFooterButtons?.includes('Save Tone')
              ))
              && (scenario.name !== "preset-manager" || (
                item.checks.hasPresetManager === true
                && item.checks.presetManagerMetrics?.visible === true
                && item.checks.presetManagerMetrics?.inViewport === true
                && item.checks.hasPresetTransfer === true
              ))
              && (scenario.name !== "preset-export-dialog" || (
                item.checks.hasNAMRackPrompt === true
                && item.checks.namRackPromptButtons?.includes('Cancel')
                && item.checks.namRackPromptButtons?.includes('Choose location')
              ));
          }
        } catch (error) {
          item.pass = false;
          item.error = error instanceof Error ? error.message : String(error);
        } finally {
          cdp.close();
        }
        if (!item.pass) report.failures.push(item);
        report.scenarios.push(item);
      }
    }
  } finally {
    if (browser && !args.keepBrowser) {
      await terminateProcessTree(browser);
      if (browser.__profile) {
        await rm(browser.__profile, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (vite && !args.keepServer) await terminateProcessTree(vite);
  }

  await writeFile(args.report, JSON.stringify(report, null, 2));
  if (report.failures.length > 0) {
    console.error(`NAM Rack visual harness failed ${report.failures.length} scenario(s). Report: ${args.report}`);
    process.exit(1);
  }
  console.log(`NAM Rack visual harness passed. Report: ${args.report}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
