import { createHmac, hkdfSync } from "node:crypto";

export const CSRF_TOKEN_LENGTH = 43;

const EMPTY_HKDF_SALT = Buffer.alloc(0);
const CSRF_HKDF_INFO = Buffer.from("csrf-token-v1", "utf8");

export function issueCsrfToken(
  csrfSigningKey: Buffer,
  sessionTokenHash: string,
): string {
  if (csrfSigningKey.length !== 32) {
    throw new Error("CSRF signing key is invalid");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionTokenHash)) {
    throw new Error("Session token hash is invalid");
  }

  const derivedKey = Buffer.from(
    hkdfSync(
      "sha256",
      csrfSigningKey,
      EMPTY_HKDF_SALT,
      CSRF_HKDF_INFO,
      32,
    ),
  );
  const token = createHmac("sha256", derivedKey)
    .update(sessionTokenHash, "ascii")
    .digest("base64url");

  if (token.length !== CSRF_TOKEN_LENGTH) {
    throw new Error("CSRF token generation failed");
  }
  return token;
}
