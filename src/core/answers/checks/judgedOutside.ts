/**
 * A Note judged by the outside agent that wrote it, on that agent's own model (#3342). IncarnaMind
 * hands over the sentences that hold no result yet, and marks the Note with what the agent hands
 * back. Nothing goes to a model from here. A verdict that a quote decides stands only on a Citation
 * IncarnaMind found in its Document, among the Documents the Note's own Check searches.
 */
import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { readMindCheck, sentenceKey, writeMindCheck } from "../../../shared/mindCheck";
import { targetHash } from "../../../shared/proposals";
import type {
  Citation,
  ClaimCheckAttributes,
  ClaimCheckResult,
  UnsupportedReason,
} from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { MindContent } from "../../mindContent";
import { cellHeadings, type TableLayout } from "./figureOccurrences";
import {
  checkText,
  everySentence,
  markedSentences,
  markSentence,
  type SelectedSentence,
} from "./sentences";
import type { MindCheckScope } from "./verify";

export type JudgedVerdict =
  | "supported"
  | "contradicted"
  | NonNullable<UnsupportedReason["word"]>
  /** The sentence says nothing a Document could state: it gets no mark. */
  | "nothing-to-check";

export interface JudgedSentence {
  /** The sentence's number in the task. */
  n: number;
  verdict: JudgedVerdict;
  /** The Citations the agent rests it on, each found in its Document now. */
  evidence: readonly Citation[];
  explanation: string | null;
}

export interface CheckTask {
  /** Names the Note's sentences as numbered here: results for another state of the Note are refused. */
  task: string;
  sentences: { n: number; text: string; row?: string; column?: string }[];
}

export type NotJudgedReason =
  /** The Note is checked against Documents the agent may not read. */
  | "beyond-reach"
  | "no-documents"
  /** The Note's sentences are not the task's any more. */
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
 * null when it may not. A scope of every Document, a Note's in no Folder (#3364), is every live
 * Document there is now.
 */
export function readsWithin(
  scope: EvidenceScope,
  reach: ReadonlySet<string>,
  live: () => ReadonlyMap<string, string>,
): string[] | null {
  const read = scope.documentIds ?? [...live().keys()];
  return read.every((id) => reach.has(id)) ? read : null;
}

export interface JudgedOutsideOptions {
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  scopeOf(mindId: string, allDocuments: boolean): MindCheckScope;
  /** Each live Document's version now. */
  documentVersions(): ReadonlyMap<string, string>;
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

export function createJudgedOutside(options: JudgedOutsideOptions) {
  const { content } = options;

  /** The sentences with no result for their words as they are now, in the Note's order. */
  const pending = (blocks: Y.XmlFragment, skipped: ReadonlySet<string>): SelectedSentence[] => {
    const marks = markedSentences(blocks);
    return everySentence(blocks).filter(
      (sentence) =>
        !skipped.has(sentenceKey(sentence.text)) &&
        !marks.some(
          ({ element, from, to, check }) =>
            element === sentence.element &&
            from < sentence.to &&
            to > sentence.from &&
            check.text === sentence.text &&
            SETTLED.has(check.state),
        ),
    );
  };

  const nameOf = (sentences: readonly SelectedSentence[]) =>
    targetHash(sentences.map((each) => `${each.blockId}\u0000${each.text}`).join("\u0001"));

  /** The Documents the Note's Check searches, when all of them are in `reach`. */
  const scopeWithin = (mindId: string, reach: ReadonlySet<string>) => {
    const { empty, check } = options.scopeOf(mindId, false);
    if (empty || check.marked.widened)
      return { ok: false as const, reason: "no-documents" as const };
    // A scope the User chose is the User's to check: an agent would learn from it what it may not read.
    const read = check.marked.chosen
      ? null
      : readsWithin(check.scope, reach, options.documentVersions);
    if (read === null) return { ok: false as const, reason: "beyond-reach" as const };
    return { ok: true as const, check, documentIds: new Set(read) };
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
        const sentences = pending(blocks, skipped);
        const grids = new Map<Y.XmlElement, TableLayout>();
        return {
          ok: true,
          value: {
            task: nameOf(sentences),
            sentences: sentences.map((sentence, index) => ({
              n: index + 1,
              text: checkText(sentence).claim,
              ...cellHeadings(sentence.element, grids),
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
        const sentences = pending(blocks, skipped);
        if (nameOf(sentences) !== task) return { ok: false, reason: "changed" };
        const unconfirmed: number[] = [];
        const reported = new Set<number>();
        let marked = 0;
        for (const each of judged) {
          const sentence = sentences[each.n - 1];
          if (!sentence || reported.has(each.n)) continue;
          reported.add(each.n);
          if (each.verdict === "nothing-to-check") {
            skipped.add(sentenceKey(sentence.text));
            continue;
          }
          const evidence = each.evidence.filter((citation) =>
            scope.documentIds.has(citation.documentId),
          );
          const result = resultOf(each, evidence);
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
          };
          markSentence(
            sentence.element,
            sentence.from,
            sentence.to,
            options.withResult(mark, result, at, blocks, mindId, checkText(sentence).claim),
          );
          marked++;
        }
        return {
          ok: true,
          value: {
            marked,
            unconfirmed,
            unreported: sentences.flatMap((_, index) =>
              reported.has(index + 1) ? [] : [index + 1],
            ),
          },
        };
      });
      if (!landed.ok) return landed;
      options.retainEvidence(mindId);
      const { keys, sentences } = content.read(mindId, (blocks) => ({
        keys: new Set(everySentence(blocks).map((each) => sentenceKey(each.text))),
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

/** The result a sentence's mark holds: the agent's verdict, on the Citations IncarnaMind found. */
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
