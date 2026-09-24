/**
 * Every binary the packager signs must be a binary the packager copied.
 *
 * ## Why this exists
 *
 * `mac.binaries` told electron-builder to codesign
 * `Contents/Resources/llama-b10182/llama-server`. `extraResources` said which
 * folders get copied into `Contents/Resources`. On 2026-09-03 a commit adding
 * the `read-document` helper **replaced** the `extraResources` array rather than
 * appending to it, and the llama entry went with it — while `mac.binaries` kept
 * pointing at the file.
 *
 * From that moment `package:dir` could not finish. It copied no llama runtime,
 * then asked `codesign` to sign one, and died on `No such file or directory`.
 * The half-written bundle it left behind failed `codesign --verify` with
 * "a sealed resource is missing or invalid" — which was read as a signing
 * problem, and was really a packaging problem wearing a signing problem's
 * clothes. Two days were spent on the wrong cause.
 *
 * The worse half is what shipped. `/Applications/Cadrane.app` carried no
 * `llama-b10182` at all, so `bundled-local-runtime.ts` — which resolves
 * `resourcesPath/llama-b10182/llama-server` when packaged — had nothing to
 * start. The local model is the floor this product stands on when no
 * subscription answers, and the floor was not in the building.
 *
 * A unit test cannot package an app. It can hold the invariant that made the
 * failure possible: **a path in `mac.binaries` that no `extraResources` entry
 * produces is a build that cannot succeed**, and that is knowable from the
 * config alone, in milliseconds, before anyone waits twenty minutes to watch
 * `codesign` discover it.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface ExtraResource {
  readonly from: string;
  readonly to: string;
}

interface BuildConfig {
  readonly extraResources?: readonly ExtraResource[];
  readonly mac?: { readonly binaries?: readonly string[] };
}

async function buildConfig(): Promise<BuildConfig> {
  const raw = await import(path.join(desktopDir, "package.json"), {
    with: { type: "json" }
  });
  return (raw.default as { build: BuildConfig }).build;
}

describe("the packaging contract", () => {
  it("copies every binary it has promised to sign", async () => {
    const config = await buildConfig();
    const binaries = config.mac?.binaries ?? [];
    const resources = config.extraResources ?? [];

    for (const binary of binaries) {
      // `mac.binaries` paths are bundle-relative and always live under
      // Contents/Resources; an entry outside it would be signing something
      // electron-builder did not put there, which is its own bug.
      const prefix = "Contents/Resources/";
      expect(
        binary.startsWith(prefix),
        `${binary} is signed but is not under ${prefix}`
      ).toBe(true);

      const insideResources = binary.slice(prefix.length);
      const producer = resources.find(
        (entry) => insideResources === entry.to || insideResources.startsWith(`${entry.to}/`)
      );

      expect(
        producer,
        `Nothing copies ${binary}. It is listed in mac.binaries, so codesign will be asked ` +
          `for it and the whole package will fail on "No such file or directory". ` +
          `Add an extraResources entry whose "to" is "${insideResources.split("/")[0]}".`
      ).toBeDefined();
    }
  });

  it("copies those binaries from somewhere that actually exists on disk", async () => {
    const config = await buildConfig();
    const resources = config.extraResources ?? [];

    // A `from` that has gone missing fails exactly like a missing entry, and is
    // the more likely way this breaks next: vendor/ is large, and something
    // that large is a tempting thing to clean.
    for (const entry of resources) {
      const source = path.resolve(desktopDir, entry.from);
      await expect(
        access(source),
        `extraResources copies from ${entry.from}, which is not on disk`
      ).resolves.toBeUndefined();
    }
  });

  it("still ships the local runtime the app resolves at startup", async () => {
    const config = await buildConfig();

    // Named rather than merely counted, because this is the one the product
    // makes a promise about: Rellane works with no subscription docked, and
    // `bundled-local-runtime.ts` looks for exactly this path when packaged.
    expect(
      (config.extraResources ?? []).some((entry) => entry.to === "llama-b10182"),
      "The bundled llama.cpp runtime is not copied into the app. Without it the " +
        "local engine cannot start in a packaged build, and 'Rellane always works' " +
        "stops being true."
    ).toBe(true);
  });
});
