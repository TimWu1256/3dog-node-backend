PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  -- Code execution status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  error TEXT,
  -- Snapshot rendering status (tracked independently)
  snapshot_status TEXT NOT NULL DEFAULT 'none'
    CHECK(snapshot_status IN ('none', 'pending', 'processing', 'completed', 'failed')),
  snapshot_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS render_jobs_updated_at
  AFTER UPDATE ON render_jobs FOR EACH ROW
  WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE render_jobs SET updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER) WHERE id = NEW.id;
END;

-- Roles: 'input_code' | 'output_glb' | 'output_snapshot'
CREATE TABLE IF NOT EXISTS render_artifacts (
  job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('input_code', 'output_glb', 'output_snapshot')),
  mime_type TEXT NOT NULL,
  text_content TEXT,   -- for input_code
  blob_content BLOB,   -- for output_glb, output_snapshot
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, role)
);
