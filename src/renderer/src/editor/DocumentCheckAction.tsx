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
import { useTurnWall } from "../turnWall";
import type { ShownClaim } from "./claimChecks";
import { AskBlock } from "./MindCheckLine";

type ReadyPlan = Extract<DocumentCheckPlan, { kind: "ready" }>;

const readsAtOnce = ({ estimate }: ReadyPlan) =>
  estimate?.billing === "per-token" && estimate.cost !== null && estimate.cost.amount <= 0.5;

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
  const wall = useTurnWall({ mindId, conversationId: null });
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  // A plan is shown, and read, only with the pick it was made for: one the User replaced is dropped.
  const [offer, setOffer] = useState<{ within: SearchScope; plan: DocumentCheckPlan } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState<SearchScope | null>(null);
  const asked = useRef<SearchScope | null>(null);
  const requested = useChecks((state) => state.pickDocument[claim.check.id] === true);
  const running = useChecks((state) => state.running[mindId]);
  const progress = useChecks((state) =>
    running ? state.documentProgress[running.requestId] : undefined,
  );
  const offered = useScopeName(offer?.within ?? null);
  const read = useScopeName(reading);

  useEffect(() => {
    if (requested) setPicking(true);
  }, [requested]);
  useEffect(() => core.on("documentCheck.progress", setDocumentProgress), []);
  useEffect(
    () => () => {
      asked.current = null;
    },
    [],
  );

  const close = () => {
    asked.current = null;
    setPicking(false);
    setOffer(null);
    setFailure(null);
    dismissDocumentPicker(claim.check.id);
  };
  const readPlan = async (within: SearchScope, plan: ReadyPlan) => {
    if (asked.current !== within) return;
    close();
    setReading(within);
    try {
      await checkSentences(editor, mindId, doc, "check-against-document", {
        ranges: [{ from: claim.from, to: claim.to }],
        within,
        plan: plan.id,
      });
    } catch (error) {
      setFailure(errorMessage(error, t));
    } finally {
      setReading((now) => (now === within ? null : now));
    }
  };
  const choose = async (within: SearchScope) => {
    close();
    asked.current = within;
    try {
      const plan = await core.planDocumentCheck({ mindId, within, model: modelInUseOf(doc) });
      if (asked.current !== within) return;
      if (plan.kind === "ready" && readsAtOnce(plan)) await readPlan(within, plan);
      else setOffer({ within, plan });
    } catch (error) {
      if (asked.current === within) setFailure(errorMessage(error, t));
    }
  };

  const plan = offer?.plan;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid="claim-check-document"
        className="citation-card-action"
        disabled={reading !== null}
        onClick={() => setPicking(true)}
      >
        {t("claim.checkAgainstDocument")}
      </button>
      {picking && button && wall !== undefined && (
        <DocumentOrFolderPicker
          anchor={button}
          wall={wall}
          labels={{
            title: t("claim.checkAgainstDocument"),
            search: t("scope.picker.label"),
            noMatch: t("scope.picker.empty"),
          }}
          onChoose={(within) => void choose(within)}
          onClose={close}
        />
      )}
      {offer && plan?.kind === "ready" && (
        <AskBlock
          testId="document-check-ask"
          question={t("claim.readAsk", { scope: offered?.name ?? "", pages: plan.pages })}
          estimate={
            plan.estimate ? estimateLine(plan.estimate, t, language, { always: true }) : null
          }
          check={{
            label: t("claim.readNow"),
            testId: "document-check-read",
            onClick: () => void readPlan(offer.within, plan),
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
            scope: read?.name ?? "",
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
