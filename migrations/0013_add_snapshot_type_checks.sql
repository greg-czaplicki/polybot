-- Phase 2.1: Constrain snapshot_type values in game_lines and team_trend_snapshots.
--
-- SQLite does not support ALTER TABLE ADD CHECK, so we use BEFORE INSERT/UPDATE
-- triggers to enforce the allowed values. These act as runtime CHECK constraints.
--
-- Canonical values:
--   game_lines.snapshot_type:          'open', 'close'
--   team_trend_snapshots.snapshot_type: 'overall', 'home', 'away', 'favorite', 'dog',
--                                       'home_favorite', 'home_dog', 'away_favorite', 'away_dog'

-- ============================================================================
-- game_lines.snapshot_type validation
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_game_lines_snapshot_type_insert
BEFORE INSERT ON game_lines
WHEN NEW.snapshot_type NOT IN ('open', 'close')
BEGIN
  SELECT RAISE(ABORT, 'game_lines.snapshot_type must be open or close');
END;

CREATE TRIGGER IF NOT EXISTS trg_game_lines_snapshot_type_update
BEFORE UPDATE OF snapshot_type ON game_lines
WHEN NEW.snapshot_type NOT IN ('open', 'close')
BEGIN
  SELECT RAISE(ABORT, 'game_lines.snapshot_type must be open or close');
END;

-- ============================================================================
-- team_trend_snapshots.snapshot_type validation
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_tts_snapshot_type_insert
BEFORE INSERT ON team_trend_snapshots
WHEN NEW.snapshot_type NOT IN (
  'overall', 'home', 'away', 'favorite', 'dog',
  'home_favorite', 'home_dog', 'away_favorite', 'away_dog'
)
BEGIN
  SELECT RAISE(ABORT, 'team_trend_snapshots.snapshot_type must be one of: overall, home, away, favorite, dog, home_favorite, home_dog, away_favorite, away_dog');
END;

CREATE TRIGGER IF NOT EXISTS trg_tts_snapshot_type_update
BEFORE UPDATE OF snapshot_type ON team_trend_snapshots
WHEN NEW.snapshot_type NOT IN (
  'overall', 'home', 'away', 'favorite', 'dog',
  'home_favorite', 'home_dog', 'away_favorite', 'away_dog'
)
BEGIN
  SELECT RAISE(ABORT, 'team_trend_snapshots.snapshot_type must be one of: overall, home, away, favorite, dog, home_favorite, home_dog, away_favorite, away_dog');
END;
