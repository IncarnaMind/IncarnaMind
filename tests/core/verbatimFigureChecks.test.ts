/**
 * A sentence a Document states word for word is Supported against All Documents (#2184), however
 * the model splits its reply across the turns of its Run. Claude Haiku 5.5 wrote its verdict lines
 * in the turn that calls `cite` and its Figures line alone after it: the check read only the last
 * turn, found no verdict, and the sentence came back "The model's reply couldn't be read".
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, requestedFigures, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

interface Language {
  documents: { name: string; contents: string }[];
  /** A sentence the Documents state word for word, and its figure as the quote writes it. */
  stated: { sentence: string; number: string };
  /** The same sentence with another figure: the Documents contradict it. */
  wrong: { sentence: string; number: string };
}

const EN: Language = {
  documents: [
    {
      name: "Field Report.md",
      contents: [
        "# Field Report: Northern Estuary",
        "",
        "This report covers the spring survey of the northern estuary, with provisional figures.",
        "",
        "## 2 Results",
        "",
        "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
        "",
      ].join("\n"),
    },
    {
      name: "Harbour Survey Brief.md",
      contents: [
        "# Harbour Survey Brief",
        "",
        "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
        "",
      ].join("\n"),
    },
  ],
  stated: {
    sentence:
      "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
    number: "40",
  },
  wrong: {
    sentence:
      "Raising the barrier crest by 60 centimetres halves the expected annual damage in the northern estuary.",
    number: "40",
  },
};

const ZH: Language = {
  documents: [
    {
      name: "灌区改造监测报告.md",
      contents: [
        "# 灌区改造监测报告",
        "",
        "本报告数据为初步数据，待秋收核定后更新。",
        "",
        "## 二、监测结果",
        "",
        "新渠道通水后，灌区内水稻亩产提高到510公斤。",
        "",
      ].join("\n"),
    },
    {
      name: "灌区情况简报.md",
      contents: ["# 灌区情况简报", "", "新渠道通水后，灌区内水稻亩产提高到510公斤。", ""].join(
        "\n",
      ),
    },
  ],
  stated: { sentence: "新渠道通水后，灌区内水稻亩产提高到510公斤。", number: "510" },
  wrong: { sentence: "新渠道通水后，灌区内水稻亩产提高到560公斤。", number: "510" },
};

/** The verdict lines Claude Haiku 5.5 wrote beside its `cite` call, with no marker. */
const verdictLines = (says: string) =>
  [
    "Verdict: supported",
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    "Roles: none, same",
    "Time: none / none, same",
    "",
    says,
    "",
    "Evidence: [1, 2]",
    "",
    "Cite records:",
  ].join("\n");

const REMAINDER_ASK = "gives no remainder";

/**
 * How the model splits its reply: `verdict` is where its verdict lines go ("cite": beside its
 * `cite` call; "search": beside its search, before it has looked), `remainder` whether its Figures
 * line gives one. Asked about its Figures line, it writes its whole reply again.
 */
interface Split {
  verdict: "cite" | "search";
  remainder: boolean;
  /** Its last turn: the Figures line, or a refusal in its place. */
  last?: "figures" | "refusal";
}

function splitting(language: Language, split: Split, calls: ModelCall[]) {
  const quote = (sentence: string) =>
    sentence === language.wrong.sentence ? language.stated.sentence : sentence;
  return scriptedModel(
    (call): ScriptedReply => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const sentence = sentenceOf(call);
      const says = `The Documents say: ${quote(sentence)}`;
      const searches = call.results.filter((result) => result.tool === "search_documents");
      const search = { tool: "search_documents", input: { query: sentence } };
      if (searches.length === 0)
        return split.verdict === "search"
          ? { text: verdictLines(says), calls: [search] }
          : { calls: [search] };
      const figuresLine = `Figures: ${JSON.stringify({
        items: requestedFigures(call).map(({ id }) => ({
          id,
          verdict: "supported",
          scope: "same",
          topic: "found",
          roles: "same",
          says: null,
          reading: null,
          relation: "equals",
          source: {
            citation: 1,
            number:
              sentence === language.wrong.sentence ? language.wrong.number : language.stated.number,
            reading: null,
            unitQuote: null,
          },
          calculation: null,
        })),
        ...(split.remainder && { remainder: null }),
      })}`;
      if (call.prompt.includes(REMAINDER_ASK))
        return {
          text: `${verdictLines(says)}\n\nFigures: ${JSON.stringify({
            ...JSON.parse(figuresLine.slice("Figures: ".length)),
            remainder: null,
          })}`,
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const shown = shownPassages(searches.at(-1)?.text ?? "").filter((each) =>
          each.text.includes(quote(sentence)),
        );
        const cite = {
          tool: "cite",
          input: {
            citations: shown
              .slice(0, 2)
              .map((each, index) => ({
                marker: index + 1,
                passage: each.id,
                quote: quote(sentence),
              })),
          },
        };
        return split.verdict === "cite"
          ? { text: verdictLines(says), calls: [cite] }
          : { calls: [cite] };
      }
      return {
        text: split.last === "refusal" ? "I'm sorry, I can't help with that." : figuresLine,
      };
    },
    { generate: checkGenerate({}) },
  );
}

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

/** Checks `sentence` against All Documents, as Check against Documents and Check again do. */
async function check(language: Language, sentence: string, split: Split) {
  const calls: ModelCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(splitting(language, split, calls)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(
      language.documents.map((each) => writeSourceFile(sources, each.name, each.contents)),
    ),
  );
  const mind = await core.createMind({ title: "Summary" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [paragraph("summary", sentence)]);
  await client.settled();
  await core.checkSentences({
    requestId: "check",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "summary", offset: 0 },
    to: { blockId: "summary", offset: sentence.length },
  });
  await client.settled();
  const span = claimSpans(readMind(client)).find((each) => each.sentence.text.trim() === sentence);
  core.close();
  return {
    check: span?.check,
    asks: calls.filter((call) => call.prompt.includes(REMAINDER_ASK)).length,
  };
}

describe.each([
  ["English", EN],
  ["Chinese", ZH],
])("a sentence a Document states word for word (#2184), in %s", (_name, language) => {
  test("is Supported when the verdict is written beside cite and the Figures line after it", async () => {
    const { check: stated } = await check(language, language.stated.sentence, {
      verdict: "cite",
      remainder: true,
    });
    expect(stated).toMatchObject({
      state: "supported",
      evidence: { quote: language.stated.sentence },
    });
    expect(stated?.figures?.map((figure) => figure.state)).toEqual(["supported"]);

    const { check: wrong } = await check(language, language.wrong.sentence, {
      verdict: "cite",
      remainder: true,
    });
    expect(wrong?.state).toBe("contradicted");
    expect(wrong?.figures?.map((figure) => figure.state)).toEqual(["contradicted"]);
  });

  test("a Figures line after the verdict that gives no remainder is asked for it once", async () => {
    const { check: stated, asks } = await check(language, language.stated.sentence, {
      verdict: "cite",
      remainder: false,
    });
    expect(asks).toBe(1);
    expect(stated?.state).toBe("supported");
  });

  test("a verdict written before the search, or a refusal for a last word, is never Supported", async () => {
    const { check: unlooked } = await check(language, language.stated.sentence, {
      verdict: "search",
      remainder: true,
    });
    expect(unlooked).toMatchObject({ state: "not-checked", reason: "malformed" });
    expect(unlooked?.figures?.map((figure) => figure.state)).toEqual(["supported"]);

    const { check: refused } = await check(language, language.stated.sentence, {
      verdict: "cite",
      remainder: true,
      last: "refusal",
    });
    expect(refused).toMatchObject({ state: "not-checked", reason: "refused" });
  });
});
