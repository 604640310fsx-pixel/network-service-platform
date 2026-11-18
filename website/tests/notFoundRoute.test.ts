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

test("known public and protected routes include authenticated referrals", () => {
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
    "referrals",
    "tickets",
    "invites",
  ]);
  assert.doesNotMatch(app, /section === "invites"/);
  assert.match(dashboardShell, /<CustomerInvitesPage \/>/);
  assert.match(app, /section === "subscribe" \|\| section === "monitor"/);
  // /tickets is a protected section: not in the public-section shortcut, so signed-out visitors go to /login.
  assert.doesNotMatch(app, /section === "tickets"/);
  assert.match(dashboardShell, /section === "tickets"/);
  assert.match(dashboardShell, /<CustomerTicketsPage \/>/);
  assert.match(app, /status === "unauthenticated"\) return <Navigate to="\/login" replace/);
  assert.match(dashboardShell, /section === "referrals"/);
  assert.match(dashboardShell, /<ReferralCenterAdapter \/>/);
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
  assert.match(notFoundPage, /<h1 id="not-found-title">\{copy\.title\}<\/h1>/);
  assert.match(readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8"), /notFound: \{\s*title: "页面不存在",[\s\S]*?home: "返回首页"/);
  assert.match(notFoundPage, /<section[^>]+aria-labelledby="not-found-title"/);
  assert.match(notFoundPage, /<p>\{copy\.body\}<\/p>/);
  assert.match(notFoundPage, /<Link to="\/"[^>]*>[\s\S]*\{copy\.home\}/);
  assert.doesNotMatch(notFoundPage, /https?:\/\/|window\.location|target="_blank"/);
});
