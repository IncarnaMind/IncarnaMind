import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import { type FigureSchedule, type FigureScheduleRow, MIND_CONTENT_FIELD } from "../../core/api";
import { fingerprintOfMind } from "../../shared/mindState";
import { useChecks } from "./checks";
import { core } from "./core";
import { figurePlace } from "./editor/figurePlaces";
import { mindEditor } from "./editor/openEditors";
import { scrollMindTo } from "./editor/reviewPick";
import { groupsMerged } from "./layoutSlice";
import { startCheck, useMindCheck } from "./mindCheck";
import { useAppStore } from "./store";

export function useFigureSchedule(mindId: string, doc: Y.Doc | null): FigureSchedule | null {
  const documents = useAppStore((state) => state.documents);
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const [read, setRead] = useState<{ doc: Y.Doc; schedule: FigureSchedule } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Source versions and Folder/title changes invalidate the core projection.
  useEffect(() => {
    if (!doc) return;
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    let active = true;
    let pending = false;
    let changed = false;
    // The schedule shown stays until the core's projection of the new text arrives: actions
    // on it are refused once the text moved on (`requireCurrent`).
    const refresh = () => {
      if (pending) {
        changed = true;
        return;
      }
      pending = true;
      changed = false;
      const basis = fingerprintOfMind(doc);
      core
        .getFigureSchedule(mindId)
        .then((schedule) => {
          if (active && schedule.basis === basis && schedule.basis === fingerprintOfMind(doc))
            setRead({ doc, schedule });
        })
        .catch((error: unknown) => {
          if (active) useAppStore.getState().reportError(error);
        })
        .finally(() => {
          pending = false;
          if (active && changed) refresh();
        });
    };
    blocks.observeDeep(refresh);
    const stop = core.on("mind.update", (event) => {
      if (event.mindId === mindId) refresh();
    });
    refresh();
    return () => {
      active = false;
      stop();
      blocks.unobserveDeep(refresh);
    };
  }, [mindId, doc, documents, mind?.folderId, mind?.title]);
  return read?.doc === doc ? (read?.schedule ?? null) : null;
}

/** Opens the note's Figure schedule beside it; `focus` false leaves the tab behind the note. */
export async function openFigureSchedule(mindId: string, focus = true): Promise<void> {
  const store = useAppStore.getState();
  let origin = store.layout?.groups.find((group) =>
    group.tabs.some(
      (tab) =>
        tab.id === group.activeTabId && tab.item.kind === "mind" && tab.item.mindId === mindId,
    ),
  );
  if (!origin) {
    await store.openMind(mindId);
    origin = useAppStore
      .getState()
      .layout?.groups.find((group) =>
        group.tabs.some(
          (tab) =>
            tab.id === group.activeTabId && tab.item.kind === "mind" && tab.item.mindId === mindId,
        ),
      );
  }
  if (!origin) return;
  await useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "figures", mindId },
    where: { in: "side", from: origin.id },
    ...(!focus && { focus }),
  });
}

/**
 * Whether the note's one Check, just started, waits for the User's yes (`true`) or
 * runs or ends without one (`false`).
 */
function checkAsks(mindId: string, started: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (asks: boolean) => {
      if (settled) return;
      settled = true;
      stopAsking();
      stopRunning();
      resolve(asks);
    };
    const stopAsking = useMindCheck.subscribe((state) => {
      if (state.asking[mindId]) done(true);
    });
    const stopRunning = useChecks.subscribe((state) => {
      if (state.running[mindId]) done(false);
    });
    void started.finally(() => done(useMindCheck.getState().asking[mindId] !== undefined));
  });
}

/**
 * Tie out figures: runs the one Check when any figure isn't checked since its last edit, then
 * shows the schedule beside the note, which fills in as results come. When the Check first asks
 * (a run billed per token) and the window has no room for groups side by side, the note's
 * question stays in front and the schedule waits in a tab beside it.
 */
export async function tieOutFigures(mindId: string): Promise<void> {
  const schedule = await core.getFigureSchedule(mindId);
  const stale = schedule.rows.some(
    (row) => row.shown.state === "not-checked" || row.shown.state === "needs-recheck",
  );
  const asks = stale ? await checkAsks(mindId, startCheck(mindId)) : false;
  await openFigureSchedule(mindId, !(asks && groupsMerged()));
}

/**
 * The figure outlined in its note: the one chosen in the schedule, or the one Show in the note
 * (Space) took the User to, which stays outlined when the schedule's tab gives way to the note
 * and goes at the User's next click or key there.
 */
export const useFigureFocus = create<{
  mindId: string | null;
  row: FigureScheduleRow | null;
  shown: boolean;
}>(() => ({ mindId: null, row: null, shown: false }));
export function focusFigure(
  mindId: string,
  row: FigureScheduleRow | null,
  how: "chosen" | "shown" | "left" = "chosen",
): void {
  const current = useFigureFocus.getState();
  if (row === null && (current.mindId !== mindId || (how === "left" && current.shown))) return;
  useFigureFocus.setState({
    mindId: row ? mindId : null,
    row,
    shown: row !== null && how === "shown",
  });
  const editor = mindEditor(mindId);
  const place = row && editor ? figurePlace(editor.state.doc, row) : null;
  if (editor && place) scrollMindTo(editor, place.from, place.to);
}
