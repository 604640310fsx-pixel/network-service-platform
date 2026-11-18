ALTER TABLE service_delivery_items
ADD COLUMN monitor_target_key TEXT
  CHECK (
    monitor_target_key IS NULL OR (
      length(monitor_target_key) BETWEEN 1 AND 128
      AND monitor_target_key = trim(monitor_target_key)
    )
  );
