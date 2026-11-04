/**
 * Address with the assistant (#328) against a real model: the instruction a
 * comment sends, on the comment's own words, through the core as the app uses
 * it. The model answers with an edit that takes the comment into account and
 * keeps the Citation on the sentence; accepting it leaves the Citation found.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *
 * The key has a name of its own, so a key a shell has for other tools never
 * starts a paid request here.
 */
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import { CITATION_NODE, type Core, type Document } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { translate } from "../../src/shared/i18n";
import { pendingProposals, resolveProposals } from "../../src/shared/proposals";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together. The range between high and low water is at its greatest then.",
  ].join("\n"),
};

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const commentId = "comment-live";

const COMMENTS = {
  en: "Say how high the water rises at spring tides.",
  "zh-CN": "说明春潮时水位有多高。",
} as const;

/** The paragraph's text, a Citation as ⟨its check⟩. */
function shown(client: MindClient): string {
  let line = "";
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    node.forEach((child) => {
      if (child.isText) line += child.text ?? "";
      else if (child.type.name === CITATION_NODE) line += `⟨${String(child.attrs.check)}⟩`;
      else line += "￼";
    });
    return false;
  });
  return line;
}

function citationChecks(client: MindClient): string[] {
  const checks: string[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) checks.push(String(node.attrs.check));
  });
  return checks;
}

describe("Address with the assistant, live", () => {
  for (const language of ["en", "zh-CN"] as const) {
    for (const run of [1, 2] as const) {
      test.skipIf(KEY === undefined)(
        `Anthropic (${language}, run ${run}): the comment's instruction edits the words it is on, and the Citation stays`,
        { timeout: 600_000 },
        async () => {
          const dataDir = await createTempDataFolder();
          const sources = await createTempDataFolder();
          const core: Core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.saveChatProvider({ kind: "anthropic", apiKey: KEY as string, modelId: MODEL });
          const [tides] = await addAndProcess(core, [
            await writeSourceFile(sources, TIDES.name, TIDES.contents),
          ]);
          const mind = await core.createMind({ title: "Tides" });
          const client = await connectToMind(core, mind.id);
          const blockId = "commented";
          const words = "Spring tides happen at new moon and at full moon";
          writeMind(client, [
            {
              type: "paragraph",
              attrs: { id: blockId },
              content: [
                { type: "text", text: words },
                {
                  type: CITATION_NODE,
                  attrs: {
                    passageId: "passage",
                    documentId: (tides as Document).id,
                    documentName: (tides as Document).name,
                    contentHash: (tides as Document).contentHash,
                    quote: words,
                    check: "found",
                  },
                },
                { type: "text", text: ", when their pull adds up." },
              ],
            },
          ]);
          const comment = COMMENTS[language];
          // The comment a User typed, on the words its range names.
          client.doc.getMap("comments").set(commentId, {
            id: commentId,
            author: null,
            createdAt: new Date().toISOString(),
            text: comment,
            resolvedAt: null,
            replies: [],
          });
          await client.settled();

          const instruction = translate(language, "comments.assistant.instruction", {
            comment,
            quote: words,
          });
          const result = await core.editWithAi({
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            from: { blockId, offset: 0 },
            to: { blockId, offset: words.length + 1 },
            text: `${words}￼`,
            action: "instruction",
            instruction,
          });
          expect(result.kind, result.kind === "failed" ? result.error.kind : result.kind).toBe(
            "proposed",
          );
          expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
          client.doc.transact(() => {
            resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
          }, "editor");
          await client.settled();
          const edited = shown(client);
          expect(edited).not.toBe(
            "Spring tides happen at new moon and at full moon⟨found⟩, when their pull adds up.",
          );
          expect(edited).toContain("⟨found⟩");
          // The comment asks for a height the source doesn't state: the edit says what it can without inventing one.
          expect(edited).not.toMatch(/\d/u);
          expect(citationChecks(client)).toEqual(["found"]);
          core.close();
        },
      );
    }
  }
});
