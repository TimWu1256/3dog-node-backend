import { transpile, ModuleKind, ScriptTarget } from "typescript";
import { createRendererPage } from "./browser.js";

export type ExecuteCodeOptions = {
  code: string;
  timeoutMs?: number;
};

export type ExecuteCodeResult = {
  glb: Buffer;
  logs: Array<{ level: string; msg: string }>;
};

export async function executeCodeToGlb(
  options: ExecuteCodeOptions,
): Promise<ExecuteCodeResult> {
  const { code, timeoutMs = 15_000 } = options;

  // Transpile TypeScript → plain JS (no module system, plain script for browser)
  const jsCode = transpile(code, {
    module: ModuleKind.None,
    target: ScriptTarget.ES2022,
  });

  const page = await createRendererPage();

  try {
    const result = (await Promise.race([
      page.evaluate(
        (js) => (window as any).__CRAFT3D_EXECUTE_CODE(js),
        jsCode,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Code execution timeout")), timeoutMs),
      ),
    ])) as {
      glb: string | null;
      error: string | null;
      logs: Array<{ level: string; msg: string }>;
    };

    if (result.error || !result.glb) {
      throw new Error(result.error ?? "Code execution returned no GLB");
    }

    const glb = Buffer.from(result.glb, "base64");
    return { glb, logs: result.logs ?? [] };
  } finally {
    await page.context().close().catch(() => {});
  }
}
