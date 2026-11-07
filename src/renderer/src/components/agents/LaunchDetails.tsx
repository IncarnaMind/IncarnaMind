import { useEffect, useState } from "react";
import type { AgentLaunch } from "../../../../core/api";
import { AGENT_TOKEN_ENV, HIDDEN_KEY } from "../../../../shared/agentSocket";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { buttonStyle } from "../ui";

/**
 * How an agent starts IncarnaMind, piece by piece, for agents whose screen asks
 * for a command, its arguments and its environment in separate fields. The key
 * shows hidden; each Copy puts the full value on the clipboard.
 */
export function LaunchDetails({ pairingId }: { pairingId: string }) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [launch, setLaunch] = useState<AgentLaunch | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    core.getAgentLaunch(pairingId).then(setLaunch, reportError);
  }, [pairingId, reportError]);

  if (!launch) return null;
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch (error) {
      reportError(error);
    }
  };
  const field = (id: string, label: string, shown: string, copiedText: string) => (
    <div className="flex items-start gap-2" data-testid={`agent-launch-${id}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12px] leading-[18px] text-ink-meta">{label}</span>
        <code
          data-testid="agent-launch-value"
          className="font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink"
        >
          {shown}
        </code>
      </div>
      <button
        type="button"
        data-testid="agent-launch-copy"
        onClick={() => void copy(id, copiedText)}
        className={buttonStyle("ghost", "sm")}
      >
        {copied === id ? t("agents.pairing.copied") : t("agents.pairing.copy")}
      </button>
    </div>
  );

  return (
    <div data-testid="agent-launch" className="mt-2 flex flex-col gap-2">
      {field("command", t("agents.pairing.command"), launch.command, launch.command)}
      {field("args", t("agents.pairing.args"), launch.args.join("\n"), launch.args.join("\n"))}
      {Object.entries(launch.env).map(([name, value]) =>
        field(
          `env-${name}`,
          t("agents.pairing.env"),
          `${name}=${name === AGENT_TOKEN_ENV ? HIDDEN_KEY : value}`,
          `${name}=${value}`,
        ),
      )}
    </div>
  );
}
