/**
 * Granting a folder, and losing one.
 *
 * Rellane ships ad-hoc signed, so macOS treats every update as a different app
 * and withdraws its folder permissions. A grant that will not restore is the
 * ordinary case after an update rather than an edge one, which makes "what
 * happens when a granted folder will not open" a first-class behaviour rather
 * than an error path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantUnavailable, SkillHost } from "./host.js";

let directory: string;
let host: SkillHost;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cadrane-host-"));
  host = new SkillHost();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("granting a folder", () => {
  it("accepts a folder it can actually open", async () => {
    expect(await host.grant(directory)).toEqual([directory]);
  });

  it("does not grant the same folder twice", async () => {
    await host.grant(directory);
    expect(await host.grant(directory)).toEqual([directory]);
  });

  it("refuses a folder that is not there, and says so in the owner's nouns", async () => {
    const missing = join(directory, "gone");
    await expect(host.grant(missing)).rejects.toBeInstanceOf(GrantUnavailable);
    await expect(host.grant(missing)).rejects.toThrow(/gone is no longer where it was/u);
  });

  it("refuses a file offered as a folder", async () => {
    const file = join(directory, "quote.pdf");
    await writeFile(file, "not a folder");
    await expect(host.grant(file)).rejects.toThrow(/quote\.pdf is a file, not a folder/u);
  });

  /**
   * The list used to be appended to before the sandbox had accepted it, so one
   * bad folder stayed in `roots` and every later grant rebuilt the sandbox with
   * it still there — a single mistake poisoning the session.
   */
  it("leaves the granted list untouched when a grant fails", async () => {
    await host.grant(directory);
    await expect(host.grant(join(directory, "nowhere"))).rejects.toThrow();
    expect(host.grantedRoots()).toEqual([directory]);
  });
});

describe("a folder that will not come back", () => {
  it("remembers it, with the reason", () => {
    host.recordLostGrant("/Users/amber/Clients", "macOS is no longer letting Rellane read Clients.");
    expect(host.lostGrants()).toEqual([
      { path: "/Users/amber/Clients", reason: "macOS is no longer letting Rellane read Clients." }
    ]);
  });

  it("never lists a folder that is currently granted", async () => {
    await host.grant(directory);
    host.recordLostGrant(directory, "stale");
    expect(host.lostGrants()).toEqual([]);
  });

  it("stops listing it once it has been granted again", async () => {
    host.recordLostGrant(directory, "macOS is no longer letting Rellane read it.");
    expect(host.lostGrants()).toHaveLength(1);

    await host.grant(directory);
    expect(host.lostGrants()).toEqual([]);
  });

  it("says nothing at all when nothing has been lost", () => {
    expect(host.lostGrants()).toEqual([]);
  });
});

describe("an approval that has gone stale", () => {
  it("cannot be run days later against a folder that moved on", async () => {
    // The five-minute window was written down and not enforced: expiry was
    // swept only when somebody *previewed* a folder, so a plan nobody looked at
    // again never expired. An approval from Tuesday could execute on Friday.
    await writeFile(join(directory, "invoice.pdf"), "x");
    await host.grant(directory);

    const at = Date.parse("2026-09-03T10:00:00.000Z");
    const preview = await host.preview("librarian", directory, at);

    // Six minutes later, and nobody has previewed anything in between.
    await expect(
      host.run(preview.planId, async () => true, at + 6 * 60_000)
    ).rejects.toThrow(/expired/u);
  });

  it("still runs inside the window", async () => {
    await writeFile(join(directory, "invoice.pdf"), "x");
    await host.grant(directory);

    const at = Date.parse("2026-09-03T10:00:00.000Z");
    const preview = await host.preview("librarian", directory, at);

    await expect(
      host.run(preview.planId, async () => true, at + 60_000)
    ).resolves.toBeDefined();
  });
});
