import type { DataKind } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";

/** Where a flow sends more under a kind than its usual words say. */
const FLOW_WORDS: Readonly<Record<string, Partial<Record<DataKind, MessageKey>>>> = {
  // During a recorded meeting a Question also goes with the newest of its transcript, whatever
  // it asks, and the text of the window the User chose to read (#144, ADR-0031).
  chat: { passages: "consent.data.chat.passages" },
};

/** Where an agent's own words for what a Note's conversation sends differ from Claude Code's (#3653). */
const CLIENT_WORDS: Readonly<Record<string, Partial<Record<DataKind, MessageKey>>>> = {
  codex: {
    "note-requests": "consent.data.note-requests.codex",
    "own-ai-context": "consent.data.own-ai-context.codex",
  },
};

/**
 * The words for what a flow sends of a kind, in Settings › Privacy and the consent dialog;
 * `client`: the agent a connected agent's service starts.
 */
export const dataKindKey = (flowId: string | null, kind: DataKind, client?: string): MessageKey =>
  (client === undefined ? undefined : CLIENT_WORDS[client]?.[kind]) ??
  (flowId === null ? undefined : FLOW_WORDS[flowId]?.[kind]) ??
  `consent.data.${kind}`;
