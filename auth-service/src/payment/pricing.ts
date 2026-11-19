/** Historical threshold retained for old reporting/tests; new sales have no business single-payment cap. */
export const PAYMENT_MAX_SINGLE_FEN = 200_000;

export const CATALOG_VERSION = "SUBSCRIBE-CATALOG-V1";

export type PriceSelection = Readonly<{
  typeId: string | null;
  regionId: string | null;
  ispId: string | null;
  specId: string | null;
  durationId: string | null;
}>;

export type PriceTuple = Readonly<PriceSelection & { priceFen: number }>;

type DurationMultiplier = readonly [numerator: number, denominator: number];

/* 周期价规则（用户 2026-11-01 确认，仅本地ISP运营商与纯净原生独享 IP）：周期总价 = 最终月价 × 月数 × 折扣，
   半年 × 6 × 0.85 = × 51/10，年付 × 12 × 0.74 = × 222/25；月付不变。
   美区本地运营商与真住宅宽带保持原周期价，不适用本规则。
   沿用既有取整契约：按整数分计算后四舍五入到整元（见 periodPriceFen）。 */
const STANDARD_PERIOD_MULTIPLIERS: Readonly<Record<string, DurationMultiplier>> = {
  "month-1": [1, 1],
  "month-6": [51, 10],
  "month-12": [222, 25],
};

/* 本地ISP运营商现有套餐被上述规则取代的旧周期价，仅供 Migration 014 只在价格仍为旧值时才更新（不覆盖管理员改过的价格）。 */
export const SUPERSEDED_FIXED_PERIOD_FEN: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "local-isp": { "month-6": 39_900, "month-12": 69_900 },
};

function periodPriceFen(monthlyFen: number, multiplier: DurationMultiplier): number {
  const [numerator, denominator] = multiplier;
  const roundedYuan = Math.floor(
    (monthlyFen * numerator + 50 * denominator) / (100 * denominator),
  );
  return roundedYuan * 100;
}

function standardPeriodPrices(monthlyFen: number): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(STANDARD_PERIOD_MULTIPLIERS).map(([durationId, multiplier]) => [
      durationId,
      periodPriceFen(monthlyFen, multiplier),
    ]),
  );
}

type FixedPriceProduct = Readonly<{
  ispsByRegion: Readonly<Record<string, readonly string[]>>;
  pricesByDuration: Readonly<Record<string, number>>;
}>;

const FIXED_PRICE_PRODUCTS: Readonly<Record<string, FixedPriceProduct>> = {
  "us-local-carrier": {
    ispsByRegion: {
      us: ["ntt", "gtt", "cogent", "charter"],
    },
    pricesByDuration: {
      "month-1": 5_900,
      "month-6": 29_900,
      "month-12": 49_900,
    },
  },
  "local-isp": {
    ispsByRegion: {
      us: ["us-verizon", "us-att", "us-rcn", "us-cox", "us-frontier", "us-charter"],
      tw: ["tw-hinet", "tw-hoshin", "tw-sonet", "tw-tbc"],
      jp: ["jp-softbank", "jp-ntt", "jp-kddi", "jp-sony", "jp-biglobe"],
      my: ["my-tm", "my-ttnet", "my-maxis", "my-umobile"],
      kr: ["kr-koreatelecom"],
      sg: ["sg-starhub"],
      gb: ["gb-bt", "gb-glide"],
      fr: ["fr-orange"],
      vn: ["vn-fpt"],
      br: ["br-atplus"],
      de: ["de-telefonica"],
      th: ["th-awn"],
      id: ["id-telkom"],
    },
    pricesByDuration: standardPeriodPrices(7_900),
  },
};

const RESIDENTIAL_ISPS_BY_REGION: Readonly<Record<string, readonly string[]>> = {
  sg: ["sptel"],
  jp: ["glbb-japan"],
  vn: ["vnpt-corp"],
  my: ["tm-technology"],
  kr: ["sk-broadband"],
  tw: ["hinet", "so-net"],
  us: ["cox", "rcn", "windstream", "att", "verizon", "comcast"],
};

const RESIDENTIAL_MONTHLY_FEN_BY_ISP: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  sptel: { "shared-5": 14_900, "shared-3": 21_900, dedicated: 59_900 },
  "glbb-japan": { "shared-5": 13_900, "shared-3": 19_900, dedicated: 54_900 },
  "vnpt-corp": { "shared-5": 8_900, "shared-3": 12_900, dedicated: 33_900 },
  "sk-broadband": { "shared-5": 11_800, "shared-3": 17_900, dedicated: 45_900 },
  "tm-technology": { "shared-5": 13_900, "shared-3": 19_900, dedicated: 54_900 },
  hinet: { "shared-5": 15_900, "shared-3": 23_900, dedicated: 65_900 },
  "so-net": { "shared-5": 15_900, "shared-3": 23_900, dedicated: 65_900 },
  cox: { "shared-5": 12_900, "shared-3": 18_900, dedicated: 49_900 },
  rcn: { "shared-5": 12_900, "shared-3": 18_900, dedicated: 49_900 },
  windstream: { "shared-5": 12_900, "shared-3": 18_900, dedicated: 49_900 },
  att: { "shared-5": 13_900, "shared-3": 19_900, dedicated: 54_900 },
  verizon: { "shared-5": 13_900, "shared-3": 19_900, dedicated: 54_900 },
  comcast: { "shared-5": 15_900, "shared-3": 23_900, dedicated: 65_900 },
};

// 真住宅宽带保持原周期价：3 个月 9 折（× 27/10）、半年 8.5 折（× 51/10）、年付 8 折（× 48/5）。
const RESIDENTIAL_DURATION_MULTIPLIERS: Readonly<Record<string, DurationMultiplier>> = {
  "month-1": [1, 1],
  "month-3": [27, 10],
  "month-6": [51, 10],
  "month-12": [48, 5],
};

/* NSP-PACKAGE-COPY-20261101-01 线路 × 流量选配：以下为最终月价（人民币分）；半年 / 年付按统一周期规则由月价计算。
   spec_id 编码为 `${lineId}-${trafficId}`。本地ISP运营商最终月费 = 所选地区现有套餐月付价
   （FIXED_PRICE_PRODUCTS["local-isp"] 的 month-1，7900 分）+ 所选线路 × 流量档加价；
   加价已对应流量档，不另收流量档基础费。普通线路只有美国提供 500G / 1T 加价；其他地区普通线路仅 200G 现有套餐。
   纯净原生独享 IP 的金额即最终套餐月价，不叠加本地ISP运营商价格。
   月付组合由 Migration 013、半年 / 年付组合由 Migration 014 写入 sellable_plans（均由本枚举生成），
   服务端报价与下单以 sellable_plans 为准；单独枚举，不并入 enumeratePriceTuples() 的 Migration 012 种子集合。 */
const PACKAGE_DURATION_ID = "month-1";

const LOCAL_ISP_LINE_SURCHARGE_FEN_BY_GROUP: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>
> = {
  us: {
    // 普通线路 200G 即现有套餐（spec_id NULL，Migration 012）；500G / 1T 为用户新增的美国普通线路加价。
    ordinary: { "500g": 1_000, "1t": 2_000 },
    half: { "200g": 1_000, "500g": 2_000, "1t": 3_000 },
    high: { "200g": 2_000, "500g": 4_000, "1t": 7_000 },
    live: { "200g": 3_000, "500g": 6_000, "1t": 10_000 },
  },
  "southeast-asia": {
    half: { "200g": 1_000, "500g": 2_000, "1t": 3_000 },
    high: { "200g": 3_000, "500g": 6_000, "1t": 10_000 },
    live: { "1t": 20_000 },
  },
  "asia-europe-brazil": {
    half: { "200g": 1_000, "500g": 2_000, "1t": 3_000 },
    high: { "200g": 3_000, "500g": 6_000, "1t": 10_000 },
    live: { "1t": 25_000 },
  },
};

const LOCAL_ISP_LINE_GROUP_BY_REGION: Readonly<Record<string, string>> = {
  us: "us",
  sg: "southeast-asia",
  my: "southeast-asia",
  vn: "southeast-asia",
  id: "southeast-asia",
  th: "southeast-asia",
  tw: "asia-europe-brazil",
  jp: "asia-europe-brazil",
  fr: "asia-europe-brazil",
  de: "asia-europe-brazil",
  br: "asia-europe-brazil",
  gb: "asia-europe-brazil",
};

const PURE_NATIVE_IP_ISP_BY_REGION: Readonly<Record<string, string>> = {
  us: "native-ip",
  tw: "broadcast-ip",
  jp: "broadcast-ip",
  sg: "broadcast-ip",
  my: "broadcast-ip",
};

const PURE_NATIVE_IP_MONTHLY_FEN: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>
> = {
  us: {
    ordinary: { "200g": 1_900, "500g": 2_900, "1t": 3_900 },
    half: { "200g": 2_900, "500g": 3_900, "1t": 5_900 },
    high: { "200g": 3_900, "500g": 5_900, "1t": 8_900 },
    "three-net": { "200g": 4_900, "500g": 7_900, "1t": 11_900 },
  },
  tw: { ordinary: { "200g": 1_900, "500g": 2_900, "1t": 3_900 } },
  jp: {
    ordinary: { "200g": 1_900, "500g": 2_900, "1t": 3_900 },
    high: { "200g": 7_900, "500g": 11_900, "1t": 20_900 },
  },
  sg: {
    ordinary: { "200g": 1_900, "500g": 2_900, "1t": 3_900 },
    high: { "200g": 8_900, "500g": 13_900, "1t": 22_900 },
  },
  my: {
    ordinary: { "200g": 4_900, "500g": 6_900, "1t": 11_900 },
    high: { "200g": 16_900, "500g": 28_900, "1t": 47_900 },
  },
};

function localIspPackageMonthlyFen(regionId: string, specId: string): number | null {
  const group = LOCAL_ISP_LINE_GROUP_BY_REGION[regionId];
  const baseFen = FIXED_PRICE_PRODUCTS["local-isp"]?.pricesByDuration[PACKAGE_DURATION_ID];
  if (group === undefined || baseFen === undefined) return null;
  for (const [lineId, surcharges] of Object.entries(LOCAL_ISP_LINE_SURCHARGE_FEN_BY_GROUP[group] ?? {})) {
    for (const [trafficId, surchargeFen] of Object.entries(surcharges)) {
      if (`${lineId}-${trafficId}` === specId) return baseFen + surchargeFen;
    }
  }
  return null;
}

function pureNativeIpMonthlyFen(regionId: string, ispId: string, specId: string): number | null {
  if (PURE_NATIVE_IP_ISP_BY_REGION[regionId] !== ispId) return null;
  for (const [lineId, prices] of Object.entries(PURE_NATIVE_IP_MONTHLY_FEN[regionId] ?? {})) {
    for (const [trafficId, priceFen] of Object.entries(prices)) {
      if (`${lineId}-${trafficId}` === specId) return priceFen;
    }
  }
  return null;
}

function resolvePackageOptionPriceFen(selection: PriceSelection): number | null {
  const { typeId, regionId, ispId, specId, durationId } = selection;
  if (!typeId || !regionId || !ispId || !specId || !durationId) return null;
  const multiplier = STANDARD_PERIOD_MULTIPLIERS[durationId];
  if (multiplier === undefined) return null;
  let monthlyFen: number | null = null;
  if (typeId === "local-isp") {
    if (!hasLinkedIsp(FIXED_PRICE_PRODUCTS["local-isp"]!.ispsByRegion, regionId, ispId)) return null;
    monthlyFen = localIspPackageMonthlyFen(regionId, specId);
  } else if (typeId === "pure-native-ip") {
    monthlyFen = pureNativeIpMonthlyFen(regionId, ispId, specId);
  }
  return monthlyFen === null ? null : periodPriceFen(monthlyFen, multiplier);
}

/* 线路 × 流量选配的全部可定价五元组：每个组合依次为月付、半年、年付（月付子集即 Migration 013 的原始顺序）。 */
export function enumeratePackageOptionTuples(): PriceTuple[] {
  const tuples: PriceTuple[] = [];
  const pushPeriods = (base: Omit<PriceTuple, "durationId" | "priceFen">, monthlyFen: number) => {
    for (const [durationId, multiplier] of Object.entries(STANDARD_PERIOD_MULTIPLIERS)) {
      tuples.push({ ...base, durationId, priceFen: periodPriceFen(monthlyFen, multiplier) });
    }
  };
  const localIspRegions = FIXED_PRICE_PRODUCTS["local-isp"]!.ispsByRegion;
  for (const [regionId, group] of Object.entries(LOCAL_ISP_LINE_GROUP_BY_REGION)) {
    for (const ispId of localIspRegions[regionId] ?? []) {
      for (const [lineId, surcharges] of Object.entries(LOCAL_ISP_LINE_SURCHARGE_FEN_BY_GROUP[group] ?? {})) {
        for (const trafficId of Object.keys(surcharges)) {
          const specId = `${lineId}-${trafficId}`;
          const monthlyFen = localIspPackageMonthlyFen(regionId, specId);
          if (monthlyFen === null) continue;
          pushPeriods({ typeId: "local-isp", regionId, ispId, specId }, monthlyFen);
        }
      }
    }
  }
  for (const [regionId, lines] of Object.entries(PURE_NATIVE_IP_MONTHLY_FEN)) {
    const ispId = PURE_NATIVE_IP_ISP_BY_REGION[regionId]!;
    for (const [lineId, prices] of Object.entries(lines)) {
      for (const [trafficId, monthlyFen] of Object.entries(prices)) {
        pushPeriods({ typeId: "pure-native-ip", regionId, ispId, specId: `${lineId}-${trafficId}` }, monthlyFen);
      }
    }
  }
  return tuples;
}


function hasLinkedIsp(
  ispsByRegion: Readonly<Record<string, readonly string[]>>,
  regionId: string,
  ispId: string,
): boolean {
  return ispsByRegion[regionId]?.includes(ispId) ?? false;
}

export function resolvePriceFen(selection: PriceSelection): number | null {
  const { typeId, regionId, ispId, specId, durationId } = selection;
  if (!typeId || !regionId || !ispId || !durationId) return null;

  if (specId !== null && (typeId === "local-isp" || typeId === "pure-native-ip")) {
    return resolvePackageOptionPriceFen(selection);
  }

  const fixedProduct = FIXED_PRICE_PRODUCTS[typeId];
  if (fixedProduct) {
    if (specId !== null) return null;
    if (!hasLinkedIsp(fixedProduct.ispsByRegion, regionId, ispId)) return null;
    return fixedProduct.pricesByDuration[durationId] ?? null;
  }

  if (typeId !== "residential" || !specId) return null;
  if (!hasLinkedIsp(RESIDENTIAL_ISPS_BY_REGION, regionId, ispId)) return null;

  const monthlyFen = RESIDENTIAL_MONTHLY_FEN_BY_ISP[ispId]?.[specId];
  const multiplier = RESIDENTIAL_DURATION_MULTIPLIERS[durationId];
  if (monthlyFen === undefined || multiplier === undefined) return null;
  return periodPriceFen(monthlyFen, multiplier);
}

export function enumeratePriceTuples(): PriceTuple[] {
  const tuples: PriceTuple[] = [];

  for (const [typeId, product] of Object.entries(FIXED_PRICE_PRODUCTS)) {
    for (const [regionId, ispIds] of Object.entries(product.ispsByRegion)) {
      for (const ispId of ispIds) {
        for (const [durationId, priceFen] of Object.entries(product.pricesByDuration)) {
          tuples.push({ typeId, regionId, ispId, specId: null, durationId, priceFen });
        }
      }
    }
  }

  for (const [regionId, ispIds] of Object.entries(RESIDENTIAL_ISPS_BY_REGION)) {
    for (const ispId of ispIds) {
      const specs = RESIDENTIAL_MONTHLY_FEN_BY_ISP[ispId];
      if (!specs) continue;
      for (const [specId, monthlyFen] of Object.entries(specs)) {
        for (const [durationId, multiplier] of Object.entries(
          RESIDENTIAL_DURATION_MULTIPLIERS,
        )) {
          tuples.push({
            typeId: "residential",
            regionId,
            ispId,
            specId,
            durationId,
            priceFen: periodPriceFen(monthlyFen, multiplier),
          });
        }
      }
    }
  }

  return tuples;
}
