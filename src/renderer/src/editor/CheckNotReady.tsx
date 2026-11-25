import type { AgentPairing, ChatReadiness } from "../../../core/api";
import { checkInBackground, useAskedAgent } from "../askedAgent";
import { askAgent, useAgentsToAskRead, useReadAgentsToAsk } from "../askYourAi";
import { dismissCheckProblem } from "../checks";
import { installClaudeCodeFromEntry, useClaudeCodeInstallAvailability } from "../claudeCodeInstall";
import { AskAgentLine } from "../components/AskAgentLine";
import { ProblemLine } from "../components/ProblemLine";
import {
  ReadinessExplanation,
  readinessAction,
  readinessAlso,
} from "../components/providers/ChatReadinessNotice";
import { buttonStyle } from "../components/ui";
import { useT } from "../i18n";
import { noModelSetUp } from "../noModelSetUp";
import { useAppStore } from "../store";

/**
 * Why a Check gave no marks while no model can run it, in the Note's card, which every Check
 * (the card's, the Note's bar, ⌘K) ends in (#3533). With no model set up and the User's own AI
 * connected, that AI is asked to check the Note, as it is asked in the chat box (#3373); with none,
 * the line says what a check needs.
 */
export function CheckNotReady({
  mindId,
  readiness,
}: {
  mindId: string;
  readiness: Extract<ChatReadiness, { ready: false }>;
}) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  useReadAgentsToAsk(mindId);
  const agents = useAgentsToAskRead(mindId);
  const installAvailability = useClaudeCodeInstallAvailability();
  const dismiss = () => dismissCheckProblem(mindId);
  const setUp = readinessAction(readiness, t, openSettings, t("question.setUp"), dismiss);
  const noModel = readiness.reason === "no-provider";
  // Until the agents are read the line holds its place, empty, so the card's height is right when
  // it comes.
  if (noModel && agents === null) return <p className="mind-health-line">{"\u00A0"}</p>;
  if (noModel && agents !== null && agents.length > 0) {
    const ask = async (agent: AgentPairing, openChat = false) => {
      if (await askAgent(agent, mindId, { kind: "check" }, undefined, { openChat })) dismiss();
    };
    return (
      <AskAgentLine
        agents={agents}
        label={(agent) => t("agents.ask.action", { agent })}
        onAsk={(agent) => void ask(agent)}
        onContinue={(agent) => void ask(agent, true)}
        testId="checks-ask-agent"
        className="mind-health-line"
      />
    );
  }
  if (noModel) {
    const offerInstall =
      installAvailability?.supported === true && !installAvailability.cliAgentPresent;
    const connectAi = {
      label: t("agents.install.connectYourAi"),
      testId: "checks-connect-ai",
      onClick: () => {
        dismiss();
        openSettings("ai");
      },
    };
    if (!offerInstall) {
      return (
        <ProblemLine testId="checks-problem" className="mind-health-line" action={connectAi}>
          {t("checks.problem.no-provider")}
        </ProblemLine>
      );
    }
    return (
      <div
        data-testid="checks-problem"
        role="status"
        className="mind-health-line flex flex-col gap-2"
      >
        <p className="font-semibold text-ink">{t("checks.problem.no-provider")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="checks-install-claude-code"
            onClick={() => {
              dismiss();
              installClaudeCodeFromEntry();
            }}
            className={buttonStyle("primary", "sm")}
          >
            {t("agents.install.action")}
          </button>
          <button
            type="button"
            data-testid="checks-connect-ai"
            onClick={connectAi.onClick}
            className={buttonStyle("secondary", "sm")}
          >
            {connectAi.label}
          </button>
        </div>
        <p className="text-[11.5px] leading-4 text-ink-meta">{t("agents.install.disclosure")}</p>
      </div>
    );
  }
  return (
    <ProblemLine
      testId="checks-problem"
      className="mind-health-line"
      action={setUp}
      also={readinessAlso(readiness, t, openSettings, dismiss)}
    >
      <ReadinessExplanation readiness={readiness} inLine />
    </ProblemLine>
  );
}

/**
 * The Note's card while the User's own AI is asked to check it (#3587): what became of the request,
 * in the words the badge says, then Ask again, Continue in the open chat and the other AIs behind
 * its ⌄. The User's own AI is the way the card checks, so it offers no model to set up (#3756).
 */
export function AskedCheckLine({ mindId }: { mindId: string }) {
  const t = useT();
  const readiness = useAppStore((state) => state.chatReadiness);
  const asked = useAskedAgent({ kind: "check", mindId });
  useReadAgentsToAsk(mindId);
  const agents = useAgentsToAskRead(mindId);
  if (!asked || !noModelSetUp(readiness)) return null;
  const { agent, background, state } = asked.asked;
  const others = (agents ?? []).filter((each) => each.id !== agent.id);
  // While it runs in the background, the one thing to do is stop it (#3606): the badge above says
  // it is checking, and Stop takes Check's place in the card's foot, so the words here are only for
  // a screen reader (#3756).
  if (background && state === "working") {
    return (
      <span role="status" data-testid="checks-asked" data-state={state} className="sr-only">
        {asked.words}
      </span>
    );
  }
  // A run stopped for what it showed opens the check in the agent's app, as its line says (#3639).
  const byLink =
    background && ["outside", "unreadable"].includes(asked.asked.problem?.problem ?? "");
  // An agent that can run it in the background does so again; any other is asked by its link.
  const ask = async (each: AgentPairing) => {
    if ((byLink && each.id === agent.id) || !(await checkInBackground(mindId, each.id)))
      await askAgent(each, mindId, { kind: "check" });
  };
  return (
    <div className="mind-health-line">
      <p role="status" data-testid="checks-asked" data-state={state}>
        {asked.words}
      </p>
      <AskAgentLine
        agents={[agent, ...others]}
        label={(name) =>
          name !== agent.name || byLink
            ? t("agents.ask.action", { agent: name })
            : t(background ? "agents.asked.checkAgain" : "agents.asked.again")
        }
        onAsk={(each) => void ask(each)}
        onContinue={(each) =>
          void askAgent(each, mindId, { kind: "check" }, undefined, { openChat: true })
        }
        testId="checks-asked-line"
      />
    </div>
  );
}
