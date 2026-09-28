import type { FastifyInstance, FastifyReply } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { ensureReferralProfile } from "../referral/profile.js";
import { readReferralSessionReadOnly } from "../referral/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

/* /api/me/invites: the signed-in account's own personal invite code (its stable
   referral public code) and how many accounts it directly invited. Self-only:
   no invitee identity or other personal data is ever returned. Accounts that
   predate personal invites get their code lazily through the existing
   collision-safe mechanism; an existing code is never rotated. */

export interface InviteHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly now?: () => Date;
}

function setNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}

function countDirectInvites(database: DatabaseConnection, userId: number): number {
  const rows = database
    .prepare("SELECT COUNT(*) AS count FROM users WHERE invited_by_user_id = ?")
    .all(userId) as Array<{ readonly count: unknown }>;
  const count = rows[0]?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Direct invite count is invalid");
  }
  return count;
}

export function registerInviteHttpRoutes(app: FastifyInstance, dependencies: InviteHttpDependencies): void {
  app.get(
    "/api/me/invites",
    { onRequest: async (_request, reply) => setNoStore(reply) },
    async (request, reply) => {
      try {
        const session = readReferralSessionReadOnly(request, dependencies);
        if (session === null) {
          return reply.code(401).send({ error: { code: "unauthorized" } });
        }
        const profile = ensureReferralProfile(
          dependencies.database,
          session.userId,
          dependencies.now ? { now: dependencies.now } : {},
        );
        return reply.code(200).send({
          code: profile.publicCode,
          directInviteCount: countDirectInvites(dependencies.database, session.userId),
        });
      } catch {
        return reply.code(503).send({ error: { code: "invites_unavailable" } });
      }
    },
  );
}
