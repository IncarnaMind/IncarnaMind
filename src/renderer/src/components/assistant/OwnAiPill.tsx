import { askAgent } from "../../askYourAi";
import { shortcutLabel } from "../../commands/keymap";
import { useComparisons } from "../../comparisons";
import { useT } from "../../i18n";
import { type OwnAiPill as Pill, setUpModelInstead } from "../../ownAiPanel";
import { OtherAgents } from "../AskAgentLine";

/**
 * The Ask pill for a User with only their own AI, the assistant folded (#3373): "Ask {agent}" with
 * ⌘J asks it about the Note the User is in; its ⌄ holds the others, as the card offers them, and
 * last IncarnaMind's own chat, which opens the assistant on model setup.
 */
export function OwnAiPill({ mindId, agents }: Pill) {
  const t = useT();
  // The Compare Documents sheet's Make button sits where the pill floats (#1839).
  const comparing = useComparisons((state) => Object.keys(state.sheets).length > 0);
  const [first, ...others] = agents;
  if (comparing || !first) return null;
  const label = (agent: string) => t("agents.ask.pill", { agent });
  return (
    <div
      data-testid="own-ai-pill"
      className="absolute bottom-5 left-1/2 z-10 flex h-10 -translate-x-1/2 items-center gap-1 rounded-full bg-sheet pr-2 font-sans text-[14px] text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong),0_4px_16px_var(--color-shadow-soft)]"
    >
      <button
        type="button"
        data-testid="own-ai-pill-ask"
        onClick={() => void askAgent(first, mindId, { kind: "note" })}
        className="flex h-full items-center gap-3 rounded-full pl-5 hover:text-ink"
      >
        {label(first.name)}
        <kbd className="rounded-sm bg-chip px-[5px] py-px font-sans text-[12px] text-ink-strong">
          {shortcutLabel("composer.focus")}
        </kbd>
      </button>
      <OtherAgents
        agents={others}
        label={label}
        onAsk={(agent) => void askAgent(agent, mindId, { kind: "note" })}
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
