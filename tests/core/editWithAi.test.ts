import type { JSONContent } from "@tiptap/core";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type ConsentRequest,
  type Core,
  type Document,
  type EditCause,
  type EditWithAiInput,
  MIND_PROPOSAL_REQUESTS_FIELD,
  PROPOSAL_ATTRIBUTE,
  type WritingPlace,
} from "../../src/core";
import {
  aiUseOfAccepted,
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  resolveProposals,
} from "../../src/shared/proposals";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, nextEvent, saveProviderUnasked, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import { controlledModel, scriptedModels, streamedReply } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** What an Edit with AI request asked: the passage, the action, the whole prompt and the instructions. */
interface EditCall {
  passage: string;
  action: string;
  prompt: string;
  system: string;
}

type Prompt = MockLanguageModelV4["doStreamCalls"][number]["prompt"];

const textOf = (prompt: Prompt, role: "user" | "system") =>
  prompt
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");

/** A model that rewrites each passage with `edit`, streamed a few characters at a time; automatic tagging gets no Tags. */
function editingModel(
  edit: (call: EditCall) => string | Promise<string>,
  calls: EditCall[] = [],
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ tags: [] }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
    doStream: async ({ prompt, abortSignal }) => {
      const text = textOf(prompt, "user");
      const call = {
        passage: /<passage>\n([\s\S]*?)\n<\/passage>/.exec(text)?.[1] ?? "",
        action: /<task action="([^"]+)">/.exec(text)?.[1] ?? "",
        prompt: text,
        system: textOf(prompt, "system"),
      };
      calls.push(call);
      return { stream: streamedReply(await edit(call), abortSignal) };
    },
  });
}

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});

let ids = 0;
const paragraph = (...content: JSONContent[]): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `block-${++ids}` },
  content,
});

/** A Citation of the Tides Document's spring-tides line, as a Note holds one copied from an Answer. */
function citation(tides: Document, check: "found" | "not-found" = "found"): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: tides.id,
      documentName: "Tides",
      contentHash: tides.contentHash,
      pageFrom: null,
      pageTo: null,
      quote: "Spring tides happen at new moon and at full moon",
      check,
      checkReason: check === "found" ? null : "quote-not-on-pages",
    },
  };
}

/** The editor's reading of a paragraph's text (an inline node as U+FFFC), for `EditWithAiInput.text`. */
function plainOf(client: MindClient, blockId: string): string {
  let found = "";
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    found = node.textBetween(0, node.content.size, "", "￼");
    return false;
  });
  return found;
}

/** Edit with AI over the whole of one paragraph. */
function wholeParagraph(
  client: MindClient,
  mindId: string,
  blockId: string,
  action: EditWithAiInput["action"],
  instruction?: string,
): EditWithAiInput {
  const plain = plainOf(client, blockId);
  return {
    requestId: `edit-${++ids}`,
    mindId,
    from: { blockId, offset: 0 },
    to: { blockId, offset: plain.length },
    text: plain,
    action,
    ...(instruction !== undefined && { instruction }),
  };
}

async function setUp(model: MockLanguageModelV4) {
  const set = await setUpWithDocuments(model, [TIDES]);
  return { ...set, tides: set.documents[0] as Document };
}

async function exported(core: Core, mindId: string): Promise<string> {
  const file = await core.exportMind(mindId, { format: "markdown" });
  return new TextDecoder().decode(file.data);
}

describe("Edit with AI", () => {
  test("a request comes back as Proposals, one per place that changed, and nothing changes until they are accepted", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(() => "The tides here are strong and regular.", calls),
    );
    const note = paragraph(text("The tides here are very strong and really regular."));
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));

    expect(result).toMatchObject({ kind: "proposed", proposals: 2, droppedCitations: 0 });
    expect(shownWithChanges(client)).toEqual([
      "The tides here are [-very -]strong and [-really -]regular.",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.action).toBe("shorten");
    expect(calls[0]?.passage).toBe("The tides here are very strong and really regular.");
    // Pending Proposals aren't the Mind's text yet: exports read it as it was.
    expect(await exported(core, mind.id)).toContain(
      "The tides here are very strong and really regular.",
    );
    // The Mind says which model made them.
    const request = result.kind === "proposed" ? result.request : "";
    expect(proposalRequestOf(client.doc, request)).toMatchObject({
      source: "edit-with-ai",
      modelId: "local-model",
    });

    // Accept one, reject the other.
    await resolveChanges(client, "accept", (_id, index) => index === 0);
    expect(shownWithChanges(client)).toEqual(["The tides here are strong and [-really -]regular."]);
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)).toEqual(["The tides here are strong and really regular."]);
    expect(await exported(core, mind.id)).toContain(
      "The tides here are strong and really regular.",
    );
  });

  test("words added come after those they replace, with the marks of the words they replace", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "Spring tides come twice each month."),
    );
    const note = paragraph(text("Spring tides "), text("happen twice a month", "bold"), text("."));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));

    expect(shownWithChanges(client)).toEqual([
      "Spring tides [-happen-]{+come+} twice [-a-]{+each+} month.",
    ]);
    const added = readMind(client).firstChild?.content.content.filter((node) =>
      node.marks.some((mark) => mark.type.name === "proposalInsert"),
    );
    expect(added?.every((node) => node.marks.some((mark) => mark.type.name === "bold"))).toBe(true);
    // Until accepted, what is read of the Mind (Question context, exports) is the text as it was.
    const before = await exported(core, mind.id);
    expect(before).toContain("Spring tides **happen twice a month**.");
    expect(before).not.toContain("come");
    await resolveChanges(client, "accept");
    expect(await exported(core, mind.id)).toContain("Spring tides **come twice each month**.");
    expect(shownWithChanges(client)).toEqual(["Spring tides come twice each month."]);
    // The words the changes added are AI text; those they kept are as they were.
    expect(readMind(client).firstChild?.toJSON().content).toEqual([
      text("Spring tides "),
      text("come", "generated", "bold"),
      text(" twice ", "bold"),
      text("each", "generated", "bold"),
      text(" month", "bold"),
      text("."),
    ]);
  });

  test("a selection inside a paragraph changes only what was selected, and the model sees the words around it", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(editingModel(() => "Moon", calls));
    const long =
      "Long before anyone kept tide tables, sailors watched how the water rose and fell. ";
    const note = paragraph(text(`${long}The moon pulls the sea, and the moon sets the tides.`));
    writeMind(client, [note]);
    await client.settled();
    const plain = plainOf(client, note.attrs.id);
    const from = plain.lastIndexOf("moon");

    await core.editWithAi({
      requestId: "edit-capital",
      mindId: mind.id,
      from: { blockId: note.attrs.id, offset: from },
      to: { blockId: note.attrs.id, offset: from + 4 },
      text: "moon",
      action: "instruction",
      instruction: "Capitalise it",
    });

    expect(shownWithChanges(client)).toEqual([
      `${long}The moon pulls the sea, and the [-moon-]{+Moon+} sets the tides.`,
    ]);
    // About 80 characters before it, no word cut in two, and what follows it.
    expect(calls[0]?.prompt).toContain(
      "<before>\nsailors watched how the water rose and fell. The moon pulls the sea, and the\n</before>",
    );
    expect(calls[0]?.prompt).toContain("<after>\nsets the tides.\n</after>");
  });

  test("a Citation the new text keeps stays, and is checked again; one it drops is shown for review", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(({ passage }) =>
        passage.includes("[2]") ? "Spring tides come at new and full moon [1]." : passage,
      ),
    );
    // Two Citations, the first said not found when it was made: it is found now.
    const note = paragraph(
      text("Spring tides happen at new moon and at full moon "),
      citation(tides, "not-found"),
      text(", and they are the highest "),
      citation(tides),
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));

    expect(result).toMatchObject({ kind: "proposed", droppedCitations: 1 });
    expect(shownWithChanges(client)).toEqual([
      "[-Spring tides happen at new moon and at full moon ⟨not-found⟩, and they are the highest ⟨found⟩.-]{+Spring tides come at new and full moon ⟨found⟩.+}",
    ]);

    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual(["Spring tides come at new and full moon ⟨found⟩."]);
    const kept: Record<string, unknown>[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === "citation") kept.push(node.attrs);
    });
    expect(kept).toEqual([
      expect.objectContaining({
        documentId: tides.id,
        contentHash: tides.contentHash,
        quote: "Spring tides happen at new moon and at full moon",
        check: "found",
        [PROPOSAL_ATTRIBUTE]: null,
      }),
    ]);
  });

  // protects=a Citation the User keeps on the version it quotes (Keep citing the old version, ADR-0017's amendment) stays on that version when a rewrite of its sentence is accepted, though its quote is in the current version; fails_when=accepting the rewrite re-points it at the current version; no_claim=none beyond protects.
  test("a Citation kept on the old version stays on it through an accepted rewrite", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() => "Spring tides come at new and full moon [1]."),
    );
    const kept = citation(tides);
    kept.attrs = { ...kept.attrs, contentHash: "an-older-version", keptOver: tides.contentHash };
    const note = paragraph(
      text("Spring tides happen at new moon and at full moon "),
      kept,
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    await resolveChanges(client, "accept");

    const after: Record<string, unknown>[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === "citation") after.push(node.attrs);
    });
    expect(after).toEqual([
      expect.objectContaining({ contentHash: "an-older-version", keptOver: tides.contentHash }),
    ]);
  });

  // protects=following a Citation's new version asks the model to make the sentence agree with the words its Citation now quotes, which the prompt gives as quoted context beside the marker, needs no instruction, keeps the Citation, and the words it replaces go (#99); fails_when=the Citation's words are not in the request, the request needs the caller's words, or the old words stay; no_claim=what a real model writes (tests/live/editWithAi.live.test.ts).
  test("follow-citation: the Citation's words go in as context, the old words are replaced and the Citation stays", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client, tides } = await setUp(
      editingModel(() => "Spring tides happen at new moon and at full moon [1].", calls),
    );
    const note = paragraph(
      text("Spring tides happen at the new moon only "),
      citation(tides),
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "follow-citation"),
    );

    expect(result.kind).toBe("proposed");
    expect(calls[0]?.action).toBe("follow-citation");
    expect(calls[0]?.prompt).toContain(
      "Its markers' Documents now say only this: [1] “Spring tides happen at new moon and at full moon”.",
    );
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([
      "Spring tides happen at new moon and at full moon ⟨found⟩.",
    ]);
  });

  test("the model sees Citations as numbered markers, formulas as written, and the paragraphs around the selection", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client, tides } = await setUp(
      editingModel(({ passage }) => passage, calls),
    );
    const note = paragraph(
      text("The force is "),
      { type: "inlineMath", attrs: { latex: "F = ma" } },
      text(" for spring tides "),
      citation(tides),
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "translate", "简体中文"),
    );

    expect(result).toEqual({ kind: "unchanged" });
    expect(calls[0]?.passage).toBe("The force is $F = ma$ for spring tides [1].");
    expect(calls[0]?.prompt).toContain("<context>\nThe force is $F = ma$ for spring tides [·].");
    expect(calls[0]?.prompt).toContain("Translate it into 简体中文");
    expect(calls[0]?.system).toContain("Keep every Citation marker");
    expect(shownWithChanges(client)).toEqual(["The force is ￼ for spring tides ⟨found⟩."]);
  });

  test("a footnote the User wrote stays where the model keeps its marker, moves with its text, or is struck when left out", async () => {
    const calls: EditCall[] = [];
    let reply = "";
    const { core, mind, client } = await setUp(editingModel(() => reply, calls));
    const footnote = (id: string, words: string): JSONContent => ({
      type: "footnote",
      attrs: { id },
      content: [text(words)],
    });
    const note = paragraph(
      text("Neap tides"),
      footnote("fn-before", "At the quarter moons."),
      text(" are weak. Spring tides are very strong"),
      footnote("fn-in", "Twice a month."),
      text(" and regular."),
    );
    writeMind(client, [note]);
    await client.settled();
    // From "Spring" to the end: the footnote before it counts as one character, its text none.
    const from = "Neap tides￼ are weak. ".length;
    const selected = "Spring tides are very strong￼ and regular.";
    const edit = async (requestId: string, rewrite: string) => {
      reply = rewrite;
      return core.editWithAi({
        requestId,
        mindId: mind.id,
        from: { blockId: note.attrs.id, offset: from },
        to: { blockId: note.attrs.id, offset: from + selected.length },
        text: selected,
        action: "shorten",
      });
    };
    const footnotes = () => {
      const found: { id: unknown; text: string; proposal: unknown }[] = [];
      readMind(client).descendants((node) => {
        if (node.type.name !== "footnote") return true;
        const kind = (node.attrs[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind ?? null;
        found.push({ id: node.attrs.id, text: node.textContent, proposal: kind });
        return false;
      });
      return found;
    };

    // Kept: only the words change around it.
    expect(await edit("edit-kept", "Spring tides are strong[^1] and regular.")).toMatchObject({
      kind: "proposed",
      proposals: 1,
    });
    expect(calls[0]?.passage).toBe("Spring tides are very strong[^1] and regular.");
    expect(calls[0]?.system).toContain("footnote marker, such as [^1]");
    expect(shownWithChanges(client)).toEqual([
      "Neap tides￼ are weak. Spring tides are [-very -]strong￼ and regular.",
    ]);
    await resolveChanges(client, "reject");

    // Moved: struck where it was, and copied with its text where the model put it.
    await edit("edit-moved", "Spring tides are very strong and regular[^1].");
    expect(shownWithChanges(client)).toEqual([
      "Neap tides￼ are weak. Spring tides are very strong[-￼-] and regular{+￼+}.",
    ]);
    const [, moved, copy] = footnotes();
    expect(moved).toEqual({ id: "fn-in", text: "Twice a month.", proposal: "delete" });
    expect(copy).toMatchObject({ text: "Twice a month.", proposal: "insert" });
    expect(copy?.id).not.toBe("fn-in");
    // A footnote's text was the User's: accepting its move writes nothing into the record of AI use.
    const accepted = await resolveChanges(client, "accept");
    expect(accepted.map((each) => each.characters)).toEqual([0, 0]);
    expect(shownWithChanges(client)).toEqual([
      "Neap tides￼ are weak. Spring tides are very strong and regular￼.",
    ]);
    expect(footnotes().map((each) => each.text)).toEqual([
      "At the quarter moons.",
      "Twice a month.",
    ]);
    expect(await exported(core, mind.id)).toContain("regular[^2].");

    // Left out: struck, for the User to review.
    const after = "Spring tides are very strong and regular￼.";
    reply = "Spring tides are strong and regular.";
    await core.editWithAi({
      requestId: "edit-dropped",
      mindId: mind.id,
      from: { blockId: note.attrs.id, offset: from },
      to: { blockId: note.attrs.id, offset: from + after.length },
      text: after,
      action: "shorten",
    });
    expect(shownWithChanges(client)).toEqual([
      "Neap tides￼ are weak. Spring tides are [-very -]strong and regular[-￼-].",
    ]);
  });

  test("Chinese is compared character by character", async () => {
    const { core, mind, client } = await setUp(editingModel(() => "潮水每天很规律地涨落两次。"));
    const note = paragraph(text("潮水每天非常规律地涨落两次。"));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));

    expect(shownWithChanges(client)).toEqual(["潮水每天[-非常-]{+很+}规律地涨落两次。"]);
  });

  test("Explain adds a new paragraph under the selection, as a Proposal of its own", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ action }) =>
        action === "explain" ? "It says the Moon lifts the sea twice a day [1]." : "",
      ),
    );
    const first = paragraph(text("The Moon raises two bulges of water."));
    const second = paragraph(text("A closing line."));
    writeMind(client, [first, second]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, first.attrs.id, "explain"),
    );

    expect(result).toMatchObject({ kind: "proposed", proposals: 1 });
    expect(shownWithChanges(client)).toEqual([
      "The Moon raises two bulges of water.",
      "+ It says the Moon lifts the sea twice a day.",
      "A closing line.",
    ]);
    expect(await exported(core, mind.id)).not.toContain("It says");
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)).toEqual([
      "The Moon raises two bulges of water.",
      "A closing line.",
    ]);
  });

  test("Shorten that joins two paragraphs takes the second out; an instruction's new text that leaves one out keeps it, unless it asks for text to go; paragraphs it adds are new Blocks", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) =>
        passage.includes("Second") ? "First and second, together." : "One line.\n\nAnother line.",
      ),
    );
    const first = paragraph(text("First paragraph."));
    const second = paragraph(text("Second paragraph."));
    const third = paragraph(text("Single line."));
    writeMind(client, [first, second, third]);
    await client.settled();
    const both = (action: EditWithAiInput["action"], instruction?: string): EditWithAiInput => ({
      requestId: `edit-join-${action}-${++ids}`,
      mindId: mind.id,
      from: { blockId: first.attrs.id, offset: 0 },
      to: { blockId: second.attrs.id, offset: "Second paragraph.".length },
      text: "First paragraph.\nSecond paragraph.",
      action,
      ...(instruction !== undefined && { instruction }),
    });

    expect(await core.editWithAi(both("shorten"))).not.toHaveProperty("leftOut");
    await core.editWithAi(wholeParagraph(client, mind.id, third.attrs.id, "instruction", "Split"));
    expect(shownWithChanges(client)).toEqual([
      "First [-paragraph-]{+and second, together+}.",
      "- Second paragraph.",
      "[-Single-]{+One+} line.",
      "+ Another line.",
    ]);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([
      "First and second, together.",
      "One line.",
      "Another line.",
    ]);

    writeMind(client, [first, second]);
    await client.settled();
    expect(await core.editWithAi(both("instruction", "Make it read better"))).toMatchObject({
      kind: "proposed",
      leftOut: [
        {
          blockId: second.attrs.id,
          from: 0,
          to: "Second paragraph.".length,
          whole: true,
          kind: "paragraph",
        },
      ],
    });
    expect(shownWithChanges(client)).toEqual([
      "First [-paragraph-]{+and second, together+}.",
      "Second paragraph.",
    ]);
    await resolveChanges(client, "reject");

    const asked = await core.editWithAi(
      both("instruction", "Join them and delete the second paragraph"),
    );
    expect(asked).not.toHaveProperty("leftOut");
    expect(shownWithChanges(client)).toEqual([
      "First [-paragraph-]{+and second, together+}.",
      "- Second paragraph.",
    ]);
  });

  test("an empty paragraph in the selection stays out of the pairing: each paragraph gets its own new text", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(() => "First line.\n\nThird line.", calls),
    );
    const first = paragraph(text("First paragraph."));
    const empty = paragraph();
    const third = paragraph(text("Third paragraph."));
    writeMind(client, [first, empty, third]);
    await client.settled();

    const result = await core.editWithAi({
      requestId: "edit-across-a-blank-line",
      mindId: mind.id,
      from: { blockId: first.attrs.id, offset: 0 },
      to: { blockId: third.attrs.id, offset: "Third paragraph.".length },
      text: "First paragraph.\n\nThird paragraph.",
      action: "shorten",
    });

    expect(calls[0]?.passage).toBe("First paragraph.\n\nThird paragraph.");
    expect(result).toMatchObject({ kind: "proposed", proposals: 2 });
    expect(shownWithChanges(client)).toEqual([
      "First [-paragraph-]{+line+}.",
      "",
      "Third [-paragraph-]{+line+}.",
    ]);
  });

  test("nothing is proposed over text that is gone or holds Proposals, nor when the model gives it back as it was", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { core, mind, client } = await setUp(
      editingModel(async ({ passage }) => {
        calls++;
        if (passage.startsWith("Slow")) await waiting;
        return passage.startsWith("Same") ? passage : `${passage} Indeed.`;
      }),
    );
    const slow = paragraph(text("Slow paragraph."));
    const same = paragraph(text("Same paragraph."));
    writeMind(client, [slow, same]);
    await client.settled();

    // What the editor read isn't what the Mind holds.
    expect(
      await core.editWithAi({
        ...wholeParagraph(client, mind.id, slow.attrs.id, "improve"),
        text: "Other",
      }),
    ).toEqual({ kind: "changed" });
    expect(calls).toBe(0);

    // The User deletes the paragraph while the model works: there is nothing to change.
    const gone = paragraph(text("Slow and gone."));
    writeMind(client, [slow, gone, same]);
    await client.settled();
    const editing = core.editWithAi(wholeParagraph(client, mind.id, gone.attrs.id, "improve"));
    await expect.poll(() => calls).toBe(1);
    client.blocks.delete(1, 1);
    await client.settled();
    release();
    expect(await editing).toEqual({ kind: "changed" });
    expect(shownWithChanges(client)).toEqual(["Slow paragraph.", "Same paragraph."]);
    expect(pendingProposals(client.blocks)).toEqual([]);

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, same.attrs.id, "improve")),
    ).toEqual({ kind: "unchanged" });

    // Proposals waiting in the selection: accept or reject them first.
    await core.editWithAi(wholeParagraph(client, mind.id, slow.attrs.id, "improve"));
    expect(shownWithChanges(client)[0]).toBe("Slow paragraph.{+ Indeed.+}");
    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, slow.attrs.id, "improve")),
    ).toEqual({ kind: "has-proposals" });
  });

  test("a request can be stopped, and one still waiting when the app quits writes nothing", async () => {
    let asked = () => {};
    const hanging = new MockLanguageModelV4({
      doStream: async ({ prompt, abortSignal }) => {
        if (textOf(prompt, "user").includes("<passage>")) asked();
        return new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () =>
            reject(new DOMException("The request was aborted.", "AbortError")),
          );
        });
      },
    });
    const { core, mind, client } = await setUp(hanging);
    const note = paragraph(text("A paragraph to improve."));
    writeMind(client, [note]);
    await client.settled();

    const input = wholeParagraph(client, mind.id, note.attrs.id, "improve");
    const waiting = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const editing = core.editWithAi(input);
    await waiting;
    await core.cancelEdit(input.requestId);
    expect(await editing).toEqual({ kind: "cancelled" });
    expect(shownWithChanges(client)).toEqual(["A paragraph to improve."]);

    // Quitting halfway: the request stops, and nothing is left half written.
    const again = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const quitting = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    await again;
    core.close();
    expect(await quitting).toEqual({ kind: "cancelled" });
    expect(pendingProposals(client.blocks)).toEqual([]);
  });

  test.each([
    "Remove the whole part about hours (full time, Monday to Friday) and leave the rest",
    "Delete the list item about hours",
    "删去整个“工作安排”部分（全职、周一至周五、核心工作时间），其他部分保持不变。",
    "删去这一条关于工时的列表项（全职工作，周一至周五）。",
  ])(
    "a part named in a longer request is removed by a reply of no text but why: %s",
    async (asked) => {
      const { core, mind, client } = await setUp(
        editingModel(() => "<why>Removed, as asked.</why>"),
      );
      const hours = paragraph(text("Work is full time, Monday to Friday."));
      const pay = paragraph(text("Pay is monthly."));
      writeMind(client, [hours, pay]);
      await client.settled();

      const result = await core.editWithAi(
        wholeParagraph(client, mind.id, hours.attrs.id, "instruction", asked),
      );

      expect(result).toMatchObject({ kind: "proposed" });
      expect(shownWithChanges(client)).toEqual([
        "- Work is full time, Monday to Friday.",
        "Pay is monthly.",
      ]);
    },
  );

  test("asked to remove a paragraph, a reply of no text but why removes it; any other empty reply fails with its reason", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) =>
        passage.startsWith("Pensions")
          ? "<why>Removed.</why>"
          : passage.startsWith("Health") || passage.startsWith("Sick")
            ? "<why>I can't do this.</why>"
            : "",
      ),
    );
    const pensions = paragraph(text("Pensions match up to 5% of salary."));
    const leave = paragraph(text("Leave is 25 days."));
    const health = paragraph(text("Health cover starts after three months."));
    const sick = paragraph(text("Sick pay is full for six weeks, then half for six more."));
    writeMind(client, [pensions, leave, health, sick]);
    await client.settled();

    const removed = await core.editWithAi(
      wholeParagraph(client, mind.id, pensions.attrs.id, "instruction", "Remove it"),
    );
    const silent = await core.editWithAi(
      wholeParagraph(client, mind.id, leave.attrs.id, "instruction", "Remove it"),
    );
    const refused = await core.editWithAi(
      wholeParagraph(client, mind.id, health.attrs.id, "instruction", "Make it more formal"),
    );

    expect(removed).toMatchObject({ kind: "proposed" });
    expect(silent).toMatchObject({ kind: "failed" });
    const shortened = await core.editWithAi(
      wholeParagraph(client, mind.id, sick.attrs.id, "instruction", "Cut it down to two sentences"),
    );
    expect(refused).toMatchObject({
      kind: "failed",
      error: { message: "I can't do this." },
    });
    expect(shortened).toMatchObject({ kind: "failed" });
    expect(shownWithChanges(client)).toEqual([
      "- Pensions match up to 5% of salary.",
      "Leave is 25 days.",
      "Health cover starts after three months.",
      "Sick pay is full for six weeks, then half for six more.",
    ]);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([
      "Leave is 25 days.",
      "Health cover starts after three months.",
      "Sick pay is full for six weeks, then half for six more.",
    ]);
  });

  test("a model that fails says why, and nothing is written", async () => {
    const { core, mind, client } = await setUp(
      new MockLanguageModelV4({
        doStream: async () => {
          throw new APICallError({
            message: "Too many requests",
            url: "http://127.0.0.1:11434/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: false,
          });
        },
      }),
    );
    const note = paragraph(text("A paragraph to improve."));
    writeMind(client, [note]);
    await client.settled();

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toEqual({ kind: "failed", error: expect.objectContaining({ kind: "rate-limit" }) });
    expect(shownWithChanges(client)).toEqual(["A paragraph to improve."]);
  });

  test("Proposals survive sync to another client and a restart, and resolve the same there", async () => {
    const dataDir = await createTempDataFolder();
    const model = editingModel(() => "The tides are strong and regular.");
    const models = scriptedModels(model);
    let core = startCore(dataDir, { createChatModel: models.createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Tides" });
    const first = await connectToMind(core, mind.id);
    const note = paragraph(text("The tides are very strong and really regular."));
    const extra = paragraph(text("Moon."));
    writeMind(first, [note, extra]);
    await first.settled();
    await core.editWithAi(wholeParagraph(first, mind.id, note.attrs.id, "shorten"));
    // A whole new Block too.
    model.doStream = async ({ abortSignal }) => ({
      stream: streamedReply("The Moon pulls the sea.", abortSignal),
    });
    await core.editWithAi(wholeParagraph(first, mind.id, extra.attrs.id, "explain"));
    const pending = shownWithChanges(first);
    expect(pending).toEqual([
      "The tides are [-very -]strong and [-really -]regular.",
      "Moon.",
      "+ The Moon pulls the sea.",
    ]);

    // Another client has them as they are.
    const second = await connectToMind(core, mind.id);
    expect(shownWithChanges(second)).toEqual(pending);

    // So does the Mind after a restart, from what was stored.
    core.close();
    core = startCore(dataDir, { createChatModel: models.createChatModel });
    const reloaded = await connectToMind(core, mind.id);
    expect(shownWithChanges(reloaded)).toEqual(pending);
    expect(pendingProposals(reloaded.blocks)).toHaveLength(3);
    expect(reloaded.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD).size).toBe(2);

    // Accepting one, rejecting one and accepting the Block gives the same text everywhere.
    const ids = pendingProposals(reloaded.blocks).map((proposal) => proposal.id);
    const apply = (doc: Y.Doc, blocks: Y.XmlFragment) =>
      doc.transact(() => {
        resolveProposals(blocks, (proposal) => proposal.id === ids[0], "accept");
        resolveProposals(blocks, (proposal) => proposal.id === ids[1], "reject");
        resolveProposals(blocks, (proposal) => proposal.id === ids[2], "accept");
      });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(reloaded.doc));
    apply(reloaded.doc, reloaded.blocks);
    await reloaded.settled();
    apply(copy, copy.getXmlFragment("blocks"));
    const expected = [
      "The tides are strong and really regular.",
      "Moon.",
      "The Moon pulls the sea.",
    ];
    expect(shownWithChanges(reloaded)).toEqual(expected);
    const again = await connectToMind(core, mind.id);
    expect(shownWithChanges(again)).toEqual(expected);
    expect(
      copy
        .getXmlFragment("blocks")
        .toArray()
        .map((block) =>
          (block as Y.XmlElement)
            .toArray()
            .map((child) => child.toString())
            .join(""),
        ),
    ).toEqual([
      "The tides are strong and really regular.",
      "Moon.",
      // Stored as AI text, as the editor's binding keeps a mark.
      "<generated>The Moon pulls the sea.</generated>",
    ]);
  });

  test("an accepted change goes into the record of AI use with the model that wrote it; a rejected one, or one that only removes words, doesn't", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "The tides are strong and quite regular."),
    );
    const note = paragraph(text("The tides are very strong and regular."));
    writeMind(client, [note]);
    await client.settled();
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    expect(shownWithChanges(client)).toEqual([
      "The tides are [-very -]strong and {+quite +}regular.",
    ]);

    // As the editor does: accept, send the change, then record what was accepted.
    const [removing, adding] = pendingProposals(client.blocks).map((proposal) => proposal.id);
    const accepted = await resolveChanges(client, "accept", (id) => id === adding);
    await resolveChanges(client, "reject", (id) => id === removing);
    const entries = aiUseOfAccepted(client.doc, mind.id, accepted, "2026-10-11T09:00:00.000Z");
    await core.recordAiUse(entries);

    expect(await core.listAiUse(mind.id)).toEqual([
      expect.objectContaining({
        kind: "edit-with-ai-accepted",
        outcome: "kept",
        providerId: expect.any(String),
        modelId: "local-model",
        characters: "quite ".length,
        blockIds: [note.attrs.id],
      }),
    ]);
    // Removing words writes nothing of the AI's.
    const removed = { id: removing ?? "", request: adding ?? "", characters: 0, blockIds: [] };
    expect(aiUseOfAccepted(client.doc, mind.id, [removed], "")).toEqual([]);
  });

  test("an accept is one step of Undo, which brings the Proposal back", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "The tides are strong and regular."),
    );
    const note = paragraph(text("The tides are very strong and really regular."));
    writeMind(client, [note]);
    await client.settled();
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });

    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual(["The tides are strong and regular."]);
    undo.undo();
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The tides are [-very -]strong and [-really -]regular.",
    ]);
    expect(pendingProposals(client.blocks)).toHaveLength(2);
    undo.redo();
    expect(shownWithChanges(client)).toEqual(["The tides are strong and regular."]);
  });
});

/** The Mind's paragraphs and headings with what kind of Block each is: "h2", "•" a bullet, "1." a numbered item, "p". */
/** Edit with AI over the whole of several paragraphs, first to last. */
function across(
  client: MindClient,
  mindId: string,
  blockIds: readonly string[],
  action: EditWithAiInput["action"],
  instruction?: string,
): EditWithAiInput {
  const first = blockIds[0] as string;
  const last = blockIds.at(-1) as string;
  return {
    requestId: `edit-${++ids}`,
    mindId,
    from: { blockId: first, offset: 0 },
    to: { blockId: last, offset: plainOf(client, last).length },
    text: blockIds.map((id) => plainOf(client, id)).join("\n"),
    action,
    ...(instruction !== undefined && { instruction }),
  };
}

/** Where the core says Edit with AI writes next in each Mind, the latest last. */
function writingPlaces(core: Core): (WritingPlace | null)[] {
  const seen: (WritingPlace | null)[] = [];
  core.on("mind.writing", ({ place }) => seen.push(place));
  return seen;
}

describe("Edit with AI as the model writes (#202)", () => {
  const tidesNote = () => [
    paragraph(text("The tides here are very strong.")),
    paragraph(text("The moon is really bright tonight.")),
    paragraph(text("Harbours are quite busy in spring.")),
  ];

  // protects=each paragraph the model finishes is in the Mind as changes at once, with Writing… on the paragraph it writes next, and the reason it gives is kept with the changes; fails_when=nothing shows until the reply ends, a paragraph is written twice, Writing… stays, or the reason is lost or shows in the text; no_claim=how a real provider chunks its text.
  test("each finished paragraph is in the Mind as changes while the rest comes, with Writing… on the next, and the reason is kept", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const blocks = tidesNote();
    writeMind(client, blocks);
    await client.settled();
    const places = writingPlaces(core);

    const editing = core.editWithAi(
      across(
        client,
        mind.id,
        blocks.map((block) => block.attrs.id),
        "shorten",
      ),
    );
    await controlled.requested();
    controlled.push("The tides here are strong.\n\nThe moon is");
    await vi.waitFor(() =>
      expect(shownWithChanges(client)).toEqual([
        "The tides here are [-very -]strong.",
        "The moon is really bright tonight.",
        "Harbours are quite busy in spring.",
      ]),
    );
    expect(places.at(-1)).toEqual({ over: blocks[1]?.attrs.id });

    controlled.push(
      " bright tonight.\n\nHarbours are busy in spring.\n<why>Shorter: the filler words are gone.</why>",
    );
    controlled.finish();
    const result = await editing;

    expect(result).toMatchObject({ kind: "proposed", proposals: 3 });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The tides here are [-very -]strong.",
      "The moon is [-really -]bright tonight.",
      "Harbours are [-quite -]busy in spring.",
    ]);
    expect(places.at(-1)).toBeNull();
    const request = result.kind === "proposed" ? result.request : "";
    expect(proposalRequestOf(client.doc, request)).toMatchObject({
      source: "edit-with-ai",
      reason: "Shorter: the filler words are gone.",
    });
  });

  // protects=Stop keeps the changes of the paragraphs already finished and leaves the rest of the selection as it was; fails_when=Stop takes back what was written, writes the half-finished paragraph, or removes the paragraphs not reached; no_claim=the renderer's Stop button.
  test("Stop keeps the finished paragraphs' changes and leaves the rest as it was", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const blocks = tidesNote();
    writeMind(client, blocks);
    await client.settled();
    const places = writingPlaces(core);

    const input = across(
      client,
      mind.id,
      blocks.map((block) => block.attrs.id),
      "shorten",
    );
    const editing = core.editWithAi(input);
    await controlled.requested();
    controlled.push("The tides here are strong.\n\nThe moon");
    await vi.waitFor(() => expect(pendingProposals(client.blocks)).toHaveLength(1));
    await core.cancelEdit(input.requestId);

    expect(await editing).toMatchObject({ kind: "proposed", proposals: 1 });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The tides here are [-very -]strong.",
      "The moon is really bright tonight.",
      "Harbours are quite busy in spring.",
    ]);
    expect(places.at(-1)).toBeNull();
  });

  // protects=quitting while the model writes stops the request without writing more as storage closes; fails_when=the request throws, or writes after the core has closed; no_claim=what the next start shows, which is what was stored.
  test("quitting while it writes stops it, and nothing more is written", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const blocks = tidesNote();
    writeMind(client, blocks);
    await client.settled();

    const editing = core.editWithAi(
      across(
        client,
        mind.id,
        blocks.map((block) => block.attrs.id),
        "shorten",
      ),
    );
    await controlled.requested();
    controlled.push("The tides here are strong.\n\nThe moon is bright tonight.\n\nHarbours");
    await vi.waitFor(() => expect(pendingProposals(client.blocks)).toHaveLength(2));
    core.close();

    expect(await editing).toEqual({ kind: "cancelled" });
  });

  // protects=Stop writes a paragraph held for its place as a new Block where the text had got to, and removes none of the selection's, a heading the model never reached included; fails_when=Stop proposes deleting a heading, or writes the held paragraph over the paragraph after it; no_claim=what a later paragraph would have been.
  test("Stop with a paragraph held writes it as a new Block, and removes nothing the model never reached", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const first = paragraph(text("Spring tides are strong at new moon."));
    const heading: JSONContent & { attrs: { id: string } } = {
      type: "heading",
      attrs: { id: `block-${++ids}`, level: 2 },
      content: [text("Harbours")],
    };
    const last = paragraph(text("Harbours publish the times of high water every year."));
    writeMind(client, [first, heading, last]);
    await client.settled();

    const input = across(
      client,
      mind.id,
      [first.attrs.id, heading.attrs.id, last.attrs.id],
      "instruction",
      "Add an opening line about the coast road",
    );
    const editing = core.editWithAi(input);
    await controlled.requested();
    // The first paragraph is kept, much changed; the second is like none of the selection's, so it is held.
    controlled.push(
      "Spring tides are strong at new moon and at full moon.\n\nA new opening line about the coast road.\n\n## Harb",
    );
    await vi.waitFor(() => expect(pendingProposals(client.blocks).length).toBeGreaterThan(0));
    await core.cancelEdit(input.requestId);
    await editing;
    await client.settled();

    const shown = shownWithChanges(client);
    expect(shown[0]).toContain("{+");
    expect(shown.slice(1)).toEqual([
      "+ A new opening line about the coast road.",
      "Harbours",
      "Harbours publish the times of high water every year.",
    ]);
  });

  // protects=a reply that rewrites every paragraph (a translation) still comes in paragraph by paragraph, each paired with the one it translates; fails_when=nothing shows until the end, or a paragraph is added beside the one it translates; no_claim=languages the word comparison can't tell apart.
  test("a translation comes in paragraph by paragraph, each in place of the one it translates", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const blocks = tidesNote();
    writeMind(client, blocks);
    await client.settled();

    const editing = core.editWithAi(
      across(
        client,
        mind.id,
        blocks.map((block) => block.attrs.id),
        "translate",
        "French",
      ),
    );
    await controlled.requested();
    controlled.push("Les marées sont fortes ici.\n\nLa lune brille ce soir.\n\nLes ports");
    await vi.waitFor(() =>
      expect(shownWithChanges(client)).toEqual([
        "[-The tides here are very strong.-]{+Les marées sont fortes ici.+}",
        "[-The moon is really bright tonight.-]{+La lune brille ce soir.+}",
        "Harbours are quite busy in spring.",
      ]),
    );
    controlled.push(" sont animés au printemps.");
    controlled.finish();
    await editing;
    await client.settled();
    expect(shownWithChanges(client)).toHaveLength(3);
    expect(shownWithChanges(client)[2]).toBe(
      "[-Harbours are quite busy in spring.-]{+Les ports sont animés au printemps.+}",
    );
  });

  // protects=a model that fails partway leaves the Mind as it was, so the request can be tried again; fails_when=half a change stays behind with the failure; no_claim=which providers fail this way.
  test("a model that fails partway takes back what it wrote, and says why", async () => {
    type Part =
      Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<
        infer Each
      >
        ? Each
        : never;
    const parts: Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "edit" },
      { type: "text-delta", id: "edit", delta: "The tides here are strong.\n\nThe moon" },
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        let sent = 0;
        return {
          stream: new ReadableStream({
            pull(controller) {
              const part = parts[sent++];
              if (part) controller.enqueue(part);
              else
                controller.error(
                  new APICallError({
                    message: "Overloaded",
                    url: "http://127.0.0.1:11434/v1/chat/completions",
                    requestBodyValues: {},
                    statusCode: 529,
                    isRetryable: false,
                  }),
                );
            },
          }),
        };
      },
    });
    const { core, mind, client } = await setUp(model);
    const blocks = tidesNote();
    writeMind(client, blocks);
    await client.settled();

    const result = await core.editWithAi(
      across(
        client,
        mind.id,
        blocks.map((block) => block.attrs.id),
        "shorten",
      ),
    );

    expect(result).toMatchObject({ kind: "failed" });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The tides here are very strong.",
      "The moon is really bright tonight.",
      "Harbours are quite busy in spring.",
    ]);
  });
});

function structure(client: MindClient): string[] {
  const lines: string[] = [];
  readMind(client).descendants((node, _position, parent) => {
    if (!node.isTextblock) return true;
    const list = parent?.type.name === "listItem" ? readMindParentOf(client, node) : null;
    const kind =
      node.type.name === "heading"
        ? `h${node.attrs.level}`
        : list === "bulletList"
          ? "•"
          : list === "orderedList"
            ? "1."
            : "p";
    let line = "";
    node.forEach((child) => {
      line += child.isText ? (child.text ?? "") : `⟨${child.attrs.check ?? child.type.name}⟩`;
    });
    lines.push(`${kind} ${line}`);
    return false;
  });
  return lines;
}

/** The kind of list a list item's paragraph is in. */
function readMindParentOf(
  client: MindClient,
  paragraph: ReturnType<typeof readMind>,
): string | null {
  let found: string | null = null;
  readMind(client).descendants((node) => {
    if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return true;
    node.descendants((inner) => {
      if (inner === paragraph || inner.eq(paragraph)) found = node.type.name;
    });
    return false;
  });
  return found;
}

describe("Edit with AI over Blocks of several kinds", () => {
  const heading = (value: string): JSONContent => ({
    type: "heading",
    attrs: { id: `block-${++ids}`, level: 2 },
    content: [text(value)],
  });
  const list = (type: "bulletList" | "orderedList", ...items: JSONContent[][]): JSONContent => ({
    type,
    content: items.map((content) => ({ type: "listItem", content: [paragraph(...content)] })),
  });
  /** Findings with a cited bullet, decisions as numbered items, and a closing paragraph. */
  const mixed = (tides: Document): JSONContent[] => [
    heading("Findings"),
    list(
      "bulletList",
      [text("Spring tides are strongest at new moon. "), citation(tides)],
      [text("Neap tides are weakest.")],
    ),
    heading("Decisions"),
    list(
      "orderedList",
      [text("Publish the tide tables in March.")],
      [text("Check the harbour gauges weekly.")],
    ),
    paragraph(text("Harbours publish the times of high water every year.")),
  ];
  const whole = (client: MindClient, mindId: string): EditWithAiInput => {
    const blocks: { id: string; size: number }[] = [];
    readMind(client).descendants((node) => {
      if (!node.isTextblock) return true;
      blocks.push({ id: String(node.attrs.id), size: node.content.size });
      return false;
    });
    const first = blocks[0] as { id: string };
    const last = blocks.at(-1) as { id: string; size: number };
    return {
      requestId: `edit-${++ids}`,
      mindId,
      from: { blockId: first.id, offset: 0 },
      to: { blockId: last.id, offset: last.size },
      text: blocks.map((block) => plainOf(client, block.id)).join("\n"),
      action: "instruction",
      instruction: "Restructure so the decisions come first. Cut the last paragraph.",
    };
  };
  const BEFORE = [
    "h2 Findings",
    "• Spring tides are strongest at new moon. ⟨found⟩",
    "• Neap tides are weakest.",
    "h2 Decisions",
    "1. Publish the tide tables in March.",
    "1. Check the harbour gauges weekly.",
    "p Harbours publish the times of high water every year.",
  ];
  const RESTRUCTURED = [
    "h2 Decisions",
    "1. Publish the tide tables in March.",
    "1. Check the harbour gauges weekly.",
    "h2 Findings",
    "• Spring tides are strongest at new moon. ⟨found⟩",
    "• Neap tides are weakest.",
  ];

  test("the model reads each Block's kind by its mark, and a restructure keeps headings, lists and Citations; Accept all is one step of Undo (#703)", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client, tides } = await setUp(
      editingModel(
        () =>
          [
            "## Decisions",
            "1. Publish the tide tables in March.",
            "1. Check the harbour gauges weekly.",
            "## Findings",
            "- Spring tides are strongest at new moon. [1]",
            "- Neap tides are weakest.",
          ].join("\n\n"),
        calls,
      ),
    );
    writeMind(client, mixed(tides));
    await client.settled();
    expect(structure(client)).toEqual(BEFORE);

    await core.editWithAi(whole(client, mind.id));

    expect(calls[0]?.passage).toBe(
      [
        "## Findings",
        "- Spring tides are strongest at new moon. [1]",
        "- Neap tides are weakest.",
        "## Decisions",
        "1. Publish the tide tables in March.",
        "1. Check the harbour gauges weekly.",
        "Harbours publish the times of high water every year.",
      ].join("\n\n"),
    );
    const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
    await resolveChanges(client, "accept");
    expect(structure(client)).toEqual(RESTRUCTURED);
    const markdown = await exported(core, mind.id);
    expect(markdown).toContain("## Decisions\n\n1. Publish the tide tables in March.");
    expect(markdown).toContain("## Findings\n\n- Spring tides are strongest at new moon.");

    undo.undo();
    await client.settled();
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
    await resolveChanges(client, "reject");
    expect(structure(client)).toEqual(BEFORE);
  });

  test("a reply without marks pairs paragraphs by their words, not their place: none is written into a heading, and moved ones keep their kind", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() =>
        [
          "Decisions",
          "Publish the tide tables in March.",
          "Check the harbour gauges weekly.",
          "Findings",
          "Spring tides are strongest at new moon. [1]",
          "Neap tides are weakest.",
        ].join("\n\n"),
      ),
    );
    writeMind(client, mixed(tides));
    await client.settled();

    await core.editWithAi(whole(client, mind.id));
    await resolveChanges(client, "accept");

    expect(structure(client)).toEqual(RESTRUCTURED);
  });

  test("a line that starts with a mark is a paragraph of its own, even after a single line break", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() =>
        [
          "## Decisions",
          "1. Publish the tide tables in March.",
          "1. Check the harbour gauges weekly.",
          "## Findings",
          "- Spring tides are strongest at new moon. [1]",
          "- Neap tides are weakest.",
        ].join("\n"),
      ),
    );
    writeMind(client, mixed(tides));
    await client.settled();

    await core.editWithAi(whole(client, mind.id));
    await resolveChanges(client, "accept");

    expect(structure(client)).toEqual(RESTRUCTURED);
  });

  // protects=a section the model adds in the middle, streamed in, is added as new Blocks before the heading it comes before, which stays as it was; fails_when=the new heading is written over the next one as a word change; no_claim=a section added at the very start.
  test("a section added in the middle comes in as new Blocks, and the section after it stays as it was", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() =>
        [
          "## Findings",
          "Spring tides are strongest at new moon.",
          "## Risks",
          "Gauges may fail in storms.",
          "## Decisions",
          "Publish the tide tables in March.",
        ].join("\n\n"),
      ),
    );
    writeMind(client, [
      heading("Findings"),
      paragraph(text("Spring tides are strongest at new moon.")),
      heading("Decisions"),
      paragraph(text("Publish the tide tables in March.")),
    ]);
    await client.settled();

    await core.editWithAi(whole(client, mind.id));

    expect(shownWithChanges(client)).toEqual([
      "Findings",
      "Spring tides are strongest at new moon.",
      "+ Risks",
      "+ Gauges may fail in storms.",
      "Decisions",
      "Publish the tide tables in March.",
    ]);
  });

  test("a Block the model marks as another kind becomes that kind", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() =>
        ["## Tides", "- Harbours publish the times of high water every year."].join("\n\n"),
      ),
    );
    writeMind(client, [
      heading("Tides"),
      paragraph(text("Harbours publish the times of high water every year.")),
    ]);
    await client.settled();

    await core.editWithAi(whole(client, mind.id));
    await resolveChanges(client, "accept");

    expect(structure(client)).toEqual([
      "h2 Tides",
      "• Harbours publish the times of high water every year.",
    ]);
  });

  test("text typed like a mark is shown escaped, and a restructure that leaves it alone keeps it plain text with its mark", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(
        () =>
          [
            "## Next",
            "- Hire a roaster.",
            "## Plan",
            "\\1. Background",
            "\\• Revenue grew",
            "Steps:\n\\- check the gauges",
          ].join("\n\n"),
        calls,
      ),
    );
    writeMind(client, [
      heading("Plan"),
      paragraph(text("1. Background")),
      paragraph(text("• Revenue grew")),
      paragraph(text("Steps:"), { type: "hardBreak" }, text("- check the gauges")),
      heading("Next"),
      list("bulletList", [text("Hire a roaster.")]),
    ]);
    await client.settled();

    await core.editWithAi(whole(client, mind.id));
    await resolveChanges(client, "accept");

    expect(calls[0]?.passage).toBe(
      [
        "## Plan",
        "\\1. Background",
        "\\• Revenue grew",
        "Steps:\n\\- check the gauges",
        "## Next",
        "- Hire a roaster.",
      ].join("\n\n"),
    );
    expect(structure(client)).toEqual([
      "h2 Next",
      "• Hire a roaster.",
      "h2 Plan",
      "p 1. Background",
      "p • Revenue grew",
      "p Steps:⟨hardBreak⟩- check the gauges",
    ]);
  });

  // protects=a list made into a table becomes a table Block where the list was, out of it, its cell keeping the item's Citation: asking for a table replaces the text it is made from (#961); fails_when=the table is pipe text or lands in the list, the Citation is lost, or the list is kept as left out; no_claim=how a real model lays out a table.
  test("a list made into a table becomes a table, out of the list, its Citation in its cell", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() =>
        [
          "| Tide | When |",
          "|:--|--:|",
          "| Spring | At new moon [1] |",
          "| Neap | Weakest \\| smallest |",
        ].join("\n"),
      ),
    );
    writeMind(client, [
      list(
        "bulletList",
        [text("Spring tides are strongest at new moon. "), citation(tides)],
        [text("Neap tides are weakest.")],
      ),
    ]);
    await client.settled();

    const result = await core.editWithAi({
      ...whole(client, mind.id),
      instruction: "Make it a table",
    });

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("leftOut");
    await resolveChanges(client, "accept");
    expect(
      readMind(client)
        .toJSON()
        .content?.map((block: JSONContent) => block.type),
    ).toEqual(["table"]);
    expect(await exported(core, mind.id)).toContain(
      "| Tide | When |\n| :--- | ---: |\n| Spring | At new moon[^1] |\n| Neap | Weakest \\| smallest |",
    );
    expect(structure(client)).toEqual([
      "p Tide",
      "p When",
      "p Spring",
      "p At new moon ⟨found⟩",
      "p Neap",
      "p Weakest | smallest",
    ]);
  });

  // protects=a table written without leading pipes, streamed in a few characters at a time, keeps every row: it isn't written while its next row may still be coming (#961); fails_when=it goes in with only the rows that had arrived when a row's first word did; no_claim=none beyond protects.
  test("a streamed table without leading pipes keeps all its rows", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() =>
        [
          "Spring tides are strong.",
          "",
          "Tide | When",
          "--- | ---",
          "Spring | New moon",
          "Neap | Quarter moon",
          "Bore | Rarely",
          "",
          "That is all.",
        ].join("\n"),
      ),
    );
    const note = paragraph(text("Spring tides are strong."));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Add a table"),
    );
    await resolveChanges(client, "accept");

    expect(await exported(core, mind.id)).toContain(
      "| Tide | When |\n| --- | --- |\n| Spring | New moon |\n| Neap | Quarter moon |\n| Bore | Rarely |",
    );
  });

  // protects=pipe lines that make no table (no row of --- under the first) are written nowhere, and the request says why (#961); fails_when=they land in the Mind as a paragraph of pipes; no_claim=none beyond protects.
  test("pipe lines that make no table change nothing, and say so", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "| Tide | When |\n| Spring | At new moon |"),
    );
    const note = paragraph(text("Spring tides are strongest at new moon."));
    writeMind(client, [note]);
    await client.settled();
    const before = JSON.stringify(client.blocks.toJSON());

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Make it a table"),
    );

    expect(result).toEqual({ kind: "no-table", text: "| Tide | When |\n| Spring | At new moon |" });
    await client.settled();
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
  });

  // protects=pipe lines the User's own text already holds don't stop a rewrite of it; fails_when=shortening a paragraph with a pipe line is refused as a broken table; no_claim=none beyond protects.
  test("pipe lines already in the User's text can still be rewritten", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replace("really ", "")),
    );
    const note = paragraph(
      text("| Draft | Owner |"),
      { type: "hardBreak" },
      text("The tides are really strong."),
    );
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));

    expect(result).toMatchObject({ kind: "proposed", proposals: 1 });
  });
});

describe("Changes out of date", () => {
  test("a paragraph edited while the model works keeps the User's edits, and the change to words they edited is out of date until it is made again", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(async ({ passage }) => {
        if (passage === "really") return "truly";
        await waiting;
        return "The tides are strong and truly regular.";
      }, calls),
    );
    const note = paragraph(text("The tides are very strong and realy regular."));
    writeMind(client, [note]);
    await client.settled();

    // The model is paused; meanwhile the User fixes a typo in words it is about to replace.
    const editing = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    await expect.poll(() => calls.length).toBe(1);
    const words = (client.blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    words.insert("The tides are very strong and rea".length, "l");
    await client.settled();
    release();

    expect(await editing).toMatchObject({ kind: "proposed", proposals: 2, outOfDate: 1 });
    // The fix stays; the change to the words fixed is out of date, the other isn't.
    expect(shownWithChanges(client)).toEqual([
      "The tides are [-very -]strong and [-really-]{+truly+} regular.",
    ]);
    const [fresh, stale] = pendingProposals(client.blocks).map((proposal) => proposal.id);
    expect([...outOfDateProposals(client.blocks)]).toEqual([stale]);
    // Neither counts until it is accepted: the Mind reads as the User has it.
    expect(await exported(core, mind.id)).toContain(
      "The tides are very strong and really regular.",
    );

    // Accepting all leaves the one out of date as it is: it can't be accepted.
    const accepted = await resolveChanges(client, "accept");
    expect(accepted.map((proposal) => proposal.id)).toEqual([fresh]);
    expect(shownWithChanges(client)).toEqual([
      "The tides are strong and [-really-]{+truly+} regular.",
    ]);

    // Regenerate makes it again, as it was asked, from the words as they are now.
    expect(
      await core.regenerateProposal({
        requestId: "again",
        mindId: mind.id,
        proposalId: stale ?? "",
      }),
    ).toMatchObject({ kind: "proposed", proposals: 1, outOfDate: 0 });
    expect(calls.at(-1)).toMatchObject({ passage: "really", action: "improve" });
    // A few words in a sentence: the model sees the words around them, to fit between and not repeat.
    expect(calls.at(-1)?.prompt).toContain(
      "<before>\nThe tides are strong and\n</before>\n\n<passage>\nreally\n</passage>\n\n<after>\nregular.\n</after>",
    );
    expect(calls.at(-1)?.system).toContain(
      "The new text must fit between the words before and after it. Never repeat those words in it.",
    );
    // A whole paragraph has no words around it.
    expect(calls[0]?.prompt).not.toContain("<before>");
    expect(calls[0]?.prompt).not.toContain("<after>");
    expect(shownWithChanges(client)).toEqual([
      "The tides are strong and [-really-]{+truly+} regular.",
    ]);
    expect(pendingProposals(client.blocks).map((proposal) => proposal.id)).not.toContain(stale);
    expect(outOfDateProposals(client.blocks).size).toBe(0);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual(["The tides are strong and truly regular."]);
  });

  test("a change out of date can be rejected; Regenerate keeps it when the model fails, and takes it away when there is nothing to change", async () => {
    let reply: (passage: string) => string = () => "The tides are strong.";
    const { core, mind, client } = await setUp(editingModel(({ passage }) => reply(passage)));
    const note = paragraph(text("The tides are very strong."));
    writeMind(client, [note]);
    await client.settled();
    const again = (proposalId: string) =>
      core.regenerateProposal({ requestId: `again-${++ids}`, mindId: mind.id, proposalId });

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    expect(shownWithChanges(client)).toEqual(["The tides are [-very -]strong."]);
    // The User changes the words the change removes.
    const words = (client.blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    words.insert("The tides are v".length, "e");
    await client.settled();
    const [stale] = pendingProposals(client.blocks).map((proposal) => proposal.id);
    expect([...outOfDateProposals(client.blocks)]).toEqual([stale]);

    // The model fails: the change stays as it was.
    reply = () => {
      throw new Error("The model is down.");
    };
    expect(await again(stale ?? "")).toMatchObject({ kind: "failed" });
    expect(shownWithChanges(client)).toEqual(["The tides are [-veery -]strong."]);

    // The model gives the words back as they are: there is no change to make, so it goes.
    reply = (passage) => passage;
    expect(await again(stale ?? "")).toEqual({ kind: "unchanged" });
    expect(shownWithChanges(client)).toEqual(["The tides are veery strong."]);
    expect(await again(stale ?? "")).toEqual({ kind: "changed" });

    // Rejecting one out of date works as for any change.
    reply = () => "The tides are strong.";
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    words.insert("The tides are v".length, "e");
    await client.settled();
    expect(outOfDateProposals(client.blocks).size).toBe(1);
    expect(await resolveChanges(client, "accept")).toEqual([]);
    expect(await resolveChanges(client, "reject")).toHaveLength(1);
    expect(shownWithChanges(client)).toEqual(["The tides are veeery strong."]);
  });

  test("a change goes out of date when the words it removes are edited, not when the User writes in what it adds or elsewhere", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "The tides are strong and truly regular. Moon."),
    );
    const note = paragraph(text("The tides are very strong and really regular. Moon."));
    writeMind(client, [note]);
    await client.settled();
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    expect(shownWithChanges(client)).toEqual([
      "The tides are [-very -]strong and [-really-]{+truly+} regular. Moon.",
    ]);
    const words = (client.blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;

    // Words written elsewhere in the paragraph, or in what a change adds, leave both as they are.
    words.insert(words.length, " Sun.");
    words.insert("The tides are very strong and reallytru".length, "u");
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The tides are [-very -]strong and [-really-]{+truuly+} regular. Moon. Sun.",
    ]);
    expect(outOfDateProposals(client.blocks).size).toBe(0);

    // Deleting some of the words a change removes puts it out of date.
    words.delete("The tides are ".length, "ve".length);
    await client.settled();
    const [first] = pendingProposals(client.blocks).map((proposal) => proposal.id);
    expect([...outOfDateProposals(client.blocks)]).toEqual([first]);
  });

  test("Proposals made before changes recorded their text are never out of date", async () => {
    const { core, mind, client } = await setUp(editingModel(() => "The tides are strong."));
    const note = paragraph(text("The tides are very strong."));
    writeMind(client, [note]);
    await client.settled();
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    // As version 4 wrote it: the change names its id and request only.
    const words = (client.blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const [change] = pendingProposals(client.blocks);
    const removed = "The tides are ".length;
    client.doc.transact(() => {
      words.format(removed, "very ".length, {
        proposalDelete: { id: change?.id, request: change?.request },
      });
    });
    words.insert(removed + 1, "e");
    await client.settled();
    expect(shownWithChanges(client)).toEqual(["The tides are [-veery -]strong."]);
    expect(outOfDateProposals(client.blocks).size).toBe(0);
    expect(await resolveChanges(client, "accept")).toHaveLength(1);
    expect(shownWithChanges(client)).toEqual(["The tides are strong."]);
  });

  test("deleting a Document a waiting change cites leaves the change, with its Citation, for the User", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() => "Spring tides come at new and full moon [1]."),
    );
    const note = paragraph(
      text("Spring tides happen at new moon and at full moon"),
      citation(tides),
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();
    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    const waiting = pendingProposals(client.blocks);
    expect(waiting.length).toBeGreaterThan(0);

    await core.deleteDocument(tides.id);
    await client.settled();

    // Nothing is dropped: the change and the Citation it keeps are still there, to show "Source removed".
    expect(pendingProposals(client.blocks)).toEqual(waiting);
    expect(shownWithChanges(client).join("")).toContain("⟨");
  });
});

describe("Edit with AI and the model's service", () => {
  test("a cloud model is asked only once the User allows the edits flow, never in local mode", async () => {
    const calls: EditCall[] = [];
    const model = editingModel(() => "A better paragraph.", calls);
    const dataDir = await createTempDataFolder();
    const models = scriptedModels(model);
    const core = startCore(dataDir, { createChatModel: models.createChatModel });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    const mind = await core.createMind({ title: "Cloud" });
    const client = await connectToMind(core, mind.id);
    const note = paragraph(text("A paragraph."));
    writeMind(client, [note]);
    await client.settled();

    // Declined: nothing is sent.
    const asked = nextEvent(core, "consent.requested");
    const declined = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    const request = (await asked) as ConsentRequest;
    expect(request.flow).toMatchObject({ id: "edits", sends: ["selection"] });
    await core.respondToConsent(request.requestId, false);
    expect(await declined).toMatchObject({
      kind: "not-ready",
      readiness: { reason: "consent-declined" },
    });
    expect(calls).toHaveLength(0);

    // Allowed: it is sent, with thinking off.
    await core.allowDataFlow("edits", request.flow.service.id);
    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toMatchObject({ kind: "proposed" });
    expect(calls).toHaveLength(1);
    expect(models.specs.at(-1)).toMatchObject({ kind: "openai", thinking: "off" });
    await resolveChanges(client, "reject");

    // Local mode: a cloud model isn't used.
    await core.setLocalOnly(true);
    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toEqual({ kind: "local-mode" });
    expect(calls).toHaveLength(1);
  });

  test("Local mode turned on while the edit waits for consent: the prompt closes, nothing is sent, and the edit says Local mode (#1120)", async () => {
    const calls: EditCall[] = [];
    const model = editingModel(() => "合成私密段落：已改写。", calls);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    const mind = await core.createMind({ title: "Private" });
    const client = await connectToMind(core, mind.id);
    const note = paragraph(text("合成私密段落：此文字不应离开本机。"));
    writeMind(client, [note]);
    await client.settled();

    const asked = nextEvent(core, "consent.requested");
    const editing = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    const request = (await asked) as ConsentRequest;
    const closed = nextEvent(core, "consent.resolved");
    await core.setLocalOnly(true);

    expect(await closed).toEqual({ requestId: request.requestId, accepted: false });
    expect(await core.listConsentRequests()).toEqual([]);
    // The old prompt, answered late, changes nothing.
    await core.respondToConsent(request.requestId, true);
    expect(await editing).toEqual({ kind: "local-mode" });
    expect(calls).toHaveLength(0);
    await client.settled();
    expect(shownWithChanges(client)).toEqual(["合成私密段落：此文字不应离开本机。"]);

    // Local mode off, the usual consent flow runs again.
    await core.setLocalOnly(false);
    const again = nextEvent(core, "consent.requested");
    const second = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    const prompt = (await again) as ConsentRequest;
    expect(prompt.flow).toMatchObject({ id: "edits" });
    await core.respondToConsent(prompt.requestId, true);
    expect(await second).toMatchObject({ kind: "proposed" });
    expect(calls).toHaveLength(1);
  });

  test("Local mode turned on while a rate-limited request waits to be tried again: nothing more is sent, and the edit says Local mode", async () => {
    const calls: EditCall[] = [];
    const model = editingModel((call) => {
      if (calls.length === 1) {
        throw new APICallError({
          message: "Rate limit reached.",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after-ms": "2000" },
          isRetryable: true,
        });
      }
      return call.passage;
    }, calls);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    const mind = await core.createMind({ title: "Private" });
    const client = await connectToMind(core, mind.id);
    const note = paragraph(text("合成私密段落：此文字不应离开本机。"));
    writeMind(client, [note]);
    await client.settled();

    const editing = core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await core.setLocalOnly(true);

    expect(await editing).toEqual({ kind: "local-mode" });
    expect(calls).toHaveLength(1);
  });

  test("with no chat model it says so, and nothing is written", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "No model" });
    const client = await connectToMind(core, mind.id);
    const note = paragraph(text("A paragraph."));
    writeMind(client, [note]);
    await client.settled();

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toEqual({ kind: "not-ready", readiness: { ready: false, reason: "no-provider" } });
    expect(shownWithChanges(client)).toEqual(["A paragraph."]);
  });
});

describe("An edit the User asked for (#880)", () => {
  const FIRST = "Tides rise twice a day along this coast.";
  const SECOND = "It's a big harbour and a lot of boats don't leave at low water.";
  const THIRD = "The harbour office posts the times each week.";
  const FORMAL = "It is a considerable harbour and a great many boats do not leave at low water.";

  /** A Mind of three paragraphs, all selected, and Edit with AI over them as the window asks. */
  async function threeParagraphs(edit: (call: EditCall) => string) {
    const set = await setUp(editingModel(edit));
    const blocks = [FIRST, SECOND, THIRD].map((words) => paragraph(text(words)));
    writeMind(set.client, blocks);
    await set.client.settled();
    const asked = (instruction: string): EditWithAiInput => ({
      requestId: `asked-${++ids}`,
      mindId: set.mind.id,
      from: { blockId: blocks[0]?.attrs.id ?? "", offset: 0 },
      to: { blockId: blocks[2]?.attrs.id ?? "", offset: THIRD.length },
      text: [FIRST, SECOND, THIRD].join("\n"),
      action: "instruction",
      instruction,
    });
    return { ...set, blocks, asked };
  }

  test("names its updates, for the window that asked to take them in, and saves a Checkpoint before writing", async () => {
    const { core, mind, asked } = await threeParagraphs(({ passage }) =>
      passage.replace("big", "large"),
    );
    const causes: (EditCause | undefined)[] = [];
    const stop = core.on("mind.update", (event) => {
      if (event.mindId === mind.id) causes.push(event.cause);
    });
    const input = asked("Use a better word for big");

    const result = await core.editWithAi(input);
    stop();

    expect(result).toMatchObject({ kind: "proposed", proposals: 1 });
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("leftOut");
    const request = result.kind === "proposed" ? result.request : "";
    const named = causes.filter((cause) => cause !== undefined);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((cause) => cause.requestId === input.requestId)).toBe(true);
    expect(named.every((cause) => cause.request === request && cause.apply)).toBe(true);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([
      expect.objectContaining({ reason: "accept" }),
    ]);
  });

  test('whole note selected, "make the second paragraph more formal": the model\'s only paragraph changes the second, and the two it left out are kept, named for the window', async () => {
    const { core, client, blocks, asked } = await threeParagraphs(() => FORMAL);

    const result = await core.editWithAi(
      asked("make the second paragraph more formal; leave the others as they are"),
    );

    expect(result).toMatchObject({
      kind: "proposed",
      leftOut: [
        { blockId: blocks[0]?.attrs.id, from: 0, to: FIRST.length, whole: true, kind: "paragraph" },
        { blockId: blocks[2]?.attrs.id, from: 0, to: THIRD.length, whole: true, kind: "paragraph" },
      ],
    });
    expect(result).not.toHaveProperty("held");
    const shown = shownWithChanges(client);
    expect(shown[0]).toBe(FIRST);
    expect(shown[1]).toContain("{+");
    expect(shown[2]).toBe(THIRD);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([FIRST, FORMAL, THIRD]);
  });

  test("what it leaves out of a selection that starts and ends inside paragraphs is kept as those parts, and a heading left out is named as one", async () => {
    const { core, mind, client } = await setUp(editingModel(() => FORMAL));
    const heading: JSONContent & { attrs: { id: string } } = {
      type: "heading",
      attrs: { id: `block-${++ids}`, level: 2 },
      content: [text("Harbours")],
    };
    const blocks = [
      paragraph(text(FIRST)),
      heading,
      paragraph(text(SECOND)),
      paragraph(text(THIRD)),
    ];
    writeMind(client, blocks);
    await client.settled();
    const start = "Tides rise ".length;
    const end = "The harbour office".length;

    const result = await core.editWithAi({
      requestId: `asked-${++ids}`,
      mindId: mind.id,
      from: { blockId: blocks[0]?.attrs.id ?? "", offset: start },
      to: { blockId: blocks[3]?.attrs.id ?? "", offset: end },
      text: [FIRST.slice(start), "Harbours", SECOND, THIRD.slice(0, end)].join("\n"),
      action: "instruction",
      instruction: "make the second paragraph more formal",
    });

    expect(result).toMatchObject({
      kind: "proposed",
      leftOut: [
        { blockId: blocks[0]?.attrs.id, from: start, to: FIRST.length, whole: false },
        {
          blockId: heading.attrs.id,
          from: 0,
          to: "Harbours".length,
          whole: true,
          kind: "heading:2",
        },
        { blockId: blocks[3]?.attrs.id, from: 0, to: end, whole: false },
      ],
    });
    expect(result).not.toHaveProperty("held");
    expect(shownWithChanges(client)).toEqual([
      FIRST,
      "Harbours",
      expect.stringContaining("{+"),
      THIRD,
    ]);
  });

  test("in Chinese, a paragraph rewritten between two kept as they were changes that paragraph, not its neighbour", async () => {
    const lines = [
      "我们周二和港务局开会，讨论新的潮位计。",
      "说实话旧的潮位计挺乱的，老是坏，大家都不太信那些数了。",
      "港务局下个月会就预算投票。",
    ];
    const formal = "现有潮位计运行状况不稳定，故障频发，各方对其采集数据的可靠性普遍存疑。";
    const { core, mind, client } = await setUp(
      editingModel(() => [lines[0], formal, lines[2]].join("\n\n")),
    );
    const blocks = lines.map((line) => paragraph(text(line)));
    writeMind(client, blocks);
    await client.settled();

    const result = await core.editWithAi({
      requestId: `asked-${++ids}`,
      mindId: mind.id,
      from: { blockId: blocks[0]?.attrs.id ?? "", offset: 0 },
      to: { blockId: blocks[2]?.attrs.id ?? "", offset: lines[2]?.length ?? 0 },
      text: lines.join("\n"),
      action: "instruction",
      instruction: "把第二段改得更正式，其他段落保持不变",
    });

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("leftOut");
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([lines[0], formal, lines[2]]);
  });

  test('an explicit "delete…" takes out what the new text leaves out, and applies', async () => {
    const { core, client, asked } = await threeParagraphs(() => [FIRST, THIRD].join("\n\n"));

    const result = await core.editWithAi(asked("delete the second paragraph"));

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("leftOut");
    expect(shownWithChanges(client)).toEqual([FIRST, `- ${SECOND}`, THIRD]);
  });

  test("new text like none of the selection's, which would remove most of it, is held for the User, all of it as changes", async () => {
    const { core, client, asked } = await threeParagraphs(
      () => "Gulls wheel, crying\n\nsalt wind on stone\n\nnight falls soft",
    );

    const result = await core.editWithAi(asked("replace it all with a haiku"));

    expect(result).toMatchObject({ kind: "proposed", held: true });
    expect(result).not.toHaveProperty("leftOut");
    const shown = shownWithChanges(client);
    expect(shown.filter((line) => line.startsWith("- "))).toHaveLength(0);
    expect(shown.join("\n")).toContain(`[-${FIRST}-]`);
    expect(shown.join("\n")).toContain(`[-${THIRD}-]`);
  });

  test("a translation is mapped by its order and never held, however much it changes", async () => {
    const { core, asked } = await threeParagraphs(({ passage }) => passage.toUpperCase());

    const result = await core.editWithAi({
      ...asked(""),
      action: "translate",
      instruction: "French",
    });

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
  });

  test("accepted as the window applies it, its new words are AI text recorded as an edit accepted, as when the User accepted it as a change", async () => {
    const { core, mind, client, blocks, asked } = await threeParagraphs(() => FORMAL);
    const result = await core.editWithAi(asked("make the second paragraph more formal"));
    const request = result.kind === "proposed" ? result.request : "";

    let accepted: ReturnType<typeof resolveProposals> = [];
    client.doc.transact(() => {
      accepted = resolveProposals(client.blocks, (ref) => ref.request === request, "accept");
    });
    await client.settled();
    await core.recordAiUse(
      aiUseOfAccepted(client.doc, mind.id, accepted, "2026-10-15T09:00:00.000Z"),
    );

    const added = readMind(client)
      .child(1)
      .content.content.filter((node) => node.marks.some((mark) => mark.type.name === "generated"))
      .map((node) => node.text ?? "")
      .join("");
    expect(added.length).toBeGreaterThan(0);
    const recorded = await core.listAiUse(mind.id);
    expect(recorded.length).toBeGreaterThan(0);
    for (const entry of recorded) {
      expect(entry).toMatchObject({
        kind: "edit-with-ai-accepted",
        outcome: "kept",
        modelId: "local-model",
        blockIds: [blocks[1]?.attrs.id],
      });
    }
    expect(recorded.reduce((sum, entry) => sum + entry.characters, 0)).toBe(added.length);
  });

  test("Regenerate on a change isn't an edit the User asked for: its updates aren't named", async () => {
    const { core, mind, client } = await setUp(editingModel(() => "The tides are strong."));
    const note = paragraph(text("The tides are very strong."));
    writeMind(client, [note]);
    await client.settled();
    const asked = await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
    expect(asked).toMatchObject({ kind: "proposed" });
    const [first] = pendingProposals(client.blocks);
    const causes: (EditCause | undefined)[] = [];
    const stop = core.on("mind.update", (event) => causes.push(event.cause));

    await core.regenerateProposal({
      requestId: "again",
      mindId: mind.id,
      proposalId: first?.id ?? "",
    });
    stop();

    expect(causes.every((cause) => cause === undefined)).toBe(true);
  });
});

describe("How a change reads (#1028)", () => {
  const heading = (value: string): JSONContent => ({
    type: "heading",
    attrs: { id: `block-${++ids}`, level: 2 },
    content: [text(value)],
  });
  const bullets = (...items: string[]): JSONContent => ({
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(text(item))] })),
  });

  /** As `shownWithChanges` shows them, a paragraph added or removed whole marked by a Block around it too. */
  const shownWhole = (client: MindClient): string[] => {
    const lines: string[] = [];
    const visit = (node: ReturnType<typeof readMind>, whole: string | null) => {
      const kind = (node.attrs?.[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind ?? whole;
      if (!node.isTextblock) {
        node.forEach((child) => {
          visit(child, kind);
        });
        return;
      }
      let line = "";
      node.forEach((child) => {
        const marks = child.marks.map((mark) => mark.type.name);
        const words = child.text ?? "￼";
        line += marks.includes("proposalDelete")
          ? `[-${words}-]`
          : marks.includes("proposalInsert")
            ? `{+${words}+}`
            : words;
      });
      lines.push(`${kind === "insert" ? "+ " : kind === "delete" ? "- " : ""}${line}`);
    };
    visit(readMind(client), null);
    return lines.map((line) => line.replace(/-\]\[-|\+\}\{\+/g, ""));
  };

  /** The whole Mind, asked to change as `instruction` says. */
  const everything = (client: MindClient, mindId: string, instruction: string) => {
    const blocks: { id: string; size: number }[] = [];
    readMind(client).descendants((node) => {
      if (!node.isTextblock) return true;
      blocks.push({ id: String(node.attrs.id), size: node.content.size });
      return false;
    });
    const first = blocks[0] as { id: string };
    const last = blocks.at(-1) as { id: string; size: number };
    return {
      requestId: `edit-${++ids}`,
      mindId,
      from: { blockId: first.id, offset: 0 },
      to: { blockId: last.id, offset: last.size },
      text: blocks.map((block) => plainOf(client, block.id)).join("\n"),
      action: "instruction" as const,
      instruction,
    };
  };

  test("a word replaced reads word by word; a paragraph 40% or more of whose words change reads whole, before and after, never interleaved", async () => {
    const before = [
      "The tides here are strong and regular.",
      "Spring tides happen at new moon and at full moon every month.",
    ];
    const after = [
      "The tides here are strong and predictable.",
      "Twice a month the Sun and the Moon pull together.",
    ];
    const { core, mind, client } = await setUp(editingModel(() => after.join("\n\n")));
    writeMind(
      client,
      before.map((line) => paragraph(text(line))),
    );
    await client.settled();

    await core.editWithAi(everything(client, mind.id, "Make it clearer"));
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "The tides here are strong and [-regular-]{+predictable+}.",
      `[-${before[1]}-]{+${after[1]}+}`,
    ]);
  });

  test("a heading changed at all reads whole", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "## Key strengths\n\nSpring tides are strongest at new moon."),
    );
    writeMind(client, [
      heading("Highlights and points to check"),
      paragraph(text("Spring tides are strongest at new moon.")),
    ]);
    await client.settled();

    await core.editWithAi(everything(client, mind.id, "Rename the heading"));
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "[-Highlights and points to check-]{+Key strengths+}",
      "Spring tides are strongest at new moon.",
    ]);
  });

  test("a list item replaced by one about something else is removed and the new one added: the degree never turns into the job", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() =>
        [
          "## 经历",
          "- 2014.09—2018.06 上海财经大学 会计学 学士",
          "- 2021.04—至今 某证券公司研究所 食品饮料行业研究员",
        ].join("\n\n"),
      ),
    );
    writeMind(client, [
      heading("经历"),
      bullets("2014.09—2018.06 上海财经大学 会计学 学士", "2018.09—2020.06 复旦大学 金融学 硕士"),
    ]);
    await client.settled();

    await core.editWithAi(everything(client, mind.id, "删掉硕士那一条，换成现在的工作"));
    await client.settled();

    expect(shownWhole(client)).toEqual([
      "经历",
      "2014.09—2018.06 上海财经大学 会计学 学士",
      "+ 2021.04—至今 某证券公司研究所 食品饮料行业研究员",
      "- 2018.09—2020.06 复旦大学 金融学 硕士",
    ]);
  });

  test("asked to replace a list item, without saying to remove it, the old item goes and the new one comes: neither is kept as left out, nor read as a translation", async () => {
    const degree = "2016.09—2018.06 上海财经大学 会计学 硕士";
    const job = "2018.10—至今 Deloitte Touche Tohmatsu, Senior Manager";
    const { core, mind, client } = await setUp(
      editingModel(() =>
        ["## 经历", "- 2012.09—2016.06 复旦大学 金融学 学士", `- ${job}`].join("\n\n"),
      ),
    );
    writeMind(client, [heading("经历"), bullets("2012.09—2016.06 复旦大学 金融学 学士", degree)]);
    await client.settled();

    const result = await core.editWithAi(everything(client, mind.id, "把硕士那条换成现在的工作"));
    await client.settled();

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("leftOut");
    expect(shownWhole(client)).toEqual([
      "经历",
      "2012.09—2016.06 复旦大学 金融学 学士",
      `+ ${job}`,
      `- ${degree}`,
    ]);
    await resolveChanges(client, "accept");
    expect(shownWhole(client)).toEqual(["经历", "2012.09—2016.06 复旦大学 金融学 学士", job]);
  });

  test("list items reworded past matching, in Chinese and English, each go once and their new wording comes once: none is doubled", async () => {
    const before = [
      "熟悉财务建模与估值，曾主导三个并购项目的尽职调查。",
      "Led quarterly forecasting for a team of twelve analysts.",
      "Presented findings to the board every month.",
      "Cut month-end close from ten days to six.",
    ];
    const after = [
      "主导过三起并购尽调，独立搭建估值模型。",
      "Ran the quarterly forecast with twelve analysts reporting to me.",
      "Briefed the board monthly on results.",
      "Shortened the monthly close by four days.",
    ];
    const { core, mind, client } = await setUp(
      editingModel(() => after.map((item) => `- ${item}`).join("\n\n")),
    );
    writeMind(client, [bullets(...before)]);
    await client.settled();

    const result = await core.editWithAi(everything(client, mind.id, "把这些要点写得更有力"));
    await client.settled();

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("leftOut");
    await resolveChanges(client, "accept");
    expect(shownWhole(client)).toEqual(after);
  });

  test("in Chinese, a date range changed is one change, and a paragraph mostly rewritten reads whole, no old and new words alternating", async () => {
    const before = [
      "2017.05—2017.04 某咨询公司 分析师",
      "张瑜的主要优势是跨医疗、金融两个行业的数据分析经验，熟悉财务建模。",
    ];
    const after = [
      "2017.05—2018.09 某咨询公司 分析师",
      "十年咨询与审计项目经验，擅长跨部门沟通与团队管理，熟悉财务建模。",
    ];
    const { core, mind, client } = await setUp(editingModel(() => after.join("\n\n")));
    writeMind(
      client,
      before.map((line) => paragraph(text(line))),
    );
    await client.settled();

    await core.editWithAi(everything(client, mind.id, "把日期改对，第二段重写"));
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "[-2017.05—2017.04-]{+2017.05—2018.09+} 某咨询公司 分析师",
      `[-${before[1]}-]{+${after[1]}+}`,
    ]);
  });
});
