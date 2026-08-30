import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { TokenHmacKeyring } from "../session/session-token.js";
import { normalizeMonitorTargetKey } from "../monitor/target-catalog.js";

export const DELIVERY_AUTH_TAG_BYTES = 16;
export const DELIVERY_NONCE_BYTES = 12;
export const DELIVERY_MAX_ITEMS = 20;
export const DELIVERY_MAX_LABEL_LENGTH = 200;
export const DELIVERY_MAX_URL_UTF8_BYTES = 2_048;

const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface ServiceDeliveryInput {
  readonly label: string;
  readonly subscriptionUrl: string;
  readonly monitorTargetKey: string;
}

export interface EncryptedServiceDeliveryItem {
  readonly position: number;
  readonly label: string;
  readonly monitorTargetKey: string;
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export type DeliveryRandomBytesSource = (size: number) => Buffer;

interface NormalizedDeliveryPayload {
  readonly label: string;
  readonly subscriptionUrl: string;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Service delivery input is invalid");
  }
}

function decodeEncryptionKey(
  keyring: TokenHmacKeyring,
  version: number,
): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    encoded === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encoded)
  ) {
    throw new Error("Service delivery keyring is invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error("Service delivery keyring is invalid");
  }
  return decoded;
}

function serializeAad(
  serviceId: number,
  position: number,
  keyVersion: number,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      service_id: serviceId,
      position,
      key_version: keyVersion,
    }),
    "utf8",
  );
}

function normalizeDeliveryPayload(
  value: unknown,
): NormalizedDeliveryPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.label !== "string" ||
    typeof item.subscriptionUrl !== "string"
  ) {
    return null;
  }
  const label = item.label.trim();
  const subscriptionUrl = item.subscriptionUrl;
  if (
    label.length === 0 ||
    label.length > DELIVERY_MAX_LABEL_LENGTH ||
    subscriptionUrl.length === 0 ||
    subscriptionUrl.trim() !== subscriptionUrl ||
    Buffer.byteLength(subscriptionUrl, "utf8") >
      DELIVERY_MAX_URL_UTF8_BYTES
  ) {
    return null;
  }
  try {
    if (new URL(subscriptionUrl).protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return { label, subscriptionUrl };
}

export function normalizeServiceDeliveryInput(
  value: unknown,
): ServiceDeliveryInput | null {
  const payload = normalizeDeliveryPayload(value);
  if (payload === null || typeof value !== "object" || value === null) {
    return null;
  }
  const monitorTargetKey = normalizeMonitorTargetKey(
    (value as Record<string, unknown>).monitorTargetKey,
  );
  return monitorTargetKey === null
    ? null
    : { ...payload, monitorTargetKey };
}

export function encryptServiceDeliveryItem(
  input: {
    readonly serviceId: number;
    readonly position: number;
    readonly item: ServiceDeliveryInput;
  },
  keyring: TokenHmacKeyring,
  randomBytesSource: DeliveryRandomBytesSource = randomBytes,
): EncryptedServiceDeliveryItem {
  assertPositiveInteger(input.serviceId);
  assertPositiveInteger(input.position);
  const normalized = normalizeServiceDeliveryInput(input.item);
  if (normalized === null) {
    throw new Error("Service delivery input is invalid");
  }
  const keyVersion = keyring.version;
  const key = decodeEncryptionKey(keyring, keyVersion);
  const nonce = randomBytesSource(DELIVERY_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== DELIVERY_NONCE_BYTES) {
    throw new Error("Service delivery nonce generation failed");
  }
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: DELIVERY_AUTH_TAG_BYTES,
  });
  cipher.setAAD(
    serializeAad(input.serviceId, input.position, keyVersion),
  );
  const ciphertext = Buffer.concat([
    cipher.update(normalized.subscriptionUrl, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== DELIVERY_AUTH_TAG_BYTES) {
    throw new Error("Service delivery authentication tag is invalid");
  }
  return {
    position: input.position,
    label: normalized.label,
    monitorTargetKey: normalized.monitorTargetKey,
    keyVersion,
    nonce,
    ciphertext,
    tag,
  };
}

export function decryptServiceDeliveryItem(
  input: Omit<EncryptedServiceDeliveryItem, "monitorTargetKey"> & {
    readonly serviceId: number;
  },
  keyring: TokenHmacKeyring,
): string {
  assertPositiveInteger(input.serviceId);
  assertPositiveInteger(input.position);
  if (
    !Buffer.isBuffer(input.nonce) ||
    input.nonce.length !== DELIVERY_NONCE_BYTES ||
    !Buffer.isBuffer(input.tag) ||
    input.tag.length !== DELIVERY_AUTH_TAG_BYTES ||
    !Buffer.isBuffer(input.ciphertext)
  ) {
    throw new Error("Service delivery payload is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeEncryptionKey(keyring, input.keyVersion),
    input.nonce,
    { authTagLength: DELIVERY_AUTH_TAG_BYTES },
  );
  decipher.setAAD(
    serializeAad(input.serviceId, input.position, input.keyVersion),
  );
  decipher.setAuthTag(input.tag);
  const subscriptionUrl = Buffer.concat([
    decipher.update(input.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  if (
    normalizeDeliveryPayload({
      label: input.label,
      subscriptionUrl,
    }) === null
  ) {
    throw new Error("Service delivery payload is invalid");
  }
  return subscriptionUrl;
}
