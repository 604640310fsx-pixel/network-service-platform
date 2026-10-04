import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("homepage latency preview: illustrative SVG curves, CSS-only motion, values stay unknown", () => {
  const page = source("../app/components/home/HomePage.tsx");
  const css = source("../app/components/home/home.css");
  // Decorative curves only: hidden from assistive tech, no live numbers, no monitor/API reads.
  assert.match(page, /<span className="home-latency-track" aria-hidden="true">\s*<svg className="home-latency-curve"/);
  assert.match(page, /<b>—<\/b>/);
  assert.doesNotMatch(page, /requestAnimationFrame|setInterval\(/);
  const showcase = page.slice(page.indexOf("const LATENCY_SHAPES"), page.indexOf("function ConsoleShowcase"));
  assert.doesNotMatch(showcase, /fetch\(|\/api\//);
  // Motion is a CSS transform loop that the reduced-motion block switches off.
  assert.match(css, /\.home-latency-curve \{[^}]*animation: home-latency-drift 28s linear infinite;/);
  assert.match(css, /@keyframes home-latency-drift \{ from \{ transform: translateX\(0\); \} to \{ transform: translateX\(-50%\); \} \}/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.home-latency-curve \{ animation: none; \}|\.home-latency-curve\s*\{\s*animation:\s*none;/);
  assert.match(reduced, /\.home-showcase-panel,\s*\.home-latency-curve \{ animation: none; \}/);
});

test("buyer delivered-line row centers index, name, badge and status link", () => {
  const css = source("../app/components/network/buyer-network.css");
  assert.match(css, /\.cc-net-line-label \{[^}]*display: flex; align-items: center;/);
  assert.doesNotMatch(css, /\.cc-net-line-label-index \{[^}]*margin-top/);
  assert.doesNotMatch(css, /\.cc-net-line-label-go \{[^}]*padding-top/);
  assert.match(css, /@media \(max-width: 480px\) \{\s*\.cc-net-line-label \{ flex-wrap: wrap; row-gap: 6px; \}/);
});
