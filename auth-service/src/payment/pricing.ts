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
    pricesByDuration: {
      "month-1": 7_900,
      "month-6": 39_900,
      "month-12": 69_900,
    },
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

type DurationMultiplier = readonly [numerator: number, denominator: number];

const RESIDENTIAL_DURATION_MULTIPLIERS: Readonly<Record<string, DurationMultiplier>> = {
  "month-1": [1, 1],
  "month-3": [27, 10],
  "month-6": [51, 10],
  "month-12": [48, 5],
};

function hasLinkedIsp(
  ispsByRegion: Readonly<Record<string, readonly string[]>>,
  regionId: string,
  ispId: string,
): boolean {
  return ispsByRegion[regionId]?.includes(ispId) ?? false;
}

function residentialPriceFen(monthlyFen: number, multiplier: DurationMultiplier): number {
  const [numerator, denominator] = multiplier;
  const roundedYuan = Math.floor(
    (monthlyFen * numerator + 50 * denominator) / (100 * denominator),
  );
  return roundedYuan * 100;
}

export function resolvePriceFen(selection: PriceSelection): number | null {
  const { typeId, regionId, ispId, specId, durationId } = selection;
  if (!typeId || !regionId || !ispId || !durationId) return null;

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
  return residentialPriceFen(monthlyFen, multiplier);
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
            priceFen: residentialPriceFen(monthlyFen, multiplier),
          });
        }
      }
    }
  }

  return tuples;
}
