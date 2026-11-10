-- New residential purchases only. Historical orders remain NULL: no backfill,
-- no catalog seed/repricing and no change to migrations 027-030.
ALTER TABLE orders ADD COLUMN residential_options_json TEXT
  CHECK (residential_options_json IS NULL OR
    (json_valid(residential_options_json) AND json_type(residential_options_json) = 'object'));
