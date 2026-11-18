import type * as Y from "yjs";
import { pendingPart, planOf } from "../../../shared/claimParts";
import {
  readOpinionSentences,
  resolveOpinions,
  writeOpinionSentences,
} from "../../../shared/opinions";
import { isVerifiedBlock, readVerification, writeVerification } from "../../../shared/verification";
import { type ClaimCheckResult, type ClaimPartPlan, MIND_SETTINGS_FIELD } from "../../api";
import { everySentence, markedSentences, type SelectedSentence, unmarkSentence } from "./sentences";

export interface SortedSentence extends SelectedSentence {
  parts: readonly ClaimPartPlan[];
}

const sameSentence = (
  a: Pick<SelectedSentence, "blockId" | "text" | "occurrence">,
  b: Pick<SelectedSentence, "blockId" | "text" | "occurrence">,
) => a.blockId === b.blockId && a.text === b.text && a.occurrence === b.occurrence;

/**
 * The check's model, which sees the Documents, found the sentence to be only its writer's own
 * view: advice, a plan or a judgement that no Document gives (#3322).
 */
export const isOwnView = (result: ClaimCheckResult): boolean =>
  result.verdict === "unsupported" && result.unsupported?.word === "own-view";

/**
 * Leaves the sentence of check `id` out as an opinion, its mark gone. False when its mark doesn't
 * cover one sentence as the Note has it now, so its check's result is written as any other.
 */
export function leaveOutOwnView(blocks: Y.XmlFragment, id: string): boolean {
  const marked = markedSentences(blocks).find((each) => each.check.id === id);
  const sentence =
    marked &&
    everySentence(blocks).find(
      (each) =>
        each.element === marked.element && each.from === marked.from && each.to === marked.to,
    );
  if (!sentence) return false;
  const whole = { start: 0, end: sentence.text.length };
  recordOpinions(blocks, [{ ...sentence, parts: [{ kind: "opinion", span: whole }] }]);
  return true;
}

export function recordOpinions(blocks: Y.XmlFragment, sorted: readonly SortedSentence[]): void {
  const doc = blocks.doc;
  if (!doc) return;
  const current = everySentence(blocks);
  for (const sentence of sorted) {
    if (sentence.parts.some((part) => part.kind === "fact")) continue;
    const now = current.find((each) => sameSentence(each, sentence));
    if (!now) continue;
    for (const mark of markedSentences(blocks)) {
      if (mark.element === now.element && mark.from < now.to && mark.to > now.from) {
        if (
          mark.check.text === now.text &&
          mark.check.parts?.some((part) => part.kind === "opinion" && part.verdict !== null)
        )
          continue;
        unmarkSentence(now.element, now.from, now.to, mark.check.action);
      }
    }
  }
  const marks = markedSentences(blocks);
  const live = resolveOpinions(current, readOpinionSentences(doc)).filter(
    (sentence) =>
      !marks.some(
        (mark) =>
          mark.element === sentence.element && mark.from < sentence.to && mark.to > sentence.from,
      ),
  );
  const kept = live.filter((sentence) => !sorted.some((each) => sameSentence(each, sentence)));
  const added = sorted.flatMap((sentence) => {
    if (sentence.parts.length === 0 || sentence.parts.some((part) => part.kind === "fact")) {
      return [];
    }
    const now = current.find((each) => sameSentence(each, sentence));
    if (!now) return [];
    if (
      marks.some((mark) => mark.element === now.element && mark.from < now.to && mark.to > now.from)
    )
      return [];
    return [
      {
        id: live.find((each) => sameSentence(each, sentence))?.id ?? crypto.randomUUID(),
        blockId: now.blockId,
        text: now.text,
        occurrence: now.occurrence,
        parts: sentence.parts.map(pendingPart),
      },
    ];
  });
  writeOpinionSentences(doc, [...kept, ...added]);
  const settings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
  const verification = readVerification(settings);
  if (!verification || verification.claims === null) return;
  const claims = current.flatMap((sentence) => {
    if (!isVerifiedBlock(doc, verification, sentence.blockId)) return [];
    const found = verification.claims?.find((claim) =>
      sameSentence(sentence, { ...claim, occurrence: claim.occurrence ?? 0 }),
    );
    const mark = marks.find(
      (mark) =>
        mark.element === sentence.element &&
        mark.from < sentence.to &&
        mark.to > sentence.from &&
        mark.check.text === sentence.text,
    );
    if (!found && !mark) return [];
    const parts = mark?.check.parts?.map(planOf) ?? found?.parts;
    return [
      {
        blockId: sentence.blockId,
        text: sentence.text,
        occurrence: sentence.occurrence,
        ...(parts && { parts: [...parts] }),
      },
    ];
  });
  if (JSON.stringify(claims) !== JSON.stringify(verification.claims)) {
    writeVerification(settings, { ...verification, claims });
  }
}

export function unmarkedOpinion(blocks: Y.XmlFragment, id: string) {
  return blocks.doc
    ? (resolveOpinions(everySentence(blocks), readOpinionSentences(blocks.doc)).find(
        (sentence) => sentence.id === id,
      ) ?? null)
    : null;
}

export function removeOpinion(blocks: Y.XmlFragment, id: string): void {
  if (!blocks.doc) return;
  const kept = readOpinionSentences(blocks.doc).filter((sentence) => sentence.id !== id);
  writeOpinionSentences(blocks.doc, kept);
}
