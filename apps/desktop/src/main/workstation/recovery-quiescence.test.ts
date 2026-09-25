import { describe, it, expect } from "vitest";
import {
  RecoveryQuiescenceCoordinator,
  RecoveryQuiescenceError,
  REQUIRED_HOST_WRITERS,
  RECOVERY_QUIESCENCE_INTEGRATION_DEPENDENCIES
} from "./recovery-quiescence.js";

describe("RecoveryQuiescenceCoordinator", () => {
  it("active-refusal: refuses export freeze when any registered write is in flight without killing active work", async () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "workstation-case"],
      initialRegisteredWriters: ["book", "workstation-case"],
      coverageDeclaration: "trusted"
    });

    const permit = coordinator.acquireWriterPermit("book");
    expect(permit.writerId).toBe("book");
    expect(permit.released).toBe(false);
    expect(coordinator.activeWriteCount).toBe(1);
    expect(coordinator.activeWriterIds()).toEqual(["book"]);

    // Attempting freeze while write is in flight is refused
    expect(() => coordinator.acquireFreeze()).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.acquireFreeze();
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryQuiescenceError);
      expect((error as RecoveryQuiescenceError).code).toBe("ACTIVE_WRITERS_IN_FLIGHT");
    }

    const tryResult = coordinator.tryAcquireFreeze();
    expect(tryResult.acquired).toBe(false);
    if (!tryResult.acquired) {
      expect(tryResult.code).toBe("ACTIVE_WRITERS_IN_FLIGHT");
      expect(tryResult.reason).toContain("registered write(s) in flight");
    }

    // Active work was NOT stopped or killed; permit remains valid and active
    expect(permit.released).toBe(false);
    expect(coordinator.activeWriteCount).toBe(1);

    // Releasing the permit allows freeze to be acquired subsequently
    expect(permit.release()).toBe(true);
    expect(permit.released).toBe(true);
    expect(coordinator.activeWriteCount).toBe(0);

    const lease = coordinator.acquireFreeze();
    expect(lease.released).toBe(false);
    expect(coordinator.isFrozen).toBe(true);
    expect(lease.release()).toBe(true);
  });

  it("concurrent writer start/freeze linearization: admission is synchronous and deterministically ordered", () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "timeline"],
      initialRegisteredWriters: ["book", "timeline"],
      coverageDeclaration: "trusted"
    });

    // Sequence A: Writer admits first synchronously -> freeze is refused
    const permitA = coordinator.acquireWriterPermit("timeline");
    expect(coordinator.activeWriteCount).toBe(1);

    expect(() => coordinator.acquireFreeze()).toThrowError(/registered write\(s\) in flight/);

    permitA.release();
    expect(coordinator.activeWriteCount).toBe(0);

    // Sequence B: Freeze admits first synchronously -> writer is refused
    const leaseB = coordinator.acquireFreeze();
    expect(coordinator.isFrozen).toBe(true);

    expect(() => coordinator.acquireWriterPermit("book")).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.acquireWriterPermit("book");
    } catch (error) {
      expect((error as RecoveryQuiescenceError).code).toBe("FREEZE_IN_PROGRESS");
    }

    leaseB.release();
    expect(coordinator.isFrozen).toBe(false);

    // After freeze release, writer admits cleanly
    const permitB = coordinator.acquireWriterPermit("book");
    expect(permitB.released).toBe(false);
    permitB.release();
  });

  it("freeze blocks new admissions and second freeze attempts", async () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "workstation-case"],
      initialRegisteredWriters: ["book", "workstation-case"],
      coverageDeclaration: "trusted"
    });

    const lease = coordinator.acquireFreeze("pre-recovery-audit");
    expect(coordinator.isFrozen).toBe(true);
    expect(lease.reason).toBe("pre-recovery-audit");

    // All writer admissions are blocked during freeze
    const writerRes = coordinator.tryAcquireWriterPermit("book");
    expect(writerRes.granted).toBe(false);
    if (!writerRes.granted) {
      expect(writerRes.code).toBe("FREEZE_IN_PROGRESS");
    }

    // Scoped helper also blocks before executing callback
    let invoked = false;
    await expect(
      coordinator.withWriterPermit("workstation-case", () => {
        invoked = true;
      })
    ).rejects.toThrow(RecoveryQuiescenceError);
    expect(invoked).toBe(false);

    // Second freeze attempt is blocked with ALREADY_FROZEN
    const secondFreezeRes = coordinator.tryAcquireFreeze();
    expect(secondFreezeRes.acquired).toBe(false);
    if (!secondFreezeRes.acquired) {
      expect(secondFreezeRes.code).toBe("ALREADY_FROZEN");
    }

    lease.release();
    expect(coordinator.isFrozen).toBe(false);
  });

  it("release unblocks writers and scoped withFreeze reliably releases on success or throw", async () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book"],
      initialRegisteredWriters: ["book"],
      coverageDeclaration: "trusted"
    });

    // 1. Manual lease release unblocks
    const lease = coordinator.acquireFreeze();
    expect(coordinator.isFrozen).toBe(true);
    expect(coordinator.tryAcquireWriterPermit("book").granted).toBe(false);

    expect(lease.release()).toBe(true);
    expect(coordinator.isFrozen).toBe(false);
    const permitResult1 = coordinator.tryAcquireWriterPermit("book");
    expect(permitResult1.granted).toBe(true);
    expect(coordinator.activeWriteCount).toBe(1);
    if (permitResult1.granted) {
      expect(permitResult1.permit.release()).toBe(true);
    }

    // 2. withFreeze unblocks on normal completion
    await coordinator.withFreeze(async () => {
      expect(coordinator.isFrozen).toBe(true);
      expect(coordinator.tryAcquireWriterPermit("book").granted).toBe(false);
    });
    expect(coordinator.isFrozen).toBe(false);
    const permitResult2 = coordinator.tryAcquireWriterPermit("book");
    expect(permitResult2.granted).toBe(true);
    if (permitResult2.granted) {
      expect(permitResult2.permit.release()).toBe(true);
    }

    // 3. withFreeze unblocks on throw
    await expect(
      coordinator.withFreeze(async () => {
        expect(coordinator.isFrozen).toBe(true);
        throw new Error("simulated export failure");
      })
    ).rejects.toThrow("simulated export failure");

    expect(coordinator.isFrozen).toBe(false);
    const permitAfterThrow = coordinator.acquireWriterPermit("book");
    expect(permitAfterThrow.released).toBe(false);
    permitAfterThrow.release();
  });

  it("incomplete coverage refuses freeze by default and when writers are missing", () => {
    // 1. Default coordinator starts untrusted/incomplete with 0 registered writers
    const defaultCoordinator = new RecoveryQuiescenceCoordinator();
    expect(defaultCoordinator.registeredWriterIds()).toEqual([]);
    expect(defaultCoordinator.missingWriterIds().length).toBe(REQUIRED_HOST_WRITERS.length);

    expect(() => defaultCoordinator.acquireFreeze()).toThrow(RecoveryQuiescenceError);
    try {
      defaultCoordinator.acquireFreeze();
    } catch (error) {
      expect((error as RecoveryQuiescenceError).code).toBe("INCOMPLETE_COVERAGE");
    }

    const defaultPreflight = defaultCoordinator.preflightQuiescence();
    expect(defaultPreflight.coverageComplete).toBe(false);
    expect(defaultPreflight.eligibleForFreeze).toBe(false);
    expect(defaultPreflight.missingWriters.length).toBe(REQUIRED_HOST_WRITERS.length);
    expect(defaultPreflight.issues.some(issue => issue.includes("coverage is incomplete"))).toBe(true);

    // 2. Custom required set missing one writer
    const customCoordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "workstation-case", "session-pool"],
      initialRegisteredWriters: ["book", "workstation-case"],
      coverageDeclaration: "trusted"
    });
    expect(customCoordinator.missingWriterIds()).toEqual(["session-pool"]);
    expect(() => customCoordinator.acquireFreeze()).toThrow(RecoveryQuiescenceError);

    // Registering the missing writer makes coverage complete
    customCoordinator.registerWriter("session-pool");
    expect(customCoordinator.missingWriterIds()).toEqual([]);
    const lease = customCoordinator.acquireFreeze();
    expect(lease.coveredWriters).toEqual(["book", "session-pool", "workstation-case"]);
    lease.release();

    // 3. Explicit untrusted coverage declaration refuses freeze even if all writers registered
    const untrustedCoordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book"],
      initialRegisteredWriters: ["book"],
      coverageDeclaration: "untrusted"
    });
    expect(() => untrustedCoordinator.acquireFreeze()).toThrow(RecoveryQuiescenceError);
    const untrustedPreflight = untrustedCoordinator.preflightQuiescence();
    expect(untrustedPreflight.coverageComplete).toBe(false);
    expect(untrustedPreflight.eligibleForFreeze).toBe(false);
  });

  it("truthful false readiness: preflight distinguishes eligibleForFreeze from productWideQuiescenceAttested", () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "settings"],
      initialRegisteredWriters: ["book", "settings"],
      coverageDeclaration: "trusted"
    });

    // When fully registered, idle, and unfrozen: eligibleForFreeze is TRUE
    const preflight = coordinator.preflightQuiescence();
    expect(preflight.coverageComplete).toBe(true);
    expect(preflight.activeWriteCount).toBe(0);
    expect(preflight.isFrozen).toBe(false);
    expect(preflight.eligibleForFreeze).toBe(true);

    // BUT product-wide quiescence and export readiness MUST remain FALSE
    expect(preflight.productWideQuiescenceAttested).toBe(false);
    expect(preflight.readyForExport).toBe(false);

    // Preflight issues and integration dependencies are documented
    expect(preflight.issues.some(i => i.includes("Product-wide quiescence is unattested"))).toBe(true);
    expect(preflight.issues.some(i => i.includes("Local coordinator lease does not survive process restart"))).toBe(true);
    expect(preflight.nextDependencies).toEqual(RECOVERY_QUIESCENCE_INTEGRATION_DEPENDENCIES);

    // When write is in flight: eligibleForFreeze becomes FALSE, productWideQuiescenceAttested remains FALSE
    const permit = coordinator.acquireWriterPermit("book");
    const preflightInFlight = coordinator.preflightQuiescence();
    expect(preflightInFlight.eligibleForFreeze).toBe(false);
    expect(preflightInFlight.productWideQuiescenceAttested).toBe(false);
    expect(preflightInFlight.readyForExport).toBe(false);
    expect(preflightInFlight.activeWriteCount).toBe(1);
    expect(preflightInFlight.activeWriters).toEqual(["book"]);
    permit.release();

    // When frozen: eligibleForFreeze is FALSE (already frozen), productWideQuiescenceAttested remains FALSE
    const lease = coordinator.acquireFreeze();
    const preflightFrozen = coordinator.preflightQuiescence();
    expect(preflightFrozen.isFrozen).toBe(true);
    expect(preflightFrozen.eligibleForFreeze).toBe(false);
    expect(preflightFrozen.productWideQuiescenceAttested).toBe(false);
    expect(preflightFrozen.readyForExport).toBe(false);
    lease.release();
  });

  it("robustness: handles duplicate permit release, stale tokens, and unknown writers deterministically", () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book"],
      initialRegisteredWriters: ["book"],
      coverageDeclaration: "trusted"
    });

    // Unknown writer refusal
    expect(() => coordinator.acquireWriterPermit("unknown-writer")).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.acquireWriterPermit("unknown-writer");
    } catch (error) {
      expect((error as RecoveryQuiescenceError).code).toBe("UNKNOWN_WRITER");
    }

    // Duplicate permit release is safe and idempotent
    const permit = coordinator.acquireWriterPermit("book");
    expect(coordinator.activeWriteCount).toBe(1);
    expect(permit.release()).toBe(true);
    expect(permit.released).toBe(true);
    expect(coordinator.activeWriteCount).toBe(0);

    // Second release call returns false without error or decrementing below zero
    expect(permit.release()).toBe(false);
    expect(permit.release()).toBe(false);
    expect(coordinator.activeWriteCount).toBe(0);

    // Stale or unknown permit token release
    expect(coordinator.releaseWriterPermit("stale-permit-token-xyz")).toBe(false);
    expect(coordinator.activeWriteCount).toBe(0);

    // Duplicate freeze lease release
    const lease = coordinator.acquireFreeze();
    expect(lease.release()).toBe(true);
    expect(lease.released).toBe(true);
    expect(coordinator.isFrozen).toBe(false);
    expect(lease.release()).toBe(false);
    expect(coordinator.releaseFreeze("stale-lease-id")).toBe(false);
  });

  it("exception/abort handling: withWriterPermit releases permit when action throws", async () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book"],
      initialRegisteredWriters: ["book"],
      coverageDeclaration: "trusted"
    });

    await expect(
      coordinator.withWriterPermit("book", () => {
        expect(coordinator.activeWriteCount).toBe(1);
        throw new Error("aborted during write");
      })
    ).rejects.toThrow("aborted during write");

    expect(coordinator.activeWriteCount).toBe(0);
    expect(coordinator.activeWriterIds()).toEqual([]);

    // Freeze can now be acquired cleanly
    const lease = coordinator.acquireFreeze();
    expect(lease.release()).toBe(true);
  });

  it("refuses freeze when all required IDs are registered without explicit trusted declaration (fail-closed default)", () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book", "timeline"],
      initialRegisteredWriters: ["book", "timeline"]
    });

    expect(coordinator.missingWriterIds()).toEqual([]);
    expect(coordinator.registeredWriterIds()).toEqual(["book", "timeline"]);

    // Refuses freeze because coverage defaults to untrusted
    expect(() => coordinator.acquireFreeze()).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.acquireFreeze();
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryQuiescenceError);
      expect((error as RecoveryQuiescenceError).code).toBe("INCOMPLETE_COVERAGE");
    }

    const preflight = coordinator.preflightQuiescence();
    expect(preflight.coverageComplete).toBe(false);
    expect(preflight.eligibleForFreeze).toBe(false);
    expect(preflight.missingWriters).toEqual([]);
    expect(preflight.productWideQuiescenceAttested).toBe(false);
    expect(preflight.readyForExport).toBe(false);

    // Setting explicit trusted declaration subsequently enables freeze eligibility
    coordinator.setCoverageDeclaration("trusted");
    const preflightTrusted = coordinator.preflightQuiescence();
    expect(preflightTrusted.coverageComplete).toBe(true);
    expect(preflightTrusted.eligibleForFreeze).toBe(true);
    expect(preflightTrusted.productWideQuiescenceAttested).toBe(false);
    expect(preflightTrusted.readyForExport).toBe(false);

    const lease = coordinator.acquireFreeze();
    expect(lease.released).toBe(false);
    expect(lease.release()).toBe(true);
  });

  it("guards setCoverageDeclaration: cannot change while freeze is held or active writes are in flight", () => {
    const coordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: ["book"],
      initialRegisteredWriters: ["book"],
      coverageDeclaration: "trusted"
    });

    // 1. Guard while write permit is active
    const permit = coordinator.acquireWriterPermit("book");
    expect(coordinator.activeWriteCount).toBe(1);

    // Setting the identical declaration does not break state and succeeds
    coordinator.setCoverageDeclaration("trusted");

    // Attempting to change declaration while writes are in flight throws ACTIVE_WRITERS_IN_FLIGHT
    expect(() => coordinator.setCoverageDeclaration("untrusted")).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.setCoverageDeclaration("untrusted");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryQuiescenceError);
      expect((error as RecoveryQuiescenceError).code).toBe("ACTIVE_WRITERS_IN_FLIGHT");
    }

    expect(permit.release()).toBe(true);
    expect(coordinator.activeWriteCount).toBe(0);

    // 2. Guard while freeze is active
    const lease = coordinator.acquireFreeze();
    expect(coordinator.isFrozen).toBe(true);

    // Setting the identical declaration does not break state and succeeds
    coordinator.setCoverageDeclaration("trusted");

    // Attempting to change declaration while freeze is held throws FREEZE_IN_PROGRESS
    expect(() => coordinator.setCoverageDeclaration("untrusted")).toThrow(RecoveryQuiescenceError);
    try {
      coordinator.setCoverageDeclaration("untrusted");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryQuiescenceError);
      expect((error as RecoveryQuiescenceError).code).toBe("FREEZE_IN_PROGRESS");
    }

    expect(lease.release()).toBe(true);
    expect(coordinator.isFrozen).toBe(false);

    // When unfrozen and idle, declaration changes cleanly
    coordinator.setCoverageDeclaration("untrusted");
    const preflight = coordinator.preflightQuiescence();
    expect(preflight.coverageComplete).toBe(false);
    expect(preflight.eligibleForFreeze).toBe(false);
  });
});