import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  collectProbedFacts,
  extractFolderBasename,
  installSelfCheck,
  sanitizeDetail,
  type InstallSelfCheckOptions
} from "./self-check-ipc.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const registeredHandlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      registeredHandlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      registeredHandlers.delete(channel);
    }
  }
}));

vi.mock("../../shared/ipc-channels.js", () => ({
  IPC_CHANNELS: {
    workstationSelfCheck: "workstation:self-check"
  }
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => {
    return (sender: unknown) => {
      if (sender && typeof sender === "object" && "id" in sender) {
        return `owner-${String((sender as { id: unknown }).id)}`;
      }
      return "owner-default";
    };
  }
}));

describe("self-check-ipc", () => {
  it("returns a full ProbedFacts with appropriate nulls when every probe rejects", async () => {
    const options: InstallSelfCheckOptions = {
      assertTrusted: () => {},
      probeBook: vi.fn().mockRejectedValue(new Error("Database locked")),
      probeProviders: vi.fn().mockRejectedValue(new Error("Discovery failed")),
      probeLocalModel: vi.fn().mockRejectedValue(new Error("Local model failed")),
      probeFolders: vi.fn().mockRejectedValue(new Error("Permission denied")),
      probeTelegram: vi.fn().mockRejectedValue(new Error("Network error")),
      probeKeychain: vi.fn().mockImplementation(() => {
        throw new Error("Keychain locked");
      }),
      probeDisk: vi.fn().mockRejectedValue(new Error("statfs failed")),
      lastBackupAt: vi.fn().mockRejectedValue(new Error("Backup check failed"))
    };

    const facts = await collectProbedFacts(options, 200);

    expect(facts.bookOpen).toBe(false);
    expect(facts.bookTables).toBeNull();
    expect(facts.providersDetected).toEqual([]);
    expect(facts.providersMissing).toEqual([]);
    expect(facts.localModelReady).toBe(false);
    expect(facts.localModelDetail).toBe("Unknown");
    expect(facts.foldersGranted).toBe(0);
    expect(facts.foldersLost).toEqual([]);
    expect(facts.telegramLinked).toBe(false);
    expect(facts.telegramChatPaired).toBe(false);
    expect(facts.keychainAvailable).toBe(false);
    expect(facts.diskFreeBytes).toBeNull();
    expect(facts.lastBackupAt).toBeNull();
    expect(typeof facts.now).toBe("number");
    expect(facts.now).toBeGreaterThan(0);
  });

  it("does not hang when a probe never settles and respects the budget", async () => {
    const options: InstallSelfCheckOptions = {
      assertTrusted: () => {},
      probeBook: () => new Promise(() => {}),
      probeProviders: async () => [
        { id: "claude", label: "Claude", detected: true, detail: "Ready" }
      ],
      probeLocalModel: () => new Promise(() => {}),
      probeFolders: async () => ({ granted: 2, lost: [] }),
      probeTelegram: async () => ({ linked: true, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: () => new Promise(() => {}),
      lastBackupAt: async () => 1700000000000
    };

    const start = Date.now();
    const facts = await collectProbedFacts(options, 50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(facts.bookOpen).toBe(false);
    expect(facts.bookTables).toBeNull();
    expect(facts.localModelReady).toBe(false);
    expect(facts.localModelDetail).toBe("Unknown");
    expect(facts.diskFreeBytes).toBeNull();

    expect(facts.providersDetected).toEqual([{ id: "claude", label: "Claude" }]);
    expect(facts.foldersGranted).toBe(2);
    expect(facts.telegramLinked).toBe(true);
    expect(facts.telegramChatPaired).toBe(false);
    expect(facts.keychainAvailable).toBe(true);
    expect(facts.lastBackupAt).toBe(1700000000000);
  });

  it("names lost folders by their last component only without any path", async () => {
    expect(extractFolderBasename("/Users/amber/Documents/Invoices")).toBe("Invoices");
    expect(extractFolderBasename("/Users/amber/Documents/Tax Receipts/")).toBe("Tax Receipts");
    expect(extractFolderBasename("C:\\Users\\amber\\Data")).toBe("Data");
    expect(extractFolderBasename("C:\\Users\\amber\\Data\\")).toBe("Data");
    expect(extractFolderBasename("/var/log")).toBe("log");
    expect(extractFolderBasename("Archive")).toBe("Archive");
    expect(extractFolderBasename("")).toBe("Unknown folder");
    expect(extractFolderBasename("/")).toBe("Unknown folder");

    const options: InstallSelfCheckOptions = {
      assertTrusted: () => {},
      probeBook: async () => ({ open: true, tables: 5 }),
      probeProviders: async () => [],
      probeLocalModel: async () => ({ ready: true, detail: "Ready" }),
      probeFolders: async () => ({
        granted: 2,
        lost: [
          "/Users/amber/Library/Preferences",
          "/Volumes/Vault/Receipts/",
          "C:\\Users\\amber\\Invoices"
        ]
      }),
      probeTelegram: async () => ({ linked: false, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: async () => 1_000_000,
      lastBackupAt: async () => null
    };

    const facts = await collectProbedFacts(options, 200);
    expect(facts.foldersLost).toEqual(["Preferences", "Receipts", "Invoices"]);
    for (const folder of facts.foldersLost) {
      expect(folder).not.toContain("/");
      expect(folder).not.toContain("\\");
    }
  });

  it("sanitizes details by removing paths, executables, tokens, and stack traces", async () => {
    const dirtyDetail =
      "Error: command failed: /usr/local/bin/ollama.exe --version with token sk-ant-api03-12345678901234567890\n    at ChildProcess.exithandler (/Users/amber/app.js:12:34)";

    const sanitized = sanitizeDetail(dirtyDetail);
    expect(sanitized).not.toContain("/usr/local/bin");
    expect(sanitized).not.toContain("ollama.exe");
    expect(sanitized).not.toContain("sk-ant-api03");
    expect(sanitized).not.toContain("ChildProcess.exithandler");
    expect(sanitized).not.toContain("/Users/amber");

    const options: InstallSelfCheckOptions = {
      assertTrusted: () => {},
      probeBook: async () => ({ open: true, tables: 8 }),
      probeProviders: async () => [
        {
          id: "ollama",
          label: "Ollama",
          detected: false,
          detail: "spawn /opt/homebrew/bin/ollama ENOENT\n    at run (/app/cli.js:4:5)"
        }
      ],
      probeLocalModel: async () => ({
        ready: false,
        detail: "Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w at /var/run/model.sock:1:1"
      }),
      probeFolders: async () => ({ granted: 1, lost: [] }),
      probeTelegram: async () => ({ linked: false, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: async () => null,
      lastBackupAt: async () => null
    };

    const facts = await collectProbedFacts(options, 200);
    expect(facts.providersMissing.length).toBeGreaterThan(0);
    const missingDetail = facts.providersMissing[0]!.detail;
    expect(missingDetail).not.toContain("/opt/homebrew/bin");
    expect(missingDetail).not.toContain("cli.js");

    expect(facts.localModelDetail).not.toContain("Bearer");
    expect(facts.localModelDetail).not.toContain("eyJ");
    expect(facts.localModelDetail).not.toContain("/var/run");
  });

  it("joins an in-flight check rather than starting a concurrent duplicate", async () => {
    let probeCount = 0;
    const probeBookMock = vi.fn().mockImplementation(async () => {
      probeCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { open: true, tables: 10 };
    });

    const options: InstallSelfCheckOptions = {
      assertTrusted: vi.fn(),
      probeBook: probeBookMock,
      probeProviders: async () => [],
      probeLocalModel: async () => ({ ready: true, detail: "Ready" }),
      probeFolders: async () => ({ granted: 1, lost: [] }),
      probeTelegram: async () => ({ linked: false, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: async () => 500,
      lastBackupAt: async () => 1000
    };

    installSelfCheck(options);

    const handler = registeredHandlers.get("workstation:self-check");
    expect(handler).toBeDefined();

    const fakeEvent1 = { sender: { id: 1 }, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    const fakeEvent2 = { sender: { id: 1 }, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    const [result1, result2] = await Promise.all([
      handler!(fakeEvent1, {}),
      handler!(fakeEvent2, {})
    ]);

    expect(result1).toEqual(result2);
    expect(probeCount).toBe(1);
  });

  it("rejects untrusted senders and rejects invalid inputs", async () => {
    const options: InstallSelfCheckOptions = {
      assertTrusted: vi.fn().mockImplementation((event: { trusted?: boolean }) => {
        if (!event.trusted) {
          throw new Error("Untrusted sender");
        }
      }),
      probeBook: async () => ({ open: true, tables: 4 }),
      probeProviders: async () => [],
      probeLocalModel: async () => ({ ready: true, detail: "Ready" }),
      probeFolders: async () => ({ granted: 1, lost: [] }),
      probeTelegram: async () => ({ linked: false, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: async () => null,
      lastBackupAt: async () => null
    };

    installSelfCheck(options);
    const handler = registeredHandlers.get("workstation:self-check");
    expect(handler).toBeDefined();

    const untrustedEvent = { trusted: false, sender: { id: 1 }, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    await expect(handler!(untrustedEvent, {})).rejects.toThrow("Untrusted sender");

    const trustedEvent = { trusted: true, sender: { id: 1 }, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    await expect(handler!(trustedEvent, "invalid string input")).rejects.toThrow();
  });

  it("includes formatted probe sentences when includeProbeSentences is requested", async () => {
    const options: InstallSelfCheckOptions = {
      assertTrusted: vi.fn(),
      probeBook: async () => ({ open: true, tables: 12 }),
      probeProviders: async () => [],
      probeLocalModel: async () => ({ ready: true, detail: "Qwen ready" }),
      probeFolders: async () => ({ granted: 1, lost: [] }),
      probeTelegram: async () => ({ linked: false, chatPaired: false }),
      probeKeychain: () => true,
      probeDisk: async () => 2048,
      lastBackupAt: async () => null
    };

    installSelfCheck(options);
    const handler = registeredHandlers.get("workstation:self-check")!;
    const event = { sender: { id: 1 }, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    const result = (await handler(event, { includeProbeSentences: true })) as {
      probeResults?: readonly { id: string; outcome: string; sentence: string }[];
    };

    expect(result.probeResults).toBeDefined();
    expect(result.probeResults).toHaveLength(3);
    expect(result.probeResults?.[0]?.sentence).toContain("Checked just now");
    expect(result.probeResults?.[0]?.sentence).toContain("12 tables");
  });
});
