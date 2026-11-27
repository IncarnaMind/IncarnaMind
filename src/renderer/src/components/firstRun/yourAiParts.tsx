import { type ReactNode, useEffect, useState } from "react";
import type { AgentClient, AgentSetupResult } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { buttonStyle } from "../ui";
import type { StepPlace } from "./SetupPanel";
import { monogram } from "./yourAiList";

/** The pairings that wait for their app's own Install, as Settings › AI is told of them; null until read. */
export function useAwaitingInstall(): readonly string[] | null {
  const [awaiting, setAwaiting] = useState<readonly string[] | null>(null);
  const reportError = useAppStore((state) => state.reportError);
  useEffect(() => {
    core.getAgents().then((settings) => setAwaiting(settings.awaitingInstall), reportError);
    return core.on("agents.changed", (settings) => setAwaiting(settings.awaitingInstall));
  }, [reportError]);
  return awaiting;
}

/** What came of connecting one app in the Your AI step (#3791): its connection, or why it failed. */
export type Done =
  | { client: AgentClient; pairingId: string; result: AgentSetupResult }
  | { client: AgentClient; error: unknown };

/** What the User chose with the apps connected in one press. */
export interface Choice {
  propose: boolean;
}

export const linkClass =
  "rounded-sm text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

export const listClass = "flex flex-col rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-rule)]";

export const rowClass =
  "flex min-h-11 min-w-0 items-center gap-3 border-t border-rule px-3 py-2 first:border-t-0";

/** An app's mark in the list, until it has an icon of its own. */
export function AppMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-small leading-none text-ink-secondary"
    >
      {monogram(name)}
    </span>
  );
}

/** The step's foot: Back (or `start`), Set up later unless `later` is false, and `main`. */
export function StepFoot({
  place,
  start,
  later,
  main,
}: {
  place: StepPlace;
  start?: ReactNode;
  later?: boolean;
  main?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      {start ??
        (place.back && (
          <button
            type="button"
            data-testid="setup-back"
            onClick={place.back}
            className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
          >
            {t("setupPage.back")}
          </button>
        ))}
      <span className="flex-1" />
      {later !== false && (
        <button
          type="button"
          data-testid="setup-skip"
          onClick={place.next}
          className={buttonStyle("ghost", "lg")}
        >
          {t("providers.setup.later")}
        </button>
      )}
      {main}
    </>
  );
}
