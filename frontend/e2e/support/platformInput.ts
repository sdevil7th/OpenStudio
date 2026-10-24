import type { Page } from "@playwright/test";

/** Match the browser's desktop identity, including an explicitly emulated OS. */
export async function primaryModifier(page: Page): Promise<"Meta" | "Control"> {
  return page.evaluate(() => (
    /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac/.test(navigator.userAgent)
      ? "Meta"
      : "Control"
  ));
}
