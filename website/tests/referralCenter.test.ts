import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REFERRAL_DATA_PENDING,
  REFERRAL_LINK_PENDING,
  WITHDRAW_MIN_FEN,
  copyReferralLink,
  formatYuan,
  groupOrders,
  levelProgress,
  monthFilterModel,
  reconcileMonth,
  tierOf,
  withdrawalGate,
} from "../app/components/referrals/referralModel.ts";
import { REFERRAL_FIXTURES } from "../app/components/referrals/preview/referralFixtures.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// The referral center's interface copy lives in the zh dictionary: centre copy runs from
// `referral: {` up to the shared withdraw/dialog strings, which run up to `records: {`.
function referralCopySlices(read: (path: string) => string) {
  const zh = read("../app/i18n/zh.ts");
  const start = zh.indexOf("  referral: {");
  const parts = zh.indexOf("    withdrawTitlePending:", start);
  const records = zh.indexOf("    records: {", start);
  return { center: zh.slice(start, parts), parts: zh.slice(parts, records), records: zh.slice(records, zh.indexOf("\n  },\n", records)) };
}

const PRODUCTION_SOURCES = [
  "../app/components/referrals/ReferralCenter.tsx",
  "../app/components/referrals/ReferralCenterAdapter.tsx",
  "../app/components/referrals/ReferralRecords.tsx",
  "../app/components/referrals/ReferralDialog.tsx",
  "../app/components/referrals/referralParts.tsx",
  "../app/components/referrals/referralModel.ts",
  "../app/components/referrals/index.ts",
];

test("candidate tiers resolve by current-month sales, and below ¥59 is not a fifth tier", () => {
  assert.equal(tierOf(null), null);
  assert.equal(tierOf(5899), null);
  assert.equal(tierOf(5900)?.key, "entry");
  assert.equal(tierOf(99899)?.key, "entry");
  assert.equal(tierOf(99900)?.key, "advanced");
  assert.equal(tierOf(199900)?.key, "core");
  assert.equal(tierOf(399900)?.key, "senior");

  const core = levelProgress(268000);
  assert.equal(core.current?.key, "core");
  assert.equal(core.next?.key, "senior");
  assert.equal(core.toNext, 131900);
  assert.deepEqual(core.fills.slice(0, 2), [100, 100]);
  assert.equal(core.fills[3], 0);

  const below = levelProgress(3900);
  assert.equal(below.current, null);
  assert.deepEqual(below.fills, [0, 0, 0, 0]);
});

test("withdrawal eligibility uses settled balance only, with the frozen ¥1,000 threshold", () => {
  assert.equal(WITHDRAW_MIN_FEN, 100000);
  assert.deepEqual(withdrawalGate(99999), { met: false, shortfall: 1, fill: 99 });
  assert.deepEqual(withdrawalGate(100000), { met: true, shortfall: 0, fill: 100 });
  assert.equal(withdrawalGate(18600).shortfall, 81400);
  assert.equal(REFERRAL_FIXTURES.edgeBelow.ledger.withdrawable, 99999);
  assert.equal(REFERRAL_FIXTURES.edgeMet.ledger.withdrawable, 100000);
});

test("month filter shows the year once and short month labels, falling back to full months across years", () => {
  const single = monthFilterModel(["2026-09", "2026-08", "2026-07", "2026-06"]);
  assert.equal(single.yearLabel, "2026 年");
  assert.deepEqual(single.options.map((option) => option.label), ["9月", "8月", "7月", "6月"]);
  assert.deepEqual(single.options.map((option) => option.ariaLabel), ["2026-09", "2026-08", "2026-07", "2026-06"]);

  const multi = monthFilterModel(["2027-01", "2026-12"]);
  assert.equal(multi.yearLabel, null);
  assert.deepEqual(multi.options.map((option) => option.label), ["2027-01", "2026-12"]);
});

test("month grouping and filtering keep totals reconciled for every isolated fixture", () => {
  const normal = REFERRAL_FIXTURES.normal;
  assert.deepEqual(groupOrders(normal.orders, "ALL").map((group) => group.month), ["2026-09", "2026-08", "2026-07", "2026-06"]);
  const [september] = groupOrders(normal.orders, "2026-09");
  assert.equal(formatYuan(september.amountTotal), "¥2,680.00");
  assert.equal(formatYuan(september.commissionTotal ?? -1), "¥486.00");
  assert.equal(groupOrders(normal.orders, "2026-06").length, 1);

  for (const [key, snapshot] of Object.entries(REFERRAL_FIXTURES)) {
    if (snapshot.orders.length === 0) continue;
    assert.deepEqual(reconcileMonth(snapshot), { sales: true, commission: true }, key);
  }

  const refund = REFERRAL_FIXTURES.refund;
  assert.equal(formatYuan(refund.sales), "¥3,851.00");
  assert.equal(formatYuan(refund.estimate as number), "¥770.20");
  assert.equal(refund.original?.adjustment, 44480);
  assert.equal(groupOrders(REFERRAL_FIXTURES.low.orders, "2026-09")[0].commissionTotal, null);
});

test("copy reports success only after a real clipboard write, and never for missing links", async () => {
  const written: string[] = [];
  const ok = { writeText: async (text: string) => { written.push(text); } };
  const reject = { writeText: async () => { throw new Error("denied"); } };
  const link = { status: "ready", url: "https://example.invalid/r/TEST" } as const;

  assert.deepEqual(await copyReferralLink(link, ok), { kind: "copied" });
  assert.deepEqual(written, ["https://example.invalid/r/TEST"]);
  assert.deepEqual(await copyReferralLink(link, reject), { kind: "failed", reason: "rejected" });
  assert.deepEqual(await copyReferralLink(link, null), { kind: "failed", reason: "unsupported" });
  assert.deepEqual(await copyReferralLink(REFERRAL_LINK_PENDING, ok), { kind: "missing" });
  assert.deepEqual(await copyReferralLink({ status: "unavailable" }, ok), { kind: "missing" });
  assert.equal(written.length, 1);
});

test("production default is an honest pending state with no fixtures, network calls, or fake submission", () => {
  assert.deepEqual(REFERRAL_DATA_PENDING, { status: "pending" });
  assert.deepEqual(REFERRAL_LINK_PENDING, { status: "pending" });

  const center = source("../app/components/referrals/ReferralCenter.tsx");
  assert.match(center, /data = REFERRAL_DATA_PENDING/);
  assert.match(center, /link = REFERRAL_LINK_PENDING/);
  assert.match(center, /notice = "pending"/);

  for (const path of PRODUCTION_SOURCES) {
    const text = source(path);
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${path} must not fetch`);
    assert.doesNotMatch(text, /XMLHttpRequest|sendBeacon|WebSocket/, `${path} must not open network channels`);
    assert.doesNotMatch(text, /from "\.\/preview|referralFixtures/, `${path} must not import fixtures`);
    assert.doesNotMatch(text, /example\.invalid|DEMO-\d/, `${path} must not embed synthetic data`);
    assert.doesNotMatch(text, /<form|onSubmit/, `${path} must not contain a submittable form`);
  }
});

test("withdrawal stays disabled and pending integration in every state", () => {
  const parts = source("../app/components/referrals/referralParts.tsx");
  const button = parts.slice(parts.indexOf("export function WithdrawButton"), parts.indexOf("export function useInfoToggle"));
  assert.match(button, /disabled aria-disabled="true"/);
  assert.doesNotMatch(button, /onClick/);
  assert.match(button, /copy\.withdrawTitleMet/);
  assert.match(referralCopySlices(source).parts, /withdrawTitleMet: "提现功能待接入"/);
});

test("formal guidance preserves retained balance without promising unconfigured finance", () => {
  const center = referralCopySlices(source).center;
  assert.match(center, /未申请的已结算余额保留，不会自动转出/);
  assert.match(center, /提现门槛：已结算余额满 ¥1,000.00（功能开放后适用）/);
  assert.match(center, /计佣方式、商品上限及结算安排尚未配置或确认/);
  assert.match(center, /战略推广伙伴.*比例待确认/);
  assert.doesNotMatch(center, /实际返佣比例 = min|月末核算后|月度核算并经观察期后|最高 50%/);
});

test("approved customer route and public build entry use the formal referral components", () => {
  const sections = source("../app/lib/sections.ts");
  const app = source("../src/App.tsx");
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  const dashboard = source("../app/components/DashboardShell.tsx");
  const viteConfig = source("../vite.config.ts");
  const indexHtml = source("../index.html");

  assert.match(sections, /"referrals"/);
  assert.doesNotMatch(app, /referral|Referral/);
  assert.match(dashboard, /section === "referrals"/);
  assert.match(dashboard, /<ReferralCenterAdapter \/>/);
  const migrated = shell.slice(shell.indexOf("const migratedPaths"), shell.indexOf("]);", shell.indexOf("const migratedPaths")));
  assert.match(migrated, /"\/referrals"/);
  assert.match(shell, /"\/referrals"\] \}/);
  assert.match(source("../app/i18n/zh.ts"), /"\/referrals": "邀请\/推广"/);
  assert.match(viteConfig, /rollupOptions/);
  assert.match(viteConfig, /"referral\.html"/);
  assert.match(source("../referral.html"), /referral-public\/main\.tsx/);
  assert.doesNotMatch(indexHtml, /referral/);

  const preview = source("../referral-preview.html");
  assert.match(preview, /\/app\/components\/referrals\/preview\/main\.tsx/);
});
