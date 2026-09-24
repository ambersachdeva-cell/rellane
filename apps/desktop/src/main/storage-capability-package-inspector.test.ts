import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cadrane/contracts/storage-capability", async () =>
  import("../../../../packages/contracts/src/storage-capability.js")
);

import { inspectStorageCapabilityPackage } from "../../scripts/inspect-storage-capability-package.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("storage capability package inspector", () => {
  it("writes deterministic no-clobber static evidence for three exact inert entries", async () => {
    const fixture = await makeFixture();
    const firstOutput = path.join(fixture.root, "receipt-1.json");
    const secondOutput = path.join(fixture.root, "receipt-2.json");
    const first = await inspectStorageCapabilityPackage({ asarPath: fixture.asarPath, outputPath: firstOutput });
    const second = await inspectStorageCapabilityPackage({ asarPath: fixture.asarPath, outputPath: secondOutput });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      inspectionKind: "packaged-static-inspection",
      durableSpacesEnabled: false,
      unobserved: {
        safeStorageAvailability: "unobserved",
        nodeSqliteModuleLoad: "unobserved",
        fts5: "unobserved",
        restart: "unobserved",
        recovery: "unobserved"
      }
    });
    expect(await readFile(firstOutput, "utf8")).toBe(await readFile(secondOutput, "utf8"));
    expect(((await import("node:fs/promises")).stat(firstOutput)).then((value) => value.mode & 0o777))
      .resolves.toBe(0o600);
  });

  it("rejects a tampered marker without creating evidence", async () => {
    const fixture = await makeFixture({
      main: "function inspect(){ return safeStorage.isEncryptionAvailable(); }"
    });
    const outputPath = path.join(fixture.root, "rejected.json");
    await expect(inspectStorageCapabilityPackage({ asarPath: fixture.asarPath, outputPath }))
      .rejects.toThrow("main probe marker");
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing exact entry", async () => {
    const fixture = await makeFixture({ omitUtility: true });
    await expect(inspectStorageCapabilityPackage({
      asarPath: fixture.asarPath,
      outputPath: path.join(fixture.root, "missing.json")
    })).rejects.toThrow("missing an exact probe entry");
  });

  it("rejects an oversized declared ASAR header before archive parsing", async () => {
    const fixture = await makeFixture();
    const malformedPath = path.join(fixture.root, "oversized-header.asar");
    const header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(0xffff_ffff, 4);
    await writeFile(malformedPath, header, { mode: 0o600 });
    header.fill(0);
    await expect(inspectStorageCapabilityPackage({
      asarPath: malformedPath,
      outputPath: path.join(fixture.root, "oversized-header.json")
    })).rejects.toThrow("header is invalid or oversized");
  });

  it("rejects a linked ASAR path", async () => {
    const fixture = await makeFixture();
    const linkedPath = path.join(fixture.root, "linked.asar");
    await symlink(fixture.asarPath, linkedPath);
    await expect(inspectStorageCapabilityPackage({
      asarPath: linkedPath,
      outputPath: path.join(fixture.root, "linked.json")
    })).rejects.toThrow("regular file");
  });

  it("does not replace an existing receipt", async () => {
    const fixture = await makeFixture();
    const outputPath = path.join(fixture.root, "existing.json");
    await writeFile(outputPath, "keep", { mode: 0o600 });
    await expect(inspectStorageCapabilityPackage({ asarPath: fixture.asarPath, outputPath }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(outputPath, "utf8")).toBe("keep");
  });
});

async function makeFixture(overrides: {
  readonly main?: string;
  readonly omitUtility?: boolean;
} = {}) {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "switchboard-storage-capability-"));
  const root = await realpath(rawRoot);
  temporaryDirectories.push(root);
  const source = path.join(root, "source");
  const mainDirectory = path.join(source, "dist/main");
  const daemonDirectory = path.join(source, "dist/daemon");
  await mkdir(mainDirectory, { recursive: true });
  await mkdir(daemonDirectory, { recursive: true });
  await writeFile(
    path.join(mainDirectory, "storage-capability-probe.cjs"),
    overrides.main ?? "const marker='switchboard-storage-capability-main-probe-v1'; function inspect(){ return safeStorage.isEncryptionAvailable(); }"
  );
  if (overrides.omitUtility !== true) {
    await writeFile(
      path.join(daemonDirectory, "storage-capability-probe.cjs"),
      "const marker='switchboard-storage-capability-utility-probe-v1'; const moduleName='node:sqlite'; typeof sqlite.DatabaseSync;"
    );
  }
  await writeFile(
    path.join(mainDirectory, "durable-spaces-gate.cjs"),
    "const marker='switchboard-durable-spaces-gate-v1'; const DURABLE_SPACES_ENABLED = false;"
  );
  const asarPath = path.join(root, "app.asar");
  await createPackage(source, asarPath);
  await chmod(asarPath, 0o600);
  return { root, asarPath };
}
