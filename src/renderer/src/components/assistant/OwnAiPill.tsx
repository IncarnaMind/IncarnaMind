import { askOnPill } from "../../askYourAi";
import { shortcutLabel } from "../../commands/keymap";
import { useT } from "../../i18n";
import { type OwnAiPill as Pill, setUpModelInstead } from "../../ownAiPanel";
import { OtherAgents } from "../AskAgentLine";

/**
 * The Ask pill for a User with only their own AI, the assistant out of sight (#3373, #3612): "Ask
 * {agent}" with ⌘J asks it about the Note at whose foot it stands, where the User types their
 * question; its ⌄ holds the others, as the card offers them, and last IncarnaMind's own model,
 * set up in Settings.
 */
export function OwnAiPill(pill: Pill) {
  const { agents } = pill;
  const t = useT();
  const [first, ...others] = agents;
  if (!first) return null;
  const label = (agent: string) => t("agents.ask.pill", { agent });
  return (
    <div
      data-testid="own-ai-pill"
      data-ask-pill=""
      className="flex h-10 max-w-full items-center gap-1 rounded-full bg-sheet pr-2 font-sans text-[14px] text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong),0_4px_16px_var(--color-shadow-soft)]"
    >
      <button
        type="button"
        data-testid="own-ai-pill-ask"
        onClick={() => void askOnPill(first, pill)}
        className="flex h-full min-w-0 items-center gap-3 rounded-full pr-1 pl-5 hover:text-ink focus-visible:outline-offset-[-2px]"
      >
        <span className="truncate">{label(first.name)}</span>
        <kbd className="rounded-sm bg-chip px-[5px] py-px font-sans text-[12px] text-ink-strong">
          {shortcutLabel("composer.focus")}
        </kbd>
      </button>
      <OtherAgents
        agents={others}
        label={label}
        onAsk={(agent) => void askOnPill(agent, pill)}
        onContinue={() => void askOnPill(first, pill, true)}
        testId="own-ai-pill"
        className="h-6 hover:bg-hover hover:text-ink"
        name={t("agents.ask.more")}
        foot={{
          label: t("agents.ask.useModel"),
          testId: "own-ai-pill-use-model",
          onClick: setUpModelInstead,
        }}
      />
    </div>
  );
}
