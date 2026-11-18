import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  CATALOG_VERSION,
  enumeratePriceTuples,
  PAYMENT_MAX_SINGLE_FEN,
  resolvePriceFen,
  type PriceTuple,
} from "../../src/payment/pricing.js";

type WebsiteCatalog = {
  networkTypes: Array<{ id: string; requiresSpec: boolean }>;
  regionsByType: Record<string, Array<{ id: string; configured: boolean }>>;
  ispsByTypeAndRegion: Record<string, Record<string, Array<{ id: string }>>>;
  specsByIsp: Record<
    string,
    Array<{ id: string; pricesByDuration: Partial<Record<string, number>> }>
  >;
  durationsByType: Record<string, Array<{ id: string; price: number | null }>>;
};

function tupleKey(tuple: PriceTuple): string {
  return [
    tuple.typeId,
    tuple.regionId,
    tuple.ispId,
    tuple.specId ?? "",
    tuple.durationId,
  ].join("\u0000");
}

function sortTuples(tuples: PriceTuple[]): PriceTuple[] {
  return [...tuples].sort((left, right) => tupleKey(left).localeCompare(tupleKey(right)));
}

async function loadFrozenWebsiteCatalog(): Promise<WebsiteCatalog> {
  const authServiceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const catalogPath = join(
    authServiceRoot,
    "../website/app/lib/subscribeCatalog.ts",
  );
  const source = await readFile(catalogPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: catalogPath,
  }).outputText;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
  return (await import(dataUrl)) as unknown as WebsiteCatalog;
}

function enumerateWebsitePriceTuples(catalog: WebsiteCatalog): PriceTuple[] {
  const tuples: PriceTuple[] = [];

  for (const type of catalog.networkTypes) {
    for (const region of catalog.regionsByType[type.id] ?? []) {
      if (!region.configured) continue;
      for (const isp of catalog.ispsByTypeAndRegion[type.id]?.[region.id] ?? []) {
        const specs = type.requiresSpec ? (catalog.specsByIsp[isp.id] ?? []) : [null];
        for (const spec of specs) {
          for (const duration of catalog.durationsByType[type.id] ?? []) {
            const priceYuan = duration.price ?? spec?.pricesByDuration[duration.id] ?? null;
            if (priceYuan === null) continue;
            tuples.push({
              typeId: type.id,
              regionId: region.id,
              ispId: isp.id,
              specId: spec?.id ?? null,
              durationId: duration.id,
              priceFen: priceYuan * 100,
            });
          }
        }
      }
    }
  }

  return tuples;
}

test("server pricing exactly matches all frozen Website catalog combinations", async () => {
  const websiteTuples = enumerateWebsitePriceTuples(await loadFrozenWebsiteCatalog());
  const serverTuples = enumeratePriceTuples();

  assert.equal(CATALOG_VERSION, "SUBSCRIBE-CATALOG-V1");
  assert.equal(websiteTuples.length, 255);
  assert.equal(serverTuples.length, 255);
  assert.equal(new Set(websiteTuples.map(tupleKey)).size, 255);
  assert.equal(new Set(serverTuples.map(tupleKey)).size, 255);
  assert.deepEqual(sortTuples(serverTuples), sortTuples(websiteTuples));

  for (const tuple of websiteTuples) {
    assert.equal(Number.isInteger(tuple.priceFen), true);
    assert.equal(resolvePriceFen(tuple), tuple.priceFen, tupleKey(tuple));
  }
});

test("single-payment cap identifies the frozen 29 over-limit combinations", async () => {
  const websiteTuples = enumerateWebsitePriceTuples(await loadFrozenWebsiteCatalog());
  const serverTuples = enumeratePriceTuples();

  assert.equal(PAYMENT_MAX_SINGLE_FEN, 200_000);
  const websiteOverLimit = sortTuples(
    websiteTuples.filter((tuple) => tuple.priceFen > PAYMENT_MAX_SINGLE_FEN),
  );
  const serverOverLimit = sortTuples(
    serverTuples.filter((tuple) => tuple.priceFen > PAYMENT_MAX_SINGLE_FEN),
  );
  assert.equal(websiteOverLimit.length, 29);
  assert.equal(serverOverLimit.length, 29);
  assert.deepEqual(serverOverLimit, websiteOverLimit);
});

test("resolver rejects selections outside the frozen catalog dependency chain", () => {
  assert.equal(
    resolvePriceFen({
      typeId: "residential",
      regionId: "vn",
      ispId: "sptel",
      specId: "shared-5",
      durationId: "month-1",
    }),
    null,
  );
  assert.equal(
    resolvePriceFen({
      typeId: "local-isp",
      regionId: "us",
      ispId: "us-verizon",
      specId: null,
      durationId: "month-3",
    }),
    null,
  );
  assert.equal(
    resolvePriceFen({
      typeId: "local-isp",
      regionId: "us",
      ispId: "us-verizon",
      specId: "forged-spec",
      durationId: "month-1",
    }),
    null,
  );
  assert.equal(
    resolvePriceFen({
      typeId: "us-local-carrier",
      regionId: "us",
      ispId: "ntt",
      specId: "forged-spec",
      durationId: "month-1",
    }),
    null,
  );
});
