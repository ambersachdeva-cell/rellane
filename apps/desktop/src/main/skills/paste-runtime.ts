/**
 * Paste As, wired to the machine.
 *
 * The pure reshaping lives in `paste-as.ts`; this is the part that touches the
 * clipboard and asks macOS what is in front. Kept separate so the interesting
 * logic stays testable without an Electron runtime or a frontmost window.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard, globalShortcut } from "electron";
import { pasteAs, targetFor, type PasteResult } from "./paste-as.js";

const run = promisify(execFile);

/** Long enough to be reliable, short enough that a hotkey never feels stuck. */
const FRONTMOST_TIMEOUT_MS = 1_500;

/**
 * The bundle id of the application in front.
 *
 * `lsappinfo` is used rather than AppleScript because it needs no Automation
 * permission — a hotkey that silently does nothing until someone finds the
 * right box in System Settings is worse than one that works everywhere.
 * Returns null rather than guessing when it cannot tell.
 */
export async function frontmostBundleId(): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["front"], {
      timeout: FRONTMOST_TIMEOUT_MS
    });
    const asn = stdout.trim();
    if (asn.length === 0) {
      return null;
    }
    const info = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn], {
      timeout: FRONTMOST_TIMEOUT_MS
    });
    // Output looks like: "CFBundleIdentifier"="com.apple.Notes"
    const match = /"CFBundleIdentifier"\s*=\s*"([^"]+)"/u.exec(info.stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PasteRuntimeOptions {
  readonly accelerator: string;
  /** Tells the user what happened. Never silent — see below. */
  notify(result: PasteResult): void;
  /** Injectable for tests. */
  readonly readClipboard?: () => string;
  readonly writeClipboard?: (text: string) => void;
  readonly frontmost?: () => Promise<string | null>;
}

export interface PasteRuntime {
  /** Runs one reshape. Exposed so it can be triggered from the UI too. */
  reshape(): Promise<PasteResult>;
  dispose(): void;
}

/**
 * Binds the hotkey and reshapes on press.
 *
 * The clipboard is only overwritten when something actually changed. Replacing
 * it with an identical value would still clobber whatever the user had copied
 * as an image or a file reference alongside the text, for no benefit.
 */
export function createPasteRuntime(options: PasteRuntimeOptions): PasteRuntime {
  const read = options.readClipboard ?? (() => clipboard.readText());
  const write = options.writeClipboard ?? ((text: string) => clipboard.writeText(text));
  const frontmost = options.frontmost ?? frontmostBundleId;

  const reshape = async (): Promise<PasteResult> => {
    const text = read();
    const target = targetFor(await frontmost());
    const result = pasteAs(text, target);
    if (!result.unchanged) {
      write(result.text);
    }
    options.notify(result);
    return result;
  };

  const bound = globalShortcut.register(options.accelerator, () => {
    void reshape();
  });
  if (!bound) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cadrane] ${options.accelerator} is already taken; Paste As can still be run from the app.`
    );
  }

  return {
    reshape,
    dispose() {
      globalShortcut.unregister(options.accelerator);
    }
  };
}
