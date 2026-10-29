import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  type CitationAttributes,
  type ConversationAnswer,
  type Core,
  type Document,
  messageReference,
} from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { citationState, needsRecheck, newVersionCitation } from "../../src/shared/citations";
import { recheckCitations } from "../../src/shared/noteBlocks";
import { citingModel, setUpWithDocuments } from "../helpers/citations";
import { queryDatabase, startCore } from "../helpers/core";
import { sha256, waitForProcessing } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

/**
 * A Citation keeps the version it quotes when its Answer goes into a Mind (ADR-0017's
 * amendment): Add to note, New note and the Mind the editor adds into at its cursor check it
 * again in that version, never re-pointing it at a newer one. Its Document changed since, it
 * lands saying so and asking to be checked again, with the words as they changed; unchanged, it
 * lands checked as before. The version it quotes stays for as long as it does.
 */

const OLD = "For the Supplier, the notice period is sixty (60) days.";
const NEW = "For the Supplier, the notice period is forty-five (45) days.";
const pdf = (clause: string) =>
  buildPdf([
    { lines: ["Amendment No. 2", "Clause 12.1 applies to both parties."] },
    { lines: ["Clause 12.2", clause] },
  ]);
const V1 = pdf(OLD);
const V2 = pdf(NEW);
/** The clause struck out: its words are gone. */
const V3 = pdf("Clause 12.2 was struck out by the parties.");
const QUESTION = "What notice does the Supplier give?";

/** A core with an Answer in a conversation citing version 1 of the amendment. */
async function citedAnswer(
  name = "Amendment.pdf",
  contents: Uint8Array | string = V1,
  quote = OLD,
  query = "notice period",
) {
  const model = citingModel({
    query,
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.text.includes(quote.slice(0, 12)))?.id,
        ...(typeof contents === "string" ? {} : { pageFrom: 2, pageTo: 2 }),
        quote,
      },
    ],
    answer: "The Supplier gives notice as the amendment says [^1].",
  });
  const setup = await setUpWithDocuments(model, [{ name, contents }]);
  const document = setup.documents[0];
  if (!document?.path) throw new Error("Nothing was added.");
  const result = await setup.core.askInConversation({ text: QUESTION });
  if (!result.asked) throw new Error("Not asked.");
  await new Promise<void>((resolve) => {
    const stop = setup.core.on("answer.finished", ({ answerId }) => {
      if (answerId !== result.answerId) return;
      stop();
      resolve();
    });
  });
  const { messages } = await setup.core.getConversation(result.conversation.id);
  const answer = messages.find((each) => each.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  expect(answer.citations).toEqual([expect.objectContaining({ check: "found", quote })]);
  return { ...setup, document: { ...document, path: document.path }, answer };
}

/** Writes a new version of the file and waits until it is the current one. */
async function change(
  core: Core,
  document: Document & { path: string },
  contents: Uint8Array | string,
) {
  await writeFile(document.path, contents);
  await core.reconcileDocuments();
  const [processed] = await waitForProcessing(core, [document.id]);
  expect(processed?.contentHash).toBe(sha256(contents));
}

const origin = (answer: ConversationAnswer) => ({
  from: messageReference(answer.conversationId, answer.id),
  question: QUESTION,
});

function citationsOf(blocks: readonly NodeJSON[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: NodeJSON) => {
    if (node.type === "citation") found.push(node.attrs ?? {});
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return found;
}

async function citationsInMind(core: Core, mindId: string) {
  const found: CitationAttributes[] = [];
  readMind(await connectToMind(core, mindId)).descendants((node) => {
    if (node.type.name === "citation") found.push(node.attrs as CitationAttributes);
  });
  return found;
}

/** The three ways an Answer lands in a Mind, as the assistant's Add to note and New note do them. */
const LANDINGS = {
  /** Add to note into a Mind that isn't open: at its end, through the core. */
  "Add to note": async (core: Core, answer: ConversationAnswer) => {
    const mind = await core.createMind({ title: "Notice" });
    await core.addToNote({
      mindId: mind.id,
      blocks: answerBlocks(answer),
      origin: origin(answer),
      model: answer.model,
    });
    return citationsInMind(core, mind.id);
  },
  /** New note: a Mind made for the Answer, with it in at once. */
  "New note": async (core: Core, answer: ConversationAnswer) => {
    const mind = await core.createMind({ title: "" });
    await core.addToNote({
      mindId: mind.id,
      blocks: answerBlocks(answer),
      origin: origin(answer),
      model: answer.model,
    });
    return citationsInMind(core, mind.id);
  },
  /** Add to note into the Mind open in the editor, which checks them through the bridge. */
  "the open Mind": async (core: Core, answer: ConversationAnswer) =>
    citationsOf(
      await recheckCitations(answerBlocks(answer), (input) =>
        core.recheckCitation({ ...input, mindId: null }),
      ),
    ) as unknown as CitationAttributes[],
} as const;

const KEPT = [
  "passageId",
  "documentId",
  "contentHash",
  "pageFrom",
  "pageTo",
  "location",
  "quote",
] as const;
const kept = (citation: Partial<CitationAttributes>) =>
  Object.fromEntries(KEPT.map((field) => [field, citation[field]]));

describe("A Citation keeps the version it quotes where its Answer lands", {
  timeout: 60_000,
}, () => {
  // protects=each way an Answer lands in a Mind keeps a Citation of a Document changed since on the version it quotes (its Passage, Units, Location and quote), checked there, and it then says the Document changed and needs re-check, with the cited words as they changed and the words now to move to; fails_when=it is re-pointed at the new version, or lands quiet; no_claim=how the card draws it (e2e).
  test.each(Object.keys(LANDINGS) as (keyof typeof LANDINGS)[])(
    "%s: a Document changed since keeps the version it quotes and needs re-check",
    async (landing) => {
      const { core, document, answer } = await citedAnswer();
      const [cited] = answer.citations;
      await change(core, document, V2);

      const [landed] = await LANDINGS[landing](core, answer);

      expect(kept(landed ?? {})).toEqual(kept(cited ?? {}));
      expect(landed).toMatchObject({ contentHash: sha256(V1), check: "found", checkReason: null });
      const state = citationState(landed ?? {}, await core.listDocuments());
      expect(state.changedAfterCited).toBe(true);
      const recheck = await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        quote: OLD,
        pageFrom: 2,
        pageTo: 2,
        contentHash: landed?.contentHash ?? null,
      });
      expect(recheck).toMatchObject({
        check: "not-found",
        contentHash: sha256(V2),
        inQuotedVersion: { check: "found", checkReason: null },
        changed: {
          parts: [
            { kind: "same", text: "For the Supplier, the notice period is " },
            { kind: "removed", text: "sixty (60)" },
            { kind: "added", text: "forty-five (45)" },
            { kind: "same", text: " days." },
          ],
          now: { quote: NEW, check: "found", contentHash: sha256(V2), pageFrom: 2, pageTo: 2 },
        },
      });
      expect(needsRecheck(state, landed ?? {}, recheck)).toBe(true);
      expect(newVersionCitation(landed ?? {}, recheck)).toMatchObject({
        contentHash: sha256(V2),
        quote: NEW,
        check: "found",
        pageFrom: 2,
        keptOver: null,
      });
    },
  );

  // protects=a Citation whose Document didn't change lands checked against the current version, as before; fails_when=its check or place changes, or it says the Document changed; no_claim=none beyond protects.
  test.each(Object.keys(LANDINGS) as (keyof typeof LANDINGS)[])(
    "%s: an unchanged Document lands checked as before",
    async (landing) => {
      const { core, answer } = await citedAnswer();

      const [landed] = await LANDINGS[landing](core, answer);

      expect(kept(landed ?? {})).toEqual(kept(answer.citations[0] ?? {}));
      expect(landed).toMatchObject({ check: "found", contentHash: sha256(V1) });
      const state = citationState(landed ?? {}, await core.listDocuments());
      expect(state.changedAfterCited).toBe(false);
      expect(needsRecheck(state, landed ?? {}, null)).toBe(false);
    },
  );

  // protects=the Document changed twice keeps the first version; words gone from the newest say so and offer nothing to move to; one the User kept citing over a version is quiet until a newer one comes; fails_when=it moves, says words changed that are gone, or asks again over a version the User kept; no_claim=none beyond protects.
  test("changed twice, the words gone, and kept over a version", async () => {
    const { core, document, answer } = await citedAnswer();
    await change(core, document, V2);
    await change(core, document, V3);

    const [landed] = await LANDINGS["Add to note"](core, answer);

    expect(landed).toMatchObject({ contentHash: sha256(V1), check: "found" });
    const input = { documentId: document.id, quote: OLD, pageFrom: 2, pageTo: 2 };
    const gone = await core.recheckCitation({ mindId: null, ...input, contentHash: sha256(V1) });
    expect(gone).toMatchObject({ check: "not-found", contentHash: sha256(V3), changed: null });
    const state = citationState(landed ?? {}, await core.listDocuments());
    expect(needsRecheck(state, landed ?? {}, gone)).toBe(true);
    expect(newVersionCitation(landed ?? {}, gone)).toBeNull();

    // Kept over version 3: quiet. A Citation pinned so lands with it, and asks again at version 2.
    const pinned = { ...landed, keptOver: sha256(V3) };
    expect(needsRecheck(state, pinned, gone)).toBe(false);
    const [again] = citationsOf(
      await recheckCitations(
        [{ type: "paragraph", content: [{ type: "citation", attrs: pinned }] }],
        (each) => core.recheckCitation({ ...each, mindId: null }),
      ),
    );
    expect(again).toMatchObject({ contentHash: sha256(V1), keptOver: sha256(V3) });
    await change(core, document, V2);
    const back = await core.recheckCitation({ mindId: null, ...input, contentHash: sha256(V1) });
    expect(needsRecheck(state, pinned, back)).toBe(true);
  });

  // protects=a Citation of a deleted Document lands as it was and says it can't be checked; the same Answer added twice keeps the version twice; fails_when=either is re-pointed or lost; no_claim=none beyond protects.
  test("a deleted Document, and the same Answer added twice", async () => {
    const { core, document, answer } = await citedAnswer();
    await change(core, document, V2);
    const mind = await core.createMind({ title: "Twice" });
    for (let time = 0; time < 2; time++) {
      await core.addToNote({
        mindId: mind.id,
        blocks: answerBlocks(answer),
        origin: origin(answer),
        model: answer.model,
      });
    }
    expect((await citationsInMind(core, mind.id)).map(kept)).toEqual(
      [0, 1].map(() => kept(answer.citations[0] ?? {})),
    );

    await core.deleteDocument(document.id);
    const [removed] = await LANDINGS["Add to note"](core, answer);
    expect(kept(removed ?? {})).toEqual(kept(answer.citations[0] ?? {}));
    expect(citationState(removed ?? {}, await core.listDocuments())).toMatchObject({
      check: "cant-check",
      reason: "document-removed",
    });
  });

  // protects=Chinese words that changed in a Markdown section show as they changed, and the new words are what Update the sentence… cites; fails_when=the words are cut inside a word or the new ones aren't found; no_claim=none beyond protects.
  test("Chinese words in a Markdown section, as they changed", async () => {
    const before = "供应商的通知期为六十（60）天。";
    const after = "供应商的通知期为四十五（45）天。";
    const markdown = (clause: string) =>
      `# 第 12.2 条\n\n${clause}\n\n# 第 13 条\n\n双方另行约定。\n`;
    const { core, document, answer } = await citedAnswer(
      "修订协议.md",
      markdown(before),
      before,
      "通知期",
    );
    await change(core, document, markdown(after));

    const [landed] = await LANDINGS["the open Mind"](core, answer);

    expect(kept(landed ?? {})).toEqual(kept(answer.citations[0] ?? {}));
    const recheck = await core.recheckCitation({
      mindId: null,
      documentId: document.id,
      quote: before,
      pageFrom: landed?.pageFrom ?? null,
      pageTo: landed?.pageTo ?? null,
      contentHash: landed?.contentHash ?? null,
    });
    expect(recheck.changed?.parts).toEqual([
      { kind: "same", text: "供应商的通知期为" },
      { kind: "removed", text: "六十（60）" },
      { kind: "added", text: "四十五（45）" },
      { kind: "same", text: "天。" },
    ]);
    expect(recheck.changed?.now).toMatchObject({ quote: after, check: "found" });
  });
});

/** The page rows kept of each version of the Documents, by content hash. */
const pagesByVersion = (dataDir: string) =>
  Object.fromEntries(
    queryDatabase<{ content_hash: string; pages: number }>(
      dataDir,
      `SELECT content_hash, count(*) AS pages FROM document_pages
       WHERE deleted_at IS NULL GROUP BY content_hash`,
    ).map((row) => [row.content_hash, row.pages]),
  );

describe("The version a landed Citation quotes is kept", { timeout: 60_000 }, () => {
  // protects=the version a landed Citation quotes stays through restarts while the Citation is in a Mind, the Mind in Recently deleted included, after its conversation is deleted for good, and goes once its Mind is too; Undo of the landing leaves the conversation's Citation to keep it; fails_when=the text goes while a Citation quotes it, or stays after; no_claim=none beyond protects.
  test("while its Mind holds it, and no longer once nothing quotes it", async () => {
    const { core, dataDir, document, answer } = await citedAnswer();
    await change(core, document, V2);
    const undone = await core.createMind({ title: "Undone" });
    const added = await core.addToNote({
      mindId: undone.id,
      blocks: answerBlocks(answer),
      origin: origin(answer),
      model: answer.model,
    });
    await core.undoAddToNote({ mindId: undone.id, blockIds: added.blockIds });
    core.close();

    // Only the conversation quotes version 1 now.
    const second = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V2)]: 2 });
    const mind = await second.createMind({ title: "Notice" });
    await second.addToNote({
      mindId: mind.id,
      blocks: answerBlocks(answer),
      origin: origin(answer),
      model: answer.model,
    });
    await second.deleteConversation(answer.conversationId);
    await second.deletePermanently([{ kind: "conversation", id: answer.conversationId }]);
    await second.deleteMind(mind.id);
    second.close();

    // Only the Mind in Recently deleted quotes it.
    const third = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V2)]: 2 });
    await third.deletePermanently([{ kind: "mind", id: mind.id }]);
    third.close();

    startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V2)]: 2 });
  });
});
