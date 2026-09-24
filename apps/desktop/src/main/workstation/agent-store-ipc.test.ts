import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installAgentStore,
  type WorkstationAgentDeleteResult,
  type WorkstationAgentSaveResult,
  type WorkstationAgentsListResult,
} from "./agent-store-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => "test-owner-token",
}));

const fakeEvent = {
  sender: { id: 1 },
  senderFrame: { processId: 1, routingId: 1 },
} as unknown as IpcMainInvokeEvent;

async function invokeList(): Promise<WorkstationAgentsListResult> {
  const handler = handlers.get(IPC_CHANNELS.workstationAgentsList);
  if (!handler) {
    throw new Error("Listing handler is not registered.");
  }
  return (await handler(fakeEvent, {})) as WorkstationAgentsListResult;
}

async function invokeSave(input: unknown): Promise<WorkstationAgentSaveResult> {
  const handler = handlers.get(IPC_CHANNELS.workstationAgentSave);
  if (!handler) {
    throw new Error("Save handler is not registered.");
  }
  return (await handler(fakeEvent, input)) as WorkstationAgentSaveResult;
}

async function invokeDelete(input: unknown): Promise<WorkstationAgentDeleteResult> {
  const handler = handlers.get(IPC_CHANNELS.workstationAgentDelete);
  if (!handler) {
    throw new Error("Delete handler is not registered.");
  }
  return (await handler(fakeEvent, input)) as WorkstationAgentDeleteResult;
}

describe("installAgentStore", () => {
  it("creates a copy rather than overwriting when saving a bundled id", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-test-"));
    try {
      const bundledAgent = { id: "bundled-writer", markdown: "# Bundled Writer Prompt" };
      installAgentStore({
        assertTrusted: () => {},
        agentsFolder: () => tempDir,
        bundled: () => [bundledAgent],
      });

      const saveResult = await invokeSave({
        id: "bundled-writer",
        markdown: "# User Customized Writer",
      });

      expect(saveResult.id).toBe("bundled-writer-copy");
      expect(saveResult.updatedAt).toBeGreaterThan(0);

      const userCopyPath = path.join(tempDir, "bundled-writer-copy.md");
      const content = await fs.readFile(userCopyPath, "utf8");
      expect(content).toBe("# User Customized Writer");

      const bundledPath = path.join(tempDir, "bundled-writer.md");
      await expect(fs.access(bundledPath)).rejects.toThrow();

      const listResult = await invokeList();
      expect(listResult.agents.length).toBe(2);

      const bundledInList = listResult.agents.find((a) => a.id === "bundled-writer");
      if (!bundledInList) {
        throw new Error("Bundled agent missing from list.");
      }
      expect(bundledInList.origin).toBe("bundled");
      expect(bundledInList.markdown).toBe("# Bundled Writer Prompt");

      const userInList = listResult.agents.find((a) => a.id === "bundled-writer-copy");
      if (!userInList) {
        throw new Error("User agent missing from list.");
      }
      expect(userInList.origin).toBe("user");
      expect(userInList.markdown).toBe("# User Customized Writer");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses a traversal id and writes nothing outside the folder", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-test-"));
    try {
      installAgentStore({
        assertTrusted: () => {},
        agentsFolder: () => tempDir,
        bundled: () => [],
      });

      await expect(
        invokeSave({
          id: "../../etc/passwd",
          markdown: "malicious payload",
        })
      ).rejects.toThrow();

      const innerFiles = await fs.readdir(tempDir);
      expect(innerFiles.length).toBe(0);

      const escapeTarget = path.resolve(tempDir, "..", "passwd.md");
      await expect(fs.access(escapeTarget)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("round-trips an agent save and list cleanly", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-test-"));
    try {
      installAgentStore({
        assertTrusted: () => {},
        agentsFolder: () => tempDir,
        bundled: () => [],
      });

      const markdown = "# Researcher\n\nInvestigate market trends.";
      const saveResult = await invokeSave({
        id: "market-researcher",
        markdown,
      });

      expect(saveResult.id).toBe("market-researcher");
      expect(saveResult.updatedAt).toBeGreaterThan(0);

      const listResult = await invokeList();
      expect(listResult.agents.length).toBe(1);

      if (listResult.agents.length > 0) {
        const agent = listResult.agents[0]!;
        expect(agent.id).toBe("market-researcher");
        expect(agent.origin).toBe("user");
        expect(agent.markdown).toBe(markdown);
        expect(agent.updatedAt).toBe(saveResult.updatedAt);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns deleted false without error when deleting an absent agent", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-test-"));
    try {
      installAgentStore({
        assertTrusted: () => {},
        agentsFolder: () => tempDir,
        bundled: () => [],
      });

      const result = await invokeDelete({ id: "missing-agent" });
      expect(result.deleted).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
