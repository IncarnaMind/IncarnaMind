/**
 * The mark where a figure couldn't be calculated, beyond the assistant's write (#2577): the
 * Answer's panel shows it once the Answer has ended, never while it is written; Add to note puts it
 * into the Note; and Edit with AI shows the model its words in the interface language and keeps
 * the mark where the reply writes them back, in either language.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import type { ConversationAnswer } from "../../src/core";
import { answerBlocks, pageBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { type EditCall, editingModel, wholeParagraph } from "../helpers/editing";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges, writeMind } from "../helpers/minds";

/** How the mark reads in `shown`, so a test can't take its words for text. */
const MARK = "‹mark›";

function shownJson(nodes: readonly NodeJSON[]): string {
  return nodes
    .map((node) =>
      node.type === "text"
        ? (node.text ?? "")
        : node.type === "missingNumber"
          ? MARK
          : shownJson(node.content ?? []),
    )
    .join("");
}

function shownStored(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toString().replace(/<[^>]+>/g, "");
  if (node.nodeName === "missingNumber") return MARK;
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? shownStored(child) : "",
    )
    .join("");
}

const lastLine = (client: MindClient): string => {
  const blocks = client.blocks.toArray();
  const last = blocks.at(-1);
  return last instanceof Y.XmlElement ? shownStored(last) : "";
};

const answer = (
  text: string,
  status: ConversationAnswer["status"],
): Pick<ConversationAnswer, "id" | "text" | "citations" | "figures" | "status"> => ({
  id: "answer-1",
  text,
  citations: [],
  figures: [],
  status,
});

describe("the Answer's panel", () => {
  test("shows the mark where a figure marker has no figure once the Answer has ended", () => {
    expect(shownJson(answerBlocks(answer("Growth was [=1].", "done")))).toBe(`Growth was ${MARK}.`);
  });

  test("shows nothing there while the Answer is written, as its figure may still come", () => {
    expect(shownJson(answerBlocks(answer("Growth was [=1]", "streaming")))).toBe("Growth was ");
  });

  test("shows the mark where the ended Answer wrote its words, in either language", () => {
    expect(
      shownJson(answerBlocks(answer("Growth was [number missing]; 增长率为 [缺少数字]。", "done"))),
    ).toBe(`Growth was ${MARK}; 增长率为 ${MARK}。`);
  });
});

test("Add to note puts the mark into the Note", async () => {
  const core = startCore(await createTempDataFolder());
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Growth" });
  await core.addToNote({
    mindId: mind.id,
    blocks: pageBlocks(answer("Harbour's growth was [=1].", "done"), "What was the growth?"),
    origin: null,
    model: null,
  });
  const client = await connectToMind(core, mind.id);
  await client.settled();
  expect(lastLine(client)).toBe(`Harbour's growth was ${MARK}.`);
});

const text = (value: string): JSONContent => ({ type: "text", text: value });

describe.each([
  ["en", "[number missing]", "[缺少数字]"],
  ["zh-CN", "[缺少数字]", "[number missing]"],
] as const)("Edit with AI with the interface in %s", (language, words, otherWords) => {
  async function noteWithMark(reply: (passage: string) => string) {
    const calls: EditCall[] = [];
    const set = await setUpWithDocuments(
      editingModel((call) => reply(call.passage), calls),
      [],
    );
    onTestFinished(() => set.core.close());
    if (language === "zh-CN") await set.core.updateSettings({ user: { language } });
    const note = {
      type: "paragraph",
      attrs: { id: "growth" },
      content: [text("Growth was "), { type: "missingNumber" }, text(" in 2026 and 9% in 2025.")],
    };
    writeMind(set.client, [note]);
    await set.client.settled();
    const result = await set.core.editWithAi(
      wholeParagraph(set.client, set.mind.id, "growth", "shorten"),
    );
    await set.client.settled();
    await resolveChanges(set.client, "accept");
    await set.client.settled();
    return { ...set, calls, result };
  }

  test("shows the model the mark's words, and a reply that keeps them keeps the mark", async () => {
    const { client, calls, result } = await noteWithMark((passage) =>
      passage.replace(" in 2026 and", ";"),
    );
    expect(result.kind).toBe("proposed");
    expect(calls[0]?.passage).toBe(`Growth was ${words} in 2026 and 9% in 2025.`);
    expect(lastLine(client)).toBe(`Growth was ${MARK}; 9% in 2025.`);
  });

  test("a reply that writes the other language's words keeps the mark too", async () => {
    const { client } = await noteWithMark((passage) =>
      passage.replace(words, otherWords).replace(" in 2026 and", ";"),
    );
    expect(lastLine(client)).toBe(`Growth was ${MARK}; 9% in 2025.`);
  });
});
