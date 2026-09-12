import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../app/components/status/BuyerServerStatusPage.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../app/components/status/server-status.css", import.meta.url),
  "utf8",
);

test("buyer status page covers the full projection and error lifecycle", () => {
  for (const text of [
    "正在检查服务器状态",
    "在线",
    "离线",
    "数据已过期",
    "暂无可查看的服务器",
    "服务器监控尚未配置",
    "服务器状态响应异常",
    "服务器状态请求超时",
    "服务器状态服务未配置",
    "服务器状态暂不可用",
    "手动刷新",
    "手动重试",
  ]) {
    assert.match(page, new RegExp(text));
  }
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /controller\.abort\(\)/);
  assert.match(page, /\[attempt\]/);
  assert.doesNotMatch(page, /setInterval|monitorTargetKey|[?&](?:vps|target)=/);
});

test("buyer status page uses existing theme tokens and narrow-screen wrapping", () => {
  assert.match(styles, /\.cc-shell\[data-theme="dark"\] \.cc-status-page/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.match(styles, /overflow: auto/);
  assert.doesNotMatch(styles, /min-width:\s*[4-9]\d{2}px/);
});
