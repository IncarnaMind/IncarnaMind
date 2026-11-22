import type { DataKind } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";

/** Where a flow sends more under a kind than its usual words say. */
const FLOW_WORDS: Readonly<Record<string, Partial<Record<DataKind, MessageKey>>>> = {
  // During a recorded meeting a Question also goes with the newest of its transcript, whatever
  // it asks, and the text of the window the User chose to read (#144, ADR-0031).
  chat: { passages: "consent.data.chat.passages" },
};

/** The words for what a flow sends of a kind, in Settings › Privacy and the consent dialog. */
export const dataKindKey = (flowId: string, kind: DataKind): MessageKey =>
  FLOW_WORDS[flowId]?.[kind] ?? `consent.data.${kind}`;
