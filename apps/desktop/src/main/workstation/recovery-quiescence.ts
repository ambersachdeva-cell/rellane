/**
 * Shared-Host recovery quiescence coordinator primitive.
 *
 * UNREGISTERED PREREQUISITE:
 * This coordinator is a local, in-memory concurrency primitive for a future
 * whole-root recovery export path. It MUST NOT claim actual product-wide
 * quiescence because Host writers, SQLite Book WAL checkpoints, and
 * background task boundaries are not yet fully wired.
 *
 * GUARANTEES PROVIDED:
 * 1. Synchronous admission: writer permits must be acquired synchronously before
 *    any asynchronous I/O or background effect begins.
 * 2. Active-refusal: an export freeze request is immediately refused if any
 *    registered write is currently in flight. Active work is never stopped or killed.
 * 3. Write blocking during freeze: new writer admissions are rejected while a
 *    freeze lease is held.
 * 4. Reliable unblocking: releasing the freeze lease unblocks subsequent admissions.
 * 5. Incomplete coverage refusal: starts untrusted/incomplete by default; freeze
 *    is refused unless every required Host writer is explicitly registered.
 * 6. Truthful false readiness: read-only preflight clearly distinguishes
 *    `eligibleForFreeze` from `productWideQuiescenceAttested` (always false).
 *    No true export-ready flag is ever produced by this primitive.
 * 7. Process-local lease: leases exist strictly in local process memory and do
 *    not survive restart or prove filesystem/WAL coherence.
 * 8. Bounded memory: no global mutable singleton, active records are discarded
 *    upon release, and memory scales strictly with concurrent in-flight operations.
 */

/**
 * Canonical set of app-owned Host writer domains that must be wired and registered
 * before whole-root quiescence can be safely considered.
 */
export const REQUIRED_HOST_WRITERS = [
  "book",
  "workstation-case",
  "workstation-brief",
  "workstation-agent",
  "restore-lease",
  "session-pool",
  "timeline",
  "preimages",
  "agents",
  "memory",
  "watches",
  "settings",
  "secrets",
  "automations"
] as const;

export type RequiredHostWriterId = typeof REQUIRED_HOST_WRITERS[number];

/**
 * Exact integration dependencies that must be satisfied before product-wide
 * quiescence or whole-root export can be safely authorized.
 */
export const RECOVERY_QUIESCENCE_INTEGRATION_DEPENDENCIES = [
  "Wire synchronous admission through this coordinator for every Host writer (WorkstationHost local briefs, cases, agents, restore leases, session pool, timeline, preimages, memory, watches, settings, secrets, automations).",
  "Obtain a trusted WAL-aware Book export receipt via SQLite online backup API or VACUUM INTO from an open trusted connection; raw file copies of Book and WAL/SHM cannot substitute.",
  "Establish owned-store key-portability and credential boundary policies for Keychain references, provider sessions, and machine-bound tokens.",
  "Obtain an independently attested immutable, quiescent source snapshot or descriptor-pinned directory reader before any recovery import planning.",
  "Implement staged no-overwrite recovery import with rollback and reopen verification."
] as const;

export type RecoveryQuiescenceErrorCode =
  | "UNKNOWN_WRITER"
  | "FREEZE_IN_PROGRESS"
  | "ACTIVE_WRITERS_IN_FLIGHT"
  | "INCOMPLETE_COVERAGE"
  | "ALREADY_FROZEN"
  | "INVALID_PERMIT"
  | "INVALID_LEASE";

export class RecoveryQuiescenceError extends Error {
  readonly code: RecoveryQuiescenceErrorCode;

  constructor(code: RecoveryQuiescenceErrorCode, message: string) {
    super(message);
    this.name = "RecoveryQuiescenceError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface WriterPermit {
  readonly permitId: string;
  readonly writerId: string;
  readonly acquiredAt: number;
  readonly released: boolean;
  release(): boolean;
}

export interface FreezeLease {
  readonly leaseId: string;
  readonly acquiredAt: number;
  readonly reason: string;
  readonly coveredWriters: readonly string[];
  readonly released: boolean;
  release(): boolean;
}

export type AcquireWriterPermitResult =
  | { readonly granted: true; readonly permit: WriterPermit }
  | { readonly granted: false; readonly code: RecoveryQuiescenceErrorCode; readonly reason: string };

export type AcquireFreezeResult =
  | { readonly acquired: true; readonly lease: FreezeLease }
  | { readonly acquired: false; readonly code: RecoveryQuiescenceErrorCode; readonly reason: string };

export interface RecoveryQuiescencePreflight {
  /**
   * Whether the Host coordinator is currently eligible to enter a freeze.
   * True ONLY if:
   * 1. Coverage is complete (all required writers registered and coverage trusted).
   * 2. No writes are currently in flight (activeWriteCount === 0).
   * 3. No freeze lease is currently active (!isFrozen).
   */
  readonly eligibleForFreeze: boolean;

  /**
   * False until future product wiring and immutable Book snapshot proof.
   * This primitive coordinates Host-side writer admission leases only.
   * It cannot and does not attest that the entire product, WAL, or unmanaged
   * stores are quiescent or safe for whole-root export.
   */
  readonly productWideQuiescenceAttested: false;

  /**
   * Always false. No true export-ready flag may be produced by this primitive.
   */
  readonly readyForExport: false;

  /**
   * Status of writer registration coverage completeness.
   */
  readonly coverageComplete: boolean;

  /**
   * Registered writers currently recognized by this coordinator.
   */
  readonly registeredWriters: readonly string[];

  /**
   * Required writers that are still missing registration.
   */
  readonly missingWriters: readonly string[];

  /**
   * Writers with active permits currently in flight.
   */
  readonly activeWriters: readonly string[];

  /**
   * Count of active write permits in flight.
   */
  readonly activeWriteCount: number;

  /**
   * Whether a recovery freeze lease is currently held.
   */
  readonly isFrozen: boolean;

  /**
   * Diagnostic issues explaining why freeze or product-wide quiescence is unavailable.
   */
  readonly issues: readonly string[];

  /**
   * Documented next integration dependencies before product-wide quiescence can be attained.
   */
  readonly nextDependencies: readonly string[];
}

export interface RecoveryQuiescenceCoordinatorOptions {
  /**
   * The explicit set of required writer IDs that must be registered before
   * any freeze eligibility is considered.
   * Defaults to REQUIRED_HOST_WRITERS.
   */
  readonly requiredWriters?: readonly string[];

  /**
   * Writers registered initially. If omitted, starts empty (untrusted/incomplete).
   */
  readonly initialRegisteredWriters?: readonly string[];

  /**
   * Explicit coverage declaration. If "untrusted", freeze is refused even if
   * all required writers are registered. Defaults to "untrusted".
   */
  readonly coverageDeclaration?: "trusted" | "untrusted";
}

interface ActivePermitInternal {
  readonly permitId: string;
  readonly writerId: string;
  readonly acquiredAt: number;
  released: boolean;
}

interface ActiveFreezeInternal {
  readonly leaseId: string;
  readonly acquiredAt: number;
  readonly reason: string;
  readonly coveredWriters: readonly string[];
  released: boolean;
}

export class RecoveryQuiescenceCoordinator {
  private readonly requiredWriters: ReadonlySet<string>;
  private readonly registeredWriters = new Set<string>();
  private readonly activePermits = new Map<string, ActivePermitInternal>();
  private readonly activeCountsByWriter = new Map<string, number>();
  private activeFreeze: ActiveFreezeInternal | null = null;
  private coverageDeclaration: "trusted" | "untrusted";
  private permitSequence = 0;
  private leaseSequence = 0;

  constructor(options: RecoveryQuiescenceCoordinatorOptions = {}) {
    const required = options.requiredWriters ?? REQUIRED_HOST_WRITERS;
    this.requiredWriters = new Set(required);
    if (options.initialRegisteredWriters) {
      for (const writer of options.initialRegisteredWriters) {
        if (typeof writer === "string" && writer.trim().length > 0) {
          this.registeredWriters.add(writer.trim());
        }
      }
    }
    this.coverageDeclaration = options.coverageDeclaration ?? "untrusted";
  }

  get isFrozen(): boolean {
    return this.activeFreeze !== null && !this.activeFreeze.released;
  }

  get activeWriteCount(): number {
    return this.activePermits.size;
  }

  activeWriterIds(): readonly string[] {
    return [...this.activeCountsByWriter.keys()].sort();
  }

  registeredWriterIds(): readonly string[] {
    return [...this.registeredWriters].sort();
  }

  missingWriterIds(): readonly string[] {
    return [...this.requiredWriters]
      .filter(required => !this.registeredWriters.has(required))
      .sort();
  }

  isWriterRegistered(writerId: string): boolean {
    return this.registeredWriters.has(writerId.trim());
  }

  registerWriter(writerId: string): void {
    const normalized = writerId?.trim();
    if (!normalized) {
      throw new RecoveryQuiescenceError("UNKNOWN_WRITER", "Writer ID must be a non-empty string.");
    }
    this.registeredWriters.add(normalized);
  }

  unregisterWriter(writerId: string): void {
    const normalized = writerId?.trim();
    if (!normalized || !this.registeredWriters.has(normalized)) {
      return;
    }
    if ((this.activeCountsByWriter.get(normalized) ?? 0) > 0) {
      throw new RecoveryQuiescenceError(
        "ACTIVE_WRITERS_IN_FLIGHT",
        `Cannot unregister writer "${normalized}" while it has active writes in flight.`
      );
    }
    this.registeredWriters.delete(normalized);
  }

  setCoverageDeclaration(declaration: "trusted" | "untrusted"): void {
    if (this.coverageDeclaration === declaration) {
      return;
    }
    if (this.isFrozen) {
      throw new RecoveryQuiescenceError(
        "FREEZE_IN_PROGRESS",
        `Cannot change coverage declaration: recovery freeze is currently active (lease ${this.activeFreeze?.leaseId}).`
      );
    }
    if (this.activePermits.size > 0) {
      const activeIds = this.activeWriterIds();
      throw new RecoveryQuiescenceError(
        "ACTIVE_WRITERS_IN_FLIGHT",
        `Cannot change coverage declaration: ${this.activePermits.size} registered write(s) are in flight across [${activeIds.join(", ")}].`
      );
    }
    this.coverageDeclaration = declaration;
  }

  /**
   * Synchronously request admission for a writer start.
   * Returns a result without throwing.
   */
  tryAcquireWriterPermit(writerId: string): AcquireWriterPermitResult {
    const normalized = writerId?.trim();
    if (!normalized || !this.registeredWriters.has(normalized)) {
      return {
        granted: false,
        code: "UNKNOWN_WRITER",
        reason: `Writer "${writerId}" is not registered in the recovery quiescence coordinator.`
      };
    }

    if (this.isFrozen) {
      return {
        granted: false,
        code: "FREEZE_IN_PROGRESS",
        reason: `Cannot admit writer "${normalized}": recovery export freeze is currently active (lease ${this.activeFreeze?.leaseId}).`
      };
    }

    this.permitSequence = (this.permitSequence + 1) % Number.MAX_SAFE_INTEGER;
    const permitId = `permit:${normalized}:${Date.now()}:${this.permitSequence}`;

    const internal: ActivePermitInternal = {
      permitId,
      writerId: normalized,
      acquiredAt: Date.now(),
      released: false
    };

    this.activePermits.set(permitId, internal);
    this.activeCountsByWriter.set(
      normalized,
      (this.activeCountsByWriter.get(normalized) ?? 0) + 1
    );

    const permit: WriterPermit = {
      permitId,
      writerId: normalized,
      get acquiredAt() {
        return internal.acquiredAt;
      },
      get released() {
        return internal.released;
      },
      release: () => this.releaseWriterPermit(permitId)
    };

    return { granted: true, permit };
  }

  /**
   * Synchronously admit a writer before any asynchronous effect begins.
   * Throws RecoveryQuiescenceError on refusal.
   */
  acquireWriterPermit(writerId: string): WriterPermit {
    const result = this.tryAcquireWriterPermit(writerId);
    if (!result.granted) {
      throw new RecoveryQuiescenceError(result.code, result.reason);
    }
    return result.permit;
  }

  /**
   * Safely release an active writer permit.
   * Duplicate releases, stale tokens, and unknown IDs return false idempotently
   * without corrupting active counters or throwing.
   */
  releaseWriterPermit(permitId: string): boolean {
    const internal = this.activePermits.get(permitId);
    if (!internal || internal.released) {
      return false;
    }

    internal.released = true;
    this.activePermits.delete(permitId);

    const currentCount = (this.activeCountsByWriter.get(internal.writerId) ?? 1) - 1;
    if (currentCount <= 0) {
      this.activeCountsByWriter.delete(internal.writerId);
    } else {
      this.activeCountsByWriter.set(internal.writerId, currentCount);
    }

    return true;
  }

  /**
   * Scoped synchronous admission helper.
   * Acquires the permit synchronously before executing action, and reliably
   * releases it in finally even if action throws or aborts.
   */
  async withWriterPermit<T>(
    writerId: string,
    action: (permit: WriterPermit) => Promise<T> | T
  ): Promise<T> {
    const permit = this.acquireWriterPermit(writerId);
    try {
      return await action(permit);
    } finally {
      permit.release();
    }
  }

  /**
   * Synchronously request an export freeze lease.
   * Returns a result without throwing.
   */
  tryAcquireFreeze(reason: string = "whole-root-recovery"): AcquireFreezeResult {
    const missing = this.missingWriterIds();
    if (missing.length > 0 || this.coverageDeclaration === "untrusted") {
      const reasonText = missing.length > 0
        ? `Cannot acquire freeze: required writer registration is incomplete. Missing: [${missing.join(", ")}].`
        : "Cannot acquire freeze: writer coverage declaration is marked untrusted.";
      return {
        acquired: false,
        code: "INCOMPLETE_COVERAGE",
        reason: reasonText
      };
    }

    if (this.isFrozen) {
      return {
        acquired: false,
        code: "ALREADY_FROZEN",
        reason: `Cannot acquire freeze: recovery freeze is already active (lease ${this.activeFreeze?.leaseId}).`
      };
    }

    if (this.activePermits.size > 0) {
      const activeIds = this.activeWriterIds();
      return {
        acquired: false,
        code: "ACTIVE_WRITERS_IN_FLIGHT",
        reason: `Cannot acquire freeze: ${this.activePermits.size} registered write(s) in flight across [${activeIds.join(", ")}]. Active work is never stopped or killed.`
      };
    }

    this.leaseSequence = (this.leaseSequence + 1) % Number.MAX_SAFE_INTEGER;
    const leaseId = `freeze-lease:${Date.now()}:${this.leaseSequence}`;

    const internal: ActiveFreezeInternal = {
      leaseId,
      acquiredAt: Date.now(),
      reason,
      coveredWriters: this.registeredWriterIds(),
      released: false
    };

    this.activeFreeze = internal;

    const lease: FreezeLease = {
      leaseId,
      get acquiredAt() {
        return internal.acquiredAt;
      },
      get reason() {
        return internal.reason;
      },
      get coveredWriters() {
        return internal.coveredWriters;
      },
      get released() {
        return internal.released;
      },
      release: () => this.releaseFreeze(leaseId)
    };

    return { acquired: true, lease };
  }

  /**
   * Synchronously acquire an export freeze lease.
   * Throws RecoveryQuiescenceError on refusal.
   */
  acquireFreeze(reason?: string): FreezeLease {
    const result = this.tryAcquireFreeze(reason);
    if (!result.acquired) {
      throw new RecoveryQuiescenceError(result.code, result.reason);
    }
    return result.lease;
  }

  /**
   * Safely release an active recovery freeze lease.
   * Duplicate releases, stale tokens, and unknown IDs return false idempotently
   * without throwing.
   */
  releaseFreeze(leaseId: string): boolean {
    if (this.activeFreeze === null || this.activeFreeze.leaseId !== leaseId || this.activeFreeze.released) {
      return false;
    }

    this.activeFreeze.released = true;
    this.activeFreeze = null;
    return true;
  }

  /**
   * Scoped freeze helper.
   * Acquires the freeze lease synchronously before executing action, and reliably
   * releases it in finally even if action throws or rejects.
   */
  async withFreeze<T>(
    action: (lease: FreezeLease) => Promise<T> | T,
    reason?: string
  ): Promise<T> {
    const lease = this.acquireFreeze(reason);
    try {
      return await action(lease);
    } finally {
      lease.release();
    }
  }

  /**
   * Read-only preflight check of coordinator status.
   * Truthfully distinguishes eligibleForFreeze from productWideQuiescenceAttested (always false).
   */
  preflightQuiescence(): RecoveryQuiescencePreflight {
    const registeredWriters = this.registeredWriterIds();
    const missingWriters = this.missingWriterIds();
    const activeWriters = this.activeWriterIds();
    const activeWriteCount = this.activePermits.size;
    const isFrozen = this.isFrozen;
    const coverageComplete = missingWriters.length === 0 && this.coverageDeclaration !== "untrusted";

    const issues: string[] = [];

    if (!coverageComplete) {
      if (missingWriters.length > 0) {
        issues.push(
          `Required writer registration coverage is incomplete (${missingWriters.length} missing: ${missingWriters.join(", ")}).`
        );
      }
      if (this.coverageDeclaration === "untrusted") {
        issues.push("Writer coverage declaration is explicitly marked untrusted.");
      }
    }

    if (activeWriteCount > 0) {
      issues.push(
        `Cannot freeze while ${activeWriteCount} registered write(s) are in flight (${activeWriters.join(", ")}). Active work will not be killed.`
      );
    }

    if (isFrozen) {
      issues.push(`Recovery freeze lease is currently active (${this.activeFreeze?.leaseId}).`);
    }

    issues.push(
      "Product-wide quiescence is unattested: Host writer wiring and WAL-aware Book snapshot proofs are not yet connected."
    );
    issues.push(
      "Local coordinator lease does not survive process restart or prove filesystem/WAL coherence."
    );

    const eligibleForFreeze = coverageComplete && activeWriteCount === 0 && !isFrozen;

    return {
      eligibleForFreeze,
      productWideQuiescenceAttested: false,
      readyForExport: false,
      coverageComplete,
      registeredWriters,
      missingWriters,
      activeWriters,
      activeWriteCount,
      isFrozen,
      issues,
      nextDependencies: RECOVERY_QUIESCENCE_INTEGRATION_DEPENDENCIES
    };
  }
}