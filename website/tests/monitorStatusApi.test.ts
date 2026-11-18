import assert from "node:assert/strict";
import test from "node:test";

import {
  getMonitorStatus,
  MONITOR_STATUS_RESPONSE_MAX_BYTES,
  MONITOR_STATUS_TIMEOUT_MS,
  MonitorStatusAbortError,
  MonitorStatusApiError,
  parseMonitorStatusError,
  parseMonitorStatusSuccess,
} from "../app/lib/monitor-status-api.ts";

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof MonitorStatusApiError &&
      error.code === code &&
      error.status === status,
  );
}

test("monitor status client sends one target-free same-origin GET", async () => {
  const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
  const projection = await getMonitorStatus(undefined, async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      label: "账户服务器 A",
      status: "online",
      updatedAt: "2030-01-01T00:01:00Z",
      stale: false,
    });
  });
  assert.deepEqual(projection, {
    label: "账户服务器 A",
    status: "online",
    updatedAt: "2030-01-01T00:01:00Z",
    stale: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/me/monitor-status");
  assert.deepEqual(
    { ...calls[0]?.init, signal: undefined },
    {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: undefined,
    },
  );
  assert.equal(JSON.stringify(calls).includes("target"), false);
  assert.equal(MONITOR_STATUS_TIMEOUT_MS, 7_000);
});

test("monitor status parser accepts only the exact online/offline/stale projection", () => {
  for (const [status, stale] of [
    ["online", false],
    ["offline", false],
    ["stale", true],
  ] as const) {
    assert.deepEqual(parseMonitorStatusSuccess({
      label: "服务器",
      status,
      updatedAt: "2030-01-01T00:01:00Z",
      stale,
    }), {
      label: "服务器",
      status,
      updatedAt: "2030-01-01T00:01:00Z",
      stale,
    });
  }
  for (const value of [
    { label: "服务器", status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: true },
    { label: "服务器", status: "stale", updatedAt: "2030-01-01T00:01:00Z", stale: false },
    { label: "服务器", status: "online", updatedAt: "2030-01-01T00:01:00.000Z", stale: false },
    { label: " 服务器", status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false },
    { label: "服务器", status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false, target: "hidden" },
  ]) {
    assert.throws(() => parseMonitorStatusSuccess(value), MonitorStatusApiError);
  }
});

test("monitor status errors require the exact nested code/status pair", () => {
  for (const [status, code] of [
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "no_eligible_service"],
    [405, "method_not_allowed"],
    [409, "monitor_unbound"],
    [429, "rate_limited"],
    [502, "monitor_invalid_response"],
    [503, "monitor_unconfigured"],
    [503, "monitor_unavailable"],
    [504, "monitor_unavailable"],
  ] as const) {
    const error = parseMonitorStatusError(status, { error: { code } });
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }
  for (const [status, value] of [
    [401, { error: { code: "monitor_unavailable" } }],
    [503, { code: "monitor_unavailable" }],
    [503, { error: { code: "monitor_unavailable", detail: "hidden" } }],
  ] as const) {
    const error = parseMonitorStatusError(status, value);
    assert.equal(error.status, 502);
    assert.equal(error.code, "monitor_invalid_response");
  }
});

test("monitor status client rejects redirects, MIME/cache drift, malformed JSON, and over-limit bodies", async () => {
  await rejectsWith(
    getMonitorStatus(undefined, async () => jsonResponse({}, 302)),
    "monitor_invalid_response",
    502,
  );
  await rejectsWith(
    getMonitorStatus(undefined, async () => jsonResponse({}, 200, { "Content-Type": "text/json" })),
    "monitor_invalid_response",
    502,
  );
  await rejectsWith(
    getMonitorStatus(undefined, async () => jsonResponse({}, 200, { "Cache-Control": "private, no-store" })),
    "monitor_invalid_response",
    502,
  );
  await rejectsWith(
    getMonitorStatus(undefined, async () => new Response("{", {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    })),
    "monitor_invalid_response",
    502,
  );
  await rejectsWith(
    getMonitorStatus(undefined, async () => new Response("x".repeat(MONITOR_STATUS_RESPONSE_MAX_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    })),
    "monitor_invalid_response",
    502,
  );
});

test("monitor status client distinguishes caller abort from transport failure", async () => {
  const controller = new AbortController();
  controller.abort("unmounted");
  await assert.rejects(
    getMonitorStatus(controller.signal, async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new Error("aborted");
    }),
    MonitorStatusAbortError,
  );
  await rejectsWith(
    getMonitorStatus(undefined, async () => {
      throw new Error("network detail");
    }),
    "monitor_unavailable",
    503,
  );
});
