import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("homepage console showcase: static fictional demo fixtures, labelled demo, no live reads or real identifiers", () => {
  const page = source("../app/components/home/HomePage.tsx");
  const css = source("../app/components/home/home.css");
  const zh = source("../app/i18n/zh.ts");
  const en = source("../app/i18n/en.ts");
  // Curves are decorative (values are shown as text), static and drawn from the same fixture as the values.
  assert.match(page, /<span className="home-latency-track" aria-hidden="true">\s*<svg className="home-latency-curve" viewBox="0 0 100 22"/);
  assert.match(page, /now: row\.samples\[row\.samples\.length - 1\]!/);
  assert.match(page, /<b>\{data\.now\} ms<\/b>/);
  assert.doesNotMatch(page, /requestAnimationFrame|setInterval\(/);
  const fixtures = page.slice(page.indexOf("type DemoHopNode"), page.indexOf("function ConsoleShowcase"));
  const showcase = page.slice(page.indexOf("function ConsoleShowcase"), page.indexOf("export function HomePage"));
  for (const block of [fixtures, showcase]) {
    assert.doesNotMatch(block, /fetch\(|\/api\/|useEffect\([^)]*fetch/);
    // No IP addresses of any kind; ASNs only from the RFC 5398 documentation range, rDNS only under example.net.
    assert.doesNotMatch(block, /\b\d{1,3}(?:\.\d{1,3}){3}\b|[0-9a-f]{1,4}::[0-9a-f]{0,4}/i);
  }
  for (const asn of fixtures.match(/AS\d+/g) ?? []) {
    const number = Number(asn.slice(2));
    assert.ok(number >= 64496 && number <= 64511, `${asn} must be a documentation ASN`);
  }
  for (const host of fixtures.match(/rdns: "[^"]+"/g) ?? []) assert.match(host, /\.example\.net"$/);
  // Usage never exceeds its total.
  assert.match(page, /usage: \{ used: 412, total: 1000 \}/);
  // Demo provenance stays visible on every tab (bar chip + per-panel note) in both languages.
  assert.match(page, /<span className="home-chip is-demo">\{copy\.previewChip\}<\/span>/);
  assert.match(page, /\{copy\.previewNote\(viewCopy\.caption\)\}/);
  assert.match(zh, /previewChip: "演示数据，非实时"/);
  assert.match(zh, /previewNote: \(caption: string\) => `演示数据，非实时 · \$\{caption\}`/);
  assert.match(en, /previewChip: "Demo data · not live"/);
  assert.match(en, /previewNote: \(caption: string\) => `Demo data · not live · \$\{caption\}`/);
  // Phones keep hop + node + latency readable without horizontal scrolling; region, ASN and rDNS collapse.
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(phone, /\.home-route-row \{ grid-template-columns: 34px minmax\(0, 1fr\) 56px; gap: 10px; \}/);
  assert.match(phone, /\.home-route-row > span:nth-child\(5\) \{ display: none; \}/);
  assert.doesNotMatch(phone, /\.home-route-row > span:nth-child\(3\) \{ display: none; \}/);
  // No drift loop any more; the reduced-motion block still neutralises panel motion.
  assert.doesNotMatch(css, /home-latency-drift/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.home-showcase-panel,\s*\.home-latency-curve \{ animation: none; \}/);
});

test("buyer delivered-line row centers index, name, badge and status link", () => {
  const css = source("../app/components/network/buyer-network.css");
  assert.match(css, /\.cc-net-line-label \{[^}]*display: flex; align-items: center;/);
  assert.doesNotMatch(css, /\.cc-net-line-label-index \{[^}]*margin-top/);
  assert.doesNotMatch(css, /\.cc-net-line-label-go \{[^}]*padding-top/);
  assert.match(css, /@media \(max-width: 480px\) \{\s*\.cc-net-line-label \{ flex-wrap: wrap; row-gap: 6px; \}/);
});
