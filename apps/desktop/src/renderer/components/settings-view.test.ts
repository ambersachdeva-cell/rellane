import { describe, expect, it } from "vitest";
import { prettyKey } from "./SettingsView";

describe("shortcuts read as Mac keys", () => {
  it("uses the real glyphs", () => {
    expect(prettyKey("Alt+Space")).toBe("⌥Space");
    expect(prettyKey("Alt+V")).toBe("⌥V");
    expect(prettyKey("CommandOrControl+Shift+K")).toBe("⌘⇧K");
    expect(prettyKey("Ctrl+Alt+Delete")).toBe("⌃⌥DELETE");
  });

  it("passes through anything it does not recognise rather than dropping it", () => {
    // Losing a key from a shortcut a person has to press is worse than
    // showing it unprettified.
    expect(prettyKey("F13")).toBe("F13");
    expect(prettyKey("Alt+F13")).toBe("⌥F13");
  });
});
