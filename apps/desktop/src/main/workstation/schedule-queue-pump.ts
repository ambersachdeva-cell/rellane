/**
 * One app-alive clock for approved schedules. It only writes due queue receipts;
 * a separate owner review and Start remain necessary for every model run.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  admitScheduledOccurrence,
  MAX_SCHEDULE_DEFINITIONS,
  MAX_SCHEDULE_HISTORY_ROWS,
  pruneInvalidQueuedOccurrences,
  scanScheduleDefinitions
} from "./schedule-definition-store.js";
import { recoverCrashedOccurrences, withImmediateTransaction } from "./scheduled-occurrence-store.js";

export const SCHEDULE_PUMP_INTERVAL_MS = 60_000;
export type SchedulePumpTick =
  | { readonly status: "busy" }
  | { readonly status: "scanned"; readonly asOf: number; readonly schedules: number;
      readonly queued: number; readonly alreadyQueued: number; readonly alreadyRecorded: number;
      readonly inactive: number; readonly notDue: number; readonly pruned: number };

interface PumpTimer {
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface ScheduleQueuePumpOptions {
  /** The Book opens lazily, so it must be acquired at each tick, not install. */
  readonly book: () => DatabaseSync;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly maxScanRows?: number;
  readonly maxSchedules?: number;
  readonly timer?: PumpTimer;
  readonly onError?: (error: unknown) => void;
}

function boundedPositive(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer at most ${maximum}.`);
  }
  return value;
}

export function createScheduleQueuePump(options: ScheduleQueuePumpOptions) {
  const intervalMs = boundedPositive(options.intervalMs ?? SCHEDULE_PUMP_INTERVAL_MS, 24 * 60 * 60_000,
    "Schedule pump interval");
  const maxScanRows = boundedPositive(options.maxScanRows ?? MAX_SCHEDULE_HISTORY_ROWS, MAX_SCHEDULE_HISTORY_ROWS,
    "Schedule scan rows");
  const maxSchedules = boundedPositive(options.maxSchedules ?? MAX_SCHEDULE_DEFINITIONS, MAX_SCHEDULE_DEFINITIONS,
    "Schedule capacity");
  const now = options.now ?? Date.now;
  const timer: PumpTimer = options.timer ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
  };
  let handle: unknown | null = null;
  let running = false;
  let disposed = false;
  let ticking = false;
  let recovered = false;
  let lastError: unknown = null;

  const tick = (asOf?: number): SchedulePumpTick => {
    if (disposed) {
      lastError = new Error("Schedule pump has stopped.");
      throw lastError;
    }
    // A recursive or overlapping callback is discarded. The next interval can
    // check again; replaying from finally can recurse forever.
    if (ticking) return { status: "busy" };
    ticking = true;
    try {
      const at = asOf ?? now();
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error("Schedule clock is invalid.");
      const db = options.book();
      if (!db || typeof (db as { prepare?: unknown }).prepare !== "function") {
        return { status: "busy" };
      }
      if (!recovered) {
        recoverCrashedOccurrences(db, { at });
        recovered = true;
      }
      // The outer transaction rolls back all admissions if a later schedule
      // fails validation. Nested queue writes use the store's savepoints.
      return withImmediateTransaction(db, () => {
        const records = scanScheduleDefinitions(db, maxScanRows);
        if (records.length > maxSchedules) {
          throw new Error(`Schedule capacity exceeded: ${records.length} definitions, limit ${maxSchedules}.`);
        }
        const pruned = pruneInvalidQueuedOccurrences(db, records, at);
        const counts = { queued: 0, alreadyQueued: 0, alreadyRecorded: 0, inactive: 0, notDue: 0 };
        for (const record of records) {
          const admission = admitScheduledOccurrence(db, {
            scheduleId: record.definition.scheduleId, asOf: at
          });
          switch (admission.status) {
            case "queued": counts.queued += 1; break;
            case "already-queued": counts.alreadyQueued += 1; break;
            case "already-recorded": counts.alreadyRecorded += 1; break;
            case "inactive": counts.inactive += 1; break;
            case "not-due": counts.notDue += 1; break;
          }
        }
        lastError = null;
        return Object.freeze({ status: "scanned" as const, asOf: at, schedules: records.length, pruned, ...counts });
      });
    } catch (error) {
      lastError = error;
      throw error;
    } finally {
      ticking = false;
    }
  };

  const safeTick = (): void => {
    if (!running || disposed) return;
    try {
      tick();
    } catch (error) {
      lastError = error;
      try { options.onError?.(error); } catch { /* Observability must not crash the timer. */ }
    }
  };

  return {
    tick,
    start(): void {
      if (disposed) throw new Error("Schedule pump has stopped.");
      if (running) return;
      try {
        handle = timer.setInterval(safeTick, intervalMs);
        if (handle && typeof handle === "object" && "unref" in handle &&
            typeof handle.unref === "function") handle.unref();
        running = true;
      } catch (error) {
        if (handle !== null) {
          try { timer.clearInterval(handle); } catch { /* Retain the setup failure. */ }
        }
        handle = null;
        running = false;
        lastError = error;
        throw error;
      }
      safeTick();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      running = false;
      if (handle !== null) timer.clearInterval(handle);
      handle = null;
    },
    get lastError(): unknown { return lastError; }
  };
}
