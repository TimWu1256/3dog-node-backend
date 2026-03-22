INSERT INTO render_jobs (id, status, snapshot_status, created_at, updated_at)
VALUES (:id, 'pending', :snapshot_status, :created_at, :created_at);
