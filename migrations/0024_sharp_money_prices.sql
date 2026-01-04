-- Add price fields for each side (0-1 from CLOB) to sharp_money_cache

ALTER TABLE sharp_money_cache ADD COLUMN side_a_price REAL;
ALTER TABLE sharp_money_cache ADD COLUMN side_b_price REAL;
