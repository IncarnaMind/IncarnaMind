/**
 * What Get started needs to know of the User's own AI (#3362): the agent connected last, and the
 * newest Note an agent connected now wrote, with its check as Home reads it. Both come from what
 * is there, the pairings and the Notes' own record of who wrote them, so nothing new is kept.
 */
import { useEffect, useState } from "react";
import * as Y from "yjs";
import type { AgentClient, AgentPairing, Document } from "../../core/api";
import { isListedMind } from "../../shared/listedMinds";
import { noteWriterOf } from "../../shared/noteWriter";
import { askableDocuments } from "../../shared/readyQuestion";
import { core } from "./core";
import { homeReading, type NoteState } from "./noteState";
import { allExamples, isOwnDocument, useAppStore } from "./store";
import { type Read, useRead } from "./useRead";

/** A Note an agent wrote, and how its check stands; null `state` before anything was checked. */
export interface AgentNote {
  mindId: string;
  state: NoteState | null;
}

// The last read of each, so a step that shows them has them as it opens and its focus lands on
// its first choice, not on whatever was there before they came.
let pairingsRead: AgentPairing[] | null = null;
let clientsRead: AgentClient[] | null = null;

/** The pairings there are, as Settings › AI lists them, kept as they change. */
export function useAgentPairings(): AgentPairing[] | null {
  const reportError = useAppStore((state) => state.reportError);
  const [pairings, setPairings] = useState<AgentPairing[] | null>(pairingsRead);
  useEffect(() => {
    const keep = (list: AgentPairing[]) => {
      pairingsRead = list;
      setPairings(list);
    };
    core.getAgents().then((settings) => keep(settings.pairings), reportError);
    return core.on("agents.changed", (settings) => keep(settings.pairings));
  }, [reportError]);
  return pairings;
}

/** The agents IncarnaMind can be set up in, those on this computer first (src/core/agents/clients.ts). */
export function useAgentClients(): Read<AgentClient[]> {
  const read = useRead("The agents IncarnaMind can be set up in", () =>
    core.listAgentClients().then((list) => {
      clientsRead = list;
      return list;
    }),
  );
  return read.state === "loading" && clientsRead ? { state: "ready", data: clientsRead } : read;
}

/** The User's own AI is connected, and no model in IncarnaMind works yet. */
export function useAgentAlone(): boolean {
  const pairings = useAgentPairings();
  const modelReady = useAppStore((state) => state.chatReadiness?.ready === true);
  return (pairings?.length ?? 0) > 0 && !modelReady;
}

/** What the card's ask step can name (#3572): a Document some connected agent reads, or why none. */
export type SummaryDocument =
  | { kind: "reading" }
  | { kind: "none" }
  | { kind: "unshared" }
  | { kind: "named"; document: Document };

/**
 * The newest Document of the User's own that a Question can be about and at least one connected
 * agent can read now: the one the card names when it asks their AI for a summary (#3572). `none`:
 * the User has no such Document; `unshared`: they have, and no connected agent reads any.
 */
export function useSummaryDocument(): SummaryDocument {
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  const own = documents.filter((each) =>
    isOwnDocument(each, allExamples({ examples, otherExamples })),
  );
  const candidates = askableDocuments(own).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const wanted = candidates.map((each) => each.id).join(",");
  const [read, setRead] = useState<{ wanted: string; readable: string[] } | null>(null);
  useEffect(() => {
    if (wanted === "") return;
    let version = 0;
    const ask = () => {
      const current = ++version;
      core.listDocumentsToAsk(wanted.split(",")).then((readable) => {
        if (current === version) setRead({ wanted, readable });
      }, useAppStore.getState().reportError);
    };
    ask();
    const stops = [
      core.on("agents.changed", ask),
      core.on("library.changed", ask),
      core.on("library.assignments", ask),
      core.on("settings.changed", ask),
      core.on("dataFlows.changed", ask),
    ];
    return () => {
      version++;
      for (const stop of stops) stop();
    };
  }, [wanted]);
  if (candidates.length === 0) return { kind: "none" };
  if (read?.wanted !== wanted) return { kind: "reading" };
  const document = candidates.find((each) => read.readable.includes(each.id));
  return document ? { kind: "named", document } : { kind: "unshared" };
}

/** At most this many of the newest Notes are read for the one an agent wrote. */
const NEWEST = 20;
/** A Note being written is read again at most this often. */
const SAVED_MS = 500;

/** The newest Note one of `pairings` wrote, read again as Notes are made and saved. */
export function useAgentNote(pairings: readonly AgentPairing[]): AgentNote | null {
  const minds = useAppStore((state) => state.minds);
  const documents = useAppStore((state) => state.documents);
  const keptCitationTexts = useAppStore((state) => state.keptCitationTexts);
  const library = useAppStore((state) => state.library);
  const [saves, setSaves] = useState(0);
  const [note, setNote] = useState<AgentNote | null>(null);
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
  const ids = new Set(pairings.map((pairing) => pairing.id));
  const since = pairings.map((pairing) => pairing.createdAt).sort()[0];
  // No Note an agent wrote is older than the agent's connection.
  const candidates =
    since === undefined
      ? []
      : minds
          .filter((mind) => mind.createdAt >= since && isListedMind(mind))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, NEWEST);
  const wanted = `${[...ids].join(",")}|${candidates.map((mind) => mind.id).join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for the pairings and the Notes.
  useEffect(() => {
    if (candidates.length === 0) {
      setNote(null);
      return;
    }
    let current = true;
    core
      .readMindContents(candidates.map((mind) => mind.id))
      .then((snapshots) => {
        const byId = new Map(snapshots.map((snapshot) => [snapshot.mindId, snapshot]));
        for (const mind of candidates) {
          const snapshot = byId.get(mind.id);
          if (!snapshot) continue;
          const doc = new Y.Doc();
          let pairingId: string | undefined;
          try {
            Y.applyUpdate(doc, snapshot.state);
            const writer = noteWriterOf(doc);
            // A copy carries its source's record: only the Note the record names is the agent's.
            if (writer?.mindId === mind.id) pairingId = writer.pairingId;
          } finally {
            doc.destroy();
          }
          if (pairingId === undefined || !ids.has(pairingId)) continue;
          const reading = homeReading(snapshot, {
            documents,
            keptCitationTexts,
            library,
            folderId: mind.folderId,
          });
          if (current) setNote({ mindId: mind.id, state: reading.state });
          return;
        }
        if (current) setNote(null);
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [wanted, documents, keptCitationTexts, library, saves]);
  return note;
}

/** Marks that need no look: what the page shows only with every result shown, or still going. */
const QUIET = new Set(["supported", "own-view", "checking"]);

/**
 * Opens a Note and takes the User to its first mark that needs a look, in view and focused, its
 * card closed; the Note's top when none does. The marks draw once the Note has opened.
 */
export function openAtFirstLook(mindId: string, focus: (element: HTMLElement) => void): void {
  useAppStore.getState().openMind(mindId);
  const until = performance.now() + 3000;
  const look = () => {
    const pane = document.querySelector(`[data-testid="mind-pane"][data-mind-id="${mindId}"]`);
    const mark = [
      ...(pane?.querySelectorAll<HTMLElement>('[data-testid="claim-mark"]') ?? []),
    ].find((each) => !QUIET.has(each.dataset.check ?? ""));
    if (mark) focus(mark);
    else if (performance.now() < until) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
