import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/storage-capability-probe.ts"],
  outDir: "dist",
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  bundle: true,
  external: ["node:sqlite"],
  noExternal: ["@cadrane/contracts", "@cadrane/runtime", "zod"]
});
