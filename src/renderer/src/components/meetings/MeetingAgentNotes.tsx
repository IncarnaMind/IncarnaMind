import { useState } from "react";
import { type AgentPairing, type Meeting, NOT_IN_A_FOLDER_ID } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { askAgent, useAgentsToAskRead, useReadAgentsToAsk } from "../../askYourAi";
import { moveIntoFolder } from "../../folderDrag";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { MoveToPicker } from "../MoveToPicker";
import { type ProblemAction, ProblemLine } from "../ProblemLine";

export function MeetingAgentNotes({ meeting, agentId }: { meeting: Meeting; agentId: string }) {
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
  const openSettings = useAppStore((state) => state.openSettings);
  if (!allowed || !active || !noteReaders || !documentId) return null;
  const open = (agent: AgentPairing): ProblemAction => ({
    label: t("meetings.notesAgent.open", { agent: agent.name }),
    onClick: () => void askAgent(agent, meeting.mindId, { kind: "meeting", meetingId: meeting.id }),
  });
  const agent = allowed.find((pairing) => pairing.id === agentId);
  if (agent)
    return (
      <ProblemLine role="status" testId="meeting-agent-notes" action={open(agent)}>
        {t("meetings.notesAgent.ready")}
      </ProblemLine>
    );

  const connected = active.find((pairing) => pairing.id === agentId);
  const readsNote = noteReaders.some((pairing) => pairing.id === agentId);
  const canMove =
    !readsNote && connected?.folderIds.some((id) => id !== NOT_IN_A_FOLDER_ID) && mind;
  const settings: ProblemAction = {
    label: t("meetings.notesAgent.settings"),
    onClick: () => openSettings("agents"),
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
        role="status"
        testId="meeting-agent-unavailable"
        action={fix}
        also={allowed[0] ? open(allowed[0]) : undefined}
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
          offeredFolderIds={connected.folderIds}
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
