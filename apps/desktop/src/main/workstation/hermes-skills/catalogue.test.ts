import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HERMES_BUNDLED_SKILLS,
  HERMES_AGENT_REPOSITORY,
  HERMES_AGENT_COMMIT,
  HERMES_AGENT_LICENSE,
  findHermesSkill,
  getHermesSkill,
  type HermesBundledSkill,
  type HermesSkillFile,
  type HermesSkillProvenance,
} from "./catalogue.js";

describe("Hermes Bundled Skills Catalogue", () => {
  const EXPECTED_IDS = [
    "hermes/document-to-action-items",
    "hermes/meeting-action-items",
    "hermes/weekly-review-planning",
  ] as const;

  const EXPECTED_DIGESTS: Record<string, { bytes: number; sha256: string; path: string }> = {
    "hermes/document-to-action-items": {
      bytes: 3910,
      sha256: "8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee",
      path: "skills/productivity/document-to-action-items/SKILL.md",
    },
    "hermes/meeting-action-items": {
      bytes: 3808,
      sha256: "1902f782551da96ee1f9b34d6f13af627f06150a498d874b0cc2a75d06d35aa8",
      path: "skills/productivity/meeting-action-items/SKILL.md",
    },
    "hermes/weekly-review-planning": {
      bytes: 3975,
      sha256: "a689257facb937cfca9bc5507dd9e729f287f0cd3f6abbf73448eb25f73fbaab",
      path: "skills/productivity/weekly-review-planning/SKILL.md",
    },
  };

  it("bundles exactly the three short portable productivity skills", () => {
    expect(HERMES_BUNDLED_SKILLS).toHaveLength(3);
    const ids = HERMES_BUNDLED_SKILLS.map((s) => s.id);
    expect(ids).toEqual(EXPECTED_IDS);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not expose grounded-citations in this slice", () => {
    const ids = HERMES_BUNDLED_SKILLS.map((s) => s.id);
    expect(ids).not.toContain("hermes/grounded-citations");
    expect(ids.some((id) => id.includes("grounded"))).toBe(false);
  });

  it("pins provenance to the exact upstream commit, repository, and MIT license", () => {
    for (const skill of HERMES_BUNDLED_SKILLS) {
      expect(skill.provenance.repository).toBe(HERMES_AGENT_REPOSITORY);
      expect(skill.provenance.commit).toBe(HERMES_AGENT_COMMIT);
      expect(skill.provenance.commit).toBe("5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04");
      expect(skill.provenance.license).toBe(HERMES_AGENT_LICENSE);
      expect(skill.provenance.version).toBe("0.1.0");

      const expected = EXPECTED_DIGESTS[skill.id];
      if (!expected) throw new Error(`Missing pinned expectation for ${skill.id}`);
      expect(expected).toBeDefined();
      expect(skill.provenance.path).toBe(expected.path);
      expect(skill.provenance.sha256).toBe(expected.sha256);
      expect(skill.provenance.url).toBe(
        `${HERMES_AGENT_REPOSITORY}/blob/${HERMES_AGENT_COMMIT}/${expected.path}`
      );
    }
  });

  it("embeds main file SKILL.md with exact case-sensitive UTF-8 byte hashes", () => {
    for (const skill of HERMES_BUNDLED_SKILLS) {
      expect(skill.files).toHaveLength(1);
      const mainFile = skill.files[0];
      if (!mainFile) throw new Error(`Missing bundled file for ${skill.id}`);
      expect(mainFile.path).toBe("SKILL.md");

      const expected = EXPECTED_DIGESTS[skill.id];
      if (!expected) throw new Error(`Missing pinned expectation for ${skill.id}`);
      const computedSha256 = createHash("sha256").update(mainFile.content, "utf8").digest("hex");
      expect(computedSha256).toBe(expected.sha256);
      expect(mainFile.sha256).toBe(expected.sha256);

      const bufferLength = Buffer.byteLength(mainFile.content, "utf8");
      expect(bufferLength).toBe(expected.bytes);
    }
  });

  it("ensures all embedded prompts fit within routine budget (<= 8000 chars)", () => {
    for (const skill of HERMES_BUNDLED_SKILLS) {
      const content = skill.files[0]!.content;
      expect(content.length).toBeLessThanOrEqual(8000);
      expect(content.length).toBeLessThanOrEqual(4000); // Each is under 4 KB
      expect(content.startsWith("---\n")).toBe(true);
      expect(content.includes("author: Ben Barclay (benbarclay), Hermes Agent")).toBe(true);
      expect(content.includes("license: MIT")).toBe(true);
    }
  });

  it("provides structured user-facing routine metadata and valid icons", () => {
    const allowedIcons = new Set<HermesBundledSkill["icon"]>([
      "write",
      "research",
      "build",
      "review",
      "data",
    ]);

    for (const skill of HERMES_BUNDLED_SKILLS) {
      expect(skill.name).toBeTruthy();
      expect(skill.title).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.sourceHint).toBeTruthy();
      expect(skill.outputLabel).toBeTruthy();
      expect(allowedIcons.has(skill.icon)).toBe(true);
    }

    expect(getHermesSkill("hermes/document-to-action-items").icon).toBe("data");
    expect(getHermesSkill("hermes/meeting-action-items").icon).toBe("write");
    expect(getHermesSkill("hermes/weekly-review-planning").icon).toBe("review");
  });

  it("provides immutable arrays and lookup helpers", () => {
    expect(Object.isFrozen(HERMES_BUNDLED_SKILLS)).toBe(true);
    for (const skill of HERMES_BUNDLED_SKILLS) {
      expect(Object.isFrozen(skill.files)).toBe(true);
      expect(Object.isFrozen(skill.provenance)).toBe(true);
    }

    const found = findHermesSkill("hermes/meeting-action-items");
    expect(found?.title).toBe("Meeting Action Items");

    const missing = findHermesSkill("hermes/non-existent");
    expect(missing).toBeUndefined();

    expect(() => getHermesSkill("hermes/unknown")).toThrow(
      "Hermes bundled skill not found: hermes/unknown"
    );
  });

  it("matches vendored disk files byte-for-byte against pinned vendored disk files", () => {
    // Relative to apps/desktop/src/main/workstation/hermes-skills
    const repoRoot = resolve(__dirname, "../../../../../..");
    const vendorDir = resolve(repoRoot, "vendor/hermes-agent");

    expect(existsSync(vendorDir)).toBe(true);
    {
      for (const skill of HERMES_BUNDLED_SKILLS) {
        const expected = EXPECTED_DIGESTS[skill.id];
      if (!expected) throw new Error(`Missing pinned expectation for ${skill.id}`);
        const vendorFilePath = resolve(vendorDir, expected.path);
        expect(existsSync(vendorFilePath)).toBe(true);

        const diskBytes = readFileSync(vendorFilePath);
        expect(diskBytes.length).toBe(expected.bytes);

        const diskSha256 = createHash("sha256").update(diskBytes).digest("hex");
        expect(diskSha256).toBe(expected.sha256);

        const diskContent = diskBytes.toString("utf8");
        expect(skill.files[0]!.content).toBe(diskContent);
      }
    }
  });
});
