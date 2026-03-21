-- Canonical entities for team/game/trend analytics (Phase 2).
-- Introduces teams, games, game_lines, team_game_facts, and team_trend_snapshots
-- to support SU/ATS/OU records, home/away and favorite/dog splits, streaks, and
-- precomputed rolling trend windows.

-- ============================================================================
-- TEAMS — stable team identity with alias normalization
-- ============================================================================

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  abbreviation TEXT,
  sport_tag TEXT NOT NULL,
  aliases_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_teams_sport_tag ON teams(sport_tag);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_sport ON teams(name, sport_tag);

-- ============================================================================
-- GAMES — schedule, participants, venue, final score, season context
-- ============================================================================

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  sport_tag TEXT NOT NULL,
  season TEXT,
  season_type TEXT,
  week TEXT,
  game_time INTEGER,
  home_team_id TEXT REFERENCES teams(id),
  away_team_id TEXT REFERENCES teams(id),
  neutral_site INTEGER NOT NULL DEFAULT 0,
  home_score INTEGER,
  away_score INTEGER,
  total_score INTEGER,
  is_final INTEGER NOT NULL DEFAULT 0,
  went_to_ot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_games_sport_season ON games(sport_tag, season);
CREATE INDEX IF NOT EXISTS idx_games_game_time ON games(game_time);
CREATE INDEX IF NOT EXISTS idx_games_home_team ON games(home_team_id);
CREATE INDEX IF NOT EXISTS idx_games_away_team ON games(away_team_id);

-- ============================================================================
-- GAME_LINES — pregame and closing spread / total / moneyline snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS game_lines (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  source TEXT NOT NULL DEFAULT 'consensus',
  snapshot_type TEXT NOT NULL,
  home_spread REAL,
  away_spread REAL,
  total_line REAL,
  home_moneyline REAL,
  away_moneyline REAL,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_game_lines_game ON game_lines(game_id, snapshot_type);

-- ============================================================================
-- TEAM_GAME_FACTS — per-team SU/ATS/OU results and contextual flags per game
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_game_facts (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  opponent_id TEXT NOT NULL REFERENCES teams(id),
  venue_role TEXT NOT NULL,
  fav_dog_role TEXT,
  team_score INTEGER,
  opponent_score INTEGER,
  actual_margin INTEGER,
  su_result TEXT,
  spread_line REAL,
  cover_margin REAL,
  ats_result TEXT,
  total_line REAL,
  actual_total INTEGER,
  ou_result TEXT,
  game_time INTEGER NOT NULL,
  sport_tag TEXT NOT NULL,
  season TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Primary query: "team X last N games" — ordered by game_time DESC
CREATE INDEX IF NOT EXISTS idx_tgf_team ON team_game_facts(team_id, game_time DESC);

-- Split queries: "team X last N as home/away" and "team X last N as favorite/dog"
CREATE INDEX IF NOT EXISTS idx_tgf_team_venue ON team_game_facts(team_id, venue_role, game_time DESC);
CREATE INDEX IF NOT EXISTS idx_tgf_team_favdog ON team_game_facts(team_id, fav_dog_role, game_time DESC);

-- Sport filtering: "team X last N in NFL"
CREATE INDEX IF NOT EXISTS idx_tgf_team_sport ON team_game_facts(team_id, sport_tag, game_time DESC);

-- Join back to game: used when enriching game detail views
CREATE INDEX IF NOT EXISTS idx_tgf_game ON team_game_facts(game_id);

-- ============================================================================
-- TEAM_TREND_SNAPSHOTS — precomputed rolling splits (e.g., last 10 away dog ATS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_trend_snapshots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  as_of_game_id TEXT NOT NULL REFERENCES games(id),
  as_of_time INTEGER NOT NULL,
  sport_tag TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  window_size INTEGER NOT NULL DEFAULT 10,
  su_wins INTEGER NOT NULL DEFAULT 0,
  su_losses INTEGER NOT NULL DEFAULT 0,
  su_pushes INTEGER NOT NULL DEFAULT 0,
  su_win_pct REAL,
  ats_wins INTEGER NOT NULL DEFAULT 0,
  ats_losses INTEGER NOT NULL DEFAULT 0,
  ats_pushes INTEGER NOT NULL DEFAULT 0,
  ats_win_pct REAL,
  ou_overs INTEGER NOT NULL DEFAULT 0,
  ou_unders INTEGER NOT NULL DEFAULT 0,
  ou_pushes INTEGER NOT NULL DEFAULT 0,
  ou_over_pct REAL,
  ats_streak_type TEXT,
  ats_streak_length INTEGER DEFAULT 0,
  ou_streak_type TEXT,
  ou_streak_length INTEGER DEFAULT 0,
  su_streak_type TEXT,
  su_streak_length INTEGER DEFAULT 0,
  avg_cover_margin REAL,
  avg_total_margin REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Primary query: "team X latest snapshot of type Y"
CREATE INDEX IF NOT EXISTS idx_tts_team_type ON team_trend_snapshots(team_id, snapshot_type, as_of_time DESC);

-- Join to specific game: "what was team X's trend when game Y happened?"
CREATE INDEX IF NOT EXISTS idx_tts_team_game ON team_trend_snapshots(team_id, as_of_game_id);

-- League-wide queries: "all teams' home ATS last 10, ordered by recency"
CREATE INDEX IF NOT EXISTS idx_tts_sport ON team_trend_snapshots(sport_tag, snapshot_type, as_of_time DESC);
