import { describe, expect, it } from "vitest";
import { runSelfCheck, type ProbedFacts } from "./self-check.js";

function makeFacts(overrides: Partial<ProbedFacts> = {}): ProbedFacts {
  const base: ProbedFacts = {
    bookOpen: true,
    bookTables: 8,
    providersDetected: [{ id: "claude", label: "Claude" }],
    providersMissing: [],
    localModelReady: true,
    localModelDetail: "Local model is ready to use.",
    foldersGranted: 2,
    foldersLost: [],
    telegramLinked: true,
    telegramChatPaired: true,
    keychainAvailable: true,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    lastBackupAt: 1_000_000,
    now: 1_000_000 + 3600 * 1000,
  };

  return { ...base, ...overrides };
}

describe("runSelfCheck", () => {
  it("reports all checks working when all probed facts are healthy", () => {
    const result = runSelfCheck(makeFacts());
    expect(result.headline).toBe("Eight things checked. All are working.");
    expect(result.findings.every((f) => f.severity === "working")).toBe(true);
    expect(result.findings.every((f) => f.fix === null)).toBe(true);
  });

  it("flags unknown when disk space or case book is null and never marks them working", () => {
    const result = runSelfCheck(
      makeFacts({
        diskFreeBytes: null,
        bookTables: null,
        bookOpen: false,
      })
    );

    const diskFinding = result.findings.find((f) => f.id === "disk-space");
    expect(diskFinding).toBeDefined();
    expect(diskFinding!.severity).toBe("unknown");
    expect(diskFinding!.line).toBe("Free disk space could not be measured.");

    const bookFinding = result.findings.find((f) => f.id === "case-book");
    expect(bookFinding).toBeDefined();
    expect(bookFinding!.severity).toBe("unknown");
    expect(bookFinding!.line).toBe("Your case book has not opened yet.");

    expect(result.headline).toContain("Two are unknown");
  });

  it("handles a fresh install without producing any broken findings", () => {
    const freshFacts: ProbedFacts = {
      bookOpen: true,
      bookTables: 0,
      providersDetected: [],
      providersMissing: [],
      localModelReady: false,
      localModelDetail: "",
      foldersGranted: 0,
      foldersLost: [],
      telegramLinked: false,
      telegramChatPaired: false,
      keychainAvailable: true,
      diskFreeBytes: 15 * 1024 * 1024 * 1024,
      lastBackupAt: null,
      now: 1_700_000_000_000,
    };

    const result = runSelfCheck(freshFacts);
    const brokenFindings = result.findings.filter((f) => f.severity === "broken");
    expect(brokenFindings).toHaveLength(0);

    const subs = result.findings.find((f) => f.id === "ai-subscriptions");
    expect(subs).toBeDefined();
    expect(subs!.severity).toBe("attention");
    expect(subs!.line).toBe("No AI subscriptions have been connected yet.");

    const backup = result.findings.find((f) => f.id === "case-backup");
    expect(backup).toBeDefined();
    expect(backup!.severity).toBe("attention");
    expect(backup!.line).toBe("No backup has been made yet on this new install.");
  });

  it("flags broken when an established install has no subscriptions detected", () => {
    const result = runSelfCheck(
      makeFacts({
        providersDetected: [],
        providersMissing: [{ id: "claude", label: "Claude", detail: "not signed in" }],
        foldersGranted: 3,
        lastBackupAt: 500_000,
      })
    );

    const subs = result.findings.find((f) => f.id === "ai-subscriptions");
    expect(subs).toBeDefined();
    expect(subs!.severity).toBe("broken");
    expect(subs!.line).toBe("No AI subscriptions are currently detected.");
    expect(subs!.fix).toBe("Open Claude once and sign in.");
  });

  it("names missing subscriptions when some are detected and some are missing", () => {
    const result = runSelfCheck(
      makeFacts({
        providersDetected: [{ id: "claude", label: "Claude" }],
        providersMissing: [
          { id: "codex", label: "Codex", detail: "signed out" },
          { id: "gemini", label: "Gemini", detail: "signed out" },
        ],
      })
    );

    const subs = result.findings.find((f) => f.id === "ai-subscriptions");
    expect(subs).toBeDefined();
    expect(subs!.severity).toBe("attention");
    expect(subs!.line).toBe("Connected to Claude, but Codex and Gemini could not be found.");
    expect(subs!.fix).toBe("Open Codex and Gemini once and sign in.");
  });

  it("flags attention when a folder grant is lost without exposing file paths", () => {
    const result = runSelfCheck(
      makeFacts({
        foldersLost: ["/Users/amber/Documents/Confidential/Finances"],
      })
    );

    const folders = result.findings.find((f) => f.id === "folder-access");
    expect(folders).toBeDefined();
    expect(folders!.severity).toBe("attention");
    expect(folders!.line).toBe("Access was lost to one previously granted folder.");
    expect(folders!.line).not.toContain("/Users");
    expect(folders!.fix).toBe("Open Settings and grant access to the folder again.");
  });

  it("flags attention when backup is older than seven days and handles clock skew", () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const overdueResult = runSelfCheck(
      makeFacts({
        lastBackupAt: 1_000_000,
        now: 1_000_000 + sevenDaysMs + 1000,
      })
    );

    const overdueBackup = overdueResult.findings.find((f) => f.id === "case-backup");
    expect(overdueBackup).toBeDefined();
    expect(overdueBackup!.severity).toBe("attention");
    expect(overdueBackup!.line).toBe("Your last backup was made more than seven days ago.");

    const futureResult = runSelfCheck(
      makeFacts({
        lastBackupAt: 2_000_000,
        now: 1_000_000,
      })
    );

    const futureBackup = futureResult.findings.find((f) => f.id === "case-backup");
    expect(futureBackup).toBeDefined();
    expect(futureBackup!.severity).toBe("attention");
    expect(futureBackup!.line).toBe("Your last backup is dated in the future, likely due to a clock adjustment.");
  });

  it("flags broken under 500 MB and attention under 2 GB", () => {
    const brokenResult = runSelfCheck(
      makeFacts({
        diskFreeBytes: 400 * 1024 * 1024,
      })
    );
    const brokenDisk = brokenResult.findings.find((f) => f.id === "disk-space");
    expect(brokenDisk!.severity).toBe("broken");
    expect(brokenDisk!.line).toBe("Your Mac has less than 500 MB of free disk space remaining.");

    const attentionResult = runSelfCheck(
      makeFacts({
        diskFreeBytes: 1500 * 1024 * 1024,
      })
    );
    const attentionDisk = attentionResult.findings.find((f) => f.id === "disk-space");
    expect(attentionDisk!.severity).toBe("attention");
    expect(attentionDisk!.line).toBe("Your Mac has less than 2 GB of free disk space remaining.");
  });

  it("flags attention when Telegram is linked but no chat is paired", () => {
    const result = runSelfCheck(
      makeFacts({
        telegramLinked: true,
        telegramChatPaired: false,
      })
    );

    const tg = result.findings.find((f) => f.id === "telegram");
    expect(tg).toBeDefined();
    expect(tg!.severity).toBe("attention");
    expect(tg!.fix).toBe(
      "The bot is reading and answering nobody on purpose. Pair your chat in Telegram to start sending questions."
    );
  });

  it("sorts findings worst first, then alphabetically by title", () => {
    const result = runSelfCheck(
      makeFacts({
        diskFreeBytes: 300 * 1024 * 1024,
        providersDetected: [],
        foldersGranted: 1,
        telegramLinked: true,
        telegramChatPaired: false,
        bookOpen: false,
        bookTables: null,
      })
    );

    const severities = result.findings.map((f) => f.severity);
    expect(severities[0]).toBe("broken");
    expect(severities[1]).toBe("broken");
    expect(result.findings[0]!.title).toBe("AI subscriptions");
    expect(result.findings[1]!.title).toBe("Disk space");

    const firstUnknownIdx = severities.indexOf("unknown");
    const firstWorkingIdx = severities.indexOf("working");
    expect(firstUnknownIdx).toBeGreaterThan(-1);
    expect(firstWorkingIdx).toBeGreaterThan(firstUnknownIdx);
  });

  it("handles completely empty facts without throwing", () => {
    const emptyFacts: ProbedFacts = {
      bookOpen: false,
      bookTables: null,
      providersDetected: [],
      providersMissing: [],
      localModelReady: false,
      localModelDetail: "",
      foldersGranted: 0,
      foldersLost: [],
      telegramLinked: false,
      telegramChatPaired: false,
      keychainAvailable: false,
      diskFreeBytes: null,
      lastBackupAt: null,
      now: 0,
    };

    const result = runSelfCheck(emptyFacts);
    expect(result.findings.length).toBe(8);
    expect(result.findings.filter((f) => f.severity === "broken")).toHaveLength(0);
    expect(result.headline).toMatch(/^[A-Z][a-z]+ things checked\./);
  });
});
