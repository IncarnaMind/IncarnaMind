/**
 * What a check costs in requests, and how many go at once (#2002, #1635): a sentence with no
 * opinion range costs what it did before sentences had parts, a sentence's parts are checked at
 * once within the run's limit, and a long Note's sorting batches go at once too.
 */
import { wrapLanguageModel } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { isCheckRun, listedSentences, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LANGUAGES = [
  {
    language: "en",
    source: "Spring tides come at new and full moon.",
    written: "Spring tides come at new and full moon [^1].",
    facts: [
      "The North store opened in March",
      "the South store opened in April",
      "the East store opened in May",
    ],
    joined: (facts: readonly string[]) => `${facts.slice(0, 2).join(", ")}, and ${facts[2]}.`,
    sentence: (index: number) => `Store ${index} sold ${index + 10} units in June.`,
  },
  {
    language: "zh-CN",
    source: "大潮出现在新月和满月时。",
    written: "大潮出现在新月和满月时[^1]。",
    facts: ["北店于三月开业", "南店于四月开业", "东店于五月开业"],
    joined: (facts: readonly string[]) => `${facts.join("，")}。`,
    sentence: (index: number) => `${index}号店六月售出${index + 10}件商品。`,
  },
] as const;

const SORTS = "You sort the sentences";
/** The check's own requests that aren't a step of its Run: a record asked for again, a judgement. */
const CHECK_ASKS = ["You checked a sentence the User wrote", "Compare a sentence"];

const systemOf = (prompt: readonly { role: string; content: unknown }[]) =>
  prompt.flatMap((message) =>
    message.role === "system" && typeof message.content === "string" ? [message.content] : [],
  )[0] ?? "";

/** The requests a check sent `model`: sorting, its Run's steps, and what else it asked. */
function checkRequests(model: MockLanguageModelV4) {
  const generated = model.doGenerateCalls.map((call) => systemOf(call.prompt));
  const streamed = model.doStreamCalls.map((call) => systemOf(call.prompt));
  return {
    sorting: generated.filter((each) => each.startsWith(SORTS)).length,
    steps: streamed.filter((each) => each.startsWith("You check one sentence")).length,
    asked: generated.filter((each) => CHECK_ASKS.some((ask) => each.startsWith(ask))).length,
  };
}

/** Resolves once `count` have arrived; a run that never gets there goes on after `ms` and fails its assertion. */
function gathering(count: number, ms = 2_000) {
  let arrived = 0;
  let release = () => {};
  const all = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, ms);
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
function quoting(
  call: ModelCall,
  { quote = sentenceOf(call), first }: { quote?: string; first?: () => Promise<void> } = {},
): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    const reply: ScriptedReply = {
      calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }],
    };
    return first ? { ...reply, pause: { after: 0, until: first() } } : reply;
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

/** Answers a sort with `parts` of each sentence listed, as facts; any other generated request with no record. */
const sortingInto =
  (parts: (text: string) => readonly string[]) => (call: { system: string; prompt: string }) => {
    if (!call.system.startsWith(SORTS)) return { text: JSON.stringify({ passage: null }) };
    const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
      number,
      parts: parts(text).map((part) => ({ kind: "fact", text: part })),
    }));
    return { text: JSON.stringify({ sentences }) };
  };

describe.each(LANGUAGES)("check requests ($language)", (example) => {
  // protects=a sentence the assistant writes is checked with the requests it took before sentences had parts: no sorting request, one Run of search, cite and reply (#1635); fails_when=a written check sorts its sentence or splits it into parts; no_claim=how many steps a real model takes.
  test("a written sentence with no opinion range is checked whole, with no sorting request", async () => {
    let written = false;
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return quoting(call, { quote: example.source });
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, quote: example.source };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      if (!written) {
        written = true;
        const content = `## Tides\n\n${example.written}`;
        return { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return { text: "Wrote it from your Documents." };
    });
    const core = await coreWith(model);
    const folderId = await inFolder(core, "Tides.md", `# Tides\n\n${example.source}\n`);

    const answer = await askAssistant(core, {
      text: "Summarise these Documents into a new note",
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });

    expect(answer.toolCalls.some((call) => call.mindChange?.selfCheck?.sent === 1)).toBe(true);
    expect(checkRequests(model)).toEqual({ sorting: 0, steps: 3, asked: 0 });
  });

  // protects=a sentence's factual parts are checked at once on a cloud model, within the run's limit, and one at a time on a model on this computer, one Run each (#2002); fails_when=parts wait for each other on a cloud model, or a local model gets several at once; no_claim=how long a real provider takes.
  test.each([
    { where: "a cloud model", local: false, atOnce: 3 },
    { where: "this computer", local: true, atOnce: 1 },
  ])(
    "a sentence's three facts are checked on $where, $atOnce at a time",
    async ({ local, atOnce }) => {
      const sentence = example.joined(example.facts);
      const started = gathering(example.facts.length);
      const inner = scriptedModel(
        (call) =>
          quoting(call, {
            ...(!local && {
              first: () => {
                started.arrive();
                return started.all;
              },
            }),
          }),
        { generate: sortingInto(() => example.facts) },
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
            type Part = typeof result.stream extends ReadableStream<infer Each> ? Each : never;
            const ended = new TransformStream<Part, Part>({
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
      expect(checkRequests(inner)).toEqual({ sorting: 1, steps: 9, asked: 0 });
    },
  );

  // protects=a Note longer than one sorting batch has its batches sorted at once on a cloud model (#2002); fails_when=each batch waits for the one before; no_claim=how long a real sort takes.
  test("a long Note's sorting batches go at once", async () => {
    const sentences = Array.from({ length: 25 }, (_, index) => example.sentence(index + 1));
    const batches = gathering(3);
    let sorting = 0;
    let most = 0;
    const inner = scriptedModel((call) => quoting(call), {
      generate: sortingInto((text) => [text]),
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
