import { useId } from "react";
import type { AgentFolderRow } from "../../agentFolders";
import { useT } from "../../i18n";
import { choiceListClass, compactChoiceRadioClass, compactChoiceRowClass } from "../ui";
import { AgentFolderList } from "./AgentFolderList";

/**
 * What an agent may read (#3544): all of the User's Documents and Notes, those added later too,
 * or the Folders they tick, which list only while that is the choice. The same two choices, in the
 * same words, in the consent and in a connected agent's Folders….
 */
export function AgentShareChoice({
  all,
  onAll,
  rows,
  chosen,
  onToggle,
}: {
  all: boolean;
  onAll(all: boolean): void;
  rows: readonly AgentFolderRow[];
  chosen: ReadonlySet<string>;
  onToggle(id: string, on: boolean): void;
}) {
  const t = useT();
  const name = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={choiceListClass}>
        <label className={compactChoiceRowClass}>
          <input
            type="radio"
            name={name}
            data-testid="agent-share-all"
            checked={all}
            onChange={() => onAll(true)}
            className={compactChoiceRadioClass}
          />
          {t("agents.share.all")}
        </label>
        <label className={compactChoiceRowClass}>
          <input
            type="radio"
            name={name}
            data-testid="agent-share-folders"
            checked={!all}
            onChange={() => onAll(false)}
            className={compactChoiceRadioClass}
          />
          {t("agents.share.folders")}
        </label>
      </div>
      {!all && <AgentFolderList rows={rows} chosen={chosen} onToggle={onToggle} />}
    </div>
  );
}
