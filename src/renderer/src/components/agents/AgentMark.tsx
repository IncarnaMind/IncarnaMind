import type { AgentClientId } from "../../../../core/api";
import { PlusLineIcon } from "../icons";
import { ProviderLogo } from "../providers/ProviderLogo";
import { PROVIDER_LOGOS } from "../providers/providerLogos";

/** An app drawn with its maker's mark, where the app has none of its own. */
const MAKER: Partial<Record<AgentClientId, string>> = {
  "claude-desktop": "anthropic",
  "claude-code": "anthropic",
  codex: "openai",
  "gemini-cli": "google",
  antigravity: "google",
  "qwen-code": "qwen",
  "kimi-code": "kimi",
  "minimax-code": "minimax",
};

/** The mark an app is drawn with in providerLogos.ts, by its maker or its own; null for none. */
export const markOf = (id: AgentClientId | null): string | null =>
  id === null ? null : (MAKER[id] ?? (PROVIDER_LOGOS[id] ? id : null));

/** An app's 32px tile: its mark, else the first letter of its name; Other agent a plus. */
export function AgentMark({ id, name }: { id: AgentClientId | null; name: string }) {
  const fallback =
    id === "other" ? (
      <PlusLineIcon />
    ) : (
      <span className="text-ui leading-none">{[...name][0]?.toLocaleUpperCase() ?? ""}</span>
    );
  return <ProviderLogo id={markOf(id)} fallback={fallback} />;
}

/** An app's state in two or three words, such as being on this computer. */
export function AgentChip({ children }: { children: string }) {
  return (
    <span className="inline-block shrink-0 rounded-sm bg-chip px-1.5 text-small leading-[18px] whitespace-nowrap text-ink-meta">
      {children}
    </span>
  );
}
