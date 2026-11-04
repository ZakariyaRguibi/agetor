CREATE TABLE sprint_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  sprint_id TEXT NOT NULL REFERENCES sprints(id),
  purpose TEXT NOT NULL
);
CREATE INDEX sprint_tasks_sprint ON sprint_tasks(sprint_id);
