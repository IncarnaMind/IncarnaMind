import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { SettingsGroup, SettingsRow, SettingsSection } from "./settings/SettingsGroup";
import { rowFieldClass } from "./ui";

const TARGET = ["author-name"] as const;

/**
 * Settings → General → Your name (#107): the name the User's edits go under
 * when a Word file shows them as tracked changes, the name the computer knows
 * them by until they type another; once typed, their own items in meeting
 * notes too (#2306). Edited in place: Enter or leaving the field saves, Esc
 * puts it back, and an empty field goes back to the computer's.
 */
export function AuthorNameSettings() {
  const t = useT();
  const id = useId();
  const author = useAppStore((state) => state.settings?.author);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [draft, setDraft] = useState(author ?? "");
  useEffect(() => {
    if (author !== undefined) setDraft(author);
  }, [author]);
  const field = useRef<HTMLInputElement>(null);
  // The name is already loaded, so this runs before the dialog is shown, and showing it moves the focus.
  const section = useSettingsTarget<HTMLElement>(TARGET, author !== undefined, () =>
    queueMicrotask(() => field.current?.focus({ preventScroll: true })),
  );
  if (author === undefined) return null;

  const commit = () => {
    const name = draft.trim();
    if (name === author) return;
    void updateSettings({ user: { authorName: name === "" ? null : name } });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape" && draft !== author) {
      // Esc puts a changed name back, and doesn't close Settings as well.
      event.preventDefault();
      setDraft(author);
    }
  };

  return (
    <SettingsSection ref={section} testId="author-name-settings">
      <SettingsGroup>
        <SettingsRow
          label={t("settings.authorName")}
          htmlFor={id}
          tip={t("settings.authorName.tip")}
          tipId={`${id}-note`}
          detail={t("settings.authorName.meetings")}
          detailId={`${id}-meetings`}
          control={
            <input
              ref={field}
              id={id}
              type="text"
              data-testid="author-name"
              value={draft}
              maxLength={200}
              aria-describedby={`${id}-meetings ${id}-note`}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              className={`${rowFieldClass} w-56`}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
