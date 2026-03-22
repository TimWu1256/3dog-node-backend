UPDATE render_jobs
SET status = :status, error = :error, updated_at = updated_at
WHERE id = :id
RETURNING id;
