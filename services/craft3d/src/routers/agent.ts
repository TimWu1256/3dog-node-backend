import { Hono } from "hono";
import debug from "debug";

const log = debug("craft3d:agent");

const AGENTS_SERVER_URL = process.env.AGENTS_SERVER_URL ?? "http://localhost:3600";

/**
 * POST /agent
 *
 * Debug endpoint. Calls the orchestrator with a synthetic tool_call event so that
 * craft3d + animation_agent run in one shot (matching the production path).
 *
 * Accepts multipart/form-data or JSON:
 *   name                string  (required)
 *   description         string  (optional)
 *   image               file    (optional)
 *   model               string  (optional) craft model, e.g. "google/gemini-3-flash-preview"
 *   craft_reasoning     string  (optional) "low" | "medium" | "high"
 *   animation_model     string  (optional) e.g. "openai/gpt-5.4"
 *   animation_reasoning string  (optional) "low" | "medium" | "high"
 *   iterations          number  (optional, overrides MAX_REVIEWS)
 *   with_animation      boolean (optional, default true)
 *
 * Returns OrchestratorOutput:
 *   { subagent_result: { job_id, glb_url, csharp_url, failure_reason },
 *     animation_result: { ... } | null }
 */
export function agentRouter() {
  const app = new Hono();

  app.post("/", async (c) => {
    let name: string | undefined;
    let description: string | undefined;
    let imageBase64: string | undefined;
    let iterations: number | undefined;
    let model: string | undefined;
    let craftReasoning: string | undefined;
    let animationModel: string | undefined;
    let animationReasoning: string | undefined;
    let withAnimation = true;

    const contentType = c.req.header("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        return c.json({ error: "Invalid form data" }, 400);
      }

      name = formData.get("name")?.toString();
      description = formData.get("description")?.toString();

      const iterRaw = formData.get("iterations")?.toString();
      if (iterRaw) {
        const parsed = parseInt(iterRaw, 10);
        if (!isNaN(parsed) && parsed > 0) iterations = parsed;
      }

      const modelRaw = formData.get("model")?.toString();
      if (modelRaw) model = modelRaw;

      const craftReasoningRaw = formData.get("craft_reasoning")?.toString();
      if (craftReasoningRaw) craftReasoning = craftReasoningRaw;

      const animationModelRaw = formData.get("animation_model")?.toString();
      if (animationModelRaw) animationModel = animationModelRaw;

      const animationReasoningRaw = formData.get("animation_reasoning")?.toString();
      if (animationReasoningRaw) animationReasoning = animationReasoningRaw;

      const animRaw = formData.get("with_animation")?.toString();
      if (animRaw === "false" || animRaw === "0") withAnimation = false;

      const imageFile = formData.get("image");
      if (imageFile instanceof File && imageFile.size > 0) {
        const buf = await imageFile.arrayBuffer();
        const mime = imageFile.type || "image/jpeg";
        imageBase64 = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
      }
    } else {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Expected multipart/form-data or JSON body" }, 400);
      }
      name = typeof body.name === "string" ? body.name : undefined;
      description = typeof body.description === "string" ? body.description : undefined;
      if (typeof body.image === "string" && body.image) imageBase64 = body.image;
      if (typeof body.iterations === "number" && body.iterations > 0) iterations = body.iterations;
      if (typeof body.model === "string" && body.model) model = body.model;
      if (typeof body.craft_reasoning === "string" && body.craft_reasoning) craftReasoning = body.craft_reasoning;
      if (typeof body.animation_model === "string" && body.animation_model) animationModel = body.animation_model;
      if (typeof body.animation_reasoning === "string" && body.animation_reasoning) animationReasoning = body.animation_reasoning;
      if (body.with_animation === false) withAnimation = false;
    }

    if (!name) {
      return c.json({ error: "Field 'name' is required" }, 400);
    }

    // Build the event arguments — backdoor fields are passed alongside the
    // standard object_name/object_description so the orchestrator can thread
    // them through to craft3d_agent.ainvoke().
    const eventArgs: Record<string, unknown> = {
      object_name: name,
      object_description: description ?? "",
      with_animation: withAnimation,
    };
    if (imageBase64) eventArgs.reference_images = [imageBase64];
    if (model) eventArgs.model = model;
    if (craftReasoning) eventArgs.craft_reasoning = craftReasoning;
    if (animationModel) eventArgs.animation_model = animationModel;
    if (animationReasoning) eventArgs.animation_reasoning = animationReasoning;
    if (iterations !== undefined) eventArgs.max_reviews = iterations;

    const orchestratorInput = {
      current_event: {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        data: {
          name: "create_3d_object",
          arguments: eventArgs,
        },
      },
    };

    log(
      "calling orchestrator at %s, name=%s, withAnimation=%s, model=%s, craftReasoning=%s, animationModel=%s, animationReasoning=%s",
      AGENTS_SERVER_URL, name, withAnimation, model, craftReasoning, animationModel, animationReasoning,
    );

    // Step 1: create a thread
    let threadId: string;
    try {
      const threadRes = await fetch(`${AGENTS_SERVER_URL}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!threadRes.ok) {
        const detail = await threadRes.text();
        return c.json({ error: `Failed to create thread (${threadRes.status})`, detail }, 502);
      }
      const threadJson = await threadRes.json() as { thread_id: string };
      threadId = threadJson.thread_id;
    } catch (err) {
      log("thread create error: %s", err);
      return c.json({ error: `Failed to reach agents server: ${err}` }, 502);
    }

    // Step 2: run/wait on the orchestrator
    let agentRes: Response;
    try {
      agentRes = await fetch(`${AGENTS_SERVER_URL}/threads/${threadId}/runs/wait`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistant_id: "orchestrator", input: orchestratorInput }),
      });
    } catch (err) {
      log("run/wait error: %s", err);
      return c.json({ error: `Failed to reach agents server: ${err}` }, 502);
    }

    const text = await agentRes.text();
    if (!agentRes.ok) {
      log("agents server error %d: %s", agentRes.status, text);
      return c.json({ error: `Agents server returned ${agentRes.status}`, detail: text }, 502);
    }

    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      return c.json({ error: "Invalid JSON from agents server", detail: text }, 502);
    }

    return c.json(result);
  });

  return app;
}
