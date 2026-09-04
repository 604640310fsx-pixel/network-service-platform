export const WEB_SESSION_COOKIE_NAME = "__Host-web_session";
export const WEB_SESSION_COOKIE_MAX_AGE_SECONDS = 2_592_000;
export const WEB_SESSION_COOKIE_EXPIRED =
  "Thu, 01 Jan 1970 00:00:00 GMT";

export function serializeWebSessionCookie(rawSessionToken: string): string {
  return `${WEB_SESSION_COOKIE_NAME}=${rawSessionToken}; Max-Age=${WEB_SESSION_COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function serializeExpiredWebSessionCookie(): string {
  return `${WEB_SESSION_COOKIE_NAME}=; Max-Age=0; Expires=${WEB_SESSION_COOKIE_EXPIRED}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readWebSessionCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) {
    return null;
  }

  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === WEB_SESSION_COOKIE_NAME) {
      values.push(part.slice(separator + 1).trim());
    }
  }

  return values.length === 1 && values[0] !== "" ? values[0]! : null;
}
