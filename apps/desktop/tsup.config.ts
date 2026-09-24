import { defineConfig } from "tsup";

/**
 * Production ships neither sourcemaps nor readable identifiers.
 *
 * A `.cjs.map` inside the asar carries `sourcesContent` — the entire main
 * process in original TypeScript, including the sandbox's deny list and the
 * injection heuristics, handed to anyone who unpacks the app. Attackers reading
 * the exact rules they need to evade is a real cost for a debugging convenience
 * we get from a local dev build anyway.
 *
 * Minification is not obfuscation and is not claimed as a security control. It
 * is here for size; the honest security benefit is only that the deny list no
 * longer sits beside a comment explaining what it protects.
 */
const PRODUCTION = process.env["NODE_ENV"] === "production";

/**
 * Keep the `node:` prefix on builtin imports. Do not remove this.
 *
 * tsup rewrites `node:fs` to `fs` by default, for compatibility with Node
 * versions predating the prefix. That is harmless for every builtin except
 * one: **`node:sqlite` has no unprefixed alias.** `require("sqlite")` resolves
 * to nothing, so the main process died at load with `Cannot find module
 * 'sqlite'` and the app started with *no window* — a live process behind a
 * blank screen, and no error anywhere a person would think to look.
 *
 * This is why the book had never been opened from the main process (D-043): any
 * earlier attempt would have failed exactly this way, pointing at nothing.
 *
 * esbuild is not at fault, and marking the module external does not fix it —
 * esbuild emits `require("node:sqlite")` correctly on its own and tsup strips
 * the prefix afterwards. Electron 43 embeds Node 24; nothing needs the rewrite.
 *
 * Note the shape of this file: `macos-plist-hardening.test.ts` reads it as text
 * and expects each `entry: [...]` to start its own block. Reformatting breaks
 * that guard, which enforces the dependency boundary.
 */
const KEEP_NODE_PREFIX = false;

export default defineConfig([
  {
    entry: ["src/main/index.ts", "src/main/storage-capability-probe.ts", "src/main/durable-spaces-gate.ts"],
    // Compact emitted whitespace in development too. Source maps and readable
    // names remain available; the existing 2 MB main-bundle budget stays fixed.
    esbuildOptions(options) { options.minifyWhitespace = true; },
    outDir: "dist/main",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    clean: true,
    bundle: true,
    removeNodeProtocol: KEEP_NODE_PREFIX,
    external: ["electron", "node:sqlite"],
    noExternal: ["@cadrane/contracts", "zod", "docx", "jszip", "xml-js"]
  },
  {
    entry: ["src/preload/index.ts"],
    outDir: "dist/preload",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    clean: true,
    bundle: true,
    removeNodeProtocol: KEEP_NODE_PREFIX,
    external: ["electron"],
    noExternal: ["@cadrane/contracts", "zod"]
  },
  {
    entry: ["../daemon/src/index.ts", "../daemon/src/storage-capability-probe.ts"],
    outDir: "dist/daemon",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    clean: true,
    bundle: true,
    removeNodeProtocol: KEEP_NODE_PREFIX,
    external: ["node:sqlite"],
    noExternal: ["@cadrane/contracts", "@cadrane/runtime", "zod"]
  }
]);
