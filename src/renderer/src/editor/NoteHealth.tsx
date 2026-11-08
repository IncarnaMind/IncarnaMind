import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { ANALYSIS_TABLE_ATTRIBUTE, type CitationAttributes } from "../../../core/api";
import { liveVersions, tableShownIn } from "../../../shared/analysisTables";
import { citationState } from "../../../shared/citations";
import { keptBinding } from "../../../shared/figureRuns";
import {
  acceptAndCheck,
  type CheckProblem,
  checkSentences,
  dismissCheckProblem,
  setCheckCardOpen,
  setOpenClaim,
  useChecks,
} from "../checks";
import { MetaLine } from "../components/MetaLine";
import { type ProblemAction, ProblemLine } from "../components/ProblemLine";
import {
  ReadinessExplanation,
  readinessAction,
  readinessAlso,
} from "../components/providers/ChatReadinessNotice";
import { UnreadFilesLine } from "../components/UnreadFilesLine";
import { useComposer } from "../composer";
import { useContradictionLine } from "../contradictions";
import { errorMessage } from "../errors";
import { openFigureSchedule } from "../figures";
import { useLanguage, useT } from "../i18n";
import { startMindCheck, useMindCheck, useMindCheckRun } from "../mindCheck";
import { type NoteState, unreadForCard } from "../noteState";
import { useEmptyScopeLine } from "../scopeDocuments";
import { useAppStore } from "../store";
import { useKeptInsideOf } from "../turnWall";
import { useCheckUnread } from "../unreadFiles";
import { AddedDocumentsLine } from "./AddedDocumentsLine";
import { AnswerError } from "./AnswerView";
import type { BadgeMark } from "./badgeState";
import { useCardPlace } from "./checkPlace";
import { coverageOf, keptSpans, sameCoverage, shownClaims } from "./claimChecks";
import {
  type CheckRow,
  checkRows,
  type NoteHealth as Health,
  healthSummary,
  noteHealth,
} from "./healthCounts";
import { CheckMarkIcon, ClaimMarkIcon } from "./icons";
import { CheckedWhen } from "./MindCheckLine";
import { useRunModel } from "./ModelChip";
import { OpinionsLine } from "./OpinionsLine";
import { useOpinionChecks } from "./opinionChecks";
import { opinionSentenceRanges } from "./opinionLocations";
import { useSignOffCounts } from "./signOffActions";
import { UncoveredLine } from "./UncoveredLine";
import { COUNT_IDLE_MS } from "./WordCount";

const NO_HEALTH: Health = {
  found: [],
  notFound: [],
  lookClaims: [],
  lookNotFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  failed: [],
  uncheckable: [],
  notRecalculated: [],
  recheck: [],
  edited: [],
  checking: [],
  kept: [],
  tableCells: [],
  noCitation: [],
  ownNotes: [],
  supportedAt: [],
  checkable: 0,
  supported: 0,
  checkedAt: null,
  unexamined: [],
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
 * A badge mark's words, with its count as `shown`. Unsupported sentences "need a look", as Verify
 * counts them, whether their card says not found or unsupported (#1608).
 */
export function partLabel(
  t: ReturnType<typeof useT>,
  part: BadgeMark,
  count: number,
  shown: string,
): string {
  const params = { count: shown };
  switch (part) {
    case "notFound":
      return count === 1 ? t("health.notFound.one") : t("health.notFound", params);
    case "unsupported":
      return count === 1 ? t("health.needLook.one") : t("health.needLook", params);
    case "contradicted":
      return count === 1 ? t("health.contradicted.one") : t("health.contradicted", params);
    case "notChecked":
      // Verify's own part: the Mind folds a failed check into its sentences to check (#1909).
      return t("verify.notChecked", params);
  }
}

/** Each badge mark's small icon, as the margin draws its state. */
export function PartMark({ part }: { part: BadgeMark }) {
  switch (part) {
    case "notFound":
      return <CheckMarkIcon check="not-found" className="mind-health-icon" />;
    case "unsupported":
      return <ClaimMarkIcon state="unsupported" className="mind-health-icon" />;
    case "contradicted":
      return <ClaimMarkIcon state="contradicted" className="mind-health-icon" />;
    case "notChecked":
      return <ClaimMarkIcon state="not-checked" className="mind-health-icon" />;
  }
}

/** The Mind's health, worked out a moment after it last changed, as the word count is. */
export function useHealth(
  editor: Editor,
  skipped: ReadonlySet<string>,
  unexamined: ReadonlySet<string>,
  doc: Y.Doc,
): Health {
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  const keptInside = useKeptInsideOf();
  const [health, setHealth] = useState<Health>(NO_HEALTH);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const count = () => {
      timer = undefined;
      if (editor.isDestroyed) return;
      setHealth(
        noteHealth(editor.state.doc, {
          claims: shownClaims(editor.state),
          citationCheck: (attributes: CitationAttributes) =>
            citationState(attributes, documents, kept).check,
          skipped,
          unexamined,
          omitted: opinionSentenceRanges(editor.state.doc, doc),
          kept: keptSpans(editor.state),
          tableShown: (table) =>
            tableShownIn(doc, table.toJSON(), "en", liveVersions(documents), keptInside),
          tableKept: (table) => keptBinding(doc, table.attrs[ANALYSIS_TABLE_ATTRIBUTE]) !== null,
        }),
      );
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(count, COUNT_IDLE_MS);
    };
    count();
    editor.on("transaction", later);
    doc.on("afterTransaction", later);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", later);
      doc.off("afterTransaction", later);
    };
  }, [editor, doc, documents, kept, skipped, unexamined, keptInside]);
  return health;
}

const ROW_WORDS = {
  look: "checks.row.look",
  supported: "checks.row.supported",
  ownNotes: "checks.row.ownNotes",
  checking: "checks.row.checking",
  toCheck: "checks.row.notChecked",
} as const;

function RowMark({ row }: { row: CheckRow }) {
  switch (row) {
    case "look":
      return <ClaimMarkIcon state="unsupported" className="mind-health-icon" />;
    case "supported":
      return <ClaimMarkIcon state="supported" className="mind-health-icon" />;
    case "ownNotes":
      return <ClaimMarkIcon state="supported" ownNoteOnly className="mind-health-icon" />;
    case "checking":
      return <ClaimMarkIcon state="checking" className="mind-health-icon" />;
    case "toCheck":
      return <ClaimMarkIcon state="not-checked" className="mind-health-icon" />;
  }
}

/**
 * The check badge's card for a Mind (#96, #909): one row a state of its
 * sentences (#2831), each moving to the next sentence in it, round to the
 * first; what is running, with Stop, or why a check gave nothing, with the
 * one thing that helps; and the files the checks couldn't read, if any.
 */
export function HealthCard({
  editor,
  doc,
  mindId,
  health,
  state,
  figures,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  health: Health;
  state: NoteState | null;
  figures: number;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useCardPlace(mindId);
  const checkedAll = useMindCheckRun(doc);
  const opinions = useOpinionChecks(editor, doc);
  const unread = useCheckUnread(editor, doc);
  const narrowUnread = useCheckUnread(editor, doc, { narrowerThanAll: true });
  const asking = useMindCheck((state) => state.asking[mindId] !== undefined);
  const coverage = useEditorState({
    editor,
    selector: ({ editor: current }) => coverageOf(shownClaims(current.state)),
    equalityFn: sameCoverage,
  });
  const runModel = useRunModel(doc);
  const running = useChecks((state) => state.running[mindId]);
  // The opinions left out show once in the card: on the last check's line when it shows.
  const opinionsHere = opinions.length > 0 && (Boolean(running) || !checkedAll);
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
  const signedOff = useSignOffCounts(editor);

  const rowText = (row: CheckRow, count: number) =>
    t(count === 1 ? `${ROW_WORDS[row]}.one` : ROW_WORDS[row], { count: format(count) });
  const rows = checkRows(health);
  const placesOf = (row: CheckRow): readonly number[] =>
    rows.find((each) => each.row === row)?.places ?? [];

  /**
   * Puts the cursor at the next such sentence after it, round to the first. It is centred by its
   * own position, not its paragraph's, which can be taller than the page, and clear of the fade and
   * the badge at the page's foot.
   */
  const goToNext = (row: CheckRow) => {
    if (editor.isDestroyed) return;
    const targets = placesOf(row);
    const head = editor.state.selection.head;
    const next = targets.find((pos) => pos > head) ?? targets[0];
    if (next === undefined) return;
    const { doc } = editor.state;
    const at = Math.min(next, doc.content.size);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(at))));
    editor.view.focus();
    const scroller = editor.view.dom.closest(".mind-scroller");
    if (scroller) {
      const caret = editor.view.coordsAtPos(at);
      const area = scroller.getBoundingClientRect();
      scroller.scrollTop += (caret.top + caret.bottom) / 2 - (area.top + area.bottom) / 2;
    }
    const claim = shownClaims(editor.state).find(
      (each) => each.sentence.from <= at && at < each.sentence.to,
    );
    if (!claim) return;
    setCheckCardOpen(place, false);
    if (claim.kind === "chart") {
      void openFigureSchedule(mindId).catch(useAppStore.getState().reportError);
      return;
    }
    setOpenClaim(place, claim.check.id);
  };

  // While a run is on, the note line carries only the verdicts that landed since it started: the
  // rows above already name the Mind's whole counts, and an earlier verdict did not just land.
  const landedRows = ["look", "supported"] as const;
  const beforeRun = useRef<readonly (readonly [CheckRow, number])[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counts are kept as the run found them, not refreshed.
  useLayoutEffect(() => {
    beforeRun.current =
      running === undefined
        ? null
        : (beforeRun.current ?? landedRows.map((row) => [row, placesOf(row).length] as const));
  }, [running]);
  const landed =
    running === undefined || beforeRun.current === null
      ? []
      : landedRows
          .map(
            (row) =>
              [
                row,
                Math.max(
                  placesOf(row).length -
                    (beforeRun.current?.find(([each]) => each === row)?.[1] ?? 0),
                  0,
                ),
              ] as const,
          )
          .filter(([, count]) => count > 0)
          .map(([row, count]) => rowText(row, count));
  const summary = healthSummary(health, {
    running: running !== undefined,
    problem: problem !== undefined,
    unread: state?.unreadMatters === true ? state.unread : 0,
  });
  const close = {
    label: t("checks.close"),
    testId: "checks-problem-close",
    onClick: () => dismissCheckProblem(mindId),
  };
  const row = (part: CheckRow) => {
    const count = placesOf(part).length;
    const text = rowText(part, count);
    return (
      <button
        key={part}
        type="button"
        data-testid={`health-${part}`}
        data-count={count}
        data-part={part}
        className={part === "ownNotes" ? "check-row check-row--under" : "check-row"}
        aria-label={t("health.next", { part: text })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => goToNext(part)}
      >
        <span className="check-row-mark">
          <RowMark row={part} />
        </span>
        <span className="check-row-text">
          <Counted text={text} count={format(count)} />
        </span>
        <span className="check-row-next" aria-hidden="true">
          {t("badge.next")}
        </span>
      </button>
    );
  };

  // What the note line says: what has landed so far while a run is on, then when it was checked.
  // With nothing to say it takes no line, so no empty line is reserved.
  const note =
    running !== undefined ? (
      landed.length > 0 && <MetaLine parts={landed} />
    ) : checkedAll != null && health.checking.length === 0 ? (
      // The health is counted a moment after the record lands: until no claim says it is being
      // checked, the line would name a check a row still says is running (#2313).
      <CheckedWhen
        run={checkedAll}
        editor={editor}
        doc={doc}
        mindId={mindId}
        unexamined={health.unexamined.length}
      />
    ) : null;
  return (
    <>
      {summary?.kind === "all" && (
        <p data-testid="health-all-checked" className="mind-health-summary">
          {t("health.allChecked")}
        </p>
      )}
      <AddedDocumentsLine doc={doc} mindId={mindId} />
      <div className="check-rows" data-testid="mind-health">
        {rows.map(({ row: part }) => row(part))}
      </div>
      {(health.kept.length > 0 || opinionsHere) && (
        <p data-testid="health-kept" className="mind-health-line">
          {health.kept.length > 0 &&
            t(health.kept.length === 1 ? "health.kept.one" : "health.kept", {
              count: format(health.kept.length),
            })}
          {health.kept.length > 0 && opinionsHere && " · "}
          {opinionsHere && <OpinionsLine editor={editor} doc={doc} mindId={mindId} className="" />}
        </p>
      )}
      {health.tableCells.length > 0 && (
        <p data-testid="health-table-cells" className="mind-health-line">
          {t("health.tableCells", { count: format(health.tableCells.length) })}
        </p>
      )}
      {figures > 0 && (
        <p data-testid="health-figures" className="mind-health-line">
          {figures === 1 ? t("figures.count.one") : t("figures.count", { count: format(figures) })}
          <span className="mind-health-sep" aria-hidden="true">
            {" · "}
          </span>
          <button
            type="button"
            className="mind-health-link"
            data-testid="health-open-schedule"
            onClick={() => {
              setCheckCardOpen(place, false);
              void openFigureSchedule(mindId).catch(useAppStore.getState().reportError);
            }}
          >
            {t("figures.openSchedule")}
          </button>
        </p>
      )}
      {/* The User's own checks (#1933), on a line of their own: never a check result. */}
      {(signedOff.checked > 0 || signedOff.changed > 0) && (
        <p data-testid="health-sign-offs" className="mind-health-line">
          {signedOff.checked > 0 && t("signOff.count.mine", { count: format(signedOff.checked) })}
          {signedOff.checked > 0 && signedOff.changed > 0 && (
            <span className="mind-health-sep" aria-hidden="true">
              {" · "}
            </span>
          )}
          {signedOff.changed > 0 &&
            t("signOff.count.changed", { count: format(signedOff.changed) })}
        </p>
      )}
      {note && <div className="check-card-note">{note}</div>}
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
              void acceptAndCheck(editor, mindId, doc, problem, (checkId) => {
                setCheckCardOpen(place, false);
                setOpenClaim(place, checkId);
              });
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
          onRetry={problem.retry}
          onOpenSettings={openSettings}
        />
      )}
      {!running && problem?.kind === "failed" && (
        <FailedCheckProblem mindId={mindId} problem={problem} close={close} />
      )}
      {!running &&
        problem &&
        problem.kind !== "not-ready" &&
        problem.kind !== "local-mode" &&
        problem.kind !== "no-documents" &&
        problem.kind !== "waiting" &&
        problem.kind !== "find-failed" &&
        problem.kind !== "failed" && (
          <ProblemLine testId="checks-problem" className="mind-health-line" action={close}>
            {problem.kind === "only-cited"
              ? t("checks.problem.only-cited.folder", { folder: folderName ?? "" })
              : problem.kind === "running"
                ? t("mindCheck.alreadyChecking")
                : t(`checks.problem.${problem.kind}`)}
          </ProblemLine>
        )}
      <UnreadFilesLine
        files={unreadForCard(unread, narrowUnread, state)}
        testId="checks-unread"
        className="mind-unread"
      />
    </>
  );
}

/** A check that failed: what it said under Details, and Try again where it can run again. */
function FailedCheckProblem({
  mindId,
  problem,
  close,
}: {
  mindId: string;
  problem: Extract<CheckProblem, { kind: "failed" }>;
  close: ProblemAction;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const cause = errorMessage(problem.error, t);
  return (
    <ProblemLine
      testId="checks-problem"
      title={cause}
      className="mind-health-line"
      action={
        problem.retry
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
      also={problem.retry ? close : undefined}
      disclosure={
        cause === ""
          ? undefined
          : {
              toggle: (
                <button
                  type="button"
                  data-testid="checks-problem-details"
                  aria-expanded={open}
                  aria-controls={panel}
                  onClick={() => setOpen(!open)}
                  className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                >
                  {t("details.label")}
                </button>
              ),
              panel: open ? (
                <p
                  id={panel}
                  data-testid="checks-problem-details-text"
                  className="mt-1 break-words"
                >
                  {cause}
                </p>
              ) : null,
            }
      }
    >
      {t("checks.problem.failed")}
    </ProblemLine>
  );
}
