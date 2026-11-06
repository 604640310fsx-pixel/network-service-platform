import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adjacentTabStop,
  filterOptions,
  hasPurchasablePlan,
  initialActiveId,
  moveActiveIndex,
  placePopover,
  typeaheadIndex,
} from "../app/components/subscribe/catalogSelectModel.ts";
import { regionsByType, ispsByTypeAndRegion } from "../app/lib/subscribeCatalog.ts";
import { en } from "../app/i18n/en.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("listbox keys clamp, skip disabled options and ignore unrelated keys", () => {
  const disabled = [false, true, false, false, true, false, false, false];
  assert.equal(moveActiveIndex(-1, "ArrowDown", disabled), 0);
  assert.equal(moveActiveIndex(-1, "ArrowUp", disabled), 7);
  assert.equal(moveActiveIndex(0, "ArrowDown", disabled), 2);
  assert.equal(moveActiveIndex(2, "ArrowUp", disabled), 0);
  assert.equal(moveActiveIndex(7, "ArrowDown", disabled), 7);
  assert.equal(moveActiveIndex(0, "ArrowUp", disabled), 0);
  assert.equal(moveActiveIndex(3, "Home", disabled), 0);
  assert.equal(moveActiveIndex(3, "End", disabled), 7);
  assert.equal(moveActiveIndex(0, "PageDown", disabled), 5);
  assert.equal(moveActiveIndex(7, "PageUp", disabled), 2);
  assert.equal(moveActiveIndex(0, "Tab", disabled), null);
  assert.equal(moveActiveIndex(0, "ArrowDown", [true, true]), null);
});

test("carrier typeahead uses real catalogue names and cycles on a repeated letter", () => {
  const isps = ispsByTypeAndRegion["local-isp"]!.us!;
  const labels = isps.map((isp) => isp.name);
  const none = labels.map(() => false);
  const c1 = typeaheadIndex(labels, none, "c", -1);
  assert.equal(labels[c1], "Cox");
  assert.equal(labels[typeaheadIndex(labels, none, "c", c1)], "Charter");
  assert.equal(labels[typeaheadIndex(labels, none, "at", 0)], "AT&T");
  assert.equal(typeaheadIndex(labels, none, "z", 0), -1);
  assert.equal(typeaheadIndex(labels, labels.map((label) => label === "Cox"), "co", -1), -1);
});

test("country search matches the real Chinese label and the English catalogue name", () => {
  const options = regionsByType["local-isp"]!.map((region) => ({
    id: region.id,
    label: region.name,
    search: [region.name, en.catalog[region.name], region.id].join(" "),
  }));
  assert.equal(options.length, regionsByType["local-isp"]!.length);
  assert.deepEqual(filterOptions(options, "日本").map((option) => option.id), ["jp"]);
  assert.deepEqual(filterOptions(options, "  japan ").map((option) => option.id), ["jp"]);
  assert.ok(filterOptions(options, "united").some((option) => option.id === "us"));
  assert.deepEqual(filterOptions(options, "zzzz"), []);
  assert.equal(filterOptions(options, "").length, options.length);
});

test("Tab / Shift+Tab leave the open select for the neighbouring page tab stops, skipping its own popover", () => {
  // [before, trigger, search input, listbox, after, later]
  const inside = [false, true, true, true, false, false];
  assert.equal(adjacentTabStop(inside, false), 4);
  assert.equal(adjacentTabStop(inside, true), 0);
  // At either end of the document there is no neighbour; the caller keeps focus on the trigger.
  assert.equal(adjacentTabStop([true, true, false], true), -1);
  assert.equal(adjacentTabStop([false, true, true], false), -1);
  assert.equal(adjacentTabStop([false, false], false), -1);
});

test("Tab is handled by the select itself so focus never lands in the closing popover or on body", () => {
  const component = source("../app/components/subscribe/CatalogSelect.tsx");
  const tab = component.slice(component.indexOf('if (key === "Tab")'), component.indexOf('if (key === "Enter"'));
  assert.match(tab, /event\.preventDefault\(\);/);
  assert.match(tab, /tabStopPast\(rootRef\.current, event\.shiftKey\)/);
  assert.match(tab, /close\(false\);\s*\(target \?\? triggerRef\.current\)\?\.focus\(\);/);
  assert.doesNotMatch(tab, /setTimeout/);
  // The scrollable listbox is never a sequential tab stop, in search and list modes alike.
  assert.match(component, /role="listbox"[\s\S]*?tabIndex=\{-1\}/);
  assert.doesNotMatch(component, /tabIndex=\{search \? undefined/);
  // Escape still returns focus to the trigger.
  assert.match(component, /key === "Escape"[\s\S]*?close\(true\)/);
});

test("open/filter keeps the selected option active, otherwise the first enabled one", () => {
  const options = [{ id: "a", label: "A", disabled: true }, { id: "b", label: "B" }, { id: "c", label: "C" }];
  assert.equal(initialActiveId(options, "c"), "c");
  assert.equal(initialActiveId(options, "a"), "b");
  assert.equal(initialActiveId(options, null), "b");
  assert.equal(initialActiveId([], "c"), null);
});

test("popover fits between the sticky top bar and the mobile order bar, flipping only with more room above", () => {
  const base = { gap: 6, chromeHeight: 62, wantedHeight: 312, comfortHeight: 168, minHeight: 72, topLimit: 75 };
  // Plenty of room below: opens down at the wanted height.
  assert.deepEqual(placePopover({ ...base, triggerTop: 200, triggerBottom: 248, bottomLimit: 900 }), { placement: "down", maxHeight: 312 });
  // Order bar close below, lots above: flips up, bounded by the space above.
  assert.deepEqual(placePopover({ ...base, triggerTop: 560, triggerBottom: 608, bottomLimit: 690 }), { placement: "up", maxHeight: 312 });
  // Tight below but comfortable: stays down and shrinks to fit.
  const tight = placePopover({ ...base, triggerTop: 200, triggerBottom: 248, bottomLimit: 500 });
  assert.equal(tight.placement, "down");
  assert.equal(tight.maxHeight, 500 - 248 - 6 - 62);
  // The subscription progress now contributes to the visible top obstacle.
  // An upward menu must fit below it instead of covering the active step.
  const beneathProgress = placePopover({ ...base, topLimit: 146, triggerTop: 380, triggerBottom: 428, bottomLimit: 500 });
  assert.equal(beneathProgress.placement, "up");
  assert.equal(beneathProgress.maxHeight, 380 - 146 - 6 - 62);
  // Never below the minimum row height.
  assert.equal(placePopover({ ...base, triggerTop: 90, triggerBottom: 138, bottomLimit: 150 }).maxHeight, 72);
});

test("availability tag reads only purchasable server tuples and stays unknown while the index is missing", () => {
  const row = (regionId: string, ispId: string, extra: Partial<{ isActive: boolean; soldOut: boolean }> = {}) => ({
    typeId: "local-isp", regionId, ispId, specId: null, durationId: "month-1", priceFen: 7900, isActive: true, soldOut: false, ...extra,
  });
  const index = Object.fromEntries([
    row("us", "us-verizon"),
    row("us", "us-cox", { soldOut: true }),
    row("jp", "jp-ntt", { isActive: false }),
  ].map((item, n) => [String(n), item]));
  assert.equal(hasPurchasablePlan(null, "local-isp", "us"), null);
  assert.equal(hasPurchasablePlan(index, null, "us"), null);
  assert.equal(hasPurchasablePlan(index, "local-isp", "us"), true);
  assert.equal(hasPurchasablePlan(index, "local-isp", "us", "us-verizon"), true);
  assert.equal(hasPurchasablePlan(index, "local-isp", "us", "us-cox"), false);
  assert.equal(hasPurchasablePlan(index, "local-isp", "jp"), false);
  assert.equal(hasPurchasablePlan(index, "residential", "us"), false);
});

test("CatalogSelect is a themed listbox with focus return, dismissal and no hardcoded sample data", () => {
  const component = source("../app/components/subscribe/CatalogSelect.tsx");
  const page = source("../app/components/subscribe/SubscribePage.tsx");
  const css = source("../app/components/subscribe/subscribe-configurator.css");
  assert.match(component, /aria-haspopup="listbox"/);
  assert.match(component, /role="listbox"/);
  assert.match(component, /role="option"[\s\S]*aria-selected=\{option\.id === value\}/);
  assert.match(component, /key === "Escape"[\s\S]*?close\(true\)/);
  assert.match(component, /key === "Tab"[\s\S]*?close\(false\)/);
  assert.match(component, /addEventListener\("pointerdown"/);
  assert.match(component, /triggerRef\.current\?\.focus/);
  assert.match(component, /\.sub-mobile-order-bar/);
  assert.match(component, /\.cc-topbar/);
  // Changing to the same option must not re-run the selection callback (native select parity).
  assert.match(component, /if \(option\.id !== value\) onSelect\(option\.id\)/);
  for (const banned of ["交互候选", "示例数据", "已按链接恢复", "Frontier", "巴西", "Brazil"]) {
    assert.ok(!component.includes(banned) && !page.includes(banned), `unexpected sample text ${banned}`);
  }
  assert.doesNotMatch(component, /\b13\b/);
  assert.match(css, /\.sub-select-list \{[^}]*overflow-x: hidden; overflow-y: auto;/);
  assert.match(css, /\.sub-select-option \{[^}]*box-sizing: border-box; width: 100%; min-width: 0;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.sub-select-option \{ height: 48px;/);
  assert.match(css, /\.sub-configuration:has\(\.sub-select\.is-open\) \{ overflow: visible; \}/);
});
