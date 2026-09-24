import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORMER_DIR_NAMES, HOME_DIR_NAME, HOME_OVERRIDE_VAR, resolveHome } from "./home.js";

let support: string;

beforeEach(async () => {
  support = await mkdtemp(join(tmpdir(), "cadrane-home-"));
});

afterEach(async () => {
  await chmod(support, 0o755).catch(() => undefined);
  await rm(support, { recursive: true, force: true });
});

/** Writes a directory that looks like real records. */
async function seed(name: string): Promise<string> {
  const dir = join(support, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "book.sqlite"), "records");
  await writeFile(join(dir, "settings.json"), "{}");
  return dir;
}

describe("where the records live", () => {
  it("remembers the literal old directory, whatever the packages are called now", () => {
    // Written out in full on purpose. A tree-wide rename of `@switchboard/*`
    // rewrote the constant this asserts and broke the migration silently — the
    // directory on disk keeps its old name no matter what the packages are
    // renamed to, so this test must not be expressible in terms of the constant.
    expect(FORMER_DIR_NAMES).toContain("@switchboard/desktop");
  });

  it("is a fixed name, not one derived from the package", () => {
    // The whole point: renaming the packages must not be able to move a
    // business's ledger. Electron derives userData from the package name, so
    // this is one `git mv` away from silent data loss.
    //
    // The assertion is spelled out rather than compared against a constant,
    // and it stays "Cadrane" through the Rellane rename on purpose: this names
    // the directory that is on disk right now, which no brand change alters.
    // (The line above used to read "renaming `@cadrane/*` to `@cadrane/*`" —
    // the 2026-09-02 sweep rewrote both halves of its own example and left a
    // sentence that says nothing. Restored here.)
    expect(HOME_DIR_NAME).toBe("Cadrane");
    expect(HOME_DIR_NAME).not.toContain("/");
    expect(HOME_DIR_NAME).not.toContain("@");
    expect(HOME_DIR_NAME).not.toContain("Rellane");
  });

  it("is a genuine first run when nothing exists anywhere", async () => {
    expect(await resolveHome(support)).toBe(join(support, HOME_DIR_NAME));
  });

  it("uses the new home once it exists, without touching anything else", async () => {
    await seed(HOME_DIR_NAME);
    const old = await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");

    expect(await resolveHome(support)).toBe(join(support, HOME_DIR_NAME));
    // The old directory is left alone rather than deleted: if both somehow
    // exist, destroying one of them is not a decision to make silently.
    expect((await readdir(old)).sort()).toEqual(["book.sqlite", "settings.json"]);
  });
});

describe("moving records that are at the old address", () => {
  it("brings every file across", async () => {
    await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");

    const home = await resolveHome(support);

    expect(home).toBe(join(support, HOME_DIR_NAME));
    expect((await readdir(home)).sort()).toEqual(["book.sqlite", "settings.json"]);
  });

  it("stays where it was when the move cannot be done", async () => {
    // The safe failure. Starting fresh would look to the owner exactly like a
    // normal first run, with every record gone and nothing on screen to say so.
    const old = await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");
    await chmod(support, 0o555);

    const home = await resolveHome(support);

    expect(home).toBe(old);
    expect((await readdir(home)).sort()).toEqual(["book.sqlite", "settings.json"]);
  });

  it("never returns a path that is empty when records existed", async () => {
    // The property that actually matters, stated directly: whatever happens,
    // the app must not end up pointed at a blank directory while the owner's
    // records sit somewhere else.
    await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");

    const home = await resolveHome(support);

    expect((await readdir(home)).length).toBeGreaterThan(0);
  });
});

describe("a directory that exists but cannot be read", () => {
  it("is used, not mistaken for absent", async () => {
    // The failure this whole module exists to prevent, arriving through its own
    // helper: swallowing every `stat` error read `EACCES` as "not there", so the
    // migration never fired and the app started on an empty home — a normal
    // looking first run with the ledger still on disk and unreachable.
    const legacy = await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");
    await chmod(legacy, 0o000);

    try {
      expect(await resolveHome(support)).toBe(legacy);
    } finally {
      await chmod(legacy, 0o755);
    }
  });
});

describe("an overridden records location", () => {
  const set = (value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[HOME_OVERRIDE_VAR];
    } else {
      process.env[HOME_OVERRIDE_VAR] = value;
    }
  };

  afterEach(() => set(undefined));

  it("is used exactly as given", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cadrane-elsewhere-"));
    set(elsewhere);

    expect(await resolveHome(support)).toBe(elsewhere);

    await rm(elsewhere, { recursive: true, force: true });
  });

  it("does not drag the old records across", async () => {
    // The whole point of naming a scratch location is to open the app on
    // nothing. Migrating the owner's real book into it would destroy the only
    // thing a first-run rehearsal is for — and would move records the person
    // never asked to move.
    const legacy = await seed(FORMER_DIR_NAMES[0] ?? "@switchboard/desktop");
    const elsewhere = await mkdtemp(join(tmpdir(), "cadrane-elsewhere-"));
    set(elsewhere);

    expect(await resolveHome(support)).toBe(elsewhere);
    expect(await readdir(elsewhere)).toHaveLength(0);
    expect(await readdir(legacy)).toContain("book.sqlite");

    await rm(elsewhere, { recursive: true, force: true });
  });

  it("ignores a relative path rather than guessing where it points", async () => {
    // `./records` names a different directory depending on whether the app was
    // double-clicked, started from a terminal, or launched by an agent. For a
    // ledger, silently picking one of those is worse than ignoring the variable.
    await seed(HOME_DIR_NAME);
    set("records/here");

    expect(await resolveHome(support)).toBe(join(support, HOME_DIR_NAME));
  });

  it("ignores an empty value, so an unset-looking variable behaves as unset", async () => {
    await seed(HOME_DIR_NAME);
    set("   ");

    expect(await resolveHome(support)).toBe(join(support, HOME_DIR_NAME));
  });
});
