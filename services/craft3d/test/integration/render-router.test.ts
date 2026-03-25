/**
 * Integration tests for POST /render.
 *
 * Uses a real SQLite test database but mocks both renderer phases so no
 * browser is required.
 *
 * ESM note: jest.unstable_mockModule() must be called before any dynamic
 * import that transitively imports the mocked module. Static imports of
 * modules that do NOT depend on the mocked modules are fine.
 */

import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { createDatabase } from "../../src/db/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Mock renderer (must come before any dynamic import of the router) ────────

jest.unstable_mockModule("../../src/renderer/execute-code", () => ({
  executeCodeToGlb: jest.fn(),
}));

jest.unstable_mockModule("../../src/renderer/render-snapshots", () => ({
  renderGlbToSnapshotGrid: jest.fn(),
}));

// ─── Module-level declarations ───────────────────────────────────────────────

let renderRouter: typeof import("../../src/routers/render").renderRouter;
let mockExecuteCodeToGlb: jest.MockedFunction<
  typeof import("../../src/renderer/execute-code").executeCodeToGlb
>;
let mockRenderGlbToSnapshotGrid: jest.MockedFunction<
  typeof import("../../src/renderer/render-snapshots").renderGlbToSnapshotGrid
>;

const FAKE_GLB = Buffer.from("FAKE_GLB_BINARY");
const FAKE_PNG = Buffer.from("FAKE_PNG_BINARY");

const TEST_DB_NAME = `test_render_${process.pid}`;
let db: ReturnType<typeof createDatabase>;
let app: Hono;

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Dynamic imports run after mock registration so the router sees the mocks.
  ({ renderRouter } = await import("../../src/routers/render"));

  const execMod = await import("../../src/renderer/execute-code");
  mockExecuteCodeToGlb = execMod.executeCodeToGlb as jest.MockedFunction<
    typeof execMod.executeCodeToGlb
  >;

  const snapMod = await import("../../src/renderer/render-snapshots");
  mockRenderGlbToSnapshotGrid = snapMod.renderGlbToSnapshotGrid as jest.MockedFunction<
    typeof snapMod.renderGlbToSnapshotGrid
  >;

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
  // clearAllMocks resets implementations in Jest 30; re-set defaults here.
  jest.clearAllMocks();
  mockExecuteCodeToGlb.mockResolvedValue({ glb: Buffer.from("FAKE_GLB_BINARY"), logs: [] });
  mockRenderGlbToSnapshotGrid.mockResolvedValue(Buffer.from("FAKE_PNG_BINARY"));
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(typeof body.job_id).toBe("string");
    expect(typeof body.glb).toBe("string");
    expect(typeof body.snapshot).toBe("string");

    // Verify base64 decodes back to the fake buffers
    expect(Buffer.from(body.glb as string, "base64")).toEqual(FAKE_GLB);
    expect(Buffer.from(body.snapshot as string, "base64")).toEqual(FAKE_PNG);
  });

  it("persists the job and artifacts in the database", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);

    const job = await db.queries.getJob({ id: body.job_id as string });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
    expect(job!.snapshot_status).toBe("completed");

    const glbArtifact = await db.queries.getArtifact({
      job_id: body.job_id as string,
      role: "output_glb",
    });
    expect(glbArtifact).not.toBeNull();
    expect(glbArtifact!.blob_content).toEqual(FAKE_GLB);

    const snapshotArtifact = await db.queries.getArtifact({
      job_id: body.job_id as string,
      role: "output_snapshot",
    });
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
  });

  it("returns 400 when code is empty string", async () => {
    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
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
    mockExecuteCodeToGlb.mockRejectedValueOnce(new Error("TS transpile error"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad code" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error as string).toContain("TS transpile error");
  });

  it("records failed job status in DB when code execution fails", async () => {
    mockExecuteCodeToGlb.mockRejectedValueOnce(new Error("execution error"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad code" }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);

    // Job should have been created and marked failed
    const jobs = await db.queries.listJobs({});
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toContain("execution error");
  });

  it("returns 422 and success=false when renderGlbToSnapshotGrid throws", async () => {
    mockRenderGlbToSnapshotGrid.mockRejectedValueOnce(new Error("snapshot render failed"));

    const res = await app.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "const x = 1;" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error as string).toContain("snapshot render failed");
  });

  it("records failed snapshot status in DB when snapshot phase fails", async () => {
    mockRenderGlbToSnapshotGrid.mockRejectedValueOnce(new Error("snapshot error"));

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
