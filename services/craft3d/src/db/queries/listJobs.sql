SELECT id, status, error, snapshot_status, snapshot_error, created_at, updated_at
FROM render_jobs
ORDER BY created_at DESC
LIMIT :limit OFFSET :offset;
