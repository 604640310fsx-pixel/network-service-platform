ALTER TABLE invite_codes ADD COLUMN recipient_email TEXT;

ALTER TABLE audit_log ADD COLUMN invite_code_id INTEGER
  REFERENCES invite_codes(id) ON DELETE RESTRICT;
ALTER TABLE audit_log ADD COLUMN result_class TEXT;
ALTER TABLE audit_log ADD COLUMN recipient_hmac TEXT;

UPDATE pending_registrations
SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE consumed_at IS NULL
  AND superseded_at IS NULL
  AND invite_code_id IN (
    SELECT id FROM invite_codes WHERE recipient_email IS NULL
  );

DELETE FROM mail_outbox
WHERE EXISTS (
  SELECT 1
  FROM pending_registrations AS p
  JOIN invite_codes AS i ON i.id=p.invite_code_id
  WHERE i.recipient_email IS NULL
    AND mail_outbox.idempotency_key
      LIKE 'register-otp-v1:' || p.id || ':%'
);

UPDATE invite_codes
SET revoked_at=COALESCE(
  revoked_at,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
WHERE recipient_email IS NULL;

UPDATE audit_log
SET actor='system:invite', result_class='legacy_redacted'
WHERE action IN ('invite_code.create','invite_code.revoke');

CREATE UNIQUE INDEX idx_invite_codes_open_recipient_unique
ON invite_codes(recipient_email)
WHERE recipient_email IS NOT NULL
  AND revoked_at IS NULL
  AND used_count=0;

CREATE TRIGGER trg_invite_codes_insert_prebound_single_use
BEFORE INSERT ON invite_codes
FOR EACH ROW
WHEN
  length(NEW.code_hash)<>43
  OR NEW.code_hash GLOB '*[^A-Za-z0-9_-]*'
  OR (
    NEW.is_bootstrap=1 AND (
      NEW.recipient_email IS NOT NULL
      OR NEW.max_uses<>1
      OR NEW.used_count<>0
      OR NEW.revoked_at IS NULL
    )
  )
  OR (
    NEW.is_bootstrap=0 AND (
      NEW.recipient_email IS NULL
      OR length(NEW.recipient_email)<3
      OR length(NEW.recipient_email)>254
      OR length(CAST(NEW.recipient_email AS BLOB))
           <>length(NEW.recipient_email)
      OR NEW.recipient_email<>lower(trim(NEW.recipient_email))
      OR instr(NEW.recipient_email,'@')<=1
      OR NEW.max_uses<>1
      OR NEW.used_count<>0
      OR NEW.revoked_at IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT,'invite_code_prebound_single_use_required');
END;

CREATE TRIGGER trg_invite_codes_binding_immutable
BEFORE UPDATE OF
  code_hash,is_bootstrap,created_by_admin_id,max_uses,recipient_email
ON invite_codes
FOR EACH ROW
WHEN
  NEW.code_hash IS NOT OLD.code_hash
  OR NEW.is_bootstrap IS NOT OLD.is_bootstrap
  OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
  OR NEW.max_uses IS NOT OLD.max_uses
  OR NEW.recipient_email IS NOT OLD.recipient_email
BEGIN
  SELECT RAISE(ABORT,'invite_code_binding_is_immutable');
END;

CREATE TRIGGER trg_invite_codes_use_guard
BEFORE UPDATE OF used_count ON invite_codes
FOR EACH ROW
WHEN NEW.used_count IS NOT OLD.used_count AND (
  OLD.recipient_email IS NULL
  OR OLD.is_bootstrap<>0
  OR OLD.max_uses<>1
  OR OLD.used_count<>0
  OR NEW.used_count<>1
  OR OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NOT OLD.revoked_at
)
BEGIN
  SELECT RAISE(ABORT,'invite_code_single_use_violation');
END;

CREATE TRIGGER trg_invite_codes_revocation_monotonic
BEFORE UPDATE OF revoked_at ON invite_codes
FOR EACH ROW
WHEN OLD.revoked_at IS NOT NULL
 AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT,'invite_code_revocation_is_final');
END;

CREATE TRIGGER trg_pending_registrations_prebound_insert
BEFORE INSERT ON pending_registrations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM invite_codes AS i
  WHERE i.id=NEW.invite_code_id
    AND i.is_bootstrap=0
    AND i.recipient_email IS NOT NULL
    AND i.recipient_email=NEW.email
)
BEGIN
  SELECT RAISE(ABORT,'pending_registration_invite_binding_mismatch');
END;

CREATE TRIGGER trg_pending_registrations_binding_immutable
BEFORE UPDATE OF email,invite_code_id ON pending_registrations
FOR EACH ROW
WHEN NEW.email IS NOT OLD.email
  OR NEW.invite_code_id IS NOT OLD.invite_code_id
BEGIN
  SELECT RAISE(ABORT,'pending_registration_binding_is_immutable');
END;

CREATE TRIGGER trg_invite_code_redemptions_single_use_insert
BEFORE INSERT ON invite_code_redemptions
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM invite_code_redemptions
    WHERE invite_code_id=NEW.invite_code_id
  )
  OR NOT EXISTS (
    SELECT 1
    FROM invite_codes AS i
    JOIN users AS u ON u.id=NEW.user_id
    WHERE i.id=NEW.invite_code_id
      AND i.is_bootstrap=0
      AND i.recipient_email IS NOT NULL
      AND i.max_uses=1
      AND i.used_count=1
      AND i.revoked_at IS NULL
      AND i.expires_at>NEW.redeemed_at
      AND u.email=i.recipient_email
      AND u.invited_by_code_id=i.id
  )
BEGIN
  SELECT RAISE(ABORT,'invite_code_redemption_single_use_violation');
END;

CREATE TRIGGER trg_invite_audit_safe_insert
BEFORE INSERT ON audit_log
FOR EACH ROW
WHEN NEW.action GLOB 'invite_code.*' AND (
  NEW.actor<>'system:invite'
  OR NEW.target_ref IS NOT NULL
  OR NEW.invite_code_id IS NULL
  OR NEW.result_class IS NULL
  OR NOT (
    (NEW.action='invite_code.create' AND NEW.result_class='issued')
    OR (
      NEW.action='invite_code.revoke'
      AND NEW.result_class IN ('reissued_revoked','admin_revoked')
    )
    OR (
      NEW.action='invite_code.redeem'
      AND NEW.result_class='redeemed'
    )
  )
  OR NEW.recipient_hmac IS NULL
  OR substr(NEW.recipient_hmac,1,1)<>'v'
  OR instr(NEW.recipient_hmac,'.')<3
  OR substr(
       NEW.recipient_hmac,2,instr(NEW.recipient_hmac,'.')-2
     ) GLOB '*[^0-9]*'
  OR (
    length(substr(
      NEW.recipient_hmac,2,instr(NEW.recipient_hmac,'.')-2
    ))>1
    AND substr(NEW.recipient_hmac,2,1)='0'
  )
  OR length(substr(
       NEW.recipient_hmac,instr(NEW.recipient_hmac,'.')+1
     ))<>43
  OR substr(
       NEW.recipient_hmac,instr(NEW.recipient_hmac,'.')+1
     ) GLOB '*[^A-Za-z0-9_-]*'
)
BEGIN
  SELECT RAISE(ABORT,'invite_audit_payload_is_unsafe');
END;

CREATE TRIGGER trg_invite_audit_immutable
BEFORE UPDATE ON audit_log
FOR EACH ROW
WHEN OLD.action GLOB 'invite_code.*'
BEGIN
  SELECT RAISE(ABORT,'invite_audit_is_immutable');
END;
