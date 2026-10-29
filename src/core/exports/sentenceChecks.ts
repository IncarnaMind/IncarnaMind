import type * as Y from "yjs";
import { checkedScope, claimCheckShown, coveredPart, saysNotFound } from "../../shared/claimChecks";
import { type ScopeKind, scopeName } from "../../shared/searchScope";
import { checkedSentences, figuresNow, recordCiteNote } from "../answers/checks/sentences";
import type { CitationAttributes, RecordCiteResult, SearchScope } from "../api";
import type { FailedSentence, RecordCiteComment } from "../mindText";

/** What the checks of a Mind's sentences are compared with, and how an export names things. */
export interface SentenceCheckContext {
  versions: ReadonlyMap<string, string>;
  folderId: string | null;
  /** The Search scope the User set for the Mind; null for none. */
  scope: SearchScope | null;
  /** A Folder's, Tag's or Document's name; null for one that isn't there. */
  scopeItemName(kind: ScopeKind, id: string): string | null;
  /** A Passage's Document and Location, as a footnote says it. */
  sourceOf(passage: Partial<CitationAttributes>): string;
}

function recordCiteComments(
  cites: readonly RecordCiteResult[],
  context: SentenceCheckContext,
): RecordCiteComment[] {
  const sourceOf = (cite: Partial<CitationAttributes>) =>
    context.sourceOf({ ...cite, contentHash: undefined });
  return cites.map((cite) => {
    const sourced =
      cite.documentId !== undefined ||
      cite.documentName !== undefined ||
      cite.location !== undefined ||
      cite.passage !== undefined;
    return {
      raw: cite.raw,
      outcome: cite.outcome,
      source: sourced ? sourceOf(cite) : null,
      passage: cite.passage ?? null,
      covered: cite.covered ?? null,
      uncovered: cite.uncovered ?? null,
      candidates: (cite.candidates ?? []).map((candidate) => candidate.name),
      nearby: cite.nearby
        ? {
            source: sourceOf({ ...cite, ...cite.nearby }),
            passage: cite.nearby.passage,
          }
        : null,
    };
  });
}

/** The checks of the Mind's sentences that aren't good, by check id: as they show now, not as they were made. */
export function failedSentences(
  fragment: Y.XmlFragment,
  context: SentenceCheckContext,
): Map<string, FailedSentence> {
  const failed = new Map<string, FailedSentence>();
  const { figureContexts, figured } = figuresNow(fragment);
  const note = recordCiteNote(fragment);
  for (const marked of checkedSentences(fragment)) {
    const { check, sentence, cited } = marked;
    const { id } = check;
    const shown = claimCheckShown(check, {
      text: sentence,
      figureContexts,
      figured: figured(marked),
      versions: context.versions,
      folderId: context.folderId,
      scope: context.scope,
      note: note(marked.place),
    });
    if (shown.state === "contradicted") {
      const { calculation } = check;
      failed.set(id, {
        id,
        check: "contradicted",
        says: check.says,
        worked:
          calculation && !calculation.agrees
            ? {
                shown: calculation.figure.shown,
                stated: calculation.stated,
                ...(calculation.relation && { relation: calculation.relation }),
              }
            : null,
      });
    } else if (shown.state === "unsupported" && check.citedCaseUnchecked) {
      failed.set(id, { id, check: "cited-case-unchecked", unsupported: true });
    } else if (
      shown.state === "unsupported" &&
      check.excluded.some((left) => left.reason === "own-workings")
    ) {
      failed.set(id, { id, check: "own-workings" });
    } else if (shown.state === "unsupported") {
      const { evidence } = check;
      const covers = evidence ? null : coveredPart(check.unsupported);
      const why = check.unsupported;
      const looked = checkedScope(check.scope);
      failed.set(id, {
        id,
        check: "unsupported",
        citations:
          !evidence && cited.length > 0 && why?.covered && why.uncovered
            ? { count: cited.length, covered: why.covered, uncovered: why.uncovered }
            : null,
        scope: looked && scopeName(looked, context.scopeItemName),
        nearest: evidence?.quote
          ? { quote: evidence.quote, source: context.sourceOf(evidence) }
          : null,
        covers: covers && {
          covered: covers.covered,
          uncovered: covers.uncovered,
          quote: covers.quote,
          source: context.sourceOf(covers.quoted),
        },
        notFound: saysNotFound(shown, check, cited.length),
        reason: why?.reason ?? null,
      });
    } else if (shown.state === "needs-recheck") {
      failed.set(id, { id, check: "needs-recheck", why: shown.why });
    } else if (shown.state === "supported" && check.citedCaseUnchecked) {
      failed.set(id, { id, check: "cited-case-unchecked", unsupported: false });
    }
    const recordCites = recordCiteComments(check.recordCites ?? [], context);
    if (recordCites.length > 0) {
      const existing = failed.get(id);
      if (existing) failed.set(id, { ...existing, recordCites });
      else failed.set(id, { id, check: "record-cites", recordCites });
    }
  }
  return failed;
}
