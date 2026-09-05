#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPEN_HTTP_PLACEHOLDERS = Object.freeze({
  canonicalHost: "__OPEN_CANONICAL_HOST__",
  bareHost: "__OPEN_BARE_HOST__",
  websiteRoot: "__OPEN_CANDIDATE_WEBSITE_ROOT__",
  apiUpstream: "__OPEN_API_UPSTREAM__",
  tlsDirectives: "__OPEN_EXISTING_TLS_DIRECTIVES__",
  cspPolicy: "__OPEN_CSP_POLICY__",
  framingDirective: "__OPEN_X_FRAME_OPTIONS_DIRECTIVE__",
  hstsDirective: "__OPEN_HSTS_DIRECTIVE__",
  compressionDirectives: "__OPEN_COMPRESSION_DIRECTIVES__",
});

export const HASHED_ASSET_PATTERN =
  "^/assets/[A-Za-z0-9._-]+-[A-Fa-f0-9]{8,}\\.(?:css|js|mjs|json|map|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf)$";
export const FILE_LIKE_PATTERN = "^/(?!assets/)(?:.*/)?[^/]+\\.[^/]+$";

const REQUIRED_CSP_DIRECTIVES = Object.freeze([
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
]);

const TEMPLATE_COUNTS = Object.freeze({
  open: Object.freeze({
    [OPEN_HTTP_PLACEHOLDERS.canonicalHost]: 3,
    [OPEN_HTTP_PLACEHOLDERS.bareHost]: 0,
    [OPEN_HTTP_PLACEHOLDERS.websiteRoot]: 1,
    [OPEN_HTTP_PLACEHOLDERS.apiUpstream]: 2,
    [OPEN_HTTP_PLACEHOLDERS.tlsDirectives]: 1,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: 1,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: 1,
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: 1,
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: 1,
  }),
  bare: Object.freeze({
    [OPEN_HTTP_PLACEHOLDERS.canonicalHost]: 2,
    [OPEN_HTTP_PLACEHOLDERS.bareHost]: 2,
    [OPEN_HTTP_PLACEHOLDERS.websiteRoot]: 0,
    [OPEN_HTTP_PLACEHOLDERS.apiUpstream]: 0,
    [OPEN_HTTP_PLACEHOLDERS.tlsDirectives]: 1,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: 0,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: 0,
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: 1,
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: 0,
  }),
});

const EXPECTED_METADATA_KEYS = Object.freeze([
  "apiUpstream",
  "bareHost",
  "canonicalHost",
  "compressionOwner",
  "cspConnectSources",
  "cspFrameSources",
  "cspPolicy",
  "framingPolicy",
  "hstsOwner",
  "hstsValue",
  "tlsBinding",
  "websiteRoot",
]);

const SYNTHETIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

export class OpenHttpContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenHttpContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OpenHttpContractError(code, message);
}

function countOccurrences(source, value) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}

function validatePlaceholderInventory(source, expected, label) {
  const allowed = new Set(Object.values(OPEN_HTTP_PLACEHOLDERS));
  const discovered = source.match(/__[A-Z0-9_]+__/g) ?? [];
  if (discovered.some((token) => !allowed.has(token))) {
    fail(
      "TEMPLATE_PLACEHOLDER_INVALID",
      `${label} template contains an unknown placeholder`,
    );
  }
  for (const [token, count] of Object.entries(expected)) {
    if (countOccurrences(source, token) !== count) {
      fail(
        "TEMPLATE_PLACEHOLDER_INVALID",
        `${label} template placeholder count does not match the frozen inventory`,
      );
    }
  }
}

function validateValueFreeTemplate(source, label) {
  const withoutComments = stripComments(source);
  const serverNames = [...withoutComments.matchAll(/\bserver_name\s+([^;]+);/g)];
  if (
    serverNames.length === 0 ||
    serverNames.some((match) => {
      const names = match[1].trim().split(/\s+/);
      return names.some(
        (name) =>
          ![
            OPEN_HTTP_PLACEHOLDERS.canonicalHost,
            OPEN_HTTP_PLACEHOLDERS.bareHost,
          ].includes(name),
      );
    })
  ) {
    fail(
      "TEMPLATE_VALUE_FORBIDDEN",
      `${label} template contains a concrete or broad server name`,
    );
  }
  const roots = [...withoutComments.matchAll(/\broot\s+([^;]+);/g)];
  if (
    roots.some(
      (match) => match[1].trim() !== OPEN_HTTP_PLACEHOLDERS.websiteRoot,
    )
  ) {
    fail(
      "TEMPLATE_VALUE_FORBIDDEN",
      `${label} template contains a concrete website root`,
    );
  }
  const upstreams = [...withoutComments.matchAll(/\bproxy_pass\s+([^;]+);/g)];
  if (
    upstreams.some(
      (match) => match[1].trim() !== OPEN_HTTP_PLACEHOLDERS.apiUpstream,
    )
  ) {
    fail(
      "TEMPLATE_VALUE_FORBIDDEN",
      `${label} template contains a concrete API upstream`,
    );
  }
  if (
    /\bssl_certificate(?:_key)?\b|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bpassword\s*=|\bcredential\s*=/i.test(
      withoutComments,
    ) ||
    /\binclude\s+\/(?:etc|opt|private|srv|usr|var)\//.test(withoutComments)
  ) {
    fail(
      "TEMPLATE_VALUE_FORBIDDEN",
      `${label} template contains concrete TLS or credential material`,
    );
  }
}

function stripComments(source) {
  let output = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += character;
  }
  if (quote !== null) {
    fail("NGINX_STRUCTURE_INVALID", "Nginx input contains an unclosed quote");
  }
  return output;
}

function tokenize(source) {
  const input = stripComments(source);
  const tokens = [];
  let word = "";
  const flush = () => {
    if (word !== "") tokens.push(word);
    word = "";
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (character === '"' || character === "'") {
      flush();
      const quote = character;
      let quoted = quote;
      let closed = false;
      for (index += 1; index < input.length; index += 1) {
        const inner = input[index];
        quoted += inner;
        if (inner === "\\" && index + 1 < input.length) {
          index += 1;
          quoted += input[index];
          continue;
        }
        if (inner === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        fail("NGINX_STRUCTURE_INVALID", "Nginx input contains an unclosed quote");
      }
      tokens.push(quoted);
      continue;
    }
    if (character === "{" || character === "}" || character === ";") {
      flush();
      tokens.push(character);
      continue;
    }
    word += character;
  }
  flush();
  return tokens;
}

function parseNginx(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const parseContext = (nested) => {
    const nodes = [];
    while (cursor < tokens.length) {
      if (tokens[cursor] === "}") {
        if (!nested) {
          fail("NGINX_STRUCTURE_INVALID", "Nginx input has an unexpected brace");
        }
        cursor += 1;
        return nodes;
      }
      const name = tokens[cursor];
      if (name === "{" || name === ";") {
        fail("NGINX_STRUCTURE_INVALID", "Nginx input has an invalid directive");
      }
      cursor += 1;
      const args = [];
      while (
        cursor < tokens.length &&
        tokens[cursor] !== ";" &&
        tokens[cursor] !== "{" &&
        tokens[cursor] !== "}"
      ) {
        args.push(tokens[cursor]);
        cursor += 1;
      }
      if (tokens[cursor] === ";") {
        cursor += 1;
        nodes.push({ name, args, children: null });
        continue;
      }
      if (tokens[cursor] === "{") {
        cursor += 1;
        nodes.push({ name, args, children: parseContext(true) });
        continue;
      }
      fail("NGINX_STRUCTURE_INVALID", "Nginx directive is not terminated");
    }
    if (nested) {
      fail("NGINX_STRUCTURE_INVALID", "Nginx input contains an unclosed block");
    }
    return nodes;
  };
  return parseContext(false);
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function argsOf(node) {
  return node.args.map(unquote);
}

function direct(node, name) {
  return (node.children ?? []).filter((child) => child.name === name);
}

function descendants(nodes) {
  const result = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children !== null) result.push(...descendants(node.children));
  }
  return result;
}

function requireSingleDirective(node, name, expectedArgs, code, message) {
  const matches = direct(node, name);
  if (
    matches.length !== 1 ||
    argsOf(matches[0]).join("\u0000") !== expectedArgs.join("\u0000")
  ) {
    fail(code, message);
  }
}

function directArgumentStrings(node, name) {
  return direct(node, name).map((entry) => argsOf(entry).join(" "));
}

function serverKind(server) {
  const listens = directArgumentStrings(server, "listen").sort();
  if (listens.join("\u0000") === ["80", "[::]:80"].sort().join("\u0000")) {
    return "http";
  }
  if (
    listens.join("\u0000") ===
    ["443 ssl", "[::]:443 ssl"].sort().join("\u0000")
  ) {
    return "https";
  }
  fail("OPEN_TOPOLOGY_INVALID", "server listener ownership is not exact");
}

function requireServers(nodes, label) {
  if (
    nodes.length !== 2 ||
    nodes.some(
      (node) =>
        node.name !== "server" || node.args.length !== 0 || node.children === null,
    )
  ) {
    fail(
      "OPEN_TOPOLOGY_INVALID",
      `${label} input must contain exactly two top-level server blocks`,
    );
  }
  const byKind = new Map(nodes.map((server) => [serverKind(server), server]));
  if (byKind.size !== 2 || !byKind.has("http") || !byKind.has("https")) {
    fail(
      "OPEN_TOPOLOGY_INVALID",
      `${label} input must own one HTTP and one HTTPS server`,
    );
  }
  return byKind;
}

function requireServerName(server, expected) {
  requireSingleDirective(
    server,
    "server_name",
    [expected],
    "OPEN_TOPOLOGY_INVALID",
    "server name ownership does not match expected metadata",
  );
}

function requireReturn(server, expected) {
  requireSingleDirective(
    server,
    "return",
    expected,
    "OPEN_TOPOLOGY_INVALID",
    "redirect ownership does not match the frozen topology",
  );
}

function requireMarker(source, name, expected, count, code) {
  const expression = new RegExp(`^\\s*#\\s*${name}:\\s*([^\\r\\n]+)\\s*$`, "gm");
  const values = [...source.matchAll(expression)].map((match) => match[1].trim());
  if (values.length !== count || values.some((value) => value !== expected)) {
    fail(code, `${name} marker does not match expected metadata`);
  }
}

function assertTlsBinding(server, code) {
  const tlsNodes = (server.children ?? []).filter(
    (node) =>
      node.name.startsWith("ssl_") ||
      (node.name === "include" && argsOf(node).join(" ") !== "mime.types"),
  );
  if (tlsNodes.length === 0 || tlsNodes.some((node) => node.children !== null)) {
    fail(code, "HTTPS server is missing bound TLS directives");
  }
}

function header(server, name, code) {
  const matches = direct(server, "add_header").filter(
    (node) => argsOf(node)[0] === name,
  );
  if (matches.length !== 1) {
    fail(code, `required ${name} header ownership is not exact`);
  }
  const args = argsOf(matches[0]);
  if (args.length !== 3 || args[2] !== "always") {
    fail(code, `required ${name} header must apply with always`);
  }
  return args[1];
}

function parseCsp(policy) {
  const directives = new Map();
  for (const part of policy.split(";")) {
    const fields = part.trim().split(/\s+/).filter(Boolean);
    if (fields.length === 0) continue;
    const [name, ...sources] = fields;
    if (directives.has(name) || sources.length === 0) {
      fail("OPEN_SECURITY_INVALID", "CSP directives must be unique and nonempty");
    }
    directives.set(name, sources);
  }
  for (const name of REQUIRED_CSP_DIRECTIVES) {
    if (!directives.has(name)) {
      fail("OPEN_SECURITY_INVALID", "CSP is missing a required directive");
    }
  }
  for (const sources of directives.values()) {
    if (
      sources.some(
        (source) => source.includes("*") || source === "'unsafe-eval'",
      )
    ) {
      fail("OPEN_SECURITY_INVALID", "CSP contains a forbidden source expression");
    }
  }
  if (
    directives
      .get("script-src")
      .some((source) => source.toLowerCase().startsWith("data:"))
  ) {
    fail("OPEN_SECURITY_INVALID", "script-src must not allow data sources");
  }
  return directives;
}

function equalStringArrays(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateSecurity(server, expected) {
  requireSingleDirective(
    server,
    "include",
    ["mime.types"],
    "OPEN_SECURITY_INVALID",
    "production MIME mapping is missing",
  );
  requireSingleDirective(
    server,
    "default_type",
    ["application/octet-stream"],
    "OPEN_SECURITY_INVALID",
    "safe default MIME type is missing",
  );
  if (header(server, "X-Content-Type-Options", "OPEN_SECURITY_INVALID") !== "nosniff") {
    fail("OPEN_SECURITY_INVALID", "nosniff policy is not exact");
  }
  if (
    header(server, "Referrer-Policy", "OPEN_SECURITY_INVALID") !==
    "strict-origin-when-cross-origin"
  ) {
    fail("OPEN_SECURITY_INVALID", "referrer policy is not exact");
  }
  if (
    header(server, "Permissions-Policy", "OPEN_SECURITY_INVALID") !==
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  ) {
    fail("OPEN_SECURITY_INVALID", "permissions policy is not exact");
  }
  const csp = header(server, "Content-Security-Policy", "OPEN_SECURITY_INVALID");
  if (csp !== expected.cspPolicy) {
    fail("RENDERED_METADATA_MISMATCH", "rendered CSP does not match expected metadata");
  }
  const directives = parseCsp(csp);
  if (
    !equalStringArrays(
      directives.get("connect-src"),
      expected.cspConnectSources,
    ) ||
    !equalStringArrays(directives.get("frame-src"), expected.cspFrameSources)
  ) {
    fail(
      "RENDERED_METADATA_MISMATCH",
      "rendered CSP allowlists do not match expected metadata",
    );
  }
  const xFrameOptions = header(server, "X-Frame-Options", "OPEN_SECURITY_INVALID");
  const frameAncestors = directives.get("frame-ancestors");
  if (
    (expected.framingPolicy === "same-origin" &&
      (xFrameOptions !== "SAMEORIGIN" ||
        !equalStringArrays(frameAncestors, ["'self'"]))) ||
    (expected.framingPolicy === "deny" &&
      (xFrameOptions !== "DENY" ||
        !equalStringArrays(frameAncestors, ["'none'"])))
  ) {
    fail("OPEN_SECURITY_INVALID", "framing policies are inconsistent");
  }
}

function locationByArgs(server, expectedArgs) {
  const matches = direct(server, "location").filter(
    (node) => argsOf(node).join("\u0000") === expectedArgs.join("\u0000"),
  );
  if (matches.length !== 1 || matches[0].children === null) {
    fail("OPEN_ROUTING_INVALID", "required location ownership is not exact");
  }
  return matches[0];
}

function requireCache(location, value) {
  requireSingleDirective(
    location,
    "set",
    ["$open_cache_control", value],
    "OPEN_CACHE_INVALID",
    "location cache policy is not exact",
  );
}

function requireTryFiles(location, expectedArgs) {
  requireSingleDirective(
    location,
    "try_files",
    expectedArgs,
    "OPEN_ROUTING_INVALID",
    "static and SPA fallback behavior is not exact",
  );
}

function requireOnlyDirectives(node, allowed, code, message) {
  if (
    (node.children ?? []).some(
      (child) => child.children !== null || !allowed.has(child.name),
    )
  ) {
    fail(code, message);
  }
}

function validateApiLocation(location, expected) {
  requireOnlyDirectives(
    location,
    new Set([
      "set",
      "proxy_cache",
      "proxy_no_cache",
      "proxy_cache_bypass",
      "proxy_intercept_errors",
      "proxy_pass",
    ]),
    "OPEN_ROUTING_INVALID",
    "API location contains an unowned directive",
  );
  requireCache(location, "");
  requireSingleDirective(
    location,
    "proxy_pass",
    [expected.apiUpstream],
    "RENDERED_METADATA_MISMATCH",
    "API upstream does not match expected metadata",
  );
  for (const [name, args] of [
    ["proxy_cache", ["off"]],
    ["proxy_no_cache", ["1"]],
    ["proxy_cache_bypass", ["1"]],
    ["proxy_intercept_errors", ["off"]],
  ]) {
    requireSingleDirective(
      location,
      name,
      args,
      "OPEN_ROUTING_INVALID",
      "API proxy isolation duties are incomplete",
    );
  }
  if (
    descendants(location.children ?? []).some((node) =>
      ["try_files", "error_page", "add_header", "proxy_hide_header"].includes(
        node.name,
      ),
    )
  ) {
    fail("OPEN_ROUTING_INVALID", "API responses can be rewritten or hidden");
  }
}

function validateRouting(server, expected) {
  const locations = direct(server, "location");
  if (locations.length !== 7 || locations.some((node) => node.children === null)) {
    fail("OPEN_ROUTING_INVALID", "canonical HTTPS location inventory is not exact");
  }
  const requiredOrder = [
    ["=", "/api"],
    ["^~", "/api/"],
    ["~", HASHED_ASSET_PATTERN],
    ["/assets/"],
    ["~", FILE_LIKE_PATTERN],
    ["=", "/index.html"],
    ["/"],
  ];
  const invalidLocationIndex = locations.findIndex(
    (location, index) =>
      argsOf(location).join("\u0000") !== requiredOrder[index].join("\u0000"),
  );
  if (invalidLocationIndex !== -1) {
    fail(
      "OPEN_ROUTING_INVALID",
      `location priority mismatch at frozen position ${invalidLocationIndex + 1}`,
    );
  }

  const apiExact = locationByArgs(server, ["=", "/api"]);
  const apiPrefix = locationByArgs(server, ["^~", "/api/"]);
  validateApiLocation(apiExact, expected);
  validateApiLocation(apiPrefix, expected);

  const hashed = locationByArgs(server, ["~", HASHED_ASSET_PATTERN]);
  requireOnlyDirectives(
    hashed,
    new Set(["set", "try_files"]),
    "OPEN_ROUTING_INVALID",
    "hashed asset location contains an unowned directive",
  );
  requireCache(hashed, "public, max-age=31536000, immutable");
  requireTryFiles(hashed, ["$uri", "=404"]);

  const assets = locationByArgs(server, ["/assets/"]);
  requireOnlyDirectives(
    assets,
    new Set(["set", "try_files"]),
    "OPEN_ROUTING_INVALID",
    "asset location contains an unowned directive",
  );
  requireCache(assets, "no-cache, must-revalidate");
  requireTryFiles(assets, ["$uri", "=404"]);

  const fileLike = locationByArgs(server, ["~", FILE_LIKE_PATTERN]);
  requireOnlyDirectives(
    fileLike,
    new Set(["set", "try_files"]),
    "OPEN_ROUTING_INVALID",
    "file-like location contains an unowned directive",
  );
  requireCache(fileLike, "no-cache, must-revalidate");
  requireTryFiles(fileLike, ["$uri", "=404"]);

  const index = locationByArgs(server, ["=", "/index.html"]);
  requireOnlyDirectives(
    index,
    new Set(["set", "try_files"]),
    "OPEN_ROUTING_INVALID",
    "index location contains an unowned directive",
  );
  requireCache(index, "no-cache, no-store, must-revalidate");
  requireTryFiles(index, ["/index.html", "=404"]);

  const spa = locationByArgs(server, ["/"]);
  requireOnlyDirectives(
    spa,
    new Set(["set", "try_files"]),
    "OPEN_ROUTING_INVALID",
    "SPA location contains an unowned directive",
  );
  requireCache(spa, "no-cache, no-store, must-revalidate");
  requireTryFiles(spa, ["$uri", "$uri/", "/index.html"]);

  const allNodes = descendants(server.children ?? []);
  const apiNodes = new Set([
    ...descendants(apiExact.children ?? []),
    ...descendants(apiPrefix.children ?? []),
  ]);
  if (
    allNodes.some(
      (node) =>
        node.name === "proxy_pass" && !apiNodes.has(node),
    ) ||
    allNodes.some((node) => ["alias", "error_page"].includes(node.name)) ||
    locations.some((location) => direct(location, "add_header").length !== 0) ||
    allNodes.some((node) => {
      const args = argsOf(node);
      return (
        node.name === "proxy_hide_header" &&
        ["cache-control", "content-encoding", "vary"].includes(
          (args[0] ?? "").toLowerCase(),
        )
      );
    })
  ) {
    fail("OPEN_ROUTING_INVALID", "routing isolation contains a forbidden directive");
  }
}

function compressionNodes(nodes) {
  return descendants(nodes).filter((node) =>
    /^(?:gzip|brotli|zstd|gunzip)(?:_|$)/.test(node.name),
  );
}

function validateCompression(canonicalHttps, otherServers) {
  const owned = compressionNodes(canonicalHttps.children ?? []);
  const active = owned.filter(
    (node) =>
      ["gzip", "brotli", "zstd", "gunzip"].includes(node.name) &&
      argsOf(node).join(" ") === "on",
  );
  const activeFamilies = active
    .map((node) => node.name)
    .filter((name) => name !== "gunzip");
  if (
    activeFamilies.length !== 1 ||
    active.some((node) => node.name === "gunzip") ||
    otherServers.some(
      (server) => compressionNodes(server.children ?? []).length !== 0,
    )
  ) {
    fail("OPEN_COMPRESSION_INVALID", "compression must have one HTTPS owner");
  }
  const family = activeFamilies[0];
  const moduleVary = owned.some(
    (node) => node.name === `${family}_vary` && argsOf(node).join(" ") === "on",
  );
  const headerVary = direct(canonicalHttps, "add_header").some((node) => {
    const args = argsOf(node);
    return (
      args[0] === "Vary" &&
      args[1]
        .split(/\s*,\s*/)
        .map((value) => value.toLowerCase())
        .includes("accept-encoding") &&
      args[2] === "always"
    );
  });
  if (!moduleVary && !headerVary) {
    fail("OPEN_COMPRESSION_INVALID", "compression must own Vary: Accept-Encoding");
  }
  if (
    descendants(canonicalHttps.children ?? []).some((node) => {
      const args = argsOf(node);
      return (
        node.name === "proxy_set_header" &&
        (args[0] ?? "").toLowerCase() === "accept-encoding"
      );
    })
  ) {
    fail("OPEN_COMPRESSION_INVALID", "API content encoding must not be rewritten");
  }
}

function validateExpectedMetadata(expected) {
  if (
    typeof expected !== "object" ||
    expected === null ||
    Array.isArray(expected) ||
    Object.keys(expected).sort().join("\u0000") !==
      [...EXPECTED_METADATA_KEYS].sort().join("\u0000")
  ) {
    fail("ARGUMENT_ERROR", "expected metadata has an invalid shape");
  }
  for (const name of [
    "apiUpstream",
    "bareHost",
    "canonicalHost",
    "compressionOwner",
    "hstsOwner",
    "tlsBinding",
    "websiteRoot",
  ]) {
    if (
      typeof expected[name] !== "string" ||
      expected[name].trim() === "" ||
      /[\r\n{};]/.test(expected[name])
    ) {
      fail("ARGUMENT_ERROR", "expected metadata contains an invalid string");
    }
  }
  for (const name of ["cspPolicy", "hstsValue"]) {
    if (
      typeof expected[name] !== "string" ||
      expected[name].trim() === "" ||
      /[\r\n{}]/.test(expected[name])
    ) {
      fail("ARGUMENT_ERROR", "expected policy metadata contains an invalid string");
    }
  }
  for (const name of ["canonicalHost", "bareHost"]) {
    if (
      /[\s/:*]/.test(expected[name]) ||
      expected[name].startsWith(".") ||
      expected[name].endsWith(".")
    ) {
      fail("ARGUMENT_ERROR", "expected host metadata is invalid");
    }
  }
  if (expected.canonicalHost === expected.bareHost || !expected.websiteRoot.startsWith("/")) {
    fail("ARGUMENT_ERROR", "expected host or root metadata is invalid");
  }
  let upstream;
  try {
    upstream = new URL(expected.apiUpstream);
  } catch {
    fail("ARGUMENT_ERROR", "expected API upstream metadata is invalid");
  }
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username !== "" ||
    upstream.password !== "" ||
    upstream.hash !== "" ||
    upstream.search !== ""
  ) {
    fail("ARGUMENT_ERROR", "expected API upstream metadata is invalid");
  }
  for (const name of ["cspConnectSources", "cspFrameSources"]) {
    if (
      !Array.isArray(expected[name]) ||
      expected[name].length === 0 ||
      expected[name].some(
        (value) =>
          typeof value !== "string" ||
          value.trim() === "" ||
          /[\s;*]/.test(value),
      )
    ) {
      fail("ARGUMENT_ERROR", "expected CSP allowlist metadata is invalid");
    }
  }
  if (!["same-origin", "deny"].includes(expected.framingPolicy)) {
    fail("ARGUMENT_ERROR", "expected framing metadata is invalid");
  }
  if (
    !/^max-age=[1-9][0-9]*(?:;\s*includeSubDomains)?(?:;\s*preload)?$/i.test(
      expected.hstsValue,
    )
  ) {
    fail("ARGUMENT_ERROR", "expected HSTS metadata is invalid");
  }
}

function validateClosedCandidate(closedCandidate) {
  const nodes = parseNginx(closedCandidate);
  const servers = requireServers(nodes, "closed candidate");
  for (const server of servers.values()) {
    const all = descendants(server.children ?? []);
    if (
      direct(server, "return").length !== 1 ||
      argsOf(direct(server, "return")[0]).join(" ") !== "503" ||
      all.some((node) =>
        [
          "location",
          "proxy_pass",
          "root",
          "try_files",
          "rewrite",
          "alias",
          "index",
        ].includes(node.name),
      ) ||
      all.some((node) => node.children !== null) ||
      direct(server, "add_header").some((node) => {
        const name = (argsOf(node)[0] ?? "").toLowerCase();
        return !["cache-control", "retry-after"].includes(name);
      })
    ) {
      fail("OPEN_CLOSED_CONFLICT", "closed candidate contains open-state behavior");
    }
  }
}

export function validateRenderedSources({
  openConfig,
  bareConfig,
  closedCandidate,
  expected,
}) {
  for (const source of [openConfig, bareConfig, closedCandidate]) {
    if (typeof source !== "string" || source.trim() === "") {
      fail("ARGUMENT_ERROR", "rendered validation requires three nonempty inputs");
    }
  }
  validateExpectedMetadata(expected);
  if (/__[A-Z0-9_]+__/.test(openConfig) || /__[A-Z0-9_]+__/.test(bareConfig)) {
    fail("UNRESOLVED_PLACEHOLDER", "rendered configuration contains a placeholder");
  }
  const normalizedOpen = stripComments(openConfig);
  if (/\breturn\s+503\s*;|\bRetry-After\b/i.test(normalizedOpen)) {
    fail("OPEN_CLOSED_CONFLICT", "open configuration contains closed-state behavior");
  }

  const openServers = requireServers(parseNginx(openConfig), "open configuration");
  const bareServers = requireServers(parseNginx(bareConfig), "bare configuration");
  const openHttp = openServers.get("http");
  const openHttps = openServers.get("https");
  const bareHttp = bareServers.get("http");
  const bareHttps = bareServers.get("https");

  requireServerName(openHttp, expected.canonicalHost);
  requireServerName(openHttps, expected.canonicalHost);
  requireServerName(bareHttp, expected.bareHost);
  requireServerName(bareHttps, expected.bareHost);
  requireReturn(openHttp, [
    "308",
    `https://${expected.canonicalHost}$request_uri`,
  ]);
  requireReturn(bareHttp, [
    "308",
    `https://${expected.canonicalHost}$request_uri`,
  ]);
  requireReturn(bareHttps, [
    "308",
    `https://${expected.canonicalHost}$request_uri`,
  ]);
  if (
    direct(openHttps, "return").length !== 0 ||
    direct(openHttp, "location").length !== 0 ||
    direct(bareHttp, "location").length !== 0 ||
    direct(bareHttps, "location").length !== 0
  ) {
    fail("OPEN_TOPOLOGY_INVALID", "server responsibilities overlap");
  }
  const redirectForbidden = new Set([
    "alias",
    "error_page",
    "index",
    "location",
    "proxy_pass",
    "rewrite",
    "root",
    "try_files",
  ]);
  if (
    [openHttp, bareHttp, bareHttps].some((server) =>
      descendants(server.children ?? []).some(
        (node) => node.children !== null || redirectForbidden.has(node.name),
      ),
    ) ||
    (openHttps.children ?? []).some(
      (node) => node.children !== null && node.name !== "location",
    )
  ) {
    fail("OPEN_TOPOLOGY_INVALID", "server responsibilities contain an unowned block");
  }

  requireSingleDirective(
    openHttps,
    "root",
    [expected.websiteRoot],
    "RENDERED_METADATA_MISMATCH",
    "website root does not match expected metadata",
  );
  requireSingleDirective(
    openHttps,
    "index",
    ["index.html"],
    "OPEN_ROUTING_INVALID",
    "SPA index ownership is missing",
  );
  requireSingleDirective(
    openHttps,
    "autoindex",
    ["off"],
    "OPEN_ROUTING_INVALID",
    "directory listing must be disabled",
  );

  requireMarker(
    openConfig,
    "OPEN_TLS_BINDING",
    expected.tlsBinding,
    1,
    "OPEN_SECURITY_INVALID",
  );
  requireMarker(
    bareConfig,
    "OPEN_TLS_BINDING",
    expected.tlsBinding,
    1,
    "OPEN_SECURITY_INVALID",
  );
  requireMarker(
    openConfig,
    "OPEN_FRAMING_POLICY",
    expected.framingPolicy,
    1,
    "OPEN_SECURITY_INVALID",
  );
  requireMarker(
    openConfig,
    "OPEN_HSTS_OWNER",
    expected.hstsOwner,
    1,
    "OPEN_SECURITY_INVALID",
  );
  requireMarker(
    bareConfig,
    "OPEN_HSTS_OWNER",
    expected.hstsOwner,
    1,
    "OPEN_SECURITY_INVALID",
  );
  requireMarker(
    openConfig,
    "OPEN_COMPRESSION_OWNER",
    expected.compressionOwner,
    1,
    "OPEN_COMPRESSION_INVALID",
  );
  assertTlsBinding(openHttps, "OPEN_SECURITY_INVALID");
  assertTlsBinding(bareHttps, "OPEN_SECURITY_INVALID");
  if (
    descendants(openHttp.children ?? []).some((node) => node.name.startsWith("ssl_")) ||
    descendants(bareHttp.children ?? []).some((node) => node.name.startsWith("ssl_"))
  ) {
    fail("OPEN_SECURITY_INVALID", "TLS directives must remain HTTPS-only");
  }

  validateSecurity(openHttps, expected);
  if (
    header(openHttps, "Strict-Transport-Security", "OPEN_SECURITY_INVALID") !==
      expected.hstsValue ||
    header(bareHttps, "Strict-Transport-Security", "OPEN_SECURITY_INVALID") !==
      expected.hstsValue
  ) {
    fail(
      "RENDERED_METADATA_MISMATCH",
      "HSTS value does not match expected metadata",
    );
  }
  if (
    direct(openHttp, "add_header").some(
      (node) => argsOf(node)[0] === "Strict-Transport-Security",
    ) ||
    direct(bareHttp, "add_header").some(
      (node) => argsOf(node)[0] === "Strict-Transport-Security",
    )
  ) {
    fail("OPEN_SECURITY_INVALID", "HSTS must remain HTTPS-only");
  }
  if (header(openHttps, "Cache-Control", "OPEN_CACHE_INVALID") !== "$open_cache_control") {
    fail("OPEN_CACHE_INVALID", "cache header variable ownership is not exact");
  }
  requireSingleDirective(
    openHttps,
    "set",
    ["$open_cache_control", "no-cache, no-store, must-revalidate"],
    "OPEN_CACHE_INVALID",
    "default HTML cache policy is not fail-safe",
  );

  validateRouting(openHttps, expected);
  validateCompression(openHttps, [openHttp, bareHttp, bareHttps]);
  validateClosedCandidate(closedCandidate);

  return Object.freeze({
    status: "ok",
    mode: "rendered",
    topology: "open-canonical-plus-bare",
  });
}

function renderTemplate(source, replacements) {
  let rendered = source;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

export function createSanitizedSyntheticRender({
  websiteRoot = "/tmp/open-http-contract-synthetic/root",
} = {}) {
  const expected = Object.freeze({
    canonicalHost: "canonical.example.invalid",
    bareHost: "bare.example.invalid",
    websiteRoot,
    apiUpstream: "http://127.0.0.1:18080",
    tlsBinding: "synthetic-existing-tls",
    cspPolicy: SYNTHETIC_CSP,
    cspConnectSources: Object.freeze(["'self'"]),
    cspFrameSources: Object.freeze(["'none'"]),
    framingPolicy: "same-origin",
    hstsOwner: "https-server",
    hstsValue: "max-age=31536000",
    compressionOwner: "canonical-https",
  });
  return Object.freeze({
    expected,
    replacements: Object.freeze({
      [OPEN_HTTP_PLACEHOLDERS.canonicalHost]: expected.canonicalHost,
      [OPEN_HTTP_PLACEHOLDERS.bareHost]: expected.bareHost,
      [OPEN_HTTP_PLACEHOLDERS.websiteRoot]: expected.websiteRoot,
      [OPEN_HTTP_PLACEHOLDERS.apiUpstream]: expected.apiUpstream,
      [OPEN_HTTP_PLACEHOLDERS.tlsDirectives]: [
        `# OPEN_TLS_BINDING: ${expected.tlsBinding}`,
        "ssl_certificate /tmp/open-http-contract-synthetic/cert.pem;",
        "ssl_certificate_key /tmp/open-http-contract-synthetic/key.pem;",
        "ssl_protocols TLSv1.2 TLSv1.3;",
      ].join("\n"),
      [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${expected.cspPolicy}"`,
      [OPEN_HTTP_PLACEHOLDERS.framingDirective]: [
        `# OPEN_FRAMING_POLICY: ${expected.framingPolicy}`,
        'add_header X-Frame-Options "SAMEORIGIN" always;',
      ].join("\n"),
      [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: [
        `# OPEN_HSTS_OWNER: ${expected.hstsOwner}`,
        `add_header Strict-Transport-Security "${expected.hstsValue}" always;`,
      ].join("\n"),
      [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: [
        `# OPEN_COMPRESSION_OWNER: ${expected.compressionOwner}`,
        "gzip on;",
        "gzip_vary on;",
        "gzip_types text/css application/javascript application/json image/svg+xml;",
      ].join("\n"),
    }),
  });
}

export function validateTemplateSources({
  openTemplate,
  bareTemplate,
  closedCandidate,
  syntheticWebsiteRoot,
}) {
  for (const source of [openTemplate, bareTemplate, closedCandidate]) {
    if (typeof source !== "string" || source.trim() === "") {
      fail("ARGUMENT_ERROR", "template validation requires three nonempty inputs");
    }
  }
  validatePlaceholderInventory(openTemplate, TEMPLATE_COUNTS.open, "open");
  validatePlaceholderInventory(bareTemplate, TEMPLATE_COUNTS.bare, "bare");
  validateValueFreeTemplate(openTemplate, "open");
  validateValueFreeTemplate(bareTemplate, "bare");
  const synthetic = createSanitizedSyntheticRender({
    websiteRoot: syntheticWebsiteRoot,
  });
  validateRenderedSources({
    openConfig: renderTemplate(openTemplate, synthetic.replacements),
    bareConfig: renderTemplate(bareTemplate, synthetic.replacements),
    closedCandidate,
    expected: synthetic.expected,
  });
  return Object.freeze({
    status: "ok",
    mode: "template-and-synthetic-render",
    placeholders: Object.values(OPEN_HTTP_PLACEHOLDERS).length,
  });
}

function existingDirectory(input) {
  try {
    const directory = realpathSync(resolve(input));
    if (!statSync(directory).isDirectory()) throw new Error("not a directory");
    return directory;
  } catch {
    fail("ARGUMENT_ERROR", "--source must be an existing directory");
  }
}

function readRegularFile(path, label) {
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("not regular");
    return readFileSync(path, "utf8");
  } catch {
    fail("ARTIFACT_MISSING", `${label} must be a regular file`);
  }
}

export function validateTemplateRoot(source) {
  const root = existingDirectory(source);
  return validateTemplateSources({
    openTemplate: readRegularFile(
      join(root, "ops/nginx/release-traffic-open.conf.example"),
      "open template",
    ),
    bareTemplate: readRegularFile(
      join(root, "ops/nginx/bare-domain-redirect.conf.example"),
      "bare template",
    ),
    closedCandidate: readRegularFile(
      join(root, "ops/nginx/release-traffic-closed.conf.example"),
      "closed candidate",
    ),
  });
}

function parseOptions(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      fail("ARGUMENT_ERROR", "options must be --name value pairs");
    }
    if (options.has(name)) fail("ARGUMENT_ERROR", "options may appear only once");
    options.set(name, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    fail("ARGUMENT_ERROR", `${name} is required`);
  }
  return value;
}

export function run(arguments_) {
  const options = parseOptions(arguments_);
  const allowed = new Set([
    "--source",
    "--open-config",
    "--bare-config",
    "--closed-config",
    "--expected-metadata",
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    fail("ARGUMENT_ERROR", "unsupported option");
  }
  if (options.has("--source")) {
    if (options.size !== 1) {
      fail("ARGUMENT_ERROR", "--source cannot be combined with rendered inputs");
    }
    return validateTemplateRoot(requiredOption(options, "--source"));
  }
  if (options.size !== 4) {
    fail("ARGUMENT_ERROR", "rendered validation requires four input options");
  }
  let expected;
  try {
    expected = JSON.parse(
      readRegularFile(
        resolve(requiredOption(options, "--expected-metadata")),
        "expected metadata",
      ),
    );
  } catch (error) {
    if (error instanceof OpenHttpContractError) throw error;
    fail("ARGUMENT_ERROR", "expected metadata must contain valid JSON");
  }
  return validateRenderedSources({
    openConfig: readRegularFile(
      resolve(requiredOption(options, "--open-config")),
      "rendered open configuration",
    ),
    bareConfig: readRegularFile(
      resolve(requiredOption(options, "--bare-config")),
      "rendered bare configuration",
    ),
    closedCandidate: readRegularFile(
      resolve(requiredOption(options, "--closed-config")),
      "closed candidate",
    ),
    expected,
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    const safe =
      error instanceof OpenHttpContractError
        ? error
        : new OpenHttpContractError(
            "INTERNAL_FAILURE",
            "open HTTP contract validation failed",
          );
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        code: safe.code,
        message: safe.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

function isDirectExecution(moduleUrl, argumentPath) {
  if (argumentPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argumentPath));
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) main();
