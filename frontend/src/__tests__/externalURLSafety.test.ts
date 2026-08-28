// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAllowedExternalBrowserURL,
  nativeBridge,
} from "../services/NativeBridge";

const nativeSource = readFileSync(
  new URL("../../../Source/MainComponent.cpp", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
const bridgeSource = readFileSync(
  new URL("../services/NativeBridge.ts", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
const aiSetupSource = readFileSync(
  new URL("../components/AiToolsSetupModal.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

describe("external URL safety policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "https://www.tone3000.com/tones/example-1",
    "http://127.0.0.1:5183/help",
    " HTTPS://example.com/path?q=1 ",
  ])("allows an absolute HTTP(S) URL: %s", (url) => {
    expect(isAllowedExternalBrowserURL(url)).toBe(true);
  });

  it.each([
    "javascript:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Users/example/log.txt",
    "mailto:support@example.com",
    "shell:AppsFolder",
    "ms-settings:privacy-microphone",
    "//tone3000.com/tones/example-1",
    "/relative/help",
    "https:example.com",
    "https://exa\tmple.com",
    "",
  ])("rejects a non-web or malformed external URL: %s", (url) => {
    expect(isAllowedExternalBrowserURL(url)).toBe(false);
  });

  it("does not forward a rejected URL to the web fallback", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    await expect(nativeBridge.openExternalURL("javascript:alert(1)"))
      .resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("normalizes and forwards an allowed URL to the web fallback", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    await expect(nativeBridge.openExternalURL("  https://example.com/docs  "))
      .resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("mirrors the HTTP(S)-only gate in the native bridge before launch", () => {
    expect(nativeSource).toContain("bool isAllowedExternalBrowserURL(juce::String rawURL)");
    expect(nativeSource).toContain('rawURL.startsWithIgnoreCase("https://")');
    expect(nativeSource).toContain('rawURL.startsWithIgnoreCase("http://")');
    expect(nativeSource).toContain("if (! isAllowedExternalBrowserURL(url))");

    const registrationStart = nativeSource.indexOf('.withNativeFunction ("openExternalURL"');
    const registrationEnd = nativeSource.indexOf('.withNativeFunction ("revealLocalPath"', registrationStart);
    const registration = nativeSource.slice(registrationStart, registrationEnd);
    expect(registration).toContain("launchInDefaultBrowser()");
    expect(registration.indexOf("isAllowedExternalBrowserURL"))
      .toBeLessThan(registration.indexOf("launchInDefaultBrowser"));
  });

  it("routes install-log access through a reveal-only native API", async () => {
    expect(aiSetupSource).toContain("nativeBridge.revealLocalPath(installLogPath)");
    expect(aiSetupSource).not.toContain("openExternalURL(toFileUrl");
    expect(bridgeSource).toContain("async revealLocalPath(path: string): Promise<boolean>");

    const registrationStart = nativeSource.indexOf('.withNativeFunction ("revealLocalPath"');
    const registrationEnd = nativeSource.indexOf('.withNativeFunction ("createTONE3000AuthRequest"', registrationStart);
    const registration = nativeSource.slice(registrationStart, registrationEnd);
    expect(registration).toContain("juce::File::isAbsolutePath(path)");
    expect(registration).toContain("localPath.existsAsFile()");
    expect(registration).toContain("localPath.revealToUser()");
    expect(registration).not.toContain("startAsProcess");
    expect(registration).not.toContain("launchInDefaultBrowser");

    await expect(nativeBridge.revealLocalPath("C:\\OpenStudio\\install.log"))
      .resolves.toBe(false);
  });
});
