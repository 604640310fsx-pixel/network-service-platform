CREATE TABLE diagnosis_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  contact_type TEXT NOT NULL CHECK (
    contact_type IN ('wechat', 'telegram', 'email', 'other')
  ),

  contact_value TEXT NOT NULL CHECK (
    length(contact_value) BETWEEN 1 AND 200
  ),

  business_scenario TEXT NOT NULL CHECK (
    business_scenario IN (
      'tiktok_content',
      'live_streaming',
      'social_media',
      'ai_development',
      'cross_border_ecommerce',
      'other',
      'unsure'
    )
  ),

  target_region TEXT NOT NULL CHECK (
    length(target_region) BETWEEN 1 AND 80
  ),

  problem_types TEXT NOT NULL CHECK (
    length(problem_types) BETWEEN 2 AND 512
  ),

  problem_description TEXT NOT NULL CHECK (
    length(problem_description) BETWEEN 10 AND 2000
  ),

  safety_ack INTEGER NOT NULL CHECK (
    safety_ack = 1
  ),

  current_region TEXT CHECK (
    current_region IS NULL OR
    length(current_region) BETWEEN 1 AND 80
  ),

  current_isp TEXT CHECK (
    current_isp IS NULL OR
    length(current_isp) BETWEEN 1 AND 120
  ),

  current_network_type TEXT CHECK (
    current_network_type IS NULL OR
    current_network_type IN (
      'home_broadband',
      'enterprise_network',
      'vps_server',
      'proxy_network',
      'unknown',
      'other'
    )
  ),

  problem_frequency TEXT CHECK (
    problem_frequency IS NULL OR
    problem_frequency IN (
      'one_time',
      'intermittent',
      'frequent',
      'continuous',
      'unknown'
    )
  ),

  is_existing_customer INTEGER CHECK (
    is_existing_customer IS NULL OR
    is_existing_customer IN (0, 1)
  ),

  preferred_contact_window TEXT CHECK (
    preferred_contact_window IS NULL OR
    length(preferred_contact_window) BETWEEN 1 AND 80
  ),

  extra_notes TEXT CHECK (
    extra_notes IS NULL OR
    length(extra_notes) BETWEEN 1 AND 1000
  ),

  status TEXT NOT NULL CHECK (
    status IN ('new', 'handled')
  ),

  classification TEXT CHECK (
    classification IS NULL OR
    classification IN (
      'continue_as_is',
      'local_optimization',
      'need_more_info',
      'formal_diagnosis',
      'network_plan',
      'out_of_scope'
    )
  ),

  admin_note TEXT CHECK (
    admin_note IS NULL OR
    length(admin_note) <= 500
  ),

  handled_by_admin_id INTEGER
    REFERENCES users(id)
    ON DELETE RESTRICT,

  handled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (
    (
      status = 'new'
      AND classification IS NULL
      AND admin_note IS NULL
      AND handled_by_admin_id IS NULL
      AND handled_at IS NULL
    )
    OR
    (
      status = 'handled'
      AND classification IS NOT NULL
      AND handled_by_admin_id IS NOT NULL
      AND handled_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_diagnosis_requests_status_created
  ON diagnosis_requests(status, created_at, id);
