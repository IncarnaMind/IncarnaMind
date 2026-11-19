import type { AgentPairing } from "../../../core/api";
import { useAnswers } from "../answers";
import { askAgent } from "../askYourAi";
import { AskAgentLine } from "../components/AskAgentLine";
import { composerKey, useComposer } from "../composer";
import { useT } from "../i18n";
import { chooseModelInPlace } from "../modelSetup";

/**
 * A Question pressed with no model in IncarnaMind and the User's own AI connected (#3373): in
 * place of the setup card, one line above the box offers that AI the words, which stay in the box.
 * Its Ask takes the focus, so a second Enter asks it; Set up a model brings the setup card.
 */
export function ComposerAskAgent({
  agents,
  draftKey,
  mindId,
}: {
  agents: readonly AgentPairing[];
  draftKey: string;
  mindId: string | null;
}) {
  const t = useT();
  const done = () => useAnswers.getState().dismiss(composerKey(mindId));
  const ask = async (agent: AgentPairing) => {
    const text = useComposer.getState().draft(draftKey).text.trim();
    const what = text
      ? ({ kind: "question", text } as const)
      : mindId
        ? ({ kind: "note" } as const)
        : null;
    if (!what || !(await askAgent(agent, mindId, what))) return;
    if (text) useComposer.getState().update(draftKey, { text: "" });
    done();
  };
  return (
    <AskAgentLine
      agents={agents}
      label={(agent) => t("agents.ask.action", { agent })}
      onAsk={(agent) => void ask(agent)}
      setUp={{
        label: t("agents.ask.setUpModel"),
        testId: "composer-ask-agent-set-up",
        onClick: () => {
          done();
          chooseModelInPlace();
        },
      }}
      testId="composer-ask-agent"
      className="composer-problem"
      focusAsk
    />
  );
}
