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
  animation_csharp: string | null;
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

  setAnimationCsharp: (params: {
    id: string;
    animation_csharp: string | null;
  }) => Promise<boolean>;
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
        ({ db, sql: sql0001 }) =>
        async () => {
          db.pragma("journal_mode = WAL");
          db.pragma("foreign_keys = ON");
          db.pragma("busy_timeout = 5000");

          db.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
              filename TEXT PRIMARY KEY,
              checksum TEXT NOT NULL,
              applied_at INTEGER NOT NULL
            )
          `);

          // Backward compat: migrate legacy checksum.sha256 → _migrations
          const checksumFilepath = path.join(db.dirname, "checksum.sha256");
          if (fs.existsSync(checksumFilepath)) {
            const oldHash = fs.readFileSync(checksumFilepath, "utf8");
            const expectedHash = await sha256(sql0001);
            if (oldHash !== expectedHash) {
              throw new Error("database schema checksum mismatch for 0001_init.sql");
            }
            db.prepare(
              "INSERT OR IGNORE INTO _migrations (filename, checksum, applied_at) VALUES (?, ?, ?)"
            ).run("0001_init.sql", oldHash, Date.now());
            fs.unlinkSync(checksumFilepath);
            db.log("migrated legacy checksum.sha256 to _migrations table");
          }

          // Apply all pending migrations in order
          const migrationsDir = path.resolve(db.dirname, "../../migrations");
          const files = fs.readdirSync(migrationsDir)
            .filter((f) => f.endsWith(".sql"))
            .sort();

          for (const filename of files) {
            const sql =
              filename === "0001_init.sql"
                ? sql0001
                : fs.readFileSync(path.join(migrationsDir, filename), "utf8");

            const checksum = await sha256(sql);
            const row = db
              .prepare("SELECT checksum FROM _migrations WHERE filename = ?")
              .get(filename) as { checksum: string } | undefined;

            if (row) {
              if (row.checksum !== checksum) {
                throw new Error(`Migration ${filename} has been modified after being applied`);
              }
              db.log(`migration ${filename} already applied`);
              continue;
            }

            db.exec(sql);
            db.prepare(
              "INSERT INTO _migrations (filename, checksum, applied_at) VALUES (?, ?, ?)"
            ).run(filename, checksum, Date.now());
            db.log(`applied migration ${filename}`);
          }
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

    setAnimationCsharp:
      ({ db, sql }) =>
      async ({ id, animation_csharp }) => {
        const row = db.prepare(sql).get({ id, animation_csharp }) as
          | { id: string }
          | undefined;
        return Boolean(row);
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
