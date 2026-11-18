-- Customer support tickets (MVP). Adds new tables only; existing data and
-- semantics are unchanged. Owner is always the session user; the optional
-- service link must belong to that owner (enforced by the application).
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  ticket_ref TEXT NOT NULL UNIQUE CHECK (
    length(ticket_ref) = 18 AND
    ticket_ref GLOB 'TK[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'
  ),

  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  service_id INTEGER REFERENCES services(id) ON DELETE RESTRICT,

  subject TEXT NOT NULL CHECK (
    length(subject) BETWEEN 1 AND 120
  ),

  status TEXT NOT NULL CHECK (
    status IN ('open', 'answered', 'closed')
  ),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  closed_at TEXT,
  closed_by_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,

  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_by_admin_id IS NOT NULL))
);

CREATE INDEX idx_tickets_owner_updated
  ON tickets (user_id, updated_at DESC, id DESC);

CREATE INDEX idx_tickets_status_updated
  ON tickets (status, updated_at DESC, id DESC);

CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,

  author_role TEXT NOT NULL CHECK (
    author_role IN ('customer', 'admin')
  ),

  author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  body TEXT NOT NULL CHECK (
    length(body) BETWEEN 1 AND 4000
  ),

  created_at TEXT NOT NULL
);

CREATE INDEX idx_ticket_messages_ticket
  ON ticket_messages (ticket_id, id);
