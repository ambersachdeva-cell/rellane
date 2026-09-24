/** Signed byte changes are accepted only through a verified expected app seal. */
import { describe, expect, it } from "vitest";
import { assertRuntimeIntegrity } from "./runtime-integrity.js";
const signed = { serverPath: "/Applications/Cadrane.app/Contents/Resources/llama-b10182/llama-server", appBundlePath: "/Applications/Cadrane.app", expectedDigest: "vendor", digest: async () => "signed-bytes" };
describe("local runtime integrity", () => {
  it("verifies the whole bundle with an explicit signer and identifier", async () => {
    const calls: string[] = [];
    await assertRuntimeIntegrity(signed, async (bundle, requirement) => { calls.push(bundle, requirement); });
    expect(calls[0]).toBe("/Applications/Cadrane.app");
    expect(calls[1]).toContain('identifier "com.cadrane.local-work-studio"');
    expect(calls[1]).toContain('anchor apple generic');
    expect(calls[1]).toContain('certificate leaf[subject.CN]');
    expect(calls[1]).toContain('4YLJH6747Y');
  });
  it("refuses a broken signature even if the raw hash matches", async () => {
    await expect(assertRuntimeIntegrity({ ...signed, digest: async () => "vendor" }, async () => { throw new Error("tampered seal"); })).rejects.toThrow("tampered seal");
  });
  it("rejects a helper outside the verified resource location", async () => {
    await expect(assertRuntimeIntegrity({ ...signed, serverPath: "/tmp/llama-server" }, async () => undefined)).rejects.toThrow("outside");
  });
  it("still requires the exact development hash", async () => {
    await expect(assertRuntimeIntegrity({ ...signed, appBundlePath: null })).rejects.toThrow("build pin");
    await expect(assertRuntimeIntegrity({ ...signed, appBundlePath: null, digest: async () => "vendor" })).resolves.toBeUndefined();
  });
});
