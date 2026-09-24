import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const PLUTIL = "/usr/bin/plutil";
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

const REMOVED_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSAppTransportSecurity:NSAllowsArbitraryLoads"
];

const REQUIRED_KEYS = [
  "NSAppTransportSecurity:NSAllowsLocalNetworking",
  "NSAppTransportSecurity:NSExceptionDomains:localhost",
  "NSAppTransportSecurity:NSExceptionDomains:127.0.0.1"
];

/**
 * electron-builder calls this after it has written its platform defaults, but
 * before fuses and signing. This hook deliberately only edits a macOS bundle.
 */
export async function afterPack(context) {
  if (context?.electronPlatformName !== "darwin") {
    return;
  }

  const infoPlist = await resolveInfoPlist(context);
  await validatePlist(infoPlist);
  await assertRequiredKeys(infoPlist);

  for (const key of REMOVED_KEYS) {
    if (await hasKey(infoPlist, key)) {
      await runPlistBuddy(infoPlist, `Delete :${key}`);
    }
  }

  await validatePlist(infoPlist);
  await assertRequiredKeys(infoPlist);
  for (const key of REMOVED_KEYS) {
    if (await hasKey(infoPlist, key)) {
      throw new Error(`macOS package hardening left forbidden Info.plist key ${key}.`);
    }
  }
}

export default afterPack;

async function resolveInfoPlist(context) {
  const { appOutDir } = context;
  if (typeof appOutDir !== "string" || appOutDir.length === 0 || !path.isAbsolute(appOutDir)) {
    throw new Error("macOS package hardening requires an absolute appOutDir.");
  }
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (!isSafeProductFilename(productFilename)) {
    throw new Error("macOS package hardening requires a safe product filename from electron-builder.");
  }

  const outputDirectory = await assertDirectory(appOutDir, "appOutDir");
  const bundleName = `${productFilename}.app`;
  const bundle = path.join(appOutDir, bundleName);
  await assertDirectory(bundle, "application bundle");
  const contents = path.join(bundle, "Contents");
  await assertDirectory(contents, "Contents directory");
  const infoPlist = path.join(contents, "Info.plist");
  await assertRegularFile(infoPlist, "Info.plist");

  const [realOutputDirectory, realInfoPlist] = await Promise.all([
    realpath(outputDirectory),
    realpath(infoPlist)
  ]);
  const relativeInfoPlist = path.relative(realOutputDirectory, realInfoPlist);
  const expectedInfoPlist = path.join(bundleName, "Contents", "Info.plist");
  if (
    relativeInfoPlist === "" ||
    relativeInfoPlist.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeInfoPlist) ||
    relativeInfoPlist !== expectedInfoPlist
  ) {
    throw new Error("macOS package hardening found Info.plist outside the expected application bundle.");
  }
  return infoPlist;
}

function isSafeProductFilename(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".app") &&
    !value.includes("\u0000") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    path.basename(value) === value;
}

async function assertDirectory(candidate, description) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new Error(`macOS package hardening cannot read ${description}.`, { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`macOS package hardening requires ${description} to be a real directory.`);
  }
  return candidate;
}

async function assertRegularFile(candidate, description) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new Error(`macOS package hardening cannot read ${description}.`, { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`macOS package hardening requires ${description} to be a regular file.`);
  }
}

async function validatePlist(infoPlist) {
  await runCommand(PLUTIL, ["-lint", infoPlist], "validate Info.plist");
}

async function assertRequiredKeys(infoPlist) {
  const localNetworking = await printRequiredKey(
    infoPlist,
    "NSAppTransportSecurity:NSAllowsLocalNetworking"
  );
  if (localNetworking.trim().toLowerCase() !== "true") {
    throw new Error("macOS package hardening requires NSAllowsLocalNetworking to remain true.");
  }
  for (const key of REQUIRED_KEYS.slice(1)) {
    const value = await printRequiredKey(infoPlist, key);
    if (!/^\s*Dict\s*\{/i.test(value)) {
      throw new Error(`macOS package hardening requires Info.plist key ${key} to be a dictionary.`);
    }
  }
}

async function printRequiredKey(infoPlist, key) {
  try {
    return await runPlistBuddy(infoPlist, `Print :${key}`);
  } catch (error) {
    throw new Error(`macOS package hardening requires Info.plist key ${key}.`, { cause: error });
  }
}

async function hasKey(infoPlist, key) {
  try {
    await runPlistBuddy(infoPlist, `Print :${key}`);
    return true;
  } catch (error) {
    if (isMissingKeyError(error)) {
      return false;
    }
    throw new Error(`macOS package hardening could not inspect Info.plist key ${key}.`, { cause: error });
  }
}

async function runPlistBuddy(infoPlist, command) {
  return runCommand(PLIST_BUDDY, ["-c", command, infoPlist], `run PlistBuddy command ${command}`);
}

async function runCommand(command, args, operation) {
  try {
    const { stdout } = await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    throw new Error(`macOS package hardening failed to ${operation}.`, { cause: error });
  }
}

function isMissingKeyError(error) {
  const cause = error instanceof Error && "cause" in error ? error.cause : error;
  const output = commandErrorOutput(cause);
  return /Print:\s*Entry,\s*".+",\s*Does Not Exist/i.test(output);
}

function commandErrorOutput(error) {
  if (error instanceof Error) {
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    return `${error.message}\n${stderr}\n${stdout}`;
  }
  return String(error);
}
