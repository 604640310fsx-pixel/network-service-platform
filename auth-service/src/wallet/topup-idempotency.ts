/** Candidate-only additive DDL. Apply explicitly to an isolated local test DB;
 * it is deliberately absent from the formal migration runner. */
export const TOPUP_IDEMPOTENCY_CANDIDATE_DDL = `
CREATE TABLE wallet_topup_idempotency (
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  order_ref TEXT NOT NULL UNIQUE REFERENCES wallet_topups(order_ref) ON DELETE RESTRICT,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  PRIMARY KEY (user_id, idempotency_key)
);
`;
