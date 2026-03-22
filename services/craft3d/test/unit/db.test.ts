import fs from "fs";
import path from "path";
import { createDatabase } from "../../src/db/index";

// Use a unique DB name per test run to avoid cross-run interference
const TEST_DB_NAME = `test_db_${process.pid}`;

let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  db = createDatabase(TEST_DB_NAME);
  await db.queries.initialize();
});

afterAll(() => {
  db.close();
  // Clean up test database directory
  const dataDir = path.resolve(__dirname, "../../src/db/data", TEST_DB_NAME);
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Truncate tables between tests (foreign key cascade clears artifacts too)
  db.exec("DELETE FROM render_artifacts");
  db.exec("DELETE FROM render_jobs");
});

// ─── createJob ────────────────────────────────────────────────────────────────

describe("createJob", () => {
  it("creates a job with status=pending and snapshot_status=none", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "job1", snapshot_status: "none", created_at: now });

    const job = await db.queries.getJob({ id: "job1" });
    expect(job).not.toBeNull();
    expect(job!.id).toBe("job1");
    expect(job!.status).toBe("pending");
    expect(job!.snapshot_status).toBe("none");
    expect(job!.error).toBeNull();
    expect(job!.snapshot_error).toBeNull();
    expect(job!.created_at).toBe(now);
  });

  it("creates a job with snapshot_status=pending", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "job2", snapshot_status: "pending", created_at: now });

    const job = await db.queries.getJob({ id: "job2" });
    expect(job!.snapshot_status).toBe("pending");
  });

  it("throws on duplicate id", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "dup", snapshot_status: "none", created_at: now });
    await expect(
      db.queries.createJob({ id: "dup", snapshot_status: "none", created_at: now })
    ).rejects.toThrow();
  });
});

// ─── getJob ───────────────────────────────────────────────────────────────────

describe("getJob", () => {
  it("returns null for a non-existent job", async () => {
    const job = await db.queries.getJob({ id: "nonexistent" });
    expect(job).toBeNull();
  });

  it("returns the correct job row for an existing job", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job).toMatchObject({ id: "j1", status: "pending" });
  });
});

// ─── updateJobStatus ──────────────────────────────────────────────────────────

describe("updateJobStatus", () => {
  it("updates status to processing", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const updated = await db.queries.updateJobStatus({ id: "j1", status: "processing" });
    expect(updated).toBe(true);
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.status).toBe("processing");
  });

  it("updates status to completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.status).toBe("completed");
    expect(job!.error).toBeNull();
  });

  it("updates status to failed with error message", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "failed", error: "render error" });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("render error");
  });

  it("returns false for a non-existent job", async () => {
    const updated = await db.queries.updateJobStatus({ id: "nope", status: "failed" });
    expect(updated).toBe(false);
  });
});

// ─── updateSnapshotStatus ─────────────────────────────────────────────────────

describe("updateSnapshotStatus", () => {
  it("updates snapshot_status to processing", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "processing" });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.snapshot_status).toBe("processing");
  });

  it("updates snapshot_status to completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "completed" });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.snapshot_status).toBe("completed");
    expect(job!.snapshot_error).toBeNull();
  });

  it("updates snapshot_status to failed with error", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateSnapshotStatus({
      id: "j1",
      snapshot_status: "failed",
      snapshot_error: "snapshot render failed",
    });
    const job = await db.queries.getJob({ id: "j1" });
    expect(job!.snapshot_status).toBe("failed");
    expect(job!.snapshot_error).toBe("snapshot render failed");
  });

  it("returns false for non-existent job", async () => {
    const result = await db.queries.updateSnapshotStatus({
      id: "nope",
      snapshot_status: "completed",
    });
    expect(result).toBe(false);
  });
});

// ─── saveArtifact / getArtifact ───────────────────────────────────────────────

describe("saveArtifact and getArtifact", () => {
  it("saves and retrieves a text artifact (input_code)", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });

    await db.queries.saveArtifact({
      job_id: "j1",
      role: "input_code",
      mime_type: "text/plain",
      text_content: "const x = 1;",
      created_at: now,
    });

    const artifact = await db.queries.getArtifact({ job_id: "j1", role: "input_code" });
    expect(artifact).not.toBeNull();
    expect(artifact!.text_content).toBe("const x = 1;");
    expect(artifact!.mime_type).toBe("text/plain");
    expect(artifact!.blob_content).toBeNull();
  });

  it("saves and retrieves a binary artifact (output_glb)", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const glbData = Buffer.from("GLB_BINARY_DATA");

    await db.queries.saveArtifact({
      job_id: "j1",
      role: "output_glb",
      mime_type: "model/gltf-binary",
      blob_content: glbData,
      created_at: now,
    });

    const artifact = await db.queries.getArtifact({ job_id: "j1", role: "output_glb" });
    expect(artifact).not.toBeNull();
    expect(artifact!.blob_content).toEqual(glbData);
    expect(artifact!.text_content).toBeNull();
  });

  it("upserts artifact on conflict (same job_id + role)", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });

    await db.queries.saveArtifact({
      job_id: "j1",
      role: "input_code",
      mime_type: "text/plain",
      text_content: "original code",
      created_at: now,
    });

    await db.queries.saveArtifact({
      job_id: "j1",
      role: "input_code",
      mime_type: "text/plain",
      text_content: "updated code",
      created_at: now,
    });

    const artifact = await db.queries.getArtifact({ job_id: "j1", role: "input_code" });
    expect(artifact!.text_content).toBe("updated code");
  });

  it("returns null for a non-existent artifact", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const artifact = await db.queries.getArtifact({ job_id: "j1", role: "output_glb" });
    expect(artifact).toBeNull();
  });
});

// ─── deleteJob ────────────────────────────────────────────────────────────────

describe("deleteJob", () => {
  it("deletes an existing job and returns true", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const deleted = await db.queries.deleteJob({ id: "j1" });
    expect(deleted).toBe(true);
    expect(await db.queries.getJob({ id: "j1" })).toBeNull();
  });

  it("cascades delete to associated artifacts", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.saveArtifact({
      job_id: "j1",
      role: "input_code",
      mime_type: "text/plain",
      text_content: "code",
      created_at: now,
    });

    await db.queries.deleteJob({ id: "j1" });
    const artifact = await db.queries.getArtifact({ job_id: "j1", role: "input_code" });
    expect(artifact).toBeNull();
  });

  it("returns false for a non-existent job", async () => {
    const deleted = await db.queries.deleteJob({ id: "nope" });
    expect(deleted).toBe(false);
  });
});

// ─── listJobs ─────────────────────────────────────────────────────────────────

describe("listJobs", () => {
  it("returns an empty array when no jobs exist", async () => {
    const jobs = await db.queries.listJobs({});
    expect(jobs).toEqual([]);
  });

  it("returns jobs ordered by created_at DESC", async () => {
    await db.queries.createJob({ id: "old", snapshot_status: "none", created_at: 1000 });
    await db.queries.createJob({ id: "new", snapshot_status: "none", created_at: 2000 });

    const jobs = await db.queries.listJobs({});
    expect(jobs[0].id).toBe("new");
    expect(jobs[1].id).toBe("old");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await db.queries.createJob({ id: `j${i}`, snapshot_status: "none", created_at: i });
    }
    const jobs = await db.queries.listJobs({ limit: 2 });
    expect(jobs.length).toBe(2);
  });

  it("respects offset parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await db.queries.createJob({ id: `j${i}`, snapshot_status: "none", created_at: i * 1000 });
    }
    const allJobs = await db.queries.listJobs({});
    const pagedJobs = await db.queries.listJobs({ limit: 3, offset: 2 });
    expect(pagedJobs[0].id).toBe(allJobs[2].id);
  });

  it("defaults to limit=20, offset=0", async () => {
    for (let i = 0; i < 25; i++) {
      await db.queries.createJob({ id: `j${i}`, snapshot_status: "none", created_at: i });
    }
    const jobs = await db.queries.listJobs({});
    expect(jobs.length).toBe(20);
  });
});
