import test from "node:test";
import assert from "node:assert/strict";
import {
  MONITOR_LANG_MESSAGE_TYPE,
  MONITOR_THEME_MESSAGE_TYPE,
  buildMonitorEmbedUrl,
  createMonitorLangMessage,
  createMonitorThemeMessage,
  isMonitorFixturePreview,
  monitorBannerMode,
  monitorPostTargetOrigin,
  normalizeMonitorTheme,
} from "../app/lib/monitorEmbed.ts";

const ORIGIN = "https://buyer.example";
const MONITOR = "https://monitor.example";

test("normalizeMonitorTheme only accepts light, else dark", () => {
  assert.equal(normalizeMonitorTheme("light"), "light");
  assert.equal(normalizeMonitorTheme("dark"), "dark");
  assert.equal(normalizeMonitorTheme(undefined), "dark");
  assert.equal(normalizeMonitorTheme(null), "dark");
  assert.equal(normalizeMonitorTheme("LIGHT"), "dark");
  assert.equal(normalizeMonitorTheme("system"), "dark");
});

test("buildMonitorEmbedUrl removes all configured identity/query values and writes theme", () => {
  const result = buildMonitorEmbedUrl(
    MONITOR + "/?vps=private-target&customer=private-customer&theme=stale",
    { theme: "light" },
    ORIGIN,
  );
  assert.ok(result);
  const url = new URL(result);
  assert.equal(url.searchParams.has("vps"), false);
  assert.equal(url.searchParams.has("customer"), false);
  assert.equal(url.searchParams.get("theme"), "light");
  assert.deepEqual([...url.searchParams.keys()], ["theme"]);
});

test("buildMonitorEmbedUrl emits only the requested public display mode", () => {
  const compact = buildMonitorEmbedUrl(MONITOR, { theme: "dark", compact: true }, ORIGIN);
  const compactUrl = new URL(compact!);
  assert.equal(compactUrl.searchParams.get("view"), "mini");
  assert.equal(compactUrl.searchParams.get("theme"), "dark");
  assert.equal(compactUrl.searchParams.has("vps"), false);

  const embedded = buildMonitorEmbedUrl(MONITOR, { theme: "light", embedded: true }, ORIGIN);
  assert.equal(new URL(embedded!).searchParams.get("view"), "embed");

  const fixture = buildMonitorEmbedUrl(
    MONITOR + "/?preview=fixture&hidden=removed",
    { theme: "dark", embedded: true },
    ORIGIN,
  );
  assert.deepEqual([...new URL(fixture!).searchParams.keys()], ["preview", "view", "theme"]);
  assert.equal(new URL(fixture!).searchParams.get("preview"), "fixture");

  const full = buildMonitorEmbedUrl(MONITOR + "/?view=mini", { theme: "dark" }, ORIGIN);
  assert.equal(new URL(full!).searchParams.has("view"), false);

  assert.equal(
    buildMonitorEmbedUrl(MONITOR, { theme: "dark", compact: true, embedded: true }, ORIGIN),
    null,
  );
});

test("buildMonitorEmbedUrl rejects unconfigured or unsafe bases", () => {
  assert.equal(buildMonitorEmbedUrl(undefined, { theme: "dark" }, ORIGIN), null);
  assert.equal(buildMonitorEmbedUrl("   ", { theme: "dark" }, ORIGIN), null);
  assert.equal(buildMonitorEmbedUrl("ftp://monitor.example", { theme: "dark" }, ORIGIN), null);
  assert.equal(
    buildMonitorEmbedUrl("https://user:pass@monitor.example", { theme: "dark" }, ORIGIN),
    null,
  );
});

test("isMonitorFixturePreview only accepts the exact fixture marker", () => {
  assert.equal(isMonitorFixturePreview(MONITOR + "/?preview=fixture", ORIGIN), true);
  assert.equal(isMonitorFixturePreview(MONITOR + "/?preview=Fixture", ORIGIN), false);
  assert.equal(isMonitorFixturePreview(MONITOR + "/?preview=live", ORIGIN), false);
  assert.equal(isMonitorFixturePreview(MONITOR, ORIGIN), false);
  assert.equal(isMonitorFixturePreview(undefined, ORIGIN), false);
  assert.equal(isMonitorFixturePreview("ftp://monitor.example/?preview=fixture", ORIGIN), false);
});

test("monitorPostTargetOrigin returns the exact monitor origin, never a wildcard", () => {
  assert.equal(monitorPostTargetOrigin(MONITOR + "/deep/path?x=1", ORIGIN), MONITOR);
  assert.equal(monitorPostTargetOrigin("https://monitor.example:8443", ORIGIN), "https://monitor.example:8443");
  assert.equal(monitorPostTargetOrigin(undefined, ORIGIN), null);
  assert.equal(monitorPostTargetOrigin("ftp://monitor.example", ORIGIN), null);
  assert.notEqual(monitorPostTargetOrigin(MONITOR, ORIGIN), "*");
});

test("createMonitorThemeMessage is a narrow, versioned, data-free payload", () => {
  assert.equal(MONITOR_THEME_MESSAGE_TYPE, "nsp-monitor-theme:v1");
  assert.deepEqual(createMonitorThemeMessage("light"), { type: "nsp-monitor-theme:v1", theme: "light" });
  assert.deepEqual(createMonitorThemeMessage("dark"), { type: "nsp-monitor-theme:v1", theme: "dark" });
  assert.deepEqual(createMonitorThemeMessage("weird" as never), { type: "nsp-monitor-theme:v1", theme: "dark" });
  assert.deepEqual(Object.keys(createMonitorThemeMessage("light")).sort(), ["theme", "type"]);
});

test("monitorBannerMode never reports a live embed without a valid public URL", () => {
  assert.equal(monitorBannerMode(undefined, ORIGIN), "unconfigured");
  assert.equal(monitorBannerMode("", ORIGIN), "unconfigured");
  assert.equal(monitorBannerMode("   ", ORIGIN), "unconfigured");
  assert.equal(monitorBannerMode("ftp://monitor.example", ORIGIN), "unconfigured");
  assert.equal(monitorBannerMode("https://user:pw@monitor.example", ORIGIN), "unconfigured");
  assert.equal(monitorBannerMode(MONITOR + "/?preview=fixture", ORIGIN), "fixture");
  assert.equal(monitorBannerMode(MONITOR + "/?preview=other", ORIGIN), "embed");
  assert.equal(monitorBannerMode(MONITOR, ORIGIN), "embed");
});

test("lang is an optional, normalized embed parameter and a narrow versioned message", () => {
  const MONITOR_BASE = "https://monitor.example.net/?lang=fr&vps=private-target";
  const en = new URL(buildMonitorEmbedUrl(MONITOR_BASE, { theme: "dark", lang: "en", embedded: true }, "https://www.example.net")!);
  assert.deepEqual([...en.searchParams.keys()], ["view", "theme", "lang"]);
  assert.equal(en.searchParams.get("lang"), "en");
  const odd = new URL(buildMonitorEmbedUrl(MONITOR_BASE, { theme: "dark", lang: "fr" as never, compact: true }, "https://www.example.net")!);
  assert.equal(odd.searchParams.get("lang"), "zh");
  const none = new URL(buildMonitorEmbedUrl(MONITOR_BASE, { theme: "dark" }, "https://www.example.net")!);
  assert.equal(none.searchParams.has("lang"), false);

  assert.equal(MONITOR_LANG_MESSAGE_TYPE, "nsp-monitor-lang:v1");
  assert.deepEqual(createMonitorLangMessage("en"), { type: "nsp-monitor-lang:v1", lang: "en" });
  assert.deepEqual(createMonitorLangMessage("weird" as never), { type: "nsp-monitor-lang:v1", lang: "zh" });
  assert.deepEqual(Object.keys(createMonitorLangMessage("zh")).sort(), ["lang", "type"]);
});
