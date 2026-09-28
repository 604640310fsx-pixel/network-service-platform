import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { InvitesApiError, parseMyInvites, personalInviteLink } from "../app/lib/invites-api.ts";
import { canonicalInviteCode, inviteCodeFromSearch } from "../app/lib/registration-api.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const CODE = "aB3_-cD4eF5gH6iJ7kL8mN9o";

test("personal invite links are exact and prefill only a valid personal code", () => {
  assert.equal(personalInviteLink("https://www.example.test", CODE), `https://www.example.test/register?invite=${CODE}`);
  assert.equal(inviteCodeFromSearch(`?invite=${CODE}`), CODE);
  for (const search of ["", "?invite=short", `?invite=${CODE}&x=1`, `?invite=${CODE}&invite=${CODE}`, `?code=${CODE}`]) {
    assert.equal(inviteCodeFromSearch(search), null, search);
  }
});

test("personal codes keep their case; legacy admin codes are canonical uppercase", () => {
  assert.equal(canonicalInviteCode(`  ${CODE} `), CODE);
  assert.equal(canonicalInviteCode("abcd-efgh-jkmn-pqrs-tvwx-yz23-4567"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567");
});

test("the invites response is self-only and parsed strictly", () => {
  assert.deepEqual(parseMyInvites({ code: CODE, directInviteCount: 3 }), { code: CODE, directInviteCount: 3 });
  for (const value of [
    { code: CODE, directInviteCount: 1, invitees: [] },
    { code: CODE, directInviteCount: 1, email: "x@example.test" },
    { code: "bad", directInviteCount: 1 },
    { code: CODE, directInviteCount: -1 },
    { code: CODE, directInviteCount: 1.5 },
  ]) {
    assert.throws(() => parseMyInvites(value), (error: unknown) => error instanceof InvitesApiError && error.code === "invalid_response");
  }
});

test("the invites page shows only the caller's code, link, and count, with no reward claims", () => {
  const page = source("../app/components/customer/CustomerInvitesPage.tsx");
  const withoutComments = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(page, /getMyInvites/);
  assert.match(page, /personalInviteLink\(window\.location\.origin, code\)/);
  assert.match(page, /已直接邀请/);
  assert.match(page, /不能登录你的账户/);
  assert.doesNotMatch(withoutComments, /奖励|佣金|返利|多级|分成|提现|invitees|email/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
});

test("the invites section is enabled in the shell and routed to its own page", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  const dashboardShell = source("../app/components/DashboardShell.tsx");
  assert.match(shell, /\["\/invites", "邀请中心"\]/);
  assert.match(shell, /"\/invites",\n\]\);/);
  assert.match(dashboardShell, /section === "invites"/);
  // /referrals stays separate.
  assert.match(dashboardShell, /section === "referrals"/);
  assert.match(dashboardShell, /<ReferralCenterAdapter \/>/);
});
