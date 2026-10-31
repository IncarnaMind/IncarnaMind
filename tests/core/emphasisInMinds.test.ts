import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind, resolveChanges } from "../helpers/minds";
import { type ScriptedReply, scriptedModel } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides happen at new moon and at full moon.",
};

/** The #1774 strings and the shapes a number or a Latin word makes, each paragraph one sentence. */
const PARAGRAPHS = [
  "**上限：**每月五千元。",
  "**上限**：每月五千元。",
  "每月五千元**（含税）**。",
  "**上限，**五千元。",
  "**上限。**五千元。",
  "**上限：**5000 元。",
  "**金额（万元）：**1,200。",
  "每月5000**（含税）**。",
  "**期限：**2026 年 3 月。",
  "见**《合同法》**5条。",
  "**Total：**5,000 元。",
];
const PAGE = `## 费用\n\n${PARAGRAPHS.join("\n\n")}`;
const BOLD = [
  "上限：",
  "上限",
  "（含税）",
  "上限，",
  "上限。",
  "上限：",
  "金额（万元）：",
  "（含税）",
  "期限：",
  "《合同法》",
  "Total：",
];
const PHRASES = PARAGRAPHS.map((each) => each.replace(/\*\*/g, ""));
/** What a check reads as sentences: one per 。, which a bold label can end. */
const SENTENCES = PHRASES.flatMap((phrase) => phrase.match(/[^。]*。|[^。]+$/g) ?? []);

interface Run {
  text: string;
  bold: boolean;
}

describe("bold beside Chinese punctuation in a Note's page and a check card", () => {
  test("a Note the assistant writes holds the words bold, with no asterisks, and its check's card reads every sentence as words", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      if (call.results.some((result) => result.tool === "create_mind")) {
        return { text: "写好了一页。" };
      }
      return { calls: [{ tool: "create_mind", input: { title: "费用", content: PAGE } }] };
    });
    const { core, mind } = await setUpWithDocuments(model, [TIDES]);

    const answer = await askAssistant(core, { text: "写一页关于费用的说明", mindId: mind.id });
    const made = changesIn(answer).find((change) => change.created);
    if (!made) throw new Error("The Answer made no Note.");
    const client = await connectToMind(core, made.mindId);
    await client.settled();
    await resolveChanges(client, "accept");
    await client.settled();

    const runs: Run[] = [];
    readMind(client).descendants((node) => {
      if (node.isText) {
        runs.push({
          text: node.text ?? "",
          bold: node.marks.some((mark) => mark.type.name === "bold"),
        });
      }
      return true;
    });
    expect(runs.map((run) => run.text).join("")).not.toContain("*");
    expect(runs.filter((run) => run.bold).map((run) => run.text)).toEqual(BOLD);
    expect(runs.map((run) => run.text).join("")).toBe(["费用", ...PHRASES].join(""));

    const blocks = (readMind(client).toJSON().content ?? []) as (JSONContent & {
      attrs: { id: string };
    })[];
    const paragraphs = blocks.filter((node) => node.type === "paragraph");
    const first = paragraphs[0];
    const last = paragraphs.at(-1);
    if (!first || !last) throw new Error("The paragraphs aren't in the Note.");
    const lengthOf = (node: JSONContent) =>
      (node.content ?? []).reduce(
        (total, child) => total + (child.type === "hardBreak" ? 1 : (child.text ?? "").length),
        0,
      );
    const result = await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: made.mindId,
      action: "check-against-documents",
      from: { blockId: first.attrs.id, offset: 0 },
      to: { blockId: last.attrs.id, offset: lengthOf(last) },
    });
    expect(result.kind).toBe("checked");
    await client.settled();
    const sentences = claimSpans(readMind(client)).map((span) => span.sentence.text);
    for (const sentence of SENTENCES) expect(sentences).toContain(sentence);
    expect(sentences.join("")).not.toContain("*");
  });
});
