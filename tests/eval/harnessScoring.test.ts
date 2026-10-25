/**
 * The harness bake-off's scoring (eval/harness): an outside harness's
 * Citation tokens read as an Answer's markers, the wrong figures a reply
 * catches, the sign test, and the adapter that lets Codex reach Claude.
 */
import { describe, expect, it } from "vitest";
import { caughtFigures, HARNESS_CASES, POINTS_BACK } from "../../eval/harness/cases";
import { ownUsage } from "../../eval/harness/codex";
import {
  flatTools,
  responsesEvents,
  toMessagesRequest,
  toolNames,
  toResponsesOutput,
} from "../../eval/harness/modelProxy";
import { type MintedCitation, signTestP, withMarkers } from "../../eval/harness/score";
import { HARNESS_INSTRUCTIONS, HARNESS_SKILL, HARNESS_TOOLS } from "../../eval/harness/wording";

const minted = (token: string, pairingId: string): MintedCitation => ({
  token,
  pairingId,
  documentId: `doc-${token}`,
  documentName: "Q3 results",
  contentHash: "hash",
  quote: `quote ${token}`,
});

describe("the harness bake-off", () => {
  it("asks 30 requests, half in Chinese, each once", () => {
    expect(HARNESS_CASES).toHaveLength(30);
    expect(HARNESS_CASES.filter((each) => each.language === "zh-CN")).toHaveLength(15);
    expect(new Set(HARNESS_CASES.map((each) => each.id)).size).toBe(30);
    expect(HARNESS_CASES.every((each) => each.mind === null)).toBe(true);
  });

  it("reads a reply's tokens as markers, and a token minted for another pairing as one without a Citation", () => {
    const known = new Map([
      ["aaaa2222", minted("aaaa2222", "mine")],
      ["bbbb3333", minted("bbbb3333", "theirs")],
    ]);
    const marked = withMarkers(
      "Margin was 38.6% [cite:aaaa2222]. Again [cite:aaaa2222], and [cite:bbbb3333] and [cite:zzzz9999].",
      "mine",
      (token) => known.get(token) ?? null,
    );
    expect(marked.text).toBe("Margin was 38.6% [^1]. Again [^1], and [^2] and [^3].");
    expect(marked.citations).toEqual([
      {
        marker: 1,
        documentId: "doc-aaaa2222",
        documentName: "Q3 results",
        contentHash: "hash",
        quote: "quote aaaa2222",
      },
    ]);
    expect(marked.invented).toEqual(["bbbb3333", "zzzz9999"]);
  });

  it("catches a wrong figure only when the reply gives the Documents' figure", () => {
    const leverage =
      HARNESS_CASES.find((each) => each.id === "figures-leverage")?.wrongFigures ?? [];
    expect(caughtFigures("It was 3.1 times, under the 3.5:1 limit.", leverage)).toEqual([
      true,
      true,
    ]);
    expect(caughtFigures("Yes: 3.4 times is inside 4.0 times.", leverage)).toEqual([false, false]);
    expect(caughtFigures("Clause 13.1 and 3.15 times say nothing.", leverage)).toEqual([
      false,
      false,
    ]);
    const margin = HARNESS_CASES.find((each) => each.id === "figures-draft-zh")?.wrongFigures ?? [];
    expect(caughtFigures("毛利率为 38.6%，不是 36.8%。", margin)).toEqual([true]);
  });

  it("finds #1172's pointers to an earlier turn", () => {
    expect(POINTS_BACK.test("Notice and leave are as noted above.")).toBe(true);
    expect(POINTS_BACK.test("居家办公的规定见上一条回答。")).toBe(true);
    expect(POINTS_BACK.test("The contract runs for three years.")).toBe(false);
  });

  it("tests signs one-sided", () => {
    expect(signTestP(6, 6)).toBeCloseTo(1 / 64);
    expect(signTestP(7, 8)).toBeCloseTo(9 / 256);
    expect(signTestP(0, 0)).toBe(1);
  });

  it("tells the outside harnesses nothing of the Tools they don't get", () => {
    for (const text of [HARNESS_INSTRUCTIONS, HARNESS_SKILL]) {
      expect(text).not.toMatch(/`ask`|`show_citation`/);
      expect(text).toContain("`search`");
    }
    expect(HARNESS_TOOLS).not.toContain("ask");
    expect(HARNESS_SKILL).not.toMatch(/^---/);
  });

  describe("the adapter from the Responses API to Claude's", () => {
    const body = {
      model: "claude-sonnet-5-5",
      instructions: "Base instructions.",
      reasoning: { effort: "low" },
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [
        {
          type: "namespace",
          name: "mcp__incarnamind",
          description: "The server's instructions.",
          tools: [
            {
              type: "function",
              name: "search",
              description: "Search.",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
        {
          type: "function",
          name: "request_user_input",
          description: "Ask.",
          parameters: { type: "object" },
        },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Developer." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What was the margin?" }],
        },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: Buffer.from(
            JSON.stringify([{ type: "thinking", thinking: "Look it up.", signature: "sig" }]),
          ).toString("base64"),
        },
        {
          type: "function_call",
          call_id: "toolu_1",
          name: "search",
          namespace: "mcp__incarnamind",
          arguments: '{"query":"gross margin"}',
        },
        { type: "function_call_output", call_id: "toolu_1", output: '{"passages":[]}' },
      ],
    };

    it("sends the instructions, the developer's and the server's words as the system prompt, and each Tool by one name", () => {
      const request = toMessagesRequest(body);
      expect(request.system).toEqual([
        { type: "text", text: "Base instructions." },
        { type: "text", text: "Developer." },
        {
          type: "text",
          text: "The Tools named mcp__incarnamind__…:\nThe server's instructions.",
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(request.tools).toEqual([
        {
          name: "mcp__incarnamind__search",
          description: "Search.",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "request_user_input",
          description: "Ask.",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(request.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "What was the margin?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Look it up.", signature: "sig" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__incarnamind__search",
              input: { query: "gross margin" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: '{"passages":[]}',
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]);
      expect(request.output_config).toEqual({ effort: "low" });
    });

    it("gives Claude's reply back as reasoning, a namespaced call with its arguments, and text", () => {
      const items = toResponsesOutput(
        {
          content: [
            { type: "thinking", thinking: "Search again.", signature: "sig2" },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "mcp__incarnamind__search",
              input: { query: "38.6%" },
            },
          ],
        },
        flatTools(body),
      );
      expect(items).toEqual([
        {
          type: "reasoning",
          id: "rs_0",
          summary: [{ type: "summary_text", text: "Search again." }],
          encrypted_content: Buffer.from(
            JSON.stringify([{ type: "thinking", thinking: "Search again.", signature: "sig2" }]),
          ).toString("base64"),
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "toolu_2",
          name: "search",
          namespace: "mcp__incarnamind",
          arguments: '{"query":"38.6%"}',
          status: "completed",
        },
      ]);
      const events = responsesEvents("resp_1", "claude-sonnet-5-5", items, {
        inputTokens: 100,
        cachedInputTokens: 60,
        cacheWriteTokens: 30,
        outputTokens: 20,
      });
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.output_item.added",
        "response.output_item.done",
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(events.at(-1)).toMatchObject({
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens: 20,
          },
        },
      });
    });

    it("refuses an input item it doesn't know, rather than drop it", () => {
      expect(() => toMessagesRequest({ input: [{ type: "local_shell_call" }] })).toThrow(
        /local_shell_call/,
      );
    });

    it("records the Tools Code Mode offers in an additional_tools item, not in tools", () => {
      const body = {
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  { type: "custom", name: "exec" },
                  { type: "function", name: "wait" },
                ],
              },
            ],
          },
          { type: "message", role: "user", content: "Hi" },
        ],
      };
      expect(toolNames(body)).toEqual(["functions__exec", "functions__wait"]);
    });
  });

  describe("Codex's usage", () => {
    const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens: 0,
      outputTokens,
    });

    it("counts a resumed turn's own tokens, not the thread's running total again", () => {
      const first = ownUsage(usage(59_401, 46_426, 312), usage(0, 0, 0));
      expect(first.usage).toEqual(usage(59_401, 46_426, 312));
      const second = ownUsage(usage(116_310, 101_049, 815), first.thread);
      expect(second.usage).toEqual(usage(56_909, 54_623, 503));
    });

    it("counts nothing for a turn that ended before Codex reported its usage", () => {
      const thread = usage(59_401, 46_426, 312);
      expect(ownUsage(usage(0, 0, 0), thread)).toEqual({ usage: usage(0, 0, 0), thread });
    });
  });
});
