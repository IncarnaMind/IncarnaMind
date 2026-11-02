/**
 * Edit with AI's last check on what it writes (#2424), against a real model: honest edits of
 * cited paragraphs, in English and Chinese, with a footnote, across the actions and the
 * instructions Users ask for, must never be refused as holding a Citation, footnote or figure
 * the reply didn't place. Runs only with a key in the environment, so `npx vitest run` makes
 * no request without one:
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep each edit's outcome.
 */
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { CITATION_NODE, type Document, type EditAction, FOOTNOTE_NODE } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const apiKey = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const model =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year, so that ships can plan their arrivals.",
  ].join("\n"),
};
const CHAOXI = {
  name: "潮汐.md",
  contents: "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
};

const cited = (document: Document, quote: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "passage",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    quote,
    check: "found",
  },
});

/** Requests none of the unit tests use: a held-out set. */
const CASES: { blocks: string[]; action: EditAction; instruction?: string }[] = [
  { blocks: ["english"], action: "improve" },
  { blocks: ["english"], action: "shorten" },
  { blocks: ["english"], action: "instruction", instruction: "Make it more formal." },
  {
    blocks: ["english"],
    action: "instruction",
    instruction: "Turn this into a table with the tide, when it comes, and its source.",
  },
  {
    blocks: ["english"],
    action: "instruction",
    instruction: "Add a sentence on why harbours publish the times, citing the same source.",
  },
  { blocks: ["english"], action: "instruction", instruction: "Remove the second sentence." },
  { blocks: ["english"], action: "instruction", instruction: "Split this into two paragraphs." },
  { blocks: ["english"], action: "translate", instruction: "Simplified Chinese (简体中文)" },
  { blocks: ["chinese"], action: "improve" },
  { blocks: ["chinese"], action: "shorten" },
  { blocks: ["chinese"], action: "translate", instruction: "English" },
  { blocks: ["chinese"], action: "instruction", instruction: "把它改写成两个要点的列表。" },
  { blocks: ["english", "second"], action: "shorten" },
  {
    blocks: ["english", "second"],
    action: "instruction",
    instruction: "Merge these into one paragraph.",
  },
];

test.skipIf(apiKey === undefined)(
  `Edit with AI, live: ${CASES.length} honest edits are never refused for what they cite (#2424)`,
  { timeout: 900_000 },
  async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", ...(apiKey && { apiKey }), modelId: model });
    const [tides, chaoxi] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, CHAOXI.name, CHAOXI.contents),
    ])) as [Document, Document];
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const outcomes: string[] = [];
    for (const each of CASES) {
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "english" },
          content: [
            { type: "text", text: "the spring tides they happens at new moon and full moon " },
            cited(tides, "Spring tides happen at new moon and at full moon"),
            { type: "text", text: ". harbours publishes the times of high water every year " },
            cited(tides, "Harbours publish the times of high water every year"),
            { type: "text", text: "." },
            {
              type: FOOTNOTE_NODE,
              attrs: { id: "note" },
              content: [{ type: "text", text: "From the harbour office's tables." }],
            },
          ],
        },
        {
          type: "paragraph",
          attrs: { id: "second" },
          content: [
            { type: "text", text: "Ships plans their arrivals by these times " },
            cited(tides, "so that ships can plan their arrivals"),
            { type: "text", text: "." },
          ],
        },
        {
          type: "paragraph",
          attrs: { id: "chinese" },
          content: [
            { type: "text", text: "大潮一般是在新月和满月的前后出现的的，" },
            cited(chaoxi, "大潮出现在新月和满月前后"),
            { type: "text", text: "因为太阳和月亮的引力它们叠加在一起。" },
          ],
        },
      ]);
      await client.settled();
      const sizes = new Map<string, number>();
      const plain = new Map<string, string>();
      readMind(client).descendants((node) => {
        if (!node.isTextblock) return true;
        const id = String(node.attrs.id);
        // As the editor reads it: an inline node as one character, a footnote's text not at all.
        let words = "";
        node.forEach((child) => {
          words += child.isText ? (child.text ?? "") : "￼";
        });
        plain.set(id, words);
        sizes.set(id, words.length);
        return false;
      });
      const first = each.blocks[0] ?? "";
      const last = each.blocks.at(-1) ?? first;
      const result = await core.editWithAi({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        from: { blockId: first, offset: 0 },
        to: { blockId: last, offset: sizes.get(last) ?? 0 },
        text: each.blocks.map((id) => plain.get(id) ?? "").join("\n"),
        action: each.action,
        ...(each.instruction && { instruction: each.instruction }),
      });
      await client.settled();
      outcomes.push(result.kind);
      const said =
        result.kind === "proposed"
          ? `, ${result.proposals} changes`
          : result.kind === "failed"
            ? `: ${result.error.message}`
            : "";
      const line = `${each.action}${each.instruction ? ` (${each.instruction})` : ""} on ${each.blocks.join("+")}: ${result.kind}${said}`;
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${line}\n`);
      }
    }
    // Each honest edit comes back as changes, or as none: never refused, and never failed.
    expect(outcomes.filter((kind) => kind !== "proposed" && kind !== "unchanged")).toEqual([]);
    expect(outcomes.filter((kind) => kind === "proposed").length).toBeGreaterThan(CASES.length / 2);
  },
);
