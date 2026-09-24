import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coerce,
  DEFAULT_SETTINGS,
  migrate,
  SettingsStore,
  SETTINGS_VERSION,
  withHeldGrants
} from "./settings.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("consent defaults are the conservative ones", () => {
  it("never turns on learning from someone's work by default", () => {
    expect(DEFAULT_SETTINGS.consent.improveFromCorrections).toBe(false);
    expect(DEFAULT_SETTINGS.consent.usageCounts).toBe(false);
  });

  it("treats anything other than an explicit true as no", () => {
    for (const value of ["true", 1, {}, [], null, undefined]) {
      const settings = coerce({ consent: { improveFromCorrections: value } });
      expect(settings.consent.improveFromCorrections).toBe(false);
    }
    expect(coerce({ consent: { improveFromCorrections: true } }).consent.improveFromCorrections).toBe(true);
  });

  it("leaves crash reports on, because it is the only way a crash reaches us", () => {
    expect(DEFAULT_SETTINGS.consent.crashReports).toBe(true);
  });
});

describe("one bad value costs one field", () => {
  it("keeps the good fields when the window block is nonsense", () => {
    const settings = coerce({
      theme: "dark",
      overlayHotkey: "Ctrl+Space",
      window: { width: "enormous", height: -5, x: NaN }
    });
    expect(settings.theme).toBe("dark");
    expect(settings.overlayHotkey).toBe("Ctrl+Space");
    expect(settings.window.width).toBe(DEFAULT_SETTINGS.window.width);
    expect(settings.window.x).toBeNull();
  });

  it("rejects a window too small to use or absurdly large", () => {
    expect(coerce({ window: { width: 10 } }).window.width).toBe(DEFAULT_SETTINGS.window.width);
    expect(coerce({ window: { width: 99_999 } }).window.width).toBe(DEFAULT_SETTINGS.window.width);
  });

  it("drops granted roots that are not absolute paths", () => {
    const settings = coerce({ grantedRoots: ["/Users/amber/Downloads", "relative", 42, null] });
    expect(settings.grantedRoots).toEqual(["/Users/amber/Downloads"]);
  });

  it("falls back to system for an unknown theme", () => {
    expect(coerce({ theme: "neon" }).theme).toBe("system");
  });

  it("survives being handed complete rubbish", () => {
    for (const rubbish of [null, undefined, 42, "text", []]) {
      expect(coerce(rubbish).version).toBe(SETTINGS_VERSION);
    }
  });
});

describe("migration cannot brick the app", () => {
  it("coerces a future version rather than refusing it", () => {
    // The real scenario: the app updates overnight, the user rolls back, and
    // the older build meets a newer file. Refusing would mean it never starts.
    const result = migrate({ version: 99, theme: "dark" });
    expect(result.settings.theme).toBe("dark");
    expect(result.migratedFrom).toBe(99);
  });

  it("reports no migration when the version already matches", () => {
    expect(migrate({ version: SETTINGS_VERSION }).migratedFrom).toBeNull();
  });
});

describe("the store", () => {
  it("round-trips", async () => {
    const store = new SettingsStore(dir);
    await store.update((current) => ({ ...current, theme: "dark" }));
    expect((await new SettingsStore(dir).read()).theme).toBe("dark");
  });

  it("returns defaults when nothing has been written", async () => {
    expect(await new SettingsStore(dir).read()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps an unreadable file instead of overwriting it", async () => {
    // Someone hand-edited it and broke the JSON. Their file is worth more than
    // a clean slate, so it is set aside rather than destroyed.
    await writeFile(join(dir, "settings.json"), "{ this is not json");
    const settings = await new SettingsStore(dir).read();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    await expect(stat(join(dir, "settings.json.unreadable"))).resolves.toBeTruthy();
  });

  it("writes through a temporary file so a crash cannot truncate it", async () => {
    const store = new SettingsStore(dir);
    await store.write({ ...DEFAULT_SETTINGS, theme: "light" });
    const raw = await readFile(join(dir, "settings.json"), "utf8");
    expect(JSON.parse(raw).theme).toBe("light");
    // No leftover scratch file.
    await expect(stat(join(dir, "settings.json.writing"))).rejects.toBeTruthy();
  });

  it("validates on the way out as well as in", async () => {
    const store = new SettingsStore(dir);
    await store.write({
      ...DEFAULT_SETTINGS,
      window: { ...DEFAULT_SETTINGS.window, width: -1 }
    });
    expect((await store.read()).window.width).toBe(DEFAULT_SETTINGS.window.width);
  });
});

describe("the contact list", () => {
  /**
   * This list decides who may operate this Mac (D-035), so its coercion is a
   * security boundary rather than tidiness. Everything malformed is dropped —
   * the cost of dropping an entry is retyping a contact, and the cost of
   * keeping a half-understood one is a stranger on the list.
   */

  it("is empty by default, so a fresh install talks to nobody", () => {
    expect(DEFAULT_SETTINGS.contacts).toEqual([]);
    expect(coerce({}).contacts).toEqual([]);
  });

  it("keeps a well-formed contact", () => {
    const kept = coerce({
      contacts: [{ channel: "whatsapp", address: "+919876543210", label: "Devgiri" }]
    }).contacts;

    expect(kept).toEqual([{ channel: "whatsapp", address: "+919876543210", label: "Devgiri" }]);
  });

  it("drops an entry on a channel that does not exist", () => {
    // An unknown channel would never match a real one, but storing it grows the
    // list with things nobody can audit.
    expect(coerce({ contacts: [{ channel: "sms", address: "1", label: "x" }] }).contacts).toEqual([]);
  });

  it("drops entries missing an address, and entries that are not objects", () => {
    expect(
      coerce({
        contacts: [
          { channel: "email", label: "no address" },
          { channel: "email", address: "", label: "empty" },
          "not-an-object",
          null,
          { channel: "email", address: "a@b.com", label: "kept" }
        ]
      }).contacts
    ).toEqual([{ channel: "email", address: "a@b.com", label: "kept" }]);
  });

  it("returns an empty list rather than throwing when the stored value is not a list", () => {
    // A corrupt settings file must not brick the app, and must not fail open.
    expect(coerce({ contacts: "everyone" }).contacts).toEqual([]);
    expect(coerce({ contacts: 7 }).contacts).toEqual([]);
  });
});

describe("a renderer cannot grant itself a folder", () => {
  // The escalation this prevents is not in-session. `coerce` accepts any
  // absolute-looking string as a granted root, so a compromised renderer could
  // write `grantedRoots: ["/"]` to the settings file — and the startup restore
  // in `index.ts` calls `skillHost.grant` on every entry it finds there. The
  // grant appeared on the NEXT launch, outliving the compromise that made it.
  const authority = coerce({
    grantedRoots: ["/Users/someone/Clients"],
    pausedRoots: ["/Users/someone/Clients/Archive"]
  });

  it("keeps the stored roots when the renderer sends different ones", () => {
    const written = coerce(
      withHeldGrants({ grantedRoots: ["/"], pausedRoots: ["/etc"] }, authority)
    );

    expect(written.grantedRoots).toEqual(["/Users/someone/Clients"]);
    expect(written.pausedRoots).toEqual(["/Users/someone/Clients/Archive"]);
  });

  it("keeps them when the renderer omits them entirely", () => {
    // The other half of the same hazard: `settingsWrite` replaces rather than
    // merges, so a renderer saving only a theme would otherwise silently drop
    // every folder the owner had granted.
    const written = coerce(withHeldGrants({ theme: "light" }, authority));

    expect(written.theme).toBe("light");
    expect(written.grantedRoots).toEqual(["/Users/someone/Clients"]);
    expect(written.pausedRoots).toEqual(["/Users/someone/Clients/Archive"]);
  });

  it("still lets everything else through", () => {
    const written = coerce(
      withHeldGrants({ theme: "dark", overlayHotkey: "Alt+K" }, authority)
    );

    expect(written.theme).toBe("dark");
    expect(written.overlayHotkey).toBe("Alt+K");
  });

  it("survives rubbish instead of an object", () => {
    const written = coerce(withHeldGrants(null, authority));

    expect(written.grantedRoots).toEqual(["/Users/someone/Clients"]);
  });
});
