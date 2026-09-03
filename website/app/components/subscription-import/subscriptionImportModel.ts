export const SUBSCRIPTION_PLATFORMS = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
] as const;

export type SubscriptionPlatform = (typeof SUBSCRIPTION_PLATFORMS)[number]["id"];

/* 客户端名称来自冻结 Task Packet。这里只表达平台筛选，不生成任何客户端 deep link。 */
export const SUBSCRIPTION_CLIENTS = [
  { id: "shadowrocket", name: "Shadowrocket", platforms: ["ios"] },
  { id: "sing-box", name: "SingBox", platforms: ["ios", "android", "macos", "windows"] },
  { id: "loon", name: "Loon", platforms: ["ios"] },
  { id: "quantumult-x", name: "Quantumult X", platforms: ["ios"] },
  { id: "stash", name: "Stash", platforms: ["ios", "macos"] },
  { id: "surge", name: "Surge", platforms: ["ios", "macos"] },
  { id: "clash", name: "Clash", platforms: ["android", "macos", "windows"] },
  { id: "surfboard", name: "Surfboard", platforms: ["android"] },
  { id: "flclash", name: "FlClash", platforms: ["android", "macos", "windows"] },
  { id: "clashx", name: "ClashX", platforms: ["macos"] },
] as const;

export type SubscriptionClient = (typeof SUBSCRIPTION_CLIENTS)[number];
export type SubscriptionClientId = SubscriptionClient["id"];

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_SUBSCRIPTION_URL_BYTES = 2048;
const BLOCKED_DEEP_LINK_PROTOCOLS = new Set([
  "blob:",
  "data:",
  "file:",
  "ftp:",
  "http:",
  "https:",
  "javascript:",
  "mailto:",
  "sms:",
  "tel:",
  "vbscript:",
]);

export function clientsForPlatform(platform: SubscriptionPlatform): readonly SubscriptionClient[] {
  return SUBSCRIPTION_CLIENTS.filter((client) =>
    (client.platforms as readonly SubscriptionPlatform[]).includes(platform),
  );
}

/**
 * The delivery API already rejects non-HTTPS subscription URLs. Re-check at the
 * UI boundary so a future caller cannot turn the safe-open, copy or QR actions
 * into a transport for an invalid value.
 */
export function safeSubscriptionHref(value: string): string | null {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_SUBSCRIPTION_URL_BYTES
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Deep links are never synthesized here. A caller may provide one only after
 * independently verifying that client's exact contract; this helper still
 * rejects browser, executable and credential-bearing URLs.
 */
export function safeVerifiedDeepLinkHref(value: string | null | undefined): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      BLOCKED_DEEP_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase()) ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
