/**
 * Display mathematics in Markdown (#2422): a formula Block only when its
 * closer is there, and the same Markdown read the same way by an Answer and
 * by the Minds' Tools an outside agent writes through.
 */
import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import { askAssistant } from "../helpers/assistant";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, heading, note, readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** A line a model may write that starts with an escaped bracket and never closes it. */
const UNCLOSED_EN = String.raw`\[note:1] is higher than the shelf below.`;
const UNCLOSED_ZH = String.raw`\[note:1] 比下面一层架子更高。`;
/** The same two lines as the paragraph shows them: the escape is a "[" like any other. */
const SHOWN_EN = "[note:1] is higher than the shelf below.";
const SHOWN_ZH = "[note:1] 比下面一层架子更高。";

/** A Block's type and words, a formula's words as "$…$". */
function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "inlineMath") return `$${node.attrs?.latex ?? ""}$`;
  return (node.content ?? []).map(textOf).join(node.type === "paragraph" ? "" : " / ");
}

const blocksOf = (blocks: readonly JSONContent[]): { type: string; text: string }[] =>
  blocks.map((block) => ({ type: block.type ?? "", text: textOf(block) }));

describe("display mathematics in Markdown", () => {
  test("a line that starts with \\[ and never closes it stays a paragraph, in English and Chinese", () => {
    expect(markdownToBlocks(UNCLOSED_EN)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: SHOWN_EN }] },
    ]);
    expect(markdownToBlocks(UNCLOSED_ZH)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: SHOWN_ZH }] },
    ]);
  });

  test("100,000 lines that each start with an unclosed \\[ finish, each its own paragraph, in English and Chinese", () => {
    for (const [line, shown] of [
      [(n: number) => `\\[note:${n}] is text.`, (n: number) => `[note:${n}] is text.`],
      [(n: number) => `\\[note:${n}] 是文字。`, (n: number) => `[note:${n}] 是文字。`],
    ] as const) {
      const text = Array.from({ length: 100_000 }, (_, n) => line(n)).join("\n");
      const blocks = markdownToBlocks(text);
      expect(blocks).toHaveLength(100_000);
      for (const n of [0, 50_000, 99_999])
        expect(blocks[n]).toEqual({
          type: "paragraph",
          content: [{ type: "text", text: shown(n) }],
        });
    }
  });

  test("a real formula still closes and formats, and the openers after it are text", () => {
    expect(markdownToBlocks("\\[ x^2 \\]\n\\[note:1] is higher.\n\\[note:2] is lower.")).toEqual([
      { type: "blockMath", attrs: { latex: "x^2" } },
      { type: "paragraph", content: [{ type: "text", text: "[note:1] is higher." }] },
      { type: "paragraph", content: [{ type: "text", text: "[note:2] is lower." }] },
    ]);
  });

  test("a real formula after an opener in a list still closes and formats", () => {
    expect(markdownToBlocks("- \\[note:1] is text.\n\\[ x^2 \\]")).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "[note:1] is text." }] },
            ],
          },
        ],
      },
      { type: "blockMath", attrs: { latex: "x^2" } },
    ]);
  });

  test("real display math is still a formula", () => {
    expect(markdownToBlocks(String.raw`\[ x^2 \]`)).toEqual([
      { type: "blockMath", attrs: { latex: "x^2" } },
    ]);
    expect(markdownToBlocks("$$\nx^2\n$$")).toEqual([
      { type: "blockMath", attrs: { latex: "x^2" } },
    ]);
  });

  test("a formula that closes on a line below is still a formula", () => {
    expect(markdownToBlocks("\\[\nx^2 + y^2\n\\]")).toEqual([
      { type: "blockMath", attrs: { latex: "x^2 + y^2" } },
    ]);
  });

  test("an unclosed $$ runs to the end as a formula, as before", () => {
    expect(markdownToBlocks("$$\nx^2")).toEqual([{ type: "blockMath", attrs: { latex: "x^2" } }]);
  });
});

describe("an Answer that starts with an unclosed \\[", { timeout: 30_000 }, () => {
  /** A core with a local chat model, a Mind, and a model that writes `line` as its Answer. */
  async function setUpAnswering(line: string) {
    const model = scriptedModel((): ScriptedReply => ({ text: line }));
    const { core, client, mind } = await setUpWithDocuments(model, []);
    return { core, client, mind };
  }

  test.each([
    ["English", UNCLOSED_EN, SHOWN_EN],
    ["Chinese", UNCLOSED_ZH, SHOWN_ZH],
  ])("keeps its words in a paragraph (%s)", async (_language, line, shown) => {
    const { core, client, mind } = await setUpAnswering(line);

    const { answerId } = await askAndFinish(core, client, mind.id, "Which shelf is higher?");

    const answer = answerIn(client, answerId).toJSON() as JSONContent;
    expect(blocksOf(answer.content ?? [])).toEqual([{ type: "paragraph", text: shown }]);
  });
});

describe("the Minds' Tools an outside agent writes through", { timeout: 30_000 }, () => {
  /** A core with a local chat model, a Mind to add to, and a model that adds `line` to it. */
  async function setUpAdding(line: string) {
    const model: MockLanguageModelV4 = scriptedModel(
      (call: ModelCall): ScriptedReply =>
        call.results.length === 0
          ? { calls: [{ tool: "add_to_mind", input: { content: line } }] }
          : { text: "Added it." },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Shelf" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(2, "Notes"), note("Check the shelf.")]);
    await client.settled();
    return { core, client, mind };
  }

  test.each([
    ["English", UNCLOSED_EN, SHOWN_EN],
    ["Chinese", UNCLOSED_ZH, SHOWN_ZH],
  ])(
    "keep a line that starts with an unclosed \\[ as one paragraph of words (%s)",
    async (_language, line, shown) => {
      const { core, client, mind } = await setUpAdding(line);

      await askAssistant(core, { text: "Add this to my notes", mindId: mind.id });

      await client.settled();
      expect(blocksOf((readMind(client).toJSON().content ?? []) as JSONContent[])).toEqual([
        { type: "heading", text: "Notes" },
        { type: "paragraph", text: "Check the shelf." },
        { type: "paragraph", text: shown },
      ]);
    },
  );
});
