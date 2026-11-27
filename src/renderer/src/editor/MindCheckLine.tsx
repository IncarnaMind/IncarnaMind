import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type * as Y from "yjs";
import type { MindCheckRun } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { useChecks } from "../checks";
import { EstimateMeta } from "../components/EstimateSource";
import { MetaLine } from "../components/MetaLine";
import { ProblemLine } from "../components/ProblemLine";
import { buttonStyle } from "../components/ui";
import { type EstimateLine, estimateLine, runStopParts } from "../cost";
import { useLanguage, useT } from "../i18n";
import { confirmCheck, dismissMindCheck, startMindCheck, useMindCheck } from "../mindCheck";
import { useRateLimitResumes } from "../rateLimitWaits";
import { useWrittenInNote } from "../writtenChecks";
import { shownClaims } from "./claimChecks";
import { OpinionsLine } from "./OpinionsLine";
import { useOpinionChecks } from "./opinionChecks";

/**
 * A question before a run billed per token, in the check badge's card: what
 * it would check, the estimate under it, then Check and Not now.
 */
export function AskBlock({
  testId,
  question,
  estimate,
  check,
  notNow,
}: {
  testId: string;
  question: string;
  estimate: EstimateLine | null;
  check: { label: string; testId: string; onClick(): void };
  notNow: { label: string; testId: string; onClick(): void };
}) {
  return (
    <div role="status" data-testid={testId} className="check-card-ask">
      <p className="check-card-ask-title">{question}</p>
      {estimate && <EstimateMeta line={estimate} />}
      <div className="check-card-ask-actions">
        <button
          type="button"
          data-testid={check.testId}
          className={buttonStyle("primary", "sm")}
          onClick={check.onClick}
        >
          {check.label}
        </button>
        <button
          type="button"
          data-testid={notNow.testId}
          className={buttonStyle("ghost", "sm")}
          onClick={notNow.onClick}
        >
          {notNow.label}
        </button>
      </div>
    </div>
  );
}

/** The one Check's question (#1941): "Check this Note's 48 claims against this Folder's Documents?" */
export function MindCheckAsk({ mindId }: { mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const asking = useMindCheck((state) => state.asking[mindId]);
  if (!asking) return null;
  const where = asking.inFolder ? "folder" : "all";
  const count = new Intl.NumberFormat(language).format(asking.count);
  const one = asking.count === 1;
  const unestimated = t("mindCheck.ask.unestimated");
  return (
    <AskBlock
      testId="mind-check-ask"
      question={t(one ? `mindCheck.ask.claims.${where}.one` : `mindCheck.ask.claims.${where}`, {
        count,
      })}
      estimate={
        asking.estimate
          ? estimateLine(asking.estimate, t, language)
          : asking.unestimated
            ? { parts: [unestimated], title: unestimated }
            : null
      }
      check={{
        label: t("mindCheck.check"),
        testId: "mind-check-check",
        onClick: () => void confirmCheck(mindId),
      }}
      notNow={{
        label: t("mindCheck.cancel"),
        testId: "mind-check-cancel",
        onClick: () => dismissMindCheck(mindId),
      }}
    />
  );
}

/**
 * Check again on a Note that hasn't changed since its check: it says so, without the time the
 * card's head already gives, and offers to check every sentence anyway (#3840).
 */
export function MindUnchanged({ mindId }: { mindId: string }) {
  const t = useT();
  return (
    <ProblemLine
      role="status"
      testId="mind-check-unchanged"
      className="mind-health-line"
      action={{
        label: t("mindCheck.every"),
        testId: "mind-check-every",
        onClick: () => void startMindCheck(mindId, "all"),
      }}
    >
      {t("mindCheck.changed.none")}
    </ProblemLine>
  );
}

export function useMindCheckProgress(editor: Editor, requestId: string | null) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const mine =
        requestId === null
          ? []
          : shownClaims(current.state).filter((each) => each.check.request === requestId);
      return {
        total: mine.length,
        done: mine.filter((each) => each.shown.state !== "checking").length,
      };
    },
    equalityFn: (a, b) => b !== null && a.done === b.done && a.total === b.total,
  });
}

/** A running check: what it is doing, in words, and how much of it is done once that is counted. */
export interface RunningCheck {
  /** "Checking 12 of 24", "Finding the sentences to check…", the rate limit, or the action's own words. */
  words: string;
  /** The sentences checked so far, of `total`; 0 of 0 until they are counted. */
  done: number;
  total: number;
}

/** What the Note's running check is doing, with its progress; null while none runs. */
export function useRunningCheck(editor: Editor, mindId: string): RunningCheck | null {
  const t = useT();
  const language = useLanguage();
  const running = useChecks((state) => state.running[mindId]);
  const background = useChecks((state) => state.background[mindId]);
  const marked = useMindCheckProgress(editor, running?.requestId ?? null);
  const limitedUntil = useRateLimitResumes(running?.requestId);
  // Checks of what the assistant wrote count as the lines under their Answers do, as each check
  // ends (a table's marks land only together, at its end), every one in the Note as one (#2830).
  const written = useWrittenInNote(mindId);
  const progress = running && background?.includes(running.requestId) && written ? written : marked;
  if (!running) return null;
  const { action } = running;
  const { done, total } = action === "whole-mind" ? progress : { done: 0, total: 0 };
  // While its requests wait on the model's rate limit, the words say when they resume (#2944).
  if (limitedUntil) {
    return {
      words: t("status.rateLimited", { time: formatDateTime(limitedUntil, language) }),
      done,
      total,
    };
  }
  if (action !== "whole-mind") return { words: t(`checks.running.${action}`), done, total };
  if (total === 0) return { words: t("verify.finding"), done, total };
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  return { words: t("badge.checking", { done: format(done), total: format(total) }), done, total };
}

/**
 * What else the last whole check left, under the rows: how many sentences it couldn't tell are
 * claims (#1682), the opinions it left out, and what stopped it. Null when it left nothing.
 */
export function CheckedMore({
  run,
  editor,
  doc,
  mindId,
  unexamined,
}: {
  run: MindCheckRun;
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  unexamined: number;
}) {
  const t = useT();
  const language = useLanguage();
  const opinions = useOpinionChecks(editor, doc);
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const parts = [
    ...(unexamined > 0
      ? [
          t(unexamined === 1 ? "health.unexamined.one" : "health.unexamined", {
            count: format(unexamined),
          }),
        ]
      : []),
    opinions.length > 0 && (
      <OpinionsLine key="opinions" editor={editor} doc={doc} mindId={mindId} className="" />
    ),
    ...(run.stop ? runStopParts(run.stop, t, language) : []),
  ];
  if (!parts.some(Boolean)) return null;
  return <MetaLine data-testid="health-checked-more" className="check-card-note" parts={parts} />;
}
