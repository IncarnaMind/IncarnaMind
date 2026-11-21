/**
 * A Note judged by the outside agent that wrote it, on that agent's own model (#3342). IncarnaMind
 * hands over the sentences that hold no result yet, and marks the Note with what the agent hands
 * back. Nothing goes to a model from here. A verdict that a quote decides stands only on a Citation
 * IncarnaMind found in its Document, among the Documents the Note's own Check searches; one worked
 * out stands only on a calculation or a run IncarnaMind made for that agent in this check (#3363).
 */
import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { partWithResult, resultFromParts } from "../../../shared/claimParts";
import { emptyFigureFinding } from "../../../shared/figureChecks";
import { readMindCheck, sentenceKey, writeMindCheck } from "../../../shared/mindCheck";
import { mindScopeIn } from "../../../shared/mindScope";
import { targetHash } from "../../../shared/proposals";
import { type Verification, verificationOf } from "../../../shared/verification";
import {
  CHART_NODE,
  type CheckedVersion,
  type CheckWorking,
  type Citation,
  type ClaimCheckAttributes,
  type ClaimCheckFailure,
  type ClaimCheckResult,
  type UnsupportedReason,
} from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { MindContent } from "../../mindContent";
import {
  cellHeadings,
  type FigureOccurrence,
  inValueCell,
  type TableLayout,
} from "./figureOccurrences";
import {
  checkText,
  everySentence,
  markedSentences,
  markSentence,
  type SelectedSentence,
} from "./sentences";
import { fileCheckLines, judgedWithOf, type Reader, readingOf } from "./standing";
import type { MindCheckScope } from "./verify";

export type JudgedVerdict =
  | "supported"
  | "contradicted"
  | NonNullable<UnsupportedReason["word"]>
  /** The sentence says nothing a Document could state: it gets no mark. */
  | "nothing-to-check";

/** What a calculation or a run IncarnaMind made for an agent gives a verdict that rests on it. */
export interface WorkedBacking {
  /** What its card cites: a calculation's inputs, a run's rows or the Library's lists. */
  evidence: readonly Citation[];
  /** A run's code and what it read. */
  working?: CheckWorking;
  /** Its one line of working: the formula with its numbers, or the figures the code gave. */
  workedOut: string;
  versions: readonly CheckedVersion[];
  /** The Documents it read: each must be one the Note's Check searches. */
  documentIds: readonly string[];
}

export type Worked =
  | { ok: true; backing: WorkedBacking }
  /** It ran, and gave no result a verdict can rest on. */
  | { ok: false; reason: ClaimCheckFailure; detail: string | null };

export interface JudgedSentence {
  /** The sentence's number in the task. */
  n: number;
  verdict: JudgedVerdict;
  /** The Citations the agent rests it on, each found in its Document now. */
  evidence: readonly Citation[];
  /**
   * The calculation or run it names, made for this agent in this check; null for one IncarnaMind
   * can't confirm as that, which marks nothing.
   */
  worked?: Worked | null;
  explanation: string | null;
}

export interface CheckTask {
  /**
   * Names the Note's sentences as numbered here, for every report on them: results after any of
   * their words changed are refused.
   */
  task: string;
  sentences: { n: number; text: string; row?: string; column?: string }[];
}

export type NotJudgedReason =
  /** The Note is checked against Documents the agent may not read. */
  | "beyond-reach"
  | "no-documents"
  /** The words of a sentence the task gave are not in the Note any more. */
  | "changed";

export type Judged<T> = { ok: true; value: T } | { ok: false; reason: NotJudgedReason };

export interface LandedCheck {
  marked: number;
  /** Supported or contradicted on no Citation IncarnaMind could confirm: marked Not checked. */
  unconfirmed: number[];
  unreported: number[];
}

/**
 * The Documents a Check of `scope` searches, when an outside agent may read every one of them;
 * null when it may not. A scope of every Document, a Note's in no Folder (#3364), is every one
 * there is now. Only what the Check searches counts: a file an agent handed over, which is no
 * source, is in a Folder's scope but never read (#3492).
 */
export function readsWithin(
  scope: EvidenceScope,
  reach: ReadonlySet<string>,
  searched: Searched,
): string[] | null {
  const read = [...searched(scope.documentIds)];
  return read.every((id) => reach.has(id)) ? read : null;
}

/** The Documents a check of these (null: of all) searches: the sources among them with Passages. */
export type Searched = (documentIds: readonly string[] | null) => readonly string[];

export interface JudgedOutsideOptions {
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  scopeOf(mindId: string, allDocuments: boolean): MindCheckScope;
  /** Each live Document's version now. */
  documentVersions(): ReadonlyMap<string, string>;
  searched: Searched;
  /** Whether the Document is a file an agent cited by its path: evidence for what cites it (#3509). */
  citedOutside(documentId: string): boolean;
  /** Throws unless the Mind exists and this version may write to it. */
  requireMind(mindId: string): void;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText?: string,
  ): ClaimCheckAttributes;
  retainEvidence(mindId: string): void;
  now(): Date;
}

const SETTLED: ReadonlySet<ClaimCheckAttributes["state"]> = new Set([
  "supported",
  "unsupported",
  "contradicted",
]);

/** The tasks given most lately, each with its sentences as given: enough for any check under way. */
const TASKS_KEPT = 200;

interface GivenSentence {
  blockId: string;
  occurrence: number;
  text: string;
  said: string;
}

/** A line a check of the Note judges, with the claim it is judged as. */
interface Line extends SelectedSentence {
  said: string;
  /** Its key in the Note's list of lines a check found nothing to check in. */
  key: string;
  /** Checked whatever a check calls it. */
  always: boolean;
}

/**
 * The lines a check of the Note judges: a file's as its check reads them (`fileCheckLines`), each
 * table row whole with its headings; a Note's own every sentence, as the Note counts them.
 */
function linesOf(blocks: Y.XmlFragment): { verification: Verification | null; lines: Line[] } {
  const verification = blocks.doc ? verificationOf(blocks.doc) : null;
  if (verification) {
    const { claims } = verification;
    const lines = fileCheckLines(blocks, verification)
      // Once the check has sorted the file, a line it found no claim in is no check's.
      .filter(
        (line) =>
          claims === null ||
          claims.some(
            (claim) =>
              claim.blockId === line.blockId &&
              claim.text === line.text &&
              (claim.occurrence ?? 0) === line.occurrence,
          ),
      )
      .map((line) => ({ ...line, key: sentenceKey(line.said), always: false }));
    return { verification, lines };
  }
  const lines = everySentence(blocks).map((sentence) => ({
    ...sentence,
    said: checkText(sentence).claim,
    key: sentenceKey(sentence.text),
    // A value cell's figure is checked whatever a check calls it, as the Note counts it (#2447).
    always: inValueCell(sentence.figures),
  }));
  return { verification: null, lines };
}

export function createJudgedOutside(options: JudgedOutsideOptions) {
  const { content } = options;

  /**
   * The sentences with no result that stands for the agent now, in the Note's order: those the
   * Note counts as not checked yet, as the Note's own Check reads them, and those whose result no
   * longer stands for `reader` (`readingOf`).
   */
  const pending = (
    blocks: Y.XmlFragment,
    lines: readonly Line[],
    skipped: ReadonlySet<string>,
    reader: Reader,
  ): Line[] => {
    const marks = markedSentences(blocks);
    const reading = readingOf(blocks, reader);
    return lines.filter(
      (sentence) =>
        !(skipped.has(sentence.key) && !sentence.always) &&
        !marks.some(
          ({ element, from, to, check }) =>
            element === sentence.element &&
            from < sentence.to &&
            to > sentence.from &&
            check.text === sentence.text &&
            SETTLED.has(check.state) &&
            reading.ofSentence(sentence, check).state !== "needs-recheck",
        ),
    );
  };

  const nameOf = (sentences: readonly Line[]) =>
    targetHash(
      sentences.map((each) => `${each.blockId}\u0000${each.text}\u0000${each.said}`).join("\u0001"),
    );

  // A report lands on the sentences its task gave, not on those still without a result: the
  // agent's own earlier report on the task changes which those are, never the task (#3432).
  const given = new Map<string, { mindId: string; sentences: readonly GivenSentence[] }>();
  const keep = (task: string, mindId: string, sentences: readonly Line[]) => {
    given.delete(task);
    given.set(task, {
      mindId,
      sentences: sentences.map(({ blockId, occurrence, text, said }) => ({
        blockId,
        occurrence,
        text,
        said,
      })),
    });
    for (const oldest of given.keys()) {
      if (given.size <= TASKS_KEPT) break;
      given.delete(oldest);
    }
  };

  /** The task's sentences as the Note holds them now; null when any one's words are gone. */
  const sentencesOf = (
    task: string,
    mindId: string,
    lines: readonly Line[],
    open: readonly Line[],
  ): readonly Line[] | null => {
    const kept = given.get(task);
    // A task from before the app last started: its sentences are those still without a result.
    if (kept?.mindId !== mindId) return nameOf(open) === task ? open : null;
    const found: Line[] = [];
    for (const each of kept.sentences) {
      const sentence = lines.find(
        (candidate) =>
          candidate.blockId === each.blockId &&
          candidate.occurrence === each.occurrence &&
          candidate.text === each.text &&
          candidate.said === each.said,
      );
      if (!sentence) return null;
      found.push(sentence);
    }
    return found;
  };

  /** The Documents the Note's Check searches, when all of them are in `reach`. */
  const scopeWithin = (mindId: string, reach: ReadonlySet<string>) => {
    const { empty, check, folderId } = options.scopeOf(mindId, false);
    if (empty || check.marked.widened)
      return { ok: false as const, reason: "no-documents" as const };
    // A scope the User chose is the User's to check: an agent would learn from it what it may not read.
    const read = check.marked.chosen ? null : readsWithin(check.scope, reach, options.searched);
    if (read === null) return { ok: false as const, reason: "beyond-reach" as const };
    const reader: Reader = {
      versions: options.documentVersions(),
      folderId,
      scope: content.readSettings(mindId, mindScopeIn),
      reach,
    };
    return { ok: true as const, check, documentIds: new Set(read), reader };
  };

  const skippedOf = (mindId: string) =>
    new Set(content.readSettings(mindId, readMindCheck)?.skipped ?? []);

  return {
    task(mindId: string, reach: ReadonlySet<string>): Judged<CheckTask> {
      options.requireMind(mindId);
      const scope = scopeWithin(mindId, reach);
      if (!scope.ok) return scope;
      const skipped = skippedOf(mindId);
      return content.read(mindId, (blocks) => {
        const { verification, lines } = linesOf(blocks);
        const sentences = pending(blocks, lines, skipped, scope.reader);
        const grids = new Map<Y.XmlElement, TableLayout>();
        const task = nameOf(sentences);
        keep(task, mindId, sentences);
        return {
          ok: true,
          value: {
            task,
            sentences: sentences.map((sentence, index) => ({
              n: index + 1,
              text: sentence.said,
              // A file's row is given whole with its headings.
              ...(verification === null && cellHeadings(sentence.element, grids)),
            })),
          },
        };
      });
    },

    /** Marks the task's sentences with `judged`, the agent `agent` named as the model that judged. */
    land(
      mindId: string,
      reach: ReadonlySet<string>,
      agent: string,
      task: string,
      judged: readonly JudgedSentence[],
    ): Judged<LandedCheck> {
      options.requireMind(mindId);
      const scope = scopeWithin(mindId, reach);
      if (!scope.ok) return scope;
      const skipped = skippedOf(mindId);
      const at = options.now().toISOString();
      const request = randomUUID();
      const landed = content.edit(mindId, (blocks): Judged<LandedCheck> => {
        const { verification, lines } = linesOf(blocks);
        const open = pending(blocks, lines, skipped, scope.reader);
        const sentences = sentencesOf(task, mindId, lines, open);
        if (!sentences) return { ok: false, reason: "changed" };
        const stillOpen = (sentence: Line) =>
          open.some((each) => each.element === sentence.element && each.from === sentence.from);
        const unconfirmed: number[] = [];
        const reported = new Set<number>();
        let marked = 0;
        for (const each of judged) {
          const sentence = sentences[each.n - 1];
          if (!sentence || reported.has(each.n)) continue;
          reported.add(each.n);
          const { worked } = each;
          if (
            worked === null ||
            (worked?.ok && !worked.backing.documentIds.every((id) => scope.documentIds.has(id)))
          ) {
            unconfirmed.push(each.n);
            continue;
          }
          if (each.verdict === "nothing-to-check") {
            if (sentence.always) unconfirmed.push(each.n);
            else skipped.add(sentence.key);
            continue;
          }
          // A file cited by path is evidence for the sentence that cites it alone (#3509).
          const citesItself = new Set(sentence.cited.map((quote) => quote.documentId));
          const evidence = each.evidence.filter(
            (citation) =>
              scope.documentIds.has(citation.documentId) ||
              (citesItself.has(citation.documentId) && options.citedOutside(citation.documentId)),
          );
          const judgedResult = worked
            ? workedResult(each, worked, evidence, sentence.said.length)
            : resultOf(each, evidence);
          const result =
            sentence.element.nodeName === CHART_NODE
              ? onEachValue(judgedResult, sentence.figures ?? [])
              : judgedResult;
          if (result.verdict === "not-checked") unconfirmed.push(each.n);
          const mark: ClaimCheckAttributes = {
            id: randomUUID(),
            request,
            action: "check-against-documents",
            state: "checking",
            reason: null,
            detail: null,
            providerId: null,
            modelId: agent,
            text: sentence.text,
            evidence: null,
            says: null,
            unsupported: null,
            calculation: null,
            citedCaseUnchecked: false,
            citedCaseFound: false,
            scope: scope.check.marked,
            versions: [],
            excluded: [],
            checkedAt: at,
            // As a file's check records it: a row's verdict stands only while the row reads the same.
            ...(verification && { judgedWith: judgedWithOf(sentence, verification) }),
          };
          markSentence(
            sentence.element,
            sentence.from,
            sentence.to,
            options.withResult(mark, result, at, blocks, mindId, sentence.said),
          );
          marked++;
        }
        return {
          ok: true,
          value: {
            marked,
            unconfirmed,
            unreported: sentences.flatMap((sentence, index) =>
              reported.has(index + 1) || !stillOpen(sentence) ? [] : [index + 1],
            ),
          },
        };
      });
      if (!landed.ok) return landed;
      options.retainEvidence(mindId);
      const { keys, sentences } = content.read(mindId, (blocks) => ({
        keys: new Set([
          ...everySentence(blocks).map((each) => sentenceKey(each.text)),
          ...linesOf(blocks).lines.map((each) => each.key),
        ]),
        sentences: markedSentences(blocks).length,
      }));
      content.editSettings(mindId, (settings) =>
        writeMindCheck(settings, {
          at,
          sentences,
          stop: null,
          skipped: [...skipped].filter((key) => keys.has(key)),
          unexamined: (readMindCheck(settings)?.unexamined ?? []).filter((key) => keys.has(key)),
        }),
      );
      return landed;
    },
  };
}

/**
 * The result of a verdict that names a calculation or a run, shown as the check's own worked-out
 * marks are: Supported or Contradicted on what it read, with its line of working; Not checked
 * where it gave no result. Any other verdict doesn't rest on it, and keeps it only as its working.
 */
function workedResult(
  judged: JudgedSentence,
  worked: Worked,
  cited: readonly Citation[],
  length: number,
): ClaimCheckResult {
  const { verdict } = judged;
  if (verdict !== "supported" && verdict !== "contradicted") {
    const result = resultOf(judged, cited);
    return worked.ok && result.verdict !== "not-checked"
      ? {
          ...result,
          versions: [...result.versions, ...worked.backing.versions],
          ...(worked.backing.working && { working: worked.backing.working }),
        }
      : result;
  }
  const unchecked = (reason: ClaimCheckFailure, detail: string | null): ClaimCheckResult => ({
    verdict: "not-checked",
    reason,
    detail,
    versions: [],
    excluded: [],
  });
  if (!worked.ok) return unchecked(worked.reason, worked.detail);
  const { evidence, working, workedOut, versions } = worked.backing;
  const [first, ...more] = evidence;
  if (!first) return unchecked("no-evidence", null);
  const result: ClaimCheckResult = {
    verdict,
    evidence: first,
    says: judged.explanation,
    unsupported: null,
    calculation: null,
    ...(working && { working }),
    workedOut,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [...versions],
    excluded: [],
  };
  // Each input of a calculation is shown on its card, as the check's own quotes are.
  return more.length === 0
    ? result
    : resultFromParts([
        partWithResult({ kind: "fact", span: { start: 0, end: length } }, result, more),
      ]);
}

/** The result a sentence's mark holds: the agent's verdict, on the Citations IncarnaMind found. */
/**
 * A chart's result as the Note's own Check marks a chart, on each of its values, which is how the
 * Note shows one checked (#3465): the agent's verdict on the chart is its verdict on each value.
 */
function onEachValue(
  result: ClaimCheckResult,
  values: readonly FigureOccurrence[],
): ClaimCheckResult {
  if (result.verdict === "not-checked" || values.length === 0) return result;
  const { figures: _figures, remainder: _remainder, currencyClause: _clause, ...judgment } = result;
  return {
    ...result,
    figures: values.map((value) => ({ ...emptyFigureFinding(value), result: judgment })),
    remainder: null,
  };
}

function resultOf(
  { verdict, explanation }: JudgedSentence,
  evidence: readonly Citation[],
): ClaimCheckResult {
  const [quoted] = evidence;
  const read = {
    versions: evidence.map(({ documentId, contentHash }) => ({ documentId, contentHash })),
    excluded: [],
  };
  const judgment = {
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    ...read,
  };
  if (verdict === "supported" || verdict === "contradicted") {
    // The one thing IncarnaMind confirms: the verdict's quote is in its Document.
    if (!quoted) return { verdict: "not-checked", reason: "no-evidence", detail: null, ...read };
    return { verdict, evidence: quoted, says: explanation, unsupported: null, ...judgment };
  }
  return {
    verdict: "unsupported",
    evidence: null,
    says: null,
    unsupported: {
      word: verdict === "nothing-to-check" ? "not-found" : verdict,
      reason: explanation,
      covered: null,
      uncovered: null,
      ...(quoted && { found: true as const, quoted }),
    },
    ...judgment,
  };
}
