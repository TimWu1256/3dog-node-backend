UPDATE render_jobs
SET snapshot_status = :snapshot_status, snapshot_error = :snapshot_error, updated_at = updated_at
WHERE id = :id
RETURNING id;
