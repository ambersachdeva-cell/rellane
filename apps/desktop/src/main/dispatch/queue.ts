/**
 * Mark's dispatch queue: work sent from a phone to a Mac that may not be awake.
 *
 * The design decision that matters is that **presence is a first-class state,
 * not an error**. A task sent to a sleeping Mac is not a failure — it is
 * queued, and the person is told so immediately. The failure mode this exists
 * to prevent is the one every remote-control tool has: you text it, nothing
 * happens, and you find out hours later that nothing was ever going to happen.
 *
 * Pure state machine. No timers, no I/O, no clock of its own — the caller
 * supplies `now`, which makes every transition reproducible in a test.
 */

export type Presence =
  /** Running and able to take work. */
  | "awake"
  /** Running but already executing something. */
  | "busy"
  /** Machine is asleep. Work queues and runs on wake. */
  | "asleep"
  /** Rellane is not running at all. Nothing can be queued or promised. */
  | "offline";

export type TaskState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "declined"
  /** Sat in the queue past its usefulness and was dropped, with the sender told. */
  | "expired";

export interface DispatchTask {
  readonly id: string;
  /** Where it came from, so the answer goes back the same way. */
  readonly channel: "telegram" | "whatsapp" | "email";
  readonly from: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly state: TaskState;
  readonly startedAt?: number | undefined;
  readonly finishedAt?: number | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * How long a queued task stays worth doing.
 *
 * Two hours, because the common case is a Mac that wakes within the working
 * day, and because silently running something the person asked for this
 * morning at eleven at night is its own kind of wrong.
 */
export const TASK_TTL_MS = 2 * 60 * 60_000;

/** One task at a time. Concurrency here means two skills writing the same folder. */
export const MAX_CONCURRENT = 1;

export interface QueueSnapshot {
  readonly presence: Presence;
  readonly tasks: readonly DispatchTask[];
}

export class DispatchQueue {
  private tasks: DispatchTask[] = [];
  private presence: Presence = "offline";

  snapshot(): QueueSnapshot {
    return { presence: this.presence, tasks: [...this.tasks] };
  }

  setPresence(presence: Presence): void {
    this.presence = presence;
  }

  currentPresence(): Presence {
    return this.presence;
  }

  /**
   * Accepts a task, or explains why it cannot be accepted.
   *
   * The reply is returned rather than sent, because this class does not own a
   * channel — the caller does, and the caller is what gets tested for whether
   * the person was actually told.
   */
  accept(
    input: { id: string; channel: DispatchTask["channel"]; from: string; text: string },
    now: number
  ): { accepted: boolean; task?: DispatchTask; reply: string } {
    if (this.presence === "offline") {
      return {
        accepted: false,
        reply:
          "Rellane is not running on your Mac right now, so I cannot queue this. Open it and send this again."
      };
    }

    const trimmed = input.text.trim();
    if (trimmed.length === 0) {
      return { accepted: false, reply: "There was no instruction in that message." };
    }

    const task: DispatchTask = {
      id: input.id,
      channel: input.channel,
      from: input.from,
      text: trimmed,
      receivedAt: now,
      state: "queued"
    };
    this.tasks.push(task);

    return {
      accepted: true,
      task,
      reply: this.acceptanceReply(now)
    };
  }

  /**
   * What the person is told the moment they send something.
   *
   * Never "OK" when it is not OK yet. A sleeping Mac says so, with the
   * consequence, so nobody sits waiting for an answer that is not coming until
   * the lid opens.
   */
  private acceptanceReply(now: number): string {
    // Counts the running task too. Excluding it undercounted by one and told
    // somebody they were next when a job was already occupying the only slot.
    const ahead =
      this.tasks.filter((task) => task.state === "queued" || task.state === "running").length - 1;
    if (this.presence === "asleep") {
      return ahead > 0
        ? `Your Mac is asleep. This is queued behind ${ahead} other ${ahead === 1 ? "task" : "tasks"} and will run when it wakes.`
        : "Your Mac is asleep. This is queued and will run the moment it wakes.";
    }
    if (this.presence === "busy" || ahead > 0) {
      return ahead > 0
        ? `Queued behind ${ahead} other ${ahead === 1 ? "task" : "tasks"}.`
        : "Queued — something else is running first.";
    }
    void now;
    return "On it.";
  }

  /** The next task to run, or null when nothing should start right now. */
  /**
   * The next task to run, or null.
   *
   * A pure query: it used to call `expire()` and **discard the result**, so any
   * task that timed out during a long drain was marked expired and dropped with
   * nobody told — against this module's one rule, that the person always hears
   * back. Expiry is now the caller's move, because only the caller can send.
   */
  next(now: number): DispatchTask | null {
    if (this.presence !== "awake") {
      return null;
    }
    if (this.tasks.some((task) => task.state === "running")) {
      return null;
    }
    // Skips anything already past its life without marking it. Marking is
    // `expire()`'s job, because only the caller can tell the sender — and this
    // must still never hand out a task that has timed out.
    return (
      this.tasks.find(
        (task) => task.state === "queued" && now - task.receivedAt <= TASK_TTL_MS
      ) ?? null
    );
  }

  markRunning(id: string, now: number): void {
    this.update(id, (task) => ({ ...task, state: "running", startedAt: now }));
  }

  markDone(id: string, result: string, now: number): void {
    this.update(id, (task) => ({ ...task, state: "done", finishedAt: now, result }));
  }

  markFailed(id: string, error: string, now: number): void {
    this.update(id, (task) => ({ ...task, state: "failed", finishedAt: now, error }));
  }

  markDeclined(id: string, reason: string, now: number): void {
    this.update(id, (task) => ({ ...task, state: "declined", finishedAt: now, error: reason }));
  }

  /**
   * Drops tasks that waited too long, returning them so the sender can be told.
   *
   * Expiring silently would be the same failure as never running them.
   */
  expire(now: number): readonly DispatchTask[] {
    const expired: DispatchTask[] = [];
    this.tasks = this.tasks.map((task) => {
      if (task.state === "queued" && now - task.receivedAt > TASK_TTL_MS) {
        const dropped: DispatchTask = { ...task, state: "expired", finishedAt: now };
        expired.push(dropped);
        return dropped;
      }
      return task;
    });
    return expired;
  }

  /** Everything still waiting, oldest first. */
  pending(): readonly DispatchTask[] {
    return this.tasks.filter((task) => task.state === "queued");
  }

  get(id: string): DispatchTask | null {
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  /** Drops finished tasks older than the window, to bound memory. */
  prune(now: number, keepMs = 24 * 60 * 60_000): void {
    this.tasks = this.tasks.filter((task) => {
      const finished = task.finishedAt;
      return finished === undefined || now - finished < keepMs;
    });
  }

  private update(id: string, change: (task: DispatchTask) => DispatchTask): void {
    this.tasks = this.tasks.map((task) => (task.id === id ? change(task) : task));
  }
}

/** What the person is told when a task finishes. */
export function completionReply(task: DispatchTask): string {
  switch (task.state) {
    case "done":
      return task.result ?? "Done.";
    case "failed":
      return `That did not work: ${task.error ?? "unknown problem"}.`;
    case "declined":
      return task.error ?? "I am not allowed to do that.";
    case "expired":
      return `I never got to “${task.text}” — your Mac stayed asleep for two hours, so I dropped it rather than doing it late. Send it again if you still want it.`;
    default:
      return "Still working.";
  }
}
