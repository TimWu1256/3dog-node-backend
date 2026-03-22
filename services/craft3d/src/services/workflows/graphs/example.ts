import debug from "debug";
import { StructuredTool, tool } from "@langchain/core/tools";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  ReducedValue,
  END,
  START,
  ConditionalEdgeRouter,
  GraphNode,
} from "@langchain/langgraph";
import {
  SystemMessage,
  HumanMessage,
  BaseMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import z from "zod";

const log = debug("graphs/gen-obj");

const MessagesState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new ReducedValue(z.number().default(0), {
    reducer: (x, y) => x + y,
  }),
});

const model = new ChatGoogleGenerativeAI({
  model: "gemini-3-flash-preview",
  thinkingConfig: { thinkingLevel: "LOW" },
});

const add = tool(({ numbers }) => numbers.reduce((a, b) => a + b, 0), {
  name: "add",
  description: "Add numbers",
  schema: z.object({
    numbers: z.array(z.number()).describe("Numbers"),
  }),
});

const multiply = tool(({ numbers }) => numbers.reduce((a, b) => a * b, 1), {
  name: "multiply",
  description: "Multiply numbers",
  schema: z.object({
    numbers: z.array(z.number()).describe("Numbers"),
  }),
});

// Augment the LLM with tools
const toolsByName: Record<string, StructuredTool> = {
  [add.name]: add,
  [multiply.name]: multiply,
};
const tools = Object.values(toolsByName);
const modelWithTools = model.bindTools(tools);

import { AIMessage, ToolMessage } from "@langchain/core/messages";

const toolNode: GraphNode<typeof MessagesState> = async (state) => {
  const lastMessage = state.messages.at(-1);

  if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
    return { messages: [] };
  }

  const result: ToolMessage[] = [];
  for (const toolCall of lastMessage.tool_calls ?? []) {
    const tool = toolsByName[toolCall.name];
    const observation = await tool.invoke(toolCall);
    result.push(observation);
  }

  return { messages: result };
};

const llmCall: GraphNode<typeof MessagesState> = async (state) => {
  const response = await modelWithTools.invoke([
    new SystemMessage(
      "You are a helpful assistant tasked with performing arithmetic on a set of inputs.",
    ),
    ...state.messages,
  ]);
  return {
    messages: [response],
    llmCalls: 1,
  };
};

const shouldContinue: ConditionalEdgeRouter<typeof MessagesState> = (state) => {
  const lastMessage = state.messages.at(-1);

  // Check if it's an AIMessage before accessing tool_calls
  if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
    return END;
  }

  // If the LLM makes a tool call, then perform an action
  if (lastMessage.tool_calls?.length) {
    return "toolNode";
  }

  // Otherwise, we stop (reply to the user)
  return END;
};

(async (run = 0) => {
  if (!run) return;
  log("generate-object");

  const agent = new StateGraph(MessagesState)
    .addNode("llmCall", llmCall)
    .addNode("toolNode", toolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall")
    .compile();

  let data: (typeof MessagesState)["State"] = {
    messages: [new HumanMessage("1x2+3x4+...10 是多少")],
    llmCalls: 0,
  };

  log("START");

  const stream = await agent.stream(data, {
    subgraphs: true,
    streamMode: ["updates", "values"],
  });

  for await (const [_subgraphs, mode, chunk] of stream) {
    switch (mode) {
      case "updates": {
        Object.entries(chunk).forEach(([nodeName, value]) => {
          const messages = value.messages;
          if (!messages) return;
          const messageArray = Array.isArray(messages) ? messages : [messages];

          for (const msg of messageArray) {
            if (!BaseMessage.isInstance(msg)) continue;
            log(`[${nodeName}:${msg.type}]`, msg.content);
          }
        });
        break;
      }
      case "values": {
        data = chunk;
        break;
      }
    }
  }

  log("END");
})();
