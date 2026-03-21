-- Phase 3: Add transitional linkage columns to manual_picks.
--
-- These columns connect existing picks to the canonical game/team context model
-- (teams, games, game_lines, team_game_facts). They are convenience fields only;
-- canonical tables remain the source of truth.

-- ============================================================================
-- Linkage columns
-- ============================================================================

ALTER TABLE manual_picks ADD COLUMN game_id TEXT REFERENCES games(id);
ALTER TABLE manual_picks ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE manual_picks ADD COLUMN opponent_id TEXT REFERENCES teams(id);
ALTER TABLE manual_picks ADD COLUMN bet_type TEXT;
ALTER TABLE manual_picks ADD COLUMN sport_tag TEXT;
ALTER TABLE manual_picks ADD COLUMN venue_role TEXT;
ALTER TABLE manual_picks ADD COLUMN fav_dog_role TEXT;
ALTER TABLE manual_picks ADD COLUMN spread_line REAL;
ALTER TABLE manual_picks ADD COLUMN total_line REAL;
ALTER TABLE manual_picks ADD COLUMN actual_margin REAL;
ALTER TABLE manual_picks ADD COLUMN actual_total REAL;

-- ============================================================================
-- Indexes for common query patterns
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_manual_picks_bet_type ON manual_picks(bet_type);
CREATE INDEX IF NOT EXISTS idx_manual_picks_sport_tag ON manual_picks(sport_tag);
CREATE INDEX IF NOT EXISTS idx_manual_picks_venue_role ON manual_picks(venue_role);
CREATE INDEX IF NOT EXISTS idx_manual_picks_fav_dog_role ON manual_picks(fav_dog_role);
CREATE INDEX IF NOT EXISTS idx_manual_picks_stats ON manual_picks(sport_tag, bet_type, status);
CREATE INDEX IF NOT EXISTS idx_manual_picks_game_id ON manual_picks(game_id);
CREATE INDEX IF NOT EXISTS idx_manual_picks_team_id ON manual_picks(team_id);
