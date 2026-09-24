import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicPublishError, atomicPublishDirectory } from "./atomic-publish.js";

const temporaryPrefix = "switchboard-sidecar-tmp-";
const roots: string[] = [];
const require = createRequire(import.meta.url);
const bindingPath = fileURLToPath(
  new URL("../../native/atomic-publish/build/Release/atomic_publish.node", import.meta.url)
);
const unsupportedBindingPath = fileURLToPath(
  new URL(
    "../../native/atomic-publish/build/Release/atomic_publish_unsupported_volume.node",
    import.meta.url
  )
);
const nativeDescribe =
  process.env.SWITCHBOARD_ATOMIC_PUBLISH_TEST === "1" ? describe : describe.skip;

interface RawAtomicPublishAddon {
  atomicPublish(parent: unknown, temporaryName: unknown, finalName: unknown): void;
}

interface BarrierPublisher {
  child: ChildProcess;
  ready: Promise<void>;
  exited: Promise<number>;
  finished: () => boolean;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function sandbox(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "switchboard-atomic-publish-")));
  roots.push(root);
  return root;
}

function temporaryName(suffix: string): string {
  return `${temporaryPrefix}${suffix}`;
}

async function preparedDirectory(parent: string, name: string, contents = name): Promise<void> {
  await mkdir(join(parent, name), { mode: 0o700 });
  await chmod(join(parent, name), 0o700);
  await writeFile(join(parent, name, "receipt"), contents, "utf8");
}

function rawAddon(path = bindingPath): RawAtomicPublishAddon {
  return require(path) as RawAtomicPublishAddon;
}

function expectCode(action: () => void, code: string, root?: string): void {
  try {
    action();
    throw new Error("Expected atomic publish to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AtomicPublishError);
    expect((error as AtomicPublishError).code).toBe(code);
    if (root !== undefined) {
      expect((error as Error).message).not.toContain(root);
    }
  }
}

function expectRawCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error("Expected raw addon to fail.");
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe(code);
  }
}

function spawnBarrierPublisher(
  parent: string,
  temporaryName_: string,
  finalName: string
): BarrierPublisher {
  const program = [
    "const addon = require(process.argv[1]);",
    "process.stdout.write('ready\\n');",
    "process.stdin.once('data', () => {",
    "  try { addon.atomicPublish(process.argv[2], process.argv[3], process.argv[4]); process.exit(0); }",
    "  catch { process.exit(1); }",
    "});",
    "setTimeout(() => process.exit(2), 10000).unref();"
  ].join(" ");
  const child = spawn(
    process.execPath,
    ["-e", program, bindingPath, parent, temporaryName_, finalName],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  let complete = false;
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ready\n")) {
        resolve();
      }
    });
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      complete = true;
      resolve(code ?? 3);
    });
  });
  return { child, ready, exited, finished: () => complete };
}

nativeDescribe("atomic publish native boundary", () => {
  it("rejects invalid canonical parents and generated names before filesystem publication", async () => {
    const root = await sandbox();
    const temporary = temporaryName("input");
    await preparedDirectory(root, temporary);

    for (const parent of ["", "/", `${root}/`, `${root}//nested`, `${root}/./nested`, `${root}/../nested`, `${root}\0suffix`]) {
      expectCode(() => atomicPublishDirectory(parent, temporary, "final"), "INVALID_ARGUMENT", root);
    }
    for (const name of ["", ".", "..", "-leading", ".leading", "has/slash", "has\0nul", "space name", "é", "a".repeat(129)]) {
      expectCode(() => atomicPublishDirectory(root, name, "final"), "INVALID_ARGUMENT", root);
      expectCode(() => atomicPublishDirectory(root, temporary, name), "INVALID_ARGUMENT", root);
    }
    expectCode(() => atomicPublishDirectory(root, "temporary", "final"), "INVALID_ARGUMENT", root);
    expectCode(() => atomicPublishDirectory(root, temporary, temporary), "INVALID_ARGUMENT", root);
    await expect(lstat(join(root, temporary))).resolves.toBeDefined();
  });

  it("rejects raw-addon arity, types, NUL, traversal, and invalid basenames", async () => {
    const root = await sandbox();
    const temporary = temporaryName("raw");
    await preparedDirectory(root, temporary);
    const addon = rawAddon();

    expectRawCode(() => (addon.atomicPublish as (...args: unknown[]) => void)(), "INVALID_ARGUMENT");
    expectRawCode(() => addon.atomicPublish(root, temporary, 1), "INVALID_ARGUMENT");
    expectRawCode(() => addon.atomicPublish(`${root}\0suffix`, temporary, "final"), "INVALID_ARGUMENT");
    expectRawCode(() => addon.atomicPublish(`${root}/../escape`, temporary, "final"), "INVALID_ARGUMENT");
    expectRawCode(() => addon.atomicPublish(root, "-not-a-temp", "final"), "INVALID_ARGUMENT");
  });

  it("rejects a symlink parent or ancestor and a group-writable parent", async () => {
    const root = await sandbox();
    const actual = join(root, "actual");
    await mkdir(actual, { mode: 0o700 });
    await preparedDirectory(actual, temporaryName("parent-link"));
    const parentLink = join(root, "parent-link");
    await symlink(actual, parentLink);
    expectCode(() => atomicPublishDirectory(parentLink, temporaryName("parent-link"), "final"), "UNSAFE_PARENT", root);

    const nested = join(actual, "nested");
    await mkdir(nested, { mode: 0o700 });
    await preparedDirectory(nested, temporaryName("ancestor-link"));
    const ancestorLink = join(root, "ancestor-link");
    await symlink(actual, ancestorLink);
    expectCode(
      () => atomicPublishDirectory(join(ancestorLink, "nested"), temporaryName("ancestor-link"), "final-two"),
      "UNSAFE_PARENT",
      root
    );

    await chmod(root, 0o770);
    expectCode(() => atomicPublishDirectory(root, temporaryName("missing"), "final-three"), "UNSAFE_PARENT", root);
  });

  it("rejects a regular file, symlink, or wrong-mode directory as the source", async () => {
    const root = await sandbox();
    const sourceFile = temporaryName("source-file");
    const sourceLink = temporaryName("source-link");
    const wrongMode = temporaryName("wrong-mode");
    const specialMode = temporaryName("special-mode");
    await writeFile(join(root, sourceFile), "not a directory", "utf8");
    await symlink(sourceFile, join(root, sourceLink));
    await preparedDirectory(root, wrongMode);
    await chmod(join(root, wrongMode), 0o750);
    await preparedDirectory(root, specialMode);
    await chmod(join(root, specialMode), 0o1700);

    expectCode(() => atomicPublishDirectory(root, sourceFile, "final-file"), "INVALID_SOURCE", root);
    expectCode(() => atomicPublishDirectory(root, sourceLink, "final-link"), "INVALID_SOURCE", root);
    expectCode(() => atomicPublishDirectory(root, wrongMode, "final-mode"), "INVALID_SOURCE", root);
    expectCode(() => atomicPublishDirectory(root, specialMode, "final-special"), "INVALID_SOURCE", root);
  });

  it("does not mutate source when the destination file, directory, or link exists", async () => {
    const root = await sandbox();
    for (const kind of ["file", "directory", "link"] as const) {
      const temporary = temporaryName(`occupied-${kind}`);
      const final = `final-${kind}`;
      await preparedDirectory(root, temporary);
      if (kind === "file") {
        await writeFile(join(root, final), "occupied", "utf8");
      } else if (kind === "directory") {
        await mkdir(join(root, final));
      } else {
        await symlink("missing-target", join(root, final));
      }

      expectCode(() => atomicPublishDirectory(root, temporary, final), "DESTINATION_EXISTS", root);
      expect((await lstat(join(root, temporary))).isDirectory()).toBe(true);
    }
  });

  it("fails closed on an unsupported volume without a production override", async () => {
    const root = await sandbox();
    const temporary = temporaryName("unsupported");
    await preparedDirectory(root, temporary);

    expectRawCode(
      () => rawAddon(unsupportedBindingPath).atomicPublish(root, temporary, "final"),
      "UNSUPPORTED_VOLUME"
    );
    await expect(lstat(join(root, temporary))).resolves.toBeDefined();
  });

  it("publishes a prepared directory once and returns undefined", async () => {
    const root = await sandbox();
    const temporary = temporaryName("success");
    await preparedDirectory(root, temporary, "verified");

    expect(atomicPublishDirectory(root, temporary, "final")).toBeUndefined();
    await expect(readFile(join(root, "final", "receipt"), "utf8")).resolves.toBe("verified");
    await expect(lstat(join(root, temporary))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows exactly one synchronized publisher and preserves the losing source", async () => {
    const root = await sandbox();
    const alpha = temporaryName("alpha");
    const beta = temporaryName("beta");
    await preparedDirectory(root, alpha, "alpha");
    await preparedDirectory(root, beta, "beta");
    const publishers = [
      spawnBarrierPublisher(root, alpha, "final"),
      spawnBarrierPublisher(root, beta, "final")
    ];
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Publish barrier timed out.")), 5000).unref();
    });

    try {
      await Promise.race([Promise.all(publishers.map((publisher) => publisher.ready)), timeout]);
      for (const publisher of publishers) {
        publisher.child.stdin?.end("start\n");
      }
      const outcomes = await Promise.race([
        Promise.all(publishers.map((publisher) => publisher.exited)),
        timeout
      ]);
      expect(outcomes.filter((outcome) => outcome === 0)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 1)).toHaveLength(1);
      const winner = outcomes[0] === 0 ? alpha : beta;
      const loser = winner === alpha ? beta : alpha;
      expect(["alpha", "beta"]).toContain(await readFile(join(root, "final", "receipt"), "utf8"));
      await expect(lstat(join(root, winner))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, loser, "receipt"), "utf8")).resolves.toBe(
        loser === alpha ? "alpha" : "beta"
      );
    } finally {
      for (const publisher of publishers) {
        if (!publisher.finished()) {
          publisher.child.kill();
        }
      }
    }
  });
});
