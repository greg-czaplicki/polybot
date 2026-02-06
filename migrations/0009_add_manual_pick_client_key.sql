-- Add external idempotency key for bot pick lifecycle updates.

ALTER TABLE manual_picks ADD COLUMN client_pick_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_picks_client_pick_id
ON manual_picks(client_pick_id)
WHERE client_pick_id IS NOT NULL;
