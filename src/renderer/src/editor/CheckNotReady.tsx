import type { AgentPairing, ChatReadiness } from "../../../core/api";
import { askAgent, useAgentsToAskRead, useReadAgentsToAsk } from "../askYourAi";
import { dismissCheckProblem } from "../checks";
import { AskAgentLine } from "../components/AskAgentLine";
import { ProblemLine } from "../components/ProblemLine";
import {
  ReadinessExplanation,
  readinessAction,
  readinessAlso,
} from "../components/providers/ChatReadinessNotice";
import { useT } from "../i18n";
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
  const dismiss = () => dismissCheckProblem(mindId);
  const setUp = readinessAction(readiness, t, openSettings, t("question.setUp"), dismiss);
  const noModel = readiness.reason === "no-provider";
  // Until the agents are read the line holds its place, empty, so the card's height is right when
  // it comes.
  if (noModel && agents === null) return <p className="mind-health-line">{"\u00A0"}</p>;
  if (noModel && agents !== null && agents.length > 0) {
    const ask = async (agent: AgentPairing) => {
      if (await askAgent(agent, mindId, { kind: "check" })) dismiss();
    };
    return (
      <AskAgentLine
        agents={agents}
        label={(agent) => t("agents.ask.action", { agent })}
        onAsk={(agent) => void ask(agent)}
        setUp={{ ...setUp, label: t("agents.ask.setUpModel"), testId: "checks-ask-agent-set-up" }}
        testId="checks-ask-agent"
        className="mind-health-line"
      />
    );
  }
  return (
    <ProblemLine
      testId="checks-problem"
      className="mind-health-line"
      action={setUp}
      also={readinessAlso(readiness, t, openSettings, dismiss)}
    >
      {noModel ? (
        t("checks.problem.no-provider")
      ) : (
        <ReadinessExplanation readiness={readiness} inLine />
      )}
    </ProblemLine>
  );
}
