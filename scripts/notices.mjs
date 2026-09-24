#!/usr/bin/env node
/** Attribution must travel with the installed app. Walk production dependencies
 * from the desktop through real workspace/package resolution, rather than npm's
 * extraneous development tree. Keep full upstream licence text, including README
 * notices, and fail closed on missing or unreviewed licences.
 * Run `node scripts/notices.mjs` to regenerate, or add --check to verify. */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PINNED_VENDOR_MANIFEST, verifyVendorManifest } from "./verify-hermes-skill-vendor.mjs";
const repo = fileURLToPath(new URL("..", import.meta.url));
const BUNDLED = [
  {
    name: "llama.cpp",
    version: "b10182",
    license: "MIT",
    copyright: "Copyright (c) 2023-2025 The ggml authors",
    note: "Pinned runtime expected at apps/desktop/vendor/llama-b10182 for local packaging. Binaries are fetched separately; packaged server integrity is checked against the sealed app and its signing identity.",
  },
  {
    name: "Qwen3 4B (open weights)",
    version: "4B-Instruct",
    license: "Apache-2.0",
    copyright: "Copyright (c) Alibaba Cloud",
    note: "Optional default local model, downloaded separately. The installed GGUF identity is verified before the process is started.",
  },
  {
    name: "Electron",
    version: "43.2.0",
    license: "MIT",
    copyright: "Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.",
    note: "Includes Chromium (BSD-3-Clause and others) and Node.js (MIT). Their notices ship inside the Electron framework bundle in the packaged app.",
  },
];

const visited = new Map();
function collect(name, base) {
  if (name.startsWith("@types/") || name === "undici-types") return;
  const req = createRequire(join(base, "package.json"));
  const manifest = (req.resolve.paths(name + "/package.json") ?? [])
    .map(dir => join(dir, name, "package.json"))
    .find(candidate => existsSync(candidate));
  if (!manifest) throw new Error("Missing manifest: " + name);
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;
  const dir = dirname(realpathSync(manifest));
  if (pkg.name.startsWith("@cadrane/")) {
    visited.set(key, null);
    for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) collect(dep, dir);
    return;
  }
  const licenses = readdirSync(dir).filter((n) =>
    /^(licen[sc]e|copying|ofl)([.-].*)?$/i.test(n)
  );
  let license = licenses
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .join("\n\n");
  if (!license) {
    const readme = readdirSync(dir).find((n) => /^readme\.md$/i.test(n));
    if (readme) {
      const text = readFileSync(join(dir, readme), "utf8");
      const heading = /(?:^|\n)#{1,6}\s+licen[sc]e[^\n]*\n/i.exec(text);
      if (heading) license = text.slice(heading.index).trim();
    }
  }
  if (!license) throw new Error("Missing licence text: " + key);
  const entry = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository:
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
    text: license
  };
  visited.set(key, entry);
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort())
    collect(dep, dir);
}

const desktop = join(repo, "apps/desktop");
const dependencies = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).dependencies;
for (const name of Object.keys(dependencies).sort()) collect(name, desktop);
// Apache-2.0 and BSD are permissive and their obligation is attribution, which
// is exactly what this file generates. They are admitted deliberately rather
// than by widening the gate: a copyleft licence still stops the build here.
const permitted = new Set([
  "MIT",
  "ISC",
  "OFL-1.1",
  "BlueOak-1.0.0",
  "(MIT AND Zlib)",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "MIT-0",
  "Python-2.0"
]);
const entries = [...visited.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
for (const entry of entries) {
  if (entry.name === "jszip" && entry.license === "(MIT OR GPL-3.0-or-later)") entry.selectedLicense = "MIT";
  // Dual-licensed, and the permissive half is chosen deliberately and named, the
  // same way jszip's is. DOMPurify arrives with mermaid, which uses it to
  // sanitise the SVG it generates.
  else if (entry.name === "dompurify" && entry.license === "(MPL-2.0 OR Apache-2.0)") entry.selectedLicense = "Apache-2.0";
  // khroma ships no `license` field, only a `license` file, and that file is the
  // MIT text. Named here with its evidence rather than inferred by the loop,
  // because "the field was missing" must never quietly become "any licence".
  else if (entry.name === "khroma" && entry.license === undefined && /MIT License/i.test(entry.text ?? "")) entry.selectedLicense = "MIT";
  else if (permitted.has(entry.license)) entry.selectedLicense = entry.license;
  else throw new Error(`Review the licence before shipping ${entry.name}: ${entry.license}`);
}
const hermesIntegrity = verifyVendorManifest(repo);
if (!hermesIntegrity.ok) throw new Error(`Hermes attribution integrity failed: ${hermesIntegrity.errors.join("; ")}`);
const hermesLicense = readFileSync(join(repo, "vendor/hermes-agent/LICENSE"), "utf8").trim();
const body = `# Third-party notices

Rellane includes the libraries and fonts below. Full upstream licence notices are
preserved. Generated by scripts/notices.mjs from ${entries.length} installed
production packages. Type declarations and development tools are excluded.

JSZip is used under its MIT option. Its upstream file also describes an optional
GPL licence; that alternative is not selected for this product.

## Runtime and model components

${BUNDLED.map(b => `### ${b.name} ${b.version}\n\n- Licence: ${b.license}\n- ${b.copyright}\n- ${b.note}\n`).join("\n")}

## Vendored skill procedures

### Hermes Agent skills

Selected licence: ${PINNED_VENDOR_MANIFEST.license}
Upstream: ${PINNED_VENDOR_MANIFEST.repository}
Pinned commit: ${PINNED_VENDOR_MANIFEST.commit}

Rellane bundles the original document-to-action-items, meeting-action-items and
weekly-review-planning skill procedures. Its local numbered-reference checker
runs the original grounded-citations sources.py and _hermes_home.py scripts.
The full grounded-citations procedure remains archived rather than selectable.
Rellane's adapters are separate from the upstream Hermes runtime. The full agent
runtime is not included or started.

${hermesLicense}

## Libraries and fonts

${entries.map(e => `### ${e.name} ${e.version}\n\nSelected licence: ${e.selectedLicense}\nUpstream: ${e.repository ?? e.name}\n\n${e.text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trim()}`).join("\n\n---\n\n")}

## Rellane itself

Original Rellane source in this repository is licensed under MIT; see LICENSE.
Third-party components retain their own licences and notices above.
`;
const output = join(repo, "NOTICES.md");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== body) throw new Error("NOTICES.md is out of date. Run node scripts/notices.mjs.");
  console.log(`NOTICES.md is current: ${entries.length} production packages.`);
} else {
  writeFileSync(output, body);
  console.log(`NOTICES.md: ${entries.length} production packages, full upstream notices.`);
}
