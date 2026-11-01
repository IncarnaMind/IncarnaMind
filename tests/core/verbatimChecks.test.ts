/**
 * A sentence a Document states word for word is Supported against All Documents (#2184), in the
 * shapes Claude Haiku 5.5 replied in. It wrote a sentence's verdict lines in the turn that calls
 * `cite` and its Figures line alone after it: the check read only the last turn, found no verdict,
 * and the sentence came back "The model's reply couldn't be read". And it wrote a quote into its
 * reply instead of calling `cite`, then, asked for that marker's record, gave the record alone:
 * the check read only a list of records, and the sentence came back Not checked.
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
  /** A sentence with no figure the first Document states word for word, and a paraphrase of it. */
  plain: { sentence: string; paraphrase: string };
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
        "Rock armour should replace the timber groynes along the southern shore.",
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
        "Rock armour should replace the timber groynes along the southern shore.",
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
  plain: {
    sentence: "Rock armour should replace the timber groynes along the southern shore.",
    paraphrase: "The southern shore's timber groynes should give way to rock armour.",
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
        "下游村庄的饮用水已改由新建水厂统一供应。",
        "",
      ].join("\n"),
    },
    {
      name: "灌区情况简报.md",
      contents: [
        "# 灌区情况简报",
        "",
        "新渠道通水后，灌区内水稻亩产提高到510公斤。",
        "",
        "下游村庄的饮用水已改由新建水厂统一供应。",
        "",
      ].join("\n"),
    },
  ],
  stated: { sentence: "新渠道通水后，灌区内水稻亩产提高到510公斤。", number: "510" },
  wrong: { sentence: "新渠道通水后，灌区内水稻亩产提高到560公斤。", number: "510" },
  plain: {
    sentence: "下游村庄的饮用水已改由新建水厂统一供应。",
    paraphrase: "新建水厂现在统一为下游村庄供应饮用水。",
  },
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
  /** A refusal beside a second `cite` call, after the verdict and before the Figures line. */
  refusesBetween?: boolean;
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
            citations: shown.slice(0, 2).map((each, index) => ({
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
      const cites = call.results.filter((result) => result.tool === "cite").length;
      if (split.refusesBetween && cites === 1) {
        const [first] = shownPassages(searches.at(-1)?.text ?? "").filter((each) =>
          each.text.includes(quote(sentence)),
        );
        return {
          text: "I'm sorry, I can't help with that.",
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 3, passage: first?.id, quote: quote(sentence) }] },
            },
          ],
        };
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
async function checkWith(
  language: Language,
  sentence: string,
  model: (calls: ModelCall[]) => ReturnType<typeof scriptedModel>,
) {
  const calls: ModelCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model(calls)).createChatModel,
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

const check = (language: Language, sentence: string, split: Split) =>
  checkWith(language, sentence, (calls) => splitting(language, split, calls));

/**
 * A model that writes its quote into its reply instead of calling `cite`, as Claude Haiku 5.5 did,
 * then, asked for that marker's record, gives the record alone with `given` as its quote.
 */
/**
 * With `second`, the model records marker 1 with `cite`, names markers 1 and 2 on its Evidence
 * line and writes only marker 2's record into its reply; asked for marker 2, it gives a record
 * alone (copying marker 1's quote), or the list the ask names with the second Passage's quote.
 */
function writingItsRecord(sentence: string, given: string, second?: "alone" | "list") {
  return (calls: ModelCall[]) =>
    scriptedModel(
      (call): ScriptedReply => {
        if (!isCheckRun(call)) return { text: "" };
        calls.push(call);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        const [first, other] = shownPassages(searches.at(-1)?.text ?? "").filter((each) =>
          each.text.includes(sentence),
        );
        if (second && !call.results.some((result) => result.tool === "cite"))
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: first?.id, quote: sentence }] },
              },
            ],
          };
        const marker = second ? 2 : 1;
        return {
          text: [
            verdictLines(`The Documents say: ${sentence} [^1]`).replace(
              "Evidence: [1, 2]",
              second ? "Evidence: [1, 2]" : "Evidence: [1]",
            ),
            "",
            `Cite: marker ${marker} → passage ${(second ? other : first)?.id}, quote "${sentence}"`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (!call.system.startsWith("You checked a sentence")) return checkGenerate({})(call);
          const passages = [
            ...call.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
          ]
            .filter((each) => each[2]?.includes(sentence))
            .map((each) => each[1]);
          if (second === "list")
            return {
              text: JSON.stringify({
                citations: [
                  { marker: 2, passage: passages[1], location: "§ Results", quote: given },
                ],
              }),
            };
          return {
            text: JSON.stringify({ passage: passages[0], location: "§ Results", quote: given }),
          };
        },
      },
    );
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

    const { check: refusedBetween } = await check(language, language.stated.sentence, {
      verdict: "cite",
      remainder: true,
      refusesBetween: true,
    });
    expect(refusedBetween).toMatchObject({ state: "not-checked", reason: "malformed" });
    expect(refusedBetween?.figures?.map((figure) => figure.state)).toEqual(["supported"]);
  });
});

describe.each([
  ["English", EN],
  ["Chinese", ZH],
])(
  "a quote written into the reply, given alone when asked for (#2184), in %s",
  (_name, language) => {
    test("is the sentence's evidence when the Passage holds it, and never when it doesn't", async () => {
      const { sentence, paraphrase } = language.plain;
      const { check: held } = await checkWith(
        language,
        sentence,
        writingItsRecord(sentence, sentence),
      );
      expect(held).toMatchObject({ state: "supported", evidence: { quote: sentence } });

      const { check: unheld } = await checkWith(
        language,
        sentence,
        writingItsRecord(sentence, paraphrase),
      );
      expect(unheld).toMatchObject({ state: "not-checked", reason: "no-evidence" });
    });

    test("is never filed under one of two markers the reply names, which the list the ask names is", async () => {
      const { sentence } = language.plain;
      const { check: alone } = await checkWith(
        language,
        sentence,
        writingItsRecord(sentence, sentence, "alone"),
      );
      expect(alone).toMatchObject({ state: "not-checked", reason: "no-evidence" });

      const { check: listed } = await checkWith(
        language,
        sentence,
        writingItsRecord(sentence, sentence, "list"),
      );
      expect(listed).toMatchObject({ state: "supported", evidence: { quote: sentence } });
    });
  },
);
