import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { DocumentCheckPlan, SearchScope } from "../../../core/api";
import { readsUnasked } from "../../../shared/readBudget";
import {
  checkSentences,
  dismissDocumentPicker,
  planDocumentRead,
  setDocumentProgress,
  stopCheck,
  useChecks,
} from "../checks";
import { DocumentOrFolderPicker } from "../components/DocumentOrFolderPicker";
import { MetaLine } from "../components/MetaLine";
import { LineAction, ProblemLine } from "../components/ProblemLine";
import { core } from "../core";
import { estimateLine } from "../cost";
import { errorMessage } from "../errors";
import { useLanguage, useT } from "../i18n";
import { useScopeName } from "../scopeDocuments";
import { useTurnWall } from "../turnWall";
import type { ShownClaim } from "./claimChecks";
import { AskBlock } from "./MindCheckLine";

type ReadyPlan = Extract<DocumentCheckPlan, { kind: "ready" }>;

// Unknown parts could cost more than the estimate says, so that read always asks.
const readsAtOnce = ({ estimate, parts }: ReadyPlan) => readsUnasked(estimate, parts !== null);

/**
 * Check against a Document…, and a whole read asked again (`requestDocumentRead`): each sized
 * first, with its cost asked when it isn't small. `offer`: the card offers the action itself.
 */
export function DocumentCheckAction({
  editor,
  mindId,
  doc,
  claim,
  offer: offered,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  claim: ShownClaim;
  offer: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const wall = useTurnWall({ mindId, conversationId: null });
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  // A plan is shown, and read, only with the pick it was made for: one the User replaced is dropped.
  const [offer, setOffer] = useState<{ within: SearchScope; plan: DocumentCheckPlan } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef<SearchScope | null>(null);
  const requested = useChecks((state) => state.pickDocument[claim.check.id]);
  const running = useChecks((state) => state.running[mindId]);
  // The read is this card's however it began, so it shows while the read runs, opened or not.
  const reading =
    running?.read && running.read.checkId === claim.check.id ? running.read.within : null;
  const progress = useChecks((state) =>
    running ? state.documentProgress[running.requestId] : undefined,
  );
  const asking = useScopeName(offer?.within ?? null);
  const read = useScopeName(reading);
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
    try {
      await checkSentences(editor, mindId, doc, "check-against-document", {
        ranges: [{ from: claim.from, to: claim.to }],
        within,
        plan: plan.id,
        checkId: claim.check.id,
      });
    } catch (error) {
      setFailure(errorMessage(error, t));
    }
  };
  /** `ask`: a read asked again, never started without the User's Read it, however small. */
  const choose = async (within: SearchScope, ask = false) => {
    close();
    asked.current = within;
    try {
      const plan = await planDocumentRead(editor, mindId, doc, {
        ranges: [{ from: claim.from, to: claim.to }],
        within,
      });
      if (!plan || asked.current !== within) return;
      if (plan.kind === "ready" && !ask && readsAtOnce(plan)) await readPlan(within, plan);
      else setOffer({ within, plan });
    } catch (error) {
      if (asked.current === within) setFailure(errorMessage(error, t));
    }
  };

  // A read already running in the Note goes on undisturbed: a request waits until it ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `choose` reads the latest state.
  useEffect(() => {
    if (!requested || running) return;
    if (requested === true) {
      setPicking(true);
      return;
    }
    dismissDocumentPicker(claim.check.id);
    void choose(requested, true);
  }, [requested, running]);
  const pending = useRef(requested);
  pending.current = requested;
  // A request this card never took up goes with it: opened later, it would read unasked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as the card goes.
  useEffect(
    () => () => {
      if (pending.current !== undefined) dismissDocumentPicker(claim.check.id);
    },
    [],
  );

  const plan = offer?.plan;
  return (
    <>
      {offered && (
        <button
          ref={setButton}
          type="button"
          data-testid="claim-check-document"
          className="citation-card-action"
          disabled={running !== undefined}
          onClick={() => setPicking(true)}
        >
          {t("claim.checkAgainstDocument")}
        </button>
      )}
      {picking && button && wall !== undefined && !running && (
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
          question={[
            t(plan.pages === 1 ? "claim.readAsk.one" : "claim.readAsk", {
              scope: asking?.name ?? "",
              pages: plan.pages,
            }),
            ...(plan.parts === null ? [t("claim.readAsk.unsorted")] : []),
          ].join(language === "zh-CN" ? "" : " ")}
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
          {plan.kind === "too-many"
            ? t("claim.readCannot.many", { most: plan.most })
            : t(plan.kind === "nothing-to-read" ? "claim.readNothing" : "claim.readCannot")}
        </p>
      )}
      {failure && <ProblemLine testId="document-check-problem">{failure}</ProblemLine>}
      {reading && (
        <MetaLine
          data-testid="document-check-progress"
          className="citation-card-note"
          parts={[
            // No count until the first window answers: "0 of 200 pages" read as nothing read.
            progress && progress.pages > 0
              ? t(progress.of === 1 ? "claim.readProgress.one" : "claim.readProgress", {
                  scope: read?.name ?? "",
                  pages: progress.pages,
                  of: progress.of,
                })
              : t("claim.readProgress.starting", { scope: read?.name ?? "" }),
            <LineAction
              key="stop"
              action={{
                label: t("checks.stop"),
                testId: "document-check-stop",
                onClick: () => stopCheck(mindId),
              }}
            />,
          ]}
        />
      )}
    </>
  );
}
