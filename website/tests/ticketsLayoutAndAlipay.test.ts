import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("the Alipay step shows a sparse 当面付 QR only when qrCode exists, else a button-first cashier link", () => {
  const pay = source("../app/components/subscribe/AlipayQrPay.tsx");
  const code = pay.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /<iframe|setTimeout|8_000|cashierTimedOut|cashierLoaded/);
  assert.match(pay, /import \{ QRCodeSVG \} from "qrcode\.react";/);
  // The QR is generated locally and only from the short qr.alipay.com code, never from the long payUrl.
  assert.match(pay, /qrCode !== null \? \(\s*<>\s*<div className="pay-qr" role="img" aria-label="支付宝付款二维码">\s*<QRCodeSVG value=\{qrCode\} size=\{240\} level="M" marginSize=\{2\} \/>/);
  assert.equal(code.match(/<QRCodeSVG/g)?.length, 1);
  assert.doesNotMatch(code, /<QRCodeSVG value=\{payUrl\}/);
  assert.match(pay, /请使用手机支付宝扫码付款[\s\S]*?<a className="pay-ghost pay-open-button" href=\{payUrl\} target="_blank" rel="noopener noreferrer">\s*或在新窗口打开支付宝收银台/);
  assert.match(pay, /\) : \(\s*<>\s*<p className="pay-open-lead">点击下方按钮[\s\S]*?<a className="pay-primary pay-open-button" href=\{payUrl\} target="_blank" rel="noopener noreferrer">\s*打开支付宝收银台/);
  assert.doesNotMatch(code, /https?:\/\/[^"'\s]*qr[^"'\s]*"/i);
  // Without a pay URL the page still says it is fetching the cashier.
  assert.match(pay, /payUrl === null \? \(\s*<div className="pay-open-loading" role="status">正在获取支付宝收银台…<\/div>/);
  for (const kept of ["支付页剩余", "刷新收银台", "正在确认支付结果", "支付成功", "重新支付"]) {
    assert.match(pay, new RegExp(kept));
  }
  const css = source("../app/components/subscribe/subscribe.css");
  assert.doesNotMatch(css, /\.pay-cashier-/);
});

test("the pay-page result parser accepts only an official Alipay QR code and treats it as optional", async () => {
  const { refreshOrderPayPage, PaymentApiError } = await import("../app/lib/payment-api.ts");
  const base = { orderRef: "DLDEMOPAY1", status: "pending", amountFen: 5_900, currency: "CNY", reservedUntil: "2026-09-30T08:00:00.000Z", payUrl: "https://openapi.alipay.com/gateway.do?x=1" };
  const original = globalThis.fetch;
  try {
    for (const [qrCode, expected] of [[undefined, null], ["https://qr.alipay.com/bax08431xmsd8ptaa9jf00d1", "https://qr.alipay.com/bax08431xmsd8ptaa9jf00d1"]] as const) {
      globalThis.fetch = (async () => new Response(JSON.stringify(qrCode === undefined ? base : { ...base, qrCode }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
      const result = await refreshOrderPayPage("DLDEMOPAY1", null);
      assert.equal(result.qrCode, expected);
      assert.equal(result.payUrl, base.payUrl);
    }
    for (const qrCode of ["https://evil.example/qr", "http://qr.alipay.com/abc", "", 12]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ ...base, qrCode }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
      await assert.rejects(refreshOrderPayPage("DLDEMOPAY1", null), (error: unknown) => error instanceof PaymentApiError && error.code === "invalid_response");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("order status polling still lives in OrderStatusPanel and still feeds the pay URL", () => {
  const panel = source("../app/components/subscribe/OrderStatusPanel.tsx");
  assert.match(panel, /<AlipayQrPay/);
  assert.match(panel, /payUrl=\{phase === "waiting" \? payUrl : null\}\s*qrCode=\{phase === "waiting" \? qrCode : null\}/);
  // qrCode is cleared and refreshed wherever payUrl is.
  assert.equal(panel.match(/setPayUrl\(null\);\s*setQrCode\(null\);/g)?.length, 2);
  assert.match(panel, /setPayUrl\(result\.payUrl\);\s*setQrCode\(result\.qrCode\);/);
  assert.match(panel, /getPaymentOrder\(/);
});

test("the ticket list has a header action, a centred empty state and compact linked rows", () => {
  const page = source("../app/components/customer/CustomerTicketsPage.tsx");
  assert.match(page, /<PanelHead title="我的工单" action=\{<NewTicketLink \/>\} \/>/);
  assert.match(page, /<Link className=\{className\} to="\/tickets\?new=1">/);
  assert.match(page, /className="cc-tk-empty"[\s\S]*?还没有工单[\s\S]*?遇到服务问题时/);
  assert.match(page, /<Link className="cc-tk-row" to=\{`\/tickets\?ref=\$\{encodeURIComponent\(item\.ref\)\}`\}>/);
  assert.match(page, /<span className="cc-tk-page">第 \{page\} 页<\/span>/);
  assert.doesNotMatch(page, /cc-tk-toolbar/);
  // Same API calls and routes as before.
  for (const call of ["listMyTickets(page, controller.signal)", "createMyTicket(csrfToken", "getMyTicket(ticketRef, controller.signal)", "replyToMyTicket(csrfToken"]) {
    assert.ok(page.includes(call), call);
  }
  const css = source("../app/components/customer/customer-tickets.css");
  assert.match(css, /\.cc-tk-row \{[^}]*grid-template-columns: minmax\(0, 1\.6fr\) minmax\(0, 1\.4fr\) auto 16px;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*?\.cc-tk-row \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
});
