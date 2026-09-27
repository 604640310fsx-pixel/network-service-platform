import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("/status is public and renders the same 3002 monitor embed as /monitor", () => {
  const app = source("../src/App.tsx");
  assert.match(app, /section === "monitor" \|\| section === "status"\) return <DashboardShell \/>/);
  const shell = source("../app/components/DashboardShell.tsx");
  assert.match(shell, /section === "status"\) \{\s*return <PublicMonitorPage \/>/);
  assert.match(shell, /section === "monitor"\) \{\s*return <PublicMonitorPage \/>/);
});
