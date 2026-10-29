import type * as Y from "yjs";
import { pendingPart } from "../../../shared/claimParts";
import {
  readOpinionSentences,
  resolveOpinions,
  writeOpinionSentences,
} from "../../../shared/opinions";
import { readVerification, writeVerification } from "../../../shared/verification";
import { type ClaimPartPlan, MIND_SETTINGS_FIELD } from "../../api";
import { everySentence, markedSentences, type SelectedSentence, unmarkSentence } from "./sentences";

export interface SortedSentence extends SelectedSentence {
  parts: readonly ClaimPartPlan[];
}

const sameSentence = (
  a: Pick<SelectedSentence, "blockId" | "text" | "occurrence">,
  b: Pick<SelectedSentence, "blockId" | "text" | "occurrence">,
) => a.blockId === b.blockId && a.text === b.text && a.occurrence === b.occurrence;

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
    if (!(sentence.blockId in verification.pages)) return [];
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
    const parts = mark?.check.parts?.map(({ span, kind }) => ({ span, kind })) ?? found?.parts;
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
