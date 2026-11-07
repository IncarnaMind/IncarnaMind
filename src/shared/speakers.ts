import type { TranscriptSpeakers } from "../core/api";
import type { MessageKey, MessageParams } from "./i18n";

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
 * Who's who after the User says who speaks `line` (#138): that line alone, or with `all`, every
 * line by its Speaker now. A new name with `all` names that Speaker, unless it is the User, who
 * keeps "Me": then their lines go to a new Speaker. A line given back to its file's label keeps
 * no entry.
 */
export function withSpeakerChosen(
  speakers: TranscriptSpeakers | null,
  lines: readonly TranscriptLine[],
  line: TranscriptLine,
  choice: SpeakerChoice,
  all: boolean,
): TranscriptSpeakers {
  const before = speakers ?? { labels: {}, lines: {} };
  const after = { labels: { ...before.labels }, lines: { ...before.lines } };
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
    : [line];
  for (const each of moved) {
    const key = lineKey(each.startMs, each.label);
    if (to === each.label) delete after.lines[key];
    else put(after.lines, key, to);
  }
  return after;
}

/** The longest name or label kept: a person's name, not a paragraph. */
const MAX_SPEAKER_TEXT = 200;
/** More entries than a Transcript has lines, by far. */
const MAX_SPEAKER_ENTRIES = 50_000;
const LINE_KEY = /^\d{1,12} (.+)$/su;

const speakerText = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  value !== "" &&
  value.length <= MAX_SPEAKER_TEXT &&
  !/[\p{Cc}]/u.test(value);

/**
 * Who's who as it was stored or sent, keeping only the entries that hold, and how many didn't:
 * a name or label of 1 to 200 characters with no spaces around it and no control characters, a
 * line known as `lineKey` makes it, and no name for "Me", who is the User. Null when none holds.
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
    ([label, name]) => label !== SPEAKER_ME && speakerText(label) && speakerText(name),
  );
  const keptLines = lines.filter(
    ([key, label]) => speakerText(LINE_KEY.exec(key)?.[1]) && speakerText(label),
  );
  const shape =
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).every((key) => key === "labels" || key === "lines") &&
    keptLabels.length + keptLines.length <= MAX_SPEAKER_ENTRIES;
  const dropped =
    labels.length - keptLabels.length + lines.length - keptLines.length + (shape ? 0 : 1);
  if (!shape || keptLabels.length + keptLines.length === 0) return { speakers: null, dropped };
  return {
    speakers: {
      labels: Object.fromEntries(keptLabels) as Record<string, string>,
      lines: Object.fromEntries(keptLines) as Record<string, string>,
    },
    dropped,
  };
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
