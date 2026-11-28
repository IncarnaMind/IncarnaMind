import type { MessageKey, MessageParams } from "./i18n/types";

/** An agent's name in the interface language: the ones with words of their own, else its own name. */
export function clientTitle(
  client: { id: string; name: string },
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  if (client.id === "other") return t("agents.client.other");
  if (client.id === "codex") return t("agents.client.codex");
  return client.name;
}

/**
 * An agent's name inside a sentence ("Let your agent read…"), where its list name
 * ("Other agent") would not read as one.
 */
export function clientInSentence(
  client: { id: string; name: string },
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  if (client.id === "other") return t("agents.sentence.other");
  if (client.id === "codex") return t("agents.sentence.codex");
  return client.name;
}
