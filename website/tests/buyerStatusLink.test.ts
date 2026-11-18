import assert from "node:assert/strict";
import test from "node:test";
import {
  buyerStatusHref,
  resolveBuyerStatusHref,
} from "../app/lib/buyerStatusLink.ts";

test("buyerStatusHref always opens the target-free buyer status route", () => {
  assert.equal(buyerStatusHref(), "/status");
  assert.equal(buyerStatusHref.length, 0);
});

test("resolveBuyerStatusHref never accepts account data or creates a query", () => {
  assert.equal(resolveBuyerStatusHref(), "/status");
  assert.equal(resolveBuyerStatusHref.length, 0);
});
