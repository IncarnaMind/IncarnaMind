/**
 * What became of a check or a summary handed to the User's own AI (#3587): one state, read by every
 * place that shows it, the Note's check badge and card and Get started's step. Asked: the request
 * waits for the User to send it in that AI. Working: since the ask, that connection called a Tool
 * about the Note or the Document, which the core tells the windows as it records each call, so
 * nothing polls the agent. Quiet: nothing from it for a while, and the words say how to ask again;
 * a later call makes it working again. It ends when what was asked for lands: the check's report,
 * or the Note the agent wrote; a check's ends too once a model is set up. An Organize's Suggestions
 * land instead (#3610): the Library's top says what came until the User opens the Review.
 */
import { create } from "zustand";
import type { AgentActivity, AgentPairing, ChatReadiness, OrganizeTarget } from "../../core/api";
import { core } from "./core";
import { useT } from "./i18n";
import { noModelSetUp } from "./noModelSetUp";
import { useAppStore } from "./store";

export type AskedFor =
  | { kind: "check"; mindId: string }
  | { kind: "summary"; documentId: string }
  | { kind: "organize"; target: OrganizeTarget };

export type AskedState = "asked" | "working" | "quiet" | "landed";

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

/** One Organize at a time, said at the Library's top wherever it was asked from. */
const ORGANIZE = "organize";

const keyOf = (asked: AskedFor) =>
  asked.kind === "check"
    ? `mind:${asked.mindId}`
    : asked.kind === "summary"
      ? `document:${asked.documentId}`
      : ORGANIZE;

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
  if (!asked || asked.state === "quiet" || asked.state === "landed") return;
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
  if (what.kind === "check")
    return activity.effects.some(
      ({ scope }) => scope.kind === "mind" && scope.mindId === what.mindId,
    );
  if (what.kind === "summary") return activity.documentIds.includes(what.documentId);
  return activity.tool === "list_sorting" || activity.tool === "propose_sorting";
};

/** For an Organize, its Suggestions came, or the list it read had nothing waiting in it. */
const landed = (activity: AgentActivity, asked: AgentAsked): boolean => {
  if (activity.outcome !== "done") return false;
  if (asked.for.kind === "check") return activity.tool === "report_check" && about(activity, asked);
  if (asked.for.kind === "summary") return activity.tool === "create_mind";
  return (
    activity.tool === "propose_sorting" ||
    (activity.tool === "list_sorting" && activity.documentIds.length === 0)
  );
};

function heard(activity: AgentActivity): void {
  for (const [key, asked] of Object.entries(useAgentAsked.getState().byKey)) {
    if (activity.pairingId !== asked.agent.id || activity.at < asked.at) continue;
    if (landed(activity, asked))
      put(key, asked.for.kind === "organize" ? { ...asked, seen: true, state: "landed" } : null);
    else if (asked.state !== "landed" && (asked.seen || about(activity, asked)))
      put(key, { ...asked, seen: true, state: "working" });
  }
}

const modelSetUp = (readiness: ChatReadiness | null): boolean =>
  readiness !== null && !noModelSetUp(readiness);

/**
 * A check stands asked of the User's own AI only while no model is set up: with one, the Note's
 * own Check runs it, and a report the AI sends after still lands its marks. A summary is the
 * User's own AI's either way.
 */
function forgetChecks({ chatReadiness }: { chatReadiness: ChatReadiness | null }): void {
  if (!modelSetUp(chatReadiness)) return;
  for (const [key, asked] of Object.entries(useAgentAsked.getState().byKey)) {
    if (asked.for.kind === "check") put(key, null);
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
    useAppStore.subscribe(forgetChecks);
  }
  if (asked.kind === "check" && modelSetUp(useAppStore.getState().chatReadiness)) return;
  put(keyOf(asked), { agent, for: asked, copied, state: "asked", at, seen: false });
}

/** Whether the User's own AI is asked to check this Note now, which its card's line says. */
export const checkAsked = (mindId: string): boolean =>
  useAgentAsked.getState().byKey[keyOf({ kind: "check", mindId })] !== undefined;

/** Another check of the Note took its place, such as one run by a model set up since. */
export function forgetAsked(asked: AskedFor): void {
  if (useAgentAsked.getState().byKey[keyOf(asked)]) put(keyOf(asked), null);
}

/** The Organize asked of the User's own AI, while the Library's top says it. */
export const useOrganizeAsked = (): AgentAsked | undefined =>
  useAgentAsked((state) => state.byKey[ORGANIZE]);

/** The User looked at what an Organize brought: from now on the Library's top counts it as any other. */
export function organizeSeen(): void {
  if (useAgentAsked.getState().byKey[ORGANIZE]?.state === "landed") put(ORGANIZE, null);
}

const WORKING = {
  check: "agents.asked.checking",
  summary: "agents.asked.writing",
  organize: "agents.asked.organizing",
} as const;

/**
 * What was asked of the User's own AI about this Note or Document, and what it says now: `words`
 * for a line, `short` for the check badge, which shares its row with the Ask pill; null for nothing,
 * and for an Organize whose Suggestions landed, which the Library's top says from them.
 */
export function useAskedAgent(
  asked: AskedFor | null,
): { asked: AgentAsked; words: string; short: string } | null {
  const t = useT();
  const key = asked ? keyOf(asked) : null;
  const now = useAgentAsked((state) => (key === null ? undefined : state.byKey[key]));
  if (!now || now.state === "landed") return null;
  const agent = now.agent.name;
  const words =
    now.state === "asked"
      ? t(now.copied ? "agents.asked.copied" : "agents.asked.opened", { agent })
      : now.state === "working"
        ? t(WORKING[now.for.kind], { agent })
        : t("agents.asked.quiet", { agent });
  return { asked: now, words, short: t(`agents.asked.short.${now.state}`) };
}
