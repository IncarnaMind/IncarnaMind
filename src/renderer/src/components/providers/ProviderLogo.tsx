import type { ReactNode } from "react";
import type { ChatProvider } from "../../../../core/api";
import { ComputerLineIcon } from "../icons";
import { type LogoPath, PROVIDER_LOGOS } from "./providerLogos";

/** A plan shows its company's logo. */
export const logoIdOf = (provider: ChatProvider): string | null =>
  provider.kind === "chatgpt"
    ? "openai"
    : provider.kind === "claude-account"
      ? "anthropic"
      : provider.kind === "copilot"
        ? "copilot"
        : (provider.catalogId ?? provider.kind);

export function ProviderLogo({
  id,
  large = false,
  fallback,
}: {
  id: string | null;
  large?: boolean;
  /** Drawn when the app has no logo for `id`; this computer's icon otherwise. */
  fallback?: ReactNode;
}) {
  const paths = id ? PROVIDER_LOGOS[id] : undefined;
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center bg-chip text-ink-meta ${
        large ? "size-11 rounded-[10px]" : "size-8 rounded-lg"
      }`}
    >
      {paths ? (
        <LogoDrawing paths={paths} className={large ? "size-6" : "size-[18px]"} />
      ) : (
        (fallback ?? <ComputerLineIcon data-size="18" />)
      )}
    </span>
  );
}

/** A logo's monochrome drawing, in the text's colour. */
export function LogoDrawing({
  paths,
  className,
}: {
  paths: readonly LogoPath[];
  className: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
    >
      {paths.map((path) =>
        typeof path === "string" ? (
          <path key={path} d={path} />
        ) : (
          <path key={path.d} d={path.d} fillOpacity={path.opacity} />
        ),
      )}
    </svg>
  );
}
