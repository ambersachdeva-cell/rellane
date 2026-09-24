/**
 * The hole the sandbox's own docstring claimed was closed.
 *
 * `resolveInSandbox` with `mustExist: false` is the path a *write* takes. It
 * resolved only the parent, on the assumption that the leaf does not exist yet.
 * When the leaf is already a symlink pointing outside, the parent check passed
 * and the write followed the link straight out.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, resolveInSandbox, SandboxError } from "./sandbox.js";

let dir: string;
let inside: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-symlink-"));
  inside = join(dir, "granted");
  outside = join(dir, "elsewhere");
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "not yours");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a symlink planted where a file is about to be written", () => {
  it("cannot be written through", async () => {
    const sandbox = await createSandbox([inside]);
    // The shape of the attack: something inside the granted folder that points
    // out of it, waiting for the next write.
    await symlink(join(outside, "secret.txt"), join(inside, "report.txt"));

    await expect(
      resolveInSandbox(sandbox, join(inside, "report.txt"), { mustExist: false })
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("still allows an ordinary write to a file that does not exist yet", async () => {
    // The case the whole `mustExist: false` path exists for. A fix that broke
    // this would close the hole by closing the feature.
    const sandbox = await createSandbox([inside]);

    await expect(
      resolveInSandbox(sandbox, join(inside, "new-file.txt"), { mustExist: false })
    ).resolves.toContain("new-file.txt");
  });

  it("still allows a link that stays inside the granted folder", async () => {
    const sandbox = await createSandbox([inside]);
    await writeFile(join(inside, "real.txt"), "mine");
    await symlink(join(inside, "real.txt"), join(inside, "alias.txt"));

    await expect(
      resolveInSandbox(sandbox, join(inside, "alias.txt"), { mustExist: false })
    ).resolves.toContain("real.txt");
  });
});

describe("a granted root that is itself a link to somewhere sensitive", () => {
  it("is refused, on what it resolves to rather than on its name", async () => {
    // `/tmp/keys` pointing at a credential store passed a check made on the
    // name it was given, and then had its real target added to the roots — the
    // one thing the never-granted list exists to make impossible.
    //
    // `.claude` rather than `.ssh`: the check resolves the link, so the target
    // has to actually exist for the test to exercise the path at all.
    const secrets = join(homedir(), ".claude");
    const decoy = join(dir, "harmless");
    await symlink(secrets, decoy);

    await expect(createSandbox([decoy])).rejects.toMatchObject({ denial: "sensitive-path" });
  });
});
