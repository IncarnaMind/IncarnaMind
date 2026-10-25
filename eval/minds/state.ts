/**
 * Minds as the evaluation reads them from the core, and the three things a
 * User does with an Answer's card: Accept all, Reject all and Undo. They are
 * applied to a copy of each Mind with the functions the card uses
 * (src/renderer/src/mindChanges.ts), not through the window.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type Core,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  MIND_PROPOSAL_REQUESTS_FIELD,
  type ProposalRef,
} from "../../src/core";
import type { ChangeStates } from "../../src/core/answers/toolRecord";
import { plainText } from "../../src/core/mindText";
import { messageReference } from "../../src/core/references";
import type { ChangedMind } from "../../src/renderer/src/changedMinds";
import { askedFor, waitsForUser } from "../../src/shared/askedChanges";
import { originMaps, setOrigins } from "../../src/shared/blockOrigins";
import { holdsOnlyItsTitle } from "../../src/shared/madeMind";
import { decideProposals, pendingProposals } from "../../src/shared/proposals";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../../tests/helpers/minds";
import type { SeedMind } from "./cases";

/** A paragraph or heading, wherever it sits in a Block, keyed by its Block and its place in it. */
export interface Unit {
  key: string;
  type: "paragraph" | "heading";
  text: string;
}

export interface BlockState {
  id: string;
  type: string;
  level: number | null;
  text: string;
}

export interface MindState {
  id: string;
  title: string;
  blocks: BlockState[];
  units: Unit[];
  /** The Mind with its waiting changes marked, one line a paragraph. */
  shown: string;
  pending: number;
}

function unitsOf(blockId: string, element: Y.XmlElement): Unit[] {
  const found: Unit[] = [];
  const visit = (each: Y.XmlElement) => {
    if (each.nodeName === "paragraph" || each.nodeName === "heading") {
      found.push({
        key: `${blockId}#${found.length}`,
        type: each.nodeName,
        text: plainText(each),
      });
      return;
    }
    for (const child of each.toArray()) if (child instanceof Y.XmlElement) visit(child);
  };
  visit(element);
  return found;
}

export async function readState(core: Core, mindId: string, title: string): Promise<MindState> {
  const { state } = await core.openMind(mindId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const fragment = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const blocks: BlockState[] = [];
  const units: Unit[] = [];
  for (const block of fragment.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    const id = String(block.getAttribute(BLOCK_ID_ATTRIBUTE) ?? "");
    const level = Number(block.getAttribute("level"));
    blocks.push({
      id,
      type: block.nodeName,
      level: block.nodeName === "heading" && Number.isFinite(level) ? level : null,
      text: plainText(block),
    });
    units.push(...unitsOf(id, block));
  }
  return {
    id: mindId,
    title,
    blocks,
    units,
    shown: shownWithChanges({ blocks: fragment }).join("\n"),
    pending: pendingProposals(fragment).length,
  };
}

export async function readWorkspace(core: Core): Promise<MindState[]> {
  const minds = await core.listMinds();
  return Promise.all(minds.map((mind) => readState(core, mind.id, mind.title)));
}

/**
 * Seeds the Minds. `written` names Minds whose text is AI text: a Meeting's notes filled after
 * Stop ("ai"), or what an Answer added, with its origin ("answer").
 */
export async function seedWorkspace(
  core: Core,
  seeds: readonly SeedMind[],
  written: { titles: readonly string[]; by: "ai" | "answer" } | null = null,
): Promise<void> {
  for (const seed of seeds) {
    const mind = await core.createMind({ title: seed.title });
    const client = await connectToMind(core, mind.id);
    const blocks = seed.blocks.map((line) =>
      line.startsWith("## ") ? heading(2, line.slice(3)) : note(line),
    );
    const by = written?.titles.includes(seed.title) ? written.by : null;
    writeMind(client, by ? blocks.map(asGenerated) : blocks);
    if (by === "answer") {
      const ids = blocks.flatMap((block) =>
        typeof block.attrs?.id === "string" ? [block.attrs.id] : [],
      );
      setOrigins(client.doc, ids, {
        from: messageReference(randomUUID(), randomUUID()),
        question: "",
      });
    }
    await client.settled();
  }
}

const asGenerated = (block: JSONContent): JSONContent => ({
  ...block,
  content: block.content?.map((child) =>
    child.type === "text"
      ? { ...child, marks: [...(child.marks ?? []), { type: GENERATED_MARK }] }
      : child,
  ),
});

export interface Decided {
  /** How many changes it took in the Minds it reached. */
  count: number;
  undo(): Promise<void>;
}

/**
 * Accept all or Reject all on an Answer's card: each row's changes in its
 * Mind, one Undo for all of them. Rejecting a Mind the Answer made removes it
 * once nothing else is in it, and Undo brings it back.
 */
export async function decideAll(
  core: Core,
  rows: readonly ChangedMind[],
  outcome: "accept" | "reject",
): Promise<Decided> {
  const steps: { undo(): Promise<void> }[] = [];
  let count = 0;
  for (const row of rows) {
    const client = await connectToMind(core, row.mindId);
    const picked = (proposal: ProposalRef) => row.requests.includes(proposal.request);
    if (!pendingProposals(client.blocks).some(picked)) continue;
    const origin = { decided: row.mindId };
    const manager = new Y.UndoManager(
      [client.blocks, client.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD), ...originMaps(client.doc)],
      { trackedOrigins: new Set([origin]) },
    );
    client.doc.transact(() => {
      count += decideProposals(client.blocks, picked, outcome).length;
    }, origin);
    await client.settled();
    const undoText = async () => {
      manager.undo();
      await client.settled();
    };
    const title = (await core.listMinds()).find((mind) => mind.id === row.mindId)?.title ?? "";
    if (outcome === "reject" && row.created && holdsOnlyItsTitle(client.blocks, title)) {
      await core.deleteMind(row.mindId);
      steps.push({
        undo: async () => {
          await core.restore([{ kind: "mind", id: row.mindId }]);
          await undoText();
        },
      });
    } else steps.push({ undo: undoText });
  }
  return {
    count,
    undo: async () => {
      for (const step of [...steps].reverse()) await step.undo();
    },
  };
}

/**
 * Which changes apply at once and which wait for the User, as the app tells the model in its own
 * turn: asked for, and not taking out most of the User's own text in their Mind.
 */
export async function changeStatesOf(
  core: Core,
  rows: readonly ChangedMind[],
): Promise<ChangeStates> {
  const applied = new Set<string>();
  for (const row of rows) {
    const { state } = await core.openMind(row.mindId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const held = waitsForUser(doc, new Set(row.requests));
    for (const request of row.requests) {
      if (!held && askedFor(doc, request)) applied.add(`${row.mindId} ${request}`);
    }
  }
  return (change) =>
    applied.has(`${change.mindId} ${change.request}`)
      ? { waiting: 0, accepted: 0, rejected: 0, applied: true }
      : null;
}
