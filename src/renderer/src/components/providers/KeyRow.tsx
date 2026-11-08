import { type ReactNode, useState } from "react";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import type { SettingsTarget } from "../../settingsPages";
import { useSettingsTarget } from "../../settingsTarget";
import { AccountState, type RowState } from "../ai/AccountState";
import { ProblemLine } from "../ProblemLine";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { ProviderLogo } from "./ProviderLogo";

const NOWHERE: readonly SettingsTarget[] = [];

/**
 * A key Accounts and keys keeps for a job other than Answers (sorting, meeting transcription,
 * ordering search results): its company, what it is used for and whether it works, and Change key,
 * which opens `form` in place, and Remove key. `reachedBy`: the Settings targets that scroll to it
 * and open Change key (a refused key's "Check the key").
 */
export function KeyRow({
  testId,
  id,
  name,
  logo,
  fallback,
  status,
  state = null,
  change,
  remove,
  onRemove,
  form,
  note = null,
  reachedBy = NOWHERE,
}: {
  testId: "sorting-key" | "transcription-key" | "rerank-key" | "search-key";
  id: string;
  name: string;
  logo: string | null;
  /** Drawn in place of a logo the app doesn't have. */
  fallback?: ReactNode;
  status: string;
  state?: RowState | null;
  change: string;
  /** Left out where removing the key would stop a job with nothing to go back to. */
  remove?: string;
  onRemove?(): Promise<void>;
  /** The form that changes the key in place; `done` puts it away. */
  form(done: () => void): ReactNode;
  /** A line under the row while the form is away, such as the key's not being checked. */
  note?: ReactNode;
  reachedBy?: readonly SettingsTarget[];
}) {
  const t = useT();
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reached = useSettingsTarget<HTMLDivElement>(reachedBy, true, () => {
    setProblem(null);
    setChanging(true);
  });
  const removeKey = async () => {
    if (!onRemove) return;
    setProblem(null);
    try {
      await onRemove();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  const below = changing || problem !== null || note !== null;
  return (
    <SettingsRow
      ref={reached}
      role="listitem"
      data-testid={`${testId}-row`}
      data-host={id}
      leading={<ProviderLogo id={logo} fallback={fallback} />}
      label={
        <span className="block truncate font-semibold" title={name}>
          {name}
        </span>
      }
      detail={
        <span data-testid={`${testId}-status`} className="block truncate" title={status}>
          {status}
        </span>
      }
      control={
        changing ? undefined : (
          <>
            {state && <AccountState state={state} />}
            <button
              type="button"
              data-testid={`${testId}-change`}
              onClick={() => {
                setProblem(null);
                setChanging(true);
              }}
              className={buttonStyle("secondary", "sm")}
            >
              {change}
            </button>
            {remove && onRemove && (
              <button
                type="button"
                data-testid={`${testId}-remove`}
                onClick={() => void removeKey()}
                className={buttonStyle("ghost", "sm")}
              >
                {remove}
              </button>
            )}
          </>
        )
      }
    >
      {below && (
        <div className="flex flex-col gap-1 pl-11">
          {changing ? form(() => setChanging(false)) : note}
          {problem && <ProblemLine>{problem}</ProblemLine>}
        </div>
      )}
    </SettingsRow>
  );
}
