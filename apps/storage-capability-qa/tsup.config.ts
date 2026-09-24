import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/native-capability-qa-main.ts"],
    outDir: "dist/main",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
    sourcemap: true,
    clean: true,
    bundle: true,
    external: ["electron"],
    noExternal: ["@cadrane/contracts", "zod"]
  },
  {
    entry: ["src/native-capability-qa-utility.ts"],
    outDir: "dist/utility",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
    sourcemap: true,
    clean: true,
    bundle: true,
    external: ["node:sqlite"],
    noExternal: ["@cadrane/contracts", "zod"]
  }
]);
