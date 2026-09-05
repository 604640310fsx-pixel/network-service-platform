import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAdminInviteCode,
  getAdminInviteCodes,
  InviteAdminApiError,
} from "../app/lib/invite-admin-api.ts";

const EXPIRES_AT = "2026-09-20T00:00:00.000Z";
const CREATED_AT = "2026-09-05T00:00:00.000Z";
const INVITE_CODE = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";

function item(
  recipientEmailMasked: string | null = "a***e@example.com",
): Record<string, unknown> {
  return {
    id: 7,
    isBootstrap: false,
    status: "usable",
    maxUses: 1,
    usedCount: 0,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    createdAt: CREATED_AT,
    recipientEmailMasked,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("admin create sends only recipientEmail and expiresAt and accepts the one-time code", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ item: item(), inviteCode: INVITE_CODE }, 201);
  }) as typeof fetch;
  try {
    const created = await createAdminInviteCode(
      "csrf-token",
      "alice@example.com",
      EXPIRES_AT,
    );
    assert.equal(capturedUrl, "/api/admin/invite-codes");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.credentials, "same-origin");
    assert.equal(
      capturedInit?.body,
      JSON.stringify({
        recipientEmail: "alice@example.com",
        expiresAt: EXPIRES_AT,
      }),
    );
    assert.deepEqual(capturedInit?.headers, {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-token",
    });
    assert.equal(created.inviteCode, INVITE_CODE);
    assert.equal(created.item.recipientEmailMasked, "a***e@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin list accepts exact masks and legacy null while rejecting raw or malformed recipient values", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      jsonResponse({
        items: [
          item("*@example.com"),
          { ...item("a*@example.com"), id: 8 },
          { ...item("a***e@example.com"), id: 9 },
          {
            ...item(null),
            id: 10,
            isBootstrap: true,
            status: "revoked",
          },
        ],
        total: 4,
      })) as typeof fetch;
    const listed = await getAdminInviteCodes();
    assert.deepEqual(
      listed.items.map((value) => value.recipientEmailMasked),
      ["*@example.com", "a*@example.com", "a***e@example.com", null],
    );

    for (const invalidMask of [
      "alice@example.com",
      "a**e@example.com",
      "a****e@example.com",
      "*@",
      "",
      undefined,
    ]) {
      globalThis.fetch = (async () =>
        jsonResponse({
          items: [{ ...item(), recipientEmailMasked: invalidMask }],
          total: 1,
        })) as typeof fetch;
      await assert.rejects(
        getAdminInviteCodes(),
        (error: unknown) =>
          error instanceof InviteAdminApiError &&
          error.code === "invalid_response",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin invite UI is admin-only, binds email, and keeps plaintext transient", () => {
  const panel = readFileSync(
    new URL(
      "../app/components/dashboard/AdminInviteCodesPanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const dashboard = readFileSync(
    new URL("../app/components/dashboard/DashboardPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    dashboard,
    /principal\?\.role === "admin" && <AdminInviteCodesPanel csrfToken=\{csrfToken\} \/>/,
  );
  assert.match(panel, /type="email"/);
  assert.match(panel, /收件邮箱/);
  assert.doesNotMatch(panel, /最大使用次数|setMaxUses/);
  assert.match(
    panel,
    /setCreatedCode\(null\);[\s\S]*?await createAdminInviteCode/,
  );
  assert.match(panel, /setCreatedCode\(created\.inviteCode\)/);
  assert.match(panel, /newCode|新邀请码（仅显示一次）/);
  assert.match(panel, /未绑定 · 已失效/);
  assert.match(panel, /await getAdminInviteCodes\(\)/);
  assert.match(panel, /navigator\.clipboard\.writeText\(createdCode\)/);
  assert.doesNotMatch(
    panel,
    /localStorage|sessionStorage|indexedDB|document\.cookie|console\./,
  );
});
