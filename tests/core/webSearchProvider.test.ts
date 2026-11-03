/**
 * The provider's own web search (#128): the pages it found, as each provider
 * reports them, and which Questions are offered web search at all.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { CutShortError, endsAtLimit } from "../../src/core/providers/outputLimits";
import { searchWeb } from "../../src/core/providers/webSearch";
import { asksForWeb } from "../../src/core/tools/web/intent";
import { translate } from "../../src/shared/i18n";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const USAGE = {
  inputTokens: { total: 8_000, noCache: 8_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 60, text: 60, reasoning: undefined },
};

/** A model whose one reply streams `parts`, then finishes; `cut`: at its output limit. */
function replying(parts: StreamPart[], cut = false) {
  return new MockLanguageModelV4({
    doStream: async () => {
      const queue: StreamPart[] = [
        { type: "stream-start", warnings: [] },
        ...parts,
        {
          type: "finish",
          finishReason: { unified: cut ? "length" : "stop", raw: undefined },
          usage: USAGE,
        },
      ];
      return {
        stream: new ReadableStream<StreamPart>({
          pull(controller) {
            const part = queue.shift();
            if (part) controller.enqueue(part);
            else controller.close();
          },
        }),
      };
    },
  });
}

const searchCall: StreamPart = {
  type: "tool-call",
  toolCallId: "ws_1",
  toolName: "web_search",
  input: "{}",
  providerExecuted: true,
};

describe("The provider's web search", () => {
  test("OpenAI's: every source its search consulted, with the titles its citations give, each once", async () => {
    const model = replying([
      searchCall,
      {
        type: "tool-result",
        toolCallId: "ws_1",
        toolName: "web_search",
        result: {
          action: { type: "search", query: "park cooling" },
          sources: [
            { type: "url", url: "https://a.example/parks#results" },
            { type: "url", url: "https://b.example/heat" },
            { type: "url", url: "https://a.example/parks" },
            { type: "api", name: "oai-weather" },
            { type: "url", url: "ftp://files.example/parks.txt" },
          ],
        },
      },
      {
        type: "source",
        sourceType: "url",
        id: "s1",
        url: "https://b.example/heat",
        title: "Heat in cities",
      },
    ]);

    const pages = await searchWeb(model, "openai", "park cooling", AbortSignal.timeout(5_000));

    expect(pages).toEqual([
      { url: "https://a.example/parks", title: null, age: null },
      { url: "https://b.example/heat", title: "Heat in cities", age: null },
    ]);
    const request = model.doStreamCalls[0];
    expect(request?.toolChoice).toEqual({ type: "tool", toolName: "web_search" });
    expect(request?.tools).toEqual([
      expect.objectContaining({ type: "provider", id: "openai.web_search", name: "web_search" }),
    ]);
    expect(request?.providerOptions).toMatchObject({ openai: { maxToolCalls: 1 } });
  });

  test("Anthropic's: its results with their titles and ages, ten at most", async () => {
    const results = Array.from({ length: 12 }, (_, at) => ({
      url: `https://news.example/${at}`,
      title: `Story ${at}`,
      pageAge: `${at} days ago`,
    }));
    const model = replying([
      searchCall,
      { type: "tool-result", toolCallId: "ws_1", toolName: "web_search", result: results },
    ]);

    const pages = await searchWeb(model, "anthropic", "news", AbortSignal.timeout(5_000));

    expect(pages).toHaveLength(10);
    expect(pages[0]).toEqual({
      url: "https://news.example/0",
      title: "Story 0",
      age: "0 days ago",
    });
    expect(model.doStreamCalls[0]?.tools).toEqual([
      expect.objectContaining({
        type: "provider",
        id: "anthropic.web_search_20250305",
        args: { maxUses: 1 },
      }),
    ]);
  });

  test("a search that fails, or a provider with no web search, says so", async () => {
    const failing = replying([
      searchCall,
      {
        type: "tool-result",
        toolCallId: "ws_1",
        toolName: "web_search",
        isError: true,
        result: { type: "web_search_tool_result_error", errorCode: "too_many_requests" },
      },
    ]);

    await expect(
      searchWeb(failing, "anthropic", "news", AbortSignal.timeout(5_000)),
    ).rejects.toThrow(/web search failed/);
    await expect(
      searchWeb(replying([]), "deepseek", "news", AbortSignal.timeout(5_000)),
    ).rejects.toThrow("deepseek has no web search of its own.");
  });

  // protects=a reply cut at its limit before the search came back fails in words, not as a search that found nothing, while one cut after it keeps the pages it found; fails_when=a cut before the search returns no pages and no problem (#2275).
  test("cut at its limit, it keeps the pages found before the cut, and fails when there were none", async () => {
    const results = [{ url: "https://news.example/0", title: "Story 0", pageAge: "today" }];
    const after = replying(
      [
        searchCall,
        { type: "tool-result", toolCallId: "ws_1", toolName: "web_search", result: results },
      ],
      true,
    );

    expect(
      await searchWeb(endsAtLimit(after), "anthropic", "news", AbortSignal.timeout(5_000)),
    ).toEqual([{ url: "https://news.example/0", title: "Story 0", age: "today" }]);
    await expect(
      searchWeb(endsAtLimit(replying([], true)), "anthropic", "news", AbortSignal.timeout(5_000)),
    ).rejects.toBeInstanceOf(CutShortError);
    // A search that fails says so on its card.
    expect(translate("en", "web.call.searchFailed", { query: "news" })).toBe(
      "Couldn’t search the web for “news”",
    );
    expect(translate("zh-CN", "web.call.searchFailed", { query: "news" })).toBe(
      "无法联网搜索“news”",
    );
  });
});

describe("Which Questions are offered web search", () => {
  test.each([
    "Search the web for the latest tide tables",
    "What do websites say about cooling parks?",
    "Look it up online",
    "Google the new lease rules",
    "上网查一下最新的潮汐表",
    "联网搜索城市公园降温",
    "网上有什么相关报道？",
  ])("“%s” is", (question) => expect(asksForWeb(question)).toBe(true));

  test.each([
    "How did tea reach Europe?",
    "What does the lease say about notice?",
    "Summarise the webinar notes",
    "合同里关于通知期是怎么写的？",
  ])("“%s” isn't", (question) => expect(asksForWeb(question)).toBe(false));
});
