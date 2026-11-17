/**
 * A sentence a Document states word for word is Supported against All Documents (#2184), in the
 * shape Claude Haiku 5.5 replied in: it wrote a sentence's verdict lines in the turn that calls
 * `cite` and only its sentence after it. A verdict read from an earlier turn is never one a later
 * turn takes back.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, sentenceOf } from "../helpers/checks";
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
  /** A sentence the first Document states word for word, and the same about another place. */
  plain: { sentence: string; decoy: string };
  /** How a last turn after the verdict takes it back, in a sentence's place. */
  takesBack: { plain: string };
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
  plain: {
    sentence: "Rock armour should replace the timber groynes along the southern shore.",
    decoy: "Rock armour should replace the timber groynes along the northern shore.",
  },
  takesBack: {
    plain:
      "On a second reading, the Documents don't support this: they name the southern shore. [^1]",
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
  plain: {
    sentence: "下游村庄的饮用水已改由新建水厂统一供应。",
    decoy: "上游村庄的饮用水已改由新建水厂统一供应。",
  },
  takesBack: {
    plain: "再次核对后，文件并不支持这一说法：文件写的是下游村庄。[^1]",
  },
};

/** A verdict the reader can't take, in each way a turn after a Supported one may give it. */
const UNREAD_VERDICTS = [
  "Verdict: not supported",
  "结论：不支持",
  "Verdict: partly supported",
  "Verdict: no",
  "结论：不成立",
];

/** The verdict lines Claude Haiku 5.5 wrote beside its `cite` call, with no marker. */
const verdictLines = (says: string) =>
  ["Verdict: supported", `Explanation: ${says}`, "", "Evidence: [1]", "", "Cite records:"].join(
    "\n",
  );

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
  return { check: span?.check };
}

/**
 * A model that checks a sentence with no figure as Claude Haiku 5.5 did (#1673): its verdict lines
 * beside `cite`, Supported, then `last` as its last turn, a refusal beside a second `cite` call
 * between them with `refusesBetween`.
 */
function plainSplitting(quote: string, last: string, refusesBetween = false) {
  return (calls: ModelCall[]) =>
    scriptedModel(
      (call): ScriptedReply => {
        if (!isCheckRun(call)) return { text: "" };
        calls.push(call);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        const [passage] = shownPassages(searches.at(-1)?.text ?? "").filter((each) =>
          each.text.includes(quote),
        );
        const cite = (marker: number) => ({
          tool: "cite",
          input: { citations: [{ marker, passage: passage?.id, quote }] },
        });
        const cites = call.results.filter((result) => result.tool === "cite").length;
        if (cites === 0)
          return { text: verdictLines(`The Documents say: ${quote}`), calls: [cite(1)] };
        if (refusesBetween && cites === 1)
          return { text: "I'm sorry, I can't help with that.", calls: [cite(2)] };
        return { text: last };
      },
      { generate: checkGenerate({}) },
    );
}

describe.each([
  ["English", EN],
  ["Chinese", ZH],
])(
  "a sentence with no figure whose verdict is set aside beside cite (#1673, #2184), in %s",
  (_name, language) => {
    test("is Supported with the sentence after it, and never past a verdict that takes it back", async () => {
      const { sentence, decoy } = language.plain;
      const { check: stated } = await checkWith(
        language,
        sentence,
        plainSplitting(sentence, `The Documents say: ${sentence} [^1]`),
      );
      expect(stated).toMatchObject({ state: "supported", evidence: { quote: sentence } });

      for (const taken of [...UNREAD_VERDICTS, language.takesBack.plain]) {
        const { check: decoyCheck } = await checkWith(
          language,
          decoy,
          plainSplitting(sentence, `${taken}\nThe Documents say: ${sentence} [^1]`),
        );
        expect(decoyCheck, taken).toMatchObject({ state: "not-checked", reason: "malformed" });
      }
    });

    test("a refusal set aside after the verdict takes it back", async () => {
      const { sentence, decoy } = language.plain;
      const { check: refused } = await checkWith(
        language,
        decoy,
        plainSplitting(sentence, `The Documents say: ${sentence} [^1]`, true),
      );
      expect(refused).toMatchObject({ state: "not-checked", reason: "malformed" });

      const { check: stated } = await checkWith(
        language,
        sentence,
        plainSplitting(sentence, `The Documents say: ${sentence} [^1]`),
      );
      expect(stated?.state).toBe("supported");
    });
  },
);

// protects=a sentence a Document states word for word stays Supported when the Document holds one of the check's tags (a TEI "<quote>"), the same tag written as "&lt;quote>", or code with "<" (#2423): the check reads the tag defused, and the quote it copies so still matches the Document; a Document's own "&lt;" and code are quoted as written; in English and Chinese; fails_when=either quote reads as not found, or code is changed; no_claim=how a real model quotes.
describe.each([
  ["English", EN],
  ["Chinese", ZH],
] as const)(
  "a Document holding a check's tag or code with “<” (#2423), in %s",
  (_name, language) => {
    test.each([
      {
        sentence: "The edition marks each speech with a <quote> element.",
        shown: "The edition marks each speech with a &lt;quote> element.",
      },
      {
        sentence: "The page escapes each speech as &lt;quote> in its HTML.",
        shown: "The page escapes each speech as &lt;quote> in its HTML.",
      },
      {
        sentence: "The loop goes on while i<sentence.length holds.",
        shown: "The loop goes on while i<sentence.length holds.",
      },
    ])("“$sentence” stays Supported", async ({ sentence, shown }) => {
      const withTags = {
        ...language,
        documents: [{ name: "Edition notes.md", contents: `# Edition notes\n\n${sentence}\n` }],
      };
      const { check } = await checkWith(
        withTags,
        sentence,
        plainSplitting(shown, `The Documents say: ${shown} [^1]`),
      );
      expect(check).toMatchObject({ state: "supported", evidence: { quote: sentence } });
    });
  },
);
