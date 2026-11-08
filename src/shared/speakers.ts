import type { TranscriptSpeakers, TranscriptSplit } from "../core/api";
import type { MessageKey, MessageParams } from "./i18n";
import { findQuote } from "./quoteMatch";

/**
 * Who a live line of a Meeting's Transcript is from, before speakers are told
 * apart (#941): the microphone, the computer's sound, or a room with no
 * computer sound. The Transcript's file keeps these words as they are, in a
 * voice span (`<v Me>`); the window words them in the interface's language.
 */
export const SPEAKER_ME = "Me";
export const SPEAKER_THEM = "Them";
export const SPEAKER_UNKNOWN = "Speaker ?";

/**
 * Someone told apart (#138, #141), numbered in the order heard in the Meeting, in a call and in
 * a room alike (DESIGN.md › Speakers): "Speaker 2". In a room it may be the User.
 */
export const numberedVoice = (n: number) => `Speaker ${n}`;
/** How cloud transcription numbered the other side's voices before #138, in Transcripts saved then: shown as "Speaker n". */
const THEIRS = /^Them (\d+)$/;
const ROOM = /^Speaker (\d+)$/;

/**
 * Not the User's microphone, and not unknown: in a call, a line of the other side. A room has
 * no "Me" line for one to be told from.
 */
export const isTheirs = (speaker: string | null) =>
  speaker !== null && speaker !== SPEAKER_ME && speaker !== SPEAKER_UNKNOWN;

const KEYS: Readonly<Record<string, MessageKey>> = {
  [SPEAKER_ME]: "transcript.speaker.me",
  [SPEAKER_THEM]: "transcript.speaker.them",
  [SPEAKER_UNKNOWN]: "transcript.speaker.unknown",
};

export const speakerKey = (speaker: string): MessageKey | null =>
  Object.hasOwn(KEYS, speaker) ? (KEYS[speaker] ?? null) : null;

export function speakerName(
  speaker: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const key = speakerKey(speaker);
  if (key) return t(key);
  const numbered = THEIRS.exec(speaker) ?? ROOM.exec(speaker);
  return numbered ? t("transcript.speaker.numbered", { n: numbered[1] as string }) : speaker;
}

/** A line of a Transcript as its file has it: when it starts, and its label. */
export interface TranscriptLine {
  startMs: number;
  label: string;
}

/** How `TranscriptSpeakers.lines` knows a line: two can start together, never with one label. */
export const lineKey = (startMs: number, label: string) => `${startMs} ${label}`;

// A label is anything a file gives, "constructor" or "__proto__" too: never an inherited key.
const own = (record: Readonly<Record<string, string>> | undefined, key: string) =>
  record && Object.hasOwn(record, key) ? (record[key] ?? null) : null;

const put = (record: Record<string, string>, key: string, value: string) =>
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

/** The label of the Speaker a line is by now: the one the User gave it to, else its file's. */
export const speakerOf = (
  speakers: TranscriptSpeakers | null | undefined,
  startMs: number,
  label: string,
): string => own(speakers?.lines, lineKey(startMs, label)) ?? label;

/** The name the User gave the Speaker with this label; null for none, and always for Me. */
export const nameOf = (speakers: TranscriptSpeakers | null | undefined, label: string) =>
  label === SPEAKER_ME ? null : own(speakers?.labels, label);

/**
 * Who a line is by, as the interface shows it (#138): the name the User gave its Speaker, else
 * its label in the interface's words. `label` is its file's, as a Citation stores it.
 */
export function shownSpeaker(
  speakers: TranscriptSpeakers | null | undefined,
  startMs: number,
  label: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const who = speakerOf(speakers, startMs, label);
  return nameOf(speakers, who) ?? speakerName(who, t);
}

/**
 * Who a line is by, as a model reads it: "Me" for the User, as the prompts say, a name the User
 * gave, else its Speaker's label.
 */
export function speakerMark(
  speakers: TranscriptSpeakers | null | undefined,
  startMs: number,
  label: string,
): string {
  const who = speakerOf(speakers, startMs, label);
  return nameOf(speakers, who) ?? who;
}

/** The Speakers a Transcript's lines are by now, by label: Me first, then as each first speaks. */
export function speakersIn(
  speakers: TranscriptSpeakers | null | undefined,
  lines: readonly TranscriptLine[],
): string[] {
  const found = new Set([SPEAKER_ME]);
  for (const line of lines) found.add(speakerOf(speakers, line.startMs, line.label));
  return [...found];
}

const NUMBERED = /^(?:Speaker|Them) (\d+)$/;

/** The label for a new Speaker: the first "Speaker N" no line, name or reassignment has taken. */
function newSpeakerLabel(speakers: TranscriptSpeakers, lines: readonly TranscriptLine[]): string {
  const taken = [
    ...lines.map((line) => line.label),
    ...Object.keys(speakers.labels),
    ...Object.values(speakers.lines),
  ];
  const highest = Math.max(0, ...taken.map((label) => Number(NUMBERED.exec(label)?.[1] ?? 0)));
  return numberedVoice(highest + 1);
}

/** Who a line is given to: a Speaker there is, by label, or a new one, by the name typed. */
export type SpeakerChoice = { label: string } | { name: string };

/**
 * Who's who after the User says who speaks `chosen` (#138): that line, or a turn's lines, alone, or
 * with `all`, every line by its Speaker now. A new name with `all` names that Speaker, unless it is the User, who
 * keeps "Me": then their lines go to a new Speaker. A line given back to its file's label keeps
 * no entry.
 */
export function withSpeakerChosen(
  speakers: TranscriptSpeakers | null,
  lines: readonly TranscriptLine[],
  chosen: TranscriptLine | readonly TranscriptLine[],
  choice: SpeakerChoice,
  all: boolean,
): TranscriptSpeakers {
  const before = speakers ?? { labels: {}, lines: {} };
  const after = { ...before, labels: { ...before.labels }, lines: { ...before.lines } };
  // A turn's lines are one Speaker's (../shared/transcriptTurns): the first says whose.
  const given: readonly TranscriptLine[] = Array.isArray(chosen) ? chosen : [chosen];
  const line = given[0];
  if (!line) return after;
  const now = speakerOf(before, line.startMs, line.label);
  let to: string;
  if ("label" in choice) to = choice.label;
  else if (all && now !== SPEAKER_ME) {
    put(after.labels, now, choice.name);
    return after;
  } else {
    to = newSpeakerLabel(before, lines);
    put(after.labels, to, choice.name);
  }
  const moved = all
    ? lines.filter((each) => speakerOf(before, each.startMs, each.label) === now)
    : given;
  for (const each of moved) {
    const key = lineKey(each.startMs, each.label);
    if (to === each.label) delete after.lines[key];
    else put(after.lines, key, to);
  }
  return after;
}

/**
 * The longest name the User gives: what a model's mark of a line carries whole, so a quote copied
 * with its mark loses the mark (`LOCATION_MARK` in ../core/answers/citations).
 */
export const MAX_SPEAKER_NAME = 60;
/** The longest label kept: a file's own, which IncarnaMind doesn't choose. */
const MAX_SPEAKER_LABEL = 200;
/** More entries than a Transcript has lines, by far. */
const MAX_SPEAKER_ENTRIES = 50_000;
const LINE_KEY = /^(\d{1,12}) (.+)$/su;

// No control characters, and no format ones (a bidirectional override, a zero-width space), which
// would let a name read as another.
const speakerText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value !== "" &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

const LABEL_WORDS =
  /^(?:me|them|speaker \?|(?:speaker|them) \d+|我|对方|发言人 ?\?|发言人 ?\d+)$/iu;

/**
 * Whether words are how the interface or a model names a Speaker by label, in English or
 * Chinese ("Me", "我", "Speaker 2", "发言人 2"): never a person's name, or a model would read
 * another Speaker's line as the User's.
 */
export const looksLikeLabel = (words: string) =>
  LABEL_WORDS.test(words.normalize("NFKC").replace(/\s+/gu, " ").trim());

/** Whether a Speaker can be given this name: the rules a name the User types is kept by. */
export const isSpeakerName = (name: string): boolean =>
  speakerText(name, MAX_SPEAKER_NAME) && !looksLikeLabel(name);

/** A Speaker as a mark names them inside its brackets: brackets and line breaks are spaces. */
export const markWords = (speaker: string) =>
  speaker
    .replace(/[[\]\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Who's who as it was stored or sent, keeping only the entries that hold, and how many didn't:
 * a name of 1 to `MAX_SPEAKER_NAME` characters that isn't a label's words, a label of 1 to 200,
 * neither with spaces around it or control or format characters, a line known as `lineKey` makes
 * it, and no name for "Me", who is the User. Null when none holds.
 */
export function parseTranscriptSpeakers(value: unknown): {
  speakers: TranscriptSpeakers | null;
  dropped: number;
} {
  const record = (each: unknown): [string, unknown][] =>
    typeof each === "object" && each !== null && !Array.isArray(each) ? Object.entries(each) : [];
  const given = typeof value === "object" && value !== null ? value : {};
  const labels = record((given as { labels?: unknown }).labels);
  const lines = record((given as { lines?: unknown }).lines);
  const keptLabels = labels.filter(
    ([label, name]) =>
      label !== SPEAKER_ME &&
      speakerText(label, MAX_SPEAKER_LABEL) &&
      speakerText(name, MAX_SPEAKER_NAME) &&
      !looksLikeLabel(name),
  );
  const keptLines = lines.filter(
    ([key, label]) =>
      speakerText(LINE_KEY.exec(key)?.[2], MAX_SPEAKER_LABEL) &&
      speakerText(label, MAX_SPEAKER_LABEL),
  );
  const splits = record((given as { splits?: unknown }).splits);
  const keptSplits = splits.filter(([key, split]) => {
    const line = LINE_KEY.exec(key);
    return (
      speakerText(line?.[2], MAX_SPEAKER_LABEL) && isSplit(split, Number(line?.[1] ?? Number.NaN))
    );
  });
  const kept = keptLabels.length + keptLines.length + keptSplits.length;
  const shape =
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).every((key) => key === "labels" || key === "lines" || key === "splits") &&
    kept <= MAX_SPEAKER_ENTRIES;
  const dropped =
    labels.length -
    keptLabels.length +
    lines.length -
    keptLines.length +
    splits.length -
    keptSplits.length +
    (shape ? 0 : 1);
  if (!shape || kept === 0) return { speakers: null, dropped };
  return {
    speakers: {
      labels: Object.fromEntries(keptLabels) as Record<string, string>,
      lines: Object.fromEntries(keptLines) as Record<string, string>,
      ...(keptSplits.length > 0 && {
        splits: Object.fromEntries(keptSplits) as Record<string, TranscriptSplit>,
      }),
    },
    dropped,
  };
}

/** The most parts one line is split into. */
const MAX_SPLITS = 100;

/**
 * A split as stored or sent: the line's text, and each later part after the one before it, the
 * first after the line's start. Where its line ends only the line knows (`splitFits`).
 */
function isSplit(value: unknown, lineMs: number): value is TranscriptSplit {
  if (typeof value !== "object" || value === null) return false;
  const { text, parts } = value as { text?: unknown; parts?: unknown };
  if (typeof text !== "string" || text === "" || !Array.isArray(parts)) return false;
  if (parts.length === 0 || parts.length > MAX_SPLITS) return false;
  let at = 0;
  let ms = lineMs;
  for (const part of parts) {
    if (typeof part !== "object" || part === null) return false;
    const next = part as { at?: unknown; ms?: unknown };
    if (!Number.isInteger(next.at) || typeof next.ms !== "number" || !Number.isFinite(next.ms)) {
      return false;
    }
    if ((next.at as number) <= at || (next.at as number) >= text.length || next.ms <= ms) {
      return false;
    }
    at = next.at as number;
    ms = next.ms;
  }
  return true;
}

/** Who's who as the database keeps it, as JSON; text that isn't JSON counts as one dropped. */
export function readStoredSpeakers(
  json: string | null,
): ReturnType<typeof parseTranscriptSpeakers> {
  if (json === null) return { speakers: null, dropped: 0 };
  try {
    return parseTranscriptSpeakers(JSON.parse(json));
  } catch {
    return { speakers: null, dropped: 1 };
  }
}

/** A line as the Transcript shows it: a file's line, or one part of a line the User split. */
export interface LinePart {
  /** When the part starts: the file's line's start for its first part. */
  startMs: number;
  endMs: number;
  /** Where the part starts in its file's line's text. */
  at: number;
  text: string;
  /** The file's label of its line, which a Citation of it stores. */
  label: string;
  /** Its file's line's start, which a Citation of it stores. */
  lineMs: number;
}

/** A line of a Transcript's file, as `partsOf` reads it. */
export interface FileLine {
  startMs: number;
  endMs: number;
  text: string;
  label: string;
}

/**
 * Whether a split holds for the line as its file has it now: the text it split, and each part's
 * start strictly inside the line's time, so a part is never said outside its line.
 */
export const splitFits = (split: TranscriptSplit, line: FileLine) =>
  split.text === line.text &&
  split.parts.every((part) => part.ms > line.startMs && part.ms < line.endMs);

/**
 * Whether every split in who's who holds for a Transcript's lines as its file has them: its line
 * is there and it fits it (`splitFits`), and no part starts where another line or part by its
 * label does, which would make them one in `lines`.
 */
export function splitsHold(speakers: TranscriptSpeakers, lines: readonly FileLine[]): boolean {
  const byKey = new Map(lines.map((line) => [lineKey(line.startMs, line.label), line]));
  const starts = new Set(byKey.keys());
  for (const [key, split] of Object.entries(speakers.splits ?? {})) {
    const line = byKey.get(key);
    if (!line || !splitFits(split, line)) return false;
    for (const part of split.parts) {
      const partKey = lineKey(part.ms, line.label);
      if (starts.has(partKey)) return false;
      starts.add(partKey);
    }
  }
  return true;
}

/** The split of a file's line, while it holds for the line (`splitFits`). */
function splitOf(
  speakers: TranscriptSpeakers | null | undefined,
  line: FileLine,
): TranscriptSplit | null {
  const splits = speakers?.splits;
  const split =
    splits && Object.hasOwn(splits, lineKey(line.startMs, line.label))
      ? splits[lineKey(line.startMs, line.label)]
      : undefined;
  return split && splitFits(split, line) ? split : null;
}

/** The parts the User split a file's line into (#138), in order: the line whole when they didn't. */
export function partsOf(
  speakers: TranscriptSpeakers | null | undefined,
  line: FileLine,
): LinePart[] {
  const starts = [{ at: 0, ms: line.startMs }, ...(splitOf(speakers, line)?.parts ?? [])];
  return starts.map((start, index) => {
    const next = starts[index + 1];
    return {
      startMs: start.ms,
      endMs: next ? next.ms : line.endMs,
      at: start.at,
      text: line.text.slice(start.at, next ? next.at : undefined).trim(),
      label: line.label,
      lineMs: line.startMs,
    };
  });
}

/** The time nearest `ms` strictly between `from` and `to` that isn't taken; null when none is free. */
function freeTime(ms: number, from: number, to: number, taken: ReadonlySet<number>): number | null {
  const wanted = Math.min(Math.max(Math.round(ms), from + 1), to - 1);
  for (let step = 0; step < to - from; step++) {
    for (const each of [wanted + step, wanted - step]) {
      if (each > from && each < to && !taken.has(each)) return each;
    }
  }
  return null;
}

/**
 * Who's who with a file's line split before the character at `at`, the part after it starting at
 * `ms` (#138), said by the Speaker of the part it was in until "Who speaks the rest?" says
 * otherwise. `lines`: the Transcript's lines and parts. The rest is known by its start and label,
 * as they are, so it starts at the free time nearest `ms` strictly inside its part, never where
 * another line by its label starts. Unchanged when `at` is the start of a part already or outside
 * the line, or the part has no time free to start another.
 */
export function withLineSplit(
  speakers: TranscriptSpeakers | null,
  line: FileLine,
  at: number,
  ms: number,
  lines: readonly TranscriptLine[] = [],
): TranscriptSpeakers {
  const before = speakers ?? { labels: {}, lines: {} };
  const parts = partsOf(before, line);
  const inside = parts.findLast((part) => part.at <= at);
  if (!inside || inside.at === at || at <= 0 || at >= line.text.length) return before;
  const taken = new Set(
    [...lines, ...parts].filter((each) => each.label === line.label).map((each) => each.startMs),
  );
  const startMs = freeTime(ms, inside.startMs, inside.endMs, taken);
  if (startMs === null) return before;
  const split = splitOf(before, line);
  const after = {
    ...before,
    lines: { ...before.lines },
    splits: { ...before.splits },
  };
  put(after.lines, lineKey(startMs, line.label), speakerOf(before, inside.startMs, line.label));
  Object.defineProperty(after.splits, lineKey(line.startMs, line.label), {
    value: {
      text: line.text,
      parts: [...(split?.parts ?? []), { at, ms: startMs }].sort((a, b) => a.at - b.at),
    },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return after;
}

/**
 * When the part a quote of a file's line starts in begins (#138): a Citation stores its line's
 * start and label, and shows the part its words are in. The line's start when it isn't split, or
 * the quote isn't found in it.
 */
export function partStartOf(
  speakers: TranscriptSpeakers | null | undefined,
  lineMs: number,
  label: string,
  quote: string | null | undefined,
): number {
  const splits = speakers?.splits;
  const split =
    splits && Object.hasOwn(splits, lineKey(lineMs, label)) ? splits[lineKey(lineMs, label)] : null;
  if (!split || !quote) return lineMs;
  const at = findQuote(split.text, quote)?.[0]?.start;
  if (at === undefined) return lineMs;
  return split.parts.findLast((part) => part.at <= at)?.ms ?? lineMs;
}
