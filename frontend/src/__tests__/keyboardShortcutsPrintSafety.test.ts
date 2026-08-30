import { describe, expect, it } from "vitest";
import { escapePrintHtml } from "../components/KeyboardShortcutsModal";
import keyboardShortcutsSource from "../components/KeyboardShortcutsModal.tsx?raw";

describe("keyboard shortcut print safety", () => {
  it("escapes imported shortcut labels before inserting printable markup", () => {
    expect(escapePrintHtml(`<img src=x onerror="alert('x')"> &`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;",
    );
    expect(keyboardShortcutsSource).toContain("escapePrintHtml(item.shortcut)");
    expect(keyboardShortcutsSource).toContain("escapePrintHtml(item.name)");
    expect(keyboardShortcutsSource).toContain("printWindow.opener = null");
  });
});
