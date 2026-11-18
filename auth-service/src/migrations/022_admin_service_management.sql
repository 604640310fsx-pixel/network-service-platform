ALTER TABLE services ADD COLUMN ends_at TEXT;            -- 到期时间，NULL=长期
ALTER TABLE services ADD COLUMN plan_override TEXT;      -- 管理员改的套餐展示快照(JSON)，NULL=用订单快照
ALTER TABLE services ADD COLUMN admin_note TEXT;         -- 管理备注（仅管理员可见），可选

CREATE TABLE admin_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  granted_by_admin_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,                                   -- 买家可见套餐名
  starts_at TEXT NOT NULL,
  ends_at TEXT,                                          -- NULL=长期
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  reason TEXT,                                           -- 内部原因，买家不可见
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_admin_grants_user ON admin_grants(user_id);
