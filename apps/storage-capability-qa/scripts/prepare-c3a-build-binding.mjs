import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_CAPABILITY_QA_C3A_BINDING,
  NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256,
  NativeCapabilityQaC3aBuildBindingSchema
} from "@cadrane/contracts/native-capability-qa";
import { StorageCapabilityPackageStaticEvidenceSchema } from "@cadrane/contracts/storage-capability";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "resources/c3a-static-evidence.json"));
if (createHash("sha256").update(source).digest("hex") !== NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256) {
  throw new Error("C3a static receipt hash is not accepted.");
}
const receipt = StorageCapabilityPackageStaticEvidenceSchema.parse(JSON.parse(source.toString("utf8")));
const binding = NativeCapabilityQaC3aBuildBindingSchema.parse(NATIVE_CAPABILITY_QA_C3A_BINDING);
if (receipt.package.asarSha256 !== binding.package.asarSha256 || receipt.entries.mainProbe.sha256 !== binding.entries.mainProbe.sha256 || receipt.entries.utilityProbe.sha256 !== binding.entries.utilityProbe.sha256 || receipt.entries.durableSpacesGate.sha256 !== binding.entries.durableSpacesGate.sha256) {
  throw new Error("C3a static receipt binding is invalid.");
}
const directory = path.join(root, "dist/resources");
await mkdir(directory, { recursive: true, mode: 0o700 });
const target = path.join(directory, "c3a-build-binding.json");
const serialized = `${JSON.stringify(binding)}\n`;
try {
  const existing = await readFile(target, "utf8");
  if (existing !== serialized) throw new Error("C3a build binding already exists with different content.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  const handle = await open(target, "wx", 0o600);
  try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
