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
import { EDIT_INSTRUCTIONS, withMissingNumber } from "../../src/core/edits/prompt";
import { answerBlocks, pageBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { REFUSAL_WORDS } from "../../src/shared/changeRefusals";
import { translate } from "../../src/shared/i18n";
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
  async function noteWithMark(
    reply: (passage: string) => string,
    content: JSONContent[] = [
      text("Growth was "),
      { type: "missingNumber" },
      text(" in 2026 and 9% in 2025."),
    ],
  ) {
    const calls: EditCall[] = [];
    const set = await setUpWithDocuments(
      editingModel((call) => reply(call.passage), calls),
      [],
    );
    onTestFinished(() => set.core.close());
    if (language === "zh-CN") await set.core.updateSettings({ user: { language } });
    const note = { type: "paragraph", attrs: { id: "growth" }, content };
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

  test("the model is told to keep the mark's words only when the passage holds the mark: any other request is as it was, byte for byte", async () => {
    const marked = await noteWithMark((passage) => passage.replace(" in 2026 and", ";"));
    const plain = await noteWithMark(
      (passage) => passage.replace(" in 2026 and", ";"),
      [text("Growth was 7% in 2026 and 9% in 2025.")],
    );
    expect(plain.calls[0]?.system).toBe(EDIT_INSTRUCTIONS);
    expect(marked.calls[0]?.system).toBe(withMissingNumber(EDIT_INSTRUCTIONS));
    expect(marked.calls[0]?.system.split("\n")).toEqual([
      ...EDIT_INSTRUCTIONS.split("\n").slice(0, 7),
      EDIT_INSTRUCTIONS.split("\n")[7],
      '- The bracketed words "[number missing]" and "[缺少数字]" stand for a number that is missing: keep them exactly as written, in their place, also when translating.',
      ...EDIT_INSTRUCTIONS.split("\n").slice(8),
    ]);
    expect(EDIT_INSTRUCTIONS.split("\n")[7]).toMatch(/^- Keep every Citation marker/);
  });

  test("words the User typed in a passage with no mark stay words, though the reply writes them back", async () => {
    const { client } = await noteWithMark(
      (passage) => passage.replace(" in 2026 and", ";"),
      [text(`Growth was ${words} in 2026 and 9% in 2025.`)],
    );
    expect(lastLine(client)).toBe(`Growth was ${words}; 9% in 2025.`);
  });

  test("the reply's words are the mark only as often as the passage held it, counted from the start", async () => {
    const { client } = await noteWithMark((passage) =>
      passage.replace(" in 2026 and 9% in 2025.", `; 2025 was ${otherWords} too.`),
    );
    expect(lastLine(client)).toBe(`Growth was ${MARK}; 2025 was ${otherWords} too.`);
  });

  test("a reply that puts a plain number where the mark is is refused, the mark stays, and the line says so", async () => {
    const { client, result } = await noteWithMark((passage) => passage.replace(words, "8.0%"));
    expect(result.kind).toBe("missing-number");
    expect(lastLine(client)).toBe(`Growth was ${MARK} in 2026 and 9% in 2025.`);
    expect(translate(language, REFUSAL_WORDS["missing-number"].editor)).toBe(
      language === "en"
        ? "The AI’s rewrite left out [number missing], so nothing changed. Try again."
        : "AI 改写时漏掉了[缺少数字]，没有改动。请重试。",
    );
  });

  test("a reply that leaves the mark out is refused too", async () => {
    const { client, result } = await noteWithMark((passage) => passage.replace(` ${words}`, ""));
    expect(result.kind).toBe("missing-number");
    expect(lastLine(client)).toBe(`Growth was ${MARK} in 2026 and 9% in 2025.`);
  });
});
