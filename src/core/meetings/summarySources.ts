import { targetHash } from "../../shared/proposals";
import { findQuote } from "../../shared/quoteMatch";
import { partsOf } from "../../shared/speakers";
import { transcriptCueLines, type UnitText } from "../../shared/units";
import type { MeetingSummarySource, TextRange, TranscriptSpeakers } from "../api";
import {
  normalizeSummaryEvidence,
  originalSummaryCue,
  type StoredSummaryQuote,
  summaryEvidenceCue,
  summaryQuoteWords,
} from "./summaryEvidence";

function originalExcerpt(text: string, words: string): string {
  const [range] = findQuote(text, words) ?? [];
  if (range) {
    const excerpt = text.slice(range.start, range.end);
    if (normalizeSummaryEvidence(excerpt) === words) return excerpt;
  }
  return text;
}

export interface TranscriptActionLine {
  transcriptCue: MeetingSummarySource;
  parentCue?: MeetingSummarySource;
  excerpt?: TextRange;
}

type IndexedCues = ReturnType<typeof transcriptCueLines>;

function sameLine(a: MeetingSummarySource, b: MeetingSummarySource) {
  return a.startMs === b.startMs && a.endMs === b.endMs && a.text === b.text;
}

function sourceOf({ startMs, endMs, text }: MeetingSummarySource): MeetingSummarySource {
  return { startMs, endMs, text };
}

export function transcriptActionLine(
  cues: IndexedCues,
  speakers: TranscriptSpeakers | null,
  selected: MeetingSummarySource,
  excerpt?: TextRange,
): TranscriptActionLine | null {
  if (
    excerpt !== undefined &&
    (!excerpt ||
      typeof selected.text !== "string" ||
      !Number.isSafeInteger(excerpt.start) ||
      !Number.isSafeInteger(excerpt.end) ||
      excerpt.start < 0 ||
      excerpt.end > selected.text.length ||
      excerpt.start >= excerpt.end ||
      !selected.text.slice(excerpt.start, excerpt.end).trim())
  )
    return null;

  const matches = cues.flatMap((cue) => {
    if (cue.startMs > selected.startMs || cue.endMs < selected.endMs) return [];
    const part = partsOf(speakers, { ...cue, label: cue.label ?? "" }).find((line) =>
      sameLine(line, selected),
    );
    return part
      ? [
          {
            transcriptCue: sourceOf(part),
            ...(excerpt &&
              (excerpt.start !== 0 || excerpt.end !== part.text.length) && {
                excerpt: { start: excerpt.start, end: excerpt.end },
              }),
            ...(!sameLine(part, cue) && { parentCue: sourceOf(cue) }),
          },
        ]
      : [];
  });
  const [line] = matches;
  if (matches.length !== 1 || !line) return null;
  const parent = line.parentCue;
  return parent && cues.filter((cue) => sameLine(cue, parent)).length !== 1 ? null : line;
}

export function actionWords(line: TranscriptActionLine) {
  const { text } = line.transcriptCue;
  return line.excerpt ? text.slice(line.excerpt.start, line.excerpt.end) : text;
}

export function transcriptActionSources(
  cues: IndexedCues,
  speakers: TranscriptSpeakers | null,
  line: TranscriptActionLine,
) {
  const parent = line.parentCue ?? line.transcriptCue;
  if (cues.filter((cue) => sameLine(cue, parent)).length !== 1) return [];
  const source = {
    ...line.transcriptCue,
    text: actionWords(line),
    ...(line.excerpt && { excerpt: { ...line.excerpt, cueHash: targetHash(parent.text) } }),
  };
  if (!line.parentCue) return [source];
  const current = transcriptActionLine(cues, speakers, line.transcriptCue);
  if (current?.parentCue && sameLine(current.parentCue, parent))
    return [{ ...source, part: true as const }];
  // A later edit to the split can leave the original words intact in their file cue.
  const { text } = line.transcriptCue;
  if (parent.text.indexOf(text) < 0 || parent.text.indexOf(text) !== parent.text.lastIndexOf(text))
    return [];
  const offset = parent.text.indexOf(text);
  const excerpt = line.excerpt && {
    cueHash: targetHash(parent.text),
    start: offset + line.excerpt.start,
    end: offset + line.excerpt.end,
  };
  return [
    {
      ...source,
      ...(excerpt && { excerpt }),
      parentCue: { startMs: parent.startMs, endMs: parent.endMs },
    },
  ];
}

export function meetingSummarySources(
  units: readonly UnitText[],
  quotes: readonly StoredSummaryQuote[],
) {
  const lines = transcriptCueLines(units).map(({ startMs, endMs, text }) => ({
    startMs,
    endMs,
    text,
    excerpts: new Set<string>(),
  }));
  const speech = lines.map(summaryEvidenceCue);
  for (const quote of quotes) {
    const index = originalSummaryCue(quote, speech);
    const only = index === undefined ? undefined : lines[index];
    if (only) only.excerpts.add(originalExcerpt(only.text, summaryQuoteWords(quote)));
  }
  return lines.flatMap(({ startMs, endMs, text, excerpts }) => {
    if (excerpts.size === 0) return [];
    const longest = [...excerpts].sort((a, b) => b.length - a.length)[0] ?? text;
    return [
      {
        startMs,
        endMs,
        text: [...excerpts].every((excerpt) => longest.includes(excerpt)) ? longest : text,
      },
    ];
  });
}
