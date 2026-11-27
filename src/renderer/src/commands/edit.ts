import { useEffect } from "react";
import type { EditMenuState } from "../../../shared/bridge";
import { files } from "../core";
import { noteAround } from "../editor/noteKeymap";
import { redoInNote, undoInNote } from "../editor/noteUndoKeys";
import { mindEditor } from "../editor/openEditors";
import { useT } from "../i18n";
import type { Translate } from "../objects";
import { nextToRedo, nextToUndo, typesText, type Undoable, undoReady, useUndo } from "../undo";
import { type Command, type CommandContext, fromMenu } from "./registry";

/**
 * Where ⌘Z and ⇧⌘Z go from the focus (docs/designs/interaction-system.md, C.6):
 * the note's own undo in the note, and the app's once the note has nothing of its
 * own to take back; a field's own in a field; and the app's changes everywhere
 * else. ⌘K runs them on what ⌘Z would there.
 */
/** Note inputs whose last undo emptied the field, so the next Redo belongs to the field (#3839). */
const fieldUndoPending = new WeakSet<Element>();

export function markFieldUndoPending(field: Element | null): void {
  if (field) fieldUndoPending.add(field);
}

export function clearFieldUndoPending(field: Element | null): void {
  if (field) fieldUndoPending.delete(field);
}

export function hasFieldUndoPending(field: Element | null): boolean {
  return field !== null && fieldUndoPending.has(field);
}

/** An empty Note input with no IME composition open delegates Undo (and Redo when its last undo wasn't in the field) to its Note (#3839). */
function emptyNoteAskMind(focus: Element | null): string | null {
  if (focus?.tagName !== "TEXTAREA") return null;
  const textarea = focus as HTMLTextAreaElement;
  const mindId = textarea.getAttribute("data-note-ask-input");
  if (!mindId || textarea.value !== "" || textarea.hasAttribute("data-composing")) return null;
  return mindId;
}

export function placeAt(
  focus: Element | null,
  step: "undo" | "redo" = "undo",
): EditMenuState["text"] {
  if (
    emptyNoteAskMind(focus) !== null &&
    (step === "undo" || !hasFieldUndoPending(focus)) &&
    noteHere(focus)
  ) {
    return "note";
  }
  const typing = typesText(focus);
  if (typing && !(focus instanceof HTMLElement && focus.isContentEditable)) return "field";
  // A chart's buttons and values (#436) are in the note, though not text: ⌘Z there takes back the note's change.
  // So is the reviewing pane beside it (#697): a decision there is a step of the note's, as from its bar.
  if (noteHere(focus)) return "note";
  return typing ? "field" : null;
}

function placeOf(ctx: CommandContext, step: "undo" | "redo" = "undo"): EditMenuState["text"] {
  // From ⌘K the focus is in its field: where the User was when it opened decides.
  if (ctx.surface === "palette") return ctx.place ?? null;
  return placeAt(document.activeElement, step);
}

// A reviewing pane's note is the one in its own Mind tab (#697): the tab beside may show the same Mind.
function noteHere(focus: Element | null) {
  const askMind = emptyNoteAskMind(focus);
  if (askMind !== null) {
    const page = focus?.closest(".mind-tab-page");
    return (
      noteAround(page?.querySelector('[data-testid="mind-editor"]') ?? null) ?? mindEditor(askMind)
    );
  }
  const tab = focus?.closest("[data-review-of]")?.closest(".mind-tab-row");
  return noteAround(tab?.querySelector('[data-testid="mind-editor"]') ?? focus);
}

const nameOf = (change: Undoable | undefined, t: Translate) =>
  change ? (change.name?.(t) ?? "") : null;

const labelFor = (ctx: CommandContext, step: "undo" | "redo", t: Translate) => {
  const bare = step === "undo" ? "menu.undo" : "menu.redo";
  // The note's and a field's own Undo take no name: they act on the text where the User is.
  if (ctx.place) return t(bare);
  const state = useUndo.getState();
  const name = nameOf(step === "undo" ? nextToUndo(state) : nextToRedo(state), t);
  if (!name) return t(bare);
  return t(step === "undo" ? "menu.undo.named" : "menu.redo.named", { action: name });
};

export const editCommands: readonly Command[] = [
  {
    ...fromMenu("edit.undo"),
    assistant: false,
    label: (ctx, t) => labelFor(ctx, "undo", t),
    shortcut: { keys: "CmdOrCtrl+Z", outsideText: true },
    group: "edit",
    reversible: true,
    enabled: (ctx) =>
      placeOf(ctx, "undo") !== null || undoReady(useUndo.getState())
        ? true
        : { reason: "undo.nothing" },
    run(ctx) {
      const place = placeOf(ctx, "undo");
      const active = document.activeElement;
      if (place === "note") {
        clearFieldUndoPending(active);
        const note = noteHere(active);
        return note ? undoInNote(note) : useUndo.getState().undo();
      }
      // A field's own undo, the system Edit menu's editing command, which only execCommand reaches.
      if (place === "field") {
        const noteAsk =
          active?.tagName === "TEXTAREA" && active.hasAttribute("data-note-ask-input")
            ? (active as HTMLTextAreaElement)
            : null;
        const hadText = noteAsk !== null && noteAsk.value !== "";
        document.execCommand("undo");
        if (hadText && noteAsk.value === "") markFieldUndoPending(noteAsk);
      } else return useUndo.getState().undo();
    },
  },
  {
    ...fromMenu("edit.redo"),
    assistant: false,
    label: (ctx, t) => labelFor(ctx, "redo", t),
    shortcut: { keys: "CmdOrCtrl+Shift+Z", alsoOther: "Ctrl+Y", outsideText: true },
    group: "edit",
    reversible: true,
    enabled: (ctx) =>
      placeOf(ctx, "redo") !== null || nextToRedo(useUndo.getState())
        ? true
        : { reason: "redo.nothing" },
    run(ctx) {
      const place = placeOf(ctx, "redo");
      const active = document.activeElement;
      if (place === "note") {
        const note = noteHere(active);
        return note ? redoInNote(note) : useUndo.getState().redo();
      }
      if (place === "field") {
        clearFieldUndoPending(active);
        document.execCommand("redo");
      } else return useUndo.getState().redo();
    },
  },
];

/** The Edit menu's state here now: where its Undo and Redo go, and what they name. */
function editMenuState(t: Translate): EditMenuState {
  const state = useUndo.getState();
  return {
    text: placeOf({ selection: [], focus: null, surface: "mind" }),
    undo: nameOf(nextToUndo(state), t) ?? (undoReady(state) ? "" : null),
    redo: nameOf(nextToRedo(state), t),
  };
}

/**
 * Keeps the application menu's Undo and Redo told where the focus is and what
 * they would take back or do again, as the focus moves and changes are made.
 */
export function useEditMenu(): void {
  const t = useT();
  useEffect(() => {
    let sent = "";
    let pending = 0;
    const report = () => {
      pending = 0;
      const state = editMenuState(t);
      const key = JSON.stringify(state);
      if (key === sent) return;
      sent = key;
      files.setEditMenu(state);
    };
    // Leaving one field for another blurs then focuses: one report for both.
    const soon = () => {
      if (!pending) pending = window.setTimeout(report, 0);
    };
    // Another window may have told the menu its own state meanwhile.
    const again = () => {
      sent = "";
      report();
    };
    report();
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    window.addEventListener("focus", again);
    const stop = useUndo.subscribe(soon);
    return () => {
      window.clearTimeout(pending);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
      window.removeEventListener("focus", again);
      stop();
    };
  }, [t]);
}
