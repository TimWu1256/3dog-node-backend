/**
 * End-to-end renderer tests.
 *
 * These tests launch a real Chromium browser and exercise the actual rendering
 * pipeline.  They are slow by design — expect 15-30 s per test.
 *
 * Artifacts are saved to test/artifacts/workflows/ for visual inspection.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { executeCodeToGlb } from "../../src/renderer/execute-code";
import { renderGlbToSnapshotGrid, createImageGrid } from "../../src/renderer/render-snapshots";
import { destroyBrowser } from "../../src/renderer/browser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/workflows");

function saveArtifact(relPath: string, data: Buffer): void {
  const fullPath = path.join(ARTIFACTS_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, data);
}

// Close the shared browser after all tests finish
afterAll(async () => {
  await destroyBrowser();
});

// ─── executeCodeToGlb ─────────────────────────────────────────────────────────

// Extract fenced code block from a markdown fixture file
function extractCodeFromMarkdown(md: string): string {
  const match = md.match(/^```(?:javascript|js)?\r?\n([\s\S]*?)^```/m);
  if (!match) throw new Error("No fenced code block found in markdown fixture");
  return match[1];
}

describe("executeCodeToGlb", () => {
  it("executes the teapot fixture code and returns a valid GLB buffer", async () => {
    const mdPath = path.resolve(__dirname, "../workflows/fixtures/teapot.md");
    const md = fs.readFileSync(mdPath, "utf-8");
    const code = extractCodeFromMarkdown(md);

    const result = await executeCodeToGlb({ code });

    expect(Buffer.isBuffer(result.glb)).toBe(true);
    expect(result.glb.slice(0, 4).toString("ascii")).toBe("glTF");
    expect(result.glb.length).toBeGreaterThan(1000);

    saveArtifact("object-designer/teapot.glb", result.glb);
  });

  it("executes a simple box mesh and returns a non-empty GLB buffer", async () => {
    const code = `
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const mesh = new THREE.Mesh(geometry, material);
      __export(mesh);
    `;

    const result = await executeCodeToGlb({ code });

    expect(Buffer.isBuffer(result.glb)).toBe(true);
    expect(result.glb.length).toBeGreaterThan(0);
    // GLB magic bytes: 0x46546C67 ("glTF")
    expect(result.glb.slice(0, 4).toString("ascii")).toBe("glTF");
    expect(Array.isArray(result.logs)).toBe(true);
  });

  it("captures console.log output from user code", async () => {
    const code = `
      console.log("hello from user code");
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1,1,1),
        new THREE.MeshBasicMaterial()
      );
      __export(mesh);
    `;

    const result = await executeCodeToGlb({ code });
    const logEntry = result.logs.find((l) => l.msg.includes("hello from user code"));
    expect(logEntry).toBeDefined();
    expect(logEntry!.level).toBe("log");
  });

  it("throws when __export() is never called", async () => {
    const code = `
      const x = 1 + 1;
      // no __export call
    `;

    await expect(executeCodeToGlb({ code })).rejects.toThrow();
  });

  it("throws when user code throws an error", async () => {
    const code = `
      throw new Error("intentional test error");
    `;

    await expect(executeCodeToGlb({ code })).rejects.toThrow();
  });

  it("works with a Group containing multiple meshes", async () => {
    const code = `
      const group = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 8, 8),
          new THREE.MeshBasicMaterial({ color: Math.random() * 0xffffff })
        );
        mesh.position.x = i * 1.5;
        group.add(mesh);
      }
      __export(group);
    `;

    const result = await executeCodeToGlb({ code });
    expect(result.glb.slice(0, 4).toString("ascii")).toBe("glTF");
    expect(result.glb.length).toBeGreaterThan(100);
  });
});

// ─── renderGlbToSnapshotGrid ──────────────────────────────────────────────────

describe("renderGlbToSnapshotGrid", () => {
  const teapotGlbPath = path.resolve(
    __dirname,
    "../workflows/fixtures/teapot.glb"
  );

  let teapotGlb: Buffer;

  beforeAll(() => {
    teapotGlb = fs.readFileSync(teapotGlbPath);
  });

  it("renders the teapot GLB and returns a non-empty PNG buffer", async () => {
    const result = await renderGlbToSnapshotGrid(teapotGlb);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50); // 'P'
    expect(result[2]).toBe(0x4e); // 'N'
    expect(result[3]).toBe(0x47); // 'G'

    saveArtifact("render-glb-snapshots/teapot-grid.png", result);
  });

  it("renders a teapot GLB (from executeCodeToGlb) to a snapshot grid", async () => {
    const mdPath = path.resolve(__dirname, "../workflows/fixtures/teapot.md");
    const md = fs.readFileSync(mdPath, "utf-8");
    const code = extractCodeFromMarkdown(md);
    const { glb } = await executeCodeToGlb({ code });

    const snapshot = await renderGlbToSnapshotGrid(glb);
    expect(Buffer.isBuffer(snapshot)).toBe(true);
    expect(snapshot[0]).toBe(0x89); // PNG magic

    saveArtifact("render-glb-snapshots/teapot-from-code-grid.png", snapshot);
  });

  it("accepts custom views with fewer angles (sphere)", async () => {
    const { glb } = await executeCodeToGlb({
      code: `
        __export(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32), new THREE.MeshStandardMaterial({ color: 0x4488ff })));
      `,
    });

    const snapshot = await renderGlbToSnapshotGrid(glb, {
      views: [
        { polar: Math.PI / 4, azimuth: 0 },
        { polar: Math.PI / 2, azimuth: Math.PI / 2 },
      ],
      size: 128,
    });

    expect(snapshot.length).toBeGreaterThan(0);

    saveArtifact("render-glb-snapshots/sphere-grid.png", snapshot);
  });
});

// ─── createImageGrid ─────────────────────────────────────────────────────────

describe("createImageGrid", () => {
  // Generate a minimal 1x1 PNG programmatically using sharp
  let tiny1x1: Buffer;

  beforeAll(async () => {
    const sharp = (await import("sharp")).default;
    tiny1x1 = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
  });

  it("throws when views array is empty", async () => {
    await expect(createImageGrid([])).rejects.toThrow("views is empty");
  });

  it("creates a PNG grid from a single image", async () => {
    const result = await createImageGrid([tiny1x1]);
    expect(result[0]).toBe(0x89); // PNG magic
    expect(result.length).toBeGreaterThan(0);
  });

  it("creates a PNG grid from multiple images", async () => {
    const result = await createImageGrid([tiny1x1, tiny1x1, tiny1x1, tiny1x1]);
    expect(result[0]).toBe(0x89);
  });

  it("creates a JPEG grid when format=image/jpeg", async () => {
    const result = await createImageGrid([tiny1x1], { format: "image/jpeg" });
    // JPEG magic bytes: 0xFF 0xD8
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
  });
});
