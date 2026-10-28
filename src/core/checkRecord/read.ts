/**
 * What a Mind's checks left on it, read for the check record (#738): each
 * checked sentence and each Citation with its result, the Document version it
 * rests on, who checked it and when, and whose text it is. What the Mind's own
 * marks and Citations and the Documents as they are now don't hold is left
 * empty, never guessed.
 */
import * as Y from "yjs";
import {
  citationAttributesOf,
  citationState,
  citedLocation,
  liveDocumentOf,
  shownDocumentName,
} from "../../shared/citations";
import { claimCheckShown, type SentenceResult, sentenceResultOf } from "../../shared/claimChecks";
import type { Translate } from "../../shared/locations";
import { mindScopeOf } from "../../shared/mindScope";
import { comparableSentence, INLINE_NODE, sentenceSpans } from "../../shared/sentences";
import {
  citationSignOffBasis,
  signOffNow,
  signOffOn,
  signOffShown,
  signOffsOf,
} from "../../shared/signOffs";
import { textOriginOf } from "../../shared/textOrigins";
import { groupsOf, isProposed } from "../aiUseStatement/figures";
import { checkedSentences, citationSentences, figuresNow } from "../answers/checks/sentences";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  type CitationAttributes,
  type CitationCheck,
  type ClaimCheckScope,
  type Document,
  GENERATED_MARK,
  type KeptCitationText,
  QUESTION_BLOCK,
  type SignOffNow,
} from "../api";
import type { ModelDescription } from "../chatModelNames";
import { type Footnote, type Inline, readBlock, reviewReading } from "../mindText";
import { layout } from "../proposals/write";

export type TextOrigin = "user" | "ai" | "other";

export interface RecordDocument {
  name: string;
  /** The file's name where it is kept, or a web page's address; null once the Document is gone. */
  file: string | null;
  deleted: boolean;
  /** In bytes, when this version is the file as it is now. */
  size: number | null;
  /** The SHA-256 of the file's bytes, in hex. */
  sha256: string | null;
  location: string | null;
  quote: string | null;
}

interface RecordItemFields {
  text: string;
  origin: TextOrigin;
  says: string | null;
  /** Null when no Document backs it: an unsupported sentence. */
  evidence: RecordDocument | null;
}

export interface SentenceCheck {
  model: ModelDescription | null;
  at: string | null;
  scope: ClaimCheckScope;
}

export type SentenceItem = RecordItemFields & {
  kind: "sentence";
  result: SentenceResult;
  /** Null when no check ran: the model refused or couldn't be reached. */
  check: SentenceCheck | null;
};

/**
 * IncarnaMind checks a Citation's quote against the Document's text without a model, and keeps no
 * time. `signOff` is a person's own check of it (#1933), which isn't IncarnaMind's.
 */
export type CitationItem = RecordItemFields & {
  kind: "citation";
  result: CitationCheck;
  signOff: SignOffNow | null;
};

export type RecordItem = SentenceItem | CitationItem;

export interface RecordSources {
  fragment: Y.XmlFragment;
  documents: readonly Document[];
  kept: readonly KeptCitationText[];
  folderId: string | null;
  t: Translate;
  model(providerId: string | null, modelId: string | null): ModelDescription | null;
  readQuote(attributes: Partial<CitationAttributes>): string | null;
  /** The User, whose own check marks are theirs (#1933); null before they make one. */
  personId: string | null;
}

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

const fileNameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

function documentOf(
  attributes: Partial<CitationAttributes>,
  { documents, t, readQuote }: Pick<RecordSources, "documents" | "t" | "readQuote">,
): RecordDocument {
  const found = liveDocumentOf(attributes, documents);
  const live = found && documents.find((each) => each.id === found.id);
  const sha256 = attributes.contentHash ? attributes.contentHash : null;
  return {
    name: shownDocumentName(attributes, documents) || t("export.unnamedDocument"),
    file: live ? (live.web?.address ?? fileNameOf(live.path)) : null,
    deleted: found === undefined,
    size: live && sha256 !== null && live.contentHash === sha256 ? live.size : null,
    sha256,
    location: citedLocation(attributes, t),
    quote: readQuote(attributes),
  };
}

function topOf(fragment: Y.XmlFragment, element: Y.XmlElement): Y.XmlElement {
  let top = element;
  while (top.parent instanceof Y.XmlElement) top = top.parent;
  return top.parent === fragment ? top : element;
}

const idOf = (element: Y.XmlElement): string | null => {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof id === "string" && id !== "" ? id : null;
};

function blockOrigin(fragment: Y.XmlFragment, top: Y.XmlElement): TextOrigin | null {
  const id = idOf(top);
  if (fragment.doc && id !== null && textOriginOf(fragment.doc, id) !== null) return "other";
  return top.nodeName === ANSWER_BLOCK ? "ai" : null;
}

function holdsAiText(element: Y.XmlElement, from: number, to: number): boolean {
  for (const { node, start } of layout(element)) {
    if (!(node instanceof Y.XmlText)) continue;
    let offset = start;
    const runs: Run[] = node.toDelta();
    for (const run of runs) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      if (run.attributes?.[GENERATED_MARK] && offset < to && offset + length > from) return true;
      offset += length;
    }
  }
  return false;
}

export function readRecord(sources: RecordSources): {
  sentences: SentenceItem[];
  citations: CitationItem[];
  /** The requests the sentences were checked with: what each check's unread files are kept by. */
  requests: string[];
} {
  const { fragment, documents, folderId, model } = sources;
  const scope = fragment.doc ? mindScopeOf(fragment.doc) : null;
  const versions = new Map(documents.map((document) => [document.id, document.contentHash]));
  const { figureContexts, figured } = figuresNow(fragment);

  const sentences: SentenceItem[] = [];
  const requests: string[] = [];
  for (const { element, from, to, check, sentence, cited } of checkedSentences(fragment)) {
    requests.push(check.request);
    const result = sentenceResultOf(
      claimCheckShown(check, {
        text: sentence,
        versions,
        folderId,
        scope,
        figureContexts,
        figured: figured({ element, from, to }),
      }),
      check,
      cited.length,
    );
    if (!result) continue;
    sentences.push({
      kind: "sentence",
      text: comparableSentence(sentence),
      result,
      origin:
        blockOrigin(fragment, topOf(fragment, element)) ??
        (holdsAiText(element, from, to) ? "ai" : "user"),
      says: check.says,
      evidence: check.evidence ? documentOf(check.evidence, sources) : null,
      check:
        result === "notChecked"
          ? null
          : {
              model: model(check.providerId, check.modelId),
              at: check.checkedAt === "" ? null : check.checkedAt,
              scope: check.scope,
            },
    });
  }

  const attributesOf = new Map<Footnote, Partial<CitationAttributes>>();
  const idOf = new Map<Footnote, string>();
  const readOptions = {
    includeQuestions: false,
    footnote: (attributes: Record<string, unknown>): Footnote => {
      const note: Footnote = { source: "", unverified: false };
      attributesOf.set(note, citationAttributesOf(attributes));
      const id = attributes[BLOCK_ID_ATTRIBUTE];
      if (typeof id === "string") idOf.set(note, id);
      return note;
    },
    trimBeforeCitation: false,
    review: reviewReading(fragment),
  };
  const marks = fragment.doc ? signOffsOf(fragment.doc) : [];
  const signedOff = marks.length > 0 ? citationSentences(fragment) : new Map<string, string>();
  const signOffOf = (note: Footnote): SignOffNow | null => {
    const id = idOf.get(note);
    const attributes = attributesOf.get(note);
    const sentence = id === undefined ? undefined : signedOff.get(id);
    const mark =
      id === undefined ? null : signOffOn(marks, { kind: "citation", id }, sources.personId);
    if (!mark || !attributes || sentence === undefined) return null;
    const cited = {
      documentId: attributes.documentId ?? null,
      contentHash: attributes.contentHash ?? null,
      quote: attributes.quote ?? null,
    };
    return signOffNow(
      signOffShown(mark, citationSignOffBasis(sentence, cited), [cited], versions),
      sources.personId,
    );
  };
  const citations: CitationItem[] = [];
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement) || child.nodeName === QUESTION_BLOCK) continue;
    if (isProposed(child)) continue;
    const origin = blockOrigin(fragment, child);
    for (const group of groupsOf(readBlock(child, readOptions))) {
      citations.push(...citationsIn(group, { attributesOf, origin, sources, signOffOf }));
    }
  }
  return { sentences, citations, requests };
}

function citationsIn(
  group: readonly Inline[],
  context: {
    attributesOf: ReadonlyMap<Footnote, Partial<CitationAttributes>>;
    origin: TextOrigin | null;
    sources: RecordSources;
    signOffOf(note: Footnote): SignOffNow | null;
  },
): CitationItem[] {
  const { attributesOf, origin, sources, signOffOf } = context;
  let plain = "";
  const aiAt: boolean[] = [];
  const placed: {
    offset: number;
    attributes: Partial<CitationAttributes>;
    signOff: SignOffNow | null;
  }[] = [];
  const add = (text: string, ai: boolean) => {
    for (const character of text) {
      plain += character;
      aiAt.push(ai);
    }
  };
  for (const inline of group) {
    if (inline.inserted) continue;
    if (inline.kind === "text") {
      add(inline.text, inline.ai === true);
    } else if (inline.kind === "figure") {
      add(inline.figure.shown, false);
    } else if (inline.kind === "citation") {
      const attributes = attributesOf.get(inline.footnote);
      if (attributes)
        placed.push({ offset: aiAt.length, attributes, signOff: signOffOf(inline.footnote) });
      add(INLINE_NODE, false);
    } else if (inline.kind === "break") {
      add("\n", false);
    }
  }
  const spans = sentenceSpans(plain);
  return placed.map(({ offset, attributes, signOff }): CitationItem => {
    const span = spans.find((each) => each.from <= offset && offset < each.to) ??
      spans.filter((each) => each.from <= offset).at(-1) ?? { from: 0, to: aiAt.length };
    return {
      kind: "citation",
      text: comparableSentence(plain.slice(span.from, span.to)),
      result: citationState(attributes, sources.documents, sources.kept).check,
      origin: origin ?? (aiAt.slice(span.from, span.to).some(Boolean) ? "ai" : "user"),
      says: attributes.verdict ?? null,
      evidence: documentOf(attributes, sources),
      signOff,
    };
  });
}
