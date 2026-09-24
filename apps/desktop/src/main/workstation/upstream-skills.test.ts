import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { WORKSTATION_PROMPT_LIMIT } from "@cadrane/contracts";
import {
  HERMES_BUNDLED_SKILLS,
  type HermesBundledSkill
} from "./hermes-skills/catalogue.js";
import {
  listHermesSkills,
  readHermesSkill,
  hermesSkillRoutines,
  buildSkillPrompt,
  verifyContentHash
} from "./upstream-skills.js";

describe("upstream-skills", () => {
  describe("host metadata / listHermesSkills", () => {
    it("returns all bundled skills from the catalogue", () => {
      const skills = listHermesSkills();
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBe(3);
      expect(skills).toBe(HERMES_BUNDLED_SKILLS);
    });

    it("exposes the three portable short bundles with valid identifiers", () => {
      const skills = listHermesSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toEqual([
        "hermes/document-to-action-items",
        "hermes/meeting-action-items",
        "hermes/weekly-review-planning"
      ]);
      // Grounded citations is retained for next adoption and must not be bundled in this slice
      expect(ids).not.toContain("hermes/grounded-citations");
    });

    it("verifies every skill provides valid host metadata, icon, and provenance", () => {
      const validIcons = new Set(["write", "research", "build", "review", "data"]);
      for (const skill of listHermesSkills()) {
        expect(skill.id).toMatch(/^hermes\/[a-z0-9-]+$/);
        expect(skill.name.length).toBeGreaterThan(0);
        expect(skill.title.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeGreaterThan(0);
        expect(validIcons.has(skill.icon)).toBe(true);
        expect(skill.sourceHint.length).toBeGreaterThan(0);
        expect(skill.outputLabel.length).toBeGreaterThan(0);

        // Provenance verification
        expect(skill.provenance.repository).toBe("https://github.com/NousResearch/hermes-agent");
        expect(skill.provenance.commit).toBe("5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04");
        expect(skill.provenance.license).toBe("MIT");
        expect(skill.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(skill.provenance.url).toContain(skill.provenance.commit);

        // Bundled files
        expect(skill.files.length).toBeGreaterThan(0);
        const skillMd = skill.files.find((f) => f.path === "SKILL.md");
        expect(skillMd).toBeDefined();
        expect(skillMd?.sha256).toBe(skill.provenance.sha256);
      }
    });
  });

  describe("exact read / readHermesSkill", () => {
    it("reads default SKILL.md when filePath is omitted", () => {
      const result = readHermesSkill("hermes/document-to-action-items");
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.sha256).toBe("8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee");
      expect(result.provenance.commit).toBe("5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04");

      // Verify returned SHA-256 against actual computed hash of content
      const computed = createHash("sha256").update(result.content, "utf8").digest("hex");
      expect(computed).toBe(result.sha256);
    });

    it("reads explicit SKILL.md file path matching default read", () => {
      const defaultRead = readHermesSkill("hermes/meeting-action-items");
      const explicitRead = readHermesSkill("hermes/meeting-action-items", "SKILL.md");
      expect(explicitRead.content).toBe(defaultRead.content);
      expect(explicitRead.sha256).toBe(defaultRead.sha256);
      expect(explicitRead.sha256).toBe("1902f782551da96ee1f9b34d6f13af627f06150a498d874b0cc2a75d06d35aa8");
    });

    it("reads all bundled skills and matches pinned upstream SHA-256 byte hashes", () => {
      const expectedHashes: Record<string, string> = {
        "hermes/document-to-action-items": "8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee",
        "hermes/meeting-action-items": "1902f782551da96ee1f9b34d6f13af627f06150a498d874b0cc2a75d06d35aa8",
        "hermes/weekly-review-planning": "a689257facb937cfca9bc5507dd9e729f287f0cd3f6abbf73448eb25f73fbaab"
      };

      for (const [id, expectedSha] of Object.entries(expectedHashes)) {
        const result = readHermesSkill(id);
        expect(result.sha256).toBe(expectedSha);
        const computed = createHash("sha256").update(result.content, "utf8").digest("hex");
        expect(computed).toBe(expectedSha);
        // Each original SKILL.md is under 4 KB
        expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(4096);
      }
    });
  });

  describe("no widening through path input / boundary defense", () => {
    it("rejects unknown skill IDs", () => {
      expect(() => readHermesSkill("hermes/unknown-skill")).toThrow(/Unknown Hermes skill ID/);
      expect(() => readHermesSkill("")).toThrow(/Skill ID must be a non-empty string/);
      expect(() => readHermesSkill("   ")).toThrow(/Skill ID must be a non-empty string/);
    });

    it("rejects path traversal in skill IDs", () => {
      expect(() => readHermesSkill("hermes/../document-to-action-items")).toThrow(/traversal/i);
      expect(() => readHermesSkill("../../etc/passwd")).toThrow(/traversal/i);
      expect(() => readHermesSkill("hermes/./meeting-action-items")).toThrow(/traversal|dot/i);
    });

    it("rejects absolute file paths on POSIX and Windows", () => {
      expect(() => readHermesSkill("hermes/document-to-action-items", "/etc/passwd")).toThrow(
        /relative path/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "/SKILL.md")).toThrow(
        /relative path/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "C:\\Windows\\System32")).toThrow(
        /relative path/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "D:/skills/SKILL.md")).toThrow(
        /relative path/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "\\\\unc\\server")).toThrow(
        /relative path/i
      );
    });

    it("rejects directory traversal in file paths", () => {
      expect(() => readHermesSkill("hermes/document-to-action-items", "../package.json")).toThrow(
        /traversal/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "references/../../etc/shadow")).toThrow(
        /traversal/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "..")).toThrow(
        /traversal/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "./SKILL.md")).toThrow(
        /dot/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "SKILL.md/..")).toThrow(
        /traversal/i
      );
    });

    it("rejects unbundled file paths", () => {
      expect(() => readHermesSkill("hermes/document-to-action-items", "package.json")).toThrow(
        /not a bundled file/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "references/missing.md")).toThrow(
        /not a bundled file/i
      );
      expect(() => readHermesSkill("hermes/document-to-action-items", "scripts/sources.py")).toThrow(
        /not a bundled file/i
      );
    });

    it("throws an error when content hash does not match expected SHA-256", () => {
      expect(() => {
        verifyContentHash("tampered content", "8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee", "tampered file");
      }).toThrow(/Integrity error/);
    });
  });

  describe("hermesSkillRoutines", () => {
    it("produces workstation routines with structural compatibility", () => {
      const routines = hermesSkillRoutines();
      expect(routines.length).toBe(3);

      for (const routine of routines) {
        expect(routine.id).toMatch(/^hermes\//);
        expect(routine.title.length).toBeGreaterThan(0);
        expect(routine.description.length).toBeGreaterThan(0);
        expect(routine.outputLabel.length).toBeGreaterThan(0);
        expect(routine.sourceHint.length).toBeGreaterThan(0);
        expect(["write", "research", "build", "review", "data"]).toContain(routine.icon);

        // G3 upstream provenance attachment
        expect(routine.upstream).toBeDefined();
        expect(routine.upstream?.repository).toBe("https://github.com/NousResearch/hermes-agent");
        expect(routine.upstream?.license).toBe("MIT");
      }
    });

    it("contains entire original SKILL.md unchanged with short framing and provenance", () => {
      const routines = hermesSkillRoutines();
      for (const routine of routines) {
        const readResult = readHermesSkill(routine.id);

        // Prompt contains the exact original bytes of SKILL.md
        expect(routine.prompt).toContain(readResult.content);
        expect(routine.prompt.endsWith(readResult.content)).toBe(true);

        // Prompt contains provenance markers
        expect(routine.prompt).toContain(routine.upstream?.repository);
        expect(routine.prompt).toContain(routine.upstream?.commit.slice(0, 7));
        expect(routine.prompt).toContain(routine.upstream?.license);
        expect(routine.prompt).toContain(routine.upstream?.sha256);

        // Prompt contains reviewed-session framing and tool disclaimers
        expect(routine.prompt).toContain("reviewed workstation session");
        expect(routine.prompt).toContain("No dynamic tool permissions");
      }
    });

    it("enforces bounded length: every routine prompt fits within 8,000 characters", () => {
      const routines = hermesSkillRoutines();
      for (const routine of routines) {
        expect(routine.prompt.length).toBeLessThanOrEqual(WORKSTATION_PROMPT_LIMIT);
        expect(routine.prompt.length).toBeLessThanOrEqual(8000);
        // Ensure prompt is non-trivial (framing + ~3.8 KB SKILL.md is ~4.3-4.5 KB)
        expect(routine.prompt.length).toBeGreaterThan(3800);
      }
    });

    it("throws clearly rather than truncating when skill prompt exceeds 8,000 characters", () => {
      const [skill] = listHermesSkills();
      if (!skill) throw new Error("Bundled skill fixture is missing.");
      // Simulate large content such as grounded-citations (12,652 bytes)
      const oversizedContent = "A".repeat(8100);

      expect(() => {
        buildSkillPrompt(skill, oversizedContent);
      }).toThrow(/exceeds composer limit of 8000 characters\. Truncation is not permitted\./);
    });

  });
});
