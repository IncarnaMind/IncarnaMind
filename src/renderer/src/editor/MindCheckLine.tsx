import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type * as Y from "yjs";
import type { MindCheckRun } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { useChecks } from "../checks";
import { MetaLine } from "../components/MetaLine";
import { ProblemLine } from "../components/ProblemLine";
import { buttonStyle } from "../components/ui";
import { type EstimateLine, runStopParts } from "../cost";
import { useLanguage, useT } from "../i18n";
import { confirmCheck, dismissMindCheck, startMindCheck, useMindCheck } from "../mindCheck";
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
      {estimate && <MetaLine parts={estimate.parts} title={estimate.title} />}
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
        asking.estimate ??
        (asking.unestimated ? { parts: [unestimated], title: unestimated } : null)
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

export function MindUnchanged({ mindId, since }: { mindId: string; since: string | null }) {
  const t = useT();
  const language = useLanguage();
  const when = since === null ? "" : formatDateTime(since, language);
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
      {when === "" ? t("mindCheck.changed.none") : t("mindCheck.unchanged", { when })}
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

/** What a running check is doing, with its progress: "Checking 12 of 24", or the action's own words. */
export function RunningText({
  editor,
  mindId,
  testId = "badge-progress",
}: {
  editor: Editor;
  mindId: string;
  testId?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const running = useChecks((state) => state.running[mindId]);
  const progress = useMindCheckProgress(editor, running?.requestId ?? null);
  if (!running) return null;
  if (running.action !== "whole-mind") return <>{t(`checks.running.${running.action}`)}</>;
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  return (
    <span data-testid={testId} className="tabular-nums">
      {progress.total === 0
        ? t("verify.finding")
        : t("badge.checking", { done: format(progress.done), total: format(progress.total) })}
    </span>
  );
}

/**
 * When the whole Mind was last checked: "Checked 48 sentences, 2 Oct, 15:20", what stopped it,
 * and how many of its sentences it didn't examine and are still to check (#1682).
 */
export function CheckedWhen({
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
  const when = formatDateTime(run.at, language);
  const said = t(run.sentences === 1 ? "health.checkedAll.one" : "health.checkedAll", {
    count: format(run.sentences),
    when,
  });
  return (
    <MetaLine
      data-testid="health-checked-all"
      parts={[
        said,
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
      ]}
    />
  );
}
