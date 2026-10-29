/**
 * The Folder wall a Question asked from the composer would be behind (#1934), as the core judges
 * it (`wallOfTurn`): the Note's, else the open conversation's when no Note is open. The composer
 * never works it out itself, so its chip, its scope and where a saved paste goes follow what
 * Answers search.
 */
import { useEffect, useState } from "react";
import type { TurnPlace } from "../../core/api";
import { useConversations } from "./conversations";
import { core } from "./core";
import { useAppStore } from "./store";

/** The walled Folder of a Question asked at `place`; null outside every wall, and until known. */
export function useTurnWall({ mindId, conversationId }: TurnPlace): string | null {
  const library = useAppStore((state) => state.library);
  const noteFolder = useAppStore(
    (state) => state.minds.find((each) => each.id === mindId)?.folderId,
  );
  const conversationFolder = useConversations(
    (state) => state.list.find((each) => each.id === conversationId)?.folderId,
  );
  const [wall, setWall] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when a wall, the Note's Folder or the conversation's moves.
  useEffect(() => {
    let current = true;
    core.wallOfTurn({ mindId, conversationId }).then(
      (found) => {
        if (current) setWall(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, [mindId, conversationId, library, noteFolder, conversationFolder]);
  return wall;
}
