/**
 * The Folder wall a Question asked from the composer would be behind (#1934), as the core judges
 * it (`wallOfTurn`): the Note's, else the open conversation's when no Note is open. The composer
 * never works it out itself, so its chip, its scope and where a saved paste goes follow what
 * Answers search.
 */
import { useCallback, useContext, useEffect, useState } from "react";
import type { TurnPlace } from "../../core/api";
import { useConversations, useOpenConversation } from "./conversations";
import { core } from "./core";
import { MindIdContext } from "./editor/mindContext";
import { describeError } from "./errors";
import { folderWallOf } from "./folders";
import { useAppStore } from "./store";
import { keptInsideName, wallsOf } from "./walls";

/** How the core says the Note or conversation a Question would be asked in is deleted. */
const GONE: ReadonlySet<string> = new Set(["error.mind.notFound", "error.conversation.notFound"]);

/**
 * The walled Folder of a Question asked at `place`: null outside every wall, undefined until the
 * core has answered for the place as it is now, so nothing shows a wall the turn won't have (#2243).
 */
export function useTurnWall({ mindId, conversationId }: TurnPlace): string | null | undefined {
  const groups = useAppStore((state) => state.library?.groups);
  const noteFolder = useAppStore(
    (state) => state.minds.find((each) => each.id === mindId)?.folderId,
  );
  const conversationFolder = useConversations(
    (state) => state.list.find((each) => each.id === conversationId)?.folderId,
  );
  // The wall of each place, so moving a Folder into or out of a wall asks again, not only
  // switching a wall on or off.
  const noteWall =
    groups !== undefined && noteFolder != null ? folderWallOf(groups, noteFolder) : null;
  const conversationWall =
    groups !== undefined && conversationFolder != null
      ? folderWallOf(groups, conversationFolder)
      : null;
  const asked = JSON.stringify([
    mindId,
    conversationId,
    noteFolder,
    conversationFolder,
    noteWall,
    conversationWall,
  ]);
  const [answer, setAnswer] = useState<{ asked: string; wall: string | null } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` holds the place and all the wall depends on.
  useEffect(() => {
    let current = true;
    core.wallOfTurn({ mindId, conversationId }).then(
      (wall) => {
        if (current) setAnswer({ asked, wall });
      },
      (error: unknown) => {
        // A Note or conversation deleted in another window: the composer waits until it moves on.
        if (GONE.has(describeError(error).wording?.key ?? "")) {
          console.error(`The wall of a Question asked at ${asked} isn't known.`, error);
        } else useAppStore.getState().reportError(error);
      },
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
      wallsOf(state),
      documentId,
      mindId !== null
        ? (state.minds.find((mind) => mind.id === mindId)?.folderId ?? null)
        : (conversation?.folderId ?? null),
    ),
  );
}

/**
 * `useKeptInside` for every Document at once, as an Analysis's table and chart need it (#2378): the
 * walled Folder that keeps each inside it, seen from where they are shown; null when it may be read.
 */
export function useKeptInsideOf(): (documentId: string | null) => string | null {
  const mindId = useContext(MindIdContext);
  const conversation = useOpenConversation();
  const library = useAppStore((state) => state.library);
  const folderId = useAppStore((state) =>
    mindId !== null
      ? (state.minds.find((mind) => mind.id === mindId)?.folderId ?? null)
      : (conversation?.folderId ?? null),
  );
  return useCallback(
    (documentId) => keptInsideName(library, documentId, folderId),
    [library, folderId],
  );
}
