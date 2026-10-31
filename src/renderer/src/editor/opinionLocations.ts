import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";
import { omittedOpinions, readOpinionSentences } from "../../../shared/opinions";
import { claimPlaces, claimSpans } from "./claimChecks";

type BlockSentence = {
  text: string;
  occurrence: number;
  from: number;
  to: number;
  starts: (number | null)[];
  ends: (number | null)[];
};

/** Each Block's sentences, at its start 0: a Block that didn't change keeps them across edits. */
const blockSentences = new WeakMap<ProseMirrorNode, BlockSentence[]>();

function sentencesOf(block: ProseMirrorNode): BlockSentence[] {
  const known = blockSentences.get(block);
  if (known) return known;
  const places = claimPlaces(block, 0);
  const occurrences = new Map<string, number>();
  const found = places.sentences.map((span) => {
    const occurrence = occurrences.get(span.text) ?? 0;
    occurrences.set(span.text, occurrence + 1);
    return {
      text: span.text,
      occurrence,
      from: span.from,
      to: span.to,
      starts: places.starts.slice(span.start, span.end),
      ends: places.ends.slice(span.start, span.end),
    };
  });
  blockSentences.set(block, found);
  return found;
}

const shifted = (places: readonly (number | null)[], by: number) =>
  places.map((place) => (place === null ? null : place + by));

/** The sentences of the Blocks named, where they are in the document now. */
export function opinionLocations(doc: ProseMirrorNode, blockIds: ReadonlySet<string>) {
  const sentences: (BlockSentence & { blockId: string })[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const blockId: unknown = block.attrs[BLOCK_ID_ATTRIBUTE];
    if (typeof blockId !== "string" || !blockIds.has(blockId)) return false;
    for (const each of sentencesOf(block)) {
      sentences.push({
        ...each,
        blockId,
        from: each.from + pos,
        to: each.to + pos,
        starts: shifted(each.starts, pos),
        ends: shifted(each.ends, pos),
      });
    }
    return false;
  });
  return sentences;
}

/** The opinions left out, by the page they were read from: each edit reads the page once, whoever asks. */
const computed = new WeakMap<
  ProseMirrorNode,
  { stored: string; opinions: ReturnType<typeof readOpinions> }
>();

export function opinionsIn(note: ProseMirrorNode, doc: Y.Doc) {
  const stored = JSON.stringify(readOpinionSentences(doc));
  const known = computed.get(note);
  if (known?.stored === stored) return known.opinions;
  const opinions = readOpinions(note, doc);
  computed.set(note, { stored, opinions });
  return opinions;
}

function readOpinions(note: ProseMirrorNode, doc: Y.Doc) {
  const stored = readOpinionSentences(doc);
  const claims = claimSpans(note);
  // Only the Blocks an opinion can be in are placed: every key would place the whole Note again.
  const blockIds = new Set([
    ...stored.map((sentence) => sentence.blockId),
    ...claims.flatMap((claim) => (claim.check.parts && claim.place ? [claim.place.blockId] : [])),
  ]);
  if (blockIds.size === 0) return [];
  const current = opinionLocations(note, blockIds);
  const marks = claims.flatMap((claim) => {
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
  return omittedOpinions(current, marks, stored).flatMap((opinion) => {
    const from = opinion.starts[opinion.span.start];
    const to = opinion.ends[opinion.span.end - 1];
    return typeof from !== "number" || typeof to !== "number"
      ? []
      : [{ ...opinion, range: { from, to } }];
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
