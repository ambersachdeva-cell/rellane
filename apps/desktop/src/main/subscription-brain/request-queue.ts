/**
 * Serializes calls to one provider and paces them.
 *
 * Two reasons, both practical. A CLI holds a session and a quota, so running
 * several at once produces interleaved failures rather than more throughput.
 * And a tool the user pays for personally should be driven at a human rate —
 * bursting through it is how an account gets flagged for abuse.
 */

export interface QueueOptions {
  /** Minimum milliseconds between the end of one call and the start of the next. */
  readonly minIntervalMs: number;
  /** Reject rather than queue past this depth, so the UI fails fast. */
  readonly maxDepth: number;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RequestQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private lastFinishedAt = 0;

  private readonly minIntervalMs: number;
  private readonly maxDepth: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: QueueOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.maxDepth = Math.max(1, options.maxDepth);
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
  }

  get pending(): number {
    return this.depth;
  }

  /** Runs `task` after every earlier task, honouring the pacing interval. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.maxDepth) {
      throw new BusyError(this.maxDepth);
    }
    this.depth += 1;

    const result = this.chain.then(async () => {
      const waitFor = this.minIntervalMs - (this.now() - this.lastFinishedAt);
      if (this.lastFinishedAt !== 0 && waitFor > 0) {
        await this.sleep(waitFor);
      }
      try {
        return await task();
      } finally {
        this.lastFinishedAt = this.now();
        this.depth -= 1;
      }
    });

    // Keep the chain alive even when this task rejects, so one failure does not
    // poison every queued call behind it.
    this.chain = result.then(
      () => undefined,
      () => undefined
    );

    return await result;
  }
}

export class BusyError extends Error {
  constructor(readonly maxDepth: number) {
    super(`Already handling ${maxDepth} requests. Wait for one to finish.`);
    this.name = "BusyError";
  }
}
