INSERT INTO render_artifacts (job_id, role, mime_type, text_content, blob_content, created_at)
VALUES (:job_id, :role, :mime_type, :text_content, :blob_content, :created_at)
ON CONFLICT(job_id, role) DO UPDATE SET
  mime_type = excluded.mime_type,
  text_content = excluded.text_content,
  blob_content = excluded.blob_content;
