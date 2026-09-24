import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage, utilityProcess } from "electron";
import {
  NativeCapabilityQaC3aBuildBindingSchema,
  NATIVE_CAPABILITY_QA_PROTOCOL_VERSION,
  NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256,
  NativeCapabilityQaRunReceiptSchema,
} from "@cadrane/contracts/native-capability-qa";
import { NativeCapabilityQaMainController } from "./native-capability-qa-main-controller.js";
import { serializeNativeCapabilityQaDiagnosticReceipt } from "./native-capability-qa-receipt.js";

export const NATIVE_CAPABILITY_QA_MAIN_MARKER = "switchboard-native-capability-qa-main-v1" as const;
export const QA_SAFE_STORAGE_ROUNDTRIP_ENABLED = false as const;
export const QA_DURABLE_SPACES_ENABLED = false as const;

const QA_TIMEOUT_MS = 8_000;

void app.whenReady().then(startOneShotQa, failClosed);

async function startOneShotQa(): Promise<void> {
  const binding = NativeCapabilityQaC3aBuildBindingSchema.parse(JSON.parse(await readFile(path.join(process.resourcesPath, "c3a-build-binding.json"), "utf8")));
  if (app.isPackaged !== true || process.platform !== "darwin" || process.arch !== "arm64" || (process as NodeJS.Process & { type?: string }).type !== "browser") return failClosed();
  const runId = randomUUID();
  const availability = safeStorage.isEncryptionAvailable() === true ? "available" : "unavailable";
  const child = utilityProcess.fork(path.join(__dirname, "../utility/native-capability-qa-utility.cjs"), [], {
    cwd: process.resourcesPath,
    env: {},
    execArgv: [],
    stdio: "ignore",
    serviceName: "switchboard-storage-capability-qa-v1",
    allowLoadingUnsignedLibraries: false,
    respondToAuthRequestsFromMainProcess: false
  });
  const controller = new NativeCapabilityQaMainController(runId);
  let timer: NodeJS.Timeout | undefined;
  const failRun = () => {
    if (timer !== undefined) clearTimeout(timer);
    child.removeAllListeners();
    child.kill();
    app.exit(1);
  };
  timer = setTimeout(() => { try { controller.timeout(); } catch { failRun(); } }, QA_TIMEOUT_MS);
  child.on("message", (value: unknown) => {
    try {
      if (controller.receive(value) === "send-shutdown") child.postMessage({ protocolVersion: NATIVE_CAPABILITY_QA_PROTOCOL_VERSION, type: "qa.shutdown", runId });
    } catch { failRun(); }
  });
  child.on("exit", (code: number) => {
    try {
      const result = controller.observeExit(code);
      const receipt = NativeCapabilityQaRunReceiptSchema.parse({
        schemaVersion: 1, kind: "native-capability-qa-diagnostic-run", acceptance: "not-accepted", protocolVersion: NATIVE_CAPABILITY_QA_PROTOCOL_VERSION, runId,
        c3aBinding: binding,
        observations: {
          app: { packaged: app.isPackaged, process: "main", platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node },
          safeStorage: { availability, roundtrip: "disabled" },
          utility: { launched: "passed", nodeSqliteModuleLoad: result.nodeSqliteModuleLoad, inMemoryDatabase: result.inMemoryDatabase, schemaTransaction: result.schemaTransaction, fts5: result.fts5, databaseClose: result.databaseClose, sqliteVersion: result.sqliteVersion, cleanExit: "passed", provenance: result.provenance }
        },
        prohibitions: { safeStorageRoundtrip: "disabled", durableSpacesEnabled: false, keychainMutation: "unobserved", crossLaunchDecrypt: "unobserved", crashRecovery: "unobserved", durableRecovery: "unobserved" }
      });
      const line = serializeNativeCapabilityQaDiagnosticReceipt(receipt);
      clearTimeout(timer);
      child.removeAllListeners();
      process.stdout.write(line, () => app.exit(0));
    } catch { failRun(); }
  });
  child.postMessage({ protocolVersion: NATIVE_CAPABILITY_QA_PROTOCOL_VERSION, type: "qa.start", runId, staticReceiptSha256: NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 });
}

function failClosed(): void { app.exit(1); }
