SELECT job_id, role, mime_type, text_content, blob_content, created_at
FROM render_artifacts
WHERE job_id = :job_id AND role = :role;
