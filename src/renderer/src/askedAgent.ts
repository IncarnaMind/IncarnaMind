/**
 * What became of a check or a summary handed to the User's own AI (#3587): one state, read by every
 * place that shows it, the Note's check badge and card and Get started's step. Asked: the request
 * waits for the User to send it in that AI. Working: since the ask, that connection called a Tool
 * about the Note or the Document, which the core tells the windows as it records each call, so
 * nothing polls the agent. Quiet: nothing from it for a while, and the words say how to ask again;
 * a later call makes it working again. It ends when what was asked for lands: the check's report,
 * or the Note the agent wrote.
 */
import { create } from "zustand";
import type { AgentActivity, AgentPairing } from "../../core/api";
import { core } from "./core";
import { useT } from "./i18n";

export type AskedFor = { kind: "check"; mindId: string } | { kind: "summary"; documentId: string };

export type AskedState = "asked" | "working" | "quiet";

export interface AgentAsked {
  agent: AgentPairing;
  for: AskedFor;
  /** The request was copied for the User to paste, not typed in the agent's app. */
  copied: boolean;
  state: AskedState;
  /** ISO 8601, UTC: a call before it isn't about this request. */
  at: string;
  /** Whether a call about it came: from then on, any call of that connection says it is still at work. */
  seen: boolean;
}

/**
 * How long nothing from the agent reads as quiet: room to switch apps and send the request, and for
 * a model to think between two calls while it writes a long report.
 */
export const QUIET_AFTER_MS = 3 * 60_000;

const keyOf = (asked: AskedFor) =>
  asked.kind === "check" ? `mind:${asked.mindId}` : `document:${asked.documentId}`;

export const useAgentAsked = create<{ byKey: Readonly<Record<string, AgentAsked>> }>()(() => ({
  byKey: {},
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let listening = false;

function put(key: string, asked: AgentAsked | null): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
  useAgentAsked.setState(({ byKey }) => {
    const next = { ...byKey };
    if (asked) next[key] = asked;
    else delete next[key];
    return { byKey: next };
  });
  if (!asked || asked.state === "quiet") return;
  timers.set(
    key,
    setTimeout(() => {
      const now = useAgentAsked.getState().byKey[key];
      if (now) put(key, { ...now, state: "quiet" });
    }, QUIET_AFTER_MS),
  );
}

const about = (activity: AgentActivity, asked: AgentAsked): boolean => {
  const what = asked.for;
  return what.kind === "check"
    ? activity.effects.some(({ scope }) => scope.kind === "mind" && scope.mindId === what.mindId)
    : activity.documentIds.includes(what.documentId);
};

const landed = (activity: AgentActivity, asked: AgentAsked): boolean =>
  activity.outcome === "done" &&
  (asked.for.kind === "check"
    ? activity.tool === "report_check" && about(activity, asked)
    : activity.tool === "create_mind");

function heard(activity: AgentActivity): void {
  for (const [key, asked] of Object.entries(useAgentAsked.getState().byKey)) {
    if (activity.pairingId !== asked.agent.id || activity.at < asked.at) continue;
    if (landed(activity, asked)) put(key, null);
    else if (asked.seen || about(activity, asked))
      put(key, { ...asked, seen: true, state: "working" });
  }
}

/** The request went to `agent`: the place it is about says so from now. */
export function rememberAsked(
  agent: AgentPairing,
  asked: AskedFor,
  { copied, at }: { copied: boolean; at: string },
): void {
  if (!listening) {
    listening = true;
    core.on("agents.activity", heard);
  }
  put(keyOf(asked), { agent, for: asked, copied, state: "asked", at, seen: false });
}

/** Another check of the Note took its place, such as one run by a model set up since. */
export function forgetAsked(asked: AskedFor): void {
  if (useAgentAsked.getState().byKey[keyOf(asked)]) put(keyOf(asked), null);
}

/** What was asked of the User's own AI about this Note or Document, and what it says now; null for nothing. */
export function useAskedAgent(asked: AskedFor | null): { asked: AgentAsked; words: string } | null {
  const t = useT();
  const key = asked ? keyOf(asked) : null;
  const now = useAgentAsked((state) => (key === null ? undefined : state.byKey[key]));
  if (!now) return null;
  const agent = now.agent.name;
  const words =
    now.state === "asked"
      ? t(now.copied ? "agents.asked.copied" : "agents.asked.opened", { agent })
      : now.state === "working"
        ? t(now.for.kind === "check" ? "agents.asked.checking" : "agents.asked.writing", { agent })
        : t("agents.asked.quiet", { agent });
  return { asked: now, words };
}
