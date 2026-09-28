import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TicketApiError,
  closeAdminTicket,
  createMyTicket,
  getMyTicket,
  listMyTickets,
  replyToMyTicket,
  ticketErrorMessage,
} from "../app/lib/tickets-api.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const REF = "TK0123456789ABCDEF";
const NOW = "2026-09-28T00:00:00.000Z";
const detail = {
  ref: REF,
  subject: "Latency",
  status: "open",
  serviceOrderRef: null,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  messageCount: 1,
  lastMessageRole: "customer",
  messages: [{ role: "customer", body: "<img src=x onerror=alert(1)>", createdAt: NOW }],
};

type Call = { readonly url: string; readonly init: RequestInit };

async function withFetch<Result>(
  respond: (call: Call) => { status: number; body: unknown },
  run: (calls: Call[]) => Promise<Result>,
): Promise<Result> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("customer writes send the session CSRF token and only allowed fields", async () => {
  await withFetch((call) => ({
    status: 200,
    body: { ticket: call.url.startsWith("/api/admin/") ? { ...detail, customerEmail: "customer@example.test" } : detail },
  }), async (calls) => {
    const created = await createMyTicket("c".repeat(43), { subject: "Latency", body: "hello", serviceOrderRef: null });
    // Message bodies stay raw strings; the page renders them as text, never HTML.
    assert.equal(created.messages[0]?.body, "<img src=x onerror=alert(1)>");
    await replyToMyTicket("c".repeat(43), REF, "more");
    await closeAdminTicket("c".repeat(43), REF);
    assert.deepEqual(calls.map((call) => call.url), [
      "/api/me/tickets",
      `/api/me/tickets/${REF}/messages`,
      `/api/admin/tickets/${REF}/status`,
    ]);
    for (const call of calls) {
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.credentials, "same-origin");
      assert.equal((call.init.headers as Record<string, string>)["X-CSRF-Token"], "c".repeat(43));
    }
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { subject: "Latency", body: "hello" });
    assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { status: "closed" });
  });
});

test("the service link is sent only when chosen and never an owner or role field", async () => {
  await withFetch(() => ({ status: 200, body: { ticket: detail } }), async (calls) => {
    await createMyTicket("c".repeat(43), { subject: "s", body: "b", serviceOrderRef: "DL00000001ABCDEF" });
    const payload = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(Object.keys(payload).sort(), ["body", "serviceOrderRef", "subject"]);
  });
});

test("malformed refs never reach the network and server errors keep their codes", async () => {
  await withFetch(() => ({ status: 404, body: { error: { code: "not_found" } } }), async (calls) => {
    await assert.rejects(getMyTicket("../admin"), (error: unknown) => error instanceof TicketApiError && error.code === "not_found");
    assert.equal(calls.length, 0);
    await assert.rejects(getMyTicket(REF), (error: unknown) => error instanceof TicketApiError && error.code === "not_found" && error.status === 404);
    assert.equal(calls.length, 1);
  });
  assert.equal(ticketErrorMessage(new TicketApiError("ticket_closed", 409)), "该工单已关闭，无法继续回复。");
  assert.equal(ticketErrorMessage(new TicketApiError("csrf_invalid", 403)), "登录状态已变化，请刷新页面后重试。");
});

test("unexpected response shapes fail closed", async () => {
  for (const body of [
    { items: [{ ...detail, status: "pending" }], page: 1, hasMore: false },
    { items: [{ ...detail, ref: "bad" }], page: 1, hasMore: false },
    { items: [], page: 0, hasMore: false },
    { items: "x", page: 1, hasMore: false },
  ]) {
    await withFetch(() => ({ status: 200, body }), async () => {
      await assert.rejects(listMyTickets(1), (error: unknown) => error instanceof TicketApiError && error.code === "invalid_response");
    });
  }
});

test("ticket pages render plain text only and promise no SLA, notifications, or attachments", () => {
  const page = source("../app/components/customer/CustomerTicketsPage.tsx");
  const admin = source("../app/components/dashboard/AdminTicketsPanel.tsx");
  const css = source("../app/components/customer/customer-tickets.css");
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of [page, admin]) {
    assert.doesNotMatch(file, /dangerouslySetInnerHTML|innerHTML/);
    assert.match(file, /<p className="cc-tk-body">\{message\.body\}<\/p>/);
    assert.doesNotMatch(withoutComments(file), /小时内|分钟内|工作日内|满意度|附件|上传|邮件通知|短信/);
  }
  assert.match(css, /\.cc-tk-body \{[^}]*white-space: pre-wrap;/);
  // Signed-out recovery is a full-page navigation, as on the orders page.
  assert.match(page, /<a className="cc-ord-primary" href="\/login">重新登录<\/a>/);
  assert.match(page, /ticket\.status === "closed"/);
});

test("the tickets section is wired into the shell, dashboard, and admin-only panel", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  const dashboard = source("../app/components/dashboard/DashboardPage.tsx");
  assert.match(shell, /"\/tickets",\n\]\);/);
  assert.match(dashboard, /\{ href: "\/tickets", label: "工单"/);
  assert.doesNotMatch(dashboard, /pendingActions|工单", hint: "待接入"/);
  assert.match(dashboard, /\{principal\?\.role === "admin" && <AdminTicketsPanel csrfToken=\{csrfToken\} \/>\}/);
});
