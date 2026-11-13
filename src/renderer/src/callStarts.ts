import { createContext, useMemo } from "react";
import type { MarkedCitation } from "../../core/api";
import { callStarts, startedLabel } from "./helpReply";
import { useLanguage, useT } from "./i18n";
import { isLive, useMeetings } from "./meetings";

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

/** The starts of the Answer in the assistant a Citation is drawn in (`useCallStarts`); none elsewhere. */
export const CallStartsContext = createContext<ReadonlyMap<string, string>>(new Map());
