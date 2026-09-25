import { describe, it, expect } from "vitest";
import {
  REQUIRED_HOST_WRITERS,
  type RequiredHostWriterId,
  RecoveryQuiescenceError,
} from "./recovery-quiescence.js";
import {
  createTrustedHostQuiescenceCoordinator,
  withHostWriterPermitSync,
  withHostWriterPermit,
  createHostWriterGate,
  type HostWriterRegistry,
} from "./recovery-quiescence-host-bridge.js";

describe("RecoveryQuiescenceHostBridge", () => {
  describe("createTrustedHostQuiescenceCoordinator", () => {
    it("reports coverageComplete: true, missingWriters: [], and eligibleForFreeze: true", () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();
      const preflight = coordinator.preflightQuiescence();

      expect(preflight.coverageComplete).toBe(true);
      expect(preflight.missingWriters).toEqual([]);
      expect(preflight.eligibleForFreeze).toBe(true);
    });
  });

  describe("14 Required Host Writers permit acquisition and release", () => {
    it("cleanly acquires and releases permits via withHostWriterPermitSync for all 14 writers", () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let executed = false;
        const result = withHostWriterPermitSync(coordinator, writerId, () => {
          executed = true;
          return `sync-result-${writerId}`;
        });

        expect(executed).toBe(true);
        expect(result).toBe(`sync-result-${writerId}`);

        const freeze = coordinator.acquireFreeze(`verify-sync-release-${writerId}`);
        freeze.release();
      }
    });

    it("cleanly acquires and releases permits via withHostWriterPermit for all 14 writers", async () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let executed = false;
        const result = await withHostWriterPermit(coordinator, writerId, async () => {
          executed = true;
          return `async-result-${writerId}`;
        });

        expect(executed).toBe(true);
        expect(result).toBe(`async-result-${writerId}`);

        const freeze = coordinator.acquireFreeze(`verify-async-release-${writerId}`);
        freeze.release();
      }
    });

    it("releases permits in finally block when synchronous fn throws", () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let threw = false;
        try {
          withHostWriterPermitSync(coordinator, writerId, () => {
            throw new Error(`sync-failure-${writerId}`);
          });
        } catch (err: unknown) {
          threw = true;
          expect(err).toBeInstanceOf(Error);
          if (err instanceof Error) {
            expect(err.message).toBe(`sync-failure-${writerId}`);
          }
        }

        expect(threw).toBe(true);

        const freeze = coordinator.acquireFreeze(`verify-sync-throw-release-${writerId}`);
        freeze.release();
      }
    });

    it("releases permits in finally block when asynchronous fn rejects", async () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let threw = false;
        try {
          await withHostWriterPermit(coordinator, writerId, async () => {
            throw new Error(`async-failure-${writerId}`);
          });
        } catch (err: unknown) {
          threw = true;
          expect(err).toBeInstanceOf(Error);
          if (err instanceof Error) {
            expect(err.message).toBe(`async-failure-${writerId}`);
          }
        }

        expect(threw).toBe(true);

        const freeze = coordinator.acquireFreeze(`verify-async-throw-release-${writerId}`);
        freeze.release();
      }
    });
  });

  describe("In-flight writer permit blocks freeze across all 14 domains", () => {
    it("causes acquireFreeze to throw ACTIVE_WRITERS_IN_FLIGHT for each domain", async () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let resolveInFlight!: () => void;
        const inFlightGate = new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });

        let writerStarted = false;
        const writerPromise = withHostWriterPermit(coordinator, writerId, async () => {
          writerStarted = true;
          await inFlightGate;
          return `done-${writerId}`;
        });

        expect(writerStarted).toBe(true);

        let freezeThrew = false;
        try {
          coordinator.acquireFreeze(`freeze-during-${writerId}`);
        } catch (err: unknown) {
          freezeThrew = true;
          expect(err).toBeInstanceOf(RecoveryQuiescenceError);
          if (err instanceof RecoveryQuiescenceError) {
            expect(err.code).toBe("ACTIVE_WRITERS_IN_FLIGHT");
          }
        }

        expect(freezeThrew).toBe(true);

        resolveInFlight();
        const outcome = await writerPromise;
        expect(outcome).toBe(`done-${writerId}`);

        const freeze = coordinator.acquireFreeze(`freeze-after-${writerId}`);
        freeze.release();
      }
    });
  });

  describe("Holding a freeze lease blocks all 14 domains", () => {
    it("causes withHostWriterPermitSync and withHostWriterPermit to throw FREEZE_IN_PROGRESS, restoring normal operation after release", async () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();
      const freezeLease = coordinator.acquireFreeze("active-freeze-test");

      for (const writerId of REQUIRED_HOST_WRITERS) {
        let syncThrew = false;
        try {
          withHostWriterPermitSync(coordinator, writerId, () => {
            return "should-never-execute";
          });
        } catch (err: unknown) {
          syncThrew = true;
          expect(err).toBeInstanceOf(RecoveryQuiescenceError);
          if (err instanceof RecoveryQuiescenceError) {
            expect(err.code).toBe("FREEZE_IN_PROGRESS");
          }
        }
        expect(syncThrew).toBe(true);

        let asyncThrew = false;
        try {
          await withHostWriterPermit(coordinator, writerId, async () => {
            return "should-never-execute";
          });
        } catch (err: unknown) {
          asyncThrew = true;
          expect(err).toBeInstanceOf(RecoveryQuiescenceError);
          if (err instanceof RecoveryQuiescenceError) {
            expect(err.code).toBe("FREEZE_IN_PROGRESS");
          }
        }
        expect(asyncThrew).toBe(true);
      }

      freezeLease.release();

      for (const writerId of REQUIRED_HOST_WRITERS) {
        const syncResult = withHostWriterPermitSync(coordinator, writerId, () => `restored-sync-${writerId}`);
        expect(syncResult).toBe(`restored-sync-${writerId}`);

        const asyncResult = await withHostWriterPermit(coordinator, writerId, async () => `restored-async-${writerId}`);
        expect(asyncResult).toBe(`restored-async-${writerId}`);
      }
    });
  });

  describe("createHostWriterGate and HostWriterRegistry", () => {
    it("provides all 14 typed domain helpers with working execution methods", async () => {
      const coordinator = createTrustedHostQuiescenceCoordinator();
      const gate = createHostWriterGate(coordinator);

      const domainGatePairs: Array<[keyof HostWriterRegistry, RequiredHostWriterId]> = [
        ["book", "book"],
        ["workstationCase", "workstation-case"],
        ["workstationBrief", "workstation-brief"],
        ["workstationAgent", "workstation-agent"],
        ["restoreLease", "restore-lease"],
        ["sessionPool", "session-pool"],
        ["timeline", "timeline"],
        ["preimages", "preimages"],
        ["agents", "agents"],
        ["memory", "memory"],
        ["watches", "watches"],
        ["settings", "settings"],
        ["secrets", "secrets"],
        ["automations", "automations"],
      ];

      for (const [propName, writerId] of domainGatePairs) {
        const domainGate = gate[propName];
        expect(domainGate).toBeDefined();
        expect(domainGate.writerId).toBe(writerId);

        const runRes = await domainGate.run(async () => `val-run-${writerId}`);
        expect(runRes).toBe(`val-run-${writerId}`);

        const runSyncRes = domainGate.runSync(() => `val-sync-${writerId}`);
        expect(runSyncRes).toBe(`val-sync-${writerId}`);

        const callRes = await domainGate(async () => `val-call-${writerId}`);
        expect(callRes).toBe(`val-call-${writerId}`);

        expect(gate.forWriter(writerId)).toBe(domainGate);
      }

      const freeze = coordinator.acquireFreeze("gate-freeze-test");

      let gateSyncThrew = false;
      try {
        gate.book.runSync(() => "blocked");
      } catch (err: unknown) {
        gateSyncThrew = true;
        expect(err).toBeInstanceOf(RecoveryQuiescenceError);
        if (err instanceof RecoveryQuiescenceError) {
          expect(err.code).toBe("FREEZE_IN_PROGRESS");
        }
      }
      expect(gateSyncThrew).toBe(true);

      let gateAsyncThrew = false;
      try {
        await gate.automations.run(async () => "blocked");
      } catch (err: unknown) {
        gateAsyncThrew = true;
        expect(err).toBeInstanceOf(RecoveryQuiescenceError);
        if (err instanceof RecoveryQuiescenceError) {
          expect(err.code).toBe("FREEZE_IN_PROGRESS");
        }
      }
      expect(gateAsyncThrew).toBe(true);

      freeze.release();

      const recovered = gate.book.runSync(() => "unblocked");
      expect(recovered).toBe("unblocked");
    });
  });
});
