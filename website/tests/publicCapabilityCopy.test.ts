import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("home preview describes real capability honestly and marks its filled showcase as fictional demo data", () => {
  // Home copy lives in the zh dictionary; the page renders it by key.
  const page = source("../app/i18n/zh.ts");
  assert.match(source("../app/components/home/HomePage.tsx"), /\{copy\.observability\.lead\}/);

  assert.match(page, /交付后可在客户中心查看已接入的服务信息；状态与用量能力按接入结果显示。/);
  assert.match(page, /交付后，已接入信息可在客户中心查看/);
  // The real dashboard still shows “pending” for unconnected capabilities; the homepage showcase is demo only.
  assert.match(page, /网络状态、系统状态与实际用量未接入时显示待接入，不作推测。/);
  assert.match(page, /以下为虚构的演示数据，非实时，不代表任何客户账户或实时监控。/);
  assert.match(page, /previewChip: "演示数据，非实时"/);
  assert.match(page, /systemStatus: "系统状态（示例主机）"/);
  assert.doesNotMatch(page, /本月用量（待接入）|工单与告警（待接入）|系统状态（待接入）/);
  assert.doesNotMatch(page, /交付后在客户中心持续观察环境状态。/);
  assert.doesNotMatch(page, /网络状态持续可见/);
});

test("buyer status entry opens /status with the account's first bound line preselected", () => {
  const page = source("../app/components/network/BuyerNetworkPage.tsx");
  // User decision 2026-10-04: the entry carries a buyer line; Auth resolves its server by ownership.
  assert.match(page, /const statusHref = primaryLineStatusHref\(statusLines, \(line\) => knownStatus\?\.get\(lineSelector\(line\)\) === "unbound"\);/);
  assert.match(page, /<Link className="cc-net-ghost" to=\{statusHref\}>\{t\.network\.viewStatus\}<\/Link>/);
  const zhCopy = source("../app/i18n/zh.ts");
  assert.match(zhCopy, /statusTitle: "服务器状态"/);
  assert.match(zhCopy, /statusBody: "打开三网监控页，自动选中你的线路对应的服务器；/);
  assert.doesNotMatch(zhCopy, /买家线路与服务器状态联动/);
  // The page never names a server itself.
  assert.doesNotMatch(page, /status\?vps=/);
  assert.doesNotMatch(page, /买家线路与服务器状态联动/);
});
