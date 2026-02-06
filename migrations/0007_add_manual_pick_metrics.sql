-- Add pricing and resolution metrics to manual picks.

ALTER TABLE manual_picks ADD COLUMN confidence TEXT;
ALTER TABLE manual_picks ADD COLUMN fair_price REAL;
ALTER TABLE manual_picks ADD COLUMN price_edge REAL;
ALTER TABLE manual_picks ADD COLUMN resolved_outcome TEXT;
ALTER TABLE manual_picks ADD COLUMN close_price REAL;
ALTER TABLE manual_picks ADD COLUMN roi REAL;
ALTER TABLE manual_picks ADD COLUMN clv REAL;
