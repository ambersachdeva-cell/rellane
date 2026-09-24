import { readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("Atomic publish verification skipped: Darwin-only native boundary.");
  process.exit(0);
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = dirname(scriptsDirectory);
const repositoryDirectory = dirname(dirname(runtimeDirectory));
const nativeDirectory = join(runtimeDirectory, "native", "atomic-publish");
const nodeExecutable = await realpath(process.execPath);
const nodePrefix = dirname(dirname(nodeExecutable));
const nodeHeader = join(nodePrefix, "include", "node", "node_version.h");
const header = await readFile(nodeHeader, "utf8");
const versionParts = ["MAJOR", "MINOR", "PATCH"].map((part) => {
  const match = header.match(new RegExp(`^#define NODE_${part}_VERSION (\\d+)$`, "mu"));
  if (match === null) {
    throw new Error("Local Node headers have no usable version declaration.");
  }
  return match[1];
});
if (versionParts.join(".") !== process.versions.node) {
  throw new Error("Local Node headers do not exactly match the active Node runtime.");
}

const require = createRequire(import.meta.url);
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
const vitest = join(repositoryDirectory, "node_modules", ".bin", "vitest");

await rm(join(nativeDirectory, "build"), { force: true, recursive: true });

function runOrThrow(arguments_, options) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: "inherit",
    ...options
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("Atomic publish verification command failed.");
  }
}

runOrThrow([
  nodeGyp,
  "rebuild",
  `--nodedir=${nodePrefix}`,
  "--directory",
  nativeDirectory
], {
  env: {
    ...process.env,
    npm_config_offline: "true",
    SWITCHBOARD_ATOMIC_PUBLISH_OFFLINE: "1"
  }
});
const testResult = spawnSync(
  vitest,
  [
    "run",
    "packages/runtime/src/acquisition/atomic-publish.test.ts",
    "packages/runtime/src/acquisition/unsigned-sidecar-assembler.test.ts",
    "packages/runtime/src/acquisition/archive-safety.test.ts",
    "--pool=forks",
    "--maxWorkers=1"
  ],
  {
    cwd: repositoryDirectory,
    env: {
      ...process.env,
      CI: "true",
      SWITCHBOARD_ATOMIC_PUBLISH_TEST: "1"
    },
    stdio: "inherit"
  }
);
if (testResult.error !== undefined) {
  throw testResult.error;
}
if (testResult.status !== 0) {
  throw new Error("Atomic publish verification command failed.");
}
