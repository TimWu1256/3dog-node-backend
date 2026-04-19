import { z } from "zod";

// Future Feature

export const ModelConfigSchema = z.object({
  provider: z.enum(["google", "openai", "anthropic", "xai"]),
  code: z.string(),
  effort: z.enum(["max", "high", "medium", "low", "min"]),
});

export const ConfigSchema = z.object({
  llms: z.object({
    craft3d: ModelConfigSchema,
    review3d: ModelConfigSchema,
  }),
  instructionsFilePaths: z.object({
    orchestrator: z.string(),
    craft3dCoding: z.string(),
    craft3dReview: z.string(),
    craft3dRevise: z.string(),
  }),
  ports: z.object({
    gateway: z.number(),
    agent_server: z.number(),
  }),
  features: z.object({
    dss: z.boolean(),
    renderer: z.boolean(),
    pbrMaterial: z.boolean(),
  }),
  defaultValues: z.object({
    redererTimeoutMs: z.number(),
  }),
  signallingAddress: z.string().describe(""),
});

export type Config = z.infer<typeof ConfigSchema>;
