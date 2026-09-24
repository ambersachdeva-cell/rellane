import { describe, expect, it } from "vitest";
import { detectShape, pasteAs, targetFor } from "./paste-as.js";

describe("recognising what was copied", () => {
  it("spots a tab-separated table", () => {
    expect(detectShape("Item\tQty\nBoxes\t2000\nCards\t500")).toBe("table");
  });

  it("spots a comma-separated table", () => {
    expect(detectShape("name,qty\nrigid box,2000\nvisiting card,500")).toBe("table");
  });

  it("spots JSON", () => {
    expect(detectShape('{"item":"rigid box","qty":2000}')).toBe("json");
  });

  it("spots a bare URL but not prose containing one", () => {
    expect(detectShape("https://api.example.com/leads")).toBe("url");
    expect(detectShape("see https://example.com for details")).not.toBe("url");
  });

  it("spots key: value blocks", () => {
    expect(detectShape("Item: rigid box\nQty: 2000\nCity: Noida")).toBe("keyvalue");
  });

  it("spots a bulleted list", () => {
    expect(detectShape("- call Sharma\n- send the quote\n- chase the PO")).toBe("list");
  });

  it("spots code", () => {
    expect(detectShape("const total = qty * rate;\nconsole.log(total);")).toBe("code");
  });

  it("falls back to prose", () => {
    expect(detectShape("sir mujhe 2000 rigid box chahiye noida me delivery")).toBe("prose");
  });
});

describe("knowing where it is going", () => {
  it("maps known applications", () => {
    expect(targetFor("com.apple.numbers")).toBe("spreadsheet");
    expect(targetFor("com.googlecode.iterm2")).toBe("terminal");
    expect(targetFor("com.apple.mail")).toBe("mail");
  });

  it("is case-insensitive about bundle ids", () => {
    expect(targetFor("com.apple.Numbers")).toBe("spreadsheet");
  });

  it("falls back to plain for anything unknown", () => {
    expect(targetFor("com.unknown.app")).toBe("plain");
    expect(targetFor(null)).toBe("plain");
  });
});

describe("reshaping for a spreadsheet", () => {
  it("turns a tab table into CSV", () => {
    const result = pasteAs("Item\tQty\nBoxes\t2000", "spreadsheet");
    expect(result.text).toBe("Item,Qty\nBoxes,2000");
    expect(result.summary).toBe("Turned 2 rows into columns.");
  });

  it("quotes a cell that contains a comma", () => {
    const result = pasteAs("Item\tNote\nBox\tred, matte", "spreadsheet");
    expect(result.text).toContain('"red, matte"');
  });

  it("strips bullets so a list becomes rows", () => {
    const result = pasteAs("- call Sharma\n- send quote\n- chase PO", "spreadsheet");
    expect(result.text).toBe("call Sharma\nsend quote\nchase PO");
  });

  it("flattens an array of objects into a header and rows", () => {
    const result = pasteAs('[{"item":"box","qty":2000},{"item":"card","qty":500}]', "spreadsheet");
    expect(result.text).toBe("item,qty\nbox,2000\ncard,500");
  });

  it("leaves prose alone and says why", () => {
    const result = pasteAs("sir mujhe 2000 rigid box chahiye", "spreadsheet");
    expect(result.unchanged).toBe(true);
    expect(result.summary).toMatch(/nothing here looks like rows/iu);
  });
});

describe("reshaping for a terminal", () => {
  it("makes a URL into a curl command", () => {
    expect(pasteAs("https://api.example.com/leads", "terminal").text).toBe(
      "curl -sS https://api.example.com/leads"
    );
  });

  it("joins several commands so they stop on the first failure", () => {
    // Pasting multiple lines into a shell runs them all regardless of failure.
    // && makes the intent explicit and halts on the first error.
    const result = pasteAs("- npm ci\n- npm test\n- npm run build", "terminal");
    expect(result.text).toBe("npm ci && npm test && npm run build");
    expect(result.summary).toMatch(/stop on the first failure/u);
  });

  it("does not join prose into a command line", () => {
    const result = pasteAs("please run the build\nand then tell me", "terminal");
    expect(result.unchanged).toBe(true);
  });
});

describe("reshaping for notes and mail", () => {
  it("turns a table into a readable list", () => {
    const result = pasteAs("Item\tQty\nBoxes\t2000", "notes");
    expect(result.text).toBe("• Item — Qty\n• Boxes — 2000");
  });

  it("bullets a key-value block", () => {
    expect(pasteAs("Item: box\nQty: 2000", "mail").text).toBe("• Item: box\n• Qty: 2000");
  });
});

describe("reshaping for an editor", () => {
  it("formats JSON", () => {
    const result = pasteAs('{"a":1,"b":[2,3]}', "editor");
    expect(result.text).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("leaves code alone", () => {
    const code = "const total = qty * rate;";
    expect(pasteAs(code, "editor").text).toBe(code);
  });
});

describe("it always says what it did", () => {
  it("reports an empty clipboard rather than pretending", () => {
    const result = pasteAs("   ", "spreadsheet");
    expect(result.unchanged).toBe(true);
    expect(result.summary).toBe("The clipboard is empty.");
  });

  it("never returns a summary claiming a change it did not make", () => {
    for (const target of ["spreadsheet", "terminal", "editor", "mail", "notes", "plain"] as const) {
      const result = pasteAs("just some ordinary sentence here", target);
      if (result.unchanged) {
        expect(result.text).toBe("just some ordinary sentence here");
      }
    }
  });
});
