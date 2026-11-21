/**
 * What a check costs in requests (#2002, #1635): a sentence the assistant writes is one Run of
 * search, cite and reply, a figure in it adding none, with no sorting request; and a long Note's
 * sorting batches go at once.
 */
import { wrapLanguageModel } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import type { SortWord } from "../../src/core/answers/checks/claims";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { sortReply } from "../helpers/claimSentences";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  unscripted,
} from "../helpers/models";

const LANGUAGES = [
  {
    language: "en",
    source: "Spring tides come at new and full moon.",
    written: "Spring tides come at new and full moon[^1].",
    sentence: (index: number) => `Store ${index} sold ${index + 10} units in June.`,
  },
  {
    language: "zh-CN",
    source: "大潮出现在新月和满月时。",
    written: "大潮出现在新月和满月时[^1]。",
    sentence: (index: number) => `${index}号店六月售出${index + 10}件商品。`,
  },
] as const;

const SORTS = "You sort the sentences";
/** The check's own requests that aren't a step of its Run: a record cite's judgement. */
const CHECK_ASKS = ["Compare a sentence"];

const systemOf = (prompt: readonly { role: string; content: unknown }[]) =>
  prompt.flatMap((message) =>
    message.role === "system" && typeof message.content === "string" ? [message.content] : [],
  )[0] ?? "";

/** The requests a check sent `model`: sorting, its Runs' steps, and what else it asked. */
function checkRequests(model: MockLanguageModelV4) {
  const generated = model.doGenerateCalls.map((call) => systemOf(call.prompt));
  const streamed = model.doStreamCalls.map((call) => systemOf(call.prompt));
  return {
    // A Note's sort streams (#2532), Verify's is generated: either is one sorting request.
    sorting: [...generated, ...streamed].filter((each) => each.startsWith(SORTS)).length,
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

/** A check Run that searches, cites the Passage holding `quote` (the sentence, by default), then says Supported. */
function quoting(call: ModelCall, quote = sentenceOf(call)): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0)
    return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
  if (!call.results.some((result) => result.tool === "cite")) {
    const shown = shownPassages(searches.at(-1)?.text ?? "");
    const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } }],
    };
  }
  return { text: "Verdict: supported\nExplanation: The Document says so. [^1]\nEvidence: [1]" };
}

/** A core whose chat model is `model`, billed per token on a service. */
async function coreWith(model: Parameters<typeof wrapLanguageModel>[0]["model"]) {
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  await core.updateSettings({ user: { checkAssistantWrites: true } });
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

/** Answers a sort with `word` for each sentence listed, and a request that asks no question with nothing. */
const sortingInto = (word: (text: string) => SortWord) => (call: GenerateCall) => {
  if (!call.question) return { text: "" };
  if (call.question === "claimed-changes") return { text: JSON.stringify({ claims: [] }) };
  if (call.question !== "find-claims") return unscripted(call.question, call.system);
  return { text: sortReply(call.prompt, word) };
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
  // protects=a plain factual sentence the assistant writes is checked with the requests it took before sentences had parts: no sorting request, one Run of cite and reply on the search made for it (#1635, #3512); fails_when=a written check sends a sorting request or splits a one-fact sentence; no_claim=how many steps a real model takes.
  test("a plain factual written sentence costs two requests, with no sorting request", async () => {
    const model = writingModel(example.source, example.written, (call) =>
      quoting(call, example.source),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);

    const { change, client } = await write(core, folderId);

    expect(change.selfCheck?.sent).toBe(1);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 2, asked: 0 });
    expect(await marksOf(client)).toEqual([
      {
        state: "supported",
        parts: [{ text: expect.any(String), kind: "fact", verdict: "supported" }],
      },
    ]);
  });

  // protects=written sentences with numbers cost the requests they did before sentences had parts: one Run each of cite and reply on the search made for it, judged whole, and no sorting request is sent (#1635, #1932); fails_when=a sentence with a figure sends a sorting request of its own, or takes more steps; no_claim=how many steps a real model takes.
  test("three written sentences with numbers make no sorting request", async () => {
    const sentences = [1, 2, 3].map(example.sentence);
    const plans = Object.fromEntries(
      sentences.map((sentence) => [sentence, { verdict: "supported" as const, quote: sentence }]),
    );
    const model = writingModel(
      sentences.join(" "),
      sentences.map((sentence) => sentence.replace(/([.。])$/u, "[^1]$1")).join(" "),
      (call) => checkReply(call, plans),
      (call) =>
        call.system.startsWith(SORTS)
          ? sortingInto(() => "claim")(call)
          : checkGenerate(plans)(call),
    );
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Stores.md", `# Stores\n\n${sentences.join(" ")}\n`);

    const { change, client } = await write(core, folderId);

    expect(change.selfCheck?.sent).toBe(3);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 6, asked: 0 });
    expect((await marksOf(client)).map((mark) => mark.state)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });

  // protects=a Note longer than one sorting batch has its batches sorted at once on a cloud model (#2002); fails_when=each batch waits for the one before; no_claim=how long a real sort takes.
  test("a long Note's sorting batches go at once", async () => {
    const sentences = Array.from({ length: 25 }, (_, index) => example.sentence(index + 1));
    const batches = gathering(3);
    let sorting = 0;
    let most = 0;
    const inner = scriptedModel((call) => quoting(call), {
      generate: sortingInto(() => "claim"),
    });
    const model = wrapLanguageModel({
      model: inner,
      middleware: {
        specificationVersion: "v4",
        wrapStream: async ({ doStream, params }) => {
          if (!systemOf(params.prompt).startsWith(SORTS)) return doStream();
          sorting++;
          most = Math.max(most, sorting);
          batches.arrive();
          await batches.all;
          try {
            return await doStream();
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
