CREATE INDEX idx_referral_candidate_owner_page
ON referral_attribution_candidates (
  source_profile_id,
  status,
  created_at DESC,
  referred_user_id DESC
);
