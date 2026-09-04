#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const candidatePath = path.join(
  repositoryRoot,
  "ops/nginx/release-traffic-closed.conf.example",
);
const runbookPath = path.join(
  repositoryRoot,
  "docs/ops/consolidated-release-runbook.md",
);

const candidateSource = readFileSync(candidatePath, "utf8");
const uncommentedCandidate = candidateSource
  .split("\n")
  .map((line) => line.replace(/\s*#.*$/, ""))
  .join("\n");

assert.match(
  candidateSource,
  /RUNTIME_TLS_DIRECTIVES_REQUIRED/,
  "candidate must identify the runtime-only TLS assembly point",
);

const serverBlocks = [];
const serverPattern = /\bserver\s*\{/g;
const blockRanges = [];
let serverMatch;
while ((serverMatch = serverPattern.exec(uncommentedCandidate)) !== null) {
  const blockStart = serverMatch.index;
  let depth = 1;
  let cursor = serverPattern.lastIndex;
  for (; cursor < uncommentedCandidate.length && depth > 0; cursor += 1) {
    if (uncommentedCandidate[cursor] === "{") depth += 1;
    if (uncommentedCandidate[cursor] === "}") depth -= 1;
  }
  assert.equal(depth, 0, "candidate contains an unclosed server block");
  serverBlocks.push(
    uncommentedCandidate.slice(serverPattern.lastIndex, cursor - 1),
  );
  blockRanges.push([blockStart, cursor]);
  serverPattern.lastIndex = cursor;
}

assert.equal(
  serverBlocks.length,
  2,
  "candidate must contain exactly one HTTP and one HTTPS server",
);

let outsideServerBlocks = uncommentedCandidate;
for (const [start, end] of blockRanges.toReversed()) {
  outsideServerBlocks =
    outsideServerBlocks.slice(0, start) + outsideServerBlocks.slice(end);
}
assert.equal(
  outsideServerBlocks.trim(),
  "",
  "candidate must not contain directives outside its two public servers",
);

const normalizedBlocks = serverBlocks.map((block) =>
  block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

for (const directives of normalizedBlocks) {
  assert.ok(
    directives.every((directive) =>
      /^(listen|server_name|add_header|return)\b.*;$/.test(directive),
    ),
    "closed candidate may contain only listen, server_name, add_header, and return directives",
  );
  assert.equal(
    directives.filter((directive) => directive === "return 503;").length,
    1,
    "each public server must terminate at exactly one return 503",
  );
  assert.ok(
    directives.includes("server_name siqiapparel.com www.siqiapparel.com;"),
    "each public server must cover both approved hostnames",
  );
  assert.ok(
    directives.includes('add_header Cache-Control "no-store" always;'),
    "each public server must prevent caching the closed response",
  );
  assert.ok(
    directives.includes('add_header Retry-After "300" always;'),
    "each public server must publish a bounded retry hint",
  );
}

assert.deepEqual(
  normalizedBlocks[0].filter((directive) => directive.startsWith("listen ")),
  ["listen 80;", "listen [::]:80;"],
  "HTTP server must cover IPv4 and IPv6 port 80 only",
);
assert.deepEqual(
  normalizedBlocks[1].filter((directive) => directive.startsWith("listen ")),
  ["listen 443 ssl;", "listen [::]:443 ssl;"],
  "HTTPS server must cover IPv4 and IPv6 port 443 only",
);

const runbookSource = readFileSync(runbookPath, "utf8");
for (const requiredFragment of [
  "ops/nginx/release-traffic-closed.conf.example",
  "CLOSED_NGINX_INVARIANT",
  "FULL_INGRESS: CLOSED",
  "APPLICATION_DB_WRITERS: ZERO",
  "DATABASE_RESTORE_ELIGIBILITY: ENDED",
]) {
  assert.ok(
    runbookSource.includes(requiredFragment),
    `runbook is missing required release invariant: ${requiredFragment}`,
  );
}

console.log("release traffic gate static validation: PASS");
