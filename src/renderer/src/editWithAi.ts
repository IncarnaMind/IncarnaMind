/**
 * Edit with AI (#93), the window's side: which text a selection is (as the
 * core reads it, `TextPlace`), asking the core for the change, the
 * composer's way of saying what to change, accepting or rejecting the
 * Proposals that come back, with Undo, and making one out of date again
 * (#94).
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { create } from "zustand";
import {
  ANSWER_BLOCK,
  type ChatReadiness,
  type EditAction,
  type EditWithAiResult,
  type ProviderError,
} from "../../core/api";
import { aiUseOfAccepted, proposalRequestOf } from "../../shared/proposals";
import { useAnswers } from "./answers";
import { type Applying, appliedMessage, finishApplying, startApplying } from "./appliedEdits";
import { core } from "./core";
import { appliedLineIn } from "./editor/appliedEditLine";
import { offerEditorUndo } from "./editor/editorUndo";
import { selectionForEdit } from "./editor/editSelection";
import {
  editorDoc,
  editTarget,
  type PendingProposal,
  pendingIn,
  resolveInEditor,
  setEditTarget,
  watchMovedOn,
} from "./editor/proposalReview";
import { keepDecisions } from "./editor/theirChanges";
import { failedEdit } from "./editProblems";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import type { Words } from "./lineNames";
import { modelInUseOf } from "./modelInUse";
import { useAppStore } from "./store";

/** The languages Translate… offers: each in its own name, and as the model is told it. */
export const TRANSLATE_LANGUAGES: readonly { id: string; name: string; prompt: string }[] = [
  { id: "en", name: "English", prompt: "English" },
  { id: "zh-Hans", name: "简体中文", prompt: "Simplified Chinese (简体中文)" },
  { id: "zh-Hant", name: "繁體中文", prompt: "Traditional Chinese (繁體中文)" },
  { id: "ja", name: "日本語", prompt: "Japanese (日本語)" },
  { id: "ko", name: "한국어", prompt: "Korean (한국어)" },
  { id: "fr", name: "Français", prompt: "French (Français)" },
  { id: "de", name: "Deutsch", prompt: "German (Deutsch)" },
  { id: "es", name: "Español", prompt: "Spanish (Español)" },
];

/** Why an Edit with AI request gave no Proposals, for the line in the composer. */
export type EditProblem = (
  | {
      kind:
        | "unchanged"
        | "changed"
        | "has-proposals"
        | "too-long"
        | "local-mode"
        | "cant-regenerate"
        | "no-table"
        | "unplaced"
        | "cut-short"
        | "late"
        | "busy";
    }
  | { kind: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  | { kind: "failed"; message: string; retry: () => void }
  | { kind: "consent-revoked"; error: ProviderError }
) & { menu?: MenuEdit };

/** An edit asked in the selection menu: where the first Block of its text is, for the line that reports it once the menu is closed. */
export interface MenuEdit {
  blockId: string | null;
  /** When it was asked (`Date.now()`); nothing shows for its first 300 ms once the menu is closed. */
  at: number;
}

interface Pending {
  requestId: string;
  action: EditAction;
  /** The language, for "translate". */
  language: string | null;
  /** Stopped by the User: it still settles before another edit can start, so its Undo stays its own. */
  stopped?: boolean;
  menu?: MenuEdit;
}

interface EditsState {
  /** By Mind: the request the AI is working on. */
  pending: Readonly<Record<string, Pending>>;
  /** By Mind: why the last request gave nothing. */
  problems: Readonly<Record<string, EditProblem>>;
  /** By Mind: the selection the composer is saying what to change in, quoted. */
  editing: Readonly<Record<string, { quote: string }>>;
  /**
   * By Mind: what a screen reader is told about Proposals, with a count to say it again, and the
   * Proposal it describes, if it does: that is said only while the cursor is in it.
   */
  spoken: Readonly<Record<string, { text: string; at: number; about?: string }>>;
  /** By Mind: the selection menu is open on the edit asked in it, which then reports itself there and not in the page. */
  menuShows: Readonly<Record<string, true>>;
}

export const useEdits = create<EditsState>()(() => ({
  pending: {},
  problems: {},
  editing: {},
  spoken: {},
  menuShows: {},
}));

const set = <K extends keyof EditsState>(
  key: K,
  mindId: string,
  value: EditsState[K][string] | null,
) =>
  useEdits.setState((state) => {
    const next = { ...state[key] } as Record<string, EditsState[K][string]>;
    if (value === null) delete next[mindId];
    else next[mindId] = value;
    return { [key]: next } as Partial<EditsState>;
  });

const t = translateNow;

let spokenAt = 0;
/** Tells a screen reader, through the Mind's live region (see `ProposalBars`). */
export function speak(mindId: string, text: string, about?: string): void {
  spokenAt += 1;
  set("spoken", mindId, { text, at: spokenAt, ...(about !== undefined && { about }) });
}

export const dismissEditProblem = (mindId: string) => set("problems", mindId, null);

export const setMenuShows = (mindId: string, shown: boolean) =>
  set("menuShows", mindId, shown ? true : null);

export const noteBusy = (mindId: string, menu?: MenuEdit) =>
  set("problems", mindId, menu ? { kind: "busy", menu } : { kind: "busy" });

/** A selection shown short, for the composer's chip. */
function quoteOf(text: string): string {
  const flat = text.replace(/￼/g, "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > 48 ? `${chars.slice(0, 47).join("")}…` : flat;
}

/** Waits until the editor shows the request's Proposals; the first, or null after a while. */
function whenShown(editor: Editor, request: string): Promise<PendingProposal | null> {
  const first = () => pendingIn(editor.state).find((each) => each.request === request) ?? null;
  return new Promise((resolve) => {
    const now = first();
    if (now || editor.isDestroyed) {
      resolve(now);
      return;
    }
    const done = (value: PendingProposal | null) => {
      clearTimeout(timer);
      editor.off("transaction", check);
      resolve(value);
    };
    const check = () => {
      const found = first();
      if (found) done(found);
    };
    // The Proposals come with the core's update, which comes before its reply; this is a backstop.
    const timer = setTimeout(() => done(first()), 5_000);
    editor.on("transaction", check);
  });
}

/** A request that threw, as the result the composer shows. */
const failure = (error: unknown): EditWithAiResult => ({
  kind: "failed",
  error: { kind: "unknown", message: errorMessage(error, t) },
});

/**
 * Asks the core to change the selected text (or `range`) as `action` says.
 * While the AI works the text is marked and the composer says so, with Stop;
 * the selection closes at its end, so the User can write on. The change
 * applies at once (#880); one held back waits as Proposals, which take the
 * cursor, if it is still where it was, so their bar shows; anything else is
 * one line in the composer. Asked in the selection menu (`from`), it reports in
 * the menu, then where its Undo line lands (`useMenuEditLine`), never in the
 * composer. One edit at a time in a Mind. Says whether the change came back.
 */
export async function requestEdit(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  action: EditAction,
  instruction?: string,
  range?: { from: number; to: number },
  from?: "menu",
): Promise<boolean> {
  const selection = selectionForEdit(editor.state, range);
  if (!selection || editor.isDestroyed || useEdits.getState().pending[mindId]) return false;
  const requestId = crypto.randomUUID();
  set("problems", mindId, null);
  set("editing", mindId, null);
  set("pending", mindId, {
    requestId,
    action,
    language: action === "translate" ? (instruction ?? null) : null,
    ...(from === "menu" && { menu: { blockId: selection.from.blockId, at: Date.now() } }),
  });
  setEditTarget(editor, selection.range);
  const { selection: now } = editor.state;
  if (now.from === selection.range.from && now.to === selection.range.to) {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, selection.range.to)),
    );
  }
  const watch = watchMovedOn(editor);
  const applying = startApplying(editor, mindId, requestId);

  let result: EditWithAiResult;
  try {
    result = await core.editWithAi({
      requestId,
      mindId,
      from: selection.from,
      to: selection.to,
      text: selection.text,
      action,
      ...(instruction !== undefined && { instruction }),
      model: modelInUseOf(doc),
    });
  } catch (error) {
    result = failure(error);
  }
  watch.stop();
  await arrived(
    editor,
    mindId,
    requestId,
    watch.movedOn(),
    result,
    async () => {
      await requestEdit(editor, mindId, doc, action, instruction, range ?? selection.range, from);
    },
    applying,
  );
  return result.kind === "proposed";
}

/**
 * What a request gave, once it is back: an edit applying (`applying`)
 * applies, stopped or not, as far as it came. Proposals take the cursor,
 * unless the User has moved it or edited meanwhile (`movedOn`), so their bar
 * shows, and a screen reader hears how many came and how many are out of
 * date; anything else is one line in the composer, `retry` trying again.
 */
async function arrived(
  editor: Editor,
  mindId: string,
  requestId: string,
  movedOn: boolean,
  result: EditWithAiResult,
  retry: () => Promise<void>,
  applying: Applying | null = null,
): Promise<void> {
  const edits = useEdits.getState();
  const menu = edits.pending[mindId]?.menu;
  const mine = edits.pending[mindId]?.requestId === requestId;
  const stopped = !mine || edits.pending[mindId]?.stopped === true;
  // Stopped: nothing waits on the text any more, unless another request or the composer does.
  const waitedOn =
    stopped &&
    (edits.editing[mindId] !== undefined || (!mine && edits.pending[mindId] !== undefined));
  if (!waitedOn && !editor.isDestroyed) setEditTarget(editor, null);
  let outcome: Awaited<ReturnType<typeof finishApplying>> = null;
  try {
    outcome = applying ? await finishApplying(applying, result) : null;
  } finally {
    if (mine) set("pending", mindId, null);
  }
  const problem = (found: EditProblem): void =>
    set("problems", mindId, menu ? { ...found, menu } : found);
  if (outcome === "late") {
    problem({ kind: "late" });
    return;
  }
  if (outcome !== null && outcome !== "held") {
    const { paragraphs, tables } = outcome.applied;
    if (paragraphs + tables > 0) speak(mindId, appliedMessage(outcome.applied));
    return;
  }
  if (stopped) return;

  if (result.kind === "proposed") {
    const first = await whenShown(editor, result.request);
    const count =
      result.proposals === 1
        ? t("proposal.arrived.one")
        : t("proposal.arrived", { count: result.proposals });
    const stale =
      result.outOfDate === 0
        ? ""
        : result.outOfDate === 1
          ? t("proposal.arrived.outOfDate.one")
          : t("proposal.arrived.outOfDate", { count: result.outOfDate });
    speak(mindId, stale ? `${count} ${stale}` : count);
    // Into the first change, unless the User has moved on meanwhile.
    if (first && !editor.isDestroyed && editor.state.selection.empty && !movedOn) {
      const pos = first.block ? first.from + 1 : first.from;
      editor
        .chain()
        .setTextSelection(Math.min(pos, editor.state.doc.content.size))
        .scrollIntoView()
        .run();
    }
    return;
  }
  if (result.kind === "cancelled") return;
  problem(result.kind === "failed" ? failedEdit(result.error, () => void retry()) : result);
}

/**
 * Regenerate on a change out of date (#94): a change from Edit with AI is
 * asked for again, as it was, from its text as it is now, and the new
 * changes take its place (the text is marked, and the composer says so with
 * Stop, as for any request); one from an Answer's Regenerate writes that
 * Answer again, which comes back as changes over the User's version.
 */
export async function regenerateChange(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  proposal: PendingProposal,
): Promise<void> {
  if (editor.isDestroyed || useEdits.getState().pending[mindId]) return;
  const made = proposalRequestOf(doc, proposal.request);
  if (made?.source === "answer") {
    const questionId = questionOfAnswer(editor, made.answerId);
    if (questionId) await useAnswers.getState().regenerate(mindId, made.answerId, questionId);
    else set("problems", mindId, { kind: "cant-regenerate" });
    return;
  }
  // An Answer added from the assistant (#201) isn't asked for again here, nor are changes from before #94.
  if (made?.source !== "edit-with-ai" || !made.action) {
    set("problems", mindId, { kind: "cant-regenerate" });
    return;
  }
  const { action } = made;
  const requestId = crypto.randomUUID();
  set("problems", mindId, null);
  set("pending", mindId, {
    requestId,
    action,
    language: action === "translate" ? (made.instruction ?? null) : null,
  });
  setEditTarget(editor, { from: proposal.from, to: proposal.to });
  const watch = watchMovedOn(editor);
  let result: EditWithAiResult;
  try {
    result = await core.regenerateProposal({
      requestId,
      mindId,
      proposalId: proposal.id,
      model: modelInUseOf(doc),
    });
  } catch (error) {
    result = failure(error);
  }
  watch.stop();
  await arrived(editor, mindId, requestId, watch.movedOn(), result, async () => {
    const still = pendingIn(editor.state).find((each) => each.id === proposal.id);
    if (still) await regenerateChange(editor, mindId, doc, still);
  });
}

/** The Question an Answer in the note answers, by the Answer's id. */
function questionOfAnswer(editor: Editor, answerId: string): string | null {
  let questionId: string | null = null;
  editor.state.doc.descendants((node) => {
    if (questionId !== null) return false;
    if (node.type.name === ANSWER_BLOCK && node.attrs.id === answerId) {
      questionId = typeof node.attrs.questionId === "string" ? node.attrs.questionId : null;
      return false;
    }
    return node.isBlock;
  });
  return questionId;
}

/** Stops the request the AI is working on in a Mind; the text stays as it was. */
export function stopEdit(mindId: string): void {
  const pending = useEdits.getState().pending[mindId];
  if (!pending || pending.stopped) return;
  set("pending", mindId, { ...pending, stopped: true });
  void core.cancelEdit(pending.requestId).catch(useAppStore.getState().reportError);
}

/**
 * "Edit with AI…" (⌘J with a selection): the composer says what to change in
 * the selected text, which stays marked while the User types. False when the
 * selection can't be edited.
 */
export function startEditing(editor: Editor, mindId: string): boolean {
  const selection = selectionForEdit(editor.state);
  if (!selection) return false;
  set("problems", mindId, null);
  setEditTarget(editor, selection.range);
  set("editing", mindId, { quote: quoteOf(selection.text) });
  return true;
}

/** The composer goes back to asking: the selection is no longer being edited. */
export function stopEditing(editor: Editor, mindId: string): void {
  if (!useEdits.getState().editing[mindId]) return;
  set("editing", mindId, null);
  if (!useEdits.getState().pending[mindId]) setEditTarget(editor, null);
}

/** What the User said to change, from the composer, for the text it is editing. */
export function editFromComposer(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  instruction: string,
): boolean {
  if (useEdits.getState().pending[mindId]) {
    noteBusy(mindId);
    return false;
  }
  const target = editTarget(editor.state);
  set("editing", mindId, null);
  if (!target || instruction.trim() === "") {
    setEditTarget(editor, null);
    return false;
  }
  void requestEdit(editor, mindId, doc, "instruction", instruction.trim(), target);
  return true;
}

/**
 * Accepts or rejects Proposals in the open Mind, as one step of its Undo,
 * and offers Undo on the undo line while that step is still the last one.
 * What an accepted Proposal wrote goes into the record of AI use (#292),
 * after the change itself has gone to the core.
 */
export function resolveProposalsIn(
  editor: Editor,
  mindId: string,
  ids: readonly string[] | "all",
  outcome: "accept" | "reject",
): void {
  if (editor.isDestroyed || ids.length === 0) return;
  // A Checkpoint of the Mind before an AI change goes in (#113). Not awaited: the core takes it
  // before the change this sends next.
  const accepting =
    outcome === "accept" &&
    pendingIn(editor.state).some(
      (proposal) => !proposal.outOfDate && (ids === "all" || ids.includes(proposal.id)),
    );
  if (accepting) {
    core.saveCheckpoint(mindId, "accept").catch(useAppStore.getState().reportError);
  }
  const picked = pendingIn(editor.state).filter((each) => ids === "all" || ids.includes(each.id));
  const line = appliedLineIn(editor.state);
  // An edit held back waits for its own Apply or Discard.
  const held = new Set(line?.kind === "held" ? [line.request] : []);
  // Read before the decision: once it is made the change's words have gone from the text.
  const before = editor.state.doc;
  const resolved = resolveInEditor(
    editor,
    ids === "all" ? ids : new Set(ids),
    outcome,
    held,
    (doc, done) => keepDecisions(doc, before, done, outcome),
  );
  if (resolved.length === 0) {
    // Only changes out of date were picked: they can't be accepted, and the User hears why.
    const theirs = picked.length > 0 && picked.every((each) => each.theirs);
    if (outcome === "accept")
      speak(mindId, t(theirs ? "proposal.cantAccept.theirs" : "proposal.cantAccept"));
    return;
  }
  const doc = editorDoc(editor);
  if (outcome === "accept" && doc) {
    const entries = aiUseOfAccepted(doc, mindId, resolved, new Date().toISOString());
    if (entries.length > 0) {
      core.recordAiUse(entries).catch(useAppStore.getState().reportError);
    }
  }
  const count = resolved.length;
  const said: Words = (t) =>
    outcome === "accept"
      ? count === 1
        ? t("proposal.accepted.one")
        : t("proposal.accepted", { count })
      : count === 1
        ? t("proposal.rejected.one")
        : t("proposal.rejected", { count });
  speak(mindId, said(t));
  offerEditorUndo(editor, said);
}
