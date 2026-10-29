/**
 * "Add to note" into a Mind that isn't open in the editor (#201): Blocks from
 * an Answer in the assistant go at the end of the Mind's note, each Citation
 * in them checked again against its Document there, with a link back to the
 * Answer (`MIND_ORIGINS_FIELD`). What goes in at once is recorded as AI use
 * (#292); Blocks `proposed` (a new Mind made from an Answer) wait as changes
 * to accept or reject, each Block one, and are recorded once accepted. Their
 * words go in as AI text (`GENERATED_MARK`). Undo takes them out again. The
 * Mind open in the editor adds at its cursor itself, by the same rules
 * (src/shared/noteBlocks.ts).
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { asGenerated } from "../shared/aiText";
import { parseOrigin, removeOrigins, setOrigins } from "../shared/blockOrigins";
import { installFigureRuns, readFigureRunClosure } from "../shared/figureRuns";
import { carryAnswerScope, uncarryAnswerScope } from "../shared/mindScope";
import {
  citedTables,
  parseNoteBlocks,
  recheckCitations,
  textLength,
  withoutIds,
} from "../shared/noteBlocks";
import { pendingProposals, proposalRequestOf, recordProposalRequest } from "../shared/proposals";
import {
  contentHash,
  createElement,
  type NodeJSON,
  textAttribute,
  topLevelBlocks,
} from "./answers/blocks";
import {
  type AddedToNote,
  BLOCK_ID_ATTRIBUTE,
  type BlockOrigin,
  type ChatModelChoice,
  type CitationRecheck,
  PROPOSAL_ATTRIBUTE,
  type ProposalAttribute,
  type ProposalRequest,
  type RecheckCitationInput,
  type RecordAiUseInput,
  type SearchScope,
} from "./api";
import { InvalidInputError, isRecord } from "./errors";
import type { MindContent } from "./mindContent";
import { isChatModelChoice } from "./settings";

export interface NoteAddingOptions {
  content: MindContent;
  /** Throws unless the Mind exists and can be written to; returns its id. */
  requireMind(mindId: unknown): string;
  recheck(input: RecheckCitationInput): CitationRecheck;
  /** The Search scope the Question of the Answer Blocks came from was asked with; null for none. */
  /** The Search scope the Answer at `origin` was asked with, as the Mind `mindId` may keep it. */
  askedScope(origin: BlockOrigin, mindId: string): SearchScope | null;
  mindFolder(mindId: string): string | null;
  /** Keeps what the AI put into a Mind in the record of AI use. */
  recordAiUse(inputs: RecordAiUseInput[]): void;
  now(): Date;
}

const isEmptyLine = (block: Y.XmlElement | undefined) =>
  block?.nodeName === "paragraph" && block.length === 0;

/** A Block as a Proposal of `request` that adds it whole. */
const proposed = (block: NodeJSON, request: string): NodeJSON => ({
  ...block,
  attrs: {
    ...block.attrs,
    [PROPOSAL_ATTRIBUTE]: {
      id: randomUUID(),
      request,
      kind: "insert",
    } satisfies ProposalAttribute,
  },
});

/**
 * Puts `blocks` into a Mind's note: right after the top-level Block `after`,
 * or at the end, in place of its empty last line, as a Question asked there
 * would be. With `request`, each Block is a Proposal of it that adds the
 * Block whole, waiting to be accepted. Returns their ids. Call it in a Yjs
 * transaction.
 */
export function insertBlocks(
  note: Y.XmlFragment,
  blocks: readonly NodeJSON[],
  { after = null, request = null }: { after?: Y.XmlElement | null; request?: string | null } = {},
): string[] {
  const elements = blocks.map((block) =>
    createElement(request === null ? block : proposed(block, request)),
  );
  const index = after ? note.toArray().indexOf(after) : -1;
  if (index >= 0) {
    note.insert(index + 1, elements);
  } else {
    const last = topLevelBlocks(note).at(-1);
    if (isEmptyLine(last) && note.get(note.length - 1) === last) {
      note.delete(note.length - 1, 1);
    }
    note.insert(note.length, elements);
  }
  return elements.map((element) => textAttribute(element, BLOCK_ID_ATTRIBUTE) ?? "");
}

function parseBlockIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((id): id is string => typeof id === "string" && id !== "")
  ) {
    throw new InvalidInputError("blockIds must be a list of Block ids.");
  }
  return value;
}

/** A request's changes still waiting in a note: null when it hasn't proposed there. */
function proposalsOf(note: Y.XmlFragment, request: string) {
  const doc = note.doc;
  if (!doc || proposalRequestOf(doc, request) === null) return null;
  const mine = pendingProposals(note).filter((each) => each.request === request);
  return { proposalId: mine[0]?.id ?? "", changes: mine.length };
}

export function createNoteAdding(options: NoteAddingOptions) {
  const { content } = options;
  // Undo is offered only while the app runs: what an add brought, by its first Block, stays here.
  const carried = new Map<string, SearchScope>();
  // What each Block said when it went in, to keep a Block the User has changed since out of Undo.
  const written = new Map<string, string>();

  return {
    async add(input: unknown): Promise<AddedToNote> {
      if (!isRecord(input)) throw new InvalidInputError("addToNote expects an object.");
      const mindId = options.requireMind(input.mindId);
      const parsed = parseNoteBlocks(input.blocks);
      if (!parsed) {
        throw new InvalidInputError("addToNote takes a list of Notes, as the editor writes them.");
      }
      const figureRuns = readFigureRunClosure(parsed, input.figureRuns ?? []);
      const origin =
        input.origin === null || input.origin === undefined ? null : parseOrigin(input.origin);
      if (input.origin && !origin) throw new InvalidInputError("That isn't a Block's origin.");
      const model: ChatModelChoice | null = isChatModelChoice(input.model) ? input.model : null;
      const proposed = input.proposed === true;
      const blocks = asGenerated(
        await recheckCitations(citedTables(withoutIds(parsed)), (each) =>
          options.recheck({ ...each, mindId }),
        ),
      );
      const request = randomUUID();
      const asked = origin ? options.askedScope(origin, mindId) : null;
      const folderId = options.mindFolder(mindId);

      const blockIds = content.edit(mindId, (note) => {
        if (note.doc) installFigureRuns(note.doc, figureRuns);
        const ids = insertBlocks(note, blocks, {
          request: proposed ? request : null,
        });
        for (const block of topLevelBlocks(note)) {
          const id = textAttribute(block, BLOCK_ID_ATTRIBUTE);
          if (id && ids.includes(id)) written.set(id, contentHash(block));
        }
        const doc = note.doc;
        if (doc && origin) setOrigins(doc, ids, origin);
        const brought = doc && carryAnswerScope(doc, asked, folderId);
        if (brought && ids[0]) carried.set(ids[0], brought);
        if (doc && proposed && model && !proposalRequestOf(doc, request)) {
          recordProposalRequest(doc, request, {
            source: "answer-added",
            providerId: model.providerId,
            modelId: model.modelId,
            createdAt: options.now().toISOString(),
          });
        }
        return ids;
      });
      // A change to accept is recorded once it is accepted, as Edit with AI's are.
      if (!proposed) {
        options.recordAiUse([
          {
            mindId,
            kind: "answer-added",
            providerId: model?.providerId ?? null,
            modelId: model?.modelId ?? null,
            characters: textLength(blocks),
            blockIds,
          },
        ]);
      }
      return { mindId, blockIds };
    },

    /**
     * Puts a Task's cited Blocks at the Mind's end as changes to accept, one
     * a Block, under `request`, their Citations checked again. Once only: a
     * Task that goes on after a quit finds them there and adds nothing.
     * Returns the first change's id and how many there are.
     */
    async propose(
      mindId: string,
      given: readonly NodeJSON[],
      request: string,
      made: ProposalRequest,
    ): Promise<{ proposalId: string; changes: number }> {
      const blocks = asGenerated(
        await recheckCitations(citedTables(withoutIds(given)), (each) =>
          options.recheck({ ...each, mindId }),
        ),
      );
      return content.edit(mindId, (note) => {
        const earlier = proposalsOf(note, request);
        if (earlier) return earlier;
        insertBlocks(note, blocks, { request });
        if (note.doc) recordProposalRequest(note.doc, request, made);
        return proposalsOf(note, request) ?? { proposalId: "", changes: 0 };
      });
    },

    /** A request's changes in a Mind, once it has proposed there; null before. */
    proposed(mindId: string, request: string): { proposalId: string; changes: number } | null {
      return content.read(mindId, (note) => proposalsOf(note, request));
    },

    undo(input: unknown): { kept: number } {
      if (!isRecord(input)) throw new InvalidInputError("undoAddToNote expects an object.");
      const mindId = options.requireMind(input.mindId);
      const blockIds = new Set(parseBlockIds(input.blockIds));
      return content.edit(mindId, (note) => {
        let kept = 0;
        const removed: string[] = [];
        // From the end, so each index stays right.
        for (let index = note.length - 1; index >= 0; index--) {
          const block = note.get(index);
          if (!(block instanceof Y.XmlElement)) continue;
          const id = textAttribute(block, BLOCK_ID_ATTRIBUTE) ?? "";
          if (!blockIds.has(id)) continue;
          // Its words changed since it went in: the User's edit stays, and Undo says so.
          if (written.get(id) !== contentHash(block)) {
            kept++;
            continue;
          }
          note.delete(index, 1);
          removed.push(id);
        }
        if (note.doc) removeOrigins(note.doc, removed);
        for (const id of removed) {
          const brought = carried.get(id);
          if (!brought) continue;
          carried.delete(id);
          if (note.doc) uncarryAnswerScope(note.doc, brought);
        }
        for (const id of blockIds) written.delete(id);
        return { kept };
      });
    },
  };
}
