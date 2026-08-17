export const ARGON2_CONCURRENCY_LIMIT = 3;
export const ARGON2_QUEUE_DEPTH = 10;
export const ARGON2_WAIT_TIMEOUT_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface Argon2GateTimer {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

interface QueueEntry {
  settled: boolean;
  timer: TimerHandle | undefined;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Argon2BusyError) => void;
}

export interface Argon2GateSnapshot {
  readonly active: number;
  readonly waiting: number;
  readonly operationsStarted: number;
}

const systemTimer: Argon2GateTimer = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
};

export class Argon2BusyError extends Error {
  readonly code = "busy";

  constructor() {
    super("Argon2 capacity is busy");
    this.name = "Argon2BusyError";
  }
}

export class Argon2Gate {
  readonly #timer: Argon2GateTimer;
  readonly #queue: QueueEntry[] = [];
  #active = 0;
  #operationsStarted = 0;

  constructor(timer: Argon2GateTimer = systemTimer) {
    this.#timer = timer;
  }

  getSnapshot(): Argon2GateSnapshot {
    return {
      active: this.#active,
      waiting: this.#queue.length,
      operationsStarted: this.#operationsStarted,
    };
  }

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const release = await this.#acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(): Promise<() => void> {
    if (this.#active < ARGON2_CONCURRENCY_LIMIT) {
      return Promise.resolve(this.#reserveSlot());
    }

    if (this.#queue.length >= ARGON2_QUEUE_DEPTH) {
      return Promise.reject(new Argon2BusyError());
    }

    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        settled: false,
        timer: undefined,
        resolve,
        reject,
      };

      entry.timer = this.#timer.setTimeout(() => {
        if (entry.settled) {
          return;
        }

        entry.settled = true;
        const index = this.#queue.indexOf(entry);
        if (index >= 0) {
          this.#queue.splice(index, 1);
        }
        entry.reject(new Argon2BusyError());
      }, ARGON2_WAIT_TIMEOUT_MS);

      this.#queue.push(entry);
    });
  }

  #reserveSlot(): () => void {
    this.#active += 1;
    this.#operationsStarted += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.#active -= 1;
      this.#drainQueue();
    };
  }

  #drainQueue(): void {
    while (
      this.#active < ARGON2_CONCURRENCY_LIMIT &&
      this.#queue.length > 0
    ) {
      const entry = this.#queue.shift();
      if (entry === undefined || entry.settled) {
        continue;
      }

      entry.settled = true;
      if (entry.timer !== undefined) {
        this.#timer.clearTimeout(entry.timer);
      }
      entry.resolve(this.#reserveSlot());
    }
  }
}

export const argon2Gate = new Argon2Gate();

export function isArgon2BusyError(error: unknown): error is Argon2BusyError {
  return error instanceof Argon2BusyError;
}
