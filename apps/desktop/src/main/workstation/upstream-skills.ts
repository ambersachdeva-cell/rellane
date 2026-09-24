/**
 * Pinned upstream Hermes skill loader and bounded workstation routine adapter.
 *
 * Upstream skills sourced from NousResearch/hermes-agent:
 * Repository: https://github.com/NousResearch/hermes-agent
 * Commit: 5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04
 * License: MIT
 *
 * MIT License
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash } from "node:crypto";
import { WORKSTATION_PROMPT_LIMIT, type WorkstationRoutine } from "@cadrane/contracts";
import {
  HERMES_BUNDLED_SKILLS,
  type HermesBundledSkill,
  type HermesSkillFile,
  type HermesSkillProvenance
} from "./hermes-skills/catalogue.js";

export type { HermesBundledSkill, HermesSkillFile, HermesSkillProvenance };

export interface HermesSkillReadResult {
  readonly content: string;
  readonly sha256: string;
  readonly provenance: HermesSkillProvenance;
}

export interface HermesWorkstationRoutine extends WorkstationRoutine {
  readonly upstream?: HermesSkillProvenance;
}

/**
 * Validates that a skill ID is a safe identifier without traversal or absolute paths.
 */
function validateSkillId(id: string): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Skill ID must be a non-empty string.");
  }
  const trimmed = id.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/.test(trimmed)
  ) {
    throw new Error(`Skill ID cannot be an absolute path: "${id}".`);
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((seg) => seg === ".." || seg === ".")) {
    throw new Error(
      `Skill ID cannot contain traversal ("..") or dot (".") components: "${id}".`
    );
  }
}

/**
 * Validates that a file path is a safe relative path within a skill directory,
 * forbidding absolute paths and directory traversal.
 */
function validateRelativeFilePath(filePath: string): void {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("File path must be a non-empty string.");
  }
  const trimmed = filePath.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/.test(trimmed)
  ) {
    throw new Error(
      `File path must be a relative path within the skill directory, got absolute path: "${filePath}".`
    );
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(
      `File path cannot contain traversal, dot, or empty segments: "${filePath}".`
    );
  }
}

/**
 * Verifies that UTF-8 content matches the expected SHA-256 hash.
 */
export function verifyContentHash(
  content: string,
  expectedSha256: string,
  contextLabel: string
): void {
  const computedSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (computedSha256 !== expectedSha256) {
    throw new Error(
      `Integrity error for ${contextLabel}: expected SHA-256 ${expectedSha256}, computed ${computedSha256}.`
    );
  }
}

/**
 * Builds the composer prompt for a workstation routine incorporating the skill's
 * original SKILL.md content unchanged, preceded by short reviewed-session framing
 * and provenance attribution.
 *
 * Throws clearly if the combined prompt exceeds WORKSTATION_PROMPT_LIMIT (8,000 characters).
 */
export function buildSkillPrompt(
  skill: HermesBundledSkill,
  skillMdContent: string
): string {
  const promptLines = [
    `# Upstream Skill: ${skill.title}`,
    "",
    `> Source: ${skill.provenance.repository} (commit ${skill.provenance.commit.slice(0, 7)}, path: ${skill.provenance.path})`,
    `> License: ${skill.provenance.license} | Version: ${skill.provenance.version} | SHA-256: ${skill.provenance.sha256}`,
    `> Reference URL: ${skill.provenance.url}`,
    "> This skill is loaded into the reviewed workstation session prompt context as immutable upstream instructions.",
    "> No dynamic tool permissions, shell execution rights, or host environment access are granted by selecting this routine.",
    "",
    "---",
    "",
    skillMdContent
  ];

  const fullPrompt = promptLines.join("\n");

  if (fullPrompt.length > WORKSTATION_PROMPT_LIMIT) {
    throw new Error(
      `Skill "${skill.id}" prompt length (${fullPrompt.length}) exceeds composer limit of ${WORKSTATION_PROMPT_LIMIT} characters. Truncation is not permitted.`
    );
  }

  return fullPrompt;
}

/**
 * Lists all bundled Hermes skills available in the host catalogue.
 */
export function listHermesSkills(): readonly HermesBundledSkill[] {
  return HERMES_BUNDLED_SKILLS;
}

/**
 * Reads a named bundled file from a Hermes skill, preserving exact UTF-8 bytes and verifying integrity.
 *
 * @param id The bundled skill ID (e.g. "hermes/document-to-action-items")
 * @param filePath Relative path within the skill directory, defaulting to "SKILL.md"
 */
export function readHermesSkill(
  id: string,
  filePath?: string
): HermesSkillReadResult {
  validateSkillId(id);

  const skill = HERMES_BUNDLED_SKILLS.find((s) => s.id === id);
  if (!skill) {
    throw new Error(
      `Unknown Hermes skill ID: "${id}". Available skills: ${HERMES_BUNDLED_SKILLS.map((s) => s.id).join(", ")}`
    );
  }

  const targetPath = filePath === undefined ? "SKILL.md" : filePath;
  validateRelativeFilePath(targetPath);

  const file = skill.files.find((f) => f.path === targetPath);
  if (!file) {
    throw new Error(
      `File "${targetPath}" is not a bundled file for skill "${id}". Bundled files: ${skill.files.map((f) => f.path).join(", ")}`
    );
  }

  verifyContentHash(file.content, file.sha256, `file "${file.path}" in skill "${id}"`);

  if (targetPath === "SKILL.md" && skill.provenance.sha256 !== file.sha256) {
    throw new Error(
      `Integrity error for skill "${id}": provenance SHA-256 ${skill.provenance.sha256} does not match SKILL.md SHA-256 ${file.sha256}.`
    );
  }

  return {
    content: file.content,
    sha256: file.sha256,
    provenance: skill.provenance
  };
}

/**
 * Adapts bundled Hermes skills into native WorkstationRoutine objects for composer pre-fill.
 *
 * Selection populates prompt drafts only; no background tools, dynamic execution, or scheduler.
 */
export function hermesSkillRoutines(): readonly HermesWorkstationRoutine[] {
  return HERMES_BUNDLED_SKILLS.map((skill) => {
    const skillMd = skill.files.find((f) => f.path === "SKILL.md");
    if (!skillMd) {
      throw new Error(
        `Skill "${skill.id}" is missing required bundled file "SKILL.md".`
      );
    }

    verifyContentHash(
      skillMd.content,
      skillMd.sha256,
      `SKILL.md in skill "${skill.id}"`
    );

    if (skill.provenance.sha256 !== skillMd.sha256) {
      throw new Error(
        `Integrity error for skill "${skill.id}": provenance SHA-256 ${skill.provenance.sha256} does not match SKILL.md SHA-256 ${skillMd.sha256}.`
      );
    }

    const prompt = buildSkillPrompt(skill, skillMd.content);

    return {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      prompt,
      icon: skill.icon,
      sourceHint: skill.sourceHint,
      outputLabel: skill.outputLabel,
      upstream: skill.provenance
    };
  });
}
