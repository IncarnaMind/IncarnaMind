import { isRecord } from "../../shared/record";
import { cueTarget, parseCueTarget } from "../../shared/units";
import type { MeetingSummaryCandidate, MeetingSummarySource } from "../api";
import { normalizeSummaryEvidence } from "./summaryEvidence";

function locatedQuotes(lines: readonly MeetingSummarySource[], quotes: readonly string[]) {
  const words = lines.map(({ text }) => normalizeSummaryEvidence(text));
  const result = new Map<number, string[]>();
  for (const quote of quotes.map(normalizeSummaryEvidence)) {
    const row = words.findIndex((text) => text.includes(quote));
    if (row < 0 || words.findLastIndex((text) => text.includes(quote)) !== row) continue;
    const line = words[row];
    if (!line || line.indexOf(quote) !== line.lastIndexOf(quote)) continue;
    result.set(row, [...(result.get(row) ?? []), quote]);
  }
  return result;
}

function matchRows(
  excerpts: readonly string[],
  lines: readonly MeetingSummarySource[],
  established: ReadonlyMap<number, string[]>,
): number[] | "ineligible" | undefined {
  let match: number[] | undefined;
  for (let i = 0; i <= lines.length - excerpts.length; i++) {
    if (!excerpts.every((excerpt, n) => lines[i + n]?.text.includes(excerpt))) continue;
    if (match) return "ineligible";
    match = excerpts.map((_, n) => i + n);
  }
  if (
    match?.some((row, n) => {
      const excerpt = normalizeSummaryEvidence(excerpts[n] ?? "");
      return established
        .get(row)
        ?.some((quote) => excerpt.includes(quote) || quote.includes(excerpt));
    })
  )
    return "ineligible";
  return match;
}

export function bindCandidateSources(
  utterances: readonly MeetingSummarySource[],
  proposals: readonly string[][],
  established: readonly string[],
): MeetingSummarySource[][] | null {
  if (!proposals.length) return [];
  const confirmed = locatedQuotes(utterances, established);
  const rows = new Map<string, number[]>();
  let matchedSpeech = false;
  for (const proposal of proposals) {
    const indices = matchRows(proposal, utterances, confirmed);
    if (indices === undefined) continue;
    matchedSpeech = true;
    if (indices !== "ineligible") rows.set(indices.join(","), indices);
  }
  if (!matchedSpeech) return null;
  const used = new Set<number>();
  const found: { first: number; sources: MeetingSummarySource[] }[] = [];
  for (const indices of [...rows.values()].sort(
    (a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0),
  )) {
    if (indices.some((n) => used.has(n))) continue;
    const sources: MeetingSummarySource[] = [];
    for (const index of indices) {
      const cue = utterances[index];
      const at = cue && parseCueTarget(sourceTarget(cue));
      if (cue && at) sources.push({ ...at, text: cue.text });
    }
    const first = indices[0];
    if (
      first === undefined ||
      sources.length !== indices.length ||
      !candidateSurvives({ sources }, utterances)
    )
      continue;
    for (const n of indices) used.add(n);
    found.push({ first, sources });
  }
  return found.sort((a, b) => a.first - b.first).map(({ sources }) => sources);
}

export function candidateExcerpts(
  entry: unknown,
  utterances: readonly { text: string; speaker?: string | null }[],
): string[] | null {
  let words = entry;
  if (isRecord(entry)) {
    if (typeof entry.text === "string") {
      const excerpt = entry.text.trim();
      if (
        !excerpt ||
        Object.keys(entry).some((key) => key !== "text" && key !== "speaker") ||
        !utterances.some((cue) => cue.speaker === entry.speaker && cue.text.includes(excerpt))
      )
        return null;
      return [excerpt];
    }
    if (
      !("excerpt" in entry) ||
      Object.keys(entry).some((key) => key !== "excerpt" && key !== "excerpt_2")
    )
      return null;
    words = "excerpt_2" in entry ? [entry.excerpt, entry.excerpt_2] : [entry.excerpt];
  }
  if (!Array.isArray(words) || words.length < 1 || words.length > 2) return null;
  const excerpts: string[] = [];
  for (const value of words) {
    if (typeof value !== "string" || !value.trim()) return null;
    excerpts.push(value.trim());
  }
  return excerpts;
}

function sourceTarget({ startMs, endMs }: MeetingSummarySource) {
  return cueTarget(Math.max(0, startMs), Math.max(0, startMs, endMs));
}

export function sameCandidateSource(a: MeetingSummarySource, b: MeetingSummarySource) {
  return a.text === b.text && sourceTarget(a) === sourceTarget(b);
}

export function candidateSurvives(
  candidate: Pick<MeetingSummaryCandidate, "sources">,
  cues: readonly MeetingSummarySource[],
): boolean {
  if (candidate.sources.length < 1 || candidate.sources.length > 2) return false;
  let previous = -1;
  for (const source of candidate.sources) {
    const index = cues.findIndex((cue) => sameCandidateSource(source, cue));
    if (index < 0 || (previous >= 0 && index !== previous + 1)) return false;
    if (cues.findIndex((cue, n) => n > index && sameCandidateSource(source, cue)) >= 0)
      return false;
    previous = index;
  }
  return true;
}
