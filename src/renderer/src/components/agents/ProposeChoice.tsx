import { useId } from "react";
import { useT } from "../../i18n";
import { checkBoxClass, checkHintClass, checkRowClass } from "../ui";

/**
 * Whether an agent may propose changes to the notes in its Folders (#352): the User's grant,
 * given where they connect it and changed in place on its row. Its changes wait for them. With
 * `hint` false the sentences on what the grant allows are left for the caller to put under Details.
 */
export function ProposeChoice({
  checked,
  onChange,
  hint = true,
  noFolders = false,
  label,
  testId = "agent-propose",
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: boolean;
  /** There is no Folder to name: every Document is in none. */
  noFolders?: boolean;
  /** Custom label when granting write access to several apps at once. */
  label?: string;
  testId?: string;
}) {
  const t = useT();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className={checkRowClass}>
        <input
          type="checkbox"
          data-testid={testId}
          checked={checked}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className={`${checkBoxClass} accent-ink`}
        />
        {label ?? t(noFolders ? "agents.propose.label.all" : "agents.propose.label")}
      </label>
      {hint && (
        <p id={hintId} className={checkHintClass}>
          {t("agents.propose.hint")}
        </p>
      )}
    </div>
  );
}
