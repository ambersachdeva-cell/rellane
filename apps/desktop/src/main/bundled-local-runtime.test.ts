/** TypeScript / vitest: startup failures explain a remedy without leaking logs. */
import { describe, expect, it } from "vitest";
import { runtimeExitProblem } from "./bundled-local-runtime.js";
describe("native runtime failures", () => {
  it("distinguishes the observed Metal queue failure from an allocation failure", () => {
    const result = runtimeExitProblem("failed to create command queue; failed to allocate context; PRIVATE_PATH secret-bearer", 1, null);
    expect(result).toContain("graphics queue");
    expect(result).not.toContain("PRIVATE_PATH");
    expect(result).not.toContain("secret-bearer");
    expect(runtimeExitProblem("out of memory", 1, null)).toContain("working memory");
  });
  it("does not make a startup option error look like a bad model or a ready process", () => {
    expect(runtimeExitProblem('error while handling argument "--flash-attn"', 1, null)).toContain("startup options");
    expect(runtimeExitProblem("private native output", null, "SIGABRT")).toContain("SIGABRT");
    expect(runtimeExitProblem("private native output", null, "SIGABRT")).not.toContain("private native output");
  });
});
