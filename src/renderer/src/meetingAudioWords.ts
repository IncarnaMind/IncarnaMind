import type { Meeting } from "../../core/api";
import type { Language } from "../../core/language";
import {
  type DateOptions,
  daysAfter,
  formatDateTime,
  formatShortDate,
  formatTime,
} from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { useMinuteClock } from "./minuteClock";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * Until when a Meeting's audio stays on this computer, as its lines say it (#687). `passed`: its
 * time has come and the sweep hasn't deleted it yet.
 */
type AudioStay =
  | { kind: "deleted"; date: string }
  | { kind: "none" }
  | { kind: "untilDeleted" }
  | { kind: "dayAfter" }
  | { kind: "today" | "tomorrow"; time: string; passed: boolean }
  | { kind: "later"; dateTime: string };

/** Every time comes from ../../shared/dates. */
function audioStay(meeting: Meeting, language: Language, options: DateOptions = {}): AudioStay {
  const now = options.now ?? new Date();
  const dates = { ...options, now };
  const { audio } = meeting;
  if (!audio.kept) {
    return audio.deletedAt
      ? { kind: "deleted", date: formatShortDate(audio.deletedAt, language, dates) }
      : { kind: "none" };
  }
  if (audio.keptUntilDeleted) return { kind: "untilDeleted" };
  if (audio.expiresAt === null) return { kind: "dayAfter" };
  const time = formatTime(audio.expiresAt, language, dates);
  const passed = Date.parse(audio.expiresAt) <= now.getTime();
  switch (daysAfter(audio.expiresAt, now)) {
    case 0:
      return { kind: "today", time, passed };
    case 1:
      return { kind: "tomorrow", time, passed };
    default:
      return { kind: "later", dateTime: formatDateTime(audio.expiresAt, language, dates) };
  }
}

/**
 * What a Meeting's audio line says (#687): until when its audio is kept, that it is kept until the
 * User deletes it, or when it was deleted.
 */
export function audioSaid(
  meeting: Meeting,
  t: Translate,
  language: Language,
  options: DateOptions = {},
): string {
  const stay = audioStay(meeting, language, options);
  switch (stay.kind) {
    case "deleted":
      return t("meetings.audio.deletedOn", { date: stay.date });
    case "none":
      return t("meetings.audio.none");
    case "untilDeleted":
      return t("meetings.audio.keptForGood");
    case "dayAfter":
      return t("meetings.audio.keptWhile");
    case "today":
      return t("meetings.audio.keptUntilToday", { time: stay.time });
    case "tomorrow":
      return t("meetings.audio.keptUntilTomorrow", { time: stay.time });
    case "later":
      return t("meetings.audio.keptUntilShort", { time: stay.dateTime });
  }
}

/** `audioSaid` as the window shows it: read again every minute, so "today" turns over at midnight. */
export function useAudioSaid(meeting: Meeting, t: Translate, language: Language): string {
  return audioSaid(meeting, t, language, { now: useMinuteClock() });
}

/**
 * The line of a stopped Meeting whose Transcript stopped before its end (#2957): it says the
 * recording is kept only while the audio is, and until when, as the audio line does. Audio gone,
 * or whose time has come, gets the plain line, which promises nothing of it.
 */
export function stoppedBeforeEndSaid(
  meeting: Meeting,
  t: Translate,
  language: Language,
  options: DateOptions = {},
): string {
  const stay = audioStay(meeting, language, options);
  switch (stay.kind) {
    case "untilDeleted":
      return t("meetings.transcript.stoppedBeforeEnd");
    case "today":
    case "tomorrow":
      if (stay.passed) return t("meetings.transcript.engineStopped");
      return stay.kind === "today"
        ? t("meetings.transcript.stoppedBeforeEndToday", { time: stay.time })
        : t("meetings.transcript.stoppedBeforeEndTomorrow", { time: stay.time });
    default:
      return t("meetings.transcript.engineStopped");
  }
}

/** `stoppedBeforeEndSaid` as the window shows it: read again every minute, as the audio line is. */
export function useStoppedBeforeEndSaid(
  meeting: Meeting,
  t: Translate,
  language: Language,
): string {
  return stoppedBeforeEndSaid(meeting, t, language, { now: useMinuteClock() });
}

/** Keep audio is offered while the audio is on this computer and would go a day after. */
export const canKeepAudio = (meeting: Meeting) =>
  meeting.audio.kept && !meeting.audio.keptUntilDeleted;
