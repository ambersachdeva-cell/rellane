#!/usr/bin/env node

/**
 * Verification script for vendored Hermes skills in Rellane.
 * Validates that vendored files in vendor/hermes-agent match the pinned manifest commit,
 * paths, byte counts, and SHA-256 digests.
 *
 * Zero runtime dependencies beyond Node built-ins.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const PINNED_VENDOR_MANIFEST = {
  repository: "https://github.com/NousResearch/hermes-agent",
  commit: "5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04",
  license: "MIT",
  files: [
    {
      path: "LICENSE",
      sha256: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
      bytes: 1070,
    },
    {
      path: "skills/productivity/document-to-action-items/SKILL.md",
      sha256: "8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee",
      bytes: 3910,
    },
    {
      path: "skills/productivity/meeting-action-items/SKILL.md",
      sha256: "1902f782551da96ee1f9b34d6f13af627f06150a498d874b0cc2a75d06d35aa8",
      bytes: 3808,
    },
    {
      path: "skills/productivity/weekly-review-planning/SKILL.md",
      sha256: "a689257facb937cfca9bc5507dd9e729f287f0cd3f6abbf73448eb25f73fbaab",
      bytes: 3975,
    },
    {
      path: "skills/research/grounded-citations/SKILL.md",
      sha256: "19fba3a4ceedf768af6851e094b268a66b62af750d4d0689c5d62d5d50c032b6",
      bytes: 12652,
    },
    {
      path: "skills/research/grounded-citations/references/citation-formats.md",
      sha256: "209312a46dd9516e44e78f617589f789e07d54660e347b6b3882e8ac60097d04",
      bytes: 2418,
    },
    {
      path: "skills/research/grounded-citations/references/grounding-rationale.md",
      sha256: "2835754857ea05a1c801e88a50d4c2b4cc6ebd52cc4cc1f5741dba05f5af73c1",
      bytes: 3127,
    },
    {
      path: "skills/research/grounded-citations/scripts/sources.py",
      sha256: "a867ae6ba99166b4114bfef1c15b57036e286fe22c48534caec28cc8335bde0c",
      bytes: 25808,
    },
    {
      path: "skills/research/grounded-citations/scripts/_hermes_home.py",
      sha256: "4bfa31ce48ffaca3ae3fdd2ba5f093a2bedc34b057eec22a38f46e2d68b333d4",
      bytes: 836,
    },
  ],
};

export function verifyVendorManifest(repoRoot) {
  const vendorDir = resolve(repoRoot, "vendor/hermes-agent");
  const errors = [];

  if (!existsSync(vendorDir)) {
    errors.push(`Vendor directory does not exist: ${vendorDir}`);
    return { ok: false, errors, checked: 0 };
  }

  try {
    const manifest = JSON.parse(readFileSync(resolve(vendorDir, "MANIFEST.json"), "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(PINNED_VENDOR_MANIFEST)) {
      errors.push("MANIFEST.json does not match the pinned vendor manifest.");
    }
  } catch {
    errors.push("MANIFEST.json is missing or invalid.");
  }

  let checked = 0;
  for (const entry of PINNED_VENDOR_MANIFEST.files) {
    const fullPath = resolve(vendorDir, entry.path);
    if (!existsSync(fullPath)) {
      errors.push(`Missing vendored file: ${entry.path} (expected at ${fullPath})`);
      continue;
    }

    const buffer = readFileSync(fullPath);
    if (buffer.length !== entry.bytes) {
      errors.push(
        `Byte length mismatch for ${entry.path}: expected ${entry.bytes}, got ${buffer.length}`
      );
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== entry.sha256) {
      errors.push(
        `SHA256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${sha256}`
      );
    }

    checked++;
  }

  // Check catalogue source file if present
  const cataloguePath = resolve(
    repoRoot,
    "apps/desktop/src/main/workstation/hermes-skills/catalogue.ts"
  );
  if (existsSync(cataloguePath)) {
    const catalogueSource = readFileSync(cataloguePath, "utf8");

    if (!catalogueSource.includes(PINNED_VENDOR_MANIFEST.commit)) {
      errors.push(`Catalogue does not reference pinned commit ${PINNED_VENDOR_MANIFEST.commit}`);
    }

    const bundledPaths = [
      "skills/productivity/document-to-action-items/SKILL.md",
      "skills/productivity/meeting-action-items/SKILL.md",
      "skills/productivity/weekly-review-planning/SKILL.md",
    ];

    for (const relPath of bundledPaths) {
      const entry = PINNED_VENDOR_MANIFEST.files.find((f) => f.path === relPath);
      if (entry && !catalogueSource.includes(entry.sha256)) {
        errors.push(`Catalogue missing expected SHA256 for ${relPath}: ${entry.sha256}`);
      }
    }

    if (catalogueSource.includes("hermes/grounded-citations")) {
      errors.push("Catalogue must not expose grounded-citations in this slice");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checked,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = verifyVendorManifest(repoRoot);

  if (!result.ok) {
    console.error(`[hermes-vendor-verify] FAILED with ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `[hermes-vendor-verify] SUCCESS: Verified ${result.checked} vendored file(s) against pin ${PINNED_VENDOR_MANIFEST.commit}`
  );
  process.exit(0);
}
