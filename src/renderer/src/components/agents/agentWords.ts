/**
 * Words for Settings → Agents (#351), shared by its parts: an agent's name, how
 * it is set up, what came of setting it up, and a call in its activity list,
 * all in plain words (no "MCP", "stdio" or "token" outside the details).
 */
import {
  AGENT_CLIENT_IDS,
  type AgentActivity,
  type AgentClient,
  type AgentClientId,
  type AgentPairing,
  type AgentSetupResult,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { clientInSentence, clientTitle } from "../../../../shared/agentNames";
import { formatDateTime } from "../../../../shared/dates";
import { type MessageKey, type MessageParams, translate } from "../../../../shared/i18n";
import { unitsOf } from "../../../../shared/i18n/join";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** An agent's name: its own, or "Other agent". */
export const clientName = (client: Pick<AgentClient, "id" | "name">, t: Translate) =>
  clientTitle(client, t);

/**
 * What a sentence calls a connected agent: its name, or, while it still has the
 * name the list gave it, the words a sentence can hold ("your agent").
 */
export function pairingInSentence(
  pairing: Pick<AgentPairing, "name" | "client">,
  t: Translate,
): string {
  const client = pairing.client === "other" || pairing.client === "codex" ? pairing.client : null;
  if (client === null) return pairing.name;
  const listNames = (["en", "zh-CN"] as const).map((language) =>
    translate(language, client === "other" ? "agents.client.other" : "agents.client.codex"),
  );
  const isListName = listNames.some((listName) => {
    const rest = pairing.name.slice(listName.length);
    return pairing.name.startsWith(listName) && (rest === "" || /^ \d+$/.test(rest));
  });
  return isListName ? clientInSentence({ id: client, name: "" }, t) : pairing.name;
}

/** What an agent's row says it reads: its Folders by name, or that it reads none yet. */
export const readsLine = (names: readonly string[], t: Translate, language: Language): string =>
  names.length > 0
    ? t("agents.pairing.reads", { folders: unitsOf(names, language) })
    : t("agents.pairing.readsNothing");

/**
 * Where each agent that takes settings by hand has the User put them (#3374), in its own
 * screen's words, from its documentation (src/core/agents/clients.ts).
 */
const PASTE_WORDS = {
  devin: "agents.done.paste.devin",
  zed: "agents.done.paste.zed",
  trae: "agents.done.paste.trae",
  qoder: "agents.done.paste.qoder",
  codebuddy: "agents.done.paste.codebuddy",
  "minimax-code": "agents.done.paste.minimax-code",
  "kilo-code": "agents.done.paste.kilo-code",
} as const satisfies Partial<Record<AgentClientId, MessageKey>>;

const pasteWords = (client: string | null): MessageKey | null =>
  client !== null && Object.hasOwn(PASTE_WORDS, client)
    ? PASTE_WORDS[client as keyof typeof PASTE_WORDS]
    : null;

/** Whether the agent's screen asks for the command, arguments and environment one by one. */
export const takesParts = (client: string | null) => client === "other" || client === "kilo-code";

/** How connecting an agent goes, in a line under its name. */
export function setupWords(client: AgentClient, t: Translate): string {
  const agent = clientInSentence(client, t);
  switch (client.setup) {
    case "bundle":
      return t("agents.setup.bundle");
    case "link":
      return t("agents.setup.link", { agent });
    case "file":
      return t("agents.setup.file", { agent });
    case "command":
      return t("agents.setup.command");
    case "manual":
      if (client.id === "other") return t("agents.setup.other");
      return t(takesParts(client.id) ? "agents.setup.parts" : "agents.setup.paste", { agent });
  }
}

/** A line under an agent's setup, where its row has more to say. */
export function clientNote(client: Pick<AgentClient, "id">, t: Translate): string | null {
  if (client.id === "codex") return t("agents.note.codex");
  if (client.id === "gemini-cli") return t("agents.note.gemini-cli");
  return null;
}

/** What came of setting an agent up, as one line. */
export function doneWords(
  result: AgentSetupResult,
  pairing: Pick<AgentPairing, "name" | "client">,
  t: Translate,
): string {
  const agent = pairingInSentence(pairing, t);
  switch (result.kind) {
    case "opened":
      return result.how === "bundle" ? t("agents.done.bundle") : t("agents.done.link", { agent });
    case "wrote":
      return t("agents.done.wrote", { agent });
    case "copy":
      if (result.path) return t("agents.done.unreadable", { agent, path: result.path });
      if (result.how === "command") return t("agents.done.command");
      if (pairing.client === "other") return t("agents.done.settings.other");
      return t(pasteWords(pairing.client) ?? "agents.done.settings", { agent });
  }
}

/** A call in the activity list: what it did, and how many results, or why it didn't. */
export function activityWords(activity: AgentActivity, t: Translate): string {
  const text = activity.summary;
  const what = t(`agents.activity.${activity.tool}`, { text });
  if (activity.outcome !== "done") {
    const reason = t(`agents.reason.${activity.problem ?? "failed"}`);
    return `${what} · ${t(
      activity.outcome === "refused" ? "agents.activity.refused" : "agents.activity.failed",
      { reason },
    )}`;
  }
  if (
    activity.count === null ||
    activity.tool === "show_citation" ||
    activity.tool === "create_mind"
  ) {
    return what;
  }
  const counted =
    activity.tool === "propose_changes" ? "agents.activity.changes" : "agents.activity.count";
  const count = t(activity.count === 1 ? `${counted}.one` : `${counted}.other`, {
    count: activity.count,
  });
  return `${what} · ${count}`;
}

/** A time, as the activity list and "Last used" show it. */
export const timeWords = (at: string, language: Language) => formatDateTime(at, language);

/** Where the step-by-step help for an agent is: the setup notes, in the interface language. */
export const helpUrl = (client: AgentClientId | string, language: Language) =>
  `https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/${
    language === "zh-CN" ? "agents.zh-CN.md" : "agents.md"
  }#${(AGENT_CLIENT_IDS as readonly string[]).includes(client) ? client : "other"}`;
