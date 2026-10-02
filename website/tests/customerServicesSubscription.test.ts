import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/components/customer/CustomerServicesPage.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: "CustomerServicesPage.tsx",
}).outputText;
const runtimeModule: { exports: Record<string, unknown> } = { exports: {} };
Function("require", "module", "exports", compiled)(
  (specifier: string) => {
    if (specifier === "../../lib/payment-api") return { PaymentApiError: class extends Error {} };
    if (specifier === "../../lib/i18n") return { useT: () => ({}) };
    if (["react", "react-router-dom", "../subscription-import", "./customer-services.css", "react/jsx-runtime"].includes(specifier)) return {};
    throw new Error(`Unexpected import: ${specifier}`);
  },
  runtimeModule,
  runtimeModule.exports,
);
const ownedDeliveryItems = runtimeModule.exports.ownedDeliveryItems as (
  item: Record<string, unknown>,
  snapshot: Record<string, unknown>,
) => readonly unknown[] | null;

const service = {
  orderRef: "DLPREVIEWA",
  amountFen: 100,
  currency: "CNY",
  orderStatus: "paid",
  serviceStatus: "open",
};
const delivery = [{ position: 1, label: "演示线路 A", subscriptionUrl: "https://a.example.invalid/demo" }];
const snapshot = {
  orderRef: service.orderRef,
  amountFen: service.amountFen,
  currency: service.currency,
  status: service.orderStatus,
  service: { status: "open", items: delivery },
};

test("a service card accepts only its matching authorized order snapshot", () => {
  assert.deepEqual(ownedDeliveryItems(service, snapshot), delivery);
  assert.equal(ownedDeliveryItems(service, { ...snapshot, orderRef: "DLPREVIEWB" }), null);
  assert.equal(ownedDeliveryItems(service, { ...snapshot, amountFen: 200 }), null);
  assert.equal(ownedDeliveryItems(service, { ...snapshot, status: "pending" }), null);
  assert.equal(ownedDeliveryItems(service, { ...snapshot, service: { status: "pending_open" } }), null);
});

test("an open snapshot without delivery remains an honest missing state", () => {
  assert.deepEqual(ownedDeliveryItems(service, { ...snapshot, service: { status: "open" } }), []);
  assert.equal(ownedDeliveryItems({ ...service, serviceStatus: "pending_open" }, snapshot), null);
});
