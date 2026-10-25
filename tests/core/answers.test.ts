import { updateYFragment } from "@tiptap/y-tiptap";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type * as Y from "yjs";
import type { Core, CoreEvents } from "../../src/core";
import { ANSWER_TEMPERATURE, answerTemperature } from "../../src/core/answers/engine";
import { asGenerated } from "../../src/shared/aiText";
import { pendingProposals, proposalRequestOf } from "../../src/shared/proposals";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import {
  createTempDataFolder,
  nextEvent,
  nextTurn,
  saveProviderUnasked,
  startCore,
} from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import {
  answerIn,
  answerText,
  editMind,
  heading,
  note,
  outline,
  question,
  readMind,
  resolveChanges,
  shownWithChanges,
  writeMind,
} from "../helpers/minds";
import {
  controlledModel,
  failingStreamModel,
  promptOf,
  scriptedModel,
  scriptedModels,
  streamingModel,
} from "../helpers/models";
import { startModelListStub, startOllamaStub, unusedLocalUrl } from "../helpers/ollama";

/** What "answer.finished" says about Citations when there were no Documents to search. */
const NO_CITATIONS = {
  citations: [],
  droppedMarkers: 0,
  droppedRecords: 0,
  rejectedRecords: [],
  idsAsText: 0,
  placedMarkers: 0,
  citedAfterChecking: { count: 0, asked: false },
  citationSupport: null,
  quoteRetry: null,
  figures: [],
  uncalculated: 0,
  figureRetry: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
};

/** A core with a local chat model set up (so no consent is needed), and a Mind with two clients. */
async function setUp(model: MockLanguageModelV4, dataDir?: string) {
  const models = scriptedModels(model);
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: models.createChatModel,
  });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Tides" });
  const writer = await connectToMind(core, mind.id);
  const reader = await connectToMind(core, mind.id);
  return { core, models, provider, mind, writer, reader };
}

interface CloudProvider {
  kind: "openai" | "anthropic" | "google";
  modelId: string;
}

/** A core with a cloud chat model whose service the User has allowed Questions to go to, and a Mind. */
async function setUpCloud(model: MockLanguageModelV4, provider: CloudProvider) {
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), { createChatModel: models.createChatModel });
  const saved = await core.saveChatProvider({ ...provider, apiKey: "sk-test" });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const mind = await core.createMind({ title: "Tides" });
  const writer = await connectToMind(core, mind.id);
  const reader = await connectToMind(core, mind.id);
  return { core, models, provider: saved, mind, writer, reader };
}

/** Resolves with the next "answer.finished" or "answer.failed" event for this Answer. */
function answerEnded(core: Core, answerId: string) {
  return new Promise<
    | { event: "finished"; payload: CoreEvents["answer.finished"] }
    | {
        event: "failed";
        payload: CoreEvents["answer.failed"];
      }
  >((resolve) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "finished", payload });
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "failed", payload });
      }),
    ];
  });
}

/** Asks a Question and expects it to be asked; returns the Answer's id. */
async function ask(core: Core, mindId: string, questionId: string): Promise<string> {
  const result = await core.askQuestion({ mindId, questionId });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  return result.answerId;
}

/** Asks a Question and waits for its Answer to be complete. */
async function askAndWait(core: Core, client: MindClient, mindId: string, questionId: string) {
  await client.settled();
  const answerId = await ask(core, mindId, questionId);
  const ended = await answerEnded(core, answerId);
  expect(ended.event).toBe("finished");
  return answerId;
}

describe("Asking a Question", () => {
  test("a Question in an empty Mind gets an Answer that streams into the Mind, seen by every client", async () => {
    const controlled = controlledModel();
    const { core, provider, mind, writer, reader } = await setUp(controlled.model);
    const events: { name: string; payload: unknown }[] = [];
    for (const name of ["answer.started", "answer.delta", "answer.finished"] as const) {
      core.on(name, (payload) => events.push({ name, payload }));
    }

    const asked = question("What is a Mind?");
    writeMind(writer, [asked]);
    await writer.settled();
    const answerId = await ask(core, mind.id, asked.attrs.id);

    // Right away, below the Question: an Answer being written, and a line to go on writing in.
    expect(outline(reader)).toEqual(["question", "answer:streaming", "paragraph"]);
    expect(answerIn(reader, answerId).attrs).toMatchObject({
      questionId: asked.attrs.id,
      providerId: provider.id,
      modelId: "local-model",
      status: "streaming",
    });

    // The other client sees each part as the model writes it.
    await controlled.requested();
    controlled.push("A Mind is ");
    await vi.waitFor(() => expect(answerText(reader, answerId)).toBe("A Mind is"));
    expect(answerIn(reader, answerId).attrs.status).toBe("streaming");
    controlled.push("a notebook.");
    await vi.waitFor(() => expect(answerText(reader, answerId)).toBe("A Mind is a notebook."));

    const finished = nextEvent(core, "answer.finished");
    controlled.finish();
    expect(await finished).toEqual({
      ...NO_CITATIONS,
      mindId: mind.id,
      answerId,
      status: "done",
      // What the model's stand-in counted (tests/helpers/models.ts).
      usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });
    expect(outline(reader)).toEqual(["question", "answer:done", "paragraph"]);
    expect(answerText(reader, answerId)).toBe("A Mind is a notebook.");

    // The model was given the Question alone, and told how to answer.
    const prompt = promptOf(controlled.model);
    expect(prompt.map((message) => message.role)).toEqual(["system", "user"]);
    expect(prompt[1]?.text).toBe("What is a Mind?");

    // The event stream: started, the deltas in order, finished.
    expect(events.map((event) => event.name)).toEqual([
      "answer.started",
      "answer.delta",
      "answer.delta",
      "answer.finished",
    ]);
    expect(events[0]?.payload).toEqual({
      mindId: mind.id,
      answerId,
      questionId: asked.attrs.id,
      model: { providerId: provider.id, modelId: "local-model" },
    });
    expect(events.slice(1, 3).map((event) => (event.payload as { text: string }).text)).toEqual([
      "A Mind is ",
      "a notebook.",
    ]);
  });

  test("the system prompt asks for the Question's language, and to say so when the model doesn't know", async () => {
    const model = streamingModel("潮汐是由月球引力引起的。");
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("潮汐是怎么形成的？");
    writeMind(writer, [note("Notes in English about tides."), asked]);

    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);

    const system = promptOf(model)[0]?.text ?? "";
    expect(system).toMatch(/answer in the language the Question is written in/i);
    expect(system).toMatch(/The Question is written in Chinese/);
    expect(system).toMatch(/don't know/i);
    expect(answerText(reader, answerId)).toBe("潮汐是由月球引力引起的。");
  });

  test("asking a Question with no text is refused, and an unknown Question isn't found", async () => {
    const { core, mind, writer } = await setUp(streamingModel("Unused."));
    const empty = question("");
    writeMind(writer, [empty]);
    await writer.settled();

    await expect(core.askQuestion({ mindId: mind.id, questionId: empty.attrs.id })).rejects.toThrow(
      /Write the Question/,
    );
    await expect(core.askQuestion({ mindId: mind.id, questionId: "nope" })).rejects.toThrow(
      /isn’t in this Mind/,
    );
  });
});

describe("Question context", () => {
  test("is every Block above the Question, without switched-off Notes: Notes and Questions from the User, Answers from the model", async () => {
    const model = streamingModel(["The Moon's gravity pulls the oceans.", "Twice a month."]);
    const { core, mind, writer } = await setUp(model);
    const first = question("Why are there tides?");
    writeMind(writer, [
      heading(1, "Tides"),
      note("The Moon matters."),
      note("Remember to buy milk.", { off: true }),
      first,
    ]);
    await askAndWait(core, writer, mind.id, first.attrs.id);

    const second = question("When are spring tides?");
    editMind(writer, (blocks) => [
      ...blocks.filter((block) => !(block.type === "paragraph" && !block.content)),
      note("Spring tides are the big ones."),
      second,
      note("This Note is below the Question."),
    ]);
    await askAndWait(core, writer, mind.id, second.attrs.id);

    expect(promptOf(model, 1).slice(1)).toEqual([
      { role: "user", text: "# Tides\n\nThe Moon matters.\n\nWhy are there tides?" },
      { role: "assistant", text: "The Moon's gravity pulls the oceans." },
      { role: "user", text: "Spring tides are the big ones.\n\nWhen are spring tides?" },
    ]);
  });

  test("reads a change still waiting as the text it would replace: its new words aren't the Mind's yet", async () => {
    const model = streamingModel("Answered.");
    const { core, mind, writer } = await setUp(model);
    const change = { id: "change-1", request: "request-1", target: "x" };
    const asked = question("How strong are the tides?");
    writeMind(writer, [
      {
        type: "paragraph",
        attrs: { id: "note-1" },
        content: [
          { type: "text", text: "The tides are " },
          { type: "text", text: "very", marks: [{ type: "proposalDelete", attrs: change }] },
          { type: "text", text: "a bit", marks: [{ type: "proposalInsert", attrs: change }] },
          { type: "text", text: " strong." },
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "note-2", proposal: { ...change, id: "change-2", kind: "insert" } },
        content: [{ type: "text", text: "A paragraph the AI would add." }],
      },
      asked,
    ]);
    await askAndWait(core, writer, mind.id, asked.attrs.id);

    expect(promptOf(model).slice(1)).toEqual([
      { role: "user", text: "The tides are very strong.\n\nHow strong are the tides?" },
    ]);
  });

  test("leaves out the oldest content first when it is over the token budget", async () => {
    const model = streamingModel("Answered.");
    const { core, mind, writer } = await setUp(model);
    // 30 Notes of about 500 tokens each: more than the 12k-token budget.
    const notes = Array.from({ length: 30 }, (_, index) =>
      note(`Note ${String(index + 1).padStart(2, "0")}: ${"lorem ipsum ".repeat(170)}`),
    );
    const asked = question("Summarise my Notes.");
    writeMind(writer, [...notes, asked]);

    await askAndWait(core, writer, mind.id, asked.attrs.id);

    const [, context] = promptOf(model);
    const text = context?.text ?? "";
    expect(text.endsWith("Summarise my Notes.")).toBe(true);
    // About 12k tokens at about four characters each, and the newest Notes are the ones kept.
    expect(text.length).toBeLessThanOrEqual(12_000 * 4 + 100);
    expect(text.length).toBeGreaterThan(11_000 * 4);
    expect(text).toContain("Note 30:");
    expect(text).toContain("Note 10:");
    expect(text).not.toContain("Note 01:");
    const kept = [...text.matchAll(/Note (\d\d):/g)].map((match) => Number(match[1]));
    expect(kept).toEqual(
      Array.from({ length: kept.length }, (_, index) => 31 - kept.length + index),
    );
  });
});

describe("Streaming Answers into the Mind", () => {
  test("Markdown arrives as rich text: headings, lists, code and math, without flickering through raw Markdown", async () => {
    const markdown = [
      "## Tidal forces",
      "",
      "The **Moon** pulls hardest on the near side, where $F = G\\frac{m_1 m_2}{r^2}$ is largest.",
      "",
      "- High tide faces the Moon",
      "- *Another* one is opposite",
      "",
      "```python",
      "print('tide')",
      "```",
      "",
      "$$",
      "h(t) = A \\cos(\\omega t)",
      "$$",
      "",
      "See [NOAA](https://oceanservice.noaa.gov) and `tide tables`.",
    ].join("\n");
    const model = streamingModel(markdown, { chunkSize: 2, delayMs: 2 });
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("Explain tides.");
    writeMind(writer, [asked]);
    await writer.settled();

    // Every state the other client sees while the Answer streams.
    const seen: { types: string[]; text: string }[] = [];
    reader.doc.on("afterTransaction", () => {
      const answer = readMind(reader).maybeChild(1);
      if (answer?.type.name !== "answer") return;
      const types: string[] = [];
      answer.forEach((block) => {
        types.push(block.type.name);
      });
      seen.push({ types, text: answer.textBetween(0, answer.content.size, "\n") });
    });

    const answerId = await ask(core, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    // Every word of it is AI text.
    expect(answerIn(reader, answerId).toJSON().content).toEqual(
      asGenerated([
        {
          type: "heading",
          attrs: {
            id: expect.any(String),
            level: 2,
            includeInContext: null,
            paragraphFormat: null,
            proposal: null,
            wordLook: null,
          },
          content: [{ type: "text", text: "Tidal forces" }],
        },
        {
          type: "paragraph",
          attrs: {
            id: expect.any(String),
            includeInContext: null,
            paragraphFormat: null,
            proposal: null,
            wordLook: null,
          },
          content: [
            { type: "text", text: "The " },
            { type: "text", text: "Moon", marks: [{ type: "bold" }] },
            { type: "text", text: " pulls hardest on the near side, where " },
            { type: "inlineMath", attrs: { latex: "F = G\\frac{m_1 m_2}{r^2}", proposal: null } },
            { type: "text", text: " is largest." },
          ],
        },
        {
          type: "bulletList",
          attrs: { id: expect.any(String), includeInContext: null, proposal: null },
          content: [
            {
              type: "listItem",
              attrs: { proposal: null },
              content: [
                {
                  type: "paragraph",
                  attrs: {
                    id: expect.any(String),
                    includeInContext: null,
                    paragraphFormat: null,
                    proposal: null,
                    wordLook: null,
                  },
                  content: [{ type: "text", text: "High tide faces the Moon" }],
                },
              ],
            },
            {
              type: "listItem",
              attrs: { proposal: null },
              content: [
                {
                  type: "paragraph",
                  attrs: {
                    id: expect.any(String),
                    includeInContext: null,
                    paragraphFormat: null,
                    proposal: null,
                    wordLook: null,
                  },
                  content: [
                    { type: "text", text: "Another", marks: [{ type: "italic" }] },
                    { type: "text", text: " one is opposite" },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: {
            id: expect.any(String),
            language: "python",
            includeInContext: null,
            proposal: null,
          },
          content: [{ type: "text", text: "print('tide')" }],
        },
        {
          type: "blockMath",
          attrs: {
            id: expect.any(String),
            latex: "h(t) = A \\cos(\\omega t)",
            includeInContext: null,
            proposal: null,
          },
        },
        {
          type: "paragraph",
          attrs: {
            id: expect.any(String),
            includeInContext: null,
            paragraphFormat: null,
            proposal: null,
            wordLook: null,
          },
          content: [
            { type: "text", text: "See " },
            {
              type: "text",
              text: "NOAA",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://oceanservice.noaa.gov",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: null,
                    title: null,
                  },
                },
              ],
            },
            { type: "text", text: " and " },
            { type: "text", text: "tide tables", marks: [{ type: "code" }] },
            { type: "text", text: "." },
          ],
        },
      ]),
    );

    // While streaming, no Markdown syntax ever showed, and Blocks only grew at the end.
    const final = seen.at(-1)?.types ?? [];
    expect(seen.length).toBeGreaterThan(5);
    for (const state of seen) {
      expect(state.text).not.toMatch(/\*\*|`|\$|\[NOAA\]|^#|^- /m);
      expect(state.types.slice(0, -1)).toEqual(final.slice(0, state.types.length - 1));
      if (state.types.length > 0) expect(final).toContain(state.types.at(-1));
    }
  });

  test("the editor reads what the core writes as valid Blocks, and has nothing to rewrite", async () => {
    const model = streamingModel(
      "# Title\n\n1. one\n2. **two** and $x^2$\n   - nested\n\n> quoted with [a link](https://example.com)\n\n---\n\n```\nplain code\n```\n\nLine *one*\nLine ~~two~~ `code`",
    );
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("Show me everything.");
    writeMind(writer, [note("Before."), asked]);
    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);

    // readMind checks the document against the editor's schema.
    const answer = answerIn(reader, answerId);
    const types: string[] = [];
    answer.forEach((block) => {
      types.push(block.type.name);
    });
    expect(types).toEqual([
      "heading",
      "orderedList",
      "blockquote",
      "horizontalRule",
      "codeBlock",
      "paragraph",
    ]);
    expect(answer.attrs.generatedMarks).toBe(true);
    expect(answer.child(5).toJSON().content).toEqual(
      asGenerated([
        { type: "text", text: "Line " },
        { type: "text", text: "one", marks: [{ type: "italic" }] },
        { type: "hardBreak", attrs: { proposal: null } },
        { type: "text", text: "Line " },
        { type: "text", text: "two", marks: [{ type: "strike" }] },
        { type: "text", text: " " },
        { type: "text", text: "code", marks: [{ type: "code" }] },
      ]),
    );

    // Tiptap's Yjs binding would write the Mind exactly as the core did: nothing changes.
    let rewritten = false;
    reader.blocks.observeDeep(() => {
      rewritten = true;
    });
    reader.doc.transact(() =>
      updateYFragment(reader.doc, reader.blocks, readMind(reader), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
    expect(rewritten).toBe(false);
  });
});

describe("Stopping and regenerating", () => {
  test("stopping an Answer keeps what was written and marks it stopped", async () => {
    const controlled = controlledModel();
    const { core, mind, writer, reader } = await setUp(controlled.model);
    const asked = question("Tell me a long story.");
    writeMind(writer, [asked]);
    await writer.settled();
    const answerId = await ask(core, mind.id, asked.attrs.id);
    await controlled.requested();
    controlled.push("Once upon a time, ");
    await vi.waitFor(() => expect(answerText(reader, answerId)).toBe("Once upon a time,"));

    const finished = nextEvent(core, "answer.finished");
    await core.stopAnswer({ mindId: mind.id, answerId });

    expect(await finished).toEqual({
      ...NO_CITATIONS,
      mindId: mind.id,
      answerId,
      status: "stopped",
    });
    expect(controlled.aborted).toBe(true);
    expect(answerIn(reader, answerId).attrs.status).toBe("stopped");
    expect(answerText(reader, answerId)).toBe("Once upon a time,");

    // Stopping it again, or a finished Answer, does nothing.
    await core.stopAnswer({ mindId: mind.id, answerId });
    expect(answerIn(reader, answerId).attrs.status).toBe("stopped");
  });

  test("regenerating replaces the Answer in place", async () => {
    const model = streamingModel(["The first Answer.", "The second Answer."]);
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("Try twice.");
    writeMind(writer, [asked]);
    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);
    editMind(writer, (blocks) => [...blocks, note("A Note after the Answer.")]);
    await writer.settled();
    expect(outline(reader)).toEqual(["question", "answer:done", "paragraph", "paragraph"]);

    const result = await core.regenerateAnswer({ mindId: mind.id, answerId });
    expect(result).toEqual({ asked: true, answerId });
    expect(await answerEnded(core, answerId)).toMatchObject({ event: "finished" });

    // The same Block, in the same place, with the new Answer.
    expect(outline(reader)).toEqual(["question", "answer:done", "paragraph", "paragraph"]);
    expect(answerText(reader, answerId)).toBe("The second Answer.");
    expect(readMind(reader).child(3).textContent).toBe("A Note after the Answer.");
    // Asked from the same Question context.
    expect(promptOf(model, 1)).toEqual(promptOf(model, 0));
  });

  test("regenerating an Answer the User has edited gives changes over their version, which stays until they accept one", async () => {
    const model = streamingModel([
      "Generated text.",
      "Regenerated text.",
      "Written again.",
      "Once more.",
      "Replaced in place.",
    ]);
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("Write something.");
    writeMind(writer, [asked, note("A Note after the Answer.")]);
    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);

    // Answers are ordinary text: the User edits this one.
    const answerElement = writer.blocks.get(1) as Y.XmlElement;
    const paragraph = answerElement.get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert("Generated text.".length, " My own words.");
    await writer.settled();
    expect(answerText(reader, answerId)).toBe("Generated text. My own words.");

    // Regenerating sends the Question again, and the new Answer comes as changes over theirs.
    expect(await core.regenerateAnswer({ mindId: mind.id, answerId })).toEqual({
      asked: true,
      answerId,
    });
    expect(await answerEnded(core, answerId)).toMatchObject({ event: "finished" });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(shownWithChanges(reader).slice(1, 2)).toEqual([
      "[-Generated text. My own words.-]{+Regenerated text.+}",
    ]);
    expect(answerIn(reader, answerId).attrs).toMatchObject({ status: "done" });
    const [change] = pendingProposals(reader.blocks);
    expect(proposalRequestOf(reader.doc, change?.request ?? "")).toMatchObject({
      source: "answer",
      answerId,
      modelId: "local-model",
    });
    // Until a change is accepted, the Answer is what the User wrote, for the model and for exports.
    const exported = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(exported).toContain("Generated text. My own words.");
    expect(exported).not.toContain("Regenerated");
    // The rest of the Mind is as it was.
    expect(readMind(reader).child(2).textContent).toBe("A Note after the Answer.");

    // Asking again while changes wait replaces them with the new Answer's.
    expect(await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id })).toEqual({
      asked: true,
      answerId,
    });
    await answerEnded(core, answerId);
    expect(shownWithChanges(reader).slice(1, 2)).toEqual([
      "[-Generated text. My own words.-]{+Written again.+}",
    ]);
    expect(pendingProposals(reader.blocks)).toHaveLength(1);

    // Rejecting them keeps the User's words, and the Answer is still theirs.
    await resolveChanges(writer, "reject");
    expect(answerText(reader, answerId)).toBe("Generated text. My own words.");
    await core.regenerateAnswer({ mindId: mind.id, answerId });
    await answerEnded(core, answerId);
    expect(shownWithChanges(reader).slice(1, 2)).toEqual([
      "[-Generated text. My own words.-]{+Once more.+}",
    ]);

    // Accepting them all makes it the model's Answer again: the next Regenerate replaces it in place.
    await resolveChanges(writer, "accept");
    expect(answerText(reader, answerId)).toBe("Once more.");
    await core.regenerateAnswer({ mindId: mind.id, answerId });
    await answerEnded(core, answerId);
    expect(answerText(reader, answerId)).toBe("Replaced in place.");
    expect(pendingProposals(reader.blocks)).toEqual([]);
  });

  test("an Answer cut off by quitting is kept, marked stopped, after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const controlled = controlledModel();
    const first = await setUp(controlled.model, dataDir);
    const asked = question("Will this survive?");
    writeMind(first.writer, [asked]);
    await first.writer.settled();
    const answerId = await ask(first.core, first.mind.id, asked.attrs.id);
    await controlled.requested();
    controlled.push("Half of an ");
    await vi.waitFor(() => expect(answerText(first.reader, answerId)).toBe("Half of an"));
    first.core.close();

    const second = startCore(dataDir);
    const reader = await connectToMind(second, first.mind.id);
    expect(outline(reader)).toEqual(["question", "answer:stopped", "paragraph"]);
    expect(answerText(reader, answerId)).toBe("Half of an");
  });
});

describe("When Questions can't be answered", () => {
  test.each([
    { status: 401, message: "Incorrect API key provided.", kind: "auth" },
    { status: 429, message: "Rate limit reached.", kind: "rate-limit" },
    { status: 500, message: "The server had an error.", kind: "provider" },
    { status: undefined, message: "Cannot connect to API.", kind: "network" },
  ])(
    "a provider error ($kind) fails the Answer, which shows its kind",
    async ({ status, message, kind }) => {
      const { core, mind, writer, reader } = await setUp(failingStreamModel(status, message));
      const asked = question("Will this work?");
      writeMind(writer, [asked]);
      await writer.settled();

      const answerId = await ask(core, mind.id, asked.attrs.id);
      const ended = await answerEnded(core, answerId);

      expect(ended).toEqual({
        event: "failed",
        payload: {
          mindId: mind.id,
          answerId,
          error: { kind, message: expect.stringContaining(message), status },
        },
      });
      expect(answerIn(reader, answerId).attrs).toMatchObject({
        status: "failed",
        errorKind: kind,
        errorMessage: expect.stringContaining(message),
      });
    },
  );

  test("without a chat model nothing is sent, and asking says why", async () => {
    const model = streamingModel("Unused.");
    const models = scriptedModels(model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    const mind = await core.createMind();
    const writer = await connectToMind(core, mind.id);
    const asked = question("Is anyone there?");
    writeMind(writer, [asked]);
    await writer.settled();

    expect(await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id })).toEqual({
      asked: false,
      reason: "not-ready",
      readiness: { ready: false, reason: "no-provider" },
    });
    expect(outline(writer)).toEqual(["question"]);
    expect(models.specs).toEqual([]);
    expect(model.doStreamCalls).toEqual([]);
  });

  test("an Answer stopped while consent is being asked sends nothing, even once it is given", async () => {
    const model = streamingModel("Unused.");
    const models = scriptedModels(model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    const requested = nextEvent(core, "consent.requested");
    const mind = await core.createMind();
    const writer = await connectToMind(core, mind.id);
    const asked = question("Wait for me?");
    writeMind(writer, [asked]);
    await writer.settled();

    const answerId = await ask(core, mind.id, asked.attrs.id);
    const request = await requested;
    await core.stopAnswer({ mindId: mind.id, answerId });
    expect(answerIn(writer, answerId).attrs.status).toBe("stopped");

    await core.respondToConsent(request.requestId, true);
    await vi.waitFor(() => expect(models.specs).toHaveLength(1), { timeout: 10_000 });
    await nextTurn();
    expect(model.doStreamCalls).toEqual([]);
    expect(answerIn(writer, answerId).attrs.status).toBe("stopped");
  });

  test("declining to send data to the provider fails the Answer and sends nothing", async () => {
    const model = streamingModel("Unused.");
    const models = scriptedModels(model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, false));
    const mind = await core.createMind();
    const writer = await connectToMind(core, mind.id);
    const asked = question("Can I ask this?");
    writeMind(writer, [asked]);
    await writer.settled();

    const answerId = await ask(core, mind.id, asked.attrs.id);
    const ended = await answerEnded(core, answerId);

    expect(ended).toMatchObject({
      event: "failed",
      payload: { error: { kind: "consent-declined" } },
    });
    expect(answerIn(writer, answerId).attrs).toMatchObject({
      status: "failed",
      errorKind: "consent-declined",
    });
    expect(models.specs).toEqual([]);
    expect(model.doStreamCalls).toEqual([]);

    // Asking again is refused up front: Questions are off for that service.
    expect(await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id })).toMatchObject({
      asked: false,
      reason: "not-ready",
      readiness: { ready: false, reason: "consent-declined" },
    });
    expect(model.doStreamCalls).toEqual([]);
  });

  test("a Question refused for a decline is answered once the service is allowed in Settings, and not before (#1297)", async () => {
    const model = streamingModel("Answered after the allowance.");
    const models = scriptedModels(model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    const stopDeclining = core.on(
      "consent.requested",
      (request) => void core.respondToConsent(request.requestId, false),
    );
    const mind = await core.createMind();
    const writer = await connectToMind(core, mind.id);
    const asked = question("Can I ask this after all?");
    writeMind(writer, [asked]);
    await writer.settled();

    const declined = await ask(core, mind.id, asked.attrs.id);
    expect(await answerEnded(core, declined)).toMatchObject({ event: "failed" });
    stopDeclining();
    expect(model.doStreamCalls).toEqual([]);

    await core.allowDataFlow("chat", "https://api.openai.com");
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.service.id));
    const answerId = await ask(core, mind.id, asked.attrs.id);
    expect(await answerEnded(core, answerId)).toMatchObject({ event: "finished" });
    expect(requests).toEqual([]);
    expect(models.specs).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(answerIn(writer, answerId).attrs).toMatchObject({ status: "done" });
  });
});

describe("Choosing the model", () => {
  test("a model picked on the Question is used instead of the default, and the Answer records it", async () => {
    const model = streamingModel("Answered by the picked model.");
    const { core, models, mind, writer, reader } = await setUp(model);
    const picked = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "picked-model",
    });
    // Saving makes a provider the default: put the default back on Ollama.
    const ollama = (await core.listChatProviders()).find((provider) => provider.kind === "ollama");
    await core.updateSettings({
      user: { chatModel: { providerId: ollama?.id ?? "", modelId: "local-model" } },
    });

    const asked = question("Which model are you?", {
      providerId: picked.id,
      modelId: "picked-model",
    });
    writeMind(writer, [asked]);
    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);

    expect(models.specs).toEqual([
      {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: null,
        modelId: "picked-model",
        thinking: "answer",
      },
    ]);
    expect(answerIn(reader, answerId).attrs).toMatchObject({
      providerId: picked.id,
      modelId: "picked-model",
    });
  });

  test("the model picker lists each saved provider's models, the default first", async () => {
    const core = startCore(await createTempDataFolder());
    const ollama = await startOllamaStub({
      models: ["llama3.2:latest", "nomic-embed-text:latest", "qwen3:4b"],
      capabilities: {
        "llama3.2:latest": ["completion", "tools"],
        "nomic-embed-text:latest": ["embedding"],
      },
    });
    const server = await startModelListStub(["deepseek-reasoner", "deepseek-chat"]);
    const local = await core.saveChatProvider({
      kind: "ollama",
      baseUrl: ollama.baseUrl,
      modelId: "qwen3:4b",
    });
    const compatible = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: server.baseUrl,
      apiKey: "sk-local",
      modelId: "deepseek-chat",
    });

    expect(await core.listChatModels()).toMatchObject([
      // Embedding models can't answer, so they aren't offered. Ollama says what llama3.2 can
      // do; nothing says what the others can.
      {
        provider: local,
        models: ["llama3.2:latest", "qwen3:4b"],
        names: {},
        other: [],
        added: [],
        unknown: ["qwen3:4b"],
        cloud: [],
      },
      {
        provider: compatible,
        models: ["deepseek-chat", "deepseek-reasoner"],
        names: {},
        other: [],
        added: [],
        unknown: ["deepseek-chat", "deepseek-reasoner"],
        cloud: [],
      },
    ]);
    expect(server.authorizations).toEqual(["Bearer sk-local"]);
  });

  test("a cloud provider isn't asked for its models before the User allows the chat flow to it", async () => {
    const core = startCore(await createTempDataFolder());
    const provider = await saveProviderUnasked(core, {
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-test",
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => fetch.mockRestore());

    expect(await core.listChatModels()).toMatchObject([
      {
        provider,
        models: ["gpt-test"],
        names: {},
        other: [],
        added: [],
        unknown: ["gpt-test"],
        cloud: [],
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a provider that can't be reached offers only its default model", async () => {
    const core = startCore(await createTempDataFolder());
    const provider = await core.saveChatProvider({
      kind: "ollama",
      baseUrl: await unusedLocalUrl(),
      modelId: "qwen3:4b",
    });

    expect(await core.listChatModels()).toMatchObject([
      {
        provider,
        models: ["qwen3:4b"],
        names: {},
        other: [],
        added: [],
        unknown: ["qwen3:4b"],
        cloud: [],
      },
    ]);
  });
});

describe("Editing while an Answer streams", () => {
  test("deleting an Answer while it is written stops it", async () => {
    const controlled = controlledModel();
    const { core, mind, writer, reader } = await setUp(controlled.model);
    const asked = question("Start something.");
    writeMind(writer, [asked]);
    await writer.settled();
    const answerId = await ask(core, mind.id, asked.attrs.id);
    await controlled.requested();
    controlled.push("Some text");
    await vi.waitFor(() => expect(answerText(reader, answerId)).toBe("Some text"));

    const finished = nextEvent(core, "answer.finished");
    editMind(writer, (blocks) => blocks.filter((block) => block.type !== "answer"));
    await writer.settled();
    controlled.push(" and more");

    expect(await finished).toEqual({
      ...NO_CITATIONS,
      mindId: mind.id,
      answerId,
      status: "stopped",
    });
    expect(controlled.aborted).toBe(true);
    expect(outline(reader)).toEqual(["question", "paragraph"]);
  });

  test("an Answer goes right after its Question, wherever that is, and Blocks below stay below", async () => {
    const model = streamingModel("In the middle.");
    const { core, mind, writer, reader } = await setUp(model);
    const asked = question("Where does this go?");
    writeMind(writer, [note("Above."), asked, note("Below.")]);

    await askAndWait(core, writer, mind.id, asked.attrs.id);

    expect(outline(reader)).toEqual(["paragraph", "question", "answer:done", "paragraph"]);
    expect(readMind(reader).child(3).textContent).toBe("Below.");
    // The Note below isn't part of the Question context.
    expect(promptOf(model).at(-1)?.text).toBe("Above.\n\nWhere does this go?");
  });
});

describe("Temperature", () => {
  test("Answers are written at a low temperature, so quotes are copied word for word", async () => {
    const model = streamingModel("Twice a day.");
    const { core, mind, writer } = await setUp(model);
    const asked = question("How often are high tides?");
    writeMind(writer, [asked]);

    await askAndWait(core, writer, mind.id, asked.attrs.id);

    expect(ANSWER_TEMPERATURE).toBeLessThanOrEqual(0.3);
    expect(model.doStreamCalls[0]?.temperature).toBe(ANSWER_TEMPERATURE);
  });

  // Six Answers, each from a core of its own: over 5 seconds on a slow runner.
  test("a model the catalog says takes no temperature is sent none; one it says takes one, or doesn't know, gets the Answer's", {
    timeout: 30_000,
  }, async () => {
    const temperatureFor = async (provider: CloudProvider) => {
      const model = streamingModel("Twice a day.");
      const { core, mind, writer, reader } = await setUpCloud(model, provider);
      const asked = question("How often are high tides?");
      writeMind(writer, [asked]);
      const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);
      expect(answerText(reader, answerId)).toBe("Twice a day.");
      return model.doStreamCalls[0]?.temperature;
    };

    // Claude's newest reject one, as do OpenAI's reasoning models; Google wants its default.
    expect(
      await temperatureFor({ kind: "anthropic", modelId: "claude-sonnet-5-5" }),
    ).toBeUndefined();
    expect(await temperatureFor({ kind: "openai", modelId: "o3-mini" })).toBeUndefined();
    expect(await temperatureFor({ kind: "google", modelId: "gemini-3.8-flash" })).toBeUndefined();
    // Models that take one, a dated snapshot of one, and an id the catalog doesn't know.
    expect(await temperatureFor({ kind: "openai", modelId: "gpt-4.1" })).toBe(ANSWER_TEMPERATURE);
    expect(await temperatureFor({ kind: "openai", modelId: "gpt-4o-2024-08-06" })).toBe(
      ANSWER_TEMPERATURE,
    );
    expect(await temperatureFor({ kind: "openai", modelId: "gpt-7-preview" })).toBe(
      ANSWER_TEMPERATURE,
    );
    expect(answerTemperature(false)).toBeUndefined();
    expect(answerTemperature(undefined)).toBe(ANSWER_TEMPERATURE);
  });

  test("a provider that refuses the temperature gets the request again without one, and the model gets none from then on", async () => {
    // e.g. an OpenAI reasoning model behind an OpenAI-compatible server, under a name of its own.
    const model = scriptedModel(
      (call) => {
        if (call.options.temperature !== undefined) {
          return {
            error: {
              status: 400,
              message: "Unsupported parameter: 'temperature' is not supported with this model.",
            },
          };
        }
        if (call.results.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
        }
        return { text: "Twice a day." };
      },
      { modelId: "my-reasoning-deployment" },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: "# Tides\n\nHigh tides come twice a day.\n" },
    ]);

    const first = await askAndFinish(core, client, mind.id, "How often are high tides?");

    expect(answerText(client, first.answerId)).toBe("Twice a day.");
    // Still with Tools: a refused temperature isn't a refusal of Tools.
    expect(first.finished.citationSupport).toBe("tools");
    expect(model.doStreamCalls.map((call) => call.temperature)).toEqual([
      ANSWER_TEMPERATURE,
      undefined,
      undefined,
    ]);

    await askAndFinish(core, client, mind.id, "How often are high tides again?");
    expect(model.doStreamCalls).toHaveLength(5);
    expect(model.doStreamCalls.slice(3).map((call) => call.temperature)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("Local mode", () => {
  const CLOUD: CloudProvider = { kind: "openai", modelId: "gpt-4.1" };

  test("a cloud model gets nothing, in a Mind or in a conversation, and says why", async () => {
    const model = streamingModel("Never sent.");
    const { core, models, provider, mind, writer } = await setUpCloud(model, CLOUD);
    await core.setLocalOnly(true);
    const asked = question("What is a Mind?");
    writeMind(writer, [asked]);
    await writer.settled();

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    expect(result).toMatchObject({
      asked: false,
      reason: "not-ready",
      readiness: { ready: false, reason: "local-mode", provider: { id: provider.id } },
    });
    const inConversation = await core.askInConversation({ text: "What is a Mind?" });
    expect(inConversation).toMatchObject({
      asked: false,
      reason: "not-ready",
      readiness: { reason: "local-mode" },
    });

    expect(models.specs).toEqual([]);
    expect(model.doStreamCalls).toEqual([]);
    expect(outline(writer)).toEqual(["question"]);
    expect(await core.getChatReadiness()).toMatchObject({ ready: false, reason: "local-mode" });
  });

  test("a model on this computer answers as usual, and the cloud model again once local mode is off", async () => {
    const { core, mind, writer, reader } = await setUp(streamingModel("Twice a day."));
    await core.setLocalOnly(true);
    const asked = question("How often are high tides?");
    writeMind(writer, [asked]);

    const answerId = await askAndWait(core, writer, mind.id, asked.attrs.id);
    expect(answerText(reader, answerId)).toBe("Twice a day.");

    const cloud = await setUpCloud(streamingModel("From the cloud."), CLOUD);
    await cloud.core.setLocalOnly(true);
    await cloud.core.setLocalOnly(false);
    const again = question("And the cloud?");
    writeMind(cloud.writer, [again]);
    const cloudAnswer = await askAndWait(cloud.core, cloud.writer, cloud.mind.id, again.attrs.id);
    expect(answerText(cloud.reader, cloudAnswer)).toBe("From the cloud.");
  });

  test("turning it on stops an Answer on its way to a cloud model, keeps what was written and says why", async () => {
    const controlled = controlledModel();
    const { core, mind, writer, reader } = await setUpCloud(controlled.model, CLOUD);
    const asked = question("What is a Mind?");
    writeMind(writer, [asked]);
    await writer.settled();
    const answerId = await ask(core, mind.id, asked.attrs.id);
    await controlled.requested();
    controlled.push("A Mind is ");
    await vi.waitFor(() => expect(answerText(reader, answerId)).toBe("A Mind is"));
    const readiness = nextEvent(core, "chatReadiness.changed");
    const ended = answerEnded(core, answerId);

    await core.setLocalOnly(true);

    expect(await ended).toMatchObject({
      event: "failed",
      payload: { answerId, error: { kind: "local-mode" } },
    });
    expect(controlled.aborted).toBe(true);
    expect(answerIn(reader, answerId).attrs).toMatchObject({
      status: "failed",
      errorKind: "local-mode",
    });
    expect(answerText(reader, answerId)).toBe("A Mind is");
    expect(await readiness).toMatchObject({ ready: false, reason: "local-mode" });
  });

  test("an Answer being written by a model on this computer carries on", async () => {
    const controlled = controlledModel();
    const { core, mind, writer, reader } = await setUp(controlled.model);
    const asked = question("What is a Mind?");
    writeMind(writer, [asked]);
    await writer.settled();
    const answerId = await ask(core, mind.id, asked.attrs.id);
    await controlled.requested();
    const ended = answerEnded(core, answerId);

    await core.setLocalOnly(true);
    controlled.push("A notebook.");
    controlled.finish();

    expect((await ended).event).toBe("finished");
    expect(answerText(reader, answerId)).toBe("A notebook.");
  });
});
