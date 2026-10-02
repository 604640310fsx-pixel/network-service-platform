import assert from "node:assert/strict";
import test from "node:test";

import type { MailDelivery } from "../../src/registration/mail-dispatcher.js";
import {
  ResendMailTransport,
  ResendMailTransportError,
  type ResendMailTransportConfig,
} from "../../src/registration/resend-mail-transport.js";

const TEST_API_KEY = "test-api-key";
const CONFIG: ResendMailTransportConfig = {
  apiKey: TEST_API_KEY,
  fromEmail: "No-Reply@Example.com",
  requestTimeoutMs: 100,
  dispatcherLeaseMs: 1_000,
};
const DELIVERY = {
  idempotencyKey: "register-otp-v1:41:1",
  toEmail: "Recipient@Example.com",
  template: "verification_code",
  verificationCode: "042917",
} as const satisfies MailDelivery;

function successResponse(id = "email_example-123"): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function rejectedError(action: () => Promise<void>): Promise<Error> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught;
}

function assertSafeDeliveryFailure(error: Error): void {
  assert.ok(error instanceof ResendMailTransportError);
  assert.equal(error.message, "Mail delivery failed");
  const serialized = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  for (const privateValue of [
    TEST_API_KEY,
    DELIVERY.toEmail,
    DELIVERY.verificationCode,
    "private provider response",
    "private network failure",
    "private response body",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
}

test("sends a plain-text verification email to the fixed Resend endpoint", async () => {
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const transport = new ResendMailTransport(
    CONFIG,
    async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return successResponse();
    },
  );

  await transport.send(DELIVERY);

  assert.equal(capturedInput, "https://api.resend.com/emails");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TEST_API_KEY}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(
    headers.get("idempotency-key"),
    DELIVERY.idempotencyKey,
  );
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  assert.equal(capturedInit.signal.aborted, false);

  const capturedBody = capturedInit.body;
  assert.equal(typeof capturedBody, "string");
  if (typeof capturedBody !== "string") {
    assert.fail("Expected a JSON request body");
  }
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.deepEqual(body, {
    from: "no-reply@example.com",
    to: ["recipient@example.com"],
    subject: "Drink Life 验证码",
    text:
      "您的邮箱验证码是：042917\n\n" +
      "此验证码仅用于验证您对该邮箱的访问。收到并验证验证码不代表邀请码仍然有效，也不代表注册一定成功。请勿转发。",
  });
  assert.equal(capturedBody.includes(TEST_API_KEY), false);
  assert.equal("html" in body, false);
});

test("accepts only a successful provider response with an opaque email id", async () => {
  for (const response of [
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ id: "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ id: "bad id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    const transport = new ResendMailTransport(CONFIG, async () => response);
    assertSafeDeliveryFailure(
      await rejectedError(() => transport.send(DELIVERY)),
    );
  }
});

test("discards provider error details and returns one safe failure", async () => {
  const transport = new ResendMailTransport(
    CONFIG,
    async () =>
      new Response(
        JSON.stringify({
          message: "private provider response",
          recipient: DELIVERY.toEmail,
        }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );

  assertSafeDeliveryFailure(
    await rejectedError(() => transport.send(DELIVERY)),
  );
});

test("does not expose network failure details", async () => {
  const transport = new ResendMailTransport(CONFIG, async () => {
    throw new Error(
      `private network failure: ${DELIVERY.toEmail} ${DELIVERY.verificationCode}`,
    );
  });

  assertSafeDeliveryFailure(
    await rejectedError(() => transport.send(DELIVERY)),
  );
});

test("aborts a request before the dispatcher lease expires", async () => {
  let observedSignal: AbortSignal | undefined;
  const transport = new ResendMailTransport(
    {
      ...CONFIG,
      requestTimeoutMs: 10,
      dispatcherLeaseMs: 100,
    },
    async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(new Error("private network failure")),
          { once: true },
        );
      });
    },
  );

  assertSafeDeliveryFailure(
    await rejectedError(() => transport.send(DELIVERY)),
  );
  assert.equal(observedSignal?.aborted, true);
});

test("keeps the timeout active while reading the provider response", async () => {
  let observedSignal: AbortSignal | undefined;
  const transport = new ResendMailTransport(
    {
      ...CONFIG,
      requestTimeoutMs: 10,
      dispatcherLeaseMs: 100,
    },
    async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          observedSignal?.addEventListener(
            "abort",
            () => controller.error(new Error("private response body")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assertSafeDeliveryFailure(
    await rejectedError(() => transport.send(DELIVERY)),
  );
  assert.equal(observedSignal?.aborted, true);
});

test("rejects invalid delivery fields before calling the provider", async () => {
  const invalidDeliveries: readonly MailDelivery[] = [
    { ...DELIVERY, idempotencyKey: "" },
    { ...DELIVERY, idempotencyKey: "x".repeat(257) },
    { ...DELIVERY, idempotencyKey: "line\nbreak" },
    { ...DELIVERY, toEmail: "invalid\n@example.com" },
    { ...DELIVERY, verificationCode: "12345" },
    {
      ...DELIVERY,
      template: "unexpected_template",
    } as unknown as MailDelivery,
  ];
  let requests = 0;
  const transport = new ResendMailTransport(CONFIG, async () => {
    requests += 1;
    return successResponse();
  });

  for (const delivery of invalidDeliveries) {
    assertSafeDeliveryFailure(
      await rejectedError(() => transport.send(delivery)),
    );
  }
  assert.equal(requests, 0);
});

test("rejects unsafe configuration without revealing its values", () => {
  const invalidConfigurations: readonly ResendMailTransportConfig[] = [
    { ...CONFIG, apiKey: "" },
    { ...CONFIG, apiKey: "invalid\nkey" },
    { ...CONFIG, fromEmail: "invalid\n@example.com" },
    { ...CONFIG, requestTimeoutMs: 0 },
    { ...CONFIG, requestTimeoutMs: 1_000 },
    {
      ...CONFIG,
      requestTimeoutMs: 2_147_483_648,
      dispatcherLeaseMs: 2_147_483_649,
    },
  ];

  for (const config of invalidConfigurations) {
    assert.throws(
      () => new ResendMailTransport(config, async () => successResponse()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Resend mail transport configuration is invalid",
        );
        for (const privateValue of [config.apiKey, config.fromEmail]) {
          if (privateValue.length > 0) {
            assert.equal(error.message.includes(privateValue), false);
          }
        }
        return true;
      },
    );
  }
});
