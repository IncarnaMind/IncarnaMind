import type { Checkpoint, CheckpointReason } from "../../core/api";
import type { Language } from "../../core/language";
import { formatTime, formatWeekdayDate } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";

/** What History says of a Checkpoint: pure, so a test can pin the clock and the language. */

type Say = (key: MessageKey, params?: MessageParams) => string;

/** A Checkpoint saved just before the AI changed the Mind, marked with the spark: not a person's changes. */
export const beforeAiChange = (checkpoint: Pick<Checkpoint, "reason">): boolean =>
  checkpoint.reason !== "idle" &&
  checkpoint.reason !== "restore" &&
  checkpoint.reason !== "others" &&
  checkpoint.reason !== "export";

const REASONS: Readonly<Record<Exclude<CheckpointReason, "idle" | "export">, MessageKey>> = {
  accept: "history.reason.accept",
  regenerate: "history.reason.regenerate",
  enhance: "history.reason.enhance",
  compare: "history.reason.compare",
  others: "history.reason.others",
  restore: "history.reason.restore",
};

function why(checkpoint: Pick<Checkpoint, "reason" | "file">, say: Say): string | null {
  if (checkpoint.reason === "idle") return null;
  if (checkpoint.reason !== "export") return say(REASONS[checkpoint.reason]);
  const file = checkpoint.file ?? "";
  return say(/\.pdf$/i.test(file) ? "history.reason.export.pdf" : "history.reason.export.docx", {
    file,
  });
}

/**
 * What it is, after its time: the name the User gave it, then why it was saved, "before AI
 * edits" or "sent as Word · Credit paper.docx"; null for an unnamed idle one, which shows only
 * its time.
 */
export const reasonLabel = (
  checkpoint: Pick<Checkpoint, "reason" | "name" | "file">,
  say: Say,
): string | null =>
  [checkpoint.name, why(checkpoint, say)].filter((part) => part !== null).join(" · ") || null;

/** The day it was saved, as its group in the picker is headed: "Friday 9 Oct", with the year when it isn't this one. */
export const dayLabel = (iso: string, now: Date, language: Language): string =>
  formatWeekdayDate(iso, language, { now });

/** The time it was saved, "10:42". */
export const timeLabel = (iso: string, language: Language): string => formatTime(iso, language);

/** The version it is, "Friday 9 Oct, 10:42". */
export const versionLabel = (
  checkpoint: Pick<Checkpoint, "createdAt">,
  now: Date,
  language: Language,
  say: Say,
): string =>
  say("history.when", {
    day: dayLabel(checkpoint.createdAt, now, language),
    time: timeLabel(checkpoint.createdAt, language),
  });

/** Checkpoints, newest first, in groups by the day they were saved. */
export function byDay(
  checkpoints: readonly Checkpoint[],
  now: Date,
  language: Language,
): { day: string; checkpoints: Checkpoint[] }[] {
  const groups: { day: string; checkpoints: Checkpoint[] }[] = [];
  for (const checkpoint of checkpoints) {
    const day = dayLabel(checkpoint.createdAt, now, language);
    const last = groups.at(-1);
    if (last?.day === day) last.checkpoints.push(checkpoint);
    else groups.push({ day, checkpoints: [checkpoint] });
  }
  return groups;
}
