import { type NativeCapabilityQaStart } from "@cadrane/contracts/native-capability-qa";
import { NativeCapabilityQaUtilityProtocol } from "./native-capability-qa-protocol.js";

export const NATIVE_CAPABILITY_QA_UTILITY_MARKER = "switchboard-native-capability-qa-utility-v1" as const;
const NODE_SQLITE_SPECIFIER = "node:sqlite" as const;
const QA_TOKEN = "switchboardqatoken" as const;

type UtilityHostProcess = NodeJS.Process & { parentPort?: { on(event: "message", listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void } };
const parentPort = (process as UtilityHostProcess).parentPort;
if (parentPort === undefined) throw new Error("Native capability QA requires an Electron utility process.");
if ((process as UtilityHostProcess & { type?: string }).type !== "utility") throw new Error("Native capability QA requires the utility process type.");

const protocol = new NativeCapabilityQaUtilityProtocol();
let running = false;
parentPort.on("message", (event) => {
  if (running) return failClosed();
  try {
    const action = protocol.receive(event.data);
    if (action.action === "shutdown") {
      parentPort.postMessage(action.complete);
      queueMicrotask(() => process.exit(0));
      return;
    }
    running = true;
    void runNativeChecks(action.start).then((sqliteVersion) => {
      running = false;
      parentPort.postMessage(protocol.completeRun(sqliteVersion));
    }, failClosed);
  } catch { failClosed(); }
});

async function runNativeChecks(_start: NativeCapabilityQaStart): Promise<string> {
  const sqlite = await import(NODE_SQLITE_SPECIFIER);
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    database.exec("BEGIN; CREATE TABLE qa_probe (token TEXT NOT NULL); CREATE VIRTUAL TABLE qa_probe_fts USING fts5(token); INSERT INTO qa_probe (token) VALUES ('switchboardqatoken'); INSERT INTO qa_probe_fts (token) VALUES ('switchboardqatoken'); COMMIT;");
    const row = database.prepare("SELECT token FROM qa_probe_fts WHERE qa_probe_fts MATCH 'switchboardqatoken'").get() as { token?: unknown } | undefined;
    if (row?.token !== QA_TOKEN) throw new Error("Native capability QA query failed.");
    const version = database.prepare("SELECT sqlite_version() AS version").get() as { version?: unknown } | undefined;
    if (typeof version?.version !== "string" || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(version.version)) throw new Error("Native capability QA version failed.");
    return version.version;
  } finally { database.close(); }
}

function failClosed(): void { process.exit(1); }
