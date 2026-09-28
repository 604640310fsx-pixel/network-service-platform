import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("order form shows the guest notice only to confirmed unauthenticated visitors", () => {
  const form = source("../app/components/subscribe/RequirementForm.tsx");

  assert.match(form, /const \{ status: authStatus \} = useAuth\(\);/);
  assert.match(
    form,
    /\{authStatus === "unauthenticated" && \(\s*<p>\s*建议先<Link to="\/login">登录<\/Link>再下单；登录后需返回“套餐订阅”重新选择套餐。/,
  );
  // 登录入口不保留所选方案，文案不得暗示会保留。
  assert.doesNotMatch(form, /保留(所选|已选)?方案|自动返回|继续下单/);
  assert.match(form, /订单只能凭本浏览器保存的查询凭证查看/);
  assert.match(form, /之后注册的账户不会自动关联此前的订单/);
  // 通知位于提交按钮之前，确保提交前可见。
  assert.ok(form.indexOf("建议先<Link") < form.indexOf('<button type="submit"'));
});

test("guest checkout stays available and the notice promises no linking", () => {
  const form = source("../app/components/subscribe/RequirementForm.tsx");

  assert.doesNotMatch(form, /authStatus === "unauthenticated"[^\n]*disabled|canSubmit[^\n]*authStatus/);
  assert.doesNotMatch(form, /自动关联(?!此前)|认领|claim/i);
});
