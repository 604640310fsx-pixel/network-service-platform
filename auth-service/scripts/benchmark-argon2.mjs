import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";

import argon2 from "argon2";

const candidates = {
  A: { memoryCost: 32_768, timeCost: 3, parallelism: 1 },
  B: { memoryCost: 65_536, timeCost: 2, parallelism: 1 },
  C: { memoryCost: 65_536, timeCost: 3, parallelism: 1 },
  D: { memoryCost: 65_536, timeCost: 3, parallelism: 2 },
};

const warmupCount = 3;
const sampleCount = 20;
const concurrencyRounds = 10;
const queueRounds = 3;
const queueTaskCount = 13;
const queueConcurrency = 3;
const password = randomBytes(24).toString("base64url");

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

  return {
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
}

function toMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

async function timed(operation) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAt };
}

async function withRuntimeSampler(operation) {
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  let previousTick = performance.now();
  let maxEventLoopDelayMs = 0;

  const sampler = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - previousTick - 10);
    previousTick = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);

  try {
    const value = await operation();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const rssAfter = process.memoryUsage().rss;
    return {
      value,
      runtime: {
        rssBeforeMiB: toMiB(rssBefore),
        rssAfterMiB: toMiB(rssAfter),
        rssDeltaMiB: toMiB(rssAfter - rssBefore),
        sampledPeakRssMiB: toMiB(peakRss),
        sampledPeakDeltaMiB: toMiB(peakRss - rssBefore),
        maxEventLoopDelayMs: Number(Math.max(0, maxEventLoopDelayMs).toFixed(2)),
      },
    };
  } finally {
    clearInterval(sampler);
  }
}

function hashOptions(parameters) {
  return {
    type: argon2.argon2id,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
  };
}

async function warmup(parameters) {
  for (let index = 0; index < warmupCount; index += 1) {
    const encoded = await argon2.hash(password, hashOptions(parameters));
    const verified = await argon2.verify(encoded, password);
    if (!verified || !encoded.startsWith("$argon2id$")) {
      throw new Error("Argon2id warmup verification failed");
    }
  }
}

async function benchmarkCandidate(name, parameters) {
  await warmup(parameters);
  globalThis.gc?.();

  const { value, runtime } = await withRuntimeSampler(async () => {
    const hashes = [];
    const hashDurations = [];
    const verifyDurations = [];

    for (let index = 0; index < sampleCount; index += 1) {
      const result = await timed(() => argon2.hash(password, hashOptions(parameters)));
      hashes.push(result.value);
      hashDurations.push(result.durationMs);
    }

    for (const encoded of hashes) {
      const result = await timed(() => argon2.verify(encoded, password));
      if (!result.value) {
        throw new Error(`Candidate ${name} verification failed`);
      }
      verifyDurations.push(result.durationMs);
    }

    return {
      candidate: name,
      algorithm: "Argon2id",
      parameters,
      warmups: warmupCount,
      samplesPerOperation: sampleCount,
      hash: summarize(hashDurations),
      verify: summarize(verifyDurations),
    };
  });

  return { ...value, runtime };
}

async function benchmarkSequential(parameters) {
  await warmup(parameters);
  const hashes = [];
  const hashDurations = [];
  const verifyDurations = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const result = await timed(() => argon2.hash(password, hashOptions(parameters)));
    hashes.push(result.value);
    hashDurations.push(result.durationMs);
  }

  for (const encoded of hashes) {
    const result = await timed(() => argon2.verify(encoded, password));
    if (!result.value) {
      throw new Error("Sequential verification failed");
    }
    verifyDurations.push(result.durationMs);
  }

  return {
    hash: summarize(hashDurations),
    verify: summarize(verifyDurations),
  };
}

async function benchmarkConcurrent(parameters) {
  const verifyHashes = await Promise.all(
    Array.from({ length: queueConcurrency }, () =>
      argon2.hash(password, hashOptions(parameters)),
    ),
  );

  const hashRoundWalls = [];
  const hashTaskDurations = [];
  const verifyRoundWalls = [];
  const verifyTaskDurations = [];

  for (let round = 0; round < concurrencyRounds; round += 1) {
    const roundStartedAt = performance.now();
    const tasks = await Promise.all(
      Array.from({ length: queueConcurrency }, () =>
        timed(() => argon2.hash(password, hashOptions(parameters))),
      ),
    );
    hashRoundWalls.push(performance.now() - roundStartedAt);
    hashTaskDurations.push(...tasks.map((task) => task.durationMs));
  }

  for (let round = 0; round < concurrencyRounds; round += 1) {
    const roundStartedAt = performance.now();
    const tasks = await Promise.all(
      verifyHashes.map((encoded) => timed(() => argon2.verify(encoded, password))),
    );
    if (tasks.some((task) => !task.value)) {
      throw new Error("Concurrent verification failed");
    }
    verifyRoundWalls.push(performance.now() - roundStartedAt);
    verifyTaskDurations.push(...tasks.map((task) => task.durationMs));
  }

  return {
    concurrency: queueConcurrency,
    roundsPerOperation: concurrencyRounds,
    hashRoundWall: summarize(hashRoundWalls),
    hashPerTask: summarize(hashTaskDurations),
    verifyRoundWall: summarize(verifyRoundWalls),
    verifyPerTask: summarize(verifyTaskDurations),
  };
}

async function runLimitedQueue(parameters) {
  const enqueuedAt = performance.now();
  let nextTask = 0;
  const queueWaits = [];
  const taskDurations = [];

  async function worker() {
    while (nextTask < queueTaskCount) {
      nextTask += 1;
      const startedAt = performance.now();
      queueWaits.push(startedAt - enqueuedAt);
      const result = await timed(() => argon2.hash(password, hashOptions(parameters)));
      taskDurations.push(result.durationMs);
    }
  }

  const workers = Array.from({ length: queueConcurrency }, () => worker());
  await Promise.all(workers);

  return {
    wallMs: performance.now() - enqueuedAt,
    queueWaits,
    taskDurations,
  };
}

async function benchmarkQueue(parameters) {
  const wallDurations = [];
  const queueWaits = [];
  const taskDurations = [];

  for (let round = 0; round < queueRounds; round += 1) {
    const result = await runLimitedQueue(parameters);
    wallDurations.push(result.wallMs);
    queueWaits.push(...result.queueWaits);
    taskDurations.push(...result.taskDurations);
  }

  return {
    concurrency: queueConcurrency,
    waitingCapacity: queueTaskCount - queueConcurrency,
    tasksPerRound: queueTaskCount,
    rounds: queueRounds,
    wall: summarize(wallDurations),
    queueWait: summarize(queueWaits),
    task: summarize(taskDurations),
    waitLimitMs: 5_000,
    waitLimitSatisfied: Math.max(...queueWaits) < 5_000,
  };
}

async function runCandidates() {
  const results = [];
  for (const [name, parameters] of Object.entries(candidates)) {
    results.push(await benchmarkCandidate(name, parameters));
  }
  return {
    mode: "candidates",
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    results,
  };
}

async function runFinal(name) {
  const parameters = candidates[name];
  if (!parameters) {
    throw new Error("Final candidate must be one of A, B, C, or D");
  }

  await warmup(parameters);
  globalThis.gc?.();
  const { value, runtime } = await withRuntimeSampler(async () => ({
    sequential: await benchmarkSequential(parameters),
    concurrent: await benchmarkConcurrent(parameters),
    queue: await benchmarkQueue(parameters),
  }));

  return {
    mode: "final",
    candidate: name,
    algorithm: "Argon2id",
    parameters,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ...value,
    runtime,
  };
}

const [mode = "candidates", candidateName] = process.argv.slice(2);
const output = mode === "final" ? await runFinal(candidateName) : await runCandidates();
console.log(JSON.stringify(output, null, 2));
