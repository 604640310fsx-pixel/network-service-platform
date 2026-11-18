import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PASSWORD_MAX_LENGTH,
  REGISTRATION_PASSWORD_MIN_LENGTH,
} from "../app/components/auth/passwordPolicy.ts";
import {
  emailChangeError,
  hasErrors,
  passwordChangeError,
  validateEmailChangeCode,
  validateEmailChangeStart,
  validatePasswordChange,
} from "../app/components/profile/accountSecurityModel.ts";
import { AccountApiError, parseEmailChangeStarted } from "../app/lib/account-api.ts";
import { zh } from "../app/i18n/zh.ts";

const V = zh.security.validation;
const E = zh.security.errors;

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
const GOOD = "battery-staple-99";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("password change validates presence, the 12-256 policy and confirmation", () => {
  assert.deepEqual(validatePasswordChange({ currentPassword: "old", newPassword: GOOD, confirmPassword: GOOD }, POLICY, V), {});
  const empty = validatePasswordChange({ currentPassword: "", newPassword: "", confirmPassword: "" }, POLICY, V);
  assert.deepEqual(empty, { currentPassword: "请输入当前密码。", newPassword: "请设置新密码。", confirmPassword: "请再次输入新密码。" });
  const short = "x".repeat(11);
  assert.equal(validatePasswordChange({ currentPassword: "old", newPassword: short, confirmPassword: short }, POLICY, V).newPassword, "新密码至少需要 12 个字符。");
  const long = "x".repeat(257);
  assert.equal(validatePasswordChange({ currentPassword: "old", newPassword: long, confirmPassword: long }, POLICY, V).newPassword, "新密码不能超过 256 个字符。");
  assert.equal(validatePasswordChange({ currentPassword: "old", newPassword: GOOD, confirmPassword: `${GOOD}!` }, POLICY, V).confirmPassword, "两次输入的新密码不一致。");
  assert.equal(hasErrors({ a: undefined }), false);
});

test("email change start validates the new address and current password", () => {
  const base = { currentPassword: "old", newEmail: "new@example.net", currentEmail: "owner@example.net" };
  assert.deepEqual(validateEmailChangeStart(base, V), {});
  assert.equal(validateEmailChangeStart({ ...base, newEmail: "" }, V).newEmail, "请输入新邮箱。");
  assert.equal(validateEmailChangeStart({ ...base, newEmail: "no-at-sign" }, V).newEmail, "请输入有效的邮箱地址。");
  assert.equal(validateEmailChangeStart({ ...base, newEmail: " Owner@Example.net " }, V).newEmail, "新邮箱与当前邮箱相同。");
  assert.equal(validateEmailChangeStart({ ...base, currentPassword: "" }, V).currentPassword, "请输入当前密码。");
});

test("the emailed code must be six digits", () => {
  assert.deepEqual(validateEmailChangeCode(" 123456 ", V), {});
  assert.equal(validateEmailChangeCode("", V).code, "请输入邮箱验证码。");
  for (const code of ["12345", "1234567", "12a456"]) {
    assert.equal(validateEmailChangeCode(code, V).code, "验证码应为 6 位数字。", code);
  }
});

test("server error codes map to explicit field messages, anything else stays generic", () => {
  assert.deepEqual(passwordChangeError("invalid_credentials", E), { field: "currentPassword", text: "当前密码不正确。" });
  assert.equal(passwordChangeError("password_policy_violation", E).field, "newPassword");
  assert.deepEqual(emailChangeError("email_taken", E), { field: "newEmail", text: "该邮箱已被其他账户使用。" });
  assert.deepEqual(emailChangeError("invalid_code", E), { field: "code", text: "验证码不正确，请检查后重试。" });
  assert.equal(emailChangeError("invalid_or_expired", E).text, "验证码已过期或申请已失效，请重新发送验证码。");
  assert.equal(emailChangeError("rate_limited", E).text, "操作过于频繁，请稍后再试。");
  for (const code of [null, "request_failed", "account_unavailable", "something_new"]) {
    assert.deepEqual(emailChangeError(code, E), { text: "暂时无法完成操作，请稍后重试。" });
    assert.deepEqual(passwordChangeError(code, E), { text: "暂时无法完成操作，请稍后重试。" });
  }
});

test("the start response is parsed strictly", () => {
  const token = `ec1.v1.${"a".repeat(80)}.${"b".repeat(43)}`;
  assert.deepEqual(parseEmailChangeStarted({ status: "ok", changeToken: token, expiresAt: "2026-09-30T03:14:05.000Z" }), { changeToken: token, expiresAt: "2026-09-30T03:14:05.000Z" });
  for (const value of [
    null,
    { status: "ok", changeToken: token },
    { status: "ok", changeToken: "v1.abc", expiresAt: "2026-09-30T03:14:05.000Z" },
    { status: "ok", changeToken: token, expiresAt: "later" },
    { status: "ok", changeToken: token, expiresAt: "2026-09-30T03:14:05.000Z", code: "123456" },
  ]) {
    assert.throws(() => parseEmailChangeStarted(value), (error) => error instanceof AccountApiError && error.code === "invalid_response");
  }
});

test("secrets stay in memory and every write carries the session CSRF token", () => {
  const forms = source("../app/components/profile/AccountSecurityForms.tsx");
  const api = source("../app/lib/account-api.ts");
  for (const text of [forms, api]) {
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|navigate\(|useSearchParams|\?(currentPassword|password|code|changeToken)=/);
  }
  assert.match(api, /"X-CSRF-Token": csrfToken/);
  assert.match(api, /"\/api\/me\/password\/change"/);
  assert.match(api, /"\/api\/me\/email\/change\/start"/);
  assert.match(api, /"\/api\/me\/email\/change\/confirm"/);
  // Fields are cleared after success; the auth session is re-read after an email change.
  assert.match(forms, /await changePassword\([\s\S]*?setCurrentPassword\(""\);\s*setNewPassword\(""\);\s*setConfirmPassword\(""\);/);
  assert.match(forms, /await confirmEmailChange\([\s\S]*?setChangeToken\(null\);[\s\S]*?await refresh\(\);/);
  assert.match(forms, /text: copy\.password\.success/);
  assert.match(zh.security.password.success, /^密码已修改/);
});

test("both security panels start collapsed and toggle from an accessible header button", () => {
  const forms = source("../app/components/profile/AccountSecurityForms.tsx");
  assert.match(forms, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(forms, /<button\s+type="button"\s+className="cc-profile-toggle"\s+aria-expanded=\{open\}\s+aria-controls=\{`\$\{baseId\}-content`\}\s+onClick=\{\(\) => setOpen\(\(current\) => !current\)\}/);
  // Collapsing only hides the form, so typed values are not lost.
  assert.match(forms, /id=\{`\$\{baseId\}-content`\} hidden=\{!open\}>/);
  assert.match(forms, /<CollapsiblePanel eyebrow="SECURITY" title=\{copy\.password\.title\}>/);
  assert.match(forms, /<CollapsiblePanel eyebrow="LOGIN EMAIL" title=\{copy\.email\.title\}>/);
  assert.equal(zh.security.password.title, "修改密码");
  assert.equal(zh.security.email.title, "修改邮箱");
});

test("the profile keeps its read-only card and adds both security panels", () => {
  const page = source("../app/components/profile/ProfilePage.tsx");
  assert.match(page, /<dt>\{copy\.email\}<\/dt>/);
  assert.match(page, /<dt>\{copy\.accountType\}<\/dt>/);
  assert.equal(zh.profile.email, "登录邮箱");
  assert.equal(zh.profile.accountType, "账户类型");
  assert.match(page, /<PasswordChangePanel \/>\s*<EmailChangePanel currentEmail=\{principal\.email\} \/>/);
  const auth = source("../app/lib/auth.tsx");
  assert.match(auth, /readonly refresh: \(\) => Promise<void>;/);
});
