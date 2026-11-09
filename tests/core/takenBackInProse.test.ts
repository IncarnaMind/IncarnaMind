/**
 * A Supported verdict written beside `cite`, then a last turn of words that aren't a verdict (#2184):
 * #1673's sentence after the verdict, or words that take it back without any of a verdict's words.
 * No reader can tell the two apart, so the verdict's quote is judged once: Supported only when the
 * judgement finds it says what the sentence says, else Not checked.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, SAME_DETAIL, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

const CASES = [
  {
    name: "English",
    document: {
      name: "Shore Survey.md",
      contents:
        "# Shore Survey\n\n## Findings\n\nRock armour should replace the timber groynes along the southern shore.\n",
    },
    stated: "Rock armour should replace the timber groynes along the southern shore.",
    decoy: "Rock armour should replace the timber groynes along the northern shore.",
    takenBack: "Scratch that, the Document names the southern shore. [^1]",
  },
  {
    name: "Chinese",
    document: {
      name: "供水情况.md",
      contents: "# 供水情况\n\n## 结果\n\n下游村庄的饮用水已改由新建水厂统一供应。\n",
    },
    stated: "下游村庄的饮用水已改由新建水厂统一供应。",
    decoy: "上游村庄的饮用水已改由新建水厂统一供应。",
    takenBack: "其实原文并没有这样说，原文写的是下游村庄。[^1]",
  },
];

const verdictLines = (sentence: string, explained: boolean) =>
  [
    "Verdict: supported",
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    `Roles: ${sentence} / ${sentence}, same`,
    "Time: none / none, same",
    SAME_DETAIL,
    ...(explained ? [`Explanation: The Documents say: ${sentence}`] : []),
    "Evidence: [1]",
  ].join("\n");

/** Its verdict lines beside `cite`, quoting `quote`, then `last` as the Run's last turn. */
function split(quote: string, last: string, explained: boolean, asked: string[]) {
  return scriptedModel(
    (call): ScriptedReply => {
      if (!isCheckRun(call)) return { text: "" };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
      const [passage] = shownPassages(searches.at(-1)?.text ?? "").filter((each) =>
        each.text.includes(quote),
      );
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          text: verdictLines(sentenceOf(call), explained),
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      return { text: last };
    },
    {
      generate: (call) => {
        if (call.question) asked.push(call.question);
        return checkGenerate({ [quote]: { judgement: "same" } })(call);
      },
    },
  );
}

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

async function check(
  document: { name: string; contents: string },
  sentence: string,
  model: ReturnType<typeof scriptedModel>,
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, document.name, document.contents)]);
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
  return span?.check;
}

describe.each(CASES)(
  "a Supported verdict set aside, then words of a last turn, in $name",
  (each) => {
    test.each([true, false])(
      "taken back with none of a verdict's words is never Supported, its Explanation beside cite: %s",
      async (explained) => {
        const asked: string[] = [];
        const decoy = await check(
          each.document,
          each.decoy,
          split(each.stated, each.takenBack, explained, asked),
        );
        expect(decoy).toMatchObject({ state: "not-checked", reason: "malformed" });
        expect(asked.filter((question) => question === "strict")).toHaveLength(1);
      },
    );

    test("its sentence after the verdict, judged to say the sentence, stays Supported", async () => {
      const asked: string[] = [];
      const stated = await check(
        each.document,
        each.stated,
        split(each.stated, `The Documents say: ${each.stated} [^1]`, false, asked),
      );
      expect(stated).toMatchObject({ state: "supported", evidence: { quote: each.stated } });
      expect(asked.filter((question) => question === "strict")).toHaveLength(1);
    });
  },
);
