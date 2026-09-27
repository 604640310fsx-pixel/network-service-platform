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
  const status = shell.slice(shell.indexOf('if (section === "status")'), shell.indexOf('if (section === "subscribe")'));
  assert.match(
    status,
    /return \(\s*<CustomerCenterShell fill[^>]*>\s*<CustomerShellMonitor \/>\s*<\/CustomerCenterShell>\s*\);\s*\}\s*$/,
  );
  assert.doesNotMatch(status, /authStatus|PublicMonitorPage|BuyerServerStatusPage|monitor-status|Navigate/);
});

test("customer-shell /status reuses the same public embed and follows the shell theme", () => {
  const page = source("../app/components/monitor/PublicMonitorPage.tsx");
  assert.match(page, /export function CustomerShellMonitor\(\) \{\s*const theme = useCustomerShellTheme\(\);\s*return <PublicMonitorEmbed theme=\{theme\} \/>;/);
  assert.match(page, /<PublicMonitorEmbed theme=\{theme\} \/>\s*<\/main>/);
  const embed = page.slice(page.indexOf("export function PublicMonitorEmbed"));
  assert.match(embed, /embedded: true/);
  assert.doesNotMatch(embed, /target\s*:|vps/);
  const customerShell = source("../app/components/customer/CustomerCenterShell.tsx");
  assert.match(customerShell, /<CustomerShellThemeContext\.Provider value=\{theme\}>\{children\}<\/CustomerShellThemeContext\.Provider>/);
});
