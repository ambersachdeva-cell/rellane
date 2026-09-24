/** Real files exercise extraction bounds and the words that actually survive. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSourceDocument } from "./source-document.js";
import { renderWorkroomDocx } from "./document.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rellane-source-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const wrap = (body: string) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
async function word(
  xml: string,
  extras: Record<string, string> = {},
): Promise<string> {
  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  for (const [name, data] of Object.entries(extras)) zip.file(name, data);
  const path = join(root, "brief.docx");
  await writeFile(
    path,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return path;
}
describe("source document snapshots", () => {
  it("preserves UTF-8 text and literal markup with hashes of the file and extracted text", async () => {
    const bytes = Buffer.from(
      "  # Brief\n₹25,000 · हिन्दी\n![reference](https://example.invalid/image)  ",
    );
    const file = join(root, "brief.md");
    await writeFile(file, bytes);
    const source = await readSourceDocument(file);
    expect(source).toMatchObject({
      fileName: "brief.md",
      format: "md",
      bytes: bytes.length,
      text: bytes.toString().trim(),
    });
    expect(source.fileSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(source.textSha256).toBe(
      createHash("sha256").update(source.text).digest("hex"),
    );
    expect(JSON.stringify(source)).not.toContain(root);
  });
  it("reads the actual Word export without losing rupees or Hindi", async () => {
    const file = join(root, "export.docx");
    const bytes = await renderWorkroomDocx("Nila Home", {
      id: "11111111-1111-4111-8111-111111111111",
      sourceTurnId: null,
      createdAt: 0,
      revision: 1,
      acceptedAt: null,
      body: "## Campaign\nBudget ₹25,000.\nकम बर्बादी, रोज़ की आसानी।",
    });
    await writeFile(file, bytes);
    const source = await readSourceDocument(file);
    expect(source.text).toContain("Nila Home");
    expect(source.text).toContain("Budget ₹25,000.");
    expect(source.text).toContain("कम बर्बादी, रोज़ की आसानी।");
    expect(source.coverage).toContain("Document body text only");
  });
  it("keeps visible paragraph order and omits fields, deleted text and unrelated parts", async () => {
    const file = await word(
      wrap(
        "<w:p><w:r><w:t>First &amp; true</w:t></w:r></w:p><w:p><w:r><w:instrText>INCLUDETEXT https://example.invalid/secret</w:instrText><w:t>Second</w:t><w:tab/><w:t>value</w:t></w:r><w:del><w:r><w:t>DELETED_CANARY</w:t></w:r></w:del><w:drawing><w:t>DRAWING_CANARY</w:t></w:drawing></w:p>",
      ),
      {
        "word/header1.xml": wrap("HEADER_CANARY"),
        "word/_rels/document.xml.rels":
          '<Relationships><Relationship TargetMode="External" Target="https://example.invalid/secret"/></Relationships>',
      },
    );
    const source = await readSourceDocument(file);
    expect(source.text).toBe("First & true\nSecond\tvalue");
    expect(source.text).not.toMatch(/CANARY|INCLUDETEXT|https:/u);
  });
  it("refuses entity declarations, broken XML and oversized expansion", async () => {
    await expect(
      readSourceDocument(
        await word(
          '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///private/data">]>' +
            wrap("<w:p><w:r><w:t>&x;</w:t></w:r></w:p>"),
        ),
      ),
    ).rejects.toThrow("entity declarations");
    const broken = await word(wrap("<w:p><w:r><w:t>broken"));
    await expect(readSourceDocument(broken)).rejects.toThrow("invalid XML");
    const expanded = await word(wrap(" ".repeat(2 * 1024 * 1024)));
    await expect(readSourceDocument(expanded)).rejects.toThrow(
      "expanded Word body",
    );
  });
  it("refuses unsupported, invalid, empty and oversized text without truncation", async () => {
    const file = join(root, "brief.txt");
    for (const bytes of [
      Buffer.from([0xff, 0xfe, 0x01]),
      Buffer.from("\0data"),
      Buffer.from(" "),
      Buffer.from("x".repeat(50_001)),
    ]) {
      await writeFile(file, bytes);
      await expect(readSourceDocument(file)).rejects.toThrow();
    }
    await expect(readSourceDocument(join(root, "report.pdf"))).rejects.toThrow(
      "Choose a Word",
    );
    await expect(readSourceDocument("relative.txt")).rejects.toThrow(
      "file picker",
    );
  });
  it("refuses symlinks and directories rather than reading through them", async () => {
    const file = join(root, "private.txt");
    await writeFile(file, "PRIVATE_TARGET");
    await symlink(file, join(root, "link.txt"));
    await expect(readSourceDocument(join(root, "link.txt"))).rejects.toThrow(
      "regular file",
    );
    await mkdir(join(root, "directory.txt"));
    await expect(
      readSourceDocument(join(root, "directory.txt")),
    ).rejects.toThrow();
  });
});
