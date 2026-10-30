/**
 * The Folder wall a Question asked from the composer would be behind (#1934), as the core judges
 * it (`wallOfTurn`): the Note's, else the open conversation's when no Note is open. The composer
 * never works it out itself, so its chip, its scope and where a saved paste goes follow what
 * Answers search.
 */
import { useContext, useEffect, useState } from "react";
import type { TurnPlace } from "../../core/api";
import { useConversations, useOpenConversation } from "./conversations";
import { core } from "./core";
import { MindIdContext } from "./editor/mindContext";
import { useAppStore } from "./store";
import { keptInsideName } from "./walls";

/**
 * The walled Folder of a Question asked at `place`: null outside every wall, undefined until the
 * core has answered for the place as it is now, so nothing shows a wall the turn won't have (#2243).
 */
export function useTurnWall({ mindId, conversationId }: TurnPlace): string | null | undefined {
  const walls = useAppStore((state) =>
    (state.library?.groups ?? [])
      .filter((group) => group.keepInside)
      .map((group) => group.id)
      .join(" "),
  );
  const noteFolder = useAppStore(
    (state) => state.minds.find((each) => each.id === mindId)?.folderId,
  );
  const conversationFolder = useConversations(
    (state) => state.list.find((each) => each.id === conversationId)?.folderId,
  );
  const asked = JSON.stringify([mindId, conversationId, noteFolder, conversationFolder, walls]);
  const [answer, setAnswer] = useState<{ asked: string; wall: string | null } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` holds the place and all the wall depends on.
  useEffect(() => {
    let current = true;
    core.wallOfTurn({ mindId, conversationId }).then(
      (wall) => {
        if (current) setAnswer({ asked, wall });
      },
      // A Note or conversation deleted in another window: the composer waits until it moves on.
      (error: unknown) =>
        console.error(`The wall of a Question asked at ${asked} isn't known.`, error),
    );
    return () => {
      current = false;
    };
  }, [asked]);
  return answer?.asked === asked ? answer.wall : undefined;
}

/**
 * The walled Folder that keeps a Citation's Document inside it, seen from where the Citation is
 * shown: its Note's Folder, even when it is in none, else the open conversation's; null when it
 * may be read there.
 */
export function useKeptInside(documentId: string | null): string | null {
  const mindId = useContext(MindIdContext);
  const conversation = useOpenConversation();
  return useAppStore((state) =>
    keptInsideName(
      state.library,
      documentId,
      mindId !== null
        ? (state.minds.find((mind) => mind.id === mindId)?.folderId ?? null)
        : (conversation?.folderId ?? null),
    ),
  );
}
