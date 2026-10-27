import type { AnswerToolCall, AskedFrom } from "../../core/api";
import type { FoldedLine, ReadDocument } from "./answerSteps";
import type { Translate } from "./objects";

/** The check's step line for this many Citations. */
export const checkedWords = (t: Translate, count: number): string =>
  t(count === 1 ? "steps.check.one" : "steps.check", { count });

/** The live line while this many Citations are checked. */
export const checkingWords = (t: Translate, count: number): string =>
  t(count === 1 ? "steps.live.checking.one" : "steps.live.checking", { count });

export function documentReadText(t: Translate, call: AnswerToolCall, live = false): string {
  const field = (name: string) => {
    const value: unknown = call.input?.[name];
    return typeof value === "string" ? value : "";
  };
  const params = { document: field("document"), pages: field("pages"), passage: field("passage") };
  const shape = params.pages ? "pages" : params.passage ? "around" : "opening";
  if (live) {
    if (shape === "pages") return t("steps.live.readDocument.pages", params);
    if (shape === "around") return t("steps.live.readDocument.around", params);
    return t("steps.live.readDocument.opening", params);
  }
  if (shape === "pages") return t("steps.readDocument.pages", params);
  if (shape === "around") return t("steps.readDocument.around", params);
  return t("steps.readDocument.opening", params);
}

export const mindLabel = (t: Translate, mind: AskedFrom) => mind.name || t("mind.untitled");

/** A step about the Mind: the one read, or the one asked from and not read. */
export type MindStep = Extract<FoldedLine, { kind: "read" | "asked" }>;

/**
 * "Read “{Mind}”", "Read your selection in “{Mind}”" when the Question was about
 * one, "Read part of “{Mind}”" when it was cut to fit, or "Asked from {Mind}"; with `name` where the Mind's name goes.
 */
export function mindStepText(t: Translate, step: MindStep, name = mindLabel(t, step.mind)): string {
  if (step.kind === "asked") {
    return step.mind.deleted ? t("steps.asked.deleted") : t("steps.asked", { mind: name });
  }
  if (step.mind.deleted) return t("steps.read.deleted");
  if (step.mind.partial) return t("steps.read.part", { mind: name });
  return t(step.selection ? "steps.read.selection" : "steps.read", { mind: name });
}

export function passagesText(t: Translate, count: number): string {
  return count === 1 ? t("steps.passages.one") : t("steps.passages", { count });
}

/** How many sources, saying "no sources" when there are none. */
export function sourcesText(t: Translate, count: number): string {
  if (count === 0) return t("steps.sources.none");
  return count === 1 ? t("steps.sources.one") : t("steps.sources", { count });
}

/**
 * The Documents read with the Question: “{Document}” for one (a deleted one
 * has no name), else how many; after the Mind's line `read` when it was read too.
 */
export function documentsReadText(
  t: Translate,
  documents: readonly ReadDocument[],
  nameOf: (document: ReadDocument) => string | null,
  read: string | null = null,
): string {
  const [first] = documents;
  const document = documents.length === 1 && first ? nameOf(first) : null;
  const count = documents.length;
  if (read === null) {
    if (documents.length === 1 && document === null) return t("steps.readDocuments.deleted");
    return document === null
      ? t("steps.readDocuments", { count })
      : t("steps.readDocuments.one", { document });
  }
  if (documents.length === 1 && document === null) {
    return t("steps.readDocuments.and.deleted", { read });
  }
  return document === null
    ? t("steps.readDocuments.and", { read, count })
    : t("steps.readDocuments.and.one", { read, document });
}

export interface FoldedWords {
  /** What the Question searched, with this many more scopes beside it. */
  scope(extra: number): string;
  modelOf(modelId: string): string;
  /** A Document's name as it is now; null when it can't be found. */
  documentOf(document: ReadDocument): string | null;
  /** Where the Mind's name goes, to split the line around it. */
  mindName?: string;
}

/** The words of the folded line. */
export function foldedWords(t: Translate, line: FoldedLine, words: FoldedWords): string {
  switch (line.kind) {
    case "searched": {
      // "Nothing found" is for a Documents search alone: another scope may have given the Answer something.
      const sources =
        line.sources === 0 && line.extraScopes === 0
          ? t("steps.found.none")
          : sourcesText(t, line.sources);
      return t("steps.searched", { scope: words.scope(line.extraScopes), sources });
    }
    case "read-passages": {
      const passages = passagesText(t, line.passages);
      if (line.citedAfterChecking === 0) return t("steps.readNoneMatched", { passages });
      return line.citedAfterChecking === 1
        ? t("steps.readCited.one", { passages })
        : t("steps.readCited", { passages, count: line.citedAfterChecking });
    }
    case "searched-web":
      return t("steps.searchedWeb", { sources: sourcesText(t, line.sources) });
    case "listened":
      return t("steps.listened", { sources: sourcesText(t, line.sources) });
    case "read-documents":
      return documentsReadText(
        t,
        line.documents,
        words.documentOf,
        line.read && mindStepText(t, line.read, words.mindName),
      );
    case "read":
    case "asked":
      return mindStepText(t, line, words.mindName);
    case "answered":
      return t("steps.answered", { model: words.modelOf(line.model) });
  }
}
