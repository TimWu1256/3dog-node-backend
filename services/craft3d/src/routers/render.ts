import { Hono } from "hono";
import { z } from "zod";
import debug from "debug";
import { generateRandomId } from "../lib/utils/generate-random-id.js";
import { stringifyError } from "../lib/utils/error-handle.js";
import { executeCodeToGlb } from "../renderer/execute-code.js";
import { renderGlbToSnapshotGrid } from "../renderer/render-snapshots.js";
import type { connect } from "../db/index.js";

const log = debug("craft3d:render");

type DB = Awaited<ReturnType<typeof connect>>;

/**
 * POST /render
 *
 * Synchronous convenience endpoint: submit Three.js TypeScript code, receive
 * the rendered GLB and PNG snapshot in a single response.
 *
 * Internally creates a job, runs both rendering phases, then returns the
 * artifacts as base64-encoded strings. The job record is retained in the
 * database and accessible via the /jobs API.
 *
 * Request body (JSON):
 *   { code: string, timeoutSec?: number }
 *
 * Success response (200):
 *   { success: true, job_id: string, glb: string (base64), snapshot: string (base64) }
 *
 * Failure response (422):
 *   { success: false, error: string }
 */
export function renderRouter(db: DB) {
  const app = new Hono();

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = z
      .object({
        code: z.string().min(1),
        timeoutSec: z.number().int().min(1).max(120).optional().default(60),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        { success: false, error: "Body must be { code: string, timeoutSec?: number }" },
        400,
      );
    }

    const { code, timeoutSec } = parsed.data;
    const timeoutMs = timeoutSec * 1000;

    const id = generateRandomId();
    const now = Date.now();

    // Persist the job and input code so it's visible via /jobs
    await db.queries.createJob({ id, snapshot_status: "pending", created_at: now });
    await db.queries.saveArtifact({
      job_id: id,
      role: "input_code",
      mime_type: "text/plain",
      text_content: code,
      created_at: now,
    });

    // ── Phase 1: TypeScript code → GLB ──────────────────────────────────────
    let glbBuffer: Buffer;
    try {
      await db.queries.updateJobStatus({ id, status: "processing" });
      log("executing code for render job %s", id);

      const { glb } = await executeCodeToGlb({ code, timeoutMs });
      glbBuffer = glb;

      await db.queries.saveArtifact({
        job_id: id,
        role: "output_glb",
        mime_type: "model/gltf-binary",
        blob_content: glbBuffer,
      });
      await db.queries.updateJobStatus({ id, status: "completed" });
      log("render job %s: GLB ready", id);
    } catch (err) {
      const error = stringifyError(err);
      log("render job %s: code execution failed: %s", id, error);
      await db.queries.updateJobStatus({ id, status: "failed", error }).catch(() => {});
      return c.json({ success: false, error }, 422);
    }

    // ── Phase 2: GLB → PNG snapshot ──────────────────────────────────────────
    let snapshotBuffer: Buffer;
    try {
      await db.queries.updateSnapshotStatus({ id, snapshot_status: "processing" });
      log("rendering snapshot for render job %s", id);

      snapshotBuffer = await renderGlbToSnapshotGrid(glbBuffer);

      await db.queries.saveArtifact({
        job_id: id,
        role: "output_snapshot",
        mime_type: "image/png",
        blob_content: snapshotBuffer,
      });
      await db.queries.updateSnapshotStatus({ id, snapshot_status: "completed" });
      log("render job %s: snapshot ready", id);
    } catch (err) {
      const error = stringifyError(err);
      log("render job %s: snapshot failed: %s", id, error);
      await db.queries
        .updateSnapshotStatus({ id, snapshot_status: "failed", snapshot_error: error })
        .catch(() => {});
      return c.json({ success: false, error }, 422);
    }

    return c.json({
      success: true,
      job_id: id,
      glb: glbBuffer.toString("base64"),
      snapshot: snapshotBuffer.toString("base64"),
    });
  });

  return app;
}
