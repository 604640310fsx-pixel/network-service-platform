import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const AUTH_SOURCE_URL = new URL("../app/lib/auth.tsx", import.meta.url);
const SHELL_SOURCE_URL = new URL(
  "../app/components/customer/CustomerCenterShell.tsx",
  import.meta.url,
);
const CSS_SOURCE_URL = new URL(
  "../app/components/customer/customer-center.css",
  import.meta.url,
);
const CSRF = "A".repeat(43);

type LogoutOperation = (
  csrfToken: string,
  fetchOperation: (input: string, init: RequestInit) => Promise<Response>,
) => Promise<void>;

function loadLogoutOperation(): LogoutOperation {
  const source = readFileSync(AUTH_SOURCE_URL, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: "auth.tsx",
  }).outputText;
  const runtimeModule: { exports: Record<string, unknown> } = { exports: {} };
  const runtimeRequire = (specifier: string): unknown => {
    if (specifier === "react") {
      return {
        createContext: () => ({ Provider: "Provider" }),
        useContext: () => null,
        useEffect: () => undefined,
        useMemo: (operation: () => unknown) => operation(),
        useRef: (value: unknown) => ({ current: value }),
        useState: (value: unknown) => [value, () => undefined],
      };
    }
    if (specifier === "react/jsx-runtime") {
      return { jsx: () => null, jsxs: () => null, Fragment: "Fragment" };
    }
    if (specifier === "./auth-errors") {
      return {
        LoginRequestError: class LoginRequestError extends Error {},
      };
    }
    throw new Error(`Unexpected fixture import: ${specifier}`);
  };
  const execute = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    compiled,
  );
  execute(
    runtimeModule.exports,
    runtimeRequire,
    runtimeModule,
    "auth.js",
    ".",
  );
  const operation = runtimeModule.exports.requestCurrentWebSessionLogout;
  assert.equal(typeof operation, "function");
  return operation as LogoutOperation;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("logout sends one exact same-origin POST with XHR, CSRF, and an exact empty JSON body", async () => {
  const requestLogout = loadLogoutOperation();
  const calls: Array<{ readonly input: string; readonly init: RequestInit }> = [];

  await requestLogout(CSRF, async (input, init) => {
    calls.push({ input, init });
    return response(200, { status: "ok" });
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    input: "/api/auth/logout",
    init: {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": CSRF,
      },
      body: "{}",
    },
  });
});

test("only exact 200 status-ok succeeds; invalid 200, 400, 403, 503, and network outcomes reject", async () => {
  const requestLogout = loadLogoutOperation();
  const outcomes: Array<() => Promise<Response>> = [
    async () => response(200, { status: "ok", extra: true }),
    async () => response(200, { status: "failed" }),
    async () => response(201, { status: "ok" }),
    async () => response(400, { error: { code: "invalid_request" } }),
    async () => response(403, { error: { code: "csrf_invalid" } }),
    async () => response(503, { error: { code: "auth_unavailable" } }),
    async () => new Response("not-json", { status: 200 }),
    async () => {
      throw new Error("network fixture detail");
    },
  ];

  for (const outcome of outcomes) {
    let calls = 0;
    await assert.rejects(
      requestLogout(CSRF, async () => {
        calls += 1;
        return outcome();
      }),
    );
    assert.equal(calls, 1);
  }
});

test("AuthProvider clears principal and CSRF atomically only after success and single-flights rapid calls", () => {
  const source = readFileSync(AUTH_SOURCE_URL, "utf8");
  const logoutStart = source.indexOf("function logout(): Promise<void>");
  const logoutEnd = source.indexOf("const value = useMemo", logoutStart);
  assert.notEqual(logoutStart, -1);
  assert.notEqual(logoutEnd, -1);
  const logoutSource = source.slice(logoutStart, logoutEnd);

  assert.match(logoutSource, /if \(logoutPromiseRef\.current !== null\)/);
  assert.match(logoutSource, /return logoutPromiseRef\.current/);
  assert.match(
    logoutSource,
    /requestCurrentWebSessionLogout\([\s\S]*?\)\.then\(\(\) => \{[\s\S]*?setAuthState\(\{ status: "unauthenticated", session: null \}\)/,
  );
  assert.equal(
    logoutSource.indexOf("setAuthState"),
    logoutSource.lastIndexOf("setAuthState"),
  );
  assert.doesNotMatch(logoutSource, /console\.|localStorage|sessionStorage/);
});

test("CustomerCenterShell exposes logout only for authenticated state with pending, retry, alert, and replace semantics", () => {
  const source = readFileSync(SHELL_SOURCE_URL, "utf8");
  assert.match(source, /authStatus === "authenticated" && \(/);
  assert.match(source, /aria-label=\{t\.center\.logout\}/);
  assert.match(source, /aria-busy=\{logoutPending\}/);
  assert.match(source, /disabled=\{logoutPending\}/);
  assert.match(source, /logoutPending \? t\.center\.loggingOut : t\.center\.logout/);
  const zhCopy = readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8");
  assert.match(zhCopy, /logout: "退出登录",\s*loggingOut: "退出中…",\s*logoutFailed: "退出失败，请重试"/);
  assert.match(source, /logoutPendingRef\.current/);
  assert.match(
    source,
    /await logout\(\);\s*navigate\("\/login", \{ replace: true \}\)/,
  );
  assert.match(
    source,
    /catch \{\s*setLogoutFailed\(true\);\s*\}/,
  );
  assert.match(
    source,
    /role="alert">\{t\.center\.logoutFailed\}<\/span>/,
  );
  assert.doesNotMatch(source, /csrfToken|console\.|confirm\(/);

  const profilePosition = source.indexOf("aria-label={t.center.profileLabel}");
  const logoutPosition = source.indexOf("aria-label={t.center.logout}");
  assert.ok(profilePosition >= 0 && logoutPosition > profilePosition);
});

test("390px may hide visual logout text while preserving the exact accessible name", () => {
  const css = readFileSync(CSS_SOURCE_URL, "utf8");
  assert.match(
    css,
    /@media \(max-width: 430px\)[\s\S]*?\.cc-logout-button span \{ display: none; \}/,
  );
  assert.doesNotMatch(css, /overflow-x:\s*scroll/);
});
