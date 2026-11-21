import type { AgentPairing } from "../../../../core/api";
import { quotedName } from "../../../../shared/naming";
import type { SummaryDocument } from "../../agentNote";
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
  live,
  onAsk,
  onAdd,
  onSettings,
}: {
  step: AskStep;
  summary: SummaryDocument;
  askers: readonly AgentPairing[] | null;
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
  const [first, ...others] = askers ?? [];
  return (
    <div className="flex items-start gap-2 rounded-md bg-chip py-1.5 pr-1.5 pl-2.5">
      <p
        data-testid={only("first-open-agent-line")}
        className="min-w-0 flex-1 py-1 text-[13px] leading-5 text-ink select-text"
      >
        {summary.kind === "named"
          ? t("firstOpen.agent.line", { document: quotedName(summary.document.name) })
          : " "}
      </p>
      {step === "ask" && first && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid={only("first-open-agent-ask")}
            onClick={() => onAsk(first)}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.ask.action", { agent: first.name })}
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
