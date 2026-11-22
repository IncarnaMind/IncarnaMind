import { useState } from "react";
import type { Meeting, MeetingSummary } from "../../../../core/api";
import { useAgentsToAskRead, useReadAgentsToAsk } from "../../askYourAi";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useMeetings } from "../../meetings";
import { useAppStore } from "../../store";
import { ProblemLine, ProblemMark } from "../ProblemLine";

type Props = { meeting: Meeting; summary: MeetingSummary };

export function MeetingSummaryProblem({ meeting, summary }: Props) {
  const t = useT();
  if (meeting.transcript?.state !== "saved" || !meeting.transcript?.documentId)
    return (
      <ProblemLine
        testId="meeting-summary-problem"
        action={
          meeting.transcript?.problem && meeting.transcript.problem.kind !== "speakers"
            ? {
                label: t("meetings.summary.retryTranscript"),
                onClick: () => void useMeetings.getState().retryTranscript(meeting.id),
              }
            : undefined
        }
      >
        <ProblemMark />
        {t("meetings.summary.needsTranscript")}
      </ProblemLine>
    );
  if (summary.retryAgentId)
    return (
      <AgentSummaryProblem meeting={meeting} summary={summary} agentId={summary.retryAgentId} />
    );
  return <RetrySummary meeting={meeting} summary={summary} />;
}

function AgentSummaryProblem({ meeting, summary, agentId }: Props & { agentId: string }) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  const device = useAppStore((state) => state.settings?.device);
  const documentId = meeting.transcript?.documentId ?? undefined;
  useReadAgentsToAsk(meeting.mindId, documentId);
  const agents = useAgentsToAskRead(meeting.mindId, documentId);
  if (!device || agents === null) return null;
  const agent = agents.find((each) => each.id === agentId);
  if (agentId !== device.meetingNotesAgentId || agentId !== device.meetingSummaryRoute)
    return (
      <ProblemLine
        testId="meeting-summary-problem"
        action={{
          label: t("settings.title"),
          onClick: () => openSettings("meetings"),
        }}
      >
        <ProblemMark />
        {agent
          ? t("meetings.summary.restoreAgent", { agent: agent.name })
          : t("error.meeting.summaryUnavailable")}
      </ProblemLine>
    );
  if (!agent) {
    return (
      <ProblemLine
        testId="meeting-summary-problem"
        action={{
          label: t("meetings.notesAgent.settings"),
          onClick: () => openSettings("ai"),
        }}
      >
        <ProblemMark />
        {t("meetings.summary.share")}
      </ProblemLine>
    );
  }
  return <RetrySummary meeting={meeting} summary={summary} />;
}

function RetrySummary({ meeting, summary }: Props) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await core.retryMeetingSummary(meeting.id);
    } catch (error) {
      useAppStore.getState().reportError(error);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <ProblemLine
      testId="meeting-summary-problem"
      action={{
        label: t("meetings.fill.tryAgain"),
        testId: "meeting-summary-retry",
        disabled: retrying,
        onClick: () => void retry(),
      }}
    >
      <ProblemMark />
      {summary.problem === "codex-input-limit"
        ? t("error.meeting.codexSummaryTooLong")
        : t(summary.text.trim() ? "meetings.summary.updateFailed" : "meetings.summary.failed")}
    </ProblemLine>
  );
}
