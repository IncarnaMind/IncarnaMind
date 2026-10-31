/**
 * The example Minds (onboarding): "Draft: credit committee paper", the
 * first-run default (#802), and one each for papers, reports, contracts and
 * meetings, which the default's banner offers, each in English and in Chinese
 * with Documents of its own. Each is a Mind written in advance that works
 * before any chat model is set up. Its Documents ship with the app
 * (`Paths.examples`), each with its source, licence and attribution in
 * LICENSE. Made, they are copied into the data folder and linked as a Linked
 * folder; the Mind holds a Question and an Answer whose Citations quote real
 * sentences of them (src/core/exampleSets.ts), and the credit paper a draft of
 * the User's own, one of whose sentences a check already found contradicted.
 * Its Citations are checked like any others, against the stored text, once
 * all its Documents have been read, and its draft's checks are written then,
 * with the Passages that decide them. They retain no Document version (#79):
 * the example's Documents change only when it follows the interface
 * language, which writes the Mind again.
 *
 * Which Mind and Linked folder are an example's is a device value, so no
 * table changes: the renderer marks them "Example", and `remove` deletes both.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as Y from "yjs";
import { withCitations } from "../shared/blockJson";
import { sentenceSpans } from "../shared/sentences";
import {
  contentHash,
  createElement,
  findBlock,
  type NodeJSON,
  syncContent,
  toMarkdown,
  topLevelBlocks,
} from "./answers/blocks";
import { markedSentences, markSentence } from "./answers/checks/sentences";
import { markdownToBlocks } from "./answers/markdown";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  type CitationRecheck,
  type CitationToRecheck,
  type ClaimCheckAttributes,
  type Document,
  type ExampleGroup,
  type Examples,
  type LinkedFolder,
  type MarkedCitation,
  type Mind,
  QUESTION_BLOCK,
} from "./api";
import { EXAMPLE_SETS, type ExampleCheck, type ExampleQuote, type ExampleSet } from "./exampleSets";
import type { Language } from "./language";

/** The device values naming each example, once made, are `examples.<group>`. */
const EXAMPLES_VALUE = "examples";
/**
 * The device value naming the example an earlier version made on a first run,
 * "Where tea comes from", before the credit paper replaced it (#802). Its files
 * no longer ship: it is only shown as the example, and removed, never remade.
 */
const LEGACY_VALUE = EXAMPLES_VALUE;
/** Set once the examples were offered on a first run, so they aren't made again unasked. */
const OFFERED_VALUE = "examplesOffered";
const ORDER_VALUE = "examplesOrder";
const DEFAULT_GROUP: ExampleGroup = "credit";
const OFFERED_GROUPS: readonly ExampleGroup[] = ["papers", "contracts", "meetings"];

const GROUPS = Object.keys(EXAMPLE_SETS) as ExampleGroup[];
const valueKey = (group: ExampleGroup) => `${EXAMPLES_VALUE}.${group}`;

interface StoredExamples {
  mindId: string;
  linkedFolderId: string;
  answerId: string;
  /** The copies of the files, in the data folder. */
  folder: string;
  /** The interface language they were made in. */
  language: Language;
  /** Once both Citations have been checked against the Documents' text. */
  checked: boolean;
}

export interface ExamplesOptions {
  /** The shipped examples folder; undefined when this copy ships none (most tests). */
  source: string | undefined;
  dataDir: string;
  language(): Language;
  readValue(key: string): unknown;
  writeValue(key: string, value: unknown): void;
  createMind(title: string): Mind;
  /** Renames a Mind. */
  renameMind(mindId: string, title: string): void;
  /** A Mind's title; "" for one that doesn't exist. */
  mindTitle(mindId: string): string;
  mindExists(mindId: string): boolean;
  deleteMind(mindId: string): void;
  /** Brings a Mind back from Recently deleted, as Undo does; throws when it can't. */
  restoreMind(mindId: string): void;
  editMind<T>(mindId: string, change: (blocks: Y.XmlFragment) => T): T;
  linkFolder(path: string): Promise<LinkedFolder>;
  unlinkFolder(linkedFolderId: string): void;
  /** Brings back an unlinked Linked folder with the Documents that left the index with it. */
  restoreFolder(linkedFolderId: string): void;
  linkedFolderExists(linkedFolderId: string): boolean;
  documentsIn(linkedFolderId: string): Document[];
  /** The Folder a Mind is in; null for none: where its checks searched. */
  mindFolder(mindId: string): string | null;
  /** Now, ISO 8601 UTC. */
  now(): string;
  /** Whether a check result in some Mind relies on one of these Documents (#819). */
  checksRelyOn(documentIds: readonly string[]): boolean;
  /**
   * Whether a Citation in a Mind other than `exceptMindId`, or in an Answer of a
   * Conversation, quotes one of these Documents.
   */
  citationsRelyOn(documentIds: readonly string[], exceptMindId: string): boolean;
  cite(input: Pick<CitationToRecheck, "documentId" | "quote">): CitationRecheck;
  /** Pushes "examples.changed". */
  changed(examples: Examples): void;
  random?(): number;
}

/** An example's draft, as the Blocks it is written into its Mind as. */
const draftBlocks = (set: ExampleSet): NodeJSON[] => (set.draft ? markdownToBlocks(set.draft) : []);

/**
 * What the default example's ready Answer can do now: be written with its checked Citations
 * (`ready`); wait, because a Document it cites is still being read (`reading`); never be written,
 * because a Document it cites couldn't be read (`unreadable`) or was deleted (`gone`); or there is
 * no example to answer from (`absent`).
 */
export type ExampleReadyState =
  | {
      kind: "ready";
      mindId: string;
      question: string;
      answer: string;
      citations: MarkedCitation[];
    }
  | { kind: "reading"; document: string }
  | { kind: "unreadable"; document: string }
  | { kind: "gone"; document: string }
  | { kind: "absent" };

/** Each of the draft's Blocks as Markdown, as the Mind holds it: to tell whether the User changed it. */
function draftMarkdown(set: ExampleSet): string[] {
  const scratch = new Y.Doc();
  const fragment = scratch.getXmlFragment("draft");
  fragment.insert(0, draftBlocks(set).map(createElement));
  return topLevelBlocks(fragment).map((block) => toMarkdown(block).trim());
}

/** A Document whose text is stored, so its Citations can be checked. */
const hasText = (document: Document) =>
  !["queued", "extracting", "failed"].includes(document.status);

export function createExamples(options: ExamplesOptions) {
  const stored = (group: ExampleGroup): StoredExamples | null => read(valueKey(group));

  /**
   * The examples removed since the app started, so Undo can bring back the same
   * Mind and Documents (#1292). The undo stack lives in the window, which goes
   * with this process, so nothing here is kept on disk. A Mind the User had
   * deleted, or a folder they had unlinked, before the removal stays as it was:
   * it wasn't the removal's.
   */
  const removed = new Map<
    ExampleGroup,
    { legacy: boolean; hadMind: boolean; hadFolder: boolean; stored: StoredExamples }
  >();

  const everyExample = (): StoredExamples[] =>
    [...GROUPS.map(stored), read(LEGACY_VALUE)].flatMap((each) => (each ? [each] : []));

  const documentIdsOf = (example: StoredExamples): string[] =>
    options.linkedFolderExists(example.linkedFolderId)
      ? options.documentsIn(example.linkedFolderId).map((document) => document.id)
      : [];

  /** The earlier version's tea example, while it is the one shown (no credit paper made yet). */
  const legacy = (): StoredExamples | null => (stored(DEFAULT_GROUP) ? null : read(LEGACY_VALUE));

  function read(key: string): StoredExamples | null {
    const value = options.readValue(key);
    if (!value || typeof value !== "object") return null;
    const examples = value as Partial<StoredExamples>;
    return typeof examples.mindId === "string" &&
      typeof examples.linkedFolderId === "string" &&
      typeof examples.answerId === "string" &&
      typeof examples.folder === "string"
      ? {
          ...(examples as StoredExamples),
          language: examples.language === "zh-CN" ? "zh-CN" : "en",
        }
      : null;
  }

  const isOffered = (value: unknown): value is ExampleGroup[] =>
    Array.isArray(value) &&
    value.length === OFFERED_GROUPS.length &&
    OFFERED_GROUPS.every((group) => value.includes(group));

  const order = (): ExampleGroup[] => {
    const kept = options.readValue(ORDER_VALUE);
    if (isOffered(kept)) return kept;
    const random = options.random ?? Math.random;
    const shuffled = [...OFFERED_GROUPS];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [
        shuffled[other] as ExampleGroup,
        shuffled[index] as ExampleGroup,
      ];
    }
    options.writeValue(ORDER_VALUE, shuffled);
    return shuffled;
  };

  /**
   * The example's own ready Question (#123), while the credit paper is the one shown; null
   * otherwise, as for the earlier version's tea example. The one the first open offers is
   * `readyQuestion`, which names the User's own Document instead as soon as theirs is ready.
   * `waitingFor` names the Document whose reading its Answer waits for, or null once it can be
   * written; a Document that can't be read at all takes the Question away, so no press is needed
   * to learn it (#2218).
   */
  const readyQuestion = (): { question: string; waitingFor: string | null } | null => {
    const examples = stored(DEFAULT_GROUP);
    const ready = examples && EXAMPLE_SETS[DEFAULT_GROUP][examples.language].ready;
    if (!examples || !ready || !options.mindExists(examples.mindId)) return null;
    if (!options.linkedFolderExists(examples.linkedFolderId)) return null;
    const documents = options.documentsIn(examples.linkedFolderId);
    let waitingFor: string | null = null;
    for (const quote of ready.quotes) {
      const document = documents.find((each) => each.name === quote.document);
      // Deleted, or never listed: nothing will answer from it, so the Question goes with it. Never
      // waited for, as a folder that never stops being scanned would leave it waiting for ever.
      if (!document) return null;
      // Its text is still being read: the Answer waits for it.
      if (document.status === "queued" || document.status === "extracting") {
        waitingFor ??= quote.document;
        continue;
      }
      if (!hasText(document) || document.status === "no-text") return null;
    }
    return { question: ready.question, waitingFor };
  };

  /**
   * Each part while it exists: the Mind can be deleted, or the folder unlinked,
   * on its own. The default is the earlier version's tea example while there is
   * one and no credit paper.
   */
  const status = (group: ExampleGroup = DEFAULT_GROUP): Examples => {
    const old = group === DEFAULT_GROUP ? legacy() : null;
    const examples = old ?? stored(group);
    const mind = examples && options.mindExists(examples.mindId) ? examples : null;
    const folder =
      examples && options.linkedFolderExists(examples.linkedFolderId) ? examples : null;
    return {
      group: old ? "tea" : group,
      available: options.source !== undefined,
      mindId: mind?.mindId ?? null,
      linkedFolderId: folder?.linkedFolderId ?? null,
      answerId: mind?.answerId ?? null,
      more: [
        ...(group === DEFAULT_GROUP ? [] : [DEFAULT_GROUP]),
        ...order().filter((each) => each !== group),
      ],
    };
  };

  /**
   * The ready Question with its Answer and Citations (`askExampleReadyQuestion`), checked
   * against the Documents now, once every Document it cites has been read; otherwise why not
   * (`readyQuestion` waits on this while the Documents are read).
   */
  const readyState = (): ExampleReadyState => {
    const examples = stored(DEFAULT_GROUP);
    const ready = examples && EXAMPLE_SETS[DEFAULT_GROUP][examples.language].ready;
    if (!examples || !ready || !options.mindExists(examples.mindId)) return { kind: "absent" };
    if (!options.linkedFolderExists(examples.linkedFolderId)) return { kind: "absent" };
    const documents = options.documentsIn(examples.linkedFolderId);
    const citations: MarkedCitation[] = [];
    for (const [index, quote] of ready.quotes.entries()) {
      const document = documents.find((each) => each.name === quote.document);
      if (!document) return { kind: "gone", document: quote.document };
      if (document.status === "queued" || document.status === "extracting") {
        return { kind: "reading", document: quote.document };
      }
      if (!hasText(document)) return { kind: "unreadable", document: quote.document };
      const result = options.cite({
        documentId: document.id,
        quote: quote.quote,
      });
      if (!result.passageId || !result.contentHash) {
        return { kind: "unreadable", document: quote.document };
      }
      citations.push({
        marker: index + 1,
        passageId: result.passageId,
        documentId: document.id,
        documentName: document.name,
        contentHash: result.contentHash,
        pageFrom: result.pageFrom,
        pageTo: result.pageTo,
        location: result.location,
        quote: quote.quote,
        check: result.check,
        checkReason: result.checkReason,
      });
    }
    return {
      kind: "ready",
      mindId: examples.mindId,
      question: ready.question,
      answer: ready.answer,
      citations,
    };
  };

  /** A Citation's attributes: what is known before it is checked, then the check's result. */
  const citationAttributes = (
    quote: ExampleQuote,
    document: Document | undefined,
    result: CitationRecheck | null,
  ): CitationAttributes => ({
    passageId: result?.passageId ?? null,
    documentId: document?.id ?? null,
    documentName: document?.name ?? quote.document,
    contentHash: result?.contentHash ?? null,
    pageFrom: result?.pageFrom ?? null,
    pageTo: result?.pageTo ?? null,
    location: result?.location ?? null,
    quote: quote.quote,
    check: result?.check ?? "checking",
    checkReason: result?.checkReason ?? null,
  });

  const citation = (
    quote: ExampleQuote,
    document: Document | undefined,
    result: CitationRecheck | null,
  ): NodeJSON => ({
    type: CITATION_NODE,
    attrs: Object.fromEntries(
      Object.entries(citationAttributes(quote, document, result)).filter(
        ([, value]) => value !== null,
      ),
    ),
  });

  /**
   * Marks a draft's sentence with its check, made in advance: the Passage
   * that decides it, found in the Document as any check's is. Nothing when
   * the sentence isn't in the Mind as the example wrote it.
   */
  const markCheck = (
    blocks: Y.XmlFragment,
    check: ExampleCheck,
    evidence: CitationAttributes,
    documents: readonly Document[],
    folderId: string | null,
  ): void => {
    const marked = markedSentences(blocks);
    for (const block of topLevelBlocks(blocks)) {
      if (block.nodeName !== "paragraph") continue;
      // A paragraph of the draft is one text, written without inline nodes.
      const text = block
        .toArray()
        .flatMap((child) =>
          child instanceof Y.XmlText
            ? (child.toDelta() as { insert: unknown }[]).map((run) =>
                typeof run.insert === "string" ? run.insert : "",
              )
            : [],
        )
        .join("");
      const span = sentenceSpans(text).find(
        (each) => text.slice(each.from, each.to) === check.sentence,
      );
      if (!span) continue;
      const earlier = marked.find(
        (mark) => mark.element === block && mark.from === span.from,
      )?.check;
      const attributes: ClaimCheckAttributes = {
        // Written again once its Documents are read, the check keeps the identity it had, so a
        // card the reader already opened stays open and shows what was found.
        id:
          earlier?.text === check.sentence && earlier.action === "check-against-documents"
            ? earlier.id
            : randomUUID(),
        request: randomUUID(),
        action: "check-against-documents",
        state: check.verdict,
        reason: null,
        detail: null,
        providerId: null,
        modelId: null,
        text: check.sentence,
        evidence,
        says: check.says,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: { folderId, widened: false },
        versions: documents.flatMap((each) =>
          each.contentHash ? [{ documentId: each.id, contentHash: each.contentHash }] : [],
        ),
        excluded: [],
        checkedAt: options.now(),
      };
      markSentence(block, span.from, span.to, attributes);
      return;
    }
  };

  const answerContent = (set: ExampleSet, citationFor: (index: number) => NodeJSON): NodeJSON[] =>
    withCitations(markdownToBlocks(set.answer), (marker) => citationFor(marker - 1));

  /**
   * Checks an example's Citations once all its Documents' text is stored, and
   * writes the results into the Answer, unless the User has edited it meanwhile.
   */
  const checkWhenRead = (group: ExampleGroup) => {
    const examples = stored(group);
    if (!examples || examples.checked) return;
    if (!options.linkedFolderExists(examples.linkedFolderId)) return;
    const set = EXAMPLE_SETS[group][examples.language];
    const documents = options.documentsIn(examples.linkedFolderId);
    const checks = set.checks ?? [];
    const named = (quote: ExampleQuote) => documents.find((each) => each.name === quote.document);
    const needed = [...set.quotes, ...checks.map((check) => check.evidence)].map(named);
    if (needed.some((document) => !document || !hasText(document))) return;
    const checked = (quote: ExampleQuote) => {
      const document = named(quote) as Document;
      return {
        document,
        result: options.cite({
          documentId: document.id,
          quote: quote.quote,
        }),
      };
    };
    const results = set.quotes.map(checked);
    const evidence = checks.map((check) => {
      const { document, result } = checked(check.evidence);
      return citationAttributes(check.evidence, document, result);
    });
    if (!options.mindExists(examples.mindId)) return;
    const folderId = options.mindFolder(examples.mindId);
    options.editMind(examples.mindId, (blocks) => {
      checks.forEach((check, index) => {
        const found = evidence[index];
        if (found) markCheck(blocks, check, found, documents, folderId);
      });
      const answer = findBlock(blocks, ANSWER_BLOCK, examples.answerId);
      if (!answer) return;
      // The User changed it: theirs now, and left as it is.
      if (answer.element.getAttribute("generatedHash") !== contentHash(answer.element)) return;
      syncContent(
        answer.element,
        answerContent(set, (index) => {
          const quote = set.quotes[index];
          const checked = results[index];
          return quote && checked
            ? citation(quote, checked.document, checked.result)
            : { type: "paragraph" };
        }),
      );
      answer.element.setAttribute("generatedHash", contentHash(answer.element));
    });
    options.writeValue(valueKey(group), { ...examples, checked: true });
  };

  /** Deletes the copies of an example's files, only those in the data folder. */
  const removeCopies = async (folder: string): Promise<void> => {
    const inside = relative(resolve(options.dataDir), resolve(folder));
    if (inside !== "" && !inside.startsWith("..") && !inside.includes(":")) {
      await rm(folder, { recursive: true, force: true });
    }
  };

  /** Unlinks an example's Documents and deletes the copies of their files. */
  const discardFiles = async (examples: StoredExamples): Promise<void> => {
    if (options.linkedFolderExists(examples.linkedFolderId)) {
      options.unlinkFolder(examples.linkedFolderId);
    }
    await removeCopies(examples.folder);
  };

  /**
   * Deletes an example Mind and unlinks its Documents, and the copies of their
   * files. The default is the earlier version's tea example while it is the one
   * shown; once it is gone, the credit paper is offered as on a first run.
   */
  const remove = async (group: ExampleGroup = DEFAULT_GROUP): Promise<void> => {
    const old = group === DEFAULT_GROUP ? legacy() : null;
    const examples = old ?? stored(group);
    if (!examples) return;
    removed.set(group, {
      legacy: old !== null,
      hadMind: options.mindExists(examples.mindId),
      hadFolder: options.linkedFolderExists(examples.linkedFolderId),
      stored: examples,
    });
    if (options.mindExists(examples.mindId)) options.deleteMind(examples.mindId);
    await discardFiles(examples);
    options.writeValue(old ? LEGACY_VALUE : valueKey(group), null);
    if (old) options.writeValue(OFFERED_VALUE, false);
    options.changed(status(group));
  };

  /**
   * Brings back an example the User removed, as Undo does: the same Mind, with
   * what the User wrote in it, and the same Documents, so its Citations still
   * open them. The tea example's files no longer ship, so only its Mind comes back.
   * What a failed step undid stays undone, so Undo is all or nothing.
   */
  const restore = async (group: ExampleGroup = DEFAULT_GROUP): Promise<Examples> => {
    const gone = removed.get(group);
    if (!gone) return status(group);
    // Made again since: the example that is there is the one.
    if (stored(group) || (group === DEFAULT_GROUP && legacy())) {
      removed.delete(group);
      return status(group);
    }
    const examples = gone.stored;
    if (gone.legacy) {
      if (gone.hadMind) options.restoreMind(examples.mindId);
      options.writeValue(LEGACY_VALUE, examples);
      options.writeValue(OFFERED_VALUE, true);
    } else {
      const source = options.source;
      if (!source) throw new Error("This copy of IncarnaMind has no examples.");
      if (gone.hadMind) options.restoreMind(examples.mindId);
      try {
        await copyFiles(source, EXAMPLE_SETS[group][examples.language]);
        // A folder the User had unlinked before stays unlinked: the removal didn't take it.
        if (gone.hadFolder) options.restoreFolder(examples.linkedFolderId);
        options.writeValue(valueKey(group), examples);
      } catch (error) {
        if (gone.hadMind) options.deleteMind(examples.mindId);
        // A folder that did come back keeps its files; one that didn't takes its copies with it.
        if (!options.linkedFolderExists(examples.linkedFolderId)) await discardFiles(examples);
        throw error;
      }
    }
    removed.delete(group);
    options.changed(status(group));
    checkWhenRead(group);
    return status(group);
  };

  /** Copies an example's Documents (with their licence) into the data folder. */
  const copyFiles = async (source: string, set: ExampleSet): Promise<string> => {
    // The files, copied into the data folder: the User's own files are never touched.
    // The licence goes with them, so the sources and attribution travel with the files.
    const folder = join(options.dataDir, set.folder);
    await mkdir(folder, { recursive: true });
    await cp(join(source, set.source), folder, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    await cp(join(source, "LICENSE"), join(folder, "LICENSE"), {
      force: false,
      errorOnExist: false,
    });
    return folder;
  };

  /** Copies an example's Documents (with their licence) into the data folder, and links them. */
  const copyAndLink = async (source: string, set: ExampleSet) => {
    const folder = await copyFiles(source, set);
    return { folder, linked: await options.linkFolder(folder) };
  };

  /** Writes an example's Note, draft, Question and Answer into its Mind, replacing what is there. */
  const populate = (
    mindId: string,
    set: ExampleSet,
    folderId: string,
    linkedFolderId: string,
    questionId: string,
    answerId: string,
  ) =>
    options.editMind(mindId, (blocks) => {
      blocks.delete(0, blocks.length);
      const answer = createElement({
        type: ANSWER_BLOCK,
        attrs: { [BLOCK_ID_ATTRIBUTE]: answerId, questionId, status: "done" },
        content: answerContent(set, (index) => {
          const quote = set.quotes[index];
          return quote ? citation(quote, undefined, null) : { type: "paragraph" };
        }),
      });
      blocks.insert(0, [
        // A page has no title field (#908): the example starts with its title, as a Mind the assistant makes.
        createElement({
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: set.title }],
        }),
        createElement({ type: "paragraph", content: [{ type: "text", text: set.intro }] }),
        ...draftBlocks(set).map(createElement),
        createElement({
          type: QUESTION_BLOCK,
          attrs: { [BLOCK_ID_ATTRIBUTE]: questionId, scopeFolderIds: [folderId] },
          content: [{ type: "text", text: set.question }],
        }),
        answer,
        createElement({ type: "paragraph" }),
      ]);
      // Unedited: regenerating it with a model of one's own replaces it in place.
      answer.setAttribute("generatedHash", contentHash(answer));
      // The draft's verdict is written in advance, so its mark is on the page from the first
      // frame: the Passage that decides it is added once the Documents are read (#2196). Its
      // scope is the Mind's own Folder, as the check made later has, so the mark reads as the
      // verdict it is rather than as one whose search scope changed.
      const documents = options.documentsIn(linkedFolderId);
      const scope = options.mindFolder(mindId);
      for (const check of set.checks ?? []) {
        const document = documents.find((each) => each.name === check.evidence.document);
        markCheck(
          blocks,
          check,
          citationAttributes(check.evidence, document, null),
          documents,
          scope,
        );
      }
    });

  const create = async (group: ExampleGroup = DEFAULT_GROUP): Promise<Examples> => {
    if (!GROUPS.includes(group)) throw new Error(`There is no example for "${group}".`);
    const current = status(group);
    if (current.mindId && current.linkedFolderId) return current;
    const source = options.source;
    if (!source) throw new Error("This copy of IncarnaMind has no examples.");
    // What is left of them (the Mind deleted, or the folder unlinked) goes first.
    if (stored(group) || (group === DEFAULT_GROUP && legacy())) await remove(group);
    const language = options.language();
    const set = EXAMPLE_SETS[group][language];

    const { folder, linked } = await copyAndLink(source, set);

    const mind = options.createMind(set.title);
    const questionId = randomUUID();
    const answerId = randomUUID();
    populate(mind.id, set, linked.folderId, linked.id, questionId, answerId);
    options.writeValue(valueKey(group), {
      mindId: mind.id,
      linkedFolderId: linked.id,
      answerId,
      folder,
      language,
      checked: false,
    } satisfies StoredExamples);
    const made = status(group);
    options.changed(made);
    checkWhenRead(group);
    return made;
  };

  /**
   * Whether the Mind is still as the example made it (#709): its title, its
   * heading of it, its Note, its draft, its Question and its Answer unchanged,
   * and nothing written after them. Its draft's checks may be there or not.
   */
  const untouched = (examples: StoredExamples, set: ExampleSet): boolean => {
    if (options.mindTitle(examples.mindId) !== set.title) return false;
    const draft = draftMarkdown(set);
    return options.editMind(examples.mindId, (blocks) => {
      const all = topLevelBlocks(blocks);
      // An example made before #908 has no heading of its title.
      const titled =
        all[0]?.nodeName === "heading" && toMarkdown(all[0]).trim() === `# ${set.title}`;
      const [note, ...afterNote] = titled ? all.slice(1) : all;
      const drafted = afterNote.slice(0, draft.length);
      const [question, answer, ...rest] = afterNote.slice(draft.length);
      if (!note || !question || !answer) return false;
      if (note.nodeName !== "paragraph" || toMarkdown(note).trim() !== set.intro) return false;
      if (drafted.some((block, index) => toMarkdown(block).trim() !== draft[index])) return false;
      if (question.nodeName !== QUESTION_BLOCK || toMarkdown(question).trim() !== set.question) {
        return false;
      }
      if (answer.nodeName !== ANSWER_BLOCK) return false;
      if (answer.getAttribute(BLOCK_ID_ATTRIBUTE) !== examples.answerId) return false;
      if (answer.getAttribute("generatedHash") !== contentHash(answer)) return false;
      return rest.every(
        (block) => block.nodeName === "paragraph" && toMarkdown(block).trim() === "",
      );
    });
  };

  /** Swaps an untouched example, in its Mind, for the same example in `language`. */
  const switchLanguage = async (
    group: ExampleGroup,
    examples: StoredExamples,
    source: string,
    language: Language,
  ): Promise<void> => {
    const set = EXAMPLE_SETS[group][language];
    const sameFolder = resolve(examples.folder) === resolve(join(options.dataDir, set.folder));
    // A folder of the same name would mix the two languages' files: the old ones go first.
    if (sameFolder) await discardFiles(examples);
    const { folder, linked } = await copyAndLink(source, set);
    // Written in or deleted while the files were copied: it stays as the User left it (#2302).
    if (
      !options.mindExists(examples.mindId) ||
      !untouched(examples, EXAMPLE_SETS[group][examples.language])
    ) {
      // A Linked folder of the User's that holds the copy is theirs: only one made for it goes.
      if (resolve(linked.path) === resolve(folder)) options.unlinkFolder(linked.id);
      await removeCopies(folder);
      return;
    }
    const questionId = randomUUID();
    const answerId = randomUUID();
    // The old Documents go before the example names the new folder, so nothing reads them as the
    // User's own in between (#2084); nothing waits between the link and "changed" (#914).
    if (!sameFolder) options.unlinkFolder(examples.linkedFolderId);
    populate(examples.mindId, set, linked.folderId, linked.id, questionId, answerId);
    options.renameMind(examples.mindId, set.title);
    options.writeValue(valueKey(group), {
      mindId: examples.mindId,
      linkedFolderId: linked.id,
      answerId,
      folder,
      language,
      checked: false,
    } satisfies StoredExamples);
    options.changed(status(group));
    // Only the copies it made are left to remove: the folder is unlinked already.
    if (!sameFolder) await discardFiles(examples);
    checkWhenRead(group);
  };

  // Made, removed, brought back and switched to another language one at a time: each copies
  // files, and one run in that wait would act on an example the other is halfway through (#2302).
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn =
    <A extends unknown[], T>(work: (...args: A) => Promise<T>) =>
    (...args: A): Promise<T> => {
      const run = queue.then(
        () => work(...args),
        () => work(...args),
      );
      queue = run.catch(() => undefined);
      return run;
    };

  return {
    status,

    /**
     * Every example still there: its Mind and its Documents, which an Answer
     * asked from another Mind leaves out of "these documents".
     */
    made(): { mindIds: string[]; documentIds: string[] } {
      const all = everyExample();
      return {
        mindIds: all.map((each) => each.mindId).filter((id) => options.mindExists(id)),
        documentIds: all.flatMap(documentIdsOf),
      };
    },

    /** An example Mind's own Documents, by id; null for a Mind that isn't an example's. */
    documentsOf(mindId: string): string[] | null {
      const example = everyExample().find((each) => each.mindId === mindId);
      return example ? documentIdsOf(example) : null;
    },

    create: inTurn(create),

    readyQuestion,

    readyState,

    /**
     * The interface language changed (#709): each example the User hasn't
     * touched becomes the same example in the new language, in its Mind, with
     * its Documents swapped. One they changed stays as it is, and so does one
     * whose Documents a check result (#819) or a Citation elsewhere relies on.
     */
    followLanguage: inTurn(async (): Promise<void> => {
      const source = options.source;
      if (source === undefined) return;
      const language = options.language();
      for (const group of GROUPS) {
        const examples = stored(group);
        if (!examples || examples.language === language) continue;
        if (!options.mindExists(examples.mindId)) continue;
        if (!untouched(examples, EXAMPLE_SETS[group][examples.language])) continue;
        const documentIds = options.documentsIn(examples.linkedFolderId).map((each) => each.id);
        // Swapping its Documents would leave the checks that relied on them needing a check
        // again, and a Citation copied out of it without its original page, for no change the
        // User made: it stays as it is. Its own Answer's Citations don't count: the swap
        // writes them again.
        if (
          options.checksRelyOn(documentIds) ||
          options.citationsRelyOn(documentIds, examples.mindId)
        ) {
          continue;
        }
        await switchLanguage(group, examples, source, language);
      }
    }),

    /**
     * On a first run (no Mind yet, examples never offered): makes the credit
     * paper, once. Returns it, or null when nothing was made.
     */
    offer: inTurn(async (hasMinds: boolean): Promise<Examples | null> => {
      if (options.source === undefined || options.readValue(OFFERED_VALUE) === true) return null;
      options.writeValue(OFFERED_VALUE, true);
      if (hasMinds) return null;
      return create(DEFAULT_GROUP);
    }),

    remove: inTurn(remove),

    restore: inTurn(restore),

    /** A Document's status changed: the examples' Citations may now be checkable. */
    documentChanged() {
      for (const group of GROUPS) checkWhenRead(group);
    },
  };
}
