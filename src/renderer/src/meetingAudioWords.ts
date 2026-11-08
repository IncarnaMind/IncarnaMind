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

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * What a Meeting's audio line says (#687): until when its audio is kept, that it is kept until the
 * User deletes it, or when it was deleted. Every time comes from ../../shared/dates.
 */
export function audioSaid(
  meeting: Meeting,
  t: Translate,
  language: Language,
  options: DateOptions = {},
): string {
  const now = options.now ?? new Date();
  const dates = { ...options, now };
  const { audio } = meeting;
  if (!audio.kept) {
    return audio.deletedAt
      ? t("meetings.audio.deletedOn", {
          date: formatShortDate(audio.deletedAt, language, dates),
        })
      : t("meetings.audio.none");
  }
  if (audio.keptUntilDeleted) return t("meetings.audio.keptForGood");
  if (audio.expiresAt === null) return t("meetings.audio.keptWhile");
  const time = formatTime(audio.expiresAt, language, dates);
  switch (daysAfter(audio.expiresAt, now)) {
    case 0:
      return t("meetings.audio.keptUntilToday", { time });
    case 1:
      return t("meetings.audio.keptUntilTomorrow", { time });
    default:
      return t("meetings.audio.keptUntilShort", {
        time: formatDateTime(audio.expiresAt, language, dates),
      });
  }
}

/** Keep audio is offered while the audio is on this computer and would go a day after. */
export const canKeepAudio = (meeting: Meeting) =>
  meeting.audio.kept && !meeting.audio.keptUntilDeleted;
