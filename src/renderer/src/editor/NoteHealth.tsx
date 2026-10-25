import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { CitationAttributes } from "../../../core/api";
import { citationState } from "../../../shared/citations";
import {
  acceptAndCheck,
  checkSentences,
  dismissCheckProblem,
  setCheckCardOpen,
  setOpenClaim,
  useChecks,
} from "../checks";
import { ProblemLine } from "../components/ProblemLine";
import {
  ReadinessExplanation,
  readinessAction,
  readinessAlso,
} from "../components/providers/ChatReadinessNotice";
import { UnreadFilesLine } from "../components/UnreadFilesLine";
import { useComposer } from "../composer";
import { useContradictionLine } from "../contradictions";
import { errorMessage } from "../errors";
import { useLanguage, useT } from "../i18n";
import { startMindCheck, useMindCheck, useMindCheckRun } from "../mindCheck";
import { useEmptyScopeLine } from "../scopeDocuments";
import { useAppStore } from "../store";
import { useCheckUnread } from "../unreadFiles";
import { AddedDocumentsLine } from "./AddedDocumentsLine";
import { AnswerError } from "./AnswerView";
import { originOf } from "./blockOrigins";
import { useCardPlace } from "./checkPlace";
import { coverageOf, keptSentences, sameCoverage, shownClaims } from "./claimChecks";
import { type NoteHealth as Health, type HealthPart, noteHealth } from "./healthCounts";
import { CheckMarkIcon, ClaimMarkIcon } from "./icons";
import { CheckedWhen } from "./MindCheckLine";
import { useRunModel } from "./ModelChip";
import { UncoveredLine } from "./UncoveredLine";
import { COUNT_IDLE_MS } from "./WordCount";

const NO_HEALTH: Health = {
  found: [],
  notFound: [],
  unsupported: [],
  contradicted: [],
  noCitation: [],
  recheck: [],
  notChecked: [],
  unchecked: [],
};

/** A count's words with the number in bold, as the badge shows it: "**3** claims not checked yet". */
export function Counted({ text, count }: { text: string; count: string }) {
  const at = text.indexOf(count);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b className="check-count">{count}</b>
      {text.slice(at + count.length)}
    </>
  );
}

/**
 * A part's words, with its count as `shown`. Unsupported sentences "need a look", as Verify counts
 * them, whether their card says not found or unsupported (#1608).
 */
export function partLabel(
  t: ReturnType<typeof useT>,
  part: HealthPart,
  count: number,
  shown: string,
): string {
  const params = { count: shown };
  switch (part) {
    case "found":
      return count === 1 ? t("health.found.one") : t("health.found", params);
    case "notFound":
      return count === 1 ? t("health.notFound.one") : t("health.notFound", params);
    case "unsupported":
      return count === 1 ? t("health.needLook.one") : t("health.needLook", params);
    case "recheck":
      return count === 1 ? t("health.recheck", params) : t("health.recheck.other", params);
    default:
      return t(`health.${part}`, params);
  }
}

/** Each part's small mark, as the margin draws its state; none for sentences with no Citation. */
export function PartMark({ part }: { part: HealthPart }) {
  switch (part) {
    case "found":
      return <CheckMarkIcon check="found" className="mind-health-icon" />;
    case "notFound":
      return <CheckMarkIcon check="not-found" className="mind-health-icon" />;
    case "unsupported":
      return <ClaimMarkIcon state="unsupported" className="mind-health-icon" />;
    case "contradicted":
      return <ClaimMarkIcon state="contradicted" className="mind-health-icon" />;
    case "recheck":
      return <ClaimMarkIcon state="needs-recheck" className="mind-health-icon" />;
    case "notChecked":
      return <ClaimMarkIcon state="not-checked" className="mind-health-icon" />;
    case "noCitation":
      return null;
  }
}

/** The Mind's health, worked out a moment after it last changed, as the word count is. */
export function useHealth(editor: Editor, skipped: ReadonlySet<string>): Health {
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  const [health, setHealth] = useState<Health>(NO_HEALTH);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const count = () => {
      timer = undefined;
      if (editor.isDestroyed) return;
      setHealth(
        noteHealth(
          editor.state.doc,
          shownClaims(editor.state),
          (attributes: CitationAttributes) => citationState(attributes, documents, kept).check,
          new Set([...skipped, ...keptSentences(editor.state)]),
          (blockId) => originOf(editor.state, blockId) !== null,
        ),
      );
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(count, COUNT_IDLE_MS);
    };
    count();
    editor.on("transaction", later);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", later);
    };
  }, [editor, documents, kept, skipped]);
  return health;
}

const ROWS: readonly HealthPart[] = [
  "contradicted",
  "unsupported",
  "notFound",
  "notChecked",
  "recheck",
  "found",
];

/**
 * The check badge's card for a Mind (#96, #909): one row a part of its
 * health, each moving to the next such sentence or Citation, round to the
 * first; what is running, with Stop, or why a check gave nothing, with the
 * one thing that helps; and the files the checks couldn't read, if any.
 */
export function HealthCard({
  editor,
  doc,
  mindId,
  health,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  health: Health;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useCardPlace(mindId);
  const checkedAll = useMindCheckRun(doc);
  const unread = useCheckUnread(editor, doc);
  const asking = useMindCheck((state) => state.asking[mindId] !== undefined);
  const coverage = useEditorState({
    editor,
    selector: ({ editor: current }) => coverageOf(shownClaims(current.state)),
    equalityFn: sameCoverage,
  });
  const runModel = useRunModel(doc);
  const running = useChecks((state) => state.running[mindId]);
  const problem = useChecks((state) => state.problems[mindId]);
  const smallModel = useChecks((state) => state.smallModel[mindId] === true);
  const contradictions = useContradictionLine(doc, mindId);
  const openSettings = useAppStore((state) => state.openSettings);
  const folderName = useAppStore((state) => {
    const folderId =
      problem?.kind === "no-documents" || problem?.kind === "only-cited" ? problem.folderId : null;
    if (folderId === null) return null;
    return state.library?.groups.find((group) => group.id === folderId)?.name ?? null;
  });
  const emptyScope = useEmptyScopeLine(
    problem?.kind === "no-documents" ? (problem.chosen ?? null) : null,
  );
  const format = (value: number) => new Intl.NumberFormat(language).format(value);

  const label = (part: HealthPart, count: number) => partLabel(t, part, count, format(count));

  /**
   * Puts the cursor at the next such sentence after it, round to the first; for a Citation, just
   * after its marker, where its state shows, so a key can't take the Citation away. It is
   * centred by its own position, not its paragraph's, which can be taller than the page, and clear
   * of the fade and the badge at the page's foot.
   */
  const goToNext = (part: HealthPart) => {
    if (editor.isDestroyed) return;
    const cited = part === "found" || part === "notFound";
    const targets = health[part].map((pos) => (cited ? pos + 1 : pos));
    const head = editor.state.selection.head;
    const next = targets.find((pos) => pos > head) ?? targets[0];
    if (next === undefined) return;
    const { doc } = editor.state;
    const at = Math.min(next, doc.content.size);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(at))));
    editor.view.focus();
    const scroller = editor.view.dom.closest(".mind-scroller");
    if (scroller) {
      const caret = editor.view.coordsAtPos(cited ? at - 1 : at);
      const area = scroller.getBoundingClientRect();
      scroller.scrollTop += (caret.top + caret.bottom) / 2 - (area.top + area.bottom) / 2;
    }
    const claim = cited
      ? undefined
      : shownClaims(editor.state).find((each) => each.sentence.from <= at && at < each.sentence.to);
    if (!claim) return;
    setCheckCardOpen(place, false);
    setOpenClaim(place, claim.check.id);
  };

  const rows = ROWS.filter((part) => health[part].length > 0);
  const close = {
    label: t("checks.close"),
    testId: "checks-problem-close",
    onClick: () => dismissCheckProblem(mindId),
  };
  const row = (part: HealthPart) => {
    const text = label(part, health[part].length);
    return (
      <button
        key={part}
        type="button"
        data-testid={`health-${part}`}
        data-count={health[part].length}
        data-part={part}
        className="check-row"
        aria-label={t("health.next", { part: text })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => goToNext(part)}
      >
        <span className="check-row-mark">
          <PartMark part={part} />
        </span>
        <span className="check-row-text">
          <Counted text={text} count={format(health[part].length)} />
        </span>
        <span className="check-row-next" aria-hidden="true">
          {t("badge.next")}
        </span>
      </button>
    );
  };

  return (
    <>
      <AddedDocumentsLine doc={doc} mindId={mindId} />
      <div className="check-rows" data-testid="mind-health">
        {rows.map(row)}
        {health.unchecked.length > 0 && (
          <div className="check-row" data-testid="health-unchecked">
            <span className="check-row-mark" />
            <span className="check-row-text">
              <Counted
                text={t(
                  health.unchecked.length === 1 ? "health.unchecked.one" : "health.unchecked",
                  { count: format(health.unchecked.length) },
                )}
                count={format(health.unchecked.length)}
              />
            </span>
          </div>
        )}
        {health.noCitation.length > 0 && row("noCitation")}
      </div>
      {checkedAll && !running && (
        <div className="check-card-note">
          <CheckedWhen run={checkedAll} />
        </div>
      )}
      {((smallModel && rows.length > 0) ||
        (contradictions?.kind !== "asking" && contradictions?.run.smallModel)) && (
        <p data-testid="checks-small-model" className="mind-health-line mind-health-note">
          {t("checks.smallModel")}
        </p>
      )}
      {!running && problem?.kind === "not-ready" && (
        <ProblemLine
          testId="checks-problem"
          className="mind-health-line"
          action={readinessAction(problem.readiness, t, openSettings, t("question.setUp"), () =>
            dismissCheckProblem(mindId),
          )}
          also={readinessAlso(problem.readiness, t, openSettings, () =>
            dismissCheckProblem(mindId),
          )}
        >
          <ReadinessExplanation readiness={problem.readiness} inLine />
        </ProblemLine>
      )}
      {!running && problem?.kind === "local-mode" && (
        <ProblemLine
          testId="checks-problem"
          className="mind-health-line"
          action={{
            label: t("checks.problem.chooseModel"),
            onClick: () => {
              dismissCheckProblem(mindId);
              openSettings("models");
            },
          }}
        >
          {t("checks.problem.local-mode")}
        </ProblemLine>
      )}
      {!running && !asking && !problem && coverage.mostlyUncovered && (
        <UncoveredLine
          className="mind-health-line"
          onCheckAll={
            !coverage.canWiden
              ? undefined
              : checkedAll
                ? () => void startMindCheck(mindId, "all", { allDocuments: true })
                : coverage.range && coverage.action
                  ? () =>
                      void checkSentences(
                        editor,
                        mindId,
                        doc,
                        coverage.action ?? "check-against-documents",
                        {
                          ...(coverage.range && { ranges: [coverage.range] }),
                          allDocuments: true,
                        },
                      )
                  : undefined
          }
        />
      )}
      {!running && problem?.kind === "no-documents" && emptyScope !== null && (
        <ProblemLine
          testId="checks-problem"
          className="mind-health-line"
          action={
            problem.checkAll && {
              label: t("checks.checkAll"),
              testId: "checks-check-all",
              onClick: () => {
                dismissCheckProblem(mindId);
                problem.checkAll?.();
              },
            }
          }
          also={{
            label: t("checks.changeScope"),
            testId: "checks-change-scope",
            onClick: () => {
              dismissCheckProblem(mindId);
              useComposer.getState().requestScope();
            },
          }}
        >
          {emptyScope}
        </ProblemLine>
      )}
      {!running && problem?.kind === "no-documents" && emptyScope === null && (
        <ProblemLine
          testId="checks-problem"
          className="mind-health-line"
          action={{
            label: t("checks.addFiles"),
            testId: "checks-add-files",
            onClick: () => void useAppStore.getState().pickDocuments(),
          }}
          also={close}
        >
          {folderName
            ? t("checks.problem.no-documents.folder", { folder: folderName })
            : t("checks.problem.no-documents.all")}
        </ProblemLine>
      )}
      {!running && problem?.kind === "waiting" && (
        <ProblemLine
          testId="checks-waiting"
          className="mind-health-line"
          action={{
            label: t("checks.acceptAndCheck"),
            testId: "checks-accept-and-check",
            onClick: () => {
              dismissCheckProblem(mindId);
              void acceptAndCheck(editor, mindId, doc, problem);
            },
          }}
          also={close}
        >
          {problem.count === 1
            ? t("checks.waiting.one")
            : t("checks.waiting", { count: format(problem.count) })}
        </ProblemLine>
      )}
      {!running && problem?.kind === "find-failed" && (
        <AnswerError
          kind={problem.error.kind}
          modelId={runModel.modelId}
          providerId={runModel.providerId}
          resetsAt={problem.error.resetsAt ?? null}
          signInRoute={problem.error.signInRoute ?? null}
          details={problem.error.message}
          onRetry={() =>
            void startMindCheck(mindId, problem.mode, { allDocuments: problem.allDocuments })
          }
          onOpenSettings={openSettings}
        />
      )}
      {!running &&
        problem &&
        problem.kind !== "not-ready" &&
        problem.kind !== "local-mode" &&
        problem.kind !== "no-documents" &&
        problem.kind !== "waiting" &&
        problem.kind !== "find-failed" && (
          <ProblemLine
            testId="checks-problem"
            className="mind-health-line"
            action={
              problem.kind === "failed" && problem.retry
                ? {
                    label: t("checks.tryAgain"),
                    testId: "checks-try-again",
                    onClick: () => {
                      dismissCheckProblem(mindId);
                      problem.retry?.();
                    },
                  }
                : close
            }
            also={problem.kind === "failed" && problem.retry ? close : undefined}
          >
            {problem.kind === "only-cited"
              ? t("checks.problem.only-cited.folder", { folder: folderName ?? "" })
              : problem.kind === "failed"
                ? t("checks.problem.failed", { message: errorMessage(problem.error, t) })
                : t(`checks.problem.${problem.kind}`)}
          </ProblemLine>
        )}
      <UnreadFilesLine files={unread} testId="checks-unread" className="mind-unread" />
    </>
  );
}
