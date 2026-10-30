/**
 * What a check costs in requests, and how many go at once (#2002, #1635): a check with no sorted
 * parts names them in its first turn, so a sentence of one fact costs what it did before sentences
 * had parts and one with an opinion one request more; a sentence's parts are checked at once
 * within the run's limit, and a long Note's sorting batches go at once too. What the assistant
 * writes gets the parts and the result Check this Note gives the same sentence.
 */
import { wrapLanguageModel } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { askAssistant } from "../helpers/assistant";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

type Part = { kind: "fact" | "opinion"; text: string };

const LANGUAGES = [
  {
    language: "en",
    source: "Spring tides come at new and full moon.",
    written: "Spring tides come at new and full moon[^1].",
    opinion: "We think the harbour is lovely",
    mixed: "We think the harbour is lovely, and spring tides come at new and full moon[^1].",
    fact: "spring tides come at new and full moon",
    facts: [
      "The North store opened in March",
      "the South store opened in April",
      "the East store opened in May",
    ],
    joined: (facts: readonly string[]) => `${facts.slice(0, 2).join(", ")}, and ${facts[2]}.`,
    sentence: (index: number) => `Store ${index} sold ${index + 10} units in June.`,
    survey: "Spring tides come at new and full moon, as the harbour survey found[^1].",
    surveyFact: "Spring tides come at new and full moon",
    leading: "Yet spring tides come at new and full moon[^1].",
    leadingFact: "spring tides come at new and full moon",
    figure: {
      source: "Revenue rose by £5m in 2025.",
      written: "I think the £5m rise is impressive[^1].",
      number: "£5m",
      opinion: "I think the £5m rise is impressive",
    },
    deals: {
      source: "The £5m and £6m deals closed in 2025.",
      typed: "Sadly the £5m and £6m deals are a disaster.",
      numbers: ["£5m", "£6m"],
      opinion: "Sadly the £5m and £6m deals are a disaster",
    },
    year: {
      source: "Revenue rose 12% in 2024.",
      written: "Revenue rose 12% in 2025[^1].",
      named: "Revenue rose 12%",
      fact: "Revenue rose 12% in 2025",
    },
  },
  {
    language: "zh-CN",
    source: "大潮出现在新月和满月时。",
    written: "大潮出现在新月和满月时[^1]。",
    opinion: "我们认为港口很美",
    mixed: "我们认为港口很美，大潮出现在新月和满月时[^1]。",
    fact: "大潮出现在新月和满月时",
    facts: ["北店于三月开业", "南店于四月开业", "东店于五月开业"],
    joined: (facts: readonly string[]) => `${facts.join("，")}。`,
    sentence: (index: number) => `${index}号店六月售出${index + 10}件商品。`,
    survey: "大潮出现在新月和满月时，正如港口调查所发现的[^1]。",
    surveyFact: "大潮出现在新月和满月时",
    leading: "而大潮出现在新月和满月时[^1]。",
    leadingFact: "大潮出现在新月和满月时",
    figure: {
      source: "2025年收入增长了500万英镑。",
      written: "我认为500万英镑的增长令人印象深刻[^1]。",
      number: "500万英镑",
      opinion: "我认为500万英镑的增长令人印象深刻",
    },
    deals: {
      source: "500万英镑和600万英镑的交易已于2025年完成。",
      typed: "可惜500万英镑和600万英镑的交易是一场灾难。",
      numbers: ["500万英镑", "600万英镑"],
      opinion: "可惜500万英镑和600万英镑的交易是一场灾难",
    },
    year: {
      source: "2024年收入增长了12%。",
      written: "2025年收入增长了12%[^1]。",
      named: "收入增长了12%",
      fact: "2025年收入增长了12%",
    },
  },
] as const;

const SORTS = "You sort the sentences";
/** The check's own requests that aren't a step of its Run: a record asked for again, a judgement. */
const CHECK_ASKS = ["You checked a sentence the User wrote", "Compare a sentence"];

const systemOf = (prompt: readonly { role: string; content: unknown }[]) =>
  prompt.flatMap((message) =>
    message.role === "system" && typeof message.content === "string" ? [message.content] : [],
  )[0] ?? "";

/** The requests a check sent `model`: sorting, its Runs' steps, and what else it asked. */
function checkRequests(model: MockLanguageModelV4) {
  const generated = model.doGenerateCalls.map((call) => systemOf(call.prompt));
  const streamed = model.doStreamCalls.map((call) => systemOf(call.prompt));
  return {
    sorting: generated.filter((each) => each.startsWith(SORTS)).length,
    steps: streamed.filter((each) => each.startsWith("You check one sentence")).length,
    asked: generated.filter((each) => CHECK_ASKS.some((ask) => each.startsWith(ask))).length,
  };
}

/** Resolves once `count` have arrived: a limit that keeps them apart never opens it, and the test times out. */
function gathering(count: number) {
  let arrived = 0;
  let release = () => {};
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    all,
    arrive() {
      arrived++;
      if (arrived >= count) release();
    },
  };
}

/** The literal parts of `sentence`, in its order, as a model names them. */
const partsIn = (sentence: string, parts: readonly Part[]): Part[] =>
  parts.filter((part) => sentence.includes(part.text));

/**
 * A check Run that searches, cites the Passage holding `quote` (the sentence, by default), then
 * says Supported. A Run that has no sorted parts names `parts` in its first turn; a Run of a part
 * waits for `first` before its first reply.
 */
function quoting(
  call: ModelCall,
  {
    quote = sentenceOf(call),
    parts = (sentence) => [{ kind: "fact", text: sentence }],
    first,
  }: {
    quote?: string;
    parts?: (sentence: string) => readonly Part[];
    first?: () => Promise<void>;
  } = {},
): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    const search = { tool: "search_documents", input: { query: sentenceOf(call) } };
    if (call.system.includes("Parts:"))
      return { text: `Parts: ${JSON.stringify(parts(sentenceOf(call)))}`, calls: [search] };
    return first ? { calls: [search], pause: { after: 0, until: first() } } : { calls: [search] };
  }
  if (!call.results.some((result) => result.tool === "cite")) {
    const shown = shownPassages(searches.at(-1)?.text ?? "");
    const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } }],
    };
  }
  return { text: "Verdict: supported\nThe Document says so. [^1]" };
}

/** A check Run whose first turn names `parts` of its sentence, then checks as `plans` say. */
function naming(
  call: ModelCall,
  plans: Record<string, Plan>,
  parts: (sentence: string) => readonly Part[],
): ScriptedReply {
  if (call.results.length > 0 || !call.system.includes("Parts:")) return checkReply(call, plans);
  const search = { tool: "search_documents", input: { query: sentenceOf(call) } };
  return { text: `Parts: ${JSON.stringify(parts(sentenceOf(call)))}`, calls: [search] };
}

/** A core whose chat model is `model`, billed per token on a service, or on this computer (`local`). */
async function coreWith(model: Parameters<typeof wrapLanguageModel>[0]["model"], local = false) {
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  if (local) {
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    return core;
  }
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  for (const flow of ["chat", "checks"] as const) {
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  }
  return core;
}

async function inFolder(core: Core, name: string, contents: string) {
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [await writeSourceFile(sources, name, contents)]);
  const folder = await core.createLibraryGroup({ name: "Notes", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  return folder.id;
}

/** Answers a sort with `parts` of each sentence listed; any other generated request with no record. */
const sortingInto =
  (parts: (text: string) => readonly Part[]) => (call: { system: string; prompt: string }) => {
    if (!call.system.startsWith(SORTS)) return { text: JSON.stringify({ passage: null }) };
    const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
      number,
      parts: parts(text),
    }));
    return { text: JSON.stringify({ sentences }) };
  };

/** The assistant's model: it searches, cites `source`, writes `written` into a new Note and replies; check Runs as `check`. */
function writingModel(
  source: string,
  written: string,
  check: (call: ModelCall) => ScriptedReply,
  generate?: (call: GenerateCall) => GeneratedReply,
) {
  let wrote = false;
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) return check(call);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: source } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, quote: source };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      if (!wrote) {
        wrote = true;
        const content = `## Tides\n\n${written}`;
        return { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return { text: "Wrote it from your Documents." };
    },
    generate ? { generate } : {},
  );
}

async function write(core: Core, folderId: string) {
  const answer = await askAssistant(core, {
    text: "Summarise these Documents into a new note",
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  const change = answer.toolCalls.find((call) => call.mindChange)?.mindChange;
  if (!change) throw new Error("The assistant wrote nothing.");
  return { change, client: await connectToMind(core, change.mindId) };
}

/** Each mark's parts as words, kinds and results, and its sentence's result. */
async function marksOf(client: MindClient) {
  await client.settled();
  return claimSpans(readMind(client)).map(({ check }) => ({
    state: check.state,
    parts: check.parts?.map((part) => ({
      text: check.text.slice(part.span.start, part.span.end),
      kind: part.kind,
      verdict: part.verdict,
    })),
  }));
}

describe.each(LANGUAGES)("check requests ($language)", (example) => {
  // protects=a plain factual sentence the assistant writes is checked with the requests it took before sentences had parts: no sorting request, one Run of search, cite and reply (#1635); fails_when=a written check sends a sorting request or splits a one-fact sentence; no_claim=how many steps a real model takes.
  test("a plain factual written sentence costs main's three requests, with no sorting request", async () => {
    const model = writingModel(example.source, example.written, (call) =>
      quoting(call, { quote: example.source }),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);

    const { change, client } = await write(core, folderId);

    expect(change.selfCheck?.sent).toBe(1);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 3, asked: 0 });
    expect(await marksOf(client)).toEqual([
      {
        state: "supported",
        parts: [{ text: expect.any(String), kind: "fact", verdict: "supported" }],
      },
    ]);
  });

  // protects=a written sentence with an opinion costs one request more than a plain one, with its fact checked and its opinion left out, and the same parts and result Check this Note gives it in a Note of the User's and on the assistant's own Note (#2002, #1635); fails_when=the opinion is judged as a fact, the two checks disagree, or Check this Note changes the written mark with no edit; no_claim=how a real model splits a sentence.
  test("a written sentence with an opinion gets the parts and result Check this Note gives it", async () => {
    const parts = (sentence: string) =>
      partsIn(sentence, [
        { kind: "opinion", text: example.opinion },
        { kind: "fact", text: example.fact },
      ]);
    const model = writingModel(
      example.source,
      example.mixed,
      (call) => quoting(call, { quote: example.source, parts }),
      sortingInto(parts),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);

    const { change, client } = await write(core, folderId);
    const written = await marksOf(client);

    expect(change.selfCheck?.sent).toBe(1);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 4, asked: 0 });
    expect(written).toEqual([
      {
        state: "supported",
        parts: [
          { text: example.opinion, kind: "opinion", verdict: null },
          { text: example.fact, kind: "fact", verdict: "supported" },
        ],
      },
    ]);

    // The same sentence the User types gets the same parts and result from Check this Note.
    const typed = await core.createMind({ title: "Typed", folderId });
    const own = await connectToMind(core, typed.id);
    const words = example.mixed.replace("[^1]", "");
    writeMind(own, [
      { type: "paragraph", attrs: { id: "own" }, content: [{ type: "text", text: words }] },
    ]);
    await own.settled();
    expect(
      await core.checkMind({ requestId: "typed", mindId: typed.id, mode: "all" }),
    ).toMatchObject({
      kind: "checked",
    });
    expect(await marksOf(own)).toEqual(written);

    // Check this Note on the assistant's Note, its words accepted, keeps the written parts and result.
    await resolveChanges(client, "accept");
    expect(
      await core.checkMind({ requestId: "again", mindId: change.mindId, mode: "all" }),
    ).toMatchObject({ kind: "checked" });
    expect(await marksOf(client)).toEqual(written);
  });

  // protects=a cited written sentence whose first turn names no part is checked whole, never dropped without a mark (#2002); fails_when=it gets no mark or only an opinion row; no_claim=how often a real model names no part.
  test("a written sentence whose first turn names no part is checked whole", async () => {
    const model = writingModel(example.source, example.written, (call) =>
      quoting(call, { quote: example.source, parts: () => [] }),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);

    const { change, client } = await write(core, folderId);

    expect(change.selfCheck).toMatchObject({ sent: 1, checked: 1 });
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 3, asked: 0 });
    expect(await marksOf(client)).toEqual([
      {
        state: "supported",
        parts: [{ text: expect.any(String), kind: "fact", verdict: "supported" }],
      },
    ]);
  });

  // protects=a written sentence whose named fact leaves out only a joining word is checked on the fact's words, so it gets the result Check this Note gives it, never the whole sentence's result on the shorter words (#2002); fails_when=the whole-sentence result is kept on a shorter part, or the two checks disagree; no_claim=how a real model names parts.
  test("a written sentence whose one fact leaves out a joining word gets the result Check this Note gives it", async () => {
    const words = example.leading.replace("[^1]", "");
    const fact = (sentence: string): Part[] =>
      partsIn(sentence, [{ kind: "fact", text: example.leadingFact }]);
    const plans = {
      [example.leadingFact]: { verdict: "supported" as const, quote: example.source },
      [words]: { verdict: "unsupported" as const },
    };
    const model = writingModel(
      example.source,
      example.leading,
      (call) => naming(call, plans, fact),
      (call) =>
        call.system.startsWith(SORTS) ? sortingInto(fact)(call) : checkGenerate(plans)(call),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);
    const expected = [
      {
        state: "supported",
        parts: [{ text: example.leadingFact, kind: "fact", verdict: "supported" }],
      },
    ];

    const { change, client } = await write(core, folderId);
    expect(await marksOf(client)).toEqual(expected);

    const typed = await core.createMind({ title: "Typed", folderId });
    const own = await connectToMind(core, typed.id);
    writeMind(own, [
      { type: "paragraph", attrs: { id: "own" }, content: [{ type: "text", text: words }] },
    ]);
    await own.settled();
    expect(
      await core.checkMind({ requestId: "typed", mindId: typed.id, mode: "all" }),
    ).toMatchObject({ kind: "checked" });
    expect(await marksOf(own)).toEqual(expected);

    await resolveChanges(client, "accept");
    expect(
      await core.checkMind({ requestId: "again", mindId: change.mindId, mode: "all" }),
    ).toMatchObject({ kind: "checked" });
    expect(await marksOf(client)).toEqual(expected);
  });

  // protects=words a named fact leaves out that say something (who found it, a year) are checked with that fact, in what the assistant writes and in Check this Note alike, so the sentence never reads Supported on the shorter words (#2002); fails_when=the left-out words are neither checked nor listed, or the two checks disagree; no_claim=how often a real model leaves words out of a fact.
  test.each(["survey", "year"] as const)(
    "words a written sentence's fact leaves out are checked with it, as Check this Note checks them (%s)",
    async (which) => {
      const written = which === "survey" ? example.survey : example.year.written;
      const source = which === "survey" ? example.source : example.year.source;
      const named = which === "survey" ? example.surveyFact : example.year.named;
      const words = written.replace("[^1]", "");
      const kept = words.replace(/[.。]$/u, "");
      const fact = (sentence: string): Part[] => partsIn(sentence, [{ kind: "fact", text: named }]);
      // The named words alone are in the Document; with what they leave out, they aren't.
      const plans = { [named]: { verdict: "supported" as const, quote: source } };
      const checked: string[] = [];
      const model = writingModel(
        source,
        written,
        (call) => {
          if (call.results.length === 0) checked.push(sentenceOf(call));
          return naming(call, plans, fact);
        },
        (call) =>
          call.system.startsWith(SORTS) ? sortingInto(fact)(call) : checkGenerate(plans)(call),
      );
      const core = await coreWith(model);
      const folderId = await inFolder(core, "Source.md", `# Source\n\n${source}\n`);
      const expected = [
        { state: "unsupported", parts: [{ text: kept, kind: "fact", verdict: "unsupported" }] },
      ];

      const { client } = await write(core, folderId);
      expect(await marksOf(client)).toEqual(expected);

      const typed = await core.createMind({ title: "Typed", folderId });
      const own = await connectToMind(core, typed.id);
      writeMind(own, [
        { type: "paragraph", attrs: { id: "own" }, content: [{ type: "text", text: words }] },
      ]);
      await own.settled();
      expect(
        await core.checkMind({ requestId: "typed", mindId: typed.id, mode: "all" }),
      ).toMatchObject({ kind: "checked" });
      expect(await marksOf(own)).toEqual(expected);
      expect(checked).not.toContain(named);
      if (which === "year") expect(kept).toBe(example.year.fact);
    },
  );

  // protects=written sentences with numbers cost the requests they did before sentences had parts: their first turn names the parts, each number inside its fact, and no sorting request is sent (#1635, #1932); fails_when=a sentence with a figure sends a sorting request of its own, or takes more steps; no_claim=how many steps a real model takes.
  test("three written sentences with numbers make no sorting request", async () => {
    const sentences = [1, 2, 3].map(example.sentence);
    const whole = (sentence: string): Part[] => [
      { kind: "fact", text: sentence.replace(/[.。]$/u, "") },
    ];
    const plans = Object.fromEntries(
      sentences.map((sentence) => [sentence, { verdict: "supported" as const, quote: sentence }]),
    );
    const model = writingModel(
      sentences.join(" "),
      sentences.map((sentence) => sentence.replace(/([.。])$/u, "[^1]$1")).join(" "),
      (call) => naming(call, plans, whole),
      (call) =>
        call.system.startsWith(SORTS) ? sortingInto(whole)(call) : checkGenerate(plans)(call),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Stores.md", `# Stores\n\n${sentences.join(" ")}\n`);

    const { change, client } = await write(core, folderId);

    expect(change.selfCheck?.sent).toBe(3);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 9, asked: 0 });
    expect((await marksOf(client)).map((mark) => mark.state)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });

  // protects=a number inside an opinion is checked as its own fact inside it, in what the assistant writes and in Check this Note, with the same parts and result, and the opinion is left out whole (#1932, #2002); fails_when=the sentence is left out whole as an opinion, its number goes unchecked, or the two checks give it different parts; no_claim=how a real model sorts the sentence.
  test("a number inside an opinion is checked as its own fact, written or typed", async () => {
    const { figure } = example;
    const opinion = (sentence: string): Part[] => [
      { kind: "opinion", text: sentence.replace(/[.。]$/u, "") },
    ];
    const plans = {
      [figure.number]: {
        verdict: "supported" as const,
        quote: figure.source,
        number: figure.number,
      },
    };
    const checked: string[] = [];
    const model = writingModel(
      figure.source,
      figure.written,
      (call) => {
        if (call.results.length === 0) checked.push(sentenceOf(call));
        return naming(call, plans, opinion);
      },
      (call) =>
        call.system.startsWith(SORTS) ? sortingInto(opinion)(call) : checkGenerate(plans)(call),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Revenue.md", `# Revenue\n\n${figure.source}\n`);
    const expected = [
      {
        state: "supported",
        parts: [
          { text: figure.opinion, kind: "opinion", verdict: null },
          { text: figure.number, kind: "fact", verdict: "supported" },
        ],
      },
    ];

    const words = figure.written.replace("[^1]", "");
    const { change, client } = await write(core, folderId);
    expect(await marksOf(client)).toEqual(expected);
    // Its first turn names the parts, and only the number goes on to be checked.
    expect(checked).toEqual([words, figure.number]);

    const typed = await core.createMind({ title: "Typed", folderId });
    const own = await connectToMind(core, typed.id);
    writeMind(own, [
      {
        type: "paragraph",
        attrs: { id: "own" },
        content: [{ type: "text", text: words }],
      },
    ]);
    await own.settled();
    expect(
      await core.checkMind({ requestId: "typed", mindId: typed.id, mode: "all" }),
    ).toMatchObject({ kind: "checked" });
    expect(await marksOf(own)).toEqual(expected);
    expect(checked).toEqual([words, figure.number, figure.number]);

    await resolveChanges(client, "accept");
    expect(
      await core.checkMind({ requestId: "again", mindId: change.mindId, mode: "all" }),
    ).toMatchObject({ kind: "checked" });
    expect(await marksOf(client)).toEqual(expected);
  });

  // protects=one opinion that numbers split is one opinion left out, counted once and shown whole, while each number in it is checked as a fact of its own (#2002, #1932); fails_when=the opinion's pieces count as several opinions, or Show would select a joining word on its own; no_claim=how a real model sorts the sentence.
  test("one opinion around two numbers is left out once and shown whole", async () => {
    const { deals } = example;
    const opinion = (sentence: string): Part[] => [
      { kind: "opinion", text: sentence.replace(/[.。]$/u, "") },
    ];
    const plans = Object.fromEntries(
      deals.numbers.map((number) => [
        number,
        { verdict: "supported" as const, quote: deals.source, number },
      ]),
    );
    const model = scriptedModel((call) => naming(call, plans, opinion), {
      generate: (call) =>
        call.system.startsWith(SORTS) ? sortingInto(opinion)(call) : checkGenerate(plans)(call),
    });
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Deals.md", `# Deals\n\n${deals.source}\n`);
    const typed = await core.createMind({ title: "Typed", folderId });
    const own = await connectToMind(core, typed.id);
    writeMind(own, [
      { type: "paragraph", attrs: { id: "own" }, content: [{ type: "text", text: deals.typed }] },
    ]);
    await own.settled();
    expect(
      await core.checkMind({ requestId: "typed", mindId: typed.id, mode: "all" }),
    ).toMatchObject({ kind: "checked" });

    expect(await marksOf(own)).toEqual([
      {
        state: "supported",
        parts: [
          { text: deals.opinion, kind: "opinion", verdict: null },
          ...deals.numbers.map((text) => ({ text, kind: "fact", verdict: "supported" })),
        ],
      },
    ]);
    const page = readMind(own);
    const opinions = opinionsIn(page, own.doc);
    expect(opinions.map((each) => page.textBetween(each.range.from, each.range.to))).toEqual([
      deals.opinion,
    ]);
  });

  // protects=a sentence's factual parts are checked at once on a cloud model, within the run's limit, and one at a time on a model on this computer, after one first turn that names them and no sorting request (#2002); fails_when=parts wait for each other on a cloud model, a local model gets several at once, or a sorting request is sent; no_claim=how long a real provider takes.
  test.each([
    { where: "a cloud model", local: false, atOnce: 3 },
    { where: "this computer", local: true, atOnce: 1 },
  ])(
    "a sentence's three facts are checked on $where, $atOnce at a time",
    async ({ local, atOnce }) => {
      const sentence = example.joined(example.facts);
      const started = gathering(example.facts.length);
      const facts = example.facts.map((text): Part => ({ kind: "fact", text }));
      const inner = scriptedModel(
        (call) =>
          quoting(call, {
            parts: () => facts,
            ...(!local && {
              first: () => {
                started.arrive();
                return started.all;
              },
            }),
          }),
        { generate: sortingInto(() => facts) },
      );
      let running = 0;
      let most = 0;
      const model = wrapLanguageModel({
        model: inner,
        middleware: {
          specificationVersion: "v4",
          wrapStream: async ({ doStream }) => {
            running++;
            most = Math.max(most, running);
            const result = await doStream();
            type Each = typeof result.stream extends ReadableStream<infer Item> ? Item : never;
            const ended = new TransformStream<Each, Each>({
              flush() {
                running--;
              },
            });
            return { ...result, stream: result.stream.pipeThrough(ended) };
          },
        },
      });
      const core = await coreWith(model, local);
      await inFolder(
        core,
        "Stores.md",
        `# Stores\n\n${example.facts.map((fact) => `${fact}.`).join("\n\n")}\n`,
      );

      const result = await core.checkClaim({ claim: sentence });

      expect(result.verdict).toBe("supported");
      expect(result.parts?.map((part) => sentence.slice(part.span.start, part.span.end))).toEqual(
        example.facts,
      );
      expect(most).toBe(atOnce);
      // The first turn that names the parts, then three Runs of search, cite and reply.
      expect(checkRequests(inner)).toEqual({ sorting: 0, steps: 10, asked: 0 });
    },
  );

  // protects=a Note longer than one sorting batch has its batches sorted at once on a cloud model (#2002); fails_when=each batch waits for the one before; no_claim=how long a real sort takes.
  test("a long Note's sorting batches go at once", async () => {
    const sentences = Array.from({ length: 25 }, (_, index) => example.sentence(index + 1));
    const batches = gathering(3);
    let sorting = 0;
    let most = 0;
    const inner = scriptedModel((call) => quoting(call), {
      generate: sortingInto((text) => [{ kind: "fact", text }]),
    });
    const model = wrapLanguageModel({
      model: inner,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          if (!systemOf(params.prompt).startsWith(SORTS)) return doGenerate();
          sorting++;
          most = Math.max(most, sorting);
          batches.arrive();
          await batches.all;
          try {
            return await doGenerate();
          } finally {
            sorting--;
          }
        },
      },
    });
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Stores.md", `# Stores\n\n${sentences.join("\n\n")}\n`);
    const mind = await core.createMind({ title: "Stores", folderId });
    const client = await connectToMind(core, mind.id);
    writeMind(
      client,
      sentences.map((each, index) => ({
        type: "paragraph",
        attrs: { id: `p${index}` },
        content: [{ type: "text", text: each }],
      })),
    );
    await client.settled();

    const result = await core.checkMind({ requestId: "run-all", mindId: mind.id, mode: "all" });

    expect(result).toMatchObject({ kind: "checked" });
    expect(checkRequests(inner).sorting).toBe(3);
    expect(most).toBe(3);
  });
});
