import { describe, it, expect } from 'vitest';
import {
  evaluateRecurrence,
  RecurrenceEvaluatorError,
  MIN_INTERVAL_MS,
  BACKSCAN_MS,
} from './recurrence-evaluator';
import type { RecurrenceEvaluationOptions } from './recurrence-evaluator';

describe('RecurrenceEvaluator', () => {
  describe('Asia/Kolkata daily 09:30 schedule', () => {
    it('evaluates daily occurrences with exact UTC instants and local keys (no DST)', () => {
      // Asia/Kolkata is fixed UTC+05:30 throughout the year.
      // 09:30 local is exactly 04:00:00.000Z UTC.
      const afterMs = Date.parse('2026-03-01T00:00:00.000Z');
      const result = evaluateRecurrence({
        expression: '0 30 9 * * *',
        timezone: 'Asia/Kolkata',
        afterMs,
        count: 3,
        maxLookaheadDays: 366,
      });

      expect(result.instants.length).toBe(3);
      expect(result.instants).toEqual([
        Date.parse('2026-03-01T04:00:00.000Z'),
        Date.parse('2026-03-02T04:00:00.000Z'),
        Date.parse('2026-03-03T04:00:00.000Z'),
      ]);

      expect(result.localKeys).toEqual([
        '2026-03-01T09:30:00',
        '2026-03-02T09:30:00',
        '2026-03-03T09:30:00',
      ]);

      expect(result.occurrences[0]).toEqual({
        utcMs: Date.parse('2026-03-01T04:00:00.000Z'),
        utcIso: '2026-03-01T04:00:00.000Z',
        localKey: '2026-03-01T09:30:00',
        tz: 'Asia/Kolkata',
      });
    });
  });

  describe('America/New_York spring forward gap', () => {
    it('shifts nonexistent local 02:30 forward to 03:30 EDT preserving target minutes', () => {
      // In America/New_York, 2026-03-08 transitions EST (UTC-5) -> EDT (UTC-4) at 02:00 local (clocks jump to 03:00).
      // 02:30 nonexistent shifts forward to 03:30 EDT = 2026-03-08T07:30:00.000Z.
      const afterMs = Date.parse('2026-03-07T12:00:00.000Z');
      const result = evaluateRecurrence({
        expression: '0 30 2 * * *',
        timezone: 'America/New_York',
        afterMs,
        count: 3,
      });

      expect(result.instants.length).toBe(3);

      // 2026-03-08: Spring gap shifted -> 03:30 EDT (UTC-4) = 07:30:00Z
      expect(result.instants[0]).toBe(Date.parse('2026-03-08T07:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-03-08T03:30:00');

      // 2026-03-09: Daylight time EDT (UTC-4) -> 02:30 EDT = 06:30:00Z
      expect(result.instants[1]).toBe(Date.parse('2026-03-09T06:30:00.000Z'));
      expect(result.occurrences[1]!.localKey).toBe('2026-03-09T02:30:00');

      // 2026-03-10: Daylight time EDT (UTC-4) -> 02:30 EDT = 06:30:00Z
      expect(result.instants[2]).toBe(Date.parse('2026-03-10T06:30:00.000Z'));
      expect(result.occurrences[2]!.localKey).toBe('2026-03-10T02:30:00');
    });
  });

  describe('America/New_York fall back repeat', () => {
    // In America/New_York, 2026-11-01 transitions EDT (UTC-4) -> EST (UTC-5) at 02:00 local (clocks jump back to 01:00).
    // The 01:30 wall clock repeats twice:
    // First repeat: 01:30 EDT = 05:30:00Z (2026-11-01T05:30:00.000Z)
    // Clocks transition back at 02:00 EDT (06:00:00Z) -> 01:00 EST
    // Second repeat: 01:30 EST = 06:30:00Z (2026-11-01T06:30:00.000Z)
    // Product policy: fire once at FIRST repeated local wall time, never firing twice on the same calendar day.
    const expr = '0 30 1 * * *';
    const tz = 'America/New_York';

    it('emits first repeated wall time (05:30Z) and advances to next day from pre-transition cursor', () => {
      const afterMs = Date.parse('2026-11-01T04:00:00.000Z');
      const result = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs,
        count: 2,
      });

      expect(result.instants.length).toBe(2);
      expect(result.instants[0]).toBe(Date.parse('2026-11-01T05:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-11-01T01:30:00');

      // The next occurrence is the following day (2026-11-02), NOT the second repeat (06:30Z)
      expect(result.instants[1]).toBe(Date.parse('2026-11-02T06:30:00.000Z'));
      expect(result.occurrences[1]!.localKey).toBe('2026-11-02T01:30:00');
    });

    it('avoids second repeat when queried fresh at 06:00Z between first and second intervals', () => {
      // Simulates restart after the job ran at 05:30Z. Cursor is at 06:00Z.
      // Seeding 48h prior ensures the parser visits 05:30Z, advances the day cursor, and skips 06:30Z.
      const afterMs = Date.parse('2026-11-01T06:00:00.000Z');
      const result = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs,
        count: 2,
      });

      expect(result.instants.length).toBe(2);
      expect(result.instants[0]).toBe(Date.parse('2026-11-02T06:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-11-02T01:30:00');
      expect(result.instants[1]).toBe(Date.parse('2026-11-03T06:30:00.000Z'));
    });

    it('emits next day when queried after second repeat (07:00Z)', () => {
      const afterMs = Date.parse('2026-11-01T07:00:00.000Z');
      const result = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs,
        count: 1,
      });

      expect(result.instants[0]).toBe(Date.parse('2026-11-02T06:30:00.000Z'));
    });

    it
('skips duplicate localKey for hourly schedule around fall transition (before both repeats)', () => {
      // Hourly: 0 30 * * * * in America/New_York
      // 04:30Z (00:30 EDT) -> localKey 2026-11-01T00:30:00
      // 05:30Z (01:30 EDT) -> localKey 2026-11-01T01:30:00
      // 06:30Z (01:30 EST) -> localKey 2026-11-01T01:30:00 (duplicate local wall time - must be skipped)
      // 07:30Z (02:30 EST) -> localKey 2026-11-01T02:30:00
      const afterMs = Date.parse('2026-11-01T04:00:00.000Z');
      const result = evaluateRecurrence({
        expression: '0 30 * * * *',
        timezone: tz,
        afterMs,
        count: 3,
      });

      expect(result.instants.length).toBe(3);
      expect(result.instants[0]).toBe(Date.parse('2026-11-01T04:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-11-01T00:30:00');

      expect(result.instants[1]).toBe(Date.parse('2026-11-01T05:30:00.000Z'));
      expect(result.occurrences[1]!.localKey).toBe('2026-11-01T01:30:00');

      // 06:30Z is skipped; next instant is 07:30Z
      expect(result.instants[2]).toBe(Date.parse('2026-11-01T07:30:00.000Z'));
      expect(result.occurrences[2]!.localKey).toBe('2026-11-01T02:30:00');
    });

    it('skips duplicate localKey for hourly schedule when queried between repeats (afterMs=05:45Z)', () => {
      // Queried at 05:45Z after first repeat (05:30Z).
      // Backscan from 48h anchor visits 05:30Z and marks 2026-11-01T01:30:00 seen.
      // 06:30Z (01:30 EST) must be skipped because localKey 01:30 already occurred.
      // Next emitted instant must be 07:30Z (02:30 EST).
      const afterMs = Date.parse('2026-11-01T05:45:00.000Z');
      const result = evaluateRecurrence({
        expression: '0 30 * * * *',
        timezone: tz,
        afterMs,
        count: 2,
      });

      expect(result.instants.length).toBe(2);
      expect(result.instants[0]).toBe(Date.parse('2026-11-01T07:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-11-01T02:30:00');

      expect(result.instants[1]).toBe(Date.parse('2026-11-01T08:30:00.000Z'));
      expect(result.occurrences[1]!.localKey).toBe('2026-11-01T03:30:00');
    });
  });

  describe('Europe/London analogous transitions', () => {
    const tz = 'Europe/London';
    const expr = '0 30 1 * * *';

    it('handles London spring gap (shifts 01:30 GMT forward to 02:30 BST = 01:30Z)', () => {
      // In Europe/London, 2026-03-29 transitions GMT (UTC+0) -> BST (UTC+1) at 01:00 UTC (jumps to 02:00 local).
      // Nonexistent 01:30 shifts forward to 02:30 BST = 01:30:00Z.
      const afterMs = Date.parse('2026-03-28T12:00:00.000Z');
      const result = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs,
        count: 2,
      });

      expect(result.instants[0]).toBe(Date.parse('2026-03-29T01:30:00.000Z'));
      expect(result.occurrences[0]!.localKey).toBe('2026-03-29T02:30:00');
    });

    it('handles London fall repeat (fires at first repeat 00:30Z, avoids second repeat 01:30Z)', () => {
      // In Europe/London, 2026-10-25 transitions BST (UTC+1) -> GMT (UTC+0) at 02:00 local (01:00 UTC, jumps back to 01:00).
      // First repeat: 01:30 BST = 00:30:00Z (2026-10-25T00:30:00.000Z).
      // Second repeat: 01:30 GMT = 01:30:00Z (2026-10-25T01:30:00.000Z).
      const afterBefore = Date.parse('2026-10-24T22:00:00.000Z');
      const resBefore = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs: afterBefore,
        count: 2,
      });

      expect(resBefore.instants[0]).toBe(Date.parse('2026-10-25T00:30:00.000Z'));
      expect(resBefore.instants[1]).toBe(Date.parse('2026-10-26T01:30:00.000Z'));

      // Queried between repeats at 01:00 UTC
      const afterBetween = Date.parse('2026-10-25T01:00:00.000Z');
      const resBetween = evaluateRecurrence({
        expression: expr,
        timezone: tz,
        afterMs: afterBetween,
        count: 1,
      });

      expect(resBetween.instants[0]).toBe(Date.parse('2026-10-26T01:30:00.000Z'));
    });
  });

  describe('Determinism and restart stability', () => {
    it('produces identical results across separate calls and simulated restart cursor movements', () => {
      const options: RecurrenceEvaluationOptions = {
        expression: '0 0 12 * * *',
        timezone: 'UTC',
        afterMs: Date.parse('2026-01-01T00:00:00.000Z'),
        count: 5,
        maxLookaheadDays: 366,
      };

      const run1 = evaluateRecurrence(options);
      const run2 = evaluateRecurrence(options);

      expect(run1.instants).toEqual(run2.instants);
      expect(run1.localKeys).toEqual(run2.localKeys);

      // Simulating step-by-step restart: evaluating after the 1st instant yields instants 2..5
      const restartRun = evaluateRecurrence({
        ...options,
        afterMs: run1.instants[0]!,
        count: 4,
      });

      expect(restartRun.instants).toEqual(run1.instants.slice(1));
    });

    it('maintains restart stability for America/New_York across DST transitions', () => {
      const options: RecurrenceEvaluationOptions = {
        expression: '0 30 1 * * *',
        timezone: 'America/New_York',
        afterMs: Date.parse('2026-10-31T12:00:00.000Z'),
        count: 4,
        maxLookaheadDays: 366,
      };

      const run1 = evaluateRecurrence(options);
      expect(run1.instants.length).toBe(4);

      const restartRun = evaluateRecurrence({
        ...options,
        afterMs: run1.instants[0]!,
        count: 3,
      });

      expect(restartRun.instants).toEqual(run1.instants.slice(1));
      expect(restartRun.localKeys).toEqual(run1.localKeys.slice(1));
    });

    it('maintains restart stability for Europe/London across DST transitions', () => {
      const options: RecurrenceEvaluationOptions = {
        expression: '0 30 1 * * *',
        timezone: 'Europe/London',
        afterMs: Date.parse('2026-10-24T12:00:00.000Z'),
        count: 4,
        maxLookaheadDays: 366,
      };

      const run1 = evaluateRecurrence(options);
      expect(run1.instants.length).toBe(4);

      const restartRun = evaluateRecurrence({
        ...options,
        afterMs: run1.instants[0]!,
        count: 3,
      });

      expect(restartRun.instants).toEqual(run1.instants.slice(1));
      expect(restartRun.localKeys).toEqual(run1.localKeys.slice(1));
    });

    it('maintains restart stability for Asia/Kolkata', () => {
      const options: RecurrenceEvaluationOptions = {
        expression: '0 30 9 * * *',
        timezone: 'Asia/Kolkata',
        afterMs: Date.parse('2026-03-01T00:00:00.000Z'),
        count: 4,
        maxLookaheadDays: 366,
      };

      const run1 = evaluateRecurrence(options);
      expect(run1.instants.length).toBe(4);

      const restartRun = evaluateRecurrence({
        ...options,
        afterMs: run1.instants[0]!,
        count: 3,
      });

      expect(restartRun.instants).toEqual(run1.instants.slice(1));
      expect(restartRun.localKeys).toEqual(run1.localKeys.slice(1));
    });
  });

  describe('Input validation', () => {
    const validBase = {
      expression: '0 0 12 * * *',
      timezone: 'UTC',
      afterMs: Date.parse('2026-01-01T00:00:00.000Z'),
      count: 1,
      maxLookaheadDays: 366,
    };

    it('rejects invalid or ambient timezones', () => {
      expect(() => evaluateRecurrence({ ...validBase, timezone: '' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, timezone: '   ' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, timezone: 'Invalid/NonExistent_Zone' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, timezone: 'SYSTEM' }))
        .toThrow(RecurrenceEvaluatorError);
    });

    it('rejects non-6-field cron expressions and non-zero seconds', () => {
      // 5-field cron
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);

      // 7-field cron
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 * * * 2026' }))
        .toThrow(RecurrenceEvaluatorError);

      // Non-zero seconds
      expect(() => evaluateRecurrence({ ...validBase, expression: '30 0 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '* 0 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '*/5 0 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);
    });

    it('rejects Jenkins-style H random expressions', () => {
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 H 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 H * * *' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 H(0-30) 12 * * *' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 * * H' }))
        .toThrow(RecurrenceEvaluatorError);
    });

    it('rejects simultaneous restriction of Day-of-Month and Day-of-Week', () => {
      // Both DOM and DOW restricted -> forbidden
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 15 * 5' }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 1-5 * 1-5' }))
        .toThrow(RecurrenceEvaluatorError);

      // DOM restricted, DOW wildcard -> permitted
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 15 * *' }))
        .not.toThrow();
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 15 * ?' }))
        .not.toThrow();

      // DOM wildcard, DOW restricted -> permitted
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 * * 5' }))
        .not.toThrow();
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0 12 ? * 5' }))
        .not.toThrow();
    });

    it('rejects invalid afterMs, count, and maxLookaheadDays', () => {
      expect(() => evaluateRecurrence({ ...validBase, afterMs: NaN }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, afterMs: Infinity }))
        .toThrow(RecurrenceEvaluatorError);

      // Count validation (1..32)
      expect(() => evaluateRecurrence({ ...validBase, count: 0 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, count: -1 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, count: 33 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, count: 2.5 }))
        .toThrow(RecurrenceEvaluatorError);

      // maxLookaheadDays validation (1..3660)
      expect(() => evaluateRecurrence({ ...validBase, maxLookaheadDays: 0 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, maxLookaheadDays: -10 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, maxLookaheadDays: 3661 }))
        .toThrow(RecurrenceEvaluatorError);
      expect(() => evaluateRecurrence({ ...validBase, maxLookaheadDays: 30.5 }))
        .toThrow(RecurrenceEvaluatorError);
    });
  });

  describe('Sparse horizon and impossible schedules', () => {
    it('rejects schedules where next occurrence exceeds maxLookaheadDays', () => {
      // Monthly schedule on day 25, but lookahead horizon is restricted to 5 days
      const afterMs = Date.parse('2026-01-01T00:00:00.000Z');
      expect(() =>
        evaluateRecurrence({
          expression: '0 0 12 25 * *',
          timezone: 'UTC',
          afterMs,
          count: 1,
          maxLookaheadDays: 5,
        })
      ).toThrow(RecurrenceEvaluatorError);
    });

    it('throws SPARSE_BEYOND_HORIZON when fewer than requested count exist before horizon', () => {
      // Monthly schedule on day 1; within 45 days only 2 occurrences exist (Jan 1, Feb 1)
      const afterMs = Date.parse('2026-01-01T00:00:00.000Z');
      expect(() =>
        evaluateRecurrence({
          expression: '0 0 12 1 * *',
          timezone: 'UTC',
          afterMs,
          count: 5,
          maxLookaheadDays: 45,
        })
      ).toThrow(RecurrenceEvaluatorError);

      try {
        evaluateRecurrence({
          expression: '0 0 12 1 * *',
          timezone: 'UTC',
          afterMs,
          count: 5,
          maxLookaheadDays: 45,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(RecurrenceEvaluatorError);
        expect((err as RecurrenceEvaluatorError).code).toBe('SPARSE_BEYOND_HORIZON');
      }
    });

    it('rejects impossible calendar schedules (e.g. February 31st)', () => {
      const afterMs = Date.parse('2026-01-01T00:00:00.000Z');
      expect(() =>
        evaluateRecurrence({
          expression: '0 0 12 31 2 *',
          timezone: 'UTC',
          afterMs,
          count: 1,
          maxLookaheadDays: 366,
        })
      ).toThrow(RecurrenceEvaluatorError);
    });
  });

  describe('Dense cadence rejection (<15 minutes)', () => {
    const validBase = {
      timezone: 'UTC',
      afterMs: Date.parse('2026-01-01T00:00:00.000Z'),
      count: 2,
    };

    it('rejects sub-15 minute cadences', () => {
      // Every minute
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 * * * * *' }))
        .toThrow(RecurrenceEvaluatorError);

      // Every 5 minutes
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 */5 * * * *' }))
        .toThrow(RecurrenceEvaluatorError);

      // Every 10 minutes
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 */10 * * * *' }))
        .toThrow(RecurrenceEvaluatorError);

      // Irregular schedule with adjacent gap < 15m (e.g. minutes 0, 5, 30)
      expect(() => evaluateRecurrence({ ...validBase, expression: '0 0,5,30 * * * *' }))
        .toThrow(RecurrenceEvaluatorError);
    });

    it('rejects dense cadences even when count=1 is requested', () => {
      expect(() =>
        evaluateRecurrence({
          ...validBase,
          expression: '0 */5 * * * *',
          count: 1,
        })
      ).toThrow(RecurrenceEvaluatorError);
    });

    it('rejects sparse irregular list with adjacent gap < 15 minutes (0 0,5,35 12 1 1 *)', () => {
      expect(() =>
        evaluateRecurrence({
          expression: '0 0,5,35 12 1 1 *',
          timezone: 'UTC',
          afterMs: Date.parse('2026-01-01T12:02:00.000Z'),
          count: 1,
        })
      ).toThrow(RecurrenceEvaluatorError);

      try {
        evaluateRecurrence({
          expression: '0 0,5,35 12 1 1 *',
          timezone: 'UTC',
          afterMs: Date.parse('2026-01-01T12:02:00.000Z'),
          count: 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(RecurrenceEvaluatorError);
        expect((err as RecurrenceEvaluatorError).code).toBe('CADENCE_TOO_FREQUENT');
      }
    });

    it('rejects circular wrap minute gap < 15 minutes across hour boundary', () => {
      expect(() =>
        evaluateRecurrence({
          expression: '0 0,50 * * * *',
          timezone: 'UTC',
          afterMs: Date.parse('2026-01-01T00:00:00.000Z'),
          count: 1,
        })
      ).toThrow(RecurrenceEvaluatorError);

      try {
        evaluateRecurrence({
          expression: '0 0,50 * * * *',
          timezone: 'UTC',
          afterMs: Date.parse('2026-01-01T00:00:00.000Z'),
          count: 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(RecurrenceEvaluatorError);
        expect((err as RecurrenceEvaluatorError).code).toBe('CADENCE_TOO_FREQUENT');
      }
    });

    it('accepts cadences with interval >= 15 minutes', () => {
      // Exactly 15 minutes
      expect(() =>
        evaluateRecurrence({ ...validBase, expression: '0 */15 * * * *' })
      ).not.toThrow();

      // Every 30 minutes
      expect(() =>
        evaluateRecurrence({ ...validBase, expression: '0 */30 * * * *' })
      ).not.toThrow();

      // Daily
      expect(() =>
        evaluateRecurrence({ ...validBase, expression: '0 0 12 * * *' })
      ).not.toThrow();
    });
  });

  describe('Pure computation guarantee', () => {
    it('executes synchronously without calling ambient Date.now() or timer APIs', () => {
      let timerInvoked = false;
      let dateNowInvoked = false;

      const originalSetTimeout = globalThis.setTimeout;
      const originalSetInterval = globalThis.setInterval;
      const originalDateNow = Date.now;

      globalThis.setTimeout = ((...args: unknown[]) => {
        timerInvoked = true;
        return originalSetTimeout(...(args as [() => void, number]));
      }) as unknown as typeof globalThis.setTimeout;

      globalThis.setInterval = ((...args: unknown[]) => {
        timerInvoked = true;
        return originalSetInterval(...(args as [() => void, number]));
      }) as unknown as typeof globalThis.setInterval;

      Date.now = () => {
        dateNowInvoked = true;
        return originalDateNow();
      };

      try {
        const result = evaluateRecurrence({
          expression: '0 30 9 * * *',
          timezone: 'Asia/Kolkata',
          afterMs: Date.parse('2026-03-01T00:00:00.000Z'),
          count: 3,
        });

        expect(result.instants.length).toBe(3);
        expect(timerInvoked).toBe(false);
        expect(dateNowInvoked).toBe(false);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.setInterval = originalSetInterval;
        Date.now = originalDateNow;
      }
    });
  });
});
