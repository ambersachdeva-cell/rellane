/**
 * Holds the running state a skill needs: granted folders, previewed plans, and
 * the snapshots that make undo possible.
 *
 * Kept in the main process and never handed to the renderer. The renderer gets
 * ids and sentences; it never receives a filesystem path it could replay, and
 * it cannot ask for a plan it did not preview.
 */

import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LostGrant, SkillPreview, SkillRunResult, SkillUndoResult } from "@cadrane/contracts";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import { execute, releaseUndo, undo, type ExecutionResult } from "../tools/executor.js";
import { LIST_FOLDER } from "../tools/registry.js";
import { canUndo, summarise, UNDO_WINDOW_MS, type Plan } from "../tools/receipt.js";
import { probeUndo, type Snapshot } from "../tools/preimage.js";
import { diagnostics } from "../foundations/diagnostics.js";
import { describeIntegrity, type Ledger } from "../security/ledger.js";
import type { SkillPolicy } from "../tools/types.js";
import { describeSurvey, planFrom, survey, type FileEntry } from "./librarian.js";

/** Plans expire so a stale approval cannot run against a folder that moved on. */
const PLAN_TTL_MS = 5 * 60_000;

/**
 * Raised when a folder cannot actually be read.
 *
 * `createSandbox` checks the *shape* of a path — absolute, and not a credential
 * store — and never touches the disk, so a root whose permission macOS has
 * withdrawn passes it happily and fails much later inside a run, as an EPERM
 * with no explanation attached.
 *
 * The message is the useful part. It says which folder, why, and what to do,
 * because the reader's next question after "it stopped working" is always "is
 * this my fault".
 */
export class GrantUnavailable extends Error {
  constructor(
    readonly folder: string,
    readonly code: string | undefined
  ) {
    super(explainGrantFailure(folder, code));
    this.name = "GrantUnavailable";
  }
}

function explainGrantFailure(folder: string, code: string | undefined): string {
  const name = basename(folder);
  if (code === "ENOENT") {
    return `${name} is no longer where it was. Grant it again from its new location.`;
  }
  if (code === "EPERM" || code === "EACCES") {
    // The ordinary cause first: this is almost always the update, not a fault.
    return `macOS is no longer letting Rellane read ${name}. This usually happens after an update rather than because anything is wrong — grant the folder again and it will pick up where it left off.`;
  }
  if (code === "ENOTDIR") {
    return `${name} is a file, not a folder.`;
  }
  return `${name} could not be opened.`;
}

/**
 * Confirms a folder can be read, by opening it rather than by asking whether it
 * could be opened. `access()` answers from the permission bits and is regularly
 * wrong under TCC, which refuses the read itself.
 */
async function requireReadable(folder: string): Promise<void> {
  let handle;
  try {
    handle = await opendir(folder);
  } catch (caught) {
    throw new GrantUnavailable(folder, (caught as NodeJS.ErrnoException).code);
  }
  await handle.close();
}

interface HeldPlan {
  readonly plan: Plan;
  readonly root: string;
  readonly policy: SkillPolicy;
  readonly createdAt: number;
}

interface HeldReceipt {
  readonly snapshots: readonly Snapshot[];
  readonly undoableUntil: string | null;
}

export class SkillHost {
  private roots: string[] = [];
  private sandbox: Sandbox | null = null;
  private readonly plans = new Map<string, HeldPlan>();
  private readonly receipts = new Map<string, HeldReceipt>();
  /** Folders granted in a past session that cannot be read now: path -> why. */
  private readonly lost = new Map<string, string>();
  private ledger: Ledger | null = null;

  /**
   * Attached at startup, once the app knows its own data directory.
   *
   * Optional only because tests drive the host without a Keychain; the shipped
   * app always attaches one. A run that changed someone's files and left no
   * durable record is exactly the gap the ledger closes.
   */
  useLedger(ledger: Ledger): void {
    this.ledger = ledger;
  }

  grantedRoots(): readonly string[] {
    return [...this.roots];
  }

  /** Canonical roots captured by the host when access was granted. Consumers
   * must recheck this snapshot before reading; they cannot grant a new path. */
  grantedSandbox(): Sandbox | null {
    return this.sandbox;
  }

  async grant(folder: string): Promise<readonly string[]> {
    await requireReadable(folder);
    const candidate = this.roots.includes(folder) ? [...this.roots] : [...this.roots, folder];
    // Rebuilt rather than appended: createSandbox is what rejects credential
    // stores, and it must see the whole set every time.
    //
    // Assigned only once both steps have succeeded, so a folder the sandbox
    // rejects does not stay in the list and poison every later grant.
    const sandbox = await createSandbox(candidate);
    this.roots = candidate;
    // Adding another grant must not silently retarget an older granted link.
    const previous = this.sandbox;
    this.sandbox = { spelledRoots: sandbox.spelledRoots, roots: Object.freeze(sandbox.roots.map((root, i) => {
      const at = previous?.spelledRoots.indexOf(sandbox.spelledRoots[i]!) ?? -1;
      return at < 0 ? root : previous!.roots[at]!;
    })) };
    this.lost.delete(folder);
    return this.grantedRoots();
  }

  /**
   * Remembers a folder that was granted once and cannot be reached now.
   *
   * Restoring grants at startup used to swallow its failures, so a folder the
   * OS had withdrawn simply vanished from the rail. With Rellane shipping
   * ad-hoc signed, macOS treats every update as a different app and revokes its
   * folder permissions, which makes a failed restore the *normal* case after an
   * update rather than an edge one. Losing it quietly is the silent degradation
   * the design principles exist to forbid.
   */
  recordLostGrant(folder: string, reason: string): void {
    if (!this.roots.includes(folder)) {
      this.lost.set(folder, reason);
    }
  }

  lostGrants(): readonly LostGrant[] {
    return [...this.lost].map(([path, reason]) => ({ path, reason }));
  }

  async revoke(folder: string): Promise<readonly string[]> {
    this.roots = this.roots.filter((root) => root !== folder);
    // Revoke synchronously, including for an in-flight read. Remaining grants
    // retain their canonical targets instead of following changed links again.
    const previous = this.sandbox;
    const retained = previous?.spelledRoots.map((root, i) => ({ root, real: previous.roots[i]! }))
      .filter(entry => this.roots.some(root => resolve(root) === entry.root)) ?? [];
    this.sandbox = retained.length === 0 ? null : {
      spelledRoots: Object.freeze(retained.map(entry => entry.root)),
      roots: Object.freeze(retained.map(entry => entry.real))
    };
    return this.grantedRoots();
  }

  /** Works out what would happen. Reads only; changes nothing. */
  async preview(skill: string, path: string, now = Date.now()): Promise<SkillPreview> {
    const sandbox = this.requireSandbox();
    if (skill !== "librarian") {
      throw new Error(`There is no skill called ${skill}.`);
    }

    const listing = (await LIST_FOLDER.handler({ path }, { sandbox })) as {
      folder: string;
      files: FileEntry[];
    };
    const decided = survey(listing.folder, listing.files, { now });
    const plan = planFrom(decided, listing.folder, now);

    diagnostics.info("skills", `previewed ${skill}`, {
      folder: listing.folder,
      willMove: plan.steps.length,
      leftAlone: decided.untouched.length
    });
    this.sweepExpired(now);
    this.plans.set(plan.id, {
      plan,
      root: listing.folder,
      policy: { byRisk: { read: "auto", write: "confirm" } },
      createdAt: now
    });

    return {
      planId: plan.id,
      headline: describeSurvey(decided),
      steps: plan.steps.map((step) => ({ summary: step.summary, reason: step.reason })),
      untouched: decided.untouched.map((item) => ({
        name: item.file.name,
        reason: item.reason
      })),
      // Derived, so the sheet cannot promise a window that has since changed.
      undoWindowMinutes: Math.round(UNDO_WINDOW_MS / 60_000),
      // Probed against this folder's own volume rather than assumed from the
      // product's design. The sheet is where consent is given, so it is the one
      // place that must not describe an undo the executor would then refuse.
      undo: await probeUndo(listing.folder)
    };
  }

  /**
   * Runs a previously previewed plan.
   *
   * `approve` is supplied by the caller because approval is a decision the user
   * makes, not a value this class can invent. Passing `() => true` here is what
   * it means to have already shown the plan and had it accepted.
   */
  async run(
    planId: string,
    approve: (summary: string) => Promise<boolean>,
    now = Date.now()
  ): Promise<SkillRunResult> {
    const sandbox = this.requireSandbox();
    // Swept here, not only in `preview`.
    //
    // The expiry was enforced by a sweep that ran when somebody looked at a
    // folder — so a plan nobody looked at again never expired. An approval from
    // Tuesday could execute on Friday against a folder that had moved on
    // entirely, which is precisely what the five-minute window exists to
    // prevent. The guarantee was written down and not enforced.
    this.sweepExpired(now);
    const held = this.plans.get(planId);
    if (held === undefined) {
      throw new Error("That plan has expired. Look at the folder again before running it.");
    }
    // Claim before the first wait: a second Run must not use this same plan
    // while its history preflight is pending. A refusal needs a fresh preview.
    this.plans.delete(planId);
    await requireActionHistory(this.ledger);
    if (this.sandbox !== sandbox) throw new Error("Folder access changed. No plan actions were run; review the folder again.");

    const result: ExecutionResult = await execute({
      plan: held.plan,
      policy: held.policy,
      context: { sandbox },
      protect: [held.root],
      approve: (step) => approve(step.summary)
    });

    const { receipt, snapshots } = result;
    diagnostics.info("skills", `ran ${held.plan.skill}`, {
      outcome: summarise(receipt),
      undoable: receipt.undoableUntil !== null,
      snapshots: snapshots.map((snapshot) => snapshot.method)
    });
    for (const step of receipt.steps) {
      if (step.outcome === "failed") {
        diagnostics.error("skills", `step failed: ${step.summary}`, { error: step.error });
      }
    }
    this.receipts.set(receipt.id, {
      snapshots,
      undoableUntil: receipt.undoableUntil
    });

    // Recorded after the fact, with real counts rather than the plan's
    // intentions — the ledger's value is that it says what happened, not what
    // was going to happen. A failure to record must not fail the run: the work
    // is already done, and throwing here would report success as an error.
    let historyWarning: string | undefined;
    await this.ledger
      ?.append({
        kind: "skill.run",
        detail: {
          skill: held.plan.skill,
          folder: held.root,
          // The undo record already carries a receipt id. Without the same id
          // here the record can say a reversal happened but not what it
          // reversed, which is half a timeline.
          receiptId: receipt.id,
          outcome: summarise(receipt),
          done: receipt.steps.filter((step) => step.outcome === "done").length,
          refused: receipt.steps.filter((step) => step.outcome === "refused").length,
          failed: receipt.steps.filter((step) => step.outcome === "failed").length
        }
      })
      .catch((error: unknown) => {
        historyWarning = "The action finished, but its history receipt could not be saved. Review this session result; do not repeat the action to repair the record.";
        diagnostics.warn("skills", "the run happened but was not recorded", {
          error: error instanceof Error ? error.message : String(error)
        });
      });

    // Release the pre-images when the window closes, so snapshots do not
    // accumulate for a session that never undoes anything.
    if (receipt.undoableUntil !== null) {
      const closesIn = Math.max(Date.parse(receipt.undoableUntil) - now, 0);
      setTimeout(() => {
        void this.expireReceipt(receipt.id);
      }, closesIn).unref?.();
    }

    return {
      receiptId: receipt.id,
      headline: summarise(receipt),
      steps: receipt.steps.map((step) => ({
        summary: step.summary,
        outcome: step.outcome,
        durationMs: step.durationMs,
        ...(step.error === undefined ? {} : { error: step.error })
      })),
      canUndo: canUndo(receipt, now),
      undoableUntil: receipt.undoableUntil,
      finishedAt: receipt.finishedAt,
      where: basename(held.root),
      ...(historyWarning === undefined ? {} : { historyWarning })
    };
  }

  /**
   * The receipts that can still be reversed right now.
   *
   * The timeline shows runs from every session the ledger remembers, but a
   * snapshot is only held while its window is open. The record therefore has to
   * say which rows can actually be put back, because offering an undo the app
   * cannot perform is the one thing the design principles forbid outright.
   */
  restorable(now = Date.now()): ReadonlySet<string> {
    const open = new Set<string>();
    for (const [id, held] of this.receipts) {
      if (held.undoableUntil !== null && now <= Date.parse(held.undoableUntil)) {
        open.add(id);
      }
    }
    return open;
  }

  async undoRun(receiptId: string, now = Date.now()): Promise<SkillUndoResult> {
    const held = this.receipts.get(receiptId);
    if (held === undefined) {
      return { undone: false };
    }
    if (held.undoableUntil === null || now > Date.parse(held.undoableUntil)) {
      return { undone: false };
    }
    await undo(held.snapshots);
    await this.expireReceipt(receiptId);
    // An undo is itself an event worth recording. A ledger that shows the run
    // but not the reversal describes a change that is no longer there.
    // A broken log must not trap the owner after an already-applied action.
    // The held snapshot is this session's authority, not a row in damaged history.
    let historyWarning: string | undefined;
    await this.ledger
      ?.append({ kind: "skill.undo", detail: { receipt: receiptId } })
      .catch(() => {
        historyWarning = "The files were restored, but the restoration receipt could not be saved to history. Do not repeat the restore to repair the record.";
      });
    return { undone: true, ...(historyWarning === undefined ? {} : { historyWarning }) };
  }

  /** Releases every held snapshot. Called on quit. */
  async dispose(): Promise<void> {
    for (const id of [...this.receipts.keys()]) {
      await this.expireReceipt(id);
    }
    this.plans.clear();
  }

  private async expireReceipt(receiptId: string): Promise<void> {
    const held = this.receipts.get(receiptId);
    if (held === undefined) {
      return;
    }
    this.receipts.delete(receiptId);
    await releaseUndo(held.snapshots);
  }

  private sweepExpired(now: number): void {
    for (const [id, held] of this.plans) {
      if (now - held.createdAt > PLAN_TTL_MS) {
        this.plans.delete(id);
      }
    }
  }

  private requireSandbox(): Sandbox {
    if (this.sandbox === null) {
      throw new Error(
        "No folder has been granted yet. Choose one before running a skill that touches files."
      );
    }
    return this.sandbox;
  }
}

/** Refuse known history damage before a new plan can change files. This is an
 * integrity preflight, not a guarantee that a later disk write will succeed. */
async function requireActionHistory(ledger: Ledger | null): Promise<void> {
  if (ledger === null) return; // Existing isolated hosts do not attach a store.
  const integrity = await ledger.verify();
  if (integrity.status !== "intact") {
    throw new Error(`No plan actions were run because action history cannot be verified. ${describeIntegrity(integrity)}`);
  }
}

/** Label for a granted root, for the settings list. */
export function rootLabel(root: string): string {
  return basename(root) || root;
}

export function newCorrelationId(): string {
  return randomUUID();
}
