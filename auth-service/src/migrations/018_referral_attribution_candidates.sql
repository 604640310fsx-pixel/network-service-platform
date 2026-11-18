ALTER TABLE pending_registrations
ADD COLUMN referral_source_profile_id INTEGER
  REFERENCES referral_profiles(id) ON DELETE RESTRICT;

CREATE TABLE referral_attribution_candidates (
  referred_user_id INTEGER PRIMARY KEY
    REFERENCES users(id) ON DELETE RESTRICT,
  source_profile_id INTEGER NOT NULL
    REFERENCES referral_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status = 'pending'),
  created_at TEXT NOT NULL
);

CREATE TRIGGER trg_referral_attribution_candidates_reject_self
BEFORE INSERT ON referral_attribution_candidates
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM referral_profiles
  WHERE id = NEW.source_profile_id
    AND user_id = NEW.referred_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'referral_candidate_self_attribution');
END;
