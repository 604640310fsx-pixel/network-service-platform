import assert from "node:assert/strict";
import test from "node:test";
import {
  buyerStatusHref,
  resolveBuyerStatusHref,
} from "../app/lib/buyerStatusLink.ts";

test("buyerStatusHref opens the buyer status page and preserves an exact VPS target", () => {
  assert.equal(buyerStatusHref(null), "/status");
  assert.equal(
    buyerStatusHref("DMIT Premium"),
    "/status?vps=DMIT%20Premium",
  );
  assert.equal(
    buyerStatusHref("香港 Yecaoyun Cloud"),
    "/status?vps=%E9%A6%99%E6%B8%AF%20Yecaoyun%20Cloud",
  );
});

test("resolveBuyerStatusHref uses the first bound delivered line and skips unbound lines", () => {
  assert.equal(
    resolveBuyerStatusHref([
      { lines: [{ monitorTargetKey: null }] },
      {
        lines: [
          { monitorTargetKey: "DMIT Eyeball" },
          { monitorTargetKey: "NetLab Global US" },
        ],
      },
    ]),
    "/status?vps=DMIT%20Eyeball",
  );
  assert.equal(resolveBuyerStatusHref([{ lines: [] }]), "/status");
});
