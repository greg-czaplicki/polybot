-- Trend context for shadow candidates: the canonical trend features
-- (fav/dog role, venue, streaks, ATS/OU records, canonical score) computed
-- at grade time, so shadow performance can be sliced by trend dimensions
-- the same way real picks are. NULL for rows recorded before 2026-07-31
-- and for rows where canonical scoring is unavailable (unseeded teams,
-- prop/other markets).
ALTER TABLE shadow_candidates ADD COLUMN trend_context_json TEXT;
