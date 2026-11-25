import { useMemo, useState } from "react";
import { type AgentPairing, ALL_SHARED_ID } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { foldersReached } from "../../agentFolders";
import { moveIntoFolder } from "../../folderDrag";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { MoveToPicker } from "../MoveToPicker";
import { type ProblemAction, ProblemLine } from "../ProblemLine";

/**
 * Shown at a Note's foot or in its check card when the User has an AI connected, none of which
 * may read this Note (#3536): names the AI, offers to move the Note into a Folder it reads, and
 * links to Settings › AI to change what it shares.
 */
export function NoteCantReadLine({
  mindId,
  connected,
  testId,
  className,
  onMoved,
  onOpenedSettings,
}: {
  mindId: string;
  connected: readonly AgentPairing[];
  testId: string;
  className?: string;
  onMoved?(): void;
  onOpenedSettings?(): void;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const folders = useAppStore((state) => state.library?.groups);
  const openSettings = useAppStore((state) => state.openSettings);

  const offeredFolderIds = useMemo(() => {
    const groups = folders ?? [];
    const ids = new Set<string>();
    for (const agent of connected) {
      for (const id of foldersReached(groups, agent.folderIds)) ids.add(id);
    }
    return [...ids];
  }, [folders, connected]);

  const includeUnfiled =
    mind !== undefined &&
    mind.folderId !== null &&
    connected.some((agent) => agent.folderIds.includes(ALL_SHARED_ID));
  const canMove = mind !== undefined && (offeredFolderIds.length > 0 || includeUnfiled);

  const settingsAction: ProblemAction = {
    label: t("meetings.notesAgent.settings"),
    testId: "note-ask-settings",
    onClick: () => {
      onOpenedSettings?.();
      openSettings("ai");
    },
  };
  const moveAction: ProblemAction = {
    label: t("mind.moveTo"),
    testId: "note-ask-move",
    onClick: (event) => setAnchor(event.currentTarget),
  };

  const [only] = connected;
  const text =
    connected.length === 1 && only
      ? t("noteAsk.cantRead.one", { agent: only.name })
      : t("noteAsk.cantRead");

  return (
    <>
      <ProblemLine
        role="status"
        testId={testId}
        {...(className && { className })}
        action={canMove ? moveAction : settingsAction}
        also={canMove ? settingsAction : undefined}
      >
        {text}
      </ProblemLine>
      {mind && anchor && (
        <MoveToPicker
          anchor={anchor}
          name={mindName(mind) || t("mind.untitled")}
          current={mind.folderId}
          offeredFolderIds={offeredFolderIds}
          includeUnfiled={includeUnfiled}
          onChoose={(folderId) => {
            setAnchor(null);
            onMoved?.();
            void moveIntoFolder({ mindIds: [mind.id] }, folderId);
          }}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
