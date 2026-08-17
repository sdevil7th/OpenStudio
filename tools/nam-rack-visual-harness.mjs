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
  { name: "rack-sort-open", params: { namView: "rack", namFocus: "amp" } },
  { name: "rack-cab", params: { namView: "rack", namFocus: "cab" } },
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
  { name: "rack-saved", params: { namView: "rack", namFocus: "amp" } },
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

async function openRightRailTab(cdp, label) {
  await evaluate(cdp, `
    (() => {
      const tab = Array.from(document.querySelectorAll('.nam-rail-tabs button'))
        .find((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(label)}));
      tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      tab?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      tab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(tab);
    })()
  `);
  await sleep(180);
}

async function openRailSortMenu(cdp) {
  await evaluate(cdp, `
    (() => {
      const trigger = document.querySelector('[data-qa="nam-rail-sort-trigger"]');
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(160);
}

async function openTunerRail(cdp) {
  await evaluate(cdp, `
    (() => {
      const premiumTuner = Array.from(document.querySelectorAll('[data-qa="nam-premium-tuner"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      const tuner = premiumTuner || Array.from(document.querySelectorAll('.nam-mode-rail-nav button'))
        .find((el) => (el.textContent || '').includes('Tuner'));
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

async function openFooterSizeMenu(cdp) {
  await evaluate(cdp, `
    (() => {
      const trigger = document.querySelector('[data-qa="nam-footer-size"]');
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Boolean(trigger);
    })()
  `);
  await sleep(160);
}

async function runInstrumentProfileProbe(cdp, outDir, viewportName) {
  const result = await evaluate(cdp, `(() => {
    const root = document.querySelector('[data-param-id="instrumentProfile"]');
    const buttons = Array.from(root?.querySelectorAll('button') || []);
    const bass = buttons.find((button) => (button.textContent || '').trim() === 'Bass');
    if (!bass) return { pass: false, reason: 'Bass control missing' };
    bass.click();
    const read = () => ({
      labels: buttons.map((button) => (button.textContent || '').trim()),
      pressed: buttons.map((button) => button.getAttribute('aria-pressed')),
      active: buttons.map((button) => button.getAttribute('data-active')),
      rootRect: (() => { const r = root.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(read()))));
  })()`);
  const value = result?.result?.value ?? result?.value ?? result;
  await screenshot(cdp, path.join(outDir, `nam-instrument-bass-${viewportName}.png`));
  const bounds = value?.rootRect;
  const pass = Array.isArray(value?.pressed)
    && value.pressed[0] === 'false'
    && value.pressed[1] === 'true'
    && value.active[0] === 'false'
    && value.active[1] === 'true'
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
  // ring. Pointer capture must retain the drag, snap to 120 Hz, and suppress
  // the synthetic release click that would otherwise advance to 240 Hz.
  await dispatchVerticalMouseDrag(cdp, center(), -50);
  const dragSample = await readThreePositionSelector(cdp, moduleName, paramId, readoutSelector);
  await screenshot(cdp, path.join(outDir, `nam-compressor-hpf-drag-1-${viewportName}.png`));

  const expectedTexts = ['HPFOFF', 'HPF120', 'HPF240'];
  const clickPass = samples.every((sample, index) => threePositionSelectorSamplePass(sample, index, expectedTexts[index]));
  const dragPass = threePositionSelectorSamplePass(dragSample, 1, 'HPF120');
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
  const expectedNeuralSection = scenarioName === "rack-neural-size-menu"
    ? "post"
    : scenarioName.startsWith("rack-neural-")
    ? scenarioName.replace("rack-neural-", "")
    : "post";
  return evaluate(cdp, `
    (() => {
      const scenarioName = ${JSON.stringify(scenarioName)};
      const expectedNeuralSection = ${JSON.stringify(expectedNeuralSection)};
      const expectedNeuralModulesBySection = {
        pre: ['pre-compressor-design-a', 'pre-tape-echo-design-a', 'pre-dual-octaver-design-a', 'pedal', 'pre-chaos-design-a'],
        amp: ['amp'],
        cab: ['cab'],
        eq: ['eq'],
        post: ['mod', 'delay', 'reverb'],
      };
      const expectedNeuralModules = expectedNeuralModulesBySection[expectedNeuralSection] || ['mod', 'delay', 'reverb'];
      const expectedNeuralDeviceCount = expectedNeuralModules.length;
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
      const productStyle = product ? window.getComputedStyle(product) : null;
      const cssToken = (name) => (productStyle?.getPropertyValue(name) || '').trim();
      const cssNumberToken = (name) => {
        const value = Number.parseFloat(cssToken(name));
        return Number.isFinite(value) ? value : 0;
      };
      const rackFinalParityTokens = {
        accent: cssToken('--nam-ref-accent'),
        accentSoft: cssToken('--nam-ref-accent-soft'),
        stageAspect: cssNumberToken('--nam-ref-stage-aspect'),
        stageGap: cssNumberToken('--nam-ref-stage-gap'),
        stageFooterHeight: cssNumberToken('--nam-ref-stage-footer-height'),
        stageFooterCompactHeight: cssNumberToken('--nam-ref-stage-footer-compact-height'),
        explorerMin: cssNumberToken('--nam-ref-explorer-min'),
        explorerMax: cssNumberToken('--nam-ref-explorer-max'),
        explorerLaptop: cssNumberToken('--nam-ref-explorer-laptop'),
        explorerCompactMin: cssNumberToken('--nam-ref-explorer-compact-min'),
        explorerCompactMax: cssNumberToken('--nam-ref-explorer-compact-max'),
        modeRailDesktop: cssNumberToken('--nam-ref-mode-rail-desktop'),
        modeRailLaptop: cssNumberToken('--nam-ref-mode-rail-laptop'),
        modeRailCompact: cssNumberToken('--nam-ref-mode-rail-compact'),
      };
      rackFinalParityTokens.ready = Boolean(
        rackFinalParityTokens.accent === '#f5ae27'
        && rackFinalParityTokens.accentSoft === '#f5c86a'
        && Math.abs(rackFinalParityTokens.stageAspect - 1.7778958555) < 0.0001
        && rackFinalParityTokens.stageGap === 8
        && rackFinalParityTokens.stageFooterHeight === 46
        && rackFinalParityTokens.stageFooterCompactHeight === 42
        && rackFinalParityTokens.explorerMax === 340
        && rackFinalParityTokens.explorerLaptop === 316
        && rackFinalParityTokens.modeRailDesktop === 78
        && rackFinalParityTokens.modeRailLaptop === 70
        && rackFinalParityTokens.modeRailCompact === 58
      );
      const rackVisualPolishTokens = {
        pass: cssNumberToken('--nam-ref-polish-pass'),
        stageBorderAlpha: cssNumberToken('--nam-ref-stage-border-alpha'),
        railCardRadius: cssNumberToken('--nam-ref-rail-card-radius'),
        railCardMinHeight: cssNumberToken('--nam-ref-rail-card-min-height'),
        artContrast: cssNumberToken('--nam-ref-art-contrast'),
      };
      rackVisualPolishTokens.ready = Boolean(
        rackVisualPolishTokens.pass === 9
        && rackVisualPolishTokens.stageBorderAlpha >= 0.1
        && rackVisualPolishTokens.stageBorderAlpha <= 0.16
        && rackVisualPolishTokens.railCardRadius === 5
        && rackVisualPolishTokens.railCardMinHeight === 93
        && rackVisualPolishTokens.artContrast >= 1.15
      );
      const hardwareDialTokens = {
        pass: cssNumberToken('--nam-ref-hardware-dial-pass'),
        grips: cssNumberToken('--nam-ref-hardware-dial-grips'),
        numberCount: cssNumberToken('--nam-ref-hardware-dial-number-count'),
        trackAlpha: cssNumberToken('--nam-ref-hardware-dial-track-alpha'),
      };
      hardwareDialTokens.ready = Boolean(
        hardwareDialTokens.pass === 13
        && hardwareDialTokens.grips === 36
        && hardwareDialTokens.numberCount === 11
        && hardwareDialTokens.trackAlpha > 0
        && hardwareDialTokens.trackAlpha < 0.08
      );
      const railArtTokens = {
        pass: cssNumberToken('--nam-ref-rail-art-pass'),
        brightness: cssNumberToken('--nam-ref-rail-art-brightness'),
        width: cssNumberToken('--nam-ref-rail-art-width'),
      };
      railArtTokens.ready = Boolean(
        railArtTokens.pass === 11
        && railArtTokens.brightness >= 1.1
        && railArtTokens.width >= 64
        && railArtTokens.width <= 78
      );
      const stageFillTokens = {
        pass: cssNumberToken('--nam-ref-stage-fill-pass'),
        bleed: cssNumberToken('--nam-ref-stage-frame-bleed'),
        topOffset: cssNumberToken('--nam-ref-stage-frame-top-offset'),
      };
      stageFillTokens.ready = Boolean(
        stageFillTokens.pass >= 14
        && stageFillTokens.bleed >= (window.innerWidth < 1100 ? 24 : 48)
        && stageFillTokens.bleed <= (window.innerWidth < 1100 ? 112 : 88)
        && stageFillTokens.topOffset >= (window.innerWidth < 1100 ? 8 : 14)
        && stageFillTokens.topOffset <= (window.innerWidth < 1100 ? 22 : 30)
      );
      const stageArtTokens = {
        pass: cssNumberToken('--nam-ref-stage-art-pass'),
        brightness: cssNumberToken('--nam-ref-stage-art-brightness'),
        headOverlay: cssNumberToken('--nam-ref-stage-head-overlay-opacity'),
        cabOverlay: cssNumberToken('--nam-ref-stage-cab-overlay-opacity'),
      };
      stageArtTokens.ready = Boolean(
        stageArtTokens.pass >= 15
        && stageArtTokens.brightness >= 0.92
        && stageArtTokens.brightness <= 1.08
        && stageArtTokens.headOverlay >= 0.58
        && stageArtTokens.headOverlay <= 0.78
        && stageArtTokens.cabOverlay >= 0.62
        && stageArtTokens.cabOverlay <= 0.82
      );
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
      const ampFrame = document.querySelector('[data-qa="nam-amp-image-space"]');
      const splitArtStack = document.querySelector('.nam-rack-art-stack');
      const splitArtHead = document.querySelector('.nam-rack-art-head');
      const splitArtCab = document.querySelector('.nam-rack-art-cab');
      const toggle = document.querySelector('[data-qa="nam-physical-toggle"]');
      const ampKnobs = Array.from(document.querySelectorAll('[data-qa="nam-faceplate-knob"]'));
      const sceneRegions = Array.from(document.querySelectorAll('.nam-hardware-scene [data-scene-region]'))
        .map((el) => el.getAttribute('data-scene-region') || '')
        .filter(Boolean);
      const sceneAnchors = Array.from(document.querySelectorAll('.nam-hardware-scene [data-scene-anchor]'))
        .map((el) => el.getAttribute('data-scene-anchor') || '')
        .filter(Boolean);
      const ampKnobScaleMarks = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-rack-knob-scale i'));
      const ampHardwareDials = Array.from(document.querySelectorAll('.nam-amp-knobs [data-qa="nam-hardware-dial"]'));
      const ampHardwareDialNumbers = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-number'));
      const ampHardwareDialTicks = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-tick'));
      const ampHardwareDialScaleTracks = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-scale-track'));
      const ampHardwareDialOuterRims = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-outer-rim'));
      const ampHardwareDialGrips = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-grip'));
      const ampHardwareDialCapHighlights = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-cap-highlight'));
      const ampHardwareDialIndicatorShadows = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-indicator-shadow'));
      const ampHardwareDialIndicatorTips = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-hardware-dial-indicator-tip'));
      const ampKnobLabels = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-rack-knob-label'));
      const ampKnobValueReadouts = Array.from(document.querySelectorAll('.nam-amp-knobs .nam-rack-control strong'));
      const chain = document.querySelector('.nam-compact-chain');
      const stageHero = document.querySelector('.nam-stage-hero');
      const stageFooter = document.querySelector('[data-qa="nam-stage-footer"]');
      const stageHeader = document.querySelector('.nam-stage-hero-head');
      const ampTopline = document.querySelector('.nam-amp-topline');
      const rightRail = document.querySelector('.nam-rack-right-rail');
      const modeRail = document.querySelector('.nam-rack-mode-rail');
      const modeRailNav = document.querySelector('[data-qa="nam-mode-rail-nav"]');
      const modeRailStatus = document.querySelector('.nam-mode-rail-status');
      const stageFooterLeft = document.querySelector('[data-qa="nam-stage-footer-left"]');
      const stageFooterRight = document.querySelector('[data-qa="nam-stage-footer-right"]');
      const railSortLabel = document.querySelector('.nam-explorer[data-variant="rail"] .nam-sort-control span');
      const railSortTrigger = document.querySelector('[data-qa="nam-rail-sort-trigger"]');
      const railSortNativeSelect = document.querySelector('.nam-explorer[data-variant="rail"] .nam-sort-control select');
      const railSortPopover = document.querySelector('.nam-sort-menu-popover');
      const railViewToggle = document.querySelector('.nam-explorer[data-variant="rail"] .nam-rail-view-toggle');
      const railViewToggleButtons = Array.from(document.querySelectorAll('.nam-explorer[data-variant="rail"] .nam-rail-view-toggle button'));
      const headerLibraryCta = document.querySelector('.nam-product[data-view="rack"] .nam-product-topbar .nam-library-cta');
      const headerPresetManagerAction = document.querySelector('[data-qa="nam-header-preset-manager"]');
      const headerUtilityButtonEls = {
        undo: document.querySelector('[data-qa="nam-header-undo"]'),
        redo: document.querySelector('[data-qa="nam-header-redo"]'),
        more: document.querySelector('[data-qa="nam-header-more"]'),
      };
      const modeRailIconClasses = Object.fromEntries(Array.from(document.querySelectorAll('.nam-mode-rail-nav button')).map((el) => [
        ((el.textContent || '').replace(/\s+/g, ' ').trim()),
        (el.querySelector('svg')?.getAttribute('class') || ''),
      ]));
      const farTunerButton = document.querySelector('[data-qa="nam-premium-tuner"]')
        || Array.from(document.querySelectorAll('.nam-mode-rail-nav button')).find((el) => (el.textContent || '').includes('Tuner'));
      const railLivePager = document.querySelector('.nam-explorer[data-variant="rail"] .nam-live-pager-footer');
      const railLivePagerText = (railLivePager?.textContent || '').replace(/\s+/g, ' ').trim();
      const railResultCards = Array.from(document.querySelectorAll('.nam-explorer[data-variant="rail"] .nam-result-card[data-view="list"]'));
      const railNewTags = Array.from(document.querySelectorAll('.nam-explorer[data-variant="rail"] .nam-rail-new-tag'));
      const railFeedback = document.querySelector('.nam-explorer[data-variant="rail"] .nam-feedback');
      const railLibrarySummary = document.querySelector('.nam-explorer[data-variant="rail"] .nam-library-summary');
      const cabRail = document.querySelector('[data-qa="nam-rail-cab"]');
      const savedRail = document.querySelector('[data-qa="nam-rail-saved"]');
      const chainDragOverlay = document.querySelector('[data-qa="nam-chain-drag-overlay"]');
      const rackMixer = document.querySelector('[data-qa="nam-rack-mixer"]');
      const fxHardware = document.querySelector('.nam-fx-hardware');
      const fxFaceplate = document.querySelector('.nam-fx-faceplate');
      const fxFaceplateArt = document.querySelector('.nam-fx-faceplate-art');
      const fxKnobDeck = document.querySelector('.nam-fx-knob-deck');
      const fxKnobs = Array.from(document.querySelectorAll('.nam-fx-knob-deck .nam-rack-control-knob'));
      const fxFootswitch = document.querySelector('.nam-fx-faceplate > .nam-pedal-footswitch');
      const hardwareNameplates = Array.from(document.querySelectorAll('.nam-hardware-nameplate'));
      const legacyAmpBadges = document.querySelector('.nam-amp-badges');
      const selectedChainModule = document.querySelector('.nam-product[data-view="rack"] .nam-compact-chain-node[data-qa="nam-compact-chain-node-delay"]');
      const chainSlotActions = Array.from(document.querySelectorAll('.nam-product[data-view="rack"] .nam-compact-chain-order'));
      const ampFrameRect = ampFrame?.getBoundingClientRect();
      const chainRect = chain?.getBoundingClientRect();
      const stageHeroRect = stageHero?.getBoundingClientRect();
      const stageFooterRect = stageFooter?.getBoundingClientRect();
      const stageFooterLeftRect = stageFooterLeft?.getBoundingClientRect();
      const stageFooterRightRect = stageFooterRight?.getBoundingClientRect();
      const rightRailRect = rightRail?.getBoundingClientRect();
      const modeRailRect = modeRail?.getBoundingClientRect();
      const modeRailNavRect = modeRailNav?.getBoundingClientRect();
      const modeRailStatusRect = modeRailStatus?.getBoundingClientRect();
      const railLivePagerRect = railLivePager?.getBoundingClientRect();
      const visibleBox = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      };
      const neuralProduct = product?.classList.contains('nam-neural-product') ? product : null;
      const neuralSectionRail = document.querySelector('.nam-neural-section-rail');
      const neuralGlobalStrip = document.querySelector('.nam-neural-global-strip');
      const neuralPostSuite = document.querySelector('.nam-neural-post-suite');
      const neuralSectionSuite = document.querySelector('.nam-neural-section-suite');
      const neuralPresetHub = document.querySelector('.nam-neural-preset-hub');
      const neuralLegacyTopbar = product?.querySelector(':scope > .nam-product-topbar');
      const neuralLegacyChain = product?.querySelector(':scope > .nam-chain');
      const neuralDevices = Array.from(document.querySelectorAll('.nam-neural-device'));
      const neuralAnchors = Array.from(document.querySelectorAll(
        '.nam-neural-control-anchor, .nam-neural-decorative-switch-anchor, .nam-neural-anchor-button, .nam-neural-footswitch-anchor, .nam-neural-device-display[data-anchored="true"], .nam-neural-delay-display[data-anchored="true"], .nam-neural-label-anchor, .nam-neural-mic-anchor, .nam-neural-meter-anchor'
      ));
      const neuralSceneControls = Array.from(document.querySelectorAll('.nam-scene-control-visual[data-scene-control="true"]'));
      const neuralSceneMetrics = neuralSceneControls.map((control) => {
        const svg = control.closest('svg.nam-scene-device-svg');
        const controlRect = control.getBoundingClientRect();
        const svgRect = svg?.getBoundingClientRect();
        const artboardWidth = Number(control.getAttribute('data-artboard-width') || 0);
        const artboardHeight = Number(control.getAttribute('data-artboard-height') || 0);
        const expectedX = Number(control.getAttribute('data-expected-x') || 0);
        const expectedY = Number(control.getAttribute('data-expected-y') || 0);
        const expectedWidth = Number(control.getAttribute('data-expected-width') || 0);
        const expectedHeight = Number(control.getAttribute('data-expected-height') || 0);
        const expectedDiameter = Number(control.getAttribute('data-expected-diameter') || 0);
        const kind = control.getAttribute('data-kind') || '';
        if (!svgRect || artboardWidth <= 0 || artboardHeight <= 0) {
          return {
            id: control.getAttribute('data-anchor-id') || '',
            kind,
            centerDelta: 999,
            diameterRatioDelta: 999,
            sizeRatioDelta: 999,
            visible: visibleBox(control),
            framed: false,
          };
        }
        const preserveAspectRatio = svg?.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
        const fillsViewBox = preserveAspectRatio === 'none';
        const scaleX = svgRect.width / artboardWidth;
        const scaleY = svgRect.height / artboardHeight;
        const scale = fillsViewBox ? 1 : Math.min(scaleX, scaleY);
        const effectiveScaleX = fillsViewBox ? scaleX : scale;
        const effectiveScaleY = fillsViewBox ? scaleY : scale;
        const offsetX = fillsViewBox ? 0 : (svgRect.width - artboardWidth * scale) / 2;
        const offsetY = fillsViewBox ? 0 : (svgRect.height - artboardHeight * scale) / 2;
        const expectedCenterX = svgRect.left + offsetX + expectedX * effectiveScaleX;
        const expectedCenterY = svgRect.top + offsetY + expectedY * effectiveScaleY;
        const actualCenterX = controlRect.left + controlRect.width / 2;
        const actualCenterY = controlRect.top + controlRect.height / 2;
        const centerDelta = Math.hypot(actualCenterX - expectedCenterX, actualCenterY - expectedCenterY);
        const checksDiameter = kind === 'knob' || kind === 'footswitch' || kind === 'led';
        const expectedPixelDiameterX = expectedDiameter * effectiveScaleX;
        const expectedPixelDiameterY = expectedDiameter * effectiveScaleY;
        const diameterWidthRatioDelta = checksDiameter && expectedPixelDiameterX > 0
          ? Math.abs(controlRect.width - expectedPixelDiameterX) / expectedPixelDiameterX
          : 0;
        const diameterHeightRatioDelta = checksDiameter && expectedPixelDiameterY > 0
          ? Math.abs(controlRect.height - expectedPixelDiameterY) / expectedPixelDiameterY
          : 0;
        const diameterRatioDelta = checksDiameter && expectedPixelDiameterX > 0 && expectedPixelDiameterY > 0
          ? Math.max(diameterWidthRatioDelta, diameterHeightRatioDelta)
          : 0;
        const expectedPixelWidth = expectedWidth * effectiveScaleX;
        const expectedPixelHeight = expectedHeight * effectiveScaleY;
        const widthRatioDelta = expectedPixelWidth > 0 ? Math.abs(controlRect.width - expectedPixelWidth) / expectedPixelWidth : 0;
        const heightRatioDelta = expectedPixelHeight > 0 ? Math.abs(controlRect.height - expectedPixelHeight) / expectedPixelHeight : 0;
        const sizeRatioDelta = checksDiameter ? 0 : Math.max(widthRatioDelta, heightRatioDelta);
        const footerLimit = stageFooterRect ? stageFooterRect.top - 8 : window.innerHeight - 8;
        const stageTopLimit = stageHeroRect ? stageHeroRect.top - 12 : 0;
        const framed = controlRect.left >= -2
          && controlRect.top >= stageTopLimit
          && controlRect.right <= window.innerWidth + 2
          && controlRect.bottom <= footerLimit;
        return {
          id: control.getAttribute('data-anchor-id') || '',
          param: control.getAttribute('data-param') || '',
          kind,
          centerDelta: Number(centerDelta.toFixed(2)),
          diameterRatioDelta: Number(diameterRatioDelta.toFixed(4)),
          sizeRatioDelta: Number(sizeRatioDelta.toFixed(4)),
          visible: visibleBox(control),
          framed,
        };
      });
      const neuralSceneCenterMaxDelta = neuralSceneMetrics.length
        ? Math.max(...neuralSceneMetrics.map((item) => item.centerDelta))
        : 999;
      const neuralSceneDiameterMaxRatioDelta = neuralSceneMetrics.length
        ? Math.max(...neuralSceneMetrics.map((item) => item.diameterRatioDelta))
        : 999;
      const neuralSceneSizeMaxRatioDelta = neuralSceneMetrics.length
        ? Math.max(...neuralSceneMetrics.map((item) => item.sizeRatioDelta))
        : 999;
      const neuralSceneControlsAligned = neuralSceneMetrics.length > 0
        && neuralSceneMetrics.every((item) => item.visible && item.centerDelta <= 2 && item.diameterRatioDelta <= 0.04 && item.sizeRatioDelta <= 0.04);
      const neuralSceneControlsFramed = neuralSceneMetrics.length > 0
        && neuralSceneMetrics.every((item) => item.visible && item.framed);
      const neuralDeviceMetrics = neuralDevices.map((el) => {
        const rect = el.getBoundingClientRect();
        const anchors = Array.from(el.querySelectorAll(
          '.nam-neural-control-anchor, .nam-neural-decorative-switch-anchor, .nam-neural-anchor-button, .nam-neural-footswitch-anchor, .nam-neural-device-display[data-anchored="true"], .nam-neural-delay-display[data-anchored="true"], .nam-neural-label-anchor, .nam-neural-mic-anchor, .nam-neural-meter-anchor'
        ));
        const sceneAnchors = Array.from(el.querySelectorAll('.nam-scene-control-visual[data-scene-control="true"]'));
        const anchorInside = [...anchors, ...sceneAnchors].every((anchor) => {
          const anchorRect = anchor.getBoundingClientRect();
          return anchorRect.left >= rect.left - 12
            && anchorRect.top >= rect.top - 12
            && anchorRect.right <= rect.right + 12
            && anchorRect.bottom <= rect.bottom + 12;
        });
        return {
          module: el.getAttribute('data-module') || '',
          active: el.getAttribute('data-active') === 'true',
          visible: visibleBox(el),
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
          anchorCount: anchors.length + sceneAnchors.length,
          anchorInside,
          hasLed: Boolean(el.querySelector('.nam-neural-led, .nam-scene-led')),
          hasFootswitch: Boolean(el.querySelector('.nam-neural-footswitch, .nam-scene-footswitch')),
          sceneGraph: el.getAttribute('data-scene-graph') === 'true',
        };
      });
      const neuralSectionButtons = Array.from(document.querySelectorAll('.nam-neural-section-rail button')).map((el) => ({
        id: el.getAttribute('data-section') || '',
        label: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        active: el.getAttribute('data-active') === 'true',
        visible: visibleBox(el),
      }));
      const neuralGlobalControlCount = neuralGlobalStrip
        ? neuralGlobalStrip.querySelectorAll('.nam-meter-trim, .nam-neural-global-knob, .nam-neural-stepper').length
        : 0;
      const neuralPresetLibraryButton = document.querySelector('.nam-neural-preset-library-button');
      const neuralGlobalLibraryButton = document.querySelector('.nam-neural-global-side-right .nam-neural-library-button');
      const neuralGlobalDividerCount = neuralGlobalStrip
        ? neuralGlobalStrip.querySelectorAll('.nam-neural-global-side > * + *').length
        : 0;
      const neuralTopStripRegionsReady = Boolean(
        visibleBox(neuralSectionRail)
        && visibleBox(neuralGlobalStrip)
        && visibleBox(neuralPresetHub)
        && visibleBox(neuralPresetLibraryButton)
        && !visibleBox(neuralGlobalLibraryButton)
        && neuralGlobalDividerCount >= 3
      );
      const neuralRetiredInputModeAbsent = !document.querySelector('.nam-neural-input-mode, [data-param="inputMode"]');
      const neuralRetiredTransposeAbsent = !document.querySelector('[data-param="transposeSemitones"], [aria-label="Transpose"]');
      const neuralPrePedalCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-material="pedal"]').length;
      const neuralCompressorBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-module="pre-compressor-design-a"] [data-bound="true"]').length;
      const neuralTapeEchoBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-module="pre-tape-echo-design-a"] [data-bound="true"]').length;
      const neuralOctaverBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-module="pre-dual-octaver-design-a"] [data-bound="true"]').length;
      const neuralPrecisionDriveBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-module="pedal"] [data-bound="true"]').length;
      const neuralChaosBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="pre"] .nam-neural-device[data-module="pre-chaos-design-a"] [data-bound="true"]').length;
      const neuralPostModBoundCount = document.querySelectorAll('.nam-neural-post-suite .nam-neural-device[data-module="mod"] [data-bound="true"]').length;
      const neuralPostModTreadleBound = Boolean(document.querySelector('.nam-neural-post-suite .nam-neural-device[data-module="mod"] .nam-neural-treadle-anchor[data-bound="true"][data-param="modulatorPedalPosition"], .nam-neural-post-suite .nam-neural-device[data-module="mod"] .nam-scene-control-visual[data-kind="treadle"][data-param="modulatorPedalPosition"]'));
      const neuralPostModEngageBound = Boolean(document.querySelector('.nam-neural-post-suite .nam-neural-device[data-module="mod"] .nam-neural-footswitch-anchor[data-bound="true"][data-param="modulatorEnabled"], .nam-neural-post-suite .nam-neural-device[data-module="mod"] .nam-scene-control-visual[data-kind="footswitch"][data-param="modulatorEnabled"]'));
      const neuralPostDelayBoundCount = document.querySelectorAll('.nam-neural-post-suite .nam-neural-device[data-module="delay"] [data-bound="true"]').length;
      const neuralPostDelayEngageBound = Boolean(document.querySelector('.nam-neural-post-suite .nam-neural-device[data-module="delay"] .nam-neural-footswitch-anchor[data-bound="true"][data-param="delayEnabled"], .nam-neural-post-suite .nam-neural-device[data-module="delay"] .nam-scene-control-visual[data-kind="footswitch"][data-param="delayEnabled"]'));
      const neuralPostDelaySevenSegment = Boolean(document.querySelector('.nam-neural-post-suite .nam-neural-device[data-module="delay"] .nam-neural-seven-segment .nam-neural-seven-segment-digit i[data-on="true"], .nam-neural-post-suite .nam-neural-device[data-module="delay"] .nam-scene-display .nam-scene-display-text'));
      const neuralPostReverbBoundCount = document.querySelectorAll('.nam-neural-post-suite .nam-neural-device[data-module="reverb"] [data-bound="true"]').length;
      const neuralPostReverbEngageBound = Boolean(document.querySelector('.nam-neural-post-suite .nam-neural-device[data-module="reverb"] .nam-neural-footswitch-anchor[data-bound="true"][data-param="reverbEnabled"], .nam-neural-post-suite .nam-neural-device[data-module="reverb"] .nam-scene-control-visual[data-kind="footswitch"][data-param="reverbEnabled"]'));
      const neuralEqFaderCount = document.querySelectorAll('.nam-neural-section-suite[data-section="eq"] .nam-neural-eq-fader, .nam-neural-section-suite[data-section="eq"] .nam-scene-control-visual[data-kind="fader"]').length;
      const neuralEqBoundFaderCount = document.querySelectorAll('.nam-neural-section-suite[data-section="eq"] .nam-neural-eq-fader[data-bound="true"], .nam-neural-section-suite[data-section="eq"] .nam-scene-fader[data-bound="true"]').length;
      const neuralEqPowerBound = Boolean(document.querySelector('.nam-neural-section-suite[data-section="eq"] .nam-neural-device[data-module="eq"] .nam-neural-footswitch-anchor[data-bound="true"][data-param="eqEnabled"], .nam-neural-section-suite[data-section="eq"] .nam-neural-device[data-module="eq"] .nam-scene-control-visual[data-kind="footswitch"][data-param="eqEnabled"]'));
      const neuralCabMicCount = document.querySelectorAll('.nam-neural-section-suite[data-section="cab"] .nam-neural-cab-mic, .nam-neural-section-suite[data-section="cab"] .nam-scene-control-visual[data-kind="mic"]').length;
      const neuralCabBoundCount = document.querySelectorAll('.nam-neural-section-suite[data-section="cab"] .nam-neural-device[data-module="cab"] [data-bound="true"]').length;
      const neuralAmpBackdropReady = Boolean(document.querySelector('.nam-neural-section-suite[data-section="amp"] .nam-neural-amp-head-backdrop'));
      const neuralAmpSceneReady = Boolean(document.querySelector('.nam-neural-section-suite[data-section="amp"] .nam-scene-device[data-module="amp"][data-original-amp*="studio13-meridian"]'));
      const neuralAmpDecorativeSwitchCount = document.querySelectorAll('.nam-neural-section-suite[data-section="amp"] .nam-neural-decorative-switch-anchor, .nam-neural-section-suite[data-section="amp"] .nam-scene-control-visual[data-kind="switch"]').length;
      const neuralAmpDecorativeKnobCount = document.querySelectorAll('.nam-neural-section-suite[data-section="amp"] .nam-neural-decorative-knob, .nam-neural-section-suite[data-section="amp"] .nam-scene-control-visual[data-kind="knob"]').length;
      const neuralAmpBoundFaceplateCount = document.querySelectorAll('.nam-neural-section-suite[data-section="amp"] .nam-neural-device[data-module="amp"] [data-bound="true"]').length;
      const neuralAmpFaceplateReady = (neuralAmpBackdropReady || neuralAmpSceneReady) && neuralAmpBoundFaceplateCount >= 10 && neuralAmpDecorativeKnobCount >= 7 && neuralAmpDecorativeSwitchCount >= 2;
      const neuralMaterialTokens = {
        pass: cssNumberToken('--nam-neural-material-pass'),
        skinOpacity: cssNumberToken('--nam-neural-skin-opacity'),
        shadowAlpha: cssNumberToken('--nam-neural-device-shadow-alpha'),
        sideDepth: cssNumberToken('--nam-neural-side-depth'),
      };
      neuralMaterialTokens.ready = Boolean(
        neuralMaterialTokens.pass >= 2
        && neuralMaterialTokens.skinOpacity >= 0.38
        && neuralMaterialTokens.skinOpacity <= 0.58
        && neuralMaterialTokens.shadowAlpha >= 0.36
        && neuralMaterialTokens.shadowAlpha <= 0.58
        && neuralMaterialTokens.sideDepth >= 6
      );
      const neuralFooterText = (stageFooter?.textContent || '').replace(/\s+/g, ' ').trim();
      const neuralFooterRect = stageFooter?.getBoundingClientRect();
      const neuralShell = {
        productClassName: product?.className || '',
        hasRoot: Boolean(neuralProduct),
        sectionRailVisible: visibleBox(neuralSectionRail),
        sectionButtonCount: neuralSectionButtons.length,
        activeSectionIds: neuralSectionButtons.filter((item) => item.active).map((item) => item.id),
        activeSectionLabels: neuralSectionButtons.filter((item) => item.active).map((item) => item.label),
        sectionButtonsVisible: neuralSectionButtons.length >= 5 && neuralSectionButtons.every((item) => item.visible),
        globalStripVisible: visibleBox(neuralGlobalStrip),
        globalControlCount: neuralGlobalControlCount,
        globalLabelsReady: neuralGlobalControlCount >= 4 && neuralRetiredInputModeAbsent && neuralRetiredTransposeAbsent,
        topStripRegionsReady: neuralTopStripRegionsReady,
        globalDividerCount: neuralGlobalDividerCount,
        presetLibraryButtonVisible: visibleBox(neuralPresetLibraryButton),
        globalLibraryButtonVisible: visibleBox(neuralGlobalLibraryButton),
        retiredInputModeAbsent: neuralRetiredInputModeAbsent,
        retiredTransposeAbsent: neuralRetiredTransposeAbsent,
        presetHubVisible: visibleBox(neuralPresetHub),
        postSuiteVisible: visibleBox(neuralPostSuite),
        sectionSuiteVisible: visibleBox(neuralSectionSuite),
        expectedSection: expectedNeuralSection,
        expectedModules: expectedNeuralModules,
        deviceCount: neuralDeviceMetrics.filter((item) => item.visible).length,
        deviceModules: neuralDeviceMetrics.map((item) => item.module),
        devicesHaveAnchors: neuralDeviceMetrics.length >= expectedNeuralDeviceCount && neuralDeviceMetrics.every((item) => item.anchorCount >= 3 && (item.sceneGraph || item.anchorInside)),
        devicesHaveSwitches: neuralDeviceMetrics.length >= expectedNeuralDeviceCount && neuralDeviceMetrics.every((item) => item.hasLed && item.hasFootswitch),
        anchorCount: neuralAnchors.length + neuralSceneControls.length,
        sceneGraphDeviceCount: neuralDeviceMetrics.filter((item) => item.sceneGraph).length,
        sceneControlCount: neuralSceneControls.length,
        sceneControlsAligned: neuralSceneControlsAligned,
        sceneControlsFramed: neuralSceneControlsFramed,
        sceneCenterMaxDelta: Number(neuralSceneCenterMaxDelta.toFixed(2)),
        sceneDiameterMaxRatioDelta: Number(neuralSceneDiameterMaxRatioDelta.toFixed(4)),
        sceneSizeMaxRatioDelta: Number(neuralSceneSizeMaxRatioDelta.toFixed(4)),
        sceneMetrics: neuralSceneMetrics.slice(0, 50),
        prePedalCount: neuralPrePedalCount,
        compressorBoundCount: neuralCompressorBoundCount,
        tapeEchoBoundCount: neuralTapeEchoBoundCount,
        octaverBoundCount: neuralOctaverBoundCount,
        precisionDriveBoundCount: neuralPrecisionDriveBoundCount,
        chaosBoundCount: neuralChaosBoundCount,
        postModBoundCount: neuralPostModBoundCount,
        postModTreadleBound: neuralPostModTreadleBound,
        postModEngageBound: neuralPostModEngageBound,
        postDelayBoundCount: neuralPostDelayBoundCount,
        postDelayEngageBound: neuralPostDelayEngageBound,
        postDelaySevenSegment: neuralPostDelaySevenSegment,
        postReverbBoundCount: neuralPostReverbBoundCount,
        postReverbEngageBound: neuralPostReverbEngageBound,
        eqFaderCount: neuralEqFaderCount,
        eqBoundFaderCount: neuralEqBoundFaderCount,
        eqPowerBound: neuralEqPowerBound,
        cabMicCount: neuralCabMicCount,
        cabBoundCount: neuralCabBoundCount,
        ampBackdropReady: neuralAmpBackdropReady,
        ampSceneReady: neuralAmpSceneReady,
        ampDecorativeSwitchCount: neuralAmpDecorativeSwitchCount,
        ampDecorativeKnobCount: neuralAmpDecorativeKnobCount,
        ampBoundFaceplateCount: neuralAmpBoundFaceplateCount,
        ampFaceplateReady: neuralAmpFaceplateReady,
        materialTokens: neuralMaterialTokens,
        materialReady: neuralMaterialTokens.ready,
        sectionSpecificReady: (expectedNeuralSection !== 'pre' || (neuralPrePedalCount >= 5 && neuralCompressorBoundCount >= 5 && neuralTapeEchoBoundCount >= 6 && neuralOctaverBoundCount >= 4 && neuralPrecisionDriveBoundCount >= 6 && neuralChaosBoundCount >= 2))
          && (expectedNeuralSection !== 'amp' || neuralAmpFaceplateReady)
          && (expectedNeuralSection !== 'post' || (neuralPostModBoundCount >= 10 && neuralPostModTreadleBound && neuralPostModEngageBound && neuralPostDelayBoundCount >= 9 && neuralPostDelayEngageBound && neuralPostDelaySevenSegment && neuralPostReverbBoundCount >= 6 && neuralPostReverbEngageBound))
          && (expectedNeuralSection !== 'eq' || (neuralEqFaderCount >= 9 && neuralEqBoundFaderCount >= 9 && neuralEqPowerBound))
          && (expectedNeuralSection !== 'cab' || (neuralCabMicCount >= 2 && neuralCabBoundCount >= 10)),
        legacyTopbarVisible: visibleBox(neuralLegacyTopbar),
        legacyChainVisible: visibleBox(neuralLegacyChain),
        footerVisible: visibleBox(stageFooter),
        footerTextReady: Boolean(neuralFooterRect && neuralFooterRect.height >= 48),
        footerText: neuralFooterText,
        metrics: neuralDeviceMetrics,
      };
      neuralShell.ready = Boolean(
        neuralShell.hasRoot
        && neuralShell.sectionRailVisible
        && neuralShell.sectionButtonsVisible
        && neuralShell.activeSectionIds.includes(expectedNeuralSection)
        && neuralShell.globalStripVisible
        && neuralShell.globalLabelsReady
        && neuralShell.topStripRegionsReady
        && neuralShell.presetHubVisible
        && (neuralShell.postSuiteVisible || neuralShell.sectionSuiteVisible)
        && neuralShell.deviceCount >= expectedNeuralDeviceCount
        && expectedNeuralModules.every((module) => neuralShell.deviceModules.includes(module))
        && neuralShell.devicesHaveAnchors
        && neuralShell.devicesHaveSwitches
        && neuralShell.anchorCount >= expectedNeuralDeviceCount * 3
        && neuralShell.sceneGraphDeviceCount >= expectedNeuralDeviceCount
        && neuralShell.sceneControlsAligned
        && neuralShell.sceneControlsFramed
        && neuralShell.sectionSpecificReady
        && neuralShell.materialReady
        && !neuralShell.legacyTopbarVisible
        && !neuralShell.legacyChainVisible
        && neuralShell.footerVisible
        && neuralShell.footerTextReady
      );
      const modeRailButtonMetrics = Array.from(document.querySelectorAll('.nam-mode-rail-nav button')).map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const icon = el.querySelector('svg');
        const iconStyle = icon ? window.getComputedStyle(icon) : null;
        return {
          qa: el.getAttribute('data-qa') || '',
          label: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          active: el.getAttribute('data-active') === 'true',
          ariaPressed: el.getAttribute('aria-pressed') === 'true',
          visible: visibleBox(el),
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
          color: style.color,
          borderColor: style.borderColor,
          backgroundImage: style.backgroundImage,
          iconColor: iconStyle?.color || '',
        };
      });
      const modeRailActiveLabels = modeRailButtonMetrics
        .filter((item) => item.active && item.ariaPressed)
        .map((item) => item.label);
      const modeRailReferenceActiveState = Boolean(modeRailButtonMetrics.length >= 4
        && modeRailButtonMetrics.every((item) => item.visible)
        && modeRailActiveLabels.length === 1
        && modeRailActiveLabels[0] === 'Gear'
        && modeRailButtonMetrics.find((item) => item.label === 'Gear')?.borderColor.includes('245')
        && modeRailButtonMetrics.find((item) => item.label === 'Gear')?.iconColor.includes('245'));
      const modeRailReferenceButtonSizing = Boolean(modeRailButtonMetrics.length >= 4
        && modeRailButtonMetrics.every((item) => item.height >= (window.innerWidth < 1100 ? 28 : 58))
        && modeRailButtonMetrics.every((item) => item.width >= (window.innerWidth < 1100 ? 46 : 54)));
      const statusPanelStyle = modeRailStatus ? window.getComputedStyle(modeRailStatus) : null;
      const statusRailBoxed = Boolean(visibleBox(modeRailStatus)
        && statusPanelStyle
        && statusPanelStyle.borderTopColor !== 'rgba(0, 0, 0, 0)'
        && statusPanelStyle.borderTopStyle !== 'none'
        && statusPanelStyle.backgroundImage !== 'none'
        && modeRailNavRect
        && modeRailStatusRect
        && modeRailStatusRect.top >= modeRailNavRect.bottom - 1);
      const stageFooterLeftText = (stageFooterLeft?.textContent || '').replace(/\\s+/g, ' ').trim();
      const stageFooterRightText = (stageFooterRight?.textContent || '').replace(/\\s+/g, ' ').trim();
      const footerSizeTrigger = document.querySelector('[data-qa="nam-footer-size"]');
      const footerSizePopover = document.querySelector('.nam-stage-size-popover');
      const footerSizeOptionLabels = Array.from(document.querySelectorAll('.nam-stage-size-popover [role="option"]'))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const stageFooterReferenceGroups = Boolean(stageFooterRect
        && stageFooterLeftRect
        && stageFooterRightRect
        && visibleBox(stageFooterLeft)
        && visibleBox(stageFooterRight)
        && stageFooterLeftRect.left >= stageFooterRect.left - 1
        && stageFooterLeftRect.right < stageFooterRightRect.left
        && stageFooterRightRect.right <= stageFooterRect.right + 1
        && stageFooterRect.width - stageFooterRightRect.right <= 14
        && stageFooterLeftText.includes('BPM')
        && stageFooterLeftText.includes('4/4')
        && !stageFooterLeftText.includes('TAP')
        && stageFooterRightText.includes('140%'));
      const stageFooterReferenceHeight = Boolean(stageFooterRect
        && stageFooterRect.height >= (window.innerWidth < 1100 ? 40 : 44)
        && stageFooterRect.height <= (window.innerWidth < 1100 ? 58 : 52));
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
      const stageFooterControls = Array.from(document.querySelectorAll('[data-qa^="nam-footer-"]')).map((el) => ({
        qa: el.getAttribute('data-qa') || '',
        disabled: Boolean(el.disabled),
        title: el.getAttribute('title') || '',
        visible: visibleBox(el),
      }));
      const railSortOptionLabels = Array.from(document.querySelectorAll('.nam-sort-menu-popover [role="option"]'))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const railSortLabelRect = railSortLabel?.getBoundingClientRect();
      const railSortTriggerRect = railSortTrigger?.getBoundingClientRect();
      const railViewToggleButtonStates = railViewToggleButtons.map((el) => ({
        active: el.getAttribute('data-active') === 'true',
        ariaPressed: el.getAttribute('aria-pressed') === 'true',
        title: el.getAttribute('title') || '',
        visible: visibleBox(el),
      }));
      const railSortReferenceLayout = Boolean(visibleBox(railSortLabel)
        && visibleBox(railSortTrigger)
        && railSortLabelRect
        && railSortTriggerRect
        && railSortTriggerRect.left >= railSortLabelRect.right + 4
        && railSortTriggerRect.height >= 30);
      const railViewToggleReferencePair = Boolean(visibleBox(railViewToggle)
        && railViewToggleButtonStates.length === 2
        && railViewToggleButtonStates.every((button) => button.visible)
        && railViewToggleButtonStates.filter((button) => button.active && button.ariaPressed).length === 1
        && railViewToggleButtonStates.some((button) => button.title === 'Card view')
        && railViewToggleButtonStates.some((button) => button.title === 'List view'));
      const rectInside = (rect, container, pad = 3) => Boolean(rect && container
        && rect.left >= container.left - pad
        && rect.top >= container.top - pad
        && rect.right <= container.right + pad
        && rect.bottom <= container.bottom + pad);
      const normalizedRect = (el, container) => {
        if (!el || !container) return null;
        const rect = el.getBoundingClientRect();
        const width = Math.max(1, container.width);
        const height = Math.max(1, container.height);
        return {
          left: Number(((rect.left - container.left) / width).toFixed(3)),
          top: Number(((rect.top - container.top) / height).toFixed(3)),
          right: Number(((rect.right - container.left) / width).toFixed(3)),
          bottom: Number(((rect.bottom - container.top) / height).toFixed(3)),
          width: Number((rect.width / width).toFixed(3)),
          height: Number((rect.height / height).toFixed(3)),
          visible: visibleBox(el),
          inside: rectInside(rect, container, 8),
        };
      };
      const fxFaceplateRect = fxFaceplate?.getBoundingClientRect();
      const fxKnobDeckRect = fxKnobDeck?.getBoundingClientRect();
      const fxModule = fxHardware?.getAttribute('data-module') || '';
      const fxFaceplateArtStyle = fxFaceplateArt ? window.getComputedStyle(fxFaceplateArt) : null;
      const fxKnobDeckStyle = fxKnobDeck ? window.getComputedStyle(fxKnobDeck) : null;
      const fxKnobMetrics = fxKnobs.map((el) => {
        const rect = el.getBoundingClientRect();
        const cap = el.querySelector('[data-qa="nam-hardware-dial"], .nam-rack-knob-cap');
        const capRect = cap?.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          param: el.getAttribute('data-param') || '',
          visible: visibleBox(el),
          insideFaceplate: rectInside(rect, fxFaceplateRect, 3),
          x: fxFaceplateRect ? Number(((rect.left + rect.width / 2 - fxFaceplateRect.left) / Math.max(1, fxFaceplateRect.width)).toFixed(3)) : 0,
          y: fxFaceplateRect ? Number(((rect.top + rect.height / 2 - fxFaceplateRect.top) / Math.max(1, fxFaceplateRect.height)).toFixed(3)) : 0,
          capWidth: capRect ? Number(capRect.width.toFixed(1)) : 0,
          capHeight: capRect ? Number(capRect.height.toFixed(1)) : 0,
          hasCardChrome: style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.borderTopStyle !== 'none',
        };
      });
      const fxKnobSlotsIntegrated = fxModule === 'eq'
        ? fxKnobMetrics.every((item) => item.y >= 0.16 && item.y <= 0.62 && item.x >= 0.22 && item.x <= 0.78)
        : fxKnobMetrics.every((item) => item.y >= 0.16 && item.y <= 0.46);
      const fxControlsIntegrated = Boolean(fxFaceplateRect
        && fxKnobDeckRect
        && fxKnobs.length > 0
        && fxKnobDeckStyle?.position === 'absolute'
        && fxFaceplateArtStyle?.mixBlendMode === 'normal'
        && fxKnobMetrics.every((item) => item.visible && item.insideFaceplate && item.capWidth >= 44 && !item.hasCardChrome)
        && fxKnobSlotsIntegrated);
      const rightRailSideBySide = Boolean(stageHeroRect && rightRailRect && modeRailRect
        && rightRailRect.left >= stageHeroRect.right - 4
        && modeRailRect.right <= stageHeroRect.left + 4);
      const desktopReferenceRailTop = Boolean(chainRect && stageHeroRect && rightRailRect
        && Math.abs(rightRailRect.top - stageHeroRect.top) < 8
        && stageHeroRect.top >= chainRect.bottom - 3
        && chainRect.right <= rightRailRect.left + 4);
      const compactStackedRailLayout = Boolean(window.innerWidth < 1100
        && stageHeroRect
        && rightRailRect
        && modeRailRect
        && rightRailRect.top >= stageHeroRect.bottom - 4
        && rightRailRect.left >= modeRailRect.right - 4
        && rightRailRect.right <= window.innerWidth - 4
        && rightRailRect.height >= 104);
      const compactReferenceRailTop = Boolean(stageHeroRect && rightRailRect
        && Math.abs(rightRailRect.top - stageHeroRect.top) < 8);
      const knobRects = ampKnobs.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-param') || '',
          x: ampFrameRect ? (rect.left + rect.width / 2 - ampFrameRect.left) / Math.max(1, ampFrameRect.width) : 0,
          y: ampFrameRect ? (rect.top + rect.height / 2 - ampFrameRect.top) / Math.max(1, ampFrameRect.height) : 0,
          inside: rectInside(rect, ampFrameRect),
          width: rect.width,
          height: rect.height,
        };
      });
      const knobLabelRects = ampKnobLabels.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim(),
          visible: visibleBox(el),
          inside: rectInside(rect, ampFrameRect, 2),
        };
      });
      const knobValueReadoutRects = ampKnobValueReadouts.map((el) => ({
        text: (el.textContent || '').trim(),
        visible: visibleBox(el),
        rect: (() => {
          const rect = el.getBoundingClientRect();
          return {
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
          };
        })(),
      }));
      const toggleRect = toggle?.getBoundingClientRect();
      const togglePosition = toggleRect && ampFrameRect ? {
        x: Number(((toggleRect.left + toggleRect.width / 2 - ampFrameRect.left) / Math.max(1, ampFrameRect.width)).toFixed(3)),
        y: Number(((toggleRect.top + toggleRect.height / 2 - ampFrameRect.top) / Math.max(1, ampFrameRect.height)).toFixed(3)),
        width: Number(toggleRect.width.toFixed(1)),
        height: Number(toggleRect.height.toFixed(1)),
      } : null;
      const toggleInFaceplateZone = Boolean(togglePosition
        && togglePosition.x >= 0.13
        && togglePosition.x <= 0.22
        && togglePosition.y >= 0.39
        && togglePosition.y <= 0.50);
      const knobScaleMarkRects = ampKnobScaleMarks.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim(),
          inside: rectInside(rect, ampFrameRect, 1),
          visible: visibleBox(el),
        };
      });
      const hardwareDialRects = ampHardwareDials.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          param: el.getAttribute('data-param') || '',
          inside: rectInside(rect, ampFrameRect, 1),
          visible: visibleBox(el),
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        };
      });
      const hardwareDialNumberRects = ampHardwareDialNumbers.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          text: (el.textContent || '').trim(),
          inside: rectInside(rect, ampFrameRect, 1),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0.5 && rect.height > 2,
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        };
      });
      const hardwareDialTickStrokeReady = ampHardwareDialTicks.length > 0
        && ampHardwareDialTicks.every((el) => {
          const style = window.getComputedStyle(el);
          return style.stroke !== 'none' && style.strokeWidth !== '0px';
        });
      const hardwareDialScaleTrackReady = ampHardwareDialScaleTracks.length >= ampHardwareDials.length
        && ampHardwareDialScaleTracks.every((el) => {
          const style = window.getComputedStyle(el);
          return style.fill !== 'none' && style.stroke !== 'none';
        });
      const hardwareDialOuterRimReady = ampHardwareDialOuterRims.length >= ampHardwareDials.length
        && ampHardwareDialOuterRims.every((el) => {
          const style = window.getComputedStyle(el);
          return style.fill !== 'none' && style.stroke !== 'none';
        });
      const hardwareDialGripStrokeReady = ampHardwareDialGrips.length >= ampHardwareDials.length * Math.max(1, hardwareDialTokens.grips)
        && ampHardwareDialGrips.every((el) => {
          const style = window.getComputedStyle(el);
          return style.stroke !== 'none' && style.strokeWidth !== '0px';
        });
      const hardwareDialCapHighlightReady = ampHardwareDialCapHighlights.length >= ampHardwareDials.length
        && ampHardwareDialCapHighlights.every((el) => {
          const style = window.getComputedStyle(el);
          return style.fill !== 'none';
        });
      const hardwareDialIndicatorShadowReady = ampHardwareDialIndicatorShadows.length >= ampHardwareDials.length
        && ampHardwareDialIndicatorShadows.every((el) => {
          const style = window.getComputedStyle(el);
          return style.stroke !== 'none' && style.strokeWidth !== '0px';
        });
      const hardwareDialIndicatorTipReady = ampHardwareDialIndicatorTips.length >= ampHardwareDials.length
        && ampHardwareDialIndicatorTips.every((el) => {
          const style = window.getComputedStyle(el);
          return style.fill !== 'none';
        });
      const hardwareNameplateRects = hardwareNameplates.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          ariaLabel: el.getAttribute('aria-label') || '',
          visible: visibleBox(el),
          inside: rectInside(rect, ampFrameRect),
          x: ampFrameRect ? Number(((rect.left + rect.width / 2 - ampFrameRect.left) / Math.max(1, ampFrameRect.width)).toFixed(3)) : 0,
          y: ampFrameRect ? Number(((rect.top + rect.height / 2 - ampFrameRect.top) / Math.max(1, ampFrameRect.height)).toFixed(3)) : 0,
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        };
      });
      const ampNameplateRect = hardwareNameplateRects.find((rect) => rect.ariaLabel.startsWith('Amp model:'));
      const cabNameplateRect = hardwareNameplateRects.find((rect) => rect.ariaLabel.startsWith('Cabinet:'));
      const hardwareNameplatesDesignBand = Boolean(ampNameplateRect
        && cabNameplateRect
        && ampNameplateRect.y >= 0.20
        && ampNameplateRect.y <= 0.31
        && cabNameplateRect.y >= 0.78
        && cabNameplateRect.y <= 0.88
        && ampNameplateRect.width <= 380
        && cabNameplateRect.width <= 380);
      const splitArtRects = {
        stack: normalizedRect(splitArtStack, ampFrameRect),
        head: normalizedRect(splitArtHead, ampFrameRect),
        cab: normalizedRect(splitArtCab, ampFrameRect),
      };
      const splitArtDesignBand = Boolean(splitArtRects.stack?.visible
        && splitArtRects.head?.visible
        && splitArtRects.cab?.visible
        && splitArtRects.stack?.inside
        && splitArtRects.head?.inside
        && splitArtRects.cab?.inside
        && splitArtRects.head.top >= -0.02
        && splitArtRects.head.top <= 0.08
        && splitArtRects.head.bottom >= 0.52
        && splitArtRects.head.bottom <= 0.64
        && splitArtRects.cab.top >= 0.54
        && splitArtRects.cab.top <= 0.66
        && splitArtRects.cab.bottom >= 0.92
        && splitArtRects.cab.bottom <= 1.04
        && Math.abs(splitArtRects.head.bottom - splitArtRects.cab.top) <= 0.08);
      const physicalNameplateMinHeight = window.innerWidth < 1100 ? 28 : window.innerWidth < 1400 ? 34 : 38;
      const ampHardware = {
        hasFrame: Boolean(ampFrameRect),
        sceneName: ampFrame?.getAttribute('data-scene') || '',
        assetTreatment: ampFrame?.getAttribute('data-asset-treatment') || '',
        sceneRegionNames: sceneRegions,
        sceneAnchorNames: sceneAnchors,
        hasHardwareSceneCoordinates: Boolean(ampFrame?.getAttribute('data-scene') === 'amp-cab'
          && sceneRegions.includes('head')
          && sceneRegions.includes('cab')
          && sceneAnchors.includes('amp-nameplate')
          && sceneAnchors.includes('cab-nameplate')
          && sceneAnchors.includes('power')
          && ['ampGainDb', 'bassDb', 'midDb', 'trebleDb', 'presenceDb', 'ampMix', 'ampOutputDb']
            .every((id) => sceneAnchors.includes(id))),
        hasHardwareAssetTreatment: ampFrame?.getAttribute('data-asset-treatment') === 'hardware-parity-v2',
        frameRatio: ampFrameRect ? Number((ampFrameRect.width / Math.max(1, ampFrameRect.height)).toFixed(3)) : 0,
        hasSplitStackArt: Boolean(splitArtStack && splitArtHead && splitArtCab),
        splitArtDesignBand,
        splitArtRects,
        hasToggle: Boolean(toggle),
        toggleInside: rectInside(toggleRect, ampFrameRect),
        togglePosition,
        toggleInFaceplateZone,
        knobCount: ampKnobs.length,
        knobsInside: knobRects.every((rect) => rect.inside),
        hardwareNameplateCount: hardwareNameplateRects.length,
        hardwareNameplatesVisible: hardwareNameplateRects.length >= 2 && hardwareNameplateRects.every((rect) => rect.visible && rect.inside),
        hardwareNameplatesPhysical: hardwareNameplateRects.length >= 2 && hardwareNameplateRects.every((rect) => rect.height >= physicalNameplateMinHeight),
        physicalNameplateMinHeight,
        hardwareNameplatesDesignBand,
        hardwareNameplateTexts: hardwareNameplateRects.map((rect) => rect.text),
        hardwareNameplateAriaLabels: hardwareNameplateRects.map((rect) => rect.ariaLabel),
        legacyAmpBadgesVisible: visibleBox(legacyAmpBadges),
        knobIds: knobRects.map((rect) => rect.id),
        knobScaleMarkCount: knobScaleMarkRects.length,
        knobScaleMarksInside: knobScaleMarkRects.every((rect) => rect.visible && rect.inside),
        hardwareDialCount: hardwareDialRects.length,
        hardwareDialsVisible: hardwareDialRects.length >= 5 && hardwareDialRects.every((rect) => rect.visible && rect.inside),
        hardwareDialMinSize: hardwareDialRects.reduce((min, rect) => Math.min(min, rect.width, rect.height), Number.POSITIVE_INFINITY),
        hardwareDialNumberCount: hardwareDialNumberRects.length,
        hardwareDialNumbersVisible: hardwareDialNumberRects.length >= hardwareDialRects.length * Math.max(7, hardwareDialTokens.numberCount || 0)
          && hardwareDialNumberRects.every((rect) => rect.visible && rect.inside),
        hardwareDialNumberInvisibleCount: hardwareDialNumberRects.filter((rect) => !rect.visible || !rect.inside).length,
        hardwareDialNumberProblemRects: hardwareDialNumberRects
          .filter((rect) => !rect.visible || !rect.inside)
          .slice(0, 12),
        hardwareDialTickCount: ampHardwareDialTicks.length,
        hardwareDialTickStrokeReady,
        hardwareDialVersionContract: ampHardwareDials.length >= 5
          && ampHardwareDials.every((el) => el.getAttribute('data-dial-version') === 'faceplate-svg-v3'),
        hardwareDialScaleTrackCount: ampHardwareDialScaleTracks.length,
        hardwareDialScaleTrackReady,
        hardwareDialOuterRimCount: ampHardwareDialOuterRims.length,
        hardwareDialOuterRimReady,
        hardwareDialGripCount: ampHardwareDialGrips.length,
        hardwareDialGripStrokeReady,
        hardwareDialCapHighlightCount: ampHardwareDialCapHighlights.length,
        hardwareDialCapHighlightReady,
        hardwareDialIndicatorShadowCount: ampHardwareDialIndicatorShadows.length,
        hardwareDialIndicatorShadowReady,
        hardwareDialIndicatorTipCount: ampHardwareDialIndicatorTips.length,
        hardwareDialIndicatorTipReady,
        knobRendererContract: ampKnobs.length >= 5 && ampKnobs.every((el) => el.getAttribute('data-renderer') === 'scene-svg-dial-v3'),
        knobLabelCount: knobLabelRects.length,
        knobLabelsVisible: knobLabelRects.length >= 5 && knobLabelRects.every((rect) => rect.text.length > 0),
        knobValueReadoutsHidden: knobValueReadoutRects.length >= 5 && knobValueReadoutRects.every((rect) => !rect.visible),
        knobValueReadoutRects,
        knobRects,
        knobLabelTexts: knobLabelRects.map((rect) => rect.text),
        knobScaleMarkTexts: knobScaleMarkRects.slice(0, 14).map((rect) => rect.text),
        hardwareDialTexts: hardwareDialNumberRects.slice(0, 14).map((rect) => rect.text),
        hardwareDialRects,
        hardwareNameplateRects,
      };
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
      const statusLabels = Array.from(document.querySelectorAll('.nam-mode-rail-status article span'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      const statusItems = Array.from(document.querySelectorAll('.nam-mode-rail-status article')).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          label: (el.querySelector('span')?.textContent || '').trim(),
          value: (el.querySelector('strong')?.textContent || '').trim(),
          hasMeter: el.getAttribute('data-meter') === 'true',
          visible: visibleBox(el),
          bottom: Number(rect.bottom.toFixed(1)),
        };
      }).filter((item) => item.label);
      const statusValues = Object.fromEntries(statusItems.map((item) => [item.label, item.value]));
      const statusMeterLabels = statusItems.filter((item) => item.hasMeter).map((item) => item.label);
      const statusRailRowsFit = Boolean(modeRailRect)
        && statusItems.every((item) => !item.visible || item.bottom <= modeRailRect.bottom + 1);
      const statusRailReferenceSplit = Boolean(modeRailRect && modeRailStatusRect)
        && (window.innerWidth < 1100 || ((modeRailStatusRect.top - modeRailRect.top) / Math.max(1, modeRailRect.height)) >= 0.45);
      const modeRailReferenceWidth = Boolean(modeRailRect)
        && (window.innerWidth < 1100
          || modeRailRect.width >= (window.innerWidth <= 1400 ? 69 : 77));
      const modeRailViewportFit = Boolean(modeRailRect)
        && (window.innerWidth < 900 || modeRailRect.right <= window.innerWidth - 4);
      const rightExplorerViewportFit = Boolean(rightRailRect)
        && (window.innerWidth < 900 || rightRailRect.right <= window.innerWidth - 4);
      const expectedModeRailWidth = window.innerWidth < 1100
        ? rackFinalParityTokens.modeRailCompact
        : window.innerWidth <= 1400
          ? rackFinalParityTokens.modeRailLaptop
          : rackFinalParityTokens.modeRailDesktop;
      const expectedExplorerWidth = window.innerWidth < 1100
        ? { min: rackFinalParityTokens.explorerCompactMin, max: rackFinalParityTokens.explorerCompactMax }
        : window.innerWidth <= 1400
          ? { min: rackFinalParityTokens.explorerLaptop, max: rackFinalParityTokens.explorerLaptop }
          : { min: rackFinalParityTokens.explorerMin, max: rackFinalParityTokens.explorerMax };
      const modeRailWidthMatchesFinalToken = Boolean(modeRailRect && expectedModeRailWidth > 0
        && Math.abs(modeRailRect.width - expectedModeRailWidth) <= 3);
      const rightExplorerWidthMatchesFinalToken = Boolean(rightRailRect
        && rightRailRect.width >= expectedExplorerWidth.min - 3
        && rightRailRect.width <= expectedExplorerWidth.max + 3);
      const stageGapMatchesFinalToken = Boolean(stageHeroRect && rightRailRect && rackFinalParityTokens.stageGap > 0
        && Math.abs(rightRailRect.left - stageHeroRect.right - rackFinalParityTokens.stageGap) <= 4);
      const stageFrameMatchesReferenceAspect = Boolean(ampFrameRect
        && Math.abs((ampFrameRect.width / Math.max(1, ampFrameRect.height)) - rackFinalParityTokens.stageAspect) <= 0.035);
      const stageContentHeight = stageHeroRect
        ? Math.max(1, (stageFooterRect?.top ?? stageHeroRect.bottom) - stageHeroRect.top)
        : 0;
      const stageFrameFillMetrics = ampFrameRect && stageHeroRect ? {
        widthRatio: Number((ampFrameRect.width / Math.max(1, stageHeroRect.width)).toFixed(3)),
        heightRatio: Number((ampFrameRect.height / Math.max(1, stageContentHeight)).toFixed(3)),
        topGap: Number((ampFrameRect.top - stageHeroRect.top).toFixed(1)),
        bottomGap: Number(((stageFooterRect?.top ?? stageHeroRect.bottom) - ampFrameRect.bottom).toFixed(1)),
        leftBleed: Number((stageHeroRect.left - ampFrameRect.left).toFixed(1)),
        rightBleed: Number((ampFrameRect.right - stageHeroRect.right).toFixed(1)),
      } : null;
      const stageFrameNoVerticalCutoff = Boolean(stageFrameFillMetrics
        && stageFrameFillMetrics.topGap >= (window.innerWidth < 1100 ? 6 : 12)
        && stageFrameFillMetrics.bottomGap >= -1);
      const stageFrameFillReady = Boolean(stageFillTokens.ready
        && stageFrameFillMetrics
        && stageFrameNoVerticalCutoff
        && stageFrameFillMetrics.heightRatio >= (window.innerWidth < 1100 ? 0.64 : 0.72)
        && stageFrameFillMetrics.widthRatio >= (window.innerWidth < 1100 ? 0.50 : 0.74)
        && stageFrameFillMetrics.topGap >= (window.innerWidth < 1100 ? 8 : 14)
        && stageFrameFillMetrics.topGap <= (window.innerWidth < 1100 ? 24 : 38)
        && stageFrameFillMetrics.bottomGap <= (window.innerWidth < 1100 ? 96 : 280)
        && stageFrameFillMetrics.leftBleed >= (window.innerWidth < 1100 ? -240 : -360)
        && stageFrameFillMetrics.rightBleed >= (window.innerWidth < 1100 ? -240 : -360));
      const stageFooterHeightMatchesFinalToken = Boolean(stageFooterRect
        && Math.abs(stageFooterRect.height - (window.innerWidth < 1100
          ? rackFinalParityTokens.stageFooterCompactHeight
          : rackFinalParityTokens.stageFooterHeight)) <= 10);
      const rackFinalParityChrome = Boolean(rackFinalParityTokens.ready
        && modeRailWidthMatchesFinalToken
        && (window.innerWidth < 1100 ? compactStackedRailLayout : rightExplorerWidthMatchesFinalToken)
        && (window.innerWidth < 1100 ? true : stageGapMatchesFinalToken)
        && stageFrameMatchesReferenceAspect
        && stageFooterHeightMatchesFinalToken);
      const stageHeroStyle = stageHero ? window.getComputedStyle(stageHero) : null;
      const selectedRailCard = railResultCards.find((el) => el.getAttribute('data-selected') === 'true') || railResultCards[0];
      const selectedRailCardStyle = selectedRailCard ? window.getComputedStyle(selectedRailCard) : null;
      const selectedRailCardRect = selectedRailCard?.getBoundingClientRect();
      const firstRailCardArt = selectedRailCard?.querySelector('.nam-card-art') || railResultCards[0]?.querySelector('.nam-card-art');
      const firstRailCardArtStyle = firstRailCardArt ? window.getComputedStyle(firstRailCardArt) : null;
      const activeModeButton = document.querySelector('.nam-mode-rail-nav button[data-active="true"]');
      const activeModeButtonStyle = activeModeButton ? window.getComputedStyle(activeModeButton) : null;
      const expectedPolishedRailCardHeight = window.innerWidth <= 1100
        ? 66
        : window.innerWidth <= 1280
          ? 74
          : rackVisualPolishTokens.railCardMinHeight - 2;
      const rackVisualPolishApplied = Boolean(rackVisualPolishTokens.ready
        && stageHeroStyle?.backgroundImage.includes('radial-gradient')
        && selectedRailCardStyle?.borderTopColor.includes('245')
        && selectedRailCardStyle?.backgroundImage.includes('radial-gradient')
        && Number.parseFloat(selectedRailCardStyle?.borderTopLeftRadius || '0') >= 4
        && selectedRailCardRect
        && selectedRailCardRect.height >= expectedPolishedRailCardHeight
        && firstRailCardArtStyle?.filter.includes('contrast')
        && activeModeButtonStyle?.backgroundImage.includes('radial-gradient')
        && activeModeButtonStyle?.borderTopColor.includes('245'));
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
      const requiredStatusLabels = ['DSP', 'SR', 'Buffer', 'Latency'];
      const optionalStatusLabels = ['CPU'];
      const allowedStatusLabels = [...optionalStatusLabels, ...requiredStatusLabels];
      const extraStatusLabels = statusItems
        .map((item) => item.label)
        .filter((label) => !allowedStatusLabels.includes(label));
      const railResultCardMetrics = railResultCards.map((el) => {
        const rect = el.getBoundingClientRect();
        const railStats = el.getAttribute('data-rail-stats') || '';
        const small = el.querySelector('.nam-result-copy small');
        const statLine = el.querySelector('.nam-rail-stats-line');
        const art = el.querySelector('.nam-card-art');
        const artRect = art?.getBoundingClientRect();
        const artStyle = art ? window.getComputedStyle(art) : null;
        const artBeforeStyle = art ? window.getComputedStyle(art, '::before') : null;
        const artAfterStyle = art ? window.getComputedStyle(art, '::after') : null;
        return {
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          visible: visibleBox(el),
          actionCount: el.querySelectorAll('.nam-result-actions button').length,
          providerArt: el.getAttribute('data-provider-art') || '',
          artVisible: visibleBox(art),
          artWidth: artRect ? Number(artRect.width.toFixed(1)) : 0,
          artHeight: artRect ? Number(artRect.height.toFixed(1)) : 0,
          artFilter: artStyle?.filter || '',
          artBackgroundImage: artStyle?.backgroundImage || '',
          artBeforeDisplay: artBeforeStyle?.display || '',
          artBeforeOpacity: artBeforeStyle?.opacity || '',
          artAfterDisplay: artAfterStyle?.display || '',
          artAfterOpacity: artAfterStyle?.opacity || '',
          railStats,
          smallText: (small?.textContent || '').replace(/\\s+/g, ' ').trim(),
          smallKind: small?.getAttribute('data-kind') || '',
          statDownloads: small?.getAttribute('data-downloads') || '',
          statFavorites: small?.getAttribute('data-favorites') || '',
          statIconCount: statLine?.querySelectorAll('svg').length || 0,
          smallVisible: visibleBox(small),
          top: Number(rect.top.toFixed(1)),
          bottom: Number(rect.bottom.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        };
      });
      const railWholeRowsVisible = railResultCardMetrics.filter((card) => card.visible
        && (!railLivePagerRect || card.bottom <= railLivePagerRect.top - 1)).length;
      const visibleRailResultCards = railResultCardMetrics.filter((card) => card.visible);
      const railArtReadable = visibleRailResultCards.length > 0
        && railArtTokens.ready
        && visibleRailResultCards.every((card) => card.artVisible
          && card.artWidth >= Math.max(54, railArtTokens.width - 3)
          && card.artHeight >= (window.innerWidth < 1100 ? 46 : window.innerWidth <= 1280 ? 52 : 58)
          && card.artBackgroundImage.includes('url(')
          && card.artFilter.includes('brightness')
          && card.artBeforeDisplay !== 'none'
          && Number.parseFloat(card.artBeforeOpacity || '0') >= 0.45
          && card.artAfterDisplay !== 'none'
          && Number.parseFloat(card.artAfterOpacity || '0') >= 0.45);
      const railResultRowsClearFooter = !railLivePagerRect || visibleRailResultCards.every((card) => !card.visible
        || card.top <= railLivePagerRect.top - 8
        || card.top >= railLivePagerRect.bottom + 1);
      const railLivePagerAnchoredBottom = Boolean(railLivePagerRect && rightRailRect
        && rightRailRect.bottom - railLivePagerRect.bottom <= 18);
      const railFooterReferenceLayout = Boolean(visibleBox(railLivePager)
        && railLivePagerText.includes('Load more')
        && railLivePagerText.includes('Page 1 of 18')
        && !railLivePagerText.includes('RESULT')
        && !railLivePagerText.includes('Sorted by')
        && !railLivePagerText.includes('sorted by'));
      const railNewTagTexts = railNewTags
        .filter((el) => visibleBox(el))
        .map((el) => (el.textContent || '').trim());
      const railTransientSummaryHidden = !visibleBox(railFeedback) && !visibleBox(railLibrarySummary);
      const modeRailReferenceIcons = Boolean(
        modeRailIconClasses.Gear?.includes('lucide-package')
        && modeRailIconClasses.Chain?.includes('lucide-audio-lines')
        && modeRailIconClasses.Mixer?.includes('lucide-sliders-horizontal')
        && modeRailIconClasses.Tuner?.includes('lucide-gauge')
        && !modeRailIconClasses.Settings
        && !modeRailIconClasses.Setting
      );
      const railRowsHaveQuickActions = visibleRailResultCards.length > 0
        && visibleRailResultCards.every((card) => card.actionCount >= 3);
      const railRowsShowStats = visibleRailResultCards.length > 0
        && visibleRailResultCards.every((card) => card.smallVisible
          && card.smallKind === 'stats'
          && card.statIconCount >= 2
          && /[0-9]/.test(card.statDownloads)
          && /[0-9]/.test(card.statFavorites));
      const tunerPanel = document.querySelector('.premium-tuner-stage, .premium-tuner-drawer, .nam-rail-tuner');
      const tunerDisplay = tunerPanel?.querySelector('.premium-tuner-stage-copy, .premium-tuner-display, .nam-tuner-display');
      const tunerScale = tunerPanel?.querySelector('.premium-tuner-scale, .premium-tuner-cents, .nam-tuner-cents');
      const tunerNeedle = tunerPanel?.querySelector('.premium-tuner-needle, .premium-tuner-cents > i, .nam-tuner-cents > i');
      const tunerNote = tunerPanel?.querySelector('.premium-tuner-stage-copy > strong, .premium-tuner-display > strong, .nam-tuner-display > strong');
      const tunerCentsReadout = tunerPanel?.querySelector('.premium-tuner-stage-copy > em, .premium-tuner-display > em, .nam-tuner-display > em');
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
      const cabRailRect = cabRail?.getBoundingClientRect();
      const cabRailHead = cabRail?.querySelector('.nam-rail-panel-head');
      const cabRailActions = cabRail?.querySelector('.nam-rail-button-row');
      const cabRailList = cabRail?.querySelector('.nam-rail-ir-list');
      const cabRailHeadRect = cabRailHead?.getBoundingClientRect();
      const cabRailActionsRect = cabRailActions?.getBoundingClientRect();
      const cabRailListRect = cabRailList?.getBoundingClientRect();
      const cabRailCompactLayout = Boolean(visibleBox(cabRail)
        && visibleBox(cabRailHead)
        && visibleBox(cabRailActions)
        && visibleBox(cabRailList)
        && cabRailRect
        && cabRailHeadRect
        && cabRailActionsRect
        && cabRailListRect
        && cabRailActionsRect.top <= cabRailHeadRect.bottom + 18
        && cabRailListRect.top <= cabRailActionsRect.bottom + 22
        && cabRailListRect.top < cabRailRect.bottom);
      const savedRailRect = savedRail?.getBoundingClientRect();
      const savedRailHead = savedRail?.querySelector('.nam-rail-panel-head');
      const savedRailActions = savedRail?.querySelector('.nam-rail-button-row');
      const savedRailList = savedRail?.querySelector('.nam-rail-preset-list');
      const saveToneModal = document.querySelector('.nam-save-tone-modal[data-modal-panel="true"]');
      const saveToneForm = saveToneModal?.querySelector('.nam-save-tone-form');
      const saveToneFields = Array.from(saveToneModal?.querySelectorAll('input, textarea') || []);
      const saveToneFooterButtons = Array.from(saveToneModal?.querySelectorAll('button') || [])
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const namRackPrompt = document.querySelector('.nam-rack-prompt-modal');
      const namRackPromptButtons = Array.from(namRackPrompt?.querySelectorAll('button') || [])
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const savedRailHeadRect = savedRailHead?.getBoundingClientRect();
      const savedRailActionsRect = savedRailActions?.getBoundingClientRect();
      const savedRailListRect = savedRailList?.getBoundingClientRect();
      const savedRailCompactLayout = Boolean(visibleBox(savedRail)
        && visibleBox(savedRailHead)
        && visibleBox(savedRailActions)
        && visibleBox(savedRailList)
        && savedRailRect
        && savedRailHeadRect
        && savedRailActionsRect
        && savedRailListRect
        && savedRailActionsRect.top <= savedRailHeadRect.bottom + 18
        && savedRailListRect.top <= savedRailActionsRect.bottom + 22
        && savedRailListRect.top < savedRailRect.bottom);
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
      let rackSizeLabel = (document.querySelector('[data-qa="nam-footer-size"]')?.textContent || '').replace(/\s+/g, ' ').trim();
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
      if (!rackSizeLabel) {
        rackSizeLabel = (designPortHost?.querySelector('.footer')?.textContent || '').replace(/\s+/g, ' ').trim();
      }
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
          compressor: { x: 5, y: 42, w: 156, h: 232 },
          'tape-echo': { x: 171, y: 42, w: 156, h: 232 },
          octaver: { x: 337, y: 42, w: 120, h: 232 },
          'precision-drive': { x: 467, y: 42, w: 120, h: 232 },
          distortion: { x: 597, y: 42, w: 156, h: 232 },
        },
        amp: {
          'amp-head': { x: 24, y: -2, w: 720, h: 345 },
        },
        cab: {
          'mic-panel': { x: 54, y: -30, w: 660, h: 402 },
        },
        eq: {
          'eq-rack': { x: 24, y: 20, w: 720, h: 300 },
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
      const eqLaneAlignmentFailures = !designEqModule ? [] : Array.from(designEqModule.querySelectorAll('.eq-band')).flatMap((lane) => {
        const fader = lane.querySelector('.fader[data-param-id]');
        const value = lane.querySelector('.eq-band-value');
        const label = lane.querySelector('.eq-frequency');
        if (!fader || !value || !label || !visibleBox(fader) || !visibleBox(value) || !visibleBox(label)) return ['eq-lane:missing'];
        const faderRect = fader.getBoundingClientRect();
        const faderCenter = faderRect.left + faderRect.width / 2;
        const valueRect = value.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const centerError = Math.max(
          Math.abs(faderCenter - (valueRect.left + valueRect.width / 2)),
          Math.abs(faderCenter - (labelRect.left + labelRect.width / 2)),
        );
        const collision = valueRect.bottom > faderRect.top - 3 || labelRect.top < faderRect.bottom + 3;
        return centerError > 2 || collision
          ? [(fader.getAttribute('data-param-id') || 'eq-lane') + ':center=' + centerError.toFixed(2) + ',collision=' + collision]
          : [];
      });
      const headerShell = designPortHost?.querySelector('.premium-nam-shell');
      const headerUtility = designPortHost?.querySelector('.premium-routing-utility');
      const headerPreset = designPortHost?.querySelector('.preset-console');
      const headerInstrument = designPortHost?.querySelector('.premium-instrument-choice');
      const headerDoubler = designPortHost?.querySelector('.premium-doubler-utility');
      const headerPresetTitle = designPortHost?.querySelector('.preset-console > .preset-title');
      const headerBrand = designPortHost?.querySelector('.premium-brand');
      const headerCalibration = designPortHost?.querySelector('[data-qa="nam-premium-calibration"]');
      const headerInputBlock = designPortHost?.querySelector('.global-block.left');
      const headerOutputBlock = designPortHost?.querySelector('.global-block.right');
      const headerInputPeakMeter = headerInputBlock?.querySelector('.premium-level-meter');
      const headerOutputPeakMeter = headerOutputBlock?.querySelector('.premium-level-meter');
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
        brand: centerMetric(headerBrand),
        calibration: centerMetric(headerCalibration),
        input: centerMetric(headerInputBlock),
        output: centerMetric(headerOutputBlock),
        inputPeakMeter: centerMetric(headerInputPeakMeter),
        outputPeakMeter: centerMetric(headerOutputPeakMeter),
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
          headerGeometry.brand,
          headerGeometry.calibration,
          headerGeometry.input,
          headerGeometry.output,
        ];
        if (requiredHeaderGeometry.some((metric) => !metric)) {
          headerGeometryFailures.push('header-geometry:missing');
        } else {
          const shellCenter = headerGeometry.shell.centerX;
           const centerChecks = [
            ['brand', headerGeometry.brand.centerX],
             ['utility', headerGeometry.utility.centerX],
             ['preset', headerGeometry.preset.centerX],
             ['title', headerGeometry.title.centerX],
          ];
          centerChecks.forEach(([name, center]) => {
            const delta = Math.abs(center - shellCenter);
            if (delta > 1.25) headerGeometryFailures.push(name + '-center-delta=' + delta.toFixed(2));
          });
          if (headerGeometry.utility.width > headerGeometry.preset.width - 8) {
            headerGeometryFailures.push('utility-not-narrower-than-preset=' + (headerGeometry.preset.width - headerGeometry.utility.width).toFixed(2));
          }
          if (headerGeometry.utilityCardClasses.length !== 2
            || !headerGeometry.utilityCardClasses.includes('premium-instrument-choice')
            || !headerGeometry.utilityCardClasses.includes('premium-doubler-utility')) {
            headerGeometryFailures.push('utility-card-contract=' + headerGeometry.utilityCardClasses.join(','));
          }
          if (headerGeometry.processingPresent) headerGeometryFailures.push('processing-card-present');
          if (headerGeometry.physicalSourcePresent) headerGeometryFailures.push('physical-source-present');
          const utilityCardRatio = headerGeometry.doubler.width / headerGeometry.instrument.width;
          const expectedUtilityCardRatio = 1.18 / .82;
          if (Math.abs(utilityCardRatio - expectedUtilityCardRatio) > .03) {
            headerGeometryFailures.push('utility-card-ratio=' + utilityCardRatio.toFixed(3));
          }
          if (headerGeometry.instrument.width < 300) {
            headerGeometryFailures.push('instrument-card-min-width=' + headerGeometry.instrument.width.toFixed(2));
          }
          if (headerGeometry.doubler.width < 430) {
            headerGeometryFailures.push('doubler-card-min-width=' + headerGeometry.doubler.width.toFixed(2));
          }
          const metricInside = (metric, container, padding = 0) => Boolean(metric && container
            && metric.left >= container.left + padding - 1
            && metric.right <= container.right - padding + 1
            && metric.top >= container.top + padding - 1
            && metric.bottom <= container.bottom - padding + 1);
          if (!metricInside(headerGeometry.utility, headerGeometry.shell)) headerGeometryFailures.push('utility-shell-overflow');
          if (!metricInside(headerGeometry.preset, headerGeometry.shell)) headerGeometryFailures.push('preset-shell-overflow');
          if (window.innerWidth >= 1264) {
            const calOutputCenterDelta = Math.abs(headerGeometry.calibration.centerX - headerGeometry.output.centerX);
            const calOutputWidthDelta = Math.abs(headerGeometry.calibration.width - headerGeometry.output.width);
            if (calOutputCenterDelta > 1.25) headerGeometryFailures.push('cal-output-center-delta=' + calOutputCenterDelta.toFixed(2));
            if (calOutputWidthDelta > 1.25) headerGeometryFailures.push('cal-output-width-delta=' + calOutputWidthDelta.toFixed(2));
          } else {
            const calOutputGap = headerGeometry.output.left - headerGeometry.calibration.right;
            if (calOutputGap < 4 || calOutputGap > 48) headerGeometryFailures.push('cal-output-gap=' + calOutputGap.toFixed(2));
          }

          const intersects = (left, right) => {
            if (!left || !right || !visibleBox(left) || !visibleBox(right)) return false;
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          };
          const headerChrome = [headerBrand, headerCalibration, headerInputBlock, headerOutputBlock].filter(Boolean);
          headerChrome.forEach((node) => {
            const name = node.classList.contains('premium-brand')
              ? 'brand'
              : node.classList.contains('premium-calibration-launch') ? 'cal'
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
        pre: ['stompbox-body-blue-wide', 'stompbox-body-olive', 'stompbox-body-dark-wide', 'stompbox-body-red-wide', 'stompbox-body-stone'],
        amp: ['amp-head-body'],
        cab: ['cab-room-integrated-body'],
        eq: ['rack-unit-body-deep'],
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
      const rackOldPbrSceneImages = Array.from(document.querySelectorAll('.nam-stage-hero .nam-scene-skin-image'))
        .filter((el) => visibleBox(el));
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
      const rackFontFloorFailures = rackFontElements
        .filter((el) => {
          const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
          return Number.isFinite(fontSize) && fontSize > 0 && fontSize < 7;
        })
        .map((el) => {
          const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
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
        rackFinalParityTokens,
        rackFinalParityChrome,
        rackVisualPolishTokens,
        rackVisualPolishApplied,
        hardwareDialTokens,
        railArtTokens,
        railArtReadable,
        stageFillTokens,
        stageArtTokens,
        stageFrameFillMetrics,
        stageFrameNoVerticalCutoff,
        stageFrameFillReady,
        modeRailWidthMatchesFinalToken,
        rightExplorerWidthMatchesFinalToken,
        stageGapMatchesFinalToken,
        stageFrameMatchesReferenceAspect,
        stageFooterHeightMatchesFinalToken,
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
        neuralShell,
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
        hasCabRoom: Boolean(document.querySelector('.nam-cab-room')),
        hasCabRail: Boolean(cabRail),
        cabRailCompactLayout,
        hasSavedRail: Boolean(savedRail),
        savedRailCompactLayout,
        hasSaveToneModal: Boolean(visibleBox(saveToneModal)),
        saveToneFormReadable: Boolean(visibleBox(saveToneForm) && saveToneFields.length >= 9),
        saveToneFooterButtons,
        hasNAMRackPrompt: Boolean(visibleBox(namRackPrompt)),
        namRackPromptButtons,
        hasChainDragOverlay: Boolean(chainDragOverlay),
        hasSettingsModeButton: Boolean(document.querySelector('[data-qa="nam-mode-settings"]')),
        hasFxHardware: Boolean(document.querySelector('.nam-fx-hardware')),
        fxHardware: {
          module: fxModule,
          faceplateVisible: visibleBox(fxFaceplate),
          artVisible: visibleBox(fxFaceplateArt),
          knobDeckPosition: fxKnobDeckStyle?.position || '',
          knobCount: fxKnobs.length,
          controlsIntegrated: fxControlsIntegrated,
          knobMetrics: fxKnobMetrics,
          footswitchInsideFaceplate: !fxFootswitch || rectInside(fxFootswitch.getBoundingClientRect(), fxFaceplateRect, 3),
        },
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
          oldPbrSceneImageCount: rackOldPbrSceneImages.length,
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
          eqLaneAlignmentFailures,
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
        ampHardware,
        statusLabels,
        statusItems,
        statusValues,
        statusMeterLabels,
        statusRailRowsFit,
        statusRailReferenceSplit,
        extraStatusLabels,
        hasRealtimeTelemetryRail: requiredStatusLabels.every((label) => statusLabels.includes(label))
          && extraStatusLabels.length === 0,
        modeRailIconClasses,
        modeRailReferenceIcons,
        modeRailButtonMetrics,
        modeRailActiveLabels,
        modeRailReferenceActiveState,
        modeRailReferenceButtonSizing,
        statusRailBoxed,
        railLivePagerVisible: visibleBox(railLivePager),
        railLivePagerText,
        railLivePagerAnchoredBottom,
        railFooterReferenceLayout,
        railNewTagTexts,
        railTransientSummaryHidden,
        railRowsHaveQuickActions,
        railRowsShowStats,
        railResultCardMetrics,
        railResultRowsCompact: visibleRailResultCards.length > 0
          && visibleRailResultCards.every((card) => card.height <= 100),
        railResultRowsClearFooter,
        railWholeRowsVisible,
        forbiddenNormalWords,
        rawWords,
        activeForbiddenTerms,
        stageChrome: {
          rects: {
            chain: chainRect ? {
              top: Number(chainRect.top.toFixed(1)),
              right: Number(chainRect.right.toFixed(1)),
              bottom: Number(chainRect.bottom.toFixed(1)),
              height: Number(chainRect.height.toFixed(1)),
            } : null,
            stageHero: stageHeroRect ? {
              top: Number(stageHeroRect.top.toFixed(1)),
              right: Number(stageHeroRect.right.toFixed(1)),
              bottom: Number(stageHeroRect.bottom.toFixed(1)),
              height: Number(stageHeroRect.height.toFixed(1)),
            } : null,
            rightRail: rightRailRect ? {
              top: Number(rightRailRect.top.toFixed(1)),
              left: Number(rightRailRect.left.toFixed(1)),
              bottom: Number(rightRailRect.bottom.toFixed(1)),
              height: Number(rightRailRect.height.toFixed(1)),
            } : null,
            modeRail: modeRailRect ? {
              top: Number(modeRailRect.top.toFixed(1)),
              left: Number(modeRailRect.left.toFixed(1)),
              bottom: Number(modeRailRect.bottom.toFixed(1)),
              width: Number(modeRailRect.width.toFixed(1)),
              height: Number(modeRailRect.height.toFixed(1)),
            } : null,
          },
          chainHeight: chainRect?.height ?? 0,
          chainReservedForRail: Boolean(chainRect && stageHeroRect && chainRect.right <= stageHeroRect.right + 4),
          stageHeaderVisible: visibleBox(stageHeader),
          ampToplineVisible: visibleBox(ampTopline),
          rightRailSideBySide,
          rightRailReferenceTop: window.innerWidth >= 1100 ? desktopReferenceRailTop : compactReferenceRailTop,
          compactStackedRailLayout,
          modeRailReferenceWidth,
          modeRailViewportFit,
          rightExplorerViewportFit,
          stageFooterVisible: visibleBox(stageFooter),
          stageFooterHeight: stageFooterRect?.height ?? 0,
        },
        hasVisibleRailSortLabel: visibleBox(railSortLabel) && (railSortLabel.textContent || '').trim().toLowerCase() === 'sort by',
        hasCustomRailSortMenu: visibleBox(railSortTrigger) && !railSortNativeSelect,
        railSortReferenceLayout,
        railViewToggleReferencePair,
        railViewToggleButtonStates,
        railSortMenuOpen: visibleBox(railSortPopover),
        headerPresetManagerHidden: !visibleBox(headerPresetManagerAction),
        railSortOptionLabels,
        stageFooterLeftText,
        stageFooterRightText,
        stageFooterReferenceGroups,
        stageFooterReferenceHeight,
        stageFooterControls,
        stageFooterControlsReady: ['nam-footer-lock', 'nam-footer-size', 'nam-footer-fullscreen']
          .every((qa) => stageFooterControls.some((item) => item.qa === qa && item.visible && !item.disabled))
          && ['nam-footer-zoom', 'nam-footer-tap-tempo', 'nam-footer-snap', 'nam-footer-fit']
            .every((qa) => !stageFooterControls.some((item) => item.qa === qa && item.visible)),
        footerSizeMenu: {
          triggerVisible: visibleBox(footerSizeTrigger),
          popoverVisible: visibleBox(footerSizePopover),
          optionLabels: footerSizeOptionLabels,
          optionCount: footerSizeOptionLabels.length,
        },
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
          if (scenario.name === "rack-chain") {
            item.interaction = await runInteractionProbe(cdp);
          }
          if (scenario.name === "source-amp-audition-click") {
            item.interaction = await runSourceAmpAuditionProbe(cdp);
          }
          if (scenario.name === "rack-cab") {
            await openRightRailTab(cdp, "Cab/IR");
          }
          if (scenario.name === "rack-saved") {
            await openRightRailTab(cdp, "Saved");
          }
          if (scenario.name === "rack-sort-open") {
            await openRailSortMenu(cdp);
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
            await openFooterSizeMenu(cdp);
          }
          if (scenario.name === "mixer") {
            await selectMixerStage(cdp, "reverb");
          }
          if (scenario.name.startsWith("rack-neural-")) {
            await waitForDesignPort(cdp);
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
          } else if (scenario.name === "rack" || scenario.name.startsWith("rack-neural-") || scenario.name === "rack-tuner" || scenario.name === "rack-calibration") {
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
              && rackMain.oldPbrSceneImageCount === 0
              && (rackMain.section !== "post" || rackMain.reverbFixedControls?.ready === true)
              && (rackMain.section !== "post" || (
                (rackMain.postKnobLabelGapFailures || []).length === 0
                && (rackMain.postVisibleControlContainmentFailures || []).length === 0
                && (rackMain.postPrimaryHardwareFailures || []).length === 0
              ))
              && (rackMain.section !== "eq" || (
                (rackMain.eqFaderParamIds || []).length === 10
                && rackMain.eqFaderParamIds.includes("eqLevelDb")
                && (rackMain.eqLaneAlignmentFailures || []).length === 0
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
                item.checks.footerSizeMenu?.triggerVisible === true
                && item.checks.footerSizeMenu?.popoverVisible === true
                && item.checks.footerSizeMenu?.optionLabels?.some((label) => label.includes('Maximum'))
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
              && item.checks.hasSettingsModeButton === false
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
              && (scenario.name !== "rack-cab" || (
                item.checks.hasCabRoom === true
                && item.checks.hasCabRail === true
                && (item.checks.viewport.width < 1100
                  ? item.checks.stageChrome?.compactStackedRailLayout === true
                  : item.checks.cabRailCompactLayout === true)
              ))
              && (scenario.name !== "rack-saved" || (
                item.checks.hasSavedRail === true
                && (item.checks.viewport.width < 1100
                  ? item.checks.stageChrome?.compactStackedRailLayout === true
                  : item.checks.savedRailCompactLayout === true)
              ))
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
              && (scenario.name !== "rack-sort-open" || (
                item.checks.railSortMenuOpen === true
                && item.checks.railSortOptionLabels?.includes('Newest')
                && item.checks.railSortOptionLabels?.includes('Trending')
                && item.checks.railSortOptionLabels?.includes('Most Downloaded')
                && item.checks.railSortOptionLabels?.includes('Most Liked')
                && item.checks.railSortOptionLabels?.includes('Name A-Z')
              ))
              && (!["rack-gate", "rack-pedal", "rack-eq", "rack-delay", "rack-chain", "rack-mod", "rack-reverb"].includes(scenario.name) || (
                item.checks.hasFxHardware === true
                && item.checks.fxHardware?.controlsIntegrated === true
              ))
              && (scenario.name !== "rack" || (
                item.checks.ampHardware?.hasFrame === true
                && item.checks.ampHardware?.frameRatio > 1.72
                && item.checks.ampHardware?.frameRatio < 1.84
                && item.checks.ampHardware?.hasSplitStackArt === true
                && item.checks.ampHardware?.splitArtDesignBand === true
                && item.checks.ampHardware?.hasHardwareSceneCoordinates === true
                && item.checks.ampHardware?.hasHardwareAssetTreatment === true
                && item.checks.ampHardware?.hasToggle === true
                && item.checks.ampHardware?.toggleInside === true
                && item.checks.ampHardware?.toggleInFaceplateZone === true
                && item.checks.ampHardware?.knobCount >= 5
                && item.checks.ampHardware?.knobsInside === true
                && item.checks.ampHardware?.hardwareDialCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialsVisible === true
                && item.checks.ampHardware?.hardwareDialMinSize >= 34
                && item.checks.ampHardware?.hardwareDialNumberCount >= item.checks.ampHardware?.knobCount * 11
                && item.checks.ampHardware?.hardwareDialNumbersVisible === true
                && item.checks.ampHardware?.hardwareDialTickCount >= item.checks.ampHardware?.knobCount * 41
                && item.checks.ampHardware?.hardwareDialTickStrokeReady === true
                && item.checks.hardwareDialTokens?.ready === true
                && item.checks.ampHardware?.hardwareDialVersionContract === true
                && item.checks.ampHardware?.hardwareDialScaleTrackCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialScaleTrackReady === true
                && item.checks.ampHardware?.hardwareDialOuterRimCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialOuterRimReady === true
                && item.checks.ampHardware?.hardwareDialGripCount >= item.checks.ampHardware?.knobCount * 36
                && item.checks.ampHardware?.hardwareDialGripStrokeReady === true
                && item.checks.ampHardware?.hardwareDialCapHighlightCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialCapHighlightReady === true
                && item.checks.ampHardware?.hardwareDialIndicatorShadowCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialIndicatorShadowReady === true
                && item.checks.ampHardware?.hardwareDialIndicatorTipCount >= item.checks.ampHardware?.knobCount
                && item.checks.ampHardware?.hardwareDialIndicatorTipReady === true
                && item.checks.ampHardware?.knobRendererContract === true
                && item.checks.ampHardware?.knobLabelsVisible === true
                && item.checks.ampHardware?.knobValueReadoutsHidden === true
                && item.checks.ampHardware?.hardwareNameplateCount >= 2
                && item.checks.ampHardware?.hardwareNameplatesVisible === true
                && item.checks.ampHardware?.hardwareNameplatesPhysical === true
                && item.checks.ampHardware?.hardwareNameplatesDesignBand === true
                && item.checks.ampHardware?.hardwareNameplateTexts?.includes('Clean Twin-style')
                && item.checks.ampHardware?.hardwareNameplateTexts?.includes('2x12 Blackface')
                && item.checks.ampHardware?.hardwareNameplateAriaLabels?.includes('Amp model: Clean Twin-style')
                && item.checks.ampHardware?.hardwareNameplateAriaLabels?.includes('Cabinet: 2x12 Blackface')
                && item.checks.ampHardware?.legacyAmpBadgesVisible === false
                && item.checks.chainCardsNeutralWhenActive === true
                && item.checks.selectedChainCardAmber === true
                && item.checks.headerMeterReadouts?.includes('-4.2 dB')
                && item.checks.headerMeterReadouts?.includes('-3.1 dB')
                && item.checks.headerTrimReadoutChipsVisible === true
                && item.checks.rackFinalParityTokens?.ready === true
                && item.checks.rackFinalParityChrome === true
                && item.checks.rackVisualPolishTokens?.ready === true
                && item.checks.rackVisualPolishApplied === true
                && item.checks.stageFillTokens?.ready === true
                && item.checks.stageArtTokens?.ready === true
                && item.checks.stageFrameNoVerticalCutoff === true
                && item.checks.stageFrameFillReady === true
                && item.checks.headerCompareLabelsClean === true
                && item.checks.headerPresetSelectIconHidden === true
                && item.checks.headerUtilityReferenceIcons === true
                && item.checks.headerLibraryActiveQuiet === true
                && item.checks.hasRealtimeTelemetryRail === true
                && item.checks.modeRailReferenceIcons === true
                && item.checks.modeRailReferenceActiveState === true
                && item.checks.modeRailReferenceButtonSizing === true
                && item.checks.statusValues?.SR === '48 kHz'
                && item.checks.statusValues?.Buffer === '128 smp'
                && (!Object.prototype.hasOwnProperty.call(item.checks.statusValues || {}, 'CPU')
                  || item.checks.statusValues?.CPU === '18%')
                && item.checks.statusValues?.DSP === '24%'
                && item.checks.statusValues?.Latency === '2.7 ms'
                && (!Object.prototype.hasOwnProperty.call(item.checks.statusValues || {}, 'CPU')
                  || item.checks.statusMeterLabels?.includes('CPU'))
                && item.checks.statusMeterLabels?.includes('DSP')
                && item.checks.statusRailRowsFit === true
                && item.checks.statusRailReferenceSplit === true
                && item.checks.statusRailBoxed === true
                && item.checks.stageChrome?.modeRailReferenceWidth === true
                && item.checks.stageChrome?.modeRailViewportFit === true
                && item.checks.stageChrome?.rightExplorerViewportFit === true
                && item.checks.extraStatusLabels?.length === 0
                && item.checks.hasVisibleRailSortLabel === true
                && item.checks.hasCustomRailSortMenu === true
                && item.checks.railSortReferenceLayout === true
                && item.checks.railViewToggleReferencePair === true
                && item.checks.headerPresetManagerHidden === true
                && item.checks.stageFooterControlsReady === true
                && item.checks.stageFooterReferenceGroups === true
                && item.checks.stageFooterReferenceHeight === true
                && item.checks.railLivePagerVisible === true
                && item.checks.railLivePagerAnchoredBottom === true
                && item.checks.railFooterReferenceLayout === true
                && item.checks.railNewTagTexts?.length >= 1
                && item.checks.railTransientSummaryHidden === true
                && item.checks.railRowsHaveQuickActions === true
                && item.checks.railRowsShowStats === true
                && item.checks.railArtTokens?.ready === true
                && item.checks.railArtReadable === true
                && item.checks.railResultRowsCompact === true
                && (item.checks.viewport.width < 1100 || item.checks.railResultRowsClearFooter === true)
                && (item.checks.viewport.width < 1100 || item.checks.railWholeRowsVisible >= (item.checks.viewport.width <= 1400 ? 3 : 4))
                && item.checks.selectedChainTextFits === true
                && item.checks.chainActionsHiddenAtRest === true
                && item.checks.stageChrome?.stageHeaderVisible === false
                && item.checks.stageChrome?.ampToplineVisible === false
                && item.checks.stageChrome?.stageFooterVisible === true
                && (item.checks.viewport.width < 1100 ? item.checks.stageChrome?.compactStackedRailLayout === true : (
                  item.checks.stageChrome?.rightRailSideBySide === true
                  && item.checks.stageChrome?.rightRailReferenceTop === true
                ))
              ))
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
