/**
 * Verify (#97), the window's side. "Check someone else’s PDF or Word file…"
 * (the + menu, ⌘K) takes a PDF or a Word file (#110), whose Mind opens with
 * the file beside it and has its claims found. The check badge's card then
 * checks them (editor/VerifyLine).
 * One run goes at a time: asking again while one runs shows its Mind.
 */

import type * as Y from "yjs";
import { create } from "zustand";
import type { DocumentPlace, FindClaimsResult, VerifyClaimsResult } from "../../core/api";
import { core, files } from "./core";
import { translateNow } from "./i18n";
import { currentMindIdOf } from "./layoutSlice";
import { modelInUseOf } from "./modelInUse";
import { useAppStore } from "./store";
import { refusalKey } from "./wordImport";

/** How a Mind's last run ended, when it says something: why it gave nothing, or what it checked. */
export type VerifyOutcome =
  | Exclude<FindClaimsResult, { kind: "found" | "cancelled" | "busy" }>
  | Extract<VerifyClaimsResult, { kind: "checked" }>
  /** Worded when shown, so it reads in the interface language even after a switch (#627). */
  | { kind: "error"; error: unknown };

interface VerifyState {
  /** The run going: in which Mind, and whether it finds or checks the claims. */
  running: { mindId: string; requestId: string; phase: "finding" | "checking" } | null;
  /** By Mind: how its last run ended. */
  outcomes: Readonly<Record<string, VerifyOutcome>>;
}

export const useVerify = create<VerifyState>()(() => ({ running: null, outcomes: {} }));

function settle(mindId: string, outcome: VerifyOutcome | null) {
  useVerify.setState((state) => {
    const outcomes = { ...state.outcomes };
    if (outcome) outcomes[mindId] = outcome;
    else delete outcomes[mindId];
    return { running: null, outcomes };
  });
}

/** Shows the Mind a run is going in. */
function showMind(mindId: string) {
  const { minds, showNewMind } = useAppStore.getState();
  const mind = minds.find((each) => each.id === mindId);
  if (mind) void showNewMind(mind);
}

/**
 * Runs one step of a Mind's verify, the only one going: another asked for
 * while it runs shows its Mind instead.
 */
async function runStep<R extends FindClaimsResult | VerifyClaimsResult>(
  mindId: string,
  phase: "finding" | "checking",
  step: (requestId: string) => Promise<R>,
): Promise<void> {
  const going = useVerify.getState().running;
  if (going) {
    showMind(going.mindId);
    return;
  }
  const requestId = crypto.randomUUID();
  useVerify.setState({ running: { mindId, requestId, phase } });
  let result: R;
  try {
    result = await step(requestId);
  } catch (error) {
    settle(mindId, { kind: "error", error });
    return;
  }
  if (result.kind === "busy") {
    useVerify.setState({ running: null });
    showMind(result.mindId);
  } else if (result.kind === "found" || result.kind === "cancelled") settle(mindId, null);
  else settle(mindId, result);
}

/** Has the core find the Mind's claims, with its own model, if it has one. */
export const findClaims = (mindId: string, doc: Y.Doc | null) =>
  runStep(mindId, "finding", (requestId) =>
    core.findClaims({ requestId, mindId, model: modelInUseOf(doc) }),
  );

/** Checks the Mind's claims against its Folder, or every Document. */
export const checkClaims = (mindId: string, doc: Y.Doc, allDocuments = false) =>
  runStep(mindId, "checking", (requestId) =>
    core.verifyClaims({ requestId, mindId, allDocuments, model: modelInUseOf(doc) }),
  );

/** Forgets how the Mind's last run ended, once its problem is dealt with. */
export const dismissVerifyOutcome = (mindId: string) => {
  const outcomes = { ...useVerify.getState().outcomes };
  delete outcomes[mindId];
  useVerify.setState({ outcomes });
};

/** Stops the run going in the Mind: the claims not checked yet say "stopped". */
export function stopVerify(mindId: string): void {
  const running = useVerify.getState().running;
  if (running?.mindId === mindId) void core.cancelCheck(running.requestId);
}

/** Opens a Document beside the Mind in front, at a place: the one it verifies, or its original (#720). */
export function openDocumentBeside(documentId: string, place: DocumentPlace = {}): void {
  const { layout, openDocument } = useAppStore.getState();
  openDocument(
    { documentId, ...place },
    { as: "citation", stay: true, ...(layout && { from: layout.focusedGroupId }) },
  );
}

/**
 * "Check someone else’s PDF or Word file…": the file the User picks becomes a
 * Mind in the Folder of the Mind in front, once its text is read; the Mind
 * opens with the file beside it, and its claims are found. While a run goes,
 * its Mind is shown instead.
 */
export async function verifyDocument(): Promise<void> {
  const going = useVerify.getState().running;
  if (going) {
    showMind(going.mindId);
    return;
  }
  const path = await files.pickFileToVerify();
  if (!path) return;
  const { layout, minds, reportError, showNewMind } = useAppStore.getState();
  const inFront = currentMindIdOf(layout);
  const folderId = minds.find((each) => each.id === inFront)?.folderId ?? null;
  try {
    const made = await core.verifyDocument({ path, folderId });
    if (!made.ok) {
      const name = path.split(/[\\/]/).pop() ?? path;
      reportError(
        new Error(
          made.reason === "word"
            ? translateNow(refusalKey(made.refusal), { name })
            : translateNow(`verify.refused.${made.reason}`),
        ),
      );
      return;
    }
    await showNewMind(made.mind);
    openDocumentBeside(made.documentId);
    // A new Mind follows the default model.
    await findClaims(made.mind.id, null);
  } catch (error) {
    reportError(error);
  }
}
