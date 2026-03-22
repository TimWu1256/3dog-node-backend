import fs from "fs";
import path from "path";
import { stringifyError } from "../lib/utils/error-handle.js";
export * from "./core.js";
import { Database } from "./core.js";

// ─── Row types ────────────────────────────────────────────────────────────────

export type JobRow = {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
  snapshot_status: "none" | "pending" | "processing" | "completed" | "failed";
  snapshot_error: string | null;
  created_at: number;
  updated_at: number;
};

export type ArtifactRow = {
  job_id: string;
  role: "input_code" | "output_glb" | "output_snapshot";
  mime_type: string;
  text_content: string | null;
  blob_content: Buffer | null;
  created_at: number;
};

// ─── Query map ────────────────────────────────────────────────────────────────

type QueryMap = {
  initialize: () => Promise<void>;

  createJob: (params: {
    id: string;
    snapshot_status: "none" | "pending";
    created_at: number;
  }) => Promise<void>;

  getJob: (params: { id: string }) => Promise<JobRow | null>;

  updateJobStatus: (params: {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    error?: string | null;
  }) => Promise<boolean>;

  updateSnapshotStatus: (params: {
    id: string;
    snapshot_status: "none" | "pending" | "processing" | "completed" | "failed";
    snapshot_error?: string | null;
  }) => Promise<boolean>;

  saveArtifact: (params: {
    job_id: string;
    role: "input_code" | "output_glb" | "output_snapshot";
    mime_type: string;
    text_content?: string | null;
    blob_content?: Buffer | Uint8Array | null;
    created_at?: number;
  }) => Promise<void>;

  getArtifact: (params: {
    job_id: string;
    role: "input_code" | "output_glb" | "output_snapshot";
  }) => Promise<ArtifactRow | null>;

  deleteJob: (params: { id: string }) => Promise<boolean>;

  listJobs: (params: { limit?: number; offset?: number }) => Promise<JobRow[]>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sha256(data: string | Uint8Array): Promise<string> {
  const array = Uint8Array.from(
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  const buf = await crypto.subtle.digest("SHA-256", array);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Database factory ────────────────────────────────────────────────────────

export function createDatabase(name: string) {
  return new Database<QueryMap>(name, {
    initialize: {
      file: "0001_init",
      migration: true,
      build:
        ({ db, sql }) =>
        async () => {
          db.pragma("journal_mode = WAL");
          db.pragma("foreign_keys = ON");
          db.pragma("busy_timeout = 5000");

          const checksum = await sha256(sql);
          const checksumFilepath = path.join(db.dirname, "checksum.sha256");

          if (fs.existsSync(checksumFilepath)) {
            const hash = await fs.promises.readFile(checksumFilepath, "utf8");
            if (hash === checksum) {
              db.log("database schema already initialized");
              return;
            }
            throw new Error("database schema checksum mismatch");
          }

          db.exec(sql);
          await fs.promises.writeFile(checksumFilepath, checksum);
          db.log("database schema initialized");
        },
    },

    createJob:
      ({ db, sql }) =>
      async ({ id, snapshot_status, created_at }) => {
        db.prepare(sql).run({ id, snapshot_status, created_at });
      },

    getJob:
      ({ db, sql }) =>
      async ({ id }) => {
        const row = db.prepare(sql).get({ id }) as JobRow | undefined;
        return row ?? null;
      },

    updateJobStatus:
      ({ db, sql }) =>
      async ({ id, status, error = null }) => {
        const row = db.prepare(sql).get({ id, status, error }) as
          | { id: string }
          | undefined;
        return Boolean(row);
      },

    updateSnapshotStatus:
      ({ db, sql }) =>
      async ({ id, snapshot_status, snapshot_error = null }) => {
        const row = db.prepare(sql).get({
          id,
          snapshot_status,
          snapshot_error,
        }) as { id: string } | undefined;
        return Boolean(row);
      },

    saveArtifact:
      ({ db, sql }) =>
      async ({
        job_id,
        role,
        mime_type,
        text_content = null,
        blob_content = null,
        created_at = Date.now(),
      }) => {
        db.prepare(sql).run({
          job_id,
          role,
          mime_type,
          text_content,
          blob_content: blob_content ?? null,
          created_at,
        });
      },

    getArtifact:
      ({ db, sql }) =>
      async ({ job_id, role }) => {
        const row = db.prepare(sql).get({ job_id, role }) as
          | ArtifactRow
          | undefined;
        return row ?? null;
      },

    deleteJob:
      ({ db, sql }) =>
      async ({ id }) => {
        const row = db.prepare(sql).get({ id }) as { id: string } | undefined;
        return Boolean(row);
      },

    listJobs:
      ({ db, sql }) =>
      async ({ limit = 20, offset = 0 }) => {
        return db.prepare(sql).all({ limit, offset }) as JobRow[];
      },
  });
}

// ─── Singleton connect ────────────────────────────────────────────────────────

export const connect = (() => {
  let _db: ReturnType<typeof createDatabase> | null = null;
  let connectionPending: Promise<void> | null = null;

  return async () => {
    const db = _db ?? createDatabase("main");

    if (!_db) _db = db;

    connectionPending ??= db.queries
      .initialize()
      .then(() => {
        const close = () => {
          try {
            db.close();
          } catch (err) {
            db.log("closing error:", stringifyError(err));
          }
        };

        process.on("SIGINT", close);
        process.on("SIGTERM", close);
      })
      .catch((err) => {
        db.log("initialization error:", stringifyError(err));
        process.exit(1);
      });

    await connectionPending;

    return db as Omit<typeof db, "close">;
  };
})();
