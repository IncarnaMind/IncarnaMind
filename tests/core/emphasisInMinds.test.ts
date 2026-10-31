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

/** The #1774 strings, each paragraph one sentence, as a model writes them into a Note. */
const PARAGRAPHS = [
  "**上限：**每月五千元。",
  "**上限**：每月五千元。",
  "每月五千元**（含税）**。",
  "**上限，**五千元。",
  "**上限。**五千元。",
];
const PAGE = `## 费用\n\n${PARAGRAPHS.join("\n\n")}`;

interface Run {
  text: string;
  bold: boolean;
}

describe("bold beside Chinese punctuation in a Note's page and a check card", () => {
  test("a Note the assistant writes holds the words bold, with no asterisks, and its check's card reads them as words", async () => {
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
    expect(runs.filter((run) => run.bold).map((run) => run.text)).toEqual([
      "上限：",
      "上限",
      "（含税）",
      "上限，",
      "上限。",
    ]);
    const page = runs.map((run) => run.text).join("");
    expect(page).toBe(["费用", ...PARAGRAPHS.map((each) => each.replace(/\*\*/g, ""))].join(""));

    const blocks = (readMind(client).toJSON().content ?? []) as (JSONContent & {
      attrs: { id: string };
    })[];
    const block = blocks.find(
      (node) =>
        node.type === "paragraph" &&
        (node.content ?? []).some((child) => (child.text ?? "").includes("（含税）")),
    );
    if (!block) throw new Error("The paragraph isn't in the Note.");
    const text = (block.content ?? []).map((child) => child.text ?? "").join("");
    const result = await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: made.mindId,
      action: "check-against-documents",
      from: { blockId: block.attrs.id, offset: 0 },
      to: { blockId: block.attrs.id, offset: text.length },
    });
    expect(result.kind).toBe("checked");
    await client.settled();
    const sentences = claimSpans(readMind(client)).map((span) => span.sentence.text);
    expect(sentences).toContain("每月五千元（含税）。");
    expect(sentences.join("")).not.toContain("*");
  });
});
