import { useMemo } from "react";
import type { ConversationAnswer, ConversationQuestion } from "../../../../core/api";
import { answerBlocks, hasText } from "../../../../shared/answerBlocks";
import type { NodeJSON } from "../../../../shared/blockJson";
import { useAnswers } from "../../answers";
import { useAnswerWait } from "../../answerWait";
import { useApprovals, waitingFor } from "../../approvals";
import { regenerateAnswer } from "../../conversations";
import {
  AnswerError,
  ApprovalCard,
  figuresOf,
  NoCitationsLine,
  UncalculatedLine,
} from "../../editor/AnswerView";
import { AskProblem } from "../../editor/AskProblem";
import { PlanLimitLine } from "../../editor/PlanLimitLine";
import { useT } from "../../i18n";
import { useStoppedByPlanLimit } from "../../planLimits";
import { useScopeEmpty } from "../../scopeDocuments";
import { useAppStore } from "../../store";
import { useUnreadFiles } from "../../unreadFiles";
import { ProblemLine } from "../ProblemLine";
import { UnreadFilesLine } from "../UnreadFilesLine";
import { AnswerActions } from "./AnswerActions";
import { AnswerSteps, useStepsScopeOf } from "./AnswerSteps";
import { AnswerText } from "./AnswerText";
import { NoMindToolsLine, UnbackedClaimLine, WaitingChangesLine } from "./ChangeProblemLines";
import { CoverageLine } from "./CoverageLines";
import { MindChangesCard, NoMindLine, wantedAMind } from "./MindChangesCard";

/** What adding an Answer needs from the thread around it. */
export interface AnswerKeeping {
  /** The name of the Mind Add to note adds to; null with no Mind in focus (the ▾ opens). */
  focusedMindName: string | null;
  add(answer: ConversationAnswer): void;
  pick(answer: ConversationAnswer, anchor: HTMLElement): void;
  openTable(answer: ConversationAnswer, table: NodeJSON): void;
}

/**
 * An Answer in the assistant (#201): no box, as an Answer in a Mind has none
 * (DESIGN.md, Answer), in the assistant's reading sizes. Its steps first
 * (#391), folded to one line; its text with its Citations and their checks
 * in their badges; the card of the Minds it changed (#202), and what kept it from
 * changing one; what went wrong, and the approvals it waits for, under
 * it; then its actions (`AnswerActions`).
 */
export function AssistantAnswer({
  answer,
  question,
  sought,
  keeping,
  askedAgain,
}: {
  answer: ConversationAnswer;
  question: ConversationQuestion | undefined;
  /** A link back from a Note led here: it is flashed. */
  sought: boolean;
  keeping: AnswerKeeping;
  /** It was asked again with this many Documents an earlier Answer didn't use. */
  askedAgain?: number;
}) {
  const t = useT();
  const { text, citations, figures, status } = answer;
  const blocks = useMemo(
    () => answerBlocks({ text, citations, figures, status }),
    [text, citations, figures, status],
  );
  const writing = useAnswers((state) => state.writing.has(answer.id));
  const streaming = writing || status === "streaming";
  const problem = useAnswers((state) => state.blocked[answer.id]);
  const waiting = useApprovals((state) => state.waiting);
  const approvals = useMemo(() => waitingFor(waiting, answer.id), [waiting, answer.id]);
  const consenting = useAnswers((state) => state.phases[answer.id] === "waiting-for-consent");
  const { silent, usual } = useAnswerWait(answer, streaming, approvals.length > 0 || consenting);
  const openSettings = useAppStore((state) => state.openSettings);
  const regenerate = () => void regenerateAnswer(answer.id);
  const written = hasText(blocks);
  const { uncalculated } = figuresOf(answer.toolCalls);
  const scopeEmpty = useScopeEmpty(question?.scope ?? null);
  const scopeName = useStepsScopeOf(question)(0);
  const unread = useUnreadFiles(question?.scope ?? null);
  const planModel = useStoppedByPlanLimit(
    status === "failed" ? (answer.errorKind ?? null) : null,
    answer.model?.providerId ?? null,
  )
    ? (answer.model?.modelId ?? null)
    : null;

  return (
    <article
      data-testid="assistant-answer"
      data-answer-id={answer.id}
      data-status={streaming ? "streaming" : status}
      data-sought={sought || undefined}
      aria-label={t("answer.label")}
      className="assistant-answer"
    >
      <AnswerSteps
        answer={answer}
        question={question}
        askedAgain={askedAgain}
        streaming={streaming}
        waitingForApproval={approvals.length > 0}
        wait={silent ? { usual } : null}
        onRegenerate={regenerate}
      />
      {answer.citationSupport === "none" && (
        <NoCitationsLine
          modelId={answer.model?.modelId ?? null}
          providerId={answer.model?.providerId ?? null}
        />
      )}
      <CoverageLine answer={answer} question={question} />
      {(written || streaming) && (
        <AnswerText
          answerId={answer.id}
          blocks={blocks}
          label={t("answer.label")}
          streaming={streaming}
          regenerate={regenerate}
          onOpenTable={(table) => keeping.openTable(answer, table)}
        />
      )}
      <MindChangesCard answer={answer} streaming={streaming} />
      {!streaming && question && !question.askedFrom && wantedAMind(answer) && (
        <NoMindLine question={question} />
      )}
      {!streaming && <WaitingChangesLine answer={answer} />}
      {!streaming && <UnbackedClaimLine answer={answer} onRegenerate={regenerate} />}
      {!streaming && written && status !== "failed" && answer.steps?.withoutMindTools && (
        <NoMindToolsLine
          answerId={answer.id}
          onAdd={(button) =>
            keeping.focusedMindName ? keeping.add(answer) : keeping.pick(answer, button)
          }
        />
      )}
      {!streaming && scopeEmpty && (
        <ProblemLine
          role="status"
          testId="answer-empty-scope"
          action={{
            label: t("claim.searchAll"),
            testId: "answer-search-all",
            onClick: () => void regenerateAnswer(answer.id, { clearScope: true }),
          }}
        >
          {t("scope.empty.line", { scope: scopeName })}
        </ProblemLine>
      )}
      {!streaming && uncalculated > 0 && <UncalculatedLine count={uncalculated} />}
      {!streaming && status !== "failed" && <UnreadFilesLine files={unread} />}
      {!streaming && status === "failed" && !planModel && (
        <AnswerError
          kind={answer.errorKind ?? "unknown"}
          modelId={answer.model?.modelId ?? null}
          providerId={answer.model?.providerId ?? null}
          // A conversation doesn't keep when a plan's limit resets: the line says so without it.
          resetsAt={null}
          signInRoute={answer.errorSignInRoute}
          details={answer.errorMessage}
          failedAt={answer.updatedAt}
          onRetry={regenerate}
          onOpenSettings={openSettings}
        />
      )}
      {!streaming && status === "failed" && planModel && (
        <PlanLimitLine
          modelId={planModel}
          providerId={answer.model?.providerId ?? null}
          details={answer.errorMessage}
          onAnswerAgain={() => regenerateAnswer(answer.id)}
        />
      )}
      {problem && (
        <AskProblem
          problem={problem}
          testIds={{
            notReady: "answer-not-ready",
            skillUnavailable: "answer-skill-unavailable",
            error: "answer-ask-error",
          }}
        />
      )}
      {approvals.length > 0 && (
        <div className="answer-approvals">
          {approvals.map((request) => (
            <ApprovalCard key={request.requestId} request={request} />
          ))}
        </div>
      )}
      <AnswerActions
        answer={answer}
        streaming={streaming}
        stopAbove={silent}
        canKeep={written}
        focusedMindName={keeping.focusedMindName}
        onAdd={() => keeping.add(answer)}
        onPick={(anchor) => keeping.pick(answer, anchor)}
      />
    </article>
  );
}
