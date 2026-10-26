import { type MouseEvent, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { create } from "zustand";
import type { Mind } from "../../core/api";
import { core } from "./core";
import { isProcessing } from "./documentStatus";
import { type NoteState, readNoteState } from "./noteState";
import { useSelection } from "./selection";
import { exampleMindIds, useAppStore } from "./store";

const NO_MINDS: readonly Mind[] = [];

// Home's tab unmounts while another is shown: what the User unfolded and where they scrolled
// wait here for when they come back.
export const useHomeView = create<{ all: boolean; scrollTop: number }>()(() => ({
  all: false,
  scrollTop: 0,
}));

export function useOwnMinds(): readonly Mind[] {
  const minds = useAppStore((state) => state.minds);
  const examples = useAppStore((state) => exampleMindIds(state).join(" "));
  return useMemo(() => {
    const left = new Set(examples.split(" "));
    const own = minds.filter((mind) => !left.has(mind.id));
    if (own.length === 0) return NO_MINDS;
    return own.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [minds, examples]);
}

const SAVED_MS = 500;

export function useMindSnippets(): ReadonlyMap<string, string> {
  const minds = useAppStore((state) => state.minds);
  const [snippets, setSnippets] = useState<ReadonlyMap<string, string>>(new Map());
  const [saves, setSaves] = useState(0);
  // The Minds list changes at most every few seconds while a Mind is typed in; a Mind open
  // beside Home is followed as it is saved, once the typing pauses.
  useEffect(() => {
    let pause: ReturnType<typeof setTimeout> | undefined;
    const stop = core.on("mind.update", () => {
      clearTimeout(pause);
      pause = setTimeout(() => setSaves((count) => count + 1), SAVED_MS);
    });
    return () => {
      clearTimeout(pause);
      stop();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change to any Mind, or a save, can change its line.
  useEffect(() => {
    let current = true;
    core
      .listMindSnippets()
      .then((list) => {
        if (current) setSnippets(new Map(list.map((each) => [each.mindId, each.text])));
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [minds, saves]);
  return snippets;
}

/**
 * Each Mind's own state, for Home's Recent rows (D266): one reader of the note's health
 * (`readNoteState`), so a row and the note's badge say the same. A Mind open beside Home is
 * followed as it is saved, at most every `SAVED_MS`.
 */
export function useMindNoteStates(
  minds: readonly Pick<Mind, "id" | "folderId">[],
): ReadonlyMap<string, NoteState | null> {
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const keptCitationTexts = useAppStore((state) => state.keptCitationTexts);
  const [saves, setSaves] = useState(0);
  const [states, setStates] = useState<ReadonlyMap<string, NoteState | null>>(new Map());
  useEffect(() => {
    let pause: ReturnType<typeof setTimeout> | undefined;
    const stop = core.on("mind.update", () => {
      clearTimeout(pause);
      pause = setTimeout(() => setSaves((count) => count + 1), SAVED_MS);
    });
    return () => {
      clearTimeout(pause);
      stop();
    };
  }, []);
  const wanted = minds.map((mind) => `${mind.id}:${mind.folderId ?? ""}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for the Minds and their Folders.
  useEffect(() => {
    let current = true;
    const folders = new Map(minds.map((mind) => [mind.id, mind.folderId]));
    const ids = minds.map((mind) => mind.id);
    if (ids.length === 0) {
      setStates(new Map());
      return;
    }
    core
      .readMindContents(ids)
      .then((snapshots) => {
        const found = new Map<string, NoteState | null>();
        for (const { mindId, state } of snapshots) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, state);
            found.set(
              mindId,
              readNoteState({
                doc,
                documents,
                keptCitationTexts,
                folderId: folders.get(mindId) ?? null,
              }).state,
            );
          } catch (error) {
            // One Mind's content this version can't read must not blank every other row's state.
            console.warn(
              `Couldn't read the state of Mind ${mindId}; its row shows the snippet.`,
              error,
            );
            found.set(mindId, null);
          } finally {
            doc.destroy();
          }
        }
        if (current) setStates(found);
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [wanted, documents, keptCitationTexts, saves]);
  return states;
}

export function useHomeNeeds(): { reading: number; suggestions: number } {
  const reading = useAppStore(
    (state) => state.documents.filter((each) => isProcessing(each.status)).length,
  );
  const suggestions = useAppStore(
    (state) => state.library?.assignments.filter((each) => each.suggested).length ?? 0,
  );
  return { reading, suggestions };
}

const MINUTE_MS = 60_000;

export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A click on a Recent row or a Folder card: ⌘-click (Ctrl-click) and Shift-click select, as in
 * the sidebar (`useSelectable`). A plain click opens it and leaves nothing selected on Home, which
 * it leaves, so the sidebar lights the Mind shown, as it does for a Mind opened anywhere else.
 */
export function homeClick(select: { onClick(event: MouseEvent): void }, open: () => void) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      select.onClick(event);
      return;
    }
    useSelection.getState().clear("home");
    open();
  };
}
