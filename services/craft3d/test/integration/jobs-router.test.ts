/**
 * Integration tests for the jobs router.
 *
 * Uses a real SQLite test database but mocks the renderer so no browser is
 * required.  Each test suite shares a single DB instance; tables are truncated
 * between tests.
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { createDatabase } from "../../src/db/index";
import { jobsRouter } from "../../src/routers/jobs";

// ─── Mock renderer ────────────────────────────────────────────────────────────

// NOTE: jest.mock() is hoisted, so constants cannot be referenced inside the
// factory. Define sentinel values as module-scope lets and assign in beforeAll.
const FAKE_GLB = Buffer.from("FAKE_GLB_BINARY");
const FAKE_PNG = Buffer.from("FAKE_PNG_BINARY");

jest.mock("../../src/renderer/execute-code", () => ({
  executeCodeToGlb: jest.fn().mockResolvedValue({
    glb: Buffer.from("FAKE_GLB_BINARY"),
    logs: [],
  }),
}));

jest.mock("../../src/renderer/render-snapshots", () => ({
  renderGlbToSnapshotGrid: jest.fn().mockResolvedValue(Buffer.from("FAKE_PNG_BINARY")),
}));

// ─── DB + App setup ───────────────────────────────────────────────────────────

const TEST_DB_NAME = `test_router_${process.pid}`;
let db: ReturnType<typeof createDatabase>;
let app: Hono;

beforeAll(async () => {
  db = createDatabase(TEST_DB_NAME);
  await db.queries.initialize();

  app = new Hono();
  app.route("/jobs", jobsRouter(db));
});

afterAll(() => {
  db.close();
  const dataDir = path.resolve(__dirname, "../../src/db/data", TEST_DB_NAME);
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  db.exec("DELETE FROM render_artifacts");
  db.exec("DELETE FROM render_jobs");
  jest.clearAllMocks();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function waitForJob(id: string, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.request(`/jobs/${id}`);
    const job = await res.json();
    const jobDone = job.status === "completed" || job.status === "failed";
    const snapDone =
      job.snapshot_status === "none" ||
      job.snapshot_status === "completed" ||
      job.snapshot_status === "failed";
    if (jobDone && snapDone) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${id} did not reach terminal state within ${timeoutMs}ms`);
}

// ─── POST /jobs ───────────────────────────────────────────────────────────────

describe("POST /jobs", () => {
  it("returns 202 with a valid job object", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;", snapshots: false }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBeDefined();
    // The background processor may have already advanced the status
    expect(["pending", "processing", "completed"]).toContain(body.status);
    expect(body.snapshot_status).toBe("none");
  });

  it("defaults snapshots to true when not provided", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.snapshot_status).toBe("pending");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when code field is missing", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: false }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when code is empty string", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("processes job successfully and saves GLB artifact", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;", snapshots: false }),
    });
    const { id } = await res.json();
    const job = await waitForJob(id);

    expect(job.status).toBe("completed");
    expect(job.snapshot_status).toBe("none");

    const glbArtifact = await db.queries.getArtifact({ job_id: id, role: "output_glb" });
    expect(glbArtifact).not.toBeNull();
    expect(glbArtifact!.blob_content).toEqual(FAKE_GLB);
  });

  it("processes job with snapshot when snapshots=true", async () => {
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;", snapshots: true }),
    });
    const { id } = await res.json();
    const job = await waitForJob(id);

    expect(job.status).toBe("completed");
    expect(job.snapshot_status).toBe("completed");

    const snapArtifact = await db.queries.getArtifact({ job_id: id, role: "output_snapshot" });
    expect(snapArtifact).not.toBeNull();
    expect(snapArtifact!.blob_content).toEqual(FAKE_PNG);
  });
});

// ─── GET /jobs ────────────────────────────────────────────────────────────────

describe("GET /jobs", () => {
  it("returns empty list when no jobs exist", async () => {
    const res = await app.request("/jobs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toEqual([]);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it("lists created jobs", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "a", snapshot_status: "none", created_at: now });
    await db.queries.createJob({ id: "b", snapshot_status: "none", created_at: now + 1 });

    const res = await app.request("/jobs");
    const body = await res.json();
    expect(body.jobs.length).toBe(2);
  });

  it("respects limit query param (max 100)", async () => {
    for (let i = 0; i < 5; i++) {
      await db.queries.createJob({ id: `j${i}`, snapshot_status: "none", created_at: i });
    }

    const res = await app.request("/jobs?limit=2");
    const body = await res.json();
    expect(body.jobs.length).toBe(2);
    expect(body.limit).toBe(2);
  });

  it("respects offset query param", async () => {
    for (let i = 0; i < 5; i++) {
      await db.queries.createJob({ id: `j${i}`, snapshot_status: "none", created_at: i * 1000 });
    }

    const all = await app.request("/jobs");
    const allBody = await all.json();

    const paged = await app.request("/jobs?offset=2&limit=10");
    const pagedBody = await paged.json();

    expect(pagedBody.jobs[0].id).toBe(allBody.jobs[2].id);
  });

  it("clamps limit to 100", async () => {
    const res = await app.request("/jobs?limit=999");
    const body = await res.json();
    expect(body.limit).toBe(100);
  });
});

// ─── GET /jobs/:id ────────────────────────────────────────────────────────────

describe("GET /jobs/:id", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns the job row for a known id", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "myj", snapshot_status: "none", created_at: now });

    const res = await app.request("/jobs/myj");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("myj");
    expect(body.status).toBe("pending");
  });
});

// ─── GET /jobs/:id/glb ────────────────────────────────────────────────────────

describe("GET /jobs/:id/glb", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nope/glb");
    expect(res.status).toBe(404);
  });

  it("returns 409 when job is not completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const res = await app.request("/jobs/j1/glb");
    expect(res.status).toBe(409);
  });

  it("returns GLB binary when job is completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    await db.queries.saveArtifact({
      job_id: "j1",
      role: "output_glb",
      mime_type: "model/gltf-binary",
      blob_content: FAKE_GLB,
      created_at: now,
    });

    const res = await app.request("/jobs/j1/glb");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf).toEqual(FAKE_GLB);
  });
});

// ─── GET /jobs/:id/snapshot ───────────────────────────────────────────────────

describe("GET /jobs/:id/snapshot", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nope/snapshot");
    expect(res.status).toBe(404);
  });

  it("returns 404 when snapshot_status=none", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const res = await app.request("/jobs/j1/snapshot");
    expect(res.status).toBe(404);
  });

  it("returns 409 when snapshot is pending", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    const res = await app.request("/jobs/j1/snapshot");
    expect(res.status).toBe(409);
  });

  it("returns PNG binary when snapshot is completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "completed" });
    await db.queries.saveArtifact({
      job_id: "j1",
      role: "output_snapshot",
      mime_type: "image/png",
      blob_content: FAKE_PNG,
      created_at: now,
    });

    const res = await app.request("/jobs/j1/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf).toEqual(FAKE_PNG);
  });
});

// ─── POST /jobs/:id/snapshot ──────────────────────────────────────────────────

describe("POST /jobs/:id/snapshot", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nope/snapshot", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when job is not completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    const res = await app.request("/jobs/j1/snapshot", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when snapshot is already completed", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "completed" });

    const res = await app.request("/jobs/j1/snapshot", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when snapshot is already in progress", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "pending", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "processing" });

    const res = await app.request("/jobs/j1/snapshot", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("triggers snapshot for completed job with snapshot_status=none", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    await db.queries.saveArtifact({
      job_id: "j1",
      role: "output_glb",
      mime_type: "model/gltf-binary",
      blob_content: FAKE_GLB,
      created_at: now,
    });

    const res = await app.request("/jobs/j1/snapshot", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    // Background processor may have advanced to processing/completed already
    expect(["pending", "processing", "completed"]).toContain(body.snapshot_status);

    // Wait for snapshot processing to complete
    const job = await waitForJob("j1");
    expect(job.snapshot_status).toBe("completed");
  });

  it("allows retry after snapshot failure", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });
    await db.queries.updateSnapshotStatus({ id: "j1", snapshot_status: "failed" });
    await db.queries.saveArtifact({
      job_id: "j1",
      role: "output_glb",
      mime_type: "model/gltf-binary",
      blob_content: FAKE_GLB,
      created_at: now,
    });

    const res = await app.request("/jobs/j1/snapshot", { method: "POST" });
    expect(res.status).toBe(202);
  });
});

// ─── DELETE /jobs/:id ─────────────────────────────────────────────────────────

describe("DELETE /jobs/:id", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes an existing job", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });

    const res = await app.request("/jobs/j1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    // Job should be gone
    const check = await app.request("/jobs/j1");
    expect(check.status).toBe(404);
  });
});

// ─── GET /jobs/:id/wait ───────────────────────────────────────────────────────

describe("GET /jobs/:id/wait", () => {
  it("returns 404 for unknown job", async () => {
    const res = await app.request("/jobs/nope/wait?timeout_sec=1");
    expect(res.status).toBe(404);
  });

  it("returns 200 immediately when job is already in terminal state", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    await db.queries.updateJobStatus({ id: "j1", status: "completed" });

    const res = await app.request("/jobs/j1/wait?timeout_sec=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
  });

  it("returns 202 when job does not finish within timeout", async () => {
    const now = Date.now();
    await db.queries.createJob({ id: "j1", snapshot_status: "none", created_at: now });
    // Job stays in pending state - timeout should be hit
    const res = await app.request("/jobs/j1/wait?timeout_sec=1");
    expect(res.status).toBe(202);
  });
});
