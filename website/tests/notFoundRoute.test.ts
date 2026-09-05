import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sectionKeys } from "../app/lib/sections.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const app = source("../src/App.tsx");
const dashboardShell = source("../app/components/DashboardShell.tsx");
const notFoundPage = source("../app/components/not-found/NotFoundPage.tsx");

test("known public and protected route classifications remain unchanged", () => {
  for (const publicPath of ["/", "/login", "/register", "/diagnosis", "/subscribe/request"]) {
    assert.match(app, new RegExp(`path=["']${publicPath.replace("/", "\\/")}["']`));
  }

  assert.deepEqual(sectionKeys, [
    "status",
    "dashboard",
    "services",
    "network",
    "monitor",
    "orders",
    "subscribe",
    "docs",
    "profile",
  ]);
  assert.match(app, /section === "subscribe" \|\| section === "monitor"/);
  assert.match(app, /status === "unauthenticated"\) return <Navigate to="\/login" replace/);
});

test("unknown single-segment routes become NotFound before auth redirects", () => {
  const unknownCheck = app.indexOf("if (!isSectionKey(section)) return <NotFoundPage />");
  const loginRedirect = app.indexOf('return <Navigate to="/login" replace />', unknownCheck);

  assert.notEqual(unknownCheck, -1);
  assert.ok(loginRedirect > unknownCheck);
  assert.match(app, /sectionKeys\.includes\(section as SectionKey\)/);
});

test("unknown multi-segment routes and DashboardShell fallbacks fail closed to NotFound", () => {
  assert.match(app, /<Route path="\*" element=\{<NotFoundPage \/>\} \/>/);
  assert.doesNotMatch(app, /<Route path="\*" element=\{<Navigate/);
  assert.match(dashboardShell, /if \(!sectionKeys\.includes[\s\S]*?return <NotFoundPage \/>/);
  assert.doesNotMatch(dashboardShell, /Navigate to="\/dashboard"/);
  assert.match(dashboardShell, /return <NotFoundPage \/>;\s*\n\}/);
});

test("NotFound UI has an accessible heading, explanation, and internal home action", () => {
  assert.match(notFoundPage, /<h1 id="not-found-title">页面不存在<\/h1>/);
  assert.match(notFoundPage, /<section[^>]+aria-labelledby="not-found-title"/);
  assert.match(notFoundPage, /<p>[^<]+<\/p>/);
  assert.match(notFoundPage, /<Link to="\/"[^>]*>[\s\S]*返回首页/);
  assert.doesNotMatch(notFoundPage, /https?:\/\/|window\.location|target="_blank"/);
});
