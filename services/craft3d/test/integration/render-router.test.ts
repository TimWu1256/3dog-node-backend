/**
 * Integration tests for POST /render.
 *
 * Uses a real SQLite test database but mocks both renderer phases so no
 * browser is required.  Mirrors the setup pattern of jobs-router.test.ts.
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { createDatabase } from "../../src/db/index";
import { renderRouter } from "../../src/routers/render";

// ─── Mock renderer ────────────────────────────────────────────────────────────

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

const TEST_DB_NAME = `test_render_${process.pid}`;
let db: ReturnType<typeof createDatabase>;
let app: Hono;

beforeAll(async () => {
  db = createDatabase(TEST_DB_NAME);
  await db.queries.initialize();

  app = new Hono();
  app.route("/render", renderRouter(db));
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
  // Restore default mocks after each test (some tests override them)
  const { executeCodeToGlb } = require("../../src/renderer/execute-code");
  const { renderGlbToSnapshotGrid } = require("../../src/renderer/render-snapshots");
  executeCodeToGlb.mockResolvedValue({ glb: Buffer.from("FAKE_GLB_BINARY"), logs: [] });
  renderGlbToSnapshotGrid.mockResolvedValue(Buffer.from("FAKE_PNG_BINARY"));
});

// ─── POST /render ─────────────────────────────────────────────────────────────

describe("POST /render", () => {
  it("returns 200 with success, job_id, glb (base64), snapshot (base64)", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const mesh = new THREE.Mesh(); __export(mesh);" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.job_id).toBe("string");
    expect(typeof body.glb).toBe("string");
    expect(typeof body.snapshot).toBe("string");

    // Verify base64 decodes back to the fake buffers
    expect(Buffer.from(body.glb, "base64")).toEqual(FAKE_GLB);
    expect(Buffer.from(body.snapshot, "base64")).toEqual(FAKE_PNG);
  });

  it("persists the job and artifacts in the database", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    const body = await res.json();
    expect(body.success).toBe(true);

    const job = await db.queries.getJob({ id: body.job_id });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
    expect(job!.snapshot_status).toBe("completed");

    const glbArtifact = await db.queries.getArtifact({ job_id: body.job_id, role: "output_glb" });
    expect(glbArtifact).not.toBeNull();
    expect(glbArtifact!.blob_content).toEqual(FAKE_GLB);

    const snapshotArtifact = await db.queries.getArtifact({ job_id: body.job_id, role: "output_snapshot" });
    expect(snapshotArtifact).not.toBeNull();
    expect(snapshotArtifact!.blob_content).toEqual(FAKE_PNG);
  });

  it("accepts custom timeoutSec", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;", timeoutSec: 30 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when code field is missing", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutSec: 10 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 400 when code is empty string", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 400 when timeoutSec exceeds 120", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;", timeoutSec: 999 }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 422 and success=false when executeCodeToGlb throws", async () => {
    const { executeCodeToGlb } = require("../../src/renderer/execute-code");
    executeCodeToGlb.mockRejectedValueOnce(new Error("TS transpile error"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad code" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("TS transpile error");
  });

  it("records failed job status in DB when code execution fails", async () => {
    const { executeCodeToGlb } = require("../../src/renderer/execute-code");
    executeCodeToGlb.mockRejectedValueOnce(new Error("execution error"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad code" }),
    });

    const body = await res.json();
    expect(body.success).toBe(false);

    // Job should have been created and marked failed
    const jobs = await db.queries.listJobs({});
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toContain("execution error");
  });

  it("returns 422 and success=false when renderGlbToSnapshotGrid throws", async () => {
    const { renderGlbToSnapshotGrid } = require("../../src/renderer/render-snapshots");
    renderGlbToSnapshotGrid.mockRejectedValueOnce(new Error("snapshot render failed"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("snapshot render failed");
  });

  it("records failed snapshot status in DB when snapshot phase fails", async () => {
    const { renderGlbToSnapshotGrid } = require("../../src/renderer/render-snapshots");
    renderGlbToSnapshotGrid.mockRejectedValueOnce(new Error("snapshot error"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    await res.json();

    const jobs = await db.queries.listJobs({});
    expect(jobs.length).toBe(1);
    // GLB phase succeeded but snapshot failed
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].snapshot_status).toBe("failed");
    expect(jobs[0].snapshot_error).toContain("snapshot error");
  });
});
