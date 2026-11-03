/**
 * "Checked by me" through the assistant's rewrites (#1933), against a real model: Improve writing
 * and Translate over a paragraph whose Citation the User checked, in English and in Chinese, as
 * the app runs them. Once the changes are accepted, a Citation the rewrite kept must still have
 * the id the mark names, so the mark stays on it, once; one the model left out is counted apart. It runs
 * only with a key in the environment:
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY    Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_RUNS             how many times each case runs (1 by default)
 *   INCARNAMIND_LIVE_REPORT           a file to keep each run's text in
 */
import { appendFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { CITATION_NODE, type Document, type EditAction } from "../../src/core";
import { citationSentences } from "../../src/core/answers/checks/sentences";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { addSignOff } from "../../src/shared/signOffs";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");

const SOURCES = {
  en: {
    name: "Tides.md",
    contents:
      "# Tides\n\nSpring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    before: "the spring tides they happens at a new moon and also when the moon is full ",
    after: ", because sun and moon is pulling together.",
    quote: "Spring tides happen at new moon and at full moon",
    translate: "Simplified Chinese (简体中文)",
  },
  "zh-CN": {
    name: "潮汐.md",
    contents: "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
    before: "大潮一般是在新月和满月的前后出现的的，",
    after: "因为太阳和月亮的引力它们叠加在一起。",
    quote: "大潮出现在新月和满月前后",
    translate: "English",
  },
} as const;

function citationIds(client: MindClient): unknown[] {
  const ids: unknown[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) ids.push(node.attrs.id);
  });
  return ids;
}

test.skipIf(KEY === undefined)(
  "the assistant's rewrites keep a checked Citation's id, so the User's mark stays on it",
  { timeout: 1_200_000 },
  async () => {
    const core = startCore(await createTempDataFolder(), { createChatModel: createAiSdkChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY, modelId: MODEL });
    const sources = await createTempDataFolder();
    const documents = await addAndProcess(core, [
      await writeSourceFile(sources, SOURCES.en.name, SOURCES.en.contents),
      await writeSourceFile(sources, SOURCES["zh-CN"].name, SOURCES["zh-CN"].contents),
    ]);
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const report: string[] = [`## ${MODEL}`];
    const outcomes: ("kept" | "left out" | "lost")[] = [];

    for (let run = 0; run < RUNS; run++) {
      for (const [index, language] of (["en", "zh-CN"] as const).entries()) {
        const source = SOURCES[language];
        const document = documents[index] as Document;
        for (const [action, instruction] of [
          ["improve", undefined],
          ["translate", source.translate],
        ] as [EditAction, string | undefined][]) {
          const id = crypto.randomUUID();
          writeMind(client, [
            {
              type: "paragraph",
              attrs: { id: "cited" },
              content: [
                { type: "text", text: source.before },
                {
                  type: CITATION_NODE,
                  attrs: {
                    passageId: "passage",
                    documentId: document.id,
                    documentName: document.name,
                    contentHash: document.contentHash,
                    quote: source.quote,
                    check: "found",
                    id,
                  },
                },
                { type: "text", text: source.after },
              ],
            },
          ]);
          addSignOff(client.doc, {
            id: crypto.randomUUID(),
            target: { kind: "citation", id },
            at: new Date().toISOString(),
            contentHash: "live",
            deletedAt: null,
            name: "Ada",
            personId: "person-1",
          });
          await client.settled();
          let plain = "";
          readMind(client).descendants((node) => {
            if (node.attrs.id !== "cited") return true;
            plain = node.textBetween(0, node.content.size, "", "￼");
            return false;
          });
          const result = await core.editWithAi({
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            from: { blockId: "cited", offset: 0 },
            to: { blockId: "cited", offset: plain.length },
            text: plain,
            action,
            ...(instruction && { instruction }),
          });
          await client.settled();
          await resolveChanges(client, "accept");
          const ids = citationIds(client);
          // A marker the model wrote twice is a copy, with an id of its own: the mark stays on one.
          const marked = ids.filter((each) => each === id).length;
          const outcome =
            ids.length === 0
              ? "left out"
              : marked === 1 && citationSentences(client.blocks).has(id)
                ? "kept"
                : "lost";
          outcomes.push(outcome);
          report.push(
            `- ${language} ${action} run ${run + 1}: ${result.kind}, ${outcome}: ${readMind(client).textContent}`,
          );
        }
      }
    }
    const count = (outcome: (typeof outcomes)[number]) =>
      outcomes.filter((each) => each === outcome).length;
    report.push(
      `Kept ${count("kept")}, left out by the model ${count("left out")}, lost ${count("lost")}, of ${outcomes.length}.`,
    );
    if (process.env.INCARNAMIND_LIVE_REPORT)
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
    expect(count("lost")).toBe(0);
  },
);
