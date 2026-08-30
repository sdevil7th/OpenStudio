import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import {
  bootstrapTONE3000Session,
  ensureTONE3000Session,
  getTONE3000SessionSnapshot,
  resetTONE3000SessionForTests,
  startTONE3000InteractiveAuth,
} from "../services/tone3000Session";

describe("TONE3000 shared session", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetTONE3000SessionForTests();
  });

  it("uses a valid stored token on startup without opening browser auth", async () => {
    const startAuth = vi.spyOn(nativeBridge, "startTONE3000AuthFlow");
    const refresh = vi.spyOn(nativeBridge, "refreshTONE3000Auth");
    vi.spyOn(nativeBridge, "getTONE3000AuthStatus").mockResolvedValue({
      success: true,
      authenticated: true,
      expired: false,
      hasRefreshToken: true,
      clientId: "client-id",
    });

    await bootstrapTONE3000Session();

    expect(refresh).not.toHaveBeenCalled();
    expect(startAuth).not.toHaveBeenCalled();
    expect(getTONE3000SessionSnapshot().status?.authenticated).toBe(true);
  });

  it("silently refreshes an expired stored token once on startup", async () => {
    let refreshed = false;
    const startAuth = vi.spyOn(nativeBridge, "startTONE3000AuthFlow");
    vi.spyOn(nativeBridge, "getTONE3000AuthStatus").mockImplementation(async () => ({
      success: true,
      authenticated: true,
      expired: !refreshed,
      hasRefreshToken: true,
      clientId: "client-id",
    }));
    const refresh = vi.spyOn(nativeBridge, "refreshTONE3000Auth").mockImplementation(async () => {
      refreshed = true;
      return { success: true, authenticated: true, hasRefreshToken: true, clientId: "client-id" };
    });

    const status = await bootstrapTONE3000Session();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(startAuth).not.toHaveBeenCalled();
    expect(status?.authenticated).toBe(true);
    expect(status?.expired).toBe(false);
  });

  it("does not open browser auth when no stored token exists", async () => {
    const startAuth = vi.spyOn(nativeBridge, "startTONE3000AuthFlow");
    vi.spyOn(nativeBridge, "getTONE3000AuthStatus").mockResolvedValue({
      success: true,
      authenticated: false,
      hasRefreshToken: false,
    });

    const result = await ensureTONE3000Session("live search");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Connect TONE3000");
    expect(startAuth).not.toHaveBeenCalled();
  });

  it("connects a first-time user through the native browser flow without exposing a token", async () => {
    const getStatus = vi.spyOn(nativeBridge, "getTONE3000AuthStatus")
      .mockResolvedValueOnce({
        success: true,
        authenticated: false,
        hasRefreshToken: false,
        configuredClientId: true,
      })
      .mockResolvedValue({
        success: true,
        authenticated: true,
        expired: false,
        hasRefreshToken: true,
        configuredClientId: true,
        clientId: "publishable-client-id",
      });
    const startAuth = vi.spyOn(nativeBridge, "startTONE3000AuthFlow").mockResolvedValue({
      success: true,
      status: "connected",
      clientId: "publishable-client-id",
    });

    await bootstrapTONE3000Session();
    const result = await startTONE3000InteractiveAuth();

    expect(result.status).toBe("connected");
    expect(startAuth).toHaveBeenCalledWith({});
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(getTONE3000SessionSnapshot().status).toMatchObject({
      authenticated: true,
      hasRefreshToken: true,
    });
  });

  it("reports reconnect after invalid refresh without repeating browser prompts", async () => {
    const startAuth = vi.spyOn(nativeBridge, "startTONE3000AuthFlow");
    vi.spyOn(nativeBridge, "getTONE3000AuthStatus").mockResolvedValue({
      success: true,
      authenticated: false,
      expired: true,
      hasRefreshToken: true,
      clientId: "client-id",
    });
    vi.spyOn(nativeBridge, "refreshTONE3000Auth").mockResolvedValue({
      success: false,
      oauthError: "invalid_grant",
      error: "Refresh token expired",
    });

    const result = await ensureTONE3000Session("loading the tone");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Refresh token expired");
    expect(startAuth).not.toHaveBeenCalled();
  });
});
