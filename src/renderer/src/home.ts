import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Mind } from "../../core/api";
import { isProcessing } from "../../shared/documentStatus";
import { isListedMind } from "../../shared/listedMinds";
import { core } from "./core";
import { createHomeNoteStateReader } from "./homeNoteStates";
import { isListedDocument } from "./meetingTranscript";
import type { NoteReading } from "./noteState";
import { useSelection } from "./selection";
import { type AppState, exampleMindIds, useAppStore } from "./store";

const NO_MINDS: readonly Mind[] = [];

// Home's tab unmounts while another is shown: what the User unfolded and where they scrolled
// wait here for when they come back.
export const useHomeView = create<{ all: boolean; scrollTop: number }>()(() => ({
  all: false,
  scrollTop: 0,
}));

export function ownMindsOf(
  state: Pick<AppState, "minds" | "examples" | "otherExamples">,
): readonly Mind[] {
  const examples = new Set(exampleMindIds(state));
  return state.minds
    .filter((mind) => isListedMind(mind) && !examples.has(mind.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useOwnMinds(): readonly Mind[] {
  const minds = useAppStore((state) => state.minds);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(() => {
    const own = ownMindsOf({ minds, examples, otherExamples });
    return own.length > 0 ? own : NO_MINDS;
  }, [minds, examples, otherExamples]);
}

const SAVED_MS = 500;

export function useHomeChanges(): number {
  const [saves, setSaves] = useState(0);
  // The Minds list changes at most every few seconds while a Mind is typed in; a Mind open
  // beside Home is followed as it is saved, once the typing pauses.
  useEffect(() => {
    let pause: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(pause);
      pause = setTimeout(() => setSaves((count) => count + 1), SAVED_MS);
    };
    const stop = core.on("mind.update", later);
    return () => {
      clearTimeout(pause);
      stop();
    };
  }, []);
  return saves;
}

export function useMindSnippets(): ReadonlyMap<string, string> {
  const minds = useAppStore((state) => state.minds);
  const [snippets, setSnippets] = useState<ReadonlyMap<string, string>>(new Map());
  const saves = useHomeChanges();

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
 * Each Mind's own health and state, for Home's next step and Recent rows (D266): one reader
 * of the note's health (`readNoteState`), so a row, the note's badge and Home's next step say
 * the same. A Mind open beside Home is followed as it is saved, at most every `SAVED_MS`.
 */
export function useMindNoteStates(
  minds: readonly Pick<Mind, "id" | "folderId">[],
): ReadonlyMap<string, NoteReading> {
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const keptCitationTexts = useAppStore((state) => state.keptCitationTexts);
  const library = useAppStore((state) => state.library);
  const [states, setStates] = useState<ReadonlyMap<string, NoteReading>>(new Map());
  const readerRef = useRef<ReturnType<typeof createHomeNoteStateReader> | null>(null);
  useEffect(() => {
    const reader = createHomeNoteStateReader({
      readMindContents: (ids) => core.readMindContents(ids),
      onChange: setStates,
      onError: (error) => useAppStore.getState().reportError(error),
    });
    readerRef.current = reader;
    let pause: ReturnType<typeof setTimeout> | undefined;
    const dirty = new Set<string>();
    const stop = core.on("mind.update", ({ mindId }) => {
      dirty.add(mindId);
      clearTimeout(pause);
      pause = setTimeout(() => {
        const ids = [...dirty];
        dirty.clear();
        reader.refresh(ids);
      }, SAVED_MS);
    });
    return () => {
      clearTimeout(pause);
      stop();
      reader.dispose();
      readerRef.current = null;
    };
  }, []);
  const wanted = minds.map((mind) => `${mind.id}:${mind.folderId ?? ""}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for the Minds and their Folders.
  useEffect(() => {
    readerRef.current?.sync(minds, { documents, keptCitationTexts, library });
  }, [wanted, documents, keptCitationTexts, library]);
  return states;
}

export function useHomeNeeds(): { reading: number } {
  const reading = useAppStore(
    (state) =>
      state.documents.filter((each) => isListedDocument(each) && isProcessing(each.status)).length,
  );
  return { reading };
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
