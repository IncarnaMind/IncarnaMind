import { useId } from "react";
import { useT } from "../../i18n";
import { checkBoxClass, checkHintClass, checkRowClass } from "../ui";

/**
 * Whether an agent may propose changes to the notes in its Folders (#352): the User's grant,
 * given where they connect it and changed in place on its row. Its changes wait for them.
 */
export function ProposeChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const t = useT();
  const hint = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className={checkRowClass}>
        <input
          type="checkbox"
          data-testid="agent-propose"
          checked={checked}
          aria-describedby={hint}
          onChange={(event) => onChange(event.target.checked)}
          className={checkBoxClass}
        />
        {t("agents.propose.label")}
      </label>
      <p id={hint} className={checkHintClass}>
        {t("agents.propose.hint")}
      </p>
    </div>
  );
}
