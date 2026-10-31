import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type {
  CapturePage,
  ConsentRequest,
  Core,
  CoreAdapters,
  PageCaptureRequest,
  Reranker,
  SuggestionOutcome,
  SuggestionRequest,
} from "../../src/core";
import { isStrongMatch, queryOf } from "../../src/core/suggestions";
import {
  continuationOf,
  numbersBacked,
  readReply,
  suggestionPrompt,
  unfinishedSentence,
} from "../../src/core/suggestions/prompt";
import { setUpWithDocuments } from "../helpers/citations";
import {
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  saveProviderUnasked,
  startCore,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "The Moon raises two bulges of water on the Earth.",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const BREAD = {
  name: "Bread.md",
  contents: "# Bread\n\nSourdough bread needs a starter fed with flour and water every day.",
};

const CHAOZHOU = {
  name: "潮汐.md",
  contents:
    "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。\n\n港口每年公布高潮时刻表。",
};

/** What the model gives back for a suggestion, as JSON text. */
interface Reply {
  text: string;
  passage: string;
  quote: string;
}

const NO_USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Prompt = MockLanguageModelV4["doGenerateCalls"][number]["prompt"];

/** What the User's messages of a request say. */
const userText = (prompt: Prompt) =>
  prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");

/** Whether a request asks for a suggestion: automatic tagging asks the same model, with no paragraph. */
const asksForSuggestion = (prompt: Prompt) => userText(prompt).includes("<paragraph>");

/** The requests for suggestions a model was sent. */
const suggestionCalls = (model: MockLanguageModelV4) =>
  model.doGenerateCalls.filter((call) => asksForSuggestion(call.prompt));

const replyWith = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: NO_USAGE,
  warnings: [],
});

/** A model that replies to each suggestion request with `reply` (or what it makes of the prompt). */
function suggestingModel(reply: Reply | ((prompt: string) => Reply)): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      if (!asksForSuggestion(prompt)) return replyWith({ tags: [] });
      const text = userText(prompt);
      return replyWith(typeof reply === "function" ? reply(text) : reply);
    },
  });
}

/** A model that never answers a suggestion request: it must be cancelled. `started` hears each. */
function hangingModel(started: () => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt, abortSignal }) => {
      if (!asksForSuggestion(prompt)) return replyWith({ tags: [] });
      started();
      return new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () =>
          reject(new DOMException("The request was aborted.", "AbortError")),
        );
      });
    },
  });
}

const SPRING: Reply = {
  text: "They come at new moon and at full moon, when the Sun and the Moon pull together.",
  passage: "P1",
  quote: "Spring tides happen at new moon and at full moon",
};

/** A paragraph about tides that the fixture supports, ending mid-thought. */
const ABOUT_TIDES =
  "The harbour survey depends on the tides. Twice a month the spring tides are highest, at new moon and full moon, and the";

let requests = 0;
const requestFor = (
  mindId: string,
  paragraph: string,
  scope: SuggestionRequest["scope"] = { folderIds: [], tagIds: [], documentIds: [] },
): SuggestionRequest => ({ requestId: `request-${++requests}`, mindId, paragraph, scope });

/** A core with a local model (no consent needed), the files as Documents, suggestions on, and a Mind. */
async function setUp(
  model: MockLanguageModelV4,
  files = [TIDES, BREAD],
  overrides: Partial<CoreAdapters> = {},
) {
  const set = await setUpWithDocuments(model, files, overrides);
  await set.core.updateSettings({ user: { suggestWhileWriting: true } });
  return set;
}

const suggestionOf = (outcome: SuggestionOutcome) => {
  if (outcome.kind !== "suggestion") throw new Error(`No suggestion: ${outcome.kind}`);
  return outcome.suggestion;
};

describe("suggestions as the User writes", () => {
  test("are off until the User turns them on, and a pause then says whether the scope has Documents to suggest from", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind } = await setUpWithDocuments(model, [TIDES]);
    expect((await core.getSettings()).user.suggestWhileWriting).toBe(false);

    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({
      kind: "off",
      scopeHasDocuments: true,
    });
    const noDocuments = { folderIds: [], tagIds: [], documentIds: ["not-a-document"] };
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES, noDocuments))).toEqual({
      kind: "off",
      scopeHasDocuments: false,
    });
    expect(suggestionCalls(model)).toEqual([]);
  });

  test("a paragraph its Documents support gets a suggestion, with a Citation whose quote is found", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind, documents } = await setUp(model);

    const suggestion = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));

    expect(suggestion.text).toBe(SPRING.text);
    expect(suggestion.citation).toMatchObject({
      documentId: documents.find((each) => each.name === "Tides")?.id,
      documentName: "Tides",
      quote: SPRING.quote,
      check: "found",
      checkReason: null,
    });
    // The model was given the paragraph and the Passages found, and asked for one short sentence.
    const [call] = suggestionCalls(model);
    const sent = JSON.stringify(call?.prompt);
    expect(sent).toContain("Twice a month the spring tides are highest");
    expect(sent).toContain('<passage id=\\"P1\\" document=\\"Tides\\"');
    expect(call?.maxOutputTokens).toBeLessThanOrEqual(400);
    expect(await core.getSuggestionStatus()).toEqual({
      today: { shown: 1, accepted: 0 },
      paused: null,
    });
  });

  test("a Document the User keeps as their own workings is never suggested from or cited, until they cite it again", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind, documents } = await setUp(model);
    const tides = documents.find((each) => each.name === "Tides");
    await core.setNotCited(tides?.id ?? "", true);

    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    expect(suggestionCalls(model)).toEqual([]);

    await core.setNotCited(tides?.id ?? "", false);
    const suggestion = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));
    expect(suggestion.citation.documentName).toBe("Tides");
  });

  test("a renamed Document is named as it is now, to the model and in the Citation", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind, documents } = await setUp(model);
    const tides = documents.find((each) => each.name === "Tides");
    await core.renameDocument(tides?.id ?? "", "Tides of the coast");

    const suggestion = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));

    expect(suggestion.citation.documentName).toBe("Tides of the coast");
    const [call] = suggestionCalls(model);
    expect(JSON.stringify(call?.prompt)).toContain('document=\\"Tides of the coast\\"');
  });

  test("a Chinese paragraph gets a Chinese suggestion from a Chinese Document", async () => {
    const model = suggestingModel({
      text: "这时太阳和月亮的引力叠加在一起。",
      passage: "P1",
      quote: "这时太阳和月亮的引力叠加在一起",
    });
    const { core, mind } = await setUp(model, [CHAOZHOU]);

    const suggestion = suggestionOf(
      await core.suggestNext(
        requestFor(
          mind.id,
          "港口测量要看潮汐的规律，工作人员记录每天的水位变化。每个月有两次大潮出现在新月和满月前后，",
        ),
      ),
    );

    expect(suggestion.text).toBe("这时太阳和月亮的引力叠加在一起。");
    expect(suggestion.citation).toMatchObject({ documentName: "潮汐", check: "found" });
  });

  test("with a reranker, its score says whether the Documents support the paragraph, whatever words they share", async () => {
    // Scores like the built-in model's: the tides Passage answers what is being written; bread doesn't.
    const reranker: Reranker = async (query, candidates) =>
      candidates.map((candidate) => ({
        ...candidate,
        score: /tides/.test(query) && candidate.text.includes("Spring tides") ? 0.9 : 0.02,
      }));
    const model = suggestingModel(SPRING);
    const { core, mind } = await setUp(model, [TIDES, BREAD], { reranker });

    expect(suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).text).toBe(
      SPRING.text,
    );
    // Many words in common, but the reranker finds it no answer: nothing is asked.
    expect(
      await core.suggestNext(
        requestFor(
          mind.id,
          "Sourdough bread needs a starter fed with flour and water, every day, by",
        ),
      ),
    ).toEqual({ kind: "none" });
    expect(suggestionCalls(model)).toHaveLength(1);
  });

  test("weak or no support sends nothing to the model", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind } = await setUp(model);

    // Nothing in the Documents is about it.
    expect(
      await core.suggestNext(
        requestFor(mind.id, "We spent the afternoon knitting scarves from grey wool by the fire."),
      ),
    ).toEqual({ kind: "none" });
    // One word in common isn't support.
    expect(
      await core.suggestNext(
        requestFor(
          mind.id,
          "My grandmother sang old songs on the radio while she baked bread for the village.",
        ),
      ),
    ).toEqual({ kind: "none" });
    // Too short to tell.
    expect(await core.suggestNext(requestFor(mind.id, "Spring tides"))).toEqual({ kind: "none" });
    expect(suggestionCalls(model)).toEqual([]);
  });

  test("a quote the check doesn't find, a Passage it wasn't given, or a repeat of the paragraph, shows nothing", async () => {
    let reply: Reply = { ...SPRING, quote: "Spring tides happen every Tuesday at noon" };
    const model = suggestingModel(() => reply);
    const { core, mind } = await setUp(model);

    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    reply = { ...SPRING, passage: "P9" };
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    reply = { ...SPRING, text: "the spring tides are highest" };
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    reply = { text: "", passage: "", quote: "" };
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    expect(suggestionCalls(model)).toHaveLength(4);
    expect((await core.getSuggestionStatus()).today.shown).toBe(0);
  });

  test("a quote from another Passage than the one named is cited where it is found", async () => {
    const HARBOUR = {
      name: "Harbour.md",
      contents: "# Harbour\n\nThe harbour survey records the height of high water every day.",
    };
    let shown = 0;
    const model = suggestingModel((prompt) => {
      // Names a Passage the quote isn't in.
      const passages = [...prompt.matchAll(/<passage id="(P\d)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)];
      shown = passages.length;
      const other = passages.find((match) => !match[2]?.includes("Spring tides"));
      return { ...SPRING, passage: other?.[1] ?? "P1" };
    });
    const { core, mind } = await setUp(model, [TIDES, HARBOUR]);

    const suggestion = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));

    expect(shown).toBeGreaterThan(1);
    expect(suggestion.citation).toMatchObject({ documentName: "Tides", check: "found" });
  });

  test("a cancelled request, or one a newer request replaced, never gives a suggestion", async () => {
    let started = () => {};
    const model = hangingModel(() => started());
    const { core, mind } = await setUp(model);
    const asked = () => new Promise<void>((resolve) => (started = resolve));

    const first = requestFor(mind.id, ABOUT_TIDES);
    let waiting = asked();
    const firstOutcome = core.suggestNext(first);
    await waiting;
    await core.cancelSuggestion(first.requestId);
    expect(await firstOutcome).toEqual({ kind: "none" });

    waiting = asked();
    const second = core.suggestNext(requestFor(mind.id, ABOUT_TIDES));
    await waiting;
    const third = core.suggestNext(requestFor(mind.id, "Too short."));
    expect(await second).toEqual({ kind: "none" });
    expect(await third).toEqual({ kind: "none" });
    expect(suggestionCalls(model).map((call) => call.abortSignal?.aborted)).toEqual([true, true]);
  });

  test("accepting a suggestion counts it for today and says so, for the record of AI use", async () => {
    const model = suggestingModel(SPRING);
    const { core, mind, models } = await setUp(model);
    const suggestion = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));
    const accepted = nextEvent(core, "suggestion.accepted");

    await core.acceptSuggestion({ suggestionId: suggestion.suggestionId, characters: 42 });

    expect(await accepted).toMatchObject({
      suggestionId: suggestion.suggestionId,
      mindId: mind.id,
      modelId: "local-model",
      characters: 42,
    });
    expect(models.specs.at(-1)?.modelId).toBe("local-model");
    expect((await core.getSuggestionStatus()).today).toEqual({ shown: 1, accepted: 1 });
    // Once only, and never one that wasn't given.
    await core.acceptSuggestion({ suggestionId: suggestion.suggestionId, characters: 42 });
    await core.acceptSuggestion({ suggestionId: "made-up", characters: 1 });
    expect((await core.getSuggestionStatus()).today).toEqual({ shown: 1, accepted: 1 });

    // The record of AI use heard it: one entry, with the model and the size, and no text.
    expect(await core.listAiUse(mind.id)).toMatchObject([
      { kind: "suggestion-accepted", outcome: "kept", modelId: "local-model", characters: 42 },
    ]);
  });

  test("an accepted suggestion's Citation has its cited page saved (#133)", async () => {
    const asked: PageCaptureRequest[] = [];
    const capturePage: CapturePage = async (request) => {
      asked.push(request);
      return { data: new Uint8Array([1]), type: "image/png", width: 1, height: 1, text: [] };
    };
    const { core, mind } = await setUp(suggestingModel(SPRING), [TIDES, BREAD], { capturePage });
    const shown = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));
    // Shown isn't made: its Citation is in the Mind once the User accepts it.
    expect(await core.citedPageImage(shown.citation)).toBeNull();

    await core.acceptSuggestion({ suggestionId: shown.suggestionId, characters: 42 });

    await vi.waitFor(async () => expect(await core.citedPageImage(shown.citation)).not.toBeNull());
    expect(asked).toMatchObject([{ document: { name: "Tides" }, area: { kind: "section" } }]);
  });

  test("a suggestion accepted while its cited page's drawing fails gives the page its tries back, and it is drawn again (#2161)", async () => {
    let calls = 0;
    let started = () => {};
    const drawingStarted = new Promise<void>((resolve) => (started = resolve));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const capturePage: CapturePage = async () => {
      calls++;
      if (calls === 2) {
        started();
        await held;
      }
      if (calls <= 2) throw new Error("UnknownVizError");
      return { data: new Uint8Array([1]), type: "image/png", width: 1, height: 1, text: [] };
    };
    const { core, mind, dataDir } = await setUp(suggestingModel(SPRING), [TIDES, BREAD], {
      capturePage,
    });
    const pages = () =>
      queryDatabase<{ tries: number; image_type: string | null }>(
        dataDir,
        "SELECT tries, image_type FROM cited_pages WHERE deleted_at IS NULL",
      );
    const first = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));
    await core.acceptSuggestion({ suggestionId: first.suggestionId, characters: 42 });
    await vi.waitFor(() => expect(pages()).toEqual([{ tries: 1, image_type: null }]));

    // Asked for, it is drawn again; the same Citation is accepted again while that drawing fails.
    expect(await core.citedPageImage(first.citation)).toBeNull();
    await drawingStarted;
    const second = suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES)));
    await core.acceptSuggestion({ suggestionId: second.suggestionId, characters: 42 });
    release();

    await vi.waitFor(() => expect(pages()).toEqual([{ tries: 1, image_type: "image/png" }]));
    expect(calls).toBe(3);
  });

  test("turning them off stops the request in flight and sends no more", async () => {
    let started = () => {};
    const asked = new Promise<void>((resolve) => (started = resolve));
    const model = hangingModel(() => started());
    const { core, mind } = await setUp(model);
    const outcome = core.suggestNext(requestFor(mind.id, ABOUT_TIDES));
    await asked;

    await core.updateSettings({ user: { suggestWhileWriting: false } });

    expect(await outcome).toEqual({ kind: "none" });
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toMatchObject({ kind: "off" });
    expect(suggestionCalls(model)).toHaveLength(1);
  });
});

describe("suggestions and consent", () => {
  /** The next request to allow the "suggestions" flow. */
  const nextSuggestionsConsent = (core: Core) =>
    new Promise<ConsentRequest>((resolve) => {
      const stop = core.on("consent.requested", (request) => {
        if (request.flow.id !== "suggestions") return;
        stop();
        resolve(request);
      });
    });

  /**
   * A core with a cloud chat model, a Document and a Mind. Chosen, the
   * provider's flows are allowed (ADR-0022); otherwise nothing is, as for a
   * provider chosen before that.
   */
  async function setUpCloud({ chosen = true } = {}) {
    const model = suggestingModel(SPRING);
    const models = scriptedModels(model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    const input = { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" } as const;
    const provider = chosen
      ? await core.saveChatProvider(input)
      : await saveProviderUnasked(core, input);
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const mind = await core.createMind({ title: "Tides" });
    return { core, model, models, provider, mind };
  }

  /** Turns suggestions on, answering the consent request it raises. */
  async function turnOn(core: Core, allow: boolean) {
    const requested = nextSuggestionsConsent(core);
    const turned = core.updateSettings({ user: { suggestWhileWriting: true } });
    const request = await requested;
    expect(request.flow).toMatchObject({
      id: "suggestions",
      service: { name: "OpenAI" },
      sends: ["writing", "writing-passages"],
    });
    await core.respondToConsent(request.requestId, allow);
    return (await turned).user.suggestWhileWriting;
  }

  test("with the provider chosen, turning them on asks nothing: choosing it allowed them", async () => {
    const { core, model, mind } = await setUpCloud();
    const asked = vi.fn();
    core.on("consent.requested", asked);

    const settings = await core.updateSettings({ user: { suggestWhileWriting: true } });

    expect(settings.user.suggestWhileWriting).toBe(true);
    expect(asked).not.toHaveBeenCalled();
    expect(suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).text).toBe(
      SPRING.text,
    );
    expect(suggestionCalls(model)).toHaveLength(1);
  });

  test("for a provider chosen before, turning them on asks, and declining keeps them off with nothing sent", async () => {
    const { core, model, mind } = await setUpCloud({ chosen: false });

    expect(await turnOn(core, false)).toBe(false);
    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toMatchObject({ kind: "off" });

    // Turning them on again asks again, as it is the User asking for them.
    expect(await turnOn(core, true)).toBe(true);
    expect(suggestionOf(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).text).toBe(
      SPRING.text,
    );
    expect(suggestionCalls(model)).toHaveLength(1);
  });

  test("with the flow revoked, a pause neither asks nor sends, and Settings says why", async () => {
    const { core, model, mind, provider } = await setUpCloud();
    await core.updateSettings({ user: { suggestWhileWriting: true } });
    const service = provider.service;
    if (!service) throw new Error("A cloud provider has a service.");
    await core.revokeConsent("suggestions", service.id);
    const asked = vi.fn();
    core.on("consent.requested", (request) => {
      if (request.flow.id === "suggestions") asked();
    });

    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    expect(asked).not.toHaveBeenCalled();
    expect(suggestionCalls(model)).toEqual([]);
    expect((await core.getSuggestionStatus()).paused).toEqual({ reason: "consent", service });
  });

  test("in local mode only a model on this computer is used", async () => {
    const { core, model, mind } = await setUpCloud();
    await core.updateSettings({ user: { suggestWhileWriting: true } });
    await core.setLocalOnly(true);

    expect(await core.suggestNext(requestFor(mind.id, ABOUT_TIDES))).toEqual({ kind: "none" });
    expect(suggestionCalls(model)).toEqual([]);
    expect((await core.getSuggestionStatus()).paused).toEqual({ reason: "local-mode" });
  });

  test("with a model on this computer, turning them on asks nothing", async () => {
    const model = suggestingModel(SPRING);
    const { core } = await setUpWithDocuments(model, [TIDES]);
    const asked = vi.fn();
    core.on("consent.requested", asked);

    const settings = await core.updateSettings({ user: { suggestWhileWriting: true } });

    expect(settings.user.suggestWhileWriting).toBe(true);
    expect(asked).not.toHaveBeenCalled();
    expect((await core.getSuggestionStatus()).paused).toBeNull();
  });
});

describe("what a suggestion rests on", () => {
  test("the end of the paragraph is searched: its last two sentences", () => {
    expect(queryOf("One. Two is here. Three goes on")).toBe("Two is here. Three goes on");
    expect(queryOf("第一句。第二句。第三句")).toBe("第二句。 第三句");
  });

  test("a strong match is one the reranker scores high, whatever words it shares", () => {
    const query = "the spring tides are highest at the moon";
    expect(isStrongMatch(query, { matches: [], relevance: 0.9 })).toBe(true);
    expect(isStrongMatch(query, { matches: ["spring", "tides", "moon"], relevance: 0.03 })).toBe(
      false,
    );
  });

  test("without a reranker, it holds two of the words searched and a third of them, three at most", () => {
    const query = "the spring tides are highest at the moon";
    const words = (matches: string[]) => ({ matches, relevance: null });
    expect(isStrongMatch(query, words(["spring", "tides"]))).toBe(true);
    expect(isStrongMatch(query, words(["moon"]))).toBe(false);
    const long = "survey harbour tides spring highest moon month twice records gauges levels";
    expect(isStrongMatch(long, words(["tides", "moon"]))).toBe(false);
    expect(isStrongMatch(long, words(["tides", "moon", "harbour"]))).toBe(true);
    // Single letters and characters say nothing.
    expect(isStrongMatch("城市 绿地 多 少 降温", words(["多", "少", "城市"]))).toBe(false);
  });

  test("every number in a suggestion is in its quote or the User's paragraph", () => {
    const quote = "Roof and insulation\tHartley Building Ltd\t£1,240,000\tJune 2027";
    expect(numbersBacked("was £1,240,000, due in June 2027.", quote, "the budget")).toBe(true);
    expect(numbersBacked("was £1240000.", quote, "the budget")).toBe(true);
    expect(numbersBacked("was £1,240,000, with 10 per cent kept back.", quote, "the budget")).toBe(
      false,
    );
    expect(numbersBacked("the other 3 rooms too.", quote, "Of the 3 rooms, the roof")).toBe(true);
    expect(
      numbersBacked("为41%，是最高的。", "西湖区绿地率最高，达到38%", "而西湖区的绿地率"),
    ).toBe(false);
  });

  test("the model is told which sentence the paragraph stops in the middle of", () => {
    expect(unfinishedSentence("The tides rise. Twice a month the spring tides")).toBe(
      "Twice a month the spring tides",
    );
    expect(unfinishedSentence("The tides rise. They fall again.")).toBe("");
    expect(unfinishedSentence("港口测量要看潮汐。每个月有两次大潮，")).toBe("每个月有两次大潮，");
    expect(suggestionPrompt("The tides rise. And the", [])).toContain(
      "The paragraph's last sentence is unfinished: “And the”. Your text finishes it.",
    );
  });

  test("a reply that starts by repeating the paragraph's end goes on from there", () => {
    expect(
      continuationOf("and the survey found that", "the survey found that trees cool it."),
    ).toBe("trees cool it.");
    expect(continuationOf("The tides rise.", "They fall again.")).toBe("They fall again.");
  });

  test("the reply is one short sentence on a Passage it was given", () => {
    expect(
      readReply({ text: "They rise at full moon. Then they fall.", passage: "2", quote: "q" }, 3),
    ).toEqual({ text: "They rise at full moon.", passage: 1, quote: "q" });
    expect(
      readReply(
        { text: "这时太阳和月亮的引力叠加在一起。之后潮水退去。", passage: "P1", quote: "q" },
        1,
      ),
    ).toEqual({ text: "这时太阳和月亮的引力叠加在一起。", passage: 0, quote: "q" });
    expect(readReply({ text: "They rise.", passage: "P4", quote: "q" }, 3)).toBeNull();
    expect(readReply({ text: "word ".repeat(60), passage: "P1", quote: "q" }, 3)).toBeNull();
    expect(readReply({ text: "", passage: "P1", quote: "q" }, 3)).toBeNull();
  });
});
