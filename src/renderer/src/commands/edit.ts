import { useEffect } from "react";
import type { EditMenuState } from "../../../shared/bridge";
import { files } from "../core";
import { noteAround } from "../editor/noteKeymap";
import { useT } from "../i18n";
import type { Translate } from "../objects";
import { nextToRedo, nextToUndo, typesText, type Undoable, useUndo } from "../undo";
import { type Command, type CommandContext, fromMenu } from "./registry";

/**
 * Where ⌘Z and ⇧⌘Z go from the focus (docs/designs/interaction-system.md, C.6):
 * the note's own undo in the note, a field's own in a field, and the app's
 * changes everywhere else. ⌘K runs them on what ⌘Z would there.
 */
export function placeAt(focus: Element | null): EditMenuState["text"] {
  const typing = typesText(focus);
  if (typing && !(focus instanceof HTMLElement && focus.isContentEditable)) return "field";
  // A chart's buttons and values (#436) are in the note, though not text: ⌘Z there takes back the note's change.
  // So is the reviewing pane beside it (#697): a decision there is a step of the note's, as from its bar.
  if (noteHere(focus)) return "note";
  return typing ? "field" : null;
}

function placeOf(ctx: CommandContext): EditMenuState["text"] {
  // From ⌘K the focus is in its field: where the User was when it opened decides.
  if (ctx.surface === "palette") return ctx.place ?? null;
  return placeAt(document.activeElement);
}

// A reviewing pane's note is the one in its own Mind tab (#697): the tab beside may show the same Mind.
function noteHere(focus: Element | null) {
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
    label: (ctx, t) => labelFor(ctx, "undo", t),
    shortcut: { keys: "CmdOrCtrl+Z", outsideText: true },
    group: "edit",
    reversible: true,
    enabled: (ctx) =>
      placeOf(ctx) !== null || nextToUndo(useUndo.getState()) ? true : { reason: "undo.nothing" },
    run(ctx) {
      const place = placeOf(ctx);
      if (place === "note") noteHere(document.activeElement)?.commands.undo();
      // A field's own undo, the system Edit menu's editing command, which only execCommand reaches.
      else if (place === "field") document.execCommand("undo");
      else return useUndo.getState().undo();
    },
  },
  {
    ...fromMenu("edit.redo"),
    label: (ctx, t) => labelFor(ctx, "redo", t),
    shortcut: { keys: "CmdOrCtrl+Shift+Z", alsoOther: "Ctrl+Y", outsideText: true },
    group: "edit",
    reversible: true,
    enabled: (ctx) =>
      placeOf(ctx) !== null || nextToRedo(useUndo.getState()) ? true : { reason: "redo.nothing" },
    run(ctx) {
      const place = placeOf(ctx);
      if (place === "note") noteHere(document.activeElement)?.commands.redo();
      else if (place === "field") document.execCommand("redo");
      else return useUndo.getState().redo();
    },
  },
];

/** The Edit menu's state here now: where its Undo and Redo go, and what they name. */
function editMenuState(t: Translate): EditMenuState {
  const state = useUndo.getState();
  return {
    text: placeOf({ selection: [], focus: null, surface: "mind" }),
    undo: nameOf(nextToUndo(state), t),
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
