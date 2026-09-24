/**
 * Attacks on the renderer protocol.
 *
 * Every case below is something that reaches a real file if the boundary is
 * wrong, run against a real directory with a real symlink in it — the symlink
 * case in particular cannot be caught by reasoning about strings, which is the
 * reason this file exists rather than a careful reading of the handler.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAsset } from "./protocol.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "cadrane-protocol-"));
  root = join(base, "renderer");
  outside = join(base, "secrets");
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, "index.html"), "<!doctype html>");
  await writeFile(join(root, "assets", "main.js"), "console.log(1)");
  await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const ask = (url: string) => resolveAsset(url, root);

describe("what it serves", () => {
  it("serves the app shell", async () => {
    const verdict = await ask("switchboard://app/index.html");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.file).toContain("index.html");
  });

  it("treats a bare root as the shell, so the app opens at all", async () => {
    expect((await ask("switchboard://app/")).ok).toBe(true);
  });

  it("serves nested assets", async () => {
    expect((await ask("switchboard://app/assets/main.js")).ok).toBe(true);
  });

  it("404s something that simply is not there", async () => {
    expect(await ask("switchboard://app/nope.js")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("path traversal", () => {
  /**
   * Two different layers refuse these, and it is worth knowing which is which.
   *
   * The WHATWG URL parser collapses literal `..` segments while parsing, so
   * `switchboard://app/../secrets/id_rsa` arrives at our code with pathname
   * `/secrets/id_rsa` — already inside the root, and refused as 404 because no
   * such file is there. Percent-encoded traversal survives parsing intact and
   * is caught by the explicit containment check instead, as 403.
   *
   * So the assertion is the security property — it never resolves to a file
   * outside the root — rather than a status code, which only tells you which
   * layer happened to catch it. Asserting the status would make these tests
   * fail the day Node changes its URL normalisation, for no security reason.
   */
  const escapes = async (url: string) => {
    const verdict = await ask(url);
    return verdict.ok && !verdict.file.startsWith(root);
  };

  it("refuses to climb out of the renderer folder", async () => {
    expect(await escapes("switchboard://app/../secrets/id_rsa")).toBe(false);
    expect((await ask("switchboard://app/../secrets/id_rsa")).ok).toBe(false);
  });

  it("refuses a long climb", async () => {
    expect(await escapes("switchboard://app/../../../../../../etc/passwd")).toBe(false);
    expect((await ask("switchboard://app/../../../../../../etc/passwd")).ok).toBe(false);
  });

  it("refuses a climb hidden by percent-encoding", async () => {
    // %2e%2e%2f is "../", and unlike the plain form it survives URL parsing.
    // This is the case the explicit containment check exists for.
    expect(await ask("switchboard://app/%2e%2e%2fsecrets%2fid_rsa")).toMatchObject({
      ok: false,
      status: 403
    });
  });

  it("refuses a climb buried mid-path", async () => {
    expect(await escapes("switchboard://app/assets/../../secrets/id_rsa")).toBe(false);
    expect((await ask("switchboard://app/assets/../../secrets/id_rsa")).ok).toBe(false);
  });

  it("refuses an absolute path", async () => {
    expect((await ask("switchboard://app//etc/passwd")).ok).toBe(false);
  });
});

describe("symlink escape", () => {
  it("refuses a link that points out of the folder", async () => {
    // Textually this never leaves the root, so the string checks pass it
    // happily. Only realpath sees where it actually goes.
    await symlink(join(outside, "id_rsa"), join(root, "innocent.js"));
    expect(await ask("switchboard://app/innocent.js")).toMatchObject({
      ok: false,
      status: 403
    });
  });

  it("refuses a linked directory used as a prefix", async () => {
    await symlink(outside, join(root, "vendor"));
    expect(await ask("switchboard://app/vendor/id_rsa")).toMatchObject({
      ok: false,
      status: 403
    });
  });

  it("still allows a link that stays inside", async () => {
    // Containment, not a blanket ban on symlinks — a build tool may legitimately
    // produce one, and refusing those would break the app for no safety gain.
    await symlink(join(root, "assets", "main.js"), join(root, "alias.js"));
    expect((await ask("switchboard://app/alias.js")).ok).toBe(true);
  });
});

describe("URLs that have no business here", () => {
  it("refuses another hostname", async () => {
    expect(await ask("switchboard://evil/index.html")).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses embedded credentials", async () => {
    expect(await ask("switchboard://user:pass@app/index.html")).toMatchObject({
      ok: false,
      status: 404
    });
  });

  it("refuses a port", async () => {
    expect(await ask("switchboard://app:8080/index.html")).toMatchObject({
      ok: false,
      status: 404
    });
  });

  it("refuses malformed percent-encoding rather than throwing", async () => {
    expect(await ask("switchboard://app/%E0%A4%A")).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses something that is not a URL at all", async () => {
    expect(await ask("not a url")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("what is not a file", () => {
  it("refuses a directory rather than serving an index", async () => {
    expect(await ask("switchboard://app/assets")).toMatchObject({ ok: false, status: 403 });
  });
});
