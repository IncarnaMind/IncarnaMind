import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { DocumentCheckPlan, SearchScope } from "../../../core/api";
import {
  checkSentences,
  dismissDocumentPicker,
  setDocumentProgress,
  stopCheck,
  useChecks,
} from "../checks";
import { DocumentOrFolderPicker } from "../components/DocumentOrFolderPicker";
import { ProblemLine } from "../components/ProblemLine";
import { core } from "../core";
import { estimateLine } from "../cost";
import { errorMessage } from "../errors";
import { useLanguage, useT } from "../i18n";
import { modelInUseOf } from "../modelInUse";
import { useScopeName } from "../scopeDocuments";
import type { ShownClaim } from "./claimChecks";
import { AskBlock } from "./MindCheckLine";

export function DocumentCheckAction({
  editor,
  mindId,
  doc,
  claim,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  claim: ShownClaim;
}) {
  const t = useT();
  const language = useLanguage();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [plan, setPlan] = useState<DocumentCheckPlan | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const latest = useRef(0);
  const requested = useChecks((state) => state.pickDocument[claim.check.id] === true);
  const running = useChecks((state) => state.running[mindId]);
  const progress = useChecks((state) =>
    running ? state.documentProgress[running.requestId] : undefined,
  );
  const named = useScopeName(scope);

  useEffect(() => {
    if (requested) setPicking(true);
  }, [requested]);
  useEffect(() => core.on("documentCheck.progress", setDocumentProgress), []);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  const close = () => {
    latest.current++;
    setPicking(false);
    setPlan(null);
    setFailure(null);
    setReading(false);
    dismissDocumentPicker(claim.check.id);
  };
  const read = async (picked: SearchScope) => {
    close();
    const current = latest.current;
    setReading(true);
    try {
      await checkSentences(editor, mindId, doc, "check-against-document", {
        ranges: [{ from: claim.from, to: claim.to }],
        within: picked,
      });
    } catch (error) {
      if (current === latest.current) setFailure(errorMessage(error, t));
    } finally {
      if (current === latest.current) {
        setReading(false);
        setPlan(null);
      }
    }
  };
  const choose = async (picked: SearchScope) => {
    close();
    setScope(picked);
    const current = latest.current;
    try {
      const next = await core.planDocumentCheck({
        mindId,
        within: picked,
        model: modelInUseOf(doc),
      });
      if (current !== latest.current) return;
      if (next.kind !== "ready") {
        setPlan(next);
        return;
      }
      const { estimate } = next;
      if (
        estimate?.billing !== "per-token" ||
        estimate.cost === null ||
        estimate.cost.amount > 0.5
      ) {
        setPlan(next);
      } else {
        await read(picked);
      }
    } catch (error) {
      if (current === latest.current) setFailure(errorMessage(error, t));
    }
  };

  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid="claim-check-document"
        className="citation-card-action"
        disabled={reading}
        onClick={() => setPicking(true)}
      >
        {t("claim.checkAgainstDocument")}
      </button>
      {picking && button && (
        <DocumentOrFolderPicker
          anchor={button}
          labels={{
            title: t("claim.checkAgainstDocument"),
            search: t("scope.picker.label"),
            noMatch: t("scope.picker.empty"),
          }}
          onChoose={(picked) => void choose(picked)}
          onClose={close}
        />
      )}
      {plan?.kind === "ready" && scope && (
        <AskBlock
          testId="document-check-ask"
          question={t("claim.readAsk", { scope: named?.name ?? "", pages: plan.pages })}
          estimate={
            plan.estimate ? estimateLine(plan.estimate, t, language, { always: true }) : null
          }
          check={{
            label: t("claim.readNow"),
            testId: "document-check-read",
            onClick: () => void read(scope),
          }}
          notNow={{
            label: t("claim.readNotNow"),
            testId: "document-check-cancel",
            onClick: close,
          }}
        />
      )}
      {plan && plan.kind !== "ready" && (
        <p data-testid="document-check-cannot" className="citation-card-note">
          {t(plan.kind === "nothing-to-read" ? "claim.readNothing" : "claim.readCannot")}
        </p>
      )}
      {failure && <ProblemLine testId="document-check-problem">{failure}</ProblemLine>}
      {reading && (
        <p data-testid="document-check-progress" className="citation-card-note">
          {t("claim.readProgress", {
            scope: named?.name ?? "",
            pages: progress?.pages ?? 0,
            of: progress?.of ?? 0,
          })}{" "}
          <button type="button" data-testid="document-check-stop" onClick={() => stopCheck(mindId)}>
            {t("checks.stop")}
          </button>
        </p>
      )}
    </>
  );
}
