import type { SignOffNow } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { checkedByMe } from "../../../shared/signOffs";
import { CheckIcon } from "../components/icons";
import { useLanguage, useT } from "../i18n";

/**
 * What a card says of a person's own check (#1933): who checked it and when, or that it
 * changed since, with Check again. It is the person's check, never the app's result.
 */
export function SignOffLine({
  now,
  onCheckAgain,
}: {
  now: SignOffNow | null;
  /** Null where the item can't be marked, such as a Note opened read-only. */
  onCheckAgain: (() => void) | null;
}) {
  const t = useT();
  const language = useLanguage();
  if (!now) return null;
  const time = formatDateTime(now.at, language);
  const name = now.name ?? "";
  const checked = now.state === "checked";
  return (
    <p className="sign-off-line" data-testid="sign-off-line" data-state={now.state}>
      <span>
        {checked
          ? now.mine
            ? t("signOff.mine", { time })
            : t("signOff.theirs", { name, time })
          : now.mine
            ? t("signOff.changed")
            : t("signOff.changed.theirs", { name })}
        {!checked && now.mine && onCheckAgain && (
          <>
            {" · "}
            <button
              type="button"
              data-testid="sign-off-again"
              className="sign-off-again"
              onClick={onCheckAgain}
            >
              {t("signOff.checkAgain")}
            </button>
          </>
        )}
      </span>
    </p>
  );
}

/** "Checked by me": a toggle among a card's actions, ticked while the User's own mark stands. */
export function SignOffToggle({
  now,
  onToggle,
  className,
}: {
  now: SignOffNow | null;
  onToggle(): void;
  className: string;
}) {
  const t = useT();
  const pressed = checkedByMe(now);
  return (
    <button
      type="button"
      data-testid="sign-off-toggle"
      aria-pressed={pressed}
      className={`sign-off-toggle ${className}`}
      onClick={onToggle}
    >
      {pressed && <CheckIcon className="sign-off-toggle-tick" />}
      {t("signOff.action")}
    </button>
  );
}
