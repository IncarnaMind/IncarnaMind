import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { FigureScheduleRow } from "../../core/api";
import { type FigureSchedule, MIND_CONTENT_FIELD } from "../../core/api";
import { fingerprintOfMind } from "../../shared/mindState";
import { core } from "./core";
import { figurePlace } from "./editor/figureActions";
import { mindEditor } from "./editor/openEditors";
import { scrollMindTo } from "./editor/reviewPick";
import { startCheckThisMind } from "./mindCheck";
import { useAppStore } from "./store";

export function useFigureSchedule(mindId: string, doc: Y.Doc | null): FigureSchedule | null {
  const documents = useAppStore((state) => state.documents);
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const [read, setRead] = useState<{ doc: Y.Doc; schedule: FigureSchedule } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Source versions and Folder/title changes invalidate the core projection.
  useEffect(() => {
    setRead(null);
    if (!doc) return;
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    let active = true;
    let pending = false;
    let changed = false;
    const refresh = () => {
      setRead((current) => {
        if (current?.doc !== doc) return null;
        const rows = current.schedule.rows.map(
          (row): FigureScheduleRow =>
            row.shown.state === "kept" ||
            row.shown.state === "checking" ||
            row.shown.state === "not-checked"
              ? row
              : {
                  ...row,
                  shown: { state: "needs-recheck", why: "edited" },
                  reason: "needs-recheck",
                },
        );
        return {
          doc,
          schedule: {
            ...current.schedule,
            rows,
            counts: {
              ...current.schedule.counts,
              supported: 0,
              needsLook: rows.filter((row) => row.shown.state === "needs-recheck").length,
            },
          },
        };
      });
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

export async function openFigureSchedule(mindId: string): Promise<void> {
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
  });
}

export async function tieOutFigures(mindId: string): Promise<void> {
  await openFigureSchedule(mindId);
  const schedule = await core.getFigureSchedule(mindId);
  if (
    schedule.rows.some(
      (row) => row.shown.state === "not-checked" || row.shown.state === "needs-recheck",
    )
  )
    await startCheckThisMind(mindId);
}

export const useFigureFocus = create<{ mindId: string | null; row: FigureScheduleRow | null }>(
  () => ({ mindId: null, row: null }),
);
export function focusFigure(mindId: string, row: FigureScheduleRow | null): void {
  if (row === null && useFigureFocus.getState().mindId !== mindId) return;
  useFigureFocus.setState({ mindId: row ? mindId : null, row });
  const editor = mindEditor(mindId);
  const place = row && editor ? figurePlace(editor.state.doc, row) : null;
  if (editor && place) scrollMindTo(editor, place.from, place.to);
}
