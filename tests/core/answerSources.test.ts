/**
 * What an Answer in the assistant was sent, and where it found what it says:
 * the record its steps line is read from. A small scope's Documents go with
 * the Question as Passages, so the model may cite one with no search, or cite
 * none; the Answer records which Documents went whole, by id, beside the Mind
 * it read.
 */
import { describe, expect, test } from "vitest";
import type { ConversationAnswer } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const LEASE = [
  "租赁合同-2026",
  "租期：2026 年 3 月 1 日至 2029 年 2 月 28 日，共三年。",
  "月租金：人民币 4,800 元整。",
  "押金：人民币 9,600 元。",
].join("\n");
const CREDIT_FINDING = "申请人的息税折旧摊销前利润为 3.1 亿元，贷款协议规定杠杆比率不超过 3.5 倍。";
const CREDIT_REPORT = ["授信委员会报告（草稿）", CREDIT_FINDING].join("\n");
const NDA = ["保密协议-2026", "保密期限：自签署之日起五年。"].join("\n");
const QUESTION = "租赁合同-2026 里的租期、月租金和押金分别是多少？";
const RENT = "月租金：人民币 4,800 元整。";

const upFrontIn = (prompt: string) =>
  /<document-text>[\s\S]*?<\/document-text>/.exec(prompt)?.[0] ?? "";

/**
 * A model that, given Passages with the Question, cites the lease's rent from
 * them (`cites`) or cites nothing; given none, it searches for the Question.
 */
function answeringFromWhatItIsGiven(cites: boolean) {
  const searched: string[] = [];
  const model = scriptedModel(
    (call: ModelCall) => {
      // The Answer's sentence is then checked against its quote (#2311): no search of the Answer's.
      if (isCheckRun(call)) {
        return checkReply(call, {
          "月租金为人民币 4,800 元。": { verdict: "supported", quote: RENT },
        });
      }
      const given = shownPassages(upFrontIn(call.prompt));
      if (given.length === 0) {
        if (call.results.some((result) => result.tool === "search_documents")) {
          return { text: "没有找到相关内容。" };
        }
        searched.push(call.prompt);
        return { calls: [{ tool: "search_documents", input: { query: QUESTION } }] };
      }
      if (!cites) return { text: "这些文档我都看过，但我拿不准。" };
      const lease = given.find((each) => each.text.includes(RENT));
      if (!lease) throw new Error("The lease wasn't sent.");
      if (!call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: lease.id, quote: RENT }] } },
          ],
        };
      }
      return { text: "月租金为人民币 4,800 元[^1]。" };
    },
    { judgesItsAnswers: true },
  );
  return { model, searched };
}

/** A core with `files` added to the Library and a Mind with some text open; the Mind's id and the Documents' ids by name. */
async function setUp(
  model: ReturnType<typeof scriptedModel>,
  files: readonly { name: string; text: string }[],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  const paths: string[] = [];
  for (const file of files)
    paths.push(await writeSourceFile(sources, `${file.name}.md`, file.text));
  const added = await addAndProcess(core, paths, 60_000);
  const ids = Object.fromEntries(files.map((file, at) => [file.name, added[at]?.id ?? ""]));
  const mind = await core.createMind({ title: "授信委员会报告（草稿）" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, "授信委员会报告（草稿）"), note(CREDIT_FINDING)]);
  await client.settled();
  return { core, mind, ids };
}

const sentOf = (answer: ConversationAnswer) => answer.steps?.sent?.documents.toSorted();

describe("An Answer's record of what its request held", { timeout: 120_000 }, () => {
  // protects=a Question about a short Document, asked beside another Mind, is answered from the text given with it: the stored Answer has no search call, cites the lease, found, records the Mind in focus as read and both Documents as sent whole; fails_when=a search call is invented, the Citation points elsewhere, or a Document sent isn't recorded; no_claim=how a real model chooses between a search and the text it was given.
  test("cites a Document with no search, and records the Mind read and the Documents sent", async () => {
    const { model, searched } = answeringFromWhatItIsGiven(true);
    const { core, mind, ids } = await setUp(model, [
      { name: "授信委员会报告（草稿）", text: CREDIT_REPORT },
      { name: "租赁合同-2026", text: LEASE },
    ]);

    const answer = await askAssistant(core, { text: QUESTION, mindId: mind.id });

    expect(searched).toEqual([]);
    expect(answer.toolCalls).toEqual([]);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({ documentId: ids["租赁合同-2026"], check: "found" });
    expect(answer.read).toMatchObject({ mindId: mind.id, deleted: false });
    expect(sentOf(answer)).toEqual(
      [ids["授信委员会报告（草稿）"], ids["租赁合同-2026"]].toSorted(),
    );
    expect(answer.steps?.sent).not.toHaveProperty("transcript");
  });

  // protects=three short Documents are sent whole and the model cites only one, or none: all three are recorded either way, by id and no text; fails_when=only the cited Document is recorded, or none when nothing is cited; no_claim=none beyond protects.
  test("records every Document sent whole, whether the model cites one or none", async () => {
    for (const cites of [true, false]) {
      const { model } = answeringFromWhatItIsGiven(cites);
      const { core, mind, ids } = await setUp(model, [
        { name: "授信委员会报告（草稿）", text: CREDIT_REPORT },
        { name: "租赁合同-2026", text: LEASE },
        { name: "保密协议-2026", text: NDA },
      ]);

      const answer = await askAssistant(core, { text: QUESTION, mindId: mind.id });

      expect(answer.citations).toHaveLength(cites ? 1 : 0);
      expect(answer.toolCalls).toEqual([]);
      expect(sentOf(answer)).toEqual(Object.values(ids).toSorted());
      expect(JSON.stringify(answer.steps?.sent)).not.toContain("月租金");
    }
  });

  // protects=a scope of more than a dozen Documents sends none whole, so the Answer records none sent and its searches stand; fails_when=Documents are recorded as sent that weren't, or the search isn't recorded; no_claim=none beyond protects.
  test("a long scope sends nothing whole: the record says so, and the Answer searches", async () => {
    const { model, searched } = answeringFromWhatItIsGiven(true);
    const many = Array.from({ length: 13 }, (_, at) => ({
      name: `备忘录-${at + 1}`,
      text: `备忘录 ${at + 1}\n租赁合同-2026 的月租金：人民币 4,800 元整。`,
    }));
    const { core, mind } = await setUp(model, many);

    const answer = await askAssistant(core, { text: QUESTION, mindId: mind.id });

    expect(searched).toHaveLength(1);
    expect(answer.steps?.sent).toEqual({ documents: [] });
    expect(answer.toolCalls.map((call) => call.tool)).toEqual(["search_documents"]);
  });
});
