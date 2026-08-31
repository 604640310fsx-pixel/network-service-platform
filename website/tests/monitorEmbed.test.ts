import test from "node:test";
import assert from "node:assert/strict";
import {
  MONITOR_THEME_MESSAGE_TYPE,
  buildMonitorEmbedUrl,
  createMonitorThemeMessage,
  monitorPostTargetOrigin,
  normalizeMonitorTarget,
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

test("normalizeMonitorTarget mirrors the validated 3002 target key rules", () => {
  assert.equal(normalizeMonitorTarget("DMIT Premium"), "DMIT Premium");
  assert.equal(normalizeMonitorTarget(null), null);
  assert.equal(normalizeMonitorTarget(""), null);
  assert.equal(normalizeMonitorTarget(" leading"), null);
  assert.equal(normalizeMonitorTarget("trailing "), null);
  assert.equal(normalizeMonitorTarget("a".repeat(128)), "a".repeat(128));
  assert.equal(normalizeMonitorTarget("a".repeat(129)), null);
  assert.equal(normalizeMonitorTarget("mid space kept"), "mid space kept");
  const tab = String.fromCharCode(9); // 0x09 C0 control
  const del = String.fromCharCode(127); // 0x7f DEL
  assert.equal(normalizeMonitorTarget("has" + tab + "ctrl"), null);
  assert.equal(normalizeMonitorTarget("has" + del + "del"), null);
});

test("buildMonitorEmbedUrl preserves vps target and writes normalized theme", () => {
  const dark = buildMonitorEmbedUrl(MONITOR, { target: "DMIT Premium", theme: "dark" }, ORIGIN);
  assert.ok(dark);
  const darkUrl = new URL(dark);
  assert.equal(darkUrl.origin, MONITOR);
  assert.equal(darkUrl.searchParams.get("vps"), "DMIT Premium");
  assert.equal(darkUrl.searchParams.get("theme"), "dark");

  const light = buildMonitorEmbedUrl(MONITOR, { target: "DMIT Premium", theme: "light" }, ORIGIN);
  assert.equal(new URL(light!).searchParams.get("theme"), "light");
  assert.equal(new URL(light!).searchParams.get("vps"), "DMIT Premium");
});

test("buildMonitorEmbedUrl omits vps when there is no target but still sets theme", () => {
  const result = buildMonitorEmbedUrl(MONITOR, { target: null, theme: "light" }, ORIGIN);
  assert.ok(result);
  const url = new URL(result);
  assert.equal(url.searchParams.has("vps"), false);
  assert.equal(url.searchParams.get("theme"), "light");
});

test("buildMonitorEmbedUrl clears a pre-existing vps when target is null", () => {
  const result = buildMonitorEmbedUrl(MONITOR + "/?vps=stale", { target: null, theme: "dark" }, ORIGIN);
  assert.equal(new URL(result!).searchParams.has("vps"), false);
});

test("buildMonitorEmbedUrl adds view=mini only when compact is requested", () => {
  const compact = buildMonitorEmbedUrl(MONITOR, { target: null, theme: "dark", compact: true }, ORIGIN);
  const compactUrl = new URL(compact!);
  assert.equal(compactUrl.searchParams.get("view"), "mini");
  assert.equal(compactUrl.searchParams.get("theme"), "dark");
  assert.equal(compactUrl.searchParams.has("vps"), false);

  const full = buildMonitorEmbedUrl(MONITOR, { target: null, theme: "dark" }, ORIGIN);
  assert.equal(new URL(full!).searchParams.has("view"), false);

  const explicitFalse = buildMonitorEmbedUrl(MONITOR, { target: null, theme: "light", compact: false }, ORIGIN);
  assert.equal(new URL(explicitFalse!).searchParams.has("view"), false);
});

test("buildMonitorEmbedUrl clears a pre-existing view when compact is not requested", () => {
  const result = buildMonitorEmbedUrl(MONITOR + "/?view=mini", { target: null, theme: "dark" }, ORIGIN);
  assert.equal(new URL(result!).searchParams.has("view"), false);
});

test("buildMonitorEmbedUrl keeps vps and view=mini together for a compact targeted embed", () => {
  const result = buildMonitorEmbedUrl(MONITOR, { target: "DMIT Premium", theme: "light", compact: true }, ORIGIN);
  const url = new URL(result!);
  assert.equal(url.searchParams.get("vps"), "DMIT Premium");
  assert.equal(url.searchParams.get("view"), "mini");
  assert.equal(url.searchParams.get("theme"), "light");
});

test("buildMonitorEmbedUrl rejects unconfigured or unsafe bases", () => {
  assert.equal(buildMonitorEmbedUrl(undefined, { target: null, theme: "dark" }, ORIGIN), null);
  assert.equal(buildMonitorEmbedUrl("   ", { target: null, theme: "dark" }, ORIGIN), null);
  assert.equal(buildMonitorEmbedUrl("ftp://monitor.example", { target: null, theme: "dark" }, ORIGIN), null);
  assert.equal(
    buildMonitorEmbedUrl("https://user:pass@monitor.example", { target: null, theme: "dark" }, ORIGIN),
    null,
  );
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
