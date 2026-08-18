import { createHmac, hkdfSync } from "node:crypto";

import type { DatabaseConnection } from "../db.js";

export const INVITE_CODE_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
export const INVITE_CODE_HASH_LENGTH = 43;

const EMPTY_HKDF_SALT = Buffer.alloc(0);
const INVITE_CODE_HKDF_INFO = Buffer.from("invite-code-v1", "utf8");
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface InviteHmacKeyring {
  readonly version: number;
  readonly keys: Readonly<Record<string, string>>;
}

export interface InviteCodeHashCandidate {
  readonly version: number;
  readonly codeHash: string;
}

export interface InviteCodeRow {
  readonly id: number;
  readonly max_uses: number;
  readonly used_count: number;
  readonly revoked_at: string | null;
  readonly expires_at: string;
}

export class InvalidInviteCodeError extends Error {
  constructor() {
    super("Invalid invite code");
    this.name = "InvalidInviteCodeError";
  }
}

function decodeKey(keyring: InviteHmacKeyring, version: number): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    encoded === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encoded)
  ) {
    throw new InvalidInviteCodeError();
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new InvalidInviteCodeError();
  }
  return decoded;
}

function inviteKeyVersions(keyring: InviteHmacKeyring): readonly number[] {
  decodeKey(keyring, keyring.version);
  const previous = Object.keys(keyring.keys)
    .filter((value) => /^(0|[1-9][0-9]*)$/.test(value))
    .map(Number)
    .filter((version) => version < keyring.version)
    .sort((left, right) => right - left)[0];

  if (previous === undefined) {
    return [keyring.version];
  }
  decodeKey(keyring, previous);
  return [keyring.version, previous];
}

export function validateInviteCodeExact(inviteCode: string): string {
  if (
    typeof inviteCode !== "string" ||
    !INVITE_CODE_PATTERN.test(inviteCode)
  ) {
    throw new InvalidInviteCodeError();
  }
  return inviteCode;
}

export function computeInviteCodeHash(
  inviteCode: string,
  keyring: InviteHmacKeyring,
  version: number,
): string {
  validateInviteCodeExact(inviteCode);
  const derivedKey = Buffer.from(
    hkdfSync(
      "sha256",
      decodeKey(keyring, version),
      EMPTY_HKDF_SALT,
      INVITE_CODE_HKDF_INFO,
      32,
    ),
  );
  const output = createHmac("sha256", derivedKey)
    .update(inviteCode, "ascii")
    .digest("base64url");
  if (output.length !== INVITE_CODE_HASH_LENGTH) {
    throw new InvalidInviteCodeError();
  }
  return output;
}

export function computeInviteCodeHashCandidates(
  rawInput: string,
  keyring: InviteHmacKeyring,
): readonly InviteCodeHashCandidate[] {
  const inviteCode = validateInviteCodeExact(rawInput);
  return inviteKeyVersions(keyring).map((version) => ({
    version,
    codeHash: computeInviteCodeHash(inviteCode, keyring, version),
  }));
}

export function lookupInviteCode(
  database: DatabaseConnection,
  rawInput: string,
  keyring: InviteHmacKeyring,
): InviteCodeRow | null {
  const candidates = computeInviteCodeHashCandidates(rawInput, keyring);
  const placeholders = candidates.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT id, max_uses, used_count, revoked_at, expires_at
       FROM invite_codes
       WHERE code_hash IN (${placeholders})`,
    )
    .all(...candidates.map((candidate) => candidate.codeHash)) as InviteCodeRow[];
  if (rows.length > 1) {
    throw new InvalidInviteCodeError();
  }
  return rows[0] ?? null;
}
