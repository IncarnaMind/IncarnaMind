import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import { libraryVersionIds } from "../../../shared/libraryFacts";
import { core } from "../core";
import { useAppStore } from "../store";
import { shownClaims } from "./claimChecks";
import { COUNT_IDLE_MS } from "./WordCount";

/**
 * The Library's facts this Note's checks rest on, as the Library gives them now (#2525), by each
 * fact's version id: asked for again once the Library changes, so a sentence whose fact says
 * otherwise needs a re-check. Empty while the Note's checks rest on none.
 */
export function useLibraryFactsNow(editor: Editor, mindId: string): ReadonlyMap<string, string> {
  const wanted = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      [...libraryVersionIds(shownClaims(current.state).map((claim) => claim.check))]
        .sort()
        .join("\n"),
  });
  const documents = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const minds = useAppStore((state) => state.minds);
  const tags = useAppStore((state) => state.tags);
  const [now, setNow] = useState<ReadonlyMap<string, string>>(NONE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Library's state says when to ask again.
  useEffect(() => {
    if (wanted === "") {
      setNow(NONE);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      core
        .libraryFactsNow(mindId)
        .then((found) => {
          if (live) setNow(new Map(Object.entries(found)));
        })
        .catch((error: unknown) => {
          console.warn(`Couldn't read the Library facts Mind ${mindId}'s checks rest on.`, error);
        });
    }, COUNT_IDLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wanted, documents, library, minds, tags, mindId]);
  return now;
}

const NONE: ReadonlyMap<string, string> = new Map();
