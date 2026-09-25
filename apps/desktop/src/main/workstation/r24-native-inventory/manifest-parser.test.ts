import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  MAX_RAW_OUTPUT_BYTES,
  NativeInventoryParseError,
  parseNativeInventoryManifest
} from "./manifest-parser";

function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("R24 native inventory manifest parser", () => {
  it("refuses raw output exceeding maximum size limit before line splitting", () => {
    const validRow = `D\t${toHex("a")}\n`;
    const repeatCount = Math.ceil(MAX_RAW_OUTPUT_BYTES / validRow.length) + 1;
    const oversizedManifest = `R24-NOFOLLOW-INVENTORY\t1\n${validRow.repeat(repeatCount)}`;

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: oversizedManifest
      })
    ).toThrow(NativeInventoryParseError);
  });
  it("parses an exact sorted two-store synthetic fixture", () => {
    const noteHash = sha256("synthetic note payload");
    const settingsHash = sha256('{"theme":"dark"}');

    const manifest = [
      "R24-NOFOLLOW-INVENTORY\t1",
      `D\t${toHex("Vault")}`,
      `F\t${toHex("Vault/note.txt")}\t22\t${noteHash}`,
      `F\t${toHex("settings.json")}\t16\t${settingsHash}`,
      ""
    ].join("\n");

    const observation = parseNativeInventoryManifest({ exitCode: 0, stdout: manifest });

    expect(observation.entries).toHaveLength(3);
    expect(observation.totalEntries).toBe(3);
    expect(observation.directoryCount).toBe(1);
    expect(observation.fileCount).toBe(2);
    expect(observation.totalRegularFileBytes).toBe(38);
    expect(observation.counts["portable-data"]).toBe(3);
    expect(observation.counts["machine-bound"]).toBe(0);
    expect(observation.counts.unknown).toBe(0);

    expect(observation.presentStores).toContain("vault");
    expect(observation.presentStores).toContain("settings-grants");
    expect(observation.absentStores).not.toContain("vault");

    expect(observation.rootIdentityAttested).toBe(false);
    expect(observation.quiescenceAttested).toBe(false);
    expect(observation.bookSnapshotCoherent).toBe(false);
    expect(observation.portableKeysVerified).toBe(false);
    expect(observation.readyForExport).toBe(false);
  });

  it("refuses when exit code is non-zero even with apparent rows", () => {
    const manifest = [
      "R24-NOFOLLOW-INVENTORY\t1",
      `D\t${toHex("Vault")}`,
      ""
    ].join("\n");

    expect(() =>
      parseNativeInventoryManifest({ exitCode: 1, stdout: manifest })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({ exitCode: null, stdout: manifest })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses malformed headers", () => {
    expect(() =>
      parseNativeInventoryManifest({ exitCode: 0, stdout: "R24-NOFOLLOW-INVENTORY 1\n" })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({ exitCode: 0, stdout: "R24-NOFOLLOW-INVENTORY\t2\n" })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({ exitCode: 0, stdout: "OTHER-HEADER\t1\n" })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({ exitCode: 0, stdout: "" })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses malformed hex", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\t616\n"
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\t61zz\n"
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\t61AB\n"
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\t\n"
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses invalid UTF-8 in relative path", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\tff\n"
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: "R24-NOFOLLOW-INVENTORY\t1\nD\tc0af\n"
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses control characters, NUL, and backslashes", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("dir\x00file")}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("dir\x1ffile")}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("dir\\file")}\n`
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses absolute, traversal, dot, and empty components", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("/absolute")}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("Vault/../escape")}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("Vault/./same")}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("Vault//empty")}\n`
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses unsorted and duplicate rows", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `D\t${toHex("b")}`,
          `D\t${toHex("a")}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `D\t${toHex("Vault")}`,
          `D\t${toHex("Vault")}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses missing parent directories and conflicting paths", () => {
    const dummyHash = "a".repeat(64);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `F\t${toHex("Vault/note.txt")}\t10\t${dummyHash}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `F\t${toHex("Vault")}\t10\t${dummyHash}`,
          `F\t${toHex("Vault/note.txt")}\t10\t${dummyHash}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses bounds violations (depth, path bytes, count, file bytes, unsafe size)", () => {
    const dummyHash = "a".repeat(64);

    const deepPath = Array(33).fill("d").join("/");
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex(deepPath)}\n`
      })
    ).toThrow(NativeInventoryParseError);

    const longPath = "a".repeat(2049);
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex(longPath)}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `F\t${toHex("large.bin")}\t${64 * 1024 * 1024 + 1}\t${dummyHash}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `F\t${toHex("large.bin")}\t9999999999999999999999999\t${dummyHash}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: [
          "R24-NOFOLLOW-INVENTORY\t1",
          `F\t${toHex("bad.bin")}\t-1\t${dummyHash}`,
          ""
        ].join("\n")
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("refuses extra columns, invalid hashes, and trailing junk", () => {
    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("Vault")}\textra\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nF\t${toHex("file.txt")}\t10\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nF\t${toHex("file.txt")}\t10\t${"b".repeat(63)}\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\nD\t${toHex("Vault")}\n\n`
      })
    ).toThrow(NativeInventoryParseError);

    expect(() =>
      parseNativeInventoryManifest({
        exitCode: 0,
        stdout: `R24-NOFOLLOW-INVENTORY\t1\r\nD\t${toHex("Vault")}\r\n`
      })
    ).toThrow(NativeInventoryParseError);
  });

  it("keeps unknown and machine-bound paths as visible blockers without dropping them", () => {
    const dummyHash = "c".repeat(64);
    const manifest = [
      "R24-NOFOLLOW-INVENTORY\t1",
      `F\t${toHex("backup.key")}\t32\t${dummyHash}`,
      `F\t${toHex("unknown-entry.xyz")}\t64\t${dummyHash}`,
      ""
    ].join("\n");

    const observation = parseNativeInventoryManifest({ exitCode: 0, stdout: manifest });

    expect(observation.entries).toHaveLength(2);
    expect(observation.counts["machine-bound"]).toBe(1);
    expect(observation.counts.unknown).toBe(1);
    expect(observation.readyForExport).toBe(false);

    const blockersText = observation.blockers.join("\n");
    expect(blockersText).toContain("backup.key");
    expect(blockersText).toContain("unknown-entry.xyz");
    expect(blockersText.toLowerCase()).toContain("machine-bound");
    expect(blockersText.toLowerCase()).toContain("unknown");
  });

  it("keeps Book+WAL unverified and marks snapshot coherence as false", () => {
    const dummyHash = "d".repeat(64);
    const manifest = [
      "R24-NOFOLLOW-INVENTORY\t1",
      `F\t${toHex("book.sqlite")}\t4096\t${dummyHash}`,
      `F\t${toHex("book.sqlite-wal")}\t1024\t${dummyHash}`,
      ""
    ].join("\n");

    const observation = parseNativeInventoryManifest({ exitCode: 0, stdout: manifest });

    expect(observation.entries).toHaveLength(2);
    expect(observation.bookSnapshotCoherent).toBe(false);
    expect(observation.readyForExport).toBe(false);

    const blockersText = observation.blockers.join("\n");
    expect(blockersText.toLowerCase()).toContain("book");
    expect(blockersText.toLowerCase()).toContain("wal");
    expect(blockersText.toLowerCase()).toContain("unverified");
  });
});