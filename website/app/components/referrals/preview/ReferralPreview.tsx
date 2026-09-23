import { useMemo, useState } from "react";
import { CustomerCenterShell } from "../../customer/CustomerCenterShell";
import {
  ReferralCenter,
  REFERRAL_CENTER_DESCRIPTION,
  REFERRAL_CENTER_TITLE,
} from "../ReferralCenter";
import {
  ReferralCenterAdapter,
  type ReferralStateLoader,
} from "../ReferralCenterAdapter";
import type { ClipboardWriter, ReferralCenterData, ReferralLinkState } from "../referralModel";
import type { ReferralStateResponse } from "../../../lib/referral-api";
import { FIXTURE_LINK, FIXTURE_LONG_LINK, REFERRAL_FIXTURES, type ReferralFixtureKey } from "./referralFixtures";
import "./referral-preview.css";

/* 隔离预览：只在开发服务器的独立入口 /referral-preview.html 中渲染，
   不进入 App 路由、不进入生产构建输入、不修改导航与 Shell。 */

type Scenario =
  | "default"
  | "loading"
  | "error"
  | "noLink"
  | "apiLoading"
  | "apiError"
  | "apiUnissued"
  | "apiIssued"
  | ReferralFixtureKey;
type ClipboardMode = "browser" | "reject" | "unsupported";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "default", label: "生产默认（数据待接入）" },
  { value: "loading", label: "加载中" },
  { value: "error", label: "加载失败" },
  { value: "noLink", label: "无可用推荐链接" },
  { value: "apiLoading", label: "API 适配 · 加载中" },
  { value: "apiError", label: "API 适配 · 读取失败" },
  { value: "apiUnissued", label: "API 适配 · 尚未签发身份" },
  { value: "apiIssued", label: "API 适配 · 已签发但链接不可用" },
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

const API_PROGRAM = {
  tiers: [
    { minSalesFen: 5_900, maxSalesFen: 99_899, rateBps: 1_000 },
    { minSalesFen: 99_900, maxSalesFen: 199_899, rateBps: 1_500 },
    { minSalesFen: 199_900, maxSalesFen: 399_899, rateBps: 2_000 },
    { minSalesFen: 399_900, maxSalesFen: null, rateBps: 3_000 },
  ],
  withdrawalThresholdFen: 100_000,
  productCap: { status: "unconfigured" },
  commission: { status: "not_integrated" },
  refunds: { status: "not_integrated" },
  settlement: { status: "not_integrated" },
  withdrawn: { status: "not_integrated" },
} as const;

function apiResponse(issued: boolean): ReferralStateResponse {
  return {
    profile: issued
      ? {
          publicCode: "A".repeat(24),
          createdAt: "2026-09-22T03:04:05.678Z",
        }
      : null,
    link: {
      status: "unavailable",
      reason: "public_route_not_integrated",
    },
    program: API_PROGRAM,
  };
}

function injectedApiLoader(scenario: Scenario): ReferralStateLoader | null {
  if (scenario === "apiLoading") {
    return (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      });
  }
  if (scenario === "apiError") {
    return () => Promise.reject(new Error("isolated preview API failure"));
  }
  if (scenario === "apiUnissued" || scenario === "apiIssued") {
    return () => Promise.resolve(apiResponse(scenario === "apiIssued"));
  }
  return null;
}

export function ReferralPreview() {
  const [scenario, setScenario] = useState<Scenario>(() =>
    initialParam("scenario", SCENARIOS.map((item) => item.value), "default"));
  const [clipboardMode, setClipboardMode] = useState<ClipboardMode>(() =>
    initialParam("clipboard", ["browser", "reject", "unsupported"] as const, "browser"));
  const [collapsed, setCollapsed] = useState(false);

  const { data, link, fixture } = useMemo(() => resolve(scenario), [scenario]);
  const apiLoader = useMemo(() => injectedApiLoader(scenario), [scenario]);
  const clipboard = clipboardMode === "reject" ? rejectingClipboard : clipboardMode === "unsupported" ? null : undefined;

  return (
    <>
      <div className={`rfc-preview-bar${collapsed ? " is-collapsed" : ""}`} role="region" aria-label="隔离预览控制（不属于客户界面）">
        <div className="rfc-preview-head">
          <b>隔离预览 · REFERRAL-UI-PRODUCT-VISUAL-INTEGRATION-01</b>
          <span>仅开发环境独立入口；非客户路由，不发起真实返佣请求</span>
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
        {apiLoader ? (
          <ReferralCenterAdapter
            key={scenario}
            loadState={apiLoader}
            clipboard={clipboard}
            notice="fixture"
          />
        ) : (
          <ReferralCenter
            key={scenario}
            data={data}
            link={link}
            clipboard={clipboard}
            notice={fixture ? "fixture" : "pending"}
            onRetry={scenario === "error" ? () => setScenario("error") : undefined}
          />
        )}
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
  if (
    scenario === "apiLoading" ||
    scenario === "apiError" ||
    scenario === "apiUnissued" ||
    scenario === "apiIssued"
  ) {
    return { data: { status: "pending" }, link: { status: "pending" }, fixture: true };
  }
  return {
    data: { status: "ready", snapshot: REFERRAL_FIXTURES[scenario] },
    link: { status: "ready", url: scenario === "long" ? FIXTURE_LONG_LINK : FIXTURE_LINK },
    fixture: true,
  };
}
