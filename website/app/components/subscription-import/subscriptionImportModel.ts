export const SUBSCRIPTION_PLATFORMS = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
] as const;

export type SubscriptionPlatform = (typeof SUBSCRIPTION_PLATFORMS)[number]["id"];

/* 客户端名称、逐平台顺序与推荐项来自用户最新冻结展示矩阵；
   该矩阵不代表 deep link 或客户端兼容性已经逐项确认。 */
export const SUBSCRIPTION_CLIENTS = [
  { id: "shadowrocket", name: "Shadowrocket" },
  { id: "sing-box", name: "SingBox" },
  { id: "loon", name: "Loon" },
  { id: "quantumult-x", name: "Quantumult X" },
  { id: "stash", name: "Stash" },
  { id: "surge", name: "Surge" },
  { id: "clash", name: "Clash" },
  { id: "surfboard", name: "Surfboard" },
  { id: "flclash", name: "FlClash" },
  { id: "clashx", name: "ClashX" },
] as const;

export type SubscriptionClient = (typeof SUBSCRIPTION_CLIENTS)[number];
export type SubscriptionClientId = SubscriptionClient["id"];
export type PlatformClient = SubscriptionClient & { readonly recommended: boolean };

type PlatformClientSetting = {
  readonly id: SubscriptionClientId;
  readonly recommended?: true;
};

export const SUBSCRIPTION_CLIENT_MATRIX: Readonly<
  Record<SubscriptionPlatform, readonly PlatformClientSetting[]>
> = {
  ios: [
    { id: "shadowrocket", recommended: true },
    { id: "sing-box", recommended: true },
    { id: "loon" },
    { id: "quantumult-x" },
    { id: "stash" },
    { id: "surge" },
  ],
  android: [
    { id: "clash", recommended: true },
    { id: "sing-box", recommended: true },
    { id: "surfboard", recommended: true },
    { id: "flclash" },
  ],
  macos: [
    { id: "clash", recommended: true },
    { id: "sing-box", recommended: true },
    { id: "clashx" },
    { id: "flclash" },
    { id: "loon" },
    { id: "stash" },
    { id: "surge" },
  ],
  windows: [
    { id: "clash", recommended: true },
    { id: "sing-box", recommended: true },
    { id: "flclash" },
  ],
};

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

export function clientsForPlatform(platform: SubscriptionPlatform): readonly PlatformClient[] {
  return SUBSCRIPTION_CLIENT_MATRIX[platform].map((setting) => {
    const client = SUBSCRIPTION_CLIENTS.find((candidate) => candidate.id === setting.id);
    if (client === undefined) throw new Error("invalid_subscription_client_matrix");
    return { ...client, recommended: setting.recommended === true };
  });
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
