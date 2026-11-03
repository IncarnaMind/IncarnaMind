/**
 * A Mind's Citations and Bibliography in its citation style (#289), as the editor shows them.
 * The core formats them on its style thread (`CoreApi.formatCitations`); the editor asks again
 * only when what is formatted changes (a Citation added, moved into or out of a cluster, a
 * reference record edited, the style switched), never at a keystroke, and shows the last
 * answer meanwhile.
 */
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import {
  type CitationFormatRequest,
  type FormattedCitations,
  type FormattedCluster,
  MIND_FIGURE_RUNS_FIELD,
  MIND_SETTINGS_FIELD,
  type StyledRun,
} from "../../core/api";
import { LANGUAGE_SAMPLE, writtenInChinese } from "../../core/documents/textLanguage";
import type { Language } from "../../core/language";
import {
  type CitationForm,
  type CitationStyleId,
  commonCitationStyle,
} from "../../shared/citationStyles";
import { displayName } from "../../shared/documentNames";
import { bibliographyShown } from "../../shared/mindBibliography";
import {
  chosenCitationStyle,
  citationStylePromptDismissed,
  resolvedCitationStyle,
} from "../../shared/mindCitationStyle";
import { isPaperOrBook } from "../../shared/references";
import { core } from "./core";
import { citationClusters, formattingClusters } from "./editor/citationClusters";
import { errorMessage } from "./errors";
import { translateNow, useLanguage } from "./i18n";
import { useAppStore } from "./store";

/** A Mind's formatting, as last answered. */
export interface MindFormatting {
  style: CitationStyleId;
  /** The last answer, and the signature of each cluster it answered, in order. */
  formatted: FormattedCitations | null;
  signatures: readonly string[];
  /** A newer request is being formatted. */
  pending: boolean;
  /** Why the last request failed, in English, or null. */
  problem: string | null;
  figures?: Readonly<Record<string, { signature: string; cluster: FormattedCluster }>>;
}

interface FormattingState {
  minds: Readonly<Record<string, MindFormatting>>;
  update(mindId: string, change: Partial<MindFormatting> & { style: CitationStyleId }): void;
  forget(mindId: string): void;
}

export const useCitationFormatting = create<FormattingState>()((set) => ({
  minds: {},
  update: (mindId, change) =>
    set((state) => {
      const before = state.minds[mindId];
      const next: MindFormatting = {
        formatted: null,
        signatures: [],
        pending: false,
        problem: null,
        ...before,
        ...change,
      };
      return { minds: { ...state.minds, [mindId]: next } };
    }),
  forget: (mindId) =>
    set((state) => {
      const { [mindId]: _, ...rest } = state.minds;
      return { minds: rest };
    }),
}));

/** The Mind's formatting, or undefined before the editor has asked, and in the assistant (no Mind). */
export const useMindFormatting = (mindId: string | null) =>
  useCitationFormatting((state) => (mindId === null ? undefined : state.minds[mindId]));

/** What a Mind's document says of its citation style, following its changes. */
export interface MindStyleChoice {
  /** The style the Mind chose; null when it follows the default (`useMindCitationStyle`). */
  chosen: CitationStyleId | null;
  /** The User closed the prompt that offers a style, for this Mind. */
  promptDismissed: boolean;
  /** The Mind shows its Bibliography without a style (#102); a styled Mind always does. */
  bibliography: boolean;
}

const choiceIn = (settings: Y.Map<unknown>): MindStyleChoice => ({
  chosen: chosenCitationStyle(settings),
  promptDismissed: citationStylePromptDismissed(settings),
  bibliography: bibliographyShown(settings),
});

/** The Mind's chosen style, if any, and whether it closed the offer of one. */
export function useMindStyleChoice(doc: Y.Doc): MindStyleChoice {
  const settings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
  const [choice, setChoice] = useState(() => choiceIn(settings));
  useEffect(() => {
    const read = () =>
      setChoice((before) => {
        const now = choiceIn(settings);
        return now.chosen === before.chosen &&
          now.promptDismissed === before.promptDismissed &&
          now.bibliography === before.bibliography
          ? before
          : now;
      });
    read();
    settings.observe(read);
    return () => settings.unobserve(read);
  }, [settings]);
  return choice;
}

/** The Documents a Mind cites, each once, as one string, so the editor re-renders only when they change. */
const citedDocuments = (editor: Editor) =>
  [
    ...new Set(
      citationClusters(editor.state).flatMap((cluster) =>
        cluster.members.flatMap((member) => member.attributes.documentId ?? []),
      ),
    ),
  ]
    .sort()
    .join(" ");

/** Whether the Mind cites a paper or a book: a reference record of one of those kinds, with authors or a year. */
export function useCitesWorks(editor: Editor): boolean {
  const cited = useEditorState({
    editor,
    selector: ({ editor: current }) => citedDocuments(current),
  });
  return useAppStore((state) => {
    if (cited === "") return false;
    const ids = new Set(cited.split(" "));
    return state.documents.some(
      (document) => ids.has(document.id) && isPaperOrBook(document.reference),
    );
  });
}

/** The language the Mind's text is in, from its start, as the core reads it for exports. */
export function useMindTextLanguage(editor: Editor): Language {
  const chineseText = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { doc } = current.state;
      // Positions count each Block's edges too: twice the sample holds at least as many characters.
      const end = Math.min(doc.content.size, LANGUAGE_SAMPLE * 2);
      return writtenInChinese(doc.textBetween(0, end, "\n"));
    },
  });
  return chineseText ? "zh-CN" : "en";
}

/**
 * The style the Mind is in: its choice, else the default for the interface's language, the
 * Mind's text and what it cites (`resolvedCitationStyle`), as the core works it out for exports.
 */
export function useMindCitationStyle(
  editor: Editor,
  choice: MindStyleChoice,
  textLanguage: Language,
): CitationStyleId {
  const language = useLanguage();
  const citesWorks = useCitesWorks(editor);
  const chineseText = textLanguage === "zh-CN";
  return resolvedCitationStyle(choice, { language, chineseText, citesWorks });
}

/**
 * How the Mind's Citations read in the text: a common style's form, else the form its last
 * answer was in, a note style's or Numbered's for a style this version doesn't have.
 */
export function citationForm(
  style: CitationStyleId,
  formatting: MindFormatting | undefined,
): CitationForm {
  const common = commonCitationStyle(style);
  if (common) return common.form;
  const formatted = formatting?.style === style ? formatting.formatted : null;
  return formatted?.form ?? "in-text";
}

/** How long the editor waits after a change before it asks again: a run of changes asks once. */
const SETTLE_MS = 150;

/**
 * Keeps the Mind's formatting (`useCitationFormatting`) in step with its editor: asks the core
 * when the clusters, the cited Documents' records or the style change, and keeps the newest
 * answer. Mounted once per open Mind.
 */
export function useCitationFormattingFor(
  editor: Editor,
  style: CitationStyleId,
  mindId: string,
  textLanguage: Language,
  doc: Y.Doc | null = null,
): void {
  const documents = useAppStore((state) => state.documents);
  /** What was asked last, kept across the effect's runs (Documents change often). */
  const last = useRef({ asked: "", latest: 0 });

  useEffect(() => {
    const progress = last.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { update } = useCitationFormatting.getState();

    const ask = () => {
      timer = undefined;
      if (editor.isDestroyed) return;
      // Numbered needs nothing formatted: its markers are numbered in the editor.
      if (style === "numbered") {
        progress.asked = "";
        progress.latest++;
        update(mindId, {
          style,
          formatted: null,
          signatures: [],
          figures: {},
          pending: false,
          problem: null,
        });
        return;
      }
      const clusters = citationClusters(editor.state);
      let gathered: ReturnType<typeof formattingClusters>;
      try {
        gathered = formattingClusters(editor.state, doc);
      } catch (error) {
        progress.asked = "";
        progress.latest++;
        update(mindId, {
          style,
          figures: {},
          pending: false,
          problem: errorMessage(error, translateNow),
        });
        return;
      }
      const request: CitationFormatRequest = {
        style,
        clusters: gathered.map(({ works }) => ({ works })),
        language: textLanguage,
      };
      // A record edited or a Document renamed since is a new request, though the Citations are as they were.
      const records = new Map(
        documents.map((document) => [
          document.id,
          `${document.reference?.updatedAt ?? ""}\n${displayName(document)}`,
        ]),
      );
      const cited = request.clusters.flatMap((cluster) =>
        cluster.works.map((work) => (work.documentId ? (records.get(work.documentId) ?? "-") : "")),
      );
      const key = JSON.stringify([request, cited]);
      if (key === progress.asked) return;
      progress.asked = key;
      const signatures = clusters.map((cluster) => cluster.signature);
      const id = ++progress.latest;
      update(mindId, { style, pending: true });
      core.formatCitations(request).then(
        (formatted) => {
          if (id !== progress.latest) return;
          const figures: Record<string, { signature: string; cluster: FormattedCluster }> = {};
          const ordinary: FormattedCluster[] = [];
          gathered.forEach((item, index) => {
            const cluster = formatted.clusters[index];
            if (!cluster) return;
            if (item.figure !== null) figures[item.figure] = { signature: item.signature, cluster };
            if (item.citation !== null) ordinary[item.citation] = cluster;
          });
          update(mindId, {
            style,
            formatted: { ...formatted, clusters: ordinary },
            figures,
            signatures,
            pending: false,
            problem: null,
          });
        },
        (error: unknown) => {
          if (id !== progress.latest) return;
          progress.asked = "";
          update(mindId, { style, pending: false, problem: errorMessage(error, translateNow) });
        },
      );
    };

    ask();
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(ask, SETTLE_MS);
    };
    editor.on("transaction", onTransaction);
    const onEvidence = () => onTransaction({ transaction: { docChanged: true } });
    const evidence = doc?.getMap(MIND_FIGURE_RUNS_FIELD);
    evidence?.observe(onEvidence);
    const again = () => {
      progress.asked = "";
      ask();
    };
    retries.set(mindId, again);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
      evidence?.unobserve(onEvidence);
      if (retries.get(mindId) === again) retries.delete(mindId);
    };
  }, [editor, mindId, style, textLanguage, documents, doc]);

  // Closed: an answer still on its way is dropped, and the Mind's formatting forgotten.
  useEffect(() => {
    const progress = last.current;
    return () => {
      progress.latest++;
      progress.asked = "";
      useCitationFormatting.getState().forget(mindId);
    };
  }, [mindId]);
}

/**
 * In a note style, the note a Citation's cluster is written as, by the key of the cluster's
 * first Citation (`NumberedCitation.key`), once it is formatted as it is now; null otherwise.
 */
export function noteOfCitation(
  state: EditorState,
  formatting: MindFormatting | undefined,
  key: string,
): StyledRun[] | null {
  if (!formatting) return null;
  const { formatted } = formatting;
  if (formatted?.form !== "note") return null;
  const clusters = citationClusters(state);
  const index = clusters.findIndex((cluster) => cluster.members[0]?.key === key);
  const cluster = clusters[index];
  if (!cluster || formatting.signatures[index] !== cluster.signature) return null;
  return (formatted.clusters[index]?.runs ?? []).map(({ work: _, ...run }) => run);
}

/** How to ask again for each open Mind, for its problem line's Try again. */
const retries = new Map<string, () => void>();

/** Asks again for a Mind whose last request failed. */
export const retryFormatting = (mindId: string) => retries.get(mindId)?.();
