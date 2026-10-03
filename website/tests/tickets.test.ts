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
    const created = await createMyTicket("c".repeat(43), { subject: "Latency", body: "hello", link: null });
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
    await createMyTicket("c".repeat(43), { subject: "s", body: "b", link: { kind: "purchase", orderRef: "DL00000001ABCDEF" } });
    await createMyTicket("c".repeat(43), { subject: "s", body: "b", link: { kind: "grant", grantId: 7 } });
    const purchase = JSON.parse(String(calls[0]?.init.body));
    const grant = JSON.parse(String(calls[1]?.init.body));
    assert.deepEqual(Object.keys(purchase).sort(), ["body", "serviceOrderRef", "subject"]);
    // Purchase and gift links are mutually exclusive, as the server requires.
    assert.deepEqual(grant, { subject: "s", body: "b", serviceGrantId: 7 });
  });
});

const IMAGE = { contentType: "image/png" as const, dataBase64: "iVBORw0KGgo=" };

test("images are sent only when chosen, as exact {contentType, dataBase64} entries, at most three", async () => {
  await withFetch(() => ({ status: 200, body: { ticket: detail } }), async (calls) => {
    await createMyTicket("c".repeat(43), { subject: "s", body: "b", link: null, attachments: [] });
    await createMyTicket("c".repeat(43), { subject: "s", body: "b", link: null, attachments: [IMAGE] });
    await replyToMyTicket("c".repeat(43), REF, "more", [IMAGE, IMAGE]);
    await replyToMyTicket("c".repeat(43), REF, "plain");
    const bodies = calls.map((call) => JSON.parse(String(call.init.body)));
    assert.deepEqual(bodies[0], { subject: "s", body: "b" });
    assert.deepEqual(bodies[1], { subject: "s", body: "b", attachments: [IMAGE] });
    assert.deepEqual(bodies[2], { body: "more", attachments: [IMAGE, IMAGE] });
    assert.deepEqual(bodies[3], { body: "plain" });
    await assert.rejects(
      replyToMyTicket("c".repeat(43), REF, "x", [IMAGE, IMAGE, IMAGE, IMAGE]),
      (error: unknown) => error instanceof TicketApiError && error.code === "invalid_attachments",
    );
    assert.equal(calls.length, 4);
  });
});

test("attachment URLs must be the same-origin ticket endpoint the client rebuilds", async () => {
  const ATTACHMENT = "TA0123456789ABCDEF";
  const withImage = (url: string, extra: Record<string, unknown> = {}) => ({
    ...detail,
    serviceGrantId: 7,
    messages: [{ ...detail.messages[0], attachments: [{ ref: ATTACHMENT, contentType: "image/webp", byteSize: 42, url }] }],
    ...extra,
  });
  await withFetch(() => ({ status: 200, body: { ticket: withImage(`/api/me/tickets/${REF}/attachments/${ATTACHMENT}`) } }), async () => {
    const ticket = await getMyTicket(REF);
    assert.equal(ticket.serviceGrantId, 7);
    assert.deepEqual(ticket.messages[0]?.attachments, [
      { ref: ATTACHMENT, contentType: "image/webp", byteSize: 42, url: `/api/me/tickets/${REF}/attachments/${ATTACHMENT}` },
    ]);
  });
  for (const bad of [
    "https://evil.example/x.png",
    `/api/admin/tickets/${REF}/attachments/${ATTACHMENT}`,
    `/api/me/tickets/TK0000000000000000/attachments/${ATTACHMENT}`,
  ]) {
    await withFetch(() => ({ status: 200, body: { ticket: withImage(bad) } }), async () => {
      await assert.rejects(getMyTicket(REF), (error: unknown) => error instanceof TicketApiError && error.code === "invalid_response");
    });
  }
  // A ticket cannot link both a purchase and a gift.
  await withFetch(() => ({ status: 200, body: { ticket: withImage(`/api/me/tickets/${REF}/attachments/${ATTACHMENT}`, { serviceOrderRef: "DL00000001ABCDEF" }) } }), async () => {
    await assert.rejects(getMyTicket(REF), (error: unknown) => error instanceof TicketApiError && error.code === "invalid_response");
  });
  // Older servers without the new fields still parse: no gift link, no images.
  await withFetch(() => ({ status: 200, body: { ticket: detail } }), async () => {
    const ticket = await getMyTicket(REF);
    assert.equal(ticket.serviceGrantId, null);
    assert.deepEqual(ticket.messages[0]?.attachments, []);
  });
});

test("image and gift errors map to their own messages", () => {
  assert.equal(ticketErrorMessage(new TicketApiError("image_too_large", 400)), "单张图片不能超过 5MB。");
  for (const code of ["unsupported_image_type", "invalid_image", "image_type_mismatch"]) {
    assert.equal(ticketErrorMessage(new TicketApiError(code, 400)), "图片无法识别，请上传 JPEG、PNG 或 WebP 图片。");
  }
  assert.equal(ticketErrorMessage(new TicketApiError("invalid_attachments", 400)), "每条消息最多附 3 张图片。");
  for (const code of ["ticket_storage_exceeded", "account_storage_exceeded", "storage_limit_exceeded"]) {
    assert.equal(ticketErrorMessage(new TicketApiError(code, 409)), "图片存储空间已满，请减少图片后重试。");
  }
  assert.equal(ticketErrorMessage(new TicketApiError("invalid_grant", 400)), "所选赠送套餐无效或已失效，请重新选择或不关联服务。");
  assert.equal(ticketErrorMessage(new TicketApiError("rate_limited", 429)), "图片发送过于频繁，请稍后重试。");
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

test("ticket pages render plain text only and promise no SLA or notifications; only the customer page takes images", () => {
  const page = source("../app/components/customer/CustomerTicketsPage.tsx");
  const admin = source("../app/components/dashboard/AdminTicketsPanel.tsx");
  const css = source("../app/components/customer/customer-tickets.css");
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of [page, admin]) {
    assert.doesNotMatch(file, /dangerouslySetInnerHTML|innerHTML/);
    assert.match(file, /<p className="cc-tk-body">\{message\.body\}<\/p>/);
    assert.doesNotMatch(withoutComments(file), /小时内|分钟内|工作日内|满意度|邮件通知|短信/);
  }
  // The admin panel still has no attachment UI; the customer page renders images only from parsed same-origin URLs.
  assert.doesNotMatch(withoutComments(admin), /附件|上传|attachments/);
  assert.match(page, /<MessageImages attachments=\{message\.attachments\} copy=\{copy\} \/>/);
  assert.match(page, /<img src=\{attachment\.url\} alt=\{copy\.imageAlt\(index \+ 1\)\} loading="lazy" \/>/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(css, /\.cc-tk-body \{[^}]*white-space: pre-wrap;/);
  // Signed-out recovery is a full-page navigation, as on the orders page.
  assert.match(page, /<a className="cc-ord-primary" href="\/login">\{copy\.signInAgain\}<\/a>/);
  assert.match(page, /ticket\.status === "closed"/);
});

test("the tickets section is wired into the shell, dashboard, and admin-only panel", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  const dashboard = source("../app/components/dashboard/DashboardPage.tsx");
  assert.match(shell, /"\/tickets",\n  "\/invites",\n\]\);/);
  assert.match(dashboard, /const quickActions = \[[^\]]*"\/tickets"[^\]]*\] as const;/);
  assert.match(source("../app/i18n/zh.ts"), /"\/tickets": \{ label: "工单", hint: "提交问题并查看客服回复" \}/);
  assert.doesNotMatch(dashboard, /pendingActions|工单", hint: "待接入"/);
  assert.match(dashboard, /\{principal\?\.role === "admin" && <AdminTicketsPanel csrfToken=\{csrfToken\} \/>\}/);
});
