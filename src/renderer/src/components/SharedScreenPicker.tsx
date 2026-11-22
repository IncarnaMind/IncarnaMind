import { useEffect, useId, useState } from "react";
import { useT } from "../i18n";
import { useMeetings } from "../meetings";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * IncarnaMind's own window picker for a Meeting's shared screen (ADR-0031),
 * where the system has none to offer (Windows, Linux, macOS before 15): the
 * open windows, each with a small picture and its name, never a whole screen
 * and never IncarnaMind's own. Choosing one reads it; Esc or Cancel doesn't.
 * The arrow keys move between windows and Enter reads the one chosen, as in
 * any list of choices.
 */
export function SharedScreenPicker() {
  const t = useT();
  const picker = useMeetings((state) => state.screenPicker);
  const { readScreen, closeScreenPicker } = useMeetings.getState();
  const dialog = useModal(picker !== null);
  const [chosen, setChosen] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const windows = picker?.windows ?? null;

  useEffect(() => {
    setChosen(windows?.[0]?.id ?? null);
  }, [windows]);

  const read = (windowId: string | null) => {
    if (picker && windowId) void readScreen(picker.meetingId, windowId);
  };

  return (
    <dialog
      ref={dialog}
      data-testid="screen-picker"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={closeScreenPicker}
      className={`${dialogClass} w-[36rem]`}
    >
      <form
        method="dialog"
        className={dialogBodyClass}
        onSubmit={(event) => {
          event.preventDefault();
          read(chosen);
        }}
      >
        <h2 id={titleId} className={dialogTitleClass}>
          {t("meetings.screen.picker.title")}
        </h2>
        <p id={bodyId} className={dialogTextClass}>
          {t("meetings.screen.picker.body")}
        </p>
        {windows === null ? (
          <p role="status" className={dialogTextClass}>
            {t("meetings.screen.picker.loading")}
          </p>
        ) : windows.length === 0 ? (
          <p data-testid="screen-picker-none" className={dialogTextClass}>
            {t("meetings.screen.picker.none")}
          </p>
        ) : (
          <div role="radiogroup" aria-labelledby={titleId} className="screen-picker-windows">
            {windows.map((window) => (
              <label
                key={window.id}
                data-testid="screen-picker-window"
                data-chosen={chosen === window.id || undefined}
                className="screen-picker-window"
                onDoubleClick={() => read(window.id)}
              >
                <input
                  type="radio"
                  name="shared-window"
                  value={window.id}
                  checked={chosen === window.id}
                  onChange={() => setChosen(window.id)}
                  className="sr-only"
                />
                <span className="screen-picker-thumbnail">
                  {window.thumbnail && <img src={window.thumbnail} alt="" />}
                </span>
                <span className="screen-picker-name" title={window.name}>
                  {window.name}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className={dialogActionsClass}>
          <button type="button" onClick={closeScreenPicker} className={buttonClass}>
            {t("meetings.screen.picker.cancel")}
          </button>
          <button
            type="submit"
            data-testid="screen-picker-read"
            disabled={!chosen}
            className={primaryButtonClass}
          >
            {t("meetings.screen.picker.read")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
