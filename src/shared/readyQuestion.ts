/**
 * The first open's ready Question (#2084): about the User's own Documents as soon as one of
 * theirs can be answered, and the example's only while they have none. Pure: one reader, which
 * the core's `readyQuestion()` returns to every host.
 */
import type { Document, FirstOpenQuestion } from "../core/api";
import type { Language } from "../core/language";
import { displayName } from "./documentNames";
import { isSearchable } from "./documentStatus";
import { translate } from "./i18n";

/** What the reader needs of a Document: enough to name it, ask about it, and tell whether it can answer. */
type AskableDocument = Pick<
  Document,
  "id" | "name" | "title" | "status" | "fileStatus" | "notCited"
>;

export function readyQuestionOf({
  own,
  example,
  language,
}: {
  /** Every Document of the User's own, most recently added first: an example's is not theirs. */
  own: readonly AskableDocument[];
  /**
   * The example's own ready Question while an Answer can still be written for it, and the
   * Document its Answer waits for, or null once it can answer (#2218).
   */
  example: { question: string; waitingFor: string | null } | null;
  language: Language;
}): FirstOpenQuestion {
  // Its row says this while there is no Question yet, so the window needn't read the Documents again.
  const beingRead = own.find((each) => each.status === "queued" || each.status === "extracting");
  const reading = beingRead === undefined ? null : displayName(beingRead);
  if (own.length === 0) {
    return {
      ready:
        example === null
          ? null
          : { question: example.question, scope: null, waitingFor: example.waitingFor },
      reading,
    };
  }
  // A missing file's text is left out of search, and a Document the User kept as their own
  // workings is never cited: a Question about either one could not be answered and cited.
  const askable = own.filter(
    (each) => isSearchable(each.status) && each.fileStatus !== "missing" && !each.notCited,
  );
  if (askable.length === 0) return { ready: null, reading };
  // One Document is asked about by name; more are all asked about alike, so no one of them
  // reads as the one the app picked (#2270).
  if (askable.length > 1) {
    return {
      ready: {
        question: translate(language, "readyQuestion.documents", { count: askable.length }),
        scope: { folderIds: [], tagIds: [], documentIds: askable.map((each) => each.id) },
        waitingFor: null,
      },
      reading,
    };
  }
  const latest = askable[0];
  if (latest === undefined) return { ready: null, reading };
  return {
    ready: {
      question: translate(language, "readyQuestion.document", { document: displayName(latest) }),
      scope: { folderIds: [], tagIds: [], documentIds: [latest.id] },
      waitingFor: null,
    },
    reading,
  };
}
