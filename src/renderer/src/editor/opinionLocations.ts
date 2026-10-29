import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";
import { omittedOpinions, readOpinionSentences } from "../../../shared/opinions";
import { sentenceSpans } from "../../../shared/sentences";
import { claimSpans, paragraphPlaces } from "./claimChecks";

export function opinionLocations(doc: ProseMirrorNode) {
  const sentences: {
    blockId: string;
    text: string;
    occurrence: number;
    from: number;
    to: number;
    starts: number[];
    ends: number[];
  }[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const blockId: unknown = block.attrs[BLOCK_ID_ATTRIBUTE];
    if (typeof blockId !== "string") return false;
    const places = paragraphPlaces(block, pos);
    const occurrences = new Map<string, number>();
    for (const span of sentenceSpans(places.text)) {
      const text = places.text.slice(span.from, span.to);
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      const from = places.starts[span.from];
      const to = places.ends[span.to - 1];
      if (from === undefined || to === undefined) continue;
      sentences.push({
        blockId,
        text,
        occurrence,
        from,
        to,
        starts: places.starts.slice(span.from, span.to),
        ends: places.ends.slice(span.from, span.to),
      });
    }
    return false;
  });
  return sentences;
}

export function opinionsIn(note: ProseMirrorNode, doc: Y.Doc) {
  const current = opinionLocations(note);
  const marks = claimSpans(note).flatMap((claim) => {
    const sentence = current.find((each) => each.from === claim.sentence.from);
    return sentence
      ? [
          {
            ...sentence,
            id: claim.check.id,
            text: claim.check.text,
            parts: claim.check.parts,
          },
        ]
      : [];
  });
  return omittedOpinions(current, marks, readOpinionSentences(doc)).flatMap((opinion) => {
    const from = opinion.starts[opinion.span.start];
    const to = opinion.ends[opinion.span.end - 1];
    return from === undefined || to === undefined ? [] : [{ ...opinion, range: { from, to } }];
  });
}

export function opinionSentenceRanges(note: ProseMirrorNode, doc: Y.Doc) {
  const marked = new Set(claimSpans(note).map((claim) => claim.check.id));
  return opinionsIn(note, doc)
    .filter((opinion) => !marked.has(opinion.id))
    .map((opinion) => ({
      from: opinion.from,
      to: opinion.to,
      text: opinion.text,
    }));
}
