import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("/status stays public without a login redirect; /monitor unchanged", () => {
  const app = source("../src/App.tsx");
  assert.match(app, /section === "monitor" \|\| section === "status"\) return <DashboardShell \/>/);
  const shell = source("../app/components/DashboardShell.tsx");
  assert.match(shell, /section === "monitor"\) \{\s*return <PublicMonitorPage \/>/);
});

test("/status always renders the monitor inside the customer shell, signed in or not", () => {
  const shell = source("../app/components/DashboardShell.tsx");
  const status = shell.slice(shell.indexOf('if (section === "status") {'), shell.indexOf('if (section === "subscribe")'));
  // A buyer line (/status?line=…) only preselects that line's server in the same public monitor (user decision 2026-10-04).
  assert.match(status, /const line = readStatusLineParam\(search\);/);
  assert.match(
    status,
    /return \(\s*<CustomerCenterShell fill[^>]*>\s*<CustomerShellMonitor line=\{line === "invalid" \? null : line\} \/>\s*<\/CustomerCenterShell>\s*\);\s*\}\s*$/,
  );
  assert.doesNotMatch(status, /authStatus|PublicMonitorPage|BuyerServerStatusPage|monitor-status|Navigate/);
});

test("customer-shell /status reuses the same public embed and follows the shell theme", () => {
  const page = source("../app/components/monitor/PublicMonitorPage.tsx");
  assert.match(page, /export function CustomerShellMonitor\(\{ line = null \}: \{ line\?: string \| null \}\) \{\s*const theme = useCustomerShellTheme\(\);/);
  // The only server identity is the one Auth resolves for the buyer's own line.
  assert.match(page, /getLineMonitorTarget\(line, controller\.signal\)/);
  assert.match(page, /<PublicMonitorEmbed key=\{vps\.server \?\? ""\} theme=\{theme\} vps=\{vps\.server\} \/>/);
  assert.match(page, /<PublicMonitorEmbed theme=\{theme\} \/>\s*<\/main>/);
  const embed = page.slice(page.indexOf("export function PublicMonitorEmbed"));
  assert.match(embed, /embedded: true, vps \}/);
  assert.doesNotMatch(embed, /target\s*:|monitorTargetKey/);
  const customerShell = source("../app/components/customer/CustomerCenterShell.tsx");
  assert.match(customerShell, /<CustomerShellThemeContext\.Provider value=\{theme\}>\{children\}<\/CustomerShellThemeContext\.Provider>/);
});
