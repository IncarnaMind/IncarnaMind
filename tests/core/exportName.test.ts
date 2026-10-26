import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import { messageReference } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

const text = (value: string): JSONContent => ({ type: "text", text: value });

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const heading = (...content: JSONContent[]): JSONContent => ({
  type: "heading",
  attrs: { level: 1 },
  content,
});

async function setUp() {
  const core = startCore(await createTempDataFolder());
  onTestFinished(() => core.close());
  return core;
}

/** A Mind with these Blocks, as "Write as a note" adds an Answer's: the first line from a Question. */
async function fromAnAnswer(
  core: ReturnType<typeof startCore>,
  line: string,
  question: string,
): Promise<{ id: string }> {
  const mind = await core.createMind({});
  await core.addToNote({
    mindId: mind.id,
    blocks: [paragraph(text(line))],
    origin: { from: messageReference("conversation-1", "message-1"), question },
    model: null,
  });
  return mind;
}

const fileName = async (core: ReturnType<typeof startCore>, mindId: string) =>
  (await core.previewMindExport(mindId, { format: "docx" })).fileName;

describe("What a note's export file is called (#1945)", () => {
  test("the title the User gave it, before anything the note says", async () => {
    const core = await setUp();
    const mind = await core.createMind({ title: "Harbourline note" });
    await core.addToNote({
      mindId: mind.id,
      blocks: [paragraph(text("A sentence the note begins with."))],
      origin: null,
      model: null,
    });
    expect(await fileName(core, mind.id)).toBe("Harbourline note.docx");
  });

  test("the Question that made it, when an Answer wrote the first line", async () => {
    const core = await setUp();
    const mind = await fromAnAnswer(
      core,
      "Revenue reached £4.025 million in 2025, up 12% on the year before.",
      "How did Harbourline's revenue move in 2025?",
    );
    expect(await fileName(core, mind.id)).toBe("How did Harbourline's revenue move in 2025.docx");
  });

  test("a heading is a title already, so it names the file itself", async () => {
    const core = await setUp();
    const mind = await core.createMind({});
    await core.addToNote({
      mindId: mind.id,
      blocks: [heading(text("Harbourline, 2025")), paragraph(text("Revenue rose."))],
      origin: { from: messageReference("conversation-1", "message-1"), question: "Write it up." },
      model: null,
    });
    expect(await fileName(core, mind.id)).toBe("Harbourline, 2025.docx");
  });

  test("the User's own first line, when nothing made it but them", async () => {
    const core = await setUp();
    const mind = await core.createMind({});
    await core.addToNote({
      mindId: mind.id,
      blocks: [paragraph(text("Notes on the Harbourline meeting"))],
      origin: null,
      model: null,
    });
    expect(await fileName(core, mind.id)).toBe("Notes on the Harbourline meeting.docx");
  });

  test("a Chinese Question names the file whole, and no part of it is cut", async () => {
    const core = await setUp();
    const question = "2025 年 Harbourline 的收入变化如何，主要来自哪些业务？";
    const mind = await fromAnAnswer(core, "收入达到 402.5 万英镑。", question);
    expect(await fileName(core, mind.id)).toBe(`${question}.docx`);
  });

  test("a long title is the file's name, not cut to a line's width", async () => {
    const core = await setUp();
    const title =
      "Harbourline, the 2025 revenue review, with the terminal, the berths and the dredging contract";
    const mind = await core.createMind({ title });
    expect(await fileName(core, mind.id)).toBe(`${title}.docx`);
  });

  test("only what a file name can't hold is taken out", async () => {
    const core = await setUp();
    const mind = await core.createMind({ title: 'Q3: why "Harbourline" <draft>/2025?' });
    expect(await fileName(core, mind.id)).toBe("Q3 why Harbourline draft 2025.docx");
  });

  test("a note with no words at all is Untitled", async () => {
    const core = await setUp();
    const mind = await core.createMind({});
    expect(await fileName(core, mind.id)).toBe("Untitled.docx");
  });
});
