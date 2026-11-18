-- Ticket image attachments and mutually exclusive grant linkage. Additive:
-- attachment bytes live in this SQLite database only (no filesystem, no
-- external storage) and are covered by the existing SQLite backup. Existing
-- ticket, message, service, and grant rows keep every prior value.
CREATE TABLE ticket_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  attachment_ref TEXT NOT NULL UNIQUE CHECK (
    length(attachment_ref) = 18 AND
    attachment_ref GLOB 'TA[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'
  ),

  message_id INTEGER NOT NULL REFERENCES ticket_messages(id) ON DELETE RESTRICT,

  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),

  byte_size INTEGER NOT NULL CHECK (
    byte_size > 0 AND byte_size <= 5242880
  ),

  content BLOB NOT NULL CHECK (
    length(content) = byte_size
  ),

  created_at TEXT NOT NULL
);

CREATE INDEX idx_ticket_attachments_message
  ON ticket_attachments (message_id, id);

ALTER TABLE tickets ADD COLUMN grant_id INTEGER
  REFERENCES admin_grants(id) ON DELETE RESTRICT
  CHECK (service_id IS NULL OR grant_id IS NULL);

CREATE INDEX idx_tickets_grant
  ON tickets (grant_id) WHERE grant_id IS NOT NULL;
