import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectGguf } from "./inspect-gguf.js";

describe("inspectGguf", () => {
  it("accepts a bounded little-endian GGUF v3 header and hashes the file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "switchboard-gguf-"));
    const modelPath = path.join(directory, "tiny.gguf");
    const header = Buffer.alloc(24);
    header.write("GGUF", 0, "ascii");
    header.writeUInt32LE(3, 4);
    header.writeBigUInt64LE(12n, 8);
    header.writeBigUInt64LE(8n, 16);
    await writeFile(modelPath, header);

    const result = await inspectGguf(modelPath);

    expect(result.inspection).toMatchObject({
      displayName: "tiny.gguf",
      version: 3,
      tensorCount: "12",
      metadataCount: "8",
      status: "header-verified"
    });
    expect(result.inspection.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects arbitrary files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "switchboard-gguf-"));
    const modelPath = path.join(directory, "not-a-model.gguf");
    await writeFile(modelPath, "not a model");

    await expect(inspectGguf(modelPath)).rejects.toMatchObject({
      detail: { code: "FILE_UNSUPPORTED" }
    });
  });

  it("stops before hashing when the inspection is cancelled", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "switchboard-gguf-"));
    const modelPath = path.join(directory, "cancelled.gguf");
    const header = Buffer.alloc(24);
    header.write("GGUF", 0, "ascii");
    header.writeUInt32LE(3, 4);
    header.writeBigUInt64LE(1n, 8);
    header.writeBigUInt64LE(1n, 16);
    await writeFile(modelPath, header);
    const controller = new AbortController();
    controller.abort();

    await expect(inspectGguf(modelPath, controller.signal)).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
  });
});
