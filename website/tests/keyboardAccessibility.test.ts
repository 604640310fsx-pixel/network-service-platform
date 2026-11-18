import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function loadTsxModule(
  relativePath: string,
  imports: Record<string, unknown>,
): Record<string, unknown> {
  const compiled = ts.transpileModule(source(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;
  const runtimeModule = { exports: {} as Record<string, unknown> };
  Function("require", "module", "exports", compiled)(
    (specifier: string) => {
      if (specifier in imports) return imports[specifier];
      throw new Error(`Unexpected test import: ${specifier}`);
    },
    runtimeModule,
    runtimeModule.exports,
  );
  return runtimeModule.exports;
}

test("mobile menu resolves Escape and Tab boundaries without allowing focus to escape", () => {
  const module = loadTsxModule("../app/components/home/SiteHeader.tsx", {
    react: {},
    "react/jsx-runtime": {},
    "react-router-dom": {},
    "../../lib/auth": {},
    "../../lib/i18n": {},
    "../common/LanguageToggle": {},
  });
  const resolve = module.resolveMobileMenuKeyAction as (
    key: string,
    shiftKey: boolean,
    currentIndex: number,
    controlCount: number,
  ) => { kind: "close" } | { kind: "focus"; index: number } | null;

  assert.deepEqual(resolve("Escape", false, 2, 5), { kind: "close" });
  assert.deepEqual(resolve("Tab", false, 4, 5), { kind: "focus", index: 0 });
  assert.deepEqual(resolve("Tab", true, 0, 5), { kind: "focus", index: 4 });
  assert.deepEqual(resolve("Tab", false, -1, 5), { kind: "focus", index: 0 });
  assert.deepEqual(resolve("Tab", true, -1, 5), { kind: "focus", index: 4 });
  assert.equal(resolve("Tab", false, 2, 5), null);
  assert.equal(resolve("Enter", false, 2, 5), null);
});

test("home exposes a real skip target and returns escaped menu focus to its exact trigger", () => {
  const header = source("../app/components/home/SiteHeader.tsx");
  const page = source("../app/components/home/HomePage.tsx");
  const css = source("../app/components/home/home.css");

  assert.match(header, /className="home-skip-link" href="#home-main"/);
  assert.match(page, /<main id="home-main" tabIndex=\{-1\}>/);
  assert.match(css, /\.home-skip-link:focus \{ transform: translateY\(0\); \}/);
  assert.match(header, /const controls = \[trigger, \.\.\.menuControls\]/);
  assert.match(header, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(header, /setMenuOpen\(false\);\s*trigger\.focus\(\);/);
});

test("roving radios wrap, honor Home and End, and skip disabled options", () => {
  const module = loadTsxModule("../app/components/subscribe/OptionCard.tsx", {
    "react/jsx-runtime": {},
  });
  const next = module.getNextEnabledRadioIndex as (
    currentIndex: number,
    key: string,
    disabled: readonly boolean[],
  ) => number | null;
  const disabled = [false, true, false, false];

  assert.equal(next(0, "ArrowRight", disabled), 2);
  assert.equal(next(0, "ArrowDown", disabled), 2);
  assert.equal(next(2, "ArrowLeft", disabled), 0);
  assert.equal(next(2, "ArrowUp", disabled), 0);
  assert.equal(next(3, "ArrowRight", disabled), 0);
  assert.equal(next(0, "ArrowLeft", disabled), 3);
  assert.equal(next(2, "Home", disabled), 0);
  assert.equal(next(0, "End", disabled), 3);
  assert.equal(next(0, "Tab", disabled), null);
  assert.equal(next(0, "ArrowRight", [true, true]), null);
});

test("each radio group has one enabled tab stop and uses the existing selection callback", () => {
  const module = loadTsxModule("../app/components/subscribe/OptionCard.tsx", {
    "react/jsx-runtime": {},
  });
  const tabIndex = module.getRovingRadioTabIndex as (
    selectedIndex: number,
    optionIndex: number,
    disabled: readonly boolean[],
  ) => 0 | -1;
  const disabled = [false, true, false, false];

  assert.deepEqual(disabled.map((_, index) => tabIndex(2, index, disabled)), [-1, -1, 0, -1]);
  assert.deepEqual(disabled.map((_, index) => tabIndex(1, index, disabled)), [0, -1, -1, -1]);

  const card = source("../app/components/subscribe/OptionCard.tsx");
  const page = source("../app/components/subscribe/SubscribePage.tsx");
  assert.match(card, /role="radio"[\s\S]*?disabled=\{disabled\}[\s\S]*?tabIndex=\{tabIndex\}/);
  assert.equal(page.match(/role="radiogroup"/g)?.length, 5);
  assert.equal(page.match(/onKeyDown=\{handleRadioGroupKeyDown\}/g)?.length, 5);
  assert.match(page, /nextRadio\.click\(\);\s*nextRadio\.focus\(\);/);
  assert.match(page, /disabled=\{durationDisabled\}/);
});

test("successful logout alone schedules focus on the visible login heading without changing the request", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  const authShell = source("../app/components/auth/AuthShell.tsx");
  const auth = source("../app/lib/auth.tsx");
  const handler = shell.slice(shell.indexOf("async function handleLogout"), shell.indexOf("useEffect(() =>", shell.indexOf("async function handleLogout")));

  assert.match(
    handler,
    /await logout\(\);\s*navigate\("\/login", \{ replace: true \}\);\s*requestPostLogoutFocus\(\);/,
  );
  assert.doesNotMatch(handler.slice(handler.indexOf("catch")), /requestPostLogoutFocus/);
  assert.match(authShell, /postLogoutFocusRequested = true/);
  assert.match(authShell, /mountedTarget\.focus\(\);\s*postLogoutFocusRequested = false/);
  assert.match(authShell, /if \(!postLogoutFocusRequested \|\| !headingRef\.current\) return;\s*headingRef\.current\.focus\(\);/);
  assert.match(authShell, /<h1 ref=\{headingRef\} id=\{POST_LOGOUT_FOCUS_TARGET_ID\} tabIndex=\{-1\}>\{title\}<\/h1>/);
  assert.equal(auth.match(/fetchOperation\("\/api\/auth\/logout"/g)?.length, 1);
  assert.match(auth, /method: "POST"[\s\S]*?credentials: "same-origin"[\s\S]*?body: "\{\}"/);
});
