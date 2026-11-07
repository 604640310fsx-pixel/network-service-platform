import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

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

test("country trigger and open rows render local original flags; unknown codes keep the globe fallback", () => {
  const loader = createTsxLoader();
  const React = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const { CatalogSelect } = loader.load("app/components/subscribe/CatalogSelect.tsx");
  const countries = [...new Map(Object.values(regionsByType).flat().map(region => [region.flagClass, region])).values()];
  const options = countries.map(region => ({ id: region.id, label: region.name, flagClass: region.flagClass }));
  const render = (value: string | null, choices = options) => renderToStaticMarkup(React.createElement(CatalogSelect as never, {
    label: "国家或地区", placeholder: "请选择", value, options: choices, onSelect() {},
  } as never));
  for (const option of options) {
    const html = render(option.id);
    assert.match(html, new RegExp(`<img[^>]*src="/subscription-flags/${option.flagClass}\\.svg"[^>]*width="20"[^>]*height="15"[^>]*alt=""`));
    assert.doesNotMatch(html, /<i class="sub-flag/);
    assert.match(source(`../public/subscription-flags/${option.flagClass}.svg`), /viewBox="0 0 640 480"/);
  }
  const fallback = [{ id: "unknown", label: "未知地区", flagClass: "../../unexpected" }, { id: "more", label: "更多地区", flagClass: "globe" }];
  for (const option of fallback) {
    const html = render(option.id, fallback);
    assert.match(html, /<i class="sub-flag is-globe" aria-hidden="true"/);
    assert.doesNotMatch(html, /<img|unexpected/);
  }
  assert.doesNotMatch(render(null), /<img|<i class="sub-flag/);
  const useState = React.useState;
  const state = mock.method(React, "useState", (initial: unknown) => useState(initial === false ? true : initial));
  try {
    const html = render("vn", [...options, ...fallback]);
    const list = html.slice(html.indexOf('<ul'));
    assert.equal((list.match(/<img /g) ?? []).length, options.length);
    for (const option of options) assert.ok(list.includes(`src="/subscription-flags/${option.flagClass}.svg"`));
    assert.equal((list.match(/class="sub-flag is-globe"/g) ?? []).length, fallback.length);
    assert.doesNotMatch(list, /unexpected|class="sub-flag is-vn"/);
  } finally {
    state.mock.restore();
  }
});

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

test("a touch/pen open focuses the list, not the search box; mouse and keyboard opens still focus search", () => {
  const component = source("../app/components/subscribe/CatalogSelect.tsx");
  // The opening press type is recorded on the trigger and cleared by any trigger key, so keyboard opens count as non-touch.
  assert.match(component, /onPointerDown=\{\(event\) => \{ openPointer\.current = event\.pointerType; \}\}/);
  assert.match(component, /function onTriggerKeyDown[^{]*\{\s*openPointer\.current = "";/);
  assert.match(component, /setTouchOpened\(openPointer\.current === "touch" \|\| openPointer\.current === "pen"\)/);
  // Only a non-touch open puts focus (and so the soft keyboard) in the search input.
  assert.match(component, /\(searchable && !touchOpened \? inputRef\.current : listRef\.current\)\?\.focus\(\{ preventScroll: true \}\)/);
  // A touch-opened list keeps focus (no redirect to the input) and drives its own keys and active descendant.
  assert.match(component, /onFocus=\{search && !touchOpened \? \(\) => inputRef\.current\?\.focus/);
  assert.match(component, /aria-activedescendant=\{search && !touchOpened \? undefined : activeDomId\}/);
  assert.match(component, /onKeyDown=\{search && !touchOpened \? undefined : onListKeyDown\}/);
  // Space picks from the focused list (also when touch-opened with a search box) but is a typed space inside the input.
  assert.match(component, /key === "Enter" \|\| \(key === " " && event\.currentTarget !== inputRef\.current\)/);
  assert.doesNotMatch(component, /key === " " && !search/);
  // Option presses still keep focus where it is, so picking never re-summons or drops the keyboard mid-tap.
  assert.match(component, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("PROPOSAL: on phones with dvh support the fixed order bar is top-anchored at the dynamic viewport bottom", () => {
  const css = source("../app/components/subscribe/subscribe-configurator.css");
  const base = source("../app/components/subscribe/subscribe.css");
  const phone = css.slice(css.indexOf("@media (max-width: 900px)"), css.indexOf("@supports (height: 100dvh)"));
  const candidate = css.slice(css.indexOf("@supports (height: 100dvh)"), css.indexOf("@media (max-width: 600px)"));
  // The block uses only dvh, so it is gated on dvh alone; without it the bottom-anchored rule and measured reserves above apply.
  assert.match(candidate, /^@supports \(height: 100dvh\) \{/);
  assert.doesNotMatch(css, /100svh|100lvh/);
  // Fallback (no dvh): the original bottom-anchored fixed bar and its reserves.
  assert.match(phone, /\.sub-configurator-v11 \.sub-mobile-order-bar \{ display: flex; \}/);
  assert.match(phone, /\.sub-configurator-v11 \.sub-layout \{[^}]*padding-bottom: calc\(100px \+ env\(safe-area-inset-bottom\)\);/);
  assert.doesNotMatch(css, /position: sticky; left: auto; right: auto;/);
  // Candidate: same element, lifted by its own height from 100dvh; it sets nothing else (no reserve overrides, no extra offsets).
  assert.match(candidate, /@media \(max-width: 900px\)/);
  assert.match(candidate, /\.sub-configurator-v11 \.sub-mobile-order-bar \{ top: 100dvh; bottom: auto; transform: translateY\(-100%\); \}/);
  assert.doesNotMatch(candidate, /sub-layout|sub-order-drawer|padding/);
  const declarations = candidate.match(/\.sub-mobile-order-bar \{([^}]*)\}/g) ?? [];
  assert.equal(declarations.length, 1);
  assert.doesNotMatch(declarations[0], /\d+px/);
  // Size, look, z-index and safe-area padding still come from the unchanged base rule.
  assert.match(base, /\.sub-mobile-order-bar \{ display: none; position: fixed; left: 0; right: 0; bottom: 0; z-index: 70;[^}]*padding: 10px 14px calc\(10px \+ env\(safe-area-inset-bottom\)\);/);
});

test("the drawer and page end reserve the order bar's measured height, published on the page like StepProgress", () => {
  const bar = source("../app/components/subscribe/MobileOrderBar.tsx");
  const css = source("../app/components/subscribe/subscribe-configurator.css");
  const phone = css.slice(css.indexOf("@media (max-width: 900px)"), css.indexOf("@supports (height: 100dvh)"));
  assert.ok(css.indexOf("@supports (height: 100dvh)") > css.indexOf("@media (max-width: 900px)"));
  // Page-scoped (not document-global), measured from the bar itself, kept in sync and cleaned up.
  assert.match(bar, /const page = bar\?\.closest<HTMLElement>\("\.sub-configurator-v11"\);/);
  assert.match(bar, /const height = bar\.getBoundingClientRect\(\)\.height;/);
  assert.match(bar, /if \(height > 0\) page\.style\.setProperty\("--sub-order-bar-height", `\$\{height\}px`\);\s*else page\.style\.removeProperty\("--sub-order-bar-height"\);/);
  assert.match(bar, /window\.addEventListener\("resize", syncHeight\);/);
  assert.match(bar, /new ResizeObserver\(syncHeight\)/);
  assert.match(bar, /observer\?\.observe\(bar\);/);
  assert.match(bar, /window\.removeEventListener\("resize", syncHeight\);\s*observer\?\.disconnect\(\);\s*page\.style\.removeProperty\("--sub-order-bar-height"\);/);
  assert.match(bar, /<div ref=\{barRef\} className="sub-mobile-order-bar">/);
  assert.doesNotMatch(bar, /document\.documentElement\.style/);
  // The bar itself never consumes its own measurement (no sizing feedback loop); only the reserves do, without adding env() twice.
  assert.doesNotMatch(css, /\.sub-mobile-order-bar \{[^}]*--sub-order-bar-height/);
  // + 1px only: scroll limits are floored to whole CSS pixels, so the measured shortfall is the fractional part (< 1px).
  assert.match(phone, /\.sub-configurator-v11 \.sub-layout \{ padding-bottom: max\(calc\(100px \+ env\(safe-area-inset-bottom\)\), calc\(var\(--sub-order-bar-height, 0px\) \+ 1px\)\); \}/);
  assert.match(phone, /\.sub-configurator-v11 \.sub-order-drawer \{ padding-bottom: calc\(var\(--sub-order-bar-height, calc\(72px \+ env\(safe-area-inset-bottom\)\)\) \+ 1px\); \}/);
  assert.doesNotMatch(css, /var\(--sub-order-bar-height[^;]*\+ (?:[2-9]|\d{2,})px/);
  assert.doesNotMatch(css, /var\(--sub-order-bar-height[^;]*\)\s*\+\s*env\(safe-area-inset-bottom\)/);
});
