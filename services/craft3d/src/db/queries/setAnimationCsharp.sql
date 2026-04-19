UPDATE render_jobs
SET animation_csharp = :animation_csharp
WHERE id = :id
RETURNING id;
