import assert from "node:assert/strict";
import test from "node:test";

import {
  ARGON2_CONCURRENCY_LIMIT,
  ARGON2_QUEUE_DEPTH,
  ARGON2_WAIT_TIMEOUT_MS,
  Argon2BusyError,
  Argon2Gate,
  type Argon2GateTimer,
} from "../../src/auth/argon2-gate.js";

type TimerHandle = ReturnType<typeof setTimeout>;

class ManualTimer implements Argon2GateTimer {
  readonly callbacks = new Map<TimerHandle, () => void>();
  #nextHandle = 1;

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    assert.equal(delayMs, ARGON2_WAIT_TIMEOUT_MS);
    const handle = this.#nextHandle as unknown as TimerHandle;
    this.#nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.callbacks.delete(handle);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

async function occupySlots(gate: Argon2Gate): Promise<{
  readonly blockers: ReturnType<typeof deferred>[];
  readonly operations: Promise<void>[];
}> {
  const blockers = Array.from(
    { length: ARGON2_CONCURRENCY_LIMIT },
    () => deferred(),
  );
  const operations = blockers.map((blocker) =>
    gate.run(() => blocker.promise),
  );
  await Promise.resolve();
  assert.equal(gate.getSnapshot().active, ARGON2_CONCURRENCY_LIMIT);
  return { blockers, operations };
}

test("never runs more than three operations concurrently", async () => {
  const gate = new Argon2Gate();
  let active = 0;
  let peak = 0;

  const operations = Array.from({ length: 12 }, () =>
    gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }),
  );

  await Promise.all(operations);
  assert.equal(peak, ARGON2_CONCURRENCY_LIMIT);
  assert.deepEqual(gate.getSnapshot(), {
    active: 0,
    waiting: 0,
    operationsStarted: 12,
  });
});

test("accepts ten waiters and rejects the eleventh immediately as busy", async () => {
  const timer = new ManualTimer();
  const gate = new Argon2Gate(timer);
  const occupied = await occupySlots(gate);
  const queued = Array.from({ length: ARGON2_QUEUE_DEPTH }, () =>
    gate.run(async () => undefined),
  );

  assert.equal(gate.getSnapshot().waiting, ARGON2_QUEUE_DEPTH);
  const queueFullError = await gate.run(async () => undefined).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(queueFullError instanceof Argon2BusyError);
  assert.equal(gate.getSnapshot().waiting, ARGON2_QUEUE_DEPTH);

  for (const blocker of occupied.blockers) {
    blocker.resolve();
  }
  await Promise.all([...occupied.operations, ...queued]);
});

test("queue timeout and queue full expose the same internal busy shape", async () => {
  const fullTimer = new ManualTimer();
  const fullGate = new Argon2Gate(fullTimer);
  const fullOccupied = await occupySlots(fullGate);
  const fullQueued = Array.from({ length: ARGON2_QUEUE_DEPTH }, () =>
    fullGate.run(async () => undefined),
  );
  const fullErrorPromise = fullGate.run(async () => undefined).then(
    () => undefined,
    (error: unknown) => error,
  );
  const fullError = await fullErrorPromise;

  const timeoutTimer = new ManualTimer();
  const timeoutGate = new Argon2Gate(timeoutTimer);
  const timeoutOccupied = await occupySlots(timeoutGate);
  const timeoutErrorPromise = timeoutGate.run(async () => undefined).then(
    () => undefined,
    (error: unknown) => error,
  );
  timeoutTimer.fireAll();
  const timeoutError = await timeoutErrorPromise;

  assert.ok(fullError instanceof Argon2BusyError);
  assert.ok(timeoutError instanceof Argon2BusyError);
  assert.deepEqual(
    {
      name: timeoutError.name,
      code: timeoutError.code,
      message: timeoutError.message,
    },
    {
      name: fullError.name,
      code: fullError.code,
      message: fullError.message,
    },
  );

  for (const blocker of fullOccupied.blockers) {
    blocker.resolve();
  }
  for (const blocker of timeoutOccupied.blockers) {
    blocker.resolve();
  }
  await Promise.all([...fullOccupied.operations, ...fullQueued]);
  await Promise.all(timeoutOccupied.operations);
});
