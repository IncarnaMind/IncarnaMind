import type { SignOffNow } from "../../../core/api";
import type { Language } from "../../../core/language";
import { formatDateTime } from "../../../shared/dates";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { checkedByMe } from "../../../shared/signOffs";
import { CheckIcon } from "../components/icons";
import { useLanguage, useT } from "../i18n";

/** Who checked an item and when, or that it changed since they did. */
export function signOffWords(
  now: SignOffNow,
  t: (key: MessageKey, params?: MessageParams) => string,
  language: Language,
): string {
  const name = now.name ?? "";
  if (now.state === "checked")
    return now.mine
      ? t("signOff.mine", { time: formatDateTime(now.at, language) })
      : t("signOff.theirs", { name, time: formatDateTime(now.at, language) });
  return now.mine ? t("signOff.changed") : t("signOff.changed.theirs", { name });
}

/**
 * What a card says of a person's own check (#1933): who checked it and when, or that it changed
 * since, when the toggle shows unticked and ticking it again marks it checked now. It is the
 * person's check, never the app's result.
 */
export function SignOffLine({ now }: { now: SignOffNow | null }) {
  const t = useT();
  const language = useLanguage();
  if (!now) return null;
  return (
    <p className="sign-off-line" data-testid="sign-off-line" data-state={now.state}>
      {signOffWords(now, t, language)}
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
