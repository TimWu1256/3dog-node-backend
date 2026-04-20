-- Move animation_csharp out of render_jobs and into render_artifacts as output_csharp role.
-- Migrate any existing data, then drop the stale column.

-- Recreate render_artifacts with output_csharp added to the role CHECK constraint.
CREATE TABLE render_artifacts_new (
  job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('input_code', 'output_glb', 'output_snapshot', 'output_csharp')),
  mime_type TEXT NOT NULL,
  text_content TEXT,
  blob_content BLOB,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, role)
);

INSERT INTO render_artifacts_new SELECT * FROM render_artifacts;

DROP TABLE render_artifacts;
ALTER TABLE render_artifacts_new RENAME TO render_artifacts;

-- Migrate existing animation_csharp values into the new artifact table.
INSERT INTO render_artifacts (job_id, role, mime_type, text_content, created_at)
SELECT id, 'output_csharp', 'text/plain', animation_csharp, updated_at
FROM render_jobs
WHERE animation_csharp IS NOT NULL;

-- Drop the stale column (requires SQLite 3.35+).
ALTER TABLE render_jobs DROP COLUMN animation_csharp;
