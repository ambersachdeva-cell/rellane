/** TypeScript / vitest: generated Word files must preserve facts and keep source
 * markup inert, including source text that tries to introduce external content. */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { CaseArtifactVersion } from "@cadrane/contracts";
import { renderWorkroomDocx } from "./document.js";

const version: CaseArtifactVersion = {
  id: "22222222-2222-4222-8222-222222222222",
  revision: 3,
  sourceTurnId: null,
  body: "# Launch brief\n\nBudget ₹12,500 & delivery in दिल्ली.\n- Check the claim\n<script>fetch('https://example.com/private')</script>\n![tracker](https://example.com/pixel)",
  createdAt: 100,
  acceptedAt: null
};

describe("editable Word output", () => {
  it("creates real headings and bullets while preserving facts and escaping imported markup", async () => {
    const zip = await JSZip.loadAsync(
      await renderWorkroomDocx("Nila Home campaign", version)
    );
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain("Nila Home campaign");
    expect(body).toContain("Budget ₹12,500 &amp; delivery in दिल्ली.");
    expect(body).toContain('w:val="Heading1"');
    expect(body).toContain("w:numPr");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("![tracker](https://example.com/pixel)");
    expect(body).toContain("Draft — not accepted");
    expect(body).not.toContain("Accepted by owner");
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".rels"))
        expect(await zip.file(name)!.async("string")).not.toContain(
          'TargetMode="External"'
        );
      expect(name).not.toMatch(/vbaProject|word\/media\//u);
    }
  });
  it("labels the exported acceptance state and refuses XML-invalid or unbounded content", async () => {
    const zip = await JSZip.loadAsync(
      await renderWorkroomDocx("Accepted proposal", {
        ...version,
        acceptedAt: 200
      })
    );
    expect(await zip.file("word/document.xml")!.async("string")).toContain(
      "Accepted by owner"
    );
    await expect(
      renderWorkroomDocx("Proposal", { ...version, body: "broken\u0000text" })
    ).rejects.toThrow("character Word cannot save");
    await expect(
      renderWorkroomDocx("Proposal", { ...version, body: "\ud800" })
    ).rejects.toThrow("character Word cannot save");
    await expect(
      renderWorkroomDocx("Proposal", { ...version, body: "x".repeat(50_001) })
    ).rejects.toThrow("too long");
  });
});
