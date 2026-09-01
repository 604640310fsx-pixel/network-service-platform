import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("public monitor uses the dedicated embed view without target identity", () => {
  const page = source("../app/components/monitor/PublicMonitorPage.tsx");
  assert.match(page, /embedded:\s*true/);
  assert.match(page, /referrerPolicy="same-origin"/);
  assert.match(page, /isMonitorFixturePreview/);
  assert.match(page, /本地演示数据/);
  assert.match(page, /FIXTURE · 15S/);
  assert.match(page, /实时数据同步/);
  assert.match(page, /LIVE · 15S/);
  assert.doesNotMatch(page, /target\s*:/);
  assert.doesNotMatch(page, /广州三网/);
});

test("sidebar mini is identity-free and status navigation carries no fixed target", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  assert.match(shell, /compact:\s*true/);
  assert.match(shell, /to="\/status"/);
  assert.doesNotMatch(shell, /SIDEBAR_MONITOR_TARGET|target\s*:/);
});

test("buyer status fails closed until the authenticated projection exists", () => {
  const page = source("../app/components/status/BuyerServerStatusPage.tsx");
  assert.match(page, /服务器状态待接入/);
  assert.match(page, /不会显示或推测具体 VPS/);
  assert.doesNotMatch(page, /<iframe|import\.meta\.env|buildMonitorEmbedUrl\(|useSearchParams\(/);
});
