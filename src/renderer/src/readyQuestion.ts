/**
 * The first open's ready Question, as this window has it: the one reader (`readyQuestionOf`),
 * over the Documents and the example the store holds, so the card shows it as its Documents are.
 */
import { useMemo } from "react";
import type { ReadyQuestion } from "../../core/api";
import { readyQuestionOf } from "../../shared/readyQuestion";
import { languageNow, useLanguage } from "./i18n";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/** The ready Question now, outside React: what its button asks. */
export function readyQuestionNow(): ReadyQuestion | null {
  const state = useAppStore.getState();
  return readyQuestionOf({
    own: state.documents.filter((each) => isOwnDocument(each, allExamples(state))),
    example: state.examples?.exampleReadyQuestion ?? null,
    language: languageNow(),
  });
}

/** The ready Question, read again as the Documents, the examples or the interface language change. */
export function useReadyQuestion(): ReadyQuestion | null {
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  const language = useLanguage();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `readyQuestionNow` reads these.
  return useMemo(() => readyQuestionNow(), [documents, examples, otherExamples, language]);
}
