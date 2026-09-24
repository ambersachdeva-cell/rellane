import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./capabilities.js";
import { runProcess } from "./cli-invoker.js";
import { RuntimeBoundaryError } from "./errors.js";
import { SubscriptionBrain } from "./index.js";
import { ANTIGRAVITY_MODELS, PROVIDER_DEFINITIONS, providerDefinition } from "./providers.js";
import { BusyError, RequestQueue } from "./request-queue.js";

describe("prompt handling is data, never shell syntax", () => {
  it("passes an injection payload through as a literal argument", async () => {
    // The previous bridge used spawn(..., { shell: true }), so a prompt like
    // this would have run `touch`. With an argv array it is just text.
    const payload = '"; touch /tmp/cadrane-pwned; echo "';
    const result = await runProcess({
      executablePath: "/bin/echo",
      args: [payload],
      timeoutMs: 5_000
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(payload);
  });

  it("treats backticks and $() as inert text", async () => {
    const payload = "`id` and $(id)";
    const result = await runProcess({
      executablePath: "/bin/echo",
      args: [payload],
      timeoutMs: 5_000
    });
    expect(result.stdout.trim()).toBe(payload);
  });
});

describe("runProcess boundaries", () => {
  it("reports a missing executable rather than pretending it ran", async () => {
    await expect(
      runProcess({
        executablePath: "/nonexistent/definitely-not-here",
        args: [],
        timeoutMs: 5_000
      })
    ).rejects.toMatchObject({
      name: "RuntimeBoundaryError",
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });
  });

  it("times out a process that will not finish", async () => {
    await expect(
      runProcess({ executablePath: "/bin/sleep", args: ["30"], timeoutMs: 300 })
    ).rejects.toMatchObject({
      name: "RuntimeBoundaryError",
      detail: { code: "TIMEOUT", retryable: true }
    });
  });

  it("surfaces a non-zero exit code instead of swallowing it", async () => {
    const result = await runProcess({
      executablePath: "/bin/sh",
      args: ["-c", "exit 3"],
      timeoutMs: 5_000
    });
    expect(result.code).toBe(3);
  });

  it("honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess({
        executablePath: "/bin/echo",
        args: ["hi"],
        timeoutMs: 5_000,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ detail: { code: "CANCELLED" } });
  });
});

describe("RequestQueue", () => {
  it("runs tasks one at a time", async () => {
    const queue = new RequestQueue({ minIntervalMs: 0, maxDepth: 10, sleep: async () => {} });
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (name: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(name);
      active -= 1;
    };

    await Promise.all([queue.run(task("a")), queue.run(task("b")), queue.run(task("c"))]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("waits the pacing interval between calls", async () => {
    let clock = 10_000;
    const slept: number[] = [];
    const queue = new RequestQueue({
      minIntervalMs: 1_200,
      maxDepth: 10,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      }
    });

    await queue.run(async () => undefined);
    await queue.run(async () => undefined);

    expect(slept).toEqual([1_200]);
  });

  it("rejects past the queue depth instead of piling up", async () => {
    const queue = new RequestQueue({ minIntervalMs: 0, maxDepth: 1, sleep: async () => {} });
    const first = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await expect(queue.run(async () => undefined)).rejects.toBeInstanceOf(BusyError);
    await first;
  });

  it("keeps running after a task rejects", async () => {
    const queue = new RequestQueue({ minIntervalMs: 0, maxDepth: 10, sleep: async () => {} });
    await expect(
      queue.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(queue.run(async () => "still works")).resolves.toBe("still works");
  });
});

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"quantity": 2000}')).toEqual({ quantity: 2000 });
  });

  it("reads an object inside a markdown fence", () => {
    expect(extractJsonObject('```json\n{"quantity": 2000}\n```')).toEqual({ quantity: 2000 });
  });

  it("reads an object after a preamble", () => {
    expect(extractJsonObject('Sure!\n{"quantity": 2000}')).toEqual({ quantity: 2000 });
  });

  it("returns null for prose", () => {
    expect(extractJsonObject("I could not parse that.")).toBeNull();
  });

  it("returns null for a top-level array", () => {
    expect(extractJsonObject("[1, 2, 3]")).toBeNull();
  });
});

describe("SubscriptionBrain refuses rather than invents", () => {
  it("errors when nothing is docked", async () => {
    const brain = new SubscriptionBrain();
    await expect(brain.ask({ prompt: "hello" })).rejects.toBeInstanceOf(RuntimeBoundaryError);
    await expect(brain.ask({ prompt: "hello" })).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });
  });

  it("reports capabilities as unknown before any probe has run", () => {
    const brain = new SubscriptionBrain();
    const capabilities = brain.capabilities();
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(capability.state).toBe("unknown");
      expect(capability.title).not.toMatch(/gemini|antigravity|claude/iu);
    }
  });

  it("has no docked provider on construction", () => {
    expect(new SubscriptionBrain().current).toBeNull();
  });
});

describe("provider definitions match the tools as installed", () => {
  it("builds Antigravity argv with the prompt as a single argument", () => {
    const args = providerDefinition("antigravity").buildArgs({
      prompt: "hello; rm -rf /",
      model: ANTIGRAVITY_MODELS.flashLow
    });
    expect(args).toEqual(["-p", "hello; rm -rf /", "--model", "gemini-3.7-flash-low"]);
  });

  it("omits the model flag for Gemini when none is chosen", () => {
    expect(providerDefinition("gemini").buildArgs({ prompt: "hi" })).toEqual(["-p", "hi"]);
  });

  it("prefers Claude, then Antigravity, then the plain Gemini CLI", () => {
    // Changed 2026-08-31. This used to assert Antigravity first, from a time
    // when it was the only subscription Rellane could drive. Claude Code is now
    // a first-class engine and offers the deepest tier on a plan the owner
    // already pays a flat fee for, so it leads.
    //
    // The order is a default and not a policy: a model pinned per task type in
    // the Engine Room beats this list, which is why this asserts the sequence
    // rather than asserting that anything is "the" provider.
    expect(PROVIDER_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "claude",
      "antigravity",
      "gemini"
    ]);
  });

  it("drives Claude through its print mode, never an interactive session", () => {
    // Without -p the binary opens a session and waits, which inside a packaged
    // app is an invisible hang rather than an error anybody can see.
    expect(providerDefinition("claude").buildArgs({ prompt: "hi", model: "opus" })).toEqual([
      "-p",
      "hi",
      "--model",
      "opus"
    ]);
  });

  it("names Claude models by alias, so a version bump does not make them lies", () => {
    // `claude-opus-5` stops resolving the day the next one ships; `opus` does
    // not. A status board that confidently names a model that no longer exists
    // is worse than one that names a tier.
    expect(providerDefinition("claude").defaultModel).toBe("sonnet");
  });

  it("uses the 3.7 flash identifiers that actually resolve", () => {
    // `agy models` still lists 3.6 as newest; 3.7 resolves and self-identifies.
    expect(Object.values(ANTIGRAVITY_MODELS)).toContain("gemini-3.7-flash-low");
  });
});
