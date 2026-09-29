CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN (
      'todo',
      'in_progress',
      'blocked',
      'awaiting_approval',
      'done',
      'cancelled'
    )),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN (
      'low',
      'normal',
      'high',
      'critical'
    )),
  assigned_to TEXT NOT NULL DEFAULT 'Ava',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
