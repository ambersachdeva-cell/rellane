import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { toPhrase } from "./book/recovery.js";
import {
  createPortableWorkspaceKeyEnvelopeFile,
  parsePortableWorkspaceKeyEnvelope,
  withPortableWorkspaceKey,
  wrapPortableWorkspaceKey
} from "./r24-portable-workspace-key-envelope.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const REFERENCE = { spaceId: SPACE_ID, keyId: KEY_ID };
const PHRASE = toPhrase(Buffer.alloc(20, 7));
const WRONG_PHRASE = toPhrase(Buffer.alloc(20, 8));

describe("isolated portable workspace-key envelope", () => {
  it("opens only after authentication and wipes the callback's mutable key copy", async () => {
    const sourceKey = Buffer.alloc(32, 43);
    const envelope = wrapPortableWorkspaceKey(REFERENCE, PHRASE, sourceKey);
    const encoded = JSON.stringify(envelope);
    expect(encoded).not.toContain(sourceKey.toString("hex"));
    expect(encoded).not.toContain(sourceKey.toString("base64url"));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      domain: "cadrane/portable-workspace-key-envelope/v1",
      kdf: "hkdf-sha256-book-phrase/v1",
      cipher: "aes-256-gcm",
      ...REFERENCE
    });
    let borrowed: Uint8Array | undefined;
    await withPortableWorkspaceKey(envelope, REFERENCE, PHRASE, async key => {
      borrowed = key;
      expect(Buffer.from(key)).toEqual(sourceKey);
      await Promise.resolve();
      expect(Buffer.from(key)).toEqual(sourceKey);
    });
    expect(borrowed).toEqual(new Uint8Array(32));
    expect(sourceKey).toEqual(Buffer.alloc(32, 43));
    expect(parsePortableWorkspaceKeyEnvelope(`${encoded}\n`)).toEqual(envelope);
    let failedBorrow: Uint8Array | undefined;
    await expect(withPortableWorkspaceKey(envelope, REFERENCE, PHRASE, key => {
      failedBorrow = key;
      throw new Error("synthetic callback failure");
    })).rejects.toThrow("synthetic callback failure");
    expect(failedBorrow).toEqual(new Uint8Array(32));
  });

  it("rejects wrong phrases, identity swaps, and all authenticated-field changes before callback", async () => {
    const envelope = wrapPortableWorkspaceKey(REFERENCE, PHRASE, Buffer.alloc(32, 11));
    const callback = vi.fn();
    await expect(withPortableWorkspaceKey(envelope, REFERENCE, WRONG_PHRASE, callback))
      .rejects.toThrow("could not be opened");
    await expect(withPortableWorkspaceKey(envelope, { ...REFERENCE, keyId: OTHER_ID }, PHRASE, callback))
      .rejects.toThrow("could not be opened");
    for (const field of ["spaceId", "keyId", "salt", "nonce", "ciphertext", "tag"] as const) {
      const changed = { ...envelope, [field]: field === "spaceId" || field === "keyId"
        ? OTHER_ID : flip(envelope[field]) };
      await expect(withPortableWorkspaceKey(changed, REFERENCE, PHRASE, callback))
        .rejects.toThrow("could not be opened");
    }
    const other = wrapPortableWorkspaceKey({ spaceId: OTHER_ID, keyId: KEY_ID }, PHRASE, Buffer.alloc(32, 55));
    await expect(withPortableWorkspaceKey(other, REFERENCE, PHRASE, callback))
      .rejects.toThrow("could not be opened");
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects malformed, noncanonical, and oversized records", async () => {
    const envelope = wrapPortableWorkspaceKey(REFERENCE, PHRASE, Buffer.alloc(32, 19));
    for (const value of [
      { ...envelope, extra: "unexpected" },
      { ...envelope, domain: "CADRANE-BACKUP/v2" },
      { ...envelope, ciphertext: `${envelope.ciphertext}=` },
      { ...envelope, ciphertext: "A".repeat(5000) },
      { ...envelope, tag: "AA" }
    ]) {
      expect(() => parsePortableWorkspaceKeyEnvelope(JSON.stringify(value))).toThrow();
    }
    expect(() => parsePortableWorkspaceKeyEnvelope(` ${JSON.stringify(envelope)}`)).toThrow();
    expect(() => parsePortableWorkspaceKeyEnvelope(`${JSON.stringify(envelope)}\n\n`)).toThrow();
    expect(() => wrapPortableWorkspaceKey(REFERENCE, PHRASE, Buffer.alloc(31))).toThrow();
    expect(() => wrapPortableWorkspaceKey(REFERENCE, "not-a-phrase", Buffer.alloc(32))).toThrow();
    expect(() => wrapPortableWorkspaceKey(REFERENCE, PHRASE,
      new Uint8Array(new SharedArrayBuffer(32)))).toThrow();
  });

  it("publishes encrypted bytes without replacing an existing file or symlink", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "r24-portable-key-"));
    try {
      const destination = path.join(directory, "workspace-key.json");
      const sourceKey = Buffer.alloc(32, 93);
      const envelope = await createPortableWorkspaceKeyEnvelopeFile(
        destination, REFERENCE, PHRASE, sourceKey);
      const firstBytes = await readFile(destination, "utf8");
      expect(firstBytes).toBe(`${JSON.stringify(envelope)}\n`);
      expect(firstBytes).not.toContain(sourceKey.toString("base64url"));
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      await expect(createPortableWorkspaceKeyEnvelopeFile(
        destination, REFERENCE, PHRASE, Buffer.alloc(32, 1)))
        .rejects.toThrow("could not be opened or published");
      expect(await readFile(destination, "utf8")).toBe(firstBytes);

      const outside = path.join(directory, "outside.txt");
      const symlinkPath = path.join(directory, "link.json");
      await writeFile(outside, "untouched", "utf8");
      await symlink(outside, symlinkPath);
      await expect(createPortableWorkspaceKeyEnvelopeFile(
        symlinkPath, REFERENCE, PHRASE, sourceKey)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("untouched");
      expect((await readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function flip(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
