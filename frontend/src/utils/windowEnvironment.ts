const browserWindow = typeof window !== "undefined" ? window : undefined;
const browserNavigator = typeof navigator !== "undefined" ? navigator : undefined;
const searchParams = new URLSearchParams(browserWindow?.location.search ?? "");

function detectHostPlatform(): string {
  const platform = browserNavigator?.platform.toLowerCase() ?? "";
  const userAgent = browserNavigator?.userAgent.toLowerCase() ?? "";

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macos";
  }

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }

  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

export const windowRole = searchParams.get("window") ?? "main";
export const windowSessionId = searchParams.get("sessionId") ?? "";
export const startupMode = searchParams.get("startup") ?? "normal";
export const hostPlatform =
  searchParams.get("platform") ?? detectHostPlatform();
export const windowChrome =
  searchParams.get("windowChrome") ??
  (hostPlatform === "macos" ? "native" : "custom");
export const usesNativeWindowChrome = windowChrome === "native";
export const isMacOS = hostPlatform === "macos";
