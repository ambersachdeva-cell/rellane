import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createGeminiWorker } from "./gemini.js";
import type { NativeEvent } from "./types.js";

interface MockChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  killed: boolean;
  exitCode: number | null;
  pid: number;
}

let lastSpawn: {
  executable: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
} | null = null;
let currentMockChild: MockChildProcess | null = null;

vi.mock("node:child_process", () => {
  return {
    spawn: (
      executable: string,
      args: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv }
    ) => {
      lastSpawn = { executable, args, options };
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter() as unknown as MockChildProcess;
      emitter.stdout = stdout;
      emitter.stdin = stdin;
      emitter.stderr = stderr;
      emitter.killed = false;
      emitter.exitCode = null;
      emitter.pid = 9876;
      emitter.kill = (signal) => {
        emitter.killed = true;
        if (signal === "SIGTERM") {
          setTimeout(() => {
            if (emitter.exitCode === null) {
              emitter.exitCode = 143;
              emitter.emit("close", 143);
            }
          }, 5);
        }
        return true;
      };
      currentMockChild = emitter;
      return emitter;
    }
  };
});

describe("createGeminiWorker", () => {
  it("parses structured NDJSON init and step_update events, accumulating text", async () => {
    const events: NativeEvent[] = [];
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      profileHome: "/Users/example/agy-setup/config2",
      onEvent: (ev) => events.push(ev)
    });

    const runPromise = worker.run("Explain quantum mechanics in one sentence.");

    expect(currentMockChild).not.toBeNull();
    const mock = currentMockChild!;

    // Verify args and child-scoped HOME
    expect(lastSpawn?.executable).toBe("/Users/example/.local/bin/agy");
    expect(lastSpawn?.args).toContain("--sandbox");
    expect(lastSpawn?.args).toContain("--mode");
    expect(lastSpawn?.args).toContain("plan");
    // The CLI's own ceiling, so a stalled session cannot hold a subscription
    // open indefinitely waiting for the local timer.
    expect(lastSpawn?.args).toContain("--print-timeout");
    expect(lastSpawn?.args).toContain("25m");
    expect(lastSpawn?.options.env?.["HOME"]).toBe("/Users/example/agy-setup/config2");

    // Emit init event
    mock.stdout.write(
      JSON.stringify({
        event: "init",
        conversation_id: "conv-abc-123",
        model: "gemini-3.8-flash-high"
      }) + "\n"
    );

    // Emit step_update deltas
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        text_delta: "Quantum mechanics is ",
        step_type: "response",
        step_index: 1,
        state: "streaming"
      }) + "\n"
    );
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        text_delta: "the physics of the very small.",
        step_type: "response",
        step_index: 2,
        state: "completed"
      }) + "\n"
    );

    // Emit result event
    mock.stdout.write(
      JSON.stringify({
        event: "result",
        status: "SUCCESS"
      }) + "\n"
    );

    mock.emit("close", 0);

    const result = await runPromise;
    expect(result.finishReason).toBe("completed");
    expect(result.sessionId).toBe("conv-abc-123");
    expect(result.text).toBe("Quantum mechanics is the physics of the very small.");
    expect(result.modelId).toBe("gemini-3.8-flash-high");

    // Verify events were emitted to consumer
    expect(events.some((e) => e.type === "session" && e.sessionId === "conv-abc-123")).toBe(true);
    expect(events.filter((e) => e.type === "text").length).toBe(2);
  });

  it("handles soft denial with denied_actions, returning finishReason denied with non-empty message", async () => {
    const events: NativeEvent[] = [];
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: (ev) => events.push(ev)
    });

    const runPromise = worker.run("Run rm -rf /");
    const mock = currentMockChild!;

    mock.stdout.write(
      JSON.stringify({
        event: "init",
        conversation_id: "conv-denial-test",
        model: "gemini-3.8-flash-high"
      }) + "\n"
    );

    mock.stdout.write(
      JSON.stringify({
        event: "result",
        status: "SUCCESS",
        denied_actions: ["execute_bash", "filesystem_write"]
      }) + "\n"
    );

    mock.emit("close", 0);

    const result = await runPromise;
    expect(result.finishReason).toBe("denied");
    // What was refused belongs in the detail. Writing a sentence about the
    // denial into `text` would put words in the room as if the provider had
    // written them, which is the one thing a transcript must not do.
    expect(result.text).toBe("");
    expect(result.detail).toContain("execute_bash");
    expect(result.detail).toContain("filesystem_write");
  });

  it("rejects SUCCESS with empty response, returning finishReason failed", async () => {
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: () => {}
    });

    const runPromise = worker.run("Do nothing");
    const mock = currentMockChild!;

    mock.stdout.write(
      JSON.stringify({
        event: "init",
        conversation_id: "conv-empty-test"
      }) + "\n"
    );
    mock.stdout.write(
      JSON.stringify({
        event: "result",
        status: "SUCCESS"
      }) + "\n"
    );

    mock.emit("close", 0);

    const result = await runPromise;
    expect(result.finishReason).toBe("failed");
    expect(result.detail).toContain("wrote nothing");
  });

  it("does not call a stream that ended without a result a completed answer", async () => {
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: () => {}
    });

    const runPromise = worker.run("Answer then die");
    const mock = currentMockChild!;

    mock.stdout.write(
      JSON.stringify({ event: "step_update", text_delta: "Half an answer" }) + "\n"
    );
    // Exit zero, no result event. A clean exit code is not the provider saying
    // it finished; the partial text is kept and the outcome is not a success.
    mock.emit("close", 0);

    const result = await runPromise;
    expect(result.finishReason).toBe("failed");
    expect(result.text).toBe("Half an answer");
    expect(result.detail).toContain("before the provider reported a result");
  });

  it("handles malformed NDJSON lines without crashing and parses subsequent valid lines", async () => {
    const textChunks: string[] = [];
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: (ev) => {
        if (ev.type === "text") {
          textChunks.push(ev.text);
        }
      }
    });

    const runPromise = worker.run("Test malformed resilience");
    const mock = currentMockChild!;

    mock.stdout.write("Not a json line\n");
    mock.stdout.write("{ corrupted json payload...\n");
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        text_delta: "Recovered after junk."
      }) + "\n"
    );
    mock.stdout.write(
      JSON.stringify({
        event: "result",
        status: "SUCCESS"
      }) + "\n"
    );

    mock.emit("close", 0);

    const result = await runPromise;
    expect(result.finishReason).toBe("completed");
    expect(result.text).toBe("Recovered after junk.");
  });

  it("preserves global process.env.HOME when executing with child-scoped profileHome", async () => {
    const originalHome = process.env["HOME"];
    const customProfileHome = "/custom/isolated/home/config3";

    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      profileHome: customProfileHome,
      onEvent: () => {}
    });

    const runPromise = worker.run("Check env isolation");
    expect(lastSpawn?.options.env?.["HOME"]).toBe(customProfileHome);
    expect(process.env["HOME"]).toBe(originalHome);

    const mock = currentMockChild!;
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        text_delta: "Env checked."
      }) + "\n"
    );
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    mock.emit("close", 0);

    await runPromise;
    expect(process.env["HOME"]).toBe(originalHome);
  });

  it("passes --conversation argument when resumeId is configured", async () => {
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      resumeId: "conv-resume-999",
      onEvent: () => {}
    });

    const runPromise = worker.run("Continue previous discussion");
    expect(lastSpawn?.args).toContain("--conversation");
    expect(lastSpawn?.args).toContain("conv-resume-999");

    const mock = currentMockChild!;
    mock.stdout.write(
      JSON.stringify({ event: "step_update", text_delta: "Resumed text." }) + "\n"
    );
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    mock.emit("close", 0);

    const res = await runPromise;
    expect(res.sessionId).toBe("conv-resume-999");
  });

  it("stops execution when interrupt is called", async () => {
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: () => {}
    });

    const runPromise = worker.run("Long task");
    const interruptResult = await worker.interrupt();
    // A signal is not an acknowledgement. Headless stream-json has no reply to
    // wait for, and saying otherwise would be a claim about the CLI.
    expect(interruptResult.acknowledged).toBe(false);
    expect(interruptResult.detail).toContain("SIGTERM");

    const result = await runPromise;
    expect(result.finishReason).toBe("stopped");
  });

  it("fails closed on decide() as headless Antigravity CLI does not accept approval RPC", async () => {
    const worker = createGeminiWorker({
      executable: "/Users/example/.local/bin/agy",
      cwd: "/Users/example/project",
      onEvent: () => {}
    });

    await expect(worker.decide("perm-bash-exec", true)).rejects.toThrow(
      /does not support interactive tool approvals/
    );
  });
});
