/**
 * The first open's ready Question (#2084): about the User's own Document as soon as one of theirs
 * can be answered, and the example's only while they have none. Pure: one reader, which the core's
 * `readyQuestion()` returns to every host.
 */
import type { Document, ReadyQuestion } from "../core/api";
import type { Language } from "../core/language";
import { displayName } from "./documentNames";
import { isSearchable } from "./documentStatus";
import { translate } from "./i18n";

/** What the reader needs of a Document: enough to name it, ask about it, and tell whether it can answer. */
type AskableDocument = Pick<Document, "id" | "name" | "title" | "status" | "fileStatus">;

export function readyQuestionOf({
  own,
  example,
  language,
}: {
  /** Every Document of the User's own, most recently added first: an example's is not theirs. */
  own: readonly AskableDocument[];
  /** The example's own ready Question, while the example is there. */
  example: string | null;
  language: Language;
}): ReadyQuestion | null {
  if (own.length === 0) return example === null ? null : { question: example, scope: null };
  // A missing file's text is left out of search, so a Question about it couldn't be answered.
  const latest = own.find((each) => isSearchable(each.status) && each.fileStatus !== "missing");
  if (latest === undefined) return null;
  return {
    question: translate(language, "readyQuestion.document", { document: displayName(latest) }),
    scope: { folderIds: [], tagIds: [], documentIds: [latest.id] },
  };
}
