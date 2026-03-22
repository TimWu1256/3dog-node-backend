DELETE FROM render_jobs
WHERE id = :id
RETURNING id;
