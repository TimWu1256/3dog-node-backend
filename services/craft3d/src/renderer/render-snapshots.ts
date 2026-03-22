import sharp from "sharp";
import { createRendererPage } from "./browser.js";

export type GlbBinary = Buffer | Uint8Array | ArrayBuffer;

export type RenderSnapshotsOptions = {
  views?: { polar: number; azimuth: number }[];
  size?: number;
  background?: string;
  format?: "image/png" | "image/jpeg";
  jpegQuality?: number;
  timeoutMs?: number;
};

export function deg(d: number): number {
  return (d * Math.PI) / 180;
}

function toBuffer(b: GlbBinary): Buffer {
  return b instanceof ArrayBuffer
    ? Buffer.from(b)
    : Buffer.isBuffer(b)
      ? b
      : Buffer.from(b);
}

function defaultViews(): { polar: number; azimuth: number }[] {
  const views: { polar: number; azimuth: number }[] = [];
  const N = 16,
    M = N / 2,
    turns = 1;
  const helix1: typeof views = [],
    helix2: typeof views = [];

  for (let i = 0; i < M; i++) {
    const tA = i / M;
    const zA = 1 - 2 * tA;
    helix1.push({
      polar: deg((Math.acos(zA) * 180) / Math.PI),
      azimuth: deg((turns * 360 * tA) % 360),
    });

    const tB = 1 - i / M;
    const zB = 1 - 2 * tB;
    helix2.push({
      polar: deg((Math.acos(zB) * 180) / Math.PI),
      azimuth: deg((turns * 360 * tB + 180) % 360),
    });
  }

  return [...helix1, ...helix2];
}

function pickBestGrid(
  n: number,
  cellW: number,
  cellH: number,
): { cols: number; rows: number } {
  let best = { cols: 1, rows: n, ratio: Infinity, empty: 0, area: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const gridW = cols * cellW,
      gridH = rows * cellH;
    const ratio = gridW >= gridH ? gridW / gridH : gridH / gridW;
    const empty = rows * cols - n;
    const area = gridW * gridH;
    const better =
      ratio < best.ratio ||
      (ratio === best.ratio && empty < best.empty) ||
      (ratio === best.ratio && empty === best.empty && area < best.area) ||
      (ratio === best.ratio &&
        empty === best.empty &&
        area === best.area &&
        cols > best.cols);
    if (better) best = { cols, rows, ratio, empty, area };
  }
  return best;
}

export async function createImageGrid(
  views: GlbBinary[],
  options: {
    background?: string;
    format?: "image/png" | "image/jpeg";
    jpegQuality?: number;
  } = {},
): Promise<Buffer> {
  const { background = "#000000", format = "image/png", jpegQuality = 0.92 } =
    options;
  if (!views.length) throw new Error("views is empty");
  const bufs = views.map(toBuffer);
  const metas = await Promise.all(bufs.map((b) => sharp(b).metadata()));
  const cellW = Math.max(...metas.map((m) => m.width ?? 0));
  const cellH = Math.max(...metas.map((m) => m.height ?? 0));
  if (!cellW || !cellH) throw new Error("failed to read image dimensions");
  const { cols, rows } = pickBestGrid(bufs.length, cellW, cellH);
  const outW = cols * cellW,
    outH = rows * cellH;
  const resized = await Promise.all(
    bufs.map((b) =>
      sharp(b).resize(cellW, cellH, { fit: "contain", background }).toBuffer(),
    ),
  );
  const composites = resized.map((input, i) => ({
    input,
    left: (i % cols) * cellW,
    top: Math.floor(i / cols) * cellH,
  }));
  let img = sharp({
    create: { width: outW, height: outH, channels: 4, background },
  }).composite(composites);
  if (format === "image/jpeg") {
    img = img.jpeg({
      quality: Math.round(Math.max(0, Math.min(1, jpegQuality)) * 100),
      mozjpeg: true,
    });
  } else {
    img = img.png();
  }
  return img.toBuffer();
}

export async function renderGlbToSnapshotGrid(
  glbBinary: GlbBinary,
  options: RenderSnapshotsOptions = {},
): Promise<Buffer> {
  const {
    views = defaultViews(),
    size = 512,
    background = "#000000",
    format = "image/png",
    jpegQuality = 0.92,
    timeoutMs = 15_000,
  } = options;

  const glbBase64 = toBuffer(glbBinary).toString("base64");
  const page = await createRendererPage();

  try {
    const dataUrls = (await Promise.race([
      page.evaluate(
        ({ glbBase64, views, size, background, format, jpegQuality }) =>
          (window as any).__CRAFT3D_RENDER_VIEWS(glbBase64, {
            views,
            size,
            background,
            format,
            jpegQuality,
          }),
        { glbBase64, views, size, background, format, jpegQuality },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Render timeout")), timeoutMs),
      ),
    ])) as string[];

    if (
      !Array.isArray(dataUrls) ||
      !dataUrls.every((i) => typeof i === "string")
    ) {
      throw new Error("Invalid render output");
    }

    const buffers = dataUrls.map((u) => {
      const idx = u.indexOf(",");
      return Buffer.from(idx >= 0 ? u.slice(idx + 1) : u, "base64");
    });

    return createImageGrid(buffers, { background, format, jpegQuality });
  } finally {
    await page.context().close().catch(() => {});
  }
}
