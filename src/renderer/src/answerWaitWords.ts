import type { Translate } from "./objects";

const SILENT_MS = 15_000;
let silentMs = SILENT_MS;

/** How long an Answer may be silent before its line says how long it usually takes; test builds shorten it. */
export const setSilentWaitMs = (ms: number): void => {
  silentMs = ms;
};

export const silentWaitMs = (): number => silentMs;

type Measure =
  | { kind: "seconds"; count: number }
  | { kind: "minute" }
  | { kind: "minutes"; count: number };

/** The usual wait in the rough measures people say; null when it is shorter than the wait so far. */
const measureOf = (usualSeconds: number | null): Measure | null => {
  if (usualSeconds === null || usualSeconds * 1000 <= silentMs) return null;
  const tens = Math.round(usualSeconds / 10) * 10;
  if (tens < 60) return { kind: "seconds", count: tens };
  const minutes = Math.round(usualSeconds / 60);
  return minutes <= 1 ? { kind: "minute" } : { kind: "minutes", count: minutes };
};

/**
 * The wait part of an Answer's step line (#2530), with the model's name: how
 * long it usually takes; null when there is none worth saying, or no model to
 * name.
 */
export function waitText(
  t: Translate,
  usualSeconds: number | null,
  model: string | null,
): string | null {
  const measure = measureOf(usualSeconds);
  if (measure === null || model === null) return null;
  switch (measure.kind) {
    case "seconds":
      return t("answer.wait.usually.seconds", { count: measure.count, model });
    case "minute":
      return t("answer.wait.usually.minute", { model });
    case "minutes":
      return t("answer.wait.usually.minutes", { count: measure.count, model });
  }
}

/** The same without the model's name, for a line too narrow for the whole part (#2531). */
export function waitTextShort(t: Translate, usualSeconds: number | null): string | null {
  const measure = measureOf(usualSeconds);
  if (measure === null) return null;
  switch (measure.kind) {
    case "seconds":
      return t("answer.wait.usually.secondsShort", { count: measure.count });
    case "minute":
      return t("answer.wait.usually.minuteShort");
    case "minutes":
      return t("answer.wait.usually.minutesShort", { count: measure.count });
  }
}
