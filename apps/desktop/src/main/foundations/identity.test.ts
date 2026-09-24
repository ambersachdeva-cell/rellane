/**
 * The names that are facts about a Mac, not decisions about a brand.
 *
 * The product is called **Rellane**. These values still say **Cadrane**, and
 * every one of them has to, because each names something that already exists
 * on somebody's disk or inside a file they already hold:
 *
 *   - the records directory the ledger lives in,
 *   - the Keychain-wrapped key every existing backup was encrypted with,
 *   - the header of every archive already written,
 *   - the filenames of the backups sitting in the owner's backup folder,
 *   - the runtime id written into saved history rows and pinned agents,
 *   - the bundle identity `safeStorage` derives that Keychain entry from —
 *     which is `app.getName()`, so `productName` and `app.setName` are two
 *     routes to the same breakage and both are pinned here.
 *
 * D-100 states the rule: *"Brand presentation changes do not silently migrate
 * the existing storage path, application origin or signing identity."*
 *
 * ## Why this file exists
 *
 * This has already gone wrong once. The 2026-09-02 `@switchboard/*` →
 * `@cadrane/*` sweep was a tree-wide find-and-replace, and it
 *
 *   - rewrote `FORMER_DIR_NAMES`, silently disabling the migration that was
 *     the only thing pointing at the records already on disk, and
 *   - changed the app identity `safeStorage` keys from, which made every
 *     backup written before that day permanently undecryptable.
 *
 * The residue is still visible: `~/Documents/Cadrane Backups/unreadable-pre-rename/`.
 *
 * `home.ts` defends its own constant by spelling the legacy scope in pieces.
 * This file does the same job for the rest of the surface, in one place, so
 * the next rename fails a test instead of a restore. **If you are here because
 * this test is failing after a rename: the test is right.** Renaming any of
 * these needs a migration and an owner decision, not a passing assertion.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMER_DIR_NAMES, HOME_DIR_NAME, HOME_OVERRIDE_VAR } from "./home.js";
import { MAGIC } from "../book/backup.js";
import { backupName } from "../book/schedule.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..", "..", "..");
const repoRoot = join(desktopRoot, "..", "..");

async function source(...parts: readonly string[]): Promise<string> {
  return readFile(join(desktopRoot, ...parts), "utf8");
}

describe("names that outlive the brand", () => {
  it("keeps the records where they already are", () => {
    expect(HOME_DIR_NAME).toBe("Cadrane");
    expect(HOME_OVERRIDE_VAR).toBe("CADRANE_HOME");
    expect(FORMER_DIR_NAMES).toContain("@switchboard/desktop");
  });

  it("keeps reading archives that are already written", () => {
    // Not cosmetic: `deriveKey` feeds MAGIC into HKDF as the info string, so
    // editing this string changes the key and every existing backup stops
    // decrypting — with no error until somebody needs a restore.
    expect(MAGIC).toBe("CADRANE-BACKUP");
  });

  it("keeps naming backups the way the ones on disk are named", () => {
    const name = backupName(new Date(2026, 8, 1, 14, 5));

    expect(name).toBe("cadrane-2026-09-01-1405.cadranebackup");
    expect(name.endsWith(".cadranebackup")).toBe(true);
  });

  it("keeps the bundle identity the Keychain entry is tied to", async () => {
    const pkg = JSON.parse(await source("package.json")) as {
      build: { appId: string; productName: string };
    };

    // productName also names `/Applications/Cadrane.app` and the built DMG, so
    // the install guide and the packaging tests move with it, not before it.
    expect(pkg.build.appId).toBe("com.cadrane.local-work-studio");
    expect(pkg.build.productName).toBe("Cadrane");
  });

  it("does not set the app name from the main process either", async () => {
    // The other route to the same breakage, and the one no test covered until
    // somebody took it. `safeStorage` derives its Keychain service name from
    // `app.getName()`, so `app.setName("Rellane")` orphans every secret exactly
    // as renaming `productName` does — the entry on this Mac is literally
    // "@cadrane/desktop Safe Storage". Pinning one identity is the right fix
    // and it is a migration: read each secret under the old name, rewrite it
    // under the new one, in one run, before the name moves anywhere (D-113).
    expect(await source("src", "main", "index.ts")).not.toContain("app.setName(");
  });

  it("keeps the runtime id that saved rows refer to", async () => {
    // Written into history rows, workroom prompts and pinned agents. Renaming
    // it orphans those rows rather than migrating them.
    for (const file of [
      ["src", "main", "agents", "local.ts"],
      ["src", "main", "workroom", "local.ts"]
    ]) {
      expect(await source(...file)).toContain('"cadrane-local-loopback"');
    }
  });
});

describe("the brand, which is free to move", () => {
  it("tells the reader both names, because they will see both", async () => {
    const guide = await readFile(join(repoRoot, "docs", "INSTALL.md"), "utf8");

    // The product is Rellane.
    expect(guide).toContain("Rellane");
    // And the thing they double-click is still called Cadrane. A guide that
    // said only the first would send somebody hunting for an app that is not
    // in their Applications folder, which is exactly the kind of quiet
    // wrongness this file exists to catch.
    expect(guide).toContain("/Applications/Cadrane.app");
    expect(guide).toContain("~/Library/Application Support/Cadrane/");
    expect(guide).toMatch(/still called Cadrane/u);
  });
});
