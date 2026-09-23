import { useMemo, useState } from "react";
import { CustomerCenterShell } from "../../customer/CustomerCenterShell";
import {
  ReferralCenter,
  REFERRAL_CENTER_DESCRIPTION,
  REFERRAL_CENTER_TITLE,
} from "../ReferralCenter";
import type { ClipboardWriter, ReferralCenterData, ReferralLinkState } from "../referralModel";
import { FIXTURE_LINK, FIXTURE_LONG_LINK, REFERRAL_FIXTURES, type ReferralFixtureKey } from "./referralFixtures";
import "./referral-preview.css";

/* 隔离预览：只在开发服务器的独立入口 /referral-preview.html 中渲染，
   不进入 App 路由、不进入生产构建输入、不修改导航与 Shell。 */

type Scenario = "default" | "loading" | "error" | "noLink" | ReferralFixtureKey;
type ClipboardMode = "browser" | "reject" | "unsupported";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "default", label: "生产默认（数据待接入）" },
  { value: "loading", label: "加载中" },
  { value: "error", label: "加载失败" },
  { value: "noLink", label: "无可用推荐链接" },
  { value: "normal", label: "演示 · 正常有数据" },
  { value: "zero", label: "演示 · 真实零值" },
  { value: "long", label: "演示 · 长文本 / 大金额" },
  { value: "low", label: "演示 · 低月销（< ¥59）" },
  { value: "cap", label: "演示 · 商品上限" },
  { value: "refund", label: "演示 · 退款调整" },
  { value: "edgeBelow", label: "演示 · 余额 ¥999.99" },
  { value: "edgeMet", label: "演示 · 余额 ¥1,000.00" },
];

function initialParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const rejectingClipboard: ClipboardWriter = {
  writeText: () => Promise.reject(new Error("预览模拟：剪贴板写入被拒绝")),
};

export function ReferralPreview() {
  const [scenario, setScenario] = useState<Scenario>(() =>
    initialParam("scenario", SCENARIOS.map((item) => item.value), "default"));
  const [clipboardMode, setClipboardMode] = useState<ClipboardMode>(() =>
    initialParam("clipboard", ["browser", "reject", "unsupported"] as const, "browser"));
  const [collapsed, setCollapsed] = useState(false);

  const { data, link, fixture } = useMemo(() => resolve(scenario), [scenario]);
  const clipboard = clipboardMode === "reject" ? rejectingClipboard : clipboardMode === "unsupported" ? null : undefined;

  return (
    <>
      <div className={`rfc-preview-bar${collapsed ? " is-collapsed" : ""}`} role="region" aria-label="隔离预览控制（不属于客户界面）">
        <div className="rfc-preview-head">
          <b>隔离预览 · REFERRAL-UI-PRODUCT-VISUAL-INTEGRATION-01</b>
          <span>仅开发环境独立入口；非客户路由，不发起返佣数据请求</span>
          <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
            {collapsed ? "展开" : "收起"}
          </button>
        </div>
        {collapsed ? null : (
          <div className="rfc-preview-controls">
            <label>
              场景
              <select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
                {SCENARIOS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label>
              剪贴板
              <select value={clipboardMode} onChange={(event) => setClipboardMode(event.target.value as ClipboardMode)}>
                <option value="browser">浏览器真实写入</option>
                <option value="reject">模拟拒绝</option>
                <option value="unsupported">模拟不支持</option>
              </select>
            </label>
          </div>
        )}
      </div>
      <CustomerCenterShell title={REFERRAL_CENTER_TITLE} description={REFERRAL_CENTER_DESCRIPTION}>
        <ReferralCenter
          key={scenario}
          data={data}
          link={link}
          clipboard={clipboard}
          notice={fixture ? "fixture" : "pending"}
          onRetry={scenario === "error" ? () => setScenario("error") : undefined}
        />
      </CustomerCenterShell>
    </>
  );
}

function resolve(scenario: Scenario): { data: ReferralCenterData; link: ReferralLinkState; fixture: boolean } {
  if (scenario === "default") return { data: { status: "pending" }, link: { status: "pending" }, fixture: false };
  if (scenario === "loading") return { data: { status: "loading" }, link: { status: "pending" }, fixture: false };
  if (scenario === "error") return { data: { status: "error" }, link: { status: "pending" }, fixture: false };
  if (scenario === "noLink") {
    return { data: { status: "ready", snapshot: REFERRAL_FIXTURES.normal }, link: { status: "unavailable" }, fixture: true };
  }
  return {
    data: { status: "ready", snapshot: REFERRAL_FIXTURES[scenario] },
    link: { status: "ready", url: scenario === "long" ? FIXTURE_LONG_LINK : FIXTURE_LINK },
    fixture: true,
  };
}
