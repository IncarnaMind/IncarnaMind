import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { type Planned, planCheckThisMind } from "../mindCheck";
import type { Translate } from "../objects";
import { useAppStore } from "../store";

const IDLE_MS = 300;

/**
 * What the one Check would run now, as the Note, its Documents, the Library and its Folder
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

/**
 * What the one Check would check, for its button's tooltip: the sentences it
 * reads — the one count (#1909) — or nothing changed. Null while the plan
 * can't be made.
 */
export function checkTitle(t: Translate, planned: Planned): string | undefined {
  const { plan } = planned;
  const sentences = plan.kind === "ready" ? plan.sentences : 0;
  if (sentences > 0) {
    return t(sentences === 1 ? "mindCheck.changed.one" : "mindCheck.changed", {
      count: sentences,
    });
  }
  if (plan.kind === "unchanged" || plan.kind === "nothing") return t("mindCheck.changed.none");
  return undefined;
}
