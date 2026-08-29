import { expect, test, type Page } from "@playwright/test";
import {
  faceplateControlHitRect,
  faceplateControlVisualRect,
  NAM_AMP_V4_FACEPLATE,
  NAM_EQ_V4_FACEPLATE,
  type FaceplateManifest,
} from "../src/components/namRackFaceplateGeometry";

const NAM_ADDRESS = {
  trackId: "nam-approved-surface-qa",
  chain: "track",
  fxIndex: 0,
} as const;

const PRE_EQ_PARAM_IDS = [
  "preEqEnabled",
  "preEq120Db",
  "preEq250Db",
  "preEq500Db",
  "preEq1kDb",
  "preEq2k5Db",
  "preEq5kDb",
  "preEq8kDb",
  "preEq12kDb",
  "preEqHPFHz",
  "preEqLPFHz",
] as const;

const DRIVE_PARAM_IDS = [
  "precisionDriveEnabled",
  "precisionDriveDrive",
  "precisionDriveVolumeDb",
  "precisionDriveBright",
  "precisionDriveAttack",
  "precisionDriveGate",
] as const;

const AMP_PARAM_IDS = [
  "ampEnabled",
  "ampBoost",
  "ampVoice",
  "ampGainDb",
  "bassDb",
  "midDb",
  "trebleDb",
  "presenceDb",
  "ampMix",
  "ampOutputDb",
] as const;

const POST_EQ_BAND_IDS = [
  "eq65Db",
  "eq125Db",
  "eq250Db",
  "eq500Db",
  "eq1kDb",
  "eq2kDb",
  "eq4kDb",
  "eq8kDb",
  "eq16kDb",
] as const;

const POST_EQ_PARAM_IDS = [
  "eqEnabled",
  ...POST_EQ_BAND_IDS,
  "eqHPFHz",
  "eqLevelDb",
  "eqLPFHz",
] as const;

type RackSection = "pre" | "amp" | "eq";

function rackUrl(section: RackSection) {
  const focus = section === "pre" ? "gate" : section;
  const session = {
    address: NAM_ADDRESS,
    title: "OpenStudio NAM Rack",
    fallbackName: "OpenStudio NAM Rack",
  };
  const params = new URLSearchParams({
    window: "pluginEditor",
    platform: "windows",
    windowChrome: "native",
    mockPlugin: "nam",
    sessionId: JSON.stringify(session),
    namView: "rack",
    namFocus: focus,
    namSection: section,
  });
  return `/?${params.toString()}`;
}

async function openRackSection(page: Page, section: RackSection) {
  await page.goto(rackUrl(section));
  const host = page.locator(
    `.nam-rack-design-port.nam-native-design-surface[data-design-section="${section}"]`,
  );
  // The detached editor is bootstrapped through a dynamic import. On a cold
  // Windows CI worker Vite can need longer than Playwright's 5 s assertion
  // default to transform the full NAM Rack surface before its host mounts.
  await expect(host).toBeVisible({ timeout: 15_000 });
  await expect(host.locator(".nam-rack-artboard")).toBeVisible();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>(
        ".nam-rack-design-port [data-rack-design-asset-kind]",
      ),
    );
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
      }
      if (typeof image.decode === "function") await image.decode().catch(() => undefined);
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  return host;
}

async function readRackValues(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    const state = await nativeBridge.getBuiltInPluginState(address);
    return state?.values ?? {};
  }, NAM_ADDRESS);
}

async function interactiveParamIds(page: Page, moduleId: string) {
  return page.locator(`[data-module="${moduleId}"]`).evaluate((module) => (
    Array.from(module.querySelectorAll<HTMLElement>("[data-param-id][role]"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden"
          && node.getAttribute("aria-disabled") !== "true";
      })
      .map((node) => node.dataset.paramId ?? "")
      .filter(Boolean)
      .sort()
  ));
}

async function surfaceGeometryFailures(page: Page, moduleId: string) {
  return page.locator(`[data-module="${moduleId}"]`).evaluate((module) => {
    const visible = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const overlapArea = (left: DOMRect, right: DOMRect) => (
      Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
      * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
    );
    const moduleRect = module.getBoundingClientRect();
    const interactive = Array.from(
      module.querySelectorAll<HTMLElement>("[data-param-id][role]"),
    ).filter(visible);
    const visibleSubjects = Array.from(module.querySelectorAll<HTMLElement>(
      ".asset-control, .label, .module-title, .module-display, .fader, [data-param-id][role]",
    )).filter(visible);
    const labels = Array.from(
      module.querySelectorAll<HTMLElement>(".label, .module-title"),
    ).filter(visible);
    const containment: string[] = [];
    const hitOverlaps: string[] = [];
    const labelOverlaps: string[] = [];
    const textOverflow: string[] = [];

    for (const node of visibleSubjects) {
      const rect = node.getBoundingClientRect();
      if (rect.left < moduleRect.left - 1
          || rect.top < moduleRect.top - 1
          || rect.right > moduleRect.right + 1
          || rect.bottom > moduleRect.bottom + 1) {
        containment.push(
          node.dataset.paramId
          ?? node.textContent?.replace(/\s+/g, " ").trim()
          ?? node.className,
        );
      }
    }
    for (let leftIndex = 0; leftIndex < interactive.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < interactive.length; rightIndex += 1) {
        const area = overlapArea(
          interactive[leftIndex].getBoundingClientRect(),
          interactive[rightIndex].getBoundingClientRect(),
        );
        if (area > 0.5) {
          hitOverlaps.push(
            `${interactive[leftIndex].dataset.paramId}:${interactive[rightIndex].dataset.paramId}:${area.toFixed(2)}`,
          );
        }
      }
    }
    for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
      if (labels[leftIndex].scrollWidth > labels[leftIndex].clientWidth + 1
          || labels[leftIndex].scrollHeight > labels[leftIndex].clientHeight + 1) {
        textOverflow.push(labels[leftIndex].textContent?.replace(/\s+/g, " ").trim() ?? "label");
      }
      for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
        const area = overlapArea(
          labels[leftIndex].getBoundingClientRect(),
          labels[rightIndex].getBoundingClientRect(),
        );
        if (area > 0.5) {
          labelOverlaps.push(
            `${labels[leftIndex].textContent?.trim()}:${labels[rightIndex].textContent?.trim()}:${area.toFixed(2)}`,
          );
        }
      }
    }
    return { containment, hitOverlaps, labelOverlaps, textOverflow };
  });
}

async function manifestProjectionFailures(
  page: Page,
  moduleId: string,
  manifest: FaceplateManifest,
  ignoredControlIds: readonly string[] = [],
) {
  const ignored = new Set(ignoredControlIds);
  const controls = manifest.controls
    .filter(({ id }) => !ignored.has(id))
    .map((control) => ({
      id: control.id,
      paramId: control.paramId,
      kind: control.kind,
      hit: faceplateControlHitRect(control),
      visual: faceplateControlVisualRect(control),
    }));
  return page.locator(`[data-module="${moduleId}"]`).evaluate(
    (module, contract) => {
      const frameNode = module.querySelector<HTMLElement>(".module-frame");
      const frame = frameNode?.getBoundingClientRect();
      if (!frame || !frameNode) return ["missing-module-frame"];
      const scaleX = frame.width / contract.assetSize.width;
      const scaleY = frame.height / contract.assetSize.height;
      const cssToViewportX = frame.width / Math.max(frameNode.offsetWidth, 1);
      const cssToViewportY = frame.height / Math.max(frameNode.offsetHeight, 1);
      const alpha = {
        left: frame.left + contract.visibleAlpha.x * scaleX,
        top: frame.top + contract.visibleAlpha.y * scaleY,
        right: frame.left + (contract.visibleAlpha.x + contract.visibleAlpha.width) * scaleX,
        bottom: frame.top + (contract.visibleAlpha.y + contract.visibleAlpha.height) * scaleY,
      };
      const failures: string[] = [];
      for (const expected of contract.controls) {
        const candidates = Array.from(
          module.querySelectorAll<HTMLElement>(`[data-param-id="${expected.paramId}"][role]`),
        );
        const node = candidates.find((candidate) => {
          if (expected.kind === "fader") return candidate.classList.contains("fader");
          return !candidate.classList.contains("fader");
        });
        if (!node) {
          failures.push(`${expected.id}:missing-hit`);
          continue;
        }
        const actual = node.getBoundingClientRect();
        const target = {
          left: frame.left + expected.hit.x * scaleX,
          top: frame.top + expected.hit.y * scaleY,
          width: expected.hit.width * scaleX,
          height: expected.hit.height * scaleY,
        };
        const centreDelta = Math.hypot(
          actual.left + actual.width / 2 - (target.left + target.width / 2),
          actual.top + actual.height / 2 - (target.top + target.height / 2),
        );
        if (centreDelta > 1.1
            || Math.abs(actual.width - target.width) > 1.1
            || Math.abs(actual.height - target.height) > 1.1) {
          failures.push(`${expected.id}:hit-geometry`);
        }
        if (actual.left < alpha.left - 1
            || actual.top < alpha.top - 1
            || actual.right > alpha.right + 1
            || actual.bottom > alpha.bottom + 1) {
          failures.push(`${expected.id}:hit-outside-painted-enclosure`);
        }

        if (expected.kind !== "fader") {
          let artwork = node.nextElementSibling as HTMLElement | null;
          while (artwork && !artwork.classList.contains("asset-control")) {
            artwork = artwork.nextElementSibling as HTMLElement | null;
          }
          if (!artwork) {
            failures.push(`${expected.id}:missing-artwork`);
            continue;
          }
          const artRect = artwork.getBoundingClientRect();
          const artStyle = getComputedStyle(artwork);
          const untransformedWidth = Number.parseFloat(artStyle.width) * cssToViewportX;
          const untransformedHeight = Number.parseFloat(artStyle.height) * cssToViewportY;
          const visualTarget = {
            left: frame.left + expected.visual.x * scaleX,
            top: frame.top + expected.visual.y * scaleY,
            width: expected.visual.width * scaleX,
            height: expected.visual.height * scaleY,
          };
          const visualCentreDelta = Math.hypot(
            artRect.left + artRect.width / 2 - (visualTarget.left + visualTarget.width / 2),
            artRect.top + artRect.height / 2 - (visualTarget.top + visualTarget.height / 2),
          );
          if (visualCentreDelta > 1.1
              || Math.abs(untransformedWidth - visualTarget.width) > 1.1
              || Math.abs(untransformedHeight - visualTarget.height) > 1.1) {
            failures.push(
              `${expected.id}:artwork-geometry:`
              + `${visualCentreDelta.toFixed(2)}:`
              + `${untransformedWidth.toFixed(2)}x${untransformedHeight.toFixed(2)}:`
              + `${visualTarget.width.toFixed(2)}x${visualTarget.height.toFixed(2)}`,
            );
          }
          if (artRect.left < alpha.left - 1
              || artRect.top < alpha.top - 1
              || artRect.right > alpha.right + 1
              || artRect.bottom > alpha.bottom + 1) {
            failures.push(`${expected.id}:artwork-outside-painted-enclosure`);
          }
        }
      }
      return failures;
    },
    {
      assetSize: manifest.assetSize,
      visibleAlpha: manifest.visibleAlphaBounds,
      controls,
    },
  );
}

test("approved Amp uses one control deck and retains all ten wrapper parameters", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const host = await openRackSection(page, "amp");
  const module = host.locator('[data-module="amp-head"]');

  expect(await interactiveParamIds(page, "amp-head"))
    .toEqual([...AMP_PARAM_IDS].sort());
  expect(await surfaceGeometryFailures(page, "amp-head")).toEqual({
    containment: [],
    hitOverlaps: [],
    labelOverlaps: [],
    textOverflow: [],
  });

  const row = await module.locator("[data-param-id][role]").evaluateAll((nodes) => {
    const centers = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return {
      count: centers.length,
      spread: Math.max(...centers) - Math.min(...centers),
    };
  });
  expect(row).toEqual({ count: 10, spread: expect.any(Number) });
  expect(row.spread).toBeLessThanOrEqual(2);
  await expect(module).not.toContainText(/\b(?:POST|MASTER)\b/i);
  await expect(module.locator(".amp-gain-label-overlay")).toHaveCount(0);
  await expect(module.locator('.module-skin[data-rack-design-asset-id="amp-head-body-v5"]'))
    .toHaveCount(1);
  const ampStatusLeds = module.locator(
    '.asset-control.led[data-param-id][data-nam-exact-size-variant="panel-led"]',
  );
  await expect(ampStatusLeds).toHaveCount(3);
  for (const paramId of ["ampEnabled", "ampBoost", "ampVoice"] as const) {
    const toggle = module.locator(`[data-param-id="${paramId}"][role="switch"]`);
    const toggleArtwork = module.locator(
      `.asset-control.toggle[data-param-id="${paramId}"]`,
    );
    const led = module.locator(`.asset-control.led[data-param-id="${paramId}"]`);
    await expect(toggle).toHaveCount(1);
    await expect(toggleArtwork).toHaveCount(1);
    await expect(led).toHaveCount(1);
    const placement = await Promise.all([
      toggleArtwork.boundingBox(),
      led.boundingBox(),
    ]);
    expect(placement[0]).not.toBeNull();
    expect(placement[1]).not.toBeNull();
    expect(
      Math.abs(
        placement[0]!.x + placement[0]!.width / 2
          - (placement[1]!.x + placement[1]!.width / 2),
      ),
    ).toBeLessThanOrEqual(1);
    expect(placement[1]!.y + placement[1]!.height).toBeLessThan(placement[0]!.y);
  }
  await expect(module.locator('[data-param-id="ampGainDb"][role="slider"]'))
    .toHaveAttribute("aria-label", /Capture Gain/i);

  const tight = module.locator('[data-param-id="ampBoost"][role="switch"]');
  await expect(tight).toHaveAttribute("aria-checked", "false");
  await expect(module.locator('.asset-control.led[data-param-id="ampBoost"]'))
    .toHaveAttribute("data-rack-design-asset-id", "led-amber-off-panel-v4");
  await tight.focus();
  await page.keyboard.press("Enter");
  await expect(tight).toHaveAttribute("aria-checked", "true");
  await expect(module.locator('.asset-control.led[data-param-id="ampBoost"]'))
    .toHaveAttribute("data-rack-design-asset-id", "led-amber-on-panel-v4");

  const bass = module.locator('[data-param-id="bassDb"][role="slider"]');
  await bass.focus();
  await page.keyboard.press("End");
  await expect(bass).toHaveAttribute("aria-valuenow", "12");
  await expect.poll(async () => (await readRackValues(page)).ampBoost).toBe(1);
  await expect.poll(async () => (await readRackValues(page)).bassDb).toBe(12);
});

test("approved post-cab EQ has nine faders and a three-rotary utility tier", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const host = await openRackSection(page, "eq");
  const module = host.locator('[data-module="eq-rack"]');

  const background = await host.locator('.premium-stage-canvas[data-design-section="eq"]').evaluate(
    (canvas) => ({
      ownImage: getComputedStyle(canvas).backgroundImage,
      beforeImage: getComputedStyle(canvas, "::before").backgroundImage,
      afterDisplay: getComputedStyle(canvas, "::after").display,
    }),
  );
  expect(background.ownImage).toContain("rack-studio-backdrop-v2");
  expect(background.beforeImage).not.toBe("none");
  expect(background.afterDisplay).not.toBe("none");
  const moduleSkin = module.locator(".module-skin");
  await expect(moduleSkin).toHaveCount(1);
  await expect(moduleSkin).toHaveAttribute("data-rack-design-asset-id", "graphic-eq-body-v6");

  expect(await interactiveParamIds(page, "eq-rack"))
    .toEqual([...POST_EQ_PARAM_IDS].sort());
  expect(await surfaceGeometryFailures(page, "eq-rack")).toEqual({
    containment: [],
    hitOverlaps: [],
    labelOverlaps: [],
    textOverflow: [],
  });
  await expect(module.locator(".fader[data-param-id]")).toHaveCount(9);
  for (const paramId of POST_EQ_BAND_IDS) {
    await expect(module.locator(`.fader[data-param-id="${paramId}"]`)).toHaveCount(1);
  }
  await expect(module.locator('.fader[data-param-id="eqLevelDb"]')).toHaveCount(0);
  for (const paramId of ["eqHPFHz", "eqLevelDb", "eqLPFHz"] as const) {
    await expect(module.locator(`[data-param-id="${paramId}"][role="slider"]`)).toHaveCount(1);
  }
  await expect(module.locator(".eq-filter-readout")).toHaveCount(0);
  await expect(module).not.toContainText("ACTIVE");

  const level = module.locator('[data-param-id="eqLevelDb"][role="slider"]');
  await level.focus();
  await page.keyboard.press("End");
  await expect(level).toHaveAttribute("aria-valuenow", "12");
  const hpf = module.locator('[data-param-id="eqHPFHz"][role="slider"]');
  await hpf.focus();
  await page.keyboard.press("Home");
  await expect(hpf).toHaveAttribute("aria-valuetext", "OFF");
  await expect.poll(async () => (await readRackValues(page)).eqLevelDb).toBe(12);
  await expect.poll(async () => (await readRackValues(page)).eqHPFHz).toBe(0);
});

test("Amp, EQ, EQ Boost, and Drive hardware remain inside their painted borders at every supported host size", async ({ page }) => {
  const viewports = [
    { width: 920, height: 760 },
    { width: 1024, height: 700 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openRackSection(page, "amp");
    expect(
      await manifestProjectionFailures(
        page,
        "amp-head",
        NAM_AMP_V4_FACEPLATE,
        ["amp-power-led", "amp-tight-led", "amp-bright-led"],
      ),
      `Amp geometry at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);

    await openRackSection(page, "eq");
    expect(
      await manifestProjectionFailures(
        page,
        "eq-rack",
        NAM_EQ_V4_FACEPLATE,
        // Power and its passive status LED intentionally share eqEnabled, so
        // this generic param-id matcher cannot distinguish their hit nodes.
        ["eq-led"],
      ),
      `EQ geometry at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);

    await openRackSection(page, "pre");
    expect(
      await surfaceGeometryFailures(page, "eq-boost"),
      `EQ Boost geometry at ${viewport.width}x${viewport.height}`,
    ).toEqual({
      containment: [],
      hitOverlaps: [],
      labelOverlaps: [],
      textOverflow: [],
    });
    expect(
      await surfaceGeometryFailures(page, "precision-drive"),
      `Precision Drive geometry at ${viewport.width}x${viewport.height}`,
    ).toEqual({
      containment: [],
      hitOverlaps: [],
      labelOverlaps: [],
      textOverflow: [],
    });
  }
});

test("compact-height hosts keep the rack frame symmetric without losing vertical scrolling", async ({ page }) => {
  for (const height of [688, 699, 700]) {
    await page.setViewportSize({ width: 360, height });
    const host = await openRackSection(page, "pre");
    const metrics = await host.evaluate((root) => {
      const shell = root.querySelector<HTMLElement>(".premium-nam-shell");
      if (!shell) throw new Error("Missing premium NAM shell");
      const rootRect = root.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const style = getComputedStyle(root);
      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
      root.scrollTop = Math.min(12, maxScrollTop);
      return {
        clientWidth: root.clientWidth,
        renderedWidth: rootRect.width,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        scrollTop: root.scrollTop,
        leftInset: shellRect.left - rootRect.left,
        rightInset: rootRect.right - shellRect.right,
        overflowY: style.overflowY,
        scrollbarGutter: style.scrollbarGutter,
        scrollbarWidth: style.scrollbarWidth,
        documentOverflow:
          document.documentElement.scrollWidth
          - document.documentElement.clientWidth,
      };
    });

    expect(metrics.clientWidth).toBeCloseTo(metrics.renderedWidth, 1);
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    expect(metrics.leftInset).toBeCloseTo(metrics.rightInset, 1);
    expect(metrics.documentOverflow).toBe(0);

    if (height < 700) {
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.scrollTop).toBeGreaterThan(0);
      expect(metrics.overflowY).toBe("auto");
      expect(metrics.scrollbarGutter).toBe("auto");
      expect(metrics.scrollbarWidth).toBe("none");
    } else {
      expect(metrics.scrollHeight).toBe(metrics.clientHeight);
      expect(metrics.overflowY).toBe("hidden");
    }
  }
});

test("EQ Boost and Drive expose separate controls without collisions", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openRackSection(page, "pre");
  const eqBoost = page.locator('[data-module="eq-boost"]');
  const drive = page.locator('[data-module="precision-drive"]');

  expect(await interactiveParamIds(page, "eq-boost")).toEqual([...PRE_EQ_PARAM_IDS].sort());
  expect(await interactiveParamIds(page, "precision-drive")).toEqual([...DRIVE_PARAM_IDS].sort());
  expect(await interactiveParamIds(page, "eq-boost")).toHaveLength(11);
  expect(await interactiveParamIds(page, "precision-drive")).toHaveLength(6);
  await expect(eqBoost.locator('[data-param-id="preEqLevelDb"]')).toHaveCount(0);
  await expect(drive.locator('[data-param-id^="preEq"]')).toHaveCount(0);
  await expect(eqBoost.locator('[data-param-id^="precisionDrive"]')).toHaveCount(0);
  expect(await surfaceGeometryFailures(page, "eq-boost")).toEqual({
    containment: [],
    hitOverlaps: [],
    labelOverlaps: [],
    textOverflow: [],
  });
  expect(await surfaceGeometryFailures(page, "precision-drive")).toEqual({
    containment: [],
    hitOverlaps: [],
    labelOverlaps: [],
    textOverflow: [],
  });

  await expect(eqBoost.locator(".combined-pre-eq-band-label")).toHaveCount(8);
  await expect(eqBoost).toContainText("120");
  await expect(eqBoost).toContainText("2.5K");
  await expect(eqBoost).toContainText("12K");
  const bandAlignment = await eqBoost.locator(".combined-pre-eq-band").evaluateAll((rows) => (
    rows.map((row) => {
      const label = row.querySelector<HTMLElement>(".combined-pre-eq-band-label");
      const track = row.querySelector<HTMLElement>(".horizontal-mini-fader-track");
      if (!label || !track) throw new Error("Incomplete EQ Boost band row");
      const labelRect = label.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      return {
        gap: trackRect.left - labelRect.right,
        verticalDelta: Math.abs(
          labelRect.top + labelRect.height / 2
            - (trackRect.top + trackRect.height / 2),
        ),
      };
    })
  ));
  expect(bandAlignment).toHaveLength(8);
  for (const row of bandAlignment) {
    expect(row.gap).toBeGreaterThanOrEqual(3);
    expect(row.gap).toBeLessThanOrEqual(5);
    expect(row.verticalDelta).toBeLessThanOrEqual(0.5);
  }
  const titleAlignment = await page.evaluate(() => {
    const read = (moduleId: string) => {
      const module = document.querySelector<HTMLElement>(`[data-module="${moduleId}"]`);
      const title = module?.querySelector<HTMLElement>(".module-title");
      if (!module || !title) throw new Error(`Missing title for ${moduleId}`);
      const moduleRect = module.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      return (titleRect.top + titleRect.height / 2 - moduleRect.top) / moduleRect.height;
    };
    return {
      compressor: read("compressor"),
      eqBoost: read("eq-boost"),
      distortion: read("distortion"),
    };
  });
  expect(titleAlignment.eqBoost).toBeCloseTo(titleAlignment.compressor, 2);
  expect(titleAlignment.eqBoost).toBeCloseTo(titleAlignment.distortion, 2);

  for (const paramId of PRE_EQ_PARAM_IDS.slice(1, 9)) {
    await expect(eqBoost.locator(`[data-param-id="${paramId}"][role="slider"]`)).toHaveCount(1);
  }
  const firstBand = eqBoost.locator('[data-param-id="preEq120Db"][role="slider"]');
  await firstBand.focus();
  await page.keyboard.press("End");
  await expect(firstBand).toHaveAttribute("aria-valuenow", "12");
  await firstBand.hover();
  await expect(page.locator(".nam-rack-control-tooltip")).toBeVisible();
  await expect(page.locator(".nam-rack-control-tooltip")).toContainText("dB");

  const preEqPower = eqBoost.locator('[data-param-id="preEqEnabled"][role="button"]');
  const drivePower = drive.locator('[data-param-id="precisionDriveEnabled"][role="button"]');
  await expect(preEqPower).toHaveAttribute("aria-pressed", "false");
  await expect(drivePower).toHaveAttribute("aria-pressed", "false");
  await preEqPower.focus();
  await page.keyboard.press("Enter");
  await expect(preEqPower).toHaveAttribute("aria-pressed", "true");
  await expect(drivePower).toHaveAttribute("aria-pressed", "false");
  await drivePower.focus();
  await page.keyboard.press("Enter");
  await expect(preEqPower).toHaveAttribute("aria-pressed", "true");
  await expect(drivePower).toHaveAttribute("aria-pressed", "true");

  await expect.poll(async () => (await readRackValues(page)).preEq120Db).toBe(12);
  await expect.poll(async () => (await readRackValues(page)).preEqEnabled).toBe(1);
  await expect.poll(async () => (await readRackValues(page)).precisionDriveEnabled).toBe(1);

  const footStateStyles = await page.locator(".primary-foot-state").evaluateAll((nodes) => (
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      };
    })
  ));
  for (const style of footStateStyles) {
    expect(style).toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderStyle: "none",
      borderRadius: "0px",
      boxShadow: "none",
      paddingLeft: "0px",
      paddingRight: "0px",
    });
  }
});

test("PRE row keeps five sibling pedals visible without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 760 });
  const host = await openRackSection(page, "pre");
  const expectedBoxes = {
    compressor: { x: 85, y: 42, w: 156, h: 232 },
    octaver: { x: 251, y: 42, w: 120, h: 232 },
    "eq-boost": { x: 381, y: 42, w: 156, h: 232 },
    "precision-drive": { x: 547, y: 42, w: 120, h: 232 },
    distortion: { x: 677, y: 42, w: 156, h: 232 },
  } as const;

  const metrics = await host.evaluate((root, expected) => {
    const artboard = root.querySelector<HTMLElement>(".nam-rack-artboard");
    if (!artboard) throw new Error("Missing PRE artboard");
    const modules = Object.fromEntries(Object.entries(expected).map(([id, box]) => {
      const node = root.querySelector<HTMLElement>(`[data-module="${id}"]`);
      if (!node) throw new Error(`Missing PRE module ${id}`);
      const rect = node.getBoundingClientRect();
      return [id, {
        logical: {
          x: Number.parseFloat(node.style.left),
          y: Number.parseFloat(node.style.top),
          w: Number.parseFloat(node.style.width),
          h: Number.parseFloat(node.style.height),
        },
        rendered: {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        },
        scaleX: rect.width / box.w,
        scaleY: rect.height / box.h,
        snapAlign: getComputedStyle(node).scrollSnapAlign,
      }];
    }));
    const scroller = root.querySelector<HTMLElement>('[data-qa="nam-pre-stage-scroll"]');
    if (!scroller) throw new Error("Missing local PRE row viewport");
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      artboardWidth: Number.parseFloat(getComputedStyle(artboard).width),
      artboardHeight: Number.parseFloat(getComputedStyle(artboard).height),
      modules,
      scroller: {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        scrollLeft: scroller.scrollLeft,
        snapType: getComputedStyle(scroller).scrollSnapType,
        overflowX: getComputedStyle(scroller).overflowX,
        required: scroller.dataset.scrollRequired,
        left: scrollerRect.left,
        right: scrollerRect.right,
      },
      rootPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  }, expectedBoxes);

  expect(metrics.artboardWidth).toBeCloseTo(918, 1);
  expect(metrics.artboardHeight).toBeCloseTo(341, 1);
  expect(metrics.rootPageOverflow).toBe(false);
  expect(metrics.scroller.scrollWidth - metrics.scroller.clientWidth).toBeLessThanOrEqual(2);
  expect(metrics.scroller.scrollLeft).toBe(0);
  expect(metrics.scroller.snapType).toBe("none");
  expect(metrics.scroller.overflowX).toBe("hidden");
  expect(metrics.scroller.required).toBe("false");
  for (const [id, expected] of Object.entries(expectedBoxes)) {
    const got = metrics.modules[id as keyof typeof metrics.modules];
    expect(got.logical).toEqual(expected);
    expect(got.scaleX).toBeCloseTo(got.scaleY, 2);
    expect(got.snapAlign).not.toBe("");
  }
  const scaleValues = Object.values(metrics.modules).map((module) => module.scaleX);
  expect(Math.max(...scaleValues) - Math.min(...scaleValues)).toBeLessThan(0.01);
  const ordered = Object.values(metrics.modules);
  for (let index = 1; index < ordered.length; index += 1) {
    const logicalGap = (ordered[index].rendered.left - ordered[index - 1].rendered.right)
      / ordered[index].scaleX;
    expect(logicalGap).toBeCloseTo(10, 1);
  }
  await expect(host.locator(".nam-pre-stage-snap-anchor")).toHaveCount(5);
  const compressorFootPadding = await host.locator('[data-module="compressor"]').evaluate((module) => {
    const foot = module.querySelector<HTMLElement>(
      '.asset-control.footswitch[data-param-id="compressorEnabled"]',
    );
    if (!foot) throw new Error("Missing compressor footswitch artwork");
    const moduleRect = module.getBoundingClientRect();
    const footRect = foot.getBoundingClientRect();
    return {
      gap: moduleRect.right - footRect.right,
      designScale: moduleRect.width / 156,
    };
  });
  expect(compressorFootPadding.gap / compressorFootPadding.designScale)
    .toBeGreaterThanOrEqual(20);
  await host.locator('[data-param-id="chaosTone"][role="slider"]').focus();
  await expect.poll(() => host.locator('[data-qa="nam-pre-stage-scroll"]').evaluate(
    (scroller) => scroller.scrollLeft,
  )).toBe(0);
});
