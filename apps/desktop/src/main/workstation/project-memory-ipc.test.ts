import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  enforceMemoryLimits,
  forgetProjectMemory,
  installProjectMemory,
  learnProjectMemory,
  MAX_PROJECT_FACTS,
  MAX_PROJECT_MEMORY_BYTES,
  type ProjectMemoryFact,
  readProjectMemory,
  setProjectMemory,
} from "./project-memory-ipc.js";

type IpcHandler = (event: unknown, input: unknown) => Promise<unknown>;
const registeredHandlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
  },
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => "test-owner-token",
}));

describe("project-memory-ipc", () => {
  let tempRoot = "";
  let memoryFolder = "";

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rellane-mem-test-"));
    memoryFolder = path.join(tempRoot, "memory");
    await fs.promises.mkdir(memoryFolder, { recursive: true });
  });

  afterEach(async () => {
    registeredHandlers.clear();
    if (tempRoot.length > 0) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses path traversal attempts and writes nothing outside the folder", async () => {
    const maliciousIds = [
      "../../etc/passwd",
      "../escape",
      "..",
      ".",
      "nested/path",
      "has space",
    ];

    for (const badId of maliciousIds) {
      await expect(
        learnProjectMemory(memoryFolder, badId, ["Malicious memory payload"])
      ).rejects.toThrow();

      await expect(
        readProjectMemory(memoryFolder, badId)
      ).rejects.toThrow();
    }

    // Verify nothing escaped memoryFolder into the tempRoot directory.
    const rootFiles = await fs.promises.readdir(tempRoot);
    expect(rootFiles).toEqual(["memory"]);

    // Verify nothing was written inside memoryFolder either.
    const memoryFiles = await fs.promises.readdir(memoryFolder);
    expect(memoryFiles).toHaveLength(0);
  });

  it("recovers valid facts from a corrupt file and reports the skipped count", async () => {
    const fact1: ProjectMemoryFact = {
      id: "f-1",
      text: "VAT registration is GB123456789",
      confirmations: 2,
      pinned: false,
      hidden: false,
      createdAt: "2026-01-01T12:00:00.000Z",
      updatedAt: "2026-01-01T12:00:00.000Z",
      kind: "about-the-business",
      learnedFrom: "an earlier piece of work",
    };

    const fact2: ProjectMemoryFact = {
      id: "f-2",
      text: "Invoice terms set to 30 days net",
      confirmations: 1,
      pinned: true,
      hidden: false,
      createdAt: "2026-01-02T12:00:00.000Z",
      updatedAt: "2026-01-02T12:00:00.000Z",
      kind: "about-the-business",
      learnedFrom: "an earlier piece of work",
    };

    const corruptContent = [
      JSON.stringify(fact1),
      "CORRUPTED LINE: NOT VALID JSON {{{{",
      JSON.stringify(fact2),
      "",
    ].join("\n");

    const targetFile = path.join(memoryFolder, "project-alpha.json");
    await fs.promises.writeFile(targetFile, corruptContent, "utf8");

    const result = await readProjectMemory(memoryFolder, "project-alpha");
    expect(result.facts).toHaveLength(2);
    expect(result.skippedCount).toBe(1);

    const first = result.facts[0];
    const second = result.facts[1];
    expect(first?.id).toBe("f-1");
    expect(first?.text).toBe("VAT registration is GB123456789");
    expect(second?.id).toBe("f-2");
    expect(second?.text).toBe("Invoice terms set to 30 days net");
  });

  it("preserves hidden status across reload", async () => {
    const learnResult = await learnProjectMemory(
      memoryFolder,
      "amber-retail",
      ["Amber prefers quarterly stock reviews"]
    );
    expect(learnResult.facts).toHaveLength(1);

    const fact = learnResult.facts[0];
    if (!fact) {
      throw new Error("Expected initial fact to exist.");
    }
    expect(fact.hidden).toBe(false);

    const updateResult = await setProjectMemory(
      memoryFolder,
      "amber-retail",
      fact.id,
      { hidden: true }
    );
    expect(updateResult.facts[0]?.hidden).toBe(true);

    // Reload freshly from disk to ensure persistence survives session termination.
    const reloaded = await readProjectMemory(memoryFolder, "amber-retail");
    expect(reloaded.facts).toHaveLength(1);
    expect(reloaded.facts[0]?.id).toBe(fact.id);
    expect(reloaded.facts[0]?.hidden).toBe(true);
  });

  it("increments confirmations when learning duplicate findings", async () => {
    await learnProjectMemory(
      memoryFolder,
      "biz-one",
      ["Gemini Advanced subscription renewed monthly"]
    );

    const secondLearn = await learnProjectMemory(
      memoryFolder,
      "biz-one",
      ["gemini advanced subscription renewed monthly"]
    );

    expect(secondLearn.facts).toHaveLength(1);
    expect(secondLearn.facts[0]?.confirmations).toBe(2);
  });

  it("forgets a fact cleanly and updates the file on disk", async () => {
    const learnResult = await learnProjectMemory(
      memoryFolder,
      "biz-two",
      ["First finding to retain", "Second finding to forget"]
    );
    expect(learnResult.facts).toHaveLength(2);

    const toForget = learnResult.facts[1];
    if (!toForget) {
      throw new Error("Expected second fact to exist.");
    }

    const forgetResult = await forgetProjectMemory(
      memoryFolder,
      "biz-two",
      toForget.id
    );
    expect(forgetResult.facts).toHaveLength(1);
    expect(forgetResult.facts[0]?.text).toBe("First finding to retain.");

    const reloaded = await readProjectMemory(memoryFolder, "biz-two");
    expect(reloaded.facts).toHaveLength(1);
    expect(reloaded.facts[0]?.text).toBe("First finding to retain.");
  });

  it("drops least-confirmed unpinned facts when limits are exceeded while preserving pinned facts", () => {
    const facts: ProjectMemoryFact[] = [
      {
        id: "p-1",
        text: "Crucial pinned business rule",
        confirmations: 1,
        pinned: true,
        hidden: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "about-the-business",
        learnedFrom: "an earlier piece of work",
      },
      {
        id: "u-1",
        text: "Low confirmation unpinned note",
        confirmations: 1,
        pinned: false,
        hidden: false,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        kind: "about-the-business",
        learnedFrom: "an earlier piece of work",
      },
      {
        id: "u-2",
        text: "High confirmation unpinned note",
        confirmations: 5,
        pinned: false,
        hidden: false,
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        kind: "about-the-business",
        learnedFrom: "an earlier piece of work",
      },
    ];

    // Artificially simulate fact count exceeding MAX_PROJECT_FACTS.
    const padded: ProjectMemoryFact[] = [...facts];
    while (padded.length <= MAX_PROJECT_FACTS) {
      padded.push({
        id: `auto-${padded.length}`,
        text: `Repeated item ${padded.length}`,
        confirmations: 2,
        pinned: false,
        hidden: false,
        createdAt: "2026-01-04T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z",
        kind: "about-the-business",
        learnedFrom: "an earlier piece of work",
      });
    }

    const { facts: capped, droppedCount } = enforceMemoryLimits(padded);
    expect(capped.length).toBeLessThanOrEqual(MAX_PROJECT_FACTS);
    expect(droppedCount).toBeGreaterThan(0);

    // Pinned fact must never be dropped despite low confirmation count.
    expect(capped.some((f) => f.id === "p-1")).toBe(true);
    // Unpinned fact with 1 confirmation should have been dropped first.
    expect(capped.some((f) => f.id === "u-1")).toBe(false);
  });

  it("wires IPC handlers correctly and verifies trusted caller", async () => {
    const assertTrusted = vi.fn();
    installProjectMemory({
      assertTrusted,
      folder: () => memoryFolder,
    });

    const learnHandler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryLearn);
    expect(learnHandler).toBeDefined();

    const mockEvent = { sender: {}, senderFrame: {} };
    const res = (await learnHandler!(mockEvent, {
      projectId: "ipc-project",
      findings: ["Fact learned over IPC bridge"],
    })) as { facts: readonly ProjectMemoryFact[] };

    expect(assertTrusted).toHaveBeenCalled();
    expect(res.facts).toHaveLength(1);
    expect(res.facts[0]?.text).toBe("Fact learned over IPC bridge.");
  });
});
