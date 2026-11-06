import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_C,
  FakeAlipaySdk,
  allRows,
  firstValue,
  insertWebSession,
  paymentDependencies,
} from "./helpers.js";

/* 线路 × 流量选配（NSP-PACKAGE-COPY-20261101-01）的服务端报价 / 下单行为。
   服务端只认 sellable_plans；月付行由新增 Migration 027、半年 / 年付行由 Migration 028 写入
   （withAuthenticationDatabase 走完整迁移序列）。负对照：在一次性测试库里删掉这些行，同一组合即不可售。 */

// 本测试额外需要的两枚合成订单查询凭证（与 helpers 中 ACCESS_TOKEN_A..C 同格式）。
const ACCESS_TOKEN_D = Buffer.alloc(32, 0x55).toString("base64url");
const ACCESS_TOKEN_E = Buffer.alloc(32, 0x66).toString("base64url");
const ACCESS_TOKEN_F = Buffer.alloc(32, 0x77).toString("base64url");
const ACCESS_TOKEN_G = Buffer.alloc(32, 0x88).toString("base64url");
const ACCESS_TOKEN_H = Buffer.alloc(32, 0x99).toString("base64url");

const US_HALF_200G = {
  typeId: "local-isp",
  regionId: "us",
  ispId: "us-verizon",
  specId: "half-200g",
  durationId: "month-1",
} as const;

const SG_PURE_HIGH_1T = {
  typeId: "pure-native-ip",
  regionId: "sg",
  ispId: "broadcast-ip",
  specId: "high-1t",
  durationId: "month-1",
} as const;

async function quote(app: ReturnType<typeof buildApp>, selection: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/pay/quote",
    headers: { "content-type": "application/json" },
    payload: { ...selection, couponCode: null },
  });
}

test("negative control: without package rows the same options are unsellable", async () => {
  await withAuthenticationDatabase(async (database) => {
    database.exec("DELETE FROM sellable_plans WHERE id > 255;");
    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      for (const selection of [US_HALF_200G, SG_PURE_HIGH_1T]) {
        const response = await quote(app, selection);
        assert.equal(response.statusCode, 409);
        assert.deepEqual(response.json(), { error: { code: "plan_unavailable" } });
      }
      const catalog = await app.inject({ method: "GET", url: "/api/catalog/plans" });
      assert.equal(firstValue(database,"SELECT COUNT(*) FROM sellable_plans"),255);
      const items=catalog.json().items as Array<Record<string,unknown>>;
      assert.equal(items.length,723); //99 remaining non-residential +624 virtual住宅 aliases, noA/B package rows.
      assert.equal(items.filter(item=>item.typeId==='residential').length,624);
      assert.equal(items.filter(item=>item.typeId!=='residential').length,99);
      assert.equal(new Set(items.map(item=>JSON.stringify([item.typeId,item.regionId,item.ispId,item.specId,item.durationId]))).size,723);
    } finally {
      await app.close();
    }
  });
});

test("package options quote server prices, snapshot owned orders, and reject tampering or invalid combinations", async () => {
  await withAuthenticationDatabase(async (database) => {
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM sellable_plans WHERE id > 255"), 759);
    const sdk = new FakeAlipaySdk();
    // 本测试会创建两笔合成订单，每笔需要不同的 orderRef UUID（默认 helper 返回固定值）。
    let uuidCounter = 0;
    const uniqueUuid = () => `11111111-1111-4111-8111-${String(++uuidCounter).padStart(12, "0")}`;
    const buyerSession = insertWebSession(database,insertAuthenticationUser(database,{
      email:"package-buyer@example.test",passwordHash:"synthetic",status:"active",
    }));
    const authenticatedHeaders = {cookie:buyerSession.cookie,"x-csrf-token":buyerSession.csrfToken};
    const app = buildApp({ payment: paymentDependencies(database, sdk, uniqueUuid) });
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/catalog/plans" });
      const items=catalog.json().items as Array<Record<string,unknown>>;
      assert.equal(items.length,1482);
      assert.equal(items.filter(item=>item.typeId==='residential').length,624);
      assert.equal(items.filter(item=>item.typeId!=='residential').length,858);
      assert.ok(items.filter(item=>item.typeId==='residential').every(item=>typeof item.specId==='string'&&item.specId.startsWith('res-v2-')));
      assert.equal(new Set(items.map(item=>JSON.stringify([item.typeId,item.regionId,item.ispId,item.specId,item.durationId]))).size,1482);

      // A = 地区现有套餐月价 ¥79 + 所选线路 × 流量档加价。
      const expectedA: Array<[Record<string, unknown>, number]> = [
        [{ ...US_HALF_200G, specId: "ordinary-500g" }, 8_900],
        [{ ...US_HALF_200G, ispId: "us-charter", specId: "ordinary-1t" }, 9_900],
        [US_HALF_200G, 8_900],
        [{ ...US_HALF_200G, specId: "half-500g" }, 9_900],
        [{ ...US_HALF_200G, specId: "half-1t" }, 10_900],
        [{ ...US_HALF_200G, ispId: "us-att", specId: "live-1t" }, 17_900],
        [{ ...US_HALF_200G, regionId: "sg", ispId: "sg-starhub", specId: "live-1t" }, 27_900],
        [{ ...US_HALF_200G, regionId: "th", ispId: "th-awn", specId: "high-500g" }, 13_900],
        [{ ...US_HALF_200G, regionId: "jp", ispId: "jp-ntt", specId: "live-1t" }, 32_900],
        [{ ...US_HALF_200G, regionId: "gb", ispId: "gb-glide", specId: "high-1t" }, 17_900],
      ];
      for (const [selection, amountFen] of expectedA) {
        const response = await quote(app, selection);
        assert.equal(response.statusCode, 200, JSON.stringify(selection));
        assert.equal(response.json().amountFen, amountFen, JSON.stringify(selection));
      }
      // A / B：半年 = 最终月价 × 6 × 0.85，年付 = × 12 × 0.74（四舍五入到整元）；美区本地运营商、真住宅宽带保持原价。
      const expectedPeriods: Array<[Record<string, unknown>, number]> = [
        [{ ...US_HALF_200G, specId: null, durationId: "month-6" }, 40_300],
        [{ ...US_HALF_200G, specId: null, durationId: "month-12" }, 70_200],
        [{ ...US_HALF_200G, regionId: "tw", ispId: "tw-hinet", specId: "half-1t", durationId: "month-6" }, 55_600],
        [{ ...US_HALF_200G, regionId: "tw", ispId: "tw-hinet", specId: "half-1t", durationId: "month-12" }, 96_800],
        [{ ...SG_PURE_HIGH_1T, regionId: "us", ispId: "native-ip", specId: "ordinary-200g", durationId: "month-6" }, 9_700],
        [{ ...SG_PURE_HIGH_1T, regionId: "us", ispId: "native-ip", specId: "ordinary-200g", durationId: "month-12" }, 16_900],
        [{ typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: null, durationId: "month-6" }, 29_900],
        [{ typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: null, durationId: "month-12" }, 49_900],
        [{ typeId: "residential", regionId: "vn", ispId: "vnpt-corp", specId: "shared-3", durationId: "month-12" }, 123_800],
        // 超过已取消的 ¥2000 业务上限的 A / B 周期价照常可售。
        [{ ...US_HALF_200G, regionId: "my", ispId: "my-tm", specId: "live-1t", durationId: "month-12" }, 247_800],
        [{ ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-6" }, 244_300],
        [{ ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-12" }, 425_400],
      ];
      for (const [selection, amountFen] of expectedPeriods) {
        const response = await quote(app, selection);
        assert.equal(response.statusCode, 200, JSON.stringify(selection));
        assert.equal(response.json().amountFen, amountFen, JSON.stringify(selection));
      }
      const catalogItem = (selection: Record<string, unknown>) =>
        (catalog.json().items as Array<Record<string, unknown>>).find((item) =>
          ["typeId", "regionId", "ispId", "specId", "durationId"].every((key) => item[key] === selection[key]),
        );
      for (const [selection, priceFen] of [
        [{ ...US_HALF_200G, regionId: "my", ispId: "my-tm", specId: "live-1t", durationId: "month-12" }, 247_800],
        [{ ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-6" }, 244_300],
        [{ ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-12" }, 425_400],
      ] as const) {
        assert.deepEqual(
          { ...catalogItem(selection) },
          { ...selection, priceFen, isActive: true, soldOut: false },
        );
      }
      const pureQuote = await quote(app, SG_PURE_HIGH_1T);
      assert.equal(pureQuote.statusCode, 200);
      assert.equal(pureQuote.json().amountFen, 22_900);

      // 篡改的客户端金额：服务端按 sellable_plans 价格拒绝，不建单。
      const tampered = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "package-tampered",
          "x-order-access-token": ACCESS_TOKEN_A,
          ...authenticatedHeaders,
        },
        payload: {
          ...US_HALF_200G,
          contact: "synthetic-contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 7_900,
        },
      });
      assert.equal(tampered.statusCode, 409);
      assert.deepEqual(tampered.json(), {
        error: { code: "price_changed", currentAmountFen: 8_900 },
      });
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 0);

      const created = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "package-order",
          "x-order-access-token": ACCESS_TOKEN_B,
          ...authenticatedHeaders,
        },
        payload: {
          ...SG_PURE_HIGH_1T,
          contact: "synthetic-contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 22_900,
        },
      });
      assert.equal(created.statusCode, 200);
      assert.equal(created.json().amountFen, 22_900);
      assert.deepEqual(
        allRows(
          database,
          `SELECT type_id, region_id, isp_id, spec_id, duration_id, catalog_version, amount_fen
           FROM orders`,
        ),
        [
          {
            type_id: "pure-native-ip",
            region_id: "sg",
            isp_id: "broadcast-ip",
            spec_id: "high-1t",
            duration_id: "month-1",
            catalog_version: "SUBSCRIBE-CATALOG-V1",
            amount_fen: 22_900,
          },
        ],
      );

      // 美国普通线路 1T（¥79 + ¥20）的真实下单快照。
      const ordinaryOrder = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "package-ordinary-order",
          "x-order-access-token": ACCESS_TOKEN_C,
          ...authenticatedHeaders,
        },
        payload: {
          ...US_HALF_200G,
          ispId: "us-att",
          specId: "ordinary-1t",
          contact: "synthetic-contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 9_900,
        },
      });
      assert.equal(ordinaryOrder.statusCode, 200);
      assert.deepEqual(
        allRows(
          database,
          `SELECT type_id, region_id, isp_id, spec_id, duration_id, amount_fen FROM orders WHERE spec_id = 'ordinary-1t'`,
        ),
        [{ type_id: "local-isp", region_id: "us", isp_id: "us-att", spec_id: "ordinary-1t", duration_id: "month-1", amount_fen: 9_900 }],
      );

      // 年付选配的下单快照（TW / HiNet 半优化线路 1T：¥109 × 12 × 0.74 = ¥968），以及篡改为月价的拒绝。
      const tamperedPeriod = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "package-period-tampered",
          "x-order-access-token": ACCESS_TOKEN_D,
          ...authenticatedHeaders,
        },
        payload: {
          ...US_HALF_200G,
          regionId: "tw",
          ispId: "tw-hinet",
          specId: "half-1t",
          durationId: "month-6",
          contact: "synthetic-contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 10_900 * 6,
        },
      });
      assert.equal(tamperedPeriod.statusCode, 409);
      assert.deepEqual(tamperedPeriod.json(), { error: { code: "price_changed", currentAmountFen: 55_600 } });
      const yearOrder = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "package-year-order",
          "x-order-access-token": ACCESS_TOKEN_E,
          ...authenticatedHeaders,
        },
        payload: {
          ...US_HALF_200G,
          regionId: "tw",
          ispId: "tw-hinet",
          specId: "half-1t",
          durationId: "month-12",
          contact: "synthetic-contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 96_800,
        },
      });
      assert.equal(yearOrder.statusCode, 200);
      assert.deepEqual(
        allRows(
          database,
          `SELECT type_id, region_id, isp_id, spec_id, duration_id, amount_fen FROM orders WHERE duration_id = 'month-12'`,
        ),
        [{ type_id: "local-isp", region_id: "tw", isp_id: "tw-hinet", spec_id: "half-1t", duration_id: "month-12", amount_fen: 96_800 }],
      );

      // 超过已取消的 ¥2000 业务上限：A-MY 直播专线 1T 年付 ¥2478、B-MY 高速线路 1T 年付 ¥4254 / 半年 ¥2443 的合成下单快照。
      for (const [token, key, selection, amountFen] of [
        [ACCESS_TOKEN_F, "above-2000-a-my-live-year", { ...US_HALF_200G, regionId: "my", ispId: "my-tm", specId: "live-1t", durationId: "month-12" }, 247_800],
        [ACCESS_TOKEN_G, "above-2000-b-my-high-year", { ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-12" }, 425_400],
        [ACCESS_TOKEN_H, "above-2000-b-my-high-half", { ...SG_PURE_HIGH_1T, regionId: "my", durationId: "month-6" }, 244_300],
      ] as const) {
        const order = await app.inject({
          method: "POST",
          url: "/api/pay/orders",
          headers: { "content-type": "application/json", "idempotency-key": key, "x-order-access-token": token,
            ...authenticatedHeaders },
          payload: { ...selection, contact: "synthetic-contact", scenarios: [], notes: null, acknowledgedAmountFen: amountFen },
        });
        assert.equal(order.statusCode, 200, key);
        assert.equal(order.json().amountFen, amountFen, key);
        assert.deepEqual(
          allRows(
            database,
            `SELECT type_id, region_id, isp_id, spec_id, duration_id, amount_fen FROM orders
             WHERE type_id = ? AND region_id = ? AND isp_id = ? AND spec_id = ? AND duration_id = ?`,
            selection.typeId, selection.regionId, selection.ispId, selection.specId, selection.durationId,
          ),
          [{
            type_id: selection.typeId, region_id: "my", isp_id: selection.ispId, spec_id: selection.specId,
            duration_id: selection.durationId, amount_fen: amountFen,
          }],
        );
      }

      // 表外组合、非美国的普通 / 现有线路 500G / 1T、普通线路 200G 作为选配项、非 1T 的东南亚 / 亚欧巴直播专线、
      // 选配的 3 个月周期均不可报价。
      const invalid = [
        { ...US_HALF_200G, durationId: "month-3" },
        { ...US_HALF_200G, specId: null, durationId: "month-3" },
        { ...US_HALF_200G, specId: "ordinary-200g" },
        { ...US_HALF_200G, specId: "ordinary-500g", durationId: "month-3" },
        { ...US_HALF_200G, regionId: "sg", ispId: "sg-starhub", specId: "live-500g", durationId: "month-12" },
        { ...US_HALF_200G, regionId: "sg", ispId: "sg-starhub", specId: "ordinary-500g" },
        { ...US_HALF_200G, regionId: "jp", ispId: "jp-ntt", specId: "ordinary-1t" },
        { ...US_HALF_200G, typeId: "us-local-carrier", ispId: "ntt", specId: "ordinary-500g" },
        { ...SG_PURE_HIGH_1T, regionId: "my", specId: "ordinary-1t", durationId: "month-3" },
        { ...SG_PURE_HIGH_1T, regionId: "tw", specId: "high-200g", durationId: "month-6" },
        { ...US_HALF_200G, regionId: "sg", ispId: "sg-starhub", specId: "live-200g" },
        { ...US_HALF_200G, regionId: "sg", ispId: "sg-starhub", specId: "live-500g" },
        { ...US_HALF_200G, regionId: "jp", ispId: "jp-ntt", specId: "live-500g" },
        { ...US_HALF_200G, regionId: "kr", ispId: "kr-koreatelecom" },
        { ...US_HALF_200G, specId: "three-net-200g" },
        { ...SG_PURE_HIGH_1T, regionId: "tw" },
        { ...SG_PURE_HIGH_1T, ispId: "native-ip" },
        { ...SG_PURE_HIGH_1T, specId: "three-net-1t" },
      ];
      for (const selection of invalid) {
        const response = await quote(app, selection);
        assert.equal(response.statusCode, 409, JSON.stringify(selection));
        assert.deepEqual(response.json(), { error: { code: "plan_unavailable" } });
      }
    } finally {
      await app.close();
    }
  });
});
