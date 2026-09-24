import { describe, expect, it } from "vitest";
import {
  buildShortcutPlist,
  describeShortcut,
  escapeXml,
  readShortcutIntent,
  shortcutName,
  validate,
  type ShortcutSpec
} from "./shortcuts.js";

const CONTEXT = { folder: "/Users/amber/Downloads" };

function spec(over: Partial<ShortcutSpec> = {}): ShortcutSpec {
  return {
    name: "Tidy Downloads",
    actions: [{ kind: "notify", title: "Rellane", body: "done" }],
    ...over
  };
}

describe("reading a sentence as a Shortcut", () => {
  it("recognises tidying, however phrased", () => {
    for (const sentence of [
      "tidy my downloads every friday",
      "organise the downloads folder",
      "sort my files",
      "clean up downloads"
    ]) {
      expect(readShortcutIntent(sentence, CONTEXT)).not.toBeNull();
    }
  });

  it("recognises a reminder", () => {
    const result = readShortcutIntent("remind me to chase the PO", CONTEXT);
    expect(result?.actions.some((a) => a.kind === "notify")).toBe(true);
  });

  it("returns null rather than inventing something", () => {
    expect(readShortcutIntent("book a flight to Delhi", CONTEXT)).toBeNull();
  });

  it("records where the Shortcut came from, inside the Shortcut", () => {
    const result = readShortcutIntent("tidy my downloads", CONTEXT);
    const comment = result?.actions.find((a) => a.kind === "comment");
    expect(comment).toMatchObject({ text: expect.stringContaining("Made by Rellane") });
  });
});

describe("naming", () => {
  it("takes a short name from the sentence", () => {
    expect(shortcutName("tidy my downloads every friday please")).toBe("Tidy my downloads every friday");
  });

  it("strips characters that do not belong in a name", () => {
    expect(shortcutName("tidy/my: downloads!")).not.toMatch(/[/:!]/u);
  });

  it("always produces something usable", () => {
    expect(shortcutName("   ")).toBe("Rellane Shortcut");
    expect(shortcutName("!!!")).toBe("Rellane Shortcut");
  });
});

describe("the plist", () => {
  it("is well-formed XML with the expected skeleton", () => {
    const xml = buildShortcutPlist(spec());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<plist version=\"1.0\">");
    expect(xml).toContain("<key>WFWorkflowActions</key>");
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
    // Every opened tag closes.
    expect((xml.match(/<dict>/gu) ?? []).length).toBe((xml.match(/<\/dict>/gu) ?? []).length);
    expect((xml.match(/<array>/gu) ?? []).length).toBe((xml.match(/<\/array>/gu) ?? []).length);
  });

  it("uses Apple's real action identifiers", () => {
    const xml = buildShortcutPlist(
      spec({ actions: [{ kind: "moveTo", path: "/tmp/x" }] })
    );
    expect(xml).toContain("is.workflow.actions.file.move");
  });

  it("escapes text that would otherwise break the XML", () => {
    // A folder called "Bills & Quotes" would produce invalid XML unescaped,
    // and the import failure gives the user nothing to act on.
    const xml = buildShortcutPlist(
      spec({ actions: [{ kind: "comment", text: 'Bills & Quotes <"2026">' }] })
    );
    expect(xml).toContain("Bills &amp; Quotes &lt;&quot;2026&quot;&gt;");
    expect(xml).not.toMatch(/Bills & Quotes/u);
  });

  it("escapes the five XML entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("round-trips a real intent into a plist", () => {
    const built = readShortcutIntent("tidy my downloads", CONTEXT);
    const xml = buildShortcutPlist(built!);
    expect(xml).toContain("/Users/amber/Downloads");
    expect((xml.match(/WFWorkflowActionIdentifier/gu) ?? []).length).toBe(built!.actions.length);
  });
});

describe("validation, because this runs unattended", () => {
  it("accepts a sound spec", () => {
    expect(validate(spec())).toEqual({ ok: true });
  });

  it("refuses a Shortcut that would do nothing", () => {
    expect(validate(spec({ actions: [] }))).toMatchObject({ ok: false });
  });

  it("refuses an empty name", () => {
    expect(validate(spec({ name: "  " }))).toMatchObject({ ok: false });
  });

  it("refuses a name containing a path separator", () => {
    expect(validate(spec({ name: "a/b" }))).toMatchObject({ ok: false });
  });

  it("refuses an action it does not know", () => {
    const rogue = spec({
      actions: [{ kind: "runShellScript" } as unknown as ShortcutSpec["actions"][number]]
    });
    const result = validate(rogue);
    expect(result).toMatchObject({ ok: false });
    // An unknown action is exactly what a model would invent, and it must not
    // reach a file that runs without Rellane watching.
    expect(result.ok === false && result.problem).toMatch(/does not know/u);
  });
});

describe("what the user is shown before installing", () => {
  it("describes every action in plain words", () => {
    const built = readShortcutIntent("tidy my downloads", CONTEXT)!;
    const lines = describeShortcut(built);
    expect(lines).toHaveLength(built.actions.length);
    expect(lines.join(" ")).toMatch(/Look at \/Users\/amber\/Downloads/u);
    expect(lines.join(" ")).not.toMatch(/is\.workflow/u);
  });
});
