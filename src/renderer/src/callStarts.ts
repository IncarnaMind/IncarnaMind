import { createContext, useMemo } from "react";
import type { AnswerSteps, ConversationQuestion, MarkedCitation } from "../../core/api";
import { transcriptsNamedAlike } from "./documentPlaces";
import { callStarts, otherCallsOf, startedLabel } from "./helpReply";
import { useLanguage, useT } from "./i18n";
import { isLive, useMeetings } from "./meetings";
import { useAppStore } from "./store";

/**
 * When the call of each cited Transcript started, by Document id, for the ones that show it beside
 * their name so two calls named for the same day read apart (#3005): under a help reply and in an
 * Answer in the assistant. This call is the one recording now.
 */
export function useCallStarts(
  cited: readonly Pick<MarkedCitation, "documentId" | "documentName" | "location">[],
): ReadonlyMap<string, string> {
  const t = useT();
  const language = useLanguage();
  const meetings = useMeetings((state) => state.meetings);
  return useMemo(() => {
    const thisCall = meetings.find(isLive)?.transcript?.documentId ?? null;
    return new Map(
      [...callStarts(cited, meetings, thisCall)].map(([documentId, startedAt]) => [
        documentId,
        startedLabel(startedAt, t, language),
      ]),
    );
  }, [cited, meetings, t, language]);
}

/**
 * The starts of the Answer in the assistant a Citation is drawn in (`useCallStarts`); null outside
 * an Answer, where a Citation goes by `useTranscriptStart`.
 */
export const CallStartsContext = createContext<ReadonlyMap<string, string> | null>(null);

/** The other calls' Transcripts the Answer in the assistant is checked without (`otherCallsOf`). */
export function useOtherCalls(
  question: Pick<ConversationQuestion, "text" | "askedFrom"> | undefined,
  answer: { steps: Pick<AnswerSteps, "sent"> | null },
): ReadonlySet<string> {
  const meetings = useMeetings((state) => state.meetings);
  const { steps } = answer;
  return useMemo(() => otherCallsOf(question, { steps }, meetings), [question, steps, meetings]);
}

/**
 * The Transcripts the Answer in the assistant a Citation is drawn in is checked without
 * (`useOtherCalls`): a Citation of one is left unchecked on purpose. Empty outside an Answer.
 */
export const OtherCallsContext = createContext<ReadonlySet<string>>(new Set());

/**
 * When a Meeting's Transcript's call started, as a Citation of it shows it wherever another
 * Document shares its name (`transcriptsNamedAlike`), in a note as in an Answer (#3005).
 */
export function useTranscriptStart(documentId: string | null): string | null {
  const t = useT();
  const language = useLanguage();
  const alike = useAppStore(
    (state) =>
      documentId !== null &&
      transcriptsNamedAlike(state.documents, state.linkedFolders).has(documentId),
  );
  const startedAt = useMeetings((state) =>
    alike
      ? (state.meetings.find((each) => each.transcript?.documentId === documentId)?.startedAt ??
        null)
      : null,
  );
  return startedAt ? startedLabel(startedAt, t, language) : null;
}
