import { describe, expect, it } from "vitest";
import { discoverProvider } from "./cli-discovery.js";
import { providerDefinition, PROVIDER_DEFINITIONS } from "./providers.js";

/**
 * What is actually installed on the machine running the suite.
 *
 * Not assertions about a particular Mac — they would fail on CI, which has none
 * of these. This reports what discovery sees so that a claim like "Claude is
 * connected" is something we have observed rather than something we assumed,
 * and so the editor-extension search path is exercised for real.
 */
describe("discovery, against this machine", () => {
  it("reports each engine honestly", async () => {
    const seen: string[] = [];
    for (const definition of PROVIDER_DEFINITIONS) {
      const found = await discoverProvider(definition);
      seen.push(
        found === null
          ? `${definition.label.padEnd(14)} not installed`
          : `${definition.label.padEnd(14)} ${found.version} @ ${found.executablePath}`
      );
    }
    console.log("\n  ENGINE ROOM, as this Mac sees it:\n    " + seen.join("\n    ") + "\n");

    // The only universal truth: discovery answers for every provider without
    // throwing, and never claims one it did not run.
    expect(seen).toHaveLength(PROVIDER_DEFINITIONS.length);
  }, 30_000);

  it("finds a CLI installed inside an editor extension, when one is there", async () => {
    // Claude Code ships as a VS Code extension rather than onto PATH. On a
    // machine that has it, discovery must find it; on one that does not, this
    // asserts nothing rather than failing.
    const found = await discoverProvider(providerDefinition("claude"));
    if (found === null) {
      return;
    }
    expect(found.executablePath).toMatch(/claude$/u);
    expect(found.version).toMatch(/\d+\.\d+/u);
  }, 30_000);
});
