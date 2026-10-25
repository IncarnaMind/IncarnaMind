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

export const speakerKey = (speaker: string): MessageKey | null => KEYS[speaker] ?? null;

export function speakerName(
  speaker: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const key = speakerKey(speaker);
  if (key) return t(key);
  const numbered = THEIRS.exec(speaker) ?? ROOM.exec(speaker);
  return numbered ? t("transcript.speaker.numbered", { n: numbered[1] as string }) : speaker;
}
