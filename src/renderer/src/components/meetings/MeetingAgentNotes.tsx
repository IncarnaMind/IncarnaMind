import { useState } from "react";
import { type AgentPairing, type Meeting, NOT_IN_A_FOLDER_ID } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { foldersReached } from "../../agentFolders";
import { askAgent, useAgentsToAskRead, useReadAgentsToAsk } from "../../askYourAi";
import { moveIntoFolder } from "../../folderDrag";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { MoveToPicker } from "../MoveToPicker";
import { type ProblemAction, ProblemLine } from "../ProblemLine";

type Translate = ReturnType<typeof useT>;

const openIn = (
  t: Translate,
  meeting: Meeting,
  agent: AgentPairing,
  onAsked?: () => void,
): ProblemAction => ({
  label: t("meetings.notesAgent.open", { agent: agent.name }),
  onClick: async () => {
    if (await askAgent(agent, meeting.mindId, { kind: "meeting", meetingId: meeting.id }))
      onAsked?.();
  },
});

export function MeetingAgentNotes({
  meeting,
  agentId,
  onAsked,
}: {
  meeting: Meeting;
  agentId: string;
  onAsked?: () => void;
}) {
  const t = useT();
  const documentId = meeting.transcript?.documentId ?? undefined;
  useReadAgentsToAsk(meeting.mindId, documentId);
  const allowed = useAgentsToAskRead(meeting.mindId, documentId);
  if (!allowed || !documentId) return null;
  const agent = allowed.find((pairing) => pairing.id === agentId);
  if (!agent)
    return <MeetingAgentUnavailable meeting={meeting} agentId={agentId} onAsked={onAsked} />;
  return (
    <ProblemLine
      role="status"
      testId="meeting-agent-notes"
      action={openIn(t, meeting, agent, onAsked)}
    >
      {t("meetings.notesAgent.ready")}
    </ProblemLine>
  );
}

/**
 * Why the AI chosen for meeting notes can't write them, with the way to fix it: Move to… a Folder
 * shared with it, or Settings. Nothing once it reads both the Note and its Transcript.
 */
export function MeetingAgentUnavailable({
  meeting,
  agentId,
  onAsked,
  role = "status",
}: {
  meeting: Meeting;
  agentId: string;
  onAsked?: () => void;
  role?: "alert" | "status";
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const documentId = meeting.transcript?.documentId ?? undefined;
  useReadAgentsToAsk(meeting.mindId, documentId);
  useReadAgentsToAsk(meeting.mindId);
  useReadAgentsToAsk(null);
  const allowed = useAgentsToAskRead(meeting.mindId, documentId);
  const noteReaders = useAgentsToAskRead(meeting.mindId);
  const active = useAgentsToAskRead(null);
  const mind = useAppStore((state) => state.minds.find((item) => item.id === meeting.mindId));
  const folders = useAppStore((state) => state.library?.groups);
  const openSettings = useAppStore((state) => state.openSettings);
  if (!allowed || !active || !noteReaders || !documentId) return null;
  if (allowed.some((pairing) => pairing.id === agentId)) return null;

  const connected = active.find((pairing) => pairing.id === agentId);
  const readsNote = noteReaders.some((pairing) => pairing.id === agentId);
  const canMove =
    !readsNote && connected?.folderIds.some((id) => id !== NOT_IN_A_FOLDER_ID) && mind;
  const settings: ProblemAction = {
    label: t("meetings.notesAgent.settings"),
    onClick: () => openSettings("ai"),
  };
  const fix: ProblemAction = canMove
    ? {
        label: t("mind.moveTo"),
        onClick: (event) => setAnchor(event.currentTarget),
      }
    : settings;
  return (
    <>
      <ProblemLine
        role={role}
        testId="meeting-agent-unavailable"
        action={fix}
        also={allowed[0] ? openIn(t, meeting, allowed[0], onAsked) : undefined}
      >
        {connected
          ? t(canMove ? "meetings.notesAgent.unshared" : "meetings.notesAgent.needsAccess", {
              agent: connected.name,
            })
          : t("meetings.notesAgent.unavailable")}
      </ProblemLine>
      {connected && mind && anchor && (
        <MoveToPicker
          anchor={anchor}
          name={mindName(mind) || t("mind.untitled")}
          current={mind.folderId}
          offeredFolderIds={foldersReached(folders ?? [], connected.folderIds)}
          onChoose={(folderId) => {
            setAnchor(null);
            void moveIntoFolder({ mindIds: [mind.id] }, folderId);
          }}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
