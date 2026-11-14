/**
 * A figure a check left Not checked because it reads more than one way (#3088): the figure as the
 * sentence writes it, and what each reading means, in the sentence's own spacing. A not-checked
 * result keeps it as its detail, and its card names both.
 */
export interface TwoReadings {
  shown: string;
  readings: readonly string[];
}

export const twoReadingsDetail = (figure: TwoReadings): string => JSON.stringify(figure);

/** The figure and readings a not-checked result's detail names; null when it names fewer than two. */
export function twoReadingsOf(detail: string | null): TwoReadings | null {
  let read: Partial<Record<keyof TwoReadings, unknown>>;
  try {
    read = JSON.parse(detail ?? "") ?? {};
  } catch {
    return null;
  }
  const { shown, readings } = read;
  if (
    typeof shown !== "string" ||
    !Array.isArray(readings) ||
    readings.length < 2 ||
    !readings.every((each): each is string => typeof each === "string")
  )
    return null;
  return { shown, readings };
}
