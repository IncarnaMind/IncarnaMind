import type { ChatProvider } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { KeyEntry } from "./KeyEntry";

/**
 * Where a model is needed later — Organize, Compare Documents, call help: first run's key field
 * in place (#1922), with one line naming what that work sends, and no step through Settings.
 * The key saved, `onDone` goes on with what the User was doing.
 */
export function NeedsModelCard({
  line,
  testId,
  onDone,
  className = "",
  autoFocus = true,
}: {
  line: MessageKey;
  testId: string;
  onDone(provider: ChatProvider): void;
  className?: string;
  /** A card that appears by itself, as during a call, leaves the focus where it was. */
  autoFocus?: boolean;
}) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  return (
    <div data-testid={testId} className={`flex flex-col gap-1.5 ${className}`}>
      <p className="text-[13px] leading-5 text-ink-secondary">{t(line)}</p>
      <KeyEntry
        testId={`${testId}-key`}
        autoFocus={autoFocus}
        onSaved={onDone}
        unrecognised={{ label: "setup.key.openSettings", run: () => openSettings("models") }}
      />
    </div>
  );
}
