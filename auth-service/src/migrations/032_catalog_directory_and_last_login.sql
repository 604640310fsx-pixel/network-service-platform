-- Preserve current purchase behavior for every configured plan tuple, including
-- plans individually stopped or sold out. Missing future keys remain unavailable.
CREATE TABLE sellable_regions (
  type_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  is_active INTEGER NOT NULL CHECK(is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (type_id, region_id)
);

CREATE TABLE sellable_operators (
  type_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  isp_id TEXT NOT NULL,
  is_active INTEGER NOT NULL CHECK(is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (type_id, region_id, isp_id),
  FOREIGN KEY (type_id, region_id) REFERENCES sellable_regions(type_id, region_id) ON DELETE RESTRICT
);

INSERT INTO sellable_regions (type_id, region_id, is_active, updated_at)
SELECT type_id, region_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sellable_plans GROUP BY type_id, region_id;

INSERT INTO sellable_operators (type_id, region_id, isp_id, is_active, updated_at)
SELECT type_id, region_id, isp_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sellable_plans GROUP BY type_id, region_id, isp_id;

ALTER TABLE users ADD COLUMN last_successful_web_login_at TEXT;
