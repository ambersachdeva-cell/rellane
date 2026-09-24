import {
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import {
  NodeManagedModelFileSystem,
  UnsafeManagedModelHardlinkError
} from "./model-download-files.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "switchboard-download-files-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("managed model filesystem", () => {
  it("does not truncate a pre-seeded hardlink when opening fresh staging", async () => {
    const outside = join(directory, "outside.bin");
    const staging = join(directory, "staging.partial");
    await writeFile(outside, "sensitive");
    await link(outside, staging);

    await expectRuntimeCode(
      new NodeManagedModelFileSystem().openWritable(staging, false, 0),
      "SECURITY_BOUNDARY"
    );
    expect(await readFile(outside, "utf8")).toBe("sensitive");
  });

  it("rejects hardlinked resume and stable-read handles", async () => {
    const outside = join(directory, "outside.bin");
    const staging = join(directory, "staging.partial");
    await writeFile(outside, "abc");
    await link(outside, staging);
    const fileSystem = new NodeManagedModelFileSystem();

    await expectRuntimeCode(
      fileSystem.openWritable(staging, true, 3),
      "SECURITY_BOUNDARY"
    );
    await expectRuntimeCode(
      fileSystem.openStableRead(staging),
      "SECURITY_BOUNDARY"
    );
    expect(await readFile(outside, "utf8")).toBe("abc");
  });

  it("distinguishes a missing entry from an unsafe hardlink identity", async () => {
    const outside = join(directory, "outside.bin");
    const staging = join(directory, "staging.partial");
    const fileSystem = new NodeManagedModelFileSystem();
    expect(await fileSystem.regularFileSize(staging)).toBeNull();

    await writeFile(outside, "abc");
    await link(outside, staging);
    await expect(fileSystem.regularFileSize(staging))
      .rejects.toBeInstanceOf(UnsafeManagedModelHardlinkError);
    expect(await readFile(outside, "utf8")).toBe("abc");
  });

  it("preserves the committed destination when directory sync fails", async () => {
    const source = join(directory, "source.bin");
    const destination = join(directory, "destination.bin");
    await writeFile(source, "verified");
    const fileSystem = new DirectorySyncFailureFileSystem();

    await expect(fileSystem.moveNoReplace(source, destination)).resolves.toEqual({
      moved: true,
      directoriesSynced: false
    });
    expect(await readFile(destination, "utf8")).toBe("verified");
    await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class DirectorySyncFailureFileSystem extends NodeManagedModelFileSystem {
  override async syncDirectory(): Promise<void> {
    throw new Error("simulated directory sync failure");
  }
}

async function expectRuntimeCode(
  promise: Promise<unknown>,
  code: RuntimeBoundaryError["detail"]["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected runtime error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeBoundaryError);
    expect((error as RuntimeBoundaryError).detail.code).toBe(code);
  }
}
