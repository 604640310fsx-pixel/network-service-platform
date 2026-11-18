import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("the Alipay step shows the sparse 当面付 QR when qrCode exists, else a dense QR of the cashier payUrl", () => {
  const pay = source("../app/components/subscribe/AlipayQrPay.tsx");
  const code = pay.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /<iframe|setTimeout|8_000|cashierTimedOut|cashierLoaded/);
  assert.match(pay, /import \{ QRCodeSVG \} from "qrcode\.react";/);
  // QRs are generated locally: the short qr.alipay.com code when present (unchanged),
  // otherwise the full cashier payUrl at the lowest error-correction level, drawn larger.
  assert.match(pay, /qrCode !== null \? \(\s*<div className="pay-qr" role="img" aria-label=\{copy\.qrLabel\}>\s*<QRCodeSVG value=\{qrCode\} size=\{240\} level="M" marginSize=\{2\} \/>/);
  assert.match(pay, /\) : \(\s*<div className="pay-qr is-dense" role="img" aria-label=\{copy\.qrLabel\}>\s*<QRCodeSVG value=\{payUrl\} size=\{320\} level="L" marginSize=\{4\} \/>/);
  assert.equal(code.match(/<QRCodeSVG/g)?.length, 2);
  // Both branches share the Alipay-app copy and the new-window backup link.
  assert.equal(code.match(/\{copy\.scanLead\}/g)?.length, 1);
  assert.match(pay, /<\/div>\s*\)\}\s*<p className="pay-open-lead">\{copy\.scanLead\}<\/p>\s*<a className="pay-ghost pay-open-button" href=\{payUrl\} target="_blank" rel="noopener noreferrer">\s*\{copy\.openCashier\}/);
  const zhCopy = source("../app/i18n/zh.ts");
  assert.match(zhCopy, /scanLead: "请使用手机支付宝扫码付款"/);
  assert.match(zhCopy, /openCashier: "或在新窗口打开支付宝收银台"/);
  assert.doesNotMatch(code, /点击下方按钮|pay-primary pay-open-button/);
  assert.match(source("../app/components/subscribe/subscribe.css"), /\.pay-qr\.is-dense \{ width: 100%; max-width: 320px;/);
  assert.doesNotMatch(code, /https?:\/\/[^"'\s]*qr[^"'\s]*"/i);
  // Without a pay URL the page still says it is fetching the cashier.
  assert.match(pay, /payUrl === null \? \(\s*<div className="pay-open-loading" role="status">\{copy\.loadingCashier\}<\/div>/);
  for (const kept of ["支付页剩余", "刷新收银台", "正在确认支付结果", "支付成功", "重新支付", "正在获取支付宝收银台…"]) {
    assert.match(zhCopy, new RegExp(kept));
  }
  for (const key of ["remaining", "refresh", "confirmingTitle", "paidTitle", "retry"]) {
    assert.match(pay, new RegExp(`copy\\.${key}\\b`));
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
  assert.match(page, /<PanelHead title=\{copy\.myTickets\} action=\{<NewTicketLink \/>\} \/>/);
  assert.match(page, /<Link className=\{className\} to="\/tickets\?new=1">/);
  assert.match(page, /className="cc-tk-empty"[\s\S]*?copy\.emptyFirst[\s\S]*?copy\.emptyHint/);
  assert.match(source("../app/i18n/zh.ts"), /emptyFirst: "还没有工单"[\s\S]*?emptyHint: "遇到服务问题时/);
  assert.match(page, /<Link className="cc-tk-row" to=\{`\/tickets\?ref=\$\{encodeURIComponent\(item\.ref\)\}`\}>/);
  assert.match(page, /<span className="cc-tk-page">\{copy\.pageNumber\(page\)\}<\/span>/);
  assert.doesNotMatch(page, /cc-tk-toolbar/);
  // Same API calls and routes as before.
  for (const call of ["listMyTickets(page, controller.signal)", "createMyTicket(csrfToken", "getMyTicket(ticketRef, controller.signal)", "replyToMyTicket(csrfToken"]) {
    assert.ok(page.includes(call), call);
  }
  const css = source("../app/components/customer/customer-tickets.css");
  assert.match(css, /\.cc-tk-row \{[^}]*grid-template-columns: minmax\(0, 1\.6fr\) minmax\(0, 1\.4fr\) auto 16px;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*?\.cc-tk-row \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
});
