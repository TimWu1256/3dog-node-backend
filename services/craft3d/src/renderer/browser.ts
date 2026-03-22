import fs from "fs/promises";
import path from "path";
import debug from "debug";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

const log = debug("craft3d:browser");

// Resolve renderer.html: try project-root first (dev + project-root prod),
// then dist/browser (dist-only deploy where build:assets copied browser/ → dist/browser/).
function resolveRendererHtmlPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../browser/renderer.html"), // src/renderer → project root
    path.resolve(__dirname, "../browser/renderer.html"),    // dist/renderer → dist/browser
  ];
  const { existsSync } = require("fs") as typeof import("fs");
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const RENDERER_HTML_PATH = resolveRendererHtmlPath();
const INIT_TIMEOUT_MS = 15_000;

let browserInstance: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=swiftshader",
      "--disable-web-security",
      "--disable-logging",
      "--log-level=3",
      "--silent",
    ],
    logger: { isEnabled: () => false, log: () => {} },
  });
  log("browser launched");
  return browser;
}

export async function getBrowser(): Promise<Browser> {
  if (browserInstance) return browserInstance;
  if (!browserPromise) {
    browserPromise = launchBrowser().then((b) => {
      browserInstance = b;
      return b;
    });
  }
  return browserPromise;
}

export async function createRendererPage(): Promise<Page> {
  const browser = await getBrowser();
  const html = await fs.readFile(RENDERER_HTML_PATH, "utf-8");

  const context = await browser.newContext({
    viewport: { width: 2048, height: 2048 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  page.on("pageerror", (e) => log("page error: %s", e.message));
  page.on("console", (m) => log("page [%s]: %s", m.type(), m.text()));
  page.on("requestfailed", (r) =>
    log("request failed: %s %s", r.url(), r.failure()?.errorText),
  );

  await page.setContent(html, { waitUntil: "load" });
  await page.waitForFunction(
    () => (window as any).__CRAFT3D_READY === true,
    null,
    { timeout: INIT_TIMEOUT_MS },
  );

  return page;
}

export async function destroyBrowser(): Promise<void> {
  if (!browserInstance) return;
  try {
    await browserInstance.close();
    log("browser closed");
  } catch (e) {
    log("error closing browser: %s", e);
  } finally {
    browserInstance = null;
    browserPromise = null;
  }
}

// Cleanup on process exit
const cleanup = () => destroyBrowser().catch(() => {});
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
