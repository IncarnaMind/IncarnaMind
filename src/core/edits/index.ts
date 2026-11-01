/**
 * Edit with AI (#93): the User selects text and asks for a change (improve,
 * shorten, translate, explain, or in their own words), and the change comes
 * back as Proposals in the Mind, waiting for them to accept or reject it.
 *
 * 1. The selection is read from the Mind (../proposals/write), with its
 *    Citations as numbered markers, and checked against what the editor read.
 * 2. The chat model (the Mind's, else the default; thinking off, one pass)
 *    gets the passage, the paragraphs around it and the task (./prompt).
 * 3. Every Citation the reply keeps is checked again against its Document; one
 *    whose check comes out differently now comes back as a checked copy.
 * 4. The reply streams in, and each paragraph is compared with the passage's
 *    word by word and written as Proposals once it is finished (#202), with
 *    "Writing…" where the next goes (`writing`). A reply that drops a
 *    Citation leaves it in a Proposal, for the User to see before accepting.
 *    The Proposals are written into a copy of the Mind as the model read it
 *    and merged into the Mind (../proposals/merge), so if the User edits the
 *    passage meanwhile, those whose words they changed arrive out of date
 *    (#94). Stopped, what is written stays; failed, it goes.
 * 5. The model says why it changed the passage, in a few words, which the
 *    change's bar shows.
 *
 * A change out of date can be made again (`regenerateProposal`): the same
 * request, from the text it covers as it is now, the User's edits included.
 *
 * Nothing leaves the computer before the User allows the "edits" flow to the
 * model's service, and in local mode only a model on this computer is used.
 * Each request can be stopped (`cancel`).
 */
import { randomUUID } from "node:crypto";
import { streamText } from "ai";
import type * as Y from "yjs";
import {
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  recordProposalRequest,
  resolveProposals,
  waitingChanges,
} from "../../shared/proposals";
import { topLevelBlocks } from "../answers/blocks";
import { estimateTokens } from "../answers/context";
import { createWindowBudget } from "../answers/window";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type ChatReadiness,
  type EditAction,
  type EditPart,
  type EditWithAiResult,
  type ExternalService,
  editActions,
  type LeftOutPart,
  MIND_CONTENT_FIELD,
  type ProposalRequest,
  type RequestedChange,
  type TextPlace,
  type WritingPlace,
} from "../api";
import type { Consent } from "../consent";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
} from "../errors";
import type { MindContent } from "../mindContent";
import { parseMindId } from "../minds";
import { docOf, forkChanges } from "../proposals/merge";
import {
  acceptOwnIn,
  boundsOf,
  type OwnWaiting,
  ownAsked,
  replaceOwn,
  waitingIn,
} from "../proposals/ownWaiting";
import {
  acceptedText,
  addNotes,
  createRewriteStream,
  layout,
  type Notes,
  proposeAfter,
  proposeRewrite,
  type ReadResult,
  type RewritePlace,
  type RewriteStream,
  readSelection,
  type Selection,
  selectionParts,
  someNotes,
  takeBackForRegenerate,
  textBlocks,
} from "../proposals/write";
import type { PreparedChatModel } from "../providers/chat";
import { outputTokens } from "../providers/outputLimits";
import { classifyProviderError } from "../providers/providerErrors";
import { gateStop } from "../sendGate";
import { inFlow } from "../timing/flows";
import { waitsForUser } from "./applies";
import {
  EDIT_INSTRUCTIONS,
  EDIT_INSTRUCTIONS_NAMED,
  EXPLAIN_INSTRUCTIONS,
  editPrompt,
  NAMES_SHOWN,
  passageSoFar,
  readEditReply,
  readRemovals,
  reasonOf,
  sameText,
  unclearTypedTags,
  unnameRemovals,
  withoutNames,
} from "./prompt";

/** The tasks whose reply may take text out by quoting it: the User's words, and a Citation's checks. */
const QUOTES_TAKE_OUT: ReadonlySet<EditAction> = new Set([
  "instruction",
  "cut-unsupported",
  "follow-citation",
]);

/** The new text a reply gives, without what it quotes as taken out, nor its paragraphs' names when the passage was shown with them. */
const textOf = (reply: string, named = false) =>
  named
    ? withoutNames(readRemovals(unnameRemovals(reply)).text).trim()
    : readRemovals(reply).text.trim();

/** The passage as the model is shown it for `action`: with its paragraphs' names, for a request in the User's words (#2356). */
const passageFor = (action: EditAction, selection: Pick<Selection, "text" | "named">) =>
  NAMES_SHOWN.has(action) ? selection.named : selection.text;

const failedEdit = (failure: unknown): EditWithAiResult =>
  gateStop(failure) instanceof LocalModeError
    ? { kind: "local-mode" }
    : { kind: "failed", error: classifyProviderError(failure) };

/** What the "edits" flow sends: the selected text, with the paragraphs it is in. */
export const EDITS_FLOW_SENDS = ["selection"] as const;

/** The most text one request edits, in characters: more is better done a part at a time. */
export const MAX_SELECTION_CHARACTERS = 12_000;
/** The most a request may say in the User's own words. */
const MAX_INSTRUCTION_CHARACTERS = 2_000;
/** A request that takes longer than this (a local model loading a long text) fails. */
const REQUEST_TIMEOUT_MS = 180_000;

type Attributes = Record<string, unknown>;

export interface EditsOptions {
  content: Pick<MindContent, "read" | "edit" | "state" | "stateVector" | "apply">;
  /** Throws unless the Mind exists and this version may write to it. */
  requireMind(mindId: string): void;
  /** The default chat model, used when the Mind has none of its own. */
  defaultModel(): ChatModelChoice | null;
  chat: {
    readiness(choice: ChatModelChoice | undefined, flow: "edits"): Promise<ChatReadiness>;
    prepareModel(choice: ChatModelChoice | undefined, flow: "edits"): Promise<PreparedChatModel>;
    /** The service the default chat model sends to; null with none, or one on this computer. */
    defaultService(): ExternalService | null;
  };
  consent: Consent;
  /** Local mode: only models on this computer. */
  localOnly(): boolean;
  /** A Citation's attributes checked again now, or null when its check comes out the same. */
  recheck(attributes: Attributes): Attributes | null;
  /**
   * Says where a request writes next in a Mind as its changes come in (#202); null once it has
   * stopped. `part`: a long selection edited in parts says which of how many is written now (#2348).
   */
  writing(mindId: string, place: WritingPlace | null, part?: EditPart): void;
  /** A Checkpoint just before an edit that applies at once writes (#113). */
  checkpoint(mindId: string): void;
  now(): Date;
}

/** What a request asks the model to do, in which Mind. */
interface Ask {
  mindId: string;
  action: EditAction;
  instruction: string;
  model: ChatModelChoice | null;
  requested?: RequestedChange;
}

interface ParsedInput extends Ask {
  requestId: string;
  from: TextPlace;
  to: TextPlace;
  text: string;
}

interface ParsedRegenerate {
  requestId: string;
  mindId: string;
  proposalId: string;
  model: ChatModelChoice | null;
}

/**
 * A copy of a Mind as the model read it, with the selection in it: a
 * request's Proposals are written there, and merged into the Mind.
 */
interface Draft {
  mindId: string;
  /** The Mind's whole state the copy was made from. */
  base: Uint8Array;
  fork: Y.Doc;
  selection: Selection;
}

/** What a request does besides writing its Proposals. */
interface Hooks {
  /** The model gave the text back as it was. */
  settle?(): void;
  /** Just before the request's first Proposals go into the Mind: a Checkpoint (#113). */
  beforeWriting?(): void;
  /** More of the request's Proposals are in the Mind: how many there are now. */
  written?(request: string, count: number): void;
  /** An edit the User asked for (#880): its updates name it. */
  requestId?: string;
}

export function parsePlace(value: unknown, what: string): TextPlace {
  if (
    !isRecord(value) ||
    typeof value.blockId !== "string" ||
    value.blockId === "" ||
    typeof value.offset !== "number" ||
    !Number.isInteger(value.offset) ||
    value.offset < 0
  ) {
    throw new InvalidInputError(`${what} must be a Block's id and an offset into its text.`);
  }
  return { blockId: value.blockId, offset: value.offset };
}

function parseInput(input: unknown): ParsedInput {
  if (!isRecord(input)) throw new InvalidInputError("editWithAi expects an object.");
  const { requestId, text, action, instruction, model } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError("An Edit with AI request needs an id.");
  }
  if (typeof text !== "string") throw new InvalidInputError("text must be the selected text.");
  if (!editActions.some((each) => each === action)) {
    throw new InvalidInputError(`Unknown Edit with AI action "${String(action)}".`);
  }
  const words = typeof instruction === "string" ? instruction.trim() : "";
  if (
    (action === "translate" || action === "instruction" || action === "cut-unsupported") &&
    words === ""
  ) {
    throw new InvalidInputError({ key: "error.edit.noInstruction" });
  }
  if (words.length > MAX_INSTRUCTION_CHARACTERS) {
    throw new InvalidInputError({
      key: "error.edit.instructionTooLong",
      values: { max: MAX_INSTRUCTION_CHARACTERS },
    });
  }
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    from: parsePlace(input.from, "from"),
    to: parsePlace(input.to, "to"),
    text,
    action: action as EditAction,
    instruction: words,
    model: parseModel(model),
  };
}

/** The model a request names: the Mind's own; null for the default chat model. */
export function parseModel(model: unknown): ChatModelChoice | null {
  return isRecord(model) &&
    typeof model.providerId === "string" &&
    model.providerId !== "" &&
    typeof model.modelId === "string" &&
    model.modelId !== ""
    ? { providerId: model.providerId, modelId: model.modelId }
    : null;
}

function parseRegenerate(input: unknown): ParsedRegenerate {
  if (!isRecord(input)) throw new InvalidInputError("regenerateProposal expects an object.");
  const { requestId, proposalId } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError("A Regenerate request needs an id.");
  }
  if (typeof proposalId !== "string" || proposalId === "") {
    throw new InvalidInputError("proposalId must be the change's id.");
  }
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    proposalId,
    model: parseModel(input.model),
  };
}

/** Rejects a Proposal in `doc`, in a transaction of its own, and says where its text is now. */
function takeBack(doc: Y.Doc, blocks: Y.XmlFragment, proposalId: string) {
  const taken: { region: ReturnType<typeof takeBackForRegenerate> } = { region: null };
  doc.transact(() => {
    taken.region = takeBackForRegenerate(blocks, proposalId);
  });
  return taken.region;
}

/**
 * The Citations a reply keeps, by marker, that come back checked differently
 * now: each checked once, when the reply first has its marker.
 */
function freshCitations(
  selection: Selection,
  recheck: EditsOptions["recheck"],
): (reply: string) => ReadonlyMap<number, Attributes> {
  const fresh = new Map<number, Attributes>();
  const checked = new Set<number>();
  return (reply) => {
    for (const match of reply.matchAll(/\[(\d+)\]/g)) {
      const marker = Number(match[1]);
      if (checked.has(marker)) continue;
      checked.add(marker);
      const attributes = selection.citations[marker - 1];
      const again = attributes ? recheck(attributes) : null;
      if (again) fresh.set(marker, again);
    }
    return fresh;
  };
}

/** Where a stream writes next, as the editor finds it: by the paragraph's id. */
function placeOf(at: RewritePlace | null): WritingPlace | null {
  if (!at) return null;
  const element = "over" in at ? at.over : at.after;
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (typeof id !== "string" || id === "") return null;
  return "over" in at ? { over: id } : { after: id };
}

/** A change the assistant asks for in a Mind (#202, `proposeInMind`). */
export interface ProposeInput {
  mindId: string;
  from: TextPlace;
  to: TextPlace;
  instruction: string;
  prepared: PreparedChatModel;
  signal: AbortSignal;
  beforeWriting(): void;
  written(request: string, count: number): void;
  /** What the User's words asked for, which its request records; null: neither. A revision records it only when its text was asked for too. */
  requested: RequestedChange | null;
  /** Requests started by this Answer, whose own changes a later call in the same turn may revise. */
  ownRequests?: ReadonlySet<string>;
}

export interface Proposed {
  result: EditWithAiResult;
  length: { before: string; after: string } | null;
  reason: string | null;
  revised: { blockIds: string[] } | null;
}

const askOf = (input: ProposeInput): Ask => ({
  mindId: input.mindId,
  action: "instruction",
  instruction: input.instruction,
  model: { providerId: input.prepared.provider.id, modelId: input.prepared.modelId },
  ...(input.requested && { requested: input.requested }),
});

interface EditCall {
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
}

const quotesOf = (selection: Selection): string[] =>
  selection.citations.map((citation) => (typeof citation.quote === "string" ? citation.quote : ""));

/**
 * The request for `ask` over `selection`; null when it is more than the model can take at once.
 * A selection with `named` is shown with its paragraphs' names when the task is in the User's words.
 */
function editCall(
  prepared: PreparedChatModel,
  ask: Pick<Ask, "action" | "instruction">,
  selection: Pick<Selection, "text" | "context" | "before" | "after" | "characters"> & {
    named?: string;
    quotes?: readonly string[];
  },
): EditCall | null {
  const explain = ask.action === "explain";
  const passage =
    selection.named === undefined
      ? selection.text
      : passageFor(ask.action, { text: selection.text, named: selection.named });
  const instructions = explain
    ? EXPLAIN_INSTRUCTIONS
    : passage === selection.text
      ? EDIT_INSTRUCTIONS
      : EDIT_INSTRUCTIONS_NAMED;
  const prompt = editPrompt({
    action: ask.action,
    instruction: ask.instruction,
    passage,
    context: selection.context,
    // Explain writes under the passage, not into it: the words around it don't matter.
    ...(!explain && { before: selection.before, after: selection.after }),
    ...((ask.action === "cut-unsupported" || ask.action === "follow-citation") && {
      quotes: selection.quotes,
    }),
  });
  const { window } = prepared;
  const budget = window ? createWindowBudget(window) : null;
  // The reply is about as long as the passage; a translation into Chinese can count more.
  const tokens = budget ? budget.tokens(passage) : estimateTokens(passage);
  const expected = explain ? 512 : Math.ceil(tokens * 1.5) + 64;
  // A rewrite that can't fit would come back cut short: it isn't sent (#2275).
  if (expected > Math.min(outputTokens("edit"), window?.outputTokens ?? Number.POSITIVE_INFINITY))
    return null;
  if (budget && window) {
    if (budget.roomBeside([instructions, prompt], expected) < 0) return null;
    return {
      instructions,
      prompt,
      maxOutputTokens: Math.min(outputTokens("edit"), window.outputTokens),
    };
  }
  const maxOutputTokens = Math.min(
    outputTokens("edit"),
    Math.max(1_024, Math.ceil(selection.characters * 1.5)),
  );
  return { instructions, prompt, maxOutputTokens };
}

/** Why a passage is more than one request edits: the app's own cap, or this model's window. */
type TooLongCause = "cap" | "model";

/**
 * Why the model can't take `selection` in one request; null when it can. "cap": the app's own
 * limits, which no model changes (12,000 characters, or a reply past an edit's 16,000 tokens).
 * "model": this model's window, or the room it leaves, which a larger one may take.
 */
function tooLongCause(
  prepared: PreparedChatModel,
  ask: Pick<Ask, "action" | "instruction">,
  selection: Parameters<typeof editCall>[2],
): TooLongCause | null {
  if (selection.characters > MAX_SELECTION_CHARACTERS) return "cap";
  if (editCall(prepared, ask, selection) !== null) return null;
  const passage =
    selection.named === undefined
      ? selection.text
      : passageFor(ask.action, { text: selection.text, named: selection.named });
  const { window } = prepared;
  const tokens = window ? createWindowBudget(window).tokens(passage) : estimateTokens(passage);
  const expected = ask.action === "explain" ? 512 : Math.ceil(tokens * 1.5) + 64;
  return expected > outputTokens("edit") ? "cap" : "model";
}

/**
 * Streams the model's reply to a request: `onText` hears it grow, the reply
 * so far and the piece just come, and stops it by returning true. `failure`:
 * why it failed, or null.
 */
async function streamEdit(
  prepared: PreparedChatModel,
  call: EditCall,
  signal: AbortSignal,
  onText?: (raw: string, piece: string) => boolean,
): Promise<{ raw: string; failure: unknown }> {
  let raw = "";
  let failure: unknown = null;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const result = inFlow("edit-with-ai", () =>
      streamText({
        model: prepared.model,
        instructions: call.instructions,
        prompt: call.prompt,
        maxOutputTokens: call.maxOutputTokens,
        maxRetries: 1,
        abortSignal: AbortSignal.any([signal, timeout]),
        onError: () => undefined,
      }),
    );
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "abort") {
        // Not the User's Stop: it took too long, and what came isn't the whole text.
        if (!signal.aborted) failure = timeout.reason;
        break;
      }
      if (part.type !== "text-delta") continue;
      raw += part.text;
      if (onText?.(raw, part.text)) break;
    }
  } catch (error) {
    failure = error;
  }
  return { raw, failure };
}

/**
 * The new text Edit with AI gives for a passage that isn't in a Mind yet (#1111: a sentence
 * the assistant is about to write), its Citations as numbered markers: the same request and
 * the same reading of the reply, with no Proposals. Null when the model fails, gives nothing,
 * or the passage is more than it can take at once.
 */
export async function editText(
  prepared: PreparedChatModel,
  ask: Pick<Ask, "action" | "instruction">,
  passage: { text: string; context: string; quotes: readonly string[] },
  signal: AbortSignal,
): Promise<string | null> {
  const call = editCall(prepared, ask, {
    ...passage,
    before: "",
    after: "",
    characters: passage.text.length,
  });
  if (!call) return null;
  const { raw, failure } = await streamEdit(prepared, call, signal);
  if (signal.aborted) return null;
  if (failure !== null) {
    console.warn(`Edit with AI (${ask.action}) of a passage not in a Mind failed:`, failure);
    return null;
  }
  const text = textOf(readEditReply(raw, passage.text));
  return text === "" ? null : text;
}

export function createEdits(options: EditsOptions) {
  const { chat, content } = options;
  const running = new Map<string, AbortController>();
  /** The core is closing: a request stopped now writes nothing more, as the Mind's storage closes. */
  let closing = false;

  options.consent.registry.register({
    id: "edits",
    sends: EDITS_FLOW_SENDS,
    async services() {
      const service = chat.defaultService();
      return service ? [service] : [];
    },
  });

  /** The part being written, while a long selection is edited in parts (#2348). */
  let partNow: { mindId: string; part: EditPart } | null = null;

  /** Says where a request writes next, and which part of how many, while it does (#202, #2348). */
  const noteWriting = (mindId: string, place: WritingPlace | null): void =>
    options.writing(mindId, place, partNow?.mindId === mindId ? partNow.part : undefined);

  const readinessOf = (choice: ChatModelChoice | null) =>
    chat.readiness(choice ?? undefined, "edits");

  const notReady = (readiness: ChatReadiness): EditWithAiResult | null =>
    readiness.ready ? null : { kind: "not-ready", readiness };

  /**
   * Asks the model to change the draft's selection as `ask` says, and writes
   * what comes back as Proposals.
   */
  async function run(
    ask: Ask,
    draft: Draft,
    signal: AbortSignal,
    hooks: Hooks = {},
  ): Promise<EditWithAiResult> {
    // A Block alone over what one request edits can't be edited in parts (#2348): said before
    // anything is sent, and before a model is asked for.
    if (draft.selection.segments.some((part) => part.characters > MAX_SELECTION_CHARACTERS)) {
      return { kind: "block-too-long", cause: "cap" };
    }

    const choice = ask.model ?? options.defaultModel();
    const readiness = await readinessOf(choice);
    const blocked = notReady(readiness);
    if (blocked) return blocked;
    if (readiness.ready && readiness.provider.service && options.localOnly()) {
      return { kind: "local-mode" };
    }

    let prepared: PreparedChatModel;
    try {
      prepared = await chat.prepareModel(choice ?? undefined, "edits");
    } catch (error) {
      if (error instanceof LocalModeError) return { kind: "local-mode" };
      if (error instanceof ChatNotReadyError)
        return { kind: "not-ready", readiness: error.readiness };
      if (error instanceof ConsentDeclinedError) {
        return notReady(await readinessOf(choice)) ?? { kind: "cancelled" };
      }
      throw error;
    }
    if (signal.aborted) return { kind: "cancelled" };
    // One request takes the whole selection when it fits: in characters, and in the model's
    // window with the room its reply needs. More than that is edited in parts (#2348).
    const fits =
      draft.selection.characters <= MAX_SELECTION_CHARACTERS &&
      editCall(prepared, ask, { ...draft.selection, quotes: quotesOf(draft.selection) }) !== null;
    if (fits) return (await rewrite(prepared, ask, draft, signal, hooks)).result;
    // Only an edit the User asked for is made in parts: one made again, or by the assistant,
    // is asked of them another way.
    if (hooks.requestId === undefined) return { kind: "too-long" };
    return rewriteInParts(prepared, ask, draft, signal, hooks);
  }

  /**
   * A selection the model can't take at once, edited in parts at Block boundaries (#2348): each
   * part is asked with the same instruction and the text around it, and streams in place as it
   * finishes (#202). The parts' changes are one request's, so the window applies them as one
   * step, with one Undo. Stopped, what is finished stays; a part that fails takes all back.
   */
  async function rewriteInParts(
    prepared: PreparedChatModel,
    ask: Ask,
    draft: Draft,
    signal: AbortSignal,
    hooks: Hooks,
  ): Promise<EditWithAiResult> {
    const { mindId } = draft;
    const split = selectionParts(
      draft.fork.getXmlFragment(MIND_CONTENT_FIELD),
      draft.selection,
      (part) =>
        part.characters <= MAX_SELECTION_CHARACTERS &&
        editCall(prepared, ask, { ...part, quotes: quotesOf(part) }) !== null,
    );
    if (!split.ok) {
      if (split.reason === "changed") return { kind: "changed" };
      const cause = tooLongCause(prepared, ask, { ...split.part, quotes: quotesOf(split.part) });
      return { kind: "block-too-long", cause: cause ?? "model" };
    }
    const request = randomUUID();
    const total = split.parts.length;
    // How many, before the first part streams: a cloud model's estimate shows first (#83).
    options.writing(mindId, null, { at: 1, of: total });
    const leftOut: LeftOutPart[] = [];
    const notes: Notes = { unmatchedMarkers: 0, unlinkedSources: 0, extraCells: 0 };
    let droppedCitations = 0;
    let held = false;
    let stopped = false;
    let made = 0;
    let said: string | undefined;
    // One Checkpoint for the whole edit, as for one request (#113).
    let marked = false;
    const once: Hooks = {
      ...hooks,
      beforeWriting: () => {
        if (marked) return;
        marked = true;
        hooks.beforeWriting?.();
      },
    };
    try {
      for (const [index, place] of split.parts.entries()) {
        if (signal.aborted) {
          stopped = true;
          break;
        }
        const read = readForEdit(mindId, place.from, place.to);
        if (!read.ok) {
          return takeBackAll(mindId, request, {
            kind: read.reason === "has-proposals" ? "has-proposals" : "changed",
          });
        }
        partNow = { mindId, part: { at: index + 1, of: total } };
        let result: EditWithAiResult;
        try {
          ({ result } = await rewrite(prepared, ask, read.draft, signal, once, request));
        } finally {
          partNow = null;
          read.draft.fork.destroy();
        }
        if (result.kind === "proposed") {
          made += 1;
          held ||= result.held === true;
          droppedCitations += result.droppedCitations;
          leftOut.push(...(result.leftOut ?? []));
          addNotes(notes, {
            unmatchedMarkers: result.unmatchedMarkers ?? 0,
            unlinkedSources: result.unlinkedSources ?? 0,
            extraCells: result.extraCells ?? 0,
          });
          continue;
        }
        if (result.kind === "unchanged") {
          said ||= result.said;
          continue;
        }
        // Stopped between two parts: what is finished stays, as for a request stopped midway.
        if (result.kind === "cancelled" || signal.aborted) {
          stopped = true;
          break;
        }
        return takeBackAll(mindId, request, result);
      }
    } finally {
      options.writing(mindId, null);
    }
    const now = content.read(mindId, (mind) => {
      const stale = outOfDateProposals(mind);
      const waiting = pendingProposals(mind).filter((each) => each.request === request);
      return { count: waiting.length, outOfDate: waiting.filter((each) => stale.has(each.id)) };
    });
    if (now.count === 0) {
      if (signal.aborted) return { kind: "cancelled" };
      return said === undefined ? { kind: "unchanged" } : { kind: "unchanged", said };
    }
    return {
      kind: "proposed",
      request,
      // How many parts it was, all of them unless the User stopped it partway.
      ...((stopped ? made : total) > 1 && { parts: stopped ? made : total }),
      proposals: now.count,
      droppedCitations,
      outOfDate: now.outOfDate.length,
      ...someNotes(notes),
      ...(held && { held: true as const }),
      ...(leftOut.length > 0 && { leftOut }),
      stateVector: content.stateVector(mindId),
    };
  }

  /** A part that failed takes back every part's changes: the edit is one step, or none. */
  function takeBackAll(
    mindId: string,
    request: string,
    result: EditWithAiResult,
  ): EditWithAiResult {
    content.edit(mindId, (mind) => {
      resolveProposals(mind, (each) => each.request === request, "reject");
    });
    return result;
  }

  /**
   * `run`, on a model already prepared: what goes to it, and what comes back
   * as Proposals, each paragraph as soon as it is finished. Also gives the
   * passage's new text and why it changed, once the model is done.
   */
  async function rewrite(
    prepared: PreparedChatModel,
    ask: Ask,
    draft: Draft,
    signal: AbortSignal,
    hooks: Hooks,
    /** The request all the Proposals are written under: one per edit, or for all its parts (#2348). */
    request: string = randomUUID(),
  ): Promise<{ result: EditWithAiResult; reply: string; reason: string | null }> {
    const { mindId, fork, selection } = draft;
    const explain = ask.action === "explain";
    const ended = (result: EditWithAiResult) => ({ result, reply: "", reason: null });
    const call = editCall(prepared, ask, { ...selection, quotes: quotesOf(selection) });
    if (!call) return ended({ kind: "too-long" });
    // The reply is read against the passage as the model saw it.
    const passage = passageFor(ask.action, selection);
    const named = NAMES_SHOWN.has(ask.action);

    const blocks = fork.getXmlFragment(MIND_CONTENT_FIELD);
    const { requestId } = hooks;
    // Explain's few sentences go in once they are all there.
    const stream = explain
      ? null
      : createRewriteStream(
          selection,
          request,
          randomUUID,
          freshCitations(selection, options.recheck),
          {
            // An edit the User asked for applies at once, here or from the assistant, and what its
            // reply leaves out without quoting it as taken out stays (#880, #2180).
            leftOut:
              (requestId !== undefined || ask.requested === "edit") && ask.action === "instruction"
                ? "keep"
                : "remove",
            named,
          },
        );
    let held = false;
    // Counted as written: the window accepts an edit the User asked for, so the Mind no longer holds them.
    let proposed = 0;
    let landed = false;
    const made: Extract<ProposalRequest, { source: "edit-with-ai" }> = {
      source: "edit-with-ai",
      providerId: prepared.provider.id,
      modelId: prepared.modelId,
      createdAt: options.now().toISOString(),
      action: ask.action,
      instruction: ask.instruction,
      ...(ask.requested && { requested: ask.requested }),
    };
    const mine = (mind: Y.XmlFragment) =>
      pendingProposals(mind).filter((each) => each.request === request);
    /**
     * What the Proposals came to in the Mind: merged with the User's edits,
     * some may have gone with the text they were in, or be out of date.
     */
    const arrived = (): EditWithAiResult => {
      const now = content.read(mindId, (mind) => {
        const stale = outOfDateProposals(mind);
        const waiting = mine(mind);
        return { count: waiting.length, outOfDate: waiting.filter((each) => stale.has(each.id)) };
      });
      const count = requestId === undefined ? now.count : landed ? proposed : 0;
      if (count === 0) return { kind: "changed" };
      const leftOut = stream?.leftOut() ?? [];
      return {
        kind: "proposed",
        request,
        proposals: count,
        droppedCitations: stream?.written().droppedCitations ?? 0,
        outOfDate: now.outOfDate.length,
        ...(stream && someNotes(stream.written().notes)),
        ...(held && { held: true as const }),
        ...(leftOut.length > 0 && { leftOut }),
        stateVector: content.stateVector(mindId),
      };
    };
    const holdsBack = (written: RewriteStream) =>
      waitsForUser({
        action: ask.action,
        ...written.extent(),
        selected: selection.characters,
      });
    const appliesNow = () =>
      explain || ask.action === "translate" || (stream?.extent().mapped ?? false);
    let wrote = false;
    let refused = false;
    /**
     * Writes in the copy; once that has written Proposals, merges the copy
     * into the Mind, the first time after `beforeWriting`. A merge that would
     * change the User's text is refused, and nothing more is written.
     */
    const step = (write: () => boolean): void => {
      if (refused) return;
      let changed = false;
      fork.transact(() => {
        changed = write();
        if (changed) recordProposalRequest(fork, request, made);
      });
      if (!changed) return;
      if (!wrote) hooks.beforeWriting?.();
      wrote = true;
      const update = forkChanges(draft.base, fork, content.state(mindId));
      if (!update) {
        refused = true;
        return;
      }
      proposed = explain ? proposed : (stream?.written().proposals.length ?? proposed);
      content.apply(
        mindId,
        update,
        requestId === undefined ? undefined : { requestId, request, apply: appliesNow() },
      );
      const inMind = content.read(mindId, mine).length;
      landed ||= inMind > 0;
      hooks.written?.(request, inMind);
    };
    /** What was written goes again: the request failed, or its changes can't be merged. */
    const takeBackWritten = () => {
      if (!wrote) return;
      content.edit(mindId, (mind) => {
        resolveProposals(mind, (each) => each.request === request, "reject");
      });
    };
    const showWriting = () => {
      if (stream) noteWriting(mindId, placeOf(stream.writingAt()));
    };
    /**
     * Which paragraph a rewrite replaces can't be trusted, or it would drop a tag the User typed:
     * none of it goes in.
     */
    const untrusted = (): EditWithAiResult | null => {
      const written = stream?.written();
      if (written?.misnamed) return { kind: "misnamed" };
      if (written?.droppedTypedTag) return { kind: "typed-tag" };
      return null;
    };

    let shown = false;
    let afterBreak = false;
    let streamed: { raw: string; failure: unknown };
    try {
      streamed = await streamEdit(prepared, call, signal, (raw, piece) => {
        if (!stream) return false;
        // A paragraph is finished once the next one starts after a line break: the reply is read
        // again only at a break and just after one, not at every word.
        const reread = piece.includes("\n") || afterBreak;
        afterBreak = piece.includes("\n");
        if (shown && !reread) return false;
        const sofar = passageSoFar(raw, passage);
        if (sofar === null) return false;
        if (!shown) {
          shown = true;
          showWriting();
        }
        if (!reread) return false;
        step(() => stream.write(sofar));
        if (refused || untrusted()) return true;
        showWriting();
        return false;
      });
    } finally {
      if (stream) noteWriting(mindId, null);
    }
    const { raw, failure } = streamed;

    if (signal.aborted && closing) return ended({ kind: "cancelled" });
    const early = failure === null ? untrusted() : null;
    if (early) {
      takeBackWritten();
      return ended(early);
    }
    if (signal.aborted && !refused) {
      // Stopped: what is finished stays.
      if (stream) {
        step(() => stream.stop());
        held = requestId !== undefined && holdsBack(stream);
      }
      if (!refused) return ended(wrote ? arrived() : { kind: "cancelled" });
    }
    if (failure !== null && !refused) {
      takeBackWritten();
      return ended(failedEdit(failure));
    }
    const reply = readEditReply(raw, passage);
    // A tag that may be the User's typed one or the model's mark: read either way, it may take their words (#2333).
    const unclear = explain ? [] : unclearTypedTags(reply, passage);
    if (unclear.length > 0) {
      takeBackWritten();
      return ended({ kind: "unplaced", quotes: unclear });
    }
    // No text back and nothing quoted as taken out: its reason ("I can't do this") is why it failed.
    // A fixed task (Shorten, Improve…) never asks for text to go, so only quotes are no text either.
    const empty = reply === "" || (!QUOTES_TAKE_OUT.has(ask.action) && textOf(reply, named) === "");
    if (empty && !wrote && !refused) {
      return ended({
        kind: "failed",
        error: {
          kind: "provider",
          message: (!explain && reasonOf(raw)) || "The model gave nothing back.",
        },
      });
    }
    if (!explain && !wrote && !refused && sameText(reply, passage)) {
      hooks.settle?.();
      return ended({ kind: "unchanged" });
    }
    const reason = explain ? null : reasonOf(raw);
    if (reason) made.reason = reason;
    step(() => {
      if (!stream) {
        proposed = proposeAfter(blocks, selection, reply, request, randomUUID).proposals.length;
        return proposed > 0;
      }
      const more = stream.write(reply, true);
      if (stream.written().unmadeTable) return false;
      const finished = stream.finish();
      if (stream.written().onlyAside) return false;
      if (requestId !== undefined) held = holdsBack(stream);
      // Written before the reason came: recorded again with it.
      return finished || more || held || (wrote && reason !== null);
    });
    if (refused) {
      takeBackWritten();
      return ended({ kind: "changed" });
    }
    if (stream?.written().unmadeTable) {
      takeBackWritten();
      return ended({ kind: "no-table", text: textOf(reply, named) });
    }
    const late = untrusted();
    if (late) {
      takeBackWritten();
      return ended(late);
    }
    // Text marked to go that isn't there: what else it wrote may lean on that going, so none of it goes in.
    const unplaced = stream?.written().unplaced;
    if (unplaced) {
      takeBackWritten();
      return ended({ kind: "unplaced", quotes: unplaced });
    }
    // What the model said beside the paragraphs it names, or instead of any, is shown, never written (#2356).
    const aside = stream?.written().aside;
    if (!wrote || stream?.written().onlyAside) {
      takeBackWritten();
      return ended({ kind: "unchanged", ...(aside && { said: aside.join(" ") }) });
    }
    return { result: arrived(), reply: textOf(reply, named), reason };
  }

  /**
   * The text from `from` to `to` in a Mind as the model will read it, in a
   * copy of the Mind that its Proposals are written into (`Draft`). Close
   * the copy (`fork.destroy`) once done.
   */
  function readForEdit(
    mindId: string,
    from: TextPlace,
    to: TextPlace,
  ): { ok: true; draft: Draft } | Extract<ReadResult, { ok: false }> {
    const base = content.state(mindId);
    const fork = docOf(base);
    const read = readSelection(fork.getXmlFragment(MIND_CONTENT_FIELD), from, to);
    if (!read.ok) {
      fork.destroy();
      return read;
    }
    return { ok: true, draft: { mindId, base, fork, selection: read.selection } };
  }

  async function edit(input: ParsedInput, signal: AbortSignal): Promise<EditWithAiResult> {
    const read = readForEdit(input.mindId, input.from, input.to);
    if (!read.ok) return { kind: read.reason === "has-proposals" ? "has-proposals" : "changed" };
    const { draft } = read;
    try {
      if (draft.selection.plain !== input.text) return { kind: "changed" };
      if (draft.selection.text === "") return { kind: "unchanged" };
      return await run(input, draft, signal, {
        requestId: input.requestId,
        beforeWriting: () => options.checkpoint(input.mindId),
      });
    } finally {
      draft.fork.destroy();
    }
  }

  async function regenerate(
    input: ParsedRegenerate,
    signal: AbortSignal,
  ): Promise<EditWithAiResult> {
    const base = content.state(input.mindId);
    const fork = docOf(base);
    try {
      const blocks = fork.getXmlFragment(MIND_CONTENT_FIELD);
      const ref = pendingProposals(blocks).find((each) => each.id === input.proposalId);
      if (!ref) return { kind: "changed" };
      const made = proposalRequestOf(fork, ref.request);
      if (made?.source !== "edit-with-ai" || !made.action) {
        throw new InvalidInputError("Only a change from Edit with AI can be regenerated.");
      }
      // Taken back in the copy: in the Mind, only once the new changes come, or none are needed.
      const region = takeBack(fork, blocks, input.proposalId);
      if (!region) return { kind: "changed" };
      const { from, to } = region;
      const read = readSelection(blocks, from, to);
      if (!read.ok) return { kind: read.reason === "has-proposals" ? "has-proposals" : "changed" };
      /** The change goes: there is no change to make now. */
      const withdraw = () => {
        const update = forkChanges(base, fork, content.state(input.mindId));
        if (update) content.apply(input.mindId, update);
      };
      if (read.selection.text === "") {
        withdraw();
        return { kind: "unchanged" };
      }
      return await run(
        {
          mindId: input.mindId,
          action: made.action,
          instruction: made.instruction ?? "",
          model: input.model,
        },
        { mindId: input.mindId, base, fork, selection: read.selection },
        signal,
        { settle: withdraw },
      );
    } finally {
      fork.destroy();
    }
  }

  /**
   * Revises the assistant's own changes still waiting over the stretch:
   * their text, as it reads once accepted, is rewritten as asked in a
   * copy of the Mind, and the new text takes their place, still waiting, as
   * Blocks of a new request (../proposals/ownWaiting). Nothing goes into the
   * Mind until the model is done; the User's own text isn't touched.
   */
  async function revise(input: ProposeInput, own: OwnWaiting): Promise<Proposed> {
    const nothing = (result: EditWithAiResult): Proposed => ({
      result,
      length: null,
      reason: null,
      revised: null,
    });
    const fork = docOf(content.state(input.mindId));
    try {
      const blocks = fork.getXmlFragment(MIND_CONTENT_FIELD);
      fork.transact(() => acceptOwnIn(blocks, own));
      const end = textBlocks(blocks).find(
        ({ element }) => element.getAttribute(BLOCK_ID_ATTRIBUTE) === input.to.blockId,
      );
      const to = end
        ? {
            blockId: input.to.blockId,
            offset: layout(end.element).reduce((sum, child) => sum + child.size, 0),
          }
        : input.to;
      const read = readSelection(blocks, input.from, to);
      const bounds = boundsOf(blocks, own);
      if (!read.ok || !bounds) return nothing({ kind: "changed" });
      const { selection } = read;
      if (selection.text === "") return nothing({ kind: "unchanged" });
      if (selection.characters > MAX_SELECTION_CHARACTERS) return nothing({ kind: "too-long" });
      // Its length is told from its Blocks: a reply that names its paragraphs may write only some.
      const stretch = () => {
        const top = topLevelBlocks(blocks);
        return top.slice(bounds.before, top.length - bounds.after);
      };
      const before = acceptedText(stretch(), "");
      const call = editCall(input.prepared, askOf(input), selection);
      if (!call) return nothing({ kind: "too-long" });
      let streamed: { raw: string; failure: unknown };
      options.writing(input.mindId, { over: input.from.blockId });
      try {
        streamed = await streamEdit(input.prepared, call, input.signal);
      } finally {
        options.writing(input.mindId, null);
      }
      if (input.signal.aborted) return nothing({ kind: "cancelled" });
      if (streamed.failure !== null) {
        return nothing(failedEdit(streamed.failure));
      }
      const ask = askOf(input);
      const passage = passageFor(ask.action, selection);
      const named = NAMES_SHOWN.has(ask.action);
      const reply = readEditReply(streamed.raw, passage);
      const unclear = unclearTypedTags(reply, passage);
      if (unclear.length > 0) return nothing({ kind: "unplaced", quotes: unclear });
      if (sameText(reply, passage)) return nothing({ kind: "unchanged" });
      const request = randomUUID();
      const written = fork.transact(() => {
        const fresh = freshCitations(selection, options.recheck)(reply);
        const rewritten = proposeRewrite(selection, reply, request, randomUUID, fresh, { named });
        resolveProposals(blocks, (each) => each.request === request, "accept");
        return rewritten;
      });
      const after = acceptedText(stretch(), request);
      if (written.unmadeTable) return nothing({ kind: "no-table", text: textOf(reply, named) });
      if (written.misnamed) return nothing({ kind: "misnamed" });
      if (written.droppedTypedTag) return nothing({ kind: "typed-tag" });
      if (written.unplaced) return nothing({ kind: "unplaced", quotes: written.unplaced });
      if (written.proposals.length === 0 || written.onlyAside)
        return nothing({ kind: "unchanged" });
      const { droppedCitations, notes } = written;
      const revised = stretch().map((element) => element.clone());
      const made: ProposalRequest = {
        source: "answer-added",
        providerId: input.prepared.provider.id,
        modelId: input.prepared.modelId,
        createdAt: options.now().toISOString(),
        instruction: input.instruction,
      };
      input.beforeWriting();
      const blockIds = content.edit(input.mindId, (mind) => {
        const asked = input.requested !== null && ownAsked(mind, own);
        const ids = replaceOwn(mind, own, revised, request, input.ownRequests);
        if (ids && mind.doc) {
          recordProposalRequest(mind.doc, request, {
            ...made,
            ...(asked && { requested: "edit" }),
          });
        }
        return ids;
      });
      if (!blockIds) return nothing({ kind: "changed" });
      const proposals = content.read(input.mindId, (mind) =>
        waitingChanges(mind, (each) => each.request === request),
      );
      input.written(request, proposals);
      return {
        result: {
          kind: "proposed",
          request,
          proposals,
          droppedCitations,
          outOfDate: 0,
          ...someNotes(notes),
          stateVector: content.stateVector(input.mindId),
        },
        length: { before, after },
        reason: reasonOf(streamed.raw),
        revised: { blockIds },
      };
    } finally {
      fork.destroy();
    }
  }

  /** Runs a request that `cancel` can stop by `requestId`. */
  async function stoppable(
    requestId: string,
    work: (signal: AbortSignal) => Promise<EditWithAiResult>,
  ): Promise<EditWithAiResult> {
    running.get(requestId)?.abort();
    const controller = new AbortController();
    running.set(requestId, controller);
    try {
      return await work(controller.signal);
    } finally {
      if (running.get(requestId) === controller) running.delete(requestId);
    }
  }

  return {
    async editWithAi(raw: unknown): Promise<EditWithAiResult> {
      const input = parseInput(raw);
      options.requireMind(input.mindId);
      return stoppable(input.requestId, (signal) => edit(input, signal));
    },

    async regenerateProposal(raw: unknown): Promise<EditWithAiResult> {
      const input = parseRegenerate(raw);
      options.requireMind(input.mindId);
      return stoppable(input.requestId, (signal) => regenerate(input, signal));
    },

    /**
     * A change the assistant asks for in a Mind (#202): `instruction`, over the
     * text from `from` to `to`, on the model its Answer is written with, which
     * the User has allowed. As Edit with AI's, it comes back as Proposals,
     * each paragraph as it is finished. Over the assistant's own changes
     * still waiting, it revises them instead (`revise`). `length`: the
     * text before and after, when it proposed; `reason`: why, as the model
     * says; `revised`: the Blocks that took the place of its waiting ones.
     */
    async proposeInMind(input: ProposeInput): Promise<Proposed> {
      options.requireMind(input.mindId);
      const nothing = (result: EditWithAiResult): Proposed => ({
        result,
        length: null,
        reason: null,
        revised: null,
      });
      const read = readForEdit(input.mindId, input.from, input.to);
      if (!read.ok) {
        if (read.reason !== "has-proposals") return nothing({ kind: "changed" });
        const waiting = content.read(input.mindId, (mind) =>
          waitingIn(mind, input.from, input.to, input.ownRequests),
        );
        return waiting.kind === "own"
          ? await revise(input, waiting)
          : nothing({ kind: "has-proposals" });
      }
      const { draft } = read;
      try {
        const { selection } = draft;
        if (selection.text === "") return nothing({ kind: "unchanged" });
        if (selection.characters > MAX_SELECTION_CHARACTERS) return nothing({ kind: "too-long" });
        const { result, reply, reason } = await rewrite(
          input.prepared,
          askOf(input),
          draft,
          input.signal,
          { beforeWriting: input.beforeWriting, written: input.written },
        );
        return {
          result,
          length: result.kind === "proposed" ? { before: selection.text, after: reply } : null,
          reason,
          revised: null,
        };
      } finally {
        draft.fork.destroy();
      }
    },

    cancel(requestId: unknown): void {
      if (typeof requestId !== "string") throw new InvalidInputError("requestId must be text.");
      running.get(requestId)?.abort();
    },

    /** The core is closing: requests still waiting stop. */
    stopAll(): void {
      closing = true;
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}

export type Edits = ReturnType<typeof createEdits>;
