/** Signing changes Mach-O bytes. Verify the sealed release and its signer; retain
 * the upstream byte pin for development. Never accept a hash mismatch alone. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execute = promisify(execFile);
const REQUIREMENT = '=identifier "com.cadrane.local-work-studio" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: amber.26.2003@gmail.com (4YLJH6747Y)" and certificate 1[field.1.2.840.113635.100.6.2.1]';
export async function assertRuntimeIntegrity(input: {
  readonly serverPath: string;
  readonly appBundlePath: string | null;
  readonly digest: () => Promise<string>;
  readonly expectedDigest: string;
}, verify: (bundle: string, requirement: string) => Promise<void> = verifyBundle): Promise<void> {
  if (input.appBundlePath !== null) {
    const expected = path.join(input.appBundlePath, "Contents", "Resources", "llama-b10182", "llama-server");
    if (!input.appBundlePath.endsWith(".app") || path.resolve(input.serverPath) !== path.resolve(expected)) throw new Error("The local runtime is outside the signed app bundle.");
    await verify(input.appBundlePath, REQUIREMENT);
    return;
  }
  if (await input.digest() !== input.expectedDigest) throw new Error("The bundled local runtime failed its build pin.");
}
async function verifyBundle(bundle: string, requirement: string): Promise<void> {
  try {
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, bundle], { timeout: 5_000, maxBuffer: 32_768, env: { PATH: "/usr/bin:/bin" } });
  } catch {
    throw new Error("The installed app's signature or signing identity could not be verified. Reinstall a verified build before using the local model.");
  }
}
