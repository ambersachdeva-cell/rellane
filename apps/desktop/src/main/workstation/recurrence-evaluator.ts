import { CronExpressionParser } from 'cron-parser';
import type { CronExpression } from 'cron-parser';

/**
 * Options for pure bounded preview recurrence evaluation.
 */
export interface RecurrenceEvaluationOptions {
  /**
   * Strict 6-field cron expression: seconds, minutes, hours, day-of-month, month, day-of-week.
   * Seconds must be fixed to '0'. Jenkins-style 'H' expressions and simultaneous
   * restriction of both Day-of-Month and Day-of-Week are forbidden.
   */
  expression: string;

  /**
   * Explicit IANA timezone identifier (e.g. 'America/New_York', 'Asia/Kolkata', 'Europe/London', 'UTC').
   * Ambient clock defaults are strictly prohibited.
   */
  timezone: string;

  /**
   * Exclusive UTC millisecond cursor timestamp. Only instants strictly greater than `afterMs` are returned.
   */
  afterMs: number;

  /**
   * Target number of occurrences to compute (1..32). Defaults to 1.
   */
  count?: number;

  /**
   * Maximum lookahead horizon in calendar days from `afterMs` (1..3660). Defaults to 366.
   */
  maxLookaheadDays?: number;
}

/**
 * Detailed occurrence descriptor with UTC instant, ISO 8601 string, and local wall-clock key.
 */
export interface RecurrenceOccurrence {
  utcMs: number;
  utcIso: string;
  localKey: string;
  tz: string;
}

/**
 * Plain structured preview result.
 * Exposes readonly arrays of UTC millisecond instants, detailed occurrence descriptors,
 * and local wall-clock keys.
 */
export interface RecurrenceResult {
  readonly instants: readonly number[];
  readonly occurrences: readonly RecurrenceOccurrence[];
  readonly localKeys: readonly string[];
}

/**
 * Specific error codes for recurrence evaluation validation and boundary failures.
 */
export type RecurrenceErrorCode =
  | 'INVALID_EXPRESSION'
  | 'FORBIDDEN_H_EXPRESSION'
  | 'FORBIDDEN_DOM_DOW_COMBINATION'
  | 'INVALID_TIMEZONE'
  | 'INVALID_AFTER_MS'
  | 'INVALID_COUNT'
  | 'INVALID_LOOKAHEAD'
  | 'CADENCE_TOO_FREQUENT'
  | 'BACKSCAN_BOUND_EXCEEDED'
  | 'SPARSE_BEYOND_HORIZON'
  | 'IMPOSSIBLE_SCHEDULE';

/**
 * Error raised when input constraints, policy, or library bounds are violated.
 */
export class RecurrenceEvaluatorError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(message: string, code: RecurrenceErrorCode) {
    super(message);
    this.name = 'RecurrenceEvaluatorError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes minimum interval to prevent model-task spam
export const BACKSCAN_MS = 48 * 60 * 60 * 1000; // 48-hour backscan window for DST restart stability
export const MAX_BACKSCAN_ITERATIONS = 250; // Hard bounded iteration guard for 48h backscan
export const DEFAULT_MAX_LOOKAHEAD_DAYS = 366;
export const MAX_ALLOWED_LOOKAHEAD_DAYS = 3660;
export const MIN_COUNT = 1;
export const MAX_COUNT = 32;

/**
 * Validates that the provided timezone is a non-empty, valid IANA timezone string.
 * Ambient defaults (such as system clock or process.env.TZ) are strictly rejected.
 */
function validateTimezone(timezone: unknown): string {
  if (typeof timezone !== 'string' || timezone.trim().length === 0) {
    throw new RecurrenceEvaluatorError(
      'Timezone must be a non-empty explicit IANA timezone string; ambient clock defaults are prohibited.',
      'INVALID_TIMEZONE'
    );
  }
  const trimmed = timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new RecurrenceEvaluatorError(
      `Invalid IANA timezone identifier: "${trimmed}".`,
      'INVALID_TIMEZONE'
    );
  }
  return trimmed;
}

/**
 * Validates strict 6-field cron format, rejects seconds !== '0', rejects Jenkins 'H',
 * and enforces the Day-of-Month / Day-of-Week restriction policy.
 *
 * Policy:
 * Standard cron takes the union (OR) when both Day-of-Month (DOM, field 3) and Day-of-Week (DOW, field 5)
 * are constrained, which often causes unintended schedule proliferation.
 * To ensure unambiguous, deterministic schedules, this evaluator requires at least one of DOM or DOW
 * to be a wildcard ('*' or '?'). Restricting both simultaneously is rejected.
 */
function validateExpression(expression: unknown): string {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new RecurrenceEvaluatorError(
      'Cron expression must be a non-empty string.',
      'INVALID_EXPRESSION'
    );
  }

  const trimmed = expression.trim();

  // Reject Jenkins-style 'H' (hash/randomized) expressions
  if (/(?:^|\s|\/|\-|\()h/i.test(trimmed)) {
    throw new RecurrenceEvaluatorError(
      "Invalid expression: Jenkins-style 'H' (hash/random) expressions are forbidden.",
      'FORBIDDEN_H_EXPRESSION'
    );
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 6) {
    throw new RecurrenceEvaluatorError(
      `Invalid expression: expected strict 6-field cron expression, got ${parts.length} fields.`,
      'INVALID_EXPRESSION'
    );
  }

  // Seconds field (index 0) must be fixed to '0'
  if (parts[0] !== '0') {
    throw new RecurrenceEvaluatorError(
      `Invalid expression: seconds field (field 0) must be fixed to '0', got "${parts[0]}".`,
      'INVALID_EXPRESSION'
    );
  }

  // Day-of-Month (field 3) and Day-of-Week (field 5) policy
  const dom = parts[3];
  const dow = parts[5];
  const isDomRestricted = dom !== '*' && dom !== '?';
  const isDowRestricted = dow !== '*' && dow !== '?';

  if (isDomRestricted && isDowRestricted) {
    throw new RecurrenceEvaluatorError(
      'Invalid expression: simultaneous restriction of both Day-of-Month (field 3) and Day-of-Week (field 5) is forbidden to prevent ambiguous union semantics; specify "*" or "?" for at least one field.',
      'FORBIDDEN_DOM_DOW_COMBINATION'
    );
  }

  const normalizedParts = parts.map((part) => (part === '?' ? '*' : part));
  return normalizedParts.join(' ');
}

/**
 * Validates cursor timestamp afterMs.
 */
function validateAfterMs(afterMs: unknown): number {
  if (typeof afterMs !== 'number' || !Number.isFinite(afterMs) || Number.isNaN(afterMs)) {
    throw new RecurrenceEvaluatorError(
      'afterMs must be a finite numeric UTC millisecond timestamp.',
      'INVALID_AFTER_MS'
    );
  }
  return afterMs;
}

/**
 * Validates requested count (1..32).
 */
function validateCount(count: unknown): number {
  if (count === undefined) {
    return MIN_COUNT;
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    throw new RecurrenceEvaluatorError(
      `count must be an integer between ${MIN_COUNT} and ${MAX_COUNT} inclusive, got ${String(count)}.`,
      'INVALID_COUNT'
    );
  }
  return count;
}

/**
 * Validates maxLookaheadDays (1..3660).
 */
function validateMaxLookaheadDays(days: unknown): number {
  if (days === undefined) {
    return DEFAULT_MAX_LOOKAHEAD_DAYS;
  }
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_ALLOWED_LOOKAHEAD_DAYS) {
    throw new RecurrenceEvaluatorError(
      `maxLookaheadDays must be an integer between 1 and ${MAX_ALLOWED_LOOKAHEAD_DAYS} inclusive, got ${String(days)}.`,
      'INVALID_LOOKAHEAD'
    );
  }
  return days;
}

/**
 * Formats a given Date instance into a local occurrence key (YYYY-MM-DDTHH:mm:ss) in the target timezone.
 */
function getLocalOccurrenceKey(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = dtf.formatToParts(date);
  let year = '';
  let month = '';
  let day = '';
  let hour = '';
  let minute = '';
  let second = '';

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = part.value;
        break;
      case 'month':
        month = part.value;
        break;
      case 'day':
        day = part.value;
        break;
      case 'hour':
        hour = part.value;
        break;
      case 'minute':
        minute = part.value;
        break;
      case 'second':
        second = part.value;
        break;
      default:
        break;
    }
  }

  const paddedHour = hour === '24' ? '00' : hour.padStart(2, '0');
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${paddedHour}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

/**
 * Validates minute cadence before preview evaluation.
 * Inspects `interval.fields.minute.values` to verify that sorted adjacent minute gaps
 * and circular wrap gaps across the hour boundary are >= 15 minutes.
 * Seconds are fixed to '0'.
 *
 * Restriction Note:
 * This static check may conservatively reject some safe sparse-hour plans
 * (e.g. irregular minutes scheduled only for specific sparse hours where wrap gaps do not recur).
 * This conservative restriction guarantees prevention of model-task spam.
 */
function validateMinuteCadence(interval: CronExpression): void {
  const fields = (interval as unknown as { fields?: { minute?: { values?: number[] } } }).fields;
  const minuteValues = fields?.minute?.values;
  if (!minuteValues || minuteValues.length <= 1) {
    return;
  }

  const sortedMinutes = [...minuteValues].sort((a, b) => a - b);
  for (let i = 1; i < sortedMinutes.length; i++) {
    const prev = sortedMinutes[i - 1];
    const curr = sortedMinutes[i];
    if (prev !== undefined && curr !== undefined) {
      const gap = curr - prev;
      if (gap < 15) {
        throw new RecurrenceEvaluatorError(
          `Cadence too frequent: minute gap between ${prev} and ${curr} is ${gap} minutes. Minimum allowed interval is 15 minutes to prevent task spam.`,
          'CADENCE_TOO_FREQUENT'
        );
      }
    }
  }

  const first = sortedMinutes[0];
  const last = sortedMinutes[sortedMinutes.length - 1];
  if (first !== undefined && last !== undefined) {
    const circularWrapGap = 60 + first - last;
    if (circularWrapGap < 15) {
      throw new RecurrenceEvaluatorError(
        `Cadence too frequent: circular minute wrap gap between ${last} and ${first} is ${circularWrapGap} minutes. Minimum allowed interval is 15 minutes to prevent task spam.`,
        'CADENCE_TOO_FREQUENT'
      );
    }
  }
}

/**
 * Deterministically evaluates future UTC instants for a cron schedule.
 *
 * DST Policy:
 * - Spring nonexistent local time: shifts forward to the valid daylight wall time preserving target minutes
 *   (e.g., in America/New_York on 2026-03-08, 02:30 nonexistent yields 2026-03-08T07:30:00Z / 03:30 local).
 * - Fall repeated local time: runs once at the FIRST repeated local wall time (e.g. 05:30Z in EDT) and does NOT
 *   run a second time during the post-transition repeat (06:30Z in EST), even when evaluated between repeats
 *   (e.g. afterMs=05:45Z). Bounded `seenLocalKeys` tracks wall-clock keys across backscan and future candidates.
 * - Restart stability: parser is seeded at least 48 hours prior to afterMs and stepped forward to > afterMs.
 *   This ensures that even if evaluated at 06:00Z (after first repeat has passed), the parser's internal day cursor
 *   already advanced through the first occurrence and does not erroneously emit the second repeat.
 * - Iteration guard: backscan iterations are capped at 250, and schedules with intervals < 15 minutes are rejected.
 */
export function evaluateRecurrence(
  options: RecurrenceEvaluationOptions
): RecurrenceResult {
  const expression = validateExpression(options.expression);
  const timezone = validateTimezone(options.timezone);
  const afterMs = validateAfterMs(options.afterMs);
  const count = validateCount(options.count);
  const maxLookaheadDays = validateMaxLookaheadDays(options.maxLookaheadDays);

  const anchorMs = afterMs - BACKSCAN_MS;
  const horizonMs = maxLookaheadDays * 24 * 60 * 60 * 1000;
  const maxDateMs = afterMs + horizonMs;

  let interval: CronExpression;
  try {
    interval = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(anchorMs),
      endDate: new Date(maxDateMs),
      strict: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecurrenceEvaluatorError(
      `Failed to parse cron expression with cron-parser: ${message}`,
      'INVALID_EXPRESSION'
    );
  }

  validateMinuteCadence(interval);

  const instants: number[] = [];
  const occurrences: RecurrenceOccurrence[] = [];
  const localKeys: string[] = [];
  const seenLocalKeys = new Set<string>();

  let prevOccurrenceMs: number | null = null;
  let backscanCount = 0;

  while (interval.hasNext()) {
    let nextDate: Date;
    let nextIso: string;

    try {
      const nextItem = interval.next();
      nextDate = nextItem.toDate();
      nextIso = nextDate.toISOString();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/out of.*range/i.test(message)) {
        break;
      }
      throw new RecurrenceEvaluatorError(
        `Failed to evaluate cron expression: ${message}`,
        'INVALID_EXPRESSION'
      );
    }

    const currentMs = nextDate.getTime();
    const localKey = getLocalOccurrenceKey(nextDate, timezone);

    // First-only wall-time policy: skip duplicate local wall times across backscan and future candidates
    if (seenLocalKeys.has(localKey)) {
      continue;
    }
    seenLocalKeys.add(localKey);

    // Reject overly frequent plans (<15 min between consecutive occurrences)
    if (prevOccurrenceMs !== null) {
      const deltaMs = currentMs - prevOccurrenceMs;
      if (deltaMs < MIN_INTERVAL_MS) {
        throw new RecurrenceEvaluatorError(
          `Cadence too frequent: occurrences are ${Math.round(deltaMs / 60000)} minutes apart (${deltaMs} ms). Minimum allowed interval is 15 minutes to prevent task spam.`,
          'CADENCE_TOO_FREQUENT'
        );
      }
    }
    prevOccurrenceMs = currentMs;

    // Backscan phase: advance cursor through historical window to prime DST state
    if (currentMs <= afterMs) {
      backscanCount++;
      if (backscanCount > MAX_BACKSCAN_ITERATIONS) {
        throw new RecurrenceEvaluatorError(
          `Backscan iteration bound exceeded (${MAX_BACKSCAN_ITERATIONS}). Schedule is too frequent for 48h backscan.`,
          'BACKSCAN_BOUND_EXCEEDED'
        );
      }
      continue;
    }

    // Explicit horizon guard: parser maxDate alone is insufficient
    if (currentMs > maxDateMs) {
      break;
    }

    // Future occurrence phase: currentMs > afterMs
    instants.push(currentMs);
    occurrences.push({
      utcMs: currentMs,
      utcIso: nextIso,
      localKey,
      tz: timezone,
    });
    localKeys.push(localKey);

    if (instants.length >= count) {
      // Guarantee dense cadences (<15m) are rejected even for count=1 requests
      if (count === 1 && interval.hasNext()) {
        try {
          const peekItem = interval.next();
          const peekMs = peekItem.toDate().getTime();
          const peekDeltaMs = peekMs - currentMs;
          if (peekDeltaMs < MIN_INTERVAL_MS) {
            throw new RecurrenceEvaluatorError(
              `Cadence too frequent: occurrences are ${Math.round(peekDeltaMs / 60000)} minutes apart (${peekDeltaMs} ms). Minimum allowed interval is 15 minutes to prevent task spam.`,
              'CADENCE_TOO_FREQUENT'
            );
          }
        } catch (peekErr: unknown) {
          if (peekErr instanceof RecurrenceEvaluatorError) {
            throw peekErr;
          }
          const message = peekErr instanceof Error ? peekErr.message : String(peekErr);
          if (!/out of.*range/i.test(message)) {
            throw new RecurrenceEvaluatorError(
              `Failed to evaluate cron expression: ${message}`,
              'INVALID_EXPRESSION'
            );
          }
        }
      }
      break;
    }
  }

  // Reject schedules that produce fewer than requested occurrences within the lookahead horizon
  if (instants.length < count) {
    throw new RecurrenceEvaluatorError(
      `Fewer than requested occurrences (${instants.length}/${count}) found within horizon (${maxLookaheadDays} days): schedule is sparse > horizon or impossible.`,
      'SPARSE_BEYOND_HORIZON'
    );
  }

  return {
    instants,
    occurrences,
    localKeys,
  };
}
