import { Hono } from "hono";
import { z } from "zod";
import debug from "debug";
import { generateRandomId } from "../lib/utils/generate-random-id.js";
import { stringifyError } from "../lib/utils/error-handle.js";
import { executeCodeToGlb } from "../renderer/execute-code.js";
import { renderGlbToSnapshotGrid } from "../renderer/render-snapshots.js";
import type { connect } from "../db/index.js";

const log = debug("craft3d:jobs");

type DB = Awaited<ReturnType<typeof connect>>;

// ─── Snapshot pipeline ───────────────────────────────────────────────────────

async function processSnapshot(db: DB, jobId: string): Promise<void> {
  try {
    await db.queries.updateSnapshotStatus({
      id: jobId,
      snapshot_status: "processing",
    });

    const glbArtifact = await db.queries.getArtifact({
      job_id: jobId,
      role: "output_glb",
    });
    if (!glbArtifact?.blob_content) {
      throw new Error("output_glb artifact missing or empty");
    }

    log("rendering snapshot for job %s", jobId);
    const snapshotBuffer = await renderGlbToSnapshotGrid(
      glbArtifact.blob_content,
    );

    await db.queries.saveArtifact({
      job_id: jobId,
      role: "output_snapshot",
      mime_type: "image/png",
      blob_content: snapshotBuffer,
    });

    await db.queries.updateSnapshotStatus({
      id: jobId,
      snapshot_status: "completed",
    });
    log("snapshot completed for job %s", jobId);
  } catch (err) {
    const errorMsg = stringifyError(err);
    log("snapshot failed for job %s: %s", jobId, errorMsg);
    await db.queries
      .updateSnapshotStatus({
        id: jobId,
        snapshot_status: "failed",
        snapshot_error: errorMsg,
      })
      .catch(() => {});
  }
}

// ─── Job pipeline ─────────────────────────────────────────────────────────────

async function processJob(
  db: DB,
  jobId: string,
  withSnapshot: boolean,
): Promise<void> {
  try {
    await db.queries.updateJobStatus({ id: jobId, status: "processing" });

    const codeArtifact = await db.queries.getArtifact({
      job_id: jobId,
      role: "input_code",
    });
    if (!codeArtifact?.text_content) {
      throw new Error("input_code artifact missing");
    }

    log("executing code for job %s", jobId);
    const { glb: glbBuffer } = await executeCodeToGlb({
      code: codeArtifact.text_content,
    });

    await db.queries.saveArtifact({
      job_id: jobId,
      role: "output_glb",
      mime_type: "model/gltf-binary",
      blob_content: glbBuffer,
    });

    await db.queries.updateJobStatus({ id: jobId, status: "completed" });
    log("job %s completed (glb ready)", jobId);

    if (withSnapshot) {
      await processSnapshot(db, jobId);
    }
  } catch (err) {
    const errorMsg = stringifyError(err);
    log("job %s failed: %s", jobId, errorMsg);
    await db.queries
      .updateJobStatus({ id: jobId, status: "failed", error: errorMsg })
      .catch(() => {});
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function jobsRouter(db: DB) {
  const app = new Hono();

  // POST /jobs — create a render job
  // Body: { code: string, snapshots?: boolean }
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = z
      .object({
        code: z.string().min(1),
        snapshots: z.boolean().optional().default(true),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Body must be { code: string, snapshots?: boolean }" }, 400);
    }

    const { code, snapshots } = parsed.data;
    const id = generateRandomId();
    const now = Date.now();

    await db.queries.createJob({
      id,
      snapshot_status: snapshots ? "pending" : "none",
      created_at: now,
    });

    await db.queries.saveArtifact({
      job_id: id,
      role: "input_code",
      mime_type: "text/plain",
      text_content: code,
      created_at: now,
    });

    // Fire-and-forget
    processJob(db, id, snapshots).catch((err) =>
      log("unhandled processJob error for %s: %s", id, stringifyError(err)),
    );

    const job = await db.queries.getJob({ id });
    return c.json(job, 202);
  });

  // GET /jobs — list jobs
  app.get("/", async (c) => {
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20),
    );
    const offset = Math.max(
      0,
      parseInt(c.req.query("offset") ?? "0", 10) || 0,
    );
    const jobs = await db.queries.listJobs({ limit, offset });
    return c.json({ jobs, limit, offset });
  });

  // GET /jobs/:id — get job status
  app.get("/:id", async (c) => {
    const job = await db.queries.getJob({ id: c.req.param("id") });
    if (!job) return c.json({ error: "Not found" }, 404);
    return c.json(job);
  });

  // GET /jobs/:id/wait — long-poll until job and snapshot both reach terminal state
  app.get("/:id/wait", async (c) => {
    const id = c.req.param("id");
    const timeoutSec = Math.min(
      120,
      Math.max(1, parseInt(c.req.query("timeout_sec") ?? "30", 10) || 30),
    );
    const deadline = Date.now() + timeoutSec * 1000;

    while (Date.now() < deadline) {
      const job = await db.queries.getJob({ id });
      if (!job) return c.json({ error: "Not found" }, 404);

      const jobDone = job.status === "completed" || job.status === "failed";
      const snapshotDone =
        job.snapshot_status === "none" ||
        job.snapshot_status === "completed" ||
        job.snapshot_status === "failed";

      if (jobDone && snapshotDone) return c.json(job);

      await new Promise((r) =>
        setTimeout(r, Math.min(500, deadline - Date.now())),
      );
    }

    const job = await db.queries.getJob({ id });
    if (!job) return c.json({ error: "Not found" }, 404);
    return c.json(job, 202);
  });

  // GET /jobs/:id/glb — download GLB
  app.get("/:id/glb", async (c) => {
    const job = await db.queries.getJob({ id: c.req.param("id") });
    if (!job) return c.json({ error: "Not found" }, 404);
    if (job.status !== "completed")
      return c.json({ error: "GLB not ready", status: job.status }, 409);

    const artifact = await db.queries.getArtifact({
      job_id: c.req.param("id"),
      role: "output_glb",
    });
    if (!artifact?.blob_content)
      return c.json({ error: "GLB artifact missing" }, 404);

    return new Response(artifact.blob_content.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "model/gltf-binary",
        "Content-Length": String(artifact.blob_content.length),
        "Cache-Control": "no-store",
      },
    });
  });

  // GET /jobs/:id/code — download code
  app.get("/:id/code", async (c) => {
    const job = await db.queries.getJob({ id: c.req.param("id") });
    if (!job) return c.json({ error: "Not found" }, 404);

    const artifact = await db.queries.getArtifact({
      job_id: c.req.param("id"),
      role: "input_code",
    });
    if (!artifact?.text_content)
      return c.json({ error: "Code artifact missing" }, 404);

    return new Response(artifact.text_content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(artifact.text_content)),
        "Cache-Control": "no-store",
      },
    });
  });

  // GET /jobs/:id/snapshot — download snapshot PNG
  app.get("/:id/snapshot", async (c) => {
    const job = await db.queries.getJob({ id: c.req.param("id") });
    if (!job) return c.json({ error: "Not found" }, 404);
    if (job.snapshot_status === "none")
      return c.json({ error: "Snapshot was not requested for this job" }, 404);
    if (job.snapshot_status !== "completed")
      return c.json(
        { error: "Snapshot not ready", snapshot_status: job.snapshot_status },
        409,
      );

    const artifact = await db.queries.getArtifact({
      job_id: c.req.param("id"),
      role: "output_snapshot",
    });
    if (!artifact?.blob_content)
      return c.json({ error: "Snapshot artifact missing" }, 404);

    return new Response(artifact.blob_content.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(artifact.blob_content.length),
        "Cache-Control": "no-store",
      },
    });
  });

  // POST /jobs/:id/snapshot — trigger snapshot rendering (for jobs created with snapshots: false)
  app.post("/:id/snapshot", async (c) => {
    const id = c.req.param("id");
    const job = await db.queries.getJob({ id });
    if (!job) return c.json({ error: "Not found" }, 404);

    if (job.status !== "completed")
      return c.json(
        { error: "Job must be completed before requesting snapshot", status: job.status },
        409,
      );

    if (
      job.snapshot_status === "pending" ||
      job.snapshot_status === "processing"
    )
      return c.json({ error: "Snapshot already in progress", snapshot_status: job.snapshot_status }, 409);

    if (job.snapshot_status === "completed")
      return c.json({ error: "Snapshot already completed" }, 409);

    // Allow triggering for 'none' or retrying after 'failed'
    await db.queries.updateSnapshotStatus({ id, snapshot_status: "pending" });

    processSnapshot(db, id).catch((err) =>
      log("unhandled processSnapshot error for %s: %s", id, stringifyError(err)),
    );

    const updated = await db.queries.getJob({ id });
    return c.json(updated, 202);
  });

  // DELETE /jobs/:id — delete job and all artifacts
  app.delete("/:id", async (c) => {
    const deleted = await db.queries.deleteJob({ id: c.req.param("id") });
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true });
  });

  return app;
}
