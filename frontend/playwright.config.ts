import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.OPENSTUDIO_E2E_PORT || 5183);
const desktopIdentity = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
  : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: "../output/playwright/test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        userAgent: devices['Desktop Chrome'].userAgent.replace(/\([^)]*\)/, `(${desktopIdentity})`),
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        // Playwright's default WebKit UA says Macintosh even on Linux. Keep
        // shortcut/platform tests aligned with the OS whose keys they send.
        userAgent: process.platform === 'darwin' ? devices['Desktop Safari'].userAgent
          : `Mozilla/5.0 (${desktopIdentity}) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15`,
      },
      testMatch: /(?:media-file-dialogs|mixer-controls|input-profile-wheel|automation-input-runtime|audio-settings-switching|ui-audit-regressions|render-export-flow|profile-onboarding|nam-rack-approved-surfaces)\.spec\.ts/,
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
