import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("home preview presents only connected information and labels unavailable capabilities", () => {
  const page = source("../app/components/home/HomePage.tsx");

  assert.match(page, /交付后可在客户中心查看已接入的服务信息；状态与用量能力按接入结果显示。/);
  assert.match(page, /交付后，已接入信息可在客户中心查看/);
  assert.match(page, /网络状态、系统状态与实际用量未接入时显示待接入，不作推测。/);
  assert.match(page, /界面预览，非实时数据/);
  assert.match(page, /本月用量（待接入）/);
  assert.match(page, /工单与告警（待接入）/);
  assert.match(page, /系统状态（待接入）/);
  assert.doesNotMatch(page, /交付后在客户中心持续观察环境状态。/);
  assert.doesNotMatch(page, /网络状态持续可见/);
});

test("buyer status entry uses the authenticated target-free projection route", () => {
  const page = source("../app/components/network/BuyerNetworkPage.tsx");

  assert.match(page, /const statusHref = resolveBuyerStatusHref\(\);/);
  assert.match(page, /<Link className="cc-net-ghost" to=\{statusHref\}>查看服务器状态<\/Link>/);
  assert.match(page, /服务器状态入口/);
  assert.match(page, /目标由服务端按所有权选择，不会进入浏览器。/);
  assert.doesNotMatch(page, /status\?vps=/);
  assert.doesNotMatch(page, /买家线路与服务器状态联动/);
});
