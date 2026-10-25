/**
 * Scoring a transcriber on the meeting set (eval/meetings/README.md). For each case: the word
 * error rate (English), character error rate (Chinese) or mixed error rate (Han characters and
 * English words, one unit each) of everything said, in time order, after the normalisation in
 * eval/transcription/scoring.ts; the diarisation error rate when the transcriber says who spoke;
 * and the real-time factor when it says how long it took. Cases of one language and setting are
 * then added up: errors over the reference's units, speech time over speech time.
 */
import { characters, type ErrorRate, errorRate, words } from "../transcription/scoring";
import { DEFAULT_COLLAR, type Der, diarisationErrorRate, type Turn, totalDer } from "./der";
import type { CaseDefinition, Hypothesis, Language, Reference, Setting } from "./types";

export interface Options {
  /** Seconds either side of a reference turn's start and end that DER leaves out. */
  collar?: number;
  /** Score only the first `until` seconds of the recording. */
  until?: number;
}

export type Unit = "word" | "character" | "mixed unit";

export interface CaseScore {
  id: string;
  language: Language;
  setting: Setting;
  seconds: number;
  unit: Unit;
  errors: ErrorRate;
  der: Der | null;
  /** Processing seconds over audio seconds; null when the transcriber didn't say or only part was scored. */
  rtf: number | null;
}

const byTime = <T extends { start: number; end: number }>(segments: readonly T[]) =>
  [...segments].sort((a, b) => a.start - b.start || a.end - b.end);

const unitOf = (language: Language): Unit =>
  language === "en" ? "word" : language === "zh" ? "character" : "mixed unit";

export function scoreCase(
  definition: CaseDefinition,
  reference: Reference,
  hypothesis: Hypothesis,
  options: Options = {},
): CaseScore {
  const until = options.until ?? Number.POSITIVE_INFINITY;
  const within = <T extends { start: number }>(segments: readonly T[]) =>
    segments.filter((segment) => segment.start < until);
  const refSegments = byTime(within(reference.segments));
  const hypSegments = byTime(within(hypothesis.segments));
  const split = definition.language === "en" ? words : characters;
  const refUnits = split(refSegments.map((segment) => segment.text).join(" "));
  const hypUnits = split(hypSegments.map((segment) => segment.text).join(" "));

  const clip = (turn: Turn): Turn => ({ ...turn, end: Math.min(turn.end, until) });
  const speaks = hypSegments.some((segment) => segment.speaker !== undefined);
  const der = speaks
    ? diarisationErrorRate(
        refSegments.map((s) => clip({ speaker: s.speaker, start: s.start, end: s.end })),
        hypSegments.map((s) => clip({ speaker: s.speaker ?? "?", start: s.start, end: s.end })),
        options.collar ?? DEFAULT_COLLAR,
      )
    : null;
  return {
    id: definition.id,
    language: definition.language,
    setting: definition.setting,
    seconds: Math.min(definition.durationSeconds, until),
    unit: unitOf(definition.language),
    errors: errorRate(refUnits, hypUnits),
    der,
    rtf:
      hypothesis.processingSeconds !== undefined && options.until === undefined
        ? hypothesis.processingSeconds / definition.durationSeconds
        : null,
  };
}

export interface CellScore {
  language: Language;
  setting: Setting;
  cases: number;
  minutes: number;
  unit: Unit;
  errors: ErrorRate;
  der: Der | null;
  rtf: number | null;
}

/** The gates the alpha holds the set to: error rate by language, DER by setting. */
export const TARGETS = {
  error: { en: 0.15, zh: 0.2, mixed: null } as Record<Language, number | null>,
  der: { online: 0.2, room: 0.3, conversation: null } as Record<Setting, number | null>,
};

export function scoreCells(scores: readonly CaseScore[]): CellScore[] {
  const cells = new Map<string, CaseScore[]>();
  for (const score of scores) {
    const key = `${score.language}/${score.setting}`;
    cells.set(key, [...(cells.get(key) ?? []), score]);
  }
  return [...cells.values()].map((group) => {
    const first = group[0] as CaseScore;
    const total = group.reduce((sum, s) => sum + s.errors.total, 0);
    const errors = group.reduce((sum, s) => sum + s.errors.errors, 0);
    const withDer = group.map((s) => s.der).filter((der): der is Der => der !== null);
    const timed = group.filter((s) => s.rtf !== null);
    const seconds = timed.reduce((sum, s) => sum + s.seconds, 0);
    return {
      language: first.language,
      setting: first.setting,
      cases: group.length,
      minutes: group.reduce((sum, s) => sum + s.seconds, 0) / 60,
      unit: first.unit,
      errors: { errors, total, rate: total === 0 ? 0 : errors / total },
      der: withDer.length === group.length ? totalDer(withDer) : null,
      rtf:
        timed.length === group.length && seconds > 0
          ? timed.reduce((sum, s) => sum + (s.rtf as number) * s.seconds, 0) / seconds
          : null,
    };
  });
}

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const LABEL: Record<Unit, string> = { word: "WER", character: "CER", "mixed unit": "MER" };

function verdict(rate: number, target: number | null): string {
  return target === null
    ? ""
    : rate <= target
      ? ` (target ${percent(target)}, met)`
      : ` (target ${percent(target)}, missed)`;
}

export function formatReport(scores: readonly CaseScore[], collar = DEFAULT_COLLAR): string {
  const lines = [
    `| Language | Setting | Cases | Minutes | Error rate | DER (collar ${collar} s) | Real-time factor |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const cell of scoreCells(scores)) {
    const error = `${LABEL[cell.unit]} ${percent(cell.errors.rate)}${verdict(cell.errors.rate, TARGETS.error[cell.language])} (${cell.errors.errors} of ${cell.errors.total} ${cell.unit}s)`;
    const der = cell.der
      ? `${percent(cell.der.rate)}${verdict(cell.der.rate, TARGETS.der[cell.setting])}`
      : "not scored";
    const rtf = cell.rtf === null ? "not reported" : `${cell.rtf.toFixed(2)}×`;
    lines.push(
      `| ${cell.language} | ${cell.setting} | ${cell.cases} | ${cell.minutes.toFixed(1)} | ${error} | ${der} | ${rtf} |`,
    );
  }
  lines.push(
    "",
    "| Case | Minutes | Error rate | DER: missed, false alarm, confusion | Real-time factor |",
    "|---|---|---|---|---|",
  );
  for (const score of scores) {
    const der = score.der
      ? `${percent(score.der.rate)}: ${score.der.missed.toFixed(0)} s, ${score.der.falseAlarm.toFixed(0)} s, ${score.der.confusion.toFixed(0)} s of ${score.der.speech.toFixed(0)} s`
      : "not scored";
    lines.push(
      `| ${score.id} | ${(score.seconds / 60).toFixed(1)} | ${LABEL[score.unit]} ${percent(score.errors.rate)} | ${der} | ${score.rtf === null ? "not reported" : `${score.rtf.toFixed(2)}×`} |`,
    );
  }
  return lines.join("\n");
}
