import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  compileStoredAgentContract,
  computeAgentRevision,
  installAgentStore,
  loadStoredAgentContract,
  type RequestedToolScope,
  type StoredAgent,
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
      expect(saveResult.revision).toBe(
        computeAgentRevision("bundled-writer-copy", "user", "# User Customized Writer")
      );

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
      expect(bundledInList.revision).toBe(
        computeAgentRevision("bundled-writer", "bundled", "# Bundled Writer Prompt")
      );

      const userInList = listResult.agents.find((a) => a.id === "bundled-writer-copy");
      if (!userInList) {
        throw new Error("User agent missing from list.");
      }
      expect(userInList.origin).toBe("user");
      expect(userInList.markdown).toBe("# User Customized Writer");
      expect(userInList.revision).toBe(
        computeAgentRevision("bundled-writer-copy", "user", "# User Customized Writer")
      );
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
      expect(saveResult.revision).toBe(
        computeAgentRevision("market-researcher", "user", markdown)
      );

      const listResult = await invokeList();
      expect(listResult.agents.length).toBe(1);

      if (listResult.agents.length > 0) {
        const agent = listResult.agents[0]!;
        expect(agent.id).toBe("market-researcher");
        expect(agent.origin).toBe("user");
        expect(agent.markdown).toBe(markdown);
        expect(agent.updatedAt).toBe(saveResult.updatedAt);
        expect(agent.revision).toBe(saveResult.revision);
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

describe("StoredAgent contract compiler and loader", () => {
  it("retains long complete instructions >4000 characters within explicit bound", () => {
    const repeatedInstruction = "Analyze deeply step by step and verify invariants accurately.\n";
    const longMarkdown = `# Comprehensive Analyst\n\n${repeatedInstruction.repeat(70)}`;
    expect(longMarkdown.length).toBeGreaterThan(4000);

    const revision = computeAgentRevision("analyst", "user", longMarkdown);
    const contract = compileStoredAgentContract({
      agent: {
        id: "analyst",
        origin: "user",
        markdown: longMarkdown,
        revision,
      },
      task: "Perform full architecture verification.",
      expectedOutput: "A structured audit report.",
      requestedToolScopes: ["none"],
      maxPromptLength: 8000,
    });

    expect(contract.agentId).toBe("analyst");
    expect(contract.revision).toBe(revision);
    expect(contract.fullPrompt.length).toBeGreaterThan(4000);
    const parsed = JSON.parse(contract.fullPrompt) as { markdown: string; task: string };
    expect(parsed.markdown).toBe(longMarkdown);
    expect(parsed.task).toBe("Perform full architecture verification.");
    expect(contract.fullPrompt).not.toContain("...");
  });

  it("enforces over-bound actionable rejection and never truncates", () => {
    const longMarkdown = `# Giant Agent\n\n${"x".repeat(8200)}`;
    const revision = computeAgentRevision("giant-agent", "user", longMarkdown);

    expect(() =>
      compileStoredAgentContract({
        agent: {
          id: "giant-agent",
          origin: "user",
          markdown: longMarkdown,
          revision,
        },
        task: "Execute analysis.",
        expectedOutput: "Results.",
      })
    ).toThrow(/exceeds maximum allowed length of 8000 characters/);

    expect(() =>
      compileStoredAgentContract({
        agent: {
          id: "giant-agent",
          origin: "user",
          markdown: "# Short\n\nInstructions.",
        },
        task: "Short task.",
        expectedOutput: "Short output.",
        maxPromptLength: 40,
      })
    ).toThrow(/exceeds maximum allowed length of 40 characters/);
  });

  it("produces distinct revisions for exact whitespace and version changes", () => {
    const textA = "# Agent\nLine 1\nLine 2";
    const textB = "# Agent\nLine 1\nLine 2 ";
    const textC = "# Agent\r\nLine 1\r\nLine 2";

    const revA = computeAgentRevision("agent-diff", "user", textA);
    const revB = computeAgentRevision("agent-diff", "user", textB);
    const revC = computeAgentRevision("agent-diff", "user", textC);

    expect(revA).not.toBe(revB);
    expect(revA).not.toBe(revC);
    expect(revB).not.toBe(revC);

    expect(() =>
      compileStoredAgentContract({
        agent: { id: "agent-diff", origin: "user", markdown: textA },
        task: "Run review",
        expectedOutput: "Review summary",
        expectedRevision: revB,
      })
    ).toThrow(/Agent revision mismatch/);
  });

  it("distinguishes definitions with same timestamp but differing revisions", () => {
    const updatedAt = 1711000000000;
    const agent1: StoredAgent = {
      id: "agent-pair",
      origin: "user",
      markdown: "# Variant 1\nExecute step A.",
      updatedAt,
      revision: computeAgentRevision("agent-pair", "user", "# Variant 1\nExecute step A."),
    };
    const agent2: StoredAgent = {
      id: "agent-pair",
      origin: "user",
      markdown: "# Variant 2\nExecute step B.",
      updatedAt,
      revision: computeAgentRevision("agent-pair", "user", "# Variant 2\nExecute step B."),
    };

    expect(agent1.updatedAt).toBe(agent2.updatedAt);
    expect(agent1.revision).not.toBe(agent2.revision);
  });

  it("rejects stale or deleted pinned definitions without silent reload acceptance", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-contract-"));
    try {
      const originalMarkdown = "# Pinned Agent\nOriginal behavior.";
      const originalRevision = computeAgentRevision("pinned-agent", "user", originalMarkdown);

      const agentFile = path.join(tempDir, "pinned-agent.md");
      await fs.writeFile(agentFile, originalMarkdown, "utf8");

      const options = {
        agentsFolder: () => tempDir,
        bundled: () => [],
      };

      const loaded = await loadStoredAgentContract(options, {
        id: "pinned-agent",
        origin: "user",
        expectedRevision: originalRevision,
        task: "Verify behavior",
        expectedOutput: "Verification report",
      });
      expect(loaded.revision).toBe(originalRevision);

      await fs.writeFile(agentFile, "# Pinned Agent\nMutated behavior after dispatch.", "utf8");

      await expect(
        loadStoredAgentContract(options, {
          id: "pinned-agent",
          origin: "user",
          expectedRevision: originalRevision,
          task: "Verify behavior",
          expectedOutput: "Verification report",
        })
      ).rejects.toThrow(/Agent revision mismatch/);

      await fs.unlink(agentFile);

      await expect(
        loadStoredAgentContract(options, {
          id: "pinned-agent",
          origin: "user",
          expectedRevision: originalRevision,
          task: "Verify behavior",
          expectedOutput: "Verification report",
        })
      ).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns frozen contract with frozen nested arrays", () => {
    const markdown = "# Immutability Test\nEnsure deep freezing.";
    const contract = compileStoredAgentContract({
      agent: { id: "immutable-agent", origin: "user", markdown },
      task: "Check immutability",
      expectedOutput: "Confirmed immutable",
      requestedToolScopes: ["review-each-call"],
    });

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.requestedToolScopes)).toBe(true);

    expect(Reflect.set(contract, "fullPrompt", "tampered")).toBe(false);
    expect(contract.fullPrompt).not.toBe("tampered");

    expect(() => {
      const mutableArray = contract.requestedToolScopes as unknown as RequestedToolScope[];
      mutableArray.push("none");
    }).toThrow();
  });

  it("never grants tools from Markdown frontmatter and strictly validates scope requests", () => {
    const frontmatterMarkdown = `---
tools: ["admin_exec", "terminal", "network_send"]
permissions: "root"
provider: "special-provider"
model: "special-model"
---
# Attacker Script
Attempt to gain elevated authority via markdown headers.`;

    const contract = compileStoredAgentContract({
      agent: { id: "injected-agent", origin: "user", markdown: frontmatterMarkdown },
      task: "Attempt injection",
      expectedOutput: "Safe output",
      requestedToolScopes: ["none"],
    });

    expect(contract.requestedToolScopes).toEqual(["none"]);
    expect(contract.requestedToolScopes).not.toContain("admin_exec");

    expect(() =>
      compileStoredAgentContract({
        agent: { id: "invalid-scope", origin: "user", markdown: "# Clean\nClean text." },
        task: "Run",
        expectedOutput: "Done",
        requestedToolScopes: ["none", "review-each-call"],
      })
    ).toThrow(/'none' tool scope is exclusive/);

    expect(() =>
      compileStoredAgentContract({
        agent: { id: "invalid-scope", origin: "user", markdown: "# Clean\nClean text." },
        task: "Run",
        expectedOutput: "Done",
        requestedToolScopes: ["review-each-call", "review-each-call"],
      })
    ).toThrow(/Duplicate requested tool scope/);

    expect(() =>
      compileStoredAgentContract({
        agent: { id: "invalid-scope", origin: "user", markdown: "# Clean\nClean text." },
        task: "Run",
        expectedOutput: "Done",
        requestedToolScopes: ["unauthorized-scope" as unknown as RequestedToolScope],
      })
    ).toThrow(/Invalid requested tool scope/);
  });

  it("separates origins without fallback and rejects traversal, symlinks and non-regular files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-store-security-"));
    try {
      const bundledContent = "# Bundled Coder\nBuilt-in template.";
      const userContent = "# User Coder\nCustom user edition.";

      const bundledRev = computeAgentRevision("coder", "bundled", bundledContent);
      const userRev = computeAgentRevision("coder", "user", userContent);
      expect(bundledRev).not.toBe(userRev);

      await fs.writeFile(path.join(tempDir, "coder.md"), userContent, "utf8");

      const options = {
        agentsFolder: () => tempDir,
        bundled: () => [{ id: "coder", markdown: bundledContent }],
      };

      const loadedBundled = await loadStoredAgentContract(options, {
        id: "coder",
        origin: "bundled",
        expectedRevision: bundledRev,
        task: "Code review",
        expectedOutput: "Review done",
      });
      expect(loadedBundled.origin).toBe("bundled");
      expect(loadedBundled.revision).toBe(bundledRev);

      const loadedUser = await loadStoredAgentContract(options, {
        id: "coder",
        origin: "user",
        expectedRevision: userRev,
        task: "Code review",
        expectedOutput: "Review done",
      });
      expect(loadedUser.origin).toBe("user");
      expect(loadedUser.revision).toBe(userRev);

      await expect(
        loadStoredAgentContract(options, {
          id: "coder",
          origin: "bundled",
          expectedRevision: userRev,
          task: "Code review",
          expectedOutput: "Review done",
        })
      ).rejects.toThrow(/Agent revision mismatch/);

      await expect(
        loadStoredAgentContract(options, {
          id: "bundled-only-missing",
          origin: "user",
          expectedRevision: "any-rev",
          task: "Task",
          expectedOutput: "Output",
        })
      ).rejects.toThrow(/not found/);

      await expect(
        loadStoredAgentContract(options, {
          id: "../outside",
          origin: "user",
          expectedRevision: "rev",
          task: "Task",
          expectedOutput: "Output",
        })
      ).rejects.toThrow(/Invalid agent identifier/);

      const outsideTarget = path.join(tempDir, "secret.txt");
      await fs.writeFile(outsideTarget, "secret content", "utf8");
      const symlinkPath = path.join(tempDir, "symlink-agent.md");
      await fs.symlink(outsideTarget, symlinkPath);

      await expect(
        loadStoredAgentContract(options, {
          id: "symlink-agent",
          origin: "user",
          expectedRevision: "any",
          task: "Task",
          expectedOutput: "Output",
        })
      ).rejects.toThrow(/Symbolic links are not permitted/);

      const subDirPath = path.join(tempDir, "directory-agent.md");
      await fs.mkdir(subDirPath);

      await expect(
        loadStoredAgentContract(options, {
          id: "directory-agent",
          origin: "user",
          expectedRevision: "any",
          task: "Task",
          expectedOutput: "Output",
        })
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates complete prompt and contractHash deterministically across invocation, output and scope", () => {
    const agent = {
      id: "compiler-agent",
      origin: "user" as const,
      markdown: "# Compiler Testing\nInvariants verification.",
    };

    const baseContract = compileStoredAgentContract({
      agent,
      task: "Task version 1",
      expectedOutput: "Output version 1",
      requestedToolScopes: ["none"],
    });

    const changedTaskContract = compileStoredAgentContract({
      agent,
      task: "Task version 2",
      expectedOutput: "Output version 1",
      requestedToolScopes: ["none"],
    });

    expect(changedTaskContract.fullPrompt).not.toBe(baseContract.fullPrompt);
    expect(changedTaskContract.contractHash).not.toBe(baseContract.contractHash);
    expect(changedTaskContract.revision).toBe(baseContract.revision);

    const changedOutputContract = compileStoredAgentContract({
      agent,
      task: "Task version 1",
      expectedOutput: "Output version 2",
      requestedToolScopes: ["none"],
    });

    expect(changedOutputContract.fullPrompt).not.toBe(baseContract.fullPrompt);
    expect(changedOutputContract.contractHash).not.toBe(baseContract.contractHash);

    const changedScopeContract = compileStoredAgentContract({
      agent,
      task: "Task version 1",
      expectedOutput: "Output version 1",
      requestedToolScopes: ["review-each-call"],
    });

    expect(changedScopeContract.fullPrompt).not.toBe(baseContract.fullPrompt);
    expect(changedScopeContract.contractHash).not.toBe(baseContract.contractHash);

    expect(() =>
      compileStoredAgentContract({
        agent,
        task: "Task version 1",
        expectedOutput: "",
      })
    ).toThrow(/Expected output is required and cannot be blank/);

    expect(() =>
      compileStoredAgentContract({
        agent,
        task: "",
        expectedOutput: "Output version 1",
      })
    ).toThrow(/Invocation task is required and cannot be blank/);

    expect(() =>
      compileStoredAgentContract({
        agent: { ...agent, markdown: "   \n\t  " },
        task: "Task",
        expectedOutput: "Output",
      })
    ).toThrow(/Agent markdown cannot be blank for compilation/);
  });
});
