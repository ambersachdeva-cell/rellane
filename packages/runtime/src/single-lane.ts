import { RuntimeBoundaryError } from "./errors.js";

interface QueueEntry<T> {
  id: string;
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface ActiveEntry {
  id: string;
  controller: AbortController;
}

export class SingleLaneScheduler {
  private readonly queue: QueueEntry<unknown>[] = [];
  private active: ActiveEntry | null = null;
  private poisonedError: RuntimeBoundaryError | null = null;

  constructor(private readonly maximumQueuedOperations = 4) {}

  enqueue<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.add(id, task, false);
  }

  enqueuePriorityBarrier<T>(
    id: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.add(id, task, true);
  }

  private add<T>(
    id: string,
    task: (signal: AbortSignal) => Promise<T>,
    priority: boolean
  ): Promise<T> {
    if (this.poisonedError !== null) {
      return Promise.reject(this.poisonedError);
    }
    if (this.active?.id === id || this.queue.some((entry) => entry.id === id)) {
      return Promise.reject(new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "An operation with this ID already exists.",
        retryable: false
      }));
    }
    if (!priority && this.queue.length >= this.maximumQueuedOperations) {
      return Promise.reject(new RuntimeBoundaryError({
        code: "BUSY",
        message: "The local model queue is full. Wait for an operation to finish or cancel one.",
        retryable: true
      }));
    }

    return new Promise<T>((resolve, reject) => {
      const entry = {
        id,
        task,
        resolve: (value: unknown) => resolve(value as T),
        reject
      };
      if (priority) {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }
      this.pump();
    });
  }

  cancel(id: string): boolean {
    if (this.active?.id === id) {
      this.active.controller.abort();
      return true;
    }

    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return false;
    }
    const [entry] = this.queue.splice(index, 1);
    entry?.reject(new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The queued local operation was cancelled.",
      retryable: true
    }));
    return true;
  }

  /**
   * Permanently closes this process's GPU lane after an unsafe native-process
   * cleanup failure. Recovery requires a fresh daemon process.
   */
  poison(error: RuntimeBoundaryError): void {
    if (this.poisonedError !== null) {
      return;
    }
    this.poisonedError = error;
    this.active?.controller.abort(error);
    for (const entry of this.queue.splice(0)) {
      entry.reject(error);
    }
  }

  isPoisoned(): boolean {
    return this.poisonedError !== null;
  }

  snapshot(): { activeId: string | null; queuedIds: string[] } {
    return {
      activeId: this.active?.id ?? null,
      queuedIds: this.queue.map((entry) => entry.id)
    };
  }

  private pump(): void {
    if (this.active !== null || this.poisonedError !== null) {
      return;
    }
    const entry = this.queue.shift();
    if (entry === undefined) {
      return;
    }

    const controller = new AbortController();
    this.active = { id: entry.id, controller };
    void entry.task(controller.signal)
      .then(
        (value: unknown) => {
          if (this.poisonedError !== null) {
            entry.reject(this.poisonedError);
            return;
          }
          entry.resolve(value);
        },
        (error: unknown) => {
          entry.reject(this.poisonedError ?? error);
        }
      )
      .finally(() => {
        this.active = null;
        this.pump();
      });
  }
}
