import { generateText, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  type AuditedRequest,
  blockUsed,
  type CallToMeasure,
  capabilityOfTool,
  createTokenAuditor,
  instructionBlocks,
  instructionUseTable,
  kindOf,
  kindTable,
  measurePrompt,
  type PromptParts,
  passageTexts,
  sumParts,
  type ToolSize,
  tokenReport,
  tokenRows,
  toolUses,
} from "../../eval/speed/tokens";
import type { ChatModelSpec } from "../../src/core";
import { estimateTokens } from "../../src/core/answers/context";
import type { ChatLanguageModel } from "../../src/core/providers/models";
import { scriptedModel } from "../helpers/models";

const empty = (): PromptParts => ({
  instructions: 0,
  tools: 0,
  passages: 0,
  passageNotes: 0,
  history: 0,
  question: 0,
  toolCalls: 0,
  toolResults: 0,
  other: 0,
});

function toolSize(name: string, description: number, schema: number): ToolSize {
  return { name, description, schema, total: estimateTokens(name) + description + schema };
}

function request(overrides: Partial<AuditedRequest> = {}): AuditedRequest {
  const { parts: given, ...rest } = overrides;
  const parts = { ...empty(), ...given };
  return {
    flow: "question",
    model: "anthropic/claude-haiku-5-5",
    language: "en",
    tag: null,
    requestedAt: "2026-10-25T00:00:00.000Z",
    tools: [],
    instructions: [],
    called: [],
    passages: 0,
    cacheable: 0,
    counted: { input: 100, cached: 40, output: 10 },
    outcome: "finished",
    files: 0,
    ...rest,
    parts,
    estimated: rest.estimated ?? sumParts(parts),
  };
}

const PASSAGES =
  '<passage id="P1" document="JP Morgan" pages="2">\nRevenue was up.\n</passage>\n\n' +
  '<passage id="P2" document="JP Morgan" pages="3">\nEmissions fell.\n</passage>\n\n' +
  "IncarnaMind couldn't read the text of one Document.";

function params(overrides: Partial<CallToMeasure> = {}): CallToMeasure {
  return {
    prompt: [
      {
        role: "system",
        content:
          "You answer Questions in IncarnaMind, a notebook where the User writes Notes.\n- Write Markdown: paragraphs and lists.\nNever work out a number yourself, not even a simple one.",
      },
      { role: "user", content: [{ type: "text", text: "Notes for Monday's briefing." }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search_documents",
            input: { query: "emissions" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search_documents",
            output: { type: "text", value: PASSAGES },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "What does the report say?" }] },
    ],
    tools: [
      {
        type: "function",
        name: "search_documents",
        description: "Search the User's Documents.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: "calculate",
        description: "Work out a number from numbers in the Passages.",
        inputSchema: { type: "object", properties: { figures: { type: "array" } } },
      },
    ],
    ...overrides,
  };
}

describe("the parts of a prompt", () => {
  it("measures the instructions, each Tool, the Passages and their notes, and the Question", () => {
    const measured = measurePrompt(params());
    expect(measured.tools.map((each) => each.name)).toEqual(["search_documents", "calculate"]);
    expect(measured.tools[0]?.total).toBe(
      estimateTokens("search_documents") +
        estimateTokens("Search the User's Documents.") +
        estimateTokens(
          JSON.stringify({
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          }),
        ),
    );
    expect(measured.parts.tools).toBe(
      (measured.tools[0]?.total ?? 0) + (measured.tools[1]?.total ?? 0),
    );
    expect(measured.parts.instructions).toBeGreaterThan(0);
    expect(measured.parts.history).toBeGreaterThan(0);
    expect(measured.parts.question).toBe(estimateTokens("What does the report say?"));
    expect(measured.parts.passages).toBeGreaterThan(0);
    expect(measured.parts.passageNotes).toBeGreaterThan(0);
    expect(measured.parts.toolCalls).toBeGreaterThan(0);
    expect(measured.passages).toBe(2);
    expect(measured.files).toBe(0);
    expect(sumParts(measured.parts)).toBe(
      measured.parts.instructions +
        measured.parts.tools +
        measured.parts.passages +
        measured.parts.passageNotes +
        measured.parts.history +
        measured.parts.question +
        measured.parts.toolCalls +
        measured.parts.toolResults +
        measured.parts.other,
    );
  });

  it("splits the earlier turns from the last Question", () => {
    const measured = measurePrompt(
      params({
        prompt: [
          { role: "system", content: "You answer Questions in IncarnaMind." },
          { role: "user", content: [{ type: "text", text: "The Mind's notes." }] },
          { role: "assistant", content: [{ type: "text", text: "An earlier Answer." }] },
          { role: "user", content: [{ type: "text", text: "The new question?" }] },
        ],
      }),
    );
    expect(measured.parts.history).toBe(
      estimateTokens("The Mind's notes.") + estimateTokens("An earlier Answer."),
    );
    expect(measured.parts.question).toBe(estimateTokens("The new question?"));
  });

  it("counts the cacheable prefix an Anthropic request marks", () => {
    const measured = measurePrompt(params());
    expect(measured.cacheable).toBeGreaterThan(measured.parts.tools);
    expect(measured.cacheable).toBeLessThanOrEqual(sumParts(measured.parts));
  });

  it("reads the last step's note as an instruction block, in the last user message", () => {
    const measured = measurePrompt(
      params({
        prompt: [
          { role: "system", content: "You answer Questions in IncarnaMind." },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "You can make no more calls, and none can record a Citation now. Write the Answer now.",
              },
            ],
          },
        ],
        tools: [],
      }),
    );
    expect(measured.instructions.map((block) => block.id)).toContain("run: the last step's note");
    expect(measured.parts.question).toBeGreaterThan(0);
  });

  it("parses the Passages a search hands", () => {
    expect(passageTexts(PASSAGES)).toEqual(["Revenue was up.", "Emissions fell."]);
  });
});

describe("the instruction blocks", () => {
  it("names the blocks a prompt carries and what each is for", () => {
    const blocks = instructionBlocks([
      "You answer Questions in IncarnaMind, a notebook.\n- Write Markdown: paragraphs.",
      "Never work out a number yourself, not even a simple one.",
    ]);
    expect(blocks.map((block) => block.id)).toEqual([
      "answer: the Answer's rules",
      "documents: calculations",
    ]);
    expect(blocks.every((block) => block.tokens > 0)).toBe(true);
  });

  it("says whether a step relied on a block: its Tool was called, or it is about the reply", () => {
    expect(blockUsed({ id: "x", capability: "calculate", tokens: 1 }, ["search_documents"])).toBe(
      "never",
    );
    expect(blockUsed({ id: "x", capability: "calculate", tokens: 1 }, ["calculate"])).toBe("yes");
    expect(blockUsed({ id: "x", capability: "reply", tokens: 1 }, [])).toBe("yes");
    expect(blockUsed({ id: "x", capability: null, tokens: 1 }, ["calculate"])).toBe(
      "not observable",
    );
  });

  it("maps a Tool's calls to the capability they exercise", () => {
    expect(capabilityOfTool("search_documents")).toBe("search");
    expect(capabilityOfTool("edit_mind")).toBe("minds");
    expect(capabilityOfTool("github__create_issue")).toBe("connectors");
    expect(capabilityOfTool("mystery_tool")).toBeNull();
  });
});

describe("the tables", () => {
  it("scales every part so the parts sum to the provider's counted input", () => {
    const parts: PromptParts = {
      ...empty(),
      instructions: 40,
      tools: 30,
      history: 20,
      question: 10,
    };
    const rows = tokenRows([
      request({ parts, counted: { input: 150, cached: 60, output: 20 } }),
      request({ parts, counted: { input: 50, cached: 0, output: 10 } }),
    ]);
    const answers = rows.find((row) => row.kind === "Answers");
    expect(answers?.requests).toBe(2);
    expect(answers?.input).toBe(100);
    expect(answers?.cached).toBe(30);
    expect(answers?.cachedShare).toBeCloseTo(0.3);
    expect(answers?.output).toBe(15);
    expect(answers?.parts?.instructions).toBeCloseTo(40);
    expect(answers?.parts?.tools).toBeCloseTo(30);
    expect(answers?.parts?.history).toBeCloseTo(20);
    expect(answers?.parts?.question).toBeCloseTo(10);
    expect(sumParts(answers?.parts ?? empty())).toBeCloseTo(100);
  });

  it("uses the flow a request came from, and puts a written check under Checks", () => {
    expect(kindOf(request({ flow: "question" }))).toBe("Answers");
    expect(kindOf(request({ flow: "assistant-write" }))).toBe("Assistant runs");
    expect(kindOf(request({ flow: "edit-with-ai" }))).toBe("Edits");
    expect(kindOf(request({ flow: "find-support" }))).toBe("Checks");
    expect(
      kindOf(request({ flow: "question", tag: { flow: "question", step: "written-check" } })),
    ).toBe("Checks");
    expect(kindOf(request({ flow: "suggestion" }))).toBe("Other flows");
  });

  it("lists each Tool a kind offers, and how often it was called", () => {
    const tools = [toolSize("search_documents", 30, 20), toolSize("calculate", 10, 8)];
    const uses = toolUses([
      request({ tools, called: ["search_documents"] }),
      request({ tools, called: [] }),
    ]);
    expect(uses.find((each) => each.name === "search_documents")).toMatchObject({
      kind: "Answers",
      offered: 2,
      called: 1,
    });
    expect(uses.find((each) => each.name === "calculate")).toMatchObject({
      offered: 2,
      called: 0,
    });
    expect(uses[0]?.name).toBe("calculate");
  });

  it("marks an instruction block no step used, and leaves the others alone", () => {
    const table = instructionUseTable([
      request({
        instructions: [
          { id: "documents: calculations", capability: "calculate", tokens: 50 },
          { id: "answer: the Answer's rules", capability: "reply", tokens: 200 },
        ],
        called: ["search_documents"],
      }),
    ]);
    expect(table).toContain("**no** (its Tool was never called)");
    expect(table).toContain("| yes |");
    const used = instructionUseTable([
      request({
        instructions: [{ id: "documents: calculations", capability: "calculate", tokens: 50 }],
        called: ["calculate"],
      }),
    ]);
    expect(used).not.toContain("**no** (its Tool was never called)");
  });

  it("names Call help as a kind with no flow", () => {
    expect(kindTable([request()])).toContain("| Call help |");
    expect(kindTable([request()])).toContain("needs a Meeting's recording");
  });
});

describe("the auditor", () => {
  it("records what the provider counted and the Tools a reply called", async () => {
    const model = scriptedModel(() => ({
      text: "The Answer.",
      calls: [{ tool: "search_documents", input: { query: "emissions" } }],
    }));
    const audit = createTokenAuditor();
    const create = audit.chatModels(() => model);
    const spec: ChatModelSpec = {
      kind: "anthropic",
      baseUrl: null,
      apiKey: "test",
      modelId: "claude-haiku-5-5",
    };
    audit.begin({ flow: "question", model: "anthropic/claude-haiku-5-5", language: "en" });
    const answer = streamText({
      model: create(spec),
      instructions: "You answer Questions in IncarnaMind.",
      prompt: "What does the report say?",
      tools: {
        search_documents: tool({
          description: "Search the User's Documents.",
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
          execute: async () => "Passages.",
        }),
      },
    });
    expect(await answer.text).toContain("The Answer.");
    const requests = audit.end();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.outcome).toBe("finished");
    expect(requests[0]?.counted).toEqual({ input: 5, cached: null, output: 1 });
    expect(requests[0]?.called).toEqual(["search_documents"]);
    expect(requests[0]?.tools.map((each) => each.name)).toEqual(["search_documents"]);
    expect(requests[0]?.instructions.map((each) => each.id)).toContain(
      "answer: the Answer's rules",
    );
  });
});

describe("a kind whose flows did not run", () => {
  it("marks it not run, never as zeros", () => {
    const report = tokenReport([
      {
        flow: "question",
        model: "anthropic/claude-haiku-5-5",
        language: "en",
        requests: [request()],
      },
    ]);
    expect(report).toContain("| Answers | question | 1 |");
    expect(report).toContain(
      "| Assistant runs | assistant-write, assistant-edit, assistant-longer | not run (flow not selected) |",
    );
    expect(report).toContain("| Edits | edit-with-ai | not run (flow not selected) |");
    expect(report).toContain("| Checks | find-support, check-mind | not run (flow not selected) |");
    expect(report).toContain(
      "| Other flows | suggestion, comparison, research | not run (flow not selected) |",
    );
    expect(report).not.toMatch(/\| Edits \| edit-with-ai \| 0 \|/);
    expect(report).not.toMatch(/\| Other flows \|[^|]*\| 0 \|/);
  });

  it("still shows a kind whose flow ran but called no model as 0 requests", () => {
    const report = tokenReport([
      {
        flow: "suggestion",
        model: "anthropic/claude-haiku-5-5",
        language: "en",
        requests: [],
      },
    ]);
    expect(report).toContain("| Other flows | suggestion, comparison, research | 0 |");
    expect(report).toContain("| Answers | question | not run (flow not selected) |");
  });

  it("measures a kind whose requests a run made, though none of its own flows ran", () => {
    const write = request({ flow: "assistant-write" });
    const check = request({
      flow: "assistant-write",
      tag: { flow: "question", step: "written-check" },
      parts: {
        ...empty(),
        instructions: 20,
        tools: 40,
        passages: 50,
        passageNotes: 10,
        history: 5,
        question: 5,
      },
      counted: { input: 140, cached: 60, output: 10 },
    });
    const report = tokenReport([
      {
        flow: "assistant-write",
        model: "anthropic/claude-haiku-5-5",
        language: "en",
        requests: [write, check],
      },
    ]);
    expect(report).toContain(
      "| Assistant runs | assistant-write, assistant-edit, assistant-longer | 1 |",
    );
    expect(report).toContain("| Checks | find-support, check-mind | 1 |");
    expect(report).not.toContain("| Checks | find-support, check-mind | not run");
    expect(report).toContain("| 140 | 60 (43%) | 10 |");
    expect(report).toContain("| Answers | question | not run (flow not selected) |");
    expect(report).toContain("| Edits | edit-with-ai | not run (flow not selected) |");
    expect(report).toContain(
      "| Other flows | suggestion, comparison, research | not run (flow not selected) |",
    );
  });
});

describe("a provider count that is not usable", () => {
  const spec: ChatModelSpec = {
    kind: "anthropic",
    baseUrl: null,
    apiKey: "test",
    modelId: "claude-haiku-5-5",
  };
  const params: CallToMeasure = {
    prompt: [{ role: "user", content: [{ type: "text", text: "What does it say?" }] }],
  };
  const usageOf = (input?: number, cached?: number, output?: number) => ({
    inputTokens: { total: input, noCache: undefined, cacheRead: cached, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  });
  type Part =
    | {
        type: "finish";
        finishReason: { unified: "stop"; raw: undefined };
        usage: ReturnType<typeof usageOf>;
      }
    | { type: "error"; error: unknown };
  const generated = (usage: ReturnType<typeof usageOf>) =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "An answer." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
  const streamOf = (parts: readonly Part[]) =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    });
  const asV4 = (model: ChatLanguageModel) => {
    if (model.specificationVersion !== "v4") throw new Error("The audit wraps a v4 model.");
    return model;
  };
  const audited = (model: MockLanguageModelV4) => {
    const audit = createTokenAuditor();
    const create = audit.chatModels(() => model);
    audit.begin({ flow: "question", model: "anthropic/claude-haiku-5-5", language: "en" });
    return { audit, model: asV4(create(spec)) };
  };
  const consumed = async (stream: ReadableStream<unknown>) => {
    const reader = stream.getReader();
    const parts: unknown[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    return parts;
  };

  it("keeps a missing cached or output count unknown, never zero", async () => {
    const { audit, model } = audited(generated(usageOf(100, undefined, undefined)));
    await generateText({ model, instructions: "Answer in English.", prompt: "What does it say?" });
    const requests = audit.end();
    const row = tokenRows(requests, new Set(["question"]))[0];
    expect(row?.input).toBe(100);
    expect(row?.cached).toBeNull();
    expect(row?.cachedShare).toBeNull();
    expect(row?.output).toBeNull();
    const table = kindTable(requests, new Set(["question"]));
    expect(table).not.toContain("0 (0%)");
    expect(table).toContain("–");
  });

  it("leaves a group's cached count unknown when one request's is", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "An answer." }],
        finishReason: { unified: "stop", raw: undefined },
        usage: call++ === 0 ? usageOf(100, 40, 7) : usageOf(100, undefined, 7),
        warnings: [],
      }),
    });
    const { audit, model: wrapped } = audited(model);
    for (let each = 0; each < 2; each++) {
      await generateText({ model: wrapped, instructions: "Answer.", prompt: "What does it say?" });
    }
    const row = tokenRows(audit.end())[0];
    expect(row?.requests).toBe(2);
    expect(row?.cached).toBeNull();
    expect(row?.cachedShare).toBeNull();
  });

  it("rejects a malformed usage: no zero row and no NaN", async () => {
    const { audit, model } = audited(generated(usageOf(Number.NaN, 40, 7)));
    await generateText({ model, instructions: "Answer.", prompt: "What does it say?" });
    const requests = audit.end();
    expect(requests[0]?.counted).toBeNull();
    const row = tokenRows(requests, new Set(["question"]))[0];
    expect(row?.calls).toBe(1);
    expect(row?.requests).toBe(0);
    expect(row?.parts).toBeNull();
    const table = kindTable(requests, new Set(["question"]));
    expect(table).toContain("1 (0 counted)");
    expect(table).not.toContain("NaN");
    expect(table).not.toContain("| 0 |");
  });

  it("keeps a normal finish without a usable usage finished", async () => {
    const { audit, model } = audited(
      streamOf([
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: usageOf(undefined, 40, 7),
        },
      ]),
    );
    const parts = await consumed((await model.doStream(params)).stream);
    expect(parts).toHaveLength(1);
    const requests = audit.end();
    expect(requests[0]?.outcome).toBe("finished");
    expect(requests[0]?.counted).toBeNull();
  });

  it("records an AbortError while reading as stopped, keeping the error", async () => {
    const error = new DOMException("User stopped", "AbortError");
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({ pull: (controller) => controller.error(error) }),
      }),
    });
    const { audit, model: wrapped } = audited(model);
    await expect(consumed((await wrapped.doStream(params)).stream)).rejects.toBe(error);
    expect(audit.end()[0]?.outcome).toBe("stopped");
  });

  it("keeps an error part's stream failed after it closes, and its part", async () => {
    const error = new Error("provider failed");
    const { audit, model } = audited(streamOf([{ type: "error", error }]));
    const parts = await consumed((await model.doStream(params)).stream);
    expect(parts).toEqual([{ type: "error", error }]);
    expect(audit.end()[0]?.outcome).toBe("failed");
  });

  it("records a cancelled read as stopped and forwards its reason", async () => {
    const reason = { stopped: "by User" };
    let received: unknown;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          cancel(value) {
            received = value;
          },
        }),
      }),
    });
    const { audit, model: wrapped } = audited(model);
    const reader = (await wrapped.doStream(params)).stream.getReader();
    await reader.cancel(reason);
    expect(received).toBe(reason);
    expect(audit.end()[0]?.outcome).toBe("stopped");
  });
});
