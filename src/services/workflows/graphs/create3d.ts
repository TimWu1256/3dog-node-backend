import debug from "debug";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  END,
  START,
  StateGraph,
  StateSchema,
  ReducedValue,
  ConditionalEdgeRouter,
  GraphNode,
} from "@langchain/langgraph";
import { ContentBlock, HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import z from "zod";

import { loadInstructionsTemplateSync } from "../../instructions";
import { ObjectProps, ObjectPropsSchema } from "../schemas";
import { stringifyError } from "../../../lib/utils/error-handle";
import { generateGlbFromCode } from "../generate-glb-from-code";
import { GlbSnapshotsRenderer } from "../render-glb-snapshots";
import { extractCodeFromMarkdown } from "../generate-code";

const MAX_REVISES = 5;

const renderThreeJsGenerationPrompt = loadInstructionsTemplateSync<ObjectProps>(
  "threejs-generation-v2",
);
const renderCraft3DReviewPrompt =
  loadInstructionsTemplateSync<ObjectProps>("craft3d-review");
const renderCraft3DRevisePrompt = loadInstructionsTemplateSync<{
  code: string;
  comment: string;
}>("craft3d-revise");

const renderer = new GlbSnapshotsRenderer();
renderer.prewarm();

const log = debug("graphs/craft3d");

const craft3DModel = new ChatGoogleGenerativeAI({
  model: "gemini-3.1-pro-preview",
  thinkingConfig: { thinkingLevel: "LOW" },
}).pipe(new StringOutputParser());

const reviewModel = new ChatGoogleGenerativeAI({
  model: "gemini-3.1-pro-preview",
  thinkingConfig: { thinkingLevel: "LOW" },
}).pipe(new StringOutputParser());

const ReviewSchema = z.object({
  approved: z.boolean(),
  comment: z.string(),
});

const ArtifactSchema = z.object({
  version: z.string(),
  input: ObjectPropsSchema,
  code: z.string().nullable(),
  glb: z.instanceof(Uint8Array).nullable(),
  snapshot: z.instanceof(Uint8Array).nullable(),
  errors: z.array(z.string()),
  review: ReviewSchema.nullable(),
});

type Artifact = z.infer<typeof ArtifactSchema>;

const Craft3DState = new StateSchema({
  input: ObjectPropsSchema,
  artifactHistory: new ReducedValue(z.array(ArtifactSchema), {
    inputSchema: ArtifactSchema.or(z.array(ArtifactSchema)),
    reducer: (current, input) => {
      return Array.isArray(input) ? input : [...current, input];
    },
  }),
  currentVersion: z.string().nullable().default(null),
  reviseCount: new ReducedValue(z.int().default(0), {
    inputSchema: z.int(),
    reducer: (current, input) => current + input,
  }),
});

async function debugSaveArtifact(result: Artifact) {
  const name = `${Date.now()}_${result.input.object_name}_${result.version}`;
  const fs = await import("fs");
  const path = await import("path");
  const dirname = path.join("./out/", name);
  fs.mkdirSync(dirname, { recursive: true });
  fs.writeFileSync(
    path.join(dirname, "meta.txt"),
    new TextEncoder().encode(
      JSON.stringify({ props: result.input, errors: result.errors }),
    ),
  );
  if (result) {
    if (result.code)
      fs.writeFileSync(path.join(dirname, "code.txt"), result.code);
    if (result.glb)
      fs.writeFileSync(path.join(dirname, "output.glb"), result.glb);
    if (result.snapshot)
      fs.writeFileSync(path.join(dirname, "snapshot.png"), result.snapshot);
    if (result.review)
      fs.writeFileSync(path.join(dirname, "review.txt"), result.review.comment);
  }
}

function getCurrentArtifact(state: (typeof Craft3DState)["State"]) {
  const currentVersion = state.currentVersion;
  return (
    state.artifactHistory.findLast((a) => a.version === currentVersion) ?? null
  );
}

async function updateCurrentArtifact(
  state: (typeof Craft3DState)["State"],
  cb: (a: Artifact) => Artifact | Promise<Artifact>,
): Promise<(typeof Craft3DState)["Update"]> {
  const currentVersion = state.currentVersion;
  const artifactHistory = [...state.artifactHistory];

  if (currentVersion === null) return {};

  const index = artifactHistory.findLastIndex(
    (a) => a.version === currentVersion,
  );

  if (index === -1) return {};

  artifactHistory[index] = await cb(artifactHistory[index]);

  return { artifactHistory };
}

async function createArtifact(
  {
    version,
    input,
    fallbackCode = null,
  }: Pick<Artifact, "version" | "input"> & { fallbackCode?: string | null },
  additionalContentBlocks: ContentBlock[] = [],
): Promise<Artifact> {
  try {
    const response = await craft3DModel.invoke([
      new HumanMessage({
        content: [
          { type: "text", text: renderThreeJsGenerationPrompt(input) },
          ...additionalContentBlocks,
        ],
      }),
    ]);
    return {
      version,
      input,
      code: extractCodeFromMarkdown(response) ?? fallbackCode,
      glb: null,
      snapshot: null,
      review: null,
      errors: [],
    };
  } catch (error) {
    return {
      version,
      input,
      code: fallbackCode,
      glb: null,
      snapshot: null,
      review: null,
      errors: [stringifyError(error)],
    };
  }
}

async function renderArtifact(input: Artifact): Promise<Artifact> {
  const { code, errors } = input;
  if (!code) {
    return { ...input, errors: [...errors, "No code to generate GLB from"] };
  }
  try {
    const glb = await generateGlbFromCode({ code, timeoutMs: 10_000 });
    try {
      const snapshot = await renderer.renderGlbSnapshotsToGrid(glb, {
        size: 512,
        background: "#000000",
        format: "image/png",
        timeoutMs: 10_000,
      });
      return { ...input, glb, snapshot: new Uint8Array(snapshot) };
    } catch (error) {
      return { ...input, glb, errors: [...errors, stringifyError(error)] };
    }
  } catch (error) {
    return { ...input, errors: [...errors, stringifyError(error)] };
  }
}

async function reviewArtifact(inputObj: Artifact): Promise<Artifact> {
  const { input, snapshot, errors } = inputObj;
  const errorMessage = errors.length
    ? `Found error${errors.length > 1 ? "s" : ""}:\n\n${errors.join("\n")}`
    : null;

  if (!snapshot) {
    return {
      ...inputObj,
      review: {
        approved: false,
        comment:
          errorMessage ??
          "The result was not generated correctly due to unexpected reasons.",
      },
    };
  }

  const base64String = Buffer.from(snapshot).toString("base64");
  const dataUri = `data:image/png;base64,${base64String}`;
  const response = await reviewModel.invoke([
    new HumanMessage({
      content: [
        { type: "text", text: renderCraft3DReviewPrompt(input) },
        { type: "image_url", image_url: { url: dataUri } },
      ],
    }),
  ]);
  const isApproved = response.includes("APPROVED");

  log(`[${input.object_name}] REVIEW:`, response);

  return {
    ...inputObj,
    review: {
      approved: isApproved,
      comment: isApproved
        ? response
        : `${errorMessage ? errorMessage + "\n\n---\n\n" : ""}${response}`,
    },
  };
}

const craftNode: GraphNode<typeof Craft3DState> = async (state) => {
  const version = String(state.artifactHistory.length + 1);
  return {
    artifactHistory: await createArtifact({ version, input: state.input }),
    currentVersion: version,
  };
};

const renderNode: GraphNode<typeof Craft3DState> = async (state) => {
  return await updateCurrentArtifact(state, renderArtifact);
};

const reviewNode: GraphNode<typeof Craft3DState> = async (state) => {
  return await updateCurrentArtifact(state, async (a) => {
    const reviewed = await reviewArtifact(a);
    debugSaveArtifact(reviewed).catch(console.error);
    return reviewed;
  });
};

const reviseNode: GraphNode<typeof Craft3DState> = async (state) => {
  const version = String(state.artifactHistory.length + 1);
  const current = getCurrentArtifact(state);

  if (!current) throw new Error("No current artifact found for revision");

  return {
    artifactHistory: await createArtifact(
      { version, input: state.input, fallbackCode: current.code },
      [
        {
          type: "text",
          text: renderCraft3DRevisePrompt({
            code: current.code ?? "",
            comment: current.review?.comment ?? "None",
          }),
        },
      ],
    ),
    currentVersion: version,
    reviseCount: 1,
  };
};

const reviewRouter: ConditionalEdgeRouter<typeof Craft3DState> = async (
  state,
) => {
  const artifact =
    (state.currentVersion &&
      state.artifactHistory.findLast(
        (a) => a.version === state.currentVersion,
      )) ||
    null;

  if (!artifact) {
    throw new Error("No artifact was activated.");
  }

  if (!artifact.review) {
    throw new Error("No review was done.");
  }

  if (artifact.review.approved || state.reviseCount >= MAX_REVISES) {
    return END;
  }

  return reviseNode.name;
};

const craft3DAgent = new StateGraph(Craft3DState)
  // Nodes
  .addNode(craftNode.name, craftNode)
  .addNode(renderNode.name, renderNode)
  .addNode(reviewNode.name, reviewNode)
  .addNode(reviseNode.name, reviseNode)
  // Routes
  .addEdge(START, craftNode.name)
  .addEdge(craftNode.name, renderNode.name)
  .addEdge(renderNode.name, reviewNode.name)
  .addEdge(reviseNode.name, renderNode.name)
  .addEdge(renderNode.name, reviewNode.name)
  .addConditionalEdges(reviewNode.name, reviewRouter, [reviseNode.name, END])
  .compile();

export async function invokeCraft3DAgent(input: ObjectProps) {
  let data: (typeof Craft3DState)["State"] = {
    input,
    artifactHistory: [],
    currentVersion: null,
    reviseCount: 0,
  };

  const stream = await craft3DAgent.stream(data, {
    subgraphs: true,
    streamMode: ["updates", "values"],
  });

  for await (const [_subgraphs, mode, chunk] of stream) {
    switch (mode) {
      case "updates": {
        for (const [nodeName, value] of Object.entries(chunk)) {
          if (!value) continue;
          log(
            `node ${JSON.stringify(nodeName)} updated ${Object.keys(value)
              .map((i) => JSON.stringify(i))
              .join(", ")}`,
          );
        }
        break;
      }
      case "values": {
        data = chunk;
        break;
      }
    }
  }

  return { ...data, currentArtifact: getCurrentArtifact(data) };
}

(async () => {
  if (!Number(process.env.RUN_CRAFT_3D_TEST)) return;

  await new Promise((r) => setTimeout(r, 1));

  log("START testing");

  await invokeCraft3DAgent({
    object_name: "Bakery",
    object_description: `A quaint, steep-roofed cottage with a rustic bakery stall at the front. The house has weathered timber framing, pale plaster walls, and a sharply pitched roof covered in multicolored aged tiles with patches of moss. A striped fabric awning shades a wooden counter displaying loaves of bread and produce. One person stands at the stall as if shopping, while another figure carrying a long tool walks along the stone path beside the house. Small flowers and scattered greenery surround the building, adding to the cozy village atmosphere.`,
  });

  log("END testing");
})();
