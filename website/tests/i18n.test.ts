import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";
import { createTsxLoader } from "./support/tsxModules.ts";

const CJK = /[㐀-鿿！-｠]/;
const MIGRATED = [
  "app/components/home/SiteHeader.tsx",
  "app/components/home/SiteFooter.tsx",
  "app/components/home/HomePage.tsx",
  "app/components/auth/AuthShell.tsx",
  "app/components/auth/LoginPage.tsx",
  "app/components/auth/RegisterPage.tsx",
  "app/components/auth/ForgotPasswordPage.tsx",
  "app/components/auth/ResetPasswordPage.tsx",
  "app/components/auth/registrationFlow.ts",
  "app/components/auth/passwordResetModel.ts",
  "app/components/common/LanguageToggle.tsx",
  "app/components/WorkbenchBanner.tsx",
  "app/components/subscribe/SubscribePage.tsx",
  "app/components/subscribe/StepProgress.tsx",
  "app/components/subscribe/MobileOrderBar.tsx",
  "app/components/subscribe/OrderSummary.tsx",
  "app/components/subscribe/SubmitRequestPage.tsx",
  "app/components/subscribe/RequirementForm.tsx",
  "app/components/subscribe/OrderStatusPanel.tsx",
  "app/components/subscribe/AlipayQrPay.tsx",
  "app/components/customer/CustomerCenterShell.tsx",
  "app/components/customer/CustomerTicketsPage.tsx",
  "app/components/customer/CustomerInvitesPage.tsx",
  "app/components/customer/CustomerOrdersPage.tsx",
  "app/components/customer/CustomerServicesPage.tsx",
  "app/components/DashboardShell.tsx",
  "app/components/dashboard/DashboardPage.tsx",
  "app/components/dashboard/BuyerDashboardOverview.tsx",
  "app/components/network/BuyerNetworkPage.tsx",
  "app/components/subscription-import/SubscriptionImportModule.tsx",
  "app/components/profile/ProfilePage.tsx",
  "app/components/profile/AccountSecurityForms.tsx",
  "app/components/profile/accountSecurityModel.ts",
  "app/components/referral-public/ReferralLandingPage.tsx",
  "app/components/diagnosis/DiagnosisPage.tsx",
  "app/components/monitor/PublicMonitorPage.tsx",
  "app/components/not-found/NotFoundPage.tsx",
  "app/components/referrals/ReferralCenter.tsx",
  "app/components/referrals/ReferralRecords.tsx",
  "app/components/referrals/referralParts.tsx",
  "app/components/referrals/ReferralDialog.tsx",
];

/** Every Chinese string literal in a source file (comments excluded). */
function chineseLiterals(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK.test(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// Catalog text is data, not UI copy: components may compare against it, and
// English renders it through the `catalog` table.
const CATALOG_TEXT = new Set([
  ...Object.keys(en.catalog),
  // Referral data values (status / tier names) are compared as data and rendered through lookups.
  ...Object.keys(en.referral.statuses),
  ...Object.keys(en.referral.tierNames),
]);

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// Lookup tables keyed by catalog ids or catalog text: Chinese leaves them empty
// (it shows the catalog as written), other languages translate what they need.
const LOOKUP_TABLES = new Set([
  "catalog",
  "home.types.meta",
  "home.regions.tags",
  "subscribe.solutions",
  "subscribe.residentialRegionTags",
  "referral.tierNames",
  "referral.statuses",
]);

/** Shape of a dictionary: nested keys, with functions reduced to their arity. */
function shape(value: unknown, path = ""): unknown {
  if (LOOKUP_TABLES.has(path)) return "lookup";
  if (typeof value === "function") return `fn/${value.length}`;
  if (Array.isArray(value)) return value.map((item) => shape(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key)]));
  }
  return typeof value;
}

function strings(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") return strings((value as (...a: number[]) => string)(1, 2), path);
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => strings(item, path ? `${path}.${key}` : key));
  }
  return [];
}

test("initial language: a saved zh/en choice wins, everything else is English", async () => {
  const { resolveInitialLang, htmlLangFor, LANG_STORAGE_KEY } = createTsxLoader().load("app/lib/i18n.tsx") as {
    resolveInitialLang: (stored: string | null) => string;
    htmlLangFor: (lang: string) => string;
    LANG_STORAGE_KEY: string;
  };
  assert.equal(LANG_STORAGE_KEY, "nsp.lang");
  assert.equal(resolveInitialLang("en"), "en");
  assert.equal(resolveInitialLang("zh"), "zh");
  assert.equal(resolveInitialLang(null), "en");
  assert.equal(resolveInitialLang(""), "en");
  assert.equal(resolveInitialLang("fr"), "en");
  assert.equal(resolveInitialLang("zh-CN"), "en");
  assert.equal(htmlLangFor("zh"), "zh-CN");
  assert.equal(htmlLangFor("en"), "en");
});

test("zh and en dictionaries have the same keys, arrays and interpolation arity", () => {
  assert.deepEqual(shape(en), shape(zh));
});

test("English copy contains no Chinese except the language switch, and every catalog string is translated", () => {
  const allowed = new Set(["language.zh", "language.zhLabel"]);
  const leaks = strings(en).filter(([path, value]) => CJK.test(value) && !allowed.has(path));
  assert.deepEqual(leaks, []);
  const catalogText = new Set([...chineseLiterals("app/lib/subscribeCatalog.ts"), "不适用"]);
  assert.deepEqual([...catalogText].filter((text) => !(text in en.catalog)), [], "untranslated catalog text");
  assert.deepEqual(Object.keys(en.catalog).filter((text) => !catalogText.has(text)), [], "stale catalog translations");
  // Chinese strings are never empty, except affixes that only one language uses.
  const affixes = new Set(["subscribe.fromPrefix"]);
  for (const [path, value] of strings(zh)) if (!affixes.has(path)) assert.notEqual(value.trim(), "", path);
});

test("migrated components keep no hard-coded Chinese in strings or JSX text", () => {
  for (const file of MIGRATED) {
    const sourceFile = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const hits: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        CJK.test(node.text) &&
        !CATALOG_TEXT.has(node.text)
      ) {
        hits.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.text.trim().slice(0, 30)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.deepEqual(hits, [], file);
  }
});

function renderer() {
  const loader = createTsxLoader({
    "app/lib/auth.tsx": { useAuth: () => ({ status: "unauthenticated" }) },
  });
  const react = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const { MemoryRouter } = loader.requirePackage("react-router-dom") as typeof import("react-router-dom");
  const { I18nProvider } = loader.load("app/lib/i18n.tsx") as { I18nProvider: (props: { initial: "zh" | "en"; children: unknown }) => unknown };
  return (file: string, exportName: string, lang: "zh" | "en", url = "/") => {
    const Component = loader.load(file)[exportName] as () => unknown;
    return renderToStaticMarkup(
      react.createElement(MemoryRouter, { initialEntries: [url] },
        react.createElement(I18nProvider as never, { initial: lang } as never, react.createElement(Component as never))),
    );
  };
}

const PAGES: Array<{ file: string; name: string; url?: string; zh: string[]; en: string[] }> = [
  { file: "app/components/home/HomePage.tsx", name: "HomePage", zh: ["先判断当前网络环境", "首页", "实时监控", "推荐地区", "新加坡"], en: ["Not every problem needs a new network", "Home", "Live monitor", "Recommended Regions", "Singapore", "China Telecom"] },
  { file: "app/components/auth/LoginPage.tsx", name: "LoginPage", url: "/login", zh: ["登录客户中心", "忘记密码？", "去注册"], en: ["Sign in to the dashboard", "Forgot password?", "No account yet? "] },
  { file: "app/components/auth/RegisterPage.tsx", name: "RegisterPage", url: "/register", zh: ["注册客户中心", "邀请码", "发送验证码"], en: ["Create your account", "Invite code", "Send code"] },
  { file: "app/components/auth/ForgotPasswordPage.tsx", name: "ForgotPasswordPage", url: "/forgot-password", zh: ["忘记密码", "发送重置链接"], en: ["Forgot password", "Send reset link"] },
  { file: "app/components/auth/ResetPasswordPage.tsx", name: "ResetPasswordPage", url: "/reset-password", zh: ["链接无效", "重新申请"], en: ["Invalid link", "Request a new link"] },
  { file: "app/components/auth/ResetPasswordPage.tsx", name: "ResetPasswordPage", url: `/reset-password?token=${"A".repeat(43)}`, zh: ["设置新密码", "确认新密码"], en: ["Set a new password", "Confirm new password"] },
];

function withBrowserStub<Result>(run: () => Result): Result {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    location: { search: "", origin: "http://localhost:5173" },
    localStorage: { getItem: () => null, setItem: () => undefined },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    navigator: { language: "zh-CN" },
  };
  try {
    return run();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test("each migrated page renders in both languages with its own copy and the language switch", () => withBrowserStub(() => {
  const render = renderer();
  for (const page of PAGES) {
    for (const lang of ["zh", "en"] as const) {
      const html = render(page.file, page.name, lang, page.url);
      for (const expected of page[lang]) assert.ok(html.includes(expected), `${page.name} ${lang}: ${expected}`);
      assert.match(html, /<div class="lang-toggle" role="group"/, `${page.name} ${lang} toggle`);
      const pressed = lang === "zh" ? /lang="zh-CN" aria-pressed="true"/ : /lang="en" aria-pressed="true"/;
      assert.match(html, pressed, `${page.name} ${lang} pressed`);
      if (lang === "en") {
        // Only brand-neutral and allowed fragments may stay Chinese in English mode.
        const text = html.replace(/<[^>]+>/g, " ").replace(/中文/g, "");
        assert.doesNotMatch(text, CJK, `${page.name} en leaks Chinese: ${text.match(new RegExp(`.{0,20}${CJK.source}.{0,20}`))?.[0]}`);
      }
    }
  }
}));

const SIGNED_IN_AUTH = {
  useAuth: () => ({
    status: "authenticated",
    principal: { email: "owner@example.net", role: "user" },
    csrfToken: "csrf-test",
    logout: async () => undefined,
    refresh: async () => undefined,
  }),
};

function dashboardRenderer() {
  const loader = createTsxLoader({ "app/lib/auth.tsx": SIGNED_IN_AUTH });
  const react = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const router = loader.requirePackage("react-router-dom") as typeof import("react-router-dom");
  const { I18nProvider } = loader.load("app/lib/i18n.tsx") as { I18nProvider: unknown };
  const { DashboardShell } = loader.load("app/components/DashboardShell.tsx") as { DashboardShell: unknown };
  const pages = loader.load("app/components/subscribe/SubmitRequestPage.tsx") as { SubmitRequestPage: unknown };
  return (url: string, lang: "zh" | "en") => {
    const element = url.startsWith("/subscribe/request")
      ? react.createElement(pages.SubmitRequestPage as never)
      : react.createElement(router.Routes, null, react.createElement(router.Route, { path: "/:section", element: react.createElement(DashboardShell as never) }));
    return renderToStaticMarkup(
      react.createElement(router.MemoryRouter, { initialEntries: [url] },
        react.createElement(I18nProvider as never, { initial: lang } as never, element)),
    );
  };
}

const DASHBOARD_PAGES: Array<{ url: string; zh: string[]; en: string[] }> = [
  { url: "/dashboard", zh: ["仪表板", "买家概览", "快捷操作"], en: ["Dashboard", "Buyer overview", "Quick actions"] },
  { url: "/subscribe", zh: ["套餐订阅", "选择网络方案架构", "真住宅宽带"], en: ["Plans", "Choose a network architecture", "Real Residential Broadband"] },
  { url: "/subscribe/request?typeId=residential&regionId=vn&ispId=vnpt-corp&specId=shared-3&durationId=month-1", zh: ["提交方案需求", "核对已选方案"], en: ["Submit plan details", "Review the selected plan"] },
  { url: "/services", zh: ["当前套餐", "正在读取服务状态…"], en: ["My plans", "Loading service status…"] },
  { url: "/orders", zh: ["订单", "正在读取订单…"], en: ["Orders", "Loading orders…"] },
  { url: "/network", zh: ["节点与流量", "可用节点与流量明细"], en: ["Nodes &amp; traffic", "Available nodes &amp; traffic"] },
  { url: "/tickets", zh: ["工单", "正在读取工单…"], en: ["Tickets", "Loading tickets…"] },
  { url: "/profile", zh: ["个人中心", "账号资料", "修改密码"], en: ["Profile", "Account details", "Change password"] },
  { url: "/invites", zh: ["邀请中心", "正在读取你的邀请码…"], en: ["Invites", "Loading your invite code…"] },
  { url: "/monitor", zh: ["实时网络监控", "监控地址未配置"], en: ["Live network monitor", "Monitor address not configured"] },
  { url: "/nope", zh: ["页面不存在"], en: ["Page not found"] },
  { url: "/referrals", zh: ["邀请/推广", "推荐链接", "伙伴等级", "战略推广合作"], en: ["Referrals", "Referral link", "Partner tiers", "Strategic promotion partnership", "Starter partner"] },
];

test("customer dashboard pages render in both languages with the shell, toggle and no Chinese in English", () => withBrowserStub(() => {
  const render = dashboardRenderer();
  for (const page of DASHBOARD_PAGES) {
    for (const lang of ["zh", "en"] as const) {
      const html = render(page.url, lang);
      for (const expected of page[lang]) assert.ok(html.includes(expected), `${page.url} ${lang}: ${expected}`);
      assert.match(html, /class="lang-toggle"/, `${page.url} ${lang} toggle`);
      if (lang === "en") {
        const text = html.replace(/<[^>]+>/g, " ").replace(/中文/g, "");
        assert.doesNotMatch(text, CJK, `${page.url} en leaks Chinese: ${text.match(new RegExp(`.{0,20}${CJK.source}.{0,20}`))?.[0]}`);
        const attributes = [...html.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map((match) => match[1]!).filter((value) => value !== "切换到中文");
        assert.deepEqual(attributes.filter((value) => CJK.test(value)), [], `${page.url} en attribute leaks`);
      }
    }
  }
}));

test("the diagnosis and referral landing pages render in both languages", () => withBrowserStub(() => {
  const loader = createTsxLoader({ "app/lib/auth.tsx": { useAuth: () => ({ status: "unauthenticated" }) } });
  const react = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const { MemoryRouter } = loader.requirePackage("react-router-dom") as typeof import("react-router-dom");
  const { I18nProvider } = loader.load("app/lib/i18n.tsx") as { I18nProvider: unknown };
  const cases = [
    { file: "app/components/diagnosis/DiagnosisPage.tsx", name: "DiagnosisPage", zh: "先把网络问题说清楚", en: "Describe your network problem first" },
    { file: "app/components/referral-public/ReferralLandingPage.tsx", name: "ReferralLandingPage", zh: "正在确认推荐链接", en: "Checking the referral link" },
  ];
  for (const item of cases) {
    const Component = loader.load(item.file)[item.name];
    for (const lang of ["zh", "en"] as const) {
      const html = renderToStaticMarkup(react.createElement(MemoryRouter, null,
        react.createElement(I18nProvider as never, { initial: lang } as never, react.createElement(Component as never))));
      assert.ok(html.includes(item[lang]), `${item.name} ${lang}`);
      if (lang === "en") assert.doesNotMatch(html.replace(/<[^>]+>/g, " ").replace(/中文/g, ""), CJK, item.name);
    }
  }
}));

test("the provider reads and persists nsp.lang and switches the dictionary", () => {
  const previous = (globalThis as { window?: unknown }).window;
  const store = new Map<string, string>([["nsp.lang", "en"]]);
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
    navigator: { language: "zh-CN" },
  };
  try {
    const loader = createTsxLoader();
    const react = loader.requirePackage("react") as typeof import("react");
    const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
    const i18n = loader.load("app/lib/i18n.tsx") as {
      I18nProvider: unknown;
      useI18n: () => { lang: string; t: typeof zh; setLang: (lang: "zh" | "en") => void };
    };
    let captured: ReturnType<typeof i18n.useI18n> | undefined;
    const Probe = () => {
      captured = i18n.useI18n();
      return react.createElement("span", null, captured.t.login.submit);
    };
    const html = renderToStaticMarkup(react.createElement(i18n.I18nProvider as never, null, react.createElement(Probe)));
    assert.equal(html, "<span>Sign in</span>");
    assert.equal(captured?.lang, "en");
    captured?.setLang("zh");
    assert.equal(store.get("nsp.lang"), "zh");
    store.delete("nsp.lang");
    renderToStaticMarkup(react.createElement(i18n.I18nProvider as never, null, react.createElement(Probe)));
    assert.equal(captured?.lang, "en", "no storage defaults to English even for a zh-CN browser");
    store.set("nsp.lang", "zh");
    renderToStaticMarkup(react.createElement(i18n.I18nProvider as never, null, react.createElement(Probe)));
    assert.equal(captured?.lang, "zh", "saved zh is retained");
    store.set("nsp.lang", "fr");
    renderToStaticMarkup(react.createElement(i18n.I18nProvider as never, null, react.createElement(Probe)));
    assert.equal(captured?.lang, "en", "invalid saved value falls back to English");
    assert.equal(store.get("nsp.lang"), "fr", "an invalid value is not cleared or rewritten");
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
});

test("provider defaults to English for any navigator language, a failing store, and without a window", () => {
  const previous = (globalThis as { window?: unknown }).window;
  const loader = createTsxLoader();
  const react = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const i18n = loader.load("app/lib/i18n.tsx") as {
    I18nProvider: unknown;
    useI18n: () => { lang: string; setLang: (lang: "zh" | "en") => void };
  };
  let captured: ReturnType<typeof i18n.useI18n> | undefined;
  const Probe = () => {
    captured = i18n.useI18n();
    return react.createElement("span");
  };
  const render = () => renderToStaticMarkup(react.createElement(i18n.I18nProvider as never, null, react.createElement(Probe)));
  const emptyStore = { getItem: () => null, setItem: () => undefined };
  const throwingStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  try {
    for (const navigator of [{ language: "zh-CN" }, { language: "zh-TW" }, { language: "en-US" }, { language: "" }, undefined]) {
      (globalThis as { window?: unknown }).window = { localStorage: emptyStore, navigator };
      render();
      assert.equal(captured?.lang, "en", JSON.stringify(navigator));
    }
    (globalThis as { window?: unknown }).window = { localStorage: throwingStore, navigator: { language: "zh-CN" } };
    render();
    assert.equal(captured?.lang, "en", "unreadable storage defaults to English");
    assert.doesNotThrow(() => captured?.setLang("zh"), "a failing store must not block the switch");
    (globalThis as { window?: unknown }).window = undefined;
    render();
    assert.equal(captured?.lang, "en", "no window (SSR) defaults to English");
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
});

test("outside a provider components fall back to English", () => {
  const loader = createTsxLoader();
  const react = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const { LanguageToggle } = loader.load("app/components/common/LanguageToggle.tsx") as { LanguageToggle: () => unknown };
  const html = renderToStaticMarkup(react.createElement(LanguageToggle as never));
  assert.match(html, /aria-label="Interface language"/);
  assert.match(html, /<button type="button" lang="zh-CN" aria-pressed="false" aria-label="切换到中文">中文<\/button>/);
  assert.match(html, /<button type="button" lang="en" aria-pressed="true" aria-label="Switch to English" class="is-active">EN<\/button>/);
});
