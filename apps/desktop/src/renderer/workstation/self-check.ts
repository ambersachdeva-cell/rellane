/** One part of a split request, and who is taking it. */
export interface ProbedFacts {
  readonly bookOpen: boolean;
  readonly bookTables: number | null;
  readonly providersDetected: readonly { readonly id: string; readonly label: string }[];
  readonly providersMissing: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly localModelReady: boolean;
  readonly localModelDetail: string;
  readonly foldersGranted: number;
  readonly foldersLost: readonly string[];
  readonly telegramLinked: boolean;
  readonly telegramChatPaired: boolean;
  readonly keychainAvailable: boolean;
  readonly diskFreeBytes: number | null;
  readonly lastBackupAt: number | null;
  readonly now: number;
}

export type Severity = "working" | "attention" | "broken" | "unknown";

export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly line: string;
  readonly fix: string | null;
}

export interface SelfCheck {
  readonly headline: string;
  readonly findings: readonly Finding[];
  readonly checkedAt: number;
}

const FIVE_HUNDRED_MB = 500 * 1024 * 1024;
const TWO_GB = 2 * 1024 * 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const SEVERITY_ORDER: Record<Severity, number> = {
  broken: 0,
  attention: 1,
  unknown: 2,
  working: 3,
};

function formatList(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0]!;
  }
  if (items.length === 2) {
    return `${items[0]!} and ${items[1]!}`;
  }
  const initial = items.slice(0, -1).join(", ");
  const last = items[items.length - 1]!;
  return `${initial}, and ${last}`;
}

function formatCountWord(n: number): string {
  const words = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
  ];
  const word = words[n];
  if (typeof word === "string") {
    return word;
  }
  return String(n);
}

function formatLowerWord(n: number): string {
  return formatCountWord(n).toLowerCase();
}

function isFreshInstall(facts: ProbedFacts): boolean {
  const noDetected = (facts.providersDetected?.length ?? 0) === 0;
  const noFolders = (facts.foldersGranted ?? 0) === 0 && (facts.foldersLost?.length ?? 0) === 0;
  const noBackup = facts.lastBackupAt === null;
  return noDetected && noFolders && noBackup;
}

function checkCaseBook(facts: ProbedFacts, isFresh: boolean): Finding {
  const bookOpen = Boolean(facts.bookOpen);
  const bookTables = facts.bookTables;

  if (!bookOpen || bookTables === null) {
    return {
      id: "case-book",
      title: "Case book",
      severity: "unknown",
      line: "Your case book has not opened yet.",
      fix: "Wait a moment for Rellane to finish opening.",
    };
  }

  if (bookTables === 0 && isFresh) {
    return {
      id: "case-book",
      title: "Case book",
      severity: "working",
      line: "Your case book is ready for your first case.",
      fix: null,
    };
  }

  return {
    id: "case-book",
    title: "Case book",
    severity: "working",
    line: "Your case book is open and ready.",
    fix: null,
  };
}

function checkSubscriptions(facts: ProbedFacts, isFresh: boolean): Finding {
  const detected = facts.providersDetected ?? [];
  const missing = facts.providersMissing ?? [];

  if (detected.length === 0) {
    if (isFresh) {
      return {
        id: "ai-subscriptions",
        title: "AI subscriptions",
        severity: "attention",
        line: "No AI subscriptions have been connected yet.",
        fix: "Open Claude, Codex, or Gemini once and sign in to connect them.",
      };
    }

    const missingNames = missing.length > 0 ? formatList(missing.map((p) => p.label)) : "";
    const fixText = missingNames !== "" ? `Open ${missingNames} once and sign in.` : "Open Claude, Codex, or Gemini once and sign in.";
    return {
      id: "ai-subscriptions",
      title: "AI subscriptions",
      severity: "broken",
      line: "No AI subscriptions are currently detected.",
      fix: fixText,
    };
  }

  if (missing.length > 0) {
    const missingNames = formatList(missing.map((p) => p.label));
    const detectedNames = formatList(detected.map((p) => p.label));
    return {
      id: "ai-subscriptions",
      title: "AI subscriptions",
      severity: "attention",
      line: `Connected to ${detectedNames}, but ${missingNames} could not be found.`,
      fix: `Open ${missingNames} once and sign in.`,
    };
  }

  const detectedNames = formatList(detected.map((p) => p.label));
  return {
    id: "ai-subscriptions",
    title: "AI subscriptions",
    severity: "working",
    line: `${detectedNames} connected and ready.`,
    fix: null,
  };
}

function checkLocalModel(facts: ProbedFacts): Finding {
  const ready = Boolean(facts.localModelReady);
  const rawDetail = typeof facts.localModelDetail === "string" ? facts.localModelDetail.trim() : "";

  if (ready) {
    return {
      id: "local-model",
      title: "Local model",
      severity: "working",
      line: rawDetail !== "" ? rawDetail : "Local model is ready to use.",
      fix: null,
    };
  }

  return {
    id: "local-model",
    title: "Local model",
    severity: "attention",
    line: rawDetail !== "" ? rawDetail : "No local model is currently running.",
    fix: "Start your local model if you want offline assistance.",
  };
}

function checkFolderAccess(facts: ProbedFacts, isFresh: boolean): Finding {
  const granted = typeof facts.foldersGranted === "number" ? facts.foldersGranted : 0;
  const lost = facts.foldersLost ?? [];

  if (lost.length > 0) {
    const countText = lost.length === 1 ? "one previously granted folder" : `${lost.length} previously granted folders`;
    const fixText = lost.length === 1 ? "Open Settings and grant access to the folder again." : "Open Settings and grant access to the folders again.";
    return {
      id: "folder-access",
      title: "Folder access",
      severity: "attention",
      line: `Access was lost to ${countText}.`,
      fix: fixText,
    };
  }

  if (granted === 0) {
    return {
      id: "folder-access",
      title: "Folder access",
      severity: "working",
      line: isFresh ? "No folders have been added to Rellane yet." : "No folders have been added yet.",
      fix: null,
    };
  }

  const countText = granted === 1 ? "one folder" : `${granted} folders`;
  return {
    id: "folder-access",
    title: "Folder access",
    severity: "working",
    line: `Access granted to ${countText}.`,
    fix: null,
  };
}

function checkTelegram(facts: ProbedFacts): Finding {
  const linked = Boolean(facts.telegramLinked);
  const paired = Boolean(facts.telegramChatPaired);

  if (!linked) {
    return {
      id: "telegram",
      title: "Telegram connection",
      severity: "working",
      line: "Telegram is not connected.",
      fix: null,
    };
  }

  if (!paired) {
    return {
      id: "telegram",
      title: "Telegram connection",
      severity: "attention",
      line: "Telegram is connected, but no chat is paired.",
      fix: "The bot is reading and answering nobody on purpose. Pair your chat in Telegram to start sending questions.",
    };
  }

  return {
    id: "telegram",
    title: "Telegram connection",
    severity: "working",
    line: "Telegram is connected and paired with your chat.",
    fix: null,
  };
}

function checkSecureStorage(facts: ProbedFacts): Finding {
  const available = Boolean(facts.keychainAvailable);

  if (available) {
    return {
      id: "keychain",
      title: "Secure storage",
      severity: "working",
      line: "Secure storage is available on your Mac.",
      fix: null,
    };
  }

  return {
    id: "keychain",
    title: "Secure storage",
    severity: "attention",
    line: "Secure storage is currently unavailable.",
    fix: "Unlock your Mac keychain to allow Rellane to store settings safely.",
  };
}

function checkDiskSpace(facts: ProbedFacts): Finding {
  const freeBytes = facts.diskFreeBytes;

  if (freeBytes === null || typeof freeBytes !== "number") {
    return {
      id: "disk-space",
      title: "Disk space",
      severity: "unknown",
      line: "Free disk space could not be measured.",
      fix: "Check your Mac storage in System Settings.",
    };
  }

  if (freeBytes < FIVE_HUNDRED_MB) {
    return {
      id: "disk-space",
      title: "Disk space",
      severity: "broken",
      line: "Your Mac has less than 500 MB of free disk space remaining.",
      fix: "Free up disk space on your Mac to prevent data loss.",
    };
  }

  if (freeBytes < TWO_GB) {
    return {
      id: "disk-space",
      title: "Disk space",
      severity: "attention",
      line: "Your Mac has less than 2 GB of free disk space remaining.",
      fix: "Free up some disk space on your Mac to keep Rellane running smoothly.",
    };
  }

  return {
    id: "disk-space",
    title: "Disk space",
    severity: "working",
    line: "Your Mac has sufficient free disk space.",
    fix: null,
  };
}

function checkBackup(facts: ProbedFacts, isFresh: boolean): Finding {
  const lastBackupAt = facts.lastBackupAt;
  const now = typeof facts.now === "number" ? facts.now : Date.now();

  if (lastBackupAt === null) {
    if (isFresh) {
      return {
        id: "case-backup",
        title: "Case backup",
        severity: "attention",
        line: "No backup has been made yet on this new install.",
        fix: "Create a backup once you start adding cases.",
      };
    }

    return {
      id: "case-backup",
      title: "Case backup",
      severity: "attention",
      line: "No backup has been created yet.",
      fix: "Create a backup to protect your cases.",
    };
  }

  if (now < lastBackupAt) {
    return {
      id: "case-backup",
      title: "Case backup",
      severity: "attention",
      line: "Your last backup is dated in the future, likely due to a clock adjustment.",
      fix: "Check your Mac clock in System Settings, then create a fresh backup.",
    };
  }

  if (now - lastBackupAt > SEVEN_DAYS_MS) {
    return {
      id: "case-backup",
      title: "Case backup",
      severity: "attention",
      line: "Your last backup was made more than seven days ago.",
      fix: "Create a fresh backup to protect your recent work.",
    };
  }

  return {
    id: "case-backup",
    title: "Case backup",
    severity: "working",
    line: "Your cases were backed up within the past seven days.",
    fix: null,
  };
}

function buildHeadline(findings: readonly Finding[]): string {
  let brokenCount = 0;
  let attentionCount = 0;
  let unknownCount = 0;

  for (const finding of findings) {
    if (finding.severity === "broken") {
      brokenCount += 1;
    } else if (finding.severity === "attention") {
      attentionCount += 1;
    } else if (finding.severity === "unknown") {
      unknownCount += 1;
    }
  }

  const total = findings.length;
  const countWord = formatCountWord(total);
  const prefix = total === 1 ? "One thing checked" : `${countWord} things checked`;

  if (brokenCount === 0 && attentionCount === 0 && unknownCount === 0) {
    return `${prefix}. All are working.`;
  }

  const clauses: string[] = [];
  if (brokenCount > 0) {
    clauses.push(brokenCount === 1 ? "one is broken" : `${formatLowerWord(brokenCount)} are broken`);
  }
  if (attentionCount > 0) {
    clauses.push(attentionCount === 1 ? "one needs attention" : `${formatLowerWord(attentionCount)} need attention`);
  }
  if (unknownCount > 0) {
    clauses.push(unknownCount === 1 ? "one is unknown" : `${formatLowerWord(unknownCount)} are unknown`);
  }

  let summary = "";
  if (clauses.length === 1) {
    summary = clauses[0]!;
  } else if (clauses.length === 2) {
    summary = `${clauses[0]!} and ${clauses[1]!}`;
  } else if (clauses.length >= 3) {
    summary = `${clauses[0]!}, ${clauses[1]!}, and ${clauses[2]!}`;
  }

  const capitalizedSummary = summary.length > 0 ? summary.charAt(0).toUpperCase() + summary.slice(1) : "All are working";
  return `${prefix}. ${capitalizedSummary}.`;
}

export function runSelfCheck(facts: ProbedFacts): SelfCheck {
  const checkedAt = typeof facts.now === "number" ? facts.now : Date.now();
  const fresh = isFreshInstall(facts);

  const rawFindings: readonly Finding[] = [
    checkCaseBook(facts, fresh),
    checkSubscriptions(facts, fresh),
    checkLocalModel(facts),
    checkFolderAccess(facts, fresh),
    checkTelegram(facts),
    checkSecureStorage(facts),
    checkDiskSpace(facts),
    checkBackup(facts, fresh),
  ];

  const sortedFindings = [...rawFindings].sort((a, b) => {
    const diff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (diff !== 0) {
      return diff;
    }
    return a.title.localeCompare(b.title);
  });

  const headline = buildHeadline(sortedFindings);

  return {
    headline,
    findings: sortedFindings,
    checkedAt,
  };
}
