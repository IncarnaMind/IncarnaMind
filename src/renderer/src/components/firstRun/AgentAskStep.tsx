import type { AgentPairing } from "../../../../core/api";
import { quotedName } from "../../../../shared/naming";
import type { SummaryDocument } from "../../agentNote";
import type { AgentAsked } from "../../askedAgent";
import { useT } from "../../i18n";
import { OtherAgents } from "../AskAgentLine";
import { buttonStyle } from "../ui";

/** What the card's ask step offers: a line with Ask, or one sentence and the way to what it lacks (#3572). */
export type AskStep = "reading" | "ask" | "add" | "share" | "reconnect";

/**
 * `askers`: the agents that can be asked about the Document the step names; `connected`: those
 * that can be asked at all now. Null until they are first read.
 */
export function askStepOf(
  summary: SummaryDocument,
  askers: readonly AgentPairing[] | null,
  connected: readonly AgentPairing[] | null,
): AskStep {
  if (summary.kind === "none") return "add";
  if (summary.kind === "named") return askers !== null && askers.length > 0 ? "ask" : "reading";
  if (summary.kind === "unshared") {
    if (connected === null) return "reading";
    return connected.length === 0 ? "reconnect" : "share";
  }
  return "reading";
}

const WORDS = {
  add: "firstOpen.agent.noDocument",
  share: "firstOpen.agent.unshared",
  reconnect: "meetings.notesAgent.unavailable",
} as const;

export function AgentAskStep({
  step,
  summary,
  askers,
  asked,
  live,
  onAsk,
  onAdd,
  onSettings,
}: {
  step: AskStep;
  summary: SummaryDocument;
  askers: readonly AgentPairing[] | null;
  /** What became of the ask, in the words the Note's check badge uses for its own (#3587). */
  asked: { asked: AgentAsked; words: string } | null;
  /** Only the card the User sees carries test ids: the unseen states only hold its height. */
  live: boolean;
  onAsk(agent: AgentPairing): void;
  onAdd(): void;
  onSettings(): void;
}) {
  const t = useT();
  const only = (testId: string) => (live ? testId : undefined);
  if (step === "add" || step === "share" || step === "reconnect") {
    const add = step === "add";
    return (
      <div className="flex flex-col items-start gap-2">
        <p
          data-testid={only("first-open-agent-lacking")}
          className="text-[13px] leading-5 text-ink-secondary"
        >
          {t(WORDS[step])}
        </p>
        <button
          type="button"
          data-testid={only(add ? "first-open-agent-add" : "first-open-agent-settings")}
          onClick={add ? onAdd : onSettings}
          className={buttonStyle("secondary", "sm")}
        >
          {t(add ? "startGuide.documents.addFiles" : "meetings.notesAgent.settings")}
        </button>
      </div>
    );
  }
  // Once asked, the agent asked leads with Ask again; the others stay behind the ⌄.
  const lead = asked?.asked.agent;
  const [first, ...others] = lead
    ? [lead, ...(askers ?? []).filter((each) => each.id !== lead.id)]
    : (askers ?? []);
  const line =
    summary.kind === "named"
      ? t("firstOpen.agent.line", { document: quotedName(summary.document.name) })
      : " ";
  return (
    <div className="flex items-start gap-2 rounded-md bg-chip py-1.5 pr-1.5 pl-2.5">
      {/* The line and what became of its ask share one place, as tall as the taller of the two. */}
      <p className="grid min-w-0 flex-1 py-1 text-[13px] leading-5 text-ink select-text">
        <span
          data-testid={asked ? undefined : only("first-open-agent-line")}
          aria-hidden={asked ? true : undefined}
          className={`col-start-1 row-start-1 ${asked ? "invisible" : ""}`}
        >
          {line}
        </span>
        {asked && (
          <span
            role="status"
            data-testid={only("first-open-agent-asked")}
            data-state={asked.asked.state}
            className="col-start-1 row-start-1"
          >
            {asked.words}
          </span>
        )}
      </p>
      {step === "ask" && first && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid={only("first-open-agent-ask")}
            onClick={() => onAsk(first)}
            className={buttonStyle("secondary", "sm")}
          >
            {lead ? t("agents.asked.again") : t("agents.ask.action", { agent: first.name })}
          </button>
          {others.length > 0 && (
            <OtherAgents
              agents={others}
              label={(name) => t("agents.ask.action", { agent: name })}
              onAsk={onAsk}
              testId={live ? "first-open-agent" : "first-open-agent-unseen"}
              className="h-7 text-ink-meta hover:bg-hover hover:text-ink"
            />
          )}
        </span>
      )}
    </div>
  );
}
