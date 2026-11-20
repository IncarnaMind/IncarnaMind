import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { AgentPairing } from "../../../core/api";
import { askAgent, useAgentsToAsk } from "../askYourAi";
import { buttonStyle } from "../components/ui";
import { useLanguage, useT } from "../i18n";
import { askedSentences } from "../unsupportedFixes";

/**
 * Whom to ask to fix every sentence of the Note that needs a look, in one request to the User's own
 * AI (#3419), and how many there are: null with no agent to ask, or fewer than two to ask about, which
 * a claim card's own Ask covers. `editable`: only while the Note can be written.
 */
export function useAskAll(
  editor: Editor,
  mindId: string,
  editable: boolean,
): { agent: AgentPairing; count: number } | null {
  const [agent] = useAgentsToAsk(mindId);
  const count = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      agent && (!editable || current.isEditable) ? askedSentences(current).length : 0,
  });
  return agent && count >= 2 ? { agent, count } : null;
}

/** "Ask {agent} to fix N": the sentences that need a look go to the agent in one request. */
export function AskAgentAllButton({
  editor,
  mindId,
  ask,
  primary,
  disabled,
  onAsked,
}: {
  editor: Editor;
  mindId: string;
  ask: { agent: AgentPairing; count: number };
  primary: boolean;
  disabled: boolean;
  onAsked(): void;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <button
      type="button"
      data-testid="badge-ask-agent-all"
      disabled={disabled}
      className={buttonStyle(primary ? "primary" : "secondary", "sm")}
      onClick={() => {
        const sentences = askedSentences(editor);
        if (sentences.length === 0) return;
        void askAgent(ask.agent, mindId, { kind: "fix", sentences });
        onAsked();
      }}
    >
      {t("agents.ask.fixAll", {
        agent: ask.agent.name,
        count: new Intl.NumberFormat(language).format(ask.count),
      })}
    </button>
  );
}
