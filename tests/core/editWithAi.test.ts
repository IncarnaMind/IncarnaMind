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
import { withoutNames } from "../../src/core/edits/prompt";
import { translate } from "../../src/shared/i18n";
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

/**
 * A model that rewrites each passage with `edit`, streamed a few characters at a time; automatic
 * tagging gets no Tags. `finished: "length"`: each reply ends at its output limit, cut off.
 */
function editingModel(
  edit: (call: EditCall) => string | Promise<string>,
  calls: EditCall[] = [],
  { finished = "stop", chunkSize = 4 }: { finished?: "stop" | "length"; chunkSize?: number } = {},
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
      return { stream: streamedReply(await edit(call), abortSignal, { finished, chunkSize }) };
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

/** The ids of the Mind's Citations, in order. */
function citationIdsOf(client: MindClient): unknown[] {
  const ids: unknown[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "citation") ids.push(node.attrs.id);
  });
  return ids;
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

/** Edit with AI over all of the Mind's text, in the User's own words. */
function wholeMind(client: MindClient, mindId: string, instruction: string): EditWithAiInput {
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
    instruction,
  };
}

const headingOf = (words: string): JSONContent & { attrs: { id: string } } => ({
  type: "heading",
  attrs: { id: `block-${++ids}`, level: 2 },
  content: [text(words)],
});

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

  // protects=a rewrite that moves a marked Citation, or deletes the sentence it is in, keeps the Citation's id: accepted, the moved Citation is the one the mark names; rejected, the Citation stays as it was; and one the accepted deletion took out comes back marked from a version kept before (#1933), in English and Chinese; fails_when=the Citation the rewrite writes, or the restored one, has another id; no_claim=how the model words the rewrite.
  test.each([
    {
      language: "en",
      before: "Spring tides happen at new moon and at full moon ",
      moved: "[1] Spring tides come at new and full moon.",
      without: "Tides vary.",
    },
    {
      language: "zh-CN",
      before: "大潮出现在新月和满月前后",
      moved: "[1] 大潮在新月和满月时出现。",
      without: "潮汐有变化。",
    },
  ])(
    "the assistant's rewrite and deletion keep a marked Citation's id ($language)",
    async ({ before, moved, without }) => {
      let reply = moved;
      const { core, mind, client, tides } = await setUp(editingModel(() => reply));
      const marked = citation(tides);
      marked.attrs = { ...marked.attrs, id: "marked-citation" };
      const note = paragraph(text(before), marked, text("."));
      const idsNow = () => citationIdsOf(client);

      for (const outcome of ["reject", "accept"] as const) {
        writeMind(client, [note]);
        await client.settled();
        await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
        await resolveChanges(client, outcome);
        expect(idsNow()).toEqual(["marked-citation"]);
      }

      writeMind(client, [note]);
      await client.settled();
      const kept = await core.saveCheckpoint(mind.id, "accept");
      reply = without;
      await core.editWithAi(
        wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Delete it"),
      );
      await resolveChanges(client, "accept");
      expect(idsNow()).toEqual([]);
      await core.restoreCheckpoint(mind.id, kept.id);
      await client.settled();
      expect(idsNow()).toEqual(["marked-citation"]);
    },
  );

  // protects=a rewrite that cites a marked Citation twice writes one Citation that is it and one copy with an id of its own, so the mark stays on one (#1933), in English and Chinese, streamed or not; fails_when=the two share the id, or neither has it; no_claim=where the model puts the markers.
  test.each([
    {
      language: "en",
      before: "Spring tides happen at new moon and at full moon ",
      twice: "[1] Spring tides occur at new and full moon [1].",
    },
    {
      language: "zh-CN",
      before: "大潮出现在新月和满月前后",
      twice: "[1] 大潮在新月和满月时出现 [1]。",
    },
  ])(
    "a rewrite that cites a marked Citation twice writes it once and a copy ($language)",
    async ({ before, twice }) => {
      const { core, mind, client, tides } = await setUp(editingModel(() => twice));
      const marked = citation(tides);
      marked.attrs = { ...marked.attrs, id: "marked-citation" };
      const note = paragraph(text(before), marked, text("."));
      writeMind(client, [note]);
      await client.settled();

      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
      await resolveChanges(client, "accept");

      const ids = citationIdsOf(client);
      expect(ids).toHaveLength(2);
      expect(ids.filter((id) => id === "marked-citation")).toHaveLength(1);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((id) => typeof id === "string")).toBe(true);
    },
  );

  // protects=an older Citation, written before Citations had ids, that the assistant's rewrite moves goes by the id the versions kept before give it, so a mark made on it after the rewrite finds it when one of them is restored (#1933); fails_when=the moved Citation has no id, or the restored one another; no_claim=Citations written since, which have their own.
  test("an older Citation the assistant's rewrite moves keeps its identity through a restore", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() => "[1] Spring tides come at new and full moon."),
    );
    const note = paragraph(
      text("Spring tides happen at new moon and at full moon "),
      citation(tides),
      text("."),
    );
    writeMind(client, [note]);
    await client.settled();
    const kept = await core.saveCheckpoint(mind.id, "accept");

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));
    await resolveChanges(client, "accept");
    const [moved] = citationIdsOf(client);
    expect(typeof moved).toBe("string");

    await core.restoreCheckpoint(mind.id, kept.id);
    await client.settled();
    expect(citationIdsOf(client)).toEqual([moved]);
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

  // protects=Shorten's join takes the second paragraph out; in the User's words a joined line, much like neither, is added beside both, which stay unless the reply quotes them as taken out (#2333: a paragraph the reply doesn't name is never written over); paragraphs it adds are new Blocks; fails_when=a join in the User's words writes over the first paragraph; no_claim=how a real model joins.
  test("Shorten that joins two paragraphs takes the second out; a join in the User's words is added beside both, which stay unless quoted as taken out; paragraphs it adds are new Blocks", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ passage, prompt }) =>
        passage.includes("Second")
          ? `First and second, together.${prompt.includes("delete") ? "\n\n<removed>Second paragraph.</removed>" : ""}`
          : "One line.\n\nAnother line.",
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
    // The passage was shown with names: a reply naming none that writes over nothing only talks.
    expect(await core.editWithAi(both("instruction", "Make it read better"))).toEqual({
      kind: "unchanged",
      said: "First and second, together.",
    });
    expect(shownWithChanges(client)).toEqual(["First paragraph.", "Second paragraph."]);

    const asked = await core.editWithAi(
      both("instruction", "Join them and delete the second paragraph"),
    );
    expect(asked).toMatchObject({ leftOut: [{ blockId: first.attrs.id, whole: true }] });
    expect(shownWithChanges(client)).toEqual([
      "First paragraph.",
      "- Second paragraph.",
      "+ First and second, together.",
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

  // protects=what goes is what the reply quotes between <removed> and </removed>, never what the request's words are read as (#2180); fails_when=a request worded off any list leaves the paragraph, or the quote lands as text; no_claim=that a real model writes the quote (tests/live/removalPhrasings).
  test.each([
    "Remove the whole part about hours (full time, Monday to Friday) and leave the rest",
    "Delete the list item about hours",
    "Lose this one",
    "I don't need this any more",
    "删去整个“工作安排”部分（全职、周一至周五、核心工作时间），其他部分保持不变。",
    "删去这一条关于工时的列表项（全职工作，周一至周五）。",
    "这段不要了",
    "这句话用不着",
  ])(
    "a paragraph the reply quotes as taken out goes, whatever the request's words: %s",
    async (asked) => {
      const { core, mind, client } = await setUp(
        editingModel(
          () =>
            "<removed>Work is full time, Monday to Friday.</removed>\n<why>Removed, as asked.</why>",
        ),
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

  // protects=a reply with no text and no quote changes nothing, whatever the request asks, and says why it failed (#2180); fails_when=an empty reply to "Remove it" takes the paragraph out, or one to another request is written as text; no_claim=how a real model words its reason.
  test("a reply of no text but why fails with its reason, whatever the request asks, and nothing is taken out", async () => {
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) =>
        passage.includes("Pensions")
          ? "<why>Removed.</why>"
          : passage.includes("Health") || passage.includes("Sick")
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

    expect(removed).toMatchObject({ kind: "failed", error: { message: "Removed." } });
    expect(silent).toMatchObject({
      kind: "failed",
      error: { message: "The model gave nothing back." },
    });
    const shortened = await core.editWithAi(
      wholeParagraph(client, mind.id, sick.attrs.id, "instruction", "Cut it down to two sentences"),
    );
    expect(refused).toMatchObject({
      kind: "failed",
      error: { message: "I can't do this." },
    });
    expect(shortened).toMatchObject({ kind: "failed" });
    expect(shownWithChanges(client)).toEqual([
      "Pensions match up to 5% of salary.",
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
  test("Stop keeps what the model finished: a paragraph it named is written, a new one added, and nothing it never reached goes", async () => {
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
    controlled.push(
      "¶1 Spring tides are strong at new moon and at full moon.\n\n¶+ A new opening line about the coast road.\n\n¶2 ## Harb",
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
            "<removed>Harbours publish the times of high water every year.</removed>",
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
        "¶1 ## Findings",
        "¶2 - Spring tides are strongest at new moon. [1]",
        "¶3 - Neap tides are weakest.",
        "¶4 ## Decisions",
        "¶5 1. Publish the tide tables in March.",
        "¶6 1. Check the harbour gauges weekly.",
        "¶7 Harbours publish the times of high water every year.",
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
          "<removed>Harbours publish the times of high water every year.</removed>",
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
          "<removed>Harbours publish the times of high water every year.</removed>",
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
        "¶1 ## Plan",
        "¶2 \\1. Background",
        "¶3 \\• Revenue grew",
        "¶4 Steps:\n\\- check the gauges",
        "¶5 ## Next",
        "¶6 - Hire a roaster.",
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

  // protects=a list made into a table becomes a table Block where the list was, out of it, its cell keeping the item's Citation, when the reply quotes the items the table takes the place of (#961, #2180); fails_when=the table is pipe text or lands in the list, the Citation is lost, or the list is kept as left out; no_claim=how a real model lays out a table.
  test("a list made into a table becomes a table, out of the list, its Citation in its cell", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(() =>
        [
          "| Tide | When |",
          "|:--|--:|",
          "| Spring | At new moon [1] |",
          "| Neap | Weakest \\| smallest |",
          "",
          "<removed>- Spring tides are strongest at new moon. [1]",
          "- Neap tides are weakest.</removed>",
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

  // protects=a table stands in for the list items it is made of only when it says nearly all of their words; one that only names them leaves them, so a summary never deletes the lines it sums up (#2180); fails_when=items a summary table names go without being quoted, or a table with all their words leaves them doubled; no_claim=how a real model lays out a table.
  test.each([
    {
      table: [
        "| Tide | When |",
        "|---|---|",
        "| Spring tides | strongest at new moon |",
        "| Neap tides | weakest |",
        "| Storm surge | after gales |",
      ],
      leftOut: 0,
    },
    { table: ["| Tide |", "|---|", "| Spring |", "| Neap |", "| Storm |"], leftOut: 3 },
  ])(
    "a table stands in for list items only when it says nearly all their words: $leftOut left out",
    async ({ table, leftOut }) => {
      const { core, mind, client } = await setUp(editingModel(() => table.join("\n")));
      writeMind(client, [
        list(
          "bulletList",
          [text("Spring tides: strongest at new moon.")],
          [text("Neap tides: weakest.")],
          [text("Storm surge: after gales.")],
        ),
      ]);
      await client.settled();

      const result = await core.editWithAi({
        ...whole(client, mind.id),
        instruction: "Add a table",
      });

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result.kind === "proposed" ? (result.leftOut ?? []).length : -1).toBe(leftOut);
      await resolveChanges(client, "accept");
      expect(structure(client).filter((line) => line.startsWith("• "))).toHaveLength(leftOut);
      expect(structure(client)).toContain("p Tide");
    },
  );

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

  // protects=a selection whose rewrite can't fit Edit with AI's output limit is turned away before anything is sent, with the shared "too much text" line in English and Chinese, while a long one that fits is sent; fails_when=it is sent and its rewrite comes back cut short (#2275).
  test("a selection whose rewrite would pass the output limit isn't sent, and a Block over it says the model is too small; a long one that fits is", async () => {
    const calls: EditCall[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(editingModel(() => "潮汐。", calls)).createChatModel,
    });
    await saveProviderUnasked(core, { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    await core.allowDataFlow("edits", "https://api.openai.com");
    const mind = await core.createMind({ title: "Long" });
    const client = await connectToMind(core, mind.id);
    // 9,000 Chinese characters rewrite in about 13,500 tokens; 11,000 in about 16,500, over 16,000.
    const fits = paragraph(text("潮".repeat(9_000)));
    const over = paragraph(text("汐".repeat(11_000)));
    writeMind(client, [fits, over]);
    await client.settled();

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, fits.attrs.id, "improve")),
    ).toMatchObject({ kind: "proposed" });
    expect(calls).toHaveLength(1);
    await resolveChanges(client, "reject");

    // One Block can't be split, and a reply past an edit's 16,000 tokens is no model's to take:
    // the line says to split the paragraph, and no model is offered (#2348).
    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, over.attrs.id, "improve")),
    ).toEqual({ kind: "block-too-long", cause: "cap" });
    expect(calls).toHaveLength(1);
    expect(translate("en", "edit.problem.block-too-long.cap")).toBe(
      "This paragraph is longer than one edit can take. Split it into shorter paragraphs.",
    );
    expect(translate("zh-CN", "edit.problem.block-too-long.cap")).toBe(
      "这一段超出了一次编辑能处理的长度，请把它拆成更短的段落。",
    );
    // A model's own window is the other cause, whose line names the model to change.
    expect(translate("en", "edit.problem.block-too-long", { model: "GPT" })).toBe(
      "This paragraph is too long for GPT",
    );
    expect(translate("zh-CN", "edit.problem.block-too-long", { model: "GPT" })).toBe(
      "这一段对 GPT 来说太长了",
    );
    expect(translate("en", "edit.problem.chooseAnotherModel")).toBe("Choose another model");
    expect(translate("zh-CN", "edit.problem.chooseAnotherModel")).toBe("换一个模型");
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

  // protects=a paragraph goes when the reply quotes it, and stays when the reply only leaves it out, whatever the request says (#2180, #880); fails_when=a "delete" request takes out a paragraph left out unquoted, or a quoted one stays; no_claim=that a real model quotes it.
  test("a paragraph the reply quotes as taken out goes, and applies; one it only leaves out stays, even when asked to delete", async () => {
    const quoted = await threeParagraphs(() =>
      [FIRST, `<removed>${SECOND}</removed>`, THIRD].join("\n\n"),
    );
    const result = await quoted.core.editWithAi(quoted.asked("delete the second paragraph"));
    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("leftOut");
    expect(shownWithChanges(quoted.client)).toEqual([FIRST, `- ${SECOND}`, THIRD]);

    const weekly = THIRD.replace("each week", "weekly");
    const left = await threeParagraphs(() => [FIRST, weekly].join("\n\n"));
    const kept = await left.core.editWithAi(left.asked("delete the second paragraph"));
    expect(kept).toMatchObject({
      kind: "proposed",
      leftOut: [expect.objectContaining({ whole: true })],
    });
    await resolveChanges(left.client, "accept");
    expect(shownWithChanges(left.client)).toEqual([FIRST, SECOND, weekly]);
  });

  // protects=a rewrite that gives back only the paragraph it changed, for a request that isn't a removal, loses none of the others (#2180, #880); fails_when=a paragraph left out goes; no_claim=what a real model returns (tests/live/overRemoval).
  test.each([
    "Make it shorter",
    "Improve the writing",
    "Make it more formal",
    "改短一些",
    "润色一下",
    "改得更正式",
  ])("“%s” answered with only the paragraph it changed keeps the other two", async (words) => {
    const { core, client, asked } = await threeParagraphs(() => FORMAL);

    const result = await core.editWithAi(asked(words));

    expect(result).toMatchObject({
      kind: "proposed",
      leftOut: [expect.anything(), expect.anything()],
    });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([FIRST, FORMAL, THIRD]);
  });

  // protects=a reply that rewrites one paragraph past half its words, gives it no name and leaves the rest out takes nothing out and writes over nothing (#2180, #2333): with the passage shown with names, a reply naming none that writes in no paragraph's place is the model's own words, shown and never applied, though the User asked for the edit (#2356); fails_when=a paragraph is written over or proposed for deletion, or its text goes into the Note; no_claim=how far a real model rewrites.
  test.each([
    {
      language: "English",
      lines: [FIRST, SECOND, THIRD],
      rewrite: "The harbour office now publishes every tide time online, on Mondays.",
    },
    {
      language: "Chinese",
      lines: ["每天涨潮两次。", "港口很大，低潮时很多船不出港。", "北区免费停车。"],
      rewrite: "北区停车需付费，不再免费。",
    },
  ])(
    "only the last paragraph, mostly rewritten and given no name, is shown, neither written nor applied, $language",
    async ({ lines, rewrite }) => {
      const { core, mind, client } = await setUp(editingModel(() => rewrite));
      const blocks = lines.map((line) => paragraph(text(line)));
      writeMind(client, blocks);
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, "Change the last one"));

      expect(result).toEqual({ kind: "unchanged", said: rewrite });
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(shownWithChanges(client)).toEqual(lines);
    },
  );

  // protects=a quote takes out the one paragraph it quotes, wherever in the reply it is written, and not the paragraphs left out unchanged beside it; fails_when=it takes a neighbour, or the paragraphs left out after it; no_claim=where a real model writes it.
  test.each([
    { where: "last", quote: (rest: string[], mark: string) => [...rest, mark] },
    { where: "first", quote: (rest: string[], mark: string) => [mark, ...rest] },
  ])(
    "a quote written $where takes out the paragraph it quotes; those left out unchanged stay",
    async ({ quote }) => {
      const words = [
        "Alpha opens the day.",
        "Bravo follows it closely.",
        "Charlie goes on for a while.",
        "Delta waits at the gate.",
        "Echo ends the day.",
      ];
      const set = await setUp(
        editingModel(() =>
          quote(
            ["Alpha opens the day well.", "Bravo follows it closely and calmly."],
            "<removed>Charlie goes on for a while.</removed>",
          ).join("\n\n"),
        ),
      );
      const blocks = words.map((each) => paragraph(text(each)));
      writeMind(set.client, blocks);
      await set.client.settled();

      const result = await set.core.editWithAi({
        requestId: `run-${++ids}`,
        mindId: set.mind.id,
        from: { blockId: blocks[0]?.attrs.id ?? "", offset: 0 },
        to: { blockId: blocks[4]?.attrs.id ?? "", offset: words[4]?.length ?? 0 },
        text: words.join("\n"),
        action: "instruction",
        instruction: "Take the third one out and tighten the rest",
      });

      expect(result).toMatchObject({
        kind: "proposed",
        leftOut: [expect.anything(), expect.anything()],
      });
      const shown = shownWithChanges(set.client);
      expect(shown.filter((line) => line.startsWith("- "))).toEqual([
        "- Charlie goes on for a while.",
      ]);
      expect(shown).toContain("Delta waits at the gate.");
      expect(shown).toContain("Echo ends the day.");
    },
  );

  // protects=a whole section quoted in one mark goes, heading and all, and nothing of the next section; in Chinese too; fails_when=a paragraph of the section stays or one of the next goes; no_claim=how a real model lays out the quote.
  test.each([
    {
      language: "English",
      blocks: [
        ["Role", "The post is a senior analyst position."],
        ["Hours", "Work is full time, Monday to Friday.", "Core hours are 9:30 to 15:30."],
        ["Pay", "The salary is set by grade 7."],
      ],
      joined: "\n",
    },
    {
      language: "Chinese",
      blocks: [
        ["职位", "该岗位是财务团队的高级分析岗位。"],
        ["工时", "全职，周一至周五上班。", "核心工作时间为9:30至15:30。"],
        ["薪酬", "薪酬按7级确定，按月发放。"],
      ],
      joined: "\n\n",
    },
  ])(
    "a section quoted as taken out goes with its heading, $language",
    async ({ blocks, joined }) => {
      const [role, hours, pay] = blocks as [string[], string[], string[]];
      const { core, mind, client } = await setUp(
        editingModel(() =>
          [
            `<removed>## ${hours[0]}${joined}${hours.slice(1).join(joined)}</removed>`,
            `<why>${hours[0]}</why>`,
          ].join("\n"),
        ),
      );
      writeMind(
        client,
        [role, hours, pay].flatMap(([title, ...rest]) => [
          headingOf(title as string),
          ...rest.map((each) => paragraph(text(each))),
        ]),
      );
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, "Drop the hours"));

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("held");
      const shown = shownWithChanges(client);
      expect(shown.filter((line) => line.startsWith("- "))).toEqual(
        hours.map((each) => `- ${each}`),
      );
      expect(shown).toEqual(expect.arrayContaining([...role, ...pay]));
    },
  );

  // protects=two headings that read alike are told apart by the words of the section quoted, and a quote like none of the Note takes nothing out; fails_when="Pay" takes "Pay review" with it, or a paraphrase takes a paragraph out; no_claim=how a real model quotes.
  test.each([
    {
      language: "English",
      alike: ["Pay review", "The pay review is held every March."],
      named: ["Pay", "The salary is set by grade 7."],
      paraphrase: "The section about the job's terms",
    },
    {
      language: "Chinese",
      alike: ["工作安排（试用期）", "试用期为三个月。"],
      named: ["工作安排", "全职，周一至周五上班。"],
      paraphrase: "关于上班安排的那一节",
    },
  ])(
    "of two headings that read alike, the one quoted goes, and a paraphrase takes nothing, $language",
    async ({ alike, named, paraphrase }) => {
      const [alikeTitle, alikeText, namedTitle, namedText] = [...alike, ...named] as [
        string,
        string,
        string,
        string,
      ];
      const sections = () => [
        headingOf(alikeTitle),
        paragraph(text(alikeText)),
        headingOf(namedTitle),
        paragraph(text(namedText)),
      ];

      const first = await setUp(
        editingModel(() => `<removed>## ${namedTitle}\n\n${namedText}</removed>`),
      );
      writeMind(first.client, sections());
      await first.client.settled();
      const done = await first.core.editWithAi(wholeMind(first.client, first.mind.id, "Drop it"));
      expect(done).toMatchObject({ kind: "proposed" });
      expect(shownWithChanges(first.client)).toEqual([
        alikeTitle,
        alikeText,
        `- ${namedTitle}`,
        `- ${namedText}`,
      ]);

      const second = await setUp(
        editingModel(() => `## ${alikeTitle}\n\n${alikeText}\n\n<removed>${paraphrase}</removed>`),
      );
      writeMind(second.client, sections());
      await second.client.settled();
      const guess = await second.core.editWithAi(
        wholeMind(second.client, second.mind.id, "Drop it"),
      );
      expect(guess).not.toMatchObject({ kind: "proposed" });
      expect(shownWithChanges(second.client)).toEqual([
        alikeTitle,
        alikeText,
        namedTitle,
        namedText,
      ]);
    },
  );

  // protects=a quote of part of a paragraph the reply leaves out takes out exactly those words, never the whole paragraph; in Chinese too (#2180); fails_when=the paragraph's other sentences go, or the quoted ones stay; no_claim=how often a real model quotes this way.
  test.each([
    {
      language: "English",
      lines: [
        "Rent is 1,200 a month, due on the first.",
        "Parking costs 100 a month. The space is in the north garage. Keys are at the front desk.",
        "Water is billed separately each quarter.",
      ],
      quote: "The space is in the north garage.",
      left: "Parking costs 100 a month. Keys are at the front desk.",
    },
    {
      language: "English, half",
      lines: [
        "Rent is 1,200 a month, due on the first.",
        "Parking costs 100 a month. The space is in the north garage. Keys are at the front desk.",
        "Water is billed separately each quarter.",
      ],
      quote: "Parking costs 100 a month. The space is in the north garage.",
      left: "Keys are at the front desk.",
    },
    {
      language: "English, at the end",
      lines: [
        "Rent is 1,200 a month, due on the first.",
        "Parking costs 100 a month. The space is in the north garage. Keys are at the front desk.",
        "Water is billed separately each quarter.",
      ],
      quote: "Keys are at the front desk.",
      left: "Parking costs 100 a month. The space is in the north garage.",
    },
    {
      language: "Chinese",
      lines: [
        "租金每月1200元，每月1日支付。",
        "停车每月100元。车位在北区车库。钥匙在前台。",
        "水费按季度单独结算。",
      ],
      quote: "车位在北区车库。",
      left: "停车每月100元。钥匙在前台。",
    },
  ])(
    "a quote of part of a paragraph takes out only those words, $language",
    async ({ lines, quote, left }) => {
      const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
      writeMind(
        client,
        lines.map((line) => paragraph(text(line))),
      );
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, "Delete that sentence"));

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("held");
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([lines[0], left, lines[2]]);
    },
  );

  // protects=a quote of words a paragraph the reply rewrote no longer has is that rewrite's, and the same words in a paragraph it left out stay; in Chinese too (#2180); fails_when=the left-out paragraph loses them; no_claim=how often a real model quotes this way.
  test.each([
    {
      language: "English",
      asked: "Drop the TBD from the owner line",
      lines: ["Budget: TBD.", "Owner: Sam. TBD.", "Water is billed separately each quarter."],
      reply: "Owner: Sam.\n\n<removed>TBD.</removed>",
      after: ["Budget: TBD.", "Owner: Sam.", "Water is billed separately each quarter."],
    },
    {
      language: "English, a sentence",
      asked: "In the parking paragraph, change 100 to 120 and drop the keys sentence",
      lines: [
        "Bikes go in the shed. Keys are at the front desk.",
        "Parking costs 100 a month. Keys are at the front desk.",
      ],
      reply: "Parking costs 120 a month.\n\n<removed>Keys are at the front desk.</removed>",
      after: ["Bikes go in the shed. Keys are at the front desk.", "Parking costs 120 a month."],
    },
    {
      language: "Chinese",
      asked: "去掉负责人那一行的待定",
      lines: ["预算：待定。", "负责人：小王。待定。", "水费按季度单独结算。"],
      reply: "负责人：小王。\n\n<removed>待定。</removed>",
      after: ["预算：待定。", "负责人：小王。", "水费按季度单独结算。"],
    },
  ])(
    "a quote of words the reply's rewrite took out leaves them in a paragraph it left out, $language",
    async ({ asked, lines, reply, after }) => {
      const { core, mind, client } = await setUp(editingModel(() => reply));
      writeMind(
        client,
        lines.map((line) => paragraph(text(line))),
      );
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, asked));

      expect(result).toMatchObject({ kind: "proposed" });
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual(after);
    },
  );

  // protects=a quote that is twice in the one paragraph that has it refuses the edit, as it can't say which; in Chinese too (#2180); fails_when=one of the two is taken out; no_claim=none beyond protects.
  test.each([
    {
      language: "English",
      lines: [
        "Rent is monthly.",
        "Keys are at the front desk. Ask first. Keys are at the front desk.",
        "Water is quarterly.",
      ],
      quote: "Keys are at the front desk.",
    },
    {
      language: "Chinese",
      lines: ["租金按月支付。", "钥匙在前台。先问一声。钥匙在前台。", "水费按季度支付。"],
      quote: "钥匙在前台。",
    },
  ])("a quote twice in one paragraph refuses the edit, $language", async ({ lines, quote }) => {
    const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
    writeMind(
      client,
      lines.map((line) => paragraph(text(line))),
    );
    await client.settled();

    const result = await core.editWithAi(wholeMind(client, mind.id, "Delete that sentence"));

    expect(result).toEqual({ kind: "unplaced", quotes: [quote] });
    expect(shownWithChanges(client)).toEqual(lines);
  });

  // protects=a part quote whose words a paragraph the reply wrote still holds refuses the edit, so no other paragraph loses them: written back as it was, rewritten around them, or only there; in Chinese too (#2180); fails_when=the words come out of a paragraph nobody named, or the quote is let pass; no_claim=how often a real model quotes this way.
  test.each([
    {
      case: "written back as it was, the same words left out elsewhere",
      lines: [
        "Bikes go in the shed. Keys are at the front desk.",
        "Parking costs 100 a month. Keys are at the front desk.",
      ],
      reply:
        "Bikes go in the shed. Keys are at the front desk.\n\n<removed>Keys are at the front desk.</removed>",
      asked: "Drop the keys sentence from the bikes paragraph",
    },
    {
      case: "rewritten but keeping them, the same words left out elsewhere",
      lines: [
        "Bikes go in the shed. Keys are at the front desk.",
        "Parking costs 100 a month. Keys are at the front desk.",
      ],
      reply:
        "Parking costs 120 a month. Keys are at the front desk.\n\n<removed>Keys are at the front desk.</removed>",
      asked: "In the parking paragraph, change 100 to 120 and drop the keys sentence",
    },
    {
      case: "only in paragraphs written back as they were",
      lines: [
        "Bikes go in the shed. Keys are at the front desk.",
        "Parking costs 100 a month. Keys are at the front desk.",
      ],
      reply:
        "Bikes go in the shed. Keys are at the front desk.\n\nParking costs 100 a month. Keys are at the front desk.\n\n<removed>Keys are at the front desk.</removed>",
      asked: "Drop the keys sentence",
    },
    {
      case: "Chinese, rewritten but keeping them",
      lines: ["自行车放在棚里。钥匙在前台。", "停车每月100元。钥匙在前台。"],
      reply: "停车每月120元。钥匙在前台。\n\n<removed>钥匙在前台。</removed>",
      asked: "停车那段把100改成120，去掉钥匙那句",
    },
  ])("a part quote the reply's own text still has refuses the edit: $case", async (each) => {
    const { core, mind, client } = await setUp(editingModel(() => each.reply));
    writeMind(
      client,
      each.lines.map((line) => paragraph(text(line))),
    );
    await client.settled();

    const result = await core.editWithAi(wholeMind(client, mind.id, each.asked));

    expect(result).toMatchObject({ kind: "unplaced" });
    expect(shownWithChanges(client)).toEqual(each.lines);
  });

  // protects=a quote is a word only where it stands as a word: "draft" isn't in "drafts" or "drafted", so a one-word removal is neither refused for them nor taken as made by them, and a rewrite that turns the word into "drafts" has taken it out; Chinese has no spaces, so there 草稿 in 草稿箱 is a place (#2180); fails_when=the title's word is refused on every retry, or stays while the edit applies; no_claim=none beyond protects.
  test.each([
    {
      case: "a longer word left out elsewhere",
      lines: ["Title: Budget draft", "Old drafts go to the archive."],
      reply: "<removed>draft</removed>",
      after: ["Title: Budget", "Old drafts go to the archive."],
    },
    {
      case: "a longer word the reply rewrote away",
      lines: ["Title: Budget draft", "We drafted the plan in May."],
      reply: "<removed>draft</removed>\n\nWe wrote the plan in May.",
      after: ["Title: Budget", "We wrote the plan in May."],
    },
    {
      case: "the word rewritten into a longer one is taken out there, and the title keeps it",
      lines: ["Title: Budget draft", "Save the draft today."],
      reply: "<removed>draft</removed>\n\nSave the drafts today.",
      after: ["Title: Budget draft", "Save the drafts today."],
    },
  ])("a quoted word is matched only as a word: $case", async ({ lines, reply, after }) => {
    const { core, mind, client } = await setUp(editingModel(() => reply));
    writeMind(
      client,
      lines.map((line) => paragraph(text(line))),
    );
    await client.settled();

    const result = await core.editWithAi(
      wholeMind(client, mind.id, "Remove the word draft from the title"),
    );

    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual(after);
  });

  // protects=Chinese has no spaces, so any character boundary counts: a word quoted from inside a run of characters comes out, and 草稿 in 草稿箱 is a second place, so that quote is refused (#2180); fails_when=a Chinese part removal is refused as cutting a word, or the second place is missed; no_claim=none beyond protects.
  test.each([
    {
      case: "a word inside a run of characters comes out",
      lines: ["标题：预算草稿", "旧文件已归档。"],
      quote: "草稿",
      after: ["标题：预算", "旧文件已归档。"],
    },
    {
      case: "a word inside a sentence comes out",
      lines: ["预算：待定下周确认。", "水费按季度单独结算。"],
      quote: "待定",
      after: ["预算：下周确认。", "水费按季度单独结算。"],
    },
    {
      case: "a second place inside another word refuses",
      lines: ["标题：预算草稿", "旧草稿箱已归档。"],
      quote: "草稿",
      after: null,
    },
  ])("in Chinese any character boundary counts: $case", async ({ lines, quote, after }) => {
    const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
    writeMind(
      client,
      lines.map((line) => paragraph(text(line))),
    );
    await client.settled();

    const result = await core.editWithAi(wholeMind(client, mind.id, `去掉${quote}`));

    if (after === null) {
      expect(result).toEqual({ kind: "unplaced", quotes: [quote] });
      expect(shownWithChanges(client)).toEqual(lines);
      return;
    }
    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual(after);
  });

  // protects=a part quote takes out exactly its words: one that starts or ends inside a word of Latin text is refused, a mark that doesn't close a word keeps the space before it, a word joined to the one before it keeps the space after it, and Chinese loses only the quoted characters, with one of two spaces around them (#2180); fails_when=the rest of a word, a space or a neighbouring character goes too; no_claim=none beyond protects.
  test.each([
    { line: "Sam TBD's car is red.", quote: "TBD", after: null },
    { line: "foo TBD.bar baz", quote: "TBD", after: null },
    { line: "foo TBD.bar", quote: "TBD", after: null },
    { line: "Price TBD/TBC.", quote: "TBD", after: "Price /TBC." },
    { line: "Sam TBD&Co", quote: "TBD", after: "Sam &Co" },
    { line: "预算待定期间 确认。", quote: "待定期", after: "预算间 确认。" },
    { line: "Ref co-TBD now.", quote: "TBD", after: "Ref co- now." },
    { line: "小王 待定 ，下周确认。", quote: "待定", after: "小王 ，下周确认。" },
  ])("a part quote takes out exactly its words: $line", async ({ line, quote, after }) => {
    const water = "Water is billed separately each quarter.";
    const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
    writeMind(client, [paragraph(text(line)), paragraph(text(water))]);
    await client.settled();

    const result = await core.editWithAi(wholeMind(client, mind.id, `Remove ${quote}`));

    if (after === null) {
      expect(result).toEqual({ kind: "unplaced", quotes: [quote] });
      expect(shownWithChanges(client)).toEqual([line, water]);
      return;
    }
    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([after, water]);
  });

  // protects=whatever the text around it, a part removal takes out the quoted words and at most one space beside them, or is refused with the Note as it was (#2180); fails_when=any other character goes; no_claim=none beyond protects.
  test("a part removal takes out only the quote and at most one space, or nothing", async () => {
    const water = "Water is billed separately each quarter.";
    const rows: { line: string; quote: string; applies: boolean }[] = [
      { line: "Sam TBD's car is red.", quote: "TBD", applies: false },
      { line: "foo TBD.bar baz", quote: "TBD", applies: false },
      { line: "foo TBD.bar", quote: "TBD", applies: false },
      { line: "Price TBD/TBC.", quote: "TBD", applies: true },
      { line: "Sam TBD&Co", quote: "TBD", applies: true },
      { line: '"Sam TBD"', quote: "TBD", applies: true },
      { line: "Owner: Sam TBD.", quote: "TBD", applies: true },
      { line: "Owner: Sam TBD, for now.", quote: "TBD", applies: true },
      { line: "Owner: Sam TBD later.", quote: "TBD", applies: true },
      { line: "TBD Sam is the owner.", quote: "TBD", applies: true },
      {
        line: "Keys are at the front desk. Ask first.",
        quote: "Keys are at the front desk.",
        applies: true,
      },
      {
        line: "Ask first. Keys are at the front desk.",
        quote: "Keys are at the front desk.",
        applies: true,
      },
      { line: "预算待定期间 确认。", quote: "待定期", applies: true },
      { line: "预算：待定下周确认。", quote: "待定", applies: true },
      { line: "预算 待定 下周确认。", quote: "待定", applies: true },
    ];
    const onlyTheQuote = (line: string, quote: string, after: string) => {
      const at = line.indexOf(quote);
      const head = line.slice(0, at);
      const tail = line.slice(at + quote.length);
      const allowed = [head + tail];
      if (/\s$/.test(head)) allowed.push(head.slice(0, -1) + tail);
      if (/^\s/.test(tail)) allowed.push(head + tail.slice(1));
      return allowed.includes(after);
    };
    const wrong: string[] = [];
    for (const { line, quote, applies } of rows) {
      const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
      writeMind(client, [paragraph(text(line)), paragraph(text(water))]);
      await client.settled();
      const result = await core.editWithAi(wholeMind(client, mind.id, `Remove ${quote}`));
      if (result.kind === "proposed") await resolveChanges(client, "accept");
      const [after, rest] = shownWithChanges(client);
      const right =
        rest === water &&
        (applies
          ? result.kind === "proposed" && after !== undefined && onlyTheQuote(line, quote, after)
          : result.kind === "unplaced" && after === line);
      if (!right) wrong.push(`${line} -> ${result.kind}: ${after}`);
    }
    expect(wrong).toEqual([]);
  });

  // protects=a footnote is the User's own writing: a quote with a footnote marker right after it is refused, and the footnote and its text stay, while a Citation marker there still goes with the quoted word; in Chinese too (#2180); fails_when=the footnote goes with the quote, or the Citation stays behind; no_claim=none beyond protects.
  test.each([
    { language: "English", words: "Owner: Sam TBD", quote: "TBD", rest: ".", after: "Owner: Sam." },
    {
      language: "English, before a space",
      words: "Owner: Sam TBD",
      quote: "TBD",
      rest: " later.",
      after: "Owner: Sam later.",
    },
    {
      language: "Chinese",
      words: "负责人：小王待定",
      quote: "待定",
      rest: "。",
      after: "负责人：小王。",
    },
  ])(
    "a footnote right after the quote refuses it, a Citation goes with it: $language",
    async ({ words, quote, rest, after }) => {
      const water = "Water is billed separately each quarter.";
      const footnote: JSONContent = {
        type: "footnote",
        attrs: { id: "fn-legal" },
        content: [text("Pending legal sign-off.")],
      };
      const noted = await setUp(editingModel(() => `<removed>${quote}</removed>`));
      writeMind(noted.client, [
        paragraph(text(words), footnote, text(rest)),
        paragraph(text(water)),
      ]);
      await noted.client.settled();
      const before = JSON.stringify(noted.client.blocks.toJSON());

      // A footnote reads as one character in the selection's text, its own words left out.
      const refused = await noted.core.editWithAi({
        ...wholeMind(noted.client, noted.mind.id, `Remove ${quote}`),
        text: `${words}\uFFFC${rest}\n${water}`,
      });

      expect(refused).toEqual({ kind: "unplaced", quotes: [quote] });
      expect(JSON.stringify(noted.client.blocks.toJSON())).toBe(before);
      expect(JSON.stringify(noted.client.blocks.toJSON())).toContain("Pending legal sign-off.");

      const cited = await setUp(editingModel(() => `<removed>${quote}</removed>`));
      writeMind(cited.client, [
        paragraph(text(words), citation(cited.tides), text(rest)),
        paragraph(text(water)),
      ]);
      await cited.client.settled();
      expect(
        await cited.core.editWithAi(wholeMind(cited.client, cited.mind.id, `Remove ${quote}`)),
      ).toMatchObject({ kind: "proposed", droppedCitations: 1 });
      await resolveChanges(cited.client, "accept");
      expect(shownWithChanges(cited.client)).toEqual([after, water]);
    },
  );

  // protects=a quote whose words run across a formula or a line break is refused, as the reply's marks can't say whether those go; the Note stays as it was (#2180); fails_when=the formula or the line break is taken out with the words; no_claim=none beyond protects.
  test.each([
    {
      case: "a formula",
      line: paragraph(
        text("Cost is "),
        { type: "inlineMath", attrs: { latex: "x" } },
        text(" per unit, TBD."),
      ),
      quote: "is $x$ per unit",
    },
    {
      case: "a line break",
      line: paragraph(text("Owner: Sam TBD"), { type: "hardBreak" }, text("later today.")),
      quote: "TBD\nlater",
    },
  ])("a quote across $case is refused", async ({ line, quote }) => {
    const { core, mind, client } = await setUp(editingModel(() => `<removed>${quote}</removed>`));
    writeMind(client, [line, paragraph(text("Water is billed separately each quarter."))]);
    await client.settled();
    const before = JSON.stringify(client.blocks.toJSON());

    const result = await core.editWithAi(wholeMind(client, mind.id, "Remove those words"));

    expect(result).toMatchObject({ kind: "unplaced" });
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
  });

  // protects=a quote of a table cell's whole text strikes the text and keeps the cell, so the table keeps its shape; Undo of the accept and a reject give the table back exactly (#2180); fails_when=the cell goes and the row is left short, or the table can't be brought back; no_claim=none beyond protects.
  test("a whole table cell quoted keeps the cell, and Undo with reject gives it back", async () => {
    const cell = (words: string): JSONContent => ({
      type: "tableCell",
      content: [paragraph(text(words))],
    });
    const { core, mind, client } = await setUp(editingModel(() => "<removed>TBD</removed>"));
    writeMind(client, [
      paragraph(text("The costs, as agreed so far.")),
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("Item"), cell("Amount")] },
          { type: "tableRow", content: [cell("Rent"), cell("TBD")] },
        ],
      },
    ]);
    await client.settled();
    const before = JSON.stringify(client.blocks.toJSON());

    const result = await core.editWithAi(
      wholeMind(client, mind.id, "Take TBD out of the rent cell"),
    );

    expect(result).toMatchObject({ kind: "proposed" });
    const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
    await resolveChanges(client, "accept");
    const rows: string[][] = [];
    readMind(client).descendants((node) => {
      if (node.type.name !== "tableRow") return true;
      const cells: string[] = [];
      node.forEach((each) => {
        cells.push(each.textContent);
      });
      rows.push(cells);
      return false;
    });
    expect(rows).toEqual([
      ["Item", "Amount"],
      ["Rent", ""],
    ]);
    undo.undo();
    await client.settled();
    await resolveChanges(client, "reject");
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
  });

  // protects=a removal never leaves a table cell with no Block, however deep the quoted text sits: a cell holding a one-item list, or a list item holding a paragraph and a nested list, keeps its shape with its text struck; Undo of the accept and a reject give the table back exactly (#2180); fails_when=the list goes, the cell with it, and the row is left short; no_claim=none beyond protects.
  test.each([
    {
      case: "a one-item list",
      content: (): JSONContent[] => [
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("TBD"))] }] },
      ],
      reply: "<removed>TBD</removed>",
    },
    {
      case: "a list item holding a paragraph and a nested list",
      content: (): JSONContent[] => [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                paragraph(text("TBD")),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [paragraph(text("TBC"))] }],
                },
              ],
            },
          ],
        },
      ],
      reply: "<removed>TBD\n\nTBC</removed>",
    },
  ])("a cell holding $case keeps its shape when all its text is quoted", async (each) => {
    const cell = (content: JSONContent[]): JSONContent => ({ type: "tableCell", content });
    const { core, mind, client } = await setUp(editingModel(() => each.reply));
    writeMind(client, [
      paragraph(text("The costs, as agreed so far.")),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [cell([paragraph(text("Item"))]), cell([paragraph(text("Amount"))])],
          },
          { type: "tableRow", content: [cell([paragraph(text("Rent"))]), cell(each.content())] },
        ],
      },
    ]);
    await client.settled();
    const before = JSON.stringify(client.blocks.toJSON());
    const shape = () => {
      const kinds: string[] = [];
      readMind(client).descendants((node) => {
        if (node.isTextblock) return false;
        kinds.push(node.type.name);
        return true;
      });
      return kinds;
    };
    const shaped = shape();

    const result = await core.editWithAi(
      wholeMind(client, mind.id, "Take TBD out of the rent cell"),
    );

    expect(result).toMatchObject({ kind: "proposed" });
    const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
    await resolveChanges(client, "accept");
    expect(shape()).toEqual(shaped);
    expect(readMind(client).textContent).not.toContain("TBD");
    undo.undo();
    await client.settled();
    await resolveChanges(client, "reject");
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
  });

  // protects=a quote whose span holds a footnote is refused, so the User's own footnote never goes with words around it (#2180); fails_when=the footnote and its text go with the quote; no_claim=none beyond protects.
  test("a quote across a footnote is refused, and the footnote stays", async () => {
    const water = "Water is billed separately each quarter.";
    const { core, mind, client } = await setUp(editingModel(() => "<removed>TBD TBC</removed>"));
    writeMind(client, [
      paragraph(
        text("Owner: Sam TBD"),
        { type: "footnote", attrs: { id: "fn-legal" }, content: [text("Pending legal sign-off.")] },
        text(" TBC."),
      ),
      paragraph(text(water)),
    ]);
    await client.settled();
    const before = JSON.stringify(client.blocks.toJSON());

    // A footnote reads as one character in the selection's text, its own words left out.
    const result = await core.editWithAi({
      ...wholeMind(client, mind.id, "Remove TBD TBC"),
      text: `Owner: Sam TBD\uFFFC TBC.\n${water}`,
    });

    expect(result).toEqual({ kind: "unplaced", quotes: ["TBD TBC"] });
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
  });

  // protects=a word taken out right before a full stop or comma takes the space before it, so no space is left before the punctuation; one taken out mid-sentence takes the space after it (#2180); fails_when=the line reads "Owner: Sam ." or two words run together; no_claim=none beyond protects.
  test.each([
    { line: "Owner: Sam TBD.", after: "Owner: Sam." },
    { line: "Owner: Sam TBD, for now.", after: "Owner: Sam, for now." },
    { line: "Owner: Sam TBD later.", after: "Owner: Sam later." },
    { line: "Owner: Sam TBD", cited: true, after: "Owner: Sam." },
  ])(
    "a word taken out leaves no space before punctuation: $line",
    async ({ line, cited, after }) => {
      const water = "Water is billed separately each quarter.";
      const { core, mind, client, tides } = await setUp(
        editingModel(() => "<removed>TBD</removed>"),
      );
      writeMind(client, [
        cited ? paragraph(text(line), citation(tides), text(".")) : paragraph(text(line)),
        paragraph(text(water)),
      ]);
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, "Drop the TBD"));

      expect(result).toMatchObject({ kind: "proposed" });
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([after, water]);
    },
  );

  // protects=a paragraph the reply moved is a paragraph it wrote: when its new place still has the quoted words, a part quote refuses the edit, and the same words in a paragraph left out stay (#2180); fails_when=the moved paragraph counts as having dropped them and the quote is let pass, or the left-out paragraph loses them; no_claim=none beyond protects.
  test("a part quote a moved paragraph still has refuses the edit", async () => {
    const lines = [
      "Parking costs 100 a month. Keys are at the front desk.",
      "Bikes go in the shed. Keys are at the front desk.",
      "Water is billed separately each quarter.",
    ];
    const { core, mind, client } = await setUp(
      editingModel(
        () => `${lines[2]}\n\n${lines[0]}\n\n<removed>Keys are at the front desk.</removed>`,
      ),
    );
    writeMind(
      client,
      lines.map((line) => paragraph(text(line))),
    );
    await client.settled();

    const result = await core.editWithAi(
      wholeMind(client, mind.id, "Put the parking line last and drop the keys"),
    );

    expect(result).toEqual({ kind: "unplaced", quotes: ["Keys are at the front desk."] });
    expect(shownWithChanges(client)).toEqual(lines);
  });

  // protects=a formula right after a quoted sentence stays, as the reply didn't quote it; the Citation marker after one goes with it (#2180); in Chinese too; fails_when=the formula goes with the sentence; no_claim=none beyond protects.
  test.each([
    { language: "English", quoted: "Done.", rest: " More text." },
    { language: "Chinese", quoted: "已完成。", rest: "接下来。" },
  ])("a formula after a quoted sentence stays, $language", async ({ quoted, rest }) => {
    const { core, mind, client } = await setUp(editingModel(() => `<removed>${quoted}</removed>`));
    writeMind(client, [
      paragraph(text("Rent is monthly.")),
      paragraph(text(`${quoted} `), { type: "inlineMath", attrs: { latex: "F = ma" } }, text(rest)),
      paragraph(text("Water is quarterly.")),
    ]);
    await client.settled();

    const result = await core.editWithAi(wholeMind(client, mind.id, "Delete that sentence"));

    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([
      "Rent is monthly.",
      `\uFFFC${rest}`,
      "Water is quarterly.",
    ]);
  });

  // protects=a quote that isn't in the passage word for word refuses the whole edit and is named, so nothing it wrote leans on text that stayed (#2180); fails_when=a paragraph goes for a paraphrase, the rest applies, or the quote isn't reported; no_claim=how a real model words a quote.
  test("a quote that isn't in the passage word for word refuses the edit, and is named", async () => {
    const weekly = THIRD.replace("each week", "weekly");
    const { core, client, asked } = await threeParagraphs(
      () => `${weekly}\n\n<removed>The harbour is big and boats wait for the tide.</removed>`,
    );

    const result = await core.editWithAi(asked("Say weekly, and drop the bit about the boats"));

    expect(result).toEqual({
      kind: "unplaced",
      quotes: ["The harbour is big and boats wait for the tide."],
    });
    expect(shownWithChanges(client)).toEqual([FIRST, SECOND, THIRD]);
    expect(translate("en", "edit.problem.unplaced")).toBe(
      "The AI marked text to remove that doesn’t match the selection word for word in one place, so nothing changed. Try again.",
    );
    expect(translate("zh-CN", "edit.problem.unplaced")).toBe(
      "AI 标出要删除的文字在选中内容里找不到唯一一处原文，没有改动。请重试。",
    );
  });

  // protects=a new line that only reads like a line the reply left out is new text, and the old line stays; in Chinese too (#2180); fails_when=the old line is taken as moved and deleted; no_claim=none beyond protects.
  test.each([
    {
      language: "English",
      lines: [
        "Deposit is 1,200, paid on signing.",
        "Parking is 100 a month.",
        "Water is 30 a month.",
      ],
      reply: "Water is 30 a month.\n\nInternet is 1,200 a year, paid on signing.",
      added: "Internet is 1,200 a year, paid on signing.",
    },
    {
      language: "Chinese",
      lines: ["押金1200元，签约时支付。", "停车每月100元。", "水费每月30元。"],
      reply: "水费每月30元。\n\n网费每年1200元，签约时支付。",
      added: "网费每年1200元，签约时支付。",
    },
  ])(
    "a new line much like one left out doesn't take it out, $language",
    async ({ lines, reply, added }) => {
      const { core, mind, client } = await setUp(editingModel(() => reply));
      writeMind(
        client,
        lines.map((line) => paragraph(text(line))),
      );
      await client.settled();

      const result = await core.editWithAi(wholeMind(client, mind.id, "Add a line for internet"));

      expect(result).toMatchObject({ kind: "proposed" });
      await resolveChanges(client, "accept");
      const shown = shownWithChanges(client);
      expect(shown).toEqual(expect.arrayContaining([...lines, added]));
      expect(shown).toHaveLength(4);
    },
  );

  // protects=of two paragraphs that read the same, a quote takes out the one the reply left out, and two left out alike take nothing for one quote (#2180); fails_when=the quote lands on the paragraph the reply kept, or picks one of two left out by guess; no_claim=none beyond protects.
  test("of two paragraphs that read the same, the one left out goes; two left out alike are not guessed between", async () => {
    const lines = ["Same line here.", "Middle one.", "Same line here."];
    const kept = await setUp(
      editingModel(() => "Same line here.\n\nMiddle one.\n\n<removed>Same line here.</removed>"),
    );
    writeMind(
      kept.client,
      lines.map((line) => paragraph(text(line))),
    );
    await kept.client.settled();
    expect(
      await kept.core.editWithAi(wholeMind(kept.client, kept.mind.id, "Remove the last line")),
    ).toMatchObject({ kind: "proposed" });
    expect(shownWithChanges(kept.client)).toEqual([
      "Same line here.",
      "Middle one.",
      "- Same line here.",
    ]);

    const both = await setUp(
      editingModel(() => "Middle one, now clearer.\n\n<removed>Same line here.</removed>"),
    );
    writeMind(
      both.client,
      lines.map((line) => paragraph(text(line))),
    );
    await both.client.settled();
    const guess = await both.core.editWithAi(wholeMind(both.client, both.mind.id, "Remove one"));
    expect(guess).toEqual({ kind: "unplaced", quotes: ["Same line here."] });
    expect(shownWithChanges(both.client)).toEqual(lines);
  });

  // protects=a fixed task (Shorten, Improve) never asks for text to go, so a reply that only quotes the passage fails with its reason and takes nothing out; in Chinese too (#2180); fails_when=the selection is emptied; no_claim=how often a model does this.
  test.each([
    {
      action: "shorten" as const,
      line: "The harbour office posts the tide times every Monday morning.",
    },
    { action: "improve" as const, line: "港务办公室每周一上午公布潮汐表。" },
  ])(
    "$action answered with only a quote of the passage fails, and takes nothing out",
    async ({ action, line }) => {
      const { core, mind, client } = await setUp(
        editingModel(() => `<removed>${line}</removed>\n<why>Nothing left to keep.</why>`),
      );
      const note = paragraph(text(line));
      writeMind(client, [note]);
      await client.settled();

      const result = await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, action));

      expect(result).toMatchObject({ kind: "failed", error: { message: "Nothing left to keep." } });
      expect(shownWithChanges(client)).toEqual([line]);
    },
  );

  // protects=a section's paragraphs replaced by one plain new sentence, the old ones quoted as taken out, leave its heading as it was; in Chinese too; fails_when=the new sentence is written into the heading, or the heading goes; no_claim=where a sentence that pairs with no paragraph goes, nor how a real model words it.
  test.each([
    {
      language: "English",
      title: "Hours",
      lines: ["Work is full time, Monday to Friday.", "Core hours are 9:30 to 15:30."],
      sentence: "Working hours are flexible.",
    },
    {
      language: "Chinese",
      title: "上班时间",
      lines: ["全职，周一至周五上班。", "核心工作时间为9:30至15:30。"],
      sentence: "上班时间由员工自行安排，十分灵活。",
    },
  ])(
    "two paragraphs replaced by one plain sentence keep their heading, $language",
    async ({ title, lines, sentence }) => {
      const { core, mind, client } = await setUp(
        editingModel(() =>
          [...lines.map((line) => `<removed>${line}</removed>`), sentence].join("\n\n"),
        ),
      );
      writeMind(client, [headingOf(title), ...lines.map((line) => paragraph(text(line)))]);
      await client.settled();

      const result = await core.editWithAi(
        wholeMind(client, mind.id, "Replace the two paragraphs with one sentence"),
      );

      expect(result).toMatchObject({ kind: "proposed" });
      await resolveChanges(client, "accept");
      const shown = shownWithChanges(client);
      expect(shown).toHaveLength(2);
      expect(shown).toEqual(expect.arrayContaining([title, sentence]));
    },
  );

  // protects=no shape a model writes the mark in puts its words, or the tag, into the Note: a mark closed later on its line, one never closed, a close alone, an empty one; fails_when=“removed” or a quoted word lands as text; no_claim=that a model should write these shapes.
  test.each([
    `<removed/>${SECOND}</removed>`,
    `<removed>${SECOND}`,
    `</removed>\n\n<removed>${SECOND}</removed>`,
    `<removed/>\n\n<removed>${SECOND}</removed>`,
    `<REMOVED>${SECOND}</REMOVED>`,
  ])("a mark written as %s is no text of the Note, and takes out what it quotes", async (mark) => {
    const { core, client, asked } = await threeParagraphs(
      () => `${FIRST}\n\n${THIRD}\n\n${mark}\n<why>Removed.</why>`,
    );

    await core.editWithAi(asked("Drop the middle one"));

    expect(shownWithChanges(client)).toEqual([FIRST, `- ${SECOND}`, THIRD]);
  });

  // protects=a mark never closed quotes only its own paragraph, so the paragraphs written after it stay as text; fails_when=a paragraph after it is taken out or lost; no_claim=that a model leaves marks open.
  test("an unclosed mark in the middle of a reply quotes only its own paragraph", async () => {
    const { core, client, asked } = await threeParagraphs(
      () => `${FIRST}\n\n<removed>${SECOND}\n\n${THIRD}\n<why>Removed.</why>`,
    );

    await core.editWithAi(asked("Drop the middle one"));

    expect(shownWithChanges(client)).toEqual([FIRST, `- ${SECOND}`, THIRD]);
  });

  // protects=typed text that only starts like the mark, such as <removed-items>, is the User's and comes back as typed; fails_when=it is read as a mark and the words after it are lost; no_claim=how a model words the rest.
  test("typed text like <removed-items> or <removed:x> is no mark", async () => {
    const typed =
      "Keep <removed-items> and <removed:x> in the list. The office posts the times each week.";
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replace("each week", "weekly")),
    );
    const note = paragraph(text(typed));
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Say weekly"),
    );

    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([typed.replace("each week", "weekly")]);
  });

  // protects=words quoted inside a paragraph are taken out of it, and the rest of the paragraph is kept as it was; in Chinese too; fails_when=the quoted words stay, or the paragraph goes whole; no_claim=that a real model quotes words this way.
  test.each([
    {
      line: SECOND,
      words: " and a lot of boats don't leave at low water",
      reply: "It's a big harbour <removed>and a lot of boats don't leave at low water</removed>.",
    },
    {
      line: "港口很大，低潮时很多船不出港。",
      words: "，低潮时很多船不出港",
      reply: "港口很大<removed>，低潮时很多船不出港</removed>。",
    },
  ])(
    "words quoted inside a paragraph are taken out of it: $reply",
    async ({ line, words, reply }) => {
      const { core, mind, client } = await setUp(editingModel(() => reply));
      const note = paragraph(text(line));
      writeMind(client, [note]);
      await client.settled();

      const result = await core.editWithAi(
        wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Drop the second half"),
      );

      expect(result).toMatchObject({ kind: "proposed" });
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([line.replace(words, "")]);
    },
  );

  test("a reply that quotes all of the passage as taken out takes out every paragraph, and applies", async () => {
    const { core, client, asked } = await threeParagraphs(
      () => `<removed>${FIRST}\n\n${SECOND}\n\n${THIRD}</removed>\n<why>Removed.</why>`,
    );

    const result = await core.editWithAi(asked("Get rid of all of it"));

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("leftOut");
    expect(shownWithChanges(client)).toEqual([`- ${FIRST}`, `- ${SECOND}`, `- ${THIRD}`]);
  });

  // protects=the mark and its words are never shown while they stream in, four characters at a time; fails_when=the Mind, at any moment, holds "<remo", "removed>" or a quoted word as new text; no_claim=the Proposals' look.
  test.each([
    {
      reply: [FIRST, `<removed>${SECOND}</removed>`, THIRD].join("\n\n"),
      shows: [FIRST, `- ${SECOND}`, THIRD],
    },
    {
      reply: [FIRST, `<removed>${SECOND}</removed>`, THIRD].join("\n"),
      shows: [FIRST, `- ${SECOND}`, THIRD],
    },
    {
      reply: `<removed>${FIRST}\n\n${SECOND}\n\n${THIRD}</removed>\n<why>Removed.</why>`,
      shows: [`- ${FIRST}`, `- ${SECOND}`, `- ${THIRD}`],
    },
  ])("the streamed mark is never shown: $reply", async ({ reply, shows }) => {
    const { core, mind, client, asked } = await threeParagraphs(() => reply);
    const seen: string[] = [];
    const stop = core.on("mind.update", (event) => {
      if (event.mindId === mind.id) seen.push(shownWithChanges(client).join("\n"));
    });

    await core.editWithAi(asked("Remove the second paragraph"));
    stop();

    expect(seen.join("\n")).not.toMatch(/<remo|removed>|^\+ /m);
    expect(seen.length).toBeGreaterThan(0);
    expect(shownWithChanges(client)).toEqual(shows);
  });

  // protects=text typed like the mark is the User's, shown to the model escaped and read back as typed; fails_when=it is taken for the mark, or comes back with a backslash; no_claim=how a model words it.
  test("a typed <removed> in the Note is escaped for the model and read back as text", async () => {
    const calls: EditCall[] = [];
    const typed =
      "Write <removed>words</removed> where words go, and \\<removed> for the tag itself.";
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replace("itself", "alone"), calls),
    );
    const note = paragraph(text(typed));
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Say alone"),
    );

    expect(calls[0]?.passage).toBe(
      "¶1 Write \\<removed>words\\</removed> where words go, and \\\\\\<removed> for the tag itself.",
    );
    expect(result).toMatchObject({ kind: "proposed" });
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([typed.replace("itself", "alone")]);
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

describe("How a change reads (#1028)", () => {
  const heading = (value: string): JSONContent => ({
    type: "heading",
    attrs: { id: `block-${++ids}`, level: 2 },
    content: [text(value)],
  });
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

    await core.editWithAi({ ...everything(client, mind.id, "Make it clearer"), action: "improve" });
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

    await core.editWithAi({
      ...everything(client, mind.id, "Rename the heading"),
      action: "improve",
    });
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "[-Highlights and points to check-]{+Key strengths+}",
      "Spring tides are strongest at new moon.",
    ]);
  });

  // protects=a list item about something else in the place of another is added as a new item, never written into the old one word by word (the degree never turns into the job), and the old one stays unless the reply quotes it as taken out (#2333); fails_when=old and new words interleave, or the degree is taken out unquoted; no_claim=what a real model quotes.
  test("a list item about something else in another's place is added, and the old one stays: the degree never turns into the job", async () => {
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
      "2018.09—2020.06 复旦大学 金融学 硕士",
    ]);
  });

  // protects=asked to replace a list item without the reply quoting it, the new item comes and the old one stays, offered for removal as left out, since a reply's new line takes no paragraph's place by its place alone (#2333); never read as a translation; fails_when=the old item is written over or taken out unquoted; no_claim=what a real model quotes.
  test("asked to replace a list item, without the reply quoting it, the new item comes and the old one stays as left out: not read as a translation", async () => {
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

    expect(result).toMatchObject({ kind: "proposed", leftOut: [{ kind: "bullet", whole: true }] });
    expect(shownWhole(client)).toEqual([
      "经历",
      "2012.09—2016.06 复旦大学 金融学 学士",
      `+ ${job}`,
      degree,
    ]);
    await resolveChanges(client, "accept");
    expect(shownWhole(client)).toEqual([
      "经历",
      "2012.09—2016.06 复旦大学 金融学 学士",
      job,
      degree,
    ]);
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

    await core.editWithAi({
      ...everything(client, mind.id, "把日期改对，第二段重写"),
      action: "improve",
    });
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "[-2017.05—2017.04-]{+2017.05—2018.09+} 某咨询公司 分析师",
      `[-${before[1]}-]{+${after[1]}+}`,
    ]);
  });
});

describe("Edit with AI keeps bold and italic (#1897)", () => {
  /** Each text node of the Mind's first paragraph with the names of its marks. */
  const runsOf = (client: MindClient, at = 0) =>
    (readMind(client).child(at).toJSON().content as JSONContent[]).map((node) => ({
      text: node.text,
      marks: (node.marks ?? []).map((mark: { type: string }) => mark.type),
    }));

  test("the model sees what is bold, and a reply that keeps the label bold changes only the words it changed", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(
        () => "**Role.** The post is senior and well paid. **Hours.** Full time, with Fridays off.",
        calls,
      ),
    );
    const note = paragraph(
      text("Role.", "bold"),
      text(" The post is senior. "),
      text("Hours.", "bold"),
      text(" Full time."),
    );
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Make it longer."),
    );

    expect(calls[0]?.passage).toBe("¶1 **Role.** The post is senior. **Hours.** Full time.");
    expect(calls[0]?.system).toContain("between ** and ** or * and *");
    expect(result).toMatchObject({ kind: "proposed", proposals: 2 });
    expect(shownWithChanges(client)).toEqual([
      "Role. The post is senior{+ and well paid+}. Hours. Full time{+, with Fridays off+}.",
    ]);
    await resolveChanges(client, "accept");
    const runs = runsOf(client);
    expect(runs.map((run) => run.text).join("")).not.toContain("*");
    expect(runs.filter((run) => run.marks.includes("bold")).map((run) => run.text)).toEqual([
      "Role.",
      "Hours.",
    ]);
  });

  test("bold and italic the model adds are bold and italic, with no asterisks left", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "Spring tides are strong. The harbour is **busy** and *calm*."),
    );
    const note = paragraph(text("Spring tides are strong."));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Add the harbour."),
    );
    await resolveChanges(client, "accept");

    const runs = runsOf(client);
    expect(runs.map((run) => run.text).join("")).toBe(
      "Spring tides are strong. The harbour is busy and calm.",
    );
    expect(runs.find((run) => run.text?.includes("busy"))?.marks).toContain("bold");
    expect(runs.find((run) => run.text?.includes("calm"))?.marks).toContain("italic");
    expect(runs.find((run) => run.text?.includes("harbour"))?.marks).not.toContain("bold");
    expect(runs.find((run) => run.text?.includes("Spring"))?.marks).not.toContain("bold");
  });

  test("a bold label next to Chinese punctuation stays bold, and what the model adds is read the same", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "**角色：**该职位为高级职位，薪酬较高。**工时：**全职。"),
    );
    const note = paragraph(text("角色：", "bold"), text("该职位为高级职位。"));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "写长一点。"),
    );
    await resolveChanges(client, "accept");

    const runs = runsOf(client);
    expect(runs.map((run) => run.text).join("")).toBe(
      "角色：该职位为高级职位，薪酬较高。工时：全职。",
    );
    expect(runs.filter((run) => run.marks.includes("bold")).map((run) => run.text)).toEqual([
      "角色：",
      "工时：",
    ]);
  });

  test.each([
    [
      "Total = price*volume*margin, see note.",
      "Total = price\\*volume\\*margin, see note.",
      "Total = price\\*volume\\*margin.",
      "Total = price*volume*margin.",
    ],
    [
      "Multiply 2*3*4 and add 1.",
      "Multiply 2\\*3\\*4 and add 1.",
      "Multiply 2\\*3\\*4 and add one.",
      "Multiply 2*3*4 and add one.",
    ],
    [
      "Use a_b_c as the key here.",
      "Use a\\_b\\_c as the key here.",
      "Use a\\_b\\_c as the key.",
      "Use a_b_c as the key.",
    ],
    [
      "Strike ~~ is two tildes.",
      "Strike \\~\\~ is two tildes.",
      "Strike \\~\\~ is two tildes, no more.",
      "Strike ~~ is two tildes, no more.",
    ],
    [
      "第3*4项是总额，另见说明。",
      "第3\\*4项是总额，另见说明。",
      "第3\\*4项是总额。",
      "第3*4项是总额。",
    ],
  ])(
    "a * _ or ~ the User typed is shown to the model escaped and comes back as itself: %s",
    async (typed, shown, reply, written) => {
      const calls: EditCall[] = [];
      const { core, mind, client } = await setUp(editingModel(() => reply, calls));
      const note = paragraph(text(typed));
      writeMind(client, [note]);
      await client.settled();

      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "shorten"));
      await resolveChanges(client, "accept");

      expect(calls[0]?.passage).toBe(shown);
      const runs = runsOf(client);
      expect(runs.map((run) => run.text).join("")).toBe(written);
      expect(
        runs.every((run) => !run.marks.includes("italic") && !run.marks.includes("bold")),
      ).toBe(true);
    },
  );

  test("a model that writes the escapes back keeps the typed characters", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "Total = price\\*volume\\*margin, see the note."),
    );
    const note = paragraph(text("Total = price*volume*margin, see note."));
    writeMind(client, [note]);
    await client.settled();

    await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve"));

    expect(shownWithChanges(client)).toEqual(["Total = price*volume*margin, see {+the +}note."]);
  });

  test("an instruction to make words bold is applied to those words and leaves the others as they were", async () => {
    const { core, mind, client } = await setUp(
      editingModel(() => "Spring tides are **strong** and neap tides are **weak**."),
    );
    const note = paragraph(text("Spring tides are strong and neap tides are weak."));
    writeMind(client, [note]);
    await client.settled();

    const result = await core.editWithAi(
      wholeParagraph(client, mind.id, note.attrs.id, "instruction", "Make the key terms bold."),
    );

    expect(result).toMatchObject({ kind: "proposed", proposals: 2 });
    expect(shownWithChanges(client)).toEqual([
      "Spring tides are [-strong-]{+strong+} and neap tides are [-weak-]{+weak+}.",
    ]);
    await resolveChanges(client, "accept");
    const runs = runsOf(client);
    expect(runs.map((run) => run.text).join("")).toBe(
      "Spring tides are strong and neap tides are weak.",
    );
    expect(runs.filter((run) => run.marks.includes("bold")).map((run) => run.text)).toEqual([
      "strong",
      "weak",
    ]);
  });

  test("a model that drops the bold of a label without changing a word gives nothing to review, and the label stays bold", async () => {
    const { core, mind, client } = await setUp(editingModel(() => "Role. The post is senior."));
    const note = paragraph(text("Role.", "bold"), text(" The post is senior."));
    writeMind(client, [note]);
    await client.settled();

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toEqual({ kind: "unchanged" });
    expect(runsOf(client)[0]).toMatchObject({ text: "Role.", marks: ["bold"] });
  });

  test("a reply that only changes the look gives nothing to review", async () => {
    const { core, mind, client } = await setUp(editingModel(() => "Role. The post is senior."));
    const note = paragraph(text("Role.", "bold"), text(" The post is senior."));
    writeMind(client, [note]);
    await client.settled();

    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, note.attrs.id, "improve")),
    ).toEqual({ kind: "unchanged" });
    expect(pendingProposals(client.blocks)).toEqual([]);
  });
});

const plain = (lines: readonly string[]) => lines.map((line) => paragraph(text(line)));

/** A Note of these Blocks, and a model that answers every edit with `reply`. */
async function noteOf(
  blocks: JSONContent[],
  reply: (call: EditCall) => string | Promise<string>,
  options: { finished?: "stop" | "length" } = {},
) {
  const calls: EditCall[] = [];
  const set = await setUp(editingModel(reply, calls, options));
  writeMind(set.client, blocks);
  await set.client.settled();
  return { ...set, calls, before: readMind(set.client).toJSON() };
}

/** Accepts the edit as the window does and gives what the Note shows; then Undo, and the Note is exactly `before`. */
async function acceptThenUndo(client: MindClient, before: unknown): Promise<string[]> {
  const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
  await resolveChanges(client, "accept");
  const accepted = shownWithChanges(client);
  undo.undo();
  await client.settled();
  await resolveChanges(client, "reject");
  expect(readMind(client).toJSON()).toEqual(before);
  return accepted;
}

describe("An edit never loses the User's words (#2333)", () => {
  // protects=a <removed> the User typed stays their text when the model writes it back without the backslash the passage showed it with, while the reply's own mark still takes out what it quotes; English and Chinese; fails_when=the typed tags, or the words after or between them, leave the Note; no_claim=how often a real model drops the escape.
  test.each([
    {
      typed: "Write <removed>draft</removed> in the subject line.",
      from: "Write",
      to: "Type",
      gone: "Old line to drop.",
    },
    {
      typed: "Start a cut with <removed> and end it with the closing tag.",
      from: "Start",
      to: "Begin",
      gone: "Old line to drop.",
    },
    {
      typed: "在主题行写<removed>草稿</removed>即可。",
      from: "即可",
      to: "就行",
      gone: "这一行可以删掉。",
    },
  ])("a typed mark written back without its escape stays text: $typed", async (each) => {
    const { core, mind, client, calls, before } = await noteOf(
      plain([each.typed, each.gone]),
      ({ passage }) =>
        [
          (passage.split("\n\n")[0] ?? "").replaceAll("\\<", "<").replace(each.from, each.to),
          `<removed>${each.gone}</removed>`,
        ].join("\n\n"),
    );

    const result = await core.editWithAi(
      wholeMind(client, mind.id, "Fix the wording and drop the last line"),
    );

    expect(calls[0]?.passage).toContain("\\<removed>");
    expect(result).toMatchObject({ kind: "proposed" });
    expect(await acceptThenUndo(client, before)).toEqual([each.typed.replace(each.from, each.to)]);
  });

  // protects=words the User types into a paragraph while the model works stay when the reply takes that paragraph out whole: that change arrives out of date and is never accepted, while a paragraph the same reply takes out that the User didn't touch goes; English and Chinese; fails_when=the typed words go with the paragraph, or the untouched one stays; no_claim=what the window shows for the change out of date.
  test.each([
    {
      lines: [
        "Rent is due on the first.",
        "Keys are at the front desk.",
        "Water is billed quarterly.",
      ],
      typed: " Bring the fob.",
    },
    { lines: ["房租每月一号交。", "钥匙在前台。", "水费按季度收。"], typed: "记得带门禁卡。" },
  ])(
    "words typed meanwhile stay in a paragraph the edit takes out: $typed",
    async ({ lines, typed }) => {
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const [rent = "", keys = "", water = ""] = lines;
      const { core, mind, client, calls } = await noteOf(plain(lines), async () => {
        await waiting;
        return [`<removed>${rent}</removed>`, `<removed>${keys}</removed>`, water].join("\n\n");
      });

      const editing = core.editWithAi(wholeMind(client, mind.id, "Delete the rent and keys lines"));
      await expect.poll(() => calls.length).toBe(1);
      const words = (client.blocks.get(1) as Y.XmlElement).get(0) as Y.XmlText;
      words.insert(words.length, typed);
      await client.settled();
      const before = readMind(client).toJSON();
      release();

      expect(await editing).toMatchObject({ kind: "proposed", outOfDate: 1 });
      const accepted = await acceptThenUndo(client, before);
      // The change to the paragraph typed into still waits, out of date: the Note reads with its words.
      expect(accepted).toEqual([`- ${keys}${typed}`, water]);
      expect(await exported(core, mind.id)).toContain(`${keys}${typed}`);
    },
  );

  // protects=a reply that ends at its output limit changes nothing, for a fixed action and a request in the User's words alike, and fails as cut short, while the same reply ended in full is applied as Shorten; English and Chinese; fails_when=the paragraphs after the cut are proposed for deletion, or the last one is written over with its cut text; no_claim=which providers report the limit.
  test.each([
    {
      lines: [
        "Rent is due on the first of each month.",
        "Keys are at the front desk downstairs.",
        "Water is billed every quarter by the city.",
      ],
      reply: "Rent is due on the first.\n\nKeys are at the fr",
    },
    {
      lines: ["房租在每个月的一号交给房东。", "钥匙放在楼下的前台。", "水费由市里每个季度收一次。"],
      reply: "房租每月一号交。\n\n钥匙在",
    },
  ])("a reply cut off at its limit changes nothing: $reply", async ({ lines, reply }) => {
    for (const action of ["shorten", "instruction"] as const) {
      const { core, mind, client } = await noteOf(plain(lines), () => reply, {
        finished: "length",
      });

      const result = await core.editWithAi({
        ...wholeMind(client, mind.id, "Make it shorter"),
        action,
      });

      expect(result).toMatchObject({ kind: "failed", error: { kind: "cut-short" } });
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(shownWithChanges(client)).toEqual(lines);
    }
    const ended = await noteOf(plain(lines), () => reply);
    expect(
      await ended.core.editWithAi({
        ...wholeMind(ended.client, ended.mind.id, "Make it shorter"),
        action: "shorten",
      }),
    ).toMatchObject({ kind: "proposed" });
    expect(shownWithChanges(ended.client)).not.toEqual(lines);
  });

  const SANDWICH = [
    "The project starts in March with a kickoff in Leeds.",
    "Dana leads the design work and reports weekly.",
    "The budget is 40,000 euros, with travel capped at 5,000.",
    "Testing runs through May on two pilot sites.",
    "The final report is due at the end of June.",
  ];
  const SANDWICH_ZH = [
    "项目三月启动，在利兹开启动会。",
    "达娜负责设计，每周汇报。",
    "预算四万欧元，差旅上限五千。",
    "测试持续到五月，在两个试点进行。",
    "最终报告六月底提交。",
  ];

  const COSTS = {
    English: {
      lines: ["Rent is 1,200 a month.", "Parking is 100 a month.", "Water is 30 a month."],
      added: "Internet is 40 a month.",
      changed: "Parking is 120 a month.",
      translated: [
        "Le loyer est de 1 200 par mois.",
        "Le parking coûte 100 par mois.",
        "L'eau coûte 30 par mois.",
      ],
    },
    Chinese: {
      lines: ["房租每月1200元。", "停车每月100元。", "物业每月30元。"],
      added: "网络每月40元。",
      changed: "停车每月120元。",
      translated: [
        "Rent is 1,200 yuan a month.",
        "Parking is 100 yuan a month.",
        "Building fees are 30 yuan a month.",
      ],
    },
  };

  // protects=a new line on the pattern of the selection's lines, after one of them as context, is added, and every line stays, in English and Chinese; Undo takes it back exactly; fails_when=it is written over the nearest line or the one after the context; no_claim=where a real model puts a new line.
  test.each(["English", "Chinese"] as const)(
    "a partial reply's new line is added beside lines like it: %s",
    async (language) => {
      const { lines, added } = COSTS[language];
      const reply = [lines[1], added].join("\n\n");
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      const result = await core.editWithAi(wholeMind(client, mind.id, "Add a line for internet"));

      expect(result).toMatchObject({ kind: "proposed" });
      const accepted = await acceptThenUndo(client, before);
      expect(accepted).toHaveLength(4);
      expect(accepted).toEqual(expect.arrayContaining([...lines, added]));
    },
  );

  // protects=with the passage shown with names, a reply that names no paragraph, writes in none's place, quotes none and would only add plain lines is the model's own words (#2356): shown with the problem, never written, the Note exactly as it was, in English and Chinese, whether it reads as a line or as talk; fails_when=its words go into the Note or wait there; no_claim=what a real model says instead of a change.
  test.each([
    { lines: COSTS.English.lines, reply: COSTS.English.added },
    { lines: COSTS.Chinese.lines, reply: COSTS.Chinese.added },
    {
      lines: COSTS.English.lines,
      reply: "No spelling mistakes appear in the passage, so nothing needs to change.",
    },
    {
      lines: COSTS.Chinese.lines,
      reply: "I checked the passage for typos and found none, so nothing needs changing.",
    },
    { lines: COSTS.Chinese.lines, reply: "没有发现错别字。\n\n原文无需修改。" },
  ])(
    "a reply naming no paragraph that only adds lines is shown: $reply",
    async ({ lines, reply }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      const result = await core.editWithAi(wholeMind(client, mind.id, "Fix any typos"));

      expect(result).toEqual({ kind: "unchanged", said: reply.replace("\n\n", " ") });
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(readMind(client).toJSON()).toEqual(before);
    },
  );

  // protects=a partial reply that rewrites one line of several alike changes that line and no other, and a rewrite of every line (a translation asked in the User's words) still pairs each with the one in its place; English and Chinese; fails_when=the rewrite is added beside its line, or the translation is added under the lines it translates; no_claim=how a real model words either.
  test.each(["English", "Chinese"] as const)(
    "a line rewritten changes that line, and a translation of all takes their places: %s",
    async (language) => {
      const { lines, changed, translated } = COSTS[language];
      const one = await noteOf(plain(lines), () => changed);
      await one.core.editWithAi(wholeMind(one.client, one.mind.id, "Make parking 120"));
      expect(await acceptThenUndo(one.client, one.before)).toEqual([lines[0], changed, lines[2]]);

      const all = await noteOf(plain(lines), () => translated.join("\n\n"));
      await all.core.editWithAi(wholeMind(all.client, all.mind.id, "Translate it"));
      expect(await acceptThenUndo(all.client, all.before)).toEqual(translated);
    },
  );

  // protects=a paragraph the reply doesn't name is never written over or taken out (review of #2344): lines after the last paragraph the reply keeps (X1, a bold first line too), a heading, list item, table or quote between two kept paragraphs, and two new lines alone (X4) are added, every paragraph stays, and Undo then reject restores the Note exactly; English and Chinese; fails_when=a stray or new line takes a paragraph's place by position; no_claim=what a real model writes.
  test.each([
    {
      name: "X1",
      blocks: plain([
        "Owner: Sam signs the lease.",
        "Keys are at the desk.",
        "Water is 30 a month.",
      ]),
      reply: ["Owner: Sam signs the lease.", "Changed to:", "Ann also signs."],
      added: ["Changed to:", "Ann also signs."],
    },
    {
      name: "X1, bold",
      blocks: [
        paragraph(text("Owner: ", "bold"), text("Sam signs the lease.")),
        ...plain(["Keys are at the desk.", "Water is 30 a month."]),
      ],
      reply: ["**Owner:** Sam signs the lease.", "Changed to:", "Ann also signs."],
      added: ["Changed to:", "Ann also signs."],
    },
    {
      name: "X1 中文",
      blocks: plain(["业主：山姆签租约。", "钥匙在前台。", "水费每月30元。"]),
      reply: ["业主：山姆签租约。", "改为：", "安也签字。"],
      added: ["改为：", "安也签字。"],
    },
    {
      name: "X4",
      blocks: plain([
        "The team is Dana and Ben.",
        "Dana leads design.",
        "Ben runs vendors.",
        "We meet on Mondays.",
      ]),
      reply: ["¶+ Chloe runs the pilots.", "¶+ Eve writes the report."],
      added: ["Chloe runs the pilots.", "Eve writes the report."],
    },
    {
      name: "X4 中文",
      blocks: plain(["团队有达娜和本。", "达娜负责设计。", "本负责供应商。", "每周一开会。"]),
      reply: ["¶+ 克洛伊负责试点。", "¶+ 伊芙撰写报告。"],
      added: ["克洛伊负责试点。", "伊芙撰写报告。"],
    },
    ...[
      ["## Next steps", "Next steps"],
      ["- Book the venue in Leeds.", "Book the venue in Leeds."],
      ["| Site | Dates |\n|---|---|\n| North | May |", "Site"],
      ["> Dana: the pilot looks good.", "Dana: the pilot looks good."],
    ].map(([written = "", shown = ""]) => ({
      name: `between kept paragraphs: ${shown}`,
      blocks: plain(SANDWICH),
      reply: [SANDWICH[0] ?? "", written, SANDWICH[2] ?? ""],
      added: [shown],
    })),
    ...[
      ["## 下一步", "下一步"],
      ["- 在利兹预订场地。", "在利兹预订场地。"],
      ["| 地点 | 日期 |\n|---|---|\n| 北区 | 五月 |", "地点"],
      ["> 达娜：试点看起来不错。", "达娜：试点看起来不错。"],
    ].map(([written = "", shown = ""]) => ({
      name: `中文，夹在两段之间：${shown}`,
      blocks: plain(SANDWICH_ZH),
      reply: [SANDWICH_ZH[0] ?? "", written, SANDWICH_ZH[2] ?? ""],
      added: [shown],
    })),
  ])("a paragraph the reply doesn't name stays: $name", async ({ blocks, reply, added }) => {
    const { core, mind, client, before } = await noteOf(blocks, () => reply.join("\n\n"));
    const lines = shownWithChanges(client);

    await core.editWithAi(wholeMind(client, mind.id, "Change it"));

    const accepted = await acceptThenUndo(client, before);
    expect(accepted).toEqual(expect.arrayContaining(lines));
    for (const line of added) expect(accepted.some((each) => each.includes(line))).toBe(true);
  });

  // protects=between two places the reply holds, several lines take the places of as many paragraphs only when each is more than half like the one in its place (review of #2344): a stray line and a new one between two kept paragraphs (N04f) are added, and the two paragraphs in their places stay, offered for removal as left out; Undo then reject restores the Note; English and Chinese; fails_when=Keys and Water are written over; no_claim=what a real model writes.
  test.each([
    {
      name: "N04f",
      lines: [
        "Owner: Sam signs the lease.",
        "Keys are at the desk.",
        "Water is 30 a month.",
        "Pay is monthly.",
      ],
      written: ["Changed to:", "Ann also signs."],
    },
    {
      name: "N04f 中文",
      lines: ["业主：山姆签租约。", "钥匙在前台。", "水费每月30元。", "工资按月发放。"],
      written: ["改为：", "安也签字。"],
    },
  ])(
    "a stray line and a new one between two kept paragraphs write over neither: $name",
    async ({ lines, written }) => {
      const [first = "", , , last = ""] = lines;
      const { core, mind, client, before } = await noteOf(plain(lines), () =>
        [first, ...written, last].join("\n\n"),
      );

      const result = await core.editWithAi(wholeMind(client, mind.id, "Change it"));

      expect(result).toMatchObject({
        kind: "proposed",
        leftOut: [{ whole: true }, { whole: true }],
      });
      const accepted = await acceptThenUndo(client, before);
      expect(accepted).toEqual(expect.arrayContaining([...lines, ...written]));
      expect(accepted).toHaveLength(6);
    },
  );

  test.each([
    { lines: SANDWICH, between: "The office moves to York in May." },
    { lines: SANDWICH_ZH, between: "办公室五月搬到约克。" },
  ])(
    "a plain paragraph between two kept ones takes the place of the one between: $between",
    async ({ lines, between }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () =>
        [lines[0], between, lines[2]].join("\n\n"),
      );

      await core.editWithAi(wholeMind(client, mind.id, "Change the second paragraph"));

      expect(await acceptThenUndo(client, before)).toEqual([lines[0], between, ...lines.slice(2)]);
    },
  );

  // protects=a list item about something else between two items the reply keeps takes the place of the item there: anchored on both sides, the old item goes whole and the new one comes once, never written into it word by word (#1028), and Undo then reject restores the Note; English and Chinese; fails_when=the old item stays as left out beside the new one; no_claim=what a real model writes.
  test.each([
    {
      items: [
        "Led quarterly forecasting for a team of twelve analysts",
        "Presented findings to the board every month",
        "Cut the month-end close from ten days to six",
      ],
      made: "Ran the vendor review",
    },
    {
      items: [
        "2012.09—2016.06 复旦大学 金融学 学士",
        "2016.09—2018.06 上海财经大学 会计学 硕士",
        "2018.07—2020.06 某银行 管培生",
      ],
      made: "2020.07—至今 Deloitte Touche Tohmatsu, Senior Manager",
    },
  ])(
    "a list item between two kept ones takes the place of the one between: $made",
    async ({ items, made }) => {
      const [first = "", old = "", last = ""] = items;
      const { core, mind, client, before } = await noteOf([bullets(...items)], () =>
        [first, made, last].map((item) => `- ${item}`).join("\n\n"),
      );

      const result = await core.editWithAi(wholeMind(client, mind.id, "Replace the second item"));

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("leftOut");
      expect(shownWhole(client)).toEqual([first, `+ ${made}`, `- ${old}`, last]);
      expect(await acceptThenUndo(client, before)).toEqual([first, made, last]);
    },
  );

  // protects=a reply starts where the selection starts, so a first line renamed in words it shares none of, before a line the reply keeps, takes the first line's place; English and Chinese; fails_when=the new name is added beside the old one, which stays as left out; no_claim=a reply that drops the first line and starts with a stray one, which this reads the same.
  test.each([
    {
      lines: ["Harbour office", "Tides rise twice a day, and the harbour office posts the times."],
      reply: ["Port authority", "Tides rise twice a day, and the port authority posts the times."],
    },
    {
      lines: ["海港办公室", "潮水每天涨落两次，海港办公室每周公布潮汐时间。"],
      reply: ["港务局", "潮水每天涨落两次，港务局每周公布潮汐时间。"],
    },
  ])(
    "a first line renamed before a kept one takes its place: $reply.0",
    async ({ lines, reply }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply.join("\n\n"));

      const result = await core.editWithAi(wholeMind(client, mind.id, "Rename it"));

      expect(result).not.toHaveProperty("leftOut");
      expect(await acceptThenUndo(client, before)).toEqual(reply);
    },
  );

  // protects=a short stray line all of whose words a paragraph has ("Changed to:", "Here it is:", "Done.", "A", 改为：, 完成。) never takes that paragraph's place (review of #2344): it is added, the paragraph stays, and Undo then reject restores the Note; English and Chinese; fails_when=the paragraph is written over; no_claim=what a real model writes.
  test.each([
    { stray: "Changed to:", holding: "The lease is changed to a yearly one." },
    { stray: "Here it is:", holding: "Here it is, the lease signed by both of us on Friday." },
    { stray: "Done.", holding: "The inventory of the flat is done." },
    { stray: "A", holding: "A new lock was fitted on the door." },
    { stray: "改为：", holding: "租期改为一年，押金不变。" },
    { stray: "完成。", holding: "公寓的物品清点已经完成。" },
  ])(
    "a short stray line never takes the place of a paragraph that has its words: $stray",
    async ({ stray, holding }) => {
      const first = /\p{Script=Han}/u.test(stray)
        ? "业主：山姆签租约。"
        : "Owner: Sam signs the lease.";
      const { core, mind, client, before } = await noteOf(plain([first, holding]), () =>
        [first, stray].join("\n\n"),
      );

      await core.editWithAi(wholeMind(client, mind.id, "Change it"));

      const accepted = await acceptThenUndo(client, before);
      expect(accepted).toEqual(expect.arrayContaining([first, holding]));
      expect(accepted).toContain(stray);
    },
  );

  // protects=typed tags are matched to the User's at their place (review of #2344): a model mark on the same word in another paragraph takes out that word while the typed tags stay (T9); tags the reply kept escaped answer first, so a mark beside them on one side still applies; an open tag is never taken for a typed close tag; a mark that could be the typed one or the model's refuses the edit; English and Chinese; fails_when=the typed tags or their word leave the Note, literal tags land in the Note, or a guess is applied; no_claim=how a real model writes tags.
  test.each([
    {
      name: "T9",
      lines: ["Also draft the body.", "Write <removed>draft</removed> in the subject."],
      reply:
        "Also <removed>draft</removed> the body.\n\nWrite <removed>draft</removed> in the subject.",
      after: ["Also the body.", "Write <removed>draft</removed> in the subject."],
    },
    {
      name: "T9 中文",
      lines: ["正文先留草稿。", "在主题行写<removed>草稿</removed>。"],
      reply: "正文先留<removed>草稿</removed>。\n\n在主题行写<removed>草稿</removed>。",
      after: ["正文先留。", "在主题行写<removed>草稿</removed>。"],
    },
    {
      name: "escaped first",
      lines: ["Write <removed>draft</removed> in the subject.", "Also draft the body."],
      reply:
        "Type \\<removed>draft\\</removed> in the subject.\n\nAlso <removed>draft</removed> the body.",
      after: ["Type <removed>draft</removed> in the subject.", "Also the body."],
    },
    {
      name: "escaped first 中文",
      lines: ["在主题行写<removed>草稿</removed>。", "正文先留草稿。"],
      reply: "在主题行里写\\<removed>草稿\\</removed>。\n\n正文先留<removed>草稿</removed>。",
      after: ["在主题行里写<removed>草稿</removed>。", "正文先留。"],
    },
    {
      name: "tag kind",
      lines: ["A cut ends at </removed>Budget notes.", "Budget notes go here."],
      reply:
        "A cut ends at </removed>Budget notes now.\n\n<removed>Budget notes go here.</removed>",
      after: ["A cut ends at </removed>Budget notes now."],
    },
    {
      name: "tag kind 中文",
      lines: ["剪切到</removed>预算说明写在这里结束。", "预算说明写在这里结束了。"],
      reply:
        "剪切到</removed>预算说明写在这里结束为止。\n\n<removed>预算说明写在这里结束了。</removed>",
      after: ["剪切到</removed>预算说明写在这里结束为止。"],
    },
  ])("a typed tag is matched at its place: $name", async ({ lines, reply, after }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    expect(await core.editWithAi(wholeMind(client, mind.id, "Fix it"))).toMatchObject({
      kind: "proposed",
    });

    expect(await acceptThenUndo(client, before)).toEqual(after);
  });

  test.each([
    {
      lines: ["Also draft the body.", "Write <removed>draft</removed> in the subject."],
      reply:
        "Please <removed>draft</removed> the body.\n\nType <removed>draft</removed> in the subject.",
    },
    {
      lines: ["正文先留草稿。", "在主题行写<removed>草稿</removed>。"],
      reply: "正文删去<removed>草稿</removed>两字。\n\n主题行里写<removed>草稿</removed>。",
    },
  ])(
    "a mark that could be the typed one or the model's refuses the edit: $reply",
    async ({ lines, reply }) => {
      const { core, mind, client } = await noteOf(plain(lines), () => reply);

      const result = await core.editWithAi(wholeMind(client, mind.id, "Fix it"));

      expect(result).toMatchObject({ kind: "unplaced" });
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(shownWithChanges(client)).toEqual(lines);
    },
  );

  const TYPED_ZH = [
    "备忘录定稿前，主题行里写<removed>草稿</removed>。",
    "周五发给全组。",
    "在共享文件夹里留一份。",
  ];
  const TYPED_EN = [
    "Write <removed>draft</removed> in the subject line until the memo is final.",
    "Send it to the team on Friday.",
    "Keep a copy in the shared folder.",
  ];

  // protects=a rewrite that leaves out a <removed> the User typed is refused with its own problem, and the Note is exactly as it was, nothing waiting (#2356): Claude Haiku 5.5's three replies to "改得更正式一些。" that wrote the typed tags as quotation marks, the same in English, and a reply naming no paragraph that drops one, read by its words; the action Shorten too; fails_when=the typed tags leave the Note, or the edit reads as done; no_claim=how often a real model drops one.
  test.each([
    {
      lines: TYPED_ZH,
      reply:
        "¶1 备忘录定稿前，主题行请注明“草案”字样。\n\n¶2 请于周五发送全组。\n\n¶3 并请在共享文件夹中留存一份备份。",
    },
    {
      lines: TYPED_ZH,
      reply:
        "¶1 备忘录定稿前，主题行请注明“草稿”字样。\n\n¶2 请于周五发送至全组。\n\n¶3 同时在共享文件夹中存档一份。",
    },
    {
      lines: TYPED_ZH,
      reply:
        '¶1 备忘录定稿前，主题行中请注明"草稿"字样。\n\n¶2 请于周五发送至全组。\n\n¶3 并在共享文件夹中留存一份备份。',
    },
    {
      lines: TYPED_EN,
      reply:
        '¶1 Mark the subject line "draft" until the memo is final.\n\n¶2 Please send it to the team on Friday.',
    },
    {
      lines: TYPED_EN,
      reply:
        'Mark the subject line "draft" until the memo is final.\n\nSend it to the team on Friday.\n\nKeep a copy in the shared folder.',
    },
    {
      lines: TYPED_ZH,
      reply: "主题行写“草稿”直到定稿。\n\n周五发给全组。\n\n在共享文件夹里留一份。",
    },
  ])("a rewrite that drops a tag the User typed is refused: $reply", async ({ lines, reply }) => {
    for (const action of ["instruction", "shorten"] as const) {
      const { core, mind, client, before } = await noteOf(plain(lines), () =>
        action === "instruction" ? reply : withoutNames(reply),
      );

      const result = await core.editWithAi({
        ...wholeMind(client, mind.id, "Make it more formal"),
        action,
      });

      expect(result).toEqual({ kind: "typed-tag" });
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(readMind(client).toJSON()).toEqual(before);
    }
  });

  // protects=a table that stands in for the paragraphs it says, in a reply naming none, keeps each <removed> the User typed in them, or the edit is refused (#2356); fails_when=the paragraph with the typed tag is taken out for the table; no_claim=how a real model lays out a table.
  test("a table that stands in for a paragraph with a typed tag, and drops it, is refused", async () => {
    const long =
      "in the subject line of every message about the memo until the board has approved the final version of the text next week.";
    const reply = ["| Step |", "|---|", `| Write draft ${long} |`, "| Send it on Friday. |"].join(
      "\n",
    );
    const { core, mind, client, before } = await noteOf(
      plain([`Write <removed>draft</removed> ${long}`, "Send it on Friday."]),
      () => reply,
    );

    expect(await core.editWithAi(wholeMind(client, mind.id, "Make it a table"))).toEqual({
      kind: "typed-tag",
    });
    expect(readMind(client).toJSON()).toEqual(before);
  });

  // protects=a list item a partial reply rewrites alone takes that item's place when it is much like it, and one that says less of it (Claude Haiku 5.5's "- 北区停车需按月另付费用。" for "北区免费停车。") is added after the edited text with the item kept, offered for removal; English and Chinese; fails_when=a line only somewhat like an item writes over it, or one much like it is added beside it; no_claim=how far a real model rewords.
  test.each([
    {
      heading: ["Benefits", "Pay"],
      bullets: [
        "A pension matched up to 5% of salary.",
        "25 days of annual leave.",
        "Free parking at the north site.",
      ],
      salary: "The salary is set by grade 7 and paid monthly.",
      rewritten: "Parking at the north site now costs extra each month.",
      replaces: true,
    },
    {
      heading: ["福利", "薪酬"],
      bullets: ["养老金按工资的5%匹配。", "每年25天年假。", "北区免费停车。"],
      salary: "薪酬按7级确定，按月发放。",
      rewritten: "北区停车需按月另付费用。",
      replaces: false,
    },
  ])(
    "a list item rewritten alone takes its item's place only when much like it: $rewritten",
    async (each) => {
      const [benefits = "", pay = ""] = each.heading;
      const bulletList: JSONContent = {
        type: "bulletList",
        content: each.bullets.map((item) => ({
          type: "listItem",
          content: [paragraph(text(item))],
        })),
      };
      const { core, mind, client, before } = await noteOf(
        [headingOf(benefits), bulletList, headingOf(pay), paragraph(text(each.salary))],
        () => `- ${each.rewritten}`,
      );

      await core.editWithAi(wholeMind(client, mind.id, "Say parking is no longer free"));

      expect(await acceptThenUndo(client, before)).toEqual(
        each.replaces
          ? [benefits, ...each.bullets.slice(0, 2), each.rewritten, pay, each.salary]
          : [benefits, ...each.bullets, pay, each.salary, each.rewritten],
      );
    },
  );

  // protects=a list item a partial reply rewrites without its mark, after an item it repeats, still takes that item's place, in English and Chinese; fails_when=the item stays beside its rewrite; no_claim=how often a real model drops the mark.
  test.each([
    {
      items: [
        "A pension matched up to 5% of salary.",
        "25 days of annual leave.",
        "Free parking at the north site.",
      ],
      rewritten: "Parking at the north site is no longer free.",
    },
    {
      items: ["养老金按工资的5%匹配。", "每年25天年假。", "北区免费停车。"],
      rewritten: "北区停车不再免费。",
    },
  ])(
    "an item rewritten without its mark takes its item's place: $rewritten",
    async ({ items, rewritten }) => {
      const bulletList: JSONContent = {
        type: "bulletList",
        content: items.map((item) => ({ type: "listItem", content: [paragraph(text(item))] })),
      };
      const { core, mind, client, before } = await noteOf([bulletList], () =>
        [`- ${items[1]}`, rewritten].join("\n\n"),
      );

      await core.editWithAi(wholeMind(client, mind.id, "Say parking is no longer free"));

      expect(await acceptThenUndo(client, before)).toEqual([...items.slice(0, 2), rewritten]);
    },
  );

  // protects=a summary line a partial reply adds after the item it repeats, naming the items after it, takes none of them out, in English and Chinese; fails_when=an item it names goes; no_claim=what a real model writes.
  test.each([
    {
      items: [
        "Spring tides: strongest at new moon.",
        "Neap tides: weakest.",
        "Storm surge: after gales.",
      ],
      summary: "Spring, neap and storm tides all matter.",
    },
    {
      items: ["大潮：新月时最强。", "小潮：最弱。", "风暴潮：大风过后。"],
      summary: "大潮、小潮和风暴潮都很重要。",
    },
  ])("a summary that names items takes none of them out: $summary", async ({ items, summary }) => {
    const bulletList: JSONContent = {
      type: "bulletList",
      content: items.map((item) => ({ type: "listItem", content: [paragraph(text(item))] })),
    };
    const { core, mind, client, before } = await noteOf([bulletList], () =>
      [`- ${items[0]}`, summary].join("\n\n"),
    );

    await core.editWithAi(wholeMind(client, mind.id, "Add a line that sums them up"));

    const accepted = await acceptThenUndo(client, before);
    expect(accepted).toHaveLength(4);
    expect(accepted).toEqual(expect.arrayContaining([...items, summary]));
  });

  // protects=a reply that rewrites every paragraph, none of its own like one of the passage's, takes their places in order; one of fewer or more lines than the passage, naming none, is shown and every paragraph kept (#2356); one that repeats a paragraph and then writes more lines than follow it adds them and keeps the paragraph after; English and Chinese; fails_when=a rewrite of every paragraph is added beside them, or lines of a shorter or longer reply take paragraphs' places; no_claim=what a real model writes.
  test.each([
    {
      lines: ["Parking is free at the north site.", "Hiring stays frozen."],
      anew: ["Gulls wheel over the quay at dawn.", "Boats rest on the mud at low water."],
      stray: "Changed to:",
      third: "Fees are paid by bank transfer.",
      fresh: "Parking at the north site is no longer free.",
    },
    {
      lines: ["北区停车免费。", "招聘继续冻结。"],
      anew: ["清晨海鸥在码头上空盘旋。", "退潮时船只停在泥滩上。"],
      stray: "改为：",
      third: "水费每季度收一次。",
      fresh: "北区停车不再免费。",
    },
  ])(
    "a reply written anew takes their places only when it rewrites every one: $stray",
    async (each) => {
      const [first = "", second = ""] = each.lines;
      const all = await noteOf(plain(each.lines), () => each.anew.join("\n\n"));
      await all.core.editWithAi(wholeMind(all.client, all.mind.id, "Rewrite it to be clearer"));
      expect(await acceptThenUndo(all.client, all.before)).toEqual(each.anew);

      for (const lines of [[first], [...each.lines, each.third]]) {
        const other = await noteOf(plain(lines), () => each.anew.join("\n\n"));
        expect(
          await other.core.editWithAi(
            wholeMind(other.client, other.mind.id, "Rewrite the intro to be clearer"),
          ),
        ).toEqual({ kind: "unchanged", said: each.anew.join(" ") });
        expect(shownWithChanges(other.client)).toEqual(lines);
      }

      const kept = await noteOf(plain(each.lines), () =>
        [first, each.stray, each.fresh].join("\n\n"),
      );
      await kept.core.editWithAi(wholeMind(kept.client, kept.mind.id, "Change the parking line"));
      expect(await acceptThenUndo(kept.client, kept.before)).toEqual([
        first,
        each.stray,
        each.fresh,
        second,
      ]);
    },
  );

  // protects=Claude Haiku 5.5's own replies to "Change the parking bullet to say parking is no longer free." over #2180's probe Note, stray lines and all, lose none of the Note's paragraphs, and their Chinese counterparts none of the Chinese Note's; fails_when=the stray lines take the places of the Role, Hours, Pay or Office paragraphs; no_claim=that the request is done exactly.
  test.each([
    {
      blocks: [
        ["heading", "Role"],
        ["paragraph", "The post is a senior analyst position in the finance team."],
        ["heading", "Hours"],
        ["paragraph", "Work is full time, Monday to Friday."],
        ["paragraph", "Core hours are 9:30 to 15:30."],
        ["heading", "Benefits"],
        ["bullet", "A pension matched up to 5% of salary."],
        ["bullet", "25 days of annual leave."],
        ["bullet", "Free parking at the north site."],
        ["heading", "Pay"],
        ["paragraph", "The salary is set by grade 7 and paid monthly."],
      ],
      replies: [
        "- Free parking at the north site. → now charged at the north site.\n\nWait, correcting the bullet properly:\n\n- Parking at the north site is no longer free.",
        '- Free parking at the north site.\n\nChanged to: "Parking at the north site is no longer free." Hmm, the bullet should replace the free parking line.\n\n- Parking at the north site is no longer free.',
        '- Free parking at the north site.\n\nChanged to: "Parking at the north site is no longer free."\n\nLet me write the new bullet:\n\n- Parking at the north site is no longer free.',
        "Wait, I must write the new bullet. Here it is:\n\nChanged to:\n\n- Parking at the north site is no longer free.",
        "- Free parking at the north site.\n\nChanging it to say parking is no longer free:\n\n- Parking at the north site is no longer free.",
      ],
    },
    {
      blocks: [
        ["heading", "职位"],
        ["paragraph", "该岗位是财务团队的高级分析岗位。"],
        ["heading", "工时"],
        ["paragraph", "全职，周一至周五上班。"],
        ["paragraph", "核心工作时间为9:30至15:30。"],
        ["heading", "福利"],
        ["bullet", "养老金按工资的5%匹配。"],
        ["bullet", "每年25天年假。"],
        ["bullet", "北区免费停车。"],
        ["heading", "薪酬"],
        ["paragraph", "薪酬按7级确定，按月发放。"],
      ],
      replies: [
        "- 北区免费停车。→ 现已收费。\n\n等等，我重新写这一条：\n\n- 北区停车不再免费。",
        "- 北区免费停车。\n\n改为：“北区停车不再免费。”嗯，这一条应该替换免费停车那一行。\n\n- 北区停车不再免费。",
        "- 北区免费停车。\n\n改为：“北区停车不再免费。”\n\n我来写新的要点：\n\n- 北区停车不再免费。",
        "等等，我得写出新的要点，如下：\n\n改为：\n\n- 北区停车不再免费。",
        "- 北区免费停车。\n\n把它改成停车不再免费：\n\n- 北区停车不再免费。",
      ],
    },
  ])("real stray-line replies lose none of the Note: $blocks.0.1", async ({ blocks, replies }) => {
    const content: JSONContent[] = [];
    for (const [kind, words] of blocks) {
      if (kind === "heading") content.push(headingOf(words ?? ""));
      else if (kind === "paragraph") content.push(paragraph(text(words ?? "")));
      else {
        const item = { type: "listItem", content: [paragraph(text(words ?? ""))] };
        const last = content.at(-1);
        if (last?.type === "bulletList") last.content?.push(item);
        else content.push({ type: "bulletList", content: [item] });
      }
    }
    const parking = blocks[8]?.[1] ?? "";
    const others = blocks.map(([, words]) => words ?? "").filter((words) => words !== parking);
    for (const reply of replies) {
      const { core, mind, client, before } = await noteOf(content, () => reply);

      await core.editWithAi(wholeMind(client, mind.id, "Change the parking bullet"));

      const accepted = await acceptThenUndo(client, before);
      expect(accepted).toEqual(expect.arrayContaining(others));
      expect(accepted.join("\n")).toMatch(/no longer free|不再免费/);
    }
  });

  // protects=a stray line and a new line in a partial reply, after the line it repeats, are added, and the sections after them stay as they were; English and Chinese; fails_when=they take the place of the paragraphs that follow (seen on Claude Haiku 5.5 in #2192's check); no_claim=what a real model writes.
  test.each([
    {
      heading: ["Benefits", "Pay", "Office"],
      bullets: ["25 days of annual leave.", "Free parking at the north site."],
      paragraphs: [
        "The salary is set by grade 7 and paid monthly.",
        "The office is on the third floor.",
      ],
      stray: "Wait, I must write the new bullet. Here it is:",
      fresh: "Parking at the north site is no longer free.",
    },
    {
      heading: ["福利", "薪酬", "办公室"],
      bullets: ["每年25天年假。", "北区免费停车。"],
      paragraphs: ["薪资按7级发放，每月支付。", "办公室在三楼。"],
      stray: "等等，我得写出新的要点，如下：",
      fresh: "北区停车不再免费。",
    },
  ])("a stray line in a partial reply writes over nothing: $stray", async (each) => {
    const [benefits = "", pay = "", office = ""] = each.heading;
    const [salary = "", floor = ""] = each.paragraphs;
    const bulletList: JSONContent = {
      type: "bulletList",
      content: each.bullets.map((item) => ({ type: "listItem", content: [paragraph(text(item))] })),
    };
    const { core, mind, client, before } = await noteOf(
      [
        headingOf(benefits),
        bulletList,
        headingOf(pay),
        paragraph(text(salary)),
        headingOf(office),
        paragraph(text(floor)),
      ],
      () => [`- ${each.bullets[1]}`, each.stray, each.fresh].join("\n\n"),
    );

    await core.editWithAi(wholeMind(client, mind.id, "Change the parking bullet"));

    const accepted = await acceptThenUndo(client, before);
    expect(accepted.slice(-4)).toEqual([pay, salary, office, floor]);
    expect(accepted).toEqual(expect.arrayContaining([...each.bullets, each.stray, each.fresh]));
  });
});

describe("A rewrite names the paragraph each of its own replaces (#2356)", () => {
  const TEAM = {
    en: [
      "Budget",
      "The budget is 40,000 euros.",
      "Ana leads the data work.",
      "Ben handles procurement.",
    ],
    zh: ["预算", "预算为4万欧元。", "安娜负责数据工作。", "本负责采购。"],
  };
  const team = (lines: readonly string[]) => [
    headingOf(lines[0] ?? ""),
    paragraph(text(lines[1] ?? "")),
    bullets(lines[2] ?? "", lines[3] ?? ""),
  ];

  // protects=a named paragraph changes in place, however little its new words share with the old, and the paragraphs the reply doesn't name stay, not counted as left out; the short Chinese item rewrite that #2344's likeness floor added beside the old one; fails_when=the new item is added beside the old one, another paragraph changes, or the result lists left-out paragraphs; no_claim=how a real model names its paragraphs.
  test.each([
    {
      lines: TEAM.en,
      reply: "¶4 - Ben handles vendor management.",
      now: "Ben handles vendor management.",
    },
    { lines: TEAM.zh, reply: "¶4 - 本负责供应商管理。", now: "本负责供应商管理。" },
  ])(
    "a named paragraph changes in place and the rest stays: $now",
    async ({ lines, reply, now }) => {
      const { core, mind, client, calls, before } = await noteOf(team(lines), () => reply);

      const result = await core.editWithAi(wholeMind(client, mind.id, "Change Ben's task"));

      expect(calls[0]?.passage).toBe(
        [`¶1 ## ${lines[0]}`, `¶2 ${lines[1]}`, `¶3 - ${lines[2]}`, `¶4 - ${lines[3]}`].join(
          "\n\n",
        ),
      );
      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("leftOut");
      expect(await acceptThenUndo(client, before)).toEqual([lines[0], lines[1], lines[2], now]);
    },
  );

  // protects=a new paragraph goes after the one before it in the reply, before the first the reply names when it comes first, and after the selection when the reply names none, and nothing is written over: #2333's X4 and the issue's look-alike cost line; fails_when=a new line takes a paragraph's place, or lands elsewhere; no_claim=where a real model puts a new paragraph.
  test.each([
    {
      lines: [
        "The team is Dana and Ben.",
        "Dana leads design.",
        "Ben runs vendors.",
        "We meet on Mondays.",
      ],
      reply: "¶3 Ben runs vendors.\n\n¶+ Chloe runs the pilots.\n\n¶+ Eve writes the report.",
      after: [
        "The team is Dana and Ben.",
        "Dana leads design.",
        "Ben runs vendors.",
        "Chloe runs the pilots.",
        "Eve writes the report.",
        "We meet on Mondays.",
      ],
    },
    {
      lines: ["团队有达娜和本。", "达娜负责设计。", "本负责供应商。", "我们周一开会。"],
      reply: "¶+ 克洛伊负责试点。\n\n¶4 我们周一开会。",
      after: [
        "团队有达娜和本。",
        "达娜负责设计。",
        "本负责供应商。",
        "克洛伊负责试点。",
        "我们周一开会。",
      ],
    },
    {
      lines: ["Rent is 1,200 a month.", "Parking is 100 a month.", "Water is 30 a month."],
      reply: "¶+ Internet is 40 a month.",
      after: [
        "Rent is 1,200 a month.",
        "Parking is 100 a month.",
        "Water is 30 a month.",
        "Internet is 40 a month.",
      ],
    },
    {
      lines: ["水费：每月30元。", "房租每月1200元。"],
      reply: "¶1 水费：每月30元。\n\n¶+ 网费：每月40元。",
      after: ["水费：每月30元。", "网费：每月40元。", "房租每月1200元。"],
    },
  ])(
    "a new paragraph is added where the reply puts it: $reply",
    async ({ lines, reply, after }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      expect(await core.editWithAi(wholeMind(client, mind.id, "Add it"))).toMatchObject({
        kind: "proposed",
      });

      expect(await acceptThenUndo(client, before)).toEqual(after);
    },
  );

  // protects=a plain line of a named reply that carries no name (#2333's "Changed to:") is the model's own words: never written into the Note, nor over a paragraph, while the paragraphs it names go in (#2356); fails_when=the line lands in the Note, or a paragraph of the User's is written over or lost; no_claim=how often a model writes such a line.
  test.each([
    {
      lines: ["Owner: Sam signs the lease.", "Keys are at the desk.", "Water is 30 a month."],
      reply: "¶1 Owner: Sam signs the lease.\n\nChanged to:\n\n¶+ Ann also signs.",
      after: [
        "Owner: Sam signs the lease.",
        "Ann also signs.",
        "Keys are at the desk.",
        "Water is 30 a month.",
      ],
    },
    {
      lines: ["业主：山姆签租约。", "钥匙在前台。", "水费每月30元。"],
      reply: "¶1 业主：山姆签租约。\n\n改为：\n\n¶+ 安也签字。",
      after: ["业主：山姆签租约。", "安也签字。", "钥匙在前台。", "水费每月30元。"],
    },
  ])(
    "a stray line is never written, into the Note or over a paragraph: $reply",
    async ({ lines, reply, after }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      await core.editWithAi(wholeMind(client, mind.id, "Ann signs too"));

      expect(await acceptThenUndo(client, before)).toEqual(after);
    },
  );

  // protects=a reply that names a paragraph twice, names one the selection hasn't, or names one with no words for it is refused with its own problem, and the Note is exactly as it was, nothing waiting; English and Chinese; fails_when=any change goes in, or the edit reads as done; no_claim=how often a real model misnames.
  test.each([
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "¶1 Rent is 1,250 a month.\n\n¶1 Rent rises in May.",
    },
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "¶2 Water is 35 a month.\n\n¶7 Internet is 40 a month.",
    },
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "¶1\n\n¶2 Water is 35 a month.",
    },
    {
      lines: ["房租每月1200元。", "水费每月30元。"],
      reply: "¶2 水费每月35元。\n\n¶2 水费按季度收。",
    },
    { lines: ["房租每月1200元。", "水费每月30元。"], reply: "¶4 网费每月40元。" },
    { lines: ["房租每月1200元。", "水费每月30元。"], reply: "¶5+ 网费每月40元。" },
    {
      lines: ["房租每月1200元。", "水费每月30元。"],
      reply: "¶2a 水费每月30元。\n\n¶+ 网费每月40元。",
    },
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "Rent is 1,250 a month.\n\n¶2a Water is 35 a month.",
    },
  ])("a reply that names a paragraph wrongly changes nothing: $reply", async ({ lines, reply }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    const result = await core.editWithAi(wholeMind(client, mind.id, "Update the costs"));

    expect(result).toEqual({ kind: "misnamed" });
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(readMind(client).toJSON()).toEqual(before);
    expect(shownWithChanges(client)).toEqual(lines);
  });

  // protects=a name that reads clearly more like another paragraph the reply hasn't named than like the one it names is refused, with the Note exactly as it was (#2356): a miscount, as Claude Haiku 5.5 named ¶7 for ¶6, though the line shares "The" and "is" with the one it names; and the User's own "¶3 of the lease…" come back with its escape dropped, read as a name; English and Chinese; fails_when=the line is written over the paragraph its name says; no_claim=how often a real model miscounts.
  test.each([
    {
      lines: [
        "The kickoff is in Leeds.",
        "The designer is Dana.",
        "The budget is 40,000 euros.",
        "The report is due in June.",
      ],
      reply: "¶3 The designer is Dana, with Ben helping.",
    },
    {
      lines: ["启动会在利兹召开。", "达娜负责设计工作。", "我们负责预算工作。", "报告六月提交。"],
      reply: "¶3 达娜负责设计工作，本协助。",
    },
    {
      lines: [
        "The rent is 1,200 a month.",
        "¶3 of the lease is void.",
        "The deposit is due in May.",
      ],
      reply: "¶3 of the lease is void.",
    },
    {
      lines: ["房租每月1200元。", "¶3 租约条款无效。", "租约押金五月付清。"],
      reply: "¶3 租约条款无效。",
    },
  ])("a name its line reads clearly against is refused: $reply", async ({ lines, reply }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    const result = await core.editWithAi(wholeMind(client, mind.id, "Ben helps Dana"));

    expect(result).toEqual({ kind: "misnamed" });
    expect(readMind(client).toJSON()).toEqual(before);
  });

  // protects=a paragraph that starts with an unescaped ¶ that is no name (after spaces or a quote mark) is refused, never written with the ¶ as text (#2356); English and Chinese; fails_when="¶ 2 " or "> ¶2 " lands in the Note, or the edit reads as done; no_claim=names written in words, such as 段1.
  test.each([
    { lines: ["Ana leads data.", "Dana leads design."], reply: "¶ 2 Dana leads the design work." },
    { lines: ["Ana leads data.", "Dana leads design."], reply: "> ¶2 Dana leads the design work." },
    { lines: ["安娜负责数据。", "达娜负责设计。"], reply: "¶ 2 达娜负责全部设计。" },
    { lines: ["安娜负责数据。", "达娜负责设计。"], reply: "> ¶2 达娜负责全部设计。" },
  ])("a name written wrong at a line's start is refused: $reply", async ({ lines, reply }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    expect(await core.editWithAi(wholeMind(client, mind.id, "Dana leads all design"))).toEqual({
      kind: "misnamed",
    });
    expect(readMind(client).toJSON()).toEqual(before);
  });

  // protects=a heading the reply names comes back as a heading, at any level, or the change is refused (#2356): Claude Haiku 5.5's "¶1 is a heading and no mistakes…" wrote its own sentence over a heading; English and Chinese; fails_when=a named heading is written over with plain text, or a heading renamed as a heading is refused; no_claim=how a model words a heading.
  test.each([
    {
      heading: "Plot",
      reply: "¶1 is a heading and no mistakes; the passage has no spelling errors to fix.",
      result: "misnamed",
    },
    { heading: "Plot", reply: "¶1 Garden plot", result: "misnamed" },
    { heading: "Plot", reply: "¶1 ## Garden plot", result: "proposed" },
    { heading: "Plot", reply: "¶1 ### Garden plot", result: "proposed" },
    { heading: "安排", reply: "¶1 是标题，没有错别字。", result: "misnamed" },
    { heading: "安排", reply: "¶1 ## 活动安排", result: "proposed" },
  ])("a named heading comes back as a heading: $reply", async ({ heading, reply, result }) => {
    const title: JSONContent = {
      type: "heading",
      attrs: { id: `block-${++ids}`, level: 2 },
      content: [text(heading)],
    };
    const { core, mind, client, before } = await noteOf(
      [title, ...plain(["The club garden is behind the library."])],
      () => reply,
    );

    expect(await core.editWithAi(wholeMind(client, mind.id, "Check the spelling"))).toMatchObject({
      kind: result,
    });
    if (result === "misnamed") expect(readMind(client).toJSON()).toEqual(before);
    else {
      await resolveChanges(client, "accept");
      expect(readMind(client).toJSON().content?.[0]?.type).toBe("heading");
    }
  });

  // protects=only a request in the User's words shows the passage's names and is told how to name its own, in its instructions, so a fixed action such as Shorten is shown no name and told of none; fails_when=Shorten's instructions or prompt mention names, or the request in words isn't told; no_claim=how a model reads the rule.
  test("the names and their rule go to a request in the User's words, not to Shorten", async () => {
    const lines = ["Rent is very high.", "Water is really cheap."];
    const { core, mind, client, calls } = await noteOf(plain(lines), ({ passage }) => passage);
    const ids = readMind(client)
      .toJSON()
      .content?.map((block: JSONContent) => String(block.attrs?.id));
    const whole = (action: "shorten" | "instruction") => ({
      ...wholeMind(client, mind.id, "Shorter"),
      action,
      ...(action === "shorten" && { instruction: undefined }),
      to: { blockId: ids?.[1] ?? "", offset: (lines[1] ?? "").length },
    });

    await core.editWithAi(whole("shorten"));
    await core.editWithAi(whole("instruction"));

    const [shorten, asked] = calls;
    expect(shorten?.passage).toBe(lines.join("\n\n"));
    expect(`${shorten?.system}${shorten?.prompt}`).not.toContain("¶");
    expect(asked?.passage).toBe(`¶1 ${lines[0]}\n\n¶2 ${lines[1]}`);
    expect(asked?.system).toContain("each starting with a name");
    expect(asked?.prompt).not.toContain("each starting with a name");
  });

  // protects=a named paragraph whose words share none with the paragraph it names, and read as another the reply doesn't name, refuses the edit rather than writing over the one named (Claude Haiku 5.5 named ¶7 for a rewrite of ¶6); a replacement in new words that reads as no other one paragraph still goes in; English and Chinese; fails_when=the paragraph named is written over, or a plain replacement is refused; no_claim=how often a model miscounts.
  test.each([
    { lines: TEAM.en, reply: "¶4 - Ana leads the vendor work.", refused: true, now: "" },
    { lines: TEAM.zh, reply: "¶4 - 安娜做数据分析。", refused: true, now: "" },
    {
      lines: TEAM.en,
      reply: "¶4 - Chloe joins as tester.",
      refused: false,
      now: "Chloe joins as tester.",
    },
    { lines: TEAM.zh, reply: "¶4 - 克洛伊负责测试。", refused: false, now: "克洛伊负责测试。" },
  ])(
    "a name its words contradict refuses the edit: $reply",
    async ({ lines, reply, refused, now }) => {
      const { core, mind, client, before } = await noteOf(team(lines), () => reply);

      const result = await core.editWithAi(wholeMind(client, mind.id, "Change the last item"));

      if (refused) {
        expect(result).toEqual({ kind: "misnamed" });
        expect(readMind(client).toJSON()).toEqual(before);
        return;
      }
      expect(result).toMatchObject({ kind: "proposed" });
      expect(await acceptThenUndo(client, before)).toEqual([lines[0], lines[1], lines[2], now]);
    },
  );

  // protects=a name alone on its line names the words after it, on the next line or after a blank one, so a model that breaks the line after a name isn't refused; fails_when=it is refused or the words are added beside; no_claim=none beyond protects.
  test.each(["¶2\nWater is 35 a month.", "¶2\n\nWater is 35 a month."])(
    "a name alone names the words after it: %j",
    async (reply) => {
      const lines = ["Rent is 1,200 a month.", "Water is 30 a month."];
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      expect(await core.editWithAi(wholeMind(client, mind.id, "Water is 35"))).toMatchObject({
        kind: "proposed",
      });
      expect(await acceptThenUndo(client, before)).toEqual([lines[0], "Water is 35 a month."]);
    },
  );

  // protects=a paragraph named after one the reply wrote later in the Note moves to where the reply has it, and the one it passed stays where it was; fails_when=the order stays, or a paragraph is lost or doubled; no_claim=none beyond protects.
  test("a paragraph named out of order moves there", async () => {
    const lines = ["Rent is 1,200 a month.", "Water is 30 a month.", "Parking is 100 a month."];
    const { core, mind, client, before } = await noteOf(plain(lines), () =>
      ["¶3 Parking is 100 a month.", "¶1 Rent is 1,200 a month."].join("\n\n"),
    );

    await core.editWithAi(wholeMind(client, mind.id, "Put rent last"));

    expect(await acceptThenUndo(client, before)).toEqual([
      "Water is 30 a month.",
      "Parking is 100 a month.",
      "Rent is 1,200 a month.",
    ]);
  });

  // protects=in a passage shown with marks, a named paragraph written as another kind of Block becomes that kind in its place; fails_when=its kind stays, or it lands elsewhere; no_claim=none beyond protects.
  test("a named paragraph written as another kind becomes it, in its place", async () => {
    const { core, mind, client } = await noteOf(
      [headingOf("Costs"), paragraph(text("Rent is 1,200 a month.")), bullets("Water", "Parking")],
      () => "¶2 - Rent is 1,200 a month.",
    );

    await core.editWithAi(wholeMind(client, mind.id, "Make rent a bullet"));
    await resolveChanges(client, "accept");

    expect(structure(client)).toEqual([
      "h2 Costs",
      "• Rent is 1,200 a month.",
      "• Water",
      "• Parking",
    ]);
  });

  // protects=a new paragraph named as following one of the passage's (¶2+, as Claude Haiku 5.5 writes it unasked) goes right after that one, after any added there before it, and is never read as the paragraph it names; fails_when=¶2 is written over, the edit is refused, or the new one lands elsewhere; no_claim=how often a model writes it.
  test.each([
    {
      reply: "¶3 差旅上限为5000欧元。\n\n¶2+ 应急金预留2000欧元。",
      after: [
        "预算",
        "试点预算为4万欧元。",
        "应急金预留2000欧元。",
        "差旅上限为5000欧元。",
        "团队",
      ],
    },
    {
      reply: "¶3 差旅上限为5000欧元。\n\n¶3+ 应急金为2000欧元。\n\n¶3+ 另留500欧元。",
      after: [
        "预算",
        "试点预算为4万欧元。",
        "差旅上限为5000欧元。",
        "应急金为2000欧元。",
        "另留500欧元。",
        "团队",
      ],
    },
  ])("a new paragraph named after one goes right after it: $reply", async ({ reply, after }) => {
    const lines = ["预算", "试点预算为4万欧元。", "差旅上限为5000欧元。", "团队"];
    const { core, mind, client, before } = await noteOf(
      [headingOf(lines[0] ?? ""), ...plain(lines.slice(1, 3)), headingOf(lines[3] ?? "")],
      () => reply,
    );

    expect(await core.editWithAi(wholeMind(client, mind.id, "在预算下面加一行"))).toMatchObject({
      kind: "proposed",
    });
    expect(await acceptThenUndo(client, before)).toEqual(after);
  });

  // protects=a name written before a <removed> mark, or inside it, is no part of the quote: the paragraph goes, in English and Chinese; fails_when=the quote is refused as unplaced or the paragraph stays; no_claim=none beyond protects.
  test.each([
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "¶2 <removed>Water is 30 a month.</removed>",
    },
    {
      lines: ["Rent is 1,200 a month.", "Water is 30 a month."],
      reply: "<removed>¶2 Water is 30 a month.</removed>",
    },
    {
      lines: ["房租每月1200元。", "水费每月30元。"],
      reply: "¶1 房租每月1200元。\n\n<removed>¶2 水费每月30元。</removed>",
    },
  ])("a named paragraph quoted as taken out goes: $reply", async ({ lines, reply }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    expect(
      await core.editWithAi(wholeMind(client, mind.id, "Remove the water line")),
    ).toMatchObject({
      kind: "proposed",
    });
    expect(await acceptThenUndo(client, before)).toEqual([lines[0]]);
  });

  // protects=a paragraph the reply names with its words as they were, then quotes as taken out, goes with the rest it quotes, as Claude Haiku 5.5 writes a section's removal; English and Chinese; fails_when=the edit is refused as unplaced, or the heading stays; no_claim=how often a model writes it so.
  test.each([
    {
      lines: [
        "Hours",
        "Work is full time.",
        "Core hours are 9:30 to 15:30.",
        "Pay",
        "Paid monthly.",
      ],
      reply:
        "¶1 ## Hours\n<removed>## Hours</removed>\n<removed>Work is full time.</removed>\n<removed>Core hours are 9:30 to 15:30.</removed>",
    },
    {
      lines: ["工时", "全职。", "核心工作时间为9:30至15:30。", "薪酬", "按月发放。"],
      reply:
        "¶1 ## 工时\n\n<removed>## 工时</removed>\n\n¶2 <removed>全职。</removed>\n\n¶3 <removed>核心工作时间为9:30至15:30。</removed>",
    },
  ])(
    "a paragraph named as it was and quoted as taken out goes: $reply",
    async ({ lines, reply }) => {
      const { core, mind, client, before } = await noteOf(
        [
          headingOf(lines[0] ?? ""),
          ...plain(lines.slice(1, 3)),
          headingOf(lines[3] ?? ""),
          paragraph(text(lines[4] ?? "")),
        ],
        () => reply,
      );

      expect(await core.editWithAi(wholeMind(client, mind.id, "Drop the hours"))).toMatchObject({
        kind: "proposed",
      });
      expect(await acceptThenUndo(client, before)).toEqual([lines[3], lines[4]]);
    },
  );

  // protects=the ways Claude Haiku 5.5 and Sonnet 5.5 write names for new lines and tables beyond the rule each read as it means: ¶++ for a second new line, ¶16 or "¶16 +" numbering a new last line, ¶+7 for one after ¶7, ¶7++ after a single line break, and a name on every row of a table, where only the first names the table; nothing is written over and no name is left in the Note; English and Chinese; fails_when=the edit is refused, a name stays as text, or a paragraph changes; no_claim=how often a model writes them.
  test.each([
    {
      lines: ["Lena books the van.", "Omar packs the archive."],
      reply:
        "¶2 Omar packs the archive.\n\n¶+ Uma brings the keys.\n\n¶++ Vic cleans the old office.",
      after: [
        "Lena books the van.",
        "Omar packs the archive.",
        "Uma brings the keys.",
        "Vic cleans the old office.",
      ],
    },
    {
      lines: ["年会定在十二月五日举行。", "签到从下午两点开始。"],
      reply: "¶3 + 当天停车免费。",
      after: ["年会定在十二月五日举行。", "签到从下午两点开始。", "当天停车免费。"],
    },
    {
      lines: ["年会定在十二月五日举行。", "签到从下午两点开始。"],
      reply: "¶3 当天停车免费。",
      after: ["年会定在十二月五日举行。", "签到从下午两点开始。", "当天停车免费。"],
    },
    {
      lines: ["小林负责场地。", "老周负责音响。", "外地同事可报销一晚住宿。"],
      reply: "¶+2 - 小陈负责摄影。",
      after: ["小林负责场地。", "老周负责音响。", "- 小陈负责摄影。", "外地同事可报销一晚住宿。"],
    },
    {
      lines: ["小林负责场地。", "老周负责音响。"],
      reply: "¶2 老周负责音响。\n¶2++ 小王负责主持。",
      after: ["小林负责场地。", "老周负责音响。", "小王负责主持。"],
    },
  ])("a new line named as Haiku writes it is added: $reply", async ({ lines, reply, after }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    expect(await core.editWithAi(wholeMind(client, mind.id, "Add it"))).toMatchObject({
      kind: "proposed",
    });
    expect(await acceptThenUndo(client, before)).toEqual(after);
  });

  // protects=a table whose every row starts with a name, as Claude Haiku 5.5 writes one, is one table in the place of the paragraph its first row names, and the paragraphs the other rows' names point at stay; fails_when=it is refused as no table, a row name is left in a cell, or another paragraph goes; no_claim=none beyond protects.
  test("a table with a name on every row is one table, in the place of the paragraph its first row names", async () => {
    const lines = ["People", "Lena books the van.", "Omar packs the archive."];
    const { core, mind, client } = await noteOf(plain(lines), () =>
      [
        "¶2 | Name | Task |",
        "¶3 |---|---|",
        "¶4 | Lena | Books the van. |",
        "¶5 | Omar | Packs the archive. |",
      ].join("\n"),
    );

    expect(await core.editWithAi(wholeMind(client, mind.id, "Make it a table"))).toMatchObject({
      kind: "proposed",
    });
    await resolveChanges(client, "accept");
    const kinds: string[] = [];
    readMind(client).forEach((block) => {
      kinds.push(block.type.name);
    });
    expect(kinds).toEqual(["paragraph", "table", "paragraph"]);
    expect(shownWithChanges(client)).toEqual([
      "People",
      "Name",
      "Task",
      "Lena",
      "Books the van.",
      "Omar",
      "Packs the archive.",
      "Omar packs the archive.",
    ]);
  });

  // protects=a new paragraph numbered just past the selection's last (¶4+ in a Note of three, as Claude Haiku 5.5 numbers a new line) goes after the last, the only place past it; fails_when=it is refused or lands elsewhere; no_claim=none beyond protects.
  test("a new paragraph numbered just past the last goes after the last", async () => {
    const lines = ["房租每月1200元。", "停车每月100元。", "物业每月30元。"];
    const { core, mind, client, before } = await noteOf(plain(lines), () =>
      ["¶3 物业每月30元。", "¶4+ 网络每月40元。"].join("\n\n"),
    );

    expect(await core.editWithAi(wholeMind(client, mind.id, "加一行网络费用"))).toMatchObject({
      kind: "proposed",
    });
    expect(await acceptThenUndo(client, before)).toEqual([...lines, "网络每月40元。"]);
  });

  // protects=every ¶ the User typed is shown escaped, "¶ 3" with a space too, and comes back as their words whether the reply keeps the escape or names the paragraph first; fails_when=the typed ¶ is read as a name, lost, or a backslash is left in the Note; no_claim=none beyond protects.
  test.each([
    { reply: "¶1 \\¶12 of the lease says rent rises in May.\n\n¶2 \\¶ 3 covers water." },
    { reply: "¶1 \\¶12 of the lease says rent rises in May.\n\n¶2 ¶ 3 covers water." },
    { reply: "¶1 ¶12 of the lease says rent rises in May." },
  ])("typed text that reads as a name stays words: $reply", async ({ reply }) => {
    const lines = ["¶12 of the lease says rent rises.", "¶ 3 covers water."];
    const { core, mind, client, calls, before } = await noteOf(plain(lines), () => reply);

    await core.editWithAi(wholeMind(client, mind.id, "Say it rises in May"));

    expect(calls[0]?.passage).toBe(
      "¶1 \\¶12 of the lease says rent rises.\n\n¶2 \\¶ 3 covers water.",
    );
    expect(await acceptThenUndo(client, before)).toEqual([
      "¶12 of the lease says rent rises in May.",
      "¶ 3 covers water.",
    ]);
  });

  // protects=a table named for a paragraph takes that paragraph's place, the name on the table's first line or the line before it; fails_when=the table is pipe text, lands elsewhere, or the paragraph stays; no_claim=none beyond protects.
  test.each(["¶2 | Cost | Amount |", "¶2\n| Cost | Amount |"])(
    "a table named for a paragraph takes its place: %j",
    async (first) => {
      const lines = ["Costs", "Rent is 1,200 and water is 30.", "Paid monthly."];
      const { core, mind, client } = await noteOf(plain(lines), () =>
        [first, "|---|---|", "| Rent | 1,200 |", "| Water | 30 |"].join("\n"),
      );

      await core.editWithAi(wholeMind(client, mind.id, "Make the costs a table"));
      await resolveChanges(client, "accept");

      const kinds: string[] = [];
      readMind(client).forEach((block) => {
        kinds.push(block.type.name);
      });
      expect(kinds).toEqual(["paragraph", "table", "paragraph"]);
      expect(shownWithChanges(client)).toEqual([
        "Costs",
        "Cost",
        "Amount",
        "Rent",
        "1,200",
        "Water",
        "30",
        "Paid monthly.",
      ]);
    },
  );

  // protects=the shapes #2344 still wrote over, each in a named reply: a new line much like exactly one paragraph (R22, R22b, the issue's internet line, R17c, R11b), one that shares only "the" and "is" with the last (S03), one exactly half like another (a lease term), a short stray line beside a short paragraph that has its words ("Changed to:", "改为："), and a lone stray line between two named ones: each is added where the reply puts it, and every paragraph stays; fails_when=any paragraph is written over or lost; no_claim=what a model writes.
  test.each([
    {
      lines: ["Rent bill: 1,200 a month.", "Water bill: 30 a month."],
      reply: "¶+ Internet bill: 40 a month.",
      after: ["Rent bill: 1,200 a month.", "Water bill: 30 a month.", "Internet bill: 40 a month."],
    },
    {
      lines: ["房租：每月1200元。", "水费：每月30元。"],
      reply: "¶+ 网费：每月40元。",
      after: ["房租：每月1200元。", "水费：每月30元。", "网费：每月40元。"],
    },
    {
      lines: ["Water is 30 a month."],
      reply: "¶+ Internet is 40 a month.",
      after: ["Water is 30 a month.", "Internet is 40 a month."],
    },
    {
      lines: ["Rent is due on the first of the month.", "Keys are at the desk."],
      reply:
        "¶1 Rent is due on the first of the month.\n\n¶+ Internet is due on the first of the month too.",
      after: [
        "Rent is due on the first of the month.",
        "Internet is due on the first of the month too.",
        "Keys are at the desk.",
      ],
    },
    {
      lines: ["Dana leads the design work and reports weekly.", "Ben joins in May."],
      reply: "¶2 Ben joins in May.\n\n¶+ Ben leads the vendor work and reports monthly.",
      after: [
        "Dana leads the design work and reports weekly.",
        "Ben joins in May.",
        "Ben leads the vendor work and reports monthly.",
      ],
    },
    {
      lines: ["The budget is 9,000 euros.", "Dana leads design.", "Ben runs vendors."],
      reply: "¶3 Ben runs vendors.\n\n¶+ The final report is due in June.",
      after: [
        "The budget is 9,000 euros.",
        "Dana leads design.",
        "Ben runs vendors.",
        "The final report is due in June.",
      ],
    },
    {
      lines: ["租期为十二个月。", "押金为两个月租金。"],
      reply: "¶+ 租期为二十个月。",
      after: ["租期为十二个月。", "押金为两个月租金。", "租期为二十个月。"],
    },
    {
      lines: ["The meeting changed to Tuesday.", "Bring the slides."],
      reply:
        "¶1 The meeting changed to Tuesday.\n\nChanged to:\n\n¶+ The meeting is on Wednesday now.",
      after: [
        "The meeting changed to Tuesday.",
        "The meeting is on Wednesday now.",
        "Bring the slides.",
      ],
    },
    {
      lines: ["会议改到周二。", "带上幻灯片。"],
      reply: "¶1 会议改到周二。\n\n改为：\n\n¶+ 会议现在改到周三。",
      after: ["会议改到周二。", "会议现在改到周三。", "带上幻灯片。"],
    },
    {
      lines: ["Owner: Sam.", "Keys are at the desk.", "Water is 30 a month."],
      reply: "¶1 Owner: Sam.\n\nDone.\n\n¶3 Water is 35 a month.",
      after: ["Owner: Sam.", "Keys are at the desk.", "Water is 35 a month."],
    },
  ])(
    "a line #2344 wrote over is added where the reply puts it: $reply",
    async ({ lines, reply, after }) => {
      const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

      expect(await core.editWithAi(wholeMind(client, mind.id, "Add it"))).toMatchObject({
        kind: "proposed",
      });
      expect(await acceptThenUndo(client, before)).toEqual(after);
    },
  );

  // protects=R25b in a named reply: a new line much like a paragraph with a Citation is added after it, and that paragraph keeps its Citation, through accept, and reject back to the Note as it was; fails_when=the cited paragraph is written over or its Citation is struck; no_claim=none beyond protects.
  test("a new line beside a cited paragraph leaves it and its Citation as they were", async () => {
    const { core, mind, client, tides } = await setUp(
      editingModel(
        () =>
          "¶1 Spring tides happen at new moon. [1]\n\n¶+ Spring tides also happen at full moon.",
      ),
    );
    writeMind(client, [
      paragraph(text("Spring tides happen at new moon. "), citation(tides)),
      paragraph(text("Harbours publish the times.")),
    ]);
    await client.settled();
    const before = readMind(client).toJSON();
    const ids = citationIdsOf(client);

    expect(await core.editWithAi(wholeMind(client, mind.id, "Add full moon"))).toMatchObject({
      kind: "proposed",
    });
    const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
    await resolveChanges(client, "accept");
    expect(structure(client)).toEqual([
      "p Spring tides happen at new moon. ⟨found⟩",
      "p Spring tides also happen at full moon.",
      "p Harbours publish the times.",
    ]);
    expect(citationIdsOf(client)).toEqual(ids);
    undo.undo();
    await client.settled();
    await resolveChanges(client, "reject");
    expect(readMind(client).toJSON()).toEqual(before);
  });

  // protects=in a reply with no names, a line made of nearly all of one paragraph's words and of no other's, in four words or more, takes that paragraph's place though it is less than half like it (#2333's summary rule, and its four-word floor from above); English and Chinese; fails_when=the summary is added beside the paragraph, or another paragraph changes; no_claim=how often a model writes one.
  test.each([
    {
      lines: [
        "Rent of 1,200 euros is due on the first of each month and is paid by bank transfer to the landlord.",
        "Keys are at the front desk.",
        "Water is billed each quarter.",
      ],
      reply: "Rent paid by transfer.",
    },
    {
      lines: [
        "每月一号前，房租须通过银行转账付给房东，逾期一周加收百分之五的滞纳金。",
        "钥匙在前台。",
        "水费按季度收。",
      ],
      reply: "加收百分之五的滞纳金。",
    },
  ])("a short summary of one paragraph takes its place: $reply", async ({ lines, reply }) => {
    const { core, mind, client, before } = await noteOf(plain(lines), () => reply);

    await core.editWithAi(wholeMind(client, mind.id, "Summarise the first line"));

    expect(await acceptThenUndo(client, before)).toEqual([reply, lines[1], lines[2]]);
  });

  // protects=a reply is read the way its first paragraph that names or reads much like one of the selection's says (#2356): a line like none before a name ("Here is the text:"), or before a removal it names, and a line whose words name a paragraph ("¶+ after ¶7:", as Claude Sonnet 5.5 wrote one) never go in, while a reply that starts with a rewrite given no name is paired by its words as #2344 pairs it, its names taken off; English and Chinese; fails_when=a line with no name lands in the Note or over a paragraph, or a name is left in the Note as text; no_claim=how often a model leaves a name out.
  test.each([
    {
      reply: "Here is the revised text:\n\n¶1 Rent is 1,250 a month.",
      result: { kind: "proposed" },
      after: ["Rent is 1,250 a month.", "Water is 30 a month."],
    },
    {
      reply: "Rent is 1,250 a month.\n\n¶2 Water is 30 a month.",
      result: { kind: "proposed" },
      after: ["Rent is 1,250 a month.", "Water is 30 a month."],
    },
    {
      reply: "修改如下：\n\n¶1 房租每月1250元。",
      lines: ["房租每月1200元。", "水费每月30元。"],
      result: { kind: "proposed" },
      after: ["房租每月1250元。", "水费每月30元。"],
    },
    {
      reply: "¶+ after ¶2:\n\n¶2 Water is 30 a month.\n\n¶+ Internet is 40 a month.",
      result: { kind: "proposed" },
      after: ["Rent is 1,200 a month.", "Water is 30 a month.", "Internet is 40 a month."],
    },
    {
      reply: "¶+ 在¶2之后：\n\n¶2 水费每月30元。\n\n¶+ 网费每月40元。",
      lines: ["房租每月1200元。", "水费每月30元。"],
      result: { kind: "proposed" },
      after: ["房租每月1200元。", "水费每月30元。", "网费每月40元。"],
    },
    {
      reply: "¶1 Rent is 1,250 a month, as ¶2 says.",
      result: { kind: "unchanged", said: "Rent is 1,250 a month, as ¶2 says." },
      after: ["Rent is 1,200 a month.", "Water is 30 a month."],
    },
    {
      reply:
        "The task is to take out the water line.\n\n¶2 <removed>Water is 30 a month.</removed>",
      result: { kind: "proposed" },
      after: ["Rent is 1,200 a month."],
    },
    {
      reply: "The task is to delete this line.\n\n¶2 <removed>水费每月30元。</removed>",
      lines: ["房租每月1200元。", "水费每月30元。"],
      result: { kind: "proposed" },
      after: ["房租每月1200元。"],
    },
  ])(
    "a reply is read by its first line that names or rewrites a paragraph: $reply",
    async (each) => {
      const lines = each.lines ?? ["Rent is 1,200 a month.", "Water is 30 a month."];
      const { core, mind, client, before } = await noteOf(plain(lines), () => each.reply);

      expect(await core.editWithAi(wholeMind(client, mind.id, "Rent is 1,250"))).toMatchObject(
        each.result,
      );

      expect(await acceptThenUndo(client, before)).toEqual(each.after);
    },
  );
});

describe("A selection too long for the model is edited in parts (#2348)", () => {
  // The most one request edits is 12,000 characters (`MAX_SELECTION_CHARACTERS`): more is done
  // in parts at Block boundaries, each asked with the same instruction and its own text around it.
  const LINE = "Sailors kept their own tables of the tides and the times of high water. ";
  /** A paragraph of about 10,800 characters: one part, and two of them take more than one request. */
  const body = (index: number) =>
    `Tide table ${index}, the water is very high. ${LINE.repeat(150)}`;

  /** Edit with AI over all of the Mind's text, as Shorten or the like, which shows no names. */
  function wholeOf(
    client: MindClient,
    mindId: string,
    action: EditWithAiInput["action"],
    instruction?: string,
  ): EditWithAiInput {
    const input = wholeMind(client, mindId, instruction ?? "");
    return { ...input, action, ...(instruction !== undefined && { instruction }) };
  }

  test("three times one request's text is edited in three parts, one after another, each with its own text around it, all one request's changes", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replaceAll(" very", ""), calls, { chunkSize: 512 }),
    );
    const notes = [0, 1, 2].map((index) => paragraph(text(body(index))));
    writeMind(client, notes);
    await client.settled();
    const parts: { at: number; of: number }[] = [];
    core.on("mind.writing", (writing) => {
      const part = writing.part;
      const last = parts.at(-1);
      if (part && (!last || last.at !== part.at || last.of !== part.of)) parts.push(part);
    });

    const result = await core.editWithAi(wholeOf(client, mind.id, "shorten"));

    // Three requests, each the next Block's own text, with the same task.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.action)).toEqual(["shorten", "shorten", "shorten"]);
    expect(calls.map((call) => call.passage)).toEqual([0, 1, 2].map((index) => body(index).trim()));
    // Each said which part it wrote, before its own text came.
    expect(parts).toEqual([
      { at: 1, of: 3 },
      { at: 2, of: 3 },
      { at: 3, of: 3 },
    ]);
    // All three parts' changes are one request's: the window applies them as one step, one Undo.
    expect(result).toMatchObject({ kind: "proposed", parts: 3 });
    const request = result.kind === "proposed" ? result.request : "";
    const made = pendingProposals(client.blocks).filter((each) => each.request === request);
    expect(made.length).toBe(result.kind === "proposed" ? result.proposals : 0);
    expect(new Set(pendingProposals(client.blocks).map((each) => each.request))).toEqual(
      new Set([request]),
    );
    // Each part's change is in the Note, over the words it changed.
    expect(shownWithChanges(client)[0]).toContain("Tide table 0, the water is [-very -]high.");
    expect(shownWithChanges(client)[2]).toContain("Tide table 2, the water is [-very -]high.");
  });

  test("stopped partway, the parts already written stay, and nothing after them is asked", async () => {
    const controlled = controlledModel();
    const { core, mind, client } = await setUp(controlled.model);
    const notes = [0, 1, 2].map((index) => paragraph(text(body(index))));
    writeMind(client, notes);
    await client.settled();
    const input = wholeOf(client, mind.id, "shorten");

    const editing = core.editWithAi(input);
    await controlled.requested(1);
    controlled.push(body(0).replaceAll(" very", ""));
    controlled.finish();
    await controlled.requested(2);
    await core.cancelEdit(input.requestId);

    // What the first part wrote stays; the other parts were never asked.
    expect(await editing).toMatchObject({ kind: "proposed" });
    const shown = shownWithChanges(client);
    expect(shown[0]).toContain("Tide table 0, the water is [-very -]high.");
    expect(shown[1]).toBe(body(1));
    expect(shown[2]).toBe(body(2));
    expect(controlled.model.doStreamCalls).toHaveLength(2);
  });

  test("a table is never split across parts: its cells go to the model together", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replaceAll(" very", ""), calls, { chunkSize: 512 }),
    );
    const cell = (words: string): JSONContent => ({
      type: "tableCell",
      content: [paragraph(text(words))],
    });
    /** Exactly `size` characters, starting as the tide line does, so Shorten changes it. */
    const exact = (size: number) => {
      const base = "Tide table 0, the water is very high. ";
      const grown = base + LINE.repeat(Math.ceil(size / LINE.length));
      return `${grown.slice(0, size - 1)}.`;
    };
    writeMind(client, [
      // The limit is 12,000 characters: the cells after this paragraph would fit one by one
      // up to the last, whose text would then go to the model alone.
      paragraph(text(exact(11_900))),
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("Rent very high"), cell("Amount very small")] },
          {
            type: "tableRow",
            content: [cell("Gas very low"), cell(`Water very even ${LINE.repeat(12)}`)],
          },
        ],
      },
      paragraph(text(exact(5_000))),
    ]);
    await client.settled();

    const result = await core.editWithAi(wholeOf(client, mind.id, "shorten"));

    // The paragraph before the table is one part; the table and what follows it, another.
    expect(result).toMatchObject({ kind: "proposed", parts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.passage).not.toContain("Rent");
    expect(calls[1]?.passage).toContain("Rent very high");
    expect(calls[1]?.passage).toContain("Gas very low");
    expect(calls[1]?.passage).toContain("Water very even");
  });

  test("a nested list's items are Blocks of their own: each item goes to the model as its own part", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replaceAll(" very", ""), calls, { chunkSize: 512 }),
    );
    /** About 10,800 characters: under the limit alone, over it with another. */
    const item = (index: number) =>
      `Nested item ${index}, the water is very high. ${LINE.repeat(150)}`;
    writeMind(client, [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("Nested lists, the water is very high.")),
              {
                type: "bulletList",
                content: [0, 1, 2].map((index) => ({
                  type: "listItem",
                  content: [paragraph(text(item(index)))],
                })),
              },
            ],
          },
        ],
      },
    ]);
    await client.settled();

    const result = await core.editWithAi(wholeOf(client, mind.id, "shorten"));

    // The bullets and the item above them are each a Block, so they are edited in three parts.
    expect(result).toMatchObject({ kind: "proposed", parts: 3 });
    expect(calls).toHaveLength(3);
    expect(calls.map((each) => each.passage.includes("Nested item 2"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("one Block over the limit is said so, with nothing sent: a Block can't be split", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(({ passage }) => passage.replaceAll(" very", ""), calls),
    );
    const huge = paragraph(text(`The water is very high. ${LINE.repeat(180)}`));
    writeMind(client, [huge]);
    await client.settled();

    expect(await core.editWithAi(wholeOf(client, mind.id, "shorten"))).toEqual({
      kind: "block-too-long",
      cause: "cap",
    });
    expect(calls).toHaveLength(0);
    expect(pendingProposals(client.blocks)).toHaveLength(0);
  });

  test("a part the model gives back as it was still counts in how many parts the edit was", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(
        // The second part comes back as it was, as a model does when nothing there needs changing.
        ({ passage }) =>
          passage.startsWith("Tide table 1") ? passage : passage.replaceAll(" very", ""),
        calls,
        { chunkSize: 512 },
      ),
    );
    writeMind(
      client,
      [0, 1, 2].map((index) => paragraph(text(body(index)))),
    );
    await client.settled();

    const result = await core.editWithAi(wholeOf(client, mind.id, "shorten"));

    expect(calls).toHaveLength(3);
    // The line said "Writing part 3 of 3…", and it was three parts, though one changed nothing.
    expect(result).toMatchObject({ kind: "proposed", parts: 3 });
  });

  test("a part that fails takes every part back: the edit is one step, or none", async () => {
    const calls: EditCall[] = [];
    const { core, mind, client } = await setUp(
      editingModel(
        ({ passage }) => {
          // The second part fails, as a provider does now and then.
          if (passage.startsWith("Tide table 1")) {
            throw new APICallError({
              message: "Overloaded",
              url: "https://fake.invalid/chat",
              requestBodyValues: {},
              statusCode: 529,
            });
          }
          return passage.replaceAll(" very", "");
        },
        calls,
        { chunkSize: 512 },
      ),
    );
    const notes = [0, 1, 2].map((index) => paragraph(text(body(index))));
    writeMind(client, notes);
    await client.settled();

    const result = await core.editWithAi(wholeOf(client, mind.id, "shorten"));

    expect([...new Set(calls.map((call) => call.passage.trim()))]).toEqual([
      body(0).trim(),
      body(1).trim(),
    ]);
    expect(result.kind).toBe("failed");
    // The first part's changes, applied before the second failed, are gone with it.
    expect(pendingProposals(client.blocks)).toHaveLength(0);
    expect(shownWithChanges(client)).toEqual([body(0), body(1), body(2)]);
  });
});
