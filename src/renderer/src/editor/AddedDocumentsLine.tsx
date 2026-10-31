import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useMemo } from "react";
import type * as Y from "yjs";
import { addedCouldChange } from "../../../shared/claimChecks";
import {
  closeAdded,
  documentsAdded,
  setAdded,
  useAddedDocuments,
  useClosedAdded,
} from "../addedDocuments";
import { useChecks } from "../checks";
import { ProblemLine } from "../components/ProblemLine";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { startMindCheck, useMindCheck } from "../mindCheck";
import { useAppStore } from "../store";
import { shownClaims } from "./claimChecks";
import { COUNT_IDLE_MS } from "./WordCount";

export function useWatchAddedDocuments(editor: Editor, mindId: string): void {
  const checks = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      shownClaims(current.state)
        .filter((claim) => addedCouldChange(claim.check, claim.shown))
        .map((claim) => `${claim.check.id}@${claim.check.checkedAt}`)
        .join(" "),
  });
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const library = useAppStore((state) => state.library);
  useEffect(() => {
    if (checks === "" || documents === null || library === null) {
      setAdded(mindId, null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      core
        .documentsAddedSinceChecks(mindId)
        .then((found) => {
          if (!live) return;
          setAdded(
            mindId,
            Object.fromEntries(found.map((each) => [each.checkId, each.documentIds])),
          );
        })
        .catch((error: unknown) => {
          console.warn(`Couldn't count the Documents added since Mind ${mindId}'s checks.`, error);
        });
    }, COUNT_IDLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [checks, documents, library, mindId]);
  useEffect(() => () => setAdded(mindId, null), [mindId]);
}

export function AddedDocumentsLine({ doc, mindId }: { doc: Y.Doc; mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const added = useAddedDocuments((state) => state.byMind[mindId]);
  const closed = useClosedAdded(doc);
  const running = useChecks((state) => state.running[mindId] !== undefined);
  const asking = useMindCheck((state) => state.asking[mindId] !== undefined);
  const documentIds = useMemo(() => documentsAdded(added), [added]);
  if (running || asking || documentIds.every((id) => closed.has(id))) return null;
  const count = documentIds.length;
  return (
    <ProblemLine
      role="status"
      testId="checks-added"
      className="mind-health-line"
      action={{
        label: t("claim.checkAgain"),
        testId: "checks-added-check",
        onClick: () => void startMindCheck(mindId, "added"),
      }}
      also={{
        label: t("checks.close"),
        testId: "checks-added-close",
        onClick: () => closeAdded(doc, documentIds),
      }}
    >
      {count === 1
        ? t("checks.added.one")
        : t("checks.added", { count: new Intl.NumberFormat(language).format(count) })}
    </ProblemLine>
  );
}
