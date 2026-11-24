/**
 * A deck an agent handed over, edited by hand (#149): one IncarnaMind keeps takes one new version a
 * sitting, and the agent's own file is never written; an agent's hand-over during a sitting becomes
 * the newest, and the sitting writes nothing over it; one handed over from a Linked folder is that
 * file, written itself, as a file of the User's own is. The agent calls through the shim the app
 * ships; the checks run on the scripted checking model.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { type DeckEdit, type Document, NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { hashBytes } from "../../src/core/documents/files";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { linkWithoutFolder, waitForDocuments } from "../helpers/documents";
import { DECK, type Handed, handOver, NORTH, started, structured } from "../helpers/handedFiles";
import { plainDeck } from "../helpers/pptx";

const NAME = "Harbour review.pptx";
const CORRECTED = "The south quay holds 19 boats.";

/** Slide 2's text box, its second line typed over. */
const typed = (south: string) => [
  {
    kind: "text" as const,
    slide: 2,
    shape: "3",
    paragraphs: [
      { source: 0, runs: [{ source: { paragraph: 0, run: 0 }, text: NORTH }] },
      { source: 1, runs: [{ source: { paragraph: 1, run: 0 }, text: south }] },
    ],
  },
];

const moved = (x: number) => [
  { kind: "box" as const, slide: 2, shape: "3", box: { x, y: 115, w: 840, h: 126 } },
];

const saved = (edit: DeckEdit) => {
  if (edit.kind !== "saved") throw new Error(`Not saved: ${edit.why}`);
  return edit;
};

/** The deck's one Document once it holds `hash`. */
async function deckHolding(core: Core, hash: string): Promise<Document> {
  const documents = await waitForDocuments(core, (all) =>
    expect(all.find((each) => each.name.startsWith("Harbour review"))?.contentHash).toBe(hash),
  );
  const document = documents.find((each) => each.name.startsWith("Harbour review"));
  if (!document) throw new Error("no deck");
  return document;
}

describe("a deck an agent handed over, edited by hand", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("takes one new version a sitting, the User's, and the agent's own file is never written", async () => {
    const set = await started();
    const agent = await connectLegacyAgent(set.writer.launch);
    const path = join(set.files, NAME);
    await writeFile(path, DECK);
    const handed = structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
    expect(handed.version).toBe(1);
    const document = await deckHolding(set.core, hashBytes(DECK));
    expect(document.linkedFolderId).toBeNull();

    const first = saved(
      await set.core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: typed(CORRECTED),
      }),
    );
    expect(first.saved).toEqual({ kind: "version", number: 2 });
    const second = saved(
      await set.core.editDeck({
        documentId: document.id,
        sittingId: first.sittingId,
        shown: "",
        edits: moved(60),
      }),
    );
    expect(second.saved).toEqual({ kind: "version", number: 2 });
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(DECK));

    const versions = (await set.core.handedFileOf(handed.mindId ?? ""))?.versions ?? [];
    expect(
      versions.map(({ number, agent: by, contentHash }) => ({ number, by, contentHash })),
    ).toEqual([
      { number: 1, by: "Claude Code", contentHash: hashBytes(DECK) },
      { number: 2, by: "", contentHash: hashBytes(second.bytes) },
    ]);
    expect(await set.core.keptDeckStates(document.id)).toEqual({ sitting: null, first: null });

    // The next sitting makes the next version.
    await set.core.closeDeckSitting(first.sittingId);
    const now = await deckHolding(set.core, hashBytes(second.bytes));
    const third = saved(
      await set.core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: now.contentHash,
        edits: moved(80),
      }),
    );
    expect(third.saved).toEqual({ kind: "version", number: 3 });
    await set.core.close();
  });

  it("an agent's hand-over during a sitting becomes the newest: nothing is written over it and Undo is refused", async () => {
    const set = await started();
    const agent = await connectLegacyAgent(set.writer.launch);
    const path = join(set.files, NAME);
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
    const document = await deckHolding(set.core, hashBytes(DECK));
    const first = saved(
      await set.core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: typed(CORRECTED),
      }),
    );

    const theirs = plainDeck([
      { title: "Harbour review" },
      { lines: [NORTH, "The south quay holds 21 boats."] },
    ]);
    await writeFile(path, theirs);
    const again = structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
    expect(again.version).toBe(3);
    await deckHolding(set.core, hashBytes(theirs));

    await expect(
      set.core.editDeck({
        documentId: document.id,
        sittingId: first.sittingId,
        shown: "",
        edits: moved(60),
      }),
    ).rejects.toThrow(/changed since/);
    await expect(set.core.undoDeckEdit(first.sittingId, first.stepId)).rejects.toThrow();
    const newest = await deckHolding(set.core, hashBytes(theirs));
    expect(newest.id).toBe(document.id);
    await set.core.close();
  });

  it("no Tool an outside agent can call writes a deck: the hand edits are the window's alone", async () => {
    const set = await started();
    const agent = await connectLegacyAgent(set.writer.launch);
    const tools = ((await agent.listTools()).tools ?? []).map((each) => each.name);
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.filter((name) => /deck|slide|restore|put_back|kept/i.test(name))).toEqual([]);
    await set.core.close();
  });

  it("one handed over from a Linked folder is that file, written itself, kept as it stood first", async () => {
    const set = await started();
    await linkWithoutFolder(set.core, set.files);
    await set.core.updateAgent(set.writer.pairing.id, {
      folderIds: [set.coast.id, NOT_IN_A_FOLDER_ID],
    });
    const agent = await connectLegacyAgent(set.writer.launch);
    const path = join(set.files, NAME);
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
    await set.core.reconcileDocuments();
    const document = await deckHolding(set.core, hashBytes(DECK));
    expect(document.linkedFolderId).not.toBeNull();
    // Handing it over wrote nothing to it.
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(DECK));

    const edit = saved(
      await set.core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: typed(CORRECTED),
      }),
    );
    expect(edit.saved).toMatchObject({ kind: "file", name: NAME });
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(edit.bytes));
    expect((await set.core.keptDeckStates(document.id)).sitting).not.toBeNull();
    await set.core.close();
  });
});
