import { useAgentsToAskRead, useReadAgentsToAsk } from "../../askYourAi";
import { useT } from "../../i18n";
import { useNoAiForNote, useOwnAiPillAt } from "../../ownAiPanel";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { NoteCantReadLine } from "./NoteCantReadLine";
import { OwnAiPill } from "./OwnAiPill";

/**
 * A Note's foot, where its own input stands, when that input can't show for a User whose own AI
 * is the way to ask (#3764): the pill that asks an AI of theirs IncarnaMind can't run here, or,
 * with none of theirs that reads the Note, one line with the one thing that fixes it. Either way
 * it is the Note's one place to ask.
 */
export function NoteFootAsk({ mindId }: { mindId: string }) {
  const t = useT();
  const pill = useOwnAiPillAt(mindId);
  const noAi = useNoAiForNote(mindId);
  useReadAgentsToAsk(null);
  const connected = useAgentsToAskRead(null);
  const openSettings = useAppStore((state) => state.openSettings);
  if (pill) {
    return (
      <div data-testid="note-foot-ask" data-mind-id={mindId} className="mind-measure note-foot-ask">
        <OwnAiPill {...pill} />
      </div>
    );
  }
  if (!noAi || connected === null) return null;
  if (connected.length > 0) {
    return (
      <div data-testid="note-foot-ask" data-mind-id={mindId} className="mind-measure note-foot-ask">
        <NoteCantReadLine mindId={mindId} connected={connected} testId="note-ask-no-ai" />
      </div>
    );
  }
  return (
    <div data-testid="note-foot-ask" data-mind-id={mindId} className="mind-measure note-foot-ask">
      <ProblemLine
        role="status"
        testId="note-ask-no-ai"
        action={{
          label: t("agents.install.connectYourAi"),
          testId: "note-ask-connect",
          onClick: () => openSettings("ai"),
        }}
      >
        {t("noteAsk.noAi")}
      </ProblemLine>
    </div>
  );
}
