-- Grade-time warnings (e.g. low_conviction, stale_data) on shadow rows so
-- warning-based filters are auditable alongside gate rejects.
ALTER TABLE shadow_candidates ADD COLUMN warnings_json TEXT;
