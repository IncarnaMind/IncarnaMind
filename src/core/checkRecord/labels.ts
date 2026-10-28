import { SENTENCE_RESULT_LABELS } from "../../shared/claimChecks";
import { formatFullDateTime } from "../../shared/dates";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import type { CitationCheck, SignOffNow } from "../api";
import type { ModelDescription, ModelPlace } from "../chatModelNames";
import type { Language } from "../language";
import type { RecordItem, TextOrigin } from "./read";

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export const translatorFor =
  (language: Language): Translator =>
  (key, params) =>
    translate(language, key, params);

const CITATION_RESULTS: Readonly<Record<CitationCheck | "gone", MessageKey>> = {
  gone: "checkRecord.notInNote",
  found: "aiStatement.citations.found",
  "not-found": "aiStatement.citations.notFound",
  "cant-check": "aiStatement.citations.cantCheck",
  unsupported: "aiStatement.citations.unsupported",
  contradicted: "aiStatement.citations.contradicted",
  checking: "aiStatement.citations.checking",
};

/** A result's words are the AI use statement's, so one result has one name. */
export function resultKey(item: RecordItem): MessageKey {
  return item.kind === "sentence"
    ? SENTENCE_RESULT_LABELS[item.result]
    : CITATION_RESULTS[item.result];
}

export const ORIGIN_LABELS: Readonly<Record<TextOrigin, MessageKey>> = {
  user: "checkRecord.origin.user",
  ai: "checkRecord.origin.ai",
  other: "checkRecord.origin.other",
};

export const KIND_LABELS: Readonly<Record<RecordItem["kind"], MessageKey>> = {
  sentence: "checkRecord.kind.sentence",
  citation: "checkRecord.kind.citation",
};

export function placeText(place: ModelPlace, t: Translator): string {
  switch (place.kind) {
    case "service":
      return place.name;
    case "this-computer":
      return t("checkRecord.thisComputer");
    case "unknown":
      return t("checkRecord.notRecorded");
  }
}

export const modelLabel = ({ name, place }: ModelDescription, t: Translator): string =>
  t("checkRecord.modelAt", { name, place: placeText(place, t) });

/** Who made a check, and where: IncarnaMind for a Citation, a model for a sentence, nothing where no check ran. */
export function checkedBy(
  item: RecordItem,
  t: Translator,
): { name: string; place: string | null } | null {
  if (item.kind === "citation") {
    return { name: t("checkRecord.checker"), place: t("checkRecord.thisComputer") };
  }
  if (!item.check) return null;
  const { model } = item.check;
  return model
    ? { name: model.name, place: placeText(model.place, t) }
    : { name: t("checkRecord.notRecorded"), place: null };
}

/** A moment as the PDF writes it: always with its year, and in UTC so that wherever it is read it is the same time. */
export function recordTime(moment: string, language: Language, t: Translator): string {
  return t("checkRecord.time", {
    time: formatFullDateTime(moment, language, { timeZone: "UTC", twelveHour: false }),
  });
}

/**
 * A person's own check of an item (#1933), as the record says it: their name, when (`time` writes
 * it) and whether it changed since. Others read the record, so it names the person, never "you".
 */
export function personCheck(
  signOff: SignOffNow | null,
  time: (moment: string) => string,
  t: Translator,
): string | null {
  if (!signOff) return null;
  const params = { name: signOff.name ?? t("checkRecord.notRecorded"), time: time(signOff.at) };
  return t(
    signOff.state === "checked" ? "checkRecord.person" : "checkRecord.person.changed",
    params,
  );
}
