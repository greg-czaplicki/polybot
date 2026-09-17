-- Era v14 (2026-09-17): a second live signal family. `lane` names the
-- pre-registered rule that produced the pick (e.g. 'cs2_pickem_dog');
-- NULL = the holder-signal book. Live-book reads filter `lane IS NULL`.
ALTER TABLE manual_picks ADD COLUMN lane TEXT;
CREATE INDEX manual_picks_lane ON manual_picks(lane, picked_at);
