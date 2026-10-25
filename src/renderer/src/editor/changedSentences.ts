import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { MindCheckPlan } from "../../../core/api";
import { type Planned, planCheckThisMind } from "../mindCheck";
import type { Translate } from "../objects";
import { useAppStore } from "../store";

const IDLE_MS = 300;

/**
 * What "Check this Mind" would run now, as the Mind, its Documents, the Library and its Folder
 * change; null until known. Not planned while a check runs.
 */
export function useCheckThisMindPlan(doc: Y.Doc, mindId: string, paused: boolean): Planned | null {
  const [planned, setPlanned] = useState<Planned | null>(null);
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const library = useAppStore((state) => state.library);
  const minds = useAppStore((state) => state.minds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change to the Documents, the Library or the Minds is a reason to plan again.
  useEffect(() => {
    if (paused) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer = undefined;
      planCheckThisMind(mindId).then(
        (next) => {
          if (current) setPlanned(next);
        },
        (failure: unknown) => {
          console.warn(`Couldn't plan Check this Mind for Mind ${mindId}.`, failure);
        },
      );
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, IDLE_MS);
    };
    refresh();
    doc.on("update", later);
    return () => {
      current = false;
      clearTimeout(timer);
      doc.off("update", later);
    };
  }, [doc, mindId, paused, documents, library, minds]);
  return planned;
}

/** What "Check this Mind" would check, for its button's tooltip: the sentences to check, or nothing changed. */
export function checkTitle(t: Translate, plan: MindCheckPlan): string | undefined {
  if (plan.kind === "unchanged") return t("mindCheck.changed.none");
  if (plan.kind !== "ready") return undefined;
  return t(plan.sentences === 1 ? "mindCheck.changed.one" : "mindCheck.changed", {
    count: plan.sentences,
  });
}
