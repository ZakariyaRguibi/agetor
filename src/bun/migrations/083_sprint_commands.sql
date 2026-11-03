CREATE TABLE sprint_commands (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL REFERENCES sprints(id),
  pid INTEGER,
  birth TEXT,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sprint_commands_pending ON sprint_commands(completed);
