import type { DatabaseConnection } from "../db.js";
import type { LineSelector } from "../monitor/line-selector.js";
import { decryptGrantDeliveryItem, decryptServiceDeliveryItem } from "../payment/delivery-crypto.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

/* 解密买家本人一条交付线路的订阅 URL（仅服务端使用，绝不出网）。所有权在 SQL 内判定：
   已购服务须属于该买家且 open；赠送须属于该买家且 active + 已交付。找不到即 null。 */

function row(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Subscription delivery database invariant failed");
  }
  return value as Record<string, unknown>;
}

function integer(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error("Subscription delivery database invariant failed");
  return field;
}

function buffer(value: Record<string, unknown>, name: string): Buffer {
  const field = value[name];
  if (!Buffer.isBuffer(field)) throw new Error("Subscription delivery database invariant failed");
  return field;
}

function text(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error("Subscription delivery database invariant failed");
  return field;
}

export function readOwnedSubscriptionUrl(
  database: DatabaseConnection,
  userId: number,
  line: LineSelector,
  keyring: TokenHmacKeyring,
): string | null {
  if (line.kind === "service") {
    const rows = database
      .prepare(
        `SELECT services.id AS service_id, items.position, items.label, items.key_version, items.nonce, items.ciphertext, items.tag
         FROM service_delivery_items AS items
         JOIN services ON services.id = items.service_id
         JOIN payments ON payments.id = services.payment_id
         JOIN orders ON orders.id = payments.order_id
         WHERE orders.order_ref = ? AND orders.user_id = ? AND services.status = 'open' AND items.position = ?`,
      )
      .all(line.ref, userId, line.position);
    if (rows.length !== 1) return null;
    const value = row(rows[0]);
    return decryptServiceDeliveryItem(
      {
        serviceId: integer(value, "service_id"),
        position: integer(value, "position"),
        label: text(value, "label"),
        keyVersion: integer(value, "key_version"),
        nonce: buffer(value, "nonce"),
        ciphertext: buffer(value, "ciphertext"),
        tag: buffer(value, "tag"),
      },
      keyring,
    );
  }
  const rows = database
    .prepare(
      `SELECT items.grant_id, items.position, items.label, items.key_version, items.nonce, items.ciphertext, items.tag
       FROM admin_grant_delivery_items AS items
       JOIN admin_grants AS grants ON grants.id = items.grant_id
       WHERE grants.id = ? AND grants.user_id = ? AND grants.status = 'active' AND grants.delivery_status = 'open' AND items.position = ?`,
    )
    .all(line.ref, userId, line.position);
  if (rows.length !== 1) return null;
  const value = row(rows[0]);
  return decryptGrantDeliveryItem(
    {
      grantId: integer(value, "grant_id"),
      position: integer(value, "position"),
      label: text(value, "label"),
      keyVersion: integer(value, "key_version"),
      nonce: buffer(value, "nonce"),
      ciphertext: buffer(value, "ciphertext"),
      tag: buffer(value, "tag"),
    },
    keyring,
  );
}
